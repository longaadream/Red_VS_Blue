;(function (root) {
  'use strict'

  function numberOr(value, fallback) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback
  }

  function finiteOrNull(value) {
    return value != null && value !== '' && Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : null
  }

  function firstNumber(values, fallback) {
    for (let index = 0; index < values.length; index += 1) {
      if (values[index] !== null && values[index] !== undefined && Number.isFinite(Number(values[index]))) {
        return Number(values[index])
      }
    }
    return fallback
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
    if (typeof status === 'string') return status
    return String(status.name || status.type || status.id || '?')
  }

  function normalizeStatuses(piece, visibleTags) {
    const statuses = []
    const seen = new Set()
    const tags = visibleTags !== undefined ? visibleTags : piece.statusTags
    ;[].concat(tags || [], piece.buffs || [], piece.debuffs || []).forEach(function (status) {
      if (!status) return
      const item = typeof status === 'string' ? { id: status, name: status } : status
      const iconRegistry = root.BattleEffectIcons
      const meta = iconRegistry && typeof iconRegistry.resolveStatus === 'function'
        ? iconRegistry.resolveStatus(item)
        : null
      if (item.visible === false || (meta && meta.visibility === 'hidden')) return
      const id = String(item.id || item.type || item.name || statusLabel(item))
      const type = String(item.type || item.id || item.name || id)
      const key = id + ':' + String(item.sourceId || '')
      if (seen.has(key)) return
      seen.add(key)
      statuses.push({
        id: id,
        type: type,
        label: String(item.name || item.label || (meta && meta.label) || statusLabel(item)),
        description: String(item.description || item.message || ''),
        iconId: meta ? meta.iconId : 'fallback',
        iconPath: meta ? meta.assetPath : 'images/effect-icons/fallback.svg',
        category: meta ? meta.category : 'unknown',
        tone: meta ? meta.tone : 'neutral',
        color: meta ? meta.color : '#94a3b8',
        visibility: meta ? meta.visibility : 'detail',
        stacks: firstNumber([item.stacks], 0),
        duration: firstNumber([
          item.remainingDuration,
          item.currentDuration,
          item.remainingTurns,
          item.duration,
        ], 0),
        uses: firstNumber([item.remainingUses, item.currentUses], 0),
        intensity: firstNumber([item.intensity], 0),
      })
    })
    return statuses
  }

  function normalizePiece(piece, context) {
    const rawPieces = context.rawPieces || []
    const template = (context.pieceTemplates || {})[piece.templateId] || {}
    const master = piece.masterPieceId && rawPieces.find(function (candidate) {
      return candidate.instanceId === piece.masterPieceId && candidate.currentHp > 0
    })
    const currentHealth = Math.max(0, firstNumber([
      master && master.currentHp,
      piece.displayCurrentHp,
      piece.currentHp,
    ], 0))
    const maxHealth = Math.max(1, firstNumber([
      master && (master.maxHp || (master.stats && master.stats.maxHp)),
      piece.displayMaxHp,
      piece.maxHp,
      piece.stats && piece.stats.maxHp,
      currentHealth,
    ], 1))
    const ownerPlayerId = String(piece.ownerPlayerId || '')
    const statuses = normalizeStatuses(
      piece,
      piece.displayStatusTags !== undefined ? piece.displayStatusTags : piece.statusTags,
    )
    return {
      id: String(piece.instanceId || piece.id || ''),
      templateId: String(piece.templateId || ''),
      portraitId: String(template.image || piece.templateId || ''),
      name: String(piece.name || template.name || piece.templateId || piece.instanceId || '?'),
      ownerPlayerId: ownerPlayerId,
      faction: piece.faction === 'blue' ? 'blue' : 'red',
      x: piece.x == null ? null : numberOr(piece.x, 0),
      y: piece.y == null ? null : numberOr(piece.y, 0),
      health: { current: currentHealth, max: maxHealth },
      visible: piece.visible !== false && currentHealth > 0,
      alive: piece.currentHp > 0,
      statuses: statuses,
      statusSummary: statuses,
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

  function normalizeSkillSummaries(value) {
    const summaries = {}
    Object.keys(value || {}).forEach(function (key) {
      const skill = value[key]
      if (!skill || typeof skill !== 'object') return
      const id = String(skill.id || key)
      const summary = {
        id: id,
        name: String(skill.name || id),
      }
      summaries[String(key)] = summary
      summaries[id] = summary
    })
    return summaries
  }

  const PRESENTATION_CUES = new Set(['directional', 'projectile', 'area', 'displacement', 'summon'])
  const PRESENTATION_END_REASONS = new Set(['hit', 'blocked', 'boundary', 'range-expired', 'resolved'])
  const PRESENTATION_COLLISIONS = new Set(['piece', 'terrain', 'boundary'])

  function normalizePresentationPoint(value) {
    if (!value || !Number.isFinite(Number(value.x)) || !Number.isFinite(Number(value.y))) return null
    return { x: Number(value.x), y: Number(value.y) }
  }

  function normalizePresentationPoints(value) {
    return (Array.isArray(value) ? value : []).flatMap(function (point) {
      const normalized = normalizePresentationPoint(point)
      return normalized ? [normalized] : []
    })
  }

  function normalizePresentation(value) {
    if (!value || typeof value !== 'object' || !PRESENTATION_CUES.has(String(value.cue || ''))) return null
    const selectedCell = normalizePresentationPoint(value.selectedCell)
    const endPoint = normalizePresentationPoint(value.endPoint)
    const endReason = PRESENTATION_END_REASONS.has(String(value.endReason || ''))
      ? String(value.endReason)
      : null
    const collisions = (Array.isArray(value.collisions) ? value.collisions : []).flatMap(function (collision) {
      const point = normalizePresentationPoint(collision)
      const kind = String(collision && collision.kind || '')
      if (!point || !PRESENTATION_COLLISIONS.has(kind)) return []
      return [{
        kind: kind,
        x: point.x,
        y: point.y,
        pieceId: collision.pieceId ? String(collision.pieceId) : null,
        terrainType: collision.terrainType ? String(collision.terrainType) : null,
        blocking: collision.blocking === true,
      }]
    })
    return {
      cue: String(value.cue),
      ...(selectedCell ? { selectedCell: selectedCell } : {}),
      pathCells: normalizePresentationPoints(value.pathCells),
      ...(endPoint ? { endPoint: endPoint } : {}),
      ...(endReason ? { endReason: endReason } : {}),
      collisions: collisions.map(function (collision) {
        const normalized = {
          kind: collision.kind,
          x: collision.x,
          y: collision.y,
          blocking: collision.blocking,
        }
        if (collision.pieceId) normalized.pieceId = collision.pieceId
        if (collision.terrainType) normalized.terrainType = collision.terrainType
        return normalized
      }),
      areaCells: normalizePresentationPoints(value.areaCells),
    }
  }

  function normalizePresentationEvents(value) {
    if (!Array.isArray(value)) return []
    return value.flatMap(function (event) {
      if (!event || typeof event !== 'object' || !event.eventId || !event.rootEventId || !event.kind) return []
      return [{
        eventId: String(event.eventId),
        rootEventId: String(event.rootEventId),
        parentEventId: event.parentEventId ? String(event.parentEventId) : null,
        actionId: String(event.actionId || ''),
        sequence: numberOr(event.sequence, 0),
        kind: String(event.kind),
        iconId: String(event.iconId || 'fallback'),
        actorPlayerId: event.actorPlayerId ? String(event.actorPlayerId) : null,
        sourcePieceId: event.sourcePieceId ? String(event.sourcePieceId) : null,
        skillId: event.skillId ? String(event.skillId) : null,
        cardId: event.cardId ? String(event.cardId) : null,
        ruleId: event.ruleId ? String(event.ruleId) : null,
        targetPieceIds: Array.isArray(event.targetPieceIds) ? event.targetPieceIds.map(String) : [],
        targetPlayerIds: Array.isArray(event.targetPlayerIds) ? event.targetPlayerIds.map(String) : [],
        targetCell: event.targetCell && Number.isFinite(Number(event.targetCell.x)) && Number.isFinite(Number(event.targetCell.y))
          ? { x: Number(event.targetCell.x), y: Number(event.targetCell.y) }
          : null,
        statusId: event.statusId ? String(event.statusId) : null,
        statusType: event.statusType ? String(event.statusType) : null,
        result: event.result && typeof event.result === 'object' ? Object.assign({}, event.result) : null,
        presentation: normalizePresentation(event.presentation),
        priority: numberOr(event.priority, 0),
        skippable: event.skippable !== false,
      }]
    }).sort(function (left, right) { return left.sequence - right.sequence })
  }

  function create(options) {
    const input = options || {}
    const interaction = input.interaction || {}
    const snapshot = input.snapshot || {}
    const map = snapshot.map || { width: 0, height: 0, tiles: [] }
    const turn = snapshot.turn || {}
    const viewerId = String(input.viewerId || '')
    const rawPieces = snapshot.pieces || []
    const pieceContext = {
      rawPieces: rawPieces,
      pieceTemplates: input.pieceTemplates || {},
    }
    const pieces = rawPieces.map(function (piece) { return normalizePiece(piece, pieceContext) })
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
      skillSummariesById: normalizeSkillSummaries(input.skillsById || snapshot.skillsById),
      presentationEvents: normalizePresentationEvents(input.presentationEvents),
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
      interaction: {
        pendingPieceId: interaction.pendingPieceId || null,
        pendingCommandId: interaction.pendingCommandId || null,
        selectedTargetPieceIds: Array.isArray(interaction.selectedTargetPieceIds)
          ? interaction.selectedTargetPieceIds.map(String)
          : [],
      },
      legal: {
        moveCells: normalizeCells(legal.moveCells),
        targetCells: normalizeCells(legal.targetCells),
        placementCells: normalizeCells(legal.placementCells),
      },
    }
  }

  root.BattleViewModel = {
    create: create,
    normalizeCells: normalizeCells,
    normalizeSkillSummaries: normalizeSkillSummaries,
    normalizePresentationEvents: normalizePresentationEvents,
  }
})(typeof window !== 'undefined' ? window : globalThis)
