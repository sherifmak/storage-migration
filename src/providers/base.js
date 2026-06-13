'use strict';

const path = require('node:path');

// Abstract base every provider extends. It owns the cross-cutting concerns
// (token freshness, the destination folder-path cache, progress plumbing) and
// declares the methods a provider must implement.
class Provider {
  /**
   * @param {object} account  persisted account record:
   *   { provider, label, app:{clientId, clientSecret?}, tokens:{accessToken, refreshToken, expiresAt}, accountId }
   * @param {object} ctx  { logger, saveTokens(tokens) }
   */
  constructor(account, ctx = {}) {
    this.account = account;
    this.app = account.app || {};
    this.tokens = account.tokens || {};
    this.logger = ctx.logger || { debug() {}, info() {}, warn() {}, error() {} };
    this._saveTokens = ctx.saveTokens || (() => {});
    this._refreshing = null;
    this._folderCache = new Map(); // relDir (posix) -> container ref
    this._existingCache = new Map(); // relDir -> Promise<Map<name,{size,id}>>
    this._freshContainers = new Set(); // relDirs we created this run (known empty)
  }

  static get id() { return 'base'; }
  static get displayName() { return 'Base'; }

  // ---- tokens --------------------------------------------------------------

  // Returns a valid access token, transparently refreshing when it is missing
  // or within 90s of expiry. Concurrent callers share one refresh.
  async getAccessToken() {
    const now = Date.now();
    if (this.tokens.accessToken && this.tokens.expiresAt && this.tokens.expiresAt - now > 90000) {
      return this.tokens.accessToken;
    }
    if (!this._refreshing) {
      this._refreshing = this.refreshTokens()
        .then((tok) => {
          this.tokens = { ...this.tokens, ...tok };
          this.account.tokens = this.tokens;
          this._saveTokens(this.tokens);
          return this.tokens.accessToken;
        })
        .finally(() => { this._refreshing = null; });
    }
    return this._refreshing;
  }

  async authHeaders() {
    return { authorization: `Bearer ${await this.getAccessToken()}` };
  }

  // Provider must implement: exchange refresh token -> { accessToken, refreshToken?, expiresAt }
  async refreshTokens() {
    throw new Error(`${this.constructor.name}.refreshTokens() not implemented`);
  }

  // ---- discovery -----------------------------------------------------------

  /**
   * Async generator over the source tree under `rootPath`.
   * Yields { type:'file'|'folder', path, name, size, srcId, srcHash, srcMime, export }
   * `path` is POSIX-relative to rootPath. Call opts.onCursor(cursor) periodically
   * so discovery itself can resume after an interruption.
   */
  async *walk(/* rootPath, opts */) {
    throw new Error(`${this.constructor.name}.walk() not implemented`);
  }

  // ---- destination ---------------------------------------------------------

  // mkdir -p for a POSIX-relative directory under the destination root, with an
  // in-memory cache. Returns a provider-specific container reference (a path
  // for Dropbox, a folder id for Google/Box).
  async ensureContainer(relDir) {
    relDir = normalizeRel(relDir);
    let entry = this._folderCache.get(relDir);
    if (!entry) {
      // Cache the in-flight promise so concurrent workers asking for the same
      // directory share one creation instead of racing to make duplicates.
      entry = this._makeContainer(relDir);
      this._folderCache.set(relDir, entry);
      entry.catch(() => this._folderCache.delete(relDir));
    }
    return entry;
  }

  // Provider implements actual folder creation/resolution.
  async _makeContainer(/* relDir */) {
    throw new Error(`${this.constructor.name}._makeContainer() not implemented`);
  }

  // List the files already present in a destination container, as a
  // Map<name, {size, id}>. Cached per directory. Containers we created this run
  // are known-empty, so we skip the API call entirely (zero overhead on a
  // first run; only re-runs pay for the listing).
  async existingFiles(relDir, containerRef) {
    relDir = normalizeRel(relDir);
    if (this._freshContainers.has(relDir)) return EMPTY_MAP;
    let entry = this._existingCache.get(relDir);
    if (!entry) {
      entry = this._listContainer(containerRef).catch((err) => {
        // A listing failure must never corrupt the migration — just don't skip.
        this.logger.debug('existingFiles list failed', { relDir, err: String(err && err.message || err) });
        this._existingCache.delete(relDir);
        return EMPTY_MAP;
      });
      this._existingCache.set(relDir, entry);
    }
    return entry;
  }

  // Provider returns Map<name, {size, id}> for files in a container.
  async _listContainer(/* containerRef */) {
    return EMPTY_MAP;
  }

  /**
   * Download a source item to a local file, resumably.
   * @param item        manifest item
   * @param destFile    local staging path
   * @param opts        { signal, onProgress(bytes), resume:{downloadedBytes}, saveResume(state) }
   * @returns           { bytes, hash? }
   */
  async download(/* item, destFile, opts */) {
    throw new Error(`${this.constructor.name}.download() not implemented`);
  }

  /**
   * Upload a local file into a destination container, resumably.
   * @param args { localPath, name, size, containerRef, item }
   * @param opts { signal, onProgress(bytes), resume, saveResume(state) }
   * @returns    { dstId, hash? }
   */
  async upload(/* args, opts */) {
    throw new Error(`${this.constructor.name}.upload() not implemented`);
  }

  // Provider returns { accountId, label } describing the connected account.
  async getAccountInfo() {
    throw new Error(`${this.constructor.name}.getAccountInfo() not implemented`);
  }
}

const EMPTY_MAP = new Map();

// Normalise a relative path to POSIX form with no leading/trailing slash.
function normalizeRel(p) {
  if (!p || p === '.' || p === '/') return '';
  return p.split(/[\\/]+/).filter(Boolean).join('/');
}

function dirOf(relPath) {
  const norm = normalizeRel(relPath);
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? '' : norm.slice(0, idx);
}

function baseName(relPath) {
  return path.posix.basename(normalizeRel(relPath));
}

module.exports = { Provider, normalizeRel, dirOf, baseName };
