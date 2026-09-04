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

  property string period: "day"
  property string view: "graph"

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
            tooltipText: "Every recorded slot with prompt and generated counts"
            onClicked: root.view = "history"
          }
        }

        // A bar chart with no stated scale is decoration: every window looks
        // "full" because the tallest bar is always the peak. Name the peak.
        Row {
          width: parent.width
          visible: root.view === "graph" && root.peak > 0

          Text {
            width: parent.width / 2
            textFormat: Text.PlainText
            text: "peak " + Model.formatTokens(root.peak) + root.slotUnit
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          Text {
            width: parent.width / 2
            horizontalAlignment: Text.AlignRight
            textFormat: Text.PlainText
            text: Model.formatTokens(root.totals.c) + " total"
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
                required property var modelData
                required property int index
                width: (content.width - (root.points.length - 1)) / root.points.length
                height: parent.height

                Rectangle {
                  anchors.bottom: labelText.top
                  anchors.bottomMargin: Style.space(3)
                  anchors.horizontalCenter: parent.horizontalCenter
                  width: Math.max(parent.width - Style.space(2), 1)
                  // Guarded against a zero peak so an empty window cannot
                  // divide by zero and paint a NaN-height bar.
                  height: root.peak > 0
                    ? Math.max(Math.round((parent.height - Style.space(16)) * (modelData.tokens / root.peak)), modelData.tokens > 0 ? 2 : 0)
                    : 0
                  radius: Style.space(2)
                  color: modelData.tokens > 0 ? root.barForeground : "transparent"
                  opacity: index === root.points.length - 1 ? 1 : 0.55
                }

                Text {
                  id: labelText
                  anchors.bottom: parent.bottom
                  anchors.horizontalCenter: parent.horizontalCenter
                  textFormat: Text.PlainText
                  // Thin the axis out rather than overprinting it when a window
                  // has more slots than the panel has room for labels.
                  text: (root.points.length <= 12 || index % Math.ceil(root.points.length / 12) === 0)
                        ? modelData.label : ""
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }
            }
          }
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
                  required property var modelData
                  width: rows.width

                  Text {
                    width: parent.width * 0.45
                    textFormat: Text.PlainText
                    text: modelData.key
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                  }

                  Text {
                    width: parent.width * 0.55
                    horizontalAlignment: Text.AlignRight
                    textFormat: Text.PlainText
                    text: Model.formatTokens(modelData.tokens) + " tokens"
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

        PanelSeparator { width: parent.width; foreground: root.barForeground }

        PanelSectionHeader {
          text: "Versus a hosted API"
          foreground: root.barForeground
          fontFamily: root.fontFamily
        }

        Repeater {
          model: [
            { key: "Prompt tokens",   value: Model.formatTokens(root.totals.p) },
            { key: "Generated",       value: Model.formatTokens(root.totals.c) },
            { key: "Cloud would cost", value: Model.formatMoney(root.money.cloud, root.currencySymbol) },
            { key: "Electricity",     value: Model.formatMoney(root.money.local, root.currencySymbol) },
            { key: "Net saved",       value: Model.formatMoney(root.money.net, root.currencySymbol) }
          ]

          Row {
            required property var modelData
            required property int index
            width: content.width

            Text {
              width: parent.width * 0.55
              textFormat: Text.PlainText
              text: modelData.key
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              width: parent.width * 0.45
              horizontalAlignment: Text.AlignRight
              textFormat: Text.PlainText
              text: modelData.value
              color: root.barForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              font.bold: index === 4
            }
          }
        }

        // The savings number is only as good as the rates behind it, so the
        // rates are on screen next to it rather than buried in settings.
        Text {
          width: parent.width
          wrapMode: Text.WordWrap
          textFormat: Text.PlainText
          text: "Assumes " + root.currencySymbol + (root.rates.inputPerMillion || 0) + " / "
                + root.currencySymbol + (root.rates.outputPerMillion || 0)
                + " per 1M prompt/output tokens, " + (root.rates.watts || 0) + "W at "
                + root.currencySymbol + (root.rates.pricePerKwh || 0) + "/kWh. Change these in Setup > Plugins."
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        PanelSeparator { width: parent.width; foreground: root.barForeground }

        Text {
          width: parent.width
          textFormat: Text.PlainText
          text: (root.loadedModel !== "" ? "Model: " + root.loadedModel : "No model resident")
                + (root.memInfo ? "   ·   " + Model.formatSize(root.memInfo.available) + " RAM available" : "")
          color: root.dim
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
