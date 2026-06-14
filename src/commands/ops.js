'use strict';

const core = require('../core');
const { c } = require('../util/ansi');
const { formatBytes, formatNumber, formatDuration } = require('../util/format');

// `cloudferry run <jobId>` — headless engine runner. Invoked by the detached
// background process; also usable directly (no TUI, machine-friendly).
async function runCommand(jobId) {
  if (!jobId) throw new Error('Usage: cloudferry run <jobId>');
  const { state } = await core.runHeadless(jobId);
  console.log(`[cloudferry] job ${jobId} finished: ${state}`);
}

// `cloudferry stop <jobId>` — pause a background migration safely.
function stopCommand(jobId, opts = {}) {
  const res = core.pauseMigration(jobId);
  if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
  if (res.paused) console.log(c.yellow(`Pausing job ${res.jobId} (pid ${res.pid}) — progress is being saved.`));
  else console.log(c.dim(`No running migration to stop for ${res.jobId} (${res.reason || res.error || 'not running'}).`));
}

// JSON variant of status, for agents/scripts.
function statusJson(jobId) {
  console.log(JSON.stringify(core.statusOf(jobId), null, 2));
}

// JSON list of jobs.
function jobsJson() {
  const jobs = core.listJobs().map((j) => {
    if (j.broken) return { id: j.id, broken: true };
    try { return core.statusOf(j.id); } catch { return { id: j.id }; }
  });
  console.log(JSON.stringify(jobs, null, 2));
}

module.exports = { runCommand, stopCommand, statusJson, jobsJson };
