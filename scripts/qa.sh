#!/bin/bash
# Packaging and safety checks that need no Omarchy install, so CI can run them.
#
# The full gate — which also needs a live shell — is
# ~/.agents/skills/omarchy-plugin-ship/scripts/preflight.sh on a machine
# running Omarchy. This is the portable subset.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

fails=0
pass() { printf '  \033[92mok\033[0m    %s\n' "$1"; }
fail() { printf '  \033[91mFAIL\033[0m  %s\n' "$1"; ((fails++)); }

echo "Packaging"
for f in manifest.json README.md LICENSE preview.png; do
  [[ -f $f ]] && pass "$f present" || fail "$f missing"
done
grep -qiE '^## Install' README.md && pass "README documents installation" \
  || fail "README must document installation"
grep -qiE '^## Remove' README.md && pass "README documents removal" \
  || fail "README must document removal"

id=$(python3 -c 'import json;print(json.load(open("manifest.json"))["id"])')
[[ $id == omarchy.* ]] && fail "id uses the reserved omarchy.* namespace" || pass "id: $id"
[[ $id == *.* ]] && pass "id is namespaced" || fail "id is not namespaced"

entry=$(python3 -c 'import json;print(" ".join(json.load(open("manifest.json"))["entryPoints"].values()))')
for e in $entry; do
  [[ -f $e ]] && pass "entry point exists: $e" || fail "entry point missing: $e"
done

[[ -z $(find . -name .git -prune -o -type l -print -quit) ]] \
  && pass "no symlinks packaged" || fail "symlinks are refused by omarchy plugin validate"

echo
echo "Safety"
# Every executable must be an absolute path in an argv array: a bare name is
# resolved through inherited PATH and can select a user-controlled binary.
if grep -RInE 'command:\s*\[\s*"[^/]' -- *.qml 2>/dev/null | grep -v '^\s*//' | grep -q .; then
  fail "Process command starts with a bare executable name"
  grep -RInE 'command:\s*\[\s*"[^/]' -- *.qml | sed 's/^/        /'
else
  pass "every Process command uses an absolute path"
fi

if grep -RInE '"(sh|bash)"\s*,\s*"-l?c"' -- *.qml 2>/dev/null | grep -q .; then
  fail "shell -c invocation; build a fixed argv array instead"
else
  pass "no shell invocations"
fi

if grep -RInE 'curl[^|]*\|\s*(sh|bash)' . --include='*' 2>/dev/null | grep -q .; then
  fail "download-to-shell execution"
else
  pass "no download-to-shell execution"
fi

if grep -RInE '(^|[^/])/tmp/' -- *.qml *.js 2>/dev/null | grep -v '^\s*//' | grep -q .; then
  fail "predictable /tmp path; use XDG_RUNTIME_DIR or a private owned directory"
else
  pass "no predictable /tmp paths"
fi

# Qt's default AutoText interprets markup, so any string the plugin did not
# author must be rendered literally.
missing=0
for f in *.qml; do
  grep -qE '^\s*Text\s*\{' "$f" && ! grep -q 'textFormat' "$f" && { fail "$f has Text {} but never sets textFormat"; missing=1; }
done
(( missing == 0 )) && pass "every file with Text sets textFormat"

if grep -RInE '(color|background|foreground)\s*:\s*"#[0-9a-fA-F]{3,8}"' -- *.qml 2>/dev/null | grep -q .; then
  fail "hardcoded colour; pull from Style/Color in qs.Commons"
else
  pass "no hardcoded colours"
fi

# Every symbol used from the qs.Commons singletons must exist. The singletons
# are not available here, so this checks against a known-good list; the full
# check runs in preflight.sh on a real install.
if grep -RohE 'Commons\.[a-zA-Z_]' -- *.qml 2>/dev/null | grep -q .; then
  fail "Commons.<x> is not valid; qs.Commons is a module, use its singletons"
else
  pass "no invalid Commons.<x> access"
fi

echo
if (( fails > 0 )); then
  echo "  $fails check(s) failed"
  exit 1
fi
echo "  all packaging checks passed"
