/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest'

import { buildInitialPiecesForPlayers, createInitialBattleForPlayers } from '@/lib/game/battle-setup'
import { DEPLOYMENT_DURATION_MS, toPublicBattleState } from '@/lib/game/deployment'
import { recordBattleInitialization, runBattleAction } from '@/lib/game/battle-runner'
import { withoutServerSkills } from '@/lib/game/battle-storage'
import { stableJson } from '@/lib/game/battle-trace'
import type { BoardMap } from '@/lib/game/map'
import { getMapById } from '@/lib/game/map-repository'
import { SELECTABLE_MAP_IDS } from '@/lib/game/map-selection'
import type { PieceTemplate } from '@/lib/game/piece'
import { getPieceById } from '@/lib/game/piece-repository'
import { RANDOM_STREAM_NAMES, RuleRuntime } from '@/lib/game/rule-runtime'
import { summonPiece } from '@/lib/game/turn'
import { pinTestBattleState } from './profile-test-identity'
import { makeState } from '../helpers/minimal-state'

const PLAYERS = ['player-red', 'player-blue'] as const

function makeDeploymentMap(): BoardMap {
  const tiles: BoardMap['tiles'] = []
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const type = x === 7 && y === 4 ? 'cover' : 'floor'
      tiles.push({
        id: `tile-${x}-${y}`,
        x,
        y,
        props: {
          type,
          walkable: true,
          bulletPassable: type === 'floor',
        },
      })
    }
  }
  return { id: 'large-hole-arena', name: 'Large Hole Arena', width: 8, height: 5, tiles, rules: [] }
}

function makeTemplates(prefix: string): PieceTemplate[] {
  return Array.from({ length: 8 }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    name: `${prefix} ${index + 1}`,
    faction: prefix === 'red' ? 'good' : 'evil',
    rarity: 'common',
    stats: { maxHp: 100, attack: 10, defense: 0, moveRange: 3 },
    skills: [],
  }))
}

function buildDeploymentOnMap(
  map: BoardMap,
  seed: number,
  reversePlayers = false,
) {
  const red = makeTemplates('red')
  const blue = makeTemplates('blue')
  const runtime = new RuleRuntime({ rootSeed: seed })
  const playerIds = reversePlayers ? [...PLAYERS].reverse() : [...PLAYERS]
  const selections = reversePlayers
    ? [
        { playerId: PLAYERS[1], pieces: blue, faction: 'red' as const },
        { playerId: PLAYERS[0], pieces: red, faction: 'blue' as const },
      ]
    : [
        { playerId: PLAYERS[0], pieces: red, faction: 'red' as const },
        { playerId: PLAYERS[1], pieces: blue, faction: 'blue' as const },
      ]
  const pieces = buildInitialPiecesForPlayers(
    map,
    playerIds,
    [...red, ...blue],
    selections,
    () => runtime.nextRandom(RANDOM_STREAM_NAMES.deployment),
    { deterministicDeployment: true },
  )
  return { map, pieces, runtime }
}

function buildDeployment(seed: number, reversePlayers = false) {
  return buildDeploymentOnMap(makeDeploymentMap(), seed, reversePlayers)
}

function positions(pieces: Array<{ instanceId: string; x: number | null; y: number | null }>) {
  return Object.fromEntries(
    [...pieces]
      .sort((left, right) => left.instanceId.localeCompare(right.instanceId))
      .map(piece => [piece.instanceId, [piece.x, piece.y]]),
  )
}

function persistedInitialStateSnapshot(value: unknown): unknown {
  return JSON.parse(stableJson(withoutServerSkills(value))) as unknown
}

function makeDeploymentState(seed = 2029) {
  const { map, pieces, runtime } = buildDeployment(seed)
  const state = makeState({ pieces: pieces as any, phase: 'start' }) as any
  state.map = map
  state.gameStartFired = false
  state.deployment = {
    status: 'awaiting-locks',
    playerIds: [...PLAYERS].sort(),
    choices: {},
    locks: Object.fromEntries(PLAYERS.map(playerId => [playerId, { locked: false }])),
    startedAt: 1_000,
    deadlineAt: 1_000 + DEPLOYMENT_DURATION_MS,
    revision: 0,
    initialPositions: Object.fromEntries(pieces.map(piece => [
      piece.instanceId,
      { x: piece.x, y: piece.y },
    ])),
  }
  pinTestBattleState(state, seed)
  recordBattleInitialization(state, runtime, [...PLAYERS].sort())
  return state
}

describe('RED-29 deterministic deployment', () => {
  it('allocates sixteen unique core pieces on ordinary floor with a frozen cursor count', () => {
    const { map, pieces, runtime } = buildDeployment(0x12345678)

    expect(pieces).toHaveLength(16)
    expect(new Set(pieces.map(piece => `${piece.x},${piece.y}`)).size).toBe(16)
    expect(pieces.every(piece => piece.isCore === true)).toBe(true)
    expect(pieces.filter(piece => piece.ownerPlayerId === PLAYERS[0])).toHaveLength(8)
    expect(pieces.filter(piece => piece.ownerPlayerId === PLAYERS[1])).toHaveLength(8)
    expect(pieces.every(piece => map.tiles.some(tile => (
      tile.x === piece.x
      && tile.y === piece.y
      && tile.props.walkable === true
      && tile.props.type === 'floor'
    )))).toBe(true)
    expect(runtime.getCursor(RANDOM_STREAM_NAMES.deployment)).toBe(16)
    expect(positions(pieces)).toEqual({
      'player-blue-1': [3, 3], 'player-blue-2': [3, 2], 'player-blue-3': [4, 4], 'player-blue-4': [2, 4],
      'player-blue-5': [1, 2], 'player-blue-6': [5, 0], 'player-blue-7': [0, 2], 'player-blue-8': [6, 1],
      'player-red-1': [1, 4], 'player-red-2': [6, 3], 'player-red-3': [2, 3], 'player-red-4': [3, 1],
      'player-red-5': [0, 1], 'player-red-6': [6, 0], 'player-red-7': [4, 3], 'player-red-8': [2, 0],
    })
  })

  it('is stable across player/seat array order and changes with the root seed', () => {
    expect(positions(buildDeployment(77).pieces)).toEqual(positions(buildDeployment(77, true).pieces))
    expect(positions(buildDeployment(77).pieces)).not.toEqual(positions(buildDeployment(78).pieces))
  })

  it.each(SELECTABLE_MAP_IDS)('preserves deterministic sixteen-piece deployment on %s', mapId => {
    const map = getMapById(mapId)
    if (!map) throw new Error(`Expected loaded map ${mapId}`)

    const first = buildDeploymentOnMap(map, 0x1190)
    const reordered = buildDeploymentOnMap(map, 0x1190, true)

    expect(first.pieces).toHaveLength(16)
    expect(new Set(first.pieces.map(piece => `${piece.x},${piece.y}`)).size).toBe(16)
    expect(positions(first.pieces)).toEqual(positions(reordered.pieces))
    expect(first.runtime.getCursor(RANDOM_STREAM_NAMES.deployment)).toBe(16)
    expect(reordered.runtime.getCursor(RANDOM_STREAM_NAMES.deployment)).toBe(16)
    expect(first.pieces.every(piece => map.tiles.some(tile => (
      tile.x === piece.x
      && tile.y === piece.y
      && tile.props.walkable === true
      && tile.props.type === 'floor'
    )))).toBe(true)
  })

  it.each(SELECTABLE_MAP_IDS)('creates an identical complete initial state on %s for fixed and reordered inputs', async mapId => {
    const red = makeTemplates('red')
    const blue = makeTemplates('blue')
    const roster = [
      { playerId: PLAYERS[0], pieces: red, faction: 'red' as const, alignment: 'light' as const },
      { playerId: PLAYERS[1], pieces: blue, faction: 'blue' as const, alignment: 'dark' as const },
    ]
    const selectedPieces = [...red, ...blue]
    const options = {
      firstPlayerId: PLAYERS[0],
      rootSeed: 0x1190cafe,
      deploymentEnabled: true,
      deploymentMode: 'legacy-reroll-v1' as const,
      deploymentStartedAt: 1_750_000_000_000,
    }
    const create = (
      playerIds: string[],
      playerSelectedPieces: typeof roster,
    ) => createInitialBattleForPlayers(
      playerIds,
      selectedPieces,
      playerSelectedPieces,
      mapId,
      options,
    )

    const first = await create([...PLAYERS], roster)
    const repeated = await create([...PLAYERS], roster)
    const reordered = await create(
      [...PLAYERS].reverse(),
      [...roster].reverse(),
    )

    expect(first).not.toBeNull()
    // The room authority persists exactly without `skillsById`; stable JSON also omits the
    // rehydrated rule-effect functions that cannot cross the storage/transport boundary.
    const expected = persistedInitialStateSnapshot(first)
    expect(first).toHaveProperty('skillsById')
    expect(expected).not.toHaveProperty('skillsById')

    expect(persistedInitialStateSnapshot(repeated)).toEqual(expected)
    expect(persistedInitialStateSnapshot(reordered)).toEqual(expected)
  })

  it('keeps the legacy Kiljaedan gameStart ritual bound outside progressive setup', async () => {
    const kiljaedan = getPieceById('kiljaedan')
    if (!kiljaedan) throw new Error('Expected Kiljaedan template')
    expect(kiljaedan.rules).toContain('rule-kiljaedan-gamestart')
    const red = [kiljaedan, ...makeTemplates('red').slice(0, 7)]
    const blue = makeTemplates('blue')
    const seed = 0x1381e9ac
    const legacy = await createInitialBattleForPlayers(
      [...PLAYERS],
      [...red, ...blue],
      [
        { playerId: PLAYERS[0], pieces: red, faction: 'red', alignment: 'dark' },
        { playerId: PLAYERS[1], pieces: blue, faction: 'blue', alignment: 'light' },
      ],
      'large-hole-arena',
      {
        firstPlayerId: PLAYERS[0],
        rootSeed: seed,
        deploymentEnabled: true,
        deploymentMode: 'legacy-reroll-v1',
        deploymentStartedAt: 1_750_000_000_000,
      },
    )
    if (!legacy) throw new Error('Expected legacy battle')
    expect(legacy.pieces.some(piece => piece.templateId === 'kiljaedan')).toBe(true)

    const redLocked = runBattleAction(legacy, {
      type: 'deploymentLock',
      playerId: PLAYERS[0],
      clientActionId: 'legacy-kj-red-lock',
    }, { rootSeed: seed }).state
    const completed = runBattleAction(redLocked, {
      type: 'deploymentLock',
      playerId: PLAYERS[1],
      clientActionId: 'legacy-kj-blue-lock',
    }, { rootSeed: seed }).state

    expect(completed.gameStartFired).toBe(true)
    expect(completed.pieces.some(piece => piece.templateId === 'kiljaedan')).toBe(false)
    expect(completed.extensions?.kiljaedanPiece).toMatchObject({
      templateId: 'kiljaedan',
      ownerPlayerId: PLAYERS[0],
      isCore: true,
    })
    expect(completed.players.find(player => player.playerId === PLAYERS[0])?.hand)
      .toContainEqual(expect.objectContaining({ cardId: 'demon-summon-1' }))
  })

  it('fails closed on fewer than sixteen ordinary floors before consuming deployment random', () => {
    const map = makeDeploymentMap()
    map.tiles = map.tiles.filter(tile => tile.props.type === 'floor').slice(0, 15)
    const red = makeTemplates('red')
    const blue = makeTemplates('blue')
    const runtime = new RuleRuntime({ rootSeed: 91 })

    expect(() => buildInitialPiecesForPlayers(
      map,
      [...PLAYERS],
      [...red, ...blue],
      [
        { playerId: PLAYERS[0], pieces: red, faction: 'red' },
        { playerId: PLAYERS[1], pieces: blue, faction: 'blue' },
      ],
      () => runtime.nextRandom(RANDOM_STREAM_NAMES.deployment),
      { deterministicDeployment: true },
    )).toThrow('sixteen ordinary floor')
    expect(runtime.getCursor(RANDOM_STREAM_NAMES.deployment)).toBe(0)
  })

  it('records initial positions and the fixed deployment cursor in initialization trace', () => {
    const state = makeDeploymentState()
    const initialization = state.extensions.debugBattle.actionLog[0]

    expect(initialization.deployment.initialPositions).toEqual(state.deployment.initialPositions)
    expect(initialization.randomStreams).toContainEqual(expect.objectContaining({
      name: RANDOM_STREAM_NAMES.deployment,
      startCursor: 0,
      endCursor: 16,
    }))
  })

  it('resolves choices only after both players lock and is independent of submission order', () => {
    const initial = makeDeploymentState()
    const redPiece = initial.pieces.find((piece: any) => piece.ownerPlayerId === PLAYERS[0])
    const bluePiece = initial.pieces.find((piece: any) => piece.ownerPlayerId === PLAYERS[1])
    const before = positions(initial.pieces)

    const redFirst = runBattleAction(initial, {
      type: 'deploymentChoice', playerId: PLAYERS[0], pieceId: redPiece.instanceId, clientActionId: 'red-choice',
    } as any, { rootSeed: 2029 })
    expect(positions(redFirst.state.pieces)).toEqual(before)
    expect((redFirst.state as any).deployment.status).toBe('awaiting-locks')

    const redLocked = runBattleAction(redFirst.state, {
      type: 'deploymentLock', playerId: PLAYERS[0], clientActionId: 'red-lock',
    } as any, { rootSeed: 2029 })
    expect(positions(redLocked.state.pieces)).toEqual(before)
    expect((redLocked.state as any).deployment.locks[PLAYERS[0]]).toMatchObject({ locked: true, reason: 'player' })

    const redThenBlueChoice = runBattleAction(redLocked.state, {
      type: 'deploymentChoice', playerId: PLAYERS[1], pieceId: bluePiece.instanceId, clientActionId: 'blue-choice',
    } as any, { rootSeed: 2029 })
    const redThenBlue = runBattleAction(redThenBlueChoice.state, {
      type: 'deploymentLock', playerId: PLAYERS[1], clientActionId: 'blue-lock',
    } as any, { rootSeed: 2029 })

    const blueFirst = runBattleAction(initial, {
      type: 'deploymentChoice', playerId: PLAYERS[1], pieceId: bluePiece.instanceId, clientActionId: 'blue-choice',
    } as any, { rootSeed: 2029 })
    const blueLocked = runBattleAction(blueFirst.state, {
      type: 'deploymentLock', playerId: PLAYERS[1], clientActionId: 'blue-lock',
    } as any, { rootSeed: 2029 })
    const blueThenRedChoice = runBattleAction(blueLocked.state, {
      type: 'deploymentChoice', playerId: PLAYERS[0], pieceId: redPiece.instanceId, clientActionId: 'red-choice',
    } as any, { rootSeed: 2029 })
    const blueThenRed = runBattleAction(blueThenRedChoice.state, {
      type: 'deploymentLock', playerId: PLAYERS[0], clientActionId: 'red-lock',
    } as any, { rootSeed: 2029 })

    expect(positions(redThenBlue.state.pieces)).toEqual(positions(blueThenRed.state.pieces))
    expect((redThenBlue.state as any).deployment.status).toBe('complete')
    expect((redThenBlue.state as any).gameStartFired).toBe(true)
    expect((redThenBlue.state as any).turn.phase).toBe('action')
    expect(positions(redThenBlue.state.pieces)[redPiece.instanceId]).not.toEqual(before[redPiece.instanceId])
    expect(positions(redThenBlue.state.pieces)[bluePiece.instanceId]).not.toEqual(before[bluePiece.instanceId])
    expect(redThenBlue.trace?.randomStreams).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: `deployment-reroll/${PLAYERS[0]}`, startCursor: 0, endCursor: 1 }),
      expect.objectContaining({ name: `deployment-reroll/${PLAYERS[1]}`, startCursor: 0, endCursor: 1 }),
    ]))
    expect(redThenBlue.trace?.deployment).toMatchObject({
      choices: {
        [PLAYERS[0]]: { pieceId: redPiece.instanceId },
        [PLAYERS[1]]: { pieceId: bluePiece.instanceId },
      },
      finalPositions: expect.any(Object),
    })
    expect(positions(redThenBlue.state.pieces)).toEqual({
      'player-blue-1': [2, 1], 'player-blue-2': [1, 4], 'player-blue-3': [3, 4], 'player-blue-4': [0, 3],
      'player-blue-5': [0, 4], 'player-blue-6': [4, 2], 'player-blue-7': [6, 3], 'player-blue-8': [3, 3],
      'player-red-1': [1, 0], 'player-red-2': [6, 0], 'player-red-3': [4, 1], 'player-red-4': [5, 3],
      'player-red-5': [5, 2], 'player-red-6': [6, 1], 'player-red-7': [2, 2], 'player-red-8': [3, 2],
    })
  })

  it('supports locking with no selection without consuming a reroll stream', () => {
    const initial = makeDeploymentState()
    const red = runBattleAction(initial, {
      type: 'deploymentLock', playerId: PLAYERS[0], clientActionId: 'red-lock',
    } as any, { rootSeed: 2029 })
    const complete = runBattleAction(red.state, {
      type: 'deploymentLock', playerId: PLAYERS[1], clientActionId: 'blue-lock',
    } as any, { rootSeed: 2029 })

    expect(positions(complete.state.pieces)).toEqual(positions(initial.pieces))
    expect(complete.trace?.randomStreams.some(stream => stream.name.startsWith('deployment-reroll/'))).toBe(false)
  })

  it.each([
    ['unknown', () => 'missing-piece'],
    ['enemy', (state: any) => state.pieces.find((piece: any) => piece.ownerPlayerId === PLAYERS[1]).instanceId],
    ['summon', (state: any) => {
      const summon = { ...state.pieces[0], instanceId: 'summon-1', isCore: false }
      state.pieces.push(summon)
      return summon.instanceId
    }],
    ['defeated', (state: any) => {
      const piece = state.pieces.find((candidate: any) => candidate.ownerPlayerId === PLAYERS[0])
      piece.currentHp = 0
      return piece.instanceId
    }],
    ['multi-piece', (state: any) => state.pieces
      .filter((piece: any) => piece.ownerPlayerId === PLAYERS[0])
      .slice(0, 2)
      .map((piece: any) => piece.instanceId)],
  ])('rejects a %s piece atomically before random consumption', (_name, selectPiece) => {
    const state = makeDeploymentState()
    const pieceId = selectPiece(state)
    const before = JSON.parse(JSON.stringify(state))

    expect(() => runBattleAction(state, {
      type: 'deploymentChoice', playerId: PLAYERS[0], pieceId, clientActionId: 'invalid-choice',
    } as any, { rootSeed: 2029 })).toThrow()
    expect(state).toEqual(before)
  })

  it('allows selection replacement and cancellation before lock, then rejects mutation and repeated lock', () => {
    const initial = makeDeploymentState()
    const owned = initial.pieces.filter((piece: any) => piece.ownerPlayerId === PLAYERS[0])

    const selected = runBattleAction(initial, {
      type: 'deploymentChoice', playerId: PLAYERS[0], pieceId: owned[0].instanceId, clientActionId: 'select-one',
    } as any, { rootSeed: 2029 })
    const replaced = runBattleAction(selected.state, {
      type: 'deploymentChoice', playerId: PLAYERS[0], pieceId: owned[1].instanceId, clientActionId: 'select-two',
    } as any, { rootSeed: 2029 })
    const cancelled = runBattleAction(replaced.state, {
      type: 'deploymentChoice', playerId: PLAYERS[0], pieceId: null, clientActionId: 'cancel',
    } as any, { rootSeed: 2029 })
    const locked = runBattleAction(cancelled.state, {
      type: 'deploymentLock', playerId: PLAYERS[0], clientActionId: 'lock',
    } as any, { rootSeed: 2029 })
    const lockedBefore = JSON.parse(JSON.stringify(locked.state))

    expect((cancelled.state as any).deployment.choices[PLAYERS[0]]).toEqual({ pieceId: null })
    expect(() => runBattleAction(locked.state, {
      type: 'deploymentChoice', playerId: PLAYERS[0], pieceId: owned[0].instanceId, clientActionId: 'change-after-lock',
    } as any, { rootSeed: 2029 })).toThrow(/locked/i)
    expect(() => runBattleAction(locked.state, {
      type: 'deploymentLock', playerId: PLAYERS[0], clientActionId: 'lock-again',
    } as any, { rootSeed: 2029 })).toThrow(/locked/i)
    expect(locked.state).toEqual(lockedBefore)
  })

  it('publishes identical complete positions to both viewers without exposing pending choices', () => {
    const initial = makeDeploymentState()
    const selectedPiece = initial.pieces.find((piece: any) => piece.ownerPlayerId === PLAYERS[0])
    const selected = runBattleAction(initial, {
      type: 'deploymentChoice', playerId: PLAYERS[0], pieceId: selectedPiece.instanceId, clientActionId: 'private-select',
    } as any, { rootSeed: 2029 })
    const locked = runBattleAction(selected.state, {
      type: 'deploymentLock', playerId: PLAYERS[0], clientActionId: 'red-lock',
    } as any, { rootSeed: 2029 })

    const alice = toPublicBattleState(locked.state, PLAYERS[0]) as any
    const bob = toPublicBattleState(locked.state, PLAYERS[1]) as any
    const spectator = toPublicBattleState(locked.state) as any

    expect(alice).toEqual(bob)
    expect(bob).toEqual(spectator)
    expect(alice.pieces.filter((piece: any) => piece.isCore === true)).toHaveLength(16)
    expect(positions(alice.pieces)).toEqual(positions(initial.pieces))
    expect(alice.deployment.choices).toEqual({})
    expect(alice.extensions.debugBattle.actionLog).toEqual([])
    expect(alice.extensions.debugBattle.appliedActionIds).toEqual([])
    expect(alice.deployment.locks).toMatchObject({
      [PLAYERS[0]]: { locked: true },
      [PLAYERS[1]]: { locked: false },
    })
  })

  it('auto-locks all remaining players at the authoritative deadline and resolves once', () => {
    const initial = makeDeploymentState()
    const selectedPiece = initial.pieces.find((piece: any) => piece.ownerPlayerId === PLAYERS[0])
    const selected = runBattleAction(initial, {
      type: 'deploymentChoice', playerId: PLAYERS[0], pieceId: selectedPiece.instanceId, clientActionId: 'red-select',
    } as any, { rootSeed: 2029 })

    expect(() => runBattleAction(selected.state, {
      type: 'deploymentTimeout', now: initial.deployment.deadlineAt - 1, clientActionId: 'too-early',
    } as any, { rootSeed: 2029 })).toThrow(/deadline/i)

    const timedOut = runBattleAction(selected.state, {
      type: 'deploymentTimeout', now: initial.deployment.deadlineAt, clientActionId: 'deadline',
    } as any, { rootSeed: 2029 })

    expect((timedOut.state as any).deployment).toMatchObject({
      status: 'complete',
      locks: {
        [PLAYERS[0]]: { locked: true, reason: 'timeout' },
        [PLAYERS[1]]: { locked: true, reason: 'timeout' },
      },
    })
    expect((timedOut.state as any).turn.phase).toBe('action')
    expect(timedOut.trace?.deployment).toMatchObject({
      command: 'timeout',
      timedOutPlayerIds: [...PLAYERS].sort(),
      finalPositions: expect.any(Object),
    })
  })

  it('keeps a locked reroll while an unlocked opponent times out and keeps all pieces', () => {
    const initial = makeDeploymentState()
    const before = positions(initial.pieces)
    const redPiece = initial.pieces.find((piece: any) => piece.ownerPlayerId === PLAYERS[0])
    const bluePieces = initial.pieces.filter((piece: any) => piece.ownerPlayerId === PLAYERS[1])
    const selected = runBattleAction(initial, {
      type: 'deploymentChoice',
      playerId: PLAYERS[0],
      pieceId: redPiece.instanceId,
      clientActionId: 'red-timeout-select',
    } as any, { rootSeed: 2029 })
    const locked = runBattleAction(selected.state, {
      type: 'deploymentLock',
      playerId: PLAYERS[0],
      clientActionId: 'red-timeout-lock',
    } as any, { rootSeed: 2029 })
    const timedOut = runBattleAction(locked.state, {
      type: 'deploymentTimeout',
      now: initial.deployment.deadlineAt,
      clientActionId: 'blue-timeout',
    } as any, { rootSeed: 2029 })
    const after = positions(timedOut.state.pieces)

    expect((timedOut.state as any).deployment).toMatchObject({
      status: 'complete',
      locks: {
        [PLAYERS[0]]: { locked: true, reason: 'player' },
        [PLAYERS[1]]: { locked: true, reason: 'timeout' },
      },
    })
    expect(after[redPiece.instanceId]).not.toEqual(before[redPiece.instanceId])
    for (const piece of bluePieces) {
      expect(after[piece.instanceId]).toEqual(before[piece.instanceId])
    }
    expect(timedOut.trace?.deployment).toMatchObject({
      command: 'timeout',
      timedOutPlayerIds: [PLAYERS[1]],
    })
  })

  it('rejects ordinary actions during deployment and deployment commands after completion', () => {
    const initial = makeDeploymentState()
    expect(() => runBattleAction(initial, { type: 'beginPhase', clientActionId: 'too-early' } as any, { rootSeed: 2029 })).toThrow()

    const red = runBattleAction(initial, {
      type: 'deploymentLock', playerId: PLAYERS[0], clientActionId: 'red-lock',
    } as any, { rootSeed: 2029 })
    const complete = runBattleAction(red.state, {
      type: 'deploymentLock', playerId: PLAYERS[1], clientActionId: 'blue-lock',
    } as any, { rootSeed: 2029 })
    expect(() => runBattleAction(complete.state, {
      type: 'deploymentChoice', playerId: PLAYERS[0], pieceId: null, clientActionId: 'late-choice',
    } as any, { rootSeed: 2029 })).toThrow()
  })

  it('strips core identity from summons even if a factory accidentally copies it', () => {
    const state = makeState({ pieces: [] }) as any
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const result = summonPiece(
      state,
      { templateId: 'summon', faction: 'red', ownerPlayerId: PLAYERS[0], x: 1, y: 1 },
      () => ({ id: 'summon', rules: [] }),
      () => ({
        instanceId: 'summon-1', templateId: 'summon', name: 'Summon', ownerPlayerId: PLAYERS[0], faction: 'red',
        currentHp: 1, maxHp: 1, attack: 0, defense: 0, x: 1, y: 1, moveRange: 1, skills: [], buffs: [], debuffs: [],
        ruleTags: [], statusTags: [], rules: [], isCore: true,
      } as any),
    )

    expect(result.success).toBe(true)
    expect(result.piece?.isCore).toBe(false)
  })
})
