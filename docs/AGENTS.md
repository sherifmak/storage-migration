# Driving CloudFerry from a coding agent

CloudFerry ships an **MCP server** so any MCP-capable coding agent — Claude Code,
Cursor, Windsurf, Zed, etc. — can run a migration for you. You just connect your
accounts once, then tell your agent something like *"migrate my Dropbox /Photos
folder to Google Drive and keep an eye on it"* and it drives the whole thing.

There are two ways to wire it up. Most people want **option A (MCP)**.

---

## A. MCP server (recommended)

CloudFerry is a standard MCP **stdio** server with zero dependencies, and it
runs straight from GitHub via `npx` — no clone, no install. Every MCP client
needs the same two things:

- **command:** `npx`
- **args:** `-y github:sherifmak/storage-migration mcp`

### The config most clients use

Cursor, Windsurf, Claude Desktop/Code, Cline, Gemini CLI and most others use the
`mcpServers` shape:

```json
{
  "mcpServers": {
    "cloudferry": {
      "command": "npx",
      "args": ["-y", "github:sherifmak/storage-migration", "mcp"]
    }
  }
}
```

VS Code uses a top-level `servers` object with an explicit `type`:

```json
{
  "servers": {
    "cloudferry": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:sherifmak/storage-migration", "mcp"]
    }
  }
}
```

### Where that config goes (by client)

| Client | Location / command |
| --- | --- |
| Claude Code | `claude mcp add cloudferry -- npx -y github:sherifmak/storage-migration mcp` |
| Claude Desktop | `claude_desktop_config.json` |
| Cline (VS Code ext.) | the extension's `cline_mcp_settings.json` |
| Cursor | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global) |
| Gemini CLI | `~/.gemini/settings.json` (`mcpServers`) |
| VS Code (Copilot agent) | `.vscode/mcp.json` — use the `servers` shape above |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Any other MCP client | command `npx`, args `-y github:sherifmak/storage-migration mcp` |

When in doubt, consult your agent's own "MCP servers" docs — the values are
always the `command`/`args` above.

<details>
<summary>Alternative: install locally (offline / development)</summary>

```bash
git clone https://github.com/sherifmak/storage-migration cloudferry && cd cloudferry
npm install        # zero dependencies
npm link           # puts `cloudferry` on your PATH
# then point your agent at:  command "cloudferry", args ["mcp"]
```

</details>

That's it. The agent now has these tools:

| Tool | What it does |
| --- | --- |
| `list_providers` | The providers it can move between |
| `get_setup_guide` | Step-by-step API-key instructions for a provider (show these to the user) |
| `list_accounts` | Accounts already connected, with their `key` |
| `connect_account` | Connect an account via OAuth (**opens the user's browser**) |
| `start_migration` | Start a migration in the **background**, returns a `jobId` |
| `migration_status` | Live status: state, %, files/bytes, speed, ETA, failures |
| `list_jobs` | All jobs and their status |
| `pause_migration` | Safely pause a running migration |
| `resume_migration` | Resume a paused/interrupted migration (optionally retry failures) |

### The typical flow your agent will follow

1. **`list_accounts`** — is the source/destination already connected?
2. If not: **`get_setup_guide`** for the provider, relay the steps so the user
   creates an OAuth app and pastes back their Client ID (and Secret for Google
   Drive / Box — Dropbox uses PKCE and needs none), then **`connect_account`**.
   *A browser window opens for the user to approve; the call blocks until they do.*
3. **`start_migration`** with `from`, `to`, and optional `src_root` / `dest_root`.
   This returns immediately with a `jobId` — the migration runs in the
   background and survives the agent session ending, your laptop sleeping, and
   network drops.
4. **Poll `migration_status`** every so often and report progress. The job is
   finished when `state` is `complete` (or `completed_with_failures`).
5. If anything failed, **`resume_migration`** with `retry_failed: true`.

> **Why background?** Migrations can run for hours or days. `start_migration`
> intentionally does not block — it hands back a `jobId` and the agent polls.
> Progress is journalled to disk, so `migration_status` is accurate even across
> restarts, and `resume_migration` always continues from where it stopped.

### A note on `connect_account`

OAuth consent inherently needs a human + a browser. `connect_account` opens the
user's default browser and waits (up to ~5 minutes) for them to approve. If a
browser can't open (e.g. a remote box), the authorize URL is written to the
server's stderr. For headless setups, it's often easiest to run the one-time
`cloudferry connect <provider>` in a terminal instead, then let the agent use
the already-connected account.

---

## B. Plain CLI with JSON (no MCP)

If your agent prefers shelling out, every relevant command speaks JSON and can
run detached:

```bash
cloudferry accounts                         # (human) one-time: connect accounts
cloudferry connect dropbox                  # (human) guided OAuth

# Start in the background, get a jobId as JSON:
cloudferry migrate --from dropbox --to gdrive \
  --src-root /Photos --dest-root root --yes --detach --json
# -> { "jobId": "dropbox-to-gdrive-...", "pid": 12345, "detached": true }

# Poll until state is "complete":
cloudferry status <jobId> --json
cloudferry jobs --json

# Control:
cloudferry stop <jobId>                      # pause safely
cloudferry resume <jobId> --detach           # resume in background
cloudferry resume <jobId> --retry-failed --detach
```

`status --json` returns: `state`, `percent`, `files {total,done,failed,skipped,
pending}`, `bytes {total,done}`, `speedBytesPerSec`, `etaSeconds`, and a
`failures` list — everything an agent needs to narrate progress and decide what
to do next.

---

## Example: what the user says

> "Use CloudFerry to copy everything in my Dropbox to Box. Connect them if
> needed, then start it and tell me when it's done."

The agent calls `list_accounts`, walks the user through `get_setup_guide` +
`connect_account` for anything missing, calls `start_migration`, and then polls
`migration_status`, reporting progress until the job completes.
