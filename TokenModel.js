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

var HISTORY_VERSION = 1

// Retention. Hours drive the 24h graph, days drive everything longer. Both are
// tiny: 72 hourly + 400 daily records is a few tens of KiB of JSON.
var KEEP_HOURS = 72
var KEEP_DAYS = 400

// Guards against a corrupted or hand-edited state file turning into absurd
// totals. A single sample cannot plausibly exceed these.
var MAX_TOKENS_PER_SAMPLE = 10000000
var MAX_SECONDS_PER_SAMPLE = 3600
var MAX_STATE_BYTES = 4194304

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
  return out
}

// llama-swap's /v1/models, reduced to the id that is actually resident.
function parseLoadedModel(jsonText) {
  try {
    var doc = JSON.parse(String(jsonText || ""))
    var list = doc && doc.data
    if (!Array.isArray(list)) return null
    for (var i = 0; i < list.length; i++) {
      var m = list[i]
      var status = m && m.status && m.status.value
      if (status === "loaded" && typeof m.id === "string") return m.id
    }
  } catch (e) {
    return null
  }
  return null
}

// ---------------------------------------------------------------- deltas

// Counters are per llama-server process, so they restart at zero whenever
// llama-swap swaps models. A reading lower than the last one means the process
// was replaced: bank nothing for that step and re-baseline, rather than
// recording a negative or treating the new absolute value as a delta.
function deltaFrom(previous, current) {
  if (!current) return null
  if (!previous || previous.model !== current.model) {
    return { promptTokens: 0, predictedTokens: 0, predictedSeconds: 0, reset: true }
  }
  if (current.predictedTokens < previous.predictedTokens ||
      current.promptTokens < previous.promptTokens) {
    return { promptTokens: 0, predictedTokens: 0, predictedSeconds: 0, reset: true }
  }
  return {
    promptTokens: clampNonNeg(current.promptTokens - previous.promptTokens, MAX_TOKENS_PER_SAMPLE),
    predictedTokens: clampNonNeg(current.predictedTokens - previous.predictedTokens, MAX_TOKENS_PER_SAMPLE),
    predictedSeconds: clampNonNeg(current.predictedSeconds - previous.predictedSeconds, MAX_SECONDS_PER_SAMPLE),
    reset: false
  }
}

// ---------------------------------------------------------------- buckets

function pad(n) { return n < 10 ? "0" + n : String(n) }

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

function emptyBucket() { return { p: 0, c: 0, s: 0, n: 0 } }

function emptyHistory() {
  return { version: HISTORY_VERSION, hours: {}, days: {} }
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
  if (!doc || typeof doc !== "object" || doc.version !== HISTORY_VERSION) return emptyHistory()

  var out = emptyHistory()
  var groups = ["hours", "days"]
  for (var g = 0; g < groups.length; g++) {
    var name = groups[g]
    var src = doc[name]
    if (!src || typeof src !== "object") continue
    var keys = Object.keys(src)
    var limit = keys.length < 2000 ? keys.length : 2000
    for (var i = 0; i < limit; i++) {
      var k = keys[i]
      if (!/^[0-9]{4}-[0-9]{2}(-[0-9]{2})?(T[0-9]{2})?$/.test(k)) continue
      var b = src[k]
      if (!b || typeof b !== "object") continue
      out[name][k] = {
        p: clampNonNeg(b.p, Number.MAX_SAFE_INTEGER),
        c: clampNonNeg(b.c, Number.MAX_SAFE_INTEGER),
        s: clampNonNeg(b.s, Number.MAX_SAFE_INTEGER),
        n: clampNonNeg(b.n, Number.MAX_SAFE_INTEGER)
      }
    }
  }
  return out
}

// Fold one delta into both the hourly and daily bucket for `date`. Writing both
// up front keeps reads trivial: no rollup pass has to run before a query.
function record(history, delta, date, requestDelta) {
  if (!history || !delta) return history
  var groups = [["hours", hourKey(date)], ["days", dayKey(date)]]
  for (var i = 0; i < groups.length; i++) {
    var group = groups[i][0], key = groups[i][1]
    var bucket = history[group][key] || emptyBucket()
    bucket.p += delta.promptTokens
    bucket.c += delta.predictedTokens
    bucket.s += delta.predictedSeconds
    bucket.n += clampNonNeg(requestDelta, 100000)
    history[group][key] = bucket
  }
  return history
}

// Drop buckets past the retention window. Called on load and before each write,
// so the file cannot grow without bound.
function prune(history, now) {
  if (!history) return emptyHistory()
  var hourCut = new Date(now.getTime() - KEEP_HOURS * 3600000)
  var dayCut = new Date(now.getTime() - KEEP_DAYS * 86400000)
  var hk = hourKey(hourCut), dk = dayKey(dayCut)
  var k

  for (k in history.hours) if (k < hk) delete history.hours[k]
  for (k in history.days) if (k < dk) delete history.days[k]
  return history
}

// ---------------------------------------------------------------- queries

function addInto(target, bucket) {
  target.p += bucket.p; target.c += bucket.c
  target.s += bucket.s; target.n += bucket.n
  return target
}

// Totals for a named window. "all" sums the daily buckets, which is every day
// still retained rather than a lifetime figure — the UI says so.
function totals(history, period, now) {
  var sum = emptyBucket()
  if (!history) return sum
  var k

  if (period === "hour") {
    var b = history.hours[hourKey(now)]
    return b ? addInto(sum, b) : sum
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

  if (period === "hour" || period === "day") {
    for (i = 23; i >= 0; i--) {
      d = new Date(now.getTime() - i * 3600000)
      key = hourKey(d)
      b = history && history.hours[key]
      out.push({ label: pad(d.getHours()), tokens: b ? b.c : 0, key: key })
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
      out.push({ label: String(d.getMonth() + 1), tokens: acc, key: mk })
    }
    return out
  }

  for (i = days - 1; i >= 0; i--) {
    d = new Date(now.getTime() - i * 86400000)
    key = dayKey(d)
    b = history && history.days[key]
    out.push({ label: pad(d.getDate()), tokens: b ? b.c : 0, key: key })
  }
  return out
}

// ---------------------------------------------------------------- money

// Every input is a stated assumption rather than a discovered fact, so the UI
// shows the rates alongside the number. Local cost is energy only: the hardware
// is already bought, and charging notional per-GB-hour "memory rent" against
// running a model you own is not a real saving.
function savings(bucket, rates) {
  var r = rates || {}
  var inRate = isNum(r.inputPerMillion) ? r.inputPerMillion : 0
  var outRate = isNum(r.outputPerMillion) ? r.outputPerMillion : 0
  var watts = isNum(r.watts) ? r.watts : 0
  var kwhPrice = isNum(r.pricePerKwh) ? r.pricePerKwh : 0

  var cloud = (bucket.p / 1000000) * inRate + (bucket.c / 1000000) * outRate
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
