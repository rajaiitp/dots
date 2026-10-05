import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui
import qs.Commons

Panel {
  id: root
  moduleName: "raja.nightlight"

  readonly property var nightlightService: bar && bar.shell
    ? bar.shell.firstPartyServiceFor("omarchy.nightlight")
    : null
  readonly property int minTemperature: 3500
  readonly property int maxTemperature: 6500
  readonly property int temperatureStep: 100
  readonly property int identityTemperature: 6000

  property int temperature: maxTemperature
  property int pendingTemperature: maxTemperature
  property bool temperatureLoaded: false
  property bool temperatureBackendAvailable: false
  property bool temperatureSetQueued: false
  property bool cursorActive: false

  readonly property bool nightlightEnabled: temperatureBackendAvailable
    ? temperature < identityTemperature
    : !!nightlightService && nightlightService.enabled

  function clampTemperature(value) {
    var numeric = Number(value)
    if (!isFinite(numeric)) return maxTemperature

    var bounded = Math.max(minTemperature, Math.min(maxTemperature, numeric))
    var stepped = Math.round(bounded / temperatureStep) * temperatureStep
    return Math.max(minTemperature, Math.min(maxTemperature, stepped))
  }

  function temperatureFromOutput(output) {
    var match = String(output === undefined || output === null ? "" : output).match(/[0-9]+/)
    if (!match) return null
    var parsed = Number(match[0])
    return isFinite(parsed) ? parsed : null
  }

  function refresh() {
    if (!statusProbe.running) statusProbe.running = true
  }

  function runTemperature(value) {
    var next = clampTemperature(value)
    setTemperatureProcess.command = ["bash", "-lc",
      "pgrep -x hyprsunset >/dev/null || { setsid uwsm-app -- hyprsunset >/dev/null 2>&1 & sleep 1; }; " +
      "hyprctl hyprsunset temperature " + Number(next)]
    setTemperatureProcess.running = true
  }

  function applyTemperature(value) {
    var next = clampTemperature(value)
    root.temperature = next
    root.pendingTemperature = next
    root.temperatureLoaded = true

    if (setTemperatureProcess.running) {
      root.temperatureSetQueued = true
      return
    }

    root.temperatureSetQueued = false
    runTemperature(next)
  }

  function previewTemperature(value) {
    root.temperature = clampTemperature(value)
    temperatureDebounce.restart()
  }

  function commitTemperature(value) {
    temperatureDebounce.stop()
    applyTemperature(value)
  }

  function adjustTemperature(deltaSteps) {
    if (!root.temperatureBackendAvailable) return
    root.cursorActive = true
    applyTemperature(root.temperature + deltaSteps * temperatureStep)
  }

  function toggleNightlight() {
    var enabling = !root.nightlightEnabled
    root.applyTemperature(enabling ? minTemperature : maxTemperature)
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  Component.onCompleted: refresh()

  onOpenedChanged: {
    if (opened) {
      refresh()
      cursorActive = false
    }
  }

  Process {
    id: statusProbe
    command: ["hyprctl", "hyprsunset", "temperature"]

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var parsed = root.temperatureFromOutput(text)
        root.temperatureLoaded = true
        if (parsed === null) {
          root.temperatureBackendAvailable = false
          return
        }

        root.temperature = root.clampTemperature(parsed)
        root.pendingTemperature = root.temperature
        root.temperatureBackendAvailable = true
      }
    }

    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root.temperatureLoaded = true
        root.temperatureBackendAvailable = false
      }
    }
  }

  Timer {
    id: temperatureDebounce
    interval: 180
    repeat: false
    onTriggered: root.applyTemperature(root.temperature)
  }

  Process {
    id: setTemperatureProcess
    stdout: StdioCollector { waitForEnd: true }

    onExited: function(exitCode) {
      if (exitCode !== 0) root.temperatureBackendAvailable = false

      if (root.temperatureSetQueued) {
        root.temperatureSetQueued = false
        root.runTemperature(root.pendingTemperature)
      } else {
        root.refresh()
      }
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰔎"
    active: root.nightlightEnabled
    useActiveColor: false
    tooltipText: root.nightlightEnabled ? "Day Light" : "Night Light"

    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) root.toggleNightlight()
      else if (buttonCode === Qt.LeftButton) root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(320))
    contentHeight: panel.fittedContentHeight(panelColumn.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent

      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) {
          root.cursorActive = true
          return
        }
        if (dx !== 0) root.adjustTemperature(dx)
      }
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: panelColumn
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(14)

        Item {
          width: parent.width
          implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight)

          Text {
            id: heroIcon
            text: "󰔎"
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.display
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
          }

          Column {
            id: heroLabels
            anchors.left: heroIcon.right
            anchors.leftMargin: Style.space(14)
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              text: "Daylight"
              color: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
              elide: Text.ElideRight
              width: parent.width
            }

            Text {
              text: root.temperatureBackendAvailable
                ? (root.nightlightEnabled ? "WARM FILTER" : "DAYLIGHT")
                : "UNAVAILABLE"
              color: Qt.darker(root.bar.foreground, 1.4)
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
              elide: Text.ElideRight
              width: parent.width
            }
          }
        }

        PanelSeparator {
          foreground: root.bar.foreground
        }

        Column {
          width: parent.width
          spacing: Style.space(6)

          Item {
            width: parent.width
            implicitHeight: Math.max(temperatureHeader.implicitHeight, temperatureValue.implicitHeight)

            PanelSectionHeader {
              id: temperatureHeader
              text: "COLOR TEMPERATURE"
              foreground: root.bar.foreground
              fontFamily: root.bar.fontFamily
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
            }

            Text {
              id: temperatureValue
              text: root.temperatureBackendAvailable
                ? (temperatureSlider.dragging ? root.clampTemperature(temperatureSlider.liveValue) : root.temperature) + "K"
                : "—"
              color: Qt.darker(root.bar.foreground, 1.4)
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              anchors.right: parent.right
              anchors.rightMargin: Style.space(6)
              anchors.verticalCenter: parent.verticalCenter
            }
          }

          CursorSurface {
            id: temperatureRow
            width: parent.width
            height: temperatureSlider.implicitHeight + Style.spacing.controlGap
            enabled: root.temperatureBackendAvailable
            hasCursor: root.cursorActive
            foreground: root.bar.foreground
            outline: true

            PanelSlider {
              id: temperatureSlider
              bar: root.bar
              anchors.fill: parent
              anchors.leftMargin: Style.space(6)
              anchors.rightMargin: Style.space(6)
              minimum: root.minTemperature
              maximum: root.maxTemperature
              step: root.temperatureStep
              integer: true
              value: root.temperature
              onMoved: function(value) { root.previewTemperature(value) }
              onReleased: function(value) { root.commitTemperature(value) }
            }

            HoverHandler {
              onHoveredChanged: if (hovered) root.cursorActive = true
            }
          }
        }

        Text {
          visible: root.temperatureBackendAvailable
          text: root.minTemperature + "K warm  ·  " + root.maxTemperature + "K daylight"
          color: Qt.darker(root.bar.foreground, 1.6)
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.caption
          horizontalAlignment: Text.AlignHCenter
          width: parent.width
        }
      }
    }
  }
}
