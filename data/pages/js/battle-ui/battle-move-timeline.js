(function (root) {
  'use strict'

  // Presentation timing only: the authoritative route is never changed here.
  function build(points) {
    const legs = []
    let distance = 0
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1]
      const to = points[index]
      const dx = to.x - from.x
      const dy = to.y - from.y
      const length = Math.hypot(dx, dy)
      if (!length) continue
      const previous = legs[legs.length - 1]
      const directionX = dx / length
      const directionY = dy / length
      if (previous && Math.abs(previous.dx - directionX) < 0.0001 && Math.abs(previous.dy - directionY) < 0.0001) {
        previous.length += length
      } else {
        legs.push({ dx: directionX, dy: directionY, length: length, startDistance: distance })
      }
      distance += length
    }
    let durationMs = 0
    legs.forEach(function (leg) {
      leg.startMs = durationMs
      leg.durationMs = Math.min(200, 120 + Math.max(0, leg.length - 1) * 12)
      durationMs += leg.durationMs
    })
    return { legs: legs, durationMs: durationMs }
  }

  function eventDuration(event) {
    if (!event || !['move', 'forceMove'].includes(event.kind)) return 0
    const result = event.result || {}
    if (result.movementKind && result.movementKind !== 'walk') return 0
    const path = event.presentation && event.presentation.pathCells
    if (!Array.isArray(path) || !Number.isFinite(result.fromX) || !Number.isFinite(result.fromY)) return 0
    return build([{ x: result.fromX, y: result.fromY }].concat(path)).durationMs
  }

  root.BattleMoveTimeline = { build: build, eventDuration: eventDuration }
})(typeof window !== 'undefined' ? window : globalThis)
