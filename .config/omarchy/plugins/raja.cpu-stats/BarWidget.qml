import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "raja.cpu-stats"

  // CPU counters are jiffies across user, nice, system, idle, iowait, irq,
  // softirq, and steal. Guest counters are intentionally excluded.
  property double previousCpuTotal: -1
  property double previousCpuIdle: -1
  property string cpuUsageText: "—"

  implicitWidth: cpuButton.implicitWidth
  implicitHeight: cpuButton.implicitHeight

  function finiteInteger(value) {
    return Number.isFinite(value) && value >= 0 && Math.floor(value) === value
  }

  function refresh() {
    if (!cpuProcess.running) cpuProcess.running = true
  }

  function updateCpu(raw) {
    var fields = String(raw || "").trim().split(/\s+/)
    if (fields.length !== 2) return

    var total = Number(fields[0])
    var idle = Number(fields[1])
    if (!finiteInteger(total) || !finiteInteger(idle) || total <= 0 || idle > total) return

    // CPU needs two valid monotonic samples. Keep the em dash on the first.
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
    id: cpuProcess
    command: [
      "awk",
      "$1 == \"cpu\" { total = 0; for (i = 2; i <= 9; i++) total += $i; idle = $5 + $6; if (total > 0 && idle >= 0) printf \"%.0f %.0f\\n\", total, idle; exit }",
      "/proc/stat"
    ]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.updateCpu(text)
    }
  }

  Timer {
    interval: 2000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  // This is the same two-slot status-button template used before the split.
  BarIconButton {
    id: cpuButton
    bar: root.bar
    text: "󰍛 " + root.cpuUsageText
    slotSize: glyphPaintedWidth + Style.space(24)
    tooltipText: "CPU utilization"
    onPressed: function(button) {
      if (button === Qt.MiddleButton) root.refresh()
    }
  }
}
