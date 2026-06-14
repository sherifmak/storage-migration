'use strict';

const { parseArgs } = require('node:util');
const { c } = require('./util/ansi');
const { connectCommand } = require('./commands/connect');
const { accountsCommand } = require('./commands/accounts');
const { migrateCommand, resumeCommand } = require('./commands/migrate');
const { jobsCommand, statusCommand } = require('./commands/jobs');
const { guideCommand } = require('./commands/guide');

const VERSION = require('../package.json').version;

const OPTIONS = {
  from: { type: 'string' },
  to: { type: 'string' },
  'src-root': { type: 'string' },
  'dest-root': { type: 'string' },
  concurrency: { type: 'string', short: 'c' },
  overwrite: { type: 'boolean' },
  port: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  'retry-failed': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    console.error(c.red(err.message));
    printHelp();
    process.exitCode = 2;
    return;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;

  if (values.version) { console.log(`cloudferry ${VERSION}`); return; }
  if (values.help || !command) { printHelp(); return; }

  const opts = {
    from: values.from,
    to: values.to,
    srcRoot: values['src-root'],
    destRoot: values['dest-root'],
    concurrency: values.concurrency,
    overwrite: values.overwrite,
    port: values.port ? Number(values.port) : undefined,
    yes: values.yes,
    retryFailed: values['retry-failed'],
  };

  switch (command) {
    case 'connect': return connectCommand(rest[0], opts);
    case 'accounts': return accountsCommand(rest[0], rest[1]);
    case 'migrate': case 'start': return migrateCommand(opts);
    case 'resume': return resumeCommand(rest[0], opts);
    case 'jobs': case 'list': return jobsCommand();
    case 'status': return statusCommand(rest[0]);
    case 'guide': case 'setup': return guideCommand(rest[0], opts);
    case 'providers': {
      const { listProviders } = require('./providers');
      console.log(c.bold('Supported providers:'));
      for (const p of listProviders()) console.log(`  • ${p.name}  ${c.dim('(' + p.id + ')')}`);
      return;
    }
    case 'help': return printHelp();
    default:
      console.error(c.red(`Unknown command: ${command}`));
      printHelp();
      process.exitCode = 2;
  }
}

function printHelp() {
  const b = c.bold;
  console.log(`
${b(c.cyan('CloudFerry'))} — resumable cloud-storage migration for your terminal.
Move files between ${b('Dropbox')}, ${b('Google Drive')} and ${b('Box')} — built for
huge transfers that run for hours or days and survive dropped connections.

${b('USAGE')}
  cloudferry <command> [options]

${b('GETTING STARTED')}
  ${c.cyan('cloudferry connect')}            Connect a cloud account (guided API-key setup)
  ${c.cyan('cloudferry migrate')}            Start a migration (interactive wizard)

${b('COMMANDS')}
  connect [provider]        Connect an account: dropbox | gdrive | box
  guide [provider]          Show how to create the API app for a provider
  accounts                  List connected accounts
  accounts remove <key>     Disconnect an account
  providers                 List supported providers
  migrate                   Create and run a migration
  resume [jobId]            Resume a paused/interrupted migration
  jobs                      List all migration jobs
  status [jobId]            Show detailed status for a job

${b('MIGRATE OPTIONS')}
  --from <key>              Source account key (see: cloudferry accounts)
  --to <key>                Destination account key
  --src-root <path|id>      Source folder (default: whole account)
  --dest-root <path|id>     Destination folder (default: account root)
  -c, --concurrency <n>     Parallel transfers (default: 4)
  --overwrite               Re-transfer files even if already at the destination
                            (default: skip files that already exist with same size)
  -y, --yes                 Skip confirmation prompts

${b('RESUME OPTIONS')}
  --retry-failed            Re-queue files that previously failed

${b('OTHER')}
  --port <n>                Local OAuth redirect port (default: 53682)
  -h, --help                Show this help
  -v, --version             Show version

${c.dim('Tip: press Ctrl-C during a migration to pause safely — progress is saved')}
${c.dim('and you can pick up exactly where you left off with `cloudferry resume`.')}
`);
}

module.exports = { main };
