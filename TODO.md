# TODO

## Publish to npm (needs Sherif's input)

Publishing would let the getting-started command drop the `github:` spec and
become versioned/trusted:

```bash
claude mcp add cloudferry -- npx -y cloudferry@latest mcp
```

**Blocked on input / credentials from you:**

- [ ] **Package name.** Is `cloudferry` available on npm, or should we use a
      scope like `@sherifmak/cloudferry`? (Your call — affects the command.)
- [ ] **npm account + access.** An npm login/token with publish rights (and 2FA
      if enabled). This is yours to provide; I can't create or hold it.
- [ ] **Org/owner metadata.** Confirm `author`, `license`, and the public repo
      URL to put in `package.json`.

**Once unblocked, I'll handle the mechanics:**

- [ ] Add `repository`, `homepage`, `bugs`, `author` to `package.json`.
- [ ] Add a `prepublishOnly` script that runs `node --test` so a broken build
      can't be published.
- [ ] Verify the published tarball contents (`npm pack` dry run) — should ship
      `bin/`, `src/`, `README.md` only (already constrained via `files`).
- [ ] `npm publish` (with `--access public` if scoped).
- [ ] Update README + `docs/AGENTS.md` to `npx -y cloudferry mcp` and add a
      version badge.

Until then, the `npx -y github:sherifmak/storage-migration mcp` command works
today with no publish required.
