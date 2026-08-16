;(function (root) {
  'use strict'

  function numberOr(value, fallback) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback
  }

  function finiteOrNull(value) {
    return value != null && value !== '' && Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : null
  }

  function cellKey(x, y) {
    return numberOr(x, 0) + ',' + numberOr(y, 0)
  }

  function normalizeCells(value) {
    const cells = []
    const seen = new Set()
    const entries = Array.isArray(value)
      ? value
      : (value && typeof value.forEach === 'function' ? Array.from(value) : [])
    entries.forEach(function (entry) {
      let x
      let y
      if (typeof entry === 'string') {
        const parts = entry.split(',')
        x = Number(parts[0])
        y = Number(parts[1])
      } else if (entry && typeof entry === 'object') {
        x = Number(entry.x)
        y = Number(entry.y !== undefined ? entry.y : entry.z)
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) return
      const key = cellKey(x, y)
      if (seen.has(key)) return
      seen.add(key)
      cells.push({ x: x, y: y })
    })
    cells.sort(function (left, right) { return left.y - right.y || left.x - right.x })
    return cells
  }

  function statusLabel(status) {
    return String(status.name || status.type || status.id || '?')
  }

  function normalizeStatuses(piece) {
    const statuses = []
    const seen = new Set()
    ;[].concat(piece.statusTags || [], piece.buffs || [], piece.debuffs || []).forEach(function (status) {
      if (!status || status.visible === false) return
      const id = String(status.id || status.type || status.name || statusLabel(status))
      const key = id + ':' + String(status.sourceId || '')
      if (seen.has(key)) return
      seen.add(key)
      statuses.push({
        id: id,
        label: statusLabel(status),
        stacks: numberOr(status.stacks, 0),
        duration: numberOr(status.duration, 0),
      })
    })
    return statuses
  }

  function pieceMaxHealth(piece) {
    return Math.max(1, numberOr(piece.maxHp, numberOr(piece.stats && piece.stats.maxHp, numberOr(piece.currentHp, 1))))
  }

  function normalizePiece(piece) {
    const currentHealth = Math.max(0, numberOr(piece.currentHp, 0))
    return {
      id: String(piece.instanceId || piece.id || ''),
      templateId: String(piece.templateId || ''),
      portraitId: String(piece.templateId || ''),
      name: String(piece.name || piece.templateId || piece.instanceId || '?'),
      ownerPlayerId: String(piece.ownerPlayerId || ''),
      faction: piece.faction === 'blue' ? 'blue' : 'red',
      x: piece.x == null ? null : numberOr(piece.x, 0),
      y: piece.y == null ? null : numberOr(piece.y, 0),
      health: { current: currentHealth, max: pieceMaxHealth(piece) },
      visible: piece.visible !== false && currentHealth > 0,
      statusSummary: normalizeStatuses(piece),
    }
  }

  function normalizeTile(tile) {
    const props = tile.props || {}
    return {
      id: String(tile.id || cellKey(tile.x, tile.y)),
      x: numberOr(tile.x, 0),
      y: numberOr(tile.y, 0),
      type: String(props.type || tile.type || 'floor'),
      walkable: props.walkable !== false,
    }
  }

  function normalizePlayer(player, pieces, currentPlayerId) {
    const id = String(player.playerId || player.id || '')
    const ownedPiece = pieces.find(function (piece) { return piece.ownerPlayerId.toLowerCase() === id.toLowerCase() })
    return {
      id: id,
      name: String(player.name || id),
      faction: ownedPiece ? ownedPiece.faction : 'red',
      isCurrent: id.toLowerCase() === String(currentPlayerId || '').toLowerCase(),
      resources: {
        action: numberOr(player.actionPoints, 0),
        maxAction: numberOr(player.maxActionPoints, 0),
        charge: numberOr(player.chargePoints, 0),
        maxCharge: numberOr(player.maxChargePoints, numberOr(player.maxCharge, 0)),
      },
      statusSummary: normalizeStatuses(player),
    }
  }

  function normalizeEffect(effect, index) {
    return {
      id: String(effect.id || effect.instanceId || effect.effectId || ('effect-' + index)),
      type: String(effect.tileType || effect.type || 'effect'),
      icon: String(effect.icon || ''),
      x: numberOr(effect.x, 0),
      y: numberOr(effect.y, 0),
    }
  }

  function create(options) {
    const input = options || {}
    const snapshot = input.snapshot || {}
    const map = snapshot.map || { width: 0, height: 0, tiles: [] }
    const pieces = (snapshot.pieces || []).map(normalizePiece)
    const turn = snapshot.turn || {}
    const turnTimer = (snapshot.extensions && snapshot.extensions.turnTimer) || {}
    const remainingSeconds = [
      turn.remainingSeconds,
      turn.remainingTimeSeconds,
      turnTimer.remainingSeconds,
    ].map(finiteOrNull).find(function (value) { return value != null })
    const selectedPieceId = input.selectedPieceId || null
    const selectedPiece = selectedPieceId
      ? pieces.find(function (piece) { return piece.id === selectedPieceId }) || null
      : null
    const legal = input.legal || {}
    const viewerId = String(input.viewerId || '')
    const players = (snapshot.players || []).map(function (player) {
      return normalizePlayer(player, pieces, turn.currentPlayerId)
    })
    const viewer = players.find(function (player) { return player.id.toLowerCase() === viewerId.toLowerCase() }) || null

    return {
      board: {
        id: String(map.id || ''),
        width: numberOr(map.width, 0),
        height: numberOr(map.height, 0),
        tiles: (map.tiles || []).map(normalizeTile),
      },
      pieces: pieces,
      effects: ((snapshot.extensions && snapshot.extensions.tileEffects) || []).map(normalizeEffect),
      players: players,
      viewer: viewer,
      turn: {
        currentPlayerId: String(turn.currentPlayerId || ''),
        number: numberOr(turn.turnNumber, 1),
        phase: String(turn.phase || ''),
        remainingSeconds: remainingSeconds == null ? null : remainingSeconds,
        isViewerTurn: !!viewerId && String(turn.currentPlayerId || '').toLowerCase() === viewerId.toLowerCase(),
      },
      selection: {
        pieceId: selectedPiece ? selectedPiece.id : null,
        piece: selectedPiece,
        mode: String(input.interactionMode || 'inspect'),
      },
      legal: {
        moveCells: normalizeCells(legal.moveCells),
        targetCells: normalizeCells(legal.targetCells),
        placementCells: normalizeCells(legal.placementCells),
      },
    }
  }

  root.BattleViewModel = { create: create, normalizeCells: normalizeCells }
})(typeof window !== 'undefined' ? window : globalThis)
