// Delegates below reference ids from this component (root, content).
// Bound makes that lookup explicit and checkable rather than relying on
// dynamic scope, which is what qmllint's "unqualified access" flags.
pragma ComponentBehavior: Bound

import QtQuick
import qs.Commons
import qs.Ui
import "TokenModel.js" as Model

// The stats popup: totals for a chosen window, a bar graph, a readable history
// table, and the savings arithmetic with its assumptions written out.
//
// TokenStats.qml owns the polling and the persisted history and pushes both in,
// so opening this panel costs nothing and both surfaces always agree.
Panel {
  id: root
  moduleName: "io.github.erikburdett.tokenstats"
  ipcTarget: "io.github.erikburdett.tokenstats"
  manageIpc: false

  property var anchorItem: null
  // The bar tracks the widget in its slot, not this nested panel, so the popout
  // coordinator has to be handed that widget as the owner identity.
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  property var history: null
  property var memInfo: null
  property string loadedModel: ""
  property var rates: ({})
  property string currencySymbol: "$"
  property string sourceState: "none"
  property string sourceLine: ""

  // Panel-set overrides and the shell.json values beneath them, both injected
  // by the widget. The pane shows the effective value and says where it came
  // from, so "why is this number not what I set" is answerable on screen.
  property var overrides: ({})
  property var shellSettings: ({})

  // Everything that is a statistic rather than a list or a form. Sessions and
  // Setup replace the whole body; the graph, table, per-model rows and cost
  // block all belong to the same "show me the numbers" mode.
  readonly property bool statsView: view !== "sessions" && view !== "setup"

  // Effective value for a setting: panel override, else shell.json, else the
  // built-in default. Mirrors the widget's own setting() resolution.
  // Panel override, else shell.json, else the built-in default. The default
  // comes from the model rather than being retyped here, because the manifest
  // declares the same values and a test asserts the two agree.
  function settingValue(key) {
    if (overrides && overrides[key] !== undefined && overrides[key] !== null) return overrides[key]
    if (shellSettings && shellSettings[key] !== undefined && shellSettings[key] !== null) return shellSettings[key]
    return Model.settingDefault(key)
  }

  function settingSource(key) {
    if (overrides && overrides[key] !== undefined && overrides[key] !== null) return "set here"
    if (shellSettings && shellSettings[key] !== undefined && shellSettings[key] !== null) return "from Setup > Plugins"
    return "default"
  }

  function showSetup() {
    view = "setup"
  }

  function writeSetting(key, value) {
    if (hostWidget && typeof hostWidget.setOverride === "function") hostWidget.setOverride(key, value)
  }

  property string period: "day"
  property string view: "graph"
  property var sessions: []
  // -1 when nothing is under the pointer.
  property int hoverIndex: -1
  // Pointer position inside the chart, for placing the floating readout.
  property real hoverX: 0
  property real hoverY: 0
  readonly property var hoveredPoint: (hoverIndex >= 0 && hoverIndex < points.length)
                                      ? points[hoverIndex] : null

  // Re-read while the panel is open. Evaluated once, this froze every total and
  // the graph at the moment the panel was first loaded.
  property var now: new Date()

  Timer {
    interval: 10000
    running: root.opened
    repeat: true
    triggeredOnStart: true
    onTriggered: root.now = new Date()
  }
  readonly property var totals: Model.totals(history, period, now)
  readonly property var points: Model.series(history, period, now)
  readonly property var money: Model.savings(totals, rates)
  readonly property var byModel: Model.modelBreakdown(totals)
  readonly property real peak: {
    var max = 0
    for (var i = 0; i < points.length; i++) if (points[i].tokens > max) max = points[i].tokens
    return max
  }

  readonly property string slotUnit: root.period === "hour" ? " / min"
                                   : (root.period === "day" ? " / hour"
                                   : (root.period === "year" ? " / month" : " / day"))

  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color dim: Qt.darker(barForeground, 1.35)

  function refresh() { /* the host pushes state; nothing to pull */ }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keys
    contentWidth: panel.fittedContentWidth(Style.space(420))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

    PanelKeyCatcher {
      id: keys
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: content
        width: parent.width
        spacing: Style.space(8)

        PanelHero {
          width: parent.width
          foreground: root.barForeground
          fontFamily: root.fontFamily
          title: Model.formatTokens(root.totals.c)
          meta: "tokens generated"
          // Throughput is only known for tokens this widget sampled itself.
          // Imported history carries exact counts but no usable generation
          // time, so say what the rate was measured on rather than implying it
          // covers everything above it.
          detail: {
            var rate = Model.formatRate(root.totals.m, root.totals.s)
            if (root.totals.m <= 0) return Model.periodLabel(root.period) + " · rate not sampled yet"
            if (root.totals.m < root.totals.c * 0.95)
              return Model.periodLabel(root.period) + " · " + rate + " on "
                     + Model.formatTokens(root.totals.m) + " sampled"
            return Model.periodLabel(root.period) + " · " + rate
          }
        }

        // ---- Window selector.
        ButtonGroup {
          width: parent.width
          options: ["Hour", "Day", "Week", "Month", "Year", "All"]
          value: root.periodOption(root.period)
          foreground: root.barForeground
          background: root.bar ? root.bar.background : Color.background
          fontFamily: root.fontFamily
          fontSize: Style.font.caption
          onChanged: function(v) { root.period = root.optionPeriod(v) }
        }

        // ---- View switch. Two buttons rather than a second chip row, so the
        //      panel reads as "here is the number, now show it to me how".
        Row {
          spacing: Style.space(6)

          Button {
            text: "Graph"
            selected: root.view === "graph"
            bordered: true
            foreground: root.barForeground
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            tooltipText: "Tokens per slot across the selected window"
            onClicked: root.view = "graph"
          }

          Button {
            text: "History"
            selected: root.view === "history"
            bordered: true
            foreground: root.barForeground
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            tooltipText: "Every recorded slot with its token count"
            onClicked: root.view = "history"
          }

          Button {
            text: "Sessions"
            selected: root.view === "sessions"
            bordered: true
            foreground: root.barForeground
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            tooltipText: "OpenCode sessions by tokens generated. Click one to resume it."
            onClicked: root.view = "sessions"
          }

          Button {
            text: "Setup"
            selected: root.view === "setup"
            bordered: true
            foreground: root.barForeground
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            tooltipText: "Change what the bar shows and the rates the comparison assumes"
            onClicked: root.view = "setup"
          }
        }

        // A bar chart with no stated scale is decoration: every window looks
        // "full" because the tallest bar is always the peak. Name the peak.
        Row {
          width: parent.width
          visible: root.view === "graph" && root.peak > 0

          Text {
            width: parent.width * 0.62
            elide: Text.ElideRight
            textFormat: Text.PlainText
            text: Model.rangeLabel(root.points)
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          Text {
            width: parent.width * 0.38
            horizontalAlignment: Text.AlignRight
            textFormat: Text.PlainText
            text: "peak " + Model.formatTokens(root.peak) + root.slotUnit
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }

        // ---- Graph. Plain Rectangles rather than a Canvas: a bar chart is
        //      rectangles, and this way it repaints with the theme for free.
        Item {
          width: parent.width
          height: Style.space(120)
          visible: root.view === "graph"

          Text {
            anchors.centerIn: parent
            visible: root.peak <= 0
            textFormat: Text.PlainText
            text: "Nothing recorded in this window yet"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          Row {
            anchors.fill: parent
            spacing: 1
            visible: root.peak > 0

            Repeater {
              model: root.points

              Item {
                id: slot
                required property var modelData
                required property int index
                readonly property bool hovered: root.hoverIndex === index
                readonly property bool boundary: Model.isBoundary(slot.modelData)
                width: (content.width - (root.points.length - 1)) / root.points.length
                height: parent.height

                // A faint rule where a new day starts, so "23:00 00:00" does
                // not read as one continuous run.
                Rectangle {
                  visible: slot.boundary
                  anchors.left: parent.left
                  anchors.top: parent.top
                  anchors.bottom: labelText.top
                  width: 1
                  color: root.dim
                  opacity: 0.35
                }

                Rectangle {
                  anchors.bottom: labelText.top
                  anchors.bottomMargin: Style.space(3)
                  anchors.horizontalCenter: parent.horizontalCenter
                  width: Math.max(parent.width - Style.space(2), 1)
                  // Guarded against a zero peak so an empty window cannot
                  // divide by zero and paint a NaN-height bar.
                  height: root.peak > 0
                    ? Math.max(Math.round((parent.height - Style.space(16)) * (slot.modelData.tokens / root.peak)), slot.modelData.tokens > 0 ? 2 : 0)
                    : 0
                  radius: Style.space(2)
                  color: slot.modelData.tokens > 0 ? root.barForeground : "transparent"
                  opacity: slot.hovered ? 1 : (slot.index === root.points.length - 1 ? 0.95 : 0.5)
                }

                Text {
                  id: labelText
                  anchors.bottom: parent.bottom
                  anchors.horizontalCenter: parent.horizontalCenter
                  textFormat: Text.PlainText
                  // Thin the axis rather than overprinting it, and always keep
                  // the slot under the pointer legible.
                  // Deliberately NOT forced visible on hover: printing the
                  // hovered slot's label on a thinned axis collided with its
                  // neighbours. The floating readout carries that detail now.
                  text: (root.points.length <= 8
                         || slot.index % Math.ceil(root.points.length / 8) === 0)
                        ? Model.axisLabel(slot.modelData) : ""
                  color: slot.hovered ? root.barForeground : root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }
            }
          }

          // One tracker across the whole chart rather than a MouseArea per bar:
          // the pointer never falls between slots, and the readout can follow it.
          MouseArea {
            id: chartMouse
            anchors.fill: parent
            hoverEnabled: true
            onPositionChanged: function (mouse) {
              if (root.points.length === 0) return
              var slotWidth = width / root.points.length
              if (slotWidth <= 0) return
              var idx = Math.floor(mouse.x / slotWidth)
              root.hoverIndex = Math.max(0, Math.min(root.points.length - 1, idx))
              root.hoverX = mouse.x
              root.hoverY = mouse.y
            }
            onExited: root.hoverIndex = -1
          }

          // Floating readout, placed beside the pointer and clamped inside the
          // chart so it never runs off either edge.
          Rectangle {
            id: readout
            visible: root.hoveredPoint !== null && root.view === "graph"
            width: readoutText.implicitWidth + Style.space(12)
            height: readoutText.implicitHeight + Style.space(8)
            radius: Style.space(3)
            color: root.bar ? root.bar.background : Color.background
            border.width: 1
            border.color: Qt.rgba(root.barForeground.r, root.barForeground.g, root.barForeground.b, 0.35)
            x: Math.max(0, Math.min(parent.width - width, root.hoverX + Style.space(12)))
            y: Math.max(0, Math.min(parent.height - height, root.hoverY - height - Style.space(6)))

            Text {
              id: readoutText
              anchors.centerIn: parent
              textFormat: Text.PlainText
              text: root.hoveredPoint ? Model.pointDetail(root.hoveredPoint) : ""
              color: root.barForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }
        }

        // Steady summary under the chart; the hover detail floats instead.
        Text {
          width: parent.width
          visible: root.view === "graph"
          elide: Text.ElideRight
          textFormat: Text.PlainText
          text: Model.formatTokens(root.totals.c) + " tokens in this window  ·  hover a bar for detail"
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        // ---- History table.
        Item {
          width: parent.width
          height: Style.space(120)
          visible: root.view === "history"

          Flickable {
            anchors.fill: parent
            contentWidth: width
            contentHeight: rows.implicitHeight
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            interactive: contentHeight > height

            Column {
              id: rows
              width: parent.width

              Repeater {
                // Newest first, and quiet slots dropped: a table of zeroes is
                // not history, it is padding.
                model: {
                  var out = []
                  for (var i = root.points.length - 1; i >= 0; i--)
                    if (root.points[i].tokens > 0) out.push(root.points[i])
                  return out
                }

                Row {
                  id: historyRow
                  required property var modelData
                  width: rows.width

                  Text {
                    width: parent.width * 0.45
                    textFormat: Text.PlainText
                    text: historyRow.modelData.key
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                  }

                  Text {
                    width: parent.width * 0.55
                    horizontalAlignment: Text.AlignRight
                    textFormat: Text.PlainText
                    text: Model.formatTokens(historyRow.modelData.tokens) + " tokens"
                    color: root.barForeground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                  }
                }
              }

              Text {
                width: rows.width
                visible: root.peak <= 0
                textFormat: Text.PlainText
                text: "Nothing recorded in this window yet"
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }
        }

        // ---- Sessions. Click one to resume it in a terminal.
        Item {
          width: parent.width
          height: Style.space(150)
          visible: root.view === "sessions"

          Text {
            anchors.centerIn: parent
            visible: root.sessions.length === 0
            textFormat: Text.PlainText
            text: "No OpenCode sessions with generated tokens yet"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          Flickable {
            anchors.fill: parent
            contentWidth: width
            contentHeight: sessionRows.implicitHeight
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            interactive: contentHeight > height

            Column {
              id: sessionRows
              width: parent.width
              spacing: Style.space(2)

              Repeater {
                model: root.sessions

                Item {
                  id: sessionRow
                  required property var modelData
                  width: sessionRows.width
                  height: title.implicitHeight + meta.implicitHeight + Style.space(6)
                  readonly property bool hovered: sessionMouse.containsMouse

                  Rectangle {
                    anchors.fill: parent
                    color: sessionRow.hovered ? root.barForeground : "transparent"
                    opacity: 0.10
                    radius: Style.space(3)
                  }

                  Text {
                    id: title
                    anchors.top: parent.top
                    anchors.left: parent.left
                    anchors.right: parent.right
                    elide: Text.ElideRight
                    // Titles are generated text from a model, so they are
                    // rendered literally rather than as possible markup.
                    textFormat: Text.PlainText
                    text: sessionRow.modelData.title
                    color: root.barForeground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                  }

                  Text {
                    id: meta
                    anchors.top: title.bottom
                    anchors.left: parent.left
                    anchors.right: parent.right
                    elide: Text.ElideRight
                    textFormat: Text.PlainText
                    text: Model.formatTokens(sessionRow.modelData.tokens) + " tokens"
                          + (sessionRow.modelData.model !== "" ? "  ·  " + sessionRow.modelData.model : "")
                          + "  ·  " + Model.shortWhen(sessionRow.modelData.at)
                          + (sessionRow.hovered ? "  ·  click to resume" : "")
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }

                  MouseArea {
                    id: sessionMouse
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                      if (root.hostWidget && root.hostWidget.openSession)
                        root.hostWidget.openSession(sessionRow.modelData.id,
                                                    sessionRow.modelData.directory)
                    }
                  }
                }
              }
            }
          }
        }

        // ---- Setup. Everything tunable, edited here rather than only in
        //      shell.json, because the rates below are assumptions you want to
        //      change while looking at the number they produced.
        //
        //      Writes go to this plugin's own state file. shell.json is never
        //      touched: it holds the user's bar layout, and a widget that
        //      rewrites user configuration is a marketplace blocker. Clearing
        //      a field with Reset hands the setting back to Setup > Plugins.
        Item {
          width: parent.width
          height: Style.space(330)
          visible: root.view === "setup"

          Flickable {
            anchors.fill: parent
            contentWidth: width
            contentHeight: setupColumn.implicitHeight
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            interactive: contentHeight > height

            Column {
              id: setupColumn
              width: parent.width
              spacing: Style.space(8)

              Text {
                width: parent.width
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                text: "Changes apply immediately and are saved to this plugin's own state file. "
                      + "Your shell.json is never modified."
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              // ---- What the bar itself shows.
              Text {
                textFormat: Text.PlainText
                text: "BAR SHOWS  ·  " + root.settingSource("barPeriod")
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              ButtonGroup {
                width: parent.width
                options: ["Hour", "Day", "Week", "Month", "Year", "All"]
                value: root.periodOption(Model.periodKey(root.settingValue("barPeriod")))
                foreground: root.barForeground
                background: root.bar ? root.bar.background : Color.background
                fontFamily: root.fontFamily
                fontSize: Style.font.caption
                // Stored as the manifest's own enum label, so a value set here
                // and one set in Setup > Plugins are literally the same string.
                onChanged: function(v) {
                  root.writeSetting("barPeriod", Model.periodSettingLabel(root.optionPeriod(v)))
                }
              }

              PanelSeparator { width: parent.width }

              // ---- The rates the comparison assumes. Money is a text field
              //      rather than a NumberField because these are decimals and
              //      NumberField is integer-only.
              Text {
                width: parent.width
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                text: "RATES ASSUMED FOR THE COMPARISON  ·  per 1M tokens"
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              Repeater {
                model: [
                  { key: "cloudInputPerMillion",       label: "Prompt processed" },
                  { key: "cloudCachedInputPerMillion", label: "Prompt from cache" },
                  { key: "cloudOutputPerMillion",      label: "Generated" },
                  { key: "pricePerKwh",                label: "Electricity per kWh" }
                ]

                Row {
                  id: rateRow
                  required property var modelData
                  width: setupColumn.width
                  spacing: Style.space(6)

                  Text {
                    width: parent.width * 0.5
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: rateRow.modelData.label
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                  }

                  TextField {
                    id: rateField
                    width: Style.space(80)
                    foreground: root.barForeground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    // Bound, not initialised: a Reset elsewhere in this pane has
                    // to be reflected here, and an unbound field would keep
                    // showing the cleared value.
                    text: String(root.settingValue(rateRow.modelData.key))
                    // Committed on Enter or on leaving the field, never on every
                    // keystroke — a half-typed "3." is not a price.
                    onEditingFinished: root.writeSetting(rateRow.modelData.key, text)
                  }
                }
              }

              Row {
                width: parent.width
                spacing: Style.space(6)

                Text {
                  width: parent.width * 0.5
                  anchors.verticalCenter: parent.verticalCenter
                  textFormat: Text.PlainText
                  text: "Currency symbol"
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                }

                TextField {
                  width: Style.space(80)
                  foreground: root.barForeground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  text: String(root.settingValue("currencySymbol"))
                  onEditingFinished: root.writeSetting("currencySymbol", text)
                }
              }

              // ---- Integers get the real control for the job.
              NumberField {
                label: "System draw while generating (W)"
                value: Number(root.settingValue("systemWatts"))
                from: 0
                to: 2000
                stepSize: 5
                foreground: root.barForeground
                fontFamily: root.fontFamily
                fontSize: Style.font.bodySmall
                onModified: function(v) { root.writeSetting("systemWatts", v) }
              }

              NumberField {
                label: "Refresh (seconds)"
                value: Number(root.settingValue("refreshIntervalSec"))
                from: 2
                to: 120
                stepSize: 1
                foreground: root.barForeground
                fontFamily: root.fontFamily
                fontSize: Style.font.bodySmall
                onModified: function(v) { root.writeSetting("refreshIntervalSec", v) }
              }

              PanelSeparator { width: parent.width }

              Toggle {
                width: parent.width
                label: "Import history from OpenCode"
                description: "Fills windows live counters could not cover, using OpenCode's own exact per-reply counts. Read-only."
                checked: root.settingValue("importOpencode") === true
                foreground: root.barForeground
                fontFamily: root.fontFamily
                onClicked: root.writeSetting("importOpencode", !checked)
              }

              PanelSeparator { width: parent.width }

              Row {
                width: parent.width
                spacing: Style.space(6)

                Button {
                  text: "Reset to Setup > Plugins"
                  bordered: true
                  foreground: root.barForeground
                  fontFamily: root.fontFamily
                  fontSize: Style.font.caption
                  tooltipText: "Clear everything set here and go back to the values in shell.json"
                  onClicked: if (root.hostWidget && root.hostWidget.resetOverrides) root.hostWidget.resetOverrides()
                }
              }

              // The one setting deliberately not editable here. It is the only
              // one with a security boundary attached, and keeping it in
              // shell.json means the loopback rule has exactly one place it can
              // be changed from.
              Text {
                width: parent.width
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                text: "The llama-swap endpoint stays in Setup > Plugins. It is the only setting with a "
                      + "security boundary — loopback addresses only — so it has one place to be changed."
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }
        }

        PanelSeparator {
          width: parent.width
          foreground: root.barForeground
          visible: root.byModel.length > 0 && root.statsView
        }

        PanelSectionHeader {
          text: "By model"
          foreground: root.barForeground
          fontFamily: root.fontFamily
          visible: root.byModel.length > 0 && root.statsView
        }

        Repeater {
          model: root.byModel

          Row {
            id: modelRow
            required property var modelData
            width: content.width
            visible: root.statsView

            Text {
              width: parent.width * 0.34
              elide: Text.ElideRight
              textFormat: Text.PlainText
              // A model id is a string from llama-swap, so it is rendered
              // literally rather than as possible markup.
              text: modelRow.modelData.model
              color: root.barForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              width: parent.width * 0.30
              horizontalAlignment: Text.AlignRight
              textFormat: Text.PlainText
              text: Model.formatTokens(modelRow.modelData.tokens)
              color: root.barForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              width: parent.width * 0.16
              horizontalAlignment: Text.AlignRight
              textFormat: Text.PlainText
              text: Math.round(modelRow.modelData.share) + "%"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              width: parent.width * 0.20
              horizontalAlignment: Text.AlignRight
              textFormat: Text.PlainText
              // Blank rather than a dash when this model has no sampled
              // throughput: the tokens are still exact, the rate simply is not
              // known for imported history.
              text: modelRow.modelData.metered > 0 && modelRow.modelData.seconds > 0
                    ? Model.formatRate(modelRow.modelData.metered, modelRow.modelData.seconds) : ""
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }
          }
        }

        PanelSeparator {
          width: parent.width
          foreground: root.barForeground
          visible: root.statsView
        }

        PanelSectionHeader {
          text: "Versus a hosted API"
          foreground: root.barForeground
          fontFamily: root.fontFamily
          visible: root.statsView
        }

        Repeater {
          model: [
            // Split, because they are not the same thing and a hosted API
            // prices them differently. "Processed" is the work this machine
            // actually did; "from cache" is prompt the KV cache served, which
            // llama.cpp and OpenCode both report separately and which an API
            // would still have billed — at a reduced rate.
            { key: "Prompt processed", value: Model.formatTokens(root.totals.p) },
            { key: "Prompt from cache", value: Model.formatTokens(root.totals.pc)
                                        + "  (" + Math.round(Model.cacheHitPercent(root.totals)) + "%)" },
            { key: "Generated",       value: Model.formatTokens(root.totals.c) },
            { key: "Cloud would cost", value: Model.formatMoney(root.money.cloud, root.currencySymbol) },
            { key: "Electricity",     value: Model.formatMoney(root.money.local, root.currencySymbol) },
            { key: "Net saved",       value: Model.formatMoney(root.money.net, root.currencySymbol) }
          ]

          Row {
            id: costRow
            required property var modelData
            required property int index
            width: content.width
            visible: root.statsView

            Text {
              width: parent.width * 0.55
              textFormat: Text.PlainText
              text: costRow.modelData.key
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              width: parent.width * 0.45
              horizontalAlignment: Text.AlignRight
              textFormat: Text.PlainText
              text: costRow.modelData.value
              color: root.barForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              font.bold: costRow.index === 4
            }
          }
        }

        // The savings number is only as good as the rates behind it, so the
        // rates are on screen next to it rather than buried in settings.
        Text {
          width: parent.width
          wrapMode: Text.WordWrap
          visible: root.statsView
          textFormat: Text.PlainText
          text: "Assumes " + root.currencySymbol + (root.rates.inputPerMillion || 0) + " prompt / "
                + root.currencySymbol + (root.rates.cachedInputPerMillion || 0) + " cached prompt / "
                + root.currencySymbol + (root.rates.outputPerMillion || 0)
                + " generated, per 1M tokens; " + (root.rates.watts || 0) + "W at "
                + root.currencySymbol + (root.rates.pricePerKwh || 0) + "/kWh. Change these under Setup, above."
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        PanelSeparator { width: parent.width; foreground: root.barForeground }

        Text {
          width: parent.width
          textFormat: Text.PlainText
          text: (root.loadedModel !== "" ? "Resident: " + root.loadedModel : "No model resident")
                + (root.memInfo ? "   ·   " + Model.formatSize(root.memInfo.available) + " RAM available" : "")
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        // Where the numbers come from. Worth a permanent line rather than a
        // one-off warning: which source is active changes what the throughput
        // figure can mean, and the setup hint is only useful where it is seen.
        Text {
          width: parent.width
          wrapMode: Text.WordWrap
          textFormat: Text.PlainText
          text: root.sourceLine
          color: root.sourceState === "none" ? (root.bar ? root.bar.urgent : Color.urgent) : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }

  // Chip labels are what the ButtonGroup stores, so translate at the edge and
  // keep the internal keys stable.
  function periodOption(key) {
    switch (key) {
      case "hour":  return "Hour"
      case "week":  return "Week"
      case "month": return "Month"
      case "year":  return "Year"
      case "all":   return "All"
      default:      return "Day"
    }
  }

  function optionPeriod(option) {
    switch (String(option)) {
      case "Hour":  return "hour"
      case "Week":  return "week"
      case "Month": return "month"
      case "Year":  return "year"
      case "All":   return "all"
      default:      return "day"
    }
  }
}
