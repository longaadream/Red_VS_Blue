;(function (root) {
  'use strict'

  const INTENT_TYPES = new Set([
    'select-piece',
    'clear-selection',
    'select-skill',
    'activate-cell',
    'inspect-piece',
    'confirm-target-selection',
    'cancel-target',
    'drop-piece',
    'viewport-change',
  ])

  function create(options) {
    const input = options || {}
    const renderer = input.renderer
    const domUi = input.domUi
    const historyUi = input.historyUi || null
    const vignetteUi = input.vignetteUi || null
    const onIntent = typeof input.onIntent === 'function' ? input.onIntent : function () {}
    let mounted = false
    let currentModel = null
    const historyBoards = new Map()
    const seenRoots = new Set()
    let historicalRoot = null
    let boardContainer = null
    let pendingBefore = null
    let historicalSelection = ''

    function boardCopy(model) {
      return JSON.parse(JSON.stringify({ board: model.board, pieces: model.pieces, effects: model.effects, turn: model.turn }))
    }

    function viewerBoards(model) {
      const viewerId = String(model && model.viewer && model.viewer.id || '')
      if (!historyBoards.has(viewerId)) historyBoards.set(viewerId, new Map())
      return historyBoards.get(viewerId)
    }

    function captureHistory(events, beforeModel) {
      if (!beforeModel || !beforeModel.board) return
      const fresh = (events || []).filter(function (event) { return !event.parentEventId && !seenRoots.has(event.rootEventId) })
      // A combined catch-up update does not prove the intermediate positions.
      if (fresh.length !== 1) return
      const boards = viewerBoards(beforeModel)
      if (!boards.has(fresh[0].rootEventId)) boards.set(fresh[0].rootEventId, boardCopy(beforeModel))
      while (boards.size > 20) boards.delete(boards.keys().next().value)
    }

    function setHistoricalBoard(rootId, events) {
      // Rebuilding emits resize, which can ask for an unavailable record again.
      // Returning to the live board must be idempotent before notifying listeners.
      if (!rootId && !historicalRoot) return null
      const saved = rootId && viewerBoards(currentModel).get(rootId)
      if (rootId && !saved) { setHistoricalBoard(null); return null }
      const key = rootId ? rootId + ':' + (events || []).map(function (e) { return e.eventId }).join(',') : ''
      if (key && key === historicalSelection) return saved
      historicalSelection = key
      historicalRoot = rootId || null
      if (boardContainer && boardContainer.ownerDocument) boardContainer.ownerDocument.body.classList.toggle('is-viewing-history', !!historicalRoot)
      if (!currentModel) return null
      const shown = saved ? Object.assign({}, currentModel, saved, {
        historyPreview: true, presentationEvents: [], selection: { mode: 'inspect', pieceId: null },
        interaction: {}, legal: { moveCells: [], targetCells: [], placementCells: [] },
      }) : currentModel
      if (renderer.showHistoricalBoard) renderer.showHistoricalBoard(shown)
      else renderer.update(shown)
      const cells = []
      ;(events || []).filter(function (event) { return event.kind !== 'concealed' }).forEach(function (event) {
        const result = event.result || {}
        const point = function (x, y) { return x != null && y != null && Number.isFinite(Number(x)) && Number.isFinite(Number(y)) }
        if ((event.kind === 'move' || event.kind === 'forceMove') && point(result.fromX, result.fromY) && point(result.toX, result.toY)) {
          cells.push({ x: result.fromX, y: result.fromY, role: 'source' }, { x: result.toX, y: result.toY, role: 'target', fromX: result.fromX, fromY: result.fromY })
        } else {
          if (event.targetCell) cells.push(Object.assign({ role: 'target' }, event.targetCell))
          ;(event.targetPieceIds || []).forEach(function (id) {
            const piece = saved && saved.pieces.find(function (p) { return p.id === id && p.visible !== false })
            if (piece) cells.push({ x: piece.x, y: piece.y, role: 'target' })
          })
        }
      })
      if (renderer.setHistoryHighlight) renderer.setHistoryHighlight(cells)
      ;(events || []).filter(function (e) { return e.kind === 'damage' || e.kind === 'heal' }).slice(0,8).forEach(function (event) {
        const piece = saved && saved.pieces.find(function (p) { return (event.targetPieceIds || []).includes(p.id) && p.visible !== false })
        if (piece && renderer.spawnFloater) renderer.spawnFloater(piece.x, piece.y,
          (event.kind === 'heal' ? '+' : '−') + Math.abs(Number(event.result && event.result.amount) || 0),
          event.kind === 'heal' ? '#a6c89c' : '#e3ac72', true, { kind: event.kind })
      })
      return saved
    }

    function guardHistoryInput(event) {
      if (!historicalRoot) return
      if (event.type === 'keydown' && event.key === 'Escape') {
        if (historyUi && historyUi.clearHighlight) historyUi.clearHighlight()
        event.preventDefault(); event.stopImmediatePropagation(); return
      }
      if (event.target && event.target.closest && event.target.closest('#actionHistoryDock')) return
      event.preventDefault(); event.stopImmediatePropagation()
    }

    function dispatch(intent) {
      if (!intent || !INTENT_TYPES.has(intent.type)) {
        throw new Error('Unsupported battle UI intent: ' + String(intent && intent.type))
      }
      if (intent.type === 'viewport-change' && vignetteUi && vignetteUi.resize) vignetteUi.resize()
      if (intent.type === 'viewport-change' && historyUi && historyUi.resize) historyUi.resize()
      if (!historicalRoot || intent.type === 'viewport-change') onIntent(intent)
    }

    if (domUi && typeof domUi.setOnIntent === 'function') domUi.setOnIntent(dispatch)

    function mount(mountOptions) {
      if (mounted) dispose()
      const mountInput = mountOptions || {}
      boardContainer = mountInput.boardContainer
      const doc = boardContainer && boardContainer.ownerDocument
      if (doc) ['pointerdown', 'click', 'contextmenu', 'keydown'].forEach(function (type) { doc.addEventListener(type, guardHistoryInput, true) })
      renderer.init({
        container: mountInput.boardContainer,
        floatLayer: mountInput.floatLayer || null,
        onIntent: dispatch,
      })
      if (historyUi && historyUi.mount) {
        historyUi.mount({
          element: mountInput.historyDock || null,
          setHistoryHighlight: function (cells) { return renderer.setHistoryHighlight(cells) },
          setHistoricalBoard: setHistoricalBoard,
        })
      }
      if (vignetteUi && vignetteUi.mount) {
        vignetteUi.mount({
          boardContainer: mountInput.boardContainer,
          floatLayer: mountInput.floatLayer || null,
          projectCell: function (x, y, elevation) { return renderer.projectCell(x, y, elevation) },
          showAreaFlash: function (cells) {
            if (!historicalRoot && renderer.showPresentationAreaFlash) renderer.showPresentationAreaFlash(cells)
          },
          clearAreaFlash: function () {
            if (renderer.clearPresentationAreaFlash) renderer.clearPresentationAreaFlash()
          },
          showPath: function (path) {
            if (!historicalRoot && renderer.showPresentationPath) renderer.showPresentationPath(path)
          },
          clearPath: function () {
            if (renderer.clearPresentationPath) renderer.clearPresentationPath()
          },
        })
      }
      mounted = true
    }

    function update(model) {
      if (!mounted || !model) return
      const previousViewer = currentModel && currentModel.viewer && currentModel.viewer.id
      const nextViewer = model.viewer && model.viewer.id
      const viewerChanged = currentModel && previousViewer !== nextViewer
      if (viewerChanged) {
        seenRoots.clear(); pendingBefore = null
        if (historyUi && historyUi.clearHighlight) historyUi.clearHighlight()
      }
      if (!viewerChanged) captureHistory(model.presentationEvents, pendingBefore || currentModel)
      pendingBefore = null
      ;(model.presentationEvents || []).filter(function (e) { return !e.parentEventId }).forEach(function (e) { seenRoots.add(e.rootEventId) })
      while (seenRoots.size > 200) seenRoots.delete(seenRoots.values().next().value)
      currentModel = model
      if (!historicalRoot) renderer.update(model)
      domUi.update(model)
      if (!historicalRoot && vignetteUi && vignetteUi.update) vignetteUi.update(model)
      if (historyUi && historyUi.update) historyUi.update(model)
    }

    function animateAction(action, previousModel, nextModel) {
      pendingBefore = previousModel && Object.assign(boardCopy(previousModel), { viewer: { id: previousModel.viewer && previousModel.viewer.id } })
      if (mounted && !historicalRoot && renderer.animateAction) renderer.animateAction(action, previousModel, nextModel)
    }

    function spawnFloater(x, y, text, color, big, options) {
      if (mounted && !historicalRoot && renderer.spawnFloater) renderer.spawnFloater(x, y, text, color, big, options)
    }

    function resize() {
      if (!mounted) return
      renderer.resize()
      if (vignetteUi && vignetteUi.resize) vignetteUi.resize()
      if (historyUi && historyUi.resize) historyUi.resize()
    }
    function resetView() { if (mounted && renderer.resetView) renderer.resetView() }
    function projectCell(x, y, elevation) { return renderer.projectCell(x, y, elevation) }
    function screenToCell(clientX, clientY) { return renderer.screenToCell(clientX, clientY) }

    function dispose() {
      if (!mounted) return
      if (historyUi && historyUi.dispose) historyUi.dispose()
      const doc = boardContainer && boardContainer.ownerDocument
      if (doc) ['pointerdown', 'click', 'contextmenu', 'keydown'].forEach(function (type) { doc.removeEventListener(type, guardHistoryInput, true) })
      renderer.dispose()
      domUi.dispose()
      if (vignetteUi && vignetteUi.dispose) vignetteUi.dispose()
      mounted = false
      currentModel = null
      historicalRoot = null; boardContainer = null; pendingBefore = null
      historyBoards.clear(); seenRoots.clear()
    }

    return {
      mount: mount,
      update: update,
      animateAction: animateAction,
      spawnFloater: spawnFloater,
      dispatch: dispatch,
      resize: resize,
      resetView: resetView,
      projectCell: projectCell,
      screenToCell: screenToCell,
      dispose: dispose,
      getModel: function () { return currentModel },
      captureHistory: captureHistory,
    }
  }

  root.BattlePresentation = { create: create, intentTypes: INTENT_TYPES }
})(typeof window !== 'undefined' ? window : globalThis)
