'use strict';

const path = require('node:path');
const config = require('../config');
const { Store } = require('../store');
const { Engine } = require('../engine');
const { Monitor } = require('../ui/monitor');
const { Logger } = require('../util/logger');
const accounts = require('../auth/accounts');
const prompts = require('../util/prompts');
const { c } = require('../util/ansi');
const { formatBytes, formatNumber, formatDuration } = require('../util/format');

// Build providers + engine for a job, wire Ctrl-C to a safe pause, run the
// dashboard, and print a summary. Shared by both `migrate` and `resume`.
async function runJob(store) {
  const logger = new Logger(path.join(store.dir, 'migration.log'));
  const cfg = accounts.load();
  const srcAcc = accounts.findAccount(cfg, store.job.from);
  const dstAcc = accounts.findAccount(cfg, store.job.to);
  if (!srcAcc) throw new Error(`Source account "${store.job.from}" is no longer connected. Run: cloudferry connect`);
  if (!dstAcc) throw new Error(`Destination account "${store.job.to}" is no longer connected. Run: cloudferry connect`);

  const source = accounts.buildProvider(srcAcc, { logger });
  const dest = accounts.buildProvider(dstAcc, { logger });
  const engine = new Engine({ store, source, dest, logger, concurrency: store.job.concurrency || 4 });
  const monitor = new Monitor(engine, { from: srcAcc.label || srcAcc.provider, to: dstAcc.label || dstAcc.provider });

  logger.info('job started', { id: store.job.id, from: store.job.from, to: store.job.to });

  let pausing = false;
  const onSig = () => {
    if (pausing) process.exit(130); // second Ctrl-C: force quit
    pausing = true;
    monitor.stop();
    process.stdout.write(c.yellow('\nPausing — finishing in-flight chunks and saving progress…\n'));
    engine.pause();
  };
  process.on('SIGINT', onSig);

  monitor.start();
  let paused = false;
  let runErr = null;
  try {
    await engine.run();
  } catch (err) {
    if (err && (err.paused || err.aborted || err.name === 'AbortError')) paused = true;
    else runErr = err;
  }
  monitor.stop();
  process.removeListener('SIGINT', onSig);
  await store.close();
  await logger.close();

  if (runErr) throw runErr;
  printSummary(store, { paused });
  return { paused };
}

function printSummary(store, { paused }) {
  const cnt = store.counts();
  console.log('');
  if (paused) {
    console.log(c.yellow(c.bold('⏸  Migration paused.')));
  } else if (cnt.failed > 0) {
    console.log(c.yellow(c.bold('⚠  Migration finished with some failures.')));
  } else {
    console.log(c.green(c.bold('✓  Migration complete!')));
  }
  console.log(c.dim('─'.repeat(50)));
  console.log(`  Job        ${store.job.id}`);
  console.log(`  Transferred ${c.green(formatNumber(cnt.done))} files  (${formatBytes(cnt.bytesDone)})`);
  console.log(`  Remaining  ${formatNumber(cnt.pending + cnt.active)} files`);
  if (cnt.failed) console.log(`  ${c.red('Failed')}     ${formatNumber(cnt.failed)} files`);
  if (cnt.skipped) console.log(`  Skipped    ${formatNumber(cnt.skipped)} files`);
  console.log(c.dim(`  Log: ${path.join(store.dir, 'migration.log')}`));

  if (cnt.failed) {
    console.log('');
    console.log(c.bold('  First failures:'));
    let shown = 0;
    for (const item of store.items.values()) {
      if (item.status === 'failed' && shown < 5) {
        console.log(`    ${c.red('✗')} ${item.path}  ${c.dim('— ' + (item.error || 'unknown'))}`);
        shown++;
      }
    }
    console.log('');
    console.log(`  Retry the failures with:  ${c.cyan(`cloudferry resume ${store.job.id} --retry-failed`)}`);
  } else if (paused || cnt.pending || cnt.active) {
    console.log('');
    console.log(`  Resume any time with:  ${c.cyan(`cloudferry resume ${store.job.id}`)}`);
  }
  console.log('');
}

// `cloudferry migrate` — interactive unless fully specified by flags.
async function migrateCommand(opts) {
  const cfg = accounts.load();
  const all = accounts.listAccounts(cfg);
  if (all.length < 1) {
    console.log(c.yellow('No cloud accounts connected yet.'));
    console.log(`Connect one first:  ${c.cyan('cloudferry connect')}`);
    return;
  }

  let fromKey = opts.from;
  let toKey = opts.to;
  if (!fromKey) fromKey = await pickAccount(all, 'Migrate FROM which account?');
  let remaining = all;
  if (!toKey) {
    remaining = all.filter((a) => a.key !== fromKey);
    if (remaining.length === 0) {
      console.log(c.yellow('You need a second account as the destination.'));
      console.log(`Connect one:  ${c.cyan('cloudferry connect')}`);
      return;
    }
    toKey = await pickAccount(remaining, 'Migrate TO which account?');
  }
  if (fromKey === toKey) throw new Error('Source and destination must be different accounts.');

  const srcAcc = accounts.findAccount(cfg, fromKey);
  const dstAcc = accounts.findAccount(cfg, toKey);

  const srcRoot = opts.srcRoot != null ? opts.srcRoot
    : await prompts.ask(`Source folder on ${srcAcc.label} ${rootHint(srcAcc.provider)}:`, { defaultValue: defaultRoot(srcAcc.provider) });
  const destRoot = opts.destRoot != null ? opts.destRoot
    : await prompts.ask(`Destination folder on ${dstAcc.label} ${rootHint(dstAcc.provider)}:`, { defaultValue: defaultRoot(dstAcc.provider) });
  const concurrency = Number(opts.concurrency || (opts.yes ? 4 : await prompts.ask('Parallel transfers', { defaultValue: '4' }))) || 4;

  console.log('');
  console.log(c.bold('About to migrate:'));
  console.log(`  From  ${c.cyan(srcAcc.label)}  ${c.dim('(' + (srcRoot || 'entire account') + ')')}`);
  console.log(`  To    ${c.cyan(dstAcc.label)}  ${c.dim('(' + (destRoot || 'account root') + ')')}`);
  console.log(`  Parallel transfers: ${concurrency}`);
  console.log('');
  if (!opts.yes && !(await prompts.confirm('Start the migration?', true))) {
    console.log('Cancelled.');
    return;
  }

  const jobId = makeJobId(srcAcc.provider, dstAcc.provider);
  const store = Store.create(jobId, {
    from: srcAcc.key, to: dstAcc.key,
    srcRoot: srcRoot || '', destRoot: destRoot || '',
    concurrency,
    fromLabel: srcAcc.label, toLabel: dstAcc.label,
  });
  console.log(c.dim(`Job ${jobId} created at ${config.jobDir(jobId)}`));
  await runJob(store);
}

// `cloudferry resume <jobId>`
async function resumeCommand(jobId, opts) {
  if (!jobId) {
    const jobs = Store.list().filter((j) => !j.broken);
    const resumable = jobs.filter((j) => j.counters);
    if (resumable.length === 0) throw new Error('No jobs found to resume.');
    jobId = resumable[resumable.length - 1].id;
    console.log(c.dim(`Resuming most recent job: ${jobId}`));
  }
  const store = Store.open(jobId);
  if (opts.retryFailed) {
    const n = store.retryFailed();
    console.log(c.dim(`Re-queued ${n} previously failed file(s).`));
  }
  if (!store.hasWork() && store.job.discoveryComplete) {
    console.log(c.green('Nothing left to do — this job is already complete.'));
    if (!opts.retryFailed) {
      const cnt = store.counts();
      if (cnt.failed) console.log(`  (${cnt.failed} failed — retry with ${c.cyan(`cloudferry resume ${jobId} --retry-failed`)})`);
    }
    await store.close();
    return;
  }
  await runJob(store);
}

// ---- helpers ---------------------------------------------------------------

async function pickAccount(list, question) {
  return prompts.select(question, list.map((a) => ({ name: `${a.label} ${c.dim('(' + a.key + ')')}`, value: a.key, hint: a.provider })));
}

function rootHint(provider) {
  if (provider === 'dropbox') return c.dim('(path like /Photos, blank = whole Dropbox)');
  if (provider === 'gdrive') return c.dim('(folder ID, blank = My Drive root)');
  if (provider === 'box') return c.dim('(folder ID, blank = All Files root)');
  return '';
}

function defaultRoot(provider) {
  if (provider === 'gdrive') return 'root';
  if (provider === 'box') return '0';
  return '';
}

function makeJobId(from, to) {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${from}-to-${to}-${ts}`;
}

module.exports = { migrateCommand, resumeCommand, runJob };
