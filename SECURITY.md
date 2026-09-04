# Security

## Reporting a vulnerability

Please report privately through GitHub's
[security advisory form](https://github.com/ErikBurdett/omarchy-tokenstats/security/advisories/new)
rather than a public issue. Include the affected commit, what you observed, and
a safe reproduction if you have one. Please do not include credentials or
exploit detail in a public thread.

## What this plugin can reach

It runs unsandboxed inside `omarchy-shell`, with your user's privileges. Being
explicit about what it actually touches:

| | |
|---|---|
| **Reads** | `/proc/meminfo`; llama-swap over loopback; OpenCode's database, **read-only** |
| **Writes** | `~/.local/state/omarchy/tokenstats/` only |
| **Runs** | `curl`, `sqlite3`, `mkdir`, `omarchy-launch-tui` — absolute paths, argv arrays, no shell |
| **Never** | writes user configuration, uses `sudo`/`pkexec`, installs anything, or reaches a non-loopback host |

## Boundaries that are deliberate

- The llama-swap endpoint from settings is pattern-matched to loopback, so a
  `shell.json` edit cannot redirect the fetch to another host.
- Session ids are validated against `^ses_[A-Za-z0-9]{1,64}$` before reaching
  the launcher, and the working directory is set as a process property rather
  than concatenated into a command string.
- OpenCode's database is opened with `sqlite3 -readonly` against a `mode=ro`
  URI. Both queries are bounded with `LIMIT` and `substr`.
- Every parser caps input length and line count and rejects malformed input
  outright rather than half-populating a record.
- State is written through `FileView.atomicWrites` into a directory the plugin
  creates for itself.
- Every subprocess has a killing watchdog and destruction teardown.

If you find somewhere these do not hold, that is worth reporting.
