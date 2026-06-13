'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { STATUS } = require('./store');
const { dirOf } = require('./providers/base');
const { AbortError } = require('./util/retry');

// Orchestrates a migration: discovery, then a pool of workers that each move
// one item at a time (download to staging → upload → verify). Everything is
// resumable: progress is journalled, and a pause leaves the job ready to
// continue exactly where it stopped.
class Engine extends EventEmitter {
  constructor({ store, source, dest, logger, concurrency = 4 }) {
    super();
    this.store = store;
    this.source = source;
    this.dest = dest;
    this.logger = logger;
    this.concurrency = Math.max(1, concurrency);

    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.paused = false;

    // Live view consumed by the dashboard.
    this.workers = Array.from({ length: this.concurrency }, (_, i) => ({ id: i + 1, idle: true }));
    this.recent = [];          // recent completions / failures / retries
    this.startedAt = Date.now();
    this.discovered = 0;
    this._bytesSinceSample = 0;
    this._rateSamples = [];    // [{t, bytes}] for a moving-average speed
    this.rate = 0;
  }

  // ---- public --------------------------------------------------------------

  async run() {
    this.source.srcRoot = this.store.job.srcRoot || '';
    this.dest.destRoot = this.store.job.destRoot || '';
    this._rateTimer = setInterval(() => this._sampleRate(), 1000);
    if (this._rateTimer.unref) this._rateTimer.unref();
    try {
      if (!this.store.job.discoveryComplete) await this._discover();
      await this._transfer();
    } finally {
      clearInterval(this._rateTimer);
    }
    return this._summary();
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.controller.abort(new AbortError('paused by user'));
    this.emit('paused');
  }

  // ---- discovery -----------------------------------------------------------

  async _discover() {
    this.emit('phase', 'discovery');
    // Discovery runs to completion before transfers begin, which keeps resume
    // simple. If a prior run was interrupted mid-discovery, start clean so the
    // append-only manifest can't accumulate duplicates.
    if (this.store.items.size > 0) this.store.resetItems();

    for await (const item of this.source.walk(this.store.job.srcRoot || '', {
      signal: this.signal,
      onProgress: (n) => { this.discovered = n; this.emit('discovering', n); },
    })) {
      if (this.signal.aborted) throw new AbortError();
      this.store.addItem(item);
      this.discovered = this.store.items.size;
      if (this.discovered % 200 === 0) this.emit('discovering', this.discovered);
    }
    this.store.finishDiscovery();
    this.emit('discovered', this.store.counts());
  }

  // ---- transfer ------------------------------------------------------------

  async _transfer() {
    this.emit('phase', 'transfer');
    // Snapshot the work queue (folders first so empty folders are created).
    const queue = [];
    for (const item of this.store.pending()) queue.push(item.seq);
    queue.sort((a, b) => {
      const A = this.store.items.get(a), B = this.store.items.get(b);
      if (A.type !== B.type) return A.type === 'folder' ? -1 : 1;
      return a - b;
    });
    let cursor = 0;
    const next = () => (cursor < queue.length ? this.store.items.get(queue[cursor++]) : null);

    const runWorker = async (slot) => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (this.signal.aborted) break;
        const item = next();
        if (!item) break;
        if (item.status !== STATUS.PENDING) continue;
        await this._handleItem(item, slot);
      }
      this.workers[slot.id - 1].idle = true;
    };

    await Promise.all(this.workers.map((slot) => runWorker(slot)));

    if (this.signal.aborted) {
      const e = new AbortError('paused');
      e.paused = true;
      throw e;
    }
  }

  async _handleItem(item, slot) {
    const w = this.workers[slot.id - 1];
    try {
      if (item.type === 'folder') {
        w.idle = false; w.name = item.path; w.phase = 'mkdir'; w.transferred = 0; w.total = 0;
        await this.dest.ensureContainer(item.path);
        this.store.update(item.seq, { status: STATUS.DONE });
        w.idle = true;
        return;
      }
      await this._transferFile(item, w);
    } catch (err) {
      w.idle = true;
      if (err && (err.aborted || err.name === 'AbortError')) {
        // Pausing: hand the item back as pending; its saved transfer state
        // lets the next run resume it.
        this.store.update(item.seq, { status: STATUS.PENDING, transfer: item.transfer });
        return;
      }
      const attempts = (item.attempts || 0) + 1;
      this.store.update(item.seq, { status: STATUS.FAILED, attempts, error: String(err && err.message || err) });
      this.logger.error('transfer failed', { path: item.path, attempts, err: String(err && err.message || err) });
      this._pushRecent({ kind: 'fail', name: item.name, detail: shortErr(err) });
      this.emit('progress');
    }
  }

  async _transferFile(item, w) {
    const stagedPath = path.join(this.store.stagingDir, `${item.seq}.part`);
    const transfer = item.transfer || {};
    this.store.update(item.seq, { status: STATUS.ACTIVE, transfer });

    // Throttle resume-state persistence: keep the latest in memory, flush to
    // the journal at most a few times per second (and always on phase change).
    let lastFlush = 0;
    const persist = (force) => {
      const now = Date.now();
      if (force || now - lastFlush > 750) {
        lastFlush = now;
        this.store.update(item.seq, { transfer: item.transfer, transferred: item.transferred });
      }
    };

    // --- download to staging ---
    // Skip the download if a previous run already staged the whole file (either
    // an upload was already in progress, or the staged bytes match the source
    // size). Re-downloading a complete file would request an invalid range.
    let staged = -1;
    try { staged = fs.statSync(stagedPath).size; } catch { staged = -1; }
    const alreadyDownloaded = (transfer.upload != null) ||
      (item.size != null && item.size > 0 && staged === item.size);

    if (!alreadyDownloaded) {
      w.idle = false; w.name = item.path; w.phase = 'download';
      w.total = item.size != null ? item.size : 0;
      w.transferred = (transfer.download && transfer.download.downloadedBytes) || 0;
      item.transferred = w.transferred;
      await this.source.download(item, stagedPath, {
        signal: this.signal,
        onProgress: (n) => { w.transferred += n; item.transferred = w.transferred; this._countBytes(n); persist(false); },
        resume: transfer.download,
        saveResume: (s) => { item.transfer = { ...item.transfer, download: s }; },
      });
    }

    const stagedSize = fs.statSync(stagedPath).size;
    if (item.size != null && item.size > 0 && stagedSize !== item.size) {
      throw Object.assign(new Error(`size mismatch after download (${stagedSize} != ${item.size})`), { retryable: false });
    }

    // --- upload from staging ---
    w.phase = 'upload'; w.total = stagedSize; w.transferred = 0;
    item.transferred = 0;
    const containerRef = await this.dest.ensureContainer(dirOf(item.path));
    const result = await this.dest.upload(
      { localPath: stagedPath, name: item.name, size: stagedSize, containerRef, item },
      {
        signal: this.signal,
        onProgress: (n) => { w.transferred += n; item.transferred = w.transferred; this._countBytes(n); persist(false); },
        resume: item.transfer && item.transfer.upload,
        saveResume: (s) => { item.transfer = { ...item.transfer, upload: s }; persist(false); },
      }
    );

    // --- verify + finalise ---
    this.store.update(item.seq, { status: STATUS.DONE, dstId: result && result.dstId, transfer: null, transferred: stagedSize });
    try { fs.unlinkSync(stagedPath); } catch { /* best effort */ }
    w.idle = true;
    this._pushRecent({ kind: 'ok', name: item.name });
    this.emit('progress');
  }

  // ---- stats helpers -------------------------------------------------------

  _countBytes(n) { this._bytesSinceSample += n; }

  _sampleRate() {
    const now = Date.now();
    this._rateSamples.push({ t: now, bytes: this._bytesSinceSample });
    this._bytesSinceSample = 0;
    while (this._rateSamples.length > 8) this._rateSamples.shift();
    const total = this._rateSamples.reduce((s, x) => s + x.bytes, 0);
    const span = this._rateSamples.length;
    this.rate = span ? total / span : 0;
    this.emit('tick');
  }

  _pushRecent(entry) {
    this.recent.unshift({ ...entry, at: Date.now() });
    if (this.recent.length > 6) this.recent.pop();
  }

  stats() {
    const counts = this.store.counts();
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const remainingBytes = Math.max(0, counts.bytesTotal - counts.bytesDone);
    const eta = this.rate > 1 ? remainingBytes / this.rate : null;
    return {
      ...counts,
      rate: this.rate,
      elapsed,
      eta,
      discovered: this.discovered,
      discoveryComplete: this.store.job.discoveryComplete,
    };
  }

  _summary() {
    const c = this.store.counts();
    return { done: c.done, failed: c.failed, skipped: c.skipped, filesTotal: c.filesTotal, bytesDone: c.bytesDone, bytesTotal: c.bytesTotal, paused: this.paused };
  }
}

function shortErr(err) {
  const m = String(err && err.message || err);
  return m.length > 60 ? m.slice(0, 57) + '…' : m;
}

module.exports = { Engine };
