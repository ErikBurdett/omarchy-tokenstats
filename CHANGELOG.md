# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.5.0] — 2026-09-07

### Added

- **Claude Code and Codex tracking.** Both tools write the API's own exact
  usage to disk — Claude Code per assistant message under `~/.claude/projects`,
  Codex per turn in its rollout files — and a new `scripts/scan-agents.sh`
  reads those records with `jq`, read-only, behind a per-provider watermark.
  Steady-state scans touch only files changed since the last one. Duplicate
  streaming lines are deduplicated by message id; Codex turns come from
  `last_token_usage`, never the cumulative total.
- **An Agents pane** showing what each cloud agent consumed in the selected
  window, per model, with estimated spend at published per-1M rates (priced
  from a table in `TokenModel.js`; cache reads at a tenth of the input rate,
  cache writes folded into prompt at the plain rate, which errs a few percent
  low; the locally-run `gpt-oss` family and unknown models are shown as
  local/unpriced, never billed as cloud). Agent tokens live in their own
  `agents.json` and are deliberately never mixed into the local history or
  the savings figure — those tokens were paid for.
- **A unified sessions list.** The Sessions pane now shows OpenCode, Claude
  Code and Codex sessions in one list, newest first, each tagged with its
  source. Clicking a row resumes it with the right tool — `opencode
  --session`, `claude --resume`, or `codex resume` — in the session's own
  working directory.
- **Session search and filtering.** The Sessions pane gained source chips
  (All / OpenCode / Claude / Codex), a live search box matching title, model,
  directory and source label as you type, and a visible "N of M" count.
- **Agent graphs and history.** The Graph and History views gained a source
  selector (Local / Claude / Codex): pick an agent and the same chart, table
  and per-model rows read that agent's buckets, with estimated spend in the
  hero in place of a throughput rate. The savings block stays strictly local
  — it prices tokens that did not go to a hosted API, so it hides for agent
  sources rather than showing a meaningless number.
- IPC verbs to open the panel straight onto a pane, for keybindings:
  `sessions`, `agents`, and `graph local|claude|codex`.
- Two settings, `importClaude` and `importCodex` (both default on), in the
  manifest schema and the widget's Setup pane.
- A new `preview.png` showing the Claude graph, the Agents pane and the
  unified sessions list side by side.
- A tooltip line with what the agents generated in the bar's window, shown
  only when there is something to say.

## [1.4.0] — 2026-09-06

### Fixed

- **The plugin counted nothing on machines that are not set up like the
  author's.** Three things were hardcoded to one machine, each failing silently:
  - **Only llama-swap was supported.** A `llama-server` run directly serves its
    counters at `/metrics`, returns `404` for `/upstream/<id>/metrics`, and its
    `/v1/models` carries no `status` field at all — so nothing was ever
    identified as loaded and no endpoint was ever polled. The server shape is
    now detected and both are handled.
  - **The endpoint was fixed at `127.0.0.1:8080`.** It now defaults to `auto`
    and probes the usual loopback ports one per refresh until one answers, then
    stays there, and resumes looking if it goes away. An explicit endpoint still
    overrides, and is still accepted only if it is loopback.
  - **OpenCode imports were filtered to `providerID = 'local'`,** which is
    nothing but the name this machine's `opencode.json` happened to use. Local
    providers are now read from `opencode.json` — any provider whose `baseURL`
    points at loopback — so `llamacpp`, `lmstudio` or any other name works.
    Provider ids are validated against `^[A-Za-z0-9._-]{1,64}$` before being
    concatenated into SQL.
- OpenCode's database and config are located through `XDG_DATA_HOME` and
  `XDG_CONFIG_HOME` rather than an assumed `~/.local/share` and `~/.config`.

### Added

- `scripts/diagnose.sh` — read-only, loopback-only, never starts a model. Checks
  each thing the plugin needs in the order it needs them and names the one that
  is missing, so "showing nothing" is answerable without reading the source.
- The panel footer now names the endpoint it found, the server shape, and the
  providers it is importing. A zero says why it is zero.

## [1.3.1] — 2026-09-06

### Documentation

- The Requirements section now states exactly which setups count with zero
  configuration and which do not, as a table, rather than a claim. Enabling
  llama.cpp's `--metrics` is labelled optional where it is described.
- Added a reproducible recipe for verifying the no-configuration path: serve
  llama-swap's model list while refusing `/upstream/<model>/metrics` with `501`,
  stop the shell, delete all stored state, and start it again. Measured that way
  on the development machine, the plugin recorded 199,762 generated tokens
  across four days from OpenCode's records alone, with recorded generation
  seconds at exactly `0` — which is what proves none of it came from the live
  counters.

## [1.3.0] — 2026-09-06

### Added

- **A Setup pane in the widget's own panel.** Everything tunable — the window
  the bar averages over, all four assumed rates, the currency symbol, system
  watts, refresh interval and the OpenCode import — can now be changed by
  clicking the widget, without opening Setup > Plugins or editing any file.
  Changes apply immediately and across every monitor.
- `omarchy-shell io.github.erikburdett.tokenstats edit` opens the panel straight
  onto that pane, matching the convention Omarchy's own weather widget uses, so
  it can be bound to a key.

### Changed

- Panel-set values are stored in
  `~/.local/state/omarchy/tokenstats/settings.json`, a file this plugin owns.
  **`shell.json` is never written to.** It remains the base layer: Setup >
  Plugins still supplies the defaults, and *Reset to Setup > Plugins* clears
  every panel-set value and hands the settings back to it. Omarchy's own weather
  panel persists its configuration the same way, to a state file rather than to
  the user's configuration.
- The llama-swap endpoint is deliberately **not** settable from the panel. It is
  the only setting with a security boundary attached, so it keeps exactly one
  place it can be changed from.
- Stored overrides are parsed against an allow-list and every value re-coerced —
  unknown keys are dropped, enums must match the manifest's own option list,
  prices must parse as a number in range, and integers are clamped. A hand-edited
  file cannot introduce a setting the widget never expected.
- Tests now read `manifest.json` and assert that every default, every settable
  key and the `barPeriod` option list agree with the model, so the pane and a
  fresh install can never drift apart unnoticed.

## [1.2.0] — 2026-09-06

### Fixed

- **Prompt tokens served from the KV cache were not counted at all.**
  `llamacpp:prompt_tokens_total` reports only what the model actually
  *processed*; the reused prefix arrives on a separate counter,
  `llamacpp:prompt_tokens_cached_total`. OpenCode splits the same way —
  `tokens.input` is the processed part and `tokens.cache.read`/`.write` the
  rest. Both are now read, and processed + cached is exactly the `prompt_tokens`
  an API reports (verified: an identical repeat request reported 13 while the
  processed counter moved by 1 and the cached counter by 12). On four days of
  real use here the cache served 74–99% of every prompt, so the cloud comparison
  had been understating its prompt side by as much as 74×.
- The panel reports the two halves separately with the cache-hit share, and the
  savings figure prices cached prompt tokens at their own rate — hosted
  providers bill cache hits at a discount rather than giving them away.

### Security

- Every `curl` and `sqlite3` now runs with `clearEnvironment: true` and an empty
  environment. This closes a real hole rather than tidying: `curl` honours
  `http_proxy`/`ALL_PROXY` and `~/.curlrc`, so the plugin's stated
  loopback-only boundary could be defeated by an environment variable. Verified
  before the fix. `--noproxy '*'` and `-q` close the same door twice more.
- `sqlite3` gains `-noinit` (it otherwise executes `~/.sqliterc` before the
  query), `-safe` and `-batch` alongside the existing `-readonly`.
- Output is now bounded at the producer, not after `StdioCollector` has already
  buffered it: `curl --max-filesize 262144` (both endpoints send
  `Content-Length`, so an oversized body is refused before transfer), and every
  text column in both SQL queries wrapped in `substr` with the row count capped
  by `LIMIT`.
- Watchdogs and destruction teardown send `SIGTERM` then `SIGKILL` rather than
  only clearing `running`.
- The session launcher runs with an explicit environment allow-list and a fixed
  `PATH`, since `omarchy-launch-tui` resolves `setsid`, `uwsm-app` and
  `xdg-terminal-exec` through it.
- The state directory is created with `install -d -m 700` rather than
  `mkdir -p`, which also corrects an existing `0755` directory from an earlier
  install.
- `parseSessions` caps the rows it returns independently of the SQL `LIMIT`.

### Changed

- History format version 4, for the prompt-cache fields.
- New setting: **Cloud price per 1M cached prompt tokens**, default `0.30`.

## [1.1.0] — 2026-09-06

### Fixed

- **Every resident model is counted, not just one.** llama-swap keeps several
  `llama-server` processes alive at once — a small model for titles beside the
  one doing the work — and the widget sampled only the first one it found,
  re-checking the list only when that model stopped answering. Because the small
  model stays resident indefinitely, the widget could latch onto it and report
  nothing at all while another model generated hundreds of thousands of tokens.
  It now sweeps the whole resident set on every refresh.
- **The watermark no longer over-claims.** A successful counter read used to
  advance a single global watermark to "now", asserting that live sampling
  covered everything — which also stopped the OpenCode importer, the one source
  that could have filled the gap, from ever reaching back into it. Coverage is
  now tracked per model and only advances after a sweep that read every resident
  model with no counter reset.
- **Tokens lost across a model swap are recovered.** `llama-server` counters
  restart at zero, so the tokens generated between the last sample and the
  restart cannot be read back from any counter. That model's mark is now left
  where it is, and the importer fills exactly that window from OpenCode's exact
  per-reply counts — for that model only.
- A failed `sqlite3` run was treated as a successful empty import, because
  `exitCode` was read as a property of `Process`, where it is a signal
  parameter. It is now read from the signal and a non-zero exit is ignored.
- `touched()` rebuilt the history object from a hand-written list of fields, so
  a newly added top-level field was written by every code path and dropped on
  the next repaint, silently. It now carries every own key, and a test enforces
  that.

### Changed

- History format version 3. A version 2 file is rejected and rebuilt from
  OpenCode's records, which is what repairs history written while whole models
  were going uncounted.
- Model ids from llama-swap are validated against `^[A-Za-z0-9._-]{1,40}$`
  before being interpolated into a request path, rather than used as returned.
- The panel and tooltip name every resident model, not one.
- **The plugin works with no configuration.** OpenCode's records were
  already an exact source; they are now a live one when llama.cpp's counters
  are unavailable, rather than only a one-shot backfill at startup. Enabling
  `--metrics` remains worthwhile — it adds live throughput and covers clients
  other than OpenCode — but is no longer required for the plugin to function.
- The panel and tooltip name which source the numbers come from, and say what
  enabling metrics would add.

## [1.0.0] — 2026-09-04

First release.

### Added

- Tokens per hour in the bar, over a configurable window.
- Panel with a hero total, window selection from this hour to twelve months,
  and a per-model breakdown with each model's share and measured throughput.
- Bar graph with dated axis labels, day-boundary rules, and a readout that
  follows the pointer showing the exact weekday, date, time span and count.
- History table of every recorded slot.
- Sessions pane listing OpenCode sessions by tokens generated; clicking one
  resumes it in a terminal in its own working directory.
- Cost comparison against a hosted API, with the assumed rates printed on
  screen next to the figure.
- Backfill from OpenCode's database, watermarked so nothing is counted twice.
- History persisted to `~/.local/state/omarchy/tokenstats/`, written atomically.

### Notes

- Token counts come from llama.cpp's own Prometheus counters and are exact.
  This requires `--metrics` on llama-server; see the README.
- Imported history carries exact token counts but no usable generation time, so
  throughput is reported only over tokens the widget sampled itself.

[Unreleased]: https://github.com/ErikBurdett/omarchy-tokenstats/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/ErikBurdett/omarchy-tokenstats/releases/tag/v1.0.0
