import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "raja.system-stats"

  property string memoryAvailableText: "—"
  property string diskFreeText: "—"

  implicitWidth: statsRow.implicitWidth
  implicitHeight: statsRow.implicitHeight

  function finiteInteger(value) {
    return Number.isFinite(value) && value >= 0 && Math.floor(value) === value
  }

  function refreshMemory() {
    if (!memoryProcess.running) memoryProcess.running = true
  }

  function updateDiskFree(raw) {
    var lines = String(raw || "").trim().split("\n")
    if (lines.length < 2) return
    var fields = lines[lines.length - 1].trim().split(/\s+/)
    if (fields.length < 6) return

    var availableKiB = Number(fields[3])
    if (!finiteInteger(availableKiB)) return
    // Keep the disk label within the same two-slot status width as CPU/RAM.
    diskFreeText = Math.round(availableKiB / 1048576) + "G"
  }

  function updateMemory(raw) {
    var availableKiB = Number(String(raw || "").trim())
    if (!finiteInteger(availableKiB)) return
    memoryAvailableText = (availableKiB / 1048576).toFixed(1) + "G"
  }

  Process {
    id: memoryProcess
    command: [
      "awk",
      "$1 == \"MemAvailable:\" { print $2; exit }",
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

  Process {
    id: diskProcess
    command: ["df", "-Pk", "/"]
    stdout: StdioCollector {
      id: diskOutput
      waitForEnd: true
      onStreamFinished: root.updateDiskFree(text)
    }
  }

  Timer {
    interval: 30000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: if (!diskProcess.running) diskProcess.running = true
  }

  // Keep RAM and disk as matching status buttons after CPU moves right.
  Row {
    id: statsRow
    spacing: 0

    BarIconButton {
      id: memoryButton
      bar: root.bar
      text: "󰘚 " + root.memoryAvailableText
      slotSize: glyphPaintedWidth + Style.space(24)
      tooltipText: "Available memory"
      onPressed: function(button) {
        if (button === Qt.MiddleButton) root.refreshMemory()
      }
    }

    // Match the 10px shared gap used between right-side status widgets.
    Item { width: Style.space(10); height: 1 }

    BarIconButton {
      id: diskButton
      bar: root.bar
      text: "󰋊 " + root.diskFreeText
      slotSize: glyphPaintedWidth + Style.space(24)
      tooltipText: "Available space on the root filesystem"
      onPressed: function(button) {
        if (button === Qt.MiddleButton && !diskProcess.running) diskProcess.running = true
      }
    }
  }
}
