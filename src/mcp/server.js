'use strict';

// A zero-dependency Model Context Protocol (MCP) server over stdio, so any
// MCP-capable coding agent (Claude Code, Cursor, Windsurf, …) can drive
// CloudFerry migrations as tools. Implements the JSON-RPC 2.0 / newline-
// delimited stdio transport directly — no SDK, keeping the zero-dep promise.
//
// Run with:  cloudferry mcp

const readline = require('node:readline');
const core = require('../core');
const accounts = require('../auth/accounts');
const { listProviders, setupGuide } = require('../providers');

const SERVER_INFO = { name: 'cloudferry', version: require('../../package.json').version };
const DEFAULT_PROTOCOL = '2025-06-18';

// ---- tool definitions ------------------------------------------------------

const TOOLS = [
  {
    name: 'list_providers',
    description: 'List the cloud providers CloudFerry can migrate between (Dropbox, Google Drive, Box).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => listProviders(),
  },
  {
    name: 'get_setup_guide',
    description: 'Get step-by-step instructions for creating the OAuth API app a provider needs (where to click, which scopes, the redirect URI, and whether a client secret is required). Show these to the user so they can obtain their Client ID / Secret.',
    inputSchema: {
      type: 'object',
      properties: { provider: { type: 'string', enum: ['dropbox', 'gdrive', 'box'], description: 'Provider id' } },
      required: ['provider'],
    },
    handler: async ({ provider }) => setupGuide(provider),
  },
  {
    name: 'list_accounts',
    description: 'List cloud accounts already connected to CloudFerry, with their account "key" (used as from/to when starting a migration).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => accounts.listAccounts().map((a) => ({ key: a.key, provider: a.provider, label: a.label })),
  },
  {
    name: 'connect_account',
    description: 'Connect a cloud account using OAuth. Requires the user\'s Client ID (and Client Secret for Google Drive and Box; Dropbox uses PKCE and needs none). This OPENS THE USER\'S BROWSER for consent and blocks until they approve (or ~5 min timeout); tell the user to expect a browser window. Returns the connected account key.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['dropbox', 'gdrive', 'box'] },
        client_id: { type: 'string', description: 'OAuth app Client ID / App key' },
        client_secret: { type: 'string', description: 'OAuth app Client Secret (Google/Box only)' },
      },
      required: ['provider', 'client_id'],
    },
    handler: async ({ provider, client_id, client_secret }) =>
      accounts.connectWithCredentials(provider, { clientId: client_id, clientSecret: client_secret }),
  },
  {
    name: 'start_migration',
    description: 'Start a migration in the BACKGROUND and return immediately with a jobId. It keeps running after this call (designed for hours/days, survives interruptions). Poll progress with migration_status. "from"/"to" are account keys from list_accounts (a provider id also works if only one account of that provider is connected).',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source account key' },
        to: { type: 'string', description: 'Destination account key' },
        src_root: { type: 'string', description: 'Source folder (Dropbox path like /Photos, or a Drive/Box folder id). Blank = whole account.' },
        dest_root: { type: 'string', description: 'Destination folder (id/path). Blank = account root.' },
        concurrency: { type: 'number', description: 'Parallel transfers (default 4)' },
        overwrite: { type: 'boolean', description: 'Re-transfer files even if already present (default false = skip same-size files)' },
      },
      required: ['from', 'to'],
    },
    handler: async (a) => core.startMigration({
      from: a.from, to: a.to, srcRoot: a.src_root, destRoot: a.dest_root,
      concurrency: a.concurrency, overwrite: a.overwrite,
    }),
  },
  {
    name: 'migration_status',
    description: 'Get JSON status for a migration job (or the most recent one if job_id is omitted): state, percent complete, file/byte counts, speed, ETA, and any failures.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } } },
    handler: async ({ job_id }) => core.statusOf(job_id),
  },
  {
    name: 'list_jobs',
    description: 'List all migration jobs with their current status.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => core.listJobs().map((j) => (j.broken ? { id: j.id, broken: true } : safeStatus(j.id))),
  },
  {
    name: 'pause_migration',
    description: 'Safely pause a running background migration (progress is saved; resume later). Omit job_id for the most recent job.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } } },
    handler: async ({ job_id }) => core.pauseMigration(job_id),
  },
  {
    name: 'resume_migration',
    description: 'Resume a paused/interrupted migration in the background. Set retry_failed to also re-queue files that previously failed.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' }, retry_failed: { type: 'boolean' } },
    },
    handler: async ({ job_id, retry_failed }) => core.resumeMigration({ jobId: job_id, retryFailed: retry_failed }),
  },
];

function safeStatus(id) { try { return core.statusOf(id); } catch { return { jobId: id }; } }

// ---- JSON-RPC plumbing -----------------------------------------------------

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handleMessage(msg) {
  if (msg.method === undefined) return; // a response; we don't send requests
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return; // notifications: no response
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === (params && params.name));
        if (!tool) return replyError(id, -32602, `Unknown tool: ${params && params.name}`);
        try {
          const result = await tool.handler((params && params.arguments) || {});
          return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        } catch (err) {
          // Tool errors are reported as results with isError so the agent can react.
          return reply(id, { content: [{ type: 'text', text: `Error: ${err && err.message ? err.message : String(err)}` }], isError: true });
        }
      }
      default:
        if (isNotification) return;
        return replyError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (!isNotification) replyError(id, -32603, `Internal error: ${err && err.message ? err.message : String(err)}`);
  }
}

function startMcpServer() {
  // Never let stray stdout writes corrupt the protocol stream.
  console.log = (...args) => process.stderr.write(args.join(' ') + '\n');
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; } // ignore non-JSON lines
    Promise.resolve(handleMessage(msg)).catch(() => {});
  });
  rl.on('close', () => process.exit(0));
  process.stderr.write(`cloudferry MCP server ready (${SERVER_INFO.version})\n`);
  // Keep the process alive on stdin.
  return new Promise(() => {});
}

module.exports = { startMcpServer, TOOLS };
