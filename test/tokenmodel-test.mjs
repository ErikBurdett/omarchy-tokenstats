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
  coverageFloor, markCovered, coveredFor, reconcileImport, cacheHitPercent,
  parseSettings, applySetting, coerceSetting, isSettingKey, periodSettingLabel,
  settingDefault, SETTING_DEFAULTS, SETTING_SPECS,
  detectServerShape, directModelName, shortModelName, endpointSetting,
  isLoopbackEndpoint, isLoopbackBaseUrl, parseLocalProviders, providerFilterSql,
  ENDPOINT_CANDIDATES,
  emptyAgentHistories, parseAgentHistories, serializeAgentHistories,
  emptyAgentCursor, parseAgentCursor, applyAgentScan, AGENT_HISTORY_VERSION,
  parseAgentRows, applyAgentImport, agentPrice, agentSpend,
  parseAgentSessionScan, parseAgentSessions, mergeSessions, sourceLabel, filterSessions, AGENT_PROVIDERS });`)(M)

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

console.log("machine-agnostic discovery")
// llama.cpp is reachable two ways and they are not the same shape. Assuming
// llama-swap is why this counted nothing on a machine running llama-server
// directly: no entry had status "loaded", so nothing was ever polled.
const SWAP = JSON.stringify({ data: [
  { id: "coder", status: { value: "loaded" } },
  { id: "tiny",  status: { value: "unloaded" } }]})
const DIRECT = JSON.stringify({ data: [{ id: "unsloth/Qwen3-0.6B-GGUF:Q4_K_M" }]})
check("llama-swap shape", M.detectServerShape(SWAP), "swap")
check("direct llama-server shape", M.detectServerShape(DIRECT), "direct")
check("empty list is neither", M.detectServerShape('{"data":[]}'), "none")
check("garbage is neither", M.detectServerShape("{{{"), "none")
check("direct model name is shortened for display",
      M.directModelName(DIRECT), "Qwen3-0.6B-GGUF")
check("direct with no id still names something",
      M.directModelName('{"data":[{}]}'), "llama.cpp")
check("shortModelName strips path and quant", M.shortModelName("a/b/Model-Name:Q4"), "Model-Name")

// Endpoint: "auto"/"" means discover; anything non-loopback is refused.
check("auto means discover", M.endpointSetting("auto"), "")
check("blank means discover", M.endpointSetting(""), "")
check("explicit loopback honoured", M.endpointSetting("http://127.0.0.1:9999"), "http://127.0.0.1:9999")
check("localhost honoured", M.endpointSetting("http://localhost:8080"), "http://localhost:8080")
check("non-loopback refused, falls back to discovery",
      M.endpointSetting("http://evil.example"), "")
check("a path is refused", M.endpointSetting("http://127.0.0.1:8080/x"), "")
check("every discovery candidate is loopback",
      M.ENDPOINT_CANDIDATES.every(M.isLoopbackEndpoint), true)

console.log("local provider detection")
// A message row carries providerID but nothing saying whether it is local, and
// the id is only what the user named it — "local" here, "llamacpp" elsewhere.
// Hardcoding one name is why the importer found nothing on another machine.
const OCCFG = JSON.stringify({ provider: {
  local:     { options: { baseURL: "http://127.0.0.1:8080/v1" } },
  llamacpp:  { options: { baseURL: "http://localhost:9000/v1" } },
  anthropic: { options: { baseURL: "https://api.anthropic.com" } },
  "bad id!": { options: { baseURL: "http://127.0.0.1:1/v1" } }
}})
check("only loopback providers are local",
      M.parseLocalProviders(OCCFG), ["llamacpp", "local"])
check("no config is no providers", M.parseLocalProviders(""), [])
check("garbage config is no providers", M.parseLocalProviders("{{{"), [])
check("a baseURL is a host check, not a whole-string match",
      M.isLoopbackBaseUrl("http://127.0.0.1:8080/v1"), true)
check("a hosted baseURL is not loopback",
      M.isLoopbackBaseUrl("https://api.anthropic.com/v1"), false)

// Provider ids are concatenated into SQL, so they are validated, not quoted
// and hoped for.
check("filter is built from validated ids",
      M.providerFilterSql(["local", "llamacpp"]),
      " and json_extract(data,'$.providerID') in ('local','llamacpp')")
check("no providers means no filter clause", M.providerFilterSql([]), "")
check("an id that could break out of the quoting is dropped",
      M.providerFilterSql(["x'); drop table message;--"]), " and 0")
check("a malformed filter fails closed", M.providerFilterSql("local"), " and 0")
check("provider ids are strings, never implicitly coerced", M.providerFilterSql([123]), " and 0")
check("an invalid filter prefix cannot cause unbounded validation",
      M.providerFilterSql(Array(64).fill("bad'").concat("local")), " and 0")
check("a hostile id does not poison its valid siblings",
      M.providerFilterSql(["local", "x' or '1'='1"]),
      " and json_extract(data,'$.providerID') in ('local')")

console.log("panel-set settings")
// These are written by the Setup pane into a file this plugin owns. shell.json
// is never touched. Every value is re-coerced on the way in and on the way out,
// because a stored file is attacker-controlled in the same threat model as any
// other local state.
check("known key", M.isSettingKey("systemWatts"), true)
check("endpoint is deliberately NOT settable from the panel",
      M.isSettingKey("endpoint"), false)
check("enum value accepted", M.coerceSetting("barPeriod", "7 days"), "7 days")
check("enum value outside the manifest list rejected",
      M.coerceSetting("barPeriod", "Yesterday"), undefined)
check("money accepted", M.coerceSetting("cloudInputPerMillion", "3.50"), "3.50")
check("money that is not a number rejected",
      M.coerceSetting("cloudInputPerMillion", "3; rm -rf /"), undefined)
check("money out of range rejected",
      M.coerceSetting("cloudInputPerMillion", "99999"), undefined)
check("integer clamped to its range", M.coerceSetting("systemWatts", 99999), 2000)
check("currency truncated", M.coerceSetting("currencySymbol", "EUROS"), "EUR")
check("bool", M.coerceSetting("importOpencode", false), false)

check("unknown keys dropped on load",
      M.parseSettings('{"systemWatts":250,"endpoint":"http://elsewhere","nope":1}'),
      { systemWatts: 250 })
check("garbage load is empty, not a throw", M.parseSettings("{{{"), {})
check("oversized load is empty", M.parseSettings("x".repeat(5000000)), {})

let ov = M.applySetting({}, "systemWatts", 300)
check("applySetting stores", ov.systemWatts, 300)
check("applySetting returns a NEW object so bindings notice",
      M.applySetting(ov, "systemWatts", 301) === ov, false)
check("null clears the override back to shell.json",
      M.applySetting(ov, "systemWatts", null).systemWatts, undefined)
check("a key outside the allow-list cannot be introduced",
      M.applySetting({}, "endpoint", "http://elsewhere").endpoint, undefined)
check("an invalid value leaves the override unset",
      M.applySetting({}, "cloudInputPerMillion", "abc").cloudInputPerMillion, undefined)

// The pane stores the manifest's own enum label, so a value set in the panel
// and one set in Setup > Plugins are the same string and round-trip.
check("period label round trip", M.periodKey(M.periodSettingLabel("week")), "week")
check("unknown period falls back", M.periodSettingLabel("nonsense"), "Today")

// The Setup pane falls back to these when neither it nor shell.json has a
// value, while a fresh install gets manifest.json's `defaults`. If the two ever
// disagreed, the pane would show one number and the widget would use another —
// silently, and only for users who had never touched the setting.
const manifest = JSON.parse(fs.readFileSync(path.join(here, "..", "manifest.json"), "utf8"))
const manifestDefaults = manifest.barWidget.defaults
for (const key of Object.keys(M.SETTING_DEFAULTS)) {
  check(`manifest default matches the model for ${key}`,
        String(manifestDefaults[key]), String(M.SETTING_DEFAULTS[key]))
}
// And every settable key must actually exist in the manifest schema, or the
// pane would be writing something Setup > Plugins can never show or clear.
const schemaKeys = manifest.barWidget.schema.map(e => e.key)
for (const key of Object.keys(M.SETTING_SPECS)) {
  check(`manifest schema declares ${key}`, schemaKeys.includes(key), true)
}
// The enum the pane offers must be exactly the enum the manifest declares.
const barPeriodOptions = manifest.barWidget.schema.find(e => e.key === "barPeriod").options
check("barPeriod options match the manifest",
      M.SETTING_SPECS.barPeriod.options, barPeriodOptions)

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

console.log("agent usage rows")
// ts|id|model|input|cache_read|cache_write|output — exact counts from the
// tools' own records, one row per API reply.
const AROWS = [
  "1788757901000|msg_a|claude-fable-5|2|0|39705|820",
  "1788757910000|msg_b|claude-fable-5|2|39705|7025|796",
  "junk",
  "1788757911000|msg_c|claude-fable-5|2|1",
].join("\n")
const arows = M.parseAgentRows(AROWS, 0)
check("valid rows only", arows.length, 2)
check("cache write folds into prompt", arows[0].promptTokens, 2 + 39705)
check("cache read kept apart", arows[1].promptCached, 39705)
check("agent rows carry no seconds", arows[0].predictedSeconds, 0)
check("watermark excludes older", M.parseAgentRows(AROWS, 1788757901000).length, 1)
check("empty input", M.parseAgentRows("", 0), [])

console.log("agent import watermark")
let ah = M.emptyHistory()
const ares = M.applyAgentImport(ah, arows)
check("rows taken", ares.taken, 2)
check("newest returned", ares.newest, 1788757910000)
check("watermark advances to newest row", ah.importedThrough, 1788757910000)
check("imported unmetered", M.totals(ah, "all", new Date(1788757910000)).m, 0)
check("second pass takes nothing", M.applyAgentImport(ah, arows).taken, 0)
check("model attributed",
      M.modelBreakdown(M.totals(ah, "all", new Date(1788757910000)))[0].model, "claude-fable-5")

console.log("agent histories persistence")
let ahs = M.emptyAgentHistories()
check("one history per provider", Object.keys(ahs).sort(), ["claude", "codex"])
M.applyAgentImport(ahs.claude, arows)
const ahsRound = M.parseAgentHistories(M.serializeAgentHistories(ahs))
check("claude survives round trip",
      M.totals(ahsRound.claude, "all", new Date(1788757910000)).c, 820 + 796)
check("watermark survives round trip", ahsRound.claude.importedThrough, 1788757910000)
check("codex untouched stays empty", M.totals(ahsRound.codex, "all", new Date()).c, 0)
check("garbage is empty, not a throw",
      M.totals(M.parseAgentHistories("{{{").claude, "all", new Date()).c, 0)
check("unknown provider dropped",
      M.parseAgentHistories('{"version":4,"providers":{"evil":{"version":4,"days":{}}}}').evil, undefined)

console.log("transactional agent scans")
const clone = value => JSON.parse(JSON.stringify(value))
const sha = n => n.toString(16).padStart(64, "0")
const cursorFile = () => ({
  path: "project/session.jsonl", device: "2049", inode: "12345", offset: 300,
  anchor: sha(10), model: "claude-sonnet-5", totals: null, discarding: false,
  sessionId: "f243b8b5-430b-457f-9258-b7d5dd259814", title: "Fix the parser",
  cwd: "/home/user/project", output: 30, updated: 1788757910000
})
const scanRow = (id, when = 1788757910000, output = 30) =>
  `${when}|${sha(id)}|claude-sonnet-5|2|10|3|${output}`
const scanEnvelope = (revision, rows = "", status = "complete", reason = "") => ({
  version: 2, status, reason, rows,
  cursor: { version: 1, revision, files: [cursorFile()], seen: [sha(1)], skipped: 0 }
})
const scan = (history, doc) => M.applyAgentScan(history, JSON.stringify(doc))
let scanned = M.emptyAgentHistories()
const firstBatch = scanEnvelope(1, scanRow(1))
check("a complete bounded scan commits", scan(scanned.claude, firstBatch).accepted, true)
check("rows and file position commit together",
      [M.totals(scanned.claude, "all", new Date(1788757910000)).c, scanned.claude.agentCursor.files[0].offset], [30, 300])
check("agent imports preserve exact cache split",
      [M.totals(scanned.claude, "all", new Date(1788757910000)).p, M.totals(scanned.claude, "all", new Date(1788757910000)).pc], [5, 10])
const firstSaved = M.serializeAgentHistories(scanned)
check("a duplicate completed batch is rejected", scan(scanned.claude, firstBatch).reason, "stale-cursor")
check("a replay changes neither rows nor cursor", M.serializeAgentHistories(scanned), firstSaved)
scanned = M.parseAgentHistories(firstSaved)
check("restart preserves per-file offset and revision",
      [scanned.claude.agentCursor.files[0].offset, scanned.claude.agentCursor.revision], [300, 1])
check("restart still rejects a previously committed batch", scan(scanned.claude, firstBatch).accepted, false)

const lateBatch = scanEnvelope(2, [scanRow(2, 1788757900000, 7), scanRow(3, 1788757910000, 8)].join("\n"), "partial", "work-limit")
lateBatch.cursor.files[0].offset = 600
lateBatch.cursor.seen = [sha(1), sha(2), sha(3)]
check("partial work commits delayed and equal-timestamp rows", scan(scanned.claude, lateBatch).taken, 2)
check("old timestamp cannot move the display watermark backwards", scanned.claude.importedThrough, 1788757910000)
check("partial work retains all recognized counts", M.totals(scanned.claude, "all", new Date(1788757910000)).c, 45)
check("cursor is retained through QML repaint copy", M.touched(scanned.claude).agentCursor.revision, 2)

const beforeInvalid = M.serializeAgentHistories(scanned)
const malformedBatch = scanEnvelope(3, [scanRow(4), scanRow(5).replace("|10|", "|1e2|")].join("\n"))
check("one malformed row rejects the entire batch", scan(scanned.claude, malformedBatch).accepted, false)
check("valid prefix and cursor do not leak from rejected batch", M.serializeAgentHistories(scanned), beforeInvalid)
check("duplicate row identities are rejected atomically",
      scan(scanned.claude, scanEnvelope(3, [scanRow(4), scanRow(4)].join("\n"))).accepted, false)
check("out-of-order revision is rejected", scan(scanned.claude, scanEnvelope(4, scanRow(4))).reason, "stale-cursor")
check("silent numeric clamping is forbidden for agent counts",
      scan(scanned.claude, scanEnvelope(3, scanRow(4, 1788757910000, 10000001))).accepted, false)
check("fractional token counts are rejected",
      scan(scanned.claude, scanEnvelope(3, scanRow(4, 1788757910000, 1.5))).accepted, false)
check("timestamp outside Date range is rejected",
      scan(scanned.claude, scanEnvelope(3, scanRow(4, 8640000000000001))).accepted, false)
check("row producer bound is independently enforced",
      scan(scanned.claude, scanEnvelope(3, Array.from({ length: 2001 }, (_, i) => scanRow(i + 10)).join("\n"))).accepted, false)
check("unexpected executable-looking envelope fields are rejected",
      scan(scanned.claude, { ...scanEnvelope(3), command: "/bin/sh" }).accepted, false)
check("unknown status text never reaches the panel",
      scan(scanned.claude, scanEnvelope(3, "", "partial", "<b>untrusted</b>")).accepted, false)
const failure = { version: 2, status: "error", reason: "file-changed", rows: "", cursor: clone(scanned.claude.agentCursor) }
check("scanner failure preserves its fixed reason", scan(scanned.claude, failure).reason, "file-changed")
check("an error cannot smuggle token rows", scan(scanned.claude, { ...failure, rows: scanRow(4) }).reason, "invalid-output")
check("all failures leave persisted history unchanged", M.serializeAgentHistories(scanned), beforeInvalid)

const progressOnly = scanEnvelope(3, "", "partial", "pending-record")
check("a batch with no usage still saves progress", scan(scanned.claude, progressOnly).changed, true)
check("progress-only batches cannot replay", scan(scanned.claude, progressOnly).accepted, false)
const skipped = scanEnvelope(4, "", "partial", "skipped-records")
skipped.cursor.skipped = 1
check("an explicit incomplete scan can record skipped input", scan(scanned.claude, skipped).accepted, true)
const hiddenSkip = scanEnvelope(5)
hiddenSkip.cursor.skipped = 1
check("a scan with skipped records cannot claim complete", scan(scanned.claude, hiddenSkip).accepted, false)
check("skipped-record evidence cannot disappear", scan(scanned.claude, scanEnvelope(5)).accepted, false)

console.log("agent cursor corruption")
const validCursor = firstBatch.cursor
check("valid cursor is copied independently", M.parseAgentCursor(validCursor) === validCursor, false)
const cursorCases = [
  ["absolute path", c => { c.files[0].path = "/etc/passwd" }],
  ["parent traversal", c => { c.files[0].path = "project/../secret.jsonl" }],
  ["dot traversal", c => { c.files[0].path = "./session.jsonl" }],
  ["empty path component", c => { c.files[0].path = "project//session.jsonl" }],
  ["duplicate path", c => { c.files.push(clone(c.files[0])) }],
  ["hardlink alias", c => { c.files.push({ ...c.files[0], path: "other/session.jsonl" }) }],
  ["negative offset", c => { c.files[0].offset = -1 }],
  ["unsafe integer", c => { c.files[0].offset = Number.MAX_SAFE_INTEGER + 1 }],
  ["fractional offset", c => { c.files[0].offset = 1.5 }],
  ["absent anchor", c => { c.files[0].anchor = "" }],
  ["nondecimal inode", c => { c.files[0].inode = "1;exec" }],
  ["unbounded title", c => { c.files[0].title = "x".repeat(161) }],
  ["delimiter in title", c => { c.files[0].title = "title|injected" }],
  ["control in cwd", c => { c.files[0].cwd = "/home/u\nrow" }],
  ["invalid session id", c => { c.files[0].sessionId = "--command" }],
  ["model prototype key", c => { c.files[0].model = "__proto__" }],
  ["invalid cumulative vector", c => { c.files[0].totals = [1, 2, 3] }],
  ["negative cumulative total", c => { c.files[0].totals = [1, 2, 3, -1] }],
  ["fake boolean", c => { c.files[0].discarding = "false" }],
  ["extra cursor field", c => { c.command = "sh" }],
  ["extra file field", c => { c.files[0].environment = {} }],
  ["duplicate seen id", c => { c.seen.push(c.seen[0]) }],
  ["invalid seen id", c => { c.seen[0] = "msg_unhashed" }],
  ["too many files", c => { c.files = Array.from({ length: 401 }, (_, i) => ({ ...cursorFile(), path: `p/${i}.jsonl` })) }],
  ["too many seen ids", c => { c.seen = Array.from({ length: 16385 }, (_, i) => sha(i)) }]
]
for (const [name, mutate] of cursorCases) {
  const cursor = clone(validCursor)
  mutate(cursor)
  check(`cursor rejects ${name}`, M.parseAgentCursor(cursor), null)
}
const byteHeavy = clone(validCursor)
byteHeavy.files = Array.from({ length: 400 }, (_, i) => ({ ...cursorFile(), inode: String(i + 100), path: "界".repeat(1000) + i,
  title: "界".repeat(160), cwd: "界".repeat(240) }))
byteHeavy.seen = Array.from({ length: 16384 }, (_, i) => sha(i))
check("cursor byte limit matches the scanner JSON encoding", M.parseAgentCursor(byteHeavy), null)

console.log("agent history migration")
check("agent file format version is independent of local buckets", M.AGENT_HISTORY_VERSION !== M.emptyHistory().version, true)
const newState = JSON.parse(firstSaved)
const oldState = clone(newState)
oldState.version = 4
check("old agent totals are rebuilt after the accounting repair",
      M.totals(M.parseAgentHistories(JSON.stringify(oldState)).claude, "all", new Date(1788757910000)).c, 0)
const retainedLocal = M.parseHistory(JSON.stringify(scanned.claude))
check("local bucket version is preserved during agent migration",
      M.totals(retainedLocal, "all", new Date(1788757910000)).c, 45)
const corruptState = clone(newState)
corruptState.providers.codex = clone(newState.providers.claude)
corruptState.providers.claude.agentCursor.files[0].offset = -1
const repaired = M.parseAgentHistories(JSON.stringify(corruptState))
check("corrupt cursor resets the matching totals and cursor together",
      [M.totals(repaired.claude, "all", new Date(1788757910000)).c, repaired.claude.agentCursor.revision], [0, 0])
check("one corrupt provider does not discard the other", M.totals(repaired.codex, "all", new Date(1788757910000)).c, 30)
delete corruptState.providers.codex.agentCursor
check("missing cursor cannot keep already counted buckets",
      M.totals(M.parseAgentHistories(JSON.stringify(corruptState)).codex, "all", new Date(1788757910000)).c, 0)
const roomyState = M.emptyAgentHistories()
const fullCursor = clone(validCursor)
fullCursor.files = Array.from({ length: 400 }, (_, i) => ({ ...cursorFile(), inode: String(i + 100), path: "x".repeat(1000) + i,
  title: "x".repeat(160), cwd: "x".repeat(240) }))
fullCursor.seen = Array.from({ length: 16384 }, (_, i) => sha(i))
roomyState.claude.agentCursor = fullCursor
const fullBucket = { p: 32, pc: 64, c: 96, s: 0, n: 32, m: 0,
  byModel: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`model-${i}`, { p: 1, pc: 2, c: 3, s: 0, m: 0 }])) }
for (let i = 0; i < 400; i++) {
  const date = new Date(Date.UTC(2026, 0, 1 + i))
  roomyState.claude.days[date.toISOString().slice(0, 10)] = clone(fullBucket)
}
roomyState.codex = clone(roomyState.claude)
const roomySaved = M.serializeAgentHistories(roomyState)
check("two valid cursors and retained history can exceed the local file cap", roomySaved.length > 4194304, true)
const roomyRestored = M.parseAgentHistories(roomySaved)
check("both providers survive a valid combined state larger than 4 MiB",
      [roomyRestored.claude.agentCursor.revision, roomyRestored.codex.agentCursor.revision,
       Object.keys(roomyRestored.claude.days).length, Object.keys(roomyRestored.codex.days).length], [1, 1, 400, 400])
check("oversized combined agent state is still rejected",
      M.parseAgentHistories(" ".repeat(16777217)).claude.agentCursor.revision, 0)

console.log("model object-key defense")
for (const key of ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty", "prototype"])
  check(`reserved model name ${key} rejected`, M.modelKey(key), "")
const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype)
const hostileHistory = M.emptyHistory()
M.record(hostileHistory, { promptTokens: 3, promptCached: 4, predictedTokens: 5, predictedSeconds: 0 },
         new Date(1788757910000), 1, false, "__proto__")
check("recording a hostile model leaves Object.prototype unchanged",
      Object.getOwnPropertyDescriptors(Object.prototype), prototypeBefore)
check("inherited object properties never become model rows",
      M.modelBreakdown(M.totals(hostileHistory, "all", new Date(1788757910000))), [])
check("unsafe loaded-model map keys are refused before QML stores them",
      M.parseLoadedModels(JSON.stringify({ data: ["__proto__", "constructor", "toString", "safe"].map(id => ({ id, status: { value: "loaded" } })) })), ["safe"])
check("hostile scanner model rejects the batch before record",
      scan(M.emptyAgentHistories().claude, scanEnvelope(1, scanRow(1).replace("claude-sonnet-5", "__proto__"))).accepted, false)

console.log("agent pricing")
check("fable priced", M.agentPrice("claude-fable-5"), { input: 10, cachedInput: 1, output: 50 })
check("opus priced", M.agentPrice("claude-opus-5").output, 25)
check("sonnet 5 cheaper than 4.6", M.agentPrice("claude-sonnet-5").input < M.agentPrice("claude-sonnet-4-6").input, true)
check("astra priced", M.agentPrice("gpt-6-astra"), { input: 10, cachedInput: 1, output: 50 })
check("sol priced", M.agentPrice("gpt-5.6-sol").input, 4)
check("unknown model unpriced", M.agentPrice("mystery-9000"), null)
// Codex runs the open-weights gpt-oss family LOCALLY through its oss
// provider; those tokens cost nothing and must not be billed as cloud.
check("gpt-oss is local, never priced as cloud", M.agentPrice("gpt-oss20b"), null)

let sh2 = M.emptyHistory()
M.record(sh2, { promptTokens: 1000000, promptCached: 1000000, predictedTokens: 1000000, predictedSeconds: 0 },
         new Date(2026, 8, 6, 9, 0), 1, false, "claude-opus-5")
M.record(sh2, { promptTokens: 0, promptCached: 0, predictedTokens: 500000, predictedSeconds: 0 },
         new Date(2026, 8, 6, 9, 0), 1, false, "mystery-9000")
const spent = M.agentSpend(M.totals(sh2, "day", new Date(2026, 8, 6, 10, 0)))
check("spend prices input, cached and output", Number(spent.spend.toFixed(2)), 5 + 0.5 + 25)
check("unpriced tokens reported, not silently dropped", spent.unpriced, 500000)

console.log("agent sessions")
const sessionScan = scanEnvelope(1, "F243B8B5-430B-457F-9258-B7D5DD259814|Fix parser|5000|claude-sonnet-5|/home/user/project|1788757910000")
const sessionResult = M.parseAgentSessionScan(JSON.stringify(sessionScan), "claude")
check("session envelope validates and exposes its rows", sessionResult.accepted, true)
check("session UUID normalized for safe launcher validation", sessionResult.sessions[0].id, "f243b8b5-430b-457f-9258-b7d5dd259814")
check("session tokens are parsed exactly", sessionResult.sessions[0].tokens, 5000)
check("session source is caller-selected, never supplied by log", sessionResult.sessions[0].source, "claude")
check("session parsing cannot mutate the caller cursor", sessionScan.cursor.revision, 1)
check("unexpected session provider is rejected", M.parseAgentSessionScan(JSON.stringify(sessionScan), "sh").accepted, false)
check("raw legacy session output is not a successful v2 scan", M.parseAgentSessionScan(sessionScan.rows, "claude").accepted, false)
const brokenSession = clone(sessionScan)
brokenSession.rows += "\nnot-a-session"
check("a valid session prefix cannot mask malformed output", M.parseAgentSessionScan(JSON.stringify(brokenSession), "claude").accepted, false)
brokenSession.rows = sessionScan.rows + "\n" + sessionScan.rows
check("duplicate session identities are rejected", M.parseAgentSessionScan(JSON.stringify(brokenSession), "claude").accepted, false)
brokenSession.rows = sessionScan.rows.replace("|5000|", "|5000oops|")
check("session numbers cannot use parseInt prefix coercion", M.parseAgentSessionScan(JSON.stringify(brokenSession), "claude").accepted, false)
brokenSession.rows = sessionScan.rows.replace("claude-sonnet-5", "constructor")
check("session model cannot reference an inherited object", M.parseAgentSessionScan(JSON.stringify(brokenSession), "claude").accepted, false)
const emptySessions = scanEnvelope(1)
check("empty session view is a valid result", M.parseAgentSessionScan(JSON.stringify(emptySessions), "codex").sessions, [])
const partialSessions = clone(sessionScan)
partialSessions.cursor.skipped = 1
partialSessions.status = "partial"
partialSessions.reason = "skipped-records"
check("incomplete session cache is explicitly marked", M.parseAgentSessionScan(JSON.stringify(partialSessions), "claude").status, "partial")
partialSessions.status = "complete"
partialSessions.reason = ""
check("session cache cannot hide skipped records", M.parseAgentSessionScan(JSON.stringify(partialSessions), "claude").accepted, false)
const unicodeCursor = clone(validCursor)
unicodeCursor.files[0].title = "😀".repeat(80)
check("cursor title limit matches the scanner Unicode convention", M.parseAgentCursor(unicodeCursor).files[0].title, unicodeCursor.files[0].title)
unicodeCursor.files[0].title += "😀"
check("cursor title UTF-16 bound is shared with the scanner", M.parseAgentCursor(unicodeCursor), null)
const tooManySessions = clone(sessionScan)
tooManySessions.rows = Array.from({ length: 101 }, (_, i) => sessionScan.rows.replace("F243B8B5", i.toString(16).padStart(8, "0"))).join("\n")
check("session producer row bound is independently enforced", M.parseAgentSessionScan(JSON.stringify(tooManySessions), "claude").accepted, false)
const ASESS = [
  "f243b8b5-430b-457f-9258-b7d5dd259814|Fix the parser|5000|claude-fable-5|/home/x|1788757901000",
  "not-a-uuid|title|100|m|/d|1",
  "f243b8b5-430b-457f-9258-b7d5dd259815|zero tokens|0|m|/d|1"
].join("\n")
const asess = M.parseAgentSessions(ASESS, "claude")
check("valid agent sessions only", asess.length, 1)
check("source tagged", asess[0].source, "claude")
check("codex source tagged", M.parseAgentSessions(ASESS, "codex")[0].source, "codex")
check("uuid preserved", asess[0].id, "f243b8b5-430b-457f-9258-b7d5dd259814")
check("agent session title shaped", asess[0].title, "Fix the parser")

const merged = M.mergeSessions([
  [{ id: "a", at: 100 }], [{ id: "b", at: 300, source: "codex" }], [{ id: "c", at: 200 }]
])
check("merged newest first", merged.map(s => s.id), ["b", "c", "a"])
check("merge caps the list",
      M.mergeSessions([Array.from({ length: 300 }, (_, i) => ({ id: String(i), at: i }))]).length <= 100, true)
check("source labels", [M.sourceLabel("claude"), M.sourceLabel("codex"), M.sourceLabel(undefined)],
      ["Claude", "Codex", "OpenCode"])

console.log("session filtering")
const FSESS = [
  { id: "a", title: "Fix the parser", model: "claude-fable-5", directory: "/home/x/proj", source: "claude", at: 3 },
  { id: "b", title: "Build a dock", model: "gpt-6-astra", directory: "/home/x/dock", source: "codex", at: 2 },
  { id: "c", title: "Wallpaper pass", model: "qwen3", directory: "/home/x/art", at: 1 }
]
check("no filter keeps everything", M.filterSessions(FSESS, "all", "").length, 3)
check("source filter", M.filterSessions(FSESS, "codex", "").map(s => s.id), ["b"])
check("missing source counts as opencode", M.filterSessions(FSESS, "opencode", "").map(s => s.id), ["c"])
check("query matches title", M.filterSessions(FSESS, "all", "parser").map(s => s.id), ["a"])
check("query is case-insensitive", M.filterSessions(FSESS, "all", "PARSER").map(s => s.id), ["a"])
check("query matches model", M.filterSessions(FSESS, "all", "astra").map(s => s.id), ["b"])
check("query matches directory", M.filterSessions(FSESS, "all", "/art").map(s => s.id), ["c"])
check("query matches the source label", M.filterSessions(FSESS, "all", "opencode").map(s => s.id), ["c"])
check("source and query combine", M.filterSessions(FSESS, "claude", "dock").length, 0)
check("no match is empty", M.filterSessions(FSESS, "all", "zzz"), [])
check("garbage input is empty, not a throw", M.filterSessions("nope", "all", "x"), [])

console.log("")
if (fails) { console.log(`${fails} test(s) failed`); process.exit(1) }
console.log("all tests passed")
