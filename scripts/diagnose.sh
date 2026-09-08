#!/usr/bin/env bash
# Why is Token Stats showing nothing?
#
# Read-only. Talks to loopback only, never writes, and never starts a model.
# Run it on the machine where the widget is not counting:
#
#     ~/.config/omarchy/plugins/io.github.erikburdett.tokenstats/scripts/diagnose.sh
#
# It checks each thing the plugin needs, in the order the plugin needs it, and
# says which one is missing rather than leaving you to guess between "idle" and
# "misconfigured".

set -uo pipefail

ENDPOINT="${1:-http://127.0.0.1:8080}"
DB="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"
STATE="${HOME}/.local/state/omarchy/tokenstats"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! $ENDPOINT =~ ^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?$ ]]; then
  printf '%s\n' 'Endpoint must be an HTTP loopback address.' >&2
  exit 2
fi

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[92mok\033[0m    %s\n' "$1"; }
no()   { printf '  \033[91mno\033[0m    %s\n' "$1"; }
info() { printf '        %s\n' "$1"; }

get() { curl -qfsS --noproxy '*' --max-time 4 --max-filesize 262144 "$1" 2>/dev/null; }
code() { curl -qsS --noproxy '*' --max-time 4 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null; }

found_live=0
found_import=0
found_agent=0

bold "Endpoint: $ENDPOINT"

models_json=$(get "$ENDPOINT/v1/models")
if [[ -z $models_json ]]; then
  no "nothing is answering $ENDPOINT/v1/models"
  info "Is llama-swap (or llama-server) running, and on this port?"
  info "If it listens elsewhere, set the endpoint in the widget's shell.json entry."
else
  ok "$ENDPOINT/v1/models answered"

  # llama-swap reports a per-model status; a plain llama-server does not.
  swap_models=$(printf '%s' "$models_json" |
    python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit()
for m in d.get("data") or []:
    if isinstance(m,dict) and (m.get("status") or {}).get("value")=="loaded":
        print(m.get("id",""))' 2>/dev/null)

  if [[ -n $swap_models ]]; then
    ok "this is llama-swap; models resident: $(echo "$swap_models" | tr '\n' ' ')"
    while read -r m; do
      [[ -n $m ]] || continue
      c=$(code "$ENDPOINT/upstream/$m/metrics")
      if [[ $c == 200 ]]; then
        ok "counters readable for '$m'"; found_live=1
      elif [[ $c == 501 ]]; then
        no "'$m' returns 501 — llama-server was started without --metrics"
      else
        no "'$m' metrics returned HTTP $c"
      fi
    done <<< "$swap_models"
  else
    no "no model reported as loaded by llama-swap"
    # Plain llama.cpp serves its counters at /metrics, not /upstream/<id>/metrics.
    c=$(code "$ENDPOINT/metrics")
    if [[ $c == 200 ]] && get "$ENDPOINT/metrics" | grep -q '^llamacpp:'; then
      ok "but $ENDPOINT/metrics IS serving llama.cpp counters directly"
      info "This looks like llama-server run directly rather than behind llama-swap."
      found_live=1
    elif [[ $c == 501 ]]; then
      no "$ENDPOINT/metrics returns 501 — start llama-server with --metrics"
    else
      info "$ENDPOINT/metrics returned HTTP $c"
    fi
  fi
fi

echo
bold "OpenCode records"

if [[ ! -r $DB ]]; then
  no "no readable database at $DB"
  info "Local accounting needs live counters; Claude/Codex records remain independent."
else
  ok "database found"
  rows=$(sqlite3 -readonly -safe -noinit -batch "file:$DB?mode=ro" \
    "select count(*) from message where json_extract(data,'\$.role')='assistant';" 2>/dev/null)
  info "assistant replies recorded: ${rows:-unknown}"

  echo "        providers seen in the database:"
  sqlite3 -readonly -safe -noinit -batch -separator '  ' "file:$DB?mode=ro" \
    "select '          ' || substr(json_extract(data,'\$.providerID'),1,64), count(*)
       from message where json_extract(data,'\$.role')='assistant'
      group by 1 order by 2 desc limit 10;" 2>/dev/null

  if [[ -r $CONFIG ]]; then
    locals=$(/usr/bin/python3 -I -S "$SCRIPT_DIR/read-config.py" "$CONFIG" 2>/dev/null | /usr/bin/python3 -I -S -c '
import json,sys,re
try: cfg=json.load(sys.stdin)
except Exception: sys.exit()
for pid,p in (cfg.get("provider") or {}).items():
    url=((p or {}).get("options") or {}).get("baseURL") or ""
    if re.match(r"^https?://(127\.0\.0\.1|localhost|\[::1\])(:|/|$)", url):
        print(str(pid)[:64])' 2>/dev/null)
    if [[ -n $locals ]]; then
      ok "providers pointing at loopback, per opencode.json: $(echo "$locals" | tr '\n' ' ')"
      found_import=1
    else
      no "opencode.json declares no provider with a loopback baseURL"
      info "The plugin imports only providers that run on this machine."
    fi
  else
    no "no opencode.json at $CONFIG"
    info "Without it the plugin cannot tell which providers are local."
  fi
fi

echo
bold "Agent records"
if [[ ! -x /usr/bin/python3 ]]; then
  no "Python 3 is required for agent scanning and OpenCode configuration"
else
  for agent_dir in "$HOME/.claude/projects" "$HOME/.codex/sessions"; do
    if [[ -d $agent_dir && ! -L $agent_dir ]]; then
      ok "source directory present: $agent_dir"
      found_agent=1
    fi
  done
  info "The panel footer reports import progress, skipped records and capacity limits."
  info "Directory presence alone does not establish readable usage records."
fi

echo
bold "Plugin state"
if [[ -d $STATE ]]; then
  ok "state directory present ($(stat -c '%a' "$STATE"))"
  [[ -f $STATE/history.json ]] && info "history.json: $(stat -c '%s' "$STATE/history.json") bytes"
else
  no "no state directory yet at $STATE"
fi

echo
bold "Verdict"
if (( found_live )); then
  ok "a live counter source is available"
elif (( found_import )); then
  ok "no live counters, but OpenCode records can be imported"
elif (( found_agent )); then
  ok "agent source directories are present; check the Agents pane for scan results"
else
  no "no usable source found — the widget will legitimately show nothing"
  info "Fix whichever line above says 'no', then restart: omarchy restart shell"
fi
