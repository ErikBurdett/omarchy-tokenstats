#!/bin/sh
# Extract token usage and session rows from Claude Code and Codex CLI's own
# on-disk records, as pipe-separated lines TokenModel.js can parse.
#
# Usage: scan-agents.sh <mode> <home> [since_ms]
#   mode      claude-usage | codex-usage | claude-sessions | codex-sessions
#   home      the user's home directory (the caller clears the environment,
#             so $HOME is not available here)
#   since_ms  usage modes only: emit rows strictly newer than this epoch-ms
#
# Run with a CLEARED environment on purpose: every tool is an absolute path,
# so there is no PATH to poison and nothing here honours a proxy or an rc
# file. Both counts are exact — Claude Code stores the API's own usage block
# per assistant message, and Codex stores the API's per-turn usage in its
# token_count events. Nothing is estimated.
#
# Output is bounded at the producer: file lists are capped, every text column
# is truncated in jq, and row counts are capped before anything is written.
#
# Usage row:    ts_ms|message_id|model|input|cache_read|cache_write|output
# Session row:  id|title|output_tokens|model|directory|updated_ms
#
# `input` excludes cached tokens; cache_read / cache_write are the prompt
# tokens the provider served from (or wrote to) its cache, kept separate
# because hosted APIs price all three differently.

set -u

MODE="${1:-}"
HOME_DIR="${2:-}"
SINCE_MS="${3:-0}"

JQ=/usr/bin/jq
FIND=/usr/bin/find
AWK=/usr/bin/awk
SORT=/usr/bin/sort
HEAD=/usr/bin/head
CUT=/usr/bin/cut
STAT=/usr/bin/stat

case "$HOME_DIR" in
  /*) : ;;
  *) exit 2 ;;
esac
case "$SINCE_MS" in
  ''|*[!0-9]*) SINCE_MS=0 ;;
esac

# find -newermt filters on file mtime while the watermark filters on row
# timestamps, so give the file filter two minutes of slack: a row is written
# moments after its timestamp, never meaningfully before it.
SINCE_S=$(( SINCE_MS / 1000 - 120 ))
[ "$SINCE_S" -lt 0 ] && SINCE_S=0

CLAUDE_DIR="$HOME_DIR/.claude/projects"
CODEX_DIR="$HOME_DIR/.codex/sessions"

# Newest files first, bounded, one path per line. Session filenames contain no
# whitespace (Claude uses UUIDs, Codex uses rollout-<timestamp>-<uuid>), so a
# line-per-path pipeline is safe.
newest_files() {
  # $1 dir, $2 name pattern, $3 max, $4 min mtime (epoch s, 0 = all)
  if [ "$4" -gt 0 ]; then
    "$FIND" "$1" -type f -name "$2" -newermt "@$4" -printf '%T@\t%p\n' 2>/dev/null
  else
    "$FIND" "$1" -type f -name "$2" -printf '%T@\t%p\n' 2>/dev/null
  fi | "$SORT" -rn | "$HEAD" -n "$3" | "$CUT" -f2-
}

case "$MODE" in

claude-usage)
  # One row per assistant message. Claude Code writes the same message id on
  # several JSONL lines while streaming, each repeating the same usage block,
  # so rows are deduplicated by message id — first occurrence wins, they are
  # identical.
  newest_files "$CLAUDE_DIR" '*.jsonl' 400 "$SINCE_S" |
  while IFS= read -r f; do
    "$JQ" -R -r '
      fromjson? | select(.type == "assistant" and .timestamp != null)
      | .message as $m | select($m.usage != null and ($m.id // "") != "")
      | [ (( .timestamp | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 ) * 1000),
          $m.id,
          (($m.model // "") | .[0:40]),
          ($m.usage.input_tokens // 0),
          ($m.usage.cache_read_input_tokens // 0),
          ($m.usage.cache_creation_input_tokens // 0),
          ($m.usage.output_tokens // 0) ]
      | map(tostring) | join("|")' "$f" 2>/dev/null
  done | "$AWK" -F'|' -v since="$SINCE_MS" '$1 + 0 > since + 0 && $2 != "" && !seen[$2]++' |
  "$HEAD" -n 20000
  ;;

codex-usage)
  # One row per token_count event's last_token_usage — the per-turn figure,
  # not the cumulative total. The model id comes from the most recent
  # turn_context event before the count, tracked per file.
  newest_files "$CODEX_DIR" 'rollout-*.jsonl' 200 "$SINCE_S" |
  while IFS= read -r f; do
    "$JQ" -n -R -r '
      reduce (inputs | fromjson? | select(.timestamp != null)) as $ev
        ( { m: "codex", rows: [] };
          if $ev.type == "turn_context" and (($ev.payload.model // "") != "") then
            .m = ($ev.payload.model | .[0:40])
          elif ($ev.payload.type // "") == "token_count"
               and $ev.payload.info.last_token_usage != null then
            ($ev.payload.info.last_token_usage) as $u
            | .rows += [[
                (( $ev.timestamp | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 ) * 1000),
                "codex",
                .m,
                ((($u.input_tokens // 0) - ($u.cached_input_tokens // 0)) | if . < 0 then 0 else . end),
                ($u.cached_input_tokens // 0),
                ($u.cache_write_input_tokens // 0),
                ($u.output_tokens // 0)
              ]]
          else . end )
      | .rows[] | map(tostring) | join("|")' "$f" 2>/dev/null
  done | "$AWK" -F'|' -v since="$SINCE_MS" '$1 + 0 > since + 0' |
  "$HEAD" -n 20000
  ;;

claude-sessions)
  # One row per session file that generated tokens, newest first. The title is
  # the first real user message — command wrappers (`<command-name>…`) and the
  # resume preamble ("Caveat: …") are skipped.
  newest_files "$CLAUDE_DIR" '*.jsonl' 80 0 |
  while IFS= read -r f; do
    id="${f##*/}"; id="${id%.jsonl}"
    at=$(( $("$STAT" -c %Y "$f" 2>/dev/null || echo 0) * 1000 ))
    "$JQ" -n -R -r --arg id "$id" --arg at "$at" '
      [inputs | fromjson?] as $e
      | [ $e[] | select(.type == "assistant" and .message.usage != null
                        and ((.message.id // "") != "")) ] as $a
      | ([ $a[] | .message.id ] | unique | length) as $seen
      | ($a | unique_by(.message.id)) as $msgs
      | ([ $msgs[] | .message.usage.output_tokens // 0 ] | add // 0) as $out
      | select($out > 0)
      | ((($msgs | last).message.model // "") | .[0:40]) as $model
      | (([ $e[] | .cwd // empty ] | last) // "") as $cwd
      | (([ $e[] | select(.type == "user" and ((.message.content // "") | type) == "string")
            | .message.content
            | select((startswith("<") or startswith("Caveat")) | not) ] | first) // "") as $title
      | [ $id,
          ($title | gsub("[|\n\r]"; " ") | .[0:160]),
          $out, $model,
          ($cwd | gsub("[|\n\r]"; " ") | .[0:240]),
          $at ]
      | map(tostring) | join("|")' "$f" 2>/dev/null
  done | "$HEAD" -n 100
  ;;

codex-sessions)
  # One row per rollout file that generated tokens. Output totals come from
  # the LARGEST cumulative figure rather than the last event, so a session
  # whose counters reset after compaction still reports everything it did.
  newest_files "$CODEX_DIR" 'rollout-*.jsonl' 80 0 |
  while IFS= read -r f; do
    at=$(( $("$STAT" -c %Y "$f" 2>/dev/null || echo 0) * 1000 ))
    "$JQ" -n -R -r --arg at "$at" '
      [inputs | fromjson?] as $e
      | (([ $e[] | select(.type == "session_meta") | .payload.id // empty ] | first) // "") as $id
      | select($id != "")
      | ([ $e[] | select(.type == "event_msg"
                         and ((.payload.type // "") == "token_count")
                         and .payload.info.total_token_usage != null)
           | .payload.info.total_token_usage.output_tokens // 0 ] | max // 0) as $out
      | select($out > 0)
      | (([ $e[] | select(.type == "turn_context") | .payload.model // empty ] | last) // "codex"
         | .[0:40]) as $model
      | (([ $e[] | select(.type == "turn_context") | .payload.cwd // empty ] | last)
         // ([ $e[] | select(.type == "session_meta") | .payload.cwd // empty ] | first)
         // "") as $cwd
      | (([ $e[] | select(.type == "response_item" and (.payload.type // "") == "message"
                          and (.payload.role // "") == "user")
            | .payload.content[]? | select((.type // "") == "input_text") | .text // ""
            | select((startswith("<") | not) and . != "") ] | first) // "") as $title
      | [ $id,
          ($title | gsub("[|\n\r]"; " ") | .[0:160]),
          $out, $model,
          ($cwd | gsub("[|\n\r]"; " ") | .[0:240]),
          $at ]
      | map(tostring) | join("|")' "$f" 2>/dev/null
  done | "$HEAD" -n 100
  ;;

*)
  exit 2
  ;;
esac

exit 0
