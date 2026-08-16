;(function (root) {
  'use strict'

  function numberOr(value, fallback) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback
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
      if (!status || status.visible === false) return
      const item = typeof status === 'string' ? { id: status, name: status } : status
      const id = String(item.id || item.type || item.name || statusLabel(item))
      const key = id + ':' + String(item.sourceId || '')
      if (seen.has(key)) return
      seen.add(key)
      statuses.push({
        id: id,
        label: statusLabel(item),
        description: String(item.description || item.message || ''),
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

  function displayStats(piece, rawPieces) {
    const master = piece.masterPieceId && rawPieces.find(function (candidate) {
      return candidate.instanceId === piece.masterPieceId && candidate.currentHp > 0
    })
    const base = master ? (master.stats || master) : (piece.stats || piece)
    return {
      attack: firstNumber([piece.displayAttack, base.attack], 0),
      defense: firstNumber([piece.displayDefense, base.defense], 0),
      moveRange: firstNumber([piece.displayMoveRange, base.moveRange], 0),
    }
  }

  function displaySkills(piece, rawPieces) {
    const master = piece.masterPieceId && rawPieces.find(function (candidate) {
      return candidate.instanceId === piece.masterPieceId && candidate.currentHp > 0
    })
    if (master) return master.skills || []
    const base = piece.displaySkills !== undefined ? piece.displaySkills : (piece.skills || [])
    if (piece.displaySkills === undefined || !Array.isArray(piece.skills)) return base || []
    const ids = new Set((base || []).map(function (skill) {
      return String((skill && (skill.skillId || skill.id || skill.definitionId)) || skill || '')
    }))
    return (base || []).concat(piece.skills.filter(function (skill) {
      const id = String((skill && (skill.skillId || skill.id || skill.definitionId)) || skill || '')
      return id && !ids.has(id)
    }))
  }

  function skillId(skill) {
    if (!skill) return ''
    if (typeof skill === 'string') return skill
    return String(skill.skillId || skill.id || skill.definitionId || '')
  }

  function skillUnavailableReason(options) {
    const input = options || {}
    if (input.readOnly) return '敌方棋子仅可查看'
    if (!input.alive) return '棋子已阵亡'
    if (input.passive) return '被动技能'
    if (!input.isViewerTurn) return '当前不是你的回合'
    if (input.phase !== 'action') return '当前阶段不可使用技能'
    if (input.currentCooldown > 0) return '冷却中（剩余 ' + input.currentCooldown + ' 回合）'
    if (input.usesRemaining === 0) return '可用次数已耗尽'
    if (input.actionPoints < input.actionCost) {
      return '行动点不足（需要 ' + input.actionCost + '，当前 ' + input.actionPoints + '）'
    }
    if (input.chargePoints < input.chargeCost) {
      return '充能点不足（需要 ' + input.chargeCost + '，当前 ' + input.chargePoints + '）'
    }
    return ''
  }

  function normalizeSkills(piece, context, readOnly) {
    const definitions = context.skillsById || {}
    const resources = context.viewerResources || {}
    return displaySkills(piece, context.rawPieces || []).map(function (runtimeSkill) {
      const id = skillId(runtimeSkill)
      const definition = definitions[id] || {}
      if (!id || definition.showInUI === false) return null
      const passive = definition.kind === 'passive' || definition.type === 'passive'
      const currentCooldown = firstNumber([runtimeSkill && runtimeSkill.currentCooldown], 0)
      const maxCooldown = firstNumber([definition.cooldownTurns, definition.cooldown], 0)
      const usesRemaining = firstNumber([runtimeSkill && runtimeSkill.usesRemaining], -1)
      const actionCost = firstNumber([
        runtimeSkill && runtimeSkill.actionPointCost,
        definition.actionPointCost,
      ], 0)
      const chargeCost = firstNumber([
        runtimeSkill && runtimeSkill.chargeCost,
        definition.chargeCost,
      ], 0)
      const unavailableReason = skillUnavailableReason({
        readOnly: readOnly,
        alive: piece.currentHp > 0,
        passive: passive,
        isViewerTurn: context.isViewerTurn,
        phase: context.phase,
        currentCooldown: currentCooldown,
        usesRemaining: usesRemaining,
        actionPoints: firstNumber([resources.actionPoints], 0),
        chargePoints: firstNumber([resources.chargePoints], 0),
        actionCost: actionCost,
        chargeCost: chargeCost,
      })
      return {
        id: id,
        name: String(definition.name || id),
        description: String(definition.description || '暂无描述'),
        icon: String(definition.icon || (definition.type === 'super' ? 'C' : 'S')),
        kind: String(definition.kind || 'active'),
        type: String(definition.type || 'normal'),
        actionCost: actionCost,
        chargeCost: chargeCost,
        cooldown: { current: currentCooldown, max: maxCooldown },
        usesRemaining: usesRemaining,
        available: unavailableReason === '',
        unavailableReason: unavailableReason,
      }
    }).filter(Boolean)
  }

  function portraitSource(template) {
    const image = String((template && template.image) || '')
    if (!image) return ''
    if (/^(?:https?:|data:|blob:|\/)/i.test(image) || image.indexOf('images/') === 0) return image
    return 'images/' + image
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
    const readOnly = ownerPlayerId.toLowerCase() !== String(context.viewerId || '').toLowerCase()
    const statuses = normalizeStatuses(
      piece,
      piece.displayStatusTags !== undefined ? piece.displayStatusTags : piece.statusTags,
    )
    return {
      id: String(piece.instanceId || piece.id || ''),
      templateId: String(piece.templateId || ''),
      portraitId: String(piece.templateId || ''),
      portraitSrc: portraitSource(template),
      name: String(piece.name || template.name || piece.templateId || piece.instanceId || '?'),
      ownerPlayerId: ownerPlayerId,
      faction: piece.faction === 'blue' ? 'blue' : 'red',
      x: piece.x == null ? null : numberOr(piece.x, 0),
      y: piece.y == null ? null : numberOr(piece.y, 0),
      health: { current: currentHealth, max: maxHealth },
      stats: displayStats(piece, rawPieces),
      visible: piece.visible !== false && currentHealth > 0,
      alive: piece.currentHp > 0,
      readOnly: readOnly,
      statuses: statuses,
      statusSummary: statuses,
      skills: normalizeSkills(piece, context, readOnly),
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
    const turn = snapshot.turn || {}
    const viewerId = String(input.viewerId || '')
    const viewerResources = (snapshot.players || []).find(function (player) {
      return String(player.playerId || player.id || '').toLowerCase() === viewerId.toLowerCase()
    }) || null
    const rawPieces = snapshot.pieces || []
    const pieceContext = {
      rawPieces: rawPieces,
      viewerId: viewerId,
      isViewerTurn: !!viewerId && String(turn.currentPlayerId || '').toLowerCase() === viewerId.toLowerCase(),
      phase: String(turn.phase || ''),
      viewerResources: viewerResources,
      skillsById: Object.assign({}, input.skillsById || {}, snapshot.skillsById || {}),
      pieceTemplates: input.pieceTemplates || {},
    }
    const pieces = rawPieces.map(function (piece) { return normalizePiece(piece, pieceContext) })
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
      players: players,
      viewer: viewer,
      turn: {
        currentPlayerId: String(turn.currentPlayerId || ''),
        number: numberOr(turn.turnNumber, 1),
        phase: String(turn.phase || ''),
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
