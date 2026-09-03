(function (global) {
  'use strict'

  const SCHEMA_VERSION = 'rvb-tutorial/v1'

  function requireValue(value, message) {
    if (!value) throw new Error('[tutorial] ' + message)
    return value
  }

  function normalizeId(value) {
    return String(value || '').trim().toLowerCase()
  }

  function findBoardPiece(state, templateId, ownerPlayerId) {
    const owner = normalizeId(ownerPlayerId)
    return (state.pieces || []).find(function (piece) {
      return normalizeId(piece.templateId) === normalizeId(templateId)
        && (!owner || normalizeId(piece.ownerPlayerId) === owner)
        && piece.currentHp > 0
    }) || null
  }

  function findReservePiece(state, templateId, ownerPlayerId) {
    const reserves = state.deployment && state.deployment.reserves
    const owner = normalizeId(ownerPlayerId)
    const key = Object.keys(reserves || {}).find(function (candidate) {
      return normalizeId(candidate) === owner
    })
    return ((key && reserves[key]) || []).find(function (piece) {
      return normalizeId(piece.templateId) === normalizeId(templateId)
    }) || null
  }

  function findAnyPiece(state, templateId, ownerPlayerId) {
    return findBoardPiece(state, templateId, ownerPlayerId)
      || findReservePiece(state, templateId, ownerPlayerId)
  }

  function validateDefinition(definition) {
    requireValue(definition && definition.schemaVersion === SCHEMA_VERSION, 'unsupported scenario schema')
    requireValue(definition.player && definition.player.playerId, 'player is missing')
    requireValue(definition.opponent && definition.opponent.playerId, 'opponent is missing')
    requireValue(definition.staging && Array.isArray(definition.staging.vanguards), 'vanguard staging is missing')
    requireValue(Array.isArray(definition.steps) && definition.steps.length > 0, 'tutorial steps are missing')
    return definition
  }

  function prepareInitialState(state, rawDefinition) {
    const definition = validateDefinition(rawDefinition)
    requireValue(state && Array.isArray(state.pieces), 'battle pieces are required')

    const playerId = definition.player.playerId
    const opponentId = definition.opponent.playerId
    const allPieces = state.pieces.slice()
    const findInitialPiece = function (templateId, ownerPlayerId) {
      return allPieces.find(function (piece) {
        return normalizeId(piece.templateId) === normalizeId(templateId)
          && normalizeId(piece.ownerPlayerId) === normalizeId(ownerPlayerId)
      }) || null
    }
    const uther = requireValue(findInitialPiece('uther', playerId), 'missing uther')
    const reaper = requireValue(findInitialPiece('reaper', opponentId), 'missing reaper')
    const anduin = requireValue(findInitialPiece('anduin', playerId), 'missing anduin')
    const widow = requireValue(findInitialPiece('red-blackwidow', opponentId), 'missing red-blackwidow')

    definition.staging.vanguards.forEach(function (staged) {
      const owner = (definition.player.roster || []).some(function (templateId) {
        return normalizeId(templateId) === normalizeId(staged.templateId)
      }) ? definition.player.playerId : definition.opponent.playerId
      const piece = requireValue(findInitialPiece(staged.templateId, owner), 'missing vanguard ' + staged.templateId)
      piece.x = staged.x
      piece.y = staged.y
      if (Number.isFinite(staged.currentHp)) {
        piece.currentHp = Math.max(1, Math.min(piece.maxHp, staged.currentHp))
      }
    })

    const opponentCell = definition.staging.deploymentCells[opponentId]
    widow.x = opponentCell.x
    widow.y = opponentCell.y
    widow.statusTags = (widow.statusTags || []).filter(function (tag) { return tag.type !== 'deployment-first-move-free' })
    anduin.x = null
    anduin.y = null
    state.pieces = [uther, reaper, widow]

    // Start as a completed legacy deployment so the scripted opening can use
    // normal turn rules. The mode flips only when the player's real reserve
    // placement begins; this avoids consuming an automatic random offer.
    state.deployment = {
      mode: 'legacy-reroll-v1',
      status: 'complete',
      playerIds: [playerId, opponentId],
      choices: {},
      locks: {},
      startedAt: definition.deploymentStartedAt,
      deadlineAt: definition.deploymentStartedAt,
      revision: 0,
      openingVanguardsInitialized: true,
      initialPositions: Object.fromEntries(state.pieces.map(function (piece) {
        return [piece.instanceId, { x: piece.x, y: piece.y }]
      })),
      reserves: {
        [playerId]: [anduin],
        [opponentId]: [],
      },
      reserveCounts: {
        [playerId]: 1,
        [opponentId]: 0,
      },
    }

    const playerCell = definition.staging.deploymentCells[playerId]
    const stagedLegalPositions = [{ x: playerCell.x, y: playerCell.y }]
    state.deployment.initialPositions = Object.fromEntries(state.pieces.map(function (piece) {
      return [piece.instanceId, { x: piece.x, y: piece.y }]
    }))

    state.extensions = state.extensions || {}
    state.extensions.tutorial = {
      schemaVersion: SCHEMA_VERSION,
      scenarioId: definition.id,
      rootSeed: definition.rootSeed,
      staged: true,
      legalPositions: stagedLegalPositions,
    }
    return state
  }

  function openPlayerDeployment(state, rawDefinition) {
    const definition = validateDefinition(rawDefinition)
    const deployment = requireValue(state && state.deployment, 'progressive deployment state is required')
    const playerId = definition.player.playerId
    const reservePiece = requireValue(findReservePiece(state, 'anduin', playerId), 'missing reserve anduin')
    const tutorialState = state.extensions && state.extensions.tutorial
    deployment.mode = 'progressive-reserve-v1'
    deployment.status = 'awaiting-reserve-deploy'
    deployment.activePlayerId = playerId
    deployment.offerTurnNumber = state.turn.turnNumber
    deployment.offerPieceIds = [reservePiece.instanceId]
    deployment.offerPieces = [{
      instanceId: reservePiece.instanceId,
      templateId: reservePiece.templateId,
      name: reservePiece.name,
    }]
    deployment.legalPositions = (tutorialState && tutorialState.legalPositions || []).map(function (cell) {
      return { x: cell.x, y: cell.y }
    })
    deployment.revision = Number(deployment.revision || 0) + 1
    return state
  }

  function resolveCellCue(state, definition, cue) {
    const cells = []
    ;(cue && cue.cells || []).forEach(function (cell) { cells.push({ x: cell.x, y: cell.y }) })
    ;(cue && cue.terrainKeys || []).forEach(function (key) {
      const cell = definition.staging.terrainCells && definition.staging.terrainCells[key]
      if (cell) cells.push({ x: cell.x, y: cell.y })
    })
    ;(cue && cue.templates || []).forEach(function (templateId) {
      const piece = findBoardPiece(state, templateId)
      if (piece && Number.isInteger(piece.x) && Number.isInteger(piece.y)) cells.push({ x: piece.x, y: piece.y })
    })
    const unique = []
    const seen = new Set()
    cells.forEach(function (cell) {
      const key = cell.x + ',' + cell.y
      if (!seen.has(key)) { seen.add(key); unique.push(cell) }
    })
    const path = []
    const connect = cue && cue.connectTemplates
    if (Array.isArray(connect) && connect.length === 2) {
      const from = findBoardPiece(state, connect[0])
      const to = findBoardPiece(state, connect[1])
      if (from && to) path.push({ x: from.x, y: from.y }, { x: to.x, y: to.y })
    }
    const connectToCell = cue && cue.connectTemplateToCell
    if (Array.isArray(connectToCell) && connectToCell.length === 2) {
      const from = findBoardPiece(state, connectToCell[0])
      const to = connectToCell[1]
      if (from && to) path.push({ x: from.x, y: from.y }, { x: to.x, y: to.y })
    }
    ;(cue && cue.path || []).forEach(function (cell) { path.push({ x: cell.x, y: cell.y }) })
    return { cells: unique, path: path }
  }

  global.RvBTutorialScenario = Object.freeze({
    SCHEMA_VERSION: SCHEMA_VERSION,
    validateDefinition: validateDefinition,
    prepareInitialState: prepareInitialState,
    openPlayerDeployment: openPlayerDeployment,
    findBoardPiece: findBoardPiece,
    findReservePiece: findReservePiece,
    findAnyPiece: findAnyPiece,
    resolveCellCue: resolveCellCue,
  })
})(typeof window !== 'undefined' ? window : globalThis)
