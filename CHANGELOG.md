# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Changed

- **The plugin now works with no configuration.** OpenCode's records were
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
