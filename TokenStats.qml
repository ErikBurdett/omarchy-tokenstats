// Delegates below reference ids from this component (root, content).
// Bound makes that lookup explicit and checkable rather than relying on
// dynamic scope, which is what qmllint's "unqualified access" flags.
pragma ComponentBehavior: Bound

import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "TokenModel.js" as Model

// Token counter for the bar, and the host for the stats panel.
//
// The bar shows one number: tokens generated. Everything else — rate, memory,
// savings, the graph and the history — lives behind hover and click, because a
// bar widget that grows a paragraph of numbers stops being glanceable.
//
// Local counters are polled; agent logs advance through bounded read batches.
// The scanner runs as one isolated Python process with no child processes.
BarWidget {
  id: root
  moduleName: "io.github.erikburdett.tokenstats"

  // ---- Settings.
  //
  // Two layers. shell.json (Setup > Plugins) is the base, and the panel's own
  // Setup pane writes OVERRIDES to a state file this plugin owns. The plugin
  // never writes shell.json — that is the user's bar layout, and rewriting user
  // configuration from a widget is exactly what the marketplace checklist asks
  // about. Omarchy's own weather panel persists to a state file the same way.
  //
  // Both layers are clamped or allow-listed below: each is a file editable by
  // anything running as the user, so nothing reaches a Timer, a formatter or a
  // price unchecked.
  property var overrides: ({})

  // Shadows BarWidget.setting(). Reading `root.overrides` here is what makes
  // every binding below depend on it, so a change in the Setup pane repaints
  // the bar immediately instead of waiting for a restart.
  function setting(name, fallback) {
    var over = root.overrides
    var value = over && over[name] !== undefined && over[name] !== null
              ? over[name] : settings ? settings[name] : undefined
    if (value === undefined || value === null) return fallback
    if (Model.isSettingKey(name)) {
      var checked = Model.coerceSetting(name, value)
      return checked === undefined ? fallback : checked
    }
    return value
  }

  // Called from the Setup pane. `value === null` clears the override and lets
  // shell.json decide again. Model.applySetting re-coerces against its
  // allow-list, so a wrong key or a wrong type cannot get in from here either.
  function setOverride(key, value) {
    root.overrides = Model.applySetting(root.overrides, key, value)
    overridesFile.setText(JSON.stringify(root.overrides))
  }

  function resetOverrides() {
    root.overrides = ({})
    overridesFile.setText("{}")
  }

  readonly property string overridesPath: stateDir + "/settings.json"
  readonly property int refreshSec: Math.min(Math.max(Math.round(setting("refreshIntervalSec", 10)), 2), 120)
  readonly property string barPeriod: {
    var allowed = ["hour", "day", "week", "month", "year", "all"]
    var chosen = Model.periodKey(setting("barPeriod", "Today"))
    return allowed.indexOf(chosen) === -1 ? "day" : chosen
  }
  readonly property real inputPerMillion: Math.min(Math.max(Number(setting("cloudInputPerMillion", 3.0)), 0), 1000)
  readonly property real outputPerMillion: Math.min(Math.max(Number(setting("cloudOutputPerMillion", 15.0)), 0), 1000)
  // Cached prompt tokens are billed at a reduced rate by hosted providers, not
  // given away, so they are priced rather than dropped. Default is a tenth of
  // the input rate.
  readonly property real cachedInputPerMillion: Math.min(Math.max(Number(setting("cloudCachedInputPerMillion", 0.30)), 0), 1000)
  readonly property real watts: Math.min(Math.max(Number(setting("systemWatts", 120)), 0), 2000)
  readonly property real pricePerKwh: Math.min(Math.max(Number(setting("pricePerKwh", 0.12)), 0), 10)
  readonly property string currencySymbol: String(setting("currencySymbol", "$")).substring(0, 3)
  readonly property bool importOpencode: setting("importOpencode", true) === true
  readonly property bool importClaude: setting("importClaude", true) === true
  readonly property bool importCodex: setting("importCodex", true) === true

  // XDG, not a hardcoded ~/.local. A machine that sets XDG_DATA_HOME or
  // XDG_CONFIG_HOME keeps OpenCode somewhere else entirely, and assuming
  // otherwise is one more way for this to silently find nothing.
  readonly property string xdgData: Quickshell.env("XDG_DATA_HOME") !== ""
                                    ? Quickshell.env("XDG_DATA_HOME")
                                    : Quickshell.env("HOME") + "/.local/share"
  readonly property string xdgConfig: Quickshell.env("XDG_CONFIG_HOME") !== ""
                                      ? Quickshell.env("XDG_CONFIG_HOME")
                                      : Quickshell.env("HOME") + "/.config"
  readonly property string opencodeDb: xdgData + "/opencode/opencode.db"
  readonly property string opencodeConfig: xdgConfig + "/opencode/opencode.json"

  // The scan script ships beside this file, so its path is resolved from the
  // QML file's own location rather than a hardcoded install path — the plugin
  // works from wherever it was actually installed.
  readonly property string scanScript: {
    var url = Qt.resolvedUrl("scripts/scan-agents.py").toString()
    return url.indexOf("file://") === 0 ? decodeURIComponent(url.substring(7)) : url
  }

  readonly property string configScript: {
    var url = Qt.resolvedUrl("scripts/read-config.py").toString()
    return url.indexOf("file://") === 0 ? decodeURIComponent(url.substring(7)) : url
  }

  // Provider ids that opencode.json says point at loopback — i.e. the ones
  // actually running on this machine. Empty until the config is read.
  property var localProviders: []
  // Last resort. "local" is only a convention, but it is a common one and a
  // better guess than importing every provider, which would count hosted API
  // usage as if it had run here.
  readonly property var effectiveProviders: localProviders.length > 0 ? localProviders : ["local"]

  // An explicit endpoint, or "" meaning "find it". Only a loopback endpoint is
  // ever accepted: this value is fetched by curl, so neither a shell.json edit
  // nor discovery may point it at another host.
  readonly property string endpointOverride: Model.endpointSetting(setting("endpoint", "auto"))
  // Discovered by probing the candidate ports one per tick until one answers.
  property string activeEndpoint: ""
  property string probing: ""
  property int probeIndex: 0
  readonly property string endpoint: endpointOverride !== "" ? endpointOverride : activeEndpoint

  // "swap"   - llama-swap: per-model status, counters at /upstream/<id>/metrics
  // "direct" - llama-server on its own: counters at /metrics
  property string serverShape: "none"
  property string directModel: ""

  readonly property var rates: ({
    inputPerMillion: root.inputPerMillion,
    cachedInputPerMillion: root.cachedInputPerMillion,
    outputPerMillion: root.outputPerMillion,
    watts: root.watts,
    pricePerKwh: root.pricePerKwh
  })

  // ---- State
  property var history: Model.emptyHistory()
  // Last counter reading per model. Counters belong to a llama-server process,
  // not to llama-swap, so every resident model needs its own baseline.
  property var samples: ({})
  // Every model llama-swap currently has resident, sorted. llama-swap keeps
  // several alive at once — a small one for titles beside the one doing the
  // work — so this is a set, not a single id.
  property var residentModels: []
  readonly property string loadedModel: residentModels.join(", ")
  property var memInfo: null
  property bool historyLoaded: false
  // True once llama.cpp's counters have answered at least once. They are off by
  // default, so a fresh install starts false and runs on OpenCode's records
  // instead — the plugin is useful before anything is configured.
  property bool metricsAvailable: false
  property bool opencodeSeen: false
  property bool historyDirty: false
  property bool destroying: false
  property string importStatus: ""
  // Which request is in flight, so the reply is parsed as what we asked for.
  property string pendingKind: ""
  property string pendingModel: ""

  // ---- Sweep bookkeeping. A sweep is one pass over every resident model.
  //      Only a sweep that read all of them without a counter reset may claim
  //      coverage, and it claims it only as far back as the instant it began.
  property var sweepQueue: []
  property real sweepStart: 0
  property bool sweepClean: true
  // How many models answered with parseable counters this sweep. Metrics can be
  // turned off again — llama-swap restarted without --metrics, say — and a
  // sweep where models were resident and not one answered means the counters
  // are gone. Without this the widget would sit on a stale "counting live"
  // claim forever while quietly counting nothing.
  property int sweepMetricsOk: 0

  readonly property var periodTotals: Model.totals(history, barPeriod, new Date())
  readonly property real perHour: Model.tokensPerHour(history, barPeriod, new Date())
  readonly property string label: "TS: " + Model.formatTokens(perHour) + " tokens/hour"
  // Left and right bars are narrow, so the caption and the unit go.
  readonly property string shortLabel: Model.formatTokens(perHour)

  readonly property string stateDir: Quickshell.env("HOME") + "/.local/state/omarchy/tokenstats"
  readonly property string statePath: stateDir + "/history.json"

  // ---- How every subprocess is invoked.
  //
  // `curl` and `sqlite3` are given a CLEARED environment. That is not tidiness:
  //
  //   * curl honours http_proxy / https_proxy / ALL_PROXY and ~/.curlrc. This
  //     plugin's stated boundary is that it only ever talks to loopback, and
  //     validating the endpoint string does not deliver that on its own — an
  //     exported ALL_PROXY sends the same URL to an arbitrary host. Verified:
  //     with a proxy variable set and no --noproxy, curl connects to the proxy.
  //     `--noproxy '*'` and `-q` close both, and an empty environment means
  //     there is nothing left to honour.
  //   * sqlite3 reads $XDG_CONFIG_HOME/sqlite3/sqliterc, else ~/.sqliterc, and
  //     executes the meta-commands in it before our query. `-noinit` refuses
  //     that file, `-safe` refuses everything that could write or attach, and
  //     `-readonly` opens the database read-only regardless.
  //
  // Output is bounded at the PRODUCER, not after collection: StdioCollector
  // buffers the whole stream before any of this code runs, so a length check
  // here would not be a cap. curl is given --max-filesize (both endpoints send
  // Content-Length, so an oversized body is refused before the transfer starts)
  // and --max-time; every sqlite3 query bounds both its row count and the
  // length of each text column it selects.
  readonly property var curlArgs: ["/usr/bin/curl", "-qfsS",
                                   "--noproxy", "*",
                                   "--max-time", "4",
                                   "--max-filesize", "262144"]
  readonly property var sqliteArgs: ["/usr/bin/sqlite3",
                                     "-readonly", "-safe", "-noinit", "-batch",
                                     "-noheader", "-separator", "|"]
  // Nothing these two need is worth the surface of inheriting it.
  readonly property var emptyEnv: ({})

  // Row caps, applied as SQL LIMIT so the bound is the producer's. 20000 replies
  // is more history than the 400-day retention can display; 60 sessions is what
  // the pane shows.
  readonly property int maxImportRows: 20000
  readonly property int maxSessionRows: 60

  // Every reader is a single process without descendants. The scanner also
  // creates a private session, so its PID is its only process-group member.
  // Escalate only the invocation we cancelled, never an unrelated/new reader.
  property var stoppingProcesses: []
  function stopProcess(proc) {
    if (!proc || !proc.running) return
    var stops = root.stoppingProcesses.slice()
    stops.push({ proc: proc, pid: proc.processId, deadline: Date.now() + 2000 })
    root.stoppingProcesses = stops
    proc.signal(15)
  }

  function reapAll() {
    var pending = []
    for (var i = 0; i < root.stoppingProcesses.length; i++) {
      var stop = root.stoppingProcesses[i]
      if (!stop.proc.running || stop.proc.processId !== stop.pid) continue
      if (Date.now() < stop.deadline) { pending.push(stop); continue }
      stop.proc.signal(9)
    }
    root.stoppingProcesses = pending
  }

  Timer {
    id: reapTimer
    interval: 100
    running: root.stoppingProcesses.length > 0
    repeat: true
    onTriggered: root.reapAll()
  }

  // ---------------------------------------------------------------- polling

  // One sweep per refresh: ask llama-swap which models are resident, then read
  // each one's counters, chained through onExited so the whole set is sampled
  // in a single burst. That keeps the covered window tight enough for the
  // watermark below to mean something.
  //
  // The previous design polled a single model and only re-asked for the model
  // list when that model stopped answering. llama-swap keeps a small model
  // resident indefinitely, so the widget latched onto it and every token
  // generated by every other model went uncounted, silently, for days.
  function poll() {
    if (root.destroying || pollProc.running) return
    root.sweepStart = Date.now()
    root.sweepClean = true
    root.sweepMetricsOk = 0
    // With no endpoint yet, each tick tries the next candidate. Discovery costs
    // exactly one loopback request per tick and stops as soon as something
    // answers with a shape we recognise.
    var target = root.endpoint
    if (target === "") {
      var list = Model.ENDPOINT_CANDIDATES
      target = list[root.probeIndex % list.length]
      root.probing = target
    } else {
      root.probing = ""
    }
    root.pendingKind = "models"
    root.pendingModel = ""
    pollProc.command = root.curlArgs.concat([target + "/v1/models"])
    pollWatchdog.restart()
    pollProc.running = true
  }

  function pollNextModel() {
    if (root.destroying) return
    if (root.sweepQueue.length === 0) { root.finishSweep(); return }
    var queue = root.sweepQueue.slice()
    var model = queue.shift()
    root.sweepQueue = queue
    root.pendingKind = "metrics"
    root.pendingModel = model
    // Direct llama-server keeps its counters at a fixed /metrics; only the
    // llama-swap shape puts a model id in the path, and that id came from
    // parseLoadedModels, which validates it against /^[A-Za-z0-9._-]{1,40}$/
    // before it can be interpolated here.
    var url = root.serverShape === "direct"
              ? root.endpoint + "/metrics"
              : root.endpoint + "/upstream/" + model + "/metrics"
    pollProc.command = root.curlArgs.concat([url])
    pollWatchdog.restart()
    pollProc.running = true
  }

  // Only a clean sweep may advance the watermark, and only per model. A model
  // whose counters reset — llama-swap replaced its llama-server — keeps its old
  // mark, which is what lets the OpenCode importer fill exactly that gap and
  // nothing else.
  function finishSweep() {
    root.pendingKind = ""
    root.pendingModel = ""
    // Checked before the historyLoaded guard below: whether the counters are
    // answering is a fact about llama-swap, not about our state file, and the
    // source line on screen must not go stale waiting for one.
    if (root.residentModels.length > 0 && root.sweepMetricsOk === 0)
      root.metricsAvailable = false
    if (!root.historyLoaded) return
    if (root.sweepClean && root.residentModels.length > 0) {
      for (var i = 0; i < root.residentModels.length; i++)
        Model.markCovered(root.history, root.residentModels[i], root.sweepStart)
      root.historyDirty = true
    }
  }

  function applyMetrics(text, model) {
    var parsed = Model.parseMetrics(text)
    if (!parsed) {
      // The upstream is gone or metrics are off for it. Drop the baseline so a
      // later reading is not diffed against a stale one, and do not let this
      // sweep claim coverage it does not have.
      root.sweepClean = false
      root.forgetSample(model)
      return
    }
    parsed.model = model
    root.metricsAvailable = true
    root.sweepMetricsOk += 1

    var delta = Model.deltaFrom(root.samples[model] || null, parsed)
    var next = root.samples
    next[model] = parsed
    root.samples = next

    if (!delta || delta.reset) {
      // A reset means tokens were generated between the last sample and the
      // process restart that no counter can still report. Leave the mark where
      // it is so OpenCode's exact records can cover the window instead.
      root.sweepClean = false
      return
    }
    if (delta.predictedTokens <= 0 && delta.promptTokens <= 0) return

    Model.record(root.history, delta, new Date(), 0, true, model)
    // A fresh top-level identity, because assigning the same object reference
    // back would not notify anything and the label would sit at its old value.
    root.history = Model.touched(root.history)
    historyDirty = true
  }

  function forgetSample(model) {
    if (root.samples[model] === undefined) return
    var next = root.samples
    delete next[model]
    root.samples = next
  }

  function refresh() {
    poll()
    meminfoFile.reload()
  }

  Component.onCompleted: {
    // A fresh install has no state directory, and FileView will not create one,
    // so the first write would fail silently and history would never persist.
    mkdirProc.running = true
    loadOpencodeConfig()
    overridesFile.reload()
    historyFile.reload()
    agentsFile.reload()
    refresh()
  }

  // 0700, because the history file records what you ran a local model for and
  // when. `install -d` rather than `mkdir -p -m` on purpose: -m applies only to
  // directories mkdir creates, so an install that predates this would keep its
  // 0755 forever. `install -d` sets the mode on an existing directory too, and
  // is idempotent either way. Verified on this machine: 755 before, 700 after.
  Process {
    id: mkdirProc
    running: false
    clearEnvironment: true
    environment: root.emptyEnv
    command: ["/usr/bin/install", "-d", "-m", "700", root.stateDir]
    onRunningChanged: if (running) mkdirWatchdog.restart()
    onExited: function(exitCode, exitStatus) {
      mkdirWatchdog.stop()
      if (exitCode === 0 && !root.destroying) {
        if (root.historyDirty) root.saveHistory()
        if (root.agentsDirty) root.saveAgents()
      }
    }
  }

  Timer {
    id: mkdirWatchdog
    interval: 5000
    onTriggered: root.stopProcess(mkdirProc)
  }

  Process {
    id: pollProc
    running: false
    // Absolute path, fixed argv, and a cleared environment — see curlArgs.
    clearEnvironment: true
    environment: root.emptyEnv
    stdout: StdioCollector { id: pollOut; waitForEnd: true }
    onExited: {
      pollWatchdog.stop()
      var text = pollOut.text
      // Take the kind and clear it BEFORE acting. The models branch starts the
      // next request from inside this handler, and that request sets its own
      // pendingKind — clearing afterwards would wipe the state the in-flight
      // reply needs and silently discard every metrics sample.
      var kind = root.pendingKind
      var model = root.pendingModel
      root.pendingKind = ""
      root.pendingModel = ""

      if (kind === "metrics") {
        root.applyMetrics(text, model)
        root.pollNextModel()
      } else if (kind === "models") {
        var shape = Model.detectServerShape(text)
        if (shape === "none") {
          // Nothing usable here. If we were probing, move on to the next
          // candidate; if this was our established endpoint, it has gone away
          // and we start looking again rather than polling a dead port forever.
          if (root.probing !== "") root.probeIndex += 1
          else root.activeEndpoint = ""
          root.probing = ""
          root.serverShape = "none"
          for (var g = 0; g < root.residentModels.length; g++) root.forgetSample(root.residentModels[g])
          root.residentModels = []
          root.sweepClean = false
          root.finishSweep()
          return
        }
        // Something answered: adopt it.
        if (root.probing !== "") { root.activeEndpoint = root.probing; root.probing = "" }
        root.serverShape = shape

        var found
        if (shape === "direct") {
          root.directModel = Model.directModelName(text)
          found = root.directModel === "" ? [] : [root.directModel]
        } else {
          found = Model.parseLoadedModels(text)
        }
        // A model leaving takes its baseline with it: the next llama-server for
        // that id starts its counters at zero.
        for (var i = 0; i < root.residentModels.length; i++)
          if (found.indexOf(root.residentModels[i]) === -1) root.forgetSample(root.residentModels[i])
        // A model arriving or leaving mid-sweep means this sweep cannot vouch
        // for the whole interval.
        if (!Model.sameModelSet(found, root.residentModels)) root.sweepClean = false
        root.residentModels = found
        root.sweepQueue = found.slice()
        root.pollNextModel()
      } else {
        root.sweepQueue = []
      }
    }
  }

  // A curl that never returns would wedge polling permanently, since a Process
  // that is already running cannot be re-run.
  Timer {
    id: pollWatchdog
    interval: 8000
    onTriggered: {
      root.stopProcess(pollProc)
      // An abandoned request leaves a hole in the sweep, so the sweep must not
      // go on to claim the interval it failed to read.
      root.sweepClean = false
      root.sweepQueue = []
      root.pendingKind = ""
      root.pendingModel = ""
    }
  }

  // Poll hard while someone is looking at the panel and back off when they are
  // not. A counter read is one loopback GET, so 2s costs nothing while open,
  // and closing the panel returns to the configured interval.
  Timer {
    interval: root.opened ? Math.min(root.refreshSec, 2) * 1000 : root.refreshSec * 1000
    running: true
    repeat: true
    onTriggered: root.refresh()
  }

  // Teardown. `running = false` on its own is not a guarantee of a reaped
  // process, so each reader is sent TERM and then KILL; they fork no children,
  // so that is the whole tree. launchProc is deliberately NOT killed — see the
  // comment where it is defined.
  Component.onDestruction: {
    root.destroying = true
    pollWatchdog.stop()
    importWatchdog.stop()
    sessionsWatchdog.stop()
    agentScanWatchdog.stop()
    agentSessionsWatchdog.stop()
    launchWatchdog.stop()
    mkdirWatchdog.stop()
    configWatchdog.stop()
    reapTimer.stop()
    // No grace period here: the component is going away and there will be no
    // timer left to escalate from, so TERM and KILL are sent together rather
    // than leaving a reader behind.
    var procs = [pollProc, importProc, sessionsProc, agentScanProc, agentSessionsProc, mkdirProc, configProc]
    for (var i = 0; i < procs.length; i++) {
      if (!procs[i].running) continue
      procs[i].signal(15)
      procs[i].signal(9)
      procs[i].running = false
    }
    if (root.historyDirty) root.saveHistory()
    if (root.agentsDirty) root.saveAgents()
  }

  // ---------------------------------------------------------------- memory

  // Read straight from procfs rather than llama-swap's /metrics, which reports
  // only used/free and no MemAvailable — the figure that actually answers "how
  // much can I still use", since page cache holding GGUF files is reclaimable.
  FileView {
    id: meminfoFile
    path: "/proc/meminfo"
    printErrors: false
    onLoaded: root.memInfo = Model.parseMeminfo(text())
    onLoadFailed: root.memInfo = null
  }

  // ---------------------------------------------------------------- history

  FileView {
    id: historyFile
    path: root.statePath
    printErrors: false
    // Quickshell writes through a temporary file and renames, so a crash or a
    // full disk cannot leave a half-written state file behind.
    atomicWrites: true
    onLoaded: {
      root.history = Model.prune(Model.parseHistory(text()), new Date())
      root.historyLoaded = true
      root.importOpencodeHistory()
    }
    onLoadFailed: {
      // No file yet on first run, which is not an error.
      root.history = Model.emptyHistory()
      root.historyLoaded = true
      root.importOpencodeHistory()
    }
  }

  // watchChanges so every bar surface — one per monitor — picks up a change made
  // in any one of their panels, rather than the others sitting stale until a
  // restart. atomicWrites for the same reason history.json uses it.
  // Another application's config must never be loaded wholesale by FileView.
  // The helper validates the descriptor and caps bytes before reading JSON.
  function loadOpencodeConfig() {
    if (root.destroying || configProc.running) return
    configProc.running = true
    configWatchdog.restart()
  }

  Process {
    id: configProc
    clearEnvironment: true
    environment: root.emptyEnv
    command: ["/usr/bin/python3", "-I", "-S", root.configScript, root.opencodeConfig]
    stdout: StdioCollector { id: configOut; waitForEnd: true }
    onExited: function(exitCode, exitStatus) {
      configWatchdog.stop()
      root.localProviders = exitCode === 0 ? Model.parseLocalProviders(configOut.text) : []
    }
  }

  Timer {
    id: configWatchdog
    interval: 5000
    onTriggered: root.stopProcess(configProc)
  }

  Timer {
    interval: 30000
    running: root.importOpencode
    repeat: true
    onTriggered: root.loadOpencodeConfig()
  }

  FileView {
    id: overridesFile
    path: root.overridesPath
    printErrors: false
    atomicWrites: true
    watchChanges: true
    onFileChanged: reload()
    onLoaded: root.overrides = Model.parseSettings(text())
    onLoadFailed: root.overrides = ({})
  }

  function saveHistory() {
    if (!historyLoaded) return
    Model.prune(root.history, new Date())
    historyFile.setText(JSON.stringify(root.history))
    historyDirty = false
  }

  // Batched rather than written on every sample: the file is a convenience, not
  // a ledger, and one write a minute is enough to survive a restart.
  Timer {
    interval: 60000
    running: true
    repeat: true
    onTriggered: {
      if (root.historyDirty) root.saveHistory()
      if (root.agentsDirty) root.saveAgents()
    }
  }

  // ---------------------------------------------------------------- import

  // OpenCode records exact per-reply token counts from the provider's usage
  // block, so it can fill in everything generated before this widget existed or
  // while the shell was not running. Only rows strictly between the watermark
  // and the moment live sampling resumed are taken, so nothing is counted twice.
  //
  // Tokens only: the message wall clock includes tool calls and waiting, which
  // reads as 2 tok/s against a benchmarked 46, so imported rows are recorded
  // unmetered and do not move the displayed rate.
  property real importBoundary: 0

  // How far behind live coverage must fall before the importer steps in.
  readonly property int importLagMs: root.metricsAvailable
                                     ? Math.max(60000, root.refreshSec * 4000)
                                     : 1000

  function importOpencodeHistory() {
    if (root.destroying || !importOpencode || !historyLoaded || importProc.running) return
    // Run whenever ANY model is behind, not only when live counters are absent.
    // The two sources are no longer mutually exclusive: live sampling covers
    // resident models, OpenCode covers everything else, and applyImport admits
    // a row only when that model's own mark does not already account for it.
    //
    // The lag keeps the two from racing. Live coverage is always one sweep
    // stale, so without it the importer would fork sqlite3 every 30s to import
    // the last few seconds of rows that live sampling was about to account for
    // anyway — correct, but it costs the measured generation seconds, which
    // only live sampling can produce. With counters unavailable there is
    // nothing to race and the importer runs as often as its timer fires.
    var floor = Model.coverageFloor(root.history)
    if (floor >= Date.now() - root.importLagMs) return

    var since = Math.round(Number(floor) || 0)
    if (!isFinite(since) || since < 0) since = 0
    root.importBoundary = Date.now()

    // `since` is a number this code produced from its own state and rounded, so
    // there is no string from anywhere else in this statement. Row count is
    // capped by LIMIT and the one text column by substr, so the output size is
    // bounded before sqlite3 writes a byte of it.
    importProc.command = root.sqliteArgs.concat([
      "file:" + root.opencodeDb + "?mode=ro",
      "select cast(json_extract(data,'$.time.completed') as integer)," +
      " cast(json_extract(data,'$.tokens.input') as integer)," +
      " cast(json_extract(data,'$.tokens.output') as integer)," +
      " cast(json_extract(data,'$.tokens.reasoning') as integer)," +
      " substr(replace(replace(coalesce(json_extract(data,'$.modelID'),''),'|',' '),char(10),' '),1,64)," +
      " cast(coalesce(json_extract(data,'$.tokens.cache.read'),0) as integer)" +
      "   + cast(coalesce(json_extract(data,'$.tokens.cache.write'),0) as integer)" +
      " from message" +
      " where json_extract(data,'$.role')='assistant'" +
      " and json_type(data,'$.time.completed')='integer'" +
      " and json_type(data,'$.tokens.input')='integer'" +
      " and json_type(data,'$.tokens.output')='integer'" +
      // Which providers count as local is read from opencode.json, not assumed.
      // providerFilterSql re-validates every id against /^[A-Za-z0-9._-]{1,64}$/
      // before it is concatenated, so nothing here can carry a quote.
      Model.providerFilterSql(root.effectiveProviders) +
      "   and json_extract(data,'$.time.completed') > " + since +
      "   and json_extract(data,'$.time.completed') <= " + root.importBoundary +
      " order by 1 limit " + (root.maxImportRows + 1) + ";"
    ])
    importWatchdog.restart()
    importProc.running = true
  }

  Process {
    id: importProc
    running: false
    clearEnvironment: true
    environment: root.emptyEnv
    stdout: StdioCollector { id: importOut; waitForEnd: true }
    // The exit code is a signal PARAMETER, not a property on Process. Reading
    // it as a property yields undefined and every failed sqlite3 run would be
    // treated as an empty-but-successful import.
    onExited: function(exitCode, exitStatus) {
      importWatchdog.stop()
      // A failed query returns no rows, which is indistinguishable from a
      // genuinely empty result — and reconciling on it would advance every mark
      // past a window nothing had actually read.
      if (exitCode !== 0) return
      // One extra row detects SQL truncation. Commit only complete timestamp
      // groups; the next query picks up the entire tied group at the boundary.
      var lines = importOut.text.trim().split("\n")
      var boundary = root.importBoundary
      if (lines.length > root.maxImportRows) {
        boundary = Number(lines[root.maxImportRows].split("|")[0]) - 1
        if (!isFinite(boundary) || boundary <= Model.coverageFloor(root.history)) {
          root.importStatus = "OpenCode import paused: too many replies share one timestamp."
          return
        }
      }
      root.importStatus = ""
      var rows = Model.parseOpencodeRows(importOut.text,
                                         Model.coverageFloor(root.history),
                                         boundary + 1)
      if (rows.length > 0) root.opencodeSeen = true
      var result = Model.applyImport(root.history, rows)
      // Any model these rows covered must lose its live baseline, or the next
      // counter delta would span the same window and bank it twice.
      for (var i = 0; i < result.models.length; i++) root.forgetSample(result.models[i])
      Model.reconcileImport(root.history, boundary)
      root.history = Model.touched(root.history)
      root.historyDirty = true
      root.saveHistory()
    }
  }

  Timer {
    id: importWatchdog
    interval: 15000
    onTriggered: root.stopProcess(importProc)
  }

  // Always running. Without llama.cpp's counters this is the only source, and
  // it is an exact one — OpenCode stores the provider's own usage block. With
  // them it is the repair path: it fills the windows live sampling provably did
  // not cover, and its guard above makes it a no-op the rest of the time.
  Timer {
    interval: root.opened ? 5000 : 30000
    running: true
    repeat: true
    onTriggered: root.importOpencodeHistory()
  }

  // ---------------------------------------------------------------- sessions

  // OpenCode's own session records. Read on demand rather than on a timer:
  // nothing needs them until the pane is open.
  property var sessions: []

  function loadSessions() {
    if (root.destroying || !importOpencode || sessionsProc.running) return
    // Every text column is truncated in SQL. A title or a working directory is
    // written by whatever ran opencode and can be arbitrarily long; capping it
    // after StdioCollector has already buffered it would not be a cap at all.
    sessionsProc.command = root.sqliteArgs.concat([
      "file:" + root.opencodeDb + "?mode=ro",
      "select substr(id,1,80)," +
      " substr(replace(replace(coalesce(title,''),'|',' '),char(10),' '),1,200)," +
      " coalesce(tokens_output,0) + coalesce(tokens_reasoning,0)," +
      " substr(coalesce(json_extract(model,'$.id'),''),1,64)," +
      " substr(replace(replace(coalesce(directory,''),'|',' '),char(10),' '),1,400)," +
      " cast(coalesce(time_updated,0) as integer)," +
      // The opening user message describes the session far better than a title
      // generated by a small model, so it is fetched as a preferred source.
      " (select replace(replace(substr(json_extract(p.data,'$.text'),1,160),'|',' '),char(10),' ')" +
      "  from part p join message m on p.message_id = m.id" +
      "  where m.session_id = session.id" +
      "    and json_extract(m.data,'$.role')='user'" +
      "    and json_extract(p.data,'$.type')='text'" +
      "  order by m.time_created, p.time_created limit 1)" +
      " from session" +
      " where coalesce(tokens_output,0) > 0" +
      " order by time_updated desc limit " + root.maxSessionRows + ";"
    ])
    sessionsWatchdog.restart()
    sessionsProc.running = true
  }

  Process {
    id: sessionsProc
    running: false
    clearEnvironment: true
    environment: root.emptyEnv
    stdout: StdioCollector { id: sessionsOut; waitForEnd: true }
    onExited: {
      sessionsWatchdog.stop()
      root.sessions = Model.parseSessions(sessionsOut.text)
    }
  }

  Timer {
    id: sessionsWatchdog
    interval: 10000
    onTriggered: root.stopProcess(sessionsProc)
  }

  // ---------------------------------------------------------------- agents

  // Claude Code and Codex tracked beside the local counts, never mixed into
  // them: the savings figure prices tokens that did NOT go to a hosted API,
  // and tokens you actually paid for must not inflate it. Both tools write
  // the API's own exact usage to disk — Claude Code per assistant message
  // under ~/.claude/projects, Codex per turn in its rollout files — and
  // scripts/scan-agents.py reads bounded batches behind per-file cursors.
  // Counters and cursors are committed together; an incomplete backlog resumes
  // on the next pass without a timestamp watermark dropping older records.
  property var agentHistories: Model.emptyAgentHistories()
  property bool agentsLoaded: false
  property bool agentsDirty: false
  property var agentScanQueue: []
  property string agentScanning: ""
  property var agentScanStates: ({ claude: "pending", codex: "pending" })

  function setAgentScanState(provider, state) {
    if (provider !== "claude" && provider !== "codex") return
    var next = { claude: root.agentScanStates.claude, codex: root.agentScanStates.codex }
    next[provider] = state
    root.agentScanStates = next
  }

  readonly property string agentStatusLine: {
    var lines = []
    var providers = Model.AGENT_PROVIDERS
    for (var i = 0; i < providers.length; i++) {
      var p = providers[i]
      if (!root.agentEnabled(p)) continue
      var state = root.agentScanStates[p]
      var name = Model.sourceLabel(p)
      if (state === "complete") lines.push(name + ": up to date")
      else if (state === "pending") lines.push(name + ": waiting for records")
      else if (state === "partial") lines.push(name + ": importing history in bounded batches")
      else if (state === "skipped-records") lines.push(name + ": some log records could not be read; totals are incomplete, scanning continues")
      else lines.push(name + ": scan paused (" + state + "); existing totals retained")
    }
    if (root.importStatus !== "") lines.push(root.importStatus)
    return lines.join(". ")
  }

  readonly property string agentsPath: stateDir + "/agents.json"

  FileView {
    id: agentsFile
    path: root.agentsPath
    printErrors: false
    atomicWrites: true
    onLoaded: {
      root.agentHistories = Model.parseAgentHistories(text())
      root.agentsLoaded = true
      root.scanAgents()
    }
    onLoadFailed: {
      // First run: no file yet. The first scan back-fills everything both
      // tools ever recorded, bounded by the scanner's own row caps.
      root.agentHistories = Model.emptyAgentHistories()
      root.agentsLoaded = true
      root.scanAgents()
    }
  }

  function saveAgents() {
    if (!agentsLoaded) return
    var now = new Date()
    for (var i = 0; i < Model.AGENT_PROVIDERS.length; i++)
      Model.prune(root.agentHistories[Model.AGENT_PROVIDERS[i]], now)
    agentsFile.setText(Model.serializeAgentHistories(root.agentHistories))
    root.agentsDirty = false
  }

  function agentEnabled(provider) {
    return provider === "claude" ? root.importClaude
         : provider === "codex" ? root.importCodex : false
  }

  function scanAgents() {
    if (root.destroying || !agentsLoaded || agentScanProc.running) return
    var queue = []
    for (var i = 0; i < Model.AGENT_PROVIDERS.length; i++) {
      var p = Model.AGENT_PROVIDERS[i]
      if (agentEnabled(p)) queue.push(p)
    }
    root.agentScanQueue = queue
    scanNextAgent()
  }

  function scanNextAgent() {
    if (root.destroying) return
    if (root.agentScanQueue.length === 0) { root.agentScanning = ""; return }
    var queue = root.agentScanQueue.slice()
    var provider = queue.shift()
    root.agentScanQueue = queue
    root.agentScanning = provider
    agentScanProc.stdinEnabled = true
    agentScanProc.command = ["/usr/bin/python3", "-I", "-S", root.scanScript,
                             provider + "-usage", Quickshell.env("HOME")]
    agentScanWatchdog.restart()
    agentScanProc.running = true
  }

  Process {
    id: agentScanProc
    running: false
    clearEnvironment: true
    environment: root.emptyEnv
    stdout: StdioCollector { id: agentScanOut; waitForEnd: true }
    onStarted: {
      var history = root.agentHistories[root.agentScanning]
      agentScanProc.write(JSON.stringify(history.agentCursor || Model.emptyAgentCursor()) + "\n")
      agentScanProc.stdinEnabled = false
    }
    onExited: function(exitCode, exitStatus) {
      agentScanWatchdog.stop()
      var provider = root.agentScanning
      root.agentScanning = ""
      if (provider !== "" && root.agentHistories[provider]) {
        var result = exitCode === 0 || exitCode === 3
          ? Model.applyAgentScan(root.agentHistories[provider], agentScanOut.text)
          : { accepted: false, reason: "reader-failed" }
        var limited = ["file-limit", "entry-limit", "depth-limit", "cursor-limit"].indexOf(result.reason) !== -1
        root.setAgentScanState(provider, result.accepted
          ? (result.reason === "skipped-records" || limited ? result.reason : result.status)
          : (result.reason || "invalid-batch"))
        if (result.accepted && result.changed) {
          // A fresh outer identity, or no binding on agentHistories notices.
          var next = {}
          for (var k in root.agentHistories) next[k] = root.agentHistories[k]
          next[provider] = Model.touched(root.agentHistories[provider])
          root.agentHistories = next
          root.agentsDirty = true
          root.saveAgents()
        }
      }
      root.scanNextAgent()
    }
  }

  // The helper's own wall/CPU deadline is shorter. TERM then KILL targets the
  // sole member of its private process group; Qt reaps the tracked process.
  Timer {
    id: agentScanWatchdog
    interval: 12000
    onTriggered: {
      root.stopProcess(agentScanProc)
      root.setAgentScanState(root.agentScanning, "timed-out")
      root.agentScanQueue = []
      root.agentScanning = ""
    }
  }

  // Catch up steadily while a backlog remains; idle files resume at EOF.
  Timer {
    interval: root.agentScanStates.claude === "partial" || root.agentScanStates.codex === "partial"
              || root.agentScanStates.claude === "skipped-records" || root.agentScanStates.codex === "skipped-records"
              ? 15000 : root.opened ? 15000 : 120000
    running: root.importClaude || root.importCodex
    repeat: true
    onTriggered: root.scanAgents()
  }

  // ---- Agent session lists, read on demand when the pane opens, exactly
  //      like OpenCode's.
  property var claudeSessions: []
  property var codexSessions: []
  property var agentSessionQueue: []
  property string agentSessionKind: ""

  // Every source's sessions in one list, newest first. This is what the
  // panel shows.
  readonly property var allSessions: Model.mergeSessions([
    root.sessions, root.claudeSessions, root.codexSessions])

  function loadAgentSessions() {
    if (root.destroying || agentSessionsProc.running) return
    var queue = []
    if (root.importClaude) queue.push("claude")
    if (root.importCodex) queue.push("codex")
    root.agentSessionQueue = queue
    nextAgentSessions()
  }

  function nextAgentSessions() {
    if (root.destroying) return
    if (root.agentSessionQueue.length === 0) { root.agentSessionKind = ""; return }
    var queue = root.agentSessionQueue.slice()
    var provider = queue.shift()
    root.agentSessionQueue = queue
    root.agentSessionKind = provider
    agentSessionsProc.stdinEnabled = true
    agentSessionsProc.command = ["/usr/bin/python3", "-I", "-S", root.scanScript, provider + "-sessions",
                                 Quickshell.env("HOME")]
    agentSessionsWatchdog.restart()
    agentSessionsProc.running = true
  }

  Process {
    id: agentSessionsProc
    running: false
    clearEnvironment: true
    environment: root.emptyEnv
    stdout: StdioCollector { id: agentSessionsOut; waitForEnd: true }
    onStarted: {
      var history = root.agentHistories[root.agentSessionKind]
      agentSessionsProc.write(JSON.stringify(history.agentCursor || Model.emptyAgentCursor()) + "\n")
      agentSessionsProc.stdinEnabled = false
    }
    onExited: function(exitCode, exitStatus) {
      agentSessionsWatchdog.stop()
      var provider = root.agentSessionKind
      root.agentSessionKind = ""
      if (exitCode === 0) {
        var result = Model.parseAgentSessionScan(agentSessionsOut.text, provider)
        if (result.accepted && provider === "claude") root.claudeSessions = result.sessions
        else if (result.accepted && provider === "codex") root.codexSessions = result.sessions
      }
      root.nextAgentSessions()
    }
  }

  Timer {
    id: agentSessionsWatchdog
    interval: 15000
    onTriggered: {
      root.stopProcess(agentSessionsProc)
      root.agentSessionQueue = []
      root.agentSessionKind = ""
    }
  }

  // Resume any session in a terminal, routed by where it ran. Ids are
  // pattern-validated per source before they go anywhere near an argv; the
  // launcher itself is the same allow-listed-environment Process the
  // OpenCode path uses.
  readonly property var agentUuidRe: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

  function openAgentSession(source, id, directory) {
    var kind = String(source || "")
    if (kind === "" || kind === "opencode") { openSession(id, directory); return }
    if (kind !== "claude" && kind !== "codex") return
    if (!agentUuidRe.test(String(id))) return
    if (launchProc.running) return
    var dir = String(directory || "")
    if (dir.charAt(0) !== "/" || dir.length > 4096) dir = Quickshell.env("HOME")
    // The mise shim, like OpenCode's: stable across the tools' own upgrades.
    var shims = Quickshell.env("HOME") + "/.local/share/mise/shims/"
    launchProc.workingDirectory = dir
    launchProc.command = kind === "claude"
      ? ["/usr/bin/omarchy-launch-tui", "--app-id=org.omarchy.agent",
         shims + "claude", "--resume", String(id)]
      : ["/usr/bin/omarchy-launch-tui", "--app-id=org.omarchy.agent",
         shims + "codex", "resume", String(id)]
    launchProc.running = true
    root.close()
  }

  // The launcher is the one subprocess that needs a session to talk to, so it
  // cannot run with an empty environment. It gets an explicit ALLOW-LIST built
  // from named variables rather than the inherited environment, and a fixed
  // PATH: /usr/bin/omarchy-launch-tui itself resolves setsid, uwsm-app and
  // xdg-terminal-exec through PATH, so leaving PATH inherited would be the one
  // place a user-writable directory could select what actually runs.
  //
  // Verified: the launcher starts a terminal with exactly these variables set
  // and nothing else.
  readonly property var launchEnv: {
    var wanted = ["HOME", "USER", "XDG_RUNTIME_DIR", "WAYLAND_DISPLAY",
                  "HYPRLAND_INSTANCE_SIGNATURE", "DBUS_SESSION_BUS_ADDRESS",
                  "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "LANG"]
    var env = { "PATH": "/usr/local/bin:/usr/bin" }
    for (var i = 0; i < wanted.length; i++) {
      var v = Quickshell.env(wanted[i])
      if (typeof v === "string" && v.length > 0 && v.length < 4096) env[wanted[i]] = v
    }
    return env
  }

  // Resume a session in a terminal. No shell: the id is pattern-validated, the
  // directory becomes the process working directory rather than part of a
  // command string, and every executable is an absolute path.
  //
  // The opencode path is under $HOME and so is user-writable. That is not a
  // privilege boundary here — this widget already runs with the user's full
  // privileges and the target is the user's own interpreter shim, which is the
  // thing they asked to launch. Nothing in this plugin is ever privileged, so
  // there is no authorization for a swapped pathname to be spent against. The
  // mise SHIM is used rather than a versioned install path because the shim is
  // stable across opencode upgrades.
  function openSession(id, directory) {
    if (!/^ses_[A-Za-z0-9]{1,64}$/.test(String(id))) return
    if (launchProc.running) return
    // Untrusted: `directory` comes out of OpenCode's database. It is a process
    // property rather than command text, so it cannot inject an argument, but
    // an absolute path is still the only thing that makes sense to chdir into.
    var dir = String(directory || "")
    if (dir.charAt(0) !== "/" || dir.length > 4096) dir = Quickshell.env("HOME")
    launchProc.workingDirectory = dir
    launchProc.command = ["/usr/bin/omarchy-launch-tui", "--app-id=org.omarchy.agent",
                          Quickshell.env("HOME") + "/.local/share/mise/shims/opencode",
                          "--session", String(id)]
    launchProc.running = true
    root.close()
  }

  Process {
    id: launchProc
    running: false
    clearEnvironment: true
    environment: root.launchEnv
    onExited: launchWatchdog.stop()
    onRunningChanged: if (running) launchWatchdog.restart()
  }

  // omarchy-launch-tui execs `setsid uwsm-app -- xdg-terminal-exec`, so the
  // terminal is deliberately in its own session and outlives this Process by
  // design — that is what "open a terminal" means. The Process tracked here is
  // only the short-lived wrapper. It is therefore NOT killed at destruction:
  // doing so would race a terminal the user just asked for, and would not reach
  // the detached session anyway. This watchdog exists so a wedged exec cannot
  // leave the Process permanently "running" and block the next click, since a
  // running Process cannot be re-run.
  Timer {
    id: launchWatchdog
    interval: 10000
    onTriggered: launchProc.running = false   // wrapper only; see above
  }

  // ---------------------------------------------------------------- panel

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function togglePanel() { if (panelLoader.item) panelLoader.item.toggle() }
  function openSetup() {
    if (!panelLoader.item) return
    if (typeof panelLoader.item.showSetup === "function") panelLoader.item.showSetup()
    panelLoader.item.open()
  }
  function openSessions() {
    if (!panelLoader.item) return
    if (typeof panelLoader.item.showSessions === "function") panelLoader.item.showSessions()
    panelLoader.item.open()
  }
  function openAgents() {
    if (!panelLoader.item) return
    if (typeof panelLoader.item.showAgents === "function") panelLoader.item.showAgents()
    panelLoader.item.open()
  }
  function openGraph(source) {
    if (!panelLoader.item) return
    if (typeof panelLoader.item.showGraph === "function") panelLoader.item.showGraph(source)
    panelLoader.item.open()
  }
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
    if ("history" in target) target.history = root.history
    if ("memInfo" in target) target.memInfo = root.memInfo
    if ("loadedModel" in target) target.loadedModel = root.loadedModel
    if ("rates" in target) target.rates = root.rates
    if ("currencySymbol" in target) target.currencySymbol = root.currencySymbol
    if ("sessions" in target) target.sessions = root.allSessions
    if ("agentHistories" in target) target.agentHistories = root.agentHistories
    if ("sourceState" in target) target.sourceState = root.sourceState
    if ("sourceLine" in target) target.sourceLine = root.sourceLine
    if ("agentStatusLine" in target) target.agentStatusLine = root.agentStatusLine
    if ("overrides" in target) target.overrides = root.overrides
    if ("shellSettings" in target) target.shellSettings = root.settings
  }

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()
  onHistoryChanged: injectPanel()
  onMemInfoChanged: injectPanel()
  onLoadedModelChanged: injectPanel()
  onAllSessionsChanged: injectPanel()
  onAgentHistoriesChanged: injectPanel()
  onSourceStateChanged: injectPanel()
  onSourceLineChanged: injectPanel()
  onAgentStatusLineChanged: injectPanel()
  onOverridesChanged: injectPanel()
  // Refresh the session lists whenever the panel is opened, so they are
  // current without polling anything in the background.
  onOpenedChanged: if (root.opened) { root.loadSessions(); root.loadAgentSessions() }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("TokenStatsPanel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  IpcHandler {
    target: "io.github.erikburdett.tokenstats"

    function refresh(): void { root.broadcast("refresh") }
    // Named `edit` to match Omarchy's own convention — `omarchy-shell
    // omarchy.weather edit` opens that widget on its configuration, so this
    // does the same and can be bound to a key or driven from a menu.
    function edit(): void { root.openSetup() }
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.togglePanel() }
    // Open straight onto a pane, so "show my AI sessions" can be one
    // keybinding: omarchy-shell io.github.erikburdett.tokenstats sessions
    function sessions(): void { root.openSessions() }
    function agents(): void { root.openAgents() }
    // graph local|claude|codex — the graph and history views read that
    // source until it is changed again.
    function graph(source: string): void { root.openGraph(source) }
  }

  // ---------------------------------------------------------------- bar

  // Which source the numbers are coming from, in the user's terms.
  readonly property string sourceState: {
    if (metricsAvailable) return "live"
    if (opencodeSeen || totalsAll.c > 0) return "opencode"
    return "none"
  }
  readonly property var totalsAll: Model.totals(history, "all", new Date())

  readonly property string sourceLine: {
    switch (sourceState) {
      case "live":
        return "Counting live from llama.cpp (" + root.serverShape + ") at "
               + root.endpoint
               + (root.residentModels.length > 1
                  ? " across " + root.residentModels.length + " resident models" : "")
               + ", with OpenCode filling any gap"
      case "opencode":
        return "Counting from OpenCode's records for "
               + root.effectiveProviders.join(", ")
               + ". Enable llama.cpp metrics for live throughput and non-OpenCode clients."
      default:
        // A zero has to say WHY, or it is indistinguishable from idle. Name the
        // thing that is missing rather than listing everything it could be.
        if (root.endpoint === "")
          return "Looking for llama.cpp on loopback — none of the usual ports answered. "
                 + "Set the endpoint under Setup if yours is elsewhere, or run scripts/diagnose.sh."
        if (root.residentModels.length === 0)
          return "Reached " + root.endpoint + " but no model is loaded. Run one."
        return "Reached " + root.endpoint + " but its counters are off. "
               + "Start llama-server with --metrics, or run a model through OpenCode."
    }
  }

  readonly property string tooltip: {
    var t = root.periodTotals
    var lines = [Model.periodLabel(root.barPeriod) + ": " + Model.formatTokens(root.perHour) + " tokens/hour"]
    lines.push("Generated: " + Model.formatTokens(t.c) + "   Prompt processed: " + Model.formatTokens(t.p))
    lines.push("Prompt from cache: " + Model.formatTokens(t.pc)
               + "  (" + Math.round(Model.cacheHitPercent(t)) + "% of prompt reused)")
    lines.push("Throughput while generating: " + Model.formatRate(t.m, t.s))
    var sv = Model.savings(t, root.rates)
    lines.push("Saved vs cloud: " + Model.formatMoney(sv.net, root.currencySymbol)
               + "  (at " + root.currencySymbol + root.inputPerMillion + "/"
               + root.currencySymbol + root.outputPerMillion + " per 1M)")
    // Cloud agents beside the local number, same window, never mixed in.
    var ct = Model.totals(root.agentHistories.claude, root.barPeriod, new Date())
    var xt = Model.totals(root.agentHistories.codex, root.barPeriod, new Date())
    if (ct.c > 0 || xt.c > 0)
      lines.push("Agents: Claude " + Model.formatTokens(ct.c)
                 + " · Codex " + Model.formatTokens(xt.c) + " generated")
    if (root.memInfo)
      lines.push("Memory available: " + Model.formatSize(root.memInfo.available))
    lines.push(root.loadedModel !== "" ? "Resident: " + root.loadedModel : "No model resident")
    lines.push(root.sourceLine)
    lines.push(root.agentStatusLine)
    lines.push("Click for the graph and history")
    return lines.join("\n")
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // The bar carries the token count and nothing else.
    text: root.vertical ? root.shortLabel : root.label
    fontSize: Style.font.caption
    tooltipText: root.tooltip
    onPressed: function(b) {
      if (b === Qt.RightButton) root.refresh()
      else root.togglePanel()
    }
  }
}
