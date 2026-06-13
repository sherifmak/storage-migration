'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

// Durable, crash-safe job state with zero native dependencies.
//
// Why append-only files instead of SQLite? It keeps the tool a pure-JS install
// that runs anywhere with no build step, while still surviving crashes, kills
// and power loss: we never rewrite data in place, so a torn final line is the
// worst case and is simply ignored on reload.
//
//   manifest.jsonl  written once during discovery (the full set of items)
//   journal.jsonl   append-only log of status changes; replayed on open and
//                   periodically compacted to the latest state per item.

const STATUS = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  DONE: 'done',
  FAILED: 'failed',
  SKIPPED: 'skipped',
});

class Store {
  constructor(jobId) {
    this.jobId = jobId;
    this.dir = config.jobDir(jobId);
    this.manifestPath = path.join(this.dir, 'manifest.jsonl');
    this.journalPath = path.join(this.dir, 'journal.jsonl');
    this.jobPath = path.join(this.dir, 'job.json');
    this.stagingDir = path.join(this.dir, 'staging');

    this.job = null;            // job definition + counters
    this.items = new Map();     // seq -> item record
    this._manifestStream = null;
    this._journalStream = null;
    this._journalLines = 0;
    this._maxSeq = 0;
  }

  // ---- lifecycle -----------------------------------------------------------

  static exists(jobId) {
    return fs.existsSync(path.join(config.jobDir(jobId), 'job.json'));
  }

  static list() {
    const dir = config.jobsDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => fs.existsSync(path.join(dir, name, 'job.json')))
      .map((name) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, name, 'job.json'), 'utf8'));
        } catch {
          return { id: name, broken: true };
        }
      });
  }

  static create(jobId, jobDef) {
    const dir = config.jobDir(jobId);
    fs.mkdirSync(path.join(dir, 'staging'), { recursive: true });
    const store = new Store(jobId);
    store.job = {
      id: jobId,
      createdAt: new Date().toISOString(),
      discoveryComplete: false,
      discoveryCursor: null,
      counters: { files: 0, folders: 0, bytes: 0 },
      ...jobDef,
    };
    store._saveJob();
    fs.writeFileSync(store.manifestPath, '');
    fs.writeFileSync(store.journalPath, '');
    store._openStreams();
    return store;
  }

  static open(jobId) {
    if (!Store.exists(jobId)) throw new Error(`No such job: ${jobId}`);
    const store = new Store(jobId);
    store.job = JSON.parse(fs.readFileSync(store.jobPath, 'utf8'));
    store._loadManifest();
    store._loadJournal();
    fs.mkdirSync(store.stagingDir, { recursive: true });
    store._openStreams();
    return store;
  }

  _openStreams() {
    this._manifestStream = fs.createWriteStream(this.manifestPath, { flags: 'a' });
    this._journalStream = fs.createWriteStream(this.journalPath, { flags: 'a' });
  }

  // ---- loading -------------------------------------------------------------

  _loadManifest() {
    const lines = readLines(this.manifestPath);
    for (const line of lines) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; } // ignore torn last line
      rec.status = STATUS.PENDING;
      rec.attempts = 0;
      rec.error = null;
      rec.transferred = 0;
      rec.transfer = null; // resume state (download/upload offsets, session ids)
      this.items.set(rec.seq, rec);
      if (rec.seq > this._maxSeq) this._maxSeq = rec.seq;
    }
  }

  _loadJournal() {
    const lines = readLines(this.journalPath);
    this._journalLines = lines.length;
    for (const line of lines) {
      let upd;
      try { upd = JSON.parse(line); } catch { continue; }
      const item = this.items.get(upd.seq);
      if (!item) continue;
      Object.assign(item, upd);
    }
    // Anything left mid-flight from a previous run is reset to pending so it is
    // retried. Its saved `transfer` state lets us resume rather than restart.
    for (const item of this.items.values()) {
      if (item.status === STATUS.ACTIVE) item.status = STATUS.PENDING;
    }
  }

  // ---- discovery (manifest) ------------------------------------------------

  addItem(rec) {
    const seq = ++this._maxSeq;
    const full = { seq, status: STATUS.PENDING, attempts: 0, transferred: 0, transfer: null, ...rec };
    this.items.set(seq, full);
    this._manifestStream.write(JSON.stringify({
      seq,
      type: rec.type,
      path: rec.path,
      name: rec.name,
      size: rec.size,
      srcId: rec.srcId,
      srcHash: rec.srcHash,
      srcMime: rec.srcMime,
      export: rec.export,
    }) + '\n');
    if (rec.type === 'folder') this.job.counters.folders++;
    else {
      this.job.counters.files++;
      this.job.counters.bytes += rec.size || 0;
    }
    return full;
  }

  setDiscoveryCursor(cursor) {
    this.job.discoveryCursor = cursor;
    this._saveJob();
  }

  finishDiscovery() {
    this.job.discoveryComplete = true;
    this._saveJob();
  }

  // ---- status updates (journal) -------------------------------------------

  update(seq, patch) {
    const item = this.items.get(seq);
    if (!item) return;
    Object.assign(item, patch);
    this._journalStream.write(JSON.stringify({ seq, ...patch }) + '\n');
    this._journalLines++;
    // Keep the journal from growing without bound on huge jobs.
    if (this._journalLines > Math.max(5000, this.items.size * 3)) this._compactJournal();
  }

  // Rewrite the journal with a single line per item reflecting current state.
  _compactJournal() {
    const tmp = this.journalPath + '.tmp';
    const out = fs.openSync(tmp, 'w');
    try {
      for (const item of this.items.values()) {
        if (item.status === STATUS.PENDING && item.attempts === 0 && !item.transfer) continue;
        fs.writeSync(out, JSON.stringify({
          seq: item.seq,
          status: item.status === STATUS.ACTIVE ? STATUS.PENDING : item.status,
          attempts: item.attempts,
          error: item.error,
          dstId: item.dstId,
          transferred: item.transferred,
          transfer: item.transfer,
        }) + '\n');
      }
      fs.fsyncSync(out);
    } finally {
      fs.closeSync(out);
    }
    if (this._journalStream) this._journalStream.end();
    fs.renameSync(tmp, this.journalPath);
    this._journalStream = fs.createWriteStream(this.journalPath, { flags: 'a' });
    this._journalLines = this.items.size;
  }

  _saveJob() {
    const tmp = this.jobPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.job, null, 2));
    fs.renameSync(tmp, this.jobPath);
  }

  // ---- queries -------------------------------------------------------------

  *pending() {
    for (const item of this.items.values()) {
      if (item.status === STATUS.PENDING) yield item;
    }
  }

  counts() {
    let done = 0, failed = 0, skipped = 0, pending = 0, active = 0;
    let bytesDone = 0, filesTotal = 0, bytesTotal = 0;
    for (const item of this.items.values()) {
      if (item.type === 'folder') continue;
      filesTotal++;
      bytesTotal += item.size || 0;
      switch (item.status) {
        case STATUS.DONE: done++; bytesDone += item.size || 0; break;
        case STATUS.FAILED: failed++; break;
        case STATUS.SKIPPED: skipped++; break;
        case STATUS.ACTIVE: active++; bytesDone += item.transferred || 0; break;
        default: pending++;
      }
    }
    return { done, failed, skipped, pending, active, filesTotal, bytesTotal, bytesDone };
  }

  hasWork() {
    for (const item of this.items.values()) {
      if (item.type === 'file' && (item.status === STATUS.PENDING || item.status === STATUS.ACTIVE)) {
        return true;
      }
    }
    return false;
  }

  // Wipe all discovered items and start the manifest/journal fresh. Used when a
  // previous discovery was interrupted, so the append-only manifest can't end
  // up with duplicates.
  resetItems() {
    if (this._manifestStream) this._manifestStream.end();
    if (this._journalStream) this._journalStream.end();
    fs.writeFileSync(this.manifestPath, '');
    fs.writeFileSync(this.journalPath, '');
    this.items.clear();
    this._maxSeq = 0;
    this._journalLines = 0;
    this.job.counters = { files: 0, folders: 0, bytes: 0 };
    this.job.discoveryComplete = false;
    this._saveJob();
    this._openStreams();
  }

  // Reset failed items back to pending (used by `resume --retry-failed`).
  retryFailed() {
    let n = 0;
    for (const item of this.items.values()) {
      if (item.status === STATUS.FAILED) {
        this.update(item.seq, { status: STATUS.PENDING, attempts: 0, error: null });
        n++;
      }
    }
    return n;
  }

  async close() {
    this._saveJob();
    await Promise.all([
      this._manifestStream && endStream(this._manifestStream),
      this._journalStream && endStream(this._journalStream),
    ]);
  }
}

function readLines(file) {
  let data;
  try { data = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return data.split('\n').filter((l) => l.length > 0);
}

function endStream(stream) {
  return new Promise((resolve) => stream.end(resolve));
}

module.exports = { Store, STATUS };
