# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
