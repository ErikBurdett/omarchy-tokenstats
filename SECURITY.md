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
| **Runs** | `curl`, `sqlite3`, `install -d`, `omarchy-launch-tui` — absolute paths, argv arrays, no shell, cleared environment |
| **Never** | writes user configuration, uses `sudo`/`pkexec`, installs anything, or reaches a non-loopback host |

## Boundaries that are deliberate

### Loopback really means loopback

The endpoint setting is pattern-matched to `127.0.0.1`/`localhost`, so a
`shell.json` edit cannot redirect the fetch. **That check alone is not
sufficient**, and the environment is why:

- `curl` honours `http_proxy`, `https_proxy` and `ALL_PROXY`, and reads
  `~/.curlrc`. Either one sends a loopback URL to an arbitrary host. Verified on
  a development machine: with `http_proxy` exported and no `--noproxy`, curl
  connects to the proxy rather than to `127.0.0.1`.
- So every `curl` runs with `clearEnvironment: true` and an empty environment,
  plus `--noproxy '*'` (ignore any proxy configuration) and `-q` (ignore
  `~/.curlrc`). Three independent reasons the request cannot leave the machine.

### sqlite3 cannot be steered by a config file either

`sqlite3` reads `$XDG_CONFIG_HOME/sqlite3/sqliterc`, else `~/.sqliterc`, and
executes its meta-commands *before* the query. Every invocation therefore uses
`-noinit` (refuse that file), `-safe` (refuse anything that could write, attach
or shell out), `-readonly`, and a `file:...?mode=ro` URI — with an empty
environment, so there is no `XDG_CONFIG_HOME` to point anywhere.

### Output is bounded at the producer, not after collection

`StdioCollector { waitForEnd: true }` buffers the complete stream before any
plugin code runs, so checking a length afterwards is not a cap. The bound is on
the producer in every case:

| Reader | Producer-side bound |
|---|---|
| `curl` | `--max-filesize 262144` and `--max-time 4`. Both llama-swap endpoints send `Content-Length`, so an oversized body is refused before the transfer starts (verified: exit 63). |
| `sqlite3` import | `LIMIT 20000` rows; the one text column wrapped in `substr(...,1,64)`. Everything else selected is an integer. |
| `sqlite3` sessions | `LIMIT 60` rows; every text column wrapped in `substr` (80/200/64/400/160 characters). |

Each parser then applies a second, independent cap on length, line count and
row count, so a malformed or hostile response is bounded twice.

### Process execution

Absolute paths (`/usr/bin/curl`, `/usr/bin/sqlite3`, `/usr/bin/install`,
`/usr/bin/omarchy-launch-tui`), fixed argv arrays, no shell anywhere, and no
`PATH` lookup. Model ids that reach a URL path are **validated** against
`^[A-Za-z0-9._-]{1,40}$` and dropped if they do not match — not sanitised, since
a repaired id would still be requested, just for the wrong model.

Every reader has a watchdog `Timer` that sends `SIGTERM` then `SIGKILL` and
clears `running`, wired to `Component.onDestruction` as well. `curl`, `sqlite3`
and `install` fork no children, so the process and its group are the same thing
and that is a complete teardown.

The session launcher is the exception and is deliberate: `omarchy-launch-tui`
execs `setsid uwsm-app -- xdg-terminal-exec`, so the terminal is in its own
session and outlives the plugin *by design* — that is what "open a terminal"
means. Only the short-lived wrapper is tracked, and it is not killed at
destruction, because doing so would race a terminal the user just asked for and
would not reach the detached session anyway. It still has a watchdog so a wedged
exec cannot block the next click.

It is also the one process that needs a session to talk to, so it cannot run
with an empty environment. It gets an explicit allow-list — `HOME`, `USER`,
`XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY`, `HYPRLAND_INSTANCE_SIGNATURE`,
`DBUS_SESSION_BUS_ADDRESS`, `XDG_CURRENT_DESKTOP`, `XDG_SESSION_TYPE`, `LANG` —
and a **fixed `PATH` of `/usr/local/bin:/usr/bin`**, because
`omarchy-launch-tui` resolves `setsid`, `uwsm-app` and `xdg-terminal-exec`
through `PATH` and an inherited one is the single place a user-writable
directory could decide what actually runs.

It launches `~/.local/share/mise/shims/opencode`, which is under `$HOME` and so
user-writable. That is not a privilege boundary here: nothing in this plugin is
ever privileged, it already runs with the user's own rights, and the target is
the user's own interpreter shim — the thing they asked to open. There is no
authorization for a swapped pathname to be spent against.

### Files

- `/proc/meminfo` is a kernel file. The state file lives in a directory the
  plugin creates with `install -d -m 700`, which sets the mode on an existing
  directory too — so an install predating that change is corrected rather than
  left at `0755` forever. Nothing else can place a symlink or a FIFO there
  without already being this user.
- `FileView` does read a whole file before any size check, which is why it is
  pointed only at those two paths and never at anything another party writes.
  `parseHistory` rejects input over 4 MiB, rejects any version but the current
  one, and validates every key against a date pattern and every value for type,
  sign, finiteness and cardinality before it reaches a runtime value or a
  `Repeater`.
- Writes go through `FileView.atomicWrites` (temporary file plus rename), so a
  crash or a full disk cannot leave a half-written state file behind.
- **Persisted state is never executed.** It is JSON, parsed with `JSON.parse`,
  and every field is treated as untrusted data.

### Untrusted text

Every one of the 21 `Text` elements in the panel sets
`textFormat: Text.PlainText`. Session titles, working directories and model
names come from OpenCode's database and llama-swap, and none of them is
authored by this plugin.

If you find somewhere these do not hold, that is worth reporting.
