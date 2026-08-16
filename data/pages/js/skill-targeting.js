;(function () {
  'use strict'

  // RED-59: this browser helper is a presentation-only adapter. It never
  // evaluates skill code or derives legality from range/faction heuristics.
  function getValidSkillTargets(battleState, _piece, _skill, preparation) {
    if (!battleState || !preparation || preparation.kind !== 'needTarget' || !Array.isArray(preparation.candidates)) {
      return []
    }

    const byId = new Map((battleState.pieces || []).map(piece => [piece.instanceId, piece]))
    return preparation.candidates.flatMap(ref => {
      if (ref.type === 'cell') return [{ x: ref.x, y: ref.y, kind: 'grid' }]
      if (ref.type !== 'piece') return []
      const piece = byId.get(ref.pieceId)
      if (!piece || piece.currentHp <= 0 || piece.x == null || piece.y == null) return []
      return [{ x: piece.x, y: piece.y, kind: 'piece', pieceId: piece.instanceId }]
    })
  }

  // Legacy movement helper retained for callers outside RED-59. Target
  // legality must never use this function.
  function getReachableCells(battleState, piece) {
    const moveRange = piece.moveRange != null ? piece.moveRange : 3
    const blocked = new Set(
      battleState.pieces
        .filter(candidate => candidate.instanceId !== piece.instanceId && candidate.currentHp > 0)
        .map(candidate => candidate.x + ',' + candidate.y)
    )
    const tileMap = {}
    for (const tile of battleState.map.tiles) tileMap[tile.x + ',' + tile.y] = tile

    const visited = new Set([piece.x + ',' + piece.y])
    const queue = [{ x: piece.x, y: piece.y, steps: 0 }]
    const results = []
    while (queue.length) {
      const current = queue.shift()
      if (current.steps > 0) results.push({ x: current.x, y: current.y })
      if (current.steps >= moveRange) continue
      for (const delta of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const x = current.x + delta[0]
        const y = current.y + delta[1]
        const key = x + ',' + y
        if (visited.has(key)) continue
        visited.add(key)
        const tile = tileMap[key]
        if (!tile || !tile.props || !tile.props.walkable || blocked.has(key)) continue
        queue.push({ x, y, steps: current.steps + 1 })
      }
    }
    return results
  }

  window.RvBTargeting = { getValidSkillTargets, getReachableCells }
})()
