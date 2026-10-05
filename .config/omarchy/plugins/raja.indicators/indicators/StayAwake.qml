import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui

BarIndicator {
  id: root

  readonly property string stateDir: Quickshell.env("HOME") + "/.local/state/omarchy/indicators"
  readonly property string statePath: stateDir + "/stay-awake"
  property bool stayAwake: false

  active: stayAwake
  activeText: "󰅶"
  inactiveText: "󰅶"
  activeTooltipText: "Allow Idle Lock & Screensaver"
  inactiveTooltipText: "Stay Awake"

  function refresh() {
    if (!stateProbe.running) stateProbe.running = true
  }

  function toggle() {
    if (toggleProcess.running) return
    toggleProcess.command = ["omarchy", "toggle", "idle", root.active ? "allow-idle" : "stay-awake"]
    toggleProcess.running = true
  }

  Process {
    id: stateProbe
    command: ["bash", "-c", "[[ -f $HOME/.local/state/omarchy/indicators/stay-awake ]] && echo yes || echo no"]
    stdout: SplitParser { onRead: function(line) { root.stayAwake = String(line).trim() === "yes" } }
  }

  Process {
    id: toggleProcess
    onExited: root.refresh()
  }

  FileView {
    path: root.stateDir
    watchChanges: true
    printErrors: false
    onFileChanged: root.refresh()
  }

  Component.onCompleted: root.refresh()
  onPressed: function() { root.toggle() }
}
