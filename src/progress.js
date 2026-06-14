'use strict';

const fs = require('node:fs');
const path = require('node:path');

// A tiny, machine-readable snapshot of a running migration, written next to the
// job so that other processes (the MCP server, scripts, an agent polling
// `status --json`) can observe progress without a TTY or shared memory.

function progressPath(jobDir) { return path.join(jobDir, 'progress.json'); }
function pidPath(jobDir) { return path.join(jobDir, 'runner.pid'); }

function writeProgress(jobDir, snapshot) {
  const tmp = progressPath(jobDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...snapshot, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, progressPath(jobDir));
}

function readProgress(jobDir) {
  try { return JSON.parse(fs.readFileSync(progressPath(jobDir), 'utf8')); }
  catch { return null; }
}

function writePid(jobDir, pid = process.pid) {
  fs.writeFileSync(pidPath(jobDir), String(pid));
}

function readPid(jobDir) {
  try { return Number(fs.readFileSync(pidPath(jobDir), 'utf8')) || null; }
  catch { return null; }
}

function clearPid(jobDir) {
  try { fs.unlinkSync(pidPath(jobDir)); } catch { /* already gone */ }
}

// Is a process with this pid currently alive? (signal 0 = existence check)
function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // exists but not ours to signal
}

module.exports = { writeProgress, readProgress, writePid, readPid, clearPid, isAlive, pidPath };
