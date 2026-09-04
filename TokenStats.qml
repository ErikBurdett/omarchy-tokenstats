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
// Cost of running: one short-lived curl per refresh and two FileViews. There is
// no journal tail, no repeated multi-megabyte log parse, and nothing forks
// while the panel is closed that would not fork anyway.
BarWidget {
  id: root
  moduleName: "io.github.erikburdett.tokenstats"

  // ---- Settings. Clamped or allow-listed here: shell.json is editable by
  //      anything running as the user, so nothing goes to a Timer, a formatter
  //      or a price unchecked.
  readonly property int refreshSec: Math.min(Math.max(Math.round(setting("refreshIntervalSec", 10)), 2), 120)
  readonly property string barPeriod: {
    var allowed = ["hour", "day", "week", "month", "year", "all"]
    var chosen = Model.periodKey(setting("barPeriod", "Today"))
    return allowed.indexOf(chosen) === -1 ? "day" : chosen
  }
  readonly property real inputPerMillion: Math.min(Math.max(Number(setting("cloudInputPerMillion", 3.0)), 0), 1000)
  readonly property real outputPerMillion: Math.min(Math.max(Number(setting("cloudOutputPerMillion", 15.0)), 0), 1000)
  readonly property real watts: Math.min(Math.max(Number(setting("systemWatts", 120)), 0), 2000)
  readonly property real pricePerKwh: Math.min(Math.max(Number(setting("pricePerKwh", 0.12)), 0), 10)
  readonly property string currencySymbol: String(setting("currencySymbol", "$")).substring(0, 3)
  readonly property bool importOpencode: setting("importOpencode", true) === true
  readonly property string opencodeDb: Quickshell.env("HOME") + "/.local/share/opencode/opencode.db"

  readonly property string endpoint: {
    // Only a loopback endpoint is accepted. This value is fetched by curl, so a
    // shell.json edit must not be able to point it at an arbitrary host.
    var raw = String(setting("endpoint", "http://127.0.0.1:8080"))
    return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(raw) ? raw : "http://127.0.0.1:8080"
  }

  readonly property var rates: ({
    inputPerMillion: root.inputPerMillion,
    outputPerMillion: root.outputPerMillion,
    watts: root.watts,
    pricePerKwh: root.pricePerKwh
  })

  // ---- State
  property var history: Model.emptyHistory()
  property var lastSample: null
  property string loadedModel: ""
  property var memInfo: null
  property bool historyLoaded: false
  property bool historyDirty: false
  // Which request is in flight, so the reply is parsed as what we asked for.
  property string pendingKind: ""

  readonly property var periodTotals: Model.totals(history, barPeriod, new Date())
  readonly property real perHour: Model.tokensPerHour(history, barPeriod, new Date())
  readonly property string label: "TS: " + Model.formatTokens(perHour) + " tokens/hour"
  // Left and right bars are narrow, so the caption and the unit go.
  readonly property string shortLabel: Model.formatTokens(perHour)

  readonly property string statePath: Quickshell.env("HOME") + "/.local/state/omarchy/tokenstats/history.json"

  // ---------------------------------------------------------------- polling

  // One request per tick. While a model is resident we read its counters; when
  // none is, we ask llama-swap which one to watch next. That keeps the steady
  // state at a single loopback GET every refreshSec.
  function poll() {
    if (pollProc.running) return
    if (loadedModel !== "") {
      pendingKind = "metrics"
      pollProc.command = ["/usr/bin/curl", "-fsS", "--max-time", "4",
                          endpoint + "/upstream/" + loadedModel + "/metrics"]
    } else {
      pendingKind = "models"
      pollProc.command = ["/usr/bin/curl", "-fsS", "--max-time", "4", endpoint + "/v1/models"]
    }
    pollWatchdog.restart()
    pollProc.running = true
  }

  function applyMetrics(text) {
    var parsed = Model.parseMetrics(text)
    if (!parsed) { loadedModel = ""; return }
    parsed.model = loadedModel

    // A successful read means live accounting covers up to now, so the importer
    // never has to reach back over a period we already counted.
    if (root.historyLoaded) {
      root.history.importedThrough = Date.now()
      root.historyDirty = true
    }

    var delta = Model.deltaFrom(lastSample, parsed)
    lastSample = parsed
    if (!delta || delta.reset) return
    if (delta.predictedTokens <= 0 && delta.promptTokens <= 0) return

    Model.record(root.history, delta, new Date(), 0, true)
    // A fresh top-level identity, because assigning the same object reference
    // back would not notify anything and the label would sit at its old value.
    root.history = Model.touched(root.history)
    historyDirty = true
  }

  function refresh() {
    poll()
    meminfoFile.reload()
  }

  Component.onCompleted: {
    historyFile.reload()
    refresh()
  }

  Process {
    id: pollProc
    running: false
    // curl inherits nothing it does not need. The URL is loopback-only by
    // construction (see `endpoint`), and the argv array leaves no shell to quote.
    environment: ({})
    stdout: StdioCollector { id: pollOut; waitForEnd: true }
    onExited: {
      pollWatchdog.stop()
      var text = pollOut.text
      // Take the kind and clear it BEFORE acting. The models branch starts the
      // next request from inside this handler, and that request sets its own
      // pendingKind — clearing afterwards would wipe the state the in-flight
      // reply needs and silently discard every metrics sample.
      var kind = root.pendingKind
      root.pendingKind = ""

      if (kind === "metrics") {
        root.applyMetrics(text)
      } else if (kind === "models") {
        var found = Model.parseLoadedModel(text)
        if (found !== root.loadedModel) root.lastSample = null
        root.loadedModel = found === null ? "" : found
        // A model just became resident — take its baseline now rather than
        // waiting out a whole interval.
        if (root.loadedModel !== "") root.poll()
      }
    }
  }

  // A curl that never returns would wedge polling permanently, since a Process
  // that is already running cannot be re-run.
  Timer {
    id: pollWatchdog
    interval: 8000
    onTriggered: {
      pollProc.running = false
      root.pendingKind = ""
    }
  }

  Timer {
    interval: root.refreshSec * 1000
    running: true
    repeat: true
    onTriggered: root.refresh()
  }

  Component.onDestruction: {
    pollWatchdog.stop()
    pollProc.running = false
    importWatchdog.stop()
    importProc.running = false
    if (root.historyDirty) root.saveHistory()
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
    onTriggered: if (root.historyDirty) root.saveHistory()
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

  function importOpencodeHistory() {
    if (!importOpencode || !historyLoaded || importProc.running) return

    var since = Math.round(Number(root.history.importedThrough) || 0)
    if (!isFinite(since) || since < 0) since = 0
    root.importBoundary = Date.now()

    importProc.command = [
      "/usr/bin/sqlite3", "-readonly", "-noheader", "-separator", "|",
      "file:" + root.opencodeDb + "?mode=ro",
      "select json_extract(data,'$.time.completed')," +
      " json_extract(data,'$.tokens.input')," +
      " json_extract(data,'$.tokens.output')," +
      " json_extract(data,'$.tokens.reasoning')" +
      " from message" +
      " where json_extract(data,'$.role')='assistant'" +
      "   and json_extract(data,'$.providerID')='local'" +
      "   and json_extract(data,'$.time.completed') > " + since +
      " order by 1 limit 20000;"
    ]
    importWatchdog.restart()
    importProc.running = true
  }

  Process {
    id: importProc
    running: false
    environment: ({})
    stdout: StdioCollector { id: importOut; waitForEnd: true }
    onExited: {
      importWatchdog.stop()
      var rows = Model.parseOpencodeRows(importOut.text,
                                         Number(root.history.importedThrough) || 0,
                                         root.importBoundary)
      if (rows.length > 0) {
        Model.applyImport(root.history, rows)
        root.history.importedThrough = root.importBoundary
        root.history = Model.touched(root.history)
        root.historyDirty = true
        root.saveHistory()
      }
    }
  }

  Timer {
    id: importWatchdog
    interval: 15000
    onTriggered: importProc.running = false
  }

  // ---------------------------------------------------------------- panel

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function togglePanel() { if (panelLoader.item) panelLoader.item.toggle() }
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
  }

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()
  onHistoryChanged: injectPanel()
  onMemInfoChanged: injectPanel()
  onLoadedModelChanged: injectPanel()

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
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.togglePanel() }
  }

  // ---------------------------------------------------------------- bar

  readonly property string tooltip: {
    var t = root.periodTotals
    var lines = [Model.periodLabel(root.barPeriod) + ": " + Model.formatTokens(root.perHour) + " tokens/hour"]
    lines.push("Generated: " + Model.formatTokens(t.c) + "   Prompt: " + Model.formatTokens(t.p))
    lines.push("Throughput while generating: " + Model.formatRate(t.m, t.s))
    var sv = Model.savings(t, root.rates)
    lines.push("Saved vs cloud: " + Model.formatMoney(sv.net, root.currencySymbol)
               + "  (at " + root.currencySymbol + root.inputPerMillion + "/"
               + root.currencySymbol + root.outputPerMillion + " per 1M)")
    if (root.memInfo)
      lines.push("Memory available: " + Model.formatSize(root.memInfo.available))
    lines.push(root.loadedModel !== "" ? "Model loaded: " + root.loadedModel : "No model resident")
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
