import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "raja.system-stats"

  property string memoryUsedText: "—"

  implicitWidth: statsRow.implicitWidth
  implicitHeight: statsRow.implicitHeight

  function finiteInteger(value) {
    return Number.isFinite(value) && value >= 0 && Math.floor(value) === value
  }

  function refreshMemory() {
    if (!memoryProcess.running) memoryProcess.running = true
  }

  function updateMemory(raw) {
    var usedKiB = Number(String(raw || "").trim())
    if (!finiteInteger(usedKiB)) return
    memoryUsedText = (usedKiB / 1048576).toFixed(1) + "G"
  }

  Process {
    id: memoryProcess
    command: [
      "awk",
      "$1 == \"MemTotal:\" { total = $2 } $1 == \"MemAvailable:\" { available = $2 } END { if (total >= available) print total - available }",
      "/proc/meminfo"
    ]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.updateMemory(text)
    }
  }

  Timer {
    interval: 2000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refreshMemory()
  }

  // Keep memory as a compact status button after CPU moves right.
  Row {
    id: statsRow
    spacing: 0

    BarIconButton {
      id: memoryButton
      bar: root.bar
      text: "󰘚 " + root.memoryUsedText
      slotSize: glyphPaintedWidth + Style.space(24)
      tooltipText: "Used memory"
      onPressed: function(button) {
        if (button === Qt.MiddleButton) root.refreshMemory()
      }
    }
  }
}
