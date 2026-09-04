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

// Bumped to 2 when per-model attribution was added. parseHistory rejects an
// older file outright, which resets the watermark and triggers a full re-import
// from OpenCode — cheap, and it rebuilds the history WITH model attribution
// rather than leaving old buckets permanently unattributed.
var HISTORY_VERSION = 2

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
function emptyBucket() { return { p: 0, c: 0, s: 0, n: 0, m: 0, byModel: {} } }

// Model ids come from llama-swap and from OpenCode's records, so they are
// sanitised before being used as object keys.
function modelKey(name) {
  var raw = String(name === undefined || name === null ? "" : name).trim()
  if (raw.length === 0) return ""
  var cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "")
  return cleaned.substring(0, MAX_MODEL_NAME)
}

function addModel(bucket, model, delta, metered) {
  var key = modelKey(model)
  if (key === "") return
  if (!bucket.byModel) bucket.byModel = {}
  if (!bucket.byModel[key]) {
    if (Object.keys(bucket.byModel).length >= MAX_MODELS_PER_BUCKET) return
    bucket.byModel[key] = { p: 0, c: 0, s: 0, m: 0 }
  }
  var slot = bucket.byModel[key]
  slot.p += delta.promptTokens
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
      c: c,
      s: clampNonNeg(v.s, Number.MAX_SAFE_INTEGER),
      m: v.m === undefined ? c : clampNonNeg(v.m, Number.MAX_SAFE_INTEGER)
    }
  }
  return out
}

function emptyHistory() {
  return { version: HISTORY_VERSION, minutes: {}, hours: {}, days: {}, importedThrough: 0 }
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
  out.importedThrough = clampNonNeg(doc.importedThrough, Number.MAX_SAFE_INTEGER)
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
  return history
}

// ---------------------------------------------------------------- queries

function addInto(target, bucket) {
  target.p += bucket.p; target.c += bucket.c
  target.s += bucket.s; target.n += bucket.n
  target.m += bucket.m === undefined ? bucket.c : bucket.m

  var src = bucket.byModel || {}
  if (!target.byModel) target.byModel = {}
  for (var key in src) {
    if (!target.byModel[key]) target.byModel[key] = { p: 0, c: 0, s: 0, m: 0 }
    var into = target.byModel[key], from = src[key]
    into.p += from.p; into.c += from.c
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
      tokens: src[key].c,
      seconds: src[key].s,
      metered: src[key].m === undefined ? src[key].c : src[key].m,
      share: total > 0 ? (src[key].c / total) * 100 : 0
    })
  }
  out.sort(function (a, b) { return b.tokens - a.tokens })
  return out
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

    out.push({
      when: when,
      model: f.length > 4 ? modelKey(f[4]) : "",
      promptTokens: clampNonNeg(input, MAX_TOKENS_PER_SAMPLE),
      predictedTokens: clampNonNeg(output, MAX_TOKENS_PER_SAMPLE) +
                       clampNonNeg(isNum(reasoning) ? reasoning : 0, MAX_TOKENS_PER_SAMPLE),
      predictedSeconds: 0
    })
  }
  return out
}

// Fold imported rows in, newest timestamp returned so the caller can advance
// its watermark and never import the same reply twice.
function applyImport(history, rows) {
  var newest = 0
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    if (row.predictedTokens <= 0 && row.promptTokens <= 0) continue
    record(history, row, new Date(row.when), 1, false, row.model)
    if (row.when > newest) newest = row.when
  }
  return newest
}

// Return a new top-level object sharing the same bucket maps.
//
// QML will not re-evaluate bindings when a `var` property is assigned the same
// object reference it already holds, so mutating history in place and then
// writing `root.history = root.history` updates nothing. Swapping in a fresh
// identity is cheap — five references — and is what actually notifies.
function touched(history) {
  if (!history) return emptyHistory()
  return {
    version: history.version,
    minutes: history.minutes,
    hours: history.hours,
    days: history.days,
    importedThrough: history.importedThrough
  }
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

  for (var i = 0; i < limit; i++) {
    var f = lines[i].split("|")
    if (f.length < 6) continue
    if (!/^ses_[A-Za-z0-9]{1,64}$/.test(f[0])) continue

    var tokens = parseInt(f[2], 10)
    var when = parseInt(f[5], 10)
    if (!isNum(tokens) || tokens <= 0) continue

    out.push({
      id: f[0],
      title: cleanTitle(f[1]),
      tokens: clampNonNeg(tokens, Number.MAX_SAFE_INTEGER),
      model: modelKey(f[3]),
      directory: String(f[4] || "").substring(0, 240),
      at: isNum(when) ? when : 0
    })
  }
  return out
}

// Session titles are generated by whichever small model is configured, and a
// tiny one tends to emit its own reasoning ("Okay, let's tackle this. The user
// wants..."). Strip that opener and cap the length so the list stays readable.
function cleanTitle(raw) {
  var t = String(raw === undefined || raw === null ? "" : raw).trim()
  t = t.replace(/^(Okay|OK|Alright|Sure|Well|Hmm)[,.!]?\s+/i, "")
  t = t.replace(/^(so\s+)?let'?s\s+(tackle|see|think about)\s+this[.,]?\s*/i, "")
  t = t.replace(/^the user (wants|is asking|asked)( to| for| about)?\s*/i, "")
  t = t.replace(/\s+/g, " ").trim()
  if (t.length === 0) return "(untitled)"
  return t.charAt(0).toUpperCase() + t.substring(1, 72)
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
