import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "omarchy.indicators"

  readonly property var defaultIndicatorEntries: [ "Dictation", "ScreenRecording", "Reminder", "NightLight", "Dnd", "StayAwake" ]
  readonly property var indicatorEntries: indicatorEntriesFromSettings(settings)
  property var activeIndicatorIds: []
  property var indicatorActiveStates: ({})
  property bool indicatorAreaHovered: false
  property bool indicatorItemHovered: false
  property bool indicatorDrawerExpanded: false
  readonly property bool alwaysShowIndicators: setting("alwaysShow", false) === true
  // On horizontal bars, inactive indicators are intentionally revealed only
  // from the dedicated chevron drawer. Retain the packaged hover behavior for
  // vertical bars, which do not have the horizontal drawer affordance.
  readonly property bool revealInactiveIndicators: alwaysShowIndicators || indicatorDrawerExpanded
    || (root.vertical && (indicatorAreaHovered || indicatorItemHovered
      || (bar && bar.centerSectionRevealHeld === true && bar.centerHoverRevealSuppressed !== true)))

  signal refreshRequested()

  ListModel { id: activeIndicatorModel }

  function entryId(entry) {
    if (typeof entry === "string") return entry
    if (Util.isPlainObject(entry)) {
      var id = entry["id"]
      if (id !== undefined && id !== null && String(id) !== "") return String(id)
    }
    return ""
  }

  function entrySettings(entry) {
    if (!Util.isPlainObject(entry)) return {}
    var copy = {}
    for (var key in entry) {
      if (key === "id") continue
      copy[key] = entry[key]
    }
    return copy
  }

  function indicatorEntriesFromSettings(settings) {
    var source = defaultIndicatorEntries
    if (settings.items && typeof settings.items.length === "number" && settings.items.length > 0) source = settings.items
    else if (settings.indicators && typeof settings.indicators.length === "number" && settings.indicators.length > 0) source = settings.indicators

    var result = []
    for (var i = 0; i < source.length; i++) {
      var item = source[i]
      if (typeof item !== "string" && item !== null && typeof item === "object") {
        try {
          item = JSON.parse(JSON.stringify(item))
        } catch (error) {
        }
      }
      var id = entryId(item)
      if (id !== "") result.push(item)
    }
    return result
  }

  function setIndicatorAreaHovered(hovered) {
    indicatorAreaHovered = hovered
    if (hovered) indicatorHideTimer.stop()
    else indicatorHideTimer.restart()
  }

  function setIndicatorItemHovered(hovered) {
    if (hovered) {
      indicatorItemHovered = true
      indicatorHideTimer.stop()
    } else {
      indicatorHideTimer.restart()
    }
  }

  function hasIndicatorId(id) {
    for (var i = 0; i < indicatorEntries.length; i++) {
      if (entryId(indicatorEntries[i]) === id) return true
    }
    return false
  }

  function entryForId(id) {
    for (var i = 0; i < indicatorEntries.length; i++) {
      var entry = indicatorEntries[i]
      if (entryId(entry) === id) return entry
    }

    return { id: id }
  }

  function activeModelIndex(id) {
    for (var i = 0; i < activeIndicatorModel.count; i++) {
      if (activeIndicatorModel.get(i).activeId === id) return i
    }
    return -1
  }

  function copyActiveStates() {
    var states = {}
    for (var id in indicatorActiveStates) {
      if (indicatorActiveStates[id] === true) states[id] = true
    }
    return states
  }

  function orderedActiveIds(states, preferredOrder) {
    var ids = []

    for (var i = 0; i < preferredOrder.length; i++) {
      var id = preferredOrder[i]
      if (ids.indexOf(id) === -1 && hasIndicatorId(id) && states[id] === true) ids.push(id)
    }

    return ids
  }

  function syncActiveIndicatorModel() {
    for (var i = activeIndicatorModel.count - 1; i >= 0; i--) {
      if (activeIndicatorIds.indexOf(activeIndicatorModel.get(i).activeId) === -1)
        activeIndicatorModel.remove(i)
    }

    for (var j = 0; j < activeIndicatorIds.length; j++) {
      var id = activeIndicatorIds[j]
      var index = activeModelIndex(id)
      if (index === -1) activeIndicatorModel.insert(j, { activeId: id })
      else if (index !== j) activeIndicatorModel.move(index, j, 1)
    }
  }

  function setIndicatorActive(entry, active) {
    var id = entryId(entry)
    if (id === "") return

    var states = copyActiveStates()
    if (active) states[id] = true
    else delete states[id]

    indicatorActiveStates = states

    // Use the configured indicator order in both the active row and the
    // inactive drawer, rather than the order in which status changes arrive.
    var configuredIds = []
    for (var i = 0; i < indicatorEntries.length; i++) configuredIds.push(entryId(indicatorEntries[i]))
    activeIndicatorIds = orderedActiveIds(states, configuredIds)
    syncActiveIndicatorModel()
  }

  function syncActiveIndicatorOrder() {
    activeIndicatorIds = orderedActiveIds(indicatorActiveStates, activeIndicatorIds)
    syncActiveIndicatorModel()
  }

  function refresh() { root.refreshRequested() }

  onIndicatorEntriesChanged: syncActiveIndicatorOrder()

  // With alwaysShow enabled, render one ordered block. On a horizontal bar,
  // the drawer wrapper owns the inactive area and its chevron as one unit.
  implicitWidth: root.vertical
    ? Math.max(root.alwaysShowIndicators ? 0 : activeVerticalBlock.implicitWidth, inactiveVerticalArea.implicitWidth)
    : horizontalIndicators.implicitWidth
  implicitHeight: root.vertical
    ? activeVerticalBlock.implicitHeight + inactiveVerticalArea.implicitHeight
    : horizontalIndicators.implicitHeight

  IpcHandler {
    target: "omarchy.indicators"

    function refresh(): void {
      root.broadcast("refresh")
    }
  }

  Timer {
    id: indicatorHideTimer
    interval: 120
    onTriggered: {
      if (!root.indicatorAreaHovered)
        root.indicatorItemHovered = false
    }
  }

  Component.onCompleted: root.refreshRequested()

  Row {
    id: horizontalIndicators

    visible: !root.vertical
    spacing: Style.space(10)

    // Keep the visual order stable: inactive items expand to the left of `<`,
    // and active items remain to its right.
    Item {
      id: inactiveIndicatorDrawer

      // Keep `<` available for this configured indicator group. A state may
      // temporarily report every item active while its service initializes.
      visible: root.alwaysShowIndicators || root.indicatorEntries.length > 0
      implicitWidth: inactiveHorizontalArea.implicitWidth
        + (indicatorDrawerChevron.visible ? indicatorDrawerChevron.implicitWidth : 0)
      implicitHeight: Math.max(inactiveHorizontalArea.implicitHeight, indicatorDrawerChevron.implicitHeight)
      width: implicitWidth
      height: implicitHeight
      onVisibleChanged: if (!visible) root.indicatorDrawerExpanded = false

      Item {
        id: inactiveHorizontalArea

        implicitWidth: root.revealInactiveIndicators ? inactiveHorizontalBlock.implicitWidth : 0
        implicitHeight: Math.max(inactiveHorizontalBlock.implicitHeight, root.barSize)
        width: implicitWidth
        height: implicitHeight
        clip: true

        // This block stays instantiated while clipped, so it continues to
        // observe inactive↔active transitions and feed the active row.
        IndicatorBlock {
          id: inactiveHorizontalBlock
          anchors.verticalCenter: parent.verticalCenter
          indicatorsModule: root
          indicatorEntries: root.indicatorEntries
          indicatorBlock: root.alwaysShowIndicators ? "single" : "inactive"
          horizontal: true
          reportActiveState: !root.vertical
        }
      }

      BarIconButton {
        id: indicatorDrawerChevron
        visible: !root.alwaysShowIndicators && root.indicatorEntries.length > 0
        x: inactiveHorizontalArea.width
        anchors.verticalCenter: parent.verticalCenter
        bar: root.bar
        text: "\uf053"
        tooltipText: "Inactive indicators"
      }

      // When collapsed this wrapper is exactly the chevron's size, preventing
      // the broad empty hover area that previously opened the drawer early.
      Item {
        id: indicatorDrawerHoverTarget
        anchors.fill: parent

        HoverHandler {
          enabled: indicatorDrawerChevron.visible
          onHoveredChanged: root.indicatorDrawerExpanded = hovered
        }
      }
    }

    ActiveIndicatorBlock {
      id: activeHorizontalBlock
      visible: !root.alwaysShowIndicators
      indicatorsModule: root
      indicatorModel: activeIndicatorModel
      horizontal: true
      reportActiveState: !root.vertical
    }
  }

  Connections {
    target: inactiveHorizontalBlock
    function onImplicitWidthChanged() {
      if (inactiveHorizontalBlock.implicitWidth === 0) root.indicatorDrawerExpanded = false
    }
  }

  Column {
    id: verticalIndicators

    visible: root.vertical
    spacing: 0

    HoverHandler {
      onHoveredChanged: root.setIndicatorAreaHovered(hovered)
    }

    Item {
      id: inactiveVerticalArea

      implicitWidth: Math.max(inactiveVerticalBlock.implicitWidth, root.barSize)
      implicitHeight: root.revealInactiveIndicators ? inactiveVerticalBlock.implicitHeight : 0
      width: implicitWidth
      height: implicitHeight
      clip: true

      IndicatorBlock {
        id: inactiveVerticalBlock
        anchors.horizontalCenter: parent.horizontalCenter
        indicatorsModule: root
        indicatorEntries: root.indicatorEntries
        indicatorBlock: root.alwaysShowIndicators ? "single" : "inactive"
        horizontal: false
        reportActiveState: root.vertical
      }

      HoverHandler {
        onHoveredChanged: root.setIndicatorAreaHovered(hovered)
      }
    }

    ActiveIndicatorBlock {
      id: activeVerticalBlock
      visible: !root.alwaysShowIndicators
      indicatorsModule: root
      indicatorModel: activeIndicatorModel
      horizontal: false
      reportActiveState: root.vertical
    }
  }

  HoverHandler {
    onHoveredChanged: root.setIndicatorAreaHovered(hovered)
  }

  component ActiveIndicatorBlock: Item {
    id: activeIndicatorBlockRoot

    property var indicatorModel: null
    property var indicatorsModule: null
    property bool horizontal: true
    property bool reportActiveState: false

    implicitWidth: blockLoader.item ? blockLoader.item.implicitWidth : 0
    implicitHeight: blockLoader.item ? blockLoader.item.implicitHeight : 0
    width: implicitWidth
    height: implicitHeight

    Loader {
      id: blockLoader

      anchors.centerIn: parent
      sourceComponent: activeIndicatorBlockRoot.horizontal ? horizontalActiveIndicatorBlock : verticalActiveIndicatorBlock
    }

    Component {
      id: horizontalActiveIndicatorBlock

      Row {
        spacing: Style.space(10)

        Repeater {
          model: activeIndicatorBlockRoot.indicatorModel

          IndicatorLoader {
            required property string activeId
            indicatorsModule: activeIndicatorBlockRoot.indicatorsModule
            entry: activeIndicatorBlockRoot.indicatorsModule.entryForId(activeId)
            indicatorBlock: "active"
            reportActiveState: activeIndicatorBlockRoot.reportActiveState
          }
        }
      }
    }

    Component {
      id: verticalActiveIndicatorBlock

      Column {
        spacing: 0

        Repeater {
          model: activeIndicatorBlockRoot.indicatorModel

          IndicatorLoader {
            required property string activeId
            indicatorsModule: activeIndicatorBlockRoot.indicatorsModule
            entry: activeIndicatorBlockRoot.indicatorsModule.entryForId(activeId)
            indicatorBlock: "active"
            reportActiveState: activeIndicatorBlockRoot.reportActiveState
          }
        }
      }
    }
  }

  component IndicatorBlock: Item {
    id: indicatorBlockRoot

    property var indicatorEntries: []
    property var indicatorsModule: null
    property string indicatorBlock: "active"
    property bool horizontal: true
    property bool reportActiveState: false

    implicitWidth: blockLoader.item ? blockLoader.item.implicitWidth : 0
    implicitHeight: blockLoader.item ? blockLoader.item.implicitHeight : 0
    width: implicitWidth
    height: implicitHeight

    Loader {
      id: blockLoader

      anchors.centerIn: parent
      sourceComponent: indicatorBlockRoot.horizontal ? horizontalIndicatorBlock : verticalIndicatorBlock
    }

    Component {
      id: horizontalIndicatorBlock

      Row {
        spacing: Style.space(10)

        Repeater {
          model: indicatorBlockRoot.indicatorEntries

          IndicatorLoader {
            required property var modelData
            indicatorsModule: indicatorBlockRoot.indicatorsModule
            entry: modelData
            indicatorBlock: indicatorBlockRoot.indicatorBlock
            reportActiveState: indicatorBlockRoot.reportActiveState
          }
        }
      }
    }

    Component {
      id: verticalIndicatorBlock

      Column {
        spacing: 0

        Repeater {
          model: indicatorBlockRoot.indicatorEntries

          IndicatorLoader {
            required property var modelData
            indicatorsModule: indicatorBlockRoot.indicatorsModule
            entry: modelData
            indicatorBlock: indicatorBlockRoot.indicatorBlock
            reportActiveState: indicatorBlockRoot.reportActiveState
          }
        }
      }
    }
  }

  component IndicatorLoader: Item {
    id: indicatorSlot

    required property var entry
    property var indicatorsModule: null
    required property string indicatorBlock
    property bool reportActiveState: false
    property bool activeStateObserved: false
    readonly property string indicatorId: root.entryId(entry)
    readonly property var indicatorSettings: root.entrySettings(entry)
    readonly property var barRef: root.bar

    implicitWidth: indicatorSource.item && indicatorSource.item.visible ? indicatorSource.item.implicitWidth : 0
    implicitHeight: indicatorSource.item && indicatorSource.item.visible ? indicatorSource.item.implicitHeight : 0
    width: implicitWidth
    height: implicitHeight
    onEntryChanged: {
      activeStateObserved = false
      injectProps()
      syncActiveState()
    }
    onIndicatorBlockChanged: injectProps()
    onIndicatorSettingsChanged: injectProps()
    onIndicatorsModuleChanged: {
      injectProps()
      syncActiveState()
    }
    onReportActiveStateChanged: syncActiveState()
    onBarRefChanged: injectProps()

    Loader {
      id: indicatorSource

      anchors.fill: parent
      source: indicatorSlot.indicatorId ? Qt.resolvedUrl("indicators/" + indicatorSlot.indicatorId + ".qml") : ""
      onLoaded: {
        indicatorSlot.injectProps()
        indicatorSlot.syncActiveState()
      }
      onStatusChanged: if (status === Loader.Error) console.warn("Indicator loader error", indicatorSlot.indicatorId, source)
    }

    Connections {
      target: indicatorSource.item
      ignoreUnknownSignals: true
      function onActiveChanged() { indicatorSlot.syncActiveState() }
    }

    function injectProps() {
      var target = indicatorSource.item
      if (!target) return
      if ("bar" in target) target.bar = root.bar
      if ("moduleName" in target) target.moduleName = indicatorId
      if ("settings" in target) target.settings = indicatorSettings
      if ("indicatorBlock" in target) target.indicatorBlock = indicatorBlock
      if ("indicatorHost" in target) target.indicatorHost = root
      // These indicators are permanently visible, so use the same full-size
      // BarIconButton geometry and glyph scale as the battery icon.
      if ("fontSize" in target) target.fontSize = Style.bar.iconFont
      if ("fixedWidth" in target) target.fixedWidth = target.vertical ? -1 : Style.bar.iconSlot
      if ("fixedHeight" in target) target.fixedHeight = target.vertical ? Style.bar.iconSlot : -1
      if ("horizontalMargin" in target) target.horizontalMargin = 8.5
      if ("verticalPadding" in target) target.verticalPadding = 6
      if ("activeOverride" in target) target.activeOverride = indicatorBlock === "active" ? true : null
    }

    function syncActiveState() {
      if (!reportActiveState || !indicatorsModule || !indicatorsModule.setIndicatorActive) return

      var active = !!indicatorSource.item && indicatorSource.item.active === true
      if (indicatorBlock === "active") {
        if (active) activeStateObserved = true
        else if (!activeStateObserved) return
      }

      indicatorsModule.setIndicatorActive(entry, active)
    }
  }
}
