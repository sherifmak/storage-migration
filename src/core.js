'use strict';

// Programmatic API for driving migrations without the interactive UI. Shared by
// the CLI (headless `run`/`stop`/`--json`) and the MCP server, so an automated
// agent and a human get identical behaviour. Everything here is non-interactive
// and returns plain data (no console output).

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Store } = require('./store');
const { Engine } = require('./engine');
const { Logger } = require('./util/logger');
const accounts = require('./auth/accounts');
const progress = require('./progress');

const CLI = path.join(__dirname, '..', 'bin', 'cloudferry.js');

// Build a ready-to-run engine for a job, wiring up the saved source/dest
// accounts. Throws a clear error if an account is missing.
function buildEngine(store, logger) {
  const cfg = accounts.load();
  const srcAcc = accounts.findAccount(cfg, store.job.from);
  const dstAcc = accounts.findAccount(cfg, store.job.to);
  if (!srcAcc) throw new Error(`Source account "${store.job.from}" is not connected. Run: cloudferry connect`);
  if (!dstAcc) throw new Error(`Destination account "${store.job.to}" is not connected. Run: cloudferry connect`);
  const source = accounts.buildProvider(srcAcc, { logger });
  const dest = accounts.buildProvider(dstAcc, { logger });
  const engine = new Engine({
    store, source, dest, logger,
    concurrency: store.job.concurrency || 4,
    skipExisting: store.job.skipExisting !== false,
  });
  return { engine, fromLabel: srcAcc.label || srcAcc.provider, toLabel: dstAcc.label || dstAcc.provider };
}

// ---- job lifecycle ---------------------------------------------------------

function makeJobId(from, to) {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${from}-to-${to}-${ts}`;
}

// Create a migration job (does not start it). Flushes and closes immediately so
// the detached runner opens a clean, fully-written job.
async function createJob({ from, to, srcRoot = '', destRoot = '', concurrency = 4, overwrite = false }) {
  const cfg = accounts.load();
  const srcAcc = accounts.findAccount(cfg, from);
  const dstAcc = accounts.findAccount(cfg, to);
  if (!srcAcc) throw new Error(`Source account "${from}" not found. Connect it first or check the account key.`);
  if (!dstAcc) throw new Error(`Destination account "${to}" not found. Connect it first or check the account key.`);
  if (srcAcc.key === dstAcc.key) throw new Error('Source and destination must be different accounts.');
  const jobId = makeJobId(srcAcc.provider, dstAcc.provider);
  const store = Store.create(jobId, {
    from: srcAcc.key, to: dstAcc.key,
    srcRoot: srcRoot || '', destRoot: destRoot || '',
    concurrency: Number(concurrency) || 4,
    skipExisting: !overwrite,
    fromLabel: srcAcc.label, toLabel: dstAcc.label,
  });
  const dir = store.dir;
  await store.close();
  return { jobId, dir, from: srcAcc.label, to: dstAcc.label };
}

// Spawn a detached, headless runner for an existing job and return immediately.
// The child keeps running after the parent (CLI invocation / MCP call) exits.
function spawnDetachedRun(jobId) {
  const dir = Store.exists(jobId) ? require('./config').jobDir(jobId) : null;
  const logFd = fs.openSync(path.join(dir, 'runner.out.log'), 'a');
  const child = spawn(process.execPath, [CLI, 'run', jobId], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  child.unref();
  // Seed a progress file so an immediate status read shows "starting".
  progress.writeProgress(dir, { state: 'starting', pid: child.pid, jobId });
  return { jobId, pid: child.pid };
}

// Start a brand-new migration in the background. Returns { jobId, pid }.
async function startMigration(opts) {
  const { jobId } = await createJob(opts);
  return { ...spawnDetachedRun(jobId), created: true };
}

// Resume an existing job in the background.
async function resumeMigration({ jobId, retryFailed = false } = {}) {
  if (!jobId) {
    const jobs = listJobs();
    if (!jobs.length) throw new Error('No jobs to resume.');
    jobId = jobs[jobs.length - 1].id;
  }
  if (!Store.exists(jobId)) throw new Error(`No such job: ${jobId}`);
  if (retryFailed) {
    const store = Store.open(jobId);
    store.retryFailed();
    await store.close(); // ensure the re-queue is flushed before the child reads it
  }
  return spawnDetachedRun(jobId);
}

// Pause a running job by signalling its detached runner. Returns whether a
// running process was found.
function pauseMigration(jobId) {
  if (!jobId) {
    const jobs = listJobs();
    if (!jobs.length) throw new Error('No jobs found.');
    jobId = jobs[jobs.length - 1].id;
  }
  const dir = require('./config').jobDir(jobId);
  const pid = progress.readPid(dir);
  if (pid && progress.isAlive(pid)) {
    try { process.kill(pid, 'SIGTERM'); return { jobId, paused: true, pid }; }
    catch (e) { return { jobId, paused: false, error: e.message }; }
  }
  return { jobId, paused: false, reason: 'no running migration found' };
}

// ---- status ----------------------------------------------------------------

function listJobs() {
  return Store.list();
}

// Rich JSON status for a single job (or the most recent one).
function statusOf(jobId) {
  if (!jobId) {
    const jobs = listJobs().filter((j) => !j.broken);
    if (!jobs.length) throw new Error('No jobs found.');
    jobId = jobs[jobs.length - 1].id;
  }
  const store = Store.open(jobId, { readOnly: true });
  const cnt = store.counts();
  const dir = store.dir;
  const prog = progress.readProgress(dir);
  const pid = progress.readPid(dir);
  const running = Boolean(pid && progress.isAlive(pid));

  // Derive a single high-level state.
  let state;
  if (running) state = 'running';
  else if (prog && (prog.state === 'complete' || prog.state === 'error' || prog.state === 'paused')) state = prog.state;
  else if (!store.job.discoveryComplete) state = 'pending';
  else if (cnt.pending + cnt.active === 0) state = cnt.failed ? 'completed_with_failures' : 'complete';
  else state = 'paused';

  const pct = cnt.bytesTotal ? Math.round((cnt.bytesDone / cnt.bytesTotal) * 100)
    : (cnt.filesTotal ? Math.round((cnt.done / cnt.filesTotal) * 100) : 0);

  const failures = [];
  for (const item of store.items.values()) {
    if (item.status === 'failed' && failures.length < 20) failures.push({ path: item.path, error: item.error });
  }
  store.close();

  return {
    jobId,
    state,
    running,
    from: store.job.fromLabel || store.job.from,
    to: store.job.toLabel || store.job.to,
    srcRoot: store.job.srcRoot || '(account root)',
    destRoot: store.job.destRoot || '(account root)',
    discoveryComplete: store.job.discoveryComplete,
    percent: pct,
    files: { total: cnt.filesTotal, done: cnt.done, failed: cnt.failed, skipped: cnt.skipped, pending: cnt.pending + cnt.active },
    bytes: { total: cnt.bytesTotal, done: cnt.bytesDone },
    speedBytesPerSec: prog && prog.stats ? Math.round(prog.stats.rate || 0) : 0,
    etaSeconds: prog && prog.stats && prog.stats.eta != null ? Math.round(prog.stats.eta) : null,
    discovered: prog && prog.stats ? prog.stats.discovered : undefined,
    failures,
    updatedAt: prog ? prog.updatedAt : null,
    logFile: path.join(dir, 'migration.log'),
  };
}

// ---- headless runner (invoked by `cloudferry run <jobId>`) ------------------

async function runHeadless(jobId) {
  const store = Store.open(jobId);
  const logger = new Logger(path.join(store.dir, 'migration.log'));
  progress.writePid(store.dir);
  logger.info('headless run started', { jobId, pid: process.pid });

  let engine, labels;
  try {
    const built = buildEngine(store, logger);
    engine = built.engine;
    labels = built;
  } catch (err) {
    progress.writeProgress(store.dir, { state: 'error', pid: process.pid, error: err.message });
    progress.clearPid(store.dir);
    await logger.close();
    throw err;
  }

  const snapshot = (state, err) => ({
    state, pid: process.pid, jobId,
    from: labels.fromLabel, to: labels.toLabel,
    phase: engine.phase || undefined,
    stats: engine.stats(),
    error: err ? String(err.message || err) : undefined,
  });

  const timer = setInterval(() => {
    try { progress.writeProgress(store.dir, snapshot('running')); } catch { /* ignore */ }
  }, 2000);
  if (timer.unref) timer.unref();

  const onSignal = () => engine.pause();
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  let state = 'complete', error = null;
  try {
    await engine.run();
    const c = store.counts();
    state = c.failed ? 'completed_with_failures' : 'complete';
  } catch (err) {
    if (err && (err.paused || err.aborted || err.name === 'AbortError')) state = 'paused';
    else { error = err; state = 'error'; }
  }

  clearInterval(timer);
  process.removeListener('SIGTERM', onSignal);
  process.removeListener('SIGINT', onSignal);
  try { progress.writeProgress(store.dir, snapshot(state, error)); } catch { /* ignore */ }
  await store.close();
  logger.info('headless run finished', { jobId, state });
  await logger.close();
  progress.clearPid(store.dir);
  if (error) { const e = new Error(error.message || String(error)); e.jobState = state; throw e; }
  return { jobId, state };
}

module.exports = {
  buildEngine,
  createJob,
  startMigration,
  resumeMigration,
  pauseMigration,
  spawnDetachedRun,
  listJobs,
  statusOf,
  runHeadless,
  makeJobId,
};
