'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { Provider, dirOf, baseName } = require('./base');
const { request } = require('../util/http');
const { withRetry } = require('../util/retry');
const { pipeBody } = require('./dropbox');

const AUTH = 'https://account.box.com/api/oauth2/authorize';
const TOKEN = 'https://api.box.com/oauth2/token';
const API = 'https://api.box.com/2.0';
const UPLOAD = 'https://upload.box.com/api/2.0';

// Box requires chunked upload for files >= 20 MB; below that a single request
// is simpler and faster.
const CHUNK_THRESHOLD = 20 * 1024 * 1024;

class BoxProvider extends Provider {
  static get id() { return 'box'; }
  static get displayName() { return 'Box'; }

  // ---- OAuth (requires client secret; refresh tokens rotate) --------------

  static buildAuthorize(clientId) {
    return {
      pkce: null,
      build: (redirectUri, state) => {
        const u = new URL(AUTH);
        u.searchParams.set('response_type', 'code');
        u.searchParams.set('client_id', clientId);
        u.searchParams.set('redirect_uri', redirectUri);
        u.searchParams.set('state', state);
        return u.toString();
      },
    };
  }

  static async exchangeCode({ clientId, clientSecret, code }) {
    const res = await request(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret }),
    });
    const j = await res.json();
    return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 };
  }

  async refreshTokens() {
    if (!this.tokens.refreshToken) throw Object.assign(new Error('Box account not connected (no refresh token).'), { permanent: true });
    const res = await request(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.tokens.refreshToken, client_id: this.app.clientId, client_secret: this.app.clientSecret }),
    });
    const j = await res.json();
    // Box rotates the refresh token on every use — we MUST keep the new one.
    return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 };
  }

  async _api(method, path, { body, params, signal } = {}) {
    const u = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) u.searchParams.set(k, v);
    return withRetry(async () => {
      const res = await request(u, {
        method,
        headers: { ...(await this.authHeaders()), ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
      const t = await res.text();
      return t ? JSON.parse(t) : {};
    }, { signal });
  }

  async getAccountInfo() {
    const me = await this._api('GET', '/users/me', { params: { fields: 'id,login,name' } });
    return { accountId: me.id, label: me.login || me.name || 'Box' };
  }

  // ---- discovery (recursive, marker paging) --------------------------------

  async *walk(rootPath, opts = {}) {
    const rootId = rootPath && rootPath !== '/' ? String(rootPath) : '0';
    // Breadth-first so we naturally emit folders before their contents.
    const queue = [{ id: rootId, path: '' }];
    let scanned = 0;
    while (queue.length) {
      const { id, path: base } = queue.shift();
      let marker = null;
      do {
        const page = await this._api('GET', `/folders/${id}/items`, {
          params: { fields: 'id,name,type,size,sha1', limit: 1000, usemarker: true, marker },
          signal: opts.signal,
        });
        for (const entry of page.entries || []) {
          const rel = base ? `${base}/${entry.name}` : entry.name;
          if (entry.type === 'folder') {
            yield { type: 'folder', path: rel, name: entry.name, srcId: entry.id };
            queue.push({ id: entry.id, path: rel });
          } else if (entry.type === 'file') {
            yield { type: 'file', path: rel, name: entry.name, size: Number(entry.size), srcId: entry.id, srcHash: entry.sha1 };
          }
        }
        scanned += (page.entries || []).length;
        if (opts.onProgress) opts.onProgress(scanned);
        marker = page.next_marker || null;
      } while (marker);
    }
  }

  // ---- destination ---------------------------------------------------------

  async _makeContainer(relDir) {
    const root = this.destRoot ? String(this.destRoot) : '0';
    if (!relDir) return root;
    const parentRel = dirOf(relDir);
    const parentId = parentRel === relDir ? root : await this.ensureContainer(parentRel);
    const name = baseName(relDir);
    try {
      const created = await this._api('POST', '/folders', { body: { name, parent: { id: parentId } } });
      return created.id;
    } catch (err) {
      // 409 name conflict -> Box returns the existing folder id in context_info.
      const existing = extractConflictId(err);
      if (existing) return existing;
      throw err;
    }
  }

  async download(item, destFile, opts = {}) {
    const { signal, onProgress, saveResume } = opts;
    let downloaded = 0;
    await withRetry(async () => {
      try { downloaded = fs.statSync(destFile).size; } catch { downloaded = 0; }
      const range = downloaded > 0 ? `bytes=${downloaded}-` : undefined;
      // The content endpoint 302-redirects to a pre-signed CDN URL; follow it
      // manually so we don't leak the Authorization header cross-origin.
      const first = await request(`${API}/files/${item.srcId}/content`, {
        headers: { ...(await this.authHeaders()), ...(range ? { Range: range } : {}) },
        redirect: 'manual', signal, expectOk: false,
      });
      let res = first;
      if (first.status >= 300 && first.status < 400) {
        const loc = first.headers.get('location');
        await first.arrayBuffer().catch(() => {});
        res = await request(loc, { headers: range ? { Range: range } : {}, signal });
      } else if (!first.ok) {
        const t = await first.text().catch(() => '');
        throw Object.assign(new Error(`Box download HTTP ${first.status} ${t}`), { status: first.status, retryable: first.status >= 500 || first.status === 429 });
      }
      const out = fs.createWriteStream(destFile, { flags: downloaded > 0 ? 'a' : 'w' });
      await pipeBody(res.body, out, (n) => {
        downloaded += n;
        if (onProgress) onProgress(n);
        if (saveResume) saveResume({ downloadedBytes: downloaded });
      }, signal);
    }, { signal });
    return { bytes: downloaded };
  }

  async upload(args, opts = {}) {
    const { localPath, name, size, containerRef } = args;
    if (size < CHUNK_THRESHOLD) return this._uploadSimple(localPath, name, containerRef, size, opts);
    return this._uploadChunked(localPath, name, containerRef, size, opts);
  }

  async _uploadSimple(localPath, name, parentId, size, opts) {
    const { signal, onProgress } = opts;
    const result = await withRetry(async () => {
      const form = new FormData();
      form.append('attributes', JSON.stringify({ name, parent: { id: parentId } }));
      const buf = fs.readFileSync(localPath);
      form.append('file', new Blob([buf]), name);
      const res = await request(`${UPLOAD}/files/content`, { method: 'POST', headers: await this.authHeaders(), body: form, signal });
      return res.json();
    }, { signal });
    if (onProgress) onProgress(size);
    const entry = result.entries && result.entries[0];
    return { dstId: entry && entry.id, hash: entry && entry.sha1 };
  }

  async _uploadChunked(localPath, name, parentId, size, opts) {
    const { signal, onProgress, resume, saveResume } = opts;
    let sessionId = resume && resume.sessionId;
    let partSize = resume && resume.partSize;
    let parts = (resume && resume.parts) || [];

    if (!sessionId) {
      const session = await withRetry(async () => {
        const res = await request(`${UPLOAD}/files/upload_sessions`, {
          method: 'POST',
          headers: { ...(await this.authHeaders()), 'content-type': 'application/json' },
          body: JSON.stringify({ folder_id: String(parentId), file_size: size, file_name: name }),
          signal,
        });
        return res.json();
      }, { signal });
      sessionId = session.id;
      partSize = session.part_size;
      parts = [];
      if (saveResume) saveResume({ sessionId, partSize, parts });
    } else {
      // Resuming: ask Box which parts it already has.
      parts = await this._listParts(sessionId, signal);
      if (saveResume) saveResume({ sessionId, partSize, parts });
    }

    const uploadedBytes = parts.reduce((n, p) => n + p.size, 0);
    if (onProgress && uploadedBytes) onProgress(uploadedBytes);

    let offset = parts.length ? Math.max(...parts.map((p) => p.offset + p.size)) : 0;
    while (offset < size) {
      const start = offset;
      const end = Math.min(start + partSize, size);
      const part = await withRetry(async () => {
        const buf = await readSlice(localPath, start, end);
        const digest = sha1Base64(buf);
        const res = await request(`${UPLOAD}/files/upload_sessions/${sessionId}`, {
          method: 'PUT',
          headers: {
            ...(await this.authHeaders()),
            'content-type': 'application/octet-stream',
            'content-range': `bytes ${start}-${end - 1}/${size}`,
            digest: `sha=${digest}`,
          },
          body: buf, signal,
        });
        return (await res.json()).part;
      }, { signal });
      parts.push(part);
      offset = end;
      if (onProgress) onProgress(end - start);
      if (saveResume) saveResume({ sessionId, partSize, parts });
    }

    // Commit with the whole-file SHA-1. Box may answer 202 while it assembles.
    const wholeSha = await sha1FileBase64(localPath);
    const committed = await withRetry(async () => {
      const res = await request(`${UPLOAD}/files/upload_sessions/${sessionId}/commit`, {
        method: 'POST',
        headers: { ...(await this.authHeaders()), 'content-type': 'application/json', digest: `sha=${wholeSha}` },
        body: JSON.stringify({ parts }),
        signal, expectOk: false,
      });
      if (res.status === 202) {
        const ra = res.headers.get('retry-after');
        await res.arrayBuffer().catch(() => {});
        throw Object.assign(new Error('Box still processing commit'), { retryable: true, retryAfterMs: (Number(ra) || 2) * 1000 });
      }
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw Object.assign(new Error(`Box commit HTTP ${res.status} ${t}`), { status: res.status, retryable: res.status >= 500 });
      }
      return res.json();
    }, { signal, retries: 12 });
    const entry = committed.entries && committed.entries[0];
    return { dstId: entry && entry.id, hash: entry && entry.sha1 };
  }

  async _listParts(sessionId, signal) {
    const all = [];
    let offset = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await this._api('GET', `/files/upload_sessions/${sessionId}/parts`, { params: { offset, limit: 1000 }, signal });
      for (const p of page.entries || []) all.push(p);
      offset += (page.entries || []).length;
      if (!page.entries || page.entries.length === 0 || offset >= (page.total_count || 0)) break;
    }
    all.sort((a, b) => a.offset - b.offset);
    return all;
  }
}

// ---- helpers ---------------------------------------------------------------

function extractConflictId(err) {
  try {
    const body = typeof err.body === 'string' ? JSON.parse(err.body) : err.body;
    const conflicts = body && body.context_info && body.context_info.conflicts;
    if (Array.isArray(conflicts) && conflicts[0]) return conflicts[0].id;
    if (conflicts && conflicts.id) return conflicts.id;
  } catch { /* not a conflict body */ }
  return null;
}

function readSlice(localPath, start, end) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const s = fs.createReadStream(localPath, { start, end: end - 1 });
    s.on('data', (c) => chunks.push(c));
    s.on('error', reject);
    s.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function sha1Base64(buf) {
  return crypto.createHash('sha1').update(buf).digest('base64');
}

function sha1FileBase64(localPath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    const s = fs.createReadStream(localPath);
    s.on('data', (c) => h.update(c));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('base64')));
  });
}

module.exports = { BoxProvider };
