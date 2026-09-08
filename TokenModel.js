// Pure logic for the token stats widget: metric parsing, delta accounting,
// history buckets, savings, and formatting. Qt-free so it can be unit tested
// under node — see test/tokenmodel-test.mjs.
//
// Accuracy note, because it is the whole point of this plugin: token counts
// come from llama.cpp's own Prometheus counters, reached through llama-swap at
// /upstream/<model>/metrics. They are exact. Estimating tokens from HTTP
// response size — the obvious approach — is wrong by more than an order of
// magnitude, because a streamed response is mostly SSE framing rather than
// content. Never reintroduce a bytes-per-token constant here.

// Bumped to 2 when per-model attribution was added, to 3 when the widget
// started sampling every resident model instead of one, and to 4 when prompt
// tokens served from the KV cache started being counted separately. parseHistory rejects an
// older file outright, which resets the watermark and triggers a full re-import
// from OpenCode — cheap, and it is the only reliable way to repair history that
// was written while whole models were going uncounted. Version 2 files record
// only whichever model the old single-model latch happened to pick, and
// anything before version 4 records no prompt-cache tokens at all.
var HISTORY_VERSION = 4

// Retention. Hours drive the 24h graph, days drive everything longer. Both are
// tiny: 72 hourly + 400 daily records is a few tens of KiB of JSON.
var KEEP_MINUTES = 180
var KEEP_HOURS = 72
var KEEP_DAYS = 400

// Guards against a corrupted or hand-edited state file turning into absurd
// totals. A single sample cannot plausibly exceed these.
var MAX_TOKENS_PER_SAMPLE = 10000000
var MAX_SECONDS_PER_SAMPLE = 3600
var MAX_STATE_BYTES = 4194304
// A corrupted or hand-edited file must not be able to explode the per-model map.
var MAX_MODELS_PER_BUCKET = 32
var MAX_MODEL_NAME = 40
// The sessions query already asks for 60 rows. This is the second, independent
// bound: whatever arrives, no more than this many rows can reach the Repeater.
var MAX_SESSIONS = 100

function isNum(v) { return typeof v === "number" && isFinite(v) }
function clampNonNeg(v, cap) {
  if (!isNum(v) || v < 0) return 0
  return v > cap ? cap : v
}

// ---------------------------------------------------------------- parsing

// llama.cpp exposes Prometheus text. We want four counters; anything else in
// the payload is ignored, and a missing counter yields null rather than a
// partial record that would compute wrong deltas.
function parseMetrics(text) {
  var raw = String(text === undefined || text === null ? "" : text)
  if (raw.length === 0 || raw.length > MAX_STATE_BYTES) return null

  var want = {
    "llamacpp:prompt_tokens_total": "promptTokens",
    // Prompt tokens served from the KV cache instead of being processed again.
    // llamacpp:prompt_tokens_total counts only what was actually computed, so
    // without this a warm cache makes the prompt figure collapse: measured on
    // this machine, an identical repeated request reported prompt=13 to the API
    // while the processed counter moved by 1 and this one moved by 12.
    // processed + cached is exactly the prompt_tokens the API reports.
    "llamacpp:prompt_tokens_cached_total": "promptCached",
    "llamacpp:tokens_predicted_total": "predictedTokens",
    "llamacpp:tokens_predicted_seconds_total": "predictedSeconds",
    "llamacpp:prompt_seconds_total": "promptSeconds"
  }

  var out = {}
  var lines = raw.split("\n")
  var limit = lines.length < 400 ? lines.length : 400
  for (var i = 0; i < limit; i++) {
    var line = lines[i]
    if (line.charAt(0) === "#") continue
    var sp = line.indexOf(" ")
    if (sp <= 0) continue
    var key = want[line.substring(0, sp)]
    if (!key) continue
    var value = parseFloat(line.substring(sp + 1))
    if (isNum(value) && value >= 0) out[key] = value
  }

  if (!isNum(out.promptTokens) || !isNum(out.predictedTokens)) return null
  if (!isNum(out.predictedSeconds)) out.predictedSeconds = 0
  if (!isNum(out.promptSeconds)) out.promptSeconds = 0
  // Older llama.cpp builds do not export the cached counter. Absent means no
  // cache attribution, not a failed read — the plugin still counts, it just
  // cannot say how much of the prompt was reused.
  if (!isNum(out.promptCached)) out.promptCached = 0
  return out
}

// A model id is interpolated into a URL path and used as an object key, so it
// is VALIDATED rather than sanitised: a sanitised id would still be sent to
// llama-swap, just as the wrong model. Anything outside this shape is dropped.
var MODEL_ID_RE = /^[A-Za-z0-9._-]{1,40}$/

// llama-swap's /v1/models, reduced to EVERY id that is currently resident.
//
// llama-swap keeps more than one llama-server alive at a time — a small model
// for titles and summaries alongside the one actually doing the work — so
// "the loaded model" is not a thing. Returning only the first match made the
// widget latch onto whichever id happened to sort first, and every token
// generated by any other model went uncounted for as long as that one stayed
// resident. Return the whole set and sample all of it.
function parseLoadedModels(jsonText) {
  var out = []
  try {
    var doc = JSON.parse(String(jsonText || ""))
    var list = doc && doc.data
    if (!Array.isArray(list)) return out
    var limit = list.length < MAX_MODELS_PER_BUCKET ? list.length : MAX_MODELS_PER_BUCKET
    for (var i = 0; i < limit; i++) {
      var m = list[i]
      var status = m && m.status && m.status.value
      if (status !== "loaded") continue
      if (typeof m.id !== "string" || !MODEL_ID_RE.test(m.id) || modelKey(m.id) !== m.id) continue
      if (out.indexOf(m.id) === -1) out.push(m.id)
    }
  } catch (e) {
    return []
  }
  return out.sort()
}

// Where a local llama.cpp lives, in the order worth trying. Nothing here is a
// guess about THIS machine: 8080 is both llama-swap's and llama-server's own
// default, and the rest are the ports people commonly move them to. Discovery
// costs one loopback request per tick until something answers, then stops.
//
// This exists so the plugin has nothing to configure. Defaulting to a single
// port and calling that "no setup required" only works on a machine that
// happens to match it.
var ENDPOINT_CANDIDATES = [
  "http://127.0.0.1:8080",
  "http://127.0.0.1:8081",
  "http://127.0.0.1:8000",
  "http://127.0.0.1:5000",
  "http://127.0.0.1:11434"
]

// Loopback only, always. An endpoint reaches curl, so a settings edit must not
// be able to point it at another host — and neither must discovery.
var LOOPBACK_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/

function isLoopbackEndpoint(raw) {
  return LOOPBACK_RE.test(String(raw === undefined || raw === null ? "" : raw))
}

// "" / "auto" mean discover. Anything else is honoured only if it is loopback.
function endpointSetting(raw) {
  var v = String(raw === undefined || raw === null ? "" : raw).trim()
  if (v === "" || v.toLowerCase() === "auto") return ""
  return isLoopbackEndpoint(v) ? v : ""
}

// A provider id is a key in the user's opencode.json and goes into SQL, so it
// is VALIDATED, never quoted-and-hoped. Nothing outside this shape can carry a
// quote, so the generated IN list cannot be broken out of.
var PROVIDER_ID_RE = /^[A-Za-z0-9._-]{1,64}$/

// Unlike the endpoint, a baseURL legitimately has a path ("/v1"), so this is a
// host check rather than a whole-string match.
function isLoopbackBaseUrl(raw) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/|$)/
    .test(String(raw === undefined || raw === null ? "" : raw))
}

// Which OpenCode providers actually run on this machine.
//
// The message rows carry a providerID but nothing that says whether it is
// local, and the id itself is just whatever the user named it — "local" here,
// but as easily "llamacpp" or "lmstudio" elsewhere. Hardcoding one name is why
// the importer found nothing on another machine. opencode.json is the only
// place that knows: a provider whose baseURL points at loopback is running
// here.
function parseLocalProviders(configText) {
  var out = []
  var raw = String(configText === undefined || configText === null ? "" : configText)
  if (raw.length === 0 || raw.length > MAX_STATE_BYTES) return out
  var doc
  try {
    doc = JSON.parse(raw)
  } catch (e) {
    return out
  }
  var providers = doc && doc.provider
  if (!providers || typeof providers !== "object") return out
  var keys = Object.keys(providers)
  var limit = keys.length < 64 ? keys.length : 64
  for (var i = 0; i < limit; i++) {
    var id = keys[i]
    if (!PROVIDER_ID_RE.test(id)) continue
    var p = providers[id]
    var url = p && p.options ? p.options.baseURL : ""
    if (!isLoopbackBaseUrl(url)) continue
    if (out.indexOf(id) === -1) out.push(id)
  }
  return out.sort()
}

// A SQL IN list, or "" when the caller deliberately requested no filter. An
// invalid supplied filter fails closed; dropping it would select hosted rows.
// Every id is
// re-validated here rather than trusting the caller, because this string is
// concatenated into a statement.
function providerFilterSql(ids) {
  if (!Array.isArray(ids)) return " and 0"
  if (ids.length === 0) return ""
  var safe = []
  for (var i = 0; i < ids.length && i < 64; i++) {
    if (typeof ids[i] === "string" && PROVIDER_ID_RE.test(ids[i])) safe.push("'" + ids[i] + "'")
  }
  if (safe.length === 0) return " and 0"
  return " and json_extract(data,'$.providerID') in (" + safe.join(",") + ")"
}

// llama.cpp can be reached two ways and they are NOT the same shape:
//
//   llama-swap  /v1/models carries a per-model status, and each model's
//               counters live at /upstream/<id>/metrics.
//   llama-server (run directly, no proxy) — /v1/models has no status field at
//               all, /upstream/... is 404, and the counters are at /metrics.
//
// Assuming the first shape is why this plugin counted nothing on a machine
// running llama-server directly: parseLoadedModels found no entry with
// status "loaded", so the sweep queue stayed empty and no endpoint was ever
// read. Detect the shape instead of assuming it.
function detectServerShape(jsonText) {
  var doc
  try {
    doc = JSON.parse(String(jsonText || ""))
  } catch (e) {
    return "none"
  }
  var list = doc && doc.data
  if (!Array.isArray(list) || list.length === 0) return "none"
  for (var i = 0; i < list.length; i++) {
    var m = list[i]
    if (m && m.status && typeof m.status.value === "string") return "swap"
  }
  return "direct"
}

// The model a directly-run llama-server is serving. Its id is a repository
// path like "unsloth/Qwen3-0.6B-GGUF:Q4_K_M", which is never interpolated into
// a URL in this mode — the counters are at a fixed /metrics — so it only has to
// be safe and legible as an object key.
function directModelName(jsonText) {
  var doc
  try {
    doc = JSON.parse(String(jsonText || ""))
  } catch (e) {
    return ""
  }
  var list = doc && doc.data
  if (!Array.isArray(list) || list.length === 0) return ""
  var first = list[0]
  var id = first && typeof first.id === "string" ? first.id : ""
  return shortModelName(id) || "llama.cpp"
}

// "unsloth/Qwen3-0.6B-GGUF:Q4_K_M" -> "Qwen3-0.6B-GGUF". The full path is
// unreadable in a bar tooltip and useless as a per-model row label.
function shortModelName(id) {
  var raw = String(id === undefined || id === null ? "" : id)
  var slash = raw.lastIndexOf("/")
  if (slash !== -1) raw = raw.substring(slash + 1)
  var colon = raw.indexOf(":")
  if (colon !== -1) raw = raw.substring(0, colon)
  return modelKey(raw)
}

// Whether the resident set changed between two sweeps. A change means a model
// was swapped in or out while we were mid-sweep, so this sweep cannot claim to
// have covered the whole period — see the watermark rule in TokenStats.qml.
function sameModelSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// ------------------------------------------------------- panel-set settings

// Settings the panel is allowed to write, with the shape each value must have.
// This is an ALLOW-LIST, not documentation: parseSettings and applySetting both
// gate on it, so a malformed stored file or a mis-typed call cannot introduce a
// key the widget never expected or a value of the wrong type.
//
// These are *overrides*. shell.json remains the base — Setup > Plugins still
// works and is still where a fresh install gets its defaults — and clearing an
// override falls back to it. The plugin never writes shell.json: that is the
// user's own bar layout, and rewriting it from a widget is the sort of thing
// the marketplace checklist asks about by name. Omarchy's own weather panel
// takes the same approach, persisting to a state file it owns rather than to
// the user's configuration.
var SETTING_SPECS = {
  barPeriod:                  { kind: "enum", options: ["This hour", "Today", "7 days", "30 days", "12 months", "All recorded"] },
  refreshIntervalSec:         { kind: "int", min: 2, max: 120 },
  cloudInputPerMillion:       { kind: "money" },
  cloudCachedInputPerMillion: { kind: "money" },
  cloudOutputPerMillion:      { kind: "money" },
  systemWatts:                { kind: "int", min: 0, max: 2000 },
  pricePerKwh:                { kind: "money" },
  currencySymbol:             { kind: "text", max: 3 },
  importOpencode:             { kind: "bool" },
  importClaude:               { kind: "bool" },
  importCodex:                { kind: "bool" }
}

// The built-in default for every setting, used when neither the panel nor
// shell.json has a value. These MUST equal manifest.json's `defaults` block, or
// the Setup pane would show one number while a fresh install used another;
// test/tokenmodel-test.mjs reads the manifest and asserts exactly that, so the
// two cannot drift apart unnoticed.
var SETTING_DEFAULTS = {
  barPeriod: "Today",
  refreshIntervalSec: 10,
  cloudInputPerMillion: "3.00",
  cloudCachedInputPerMillion: "0.30",
  cloudOutputPerMillion: "15.00",
  systemWatts: 120,
  pricePerKwh: "0.12",
  currencySymbol: "$",
  importOpencode: true,
  importClaude: true,
  importCodex: true
}

function settingDefault(key) {
  var v = SETTING_DEFAULTS[String(key)]
  return v === undefined ? "" : v
}

function isSettingKey(key) {
  return Object.prototype.hasOwnProperty.call(SETTING_SPECS, String(key))
}

// Coerce a value to the shape its key demands, or return undefined to mean
// "not storable" — the caller then leaves the override unset and shell.json
// keeps deciding. Money is kept as a STRING because that is what the manifest
// schema declares and what the settings UI round-trips; it is validated as a
// number here so a stored file can never put a NaN into a price.
function coerceSetting(key, value) {
  var spec = SETTING_SPECS[String(key)]
  if (!spec) return undefined

  if (spec.kind === "bool") return value === true || value === "true"

  if (spec.kind === "int") {
    var n = Math.round(Number(value))
    if (!isNum(n)) return undefined
    return Math.min(Math.max(n, spec.min), spec.max)
  }

  if (spec.kind === "money") {
    var raw = String(value === undefined || value === null ? "" : value).trim()
    if (raw.length === 0 || raw.length > 12) return undefined
    if (!/^[0-9]+(\.[0-9]{1,4})?$/.test(raw)) return undefined
    var m = Number(raw)
    if (!isNum(m) || m < 0 || m > 1000) return undefined
    return raw
  }

  if (spec.kind === "enum") {
    var t = String(value === undefined || value === null ? "" : value)
    return spec.options.indexOf(t) === -1 ? undefined : t
  }

  // text
  var str = String(value === undefined || value === null ? "" : value)
  if (str.length === 0) return undefined
  return str.substring(0, spec.max)
}

// Stored overrides are local state, so they are attacker-controlled in the same
// threat model as history.json: parsed defensively, unknown keys dropped, every
// value re-coerced rather than trusted.
function parseSettings(text) {
  var out = {}
  var raw = String(text === undefined || text === null ? "" : text)
  if (raw.length === 0 || raw.length > MAX_STATE_BYTES) return out
  var doc
  try {
    doc = JSON.parse(raw)
  } catch (e) {
    return out
  }
  if (!doc || typeof doc !== "object") return out
  for (var key in SETTING_SPECS) {
    if (!Object.prototype.hasOwnProperty.call(doc, key)) continue
    var v = coerceSetting(key, doc[key])
    if (v !== undefined) out[key] = v
  }
  return out
}

// Returns a NEW object: assigning the same reference back would not notify any
// binding, and every displayed setting is a binding.
function applySetting(overrides, key, value) {
  var out = {}
  var src = overrides && typeof overrides === "object" ? overrides : {}
  for (var k in src) if (isSettingKey(k)) out[k] = src[k]
  if (!isSettingKey(key)) return out
  if (value === null) { delete out[key]; return out }
  var coerced = coerceSetting(key, value)
  if (coerced !== undefined) out[key] = coerced
  return out
}

// ---------------------------------------------------------------- deltas

// Counters are per llama-server process, so they restart at zero whenever
// llama-swap swaps models. A reading lower than the last one means the process
// was replaced: bank nothing for that step and re-baseline, rather than
// recording a negative or treating the new absolute value as a delta.
function zeroDeltaReset() {
  return { promptTokens: 0, promptCached: 0, predictedTokens: 0,
           predictedSeconds: 0, reset: true }
}

function deltaFrom(previous, current) {
  if (!current) return null
  if (!previous || previous.model !== current.model) {
    return zeroDeltaReset()
  }
  if (current.predictedTokens < previous.predictedTokens ||
      current.promptTokens < previous.promptTokens ||
      current.promptCached < previous.promptCached) {
    return zeroDeltaReset()
  }
  return {
    promptTokens: clampNonNeg(current.promptTokens - previous.promptTokens, MAX_TOKENS_PER_SAMPLE),
    promptCached: clampNonNeg(current.promptCached - previous.promptCached, MAX_TOKENS_PER_SAMPLE),
    predictedTokens: clampNonNeg(current.predictedTokens - previous.predictedTokens, MAX_TOKENS_PER_SAMPLE),
    predictedSeconds: clampNonNeg(current.predictedSeconds - previous.predictedSeconds, MAX_SECONDS_PER_SAMPLE),
    reset: false
  }
}

// ---------------------------------------------------------------- buckets

function pad(n) { return n < 10 ? "0" + n : String(n) }

function minuteKey(date) {
  return hourKey(date) + ":" + pad(date.getMinutes())
}

function hourKey(date) {
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
         "T" + pad(date.getHours())
}

function dayKey(date) {
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate())
}

function monthKey(date) {
  return date.getFullYear() + "-" + pad(date.getMonth() + 1)
}

// p prompt tokens, c generated tokens, s measured generation seconds,
// m generated tokens that came WITH measured seconds, n requests (reserved).
//
// m exists because imported history carries exact token counts but no usable
// generation time — opencode's message wall clock includes tool calls and
// waiting, which reads as 2 tok/s against a benchmarked 46. Rate is m/s, so an
// imported bucket reports its tokens and declines to invent a rate.
// p  prompt tokens actually processed        c  generated tokens
// pc prompt tokens served from the KV cache   s  measured generation seconds
// m  generated tokens that came WITH seconds  n  requests (reserved)
//
// p and pc are kept apart deliberately. p is the work the hardware actually
// did; p + pc is what a hosted API would have called your prompt. Folding them
// together loses the first. Counting only p in the savings figure — which is
// what this plugin did before version 4 — understates the comparison by
// whatever the cache served, and on a long agent session that is most of it.
function emptyBucket() { return { p: 0, pc: 0, c: 0, s: 0, n: 0, m: 0, byModel: {} } }

// Model ids come from llama-swap and from OpenCode's records, so they are
// sanitised before being used as object keys.
function modelKey(name) {
  var raw = String(name === undefined || name === null ? "" : name).trim()
  if (raw.length === 0) return ""
  var cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "")
  var key = cleaned.substring(0, MAX_MODEL_NAME)
  // These names otherwise resolve to inherited values in the bucket maps.
  if (key === "prototype" || Object.prototype.hasOwnProperty.call(Object.prototype, key)) return ""
  return key
}

function addModel(bucket, model, delta, metered) {
  var key = modelKey(model)
  if (key === "") return
  if (!bucket.byModel) bucket.byModel = {}
  if (!bucket.byModel[key]) {
    if (Object.keys(bucket.byModel).length >= MAX_MODELS_PER_BUCKET) return
    bucket.byModel[key] = { p: 0, pc: 0, c: 0, s: 0, m: 0 }
  }
  var slot = bucket.byModel[key]
  slot.p += delta.promptTokens
  slot.pc += clampNonNeg(delta.promptCached, MAX_TOKENS_PER_SAMPLE)
  slot.c += delta.predictedTokens
  if (metered) {
    slot.s += delta.predictedSeconds
    slot.m += delta.predictedTokens
  }
}

// Every per-model figure is re-validated on the way in, and the map is capped.
function parseByModel(src) {
  var out = {}
  if (!src || typeof src !== "object") return out
  var keys = Object.keys(src)
  var limit = keys.length < MAX_MODELS_PER_BUCKET ? keys.length : MAX_MODELS_PER_BUCKET
  for (var i = 0; i < limit; i++) {
    var key = modelKey(keys[i])
    if (key === "") continue
    var v = src[keys[i]]
    if (!v || typeof v !== "object") continue
    var c = clampNonNeg(v.c, Number.MAX_SAFE_INTEGER)
    out[key] = {
      p: clampNonNeg(v.p, Number.MAX_SAFE_INTEGER),
      pc: clampNonNeg(v.pc, Number.MAX_SAFE_INTEGER),
      c: c,
      s: clampNonNeg(v.s, Number.MAX_SAFE_INTEGER),
      m: v.m === undefined ? c : clampNonNeg(v.m, Number.MAX_SAFE_INTEGER)
    }
  }
  return out
}

// `covered` is the honest part of the accounting: per model, the instant up to
// which LIVE sampling is known to be complete. `importedThrough` is only the
// floor for a model that has no entry — one that has never been resident while
// we were watching.
//
// A single global watermark cannot be correct here. Coverage breaks per model
// (llama-swap restarts one llama-server and its counters return to zero) while
// the others keep being sampled cleanly, so a global "we are covered through
// now" both over-claims for the model that reset and blocks the one source —
// OpenCode's exact per-reply counts — that could have filled the gap.
function emptyHistory() {
  return { version: HISTORY_VERSION, minutes: {}, hours: {}, days: {},
           importedThrough: 0, covered: {} }
}

// The oldest instant the importer still has to consider, so the SQL asks for as
// few rows as it can while never skipping one.
function coverageFloor(history) {
  var floor = clampNonNeg(history && history.importedThrough, Number.MAX_SAFE_INTEGER)
  var covered = history && history.covered
  if (!covered || typeof covered !== "object") return floor
  for (var k in covered) {
    var v = covered[k]
    if (isNum(v) && v < floor) floor = v
  }
  return floor
}

// Record that live sampling covered `model` up to `ms`. Never moves backwards:
// a stale reply must not reopen a window the importer has already been told is
// closed, or the same tokens would be counted twice.
function markCovered(history, model, ms) {
  if (!history) return
  if (!history.covered || typeof history.covered !== "object") history.covered = {}
  var key = modelKey(model)
  if (key === "") return
  if (!isNum(ms) || ms < 0) return
  if (Object.keys(history.covered).length >= MAX_MODELS_PER_BUCKET &&
      history.covered[key] === undefined) return
  if (!isNum(history.covered[key]) || history.covered[key] < ms) history.covered[key] = ms
}

// What live sampling claims for one model, falling back to the global floor for
// a model we have never sampled.
function coveredFor(history, model) {
  var covered = history && history.covered
  var key = modelKey(model)
  if (covered && isNum(covered[key])) return covered[key]
  return clampNonNeg(history && history.importedThrough, Number.MAX_SAFE_INTEGER)
}

function parseCovered(src) {
  var out = {}
  if (!src || typeof src !== "object") return out
  var keys = Object.keys(src)
  var limit = keys.length < MAX_MODELS_PER_BUCKET ? keys.length : MAX_MODELS_PER_BUCKET
  for (var i = 0; i < limit; i++) {
    var k = modelKey(keys[i])
    if (k === "") continue
    var v = src[keys[i]]
    if (!isNum(v) || v < 0) continue
    out[k] = v
  }
  return out
}

// Accept only what we wrote, and only in the shape we wrote it. A state file is
// user-writable, so every number is re-validated on the way in.
function parseHistory(text) {
  var raw = String(text === undefined || text === null ? "" : text)
  if (raw.length === 0 || raw.length > MAX_STATE_BYTES) return emptyHistory()

  var doc
  try {
    doc = JSON.parse(raw)
  } catch (e) {
    return emptyHistory()
  }
  return parseHistoryDoc(doc)
}

// The same validation for a history that arrives as an already-parsed object —
// each provider entry inside agents.json is one of these.
function parseHistoryDoc(doc) {
  if (!doc || typeof doc !== "object" || doc.version !== HISTORY_VERSION) return emptyHistory()

  var out = emptyHistory()
  out.importedThrough = clampNonNeg(doc.importedThrough, Number.MAX_SAFE_INTEGER)
  out.covered = parseCovered(doc.covered)
  var groups = ["minutes", "hours", "days"]
  for (var g = 0; g < groups.length; g++) {
    var name = groups[g]
    var src = doc[name]
    if (!src || typeof src !== "object") continue
    var keys = Object.keys(src)
    var limit = keys.length < 2000 ? keys.length : 2000
    for (var i = 0; i < limit; i++) {
      var k = keys[i]
      if (!/^[0-9]{4}-[0-9]{2}(-[0-9]{2})?(T[0-9]{2}(:[0-9]{2})?)?$/.test(k)) continue
      var b = src[k]
      if (!b || typeof b !== "object") continue
      var c = clampNonNeg(b.c, Number.MAX_SAFE_INTEGER)
      out[name][k] = {
        p: clampNonNeg(b.p, Number.MAX_SAFE_INTEGER),
        pc: clampNonNeg(b.pc, Number.MAX_SAFE_INTEGER),
        c: c,
        s: clampNonNeg(b.s, Number.MAX_SAFE_INTEGER),
        n: clampNonNeg(b.n, Number.MAX_SAFE_INTEGER),
        // Files written before `m` existed hold live-sampled data only, so the
        // whole count was metered.
        m: b.m === undefined ? c : clampNonNeg(b.m, Number.MAX_SAFE_INTEGER),
        byModel: parseByModel(b.byModel)
      }
    }
  }
  return out
}

// Fold one delta into both the hourly and daily bucket for `date`. Writing both
// up front keeps reads trivial: no rollup pass has to run before a query.
function record(history, delta, date, requestDelta, metered, model) {
  if (!history || !delta) return history
  var isMetered = metered !== false
  var groups = [["minutes", minuteKey(date)], ["hours", hourKey(date)], ["days", dayKey(date)]]
  for (var i = 0; i < groups.length; i++) {
    var group = groups[i][0], key = groups[i][1]
    var bucket = history[group][key] || emptyBucket()
    bucket.p += delta.promptTokens
    bucket.pc += clampNonNeg(delta.promptCached, MAX_TOKENS_PER_SAMPLE)
    bucket.c += delta.predictedTokens
    bucket.n += clampNonNeg(requestDelta, 100000)
    if (isMetered) {
      bucket.s += delta.predictedSeconds
      bucket.m += delta.predictedTokens
    }
    addModel(bucket, model, delta, isMetered)
    history[group][key] = bucket
  }
  return history
}

// Drop buckets past the retention window. Called on load and before each write,
// so the file cannot grow without bound.
function prune(history, now) {
  if (!history) return emptyHistory()
  var minuteCut = new Date(now.getTime() - KEEP_MINUTES * 60000)
  var hourCut = new Date(now.getTime() - KEEP_HOURS * 3600000)
  var dayCut = new Date(now.getTime() - KEEP_DAYS * 86400000)
  var nk = minuteKey(minuteCut), hk = hourKey(hourCut), dk = dayKey(dayCut)
  var k

  if (!history.minutes) history.minutes = {}
  for (k in history.minutes) if (k < nk) delete history.minutes[k]
  for (k in history.hours) if (k < hk) delete history.hours[k]
  for (k in history.days) if (k < dk) delete history.days[k]

  // A model that has not been seen for the whole retention window can go: its
  // OpenCode rows are older than anything we would still display, so dropping
  // the mark cannot cause a re-import of anything visible.
  if (!history.covered || typeof history.covered !== "object") history.covered = {}
  var coveredCut = now.getTime() - KEEP_DAYS * 86400000
  for (k in history.covered) {
    if (!isNum(history.covered[k]) || history.covered[k] < coveredCut) delete history.covered[k]
  }
  return history
}

// ---------------------------------------------------------------- queries

function addInto(target, bucket) {
  target.p += bucket.p; target.c += bucket.c
  target.pc += clampNonNeg(bucket.pc, Number.MAX_SAFE_INTEGER)
  target.s += bucket.s; target.n += bucket.n
  target.m += bucket.m === undefined ? bucket.c : bucket.m

  var src = bucket.byModel || {}
  if (!target.byModel) target.byModel = {}
  for (var key in src) {
    if (!target.byModel[key]) target.byModel[key] = { p: 0, pc: 0, c: 0, s: 0, m: 0 }
    var into = target.byModel[key], from = src[key]
    into.p += from.p; into.c += from.c
    into.pc += clampNonNeg(from.pc, Number.MAX_SAFE_INTEGER)
    into.s += from.s; into.m += from.m === undefined ? from.c : from.m
  }
  return target
}

// Per-model rows for the panel, biggest first, with each model's share of the
// window. Sorting here rather than in QML keeps the view declarative.
function modelBreakdown(bucket) {
  var out = []
  var src = (bucket && bucket.byModel) || {}
  var total = 0
  var key

  for (key in src) total += src[key].c
  for (key in src) {
    out.push({
      model: key,
      prompt: src[key].p,
      promptCached: clampNonNeg(src[key].pc, Number.MAX_SAFE_INTEGER),
      tokens: src[key].c,
      seconds: src[key].s,
      metered: src[key].m === undefined ? src[key].c : src[key].m,
      share: total > 0 ? (src[key].c / total) * 100 : 0
    })
  }
  out.sort(function (a, b) { return b.tokens - a.tokens })
  return out
}

// What fraction of the prompt the KV cache served, 0-100. Worth surfacing: it
// is the single number that explains why a local agent session stays fast, and
// it is the difference between this plugin's prompt figure and the one a hosted
// API would have billed.
function cacheHitPercent(bucket) {
  if (!bucket) return 0
  var processed = clampNonNeg(bucket.p, Number.MAX_SAFE_INTEGER)
  var cached = clampNonNeg(bucket.pc, Number.MAX_SAFE_INTEGER)
  var total = processed + cached
  return total > 0 ? (cached / total) * 100 : 0
}

// Totals for a named window. "all" sums the daily buckets, which is every day
// still retained rather than a lifetime figure — the UI says so.
function totals(history, period, now) {
  var sum = emptyBucket()
  if (!history) return sum
  var k

  if (period === "hour") {
    // Summed from the minute buckets rather than the hourly one, so this total
    // always agrees with the graph beside it — the two read the same rows.
    var prefix = hourKey(now)
    for (k in (history.minutes || {})) {
      if (k.indexOf(prefix) === 0) addInto(sum, history.minutes[k])
    }
    return sum
  }
  if (period === "day") {
    var d = history.days[dayKey(now)]
    return d ? addInto(sum, d) : sum
  }
  if (period === "week" || period === "month" || period === "year") {
    var days = period === "week" ? 7 : (period === "month" ? 30 : 365)
    var cut = dayKey(new Date(now.getTime() - (days - 1) * 86400000))
    for (k in history.days) if (k >= cut) addInto(sum, history.days[k])
    return sum
  }
  for (k in history.days) addInto(sum, history.days[k])
  return sum
}

// A dense series for the graph: one point per slot with zeroes filled in, so
// the chart shows quiet periods instead of silently compressing them.
function series(history, period, now) {
  var out = []
  var i, d, key, b

  if (period === "hour") {
    // 60 one-minute slots. Without this the hour view was a copy of the day
    // view, which is what made the graph look wrong.
    for (i = 59; i >= 0; i--) {
      d = new Date(now.getTime() - i * 60000)
      key = minuteKey(d)
      b = history && history.minutes && history.minutes[key]
      out.push({ label: pad(d.getMinutes()), tokens: b ? b.c : 0, key: key,
                 at: d.getTime(), slot: "minute" })
    }
    return out
  }

  if (period === "day") {
    for (i = 23; i >= 0; i--) {
      d = new Date(now.getTime() - i * 3600000)
      key = hourKey(d)
      b = history && history.hours[key]
      out.push({ label: pad(d.getHours()), tokens: b ? b.c : 0, key: key,
                 at: d.getTime(), slot: "hour" })
    }
    return out
  }

  var days = period === "week" ? 7 : (period === "month" ? 30 : 365)
  if (period === "year") {
    for (i = 11; i >= 0; i--) {
      d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      var mk = monthKey(d)
      var acc = 0
      for (key in (history ? history.days : {})) {
        if (key.indexOf(mk) === 0) acc += history.days[key].c
      }
      out.push({ label: MONTHS[d.getMonth()], tokens: acc, key: mk,
                 at: d.getTime(), slot: "month" })
    }
    return out
  }

  for (i = days - 1; i >= 0; i--) {
    d = new Date(now.getTime() - i * 86400000)
    key = dayKey(d)
    b = history && history.days[key]
    out.push({ label: pad(d.getDate()), tokens: b ? b.c : 0, key: key,
               at: d.getTime(), slot: "day" })
  }
  return out
}

// ---------------------------------------------------------------- money

// Every input is a stated assumption rather than a discovered fact, so the UI
// shows the rates alongside the number. Local cost is energy only: the hardware
// is already bought, and charging notional per-GB-hour "memory rent" against
// running a model you own is not a real saving.
// Cached prompt tokens are billed by hosted APIs too, at a reduced rate rather
// than free, so they get their own price instead of being dropped or charged in
// full. The default is a tenth of the input rate, which is where the common
// providers sit; like every other rate here it is a stated assumption the panel
// prints on screen, not a measurement.
function savings(bucket, rates) {
  var r = rates || {}
  var inRate = isNum(r.inputPerMillion) ? r.inputPerMillion : 0
  var outRate = isNum(r.outputPerMillion) ? r.outputPerMillion : 0
  var cachedRate = isNum(r.cachedInputPerMillion) ? r.cachedInputPerMillion : inRate / 10
  var watts = isNum(r.watts) ? r.watts : 0
  var kwhPrice = isNum(r.pricePerKwh) ? r.pricePerKwh : 0

  var cloud = (bucket.p / 1000000) * inRate
            + (clampNonNeg(bucket.pc, Number.MAX_SAFE_INTEGER) / 1000000) * cachedRate
            + (bucket.c / 1000000) * outRate
  var energyKwh = (watts / 1000) * (bucket.s / 3600)
  var local = energyKwh * kwhPrice

  return {
    cloud: cloud,
    local: local,
    net: cloud - local,
    energyKwh: energyKwh
  }
}

// ---------------------------------------------------------------- format

function formatTokens(n) {
  if (!isNum(n) || n < 0) return "0"
  if (n < 1000) return String(Math.round(n))
  if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + "k"
  if (n < 1000000000) return (n / 1000000).toFixed(n < 10000000 ? 1 : 0) + "M"
  return (n / 1000000000).toFixed(1) + "B"
}

function formatRate(tokens, seconds) {
  if (!isNum(tokens) || !isNum(seconds) || seconds <= 0) return "—"
  return (tokens / seconds).toFixed(1) + " tok/s"
}

function formatMoney(amount, symbol) {
  var s = symbol || "$"
  if (!isNum(amount)) return s + "0.00"
  var abs = amount < 0 ? -amount : amount
  var body = abs < 10 ? abs.toFixed(2) : (abs < 1000 ? abs.toFixed(1) : abs.toFixed(0))
  return (amount < 0 ? "-" : "") + s + body
}

function periodLabel(period) {
  switch (period) {
    case "hour":  return "This hour"
    case "day":   return "Today"
    case "week":  return "7 days"
    case "month": return "30 days"
    case "year":  return "12 months"
    default:      return "All recorded"
  }
}

// ---------------------------------------------------------------- settings

// The manifest's enum options are the strings the settings UI shows and
// shell.json stores, so the readable label is the wire format. Map it here and
// fall back rather than passing an unknown value to a query.
var PERIOD_KEYS = {
  "this hour": "hour",
  "today": "day",
  "7 days": "week",
  "30 days": "month",
  "12 months": "year",
  "all recorded": "all"
}

// The inverse of periodKey: an internal key back to the exact label the
// manifest's enum declares. The Setup pane stores the manifest label, not the
// internal key, so a value set in the panel and a value set in Setup > Plugins
// are the same string and either can be read by the other.
var PERIOD_SETTING_LABELS = {
  hour: "This hour",
  day: "Today",
  week: "7 days",
  month: "30 days",
  year: "12 months",
  all: "All recorded"
}

function periodSettingLabel(key) {
  var label = PERIOD_SETTING_LABELS[String(key)]
  return label === undefined ? "Today" : label
}

function periodKey(label) {
  var key = String(label === undefined || label === null ? "" : label).trim().toLowerCase()
  return PERIOD_KEYS.hasOwnProperty(key) ? PERIOD_KEYS[key] : "day"
}

// ---------------------------------------------------------------- memory

// Just the two fields the tooltip needs, with the same bounded, reject-on-doubt
// posture as the metrics parser.
function parseMeminfo(text) {
  var raw = String(text === undefined || text === null ? "" : text)
  if (raw.length === 0 || raw.length > 65536) return null

  var total = NaN, available = NaN
  var lines = raw.split("\n")
  var limit = lines.length < 512 ? lines.length : 512
  for (var i = 0; i < limit; i++) {
    var m = /^(MemTotal|MemAvailable):\s+(\d+) kB$/.exec(lines[i])
    if (!m) continue
    var v = parseInt(m[2], 10)
    if (!isNum(v) || v < 0) continue
    if (m[1] === "MemTotal") total = v
    else available = v
  }
  if (!isNum(total) || total <= 0) return null
  if (!isNum(available)) available = 0
  return { total: total, available: Math.min(available, total) }
}

// KiB -> human string, GiB above one GiB so a busy machine never reads 0.0 GiB.
function formatSize(kib) {
  if (!isNum(kib) || kib < 0) return "—"
  return kib >= 1048576 ? (kib / 1048576).toFixed(1) + " GiB"
                        : (kib / 1024).toFixed(0) + " MiB"
}


// ---------------------------------------------------------------- rates

// Hours actually elapsed inside a window, so a rate early in the day is not
// divided by a full 24 hours. Trailing windows (week/month/year) are complete
// by definition; calendar windows (hour/day) are only partly through.
function elapsedHours(period, now) {
  var ms
  switch (period) {
    case "hour":
      ms = now.getMinutes() * 60000 + now.getSeconds() * 1000
      return Math.max(ms / 3600000, 1 / 60)
    case "day":
      ms = now.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      return Math.max(ms / 3600000, 1 / 60)
    case "week":  return 7 * 24
    case "month": return 30 * 24
    case "year":  return 365 * 24
    default:      return 0
  }
}

// Tokens per hour across a window. "all" measures from the oldest day still
// retained rather than assuming a window length.
function tokensPerHour(history, period, now) {
  var bucket = totals(history, period, now)
  var hours = elapsedHours(period, now)

  if (period === "all" || hours <= 0) {
    var oldest = null
    for (var k in (history && history.days ? history.days : {})) {
      if (oldest === null || k < oldest) oldest = k
    }
    if (oldest === null) return 0
    var parts = oldest.split("-")
    var start = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
    hours = Math.max((now.getTime() - start.getTime()) / 3600000, 1 / 60)
  }

  if (!isNum(bucket.c) || hours <= 0) return 0
  return bucket.c / hours
}

// ---------------------------------------------------------------- import

// One row per assistant reply from OpenCode's database:
//   completedMs|inputTokens|outputTokens|reasoningTokens
// Token counts there come from the provider's own usage block, so they are
// exact — but the message wall clock is not generation time (it includes tool
// calls and waiting), so imported rows carry tokens only and are recorded
// unmetered.
function parseOpencodeRows(text, notBefore, notAfter) {
  var raw = String(text === undefined || text === null ? "" : text)
  if (raw.length === 0 || raw.length > MAX_STATE_BYTES) return []

  var lines = raw.split("\n")
  var limit = lines.length < 40000 ? lines.length : 40000
  var out = []
  var floor = isNum(notBefore) ? notBefore : 0
  var ceiling = isNum(notAfter) ? notAfter : Number.MAX_SAFE_INTEGER

  for (var i = 0; i < limit; i++) {
    var line = lines[i]
    if (line.length === 0) continue
    var f = line.split("|")
    if (f.length < 4) continue

    var when = parseInt(f[0], 10)
    if (!isNum(when) || when <= floor || when >= ceiling) continue

    var input = parseInt(f[1], 10)
    var output = parseInt(f[2], 10)
    var reasoning = parseInt(f[3], 10)
    if (!isNum(output)) continue
    // OpenCode splits the prompt the same way llama.cpp's counters do:
    // `tokens.input` is what was actually processed and `tokens.cache.read` /
    // `.write` is what the cache served. Reading only `input` — which this
    // plugin did before version 4 — drops the larger part by far: on one day of
    // real use here, 268k processed against 6.25M served from cache.
    var cached = parseInt(f.length > 5 ? f[5] : "0", 10)

    out.push({
      when: when,
      model: f.length > 4 ? modelKey(f[4]) : "",
      promptTokens: clampNonNeg(input, MAX_TOKENS_PER_SAMPLE),
      promptCached: clampNonNeg(isNum(cached) ? cached : 0, MAX_TOKENS_PER_SAMPLE),
      predictedTokens: clampNonNeg(output, MAX_TOKENS_PER_SAMPLE) +
                       clampNonNeg(isNum(reasoning) ? reasoning : 0, MAX_TOKENS_PER_SAMPLE),
      predictedSeconds: 0
    })
  }
  return out
}

// Fold imported rows in, newest timestamp returned so the caller can advance
// its watermark and never import the same reply twice.
// Rows are admitted per model against that model's own live-coverage mark, not
// against one global watermark. A row is taken only when live sampling did NOT
// already account for that model at that instant, so the two sources can run at
// the same time — which they must, because live sampling covers only models
// that are resident, and OpenCode covers only what OpenCode ran.
function applyImport(history, rows) {
  var newest = 0
  var taken = 0
  var models = []
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    if (row.predictedTokens <= 0 && row.promptTokens <= 0) continue
    if (row.when <= coveredFor(history, row.model)) continue
    record(history, row, new Date(row.when), 1, false, row.model)
    taken++
    if (models.indexOf(row.model) === -1 && models.length < MAX_MODELS_PER_BUCKET)
      models.push(row.model)
    if (row.when > newest) newest = row.when
  }
  return { newest: newest, taken: taken, models: models }
}

// Close the books after an import that read every OpenCode row up to
// `boundary`. At that point every model is accounted for through `boundary` —
// live where live had it, imported where it did not — so every mark moves up
// and the floor with it. Without this the floor would stay pinned to the oldest
// model ever seen and the importer would rescan the whole database forever.
//
// The caller MUST drop the live baseline for every model in `models`: the next
// counter delta would otherwise span a window these rows already covered, and
// bank it a second time.
function reconcileImport(history, boundary) {
  if (!history || !isNum(boundary) || boundary < 0) return
  if (!history.covered || typeof history.covered !== "object") history.covered = {}
  for (var k in history.covered) {
    if (!isNum(history.covered[k]) || history.covered[k] < boundary) history.covered[k] = boundary
  }
  if (!isNum(history.importedThrough) || history.importedThrough < boundary)
    history.importedThrough = boundary
}

// Return a new top-level object sharing the same bucket maps.
//
// QML will not re-evaluate bindings when a `var` property is assigned the same
// object reference it already holds, so mutating history in place and then
// writing `root.history = root.history` updates nothing. Swapping in a fresh
// identity is cheap — five references — and is what actually notifies.
// A shallow copy under a NEW top-level identity, so QML notices the change —
// assigning the same object reference back notifies nothing and the bar sits at
// its old value.
//
// Every own key is carried, deliberately. An earlier version listed the fields
// by hand and a later field was simply left out of the list: it was written by
// every code path, dropped on the next repaint, and nothing failed loudly. If
// you add a top-level field, this function already handles it.
function touched(history) {
  if (!history) return emptyHistory()
  var out = {}
  for (var k in history) {
    if (Object.prototype.hasOwnProperty.call(history, k)) out[k] = history[k]
  }
  return out
}


// ---------------------------------------------------------------- labels

var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

// Axis text for one slot. Bare numbers ("15 17 19") read as nothing in
// particular, so hours carry a colon and days carry their month.
function axisLabel(point) {
  if (!point) return ""
  var d = new Date(point.at)
  switch (point.slot) {
    case "minute": return pad(d.getMinutes())
    case "hour":   return pad(d.getHours()) + ":00"
    case "month":  return MONTHS[d.getMonth()]
    default:       return MONTHS[d.getMonth()] + " " + d.getDate()
  }
}

// A day boundary is worth marking on an hour axis, otherwise "23:00 00:00"
// looks like a continuous run rather than a new day.
function isBoundary(point) {
  if (!point) return false
  var d = new Date(point.at)
  if (point.slot === "hour") return d.getHours() === 0
  if (point.slot === "minute") return d.getMinutes() === 0
  if (point.slot === "day") return d.getDate() === 1
  return false
}

// Full description of one slot, for the hover readout.
function pointDetail(point) {
  if (!point) return ""
  var d = new Date(point.at)
  var when
  switch (point.slot) {
    case "minute":
      when = DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()] +
             ", " + pad(d.getHours()) + ":" + pad(d.getMinutes())
      break
    case "hour":
      when = DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()] +
             ", " + pad(d.getHours()) + ":00-" + pad(d.getHours()) + ":59"
      break
    case "month":
      when = MONTHS[d.getMonth()] + " " + d.getFullYear()
      break
    default:
      when = DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()] +
             " " + d.getFullYear()
  }
  return when + "  ·  " + formatTokens(point.tokens) + " tokens"
}

// The span a chart covers, so the reader knows what they are looking at
// without hovering anything.
function rangeLabel(points) {
  if (!points || points.length === 0) return ""
  var first = new Date(points[0].at)
  var last = new Date(points[points.length - 1].at)
  var slot = points[0].slot

  if (slot === "minute" || slot === "hour") {
    var sameDay = first.getDate() === last.getDate() && first.getMonth() === last.getMonth()
    var head = MONTHS[first.getMonth()] + " " + first.getDate() + " " +
               pad(first.getHours()) + ":" + pad(first.getMinutes())
    var tail = (sameDay ? "" : MONTHS[last.getMonth()] + " " + last.getDate() + " ") +
               pad(last.getHours()) + ":" + pad(last.getMinutes())
    return head + " - " + tail
  }
  if (slot === "month") return MONTHS[first.getMonth()] + " " + first.getFullYear() +
                               " - " + MONTHS[last.getMonth()] + " " + last.getFullYear()
  return MONTHS[first.getMonth()] + " " + first.getDate() + " - " +
         MONTHS[last.getMonth()] + " " + last.getDate()
}

// ---------------------------------------------------------------- sessions

// One row per OpenCode session:
//   id|title|generatedTokens|model|directory|updatedMs
// Session ids are validated because they are handed to a launcher.
function parseSessions(text) {
  var raw = String(text === undefined || text === null ? "" : text)
  if (raw.length === 0 || raw.length > MAX_STATE_BYTES) return []

  var lines = raw.split("\n")
  var limit = lines.length < 500 ? lines.length : 500
  var out = []

  for (var i = 0; i < limit && out.length < MAX_SESSIONS; i++) {
    var f = lines[i].split("|")
    if (f.length < 6) continue
    if (!/^ses_[A-Za-z0-9]{1,64}$/.test(f[0])) continue

    var tokens = parseInt(f[2], 10)
    var when = parseInt(f[5], 10)
    if (!isNum(tokens) || tokens <= 0) continue

    out.push({
      id: f[0],
      title: cleanTitle(f.length > 6 ? f[6] : "", f[1]),
      tokens: clampNonNeg(tokens, Number.MAX_SAFE_INTEGER),
      model: modelKey(f[3]),
      directory: String(f[4] || "").substring(0, 240),
      at: isNum(when) ? when : 0
    })
  }
  return out
}

// What a session was about, in one short line.
//
// The stored title is written by whatever `small_model` is configured, and a
// small one tends to emit its own reasoning ("Okay, let's tackle this. The user
// wants...") rather than a title. The opening user message is a far better
// summary of the session, so it is preferred and the stored title is only a
// fallback.
var TITLE_MAX = 58

function cleanTitle(opening, stored) {
  var t = shapeTitle(opening)
  if (t !== "") return t
  t = shapeTitle(stored)
  return t !== "" ? t : "(untitled)"
}

function shapeTitle(raw) {
  var t = String(raw === undefined || raw === null ? "" : raw)

  // One line only, and drop code fences and inline markup that read as noise
  // at this size.
  t = t.split("\n")[0]
  t = t.replace(/[`*_#>]+/g, " ")
  t = t.replace(/^\s*["'\u201c\u201d]+/, "").replace(/["'\u201c\u201d]+\s*$/, "")
  t = t.replace(/\s+/g, " ").trim()

  // Strip the reasoning preamble a small model produces when asked for a title.
  t = t.replace(/^(Okay|OK|Alright|Sure|Well|Hmm|Right)[,.!]?\s+/i, "")
  t = t.replace(/^(so\s+)?let'?s\s+(tackle|see|think about|look at)\s+this[.,]?\s*/i, "")
  t = t.replace(/^the user (wants|is asking|asked|would like)( to| for| about)?\s*/i, "")
  t = t.replace(/^(please|can you|could you|i want you to|i'?d like you to)\s+/i, "")
  t = t.trim()
  if (t.length === 0) return ""

  // Prefer the first sentence when it is a usable length on its own.
  var stop = t.search(/[.!?](\s|$)/)
  if (stop >= 12 && stop <= TITLE_MAX) t = t.substring(0, stop)

  if (t.length > TITLE_MAX) {
    var cut = t.substring(0, TITLE_MAX)
    var space = cut.lastIndexOf(" ")
    // Break on a word rather than mid-token, but only if that leaves something
    // substantial behind.
    if (space > TITLE_MAX * 0.6) cut = cut.substring(0, space)
    t = cut.replace(/[\s,;:-]+$/, "") + "\u2026"
  }

  return t.charAt(0).toUpperCase() + t.substring(1)
}

// ---------------------------------------------------------------- agents

// Cloud coding agents — Claude Code and Codex — tracked beside the local
// counts but never mixed into them: the savings figure above prices tokens
// you did NOT send to a hosted API, and folding in tokens you actually paid
// for would corrupt it. Each provider gets its own full history (the same
// bucket machinery, so totals/series/modelBreakdown all work on it), and the
// whole set persists as one agents.json.
//
// Both sources are exact, read from the tools' own records by
// scripts/scan-agents.sh: Claude Code stores the API's usage block per
// assistant message, Codex stores the API's per-turn usage in its
// token_count events.
var AGENT_PROVIDERS = ["claude", "codex"]
// Agent ingestion now uses persisted file positions, replacing a timestamp
// watermark that dropped delayed rows and reused cumulative Codex events. Only
// agents.json is rebuilt; HISTORY_VERSION and local metered history stay put.
var AGENT_HISTORY_VERSION = 5
// The file holds two bounded 2 MiB cursors plus both retained bucket sets.
// Applying the local history's 4 MiB cap here could discard valid saved data.
var MAX_AGENT_STATE_BYTES = 16777216
var MAX_AGENT_CURSOR_BYTES = 2097152
var MAX_AGENT_FILES = 400
var MAX_AGENT_SEEN = 16384
var MAX_AGENT_ROWS = 2000
var AGENT_SCAN_REASONS = ["", "work-limit", "file-limit", "entry-limit", "depth-limit",
  "row-limit", "skipped-records", "pending-record", "cursor-limit", "unsafe-file",
  "file-changed", "source-missing", "invalid-cursor", "invalid-arguments", "read-error",
  "deadline", "memory-limit", "cancelled", "internal-error"]

function emptyAgentCursor() {
  return { version: 1, revision: 0, files: [], seen: [], skipped: 0 }
}

function agentInteger(v, cap) {
  return isNum(v) && Math.floor(v) === v && v >= 0 && v <= cap
}

function agentObject(v, keys) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false
  var actual = Object.keys(v)
  if (actual.length !== keys.length) return false
  for (var i = 0; i < keys.length; i++)
    if (!Object.prototype.hasOwnProperty.call(v, keys[i])) return false
  return true
}

function agentText(v, cap) {
  // The Python scanner uses these same UTF-16 limits when shortening text.
  return typeof v === "string" && v.length <= cap && !/[\u0000-\u001f\u007f-\u009f|]/.test(v)
}

function agentUtf8Fits(text, cap) {
  if (text.length > cap) return false
  var bytes = 0
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i)
    if (code < 128) bytes++
    else if (code < 2048) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length &&
             text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4
      i++
    } else bytes += 3
    if (bytes > cap) return false
  }
  return true
}

function agentCursorFits(cursor) {
  // Match the helper's ensure_ascii JSON representation, including its byte
  // bound, so persisted Unicode paths cannot validate here then fail there.
  var encoded = JSON.stringify(cursor), bytes = 0
  for (var i = 0; i < encoded.length; i++) {
    bytes += encoded.charCodeAt(i) < 128 ? 1 : 6
    if (bytes > MAX_AGENT_CURSOR_BYTES) return false
  }
  return true
}

// A cursor is data, never executable state. Validate every field, not merely
// its byte size, before it can be persisted or sent to the descriptor-bound
// scanner. A corrupt cursor must reset its matching totals as well: retaining
// the buckets while restarting at byte zero would count them again.
function parseAgentCursor(src) {
  if (!agentObject(src, ["version", "revision", "files", "seen", "skipped"]) || src.version !== 1 ||
      !agentInteger(src.revision, Number.MAX_SAFE_INTEGER - 1) ||
      !agentInteger(src.skipped, Number.MAX_SAFE_INTEGER) ||
      !Array.isArray(src.files) || src.files.length > MAX_AGENT_FILES ||
      !Array.isArray(src.seen) || src.seen.length > MAX_AGENT_SEEN) return null
  var paths = Object.create(null), identities = Object.create(null), hashes = Object.create(null)
  var out = { version: 1, revision: src.revision, files: [], seen: [], skipped: src.skipped }
  var fileKeys = ["path", "device", "inode", "offset", "anchor", "model", "totals",
    "discarding", "sessionId", "title", "cwd", "output", "updated"]
  for (var i = 0; i < src.files.length; i++) {
    var f = src.files[i]
    if (!agentObject(f, fileKeys) || !agentText(f.path, 1024) || !f.path || f.path.charAt(0) === "/" ||
        /(^|\/)(\.|\.\.)(\/|$)/.test(f.path) || f.path.indexOf("//") !== -1 ||
        f.path.charAt(f.path.length - 1) === "/" || paths[f.path] ||
        typeof f.device !== "string" || !/^[0-9]{1,32}$/.test(f.device) ||
        typeof f.inode !== "string" || !/^[0-9]{1,32}$/.test(f.inode) || identities[f.device + ":" + f.inode] ||
        !agentInteger(f.offset, Number.MAX_SAFE_INTEGER) ||
        typeof f.anchor !== "string" || (f.offset === 0 ? f.anchor !== "" : !/^[a-f0-9]{64}$/.test(f.anchor)) ||
        typeof f.model !== "string" || !MODEL_ID_RE.test(f.model) || modelKey(f.model) !== f.model ||
        typeof f.discarding !== "boolean" || typeof f.sessionId !== "string" ||
        (f.sessionId !== "" && !/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(f.sessionId)) ||
        !agentText(f.title, 160) || !agentText(f.cwd, 240) ||
        !agentInteger(f.output, Number.MAX_SAFE_INTEGER) || !agentInteger(f.updated, 8640000000000000)) return null
    if (f.totals !== null) {
      if (!Array.isArray(f.totals) || f.totals.length !== 4) return null
      for (var t = 0; t < f.totals.length; t++)
        if (!agentInteger(f.totals[t], Number.MAX_SAFE_INTEGER)) return null
    }
    paths[f.path] = true
    identities[f.device + ":" + f.inode] = true
    out.files.push({ path: f.path, device: f.device, inode: f.inode, offset: f.offset,
      anchor: f.anchor, model: f.model, totals: f.totals === null ? null : f.totals.slice(),
      discarding: f.discarding, sessionId: f.sessionId, title: f.title, cwd: f.cwd,
      output: f.output, updated: f.updated })
  }
  for (var s = 0; s < src.seen.length; s++) {
    var hash = src.seen[s]
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) || hashes[hash]) return null
    hashes[hash] = true
    out.seen.push(hash)
  }
  if (!agentCursorFits(out)) return null
  return out
}

function emptyAgentHistory() {
  var out = emptyHistory()
  out.agentCursor = emptyAgentCursor()
  return out
}

function emptyAgentHistories() {
  var out = {}
  for (var i = 0; i < AGENT_PROVIDERS.length; i++)
    out[AGENT_PROVIDERS[i]] = emptyAgentHistory()
  return out
}

// agents.json is { version: N, providers: { claude: <history>, codex: … } }.
// Unknown providers are dropped. The outer version is independent from the
// shared bucket format so an ingestion repair never destroys local timing.
function parseAgentHistories(text) {
  var out = emptyAgentHistories()
  var raw = String(text === undefined || text === null ? "" : text)
  if (raw.length === 0 || !agentUtf8Fits(raw, MAX_AGENT_STATE_BYTES)) return out
  var doc
  try {
    doc = JSON.parse(raw)
  } catch (e) {
    return out
  }
  if (!doc || typeof doc !== "object" || doc.version !== AGENT_HISTORY_VERSION) return out
  var src = doc.providers
  if (!src || typeof src !== "object") return out
  for (var i = 0; i < AGENT_PROVIDERS.length; i++) {
    var p = AGENT_PROVIDERS[i]
    var history = src[p]
    if (!history || history.version !== HISTORY_VERSION) continue
    var cursor = parseAgentCursor(history.agentCursor)
    if (!cursor) continue
    out[p] = parseHistoryDoc(history)
    out[p].agentCursor = cursor
  }
  return out
}

function serializeAgentHistories(histories) {
  var providers = {}
  for (var i = 0; i < AGENT_PROVIDERS.length; i++) {
    var p = AGENT_PROVIDERS[i]
    providers[p] = (histories && histories[p]) ? histories[p] : emptyAgentHistory()
  }
  return JSON.stringify({ version: AGENT_HISTORY_VERSION, providers: providers })
}

// Successful helper output is one transaction: the exact recognized rows and
// their new file positions must either both survive or both be retried. The
// revision matches the cursor sent to this scan, refusing a replay even when
// the batch contains no tokens. Timestamps never decide whether v2 rows are
// new: a delayed file and equal timestamps are legitimate new usage.
function applyAgentScan(history, text) {
  var rejected = { accepted: false, changed: false, taken: 0, newest: 0, status: "error", reason: "invalid-output" }
  if (!history || history.version !== HISTORY_VERSION || typeof text !== "string" ||
      text.length === 0 || !agentUtf8Fits(text, MAX_STATE_BYTES)) return rejected
  var doc
  try { doc = JSON.parse(text) } catch (e) { return rejected }
  if (!agentObject(doc, ["version", "status", "reason", "rows", "cursor"]) || doc.version !== 2 ||
      ["complete", "partial", "error"].indexOf(doc.status) === -1 ||
      AGENT_SCAN_REASONS.indexOf(doc.reason) === -1 || typeof doc.rows !== "string") return rejected
  var cursor = parseAgentCursor(doc.cursor)
  var previous = parseAgentCursor(history.agentCursor)
  if (!cursor || !previous) return rejected
  if (doc.status === "error") {
    if (doc.rows !== "" || !doc.reason || JSON.stringify(cursor) !== JSON.stringify(previous)) return rejected
    rejected.reason = doc.reason
    return rejected
  }
  if ((doc.status === "complete" && doc.reason !== "" && doc.reason !== "source-missing") ||
      (doc.status === "partial" && doc.reason === "") ||
      (cursor.skipped > 0 && (doc.status !== "partial" || doc.reason !== "skipped-records")) ||
      cursor.skipped < previous.skipped) return rejected
  if (cursor.revision !== previous.revision + 1) {
    rejected.reason = "stale-cursor"
    return rejected
  }
  var lines = doc.rows === "" ? [] : doc.rows.split("\n")
  if (lines.length && lines[lines.length - 1] === "") lines.pop()
  if (lines.length > MAX_AGENT_ROWS) return rejected
  var rows = [], ids = Object.create(null), newest = 0
  for (var i = 0; i < lines.length; i++) {
    var f = lines[i].split("|")
    if (f.length !== 7 || !/^[0-9]{1,16}$/.test(f[0]) || !/^[a-f0-9]{64}$/.test(f[1]) || ids[f[1]] ||
        !MODEL_ID_RE.test(f[2]) || modelKey(f[2]) !== f[2]) return rejected
    var when = Number(f[0]), counts = []
    if (!agentInteger(when, 8640000000000000) || when === 0) return rejected
    for (var c = 3; c < 7; c++) {
      if (!/^[0-9]{1,8}$/.test(f[c]) || !agentInteger(Number(f[c]), MAX_TOKENS_PER_SAMPLE)) return rejected
      counts.push(Number(f[c]))
    }
    if (counts[0] + counts[2] > MAX_TOKENS_PER_SAMPLE) return rejected
    ids[f[1]] = true
    rows.push({ when: when, model: f[2], promptTokens: counts[0] + counts[2],
      promptCached: counts[1], predictedTokens: counts[3], predictedSeconds: 0 })
    if (when > newest) newest = when
  }
  // Stage on independent bucket maps. No history or cursor is modified until
  // every row, count and cursor field has passed the checks above.
  var staged = parseHistoryDoc(history), taken = 0
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r]
    if (row.promptTokens === 0 && row.promptCached === 0 && row.predictedTokens === 0) continue
    record(staged, row, new Date(row.when), 1, false, row.model)
    taken++
  }
  staged.importedThrough = Math.max(staged.importedThrough, newest)
  history.minutes = staged.minutes
  history.hours = staged.hours
  history.days = staged.days
  history.importedThrough = staged.importedThrough
  history.covered = staged.covered
  history.agentCursor = cursor
  return { accepted: true, changed: true, taken: taken, newest: newest, status: doc.status, reason: doc.reason }
}

// One row per API reply from the scan script:
//   ts_ms|id|model|input|cache_read|cache_write|output
// input is the uncached prompt; cache_read is prompt served from the
// provider's cache. cache_write is folded into the prompt figure — it is
// billed slightly ABOVE the plain input rate (1.25x at the common providers),
// so the spend estimate errs a few percent low rather than inventing a
// fourth bucket field.
function parseAgentRows(text, notBefore) {
  var raw = String(text === undefined || text === null ? "" : text)
  if (raw.length === 0 || raw.length > MAX_STATE_BYTES) return []

  var lines = raw.split("\n")
  var limit = lines.length < 40000 ? lines.length : 40000
  var floor = isNum(notBefore) ? notBefore : 0
  var out = []

  for (var i = 0; i < limit; i++) {
    var f = lines[i].split("|")
    if (f.length < 7) continue

    var when = parseInt(f[0], 10)
    if (!isNum(when) || when <= floor) continue

    var input = parseInt(f[3], 10)
    var cacheRead = parseInt(f[4], 10)
    var cacheWrite = parseInt(f[5], 10)
    var output = parseInt(f[6], 10)
    if (!isNum(output)) continue

    out.push({
      when: when,
      model: modelKey(f[2]),
      promptTokens: clampNonNeg(input, MAX_TOKENS_PER_SAMPLE) +
                    clampNonNeg(isNum(cacheWrite) ? cacheWrite : 0, MAX_TOKENS_PER_SAMPLE),
      promptCached: clampNonNeg(isNum(cacheRead) ? cacheRead : 0, MAX_TOKENS_PER_SAMPLE),
      predictedTokens: clampNonNeg(output, MAX_TOKENS_PER_SAMPLE),
      predictedSeconds: 0
    })
  }
  return out
}

// Legacy row-import utility; the running widget uses applyAgentScan and its
// persisted file cursor instead. Kept for callers with already ordered rows.
// Fold agent rows in behind a single per-provider watermark. Unlike the local
// import there is no live source racing this one, so the watermark is simply
// the newest row ever recorded: rows at or before it were counted, everything
// after is new. The scan script deduplicates by message id within a scan, and
// the strict > here keeps a row from being counted twice across scans.
//
// The watermark advances only to the newest row actually seen — never to the
// scan instant — so a row that lands on disk after the scan read its file is
// picked up next time rather than skipped.
function applyAgentImport(history, rows) {
  var newest = 0
  var taken = 0
  if (!history) return { newest: newest, taken: taken }
  var floor = clampNonNeg(history.importedThrough, Number.MAX_SAFE_INTEGER)
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    if (row.when <= floor) continue
    if (row.predictedTokens <= 0 && row.promptTokens <= 0 && row.promptCached <= 0) continue
    record(history, row, new Date(row.when), 1, false, row.model)
    taken++
    if (row.when > newest) newest = row.when
  }
  if (newest > floor) history.importedThrough = newest
  return { newest: newest, taken: taken }
}

// Published per-1M rates for the models these agents actually run, matched by
// prefix so a dated or suffixed id still prices. Cached prompt reads are a
// tenth of the input rate at both providers. These are stated assumptions the
// panel labels as estimates — rates move, and this table is where they live.
// (Anthropic and OpenAI list prices as of September 2026.)
var AGENT_PRICES = [
  { prefix: "claude-fable",  input: 10,   output: 50 },
  { prefix: "claude-mythos", input: 10,   output: 50 },
  { prefix: "claude-opus",   input: 5,    output: 25 },
  { prefix: "claude-sonnet-5", input: 2,  output: 10 },
  { prefix: "claude-sonnet", input: 3,    output: 15 },
  { prefix: "claude-haiku",  input: 1,    output: 5 },
  { prefix: "claude",        input: 5,    output: 25 },
  // gpt-oss is the open-weights family Codex runs LOCALLY through its oss
  // provider. It must sort before the gpt catch-all: pricing a local model as
  // cloud spend is exactly the kind of quiet lie this plugin exists to avoid.
  { prefix: "gpt-oss",       input: null, output: null },
  { prefix: "gpt-6",         input: 10,   output: 50 },
  { prefix: "gpt-5.6",       input: 4,    output: 20 },
  { prefix: "gpt-5",         input: 1.25, output: 10 },
  { prefix: "gpt",           input: 4,    output: 20 },
  { prefix: "codex",         input: 4,    output: 20 }
]

function agentPrice(model) {
  var id = String(model === undefined || model === null ? "" : model).toLowerCase()
  for (var i = 0; i < AGENT_PRICES.length; i++) {
    if (id.indexOf(AGENT_PRICES[i].prefix) === 0) {
      if (!isNum(AGENT_PRICES[i].input)) return null
      return { input: AGENT_PRICES[i].input,
               cachedInput: AGENT_PRICES[i].input / 10,
               output: AGENT_PRICES[i].output }
    }
  }
  return null
}

// Estimated spend for one totals bucket, priced per model from the table.
// Tokens whose model has no listed price are counted but not priced, and the
// unpriced generated-token count is reported so the panel can say so instead
// of showing a silently short figure.
function agentSpend(bucket) {
  var spend = 0
  var unpriced = 0
  var src = (bucket && bucket.byModel) || {}
  for (var key in src) {
    var price = agentPrice(key)
    if (!price) { unpriced += src[key].c; continue }
    spend += (src[key].p / 1000000) * price.input
           + (clampNonNeg(src[key].pc, Number.MAX_SAFE_INTEGER) / 1000000) * price.cachedInput
           + (src[key].c / 1000000) * price.output
  }
  return { spend: spend, unpriced: unpriced }
}

// One row per agent session from the scan script, same columns as OpenCode's:
//   id|title|output_tokens|model|directory|updated_ms
// Ids are UUIDs (both tools) and are handed to a launcher, so they are
// pattern-validated, not repaired.
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Sessions are a bounded view of the same validated cursor, with no log
// rereading or cursor advancement. A malformed envelope must not replace a
// previously visible session list with a plausible partial parse.
function parseAgentSessionScan(text, source) {
  var rejected = { accepted: false, sessions: [], status: "error", reason: "invalid-output" }
  if (AGENT_PROVIDERS.indexOf(source) === -1 || typeof text !== "string" ||
      text.length === 0 || !agentUtf8Fits(text, MAX_STATE_BYTES)) return rejected
  var doc
  try { doc = JSON.parse(text) } catch (e) { return rejected }
  if (!agentObject(doc, ["version", "status", "reason", "rows", "cursor"]) || doc.version !== 2 ||
      ["complete", "partial", "error"].indexOf(doc.status) === -1 ||
      AGENT_SCAN_REASONS.indexOf(doc.reason) === -1 || typeof doc.rows !== "string") return rejected
  var cursor = parseAgentCursor(doc.cursor)
  if (!cursor) return rejected
  if (doc.status === "error") {
    if (doc.rows === "" && doc.reason) rejected.reason = doc.reason
    return rejected
  }
  if ((doc.status === "complete" && doc.reason !== "") ||
      (doc.status === "partial" && doc.reason !== "skipped-records") ||
      (cursor.skipped > 0) !== (doc.status === "partial")) return rejected
  var lines = doc.rows === "" ? [] : doc.rows.split("\n")
  if (lines.length && lines[lines.length - 1] === "") lines.pop()
  if (lines.length > MAX_SESSIONS) return rejected
  var sessions = [], ids = Object.create(null)
  for (var i = 0; i < lines.length; i++) {
    var f = lines[i].split("|")
    var id = f.length === 6 ? f[0].toLowerCase() : ""
    if (f.length !== 6 || !UUID_RE.test(id) || ids[id] ||
        !agentText(f[1], 160) || !/^[0-9]{1,16}$/.test(f[2]) ||
        !agentInteger(Number(f[2]), Number.MAX_SAFE_INTEGER) || Number(f[2]) === 0 ||
        !MODEL_ID_RE.test(f[3]) || modelKey(f[3]) !== f[3] || !agentText(f[4], 240) ||
        !/^[0-9]{1,16}$/.test(f[5]) || !agentInteger(Number(f[5]), 8640000000000000)) return rejected
    ids[id] = true
    sessions.push({ id: id, title: cleanTitle(f[1], ""), tokens: Number(f[2]), model: f[3],
      directory: f[4], at: Number(f[5]), source: source })
  }
  return { accepted: true, sessions: sessions, status: doc.status, reason: doc.reason }
}

function parseAgentSessions(text, source) {
  var raw = String(text === undefined || text === null ? "" : text)
  if (raw.length === 0 || raw.length > MAX_STATE_BYTES) return []

  var lines = raw.split("\n")
  var limit = lines.length < 500 ? lines.length : 500
  var out = []

  for (var i = 0; i < limit && out.length < MAX_SESSIONS; i++) {
    var f = lines[i].split("|")
    if (f.length < 6) continue
    if (!UUID_RE.test(f[0])) continue

    var tokens = parseInt(f[2], 10)
    var when = parseInt(f[5], 10)
    if (!isNum(tokens) || tokens <= 0) continue

    out.push({
      id: f[0],
      title: cleanTitle(f[1], ""),
      tokens: clampNonNeg(tokens, Number.MAX_SAFE_INTEGER),
      model: modelKey(f[3]),
      directory: String(f[4] || "").substring(0, 240),
      at: isNum(when) ? when : 0,
      source: source === "codex" ? "codex" : "claude"
    })
  }
  return out
}

// Every source's sessions in one list, newest first, bounded. Each entry
// carries its `source` so the panel can tag it and the launcher can pick the
// right binary.
function mergeSessions(lists) {
  var out = []
  var src = Array.isArray(lists) ? lists : []
  for (var i = 0; i < src.length; i++) {
    var list = Array.isArray(src[i]) ? src[i] : []
    for (var j = 0; j < list.length && out.length < MAX_SESSIONS * 3; j++) out.push(list[j])
  }
  out.sort(function (a, b) { return (b.at || 0) - (a.at || 0) })
  return out.slice(0, MAX_SESSIONS)
}

// Narrow the merged list to one source and/or a search string. The query is a
// plain case-insensitive substring over what the row actually shows — title,
// model, directory and the source label — because a search box that matches
// hidden fields reads as broken. Pure and bounded so the view stays
// declarative: the panel just binds to the result.
function filterSessions(sessions, source, query) {
  var list = Array.isArray(sessions) ? sessions : []
  var src = String(source === undefined || source === null ? "all" : source)
  var q = String(query === undefined || query === null ? "" : query).trim().toLowerCase()
  if (q.length > 80) q = q.substring(0, 80)

  var out = []
  for (var i = 0; i < list.length && out.length < MAX_SESSIONS; i++) {
    var s = list[i]
    if (!s || typeof s !== "object") continue
    var rowSource = String(s.source || "opencode")
    if (src !== "all" && rowSource !== src) continue
    if (q !== "") {
      var hay = (String(s.title || "") + " " + String(s.model || "") + " "
                 + String(s.directory || "") + " " + sourceLabel(s.source)).toLowerCase()
      if (hay.indexOf(q) === -1) continue
    }
    out.push(s)
  }
  return out
}

// The label a session row shows for where it ran.
function sourceLabel(source) {
  switch (String(source || "")) {
    case "claude": return "Claude"
    case "codex":  return "Codex"
    default:       return "OpenCode"
  }
}

// Compact "when", for list rows: a time today, a day and month otherwise.
function shortWhen(ms) {
  if (!isNum(ms) || ms <= 0) return "—"
  var d = new Date(ms)
  var now = new Date()
  var sameDay = d.getFullYear() === now.getFullYear() &&
                d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (sameDay) return pad(d.getHours()) + ":" + pad(d.getMinutes())
  return MONTHS[d.getMonth()] + " " + d.getDate() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes())
}
