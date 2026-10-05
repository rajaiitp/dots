import QtQuick
import Quickshell.Io
import qs.Ui

BarIndicator {
  id: root

  property bool nightlightEnabled: false

  active: nightlightEnabled
  activeText: "󰔎"
  inactiveText: "󰔎"
  activeTooltipText: "Day Light"
  inactiveTooltipText: "Night Light"

  function refresh() {
    if (!stateProbe.running) stateProbe.running = true
  }

  function update(raw) {
    var data = extractData(raw)
    nightlightEnabled = data.enabled === true
  }

  function toggle() {
    if (!toggleProcess.running) toggleProcess.running = true
  }

  Process {
    id: stateProbe
    command: ["omarchy", "toggle", "nightlight", "--status"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.update(text)
    }
  }

  Process {
    id: toggleProcess
    command: ["omarchy", "toggle", "nightlight"]
    onExited: root.refresh()
  }

  Connections {
    target: root.indicatorHost
    ignoreUnknownSignals: true
    function onRefreshRequested() { root.refresh() }
  }

  Timer {
    interval: 5000
    repeat: true
    running: true
    onTriggered: root.refresh()
  }

  Component.onCompleted: root.refresh()
  onPressed: function() { root.toggle() }
}
