## What this changes

<!-- The defect or the gap, then the fix. Why, not just what. -->

## How it was verified

- [ ] `node test/tokenmodel-test.mjs`
- [ ] `bash scripts/qa.sh`
- [ ] `omarchy plugin validate .`
- [ ] `qmllint` clean (see CONTRIBUTING.md for the invocation)
- [ ] Loaded in a running shell with no errors in `quickshell log`
- [ ] **Looked at it.** Screenshot below if the change is visible.

<!--
A clean log proves the QML parsed, not that anything was drawn. QML resolves a
missing property to `undefined` rather than raising, so a typo shows up as an
empty widget and a healthy-looking log.
-->

## Screenshot

<!-- If the change has a visible effect. -->

## Notes for the reviewer

<!-- Anything surprising, any trade-off you made, anything you are unsure of. -->
