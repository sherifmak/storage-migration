'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { formatBytes, formatDuration, fit } = require('../src/util/format');
const { isRetryable } = require('../src/util/retry');
const { visibleLength } = require('../src/util/ansi');

test('formatBytes scales units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1024 * 1024 * 1.5), '1.5 MB');
  assert.equal(formatBytes(1024 ** 3), '1.0 GB');
});

test('formatDuration handles unknown and normal values', () => {
  assert.equal(formatDuration(null), '--:--:--');
  assert.equal(formatDuration(0), '00:00:00');
  assert.equal(formatDuration(3661), '01:01:01');
});

test('fit middle-truncates and pads', () => {
  assert.equal(fit('short', 10, true).length, 10);
  const t = fit('a-really-long-file-name.mov', 12);
  assert.ok(t.length <= 12);
  assert.ok(t.includes('…'));
  assert.ok(t.endsWith('.mov'));
});

test('isRetryable: transient yes, permanent no', () => {
  assert.equal(isRetryable({ status: 500 }), true);
  assert.equal(isRetryable({ status: 429 }), true);
  assert.equal(isRetryable({ code: 'ECONNRESET' }), true);
  assert.equal(isRetryable({ status: 404 }), false);
  assert.equal(isRetryable({ status: 403, permanent: true }), false);
  assert.equal(isRetryable({ aborted: true }), false);
});

test('visibleLength ignores ANSI colour codes', () => {
  assert.equal(visibleLength('\x1b[31mred\x1b[39m'), 3);
  assert.equal(visibleLength('plain'), 5);
});
