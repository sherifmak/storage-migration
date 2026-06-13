'use strict';

const { Store } = require('../store');
const { c } = require('../util/ansi');
const { formatBytes, formatNumber } = require('../util/format');

// `cloudferry jobs` — list every migration job and its high-level state.
function jobsCommand() {
  const jobs = Store.list();
  if (jobs.length === 0) {
    console.log('No migration jobs yet. Start one with `cloudferry migrate`.');
    return;
  }
  console.log(c.bold('Migration jobs:'));
  for (const j of jobs) {
    if (j.broken) { console.log(`  ${c.red('✗')} ${j.id} ${c.dim('(unreadable)')}`); continue; }
    const cn = j.counters || {};
    const state = j.discoveryComplete ? '' : c.yellow(' [discovery incomplete]');
    console.log(`  ${c.cyan('●')} ${c.bold(j.id)}${state}`);
    console.log(`      ${c.dim(j.fromLabel || j.from)} ${c.cyan('→')} ${c.dim(j.toLabel || j.to)}` +
      `   ${formatNumber(cn.files || 0)} files, ${formatBytes(cn.bytes || 0)}`);
  }
  console.log(c.dim('\nDetails:  cloudferry status <jobId>     Resume:  cloudferry resume <jobId>'));
}

// `cloudferry status <jobId>` — detailed counts + failures for one job.
function statusCommand(jobId) {
  if (!jobId) {
    const jobs = Store.list().filter((j) => !j.broken);
    if (!jobs.length) { console.log('No jobs found.'); return; }
    jobId = jobs[jobs.length - 1].id;
  }
  const store = Store.open(jobId);
  const cnt = store.counts();
  const j = store.job;
  console.log(c.bold(`Job ${j.id}`));
  console.log(c.dim('─'.repeat(50)));
  console.log(`  Route       ${j.fromLabel || j.from} → ${j.toLabel || j.to}`);
  console.log(`  Source root ${j.srcRoot || '(account root)'}`);
  console.log(`  Dest root   ${j.destRoot || '(account root)'}`);
  console.log(`  Discovery   ${j.discoveryComplete ? c.green('complete') : c.yellow('incomplete')}`);
  console.log('');
  console.log(`  Files       ${formatNumber(cnt.filesTotal)} total`);
  console.log(`    ${c.green('done')}      ${formatNumber(cnt.done)}  (${formatBytes(cnt.bytesDone)})`);
  console.log(`    pending   ${formatNumber(cnt.pending + cnt.active)}`);
  if (cnt.failed) console.log(`    ${c.red('failed')}    ${formatNumber(cnt.failed)}`);
  if (cnt.skipped) console.log(`    skipped   ${formatNumber(cnt.skipped)}`);
  console.log(`  Data        ${formatBytes(cnt.bytesDone)} / ${formatBytes(cnt.bytesTotal)}`);

  if (cnt.failed) {
    console.log('');
    console.log(c.bold('  Failures:'));
    let n = 0;
    for (const item of store.items.values()) {
      if (item.status === 'failed' && n < 15) { console.log(`    ${c.red('✗')} ${item.path} ${c.dim('— ' + (item.error || ''))}`); n++; }
    }
    if (cnt.failed > 15) console.log(c.dim(`    …and ${cnt.failed - 15} more`));
  }
  store.close();
}

module.exports = { jobsCommand, statusCommand };
