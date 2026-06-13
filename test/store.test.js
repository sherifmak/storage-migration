'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point CloudFerry's home at a throwaway dir before loading modules that read it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-store-'));
process.env.CLOUDFERRY_HOME = TMP;

const { Store, STATUS } = require('../src/store');

test('manifest + journal survive a close/reopen', async () => {
  const store = Store.create('job1', { from: 'a', to: 'b' });
  store.addItem({ type: 'folder', path: 'docs', name: 'docs' });
  const f1 = store.addItem({ type: 'file', path: 'docs/a.txt', name: 'a.txt', size: 100 });
  const f2 = store.addItem({ type: 'file', path: 'b.bin', name: 'b.bin', size: 2000 });
  store.finishDiscovery();
  store.update(f1.seq, { status: STATUS.DONE });
  await store.close();

  const re = Store.open('job1');
  assert.equal(re.job.discoveryComplete, true);
  const c = re.counts();
  assert.equal(c.filesTotal, 2);
  assert.equal(c.done, 1);
  assert.equal(c.pending, 1);
  assert.equal(c.bytesTotal, 2100);
  assert.equal(re.items.get(f2.seq).status, STATUS.PENDING);
  await re.close();
});

test('an interrupted (active) item reloads as pending, keeping resume state', async () => {
  const store = Store.create('job2', {});
  const f = store.addItem({ type: 'file', path: 'big.bin', name: 'big.bin', size: 9999 });
  store.finishDiscovery();
  // Simulate a crash mid-upload: status active with saved transfer offsets.
  store.update(f.seq, { status: STATUS.ACTIVE, transfer: { upload: { sessionId: 'S', offset: 4096 } }, transferred: 4096 });
  await store.close();

  const re = Store.open('job2');
  const item = re.items.get(f.seq);
  assert.equal(item.status, STATUS.PENDING, 'active items become pending on reload');
  assert.deepEqual(item.transfer.upload, { sessionId: 'S', offset: 4096 }, 'resume state preserved');
  await re.close();
});

test('journal compaction preserves the latest state per item', async () => {
  const store = Store.create('job3', {});
  const f = store.addItem({ type: 'file', path: 'x', name: 'x', size: 1 });
  store.finishDiscovery();
  // Many updates to force at least one compaction.
  for (let i = 0; i < 20000; i++) store.update(f.seq, { transferred: i });
  store.update(f.seq, { status: STATUS.DONE, transferred: 1 });
  await store.close();

  const re = Store.open('job3');
  assert.equal(re.items.get(f.seq).status, STATUS.DONE);
  await re.close();
});

test('retryFailed re-queues failed items; resetItems clears everything', async () => {
  const store = Store.create('job4', {});
  const f = store.addItem({ type: 'file', path: 'x', name: 'x', size: 1 });
  store.finishDiscovery();
  store.update(f.seq, { status: STATUS.FAILED, error: 'boom', attempts: 3 });
  assert.equal(store.counts().failed, 1);
  assert.equal(store.retryFailed(), 1);
  assert.equal(store.counts().pending, 1);

  store.resetItems();
  assert.equal(store.items.size, 0);
  assert.equal(store.job.discoveryComplete, false);
  await store.close();
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
