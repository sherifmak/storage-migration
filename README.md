# CloudFerry 🚢

**Resumable, terminal-based migration of large cloud storage between Dropbox, Google Drive and Box.**

CloudFerry moves your files from one cloud provider to another, straight from
your terminal. It's built for the painful case: **huge migrations** — hundreds
of gigabytes, hundreds of thousands of files — that run for **hours or days**.
Connections drop, laptops go to sleep, tokens expire. CloudFerry is designed so
that none of that loses your progress: pause any time, close your laptop, lose
Wi‑Fi — then pick up exactly where you left off.

```
╔══════════════════════════════════════════════════════════════════╗
║ CloudFerry  ·  Dropbox → Google Drive                              ║
╟────────────────────────────────────────────────────────────────────╢
║ Overall  ██████████████░░░░░░░░░░░░░░  52%                         ║
║ Files 12,403/23,910      Data 142.3 GB/271.0 GB                    ║
║ Speed 48.2 MB/s   ·   ETA 00:41:12   ·   Elapsed 02:13:55         ║
║ Active 4   Failed 0   Skipped 0   Pending 11,503                  ║
╟─ Workers ──────────────────────────────────────────────────────────╢
║ 1 ⬆ photos/2021/IMG_3920.mov            ████████░░  81%           ║
║ 2 ⬇ docs/Q3 Report.pdf                  ███░░░░░░░  31%           ║
║ 3   idle                                                          ║
║ 4 ⬆ archive/backup.zip                  ██████████  99%           ║
╟─ Recent ───────────────────────────────────────────────────────────╢
║ ✓ music/track01.flac                                              ║
╚══════════════════════════════════════════════════════════════════╝
  Press Ctrl-C to pause safely — progress is saved, resume anytime.
```

## ⚡ Get started in one command (with your coding agent)

Let an AI coding agent run the whole migration for you. Register CloudFerry's
MCP server with a single command — no clone, no install (it runs straight from
GitHub via `npx`):

**Claude Code**

```bash
claude mcp add cloudferry -- npx -y github:sherifmak/storage-migration mcp
```

**Cursor / Windsurf / Claude Desktop / Zed** — add this to your MCP config:

```json
{ "mcpServers": { "cloudferry": { "command": "npx", "args": ["-y", "github:sherifmak/storage-migration", "mcp"] } } }
```

Then just ask your agent, e.g. *"Use CloudFerry to migrate my Dropbox /Photos
folder to Google Drive, connect the accounts if needed, and tell me when it's
done."* The agent walks you through getting API keys, starts the migration in
the background, and reports progress until it finishes. Full guide:
**[docs/AGENTS.md](docs/AGENTS.md)**.

> Prefer the plain terminal? Jump to [Install](#install) and [Quick start](#quick-start).

## Why CloudFerry

- **Resumable by design.** Every file's progress is journalled to disk. After a
  crash, a `Ctrl-C`, or a dead connection, `cloudferry resume` continues from
  the exact byte it stopped at — including *within* a single large file, using
  each provider's chunked/resumable upload protocol.
- **Survives flaky networks.** Automatic retries with exponential backoff,
  honouring `Retry-After`, and transparent OAuth token refresh (including Box's
  rotating refresh tokens) so a multi-day run keeps going unattended.
- **A genuinely nice TUI.** A live ASCII dashboard shows overall progress,
  per‑worker activity, throughput and ETA. Pipe it to a file or run it in CI and
  it degrades gracefully to periodic status lines.
- **Guided setup.** It walks you through creating the API app and finding your
  keys for each provider, step by step.
- **Zero runtime dependencies.** Pure Node.js (built‑ins only) — no native
  modules to compile, so it installs instantly and runs anywhere Node 18.17+ runs
  (macOS, Windows, Linux).

## Install

Requires **Node.js 18.17+** (Node 20+ recommended).

```bash
git clone <this-repo> cloudferry
cd cloudferry
npm install          # no dependencies — just links the `cloudferry` command
npm link             # optional: puts `cloudferry` / `cf` on your PATH
```

Or run it directly without linking:

```bash
node bin/cloudferry.js --help
```

## Quick start

```bash
# 1. Connect the account you're migrating FROM (guided API‑key setup)
cloudferry connect dropbox

# 2. Connect the account you're migrating TO
cloudferry connect gdrive

# 3. Start the migration (interactive wizard)
cloudferry migrate

# …pause any time with Ctrl-C, then later:
cloudferry resume
```

## Commands

| Command | What it does |
| --- | --- |
| `cloudferry connect [provider]` | Connect an account (`dropbox` \| `gdrive` \| `box`), with a guided API‑key walkthrough |
| `cloudferry guide [provider]` | Print just the API‑app setup instructions |
| `cloudferry accounts` | List connected accounts |
| `cloudferry accounts remove <key>` | Disconnect an account |
| `cloudferry migrate` | Create and run a migration (skips already-present files by default) |
| `cloudferry resume [jobId]` | Resume a paused/interrupted migration (newest job if omitted) |
| `cloudferry jobs` | List all migration jobs |
| `cloudferry status [jobId]` | Detailed counts and failures for a job |
| `cloudferry stop [jobId]` | Pause a background migration safely |
| `cloudferry mcp` | Run the MCP server so a coding agent can drive migrations |

## Let your coding agent do it

CloudFerry includes an **MCP server**, so an AI coding agent (Claude Code,
Cursor, Windsurf, …) can run the whole migration for you. Connect your accounts
once, then just ask: *"migrate my Dropbox /Photos to Google Drive and tell me
when it's done."*

Register it once (no clone or install needed — runs from GitHub via `npx`):

```bash
# Claude Code
claude mcp add cloudferry -- npx -y github:sherifmak/storage-migration mcp
```

```json
// Cursor / Windsurf / Claude Desktop  (mcpServers config)
{ "mcpServers": { "cloudferry": { "command": "npx", "args": ["-y", "github:sherifmak/storage-migration", "mcp"] } } }
```

The agent gets tools to connect accounts, start a migration in the background,
poll its progress, and pause/resume it. Migrations run detached, so they survive
the agent session ending. Full guide (including a plain‑CLI/JSON path with
`--detach` and `--json`): **[docs/AGENTS.md](docs/AGENTS.md)**.

### Non‑interactive migration

```bash
cloudferry migrate \
  --from "dropbox:dbid:abc" \
  --to   "gdrive:me@example.com" \
  --src-root "/Photos" \
  --dest-root "root" \
  --concurrency 6 \
  --yes
```

Add `--overwrite` to re-transfer files even if they already exist at the
destination. Use `cloudferry accounts` to see the `key` for each connected
account.

### Incremental re-runs (skip existing)

By default CloudFerry **skips files that already exist at the destination** with
a matching size — so re-running a migration (or running it again later to pick
up new files) won't re-upload everything, and a lost job database won't cause
duplicates. The check costs one folder listing per destination directory, and
folders CloudFerry creates during the run are known-empty so they're never
listed (a first run pays essentially nothing). Pass `--overwrite` to force a
full re-transfer instead.

- **Source / destination roots:**
  - Dropbox: a path like `/Photos` (blank = your whole Dropbox).
  - Google Drive: a folder **ID** (blank/`root` = My Drive).
  - Box: a folder **ID** (blank/`0` = All Files).

### Retrying failures

A long migration may leave a handful of files failed (permissions, a corrupt
source object, etc.). They're listed in `cloudferry status`, and you can retry
just those:

```bash
cloudferry resume <jobId> --retry-failed
```

## Getting your API keys

Each provider needs a small OAuth "app" that you create once (free). CloudFerry
prints exact, current steps when you run `cloudferry connect` or
`cloudferry guide <provider>`. In short:

- **Dropbox** — <https://www.dropbox.com/developers/apps> → *Create app* →
  *Scoped access* → *Full Dropbox*. Enable scopes `account_info.read`,
  `files.metadata.read`, `files.content.read`, `files.content.write`. Add the
  redirect URI `http://localhost:53682`. Copy the **App key** (Client ID).
  *No client secret needed — Dropbox uses PKCE.*
- **Google Drive** — <https://console.cloud.google.com/> → enable the **Google
  Drive API** → configure the OAuth consent screen (add yourself as a test
  user) → create an **OAuth client ID** of type **Desktop app**. Copy the
  **Client ID** and **Client secret**.
- **Box** — <https://app.box.com/developers/console> → *Create New App* →
  *Custom App* → *User Authentication (OAuth 2.0)*. Add redirect URI
  `http://localhost:53682`, enable *Read and write all files and folders*, and
  copy the **Client ID** and **Client Secret**.

The browser opens automatically for the consent step; a tiny local server on
port `53682` (override with `--port`) catches the redirect. If you change the
port, register `http://localhost:<port>` as the redirect URI accordingly.

## How resume works

- **Discovery first.** CloudFerry scans the source and writes an append‑only
  `manifest.jsonl` of every file and folder. Discovery completes before any
  transfer begins, so the work set is fixed and resumable.
- **Per‑item journal.** Each status change (and resume offsets/session IDs) is
  appended to `journal.jsonl`. On restart, the journal is replayed; anything
  that was mid‑flight is reset to *pending* with its saved offsets intact.
- **Staged transfers.** Each file is downloaded to a staging file, then uploaded
  with the destination's resumable protocol:
  - Dropbox `upload_session` (handles `incorrect_offset` corrections),
  - Google Drive resumable uploads (re‑queries the `308` offset),
  - Box chunked upload sessions (re‑lists uploaded parts, SHA‑1 verified).
  Downloads resume via HTTP `Range`. The staging file is deleted only after the
  upload succeeds.

This means you can `Ctrl‑C`, reboot, or lose connectivity at any moment and lose
at most the chunk that was in flight.

## Where your data lives

Everything is under `~/.cloudferry/` (override with `CLOUDFERRY_HOME`):

```
~/.cloudferry/
  config.json            API app credentials + OAuth tokens   (chmod 600)
  jobs/<jobId>/
    manifest.jsonl       every discovered item
    journal.jsonl        status + resume state
    job.json             job definition & counters
    migration.log        full activity log
    staging/             temp files for in‑flight transfers
```

**Security:** OAuth tokens are stored in `config.json` with `0600` permissions.
Treat that file like a password. Remove an account's tokens with
`cloudferry accounts remove <key>`.

## Notes & limitations

- **Google native docs** (Docs/Sheets/Slides) can't be copied byte‑for‑byte, so
  they're **exported**: Docs→`.docx`, Sheets→`.xlsx`, Slides→`.pptx`,
  Drawings→`.pdf`.
- **Disk space:** in‑flight files are staged to disk, so you need roughly
  `concurrency × (largest file size)` free space. Tune with `--concurrency`.
- **Integrity:** transfers are size‑verified end to end; chunked uploads are
  additionally hash‑verified by the provider (Box SHA‑1, Dropbox content hash).
- Shared drives / shared folders are included where the API exposes them.
- Versions, comments, and sharing permissions are **not** migrated — file
  content and folder structure are.

## Development

```bash
node --test        # run the test suite (store recovery, engine, utils)
CLOUDFERRY_DEBUG=1 node bin/cloudferry.js …   # verbose logging + stack traces
```

## License

MIT
