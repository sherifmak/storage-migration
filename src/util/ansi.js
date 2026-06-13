'use strict';

// Tiny ANSI helper so we don't pull in a colour dependency. Colour output is
// disabled automatically when stdout is not a TTY or when NO_COLOR is set
// (https://no-color.org/).

const ESC = '\x1b';
const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function wrap(open, close) {
  return (str) => (enabled ? `${ESC}[${open}m${str}${ESC}[${close}m` : String(str));
}

const c = {
  enabled,
  reset: `${ESC}[0m`,
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  inverse: wrap(7, 27),
  black: wrap(30, 39),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  white: wrap(37, 39),
  gray: wrap(90, 39),
  grey: wrap(90, 39),
};

// Cursor / screen control sequences (only emitted on a TTY).
const ctl = {
  hideCursor: () => (enabled ? process.stdout.write(`${ESC}[?25l`) : undefined),
  showCursor: () => (enabled ? process.stdout.write(`${ESC}[?25h`) : undefined),
  clearScreen: () => (enabled ? process.stdout.write(`${ESC}[2J${ESC}[H`) : undefined),
  moveTo: (row, col = 1) => (enabled ? `${ESC}[${row};${col}H` : ''),
  clearLine: enabled ? `${ESC}[2K` : '',
  home: enabled ? `${ESC}[H` : '',
};

// Visible length of a string, ignoring ANSI escape codes.
function visibleLength(str) {
  // eslint-disable-next-line no-control-regex
  return String(str).replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g'), '').length;
}

module.exports = { c, ctl, visibleLength };
