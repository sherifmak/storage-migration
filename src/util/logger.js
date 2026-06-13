'use strict';

const fs = require('node:fs');
const path = require('node:path');

// A small append-only logger. Everything is written to a per-job log file so
// that the live dashboard can stay clean while a full audit trail is kept on
// disk for debugging long migrations.
class Logger {
  constructor(filePath) {
    this.filePath = filePath;
    this.stream = null;
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      this.stream = fs.createWriteStream(filePath, { flags: 'a' });
    }
  }

  _write(level, msg, meta) {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}` +
      (meta ? ` ${safeJson(meta)}` : '');
    if (this.stream) this.stream.write(line + '\n');
  }

  info(msg, meta) { this._write('INFO', msg, meta); }
  warn(msg, meta) { this._write('WARN', msg, meta); }
  error(msg, meta) { this._write('ERROR', msg, meta); }
  debug(msg, meta) { if (process.env.CLOUDFERRY_DEBUG) this._write('DEBUG', msg, meta); }

  async close() {
    if (!this.stream) return;
    await new Promise((resolve) => this.stream.end(resolve));
    this.stream = null;
  }
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

module.exports = { Logger };
