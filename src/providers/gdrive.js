'use strict';

const fs = require('node:fs');
const { Provider, dirOf, baseName, normalizeRel } = require('./base');
const { request } = require('../util/http');
const { withRetry } = require('../util/retry');
const { pipeBody } = require('./dropbox');

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

const CHUNK = 16 * 1024 * 1024; // multiple of 256 KiB, required by Drive
const SIMPLE_LIMIT = 8 * 1024 * 1024;
const SCOPE = 'https://www.googleapis.com/auth/drive';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// Native Google formats can't be downloaded as-is; export them to a portable
// equivalent and tag on the right extension.
const EXPORTS = {
  'application/vnd.google-apps.document': { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: '.docx' },
  'application/vnd.google-apps.spreadsheet': { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: '.xlsx' },
  'application/vnd.google-apps.presentation': { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', extension: '.pptx' },
  'application/vnd.google-apps.drawing': { mimeType: 'application/pdf', extension: '.pdf' },
  'application/vnd.google-apps.script': { mimeType: 'application/vnd.google-apps.script+json', extension: '.json' },
};

class GoogleDriveProvider extends Provider {
  static get id() { return 'gdrive'; }
  static get displayName() { return 'Google Drive'; }

  // ---- OAuth ---------------------------------------------------------------

  static buildAuthorize(clientId) {
    return {
      pkce: null,
      build: (redirectUri, state) => {
        const u = new URL(AUTH);
        u.searchParams.set('client_id', clientId);
        u.searchParams.set('redirect_uri', redirectUri);
        u.searchParams.set('response_type', 'code');
        u.searchParams.set('scope', SCOPE);
        u.searchParams.set('access_type', 'offline');
        u.searchParams.set('prompt', 'consent'); // force a refresh token every time
        u.searchParams.set('state', state);
        return u.toString();
      },
    };
  }

  static async exchangeCode({ clientId, clientSecret, code, redirectUri }) {
    const res = await request(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    });
    const j = await res.json();
    return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 };
  }

  async refreshTokens() {
    if (!this.tokens.refreshToken) throw Object.assign(new Error('Google account not connected (no refresh token).'), { permanent: true });
    const res = await request(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.app.clientId, client_secret: this.app.clientSecret, refresh_token: this.tokens.refreshToken, grant_type: 'refresh_token' }),
    });
    const j = await res.json();
    return { accessToken: j.access_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 };
  }

  async _get(path, params, opts = {}) {
    const u = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) u.searchParams.set(k, v);
    return withRetry(async () => {
      const res = await request(u, { headers: await this.authHeaders(), signal: opts.signal });
      return res.json();
    }, { signal: opts.signal });
  }

  async getAccountInfo() {
    const j = await this._get('/about', { fields: 'user(emailAddress,displayName)' });
    const user = j.user || {};
    return { accountId: user.emailAddress, label: user.emailAddress || user.displayName || 'Google Drive' };
  }

  // ---- discovery -----------------------------------------------------------
  // Drive is a graph, not a tree, so we page through every item, build an
  // id->node map, then reconstruct POSIX paths by walking parents up to root.

  async *walk(rootPath, opts = {}) {
    const rootId = rootPath && rootPath !== '/' ? rootPath : 'root';
    const realRoot = rootId === 'root' ? (await this._get('/files/root', { fields: 'id' })).id : rootId;

    const nodes = new Map();
    let pageToken = null;
    let scanned = 0;
    do {
      const page = await this._get('/files', {
        q: 'trashed = false',
        fields: 'nextPageToken, files(id,name,mimeType,size,parents,shortcutDetails)',
        pageSize: 1000,
        pageToken,
        corpora: 'user',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        orderBy: 'folder,name',
      }, opts);
      for (const f of page.files || []) {
        if (f.mimeType === 'application/vnd.google-apps.shortcut') continue;
        nodes.set(f.id, f);
      }
      scanned += (page.files || []).length;
      if (opts.onProgress) opts.onProgress(scanned);
      pageToken = page.nextPageToken;
    } while (pageToken);

    // Resolve each node's path relative to realRoot (skip anything not under it).
    const pathCache = new Map();
    const resolvePath = (id, seen) => {
      if (id === realRoot) return '';
      if (pathCache.has(id)) return pathCache.get(id);
      const node = nodes.get(id);
      if (!node || !node.parents || node.parents.length === 0) return null;
      if (seen.has(id)) return null; // cycle guard
      seen.add(id);
      const parentPath = resolvePath(node.parents[0], seen);
      if (parentPath === null) return null;
      const p = parentPath ? `${parentPath}/${node.name}` : node.name;
      pathCache.set(id, p);
      return p;
    };

    for (const node of nodes.values()) {
      const rel = resolvePath(node.id, new Set());
      if (rel === null || rel === '') continue; // outside root, or the root itself
      if (node.mimeType === FOLDER_MIME) {
        yield { type: 'folder', path: rel, name: node.name, srcId: node.id };
      } else {
        const exp = EXPORTS[node.mimeType];
        yield {
          type: 'file',
          path: exp ? rel + exp.extension : rel,
          name: exp ? node.name + exp.extension : node.name,
          size: node.size != null ? Number(node.size) : null, // exports report no size
          srcId: node.id,
          srcMime: node.mimeType,
          export: exp || undefined,
        };
      }
    }
  }

  // ---- destination ---------------------------------------------------------

  async _makeContainer(relDir) {
    const root = this.destRoot && this.destRoot !== '/' ? this.destRoot : 'root';
    if (!relDir) return root;
    const parentRel = dirOf(relDir);
    const parentId = parentRel === relDir ? root : await this.ensureContainer(parentRel);
    const name = baseName(relDir);
    // Reuse an existing folder of the same name (Drive permits duplicates).
    const q = `name = ${gq(name)} and '${parentId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const found = await this._get('/files', { q, fields: 'files(id)', pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true });
    if (found.files && found.files.length) return found.files[0].id;
    const created = await withRetry(async () => {
      const res = await request(`${API}/files?supportsAllDrives=true&fields=id`, {
        method: 'POST',
        headers: { ...(await this.authHeaders()), 'content-type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
      });
      return res.json();
    });
    this._freshContainers.add(normalizeRel(relDir)); // newly created -> empty
    return created.id;
  }

  async _listContainer(folderId) {
    const map = new Map();
    let pageToken = null;
    do {
      const page = await this._get('/files', {
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id,name,size,mimeType,md5Checksum)',
        pageSize: 1000, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      for (const f of page.files || []) {
        if (f.mimeType === FOLDER_MIME) continue;
        // Native docs report no size; skip them (export size is unknowable here).
        if (f.size == null) continue;
        map.set(f.name, { size: Number(f.size), id: f.id, hash: f.md5Checksum });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return map;
  }

  async download(item, destFile, opts = {}) {
    const { signal, onProgress, saveResume } = opts;
    if (item.export) return this._exportDownload(item, destFile, opts);

    let downloaded = 0;
    await withRetry(async () => {
      try { downloaded = fs.statSync(destFile).size; } catch { downloaded = 0; }
      const headers = { ...(await this.authHeaders()) };
      if (downloaded > 0) headers.Range = `bytes=${downloaded}-`;
      const res = await request(`${API}/files/${item.srcId}?alt=media&supportsAllDrives=true`, { headers, signal });
      const out = fs.createWriteStream(destFile, { flags: downloaded > 0 ? 'a' : 'w' });
      await pipeBody(res.body, out, (n) => {
        downloaded += n;
        if (onProgress) onProgress(n);
        if (saveResume) saveResume({ downloadedBytes: downloaded });
      }, signal);
    }, { signal });
    return { bytes: downloaded };
  }

  // Exports are not resumable; always fetch from the start.
  async _exportDownload(item, destFile, opts) {
    const { signal, onProgress } = opts;
    let downloaded = 0;
    await withRetry(async () => {
      downloaded = 0;
      const u = new URL(`${API}/files/${item.srcId}/export`);
      u.searchParams.set('mimeType', item.export.mimeType);
      u.searchParams.set('supportsAllDrives', 'true');
      const res = await request(u, { headers: await this.authHeaders(), signal });
      const out = fs.createWriteStream(destFile, { flags: 'w' });
      await pipeBody(res.body, out, (n) => { downloaded += n; if (onProgress) onProgress(n); }, signal);
    }, { signal });
    return { bytes: downloaded };
  }

  async upload(args, opts = {}) {
    const { localPath, name, size, containerRef } = args;
    if (size <= SIMPLE_LIMIT) return this._uploadMultipart(localPath, name, containerRef, size, opts);
    return this._uploadResumable(localPath, name, containerRef, size, opts);
  }

  async _uploadMultipart(localPath, name, parentId, size, opts) {
    const { signal, onProgress } = opts;
    const meta = JSON.stringify({ name, parents: [parentId] });
    const boundary = `cf${Date.now()}${Math.random().toString(36).slice(2)}`;
    const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--`);
    const body = Buffer.concat([head, fs.readFileSync(localPath), tail]);
    const result = await withRetry(async () => {
      const res = await request(`${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=id,md5Checksum`, {
        method: 'POST',
        headers: { ...(await this.authHeaders()), 'content-type': `multipart/related; boundary=${boundary}` },
        body, signal,
      });
      return res.json();
    }, { signal });
    if (onProgress) onProgress(size);
    return { dstId: result.id, hash: result.md5Checksum };
  }

  async _uploadResumable(localPath, name, parentId, size, opts) {
    const { signal, onProgress, resume, saveResume } = opts;
    let sessionUri = resume && resume.sessionUri;
    let offset = (resume && resume.offset) || 0;

    if (!sessionUri) {
      sessionUri = await withRetry(async () => {
        const res = await request(`${UPLOAD}/files?uploadType=resumable&supportsAllDrives=true`, {
          method: 'POST',
          headers: {
            ...(await this.authHeaders()),
            'content-type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Length': String(size),
            'X-Upload-Content-Type': 'application/octet-stream',
          },
          body: JSON.stringify({ name, parents: [parentId] }),
          signal,
        });
        const loc = res.headers.get('location');
        if (!loc) throw Object.assign(new Error('Drive did not return a resumable session URI'), { retryable: true });
        return loc;
      }, { signal });
      offset = 0;
      if (saveResume) saveResume({ sessionUri, offset });
    } else {
      // Re-establish how many bytes Drive already has.
      offset = await this._queryResumeOffset(sessionUri, size, signal);
      if (offset >= size) return this._finalizeFromStatus(sessionUri, size, signal);
    }

    let result = null;
    while (offset < size) {
      const start = offset;
      const end = Math.min(start + CHUNK, size);
      result = await withRetry(async () => {
        const res = await request(sessionUri, {
          method: 'PUT',
          headers: { 'content-length': String(end - start), 'content-range': `bytes ${start}-${end - 1}/${size}` },
          body: fs.createReadStream(localPath, { start, end: end - 1 }),
          duplex: 'half',
          signal,
          expectOk: false,
        });
        if (res.status === 308) { await res.arrayBuffer().catch(() => {}); return null; }
        if (res.status === 200 || res.status === 201) return res.json();
        const t = await res.text().catch(() => '');
        const err = new Error(`resumable PUT failed: HTTP ${res.status} ${t}`);
        err.status = res.status;
        err.retryable = res.status >= 500 || res.status === 429;
        // On a recoverable error, re-sync our offset from the server next loop.
        throw err;
      }, {
        signal,
        onRetry: async () => { try { offset = await this._queryResumeOffset(sessionUri, size, signal); } catch { /* keep offset */ } },
      });
      offset = end;
      if (onProgress) onProgress(end - start);
      if (saveResume) saveResume({ sessionUri, offset });
    }
    return { dstId: result && result.id, hash: result && result.md5Checksum };
  }

  // Content-Range: bytes */size  =>  308 + "Range: bytes=0-N" telling us N+1 received.
  async _queryResumeOffset(sessionUri, size, signal) {
    const res = await request(sessionUri, {
      method: 'PUT',
      headers: { 'content-range': `bytes */${size}`, 'content-length': '0' },
      signal,
      expectOk: false,
    });
    if (res.status === 200 || res.status === 201) { await res.arrayBuffer().catch(() => {}); return size; }
    if (res.status === 308) {
      const range = res.headers.get('range');
      await res.arrayBuffer().catch(() => {});
      if (!range) return 0;
      const m = /bytes=0-(\d+)/.exec(range);
      return m ? Number(m[1]) + 1 : 0;
    }
    // 404/410 => session expired; signal a fresh start.
    const err = new Error(`resume query failed: HTTP ${res.status}`);
    err.sessionExpired = res.status === 404 || res.status === 410;
    err.retryable = res.status >= 500;
    throw err;
  }

  async _finalizeFromStatus(sessionUri, size, signal) {
    const res = await request(sessionUri, { method: 'PUT', headers: { 'content-range': `bytes */${size}`, 'content-length': '0' }, signal, expectOk: false });
    if (res.status === 200 || res.status === 201) { const j = await res.json().catch(() => ({})); return { dstId: j.id, hash: j.md5Checksum }; }
    await res.arrayBuffer().catch(() => {});
    return { dstId: null };
  }
}

// Escape a string for a Drive `q` query literal.
function gq(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

module.exports = { GoogleDriveProvider };
