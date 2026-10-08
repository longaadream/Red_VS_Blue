(function (root) {
  'use strict'

  function create(options) {
    const input = options || {}
    let timer = null
    let generation = 0
    let lastSnapshot = null
    let lastKey = ''
    function clear() {
      generation += 1
      if (timer !== null) clearTimeout(timer)
      timer = null
      lastSnapshot = null
      lastKey = ''
    }
    function request(snapshot, action, viewerId, accept) {
      const key = JSON.stringify(action)
      if (lastSnapshot === snapshot && lastKey === key) return
      clear()
      lastSnapshot = snapshot
      lastKey = key
      const version = generation
      // Only settle once a tile transition has paused. Pointer frames remain
      // visual-only, and cancelled/replaced paths cannot publish old results.
      timer = setTimeout(function () {
        timer = null
        if (version !== generation) return
        const result = input.engine.previewBattleAction(snapshot, action, viewerId)
        if (version === generation) accept(result)
      }, 90)
    }
    return { request: request, clear: clear }
  }
  root.BattleMovePreview = { create: create }
})(typeof window !== 'undefined' ? window : globalThis)
