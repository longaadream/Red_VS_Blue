;(function (root) {
  'use strict'

  const INTENT_TYPES = new Set([
    'select-piece',
    'clear-selection',
    'select-skill',
    'activate-cell',
    'inspect-piece',
    'cancel-target',
    'toggle-move',
  ])

  function create(options) {
    const input = options || {}
    const renderer = input.renderer
    const domUi = input.domUi
    const onIntent = typeof input.onIntent === 'function' ? input.onIntent : function () {}
    let mounted = false
    let currentModel = null

    function dispatch(intent) {
      if (!intent || !INTENT_TYPES.has(intent.type)) {
        throw new Error('Unsupported battle UI intent: ' + String(intent && intent.type))
      }
      onIntent(intent)
    }

    function mount(mountOptions) {
      if (mounted) dispose()
      const mountInput = mountOptions || {}
      renderer.init({
        container: mountInput.boardContainer,
        floatLayer: mountInput.floatLayer || null,
        onIntent: dispatch,
      })
      mounted = true
    }

    function update(model) {
      if (!mounted || !model) return
      currentModel = model
      renderer.update(model)
      domUi.update(model)
    }

    function animateAction(action, previousModel, nextModel) {
      if (mounted && renderer.animateAction) renderer.animateAction(action, previousModel, nextModel)
    }

    function spawnFloater(x, y, text, color, big) {
      if (mounted && renderer.spawnFloater) renderer.spawnFloater(x, y, text, color, big)
    }

    function resize() { if (mounted) renderer.resize() }
    function resetView() { if (mounted && renderer.resetView) renderer.resetView() }
    function projectCell(x, y, elevation) { return renderer.projectCell(x, y, elevation) }
    function screenToCell(clientX, clientY) { return renderer.screenToCell(clientX, clientY) }

    function dispose() {
      if (!mounted) return
      renderer.dispose()
      domUi.dispose()
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
