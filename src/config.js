'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Everything CloudFerry persists lives under a single home directory so it is
// easy to find, back up, or wipe. Layout:
//
//   ~/.cloudferry/
//     config.json            app credentials + saved provider accounts (0600)
//     jobs/<jobId>/
//       job.json             job definition + live counters
//       manifest.jsonl       one line per discovered item (append-only)
//       journal.jsonl        item status changes (append-only, compacted)
//       migration.log        human-readable log
//       staging/             temp files mid-transfer

function homeDir() {
  if (process.env.CLOUDFERRY_HOME) return process.env.CLOUDFERRY_HOME;
  return path.join(os.homedir(), '.cloudferry');
}

function configPath() {
  return path.join(homeDir(), 'config.json');
}

function jobsDir() {
  return path.join(homeDir(), 'jobs');
}

function jobDir(jobId) {
  return path.join(jobsDir(), jobId);
}

function ensureHome() {
  fs.mkdirSync(homeDir(), { recursive: true });
  // Best-effort lockdown of the directory holding OAuth tokens.
  try { fs.chmodSync(homeDir(), 0o700); } catch { /* windows / unsupported */ }
}

function loadConfig() {
  ensureHome();
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return { apps: {}, accounts: {} };
    throw new Error(`Could not read config at ${configPath()}: ${err.message}`);
  }
}

// Atomic, restrictive-permission write so a crash never leaves a half-written
// credential file.
function saveConfig(config) {
  ensureHome();
  const tmp = configPath() + '.tmp';
  const data = JSON.stringify(config, null, 2);
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, configPath());
  try { fs.chmodSync(configPath(), 0o600); } catch { /* ignore */ }
}

module.exports = {
  homeDir,
  configPath,
  jobsDir,
  jobDir,
  ensureHome,
  loadConfig,
  saveConfig,
};
