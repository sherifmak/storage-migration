'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-core-'));
process.env.CLOUDFERRY_HOME = TMP;

const { Store, STATUS } = require('../src/store');
const core = require('../src/core');

test('statusOf reports a structured snapshot of a job', async () => {
  const store = Store.create('job-status', { from: 'a', to: 'b', srcRoot: '/Photos', destRoot: 'root', fromLabel: 'Acct A', toLabel: 'Acct B' });
  const f1 = store.addItem({ type: 'file', path: 'a.txt', name: 'a.txt', size: 100 });
  store.addItem({ type: 'file', path: 'b.txt', name: 'b.txt', size: 300 });
  store.finishDiscovery();
  store.update(f1.seq, { status: STATUS.DONE });
  await store.close();

  const s = core.statusOf('job-status');
  assert.equal(s.jobId, 'job-status');
  assert.equal(s.from, 'Acct A');
  assert.equal(s.to, 'Acct B');
  assert.equal(s.files.total, 2);
  assert.equal(s.files.done, 1);
  assert.equal(s.files.pending, 1);
  assert.equal(s.bytes.total, 400);
  assert.equal(s.bytes.done, 100);
  assert.equal(s.percent, 25);
  assert.equal(s.running, false);
  assert.ok(['paused', 'pending'].includes(s.state) || s.state === 'complete');
});

test('statusOf marks a fully-done job complete', async () => {
  const store = Store.create('job-done', { from: 'a', to: 'b' });
  const f = store.addItem({ type: 'file', path: 'x', name: 'x', size: 10 });
  store.finishDiscovery();
  store.update(f.seq, { status: STATUS.DONE });
  await store.close();

  const s = core.statusOf('job-done');
  assert.equal(s.state, 'complete');
  assert.equal(s.percent, 100);
});

test('listJobs returns created jobs', () => {
  const ids = core.listJobs().map((j) => j.id);
  assert.ok(ids.includes('job-status'));
  assert.ok(ids.includes('job-done'));
});

test('pauseMigration reports when nothing is running', () => {
  const res = core.pauseMigration('job-done');
  assert.equal(res.paused, false);
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
