#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli');
const { c } = require('../src/util/ansi');

main(process.argv.slice(2)).catch((err) => {
  // Keep the cursor usable if we died mid-dashboard.
  if (process.stdout.isTTY) process.stdout.write('\x1b[?25h');
  console.error('\n' + c.red('Error: ') + (err && err.message ? err.message : String(err)));
  if (process.env.CLOUDFERRY_DEBUG && err && err.stack) console.error(c.dim(err.stack));
  process.exitCode = 1;
});
