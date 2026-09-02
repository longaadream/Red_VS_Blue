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

    function dispatch(intent) {
      if (!intent || !INTENT_TYPES.has(intent.type)) {
        throw new Error('Unsupported battle UI intent: ' + String(intent && intent.type))
      }
      if (intent.type === 'viewport-change' && vignetteUi && vignetteUi.resize) vignetteUi.resize()
      if (intent.type === 'viewport-change' && historyUi && historyUi.resize) historyUi.resize()
      onIntent(intent)
    }

    if (domUi && typeof domUi.setOnIntent === 'function') domUi.setOnIntent(dispatch)

    function mount(mountOptions) {
      if (mounted) dispose()
      const mountInput = mountOptions || {}
      renderer.init({
        container: mountInput.boardContainer,
        floatLayer: mountInput.floatLayer || null,
        onIntent: dispatch,
      })
      if (historyUi && historyUi.mount) {
        historyUi.mount({
          element: mountInput.historyDock || null,
          setHistoryHighlight: function (cells) { return renderer.setHistoryHighlight(cells) },
        })
      }
      if (vignetteUi && vignetteUi.mount) {
        vignetteUi.mount({
          boardContainer: mountInput.boardContainer,
          floatLayer: mountInput.floatLayer || null,
          projectCell: function (x, y, elevation) { return renderer.projectCell(x, y, elevation) },
          showAreaFlash: function (cells) {
            if (renderer.showPresentationAreaFlash) renderer.showPresentationAreaFlash(cells)
          },
          clearAreaFlash: function () {
            if (renderer.clearPresentationAreaFlash) renderer.clearPresentationAreaFlash()
          },
          showPath: function (path) {
            if (renderer.showPresentationPath) renderer.showPresentationPath(path)
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
      currentModel = model
      renderer.update(model)
      domUi.update(model)
      if (vignetteUi && vignetteUi.update) vignetteUi.update(model)
      if (historyUi && historyUi.update) historyUi.update(model)
    }

    function animateAction(action, previousModel, nextModel) {
      if (mounted && renderer.animateAction) renderer.animateAction(action, previousModel, nextModel)
    }

    function spawnFloater(x, y, text, color, big, options) {
      if (mounted && renderer.spawnFloater) renderer.spawnFloater(x, y, text, color, big, options)
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
      renderer.dispose()
      domUi.dispose()
      if (vignetteUi && vignetteUi.dispose) vignetteUi.dispose()
      if (historyUi && historyUi.dispose) historyUi.dispose()
      mounted = false
      currentModel = null
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
    }
  }

  root.BattlePresentation = { create: create, intentTypes: INTENT_TYPES }
})(typeof window !== 'undefined' ? window : globalThis)
