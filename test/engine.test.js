'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-engine-'));
process.env.CLOUDFERRY_HOME = TMP;

const { Store } = require('../src/store');
const { Engine } = require('../src/engine');
const { Provider } = require('../src/providers/base');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

// A fully in-memory provider used as both source and destination so the engine
// can be exercised end-to-end without any network.
class FakeProvider extends Provider {
  constructor() {
    super({}, { logger: silentLogger });
    this.files = new Map();    // srcId/path -> Buffer (source role)
    this.folders = new Set();  // source folder paths
    this.received = new Map(); // "container/name" -> Buffer (dest role)
    this.madeFolders = new Set();
    this.onBeforeUpload = null;
    this.failUploadOnce = new Set();
  }

  seed(tree) {
    for (const [p, content] of Object.entries(tree)) {
      const buf = Buffer.from(content);
      this.files.set(p, buf);
      const dir = p.split('/').slice(0, -1).join('/');
      if (dir) this.folders.add(dir);
    }
  }

  async *walk() {
    for (const folder of this.folders) yield { type: 'folder', path: folder, name: folder.split('/').pop(), srcId: folder };
    for (const [p, buf] of this.files) yield { type: 'file', path: p, name: p.split('/').pop(), size: buf.length, srcId: p };
  }

  async _makeContainer(relDir) {
    this.madeFolders.add(relDir);
    if (!this.preexisting) this._freshContainers.add(relDir); // mirror real providers
    return relDir;
  }

  async _listContainer(ref) {
    const map = new Map();
    for (const [key, buf] of this.received) {
      const slash = key.lastIndexOf('/');
      const dir = slash === -1 ? '' : key.slice(0, slash);
      const name = slash === -1 ? key : key.slice(slash + 1);
      if (dir === ref) map.set(name, { size: buf.length, id: `id-${name}` });
    }
    return map;
  }

  async download(item, destFile, opts = {}) {
    const buf = this.files.get(item.srcId);
    if (!buf) throw Object.assign(new Error('not found'), { permanent: true });
    // Honour any bytes already on disk (resume), then write the remainder.
    let have = 0;
    try { have = fs.statSync(destFile).size; } catch { have = 0; }
    const out = fs.createWriteStream(destFile, { flags: have > 0 ? 'a' : 'w' });
    await new Promise((res, rej) => out.write(buf.subarray(have), (e) => (e ? rej(e) : res())));
    await new Promise((res) => out.end(res));
    if (opts.onProgress) opts.onProgress(buf.length - have);
    return { bytes: buf.length };
  }

  async upload(args, opts = {}) {
    const { localPath, name, size, containerRef } = args;
    if (this.onBeforeUpload) await this.onBeforeUpload(name, opts.signal);
    if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
    if (this.failUploadOnce.has(name)) {
      this.failUploadOnce.delete(name);
      throw Object.assign(new Error('simulated upload failure'), { permanent: true });
    }
    const buf = fs.readFileSync(localPath);
    assert.equal(buf.length, size);
    this.received.set(containerRef ? `${containerRef}/${name}` : name, buf);
    if (opts.onProgress) opts.onProgress(buf.length);
    return { dstId: `id-${name}` };
  }

  async getAccountInfo() { return { accountId: 'fake', label: 'Fake' }; }
}

test('happy path: every file and folder is migrated with intact bytes', async () => {
  const src = new FakeProvider();
  src.seed({
    'a.txt': 'hello',
    'docs/b.txt': 'world!!',
    'docs/sub/c.bin': 'x'.repeat(5000),
  });
  src.folders.add('empty/nested'); // an empty folder tree
  const dst = new FakeProvider();

  const store = Store.create('e1', { srcRoot: '', destRoot: '' });
  const engine = new Engine({ store, source: src, dest: dst, logger: silentLogger, concurrency: 3 });
  const summary = await engine.run();
  await store.close();

  assert.equal(summary.failed, 0);
  assert.equal(summary.done, 3);
  assert.equal(dst.received.get('a.txt').toString(), 'hello');
  assert.equal(dst.received.get('docs/b.txt').toString(), 'world!!');
  assert.equal(dst.received.get('docs/sub/c.bin').length, 5000);
  assert.ok(dst.madeFolders.has('empty/nested'), 'empty folders are recreated');
});

test('failures are recorded, then resume --retry-failed completes the job', async () => {
  const src = new FakeProvider();
  src.seed({ 'one.txt': 'one', 'two.txt': 'two' });
  const dst = new FakeProvider();
  dst.failUploadOnce.add('two.txt'); // first attempt for two.txt fails permanently

  const store = Store.create('e2', {});
  await new Engine({ store, source: src, dest: dst, logger: silentLogger, concurrency: 2 }).run();
  await store.close();

  let re = Store.open('e2');
  assert.equal(re.counts().done, 1);
  assert.equal(re.counts().failed, 1);

  // Operator retries; this time the upload succeeds.
  re.retryFailed();
  await new Engine({ store: re, source: src, dest: dst, logger: silentLogger, concurrency: 2 }).run();
  await re.close();

  const final = Store.open('e2');
  assert.equal(final.counts().done, 2);
  assert.equal(final.counts().failed, 0);
  assert.equal(dst.received.get('two.txt').toString(), 'two');
  await final.close();
});

test('pause mid-transfer is safe and a fresh engine resumes to completion', async () => {
  const src = new FakeProvider();
  src.seed({ 'p1.txt': 'aaa', 'p2.txt': 'bbb', 'p3.txt': 'ccc' });
  const dst = new FakeProvider();

  const store = Store.create('e3', {});
  const engine = new Engine({ store, source: src, dest: dst, logger: silentLogger, concurrency: 1 });
  // Pause the engine the moment the first upload begins.
  dst.onBeforeUpload = async (name) => { if (name === 'p1.txt') engine.pause(); };

  let paused = false;
  try { await engine.run(); } catch (e) { paused = Boolean(e && (e.paused || e.aborted)); }
  await store.close();
  assert.ok(paused, 'engine reports a pause');
  assert.ok(dst.received.size < 3, 'not everything was delivered before pausing');

  // Resume with a brand-new engine (as a separate process would).
  const re = Store.open('e3');
  const dst2 = dst; // same destination store
  re.job.discoveryComplete = true;
  await new Engine({ store: re, source: src, dest: dst2, logger: silentLogger, concurrency: 2 }).run();
  await re.close();

  assert.equal(dst.received.get('p1.txt').toString(), 'aaa');
  assert.equal(dst.received.get('p2.txt').toString(), 'bbb');
  assert.equal(dst.received.get('p3.txt').toString(), 'ccc');
});

test('skip-existing: destination files with matching size are skipped, not re-sent', async () => {
  const src = new FakeProvider();
  src.seed({ 'a.txt': 'hello', 'docs/b.txt': 'world' });
  const dst = new FakeProvider();
  dst.preexisting = true; // destination folders already exist (not freshly created)
  dst.received.set('a.txt', Buffer.from('HELLO')); // same 5-byte size, different content

  const store = Store.create('e4', {});
  const summary = await new Engine({ store, source: src, dest: dst, logger: silentLogger, concurrency: 2, skipExisting: true }).run();
  await store.close();

  assert.equal(summary.skipped, 1, 'a.txt is skipped (already present, same size)');
  assert.equal(summary.done, 1, 'docs/b.txt is transferred');
  assert.equal(dst.received.get('a.txt').toString(), 'HELLO', 'existing file left untouched');
  assert.equal(dst.received.get('docs/b.txt').toString(), 'world');
});

test('skip-existing off (--overwrite) re-transfers everything', async () => {
  const src = new FakeProvider();
  src.seed({ 'a.txt': 'hello' });
  const dst = new FakeProvider();
  dst.preexisting = true;
  dst.received.set('a.txt', Buffer.from('HELLO'));

  const store = Store.create('e5', {});
  const summary = await new Engine({ store, source: src, dest: dst, logger: silentLogger, concurrency: 1, skipExisting: false }).run();
  await store.close();

  assert.equal(summary.skipped, 0);
  assert.equal(summary.done, 1);
  assert.equal(dst.received.get('a.txt').toString(), 'hello', 'overwritten with source content');
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
