'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cloudferry.js');

// Drive the MCP server over stdio and collect responses keyed by id.
function talk(messages, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-mcp-'));
    const child = spawn(process.execPath, [CLI, 'mcp'], { env: { ...process.env, CLOUDFERRY_HOME: home } });
    const responses = new Map();
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP test timed out')); }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { const msg = JSON.parse(line); if (msg.id != null) responses.set(msg.id, msg); } catch { /* ignore */ }
      }
      const wantIds = messages.filter((m) => m.id != null).map((m) => m.id);
      if (wantIds.every((id) => responses.has(id))) {
        clearTimeout(timer);
        child.kill();
        fs.rmSync(home, { recursive: true, force: true });
        resolve(responses);
      }
    });
    child.on('error', reject);
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
  });
}

test('MCP: initialize, tools/list and a tool call work over stdio', async () => {
  const res = await talk([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_providers', arguments: {} } },
  ]);

  const init = res.get(1);
  assert.equal(init.result.serverInfo.name, 'cloudferry');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);

  const tools = res.get(2).result.tools.map((t) => t.name);
  for (const expected of ['list_providers', 'connect_account', 'start_migration', 'migration_status', 'pause_migration', 'resume_migration']) {
    assert.ok(tools.includes(expected), `tools/list should include ${expected}`);
  }

  const call = res.get(3);
  const payload = JSON.parse(call.result.content[0].text);
  assert.equal(payload.length, 3);
  assert.ok(payload.find((p) => p.id === 'dropbox'));
});

test('MCP: unknown tool returns an isError result, not a crash', async () => {
  const res = await talk([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'does_not_exist', arguments: {} } },
  ]);
  const call = res.get(2);
  assert.ok(call.error || (call.result && call.result.isError), 'should signal an error');
});
