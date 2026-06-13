'use strict';

const readline = require('node:readline');
const { c } = require('./ansi');

// Minimal interactive prompts built on readline — no dependency needed.

function ask(question, { defaultValue } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? c.dim(` [${defaultValue}]`) : '';
  return new Promise((resolve) => {
    rl.question(`${c.cyan('?')} ${question}${suffix} `, (answer) => {
      rl.close();
      const v = answer.trim();
      resolve(v === '' && defaultValue !== undefined ? defaultValue : v);
    });
  });
}

// Read a secret without echoing it to the terminal.
function askSecret(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(`${c.cyan('?')} ${question} `);
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const onData = (chunk) => {
      const str = chunk.toString('utf8');
      for (const ch of str) {
        if (ch === '\n' || ch === '\r' || ch === '') {
          if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(value.trim());
        } else if (ch === '') { // Ctrl-C
          process.stdout.write('\n');
          process.exit(130);
        } else if (ch === '' || ch === '\b') { // backspace
          if (value.length) { value = value.slice(0, -1); process.stdout.write('\b \b'); }
        } else {
          value += ch;
          process.stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function confirm(question, defaultYes = true) {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const ans = (await ask(`${question} ${c.dim(`(${hint})`)}`)).toLowerCase();
  if (ans === '') return defaultYes;
  return ans === 'y' || ans === 'yes';
}

// Single-choice list. `choices` = [{ name, value, hint }]. Returns the value.
async function select(question, choices) {
  console.log(`${c.cyan('?')} ${question}`);
  choices.forEach((ch, i) => {
    const hint = ch.hint ? c.dim(`  — ${ch.hint}`) : '';
    console.log(`  ${c.bold(String(i + 1))}) ${ch.name}${hint}`);
  });
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ans = await ask('Enter a number');
    const idx = Number(ans) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < choices.length) return choices[idx].value;
    console.log(c.red('  Please enter a valid number.'));
  }
}

module.exports = { ask, askSecret, confirm, select };
