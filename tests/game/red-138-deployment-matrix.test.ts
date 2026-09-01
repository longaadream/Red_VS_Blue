/* eslint-disable @typescript-eslint/no-explicit-any -- authority metadata and JSON-authored rules are intentionally inspected. */
import { beforeAll, describe, expect, it } from 'vitest'

import { loadMaps } from '@/config/maps'
import { createInitialBattleForPlayers } from '@/lib/game/battle-setup'
import {
  hashBattleState,
  runBattleAction,
  stableJson,
} from '@/lib/game/battle-runner'
import {
  getEmptyWalkableDeploymentPositions,
  getSafeDeploymentPositions,
} from '@/lib/game/deployment'
import { SELECTABLE_MAP_IDS, type SelectableMapId } from '@/lib/game/map-selection'
import type { PieceInstance, PieceTemplate } from '@/lib/game/piece'
import { RANDOM_STREAM_NAMES } from '@/lib/game/rule-runtime'
import {
  safeCloneBattleState,
  type BattleAction,
  type BattleState,
} from '@/lib/game/turn'
import { manhattanDistance } from '@/lib/game/spatial'

const PLAYERS = ['player-red', 'player-blue'] as const
const MATRIX_SEED = 0x1384c0de
const STARTED_AT = 1_750_000_000_000

function templates(prefix: 'red' | 'blue', withRule = false): PieceTemplate[] {
  return Array.from({ length: 8 }, (_, index) => ({
    id: `${prefix}-matrix-${index + 1}`,
    name: `${prefix} matrix ${index + 1}`,
    faction: prefix === 'red' ? 'good' : 'evil',
    rarity: 'common',
    stats: {
      maxHp: 20 + index,
      attack: 3 + index,
      defense: index % 4,
      moveRange: 2 + (index % 3),
    },
    skills: [],
    ...(withRule ? { rules: ['rule-divine-shield'] } : {}),
  }))
}

async function createBattle(
  mapId: SelectableMapId = 'large-hole-arena',
  seed = MATRIX_SEED,
  withRule = false,
): Promise<BattleState> {
  const red = templates('red', withRule)
  const blue = templates('blue', withRule)
  const battle = await createInitialBattleForPlayers(
    [...PLAYERS],
    [...red, ...blue],
    [
      { playerId: PLAYERS[0], pieces: red, faction: 'red', alignment: 'light' },
      { playerId: PLAYERS[1], pieces: blue, faction: 'blue', alignment: 'dark' },
    ],
    mapId,
    {
      firstPlayerId: PLAYERS[0],
      rootSeed: seed,
      deploymentEnabled: true,
      deploymentStartedAt: STARTED_AT,
    },
  )
  if (!battle) throw new Error(`Expected progressive battle on ${mapId}`)
  return battle
}

function authorityCursors(state: BattleState): Record<string, number> {
  return {
    ...((state.extensions as any)?.debugBattle?.authority?.runtimeCursors ?? {}),
  }
}

function openingSnapshot(state: BattleState) {
  return {
    mapId: state.map.id,
    vanguards: state.pieces
      .map(piece => ({
        instanceId: piece.instanceId,
        ownerPlayerId: piece.ownerPlayerId,
        x: piece.x,
        y: piece.y,
      }))
      .sort((left, right) => left.ownerPlayerId.localeCompare(right.ownerPlayerId)),
    offerPieceIds: [...(state.deployment?.offerPieceIds ?? [])],
  }
}

const EXPECTED_OPENING_MATRIX: Record<SelectableMapId, ReturnType<typeof openingSnapshot>> = {
  'large-hole-arena': {
    mapId: 'large-hole-arena',
    vanguards: [
      { instanceId: 'player-blue-6', ownerPlayerId: 'player-blue', x: 14, y: 6 },
      { instanceId: 'player-red-2', ownerPlayerId: 'player-red', x: 18, y: 10 },
    ],
    offerPieceIds: ['player-red-6', 'player-red-8', 'player-red-4'],
  },
  'open-expanse': {
    mapId: 'open-expanse',
    vanguards: [
      { instanceId: 'player-blue-6', ownerPlayerId: 'player-blue', x: 10, y: 6 },
      { instanceId: 'player-red-2', ownerPlayerId: 'player-red', x: 7, y: 11 },
    ],
    offerPieceIds: ['player-red-6', 'player-red-8', 'player-red-4'],
  },
  'winding-pass': {
    mapId: 'winding-pass',
    vanguards: [
      { instanceId: 'player-blue-6', ownerPlayerId: 'player-blue', x: 14, y: 6 },
      { instanceId: 'player-red-2', ownerPlayerId: 'player-red', x: 5, y: 11 },
    ],
    offerPieceIds: ['player-red-6', 'player-red-8', 'player-red-4'],
  },
  'narrow-corridors': {
    mapId: 'narrow-corridors',
    vanguards: [
      { instanceId: 'player-blue-6', ownerPlayerId: 'player-blue', x: 5, y: 6 },
      { instanceId: 'player-red-2', ownerPlayerId: 'player-red', x: 17, y: 10 },
    ],
    offerPieceIds: ['player-red-6', 'player-red-8', 'player-red-4'],
  },
}

type Position = { x: number; y: number }

function formalWalkablePositions(state: BattleState): Position[] {
  return state.map.tiles
    .filter(tile => tile.props.walkable === true)
    .map(tile => ({ x: tile.x, y: tile.y }))
    .sort((left, right) => left.y - right.y || left.x - right.x)
}

function fixturePiece(position: Position, index: number, label: string): PieceInstance {
  const ownerPlayerId = index === 1 ? PLAYERS[1] : PLAYERS[0]
  return {
    instanceId: `${label}-blocker-${index + 1}`,
    templateId: `${label}-blocker`,
    name: `${label} blocker ${index + 1}`,
    ownerPlayerId,
    faction: ownerPlayerId === PLAYERS[0] ? 'red' : 'blue',
    x: position.x,
    y: position.y,
    currentHp: 10,
    maxHp: 10,
    attack: 1,
    defense: 0,
    moveRange: 1,
    skills: [],
    isCore: index < 2,
    buffs: [],
    debuffs: [],
    ruleTags: [],
    statusTags: [],
    rules: [],
  }
}

function replaceBoardWithBlockers(
  initial: BattleState,
  blockerPositions: Position[],
  label: string,
): BattleState {
  if (blockerPositions.length < 2) throw new Error('Expected blockers for both living board cores')
  const state = safeCloneBattleState(initial)
  state.pieces = blockerPositions.map((position, index) => fixturePiece(position, index, label))
  state.graveyard = []
  if (!state.deployment) throw new Error('Expected progressive deployment state')
  state.deployment.legalPositions = getSafeDeploymentPositions(state)
  return state
}

function exactlyOneSafeFixture(initial: BattleState): { state: BattleState; target: Position } {
  const walkable = formalWalkablePositions(initial)
  for (const target of walkable) {
    const blockers = walkable.filter(position => manhattanDistance(position, target) > 5)
    if (blockers.length < 2) continue
    const everyOtherCellCovered = walkable.every(position =>
      (position.x === target.x && position.y === target.y)
      || blockers.some(blocker =>
        (blocker.x === position.x && blocker.y === position.y)
        || manhattanDistance(position, blocker) <= 5))
    if (!everyOtherCellCovered) continue

    const state = replaceBoardWithBlockers(initial, blockers, `single-${initial.map.id}`)
    const safePositions = getSafeDeploymentPositions(state)
    if (safePositions.length === 1
      && safePositions[0].x === target.x
      && safePositions[0].y === target.y) {
      return { state, target }
    }
  }
  throw new Error(`Unable to construct exactly one safe cell on ${initial.map.id}`)
}

function zeroSafeFallbackFixture(initial: BattleState): {
  state: BattleState
  fallbackPositions: Position[]
} {
  const walkable = formalWalkablePositions(initial)
  for (let index = 0; index < walkable.length; index += 1) {
    const first = walkable[index]
    const second = walkable.slice(index + 1).find(position =>
      manhattanDistance(first, position) === 1)
    if (!second) continue
    const fallbackPositions = [first, second]
    const blockers = walkable.filter(position => !fallbackPositions.some(fallback =>
      fallback.x === position.x && fallback.y === position.y))
    if (blockers.length < 2) continue
    const state = replaceBoardWithBlockers(initial, blockers, `fallback-${initial.map.id}`)
    if (getSafeDeploymentPositions(state).length === 0) {
      return { state, fallbackPositions }
    }
  }
  throw new Error(`Unable to construct zero safe cells with fallback choices on ${initial.map.id}`)
}

function prepareReserveRemainder(initial: BattleState, reserveCount: 1 | 2): BattleState {
  const state = safeCloneBattleState(initial)
  const deployment = state.deployment
  if (!deployment?.reserves) throw new Error('Expected progressive reserves')
  const reserve = deployment.reserves[PLAYERS[0]]
  if (!reserve) throw new Error('Expected red progressive reserve')
  deployment.reserves[PLAYERS[0]] = reserve.slice(0, reserveCount)
  deployment.reserveCounts = {
    ...(deployment.reserveCounts ?? {}),
    [PLAYERS[0]]: reserveCount,
  }
  deployment.status = 'turn-ready'
  delete deployment.activePlayerId
  delete deployment.offerTurnNumber
  delete deployment.offerPieceIds
  delete deployment.legalPositions
  state.turn.phase = 'start'
  return state
}

function expectRejectedWithoutMutation(
  state: BattleState,
  action: BattleAction,
  expectedMessage: string,
): void {
  const beforeState = stableJson(state)
  const beforeHash = hashBattleState(state)
  const beforeCursors = authorityCursors(state)

  expect(() => runBattleAction(state, action, { rootSeed: MATRIX_SEED })).toThrow(expectedMessage)
  expect(stableJson(state)).toBe(beforeState)
  expect(hashBattleState(state)).toBe(beforeHash)
  expect(authorityCursors(state)).toEqual(beforeCursors)
}

function persistentPieceSnapshot(piece: PieceInstance) {
  return {
    instanceId: piece.instanceId,
    templateId: piece.templateId,
    name: piece.name,
    ownerPlayerId: piece.ownerPlayerId,
    faction: piece.faction,
    isCore: piece.isCore,
    currentHp: piece.currentHp,
    maxHp: piece.maxHp,
    attack: piece.attack,
    defense: piece.defense,
    moveRange: piece.moveRange,
    rules: (piece.rules ?? []).map(rule => ({
      id: rule.id,
      name: rule.name,
      trigger: { ...rule.trigger },
      limits: rule.limits ? { ...rule.limits } : undefined,
    })),
  }
}

beforeAll(async () => {
  await loadMaps()
})

describe('RED-138 progressive deployment spatial and authority matrix', () => {
  it.each(SELECTABLE_MAP_IDS)('freezes opening vanguards, offer, and safe-space matrix on %s', async mapId => {
    const first = await createBattle(mapId)
    const repeated = await createBattle(mapId)
    const deployment = first.deployment!

    expect(hashBattleState(repeated)).toBe(hashBattleState(first))
    expect(openingSnapshot(repeated)).toEqual(openingSnapshot(first))
    expect(first.pieces.filter(piece => piece.isCore)).toHaveLength(2)
    for (const playerId of PLAYERS) {
      expect(first.pieces.filter(piece => piece.isCore && piece.ownerPlayerId === playerId)).toHaveLength(1)
      expect(deployment.reserveCounts?.[playerId]).toBe(7)
    }
    expect(deployment.offerPieceIds).toHaveLength(3)
    expect(new Set(deployment.offerPieceIds).size).toBe(3)
    expect(deployment.legalPositions?.length).toBeGreaterThan(0)
    for (const position of deployment.legalPositions ?? []) {
      for (const livingPiece of first.pieces.filter(piece => piece.currentHp > 0)) {
        expect(manhattanDistance(position, livingPiece)).toBeGreaterThan(5)
      }
    }

    const trace = (first.extensions as any)?.debugBattle?.actionLog?.[0]
    for (const playerId of PLAYERS) {
      expect(trace?.randomStreams).toContainEqual(expect.objectContaining({
        name: `${RANDOM_STREAM_NAMES.progressiveDeploymentOpeningPiece}/${playerId}`,
        startCursor: 0,
        endCursor: 1,
      }))
      expect(trace?.randomStreams).toContainEqual(expect.objectContaining({
        name: `${RANDOM_STREAM_NAMES.progressiveDeploymentOpeningCell}/${playerId}`,
        startCursor: 0,
        endCursor: 1,
      }))
    }

    expect(openingSnapshot(first)).toEqual(EXPECTED_OPENING_MATRIX[mapId])
  })

  it.each(SELECTABLE_MAP_IDS)('accepts a player-selected cell when %s has multiple safe cells', async mapId => {
    const initial = await createBattle(mapId)
    const safePositions = getSafeDeploymentPositions(initial)
    const pieceId = initial.deployment?.offerPieceIds?.[0]
    if (!pieceId) throw new Error(`Expected an offered reserve core on ${mapId}`)

    expect(safePositions.length).toBeGreaterThan(1)
    expect(initial.deployment?.legalPositions).toEqual(safePositions)
    const selected = safePositions[1]
    const deployed = runBattleAction(initial, {
      type: 'deployReservePiece',
      playerId: PLAYERS[0],
      expectedDeploymentRevision: initial.deployment!.revision,
      pieceId,
      toX: selected.x,
      toY: selected.y,
    }, { rootSeed: MATRIX_SEED })

    expect(deployed.state.pieces.find(piece => piece.instanceId === pieceId))
      .toMatchObject(selected)
    expect(deployed.trace?.randomStreams ?? []).not.toContainEqual(expect.objectContaining({
      name: `${RANDOM_STREAM_NAMES.progressiveDeploymentFallback}/${PLAYERS[0]}`,
    }))
  })

  it.each(SELECTABLE_MAP_IDS)('uses the only authoritative safe cell on %s', async mapId => {
    const fixture = exactlyOneSafeFixture(await createBattle(mapId))
    const pieceId = fixture.state.deployment?.offerPieceIds?.[0]
    if (!pieceId) throw new Error(`Expected an offered reserve core on ${mapId}`)

    expect(getSafeDeploymentPositions(fixture.state)).toEqual([fixture.target])
    expect(fixture.state.deployment?.legalPositions).toEqual([fixture.target])
    const deployed = runBattleAction(fixture.state, {
      type: 'deployReservePiece',
      playerId: PLAYERS[0],
      expectedDeploymentRevision: fixture.state.deployment!.revision,
      pieceId,
      toX: fixture.target.x,
      toY: fixture.target.y,
    }, { rootSeed: MATRIX_SEED })

    expect(deployed.state.pieces.find(piece => piece.instanceId === pieceId))
      .toMatchObject(fixture.target)
    expect(deployed.trace?.deployment?.deployedPosition).toEqual(fixture.target)
  })

  it.each(SELECTABLE_MAP_IDS)('uses the seeded fallback among empty walkable cells when %s has zero safe cells', async mapId => {
    const fixture = zeroSafeFallbackFixture(await createBattle(mapId))
    const pieceId = fixture.state.deployment?.offerPieceIds?.[0]
    if (!pieceId) throw new Error(`Expected an offered reserve core on ${mapId}`)
    const action: BattleAction = {
      type: 'deployReservePiece',
      playerId: PLAYERS[0],
      expectedDeploymentRevision: fixture.state.deployment!.revision,
      pieceId,
    }

    expect(getSafeDeploymentPositions(fixture.state)).toEqual([])
    expect(getEmptyWalkableDeploymentPositions(fixture.state)).toEqual(fixture.fallbackPositions)
    const first = runBattleAction(fixture.state, action, { rootSeed: MATRIX_SEED })
    const repeated = runBattleAction(fixture.state, action, { rootSeed: MATRIX_SEED })
    const committed = first.trace?.deployment?.deployedPosition

    expect(fixture.fallbackPositions).toContainEqual(committed)
    expect(repeated.trace?.deployment?.deployedPosition).toEqual(committed)
    expect(hashBattleState(repeated.state)).toBe(hashBattleState(first.state))
    expect(first.trace?.randomStreams).toContainEqual(expect.objectContaining({
      name: `${RANDOM_STREAM_NAMES.progressiveDeploymentFallback}/${PLAYERS[0]}`,
      startCursor: 0,
      endCursor: 1,
    }))
  })

  it.each([2, 1] as const)('offers min(3,N) unique pieces when the ordinary reserve has %i left', async reserveCount => {
    const initial = await createBattle()
    const prepared = prepareReserveRemainder(initial, reserveCount)
    const beforeOfferCursor = authorityCursors(prepared)[
      `${RANDOM_STREAM_NAMES.progressiveDeploymentOffer}/${PLAYERS[0]}`
    ]
    const result = runBattleAction(prepared, { type: 'beginPhase' }, { rootSeed: MATRIX_SEED })
    const offer = result.state.deployment?.offerPieceIds ?? []

    expect(offer).toHaveLength(Math.min(3, reserveCount))
    expect(new Set(offer).size).toBe(offer.length)
    expect(result.trace?.randomStreams).toContainEqual(expect.objectContaining({
      name: `${RANDOM_STREAM_NAMES.progressiveDeploymentOffer}/${PLAYERS[0]}`,
      startCursor: beforeOfferCursor,
      endCursor: beforeOfferCursor + reserveCount,
    }))
  })

  it('rejects illegal safe cells, non-offer pieces, and the non-acting player without any state or RNG mutation', async () => {
    const initial = await createBattle()
    const deployment = initial.deployment!
    const offeredPieceId = deployment.offerPieceIds?.[0]
    const legalPosition = deployment.legalPositions?.[0]
    const safeKeys = new Set((deployment.legalPositions ?? []).map(position => `${position.x},${position.y}`))
    const illegalEmptyPosition = initial.map.tiles.find(tile =>
      tile.props.walkable
      && !safeKeys.has(`${tile.x},${tile.y}`)
      && !initial.pieces.some(piece => piece.x === tile.x && piece.y === tile.y))
    const nonOfferPiece = deployment.reserves?.[PLAYERS[0]]?.find(piece =>
      !deployment.offerPieceIds?.includes(piece.instanceId))
    const opponentReservePiece = deployment.reserves?.[PLAYERS[1]]?.[0]
    if (!offeredPieceId || !legalPosition || !illegalEmptyPosition || !nonOfferPiece || !opponentReservePiece) {
      throw new Error('Expected complete invalid-command matrix fixture')
    }

    expectRejectedWithoutMutation(initial, {
      type: 'deployReservePiece',
      playerId: PLAYERS[0],
      expectedDeploymentRevision: deployment.revision,
      pieceId: offeredPieceId,
      toX: illegalEmptyPosition.x,
      toY: illegalEmptyPosition.y,
    }, 'Deployment position is outside the authoritative safe cells')
    expectRejectedWithoutMutation(initial, {
      type: 'deployReservePiece',
      playerId: PLAYERS[0],
      expectedDeploymentRevision: deployment.revision,
      pieceId: nonOfferPiece.instanceId,
      toX: legalPosition.x,
      toY: legalPosition.y,
    }, 'Selected piece is not in the authoritative reserve offer')
    expectRejectedWithoutMutation(initial, {
      type: 'deployReservePiece',
      playerId: PLAYERS[1],
      expectedDeploymentRevision: deployment.revision,
      pieceId: opponentReservePiece.instanceId,
      toX: legalPosition.x,
      toY: legalPosition.y,
    }, 'Reserve deployment belongs to another player or turn')
  })

  it('preserves the offered core identity, owner, faction, HP, base stats, and rules across reserve-to-board summon', async () => {
    const initial = await createBattle('large-hole-arena', MATRIX_SEED, true)
    const pieceId = initial.deployment?.offerPieceIds?.[0]
    const position = initial.deployment?.legalPositions?.[0]
    const before = initial.deployment?.reserves?.[PLAYERS[0]]?.find(piece => piece.instanceId === pieceId)
    if (!pieceId || !position || !before) throw new Error('Expected offered reserve core')
    expect(before.rules?.map(rule => rule.id)).toContain('rule-divine-shield')
    const beforeSnapshot = persistentPieceSnapshot(before)

    const deployed = runBattleAction(initial, {
      type: 'deployReservePiece',
      playerId: PLAYERS[0],
      expectedDeploymentRevision: initial.deployment!.revision,
      pieceId,
      toX: position.x,
      toY: position.y,
    }, { rootSeed: MATRIX_SEED }).state
    const after = deployed.pieces.find(piece => piece.instanceId === pieceId)
    if (!after) throw new Error('Expected deployed core with the same stable ID')

    expect(persistentPieceSnapshot(after)).toEqual(beforeSnapshot)
    expect(deployed.pieces.filter(piece => piece.instanceId === pieceId)).toHaveLength(1)
    expect(deployed.deployment?.reserves?.[PLAYERS[0]]?.some(piece => piece.instanceId === pieceId)).toBe(false)
  })
})
