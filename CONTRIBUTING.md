# Contributing

Thanks for looking. This plugin runs unsandboxed inside `omarchy-shell`, so a
bug here takes down someone's bar and notifications. That shapes most of what
follows.

## Getting set up

You need Omarchy 4 with `omarchy-shell`, and llama.cpp's metrics endpoint
enabled — see [Requirements](README.md#requirements). Develop against the
installed plugin directory, which hot-reloads on save:

```bash
git clone https://github.com/ErikBurdett/omarchy-tokenstats.git \
  ~/.config/omarchy/plugins/io.github.erikburdett.tokenstats
omarchy-shell shell rescanPlugins
omarchy plugin enable io.github.erikburdett.tokenstats left
```

## Before you open a pull request

```bash
node test/tokenmodel-test.mjs        # the model layer
bash scripts/qa.sh                   # packaging and safety
omarchy plugin validate .            # manifest against the shell's schema

/usr/lib/qt6/bin/qmllint --max-warnings 0 \
  --missing-property info --signal-handler-parameters info \
  -I /usr/share/omarchy/shell \
  -i /usr/share/omarchy/shell/Commons/qmldir \
  -i /usr/share/omarchy/shell/Ui/qmldir \
  *.qml
```

CI runs all four. The QML lint is the one that catches what testing cannot: a
type or property that never resolves. **QML resolves a missing property to
`undefined` rather than raising**, so a typo produces an empty widget and a
completely clean log.

Then look at it:

```bash
omarchy-shell shell rescanPlugins
quickshell list --all && quickshell log -i <instance> -t 40
grim -g "0,0 900x40" /tmp/bar.png
```

A clean log proves the QML parsed, not that anything was drawn. If your change
has a visible effect, please include a screenshot in the pull request.

## House rules

These are not style preferences; each one is a defect this plugin has already
had, or one the Omarchy marketplace review blocks on.

- **Token counts stay exact.** They come from llama.cpp's own counters. Never
  reintroduce a bytes-per-token estimate — response size is mostly SSE framing
  and gets it wrong by more than an order of magnitude.
- **Never compute a rate from `c`.** Buckets carry `c` (all generated tokens)
  and `m` (tokens that arrived with measured seconds). Throughput is `m / s`.
- **Bump `HISTORY_VERSION` when you add a bucket field.** Old files are rejected
  rather than migrated, which resets the watermark and rebuilds history in the
  new shape. Without the bump the field stays empty forever.
- **Absolute executable paths, argv arrays, no shell.** Every subprocess needs a
  watchdog `Timer` that kills it and a `Component.onDestruction` handler.
- **`textFormat: Text.PlainText` on any string the plugin did not author** —
  model ids, session titles, command output. Qt's default interprets markup.
- **No hardcoded colours, fonts or sizes.** They come from `Style` and `Color`
  in `qs.Commons`, or from the injected `bar` object.
- **Clamp or allow-list every setting** read from `shell.json` at the point of
  read. That file is editable by anything running as the user.
- **Logic goes in `TokenModel.js`**, which is Qt-free and unit tested. QML stays
  declarative. New behaviour needs assertions in `test/tokenmodel-test.mjs`.

## Branches and commits

- Branch from `main`; `main` is protected and requires a green CI run.
- One concern per pull request.
- Write commit messages that say **why**, not just what. The existing history is
  the model: state the defect, then the fix.

## Reporting something

Use the issue templates. For anything security-shaped, read
[SECURITY.md](SECURITY.md) first — please do not open a public issue for it.
