import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "raja.system-stats"

  // CPU counters are jiffies across user, nice, system, idle, iowait, irq,
  // softirq, and steal. Guest counters are intentionally excluded.
  property double previousCpuTotal: -1
  property double previousCpuIdle: -1
  property string cpuUsageText: "—"
  property string memoryAvailableText: "—"
  property string diskFreeText: "—"

  implicitWidth: statsRow.implicitWidth
  implicitHeight: statsRow.implicitHeight

  function finiteInteger(value) {
    return Number.isFinite(value) && value >= 0 && Math.floor(value) === value
  }

  function refresh() {
    if (!statsProcess.running) statsProcess.running = true
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

  function updateStats(raw) {
    var fields = String(raw || "").trim().split(/\s+/)
    if (fields.length !== 3) return

    var total = Number(fields[0])
    var idle = Number(fields[1])
    var availableKiB = Number(fields[2])
    if (!finiteInteger(total) || !finiteInteger(idle) || !finiteInteger(availableKiB)
        || total <= 0 || idle > total) return

    // Memory may be displayed after the first valid sample. CPU requires two
    // monotonic samples, so do not invent a value during the initial probe.
    memoryAvailableText = (availableKiB / 1048576).toFixed(1) + "G"
    if (previousCpuTotal >= 0 && total > previousCpuTotal && idle >= previousCpuIdle) {
      var totalDelta = total - previousCpuTotal
      var idleDelta = idle - previousCpuIdle
      if (idleDelta <= totalDelta) {
        var usage = Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta)))
        cpuUsageText = Math.round(usage) + "%"
      }
    }

    previousCpuTotal = total
    previousCpuIdle = idle
  }

  Process {
    id: statsProcess
    command: [
      "awk",
      "FILENAME == \"/proc/stat\" && $1 == \"cpu\" { total = 0; for (i = 2; i <= 9; i++) total += $i; idle = $5 + $6; next } FILENAME == \"/proc/meminfo\" && $1 == \"MemAvailable:\" { available = $2 } END { if (total > 0 && idle >= 0 && available >= 0) printf \"%.0f %.0f %.0f\\n\", total, idle, available }",
      "/proc/stat",
      "/proc/meminfo"
    ]
    stdout: StdioCollector {
      id: statsOutput
      waitForEnd: true
      onStreamFinished: root.updateStats(text)
    }
  }

  Timer {
    interval: 2000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refresh()
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

  // Reuse the stock battery widget's status-button template: each metric is
  // a two-slot BarIconButton so glyph sizing, baseline, and spacing match it.
  Row {
    id: statsRow
    // Explicit spacers keep the visual gaps identical regardless of the
    // changing width of each live value.
    spacing: 0

    BarIconButton {
      id: cpuButton
      bar: root.bar
      text: "󰍛 " + root.cpuUsageText
      // Equal side padding around the actual painted text, independent of
      // how many digits the live metric currently has.
      slotSize: glyphPaintedWidth + Style.space(24)
      tooltipText: "CPU utilization"
      onPressed: function(button) {
        if (button === Qt.MiddleButton) root.refresh()
      }
    }

    Item { width: Style.space(20); height: 1 }

    BarIconButton {
      id: memoryButton
      bar: root.bar
      text: "󰘚 " + root.memoryAvailableText
      slotSize: glyphPaintedWidth + Style.space(24)
      tooltipText: "Available memory"
      onPressed: function(button) {
        if (button === Qt.MiddleButton) root.refresh()
      }
    }

    Item { width: Style.space(20); height: 1 }

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
