// Unit tests for TokenModel.js.  Run: node test/tokenmodel-test.mjs
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, "..", "TokenModel.js"), "utf8")
const M = {}
new Function("exports", src + `;Object.assign(exports,{
  parseMetrics, parseLoadedModels, sameModelSet, deltaFrom, hourKey, dayKey, emptyHistory,
  parseHistory, record, prune, totals, series, savings, formatTokens,
  formatRate, formatMoney, periodLabel, periodKey, parseMeminfo, formatSize,
  minuteKey, touched, tokensPerHour, parseOpencodeRows, applyImport, elapsedHours,
  modelKey, modelBreakdown, axisLabel, pointDetail, rangeLabel, isBoundary,
  parseSessions, cleanTitle, shortWhen,
  coverageFloor, markCovered, coveredFor, reconcileImport, cacheHitPercent });`)(M)

let fails = 0
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) console.log(`  ok  ${name}`)
  else { console.log(`FAIL  ${name}\n        expected ${e}\n        actual   ${a}`); fails++ }
}

const METRICS = [
  "# HELP llamacpp:prompt_tokens_total Number of prompt tokens processed.",
  "# TYPE llamacpp:prompt_tokens_total counter",
  "llamacpp:prompt_tokens_total 1200",
  "llamacpp:tokens_predicted_total 3400",
  "llamacpp:tokens_predicted_seconds_total 70.5",
  "llamacpp:prompt_seconds_total 2.5",
  "llamacpp:requests_processing 0",
  ""
].join("\n")

console.log("parseMetrics")
const m = M.parseMetrics(METRICS)
check("prompt", m.promptTokens, 1200)
check("predicted", m.predictedTokens, 3400)
check("predicted seconds", m.predictedSeconds, 70.5)
check("comments ignored", m.requests_processing, undefined)
check("empty", M.parseMetrics(""), null)
check("null", M.parseMetrics(null), null)
check("garbage", M.parseMetrics("not prometheus"), null)
check("missing required counter", M.parseMetrics("llamacpp:prompt_tokens_total 5"), null)

console.log("parseLoadedModels")
const MODELS = JSON.stringify({ data: [
  { id: "coder", status: { value: "unloaded" } },
  { id: "reason", status: { value: "loaded" } }]})
check("finds loaded", M.parseLoadedModels(MODELS), ["reason"])
// The regression that made this plugin undercount for days: llama-swap keeps
// several models resident and only the first was ever sampled.
check("finds EVERY loaded model", M.parseLoadedModels(JSON.stringify({ data: [
  { id: "coder", status: { value: "loaded" } },
  { id: "fast",  status: { value: "unloaded" } },
  { id: "tiny",  status: { value: "loaded" } }]})), ["coder", "tiny"])
check("none loaded", M.parseLoadedModels('{"data":[{"id":"a","status":{"value":"unloaded"}}]}'), [])
check("bad json", M.parseLoadedModels("{{{"), [])
check("empty", M.parseLoadedModels(""), [])
// An id is interpolated into a URL path, so it is rejected, not repaired.
check("rejects an unsafe id", M.parseLoadedModels(JSON.stringify({ data: [
  { id: "../../etc/passwd", status: { value: "loaded" } },
  { id: "ok", status: { value: "loaded" } }]})), ["ok"])
check("rejects an over-long id", M.parseLoadedModels(JSON.stringify({ data: [
  { id: "x".repeat(41), status: { value: "loaded" } }]})), [])
check("same set", M.sameModelSet(["a", "b"], ["a", "b"]), true)
check("different set", M.sameModelSet(["a"], ["a", "b"]), false)

console.log("deltaFrom")
const prev = { model: "reason", promptTokens: 100, predictedTokens: 200, predictedSeconds: 10 }
const cur  = { model: "reason", promptTokens: 150, predictedTokens: 260, predictedSeconds: 12 }
check("normal delta", M.deltaFrom(prev, cur),
      { promptTokens: 50, promptCached: 0, predictedTokens: 60, predictedSeconds: 2, reset: false })
check("no previous banks nothing", M.deltaFrom(null, cur).predictedTokens, 0)
check("model swap banks nothing",
      M.deltaFrom({ ...prev, model: "coder" }, cur).reset, true)
check("counter reset banks nothing",
      M.deltaFrom(prev, { model: "reason", promptTokens: 5, predictedTokens: 5, predictedSeconds: 0 }).reset, true)
check("no current", M.deltaFrom(prev, null), null)

console.log("history buckets")
const now = new Date(2026, 8, 4, 13, 30)
let h = M.emptyHistory()
M.record(h, { promptTokens: 10, predictedTokens: 90, predictedSeconds: 3 }, now, 1)
M.record(h, { promptTokens: 5, predictedTokens: 45, predictedSeconds: 1.5 }, now, 1)
check("hour bucket accumulates", h.hours[M.hourKey(now)], { p: 15, pc: 0, c: 135, s: 4.5, n: 2, m: 135, byModel: {} })
check("day bucket accumulates", h.days[M.dayKey(now)], { p: 15, pc: 0, c: 135, s: 4.5, n: 2, m: 135, byModel: {} })

const earlier = new Date(2026, 8, 3, 9, 0)
M.record(h, { promptTokens: 1, predictedTokens: 10, predictedSeconds: 1 }, earlier, 1)
check("this hour only", M.totals(h, "hour", now).c, 135)
check("today only", M.totals(h, "day", now).c, 135)
check("week spans days", M.totals(h, "week", now).c, 145)
check("all spans days", M.totals(h, "all", now).c, 145)

console.log("persistence round trip")
const round = M.parseHistory(JSON.stringify(h))
check("survives round trip", round.days[M.dayKey(now)], { p: 15, pc: 0, c: 135, s: 4.5, n: 2, m: 135, byModel: {} })
check("rejects a newer version", M.parseHistory('{"version":99,"days":{}}').days, {})
check("rejects garbage", M.parseHistory("}{").days, {})
check("rejects empty", M.parseHistory("").days, {})
check("rejects oversized", M.parseHistory("x".repeat(5000000)).days, {})
check("drops bogus keys", M.parseHistory('{"version":4,"days":{"../etc":{"p":1,"c":1,"s":1,"n":1}}}').days, {})
check("clamps negatives",
      M.parseHistory('{"version":4,"days":{"2026-09-04":{"p":-5,"c":10,"s":1,"n":1}}}').days["2026-09-04"].p, 0)

console.log("prune")
let old = M.emptyHistory()
M.record(old, { promptTokens: 1, predictedTokens: 1, predictedSeconds: 0 }, new Date(2020, 0, 1, 5), 1)
M.record(old, { promptTokens: 1, predictedTokens: 1, predictedSeconds: 0 }, now, 1)
M.prune(old, now)
check("old day dropped", Object.keys(old.days), [M.dayKey(now)])
check("old hour dropped", Object.keys(old.hours), [M.hourKey(now)])

console.log("series")
const s24 = M.series(h, "day", now)
check("24 hourly slots", s24.length, 24)
check("zeros filled", s24[0].tokens, 0)
check("current hour populated", s24[23].tokens, 135)
check("12 monthly slots", M.series(h, "year", now).length, 12)
check("7 daily slots", M.series(h, "week", now).length, 7)

console.log("savings")
const rates = { inputPerMillion: 3, outputPerMillion: 15, watts: 120, pricePerKwh: 0.12 }
const sv = M.savings({ p: 1000000, c: 1000000, s: 3600 }, rates)
check("cloud cost", Number(sv.cloud.toFixed(4)), 18)
check("energy kwh", Number(sv.energyKwh.toFixed(4)), 0.12)
check("local cost", Number(sv.local.toFixed(4)), 0.0144)
check("net", Number(sv.net.toFixed(4)), 17.9856)
check("zero rates safe", M.savings({ p: 1, c: 1, s: 1 }, {}).net, 0)

console.log("formatting")
check("hundreds", M.formatTokens(999), "999")
check("thousands", M.formatTokens(1500), "1.5k")
check("ten thousands", M.formatTokens(25000), "25k")
check("millions", M.formatTokens(1250000), "1.3M")
check("billions", M.formatTokens(2.5e9), "2.5B")
check("negative", M.formatTokens(-5), "0")
check("rate", M.formatRate(100, 2), "50.0 tok/s")
check("rate div zero", M.formatRate(100, 0), "—")
check("money", M.formatMoney(3.14159, "$"), "$3.14")
check("money big", M.formatMoney(1234.5, "$"), "$1235")
check("money negative", M.formatMoney(-2.5, "$"), "-$2.50")
check("label", M.periodLabel("week"), "7 days")

console.log("metered vs imported")
let mh = M.emptyHistory()
const t0 = new Date(2026, 8, 4, 13, 30)
M.record(mh, { promptTokens: 5, predictedTokens: 50, predictedSeconds: 1 }, t0, 0, true)
M.record(mh, { promptTokens: 5, predictedTokens: 50, predictedSeconds: 0 }, t0, 0, false)
const mb = mh.days[M.dayKey(t0)]
check("all tokens counted", mb.c, 100)
check("only metered tokens carry seconds", mb.m, 50)
check("rate uses metered only", M.formatRate(mb.m, mb.s), "50.0 tok/s")
check("minute bucket written", mh.minutes[M.minuteKey(t0)].c, 100)
check("hour totals read minutes", M.totals(mh, "hour", t0).c, 100)

console.log("per-model attribution")
let pm = M.emptyHistory()
const pt = new Date(2026, 8, 4, 13, 30)
M.record(pm, { promptTokens: 10, predictedTokens: 900, predictedSeconds: 20 }, pt, 0, true, "coder")
M.record(pm, { promptTokens: 5, predictedTokens: 100, predictedSeconds: 0 }, pt, 0, false, "reason")
const bd = M.modelBreakdown(M.totals(pm, "day", pt))
check("sorted biggest first", bd.map(r => r.model), ["coder", "reason"])
check("tokens attributed", bd[0].tokens, 900)
check("share computed", Math.round(bd[0].share), 90)
check("imported model is unmetered", bd[1].metered, 0)
check("metered model keeps seconds", bd[0].seconds, 20)
check("no model is not attributed",
      M.modelBreakdown(M.totals((() => { const h = M.emptyHistory()
        M.record(h, { promptTokens: 1, predictedTokens: 1, predictedSeconds: 0 }, pt, 0, true, "")
        return h })(), "day", pt)).length, 0)

console.log("model key sanitising")
check("plain", M.modelKey("coder"), "coder")
check("path traversal stripped", M.modelKey("../../etc/passwd"), "....etcpasswd")
check("trimmed", M.modelKey("  reason  "), "reason")
check("empty", M.modelKey(""), "")
check("null", M.modelKey(null), "")
check("length capped", M.modelKey("x".repeat(80)).length, 40)

console.log("per-model round trip")
const pmr = M.parseHistory(JSON.stringify(pm))
check("byModel survives", M.modelBreakdown(pmr.days[M.dayKey(pt)])[0].tokens, 900)
check("current version accepted", pmr.version, 4)
check("version 1 rejected", M.parseHistory('{"version":1,"days":{}}').days, {})

console.log("reactivity helper")
// touched() once enumerated fields by hand, so a newly added top-level field
// was dropped on every repaint with no error anywhere. It now carries all of
// them; this test is what keeps that true.
let tk = M.emptyHistory()
M.markCovered(tk, "coder", 1234)
check("touched keeps every top-level field",
      Object.keys(M.touched(tk)).sort(), Object.keys(tk).sort())
check("touched keeps the coverage map", M.touched(tk).covered.coder, 1234)
const orig = M.emptyHistory()
check("touched returns a new identity", M.touched(orig) === orig, false)
check("touched keeps the buckets", M.touched(orig).days === orig.days, true)

console.log("opencode import")
const ROWS = ["1788542714634|312|1|0", "1788542714700|100|500|20", "junk", "1788542714800|1|2"].join("\n")
const parsed = M.parseOpencodeRows(ROWS, 0, Number.MAX_SAFE_INTEGER)
check("valid rows only", parsed.length, 2)
check("reasoning added to generated", parsed[1].predictedTokens, 520)
check("imported rows carry no seconds", parsed[0].predictedSeconds, 0)
check("watermark excludes older", M.parseOpencodeRows(ROWS, 1788542714650, Number.MAX_SAFE_INTEGER).length, 1)
check("boundary excludes newer", M.parseOpencodeRows(ROWS, 0, 1788542714650).length, 1)
check("empty input", M.parseOpencodeRows("", 0, 1), [])
let ih = M.emptyHistory()
const imported = M.applyImport(ih, parsed)
check("newest timestamp returned", imported.newest, 1788542714700)
check("import is unmetered", M.totals(ih, "all", new Date(1788542714700)).m, 0)

console.log("per-model coverage")
// Live sampling covers the models that are resident; OpenCode covers the rest.
// A single global watermark cannot express that, and claiming one is what let
// two days of a busy model go uncounted while a small one was sampled cleanly.
let cv = M.emptyHistory()
check("floor starts at zero", M.coverageFloor(cv), 0)
M.markCovered(cv, "tiny", 5000)
check("unknown model falls back to the floor", M.coveredFor(cv, "coder"), 0)
check("known model uses its own mark", M.coveredFor(cv, "tiny"), 5000)
check("floor is the oldest mark", M.coverageFloor(cv), 0)
M.markCovered(cv, "tiny", 4000)
check("marks never move backwards", M.coveredFor(cv, "tiny"), 5000)
// Coverage marks are keyed exactly as bucket attribution is, via modelKey, so
// a mark and the imported rows it gates can never disagree about a name.
M.markCovered(cv, "../etc", 9000)
check("marks are keyed by the sanitised name", Object.keys(cv.covered).sort(),
      [M.modelKey("../etc"), "tiny"].sort())
check("a sanitised name still gates its own rows", M.coveredFor(cv, "../etc"), 9000)
check("and does not leak onto another name", M.coveredFor(cv, "unseen"), 0)

// A row is admitted against its OWN model's mark.
let cv2 = M.emptyHistory()
M.markCovered(cv2, "tiny", 6000)
const mixed = [
  { when: 5000, model: "tiny",  promptTokens: 1, predictedTokens: 10, predictedSeconds: 0 },
  { when: 5000, model: "coder", promptTokens: 1, predictedTokens: 20, predictedSeconds: 0 },
  { when: 7000, model: "tiny",  promptTokens: 1, predictedTokens: 40, predictedSeconds: 0 }
]
const mixedResult = M.applyImport(cv2, mixed)
check("skips only what live already counted", mixedResult.taken, 2)
check("reports which models it touched", mixedResult.models.sort(), ["coder", "tiny"])
check("totals exclude the double count",
      M.totals(cv2, "all", new Date(7000)).c, 60)

M.reconcileImport(cv2, 9000)
check("reconcile advances every mark", M.coveredFor(cv2, "tiny"), 9000)
check("reconcile advances the floor", M.coverageFloor(cv2), 9000)
check("reconcile covers unknown models too", M.coveredFor(cv2, "brand-new"), 9000)

console.log("prompt cache")
// llamacpp:prompt_tokens_total reports only what was PROCESSED, so a warm KV
// cache collapses the prompt figure. Verified on hardware: an identical repeat
// request reported prompt=13 to the API while the processed counter moved by 1
// and the cached counter by 12. processed + cached is what the API reports, so
// both are carried.
const CACHED = [
  "llamacpp:prompt_tokens_total 100",
  "llamacpp:prompt_tokens_cached_total 900",
  "llamacpp:tokens_predicted_total 50",
  "llamacpp:tokens_predicted_seconds_total 1"
].join("\n")
check("cached counter parsed", M.parseMetrics(CACHED).promptCached, 900)
check("absent cached counter is zero, not a failed parse",
      M.parseMetrics("llamacpp:prompt_tokens_total 1\nllamacpp:tokens_predicted_total 1").promptCached, 0)
check("cached delta", M.deltaFrom(
        { model: "m", promptTokens: 100, promptCached: 900, predictedTokens: 50, predictedSeconds: 1 },
        { model: "m", promptTokens: 120, promptCached: 1500, predictedTokens: 60, predictedSeconds: 2 }
      ).promptCached, 600)
check("a cached-counter regression is a reset", M.deltaFrom(
        { model: "m", promptTokens: 100, promptCached: 900, predictedTokens: 50, predictedSeconds: 1 },
        { model: "m", promptTokens: 100, promptCached: 5, predictedTokens: 50, predictedSeconds: 1 }
      ).reset, true)

let ch = M.emptyHistory()
M.record(ch, { promptTokens: 100, promptCached: 900, predictedTokens: 50, predictedSeconds: 1 },
         new Date(2026, 8, 6, 9, 0), 0, true, "coder")
const cht = M.totals(ch, "day", new Date(2026, 8, 6, 9, 30))
check("processed and cached are kept apart", [cht.p, cht.pc], [100, 900])
check("cache hit percent", Math.round(M.cacheHitPercent(cht)), 90)
check("per-model carries the cached half", M.modelBreakdown(cht)[0].promptCached, 900)

// Savings must price the cached prompt, not drop it.
const cacheSv = M.savings(cht, { inputPerMillion: 3, cachedInputPerMillion: 0.3,
                                 outputPerMillion: 15, watts: 0, pricePerKwh: 0 })
check("cached prompt is priced", Number(cacheSv.cloud.toFixed(9)),
      Number((100/1e6*3 + 900/1e6*0.3 + 50/1e6*15).toFixed(9)))
check("cached rate defaults to a tenth of input",
      Number(M.savings(cht, { inputPerMillion: 3, outputPerMillion: 15 }).cloud.toFixed(9)),
      Number((100/1e6*3 + 900/1e6*0.3 + 50/1e6*15).toFixed(9)))

// OpenCode splits the prompt the same way: tokens.input is processed only.
const crow = M.parseOpencodeRows("1788542714634|20|5|0|coder|880", 0, Number.MAX_SAFE_INTEGER)[0]
check("import reads cache.read + cache.write", crow.promptCached, 880)
check("import without a cache column is zero",
      M.parseOpencodeRows("1788542714634|20|5|0|coder", 0, Number.MAX_SAFE_INTEGER)[0].promptCached, 0)

console.log("tokens per hour")
let rh = M.emptyHistory()
M.record(rh, { promptTokens: 0, predictedTokens: 3600, predictedSeconds: 10 }, new Date(2026, 8, 4, 12, 0), 0, true)
check("week window is fully elapsed", M.elapsedHours("week", new Date(2026, 8, 4, 13, 0)), 168)
check("day window uses elapsed", Math.round(M.elapsedHours("day", new Date(2026, 8, 4, 6, 0))), 6)
check("rate over 7 days", Math.round(M.tokensPerHour(rh, "week", new Date(2026, 8, 4, 13, 0))), 21)
check("no data is zero", M.tokensPerHour(M.emptyHistory(), "day", new Date()), 0)

console.log("settings vocabulary")
check("today", M.periodKey("Today"), "day")
check("case insensitive", M.periodKey("7 DAYS"), "week")
check("all recorded", M.periodKey("All recorded"), "all")
check("unknown falls back", M.periodKey("nonsense"), "day")
check("null falls back", M.periodKey(null), "day")

console.log("meminfo")
const MEM = "MemTotal:       131000324 kB\nMemFree:  100 kB\nMemAvailable:   116591236 kB\n"
check("total", M.parseMeminfo(MEM).total, 131000324)
check("available", M.parseMeminfo(MEM).available, 116591236)
check("clamped to total", M.parseMeminfo("MemTotal: 100 kB\nMemAvailable: 999 kB").available, 100)
check("no total", M.parseMeminfo("MemAvailable: 5 kB"), null)
check("garbage", M.parseMeminfo("nope"), null)
check("oversized", M.parseMeminfo("x".repeat(70000)), null)
check("size GiB", M.formatSize(2097152), "2.0 GiB")
check("size MiB", M.formatSize(51200), "50 MiB")
check("size invalid", M.formatSize(-1), "—")

console.log("graph labels")
const gnow = new Date(2026, 8, 4, 13, 30)
const dayPts = M.series(M.emptyHistory(), "day", gnow)
check("hour axis carries a colon", M.axisLabel(dayPts[0]), "14:00")
check("hour slots span a day", dayPts.length, 24)
check("range names both ends", M.rangeLabel(dayPts), "Sep 3 14:30 - Sep 4 13:30")
check("midnight is a boundary", M.isBoundary({ at: new Date(2026, 8, 4, 0, 0).getTime(), slot: "hour" }), true)
check("noon is not", M.isBoundary({ at: new Date(2026, 8, 4, 12, 0).getTime(), slot: "hour" }), false)
check("hour detail names the day", M.pointDetail({ at: new Date(2026, 8, 4, 3, 0).getTime(), slot: "hour", tokens: 64000 }),
      "Fri 4 Sep, 03:00-03:59  ·  64k tokens")
check("day detail", M.pointDetail({ at: new Date(2026, 8, 4).getTime(), slot: "day", tokens: 1200 }),
      "Fri 4 Sep 2026  ·  1.2k tokens")
check("month axis", M.axisLabel({ at: new Date(2026, 8, 1).getTime(), slot: "month" }), "Sep")
check("week range", M.rangeLabel(M.series(M.emptyHistory(), "week", gnow)), "Aug 29 - Sep 4")
check("empty series", M.rangeLabel([]), "")

console.log("sessions")
const SROWS = [
  "ses_abc123|Okay, let's tackle this. The user wants a graph|5000|coder|/home/x|1788542714700",
  "ses_def456|Plain title|10|reason|/home/y|1788542714800",
  "notasession|x|5|m|/d|1",
  "ses_zero|no tokens|0|m|/d|1"
].join("\n")
const sess = M.parseSessions(SROWS)
check("valid sessions only", sess.length, 2)
check("id preserved", sess[0].id, "ses_abc123")
check("title from stored when no opening", sess[0].title, "A graph")
check("tokens parsed", sess[0].tokens, 5000)
check("zero-token sessions dropped", sess.filter(x => x.id === "ses_zero").length, 0)
check("bad id rejected", sess.filter(x => x.id === "notasession").length, 0)
check("empty input", M.parseSessions(""), [])

console.log("title derivation")
check("opening message wins over stored title",
      M.cleanTitle("Add a graph to the widget", "Okay, the user wants something"), "Add a graph to the widget")
check("falls back to stored title",
      M.cleanTitle("", "Okay, the user wants a widget"), "A widget")
check("strips let us tackle", M.cleanTitle("", "Alright, let's tackle this. Build a plugin"), "Build a plugin")
check("strips a polite request opener", M.cleanTitle("Please add a sessions pane", ""), "Add a sessions pane")
check("unwraps quotes", M.cleanTitle('"List every skill"', ""), "List every skill")
check("takes the first sentence when short enough",
      M.cleanTitle("Fix the parser. Then add tests and update the docs too.", ""), "Fix the parser")
check("strips markdown", M.cleanTitle("Update `TokenModel.js` **now**", ""), "Update TokenModel.js now")
check("first line only", M.cleanTitle("Add a pane\nand then do more", ""), "Add a pane")
check("truncates on a word boundary",
      M.cleanTitle("Build an omarchy theme using the omarchy-plugin-ship skills available here", ""),
      "Build an omarchy theme using the omarchy-plugin-ship\u2026")
check("empty becomes untitled", M.cleanTitle("   ", "  "), "(untitled)")
check("null safe", M.cleanTitle(null, null), "(untitled)")
check("length capped", M.cleanTitle("y".repeat(200), "").length <= 60, true)

console.log("")
if (fails) { console.log(`${fails} test(s) failed`); process.exit(1) }
console.log("all tests passed")
