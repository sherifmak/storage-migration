'use strict';

const fs = require('node:fs');
const { Provider, dirOf, normalizeRel } = require('./base');
const { request } = require('../util/http');
const { withRetry } = require('../util/retry');
const oauth = require('../auth/oauth');

const AUTH_HOST = 'https://www.dropbox.com';
const API = 'https://api.dropboxapi.com';
const CONTENT = 'https://content.dropboxapi.com';

// Upload chunk size: Dropbox recommends a multiple of 4 MiB and caps a single
// request at 150 MiB. 16 MiB balances throughput and resume granularity.
const CHUNK = 16 * 1024 * 1024;
// Files at/under this size go up in one request; larger use a resumable session.
const SIMPLE_LIMIT = 32 * 1024 * 1024;

const SCOPES = [
  'account_info.read',
  'files.metadata.read',
  'files.content.read',
  'files.content.write',
].join(' ');

class DropboxProvider extends Provider {
  static get id() { return 'dropbox'; }
  static get displayName() { return 'Dropbox'; }

  // ---- OAuth (PKCE, no client secret) -------------------------------------

  static buildAuthorize(clientId) {
    const pkce = oauth.generatePkce();
    return {
      pkce,
      build: (redirectUri, state) => {
        const u = new URL('/oauth2/authorize', AUTH_HOST);
        u.searchParams.set('client_id', clientId);
        u.searchParams.set('response_type', 'code');
        u.searchParams.set('token_access_type', 'offline'); // => refresh token
        u.searchParams.set('code_challenge', pkce.challenge);
        u.searchParams.set('code_challenge_method', pkce.method);
        u.searchParams.set('scope', SCOPES);
        u.searchParams.set('redirect_uri', redirectUri);
        u.searchParams.set('state', state);
        return u.toString();
      },
    };
  }

  static async exchangeCode({ clientId, code, codeVerifier, redirectUri }) {
    const body = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: clientId,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    });
    const res = await request(`${API}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json();
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + (json.expires_in || 14400) * 1000,
      accountId: json.account_id,
    };
  }

  async refreshTokens() {
    if (!this.tokens.refreshToken) throw Object.assign(new Error('Dropbox account not connected (no refresh token).'), { permanent: true });
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refreshToken,
      client_id: this.app.clientId,
    });
    const res = await request(`${API}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json();
    return {
      accessToken: json.access_token,
      expiresAt: Date.now() + (json.expires_in || 14400) * 1000,
    };
  }

  async _rpc(path, arg, { signal } = {}) {
    return withRetry(async () => {
      const res = await request(`${API}${path}`, {
        method: 'POST',
        headers: { ...(await this.authHeaders()), 'content-type': 'application/json' },
        body: arg === null ? null : JSON.stringify(arg),
        signal,
      });
      return res.json();
    }, { signal, onRetry: (e, a, d) => this.logger.debug('dropbox rpc retry', { path, attempt: a, delay: d, err: e.message }) });
  }

  async getAccountInfo() {
    const info = await this._rpc('/2/users/get_current_account', null);
    return { accountId: info.account_id, label: info.email || (info.name && info.name.display_name) || 'Dropbox' };
  }

  // ---- discovery -----------------------------------------------------------

  async *walk(rootPath, opts = {}) {
    const root = toDbxPath(rootPath); // '' for root, else '/Folder'
    let cursor = opts.cursor || null;
    let page;
    if (cursor) {
      page = await this._rpc('/2/files/list_folder/continue', { cursor }, opts);
    } else {
      page = await this._rpc('/2/files/list_folder', {
        path: root,
        recursive: true,
        include_deleted: false,
        include_media_info: false,
        limit: 2000,
      }, opts);
    }
    // eslint-disable-next-line no-constant-condition
    while (true) {
      for (const e of page.entries) {
        const rel = relativize(e.path_display, root);
        if (rel === null) continue;
        if (e['.tag'] === 'folder') {
          yield { type: 'folder', path: rel, name: e.name, srcId: e.id };
        } else if (e['.tag'] === 'file') {
          yield {
            type: 'file',
            path: rel,
            name: e.name,
            size: e.size,
            srcId: e.id,
            srcHash: e.content_hash,
          };
        }
      }
      if (opts.onCursor && page.cursor) opts.onCursor(page.cursor);
      if (!page.has_more) break;
      page = await this._rpc('/2/files/list_folder/continue', { cursor: page.cursor }, opts);
    }
  }

  // ---- destination ---------------------------------------------------------

  async _makeContainer(relDir) {
    const full = joinDbx(this.destRoot, relDir);
    if (full === '' || full === '/') return ''; // root always exists
    // Ensure parent first (cached), then create this folder.
    const parent = dirOf(relDir);
    if (normalizeRel(relDir) !== normalizeRel(parent)) await this.ensureContainer(parent);
    try {
      await this._rpc('/2/files/create_folder_v2', { path: full, autorename: false });
      this._freshContainers.add(normalizeRel(relDir)); // we created it -> known empty
    } catch (err) {
      // A pre-existing folder reports path/conflict/folder — that's fine.
      if (!/conflict/.test(err.body || '')) throw err;
    }
    return full;
  }

  async _listContainer(containerRef) {
    const map = new Map();
    let page = await this._rpc('/2/files/list_folder', { path: toDbxPath(containerRef), recursive: false, limit: 2000 });
    // eslint-disable-next-line no-constant-condition
    while (true) {
      for (const e of page.entries) {
        if (e['.tag'] === 'file') map.set(e.name, { size: e.size, id: e.id, hash: e.content_hash });
      }
      if (!page.has_more) break;
      page = await this._rpc('/2/files/list_folder/continue', { cursor: page.cursor });
    }
    return map;
  }

  async download(item, destFile, opts = {}) {
    const { signal, onProgress, resume, saveResume } = opts;
    let downloaded = (resume && resume.downloadedBytes) || 0;
    if (downloaded && !fs.existsSync(destFile)) downloaded = 0;

    await withRetry(async () => {
      // Re-check what's already on disk before each (re)attempt.
      try { downloaded = fs.statSync(destFile).size; } catch { downloaded = 0; }
      const headers = {
        ...(await this.authHeaders()),
        'Dropbox-API-Arg': JSON.stringify({ path: item.srcId }),
      };
      if (downloaded > 0) headers.Range = `bytes=${downloaded}-`;
      const res = await request(`${CONTENT}/2/files/download`, { method: 'POST', headers, signal });
      const out = fs.createWriteStream(destFile, { flags: downloaded > 0 ? 'a' : 'w' });
      await pipeBody(res.body, out, (n) => {
        downloaded += n;
        if (onProgress) onProgress(n);
        if (saveResume) saveResume({ downloadedBytes: downloaded });
      }, signal);
    }, { signal, onRetry: (e, a, d) => this.logger.debug('dropbox download retry', { name: item.name, attempt: a, delay: d, err: e.message }) });

    return { bytes: downloaded };
  }

  async upload(args, opts = {}) {
    const { localPath, name, size, containerRef } = args;
    const fullPath = joinDbx(containerRef, name);
    if (size <= SIMPLE_LIMIT) return this._uploadSimple(localPath, fullPath, size, opts);
    return this._uploadSession(localPath, fullPath, size, opts);
  }

  async _uploadSimple(localPath, fullPath, size, opts) {
    const { signal, onProgress } = opts;
    const result = await withRetry(async () => {
      const headers = {
        ...(await this.authHeaders()),
        'content-type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path: fullPath, mode: 'overwrite', autorename: false, mute: true, strict_conflict: false }),
      };
      const res = await request(`${CONTENT}/2/files/upload`, {
        method: 'POST', headers, body: fs.createReadStream(localPath), duplex: 'half', signal,
      });
      return res.json();
    }, { signal });
    if (onProgress) onProgress(size);
    return { dstId: result.id, hash: result.content_hash };
  }

  async _uploadSession(localPath, fullPath, size, opts) {
    const { signal, onProgress, resume, saveResume } = opts;
    let sessionId = resume && resume.sessionId;
    let offset = (resume && resume.offset) || 0;

    if (!sessionId) {
      // Start the session with the first chunk.
      const firstLen = Math.min(CHUNK, size);
      const started = await withRetry(async () => {
        const res = await request(`${CONTENT}/2/files/upload_session/start`, {
          method: 'POST',
          headers: {
            ...(await this.authHeaders()),
            'content-type': 'application/octet-stream',
            'Dropbox-API-Arg': JSON.stringify({ close: size <= firstLen }),
          },
          body: fs.createReadStream(localPath, { start: 0, end: firstLen - 1 }),
          duplex: 'half',
          signal,
        });
        return res.json();
      }, { signal });
      sessionId = started.session_id;
      offset = firstLen;
      if (onProgress) onProgress(firstLen);
      if (saveResume) saveResume({ sessionId, offset });
    }

    // Append remaining chunks (all but the final one).
    while (size - offset > CHUNK) {
      const start = offset;
      const end = Math.min(start + CHUNK, size);
      try {
        await withRetry(async () => {
          await this._appendChunk(localPath, sessionId, start, end, false, signal);
        }, { signal, onRetry: (e, a, d) => this.logger.debug('dropbox append retry', { attempt: a, delay: d, err: e.message }) });
      } catch (err) {
        // After a dropped response Dropbox may already hold some of this chunk;
        // it tells us the offset it actually expects — resync and continue.
        if (typeof err.correctOffset === 'number') {
          this.logger.debug('dropbox offset corrected', { from: start, to: err.correctOffset });
          offset = err.correctOffset;
          if (saveResume) saveResume({ sessionId, offset });
          continue;
        }
        throw err;
      }
      offset = end;
      if (onProgress) onProgress(end - start);
      if (saveResume) saveResume({ sessionId, offset });
    }

    // Finish with the final chunk + commit.
    const result = await withRetry(async () => {
      const res = await request(`${CONTENT}/2/files/upload_session/finish`, {
        method: 'POST',
        headers: {
          ...(await this.authHeaders()),
          'content-type': 'application/octet-stream',
          'Dropbox-API-Arg': JSON.stringify({
            cursor: { session_id: sessionId, offset },
            commit: { path: fullPath, mode: 'overwrite', autorename: false, mute: true },
          }),
        },
        body: offset < size ? fs.createReadStream(localPath, { start: offset, end: size - 1 }) : Buffer.alloc(0),
        duplex: 'half',
        signal,
      });
      return res.json();
    }, { signal });
    if (onProgress && size > offset) onProgress(size - offset);
    return { dstId: result.id, hash: result.content_hash };
  }

  async _appendChunk(localPath, sessionId, start, end, close, signal) {
    const res = await request(`${CONTENT}/2/files/upload_session/append_v2`, {
      method: 'POST',
      headers: {
        ...(await this.authHeaders()),
        'content-type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ cursor: { session_id: sessionId, offset: start }, close }),
      },
      body: fs.createReadStream(localPath, { start, end: end - 1 }),
      duplex: 'half',
      signal,
      expectOk: false,
    });
    if (res.status === 409) {
      // incorrect_offset: Dropbox tells us the offset it actually expects.
      const j = await res.json().catch(() => ({}));
      const correct = j && j.error && j.error.correct_offset;
      if (typeof correct === 'number') {
        const e = new Error(`offset corrected to ${correct}`);
        e.correctOffset = correct;
        throw e;
      }
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      const err = new Error(`append failed: HTTP ${res.status} ${t}`);
      err.status = res.status;
      err.retryable = res.status >= 500 || res.status === 429;
      throw err;
    }
  }
}

// ---- helpers ---------------------------------------------------------------

// User-facing Dropbox root path -> API path ('' for the account root).
function toDbxPath(p) {
  if (!p || p === '/' || p === '.') return '';
  let s = String(p).replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  return s.replace(/\/+$/, '');
}

function joinDbx(base, rel) {
  const b = toDbxPath(base);
  const r = normalizeRel(rel);
  if (!r) return b;
  return `${b}/${r}`;
}

// path_display under root -> POSIX-relative path. Returns null if outside root.
function relativize(displayPath, root) {
  const norm = displayPath.replace(/\\/g, '/');
  if (!root) return norm.replace(/^\//, '');
  if (norm.toLowerCase() === root.toLowerCase()) return '';
  const prefix = root + '/';
  if (norm.toLowerCase().startsWith(prefix.toLowerCase())) return norm.slice(prefix.length);
  return null;
}

async function pipeBody(webStream, out, onChunk, signal) {
  const reader = webStream.getReader();
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      await new Promise((resolve, reject) => out.write(buf, (e) => (e ? reject(e) : resolve())));
      if (onChunk) onChunk(buf.length);
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

module.exports = { DropboxProvider, pipeBody };
