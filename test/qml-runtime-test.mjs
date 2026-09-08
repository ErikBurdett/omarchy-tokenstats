// Exercise the QML's actual control-flow functions against process mocks and
// SQLite fixtures. No live shell, agent records, or personal state is touched.
// Run: node test/qml-runtime-test.mjs
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const qml = fs.readFileSync(path.join(repo, "TokenStats.qml"), "utf8")
const modelSource = fs.readFileSync(path.join(repo, "TokenModel.js"), "utf8")

// The tested bodies contain ordinary JS strings/comments. Skip both while
// matching braces, so braces inside SQL text or comments cannot truncate a body.
function blockAt(source, start) {
  assert.equal(source[start], "{")
  let depth = 0, quote = "", comment = ""
  for (let i = start; i < source.length; i++) {
    const c = source[i], next = source[i + 1]
    if (comment === "line") { if (c === "\n") comment = ""; continue }
    if (comment === "block") {
      if (c === "*" && next === "/") { comment = ""; i++ }
      continue
    }
    if (quote) {
      if (c === "\\") { i++; continue }
      if (c === quote) quote = ""
      continue
    }
    if (c === "/" && next === "/") { comment = "line"; i++; continue }
    if (c === "/" && next === "*") { comment = "block"; i++; continue }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue }
    if (c === "{") depth++
    if (c === "}" && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error("Unclosed source block")
}

function functionSource(name) {
  const match = new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{`).exec(qml)
  assert.ok(match, `QML function ${name} exists`)
  return match[0].slice(0, -1) + blockAt(qml, match.index + match[0].length - 1)
}

function handlerSource(processId, handler = "onExited") {
  const id = qml.indexOf(`id: ${processId}\n`)
  assert.ok(id >= 0, `QML Process ${processId} exists`)
  const start = qml.lastIndexOf("Process {", id) + "Process ".length
  const process = blockAt(qml, start)
  const match = new RegExp(`${handler}:\\s*(?:function\\s*(\\([^)]*\\))\\s*)?\\{`).exec(process)
  assert.ok(match, `${processId}.${handler} exists`)
  return `function${match[1] || "()"}` + blockAt(process, match.index + match[0].length - 1)
}

function timer() { return { stop() {}, restart() {} } }
function processMock(pid) {
  let running = false
  return {
    processId: pid, starts: 0, signals: [], command: [],
    get running() { return running },
    set running(value) { if (value && !running) this.starts++; running = value },
    signal(value) { this.signals.push(value); this.onSignal?.(value) },
  }
}

function harness() {
  const model = vm.createContext({})
  vm.runInContext(modelSource, model)
  const clock = { now: 1700000000010 }
  class ClockDate extends Date { static now() { return clock.now } }
  const root = {
    stoppingProcesses: [], destroying: false, historyDirty: false, agentsDirty: false,
    overrides: {}, settings: {},
    history: model.emptyHistory(), importBoundary: 0, importLagMs: 1000,
    maxImportRows: 3, opencodeDb: "/unused/opencode.db", effectiveProviders: ["local"],
    sqliteArgs: ["/usr/bin/sqlite3", "-readonly"],
    saveHistory() {}, saveAgents() {}, forgetSample() {},
  }
  const context = vm.createContext({
    root, Model: model, Date: ClockDate, importOpencode: true, historyLoaded: true,
    settings: root.settings,
  })
  const ids = ["pollProc", "importProc", "sessionsProc", "agentScanProc", "agentSessionsProc", "mkdirProc", "configProc"]
  ids.forEach((id, i) => { context[id] = processMock(100 + i) })
  for (const id of ["pollWatchdog", "importWatchdog", "sessionsWatchdog", "agentScanWatchdog", "agentSessionsWatchdog", "mkdirWatchdog", "configWatchdog", "launchWatchdog", "reapTimer"])
    context[id] = timer()
  context.importOut = { text: "" }
  context.pollOut = { text: "" }
  for (const name of ["setting", "stopProcess", "reapAll", "poll", "pollNextModel", "scanNextAgent", "nextAgentSessions", "importOpencodeHistory", "loadOpencodeConfig", "loadSessions", "loadAgentSessions"]) {
    context[name] = vm.runInContext(`(${functionSource(name)})`, context)
    root[name] = context[name]
  }
  return { root, model, context, clock, ids }
}

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

test("watchdog escalates only its cancelled invocation after the grace period", () => {
  const { root, context, clock } = harness()
  context.pollProc.running = true
  context.importProc.running = true
  root.stopProcess(context.pollProc)
  assert.deepEqual(context.pollProc.signals, [15])
  clock.now += 1999
  root.reapAll()
  assert.deepEqual(context.pollProc.signals, [15])
  clock.now += 1
  root.reapAll()
  assert.deepEqual(context.pollProc.signals, [15, 9])
  assert.deepEqual(context.importProc.signals, [])
  assert.equal(root.stoppingProcesses.length, 0)
})

test("watchdog never kills a new PID that reused the same Process object", () => {
  const { root, context, clock } = harness()
  const process = context.pollProc
  process.running = true
  root.stopProcess(process)
  process.running = false
  process.processId++
  process.running = true
  clock.now += 2000
  root.reapAll()
  assert.deepEqual(process.signals, [15])
  assert.equal(root.stoppingProcesses.length, 0)
})

test("destruction cannot start follow-up polling or queued agent scans", () => {
  const { root, context, ids } = harness()
  root.pendingKind = "metrics"
  root.pendingModel = "first"
  root.sweepQueue = ["second"]
  root.agentScanQueue = ["claude"]
  root.agentSessionQueue = ["codex"]
  root.applyMetrics = () => {}
  root.finishSweep = () => {}
  root.endpoint = "http://127.0.0.1:8080"
  root.curlArgs = ["/usr/bin/curl"]
  root.serverShape = "swap"
  const pollExited = vm.runInContext(`(${handlerSource("pollProc")})`, context)
  for (const id of ids) context[id].running = true
  let exited = false
  context.pollProc.onSignal = () => {
    if (exited) return
    exited = true
    context.pollProc.running = false
    pollExited()
  }
  const marker = "Component.onDestruction: "
  const start = qml.indexOf(marker) + marker.length
  vm.runInContext(`(function() ${blockAt(qml, start)})()`, context)
  root.scanNextAgent()
  root.nextAgentSessions()
  root.poll()
  root.loadOpencodeConfig()
  assert.equal(root.destroying, true)
  for (const id of ids) assert.equal(context[id].starts, 1, `${id} did not restart`)
})

test("hand-edited numeric settings fall back before timer/cost bindings", () => {
  const { root } = harness()
  root.settings.refreshIntervalSec = "garbage"
  root.settings.cloudInputPerMillion = "Infinity"
  root.settings.systemWatts = -500
  assert.equal(root.setting("refreshIntervalSec", 10), 10)
  assert.equal(root.setting("cloudInputPerMillion", 3), 3)
  assert.ok(Number.isFinite(root.setting("systemWatts", 120)))
  root.overrides = { refreshIntervalSec: "NaN" }
  assert.equal(root.setting("refreshIntervalSec", 10), 10)
})

const sqliteFixture = `
import json, sqlite3, sys
fixture=json.load(sys.stdin)
db=sqlite3.connect(':memory:')
db.execute('create table message(data text)')
db.executemany('insert into message(data) values (?)',[(json.dumps(row),) for row in fixture['rows']])
for row in db.execute(fixture['sql']):
    print('|'.join('' if value is None else str(value) for value in row))
`

function executeImport(h, records) {
  h.context.importProc.running = false
  h.root.importOpencodeHistory()
  assert.equal(h.context.importProc.running, true)
  const sql = h.context.importProc.command.at(-1)
  const result = spawnSync("/usr/bin/python3", ["-I", "-S", "-c", sqliteFixture], {
    input: JSON.stringify({ sql, rows: records }), encoding: "utf8",
    timeout: 5000, maxBuffer: 4 * 1024 * 1024,
  })
  assert.equal(result.status, 0, result.stderr || String(result.error || ""))
  h.context.importOut.text = result.stdout
  h.context.importProc.running = false
  const exited = vm.runInContext(`(${handlerSource("importProc")})`, h.context)
  exited(0, 0)
  return result.stdout
}

function reply(when, output = 10) {
  return { role: "assistant", providerID: "local", modelID: "local", time: { completed: when },
    tokens: { input: 1, output, reasoning: 0, cache: { read: 0, write: 0 } } }
}

test("actual import SQL rejects huge fake numeric text at the producer", () => {
  const h = harness()
  const good = reply(h.clock.now - 10)
  const huge = "7".repeat(1024 * 1024 + 1)
  const badInput = reply(h.clock.now - 9); badInput.tokens.input = huge
  const badOutput = reply(h.clock.now - 8); badOutput.tokens.output = huge
  const badTimestamp = reply(huge)
  const badReasoning = reply(h.clock.now - 7); badReasoning.tokens.reasoning = huge
  const output = executeImport(h, [good, badInput, badOutput, badTimestamp, badReasoning])
  assert.ok(output.length < 512, `collector received ${output.length} bytes`)
  assert.ok(!output.includes(huge))
})

test("overflow imports preserve complete timestamp groups and the final boundary", () => {
  const h = harness()
  h.root.importLagMs = 0
  const start = h.clock.now - 10
  const records = [1, 2, 2, 3, 3, 10].map(offset => reply(start + offset))
  for (let i = 0; i < 5 && h.model.coverageFloor(h.root.history) < h.clock.now; i++)
    executeImport(h, records)
  assert.equal(h.model.totals(h.root.history, "all", new Date(h.clock.now)).c, 60)
  assert.equal(h.model.coverageFloor(h.root.history), h.clock.now)
})

test("an oversized tied timestamp pauses without moving the coverage floor", () => {
  const h = harness()
  const when = h.clock.now - 10
  h.root.history.importedThrough = when - 1
  h.root.importLagMs = 0
  executeImport(h, [reply(when), reply(when), reply(when), reply(when)])
  assert.equal(h.model.coverageFloor(h.root.history), when - 1)
  assert.equal(h.model.totals(h.root.history, "all", new Date(h.clock.now)).c, 0)
  assert.match(h.root.importStatus, /paused/)
})

let failures = 0
for (const { name, fn } of tests) {
  try { fn(); console.log(`ok ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`) }
}
assert.equal(failures, 0, `${failures} QML runtime regression(s)`)
console.log(`${tests.length} QML runtime tests passed`)
