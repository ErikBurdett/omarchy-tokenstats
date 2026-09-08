# Security

## Reporting a vulnerability

Use the [private advisory form](https://github.com/ErikBurdett/omarchy-tokenstats/security/advisories/new)
for vulnerabilities. Include the affected commit and a safe reproduction; omit
credentials, session transcripts and other private data from public issues.

## Runtime access

Token Stats runs with the user's privileges inside `omarchy-shell`.

| Access | Scope |
|---|---|
| Reads | `/proc/meminfo`; loopback llama.cpp/llama-swap endpoints; OpenCode's config and read-only database; default-location Claude Code/Codex JSONL logs |
| Writes | `~/.local/state/omarchy/tokenstats/` only: history, panel overrides, agent totals and cursors |
| Commands | Absolute `/usr/bin/curl`, `/usr/bin/sqlite3`, `/usr/bin/python3`, `/usr/bin/install`, `/usr/bin/omarchy-launch-tui` |

No sudo or pkexec is required. The plugin does not install software, rewrite
`shell.json` or the tools' configurations, or download and execute code. The
manual clone instructions and optional server restart command in the README
are user actions, not widget actions.

## Bounded agent scanning

`scripts/scan-agents.py` replaces the former shell/find/sort/jq/head pipeline.
Python runs with `-I -S` and a cleared environment: no user site packages,
startup customization, inherited search paths or subprocess commands. The
scanner creates a private session and starts **no descendants or threads**.

It walks directories incrementally, pins directories and opens log files with
`O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC`, and validates the descriptor actually
read with `fstat`. Symlinks and special files cannot redirect or block reads.
Checks on file identity and prior bytes reject replaced/truncated logs rather
than silently replaying them.

The scanner has independent limits on file bytes per pass, total bytes per
pass, line length, line count, directory traversal, output rows, cursor state,
serialized output, CPU time, address space and wall time. Large files resume
at persisted offsets. A long single record is discarded in bounded chunks;
the persistent skipped-record count keeps the result marked incomplete.
Malformed records are also explicitly reported as incomplete.

| Budget | Limit |
|---|---|
| Log bytes per file / per pass | 16 MiB / 128 MiB, including buffered read-ahead; cursor anchors additionally read at most 256 bytes before and after each file |
| JSONL record / line count | 256 KiB per record; 50,000 lines per file and 500,000 per pass |
| Traversal / retained files | 4,096 entries, depth 16, 400 files |
| Retained Claude IDs / output usage rows | 16,384 IDs / 2,000 rows per pass |
| Cursor input / serialized output | 2 MiB / 4 MiB |
| Wall / CPU / address space | 8 seconds / 8 seconds soft and 9 seconds hard / 256 MiB |

Byte/row work limits resume on later passes. File, traversal, depth and
deduplication capacity limits need a smaller source set and are reported as
limits, not as a promise that another pass will finish.

No complete log, directory listing or session-event array is materialized.
Sessions are derived from bounded metadata accumulated during usage scans.
Claude message IDs are hashed and retained within a fixed deduplication bound;
Codex repeated cumulative counters add no duplicate usage. A cursor bound is
an explicit failure, never permission to discard deduplication state.

Each accepted batch carries validated rows and a revisioned cursor. The model
validates the complete envelope before applying either. Totals and cursor are
saved in the same atomic state file; failed scans and replayed revisions leave
both unchanged. Timestamps are bucket labels, not the import deduplication key.

## Process cancellation and reaping

Every reader, including state-directory creation, has a QML watchdog. A
watchdog sends TERM, allows a two-second grace period, and sends KILL only if
that same Process still has the cancelled PID. It cannot kill a replacement
invocation or another reader. The helpers also enforce their own deadlines.

On widget destruction, callbacks are prevented from starting more work and
all readers are terminated immediately. Quickshell's `Process` owns and reaps
each direct child. In particular, the scanner's PID is the **only member of its
private process group**: there are no `find`, `sort`, `jq`, shell or `head`
children to survive a parent-only signal. Destruction cannot defer cleanup to
a QML timer that is being destroyed. Immediate KILL on destruction covers the
whole scanner group because that group contains exactly one process.

The terminal launcher is a deliberate user action. It starts an independent
terminal session, which outlives the popup; closing the popup does not close
the user's terminal. Its short-lived wrapper has a watchdog. Session IDs are
validated before entering argv; the working directory is a Process property,
not shell text. The tools' absolute mise shim paths are user-owned code run
with the user's existing privileges, with no privilege transition.

## Loopback and SQLite

Endpoint overrides and discovered model IDs are validated at use. Every curl
runs with a cleared environment, `-q`, `--noproxy '*'`, `--max-time 4`, and
`--max-filesize 262144`. No redirects are followed. Proxy environment variables
and curl startup files cannot change the request destination.

SQLite runs with a cleared environment and `-readonly -safe -noinit -batch`,
against a `mode=ro` URI. Queries limit rows and text-column lengths; selected
numeric JSON values are cast to integers, so a string in an alleged token
field cannot bypass the producer's byte bound. Provider IDs are validated
immediately before building the `IN` clause; invalid-only lists select nothing.
The import fetches one overflow row and commits only complete timestamp groups,
so a full batch cannot advance coverage past unscanned replies.

The launcher alone receives an allow-list of desktop session variables and a
fixed `/usr/local/bin:/usr/bin` PATH, for Omarchy's own terminal launcher.

## Configuration, storage and UI

OpenCode configuration is read by `scripts/read-config.py`, not `FileView`.
The helper opens every path component without following symlinks, requires an
owned regular file, and reads at most 256 KiB plus one overflow byte. JSON
structure is bounded to depth 64 and 16,384 values; its wall deadline is three
seconds. Invalid or unavailable configuration yields no providers. Symlinked
XDG config paths must be configured using their resolved real path.

`FileView` is used only for kernel memory data and plugin-owned state. The
plugin creates its state directory with mode 0700 and writes JSON atomically
through `FileView.atomicWrites`. State is parsed as data, never executed; schema,
version, finite numeric values, key lengths and collection sizes are validated.
Agent histories have a separate format version, so an agent import repair does
not discard local throughput history.

The plugin's state directory is user-controlled. `FileView` loads owned state
before the model's parse limits (4 MiB local history, 16 MiB combined agent
histories and cursors); it is not claimed to provide a bounded
reader for arbitrary third-party files. Protecting against another program
running as the same user replacing this private state remains outside that
storage boundary.

Settings from both the panel and `shell.json` pass the same coercion rules;
invalid numbers fall back rather than reaching timers as NaN. Model identifiers
cannot collide with JavaScript prototype keys. All external text in the panel
is rendered with `Text.PlainText`.
