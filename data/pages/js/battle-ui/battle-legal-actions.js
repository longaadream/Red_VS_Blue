;(function (root) {
  'use strict'

  function cloneState(snapshot, engine) {
    if (engine && typeof engine.safeCloneBattleState === 'function') {
      return engine.safeCloneBattleState(snapshot)
    }
    return JSON.parse(JSON.stringify(snapshot))
  }

  function cellKey(x, y) { return x + ',' + y }

  function candidateCells(snapshot) {
    return snapshot && snapshot.map && Array.isArray(snapshot.map.tiles) ? snapshot.map.tiles : []
  }

  function targetCandidateCells(snapshot, targetType, filter) {
    const type = String(targetType || '').toLowerCase()
    const targetFilter = String(filter || '').toLowerCase()
    const pieceOnly = ['piece', 'character', 'self'].includes(type)
      || ['ally', 'allies', 'friendly', 'enemy', 'enemies'].includes(targetFilter)
    if (!pieceOnly) return candidateCells(snapshot)
    const occupied = new Set((snapshot.pieces || []).filter(function (piece) {
      return piece.currentHp > 0 && piece.x != null && piece.y != null
    }).map(function (piece) { return cellKey(piece.x, piece.y) }))
    return candidateCells(snapshot).filter(function (tile) {
      return occupied.has(cellKey(tile.x, tile.y))
    })
  }

  function livePieceAt(snapshot, x, y) {
    return (snapshot.pieces || []).find(function (piece) {
      return piece.x === x && piece.y === y && piece.currentHp > 0
    }) || null
  }

  function appendTarget(action, piece, x, y) {
    const next = Object.assign({}, action)
    delete next.clientActionId
    delete next.requestId
    delete next.validTargets
    const hasPrimary = !!(next.targetPieceId || next.targetX !== undefined || next.targetY !== undefined)
    if (!hasPrimary) {
      if (piece) next.targetPieceId = piece.instanceId
      next.targetX = x
      next.targetY = y
      return next
    }
    const extraTargets = Array.isArray(next.extraTargets) ? next.extraTargets.slice() : []
    const extra = { x: x, y: y }
    if (piece) extra.pieceId = piece.instanceId
    extraTargets.push(extra)
    next.extraTargets = extraTargets
    return next
  }

  function actionAccepted(engine, snapshot, action, validateOnly) {
    if (!engine) return false
    try {
      const state = cloneState(snapshot, engine)
      if (validateOnly && typeof engine.validateSkillActionByDryRun === 'function') {
        engine.validateSkillActionByDryRun(state, action)
      } else if (typeof engine.applyBattleAction === 'function') {
        engine.applyBattleAction(state, action)
      } else {
        return false
      }
      return true
    } catch {
      return false
    }
  }

  function moveActionAccepted(engine, snapshot, action) {
    if (!engine || typeof engine.applyBattleAction !== 'function') return false
    try {
      const state = cloneState(snapshot, engine)
      const beforePiece = (state.pieces || []).find(function (piece) { return piece.instanceId === action.pieceId })
      if (!beforePiece) return false
      const beforeX = beforePiece.x
      const beforeY = beforePiece.y
      const applied = engine.applyBattleAction(state, action)
      const nextState = applied && Array.isArray(applied.pieces) ? applied : state
      const nextPiece = (nextState.pieces || []).find(function (piece) { return piece.instanceId === action.pieceId })
      return !!nextPiece && (nextPiece.x !== beforeX || nextPiece.y !== beforeY)
    } catch {
      return false
    }
  }

  function targetCandidateAccepted(engine, snapshot, action, validateOnly, targetIndex) {
    if (!engine) return false
    try {
      const state = cloneState(snapshot, engine)
      if (validateOnly && typeof engine.validateSkillActionByDryRun === 'function') {
        engine.validateSkillActionByDryRun(state, action)
      } else if (typeof engine.applyBattleAction === 'function') {
        engine.applyBattleAction(state, action)
      } else {
        return false
      }
      return true
    } catch (error) {
      if (!error || !error.needsTargetSelection) return false
      const requestedIndex = Number(error.targetIndex)
      const currentIndex = Number(targetIndex || 0)
      return Number.isFinite(requestedIndex) && requestedIndex > currentIndex
    }
  }

  function queryMoveCells(options) {
    const input = options || {}
    if (!input.snapshot || !input.pieceId || !input.playerId) return new Set()
    const result = new Set()
    let candidates = candidateCells(input.snapshot)
    if (input.engine && typeof input.engine.getLegalNormalMoveTargetsForPlayer === 'function') {
      try {
        candidates = input.engine.getLegalNormalMoveTargetsForPlayer(input.snapshot, input.playerId, input.pieceId) || []
      } catch {
        return result
      }
    }
    candidates.forEach(function (tile) {
      const action = {
        type: 'move',
        playerId: input.playerId,
        pieceId: input.pieceId,
        toX: tile.x,
        toY: tile.y,
      }
      if (moveActionAccepted(input.engine, input.snapshot, action)) result.add(cellKey(tile.x, tile.y))
    })
    return result
  }

  function probeSkillTarget(options) {
    const input = options || {}
    if (!input.snapshot || !input.pieceId || !input.skillId || !input.engine) return null
    const skill = (input.snapshot.skillsById && input.snapshot.skillsById[input.skillId])
      || (input.skillsById && input.skillsById[input.skillId])
      || {}
    const action = {
      type: skill.type === 'super' ? 'useChargeSkill' : 'useBasicSkill',
      playerId: input.playerId,
      pieceId: input.pieceId,
      skillId: input.skillId,
    }
    try {
      const state = cloneState(input.snapshot, input.engine)
      state.skillsById = Object.assign({}, state.skillsById || {}, { [input.skillId]: skill })
      if (typeof input.engine.validateSkillActionByDryRun === 'function') {
        input.engine.validateSkillActionByDryRun(state, action)
      } else {
        input.engine.applyBattleAction(state, action)
      }
      return { needsTarget: false, baseAction: action }
    } catch (error) {
      if (error && error.needsTargetSelection) {
        return {
          needsTarget: true,
          baseAction: action,
          range: error.range,
          targetType: error.targetType || '',
          filter: error.filter || '',
          targetIndex: error.targetIndex,
        }
      }
      if (error && error.needsOptionSelection) return { needsTarget: false, baseAction: action }
      return null
    }
  }

  function querySkillTargetCells(options) {
    const input = options || {}
    if (!input.snapshot || !input.baseAction) return new Set()
    const result = new Set()
    targetCandidateCells(input.snapshot, input.targetType, input.filter).forEach(function (tile) {
      const piece = livePieceAt(input.snapshot, tile.x, tile.y)
      const action = appendTarget(input.baseAction, piece, tile.x, tile.y)
      if (targetCandidateAccepted(input.engine, input.snapshot, action, true, input.targetIndex)) {
        result.add(cellKey(tile.x, tile.y))
      }
    })
    return result
  }

  function queryActionTargetCells(options) {
    const input = options || {}
    if (!input.snapshot || !input.baseAction) return new Set()
    const result = new Set()
    targetCandidateCells(input.snapshot, input.targetType, input.filter).forEach(function (tile) {
      const piece = livePieceAt(input.snapshot, tile.x, tile.y)
      const action = appendTarget(input.baseAction, piece, tile.x, tile.y)
      if (targetCandidateAccepted(input.engine, input.snapshot, action, false, input.targetIndex)) {
        result.add(cellKey(tile.x, tile.y))
      }
    })
    return result
  }

  function queryPendingTargetCells(options) {
    const input = options || {}
    if (!input.snapshot || !input.playerId) return new Set()
    const result = new Set()
    const pending = input.snapshot.pendingTargetSelection || {}
    targetCandidateCells(input.snapshot, pending.targetType, pending.filter).forEach(function (tile) {
      const piece = livePieceAt(input.snapshot, tile.x, tile.y)
      const action = { type: 'pendingTargetSelect', playerId: input.playerId, targetX: tile.x, targetY: tile.y }
      if (piece) action.targetPieceId = piece.instanceId
      if (actionAccepted(input.engine, input.snapshot, action, false)) result.add(cellKey(tile.x, tile.y))
    })
    return result
  }

  function queryTrainingPlacementCells(snapshot) {
    const occupied = new Set((snapshot.pieces || []).filter(function (piece) {
      return piece.currentHp > 0 && piece.x != null && piece.y != null
    }).map(function (piece) { return cellKey(piece.x, piece.y) }))
    const result = new Set()
    candidateCells(snapshot).forEach(function (tile) {
      if (tile.props && tile.props.walkable && !occupied.has(cellKey(tile.x, tile.y))) {
        result.add(cellKey(tile.x, tile.y))
      }
    })
    return result
  }

  root.BattleLegalActions = {
    appendTarget: appendTarget,
    probeSkillTarget: probeSkillTarget,
    queryMoveCells: queryMoveCells,
    queryActionTargetCells: queryActionTargetCells,
    queryPendingTargetCells: queryPendingTargetCells,
    querySkillTargetCells: querySkillTargetCells,
    queryTrainingPlacementCells: queryTrainingPlacementCells,
  }
})(typeof window !== 'undefined' ? window : globalThis)
