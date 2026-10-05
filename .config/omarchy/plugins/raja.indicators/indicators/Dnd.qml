import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui

BarIndicator {
  id: root

  readonly property string statePath: Quickshell.env("HOME") + "/.local/state/omarchy/notifications.json"
  property bool dnd: false

  active: dnd
  activeText: "󰂛"
  inactiveText: "󰂛"
  activeTooltipText: "Allow Notifications"
  inactiveTooltipText: "Silence Notifications"

  function refresh() {
    if (!stateProbe.running) stateProbe.running = true
  }

  function toggle() {
    if (!toggleProcess.running) toggleProcess.running = true
  }

  Process {
    id: stateProbe
    command: ["omarchy-shell", "notifications", "dndState"]
    stdout: SplitParser { onRead: function(line) { root.dnd = String(line).trim() === "on" } }
  }

  Process {
    id: toggleProcess
    command: ["omarchy", "toggle", "notification", "silencing"]
    onExited: root.refresh()
  }

  FileView {
    path: root.statePath
    watchChanges: true
    printErrors: false
    onFileChanged: root.refresh()
  }

  Connections {
    target: root.indicatorHost
    ignoreUnknownSignals: true
    function onRefreshRequested() { root.refresh() }
  }

  Component.onCompleted: root.refresh()
  onPressed: function() { root.toggle() }
}
