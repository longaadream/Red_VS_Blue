/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { recordBattleInitialization } from '@/lib/game/battle-trace'
import {
  clearRoomDeploymentTimeout,
  createPublicBattleSnapshot,
  dispatchRoomBattleAction,
  type DeploymentRoomStore,
  scheduleRoomDeploymentTimeout,
} from '@/lib/game/room-battle-actions'
import type { Room } from '@/lib/game/room-model'
import type { BattleAuthorityReceipt } from '@/lib/game/battle-transition'
import { createTestServerBattleState, pinTestBattleState } from './profile-test-identity'
import { RuleRuntime } from '@/lib/game/rule-runtime'
import { loadRuleById } from '@/lib/game/skills'
import { makePiece, makeState } from '../helpers/minimal-state'

const PLAYERS = ['player-red', 'player-blue'] as const
const originalTurnTimerFlag = process.env.RVB_TURN_TIMER_ENABLED
beforeAll(() => { process.env.RVB_TURN_TIMER_ENABLED = '1' })
afterAll(() => {
  if (originalTurnTimerFlag === undefined) delete process.env.RVB_TURN_TIMER_ENABLED
  else process.env.RVB_TURN_TIMER_ENABLED = originalTurnTimerFlag
})
const ROOT_SEED = 2029

class MemoryRoomStore implements DeploymentRoomStore {
  room: Room
  writes = 0
  readonly receipts = new Map<string, BattleAuthorityReceipt>()

  constructor(room: Room) {
    this.room = clone(room)
  }

  async getRoom(roomId: string): Promise<Room | undefined> {
    return this.room.id === roomId ? clone(this.room) : undefined
  }

  async setRoom(roomId: string, room: Room): Promise<void> {
    if (roomId !== this.room.id) throw new Error('Room not found')
    this.room = { ...clone(room), version: (this.room.version ?? 0) + 1 }
    this.writes += 1
  }

  async setRoomIfVersion(roomId: string, room: Room, expectedVersion: number): Promise<boolean> {
    if (roomId !== this.room.id || this.room.version !== expectedVersion) return false
    this.room = { ...clone(room), version: expectedVersion + 1 }
    this.writes += 1
    return true
  }

  async getBattleAuthorityReceipt(_roomId: string, clientActionId: string) {
    return this.receipts.get(clientActionId)
  }

  async persistBattleAuthorityReceipt(receipt: BattleAuthorityReceipt) {
    this.receipts.set(receipt.clientActionId, clone(receipt))
  }

  inspectBattleAuthorityPersistence() {
    const authorityVersion = this.room.battleAuthorityVersion ?? 0
    return { status: 'durable' as const, authorityVersion, durableAuthorityVersion: authorityVersion, pending: 0 }
  }

  async commitBattleAuthorityTransition(
    input: Parameters<NonNullable<DeploymentRoomStore['commitBattleAuthorityTransition']>>[0],
  ): Promise<boolean> {
    if ((this.room.battleAuthorityVersion ?? 0) !== input.expectedVersion) return false
    this.room = {
      ...clone(input.nextRoom),
      battleAuthorityVersion: input.transition.toVersion,
      battleAuthorityDurableVersion: input.transition.toVersion,
      battleAuthorityPersistenceStatus: 'durable',
      battleAuthorityTransitionHash: input.transition.transitionHash,
    }
    this.receipts.set(input.transition.clientActionId, clone(input.transition.receipt))
    this.writes += 1
    return true
  }
}

function makeDeploymentRoom(id = 'deployment-room', deadlineAt = 46_000): Room {
  const pieces = Array.from({ length: 16 }, (_, index) => {
    const ownerPlayerId = index < 8 ? PLAYERS[0] : PLAYERS[1]
    return {
      ...makePiece({
        instanceId: `piece-${index + 1}`,
        ownerPlayerId,
        faction: index < 8 ? 'red' : 'blue',
        x: index % 6,
        y: Math.floor(index / 6),
      }),
      isCore: true,
    }
  })
  const state = makeState({ pieces: pieces as any, phase: 'start' }) as any
  state.gameStartFired = false
  state.deployment = {
    status: 'awaiting-locks',
    playerIds: [...PLAYERS],
    choices: {},
    locks: {
      [PLAYERS[0]]: { locked: false },
      [PLAYERS[1]]: { locked: false },
    },
    startedAt: 1_000,
    deadlineAt,
    revision: 0,
    initialPositions: Object.fromEntries(pieces.map(piece => [
      piece.instanceId,
      { x: piece.x, y: piece.y },
    ])),
  }
  pinTestBattleState(state, ROOT_SEED)
  recordBattleInitialization(state, new RuleRuntime({ rootSeed: ROOT_SEED }), [...PLAYERS])

  return {
    id,
    name: id,
    status: 'in-progress',
    players: [
      { id: PLAYERS[0], name: 'Red', seat: 'red', alignment: 'light' },
      { id: PLAYERS[1], name: 'Blue', seat: 'blue', alignment: 'dark' },
    ],
    spectators: [],
    currentTurnIndex: 0,
    actions: [],
    version: 1,
    battleState: createTestServerBattleState(state, ROOT_SEED) as any,
  }
}

function makeWatcherDeploymentRoom(id = 'watcher-deployment-room', deadlineAt = 5_000): Room {
  const room = makeDeploymentRoom(id, deadlineAt)
  const state = (room.battleState as any).state
  const watcher = state.pieces.find((piece: any) => piece.instanceId === 'piece-1')
  const watcherRule = loadRuleById('rule-watcher-form', true)
  if (!watcher || !watcherRule) throw new Error('Watcher deployment fixture could not load')
  watcher.templateId = 'blue-watcher'
  watcher.name = '观者'
  watcher.rules = [watcherRule]
  return room
}

function makeProgressiveDeploymentRoom(id = 'progressive-deployment-room'): Room {
  const reservePiece = (instanceId: string, ownerPlayerId: string, faction: 'red' | 'blue') => ({
    ...makePiece({ instanceId, ownerPlayerId, faction, x: 0, y: 0, moveRange: 2 }),
    isCore: true,
    name: instanceId,
    x: null,
    y: null,
    buffs: [],
    debuffs: [],
    ruleTags: [],
  })
  const redReserve = reservePiece('red-reserve', PLAYERS[0], 'red')
  const blueReserve = reservePiece('blue-reserve', PLAYERS[1], 'blue')
  const redVanguard = {
    ...makePiece({
      instanceId: 'red-vanguard',
      ownerPlayerId: PLAYERS[0],
      faction: 'red',
      x: 5,
      y: 4,
    }),
    isCore: true,
  }
  const blueVanguard = {
    ...makePiece({
      instanceId: 'blue-vanguard',
      ownerPlayerId: PLAYERS[1],
      faction: 'blue',
      x: 5,
      y: 3,
    }),
    isCore: true,
  }
  const state = makeState({
    pieces: [redVanguard, blueVanguard],
    currentPlayerId: PLAYERS[0],
    phase: 'start',
  }) as any
  state.gameStartFired = true
  state.deployment = {
    mode: 'progressive-reserve-v1',
    status: 'awaiting-reserve-deploy',
    playerIds: [...PLAYERS],
    choices: {},
    locks: {},
    startedAt: 1_000,
    deadlineAt: 46_000,
    revision: 1,
    initialPositions: {
      [redVanguard.instanceId]: { x: redVanguard.x, y: redVanguard.y },
      [blueVanguard.instanceId]: { x: blueVanguard.x, y: blueVanguard.y },
    },
    reserves: {
      [PLAYERS[0]]: [redReserve],
      [PLAYERS[1]]: [blueReserve],
    },
    reserveCounts: { [PLAYERS[0]]: 1, [PLAYERS[1]]: 1 },
    activePlayerId: PLAYERS[0],
    offerTurnNumber: 1,
    offerPieceIds: [redReserve.instanceId],
    legalPositions: [{ x: 0, y: 0 }],
  }
  pinTestBattleState(state, ROOT_SEED)
  recordBattleInitialization(state, new RuleRuntime({ rootSeed: ROOT_SEED }), [...PLAYERS])

  return {
    id,
    name: id,
    status: 'in-progress',
    players: [
      { id: PLAYERS[0], name: 'Red', seat: 'red', alignment: 'light' },
      { id: PLAYERS[1], name: 'Blue', seat: 'blue', alignment: 'dark' },
    ],
    spectators: [],
    currentTurnIndex: 0,
    actions: [],
    version: 1,
    battleState: createTestServerBattleState(state, ROOT_SEED) as any,
  }
}

describe('RED-138 progressive deployment room authority', () => {
  it('projects the private offer only to its owner and commits directly into tagged action play', async () => {
    const store = new MemoryRoomStore(makeProgressiveDeploymentRoom())
    const clock = { now: () => 2_000 }
    const ownerBefore = createPublicBattleSnapshot(store.room, PLAYERS[0], clock).state
    const opponentBefore = createPublicBattleSnapshot(store.room, PLAYERS[1], clock).state
    const beforeAp = (store.room.battleState as any).state.players
      .find((player: any) => player.playerId === PLAYERS[0]).actionPoints

    expect(ownerBefore.deployment?.offerPieceIds).toEqual(['red-reserve'])
    expect(ownerBefore.deployment?.legalPositions).toEqual([{ x: 0, y: 0 }])
    expect(ownerBefore.deployment?.reserves).toEqual({})
    expect(opponentBefore.deployment?.offerPieceIds).toEqual([])
    expect(opponentBefore.deployment?.legalPositions).toEqual([])
    expect(JSON.stringify(opponentBefore)).not.toContain('red-reserve')

    const deployed = await dispatchRoomBattleAction(store, store.room.id, PLAYERS[0], {
      type: 'deployReservePiece',
      playerId: PLAYERS[0],
      expectedDeploymentRevision: ownerBefore.deployment!.revision,
      pieceId: 'red-reserve',
      toX: 0,
      toY: 0,
      clientActionId: 'progressive-deploy-red',
    }, { clock })

    expect(deployed.kind).toBe('applied')
    expect(deployed.snapshot.state.deployment).toMatchObject({
      status: 'turn-ready',
    })
    const authorityState = (store.room.battleState as any).state
    expect(authorityState.pieces).toContainEqual(expect.objectContaining({
      instanceId: 'red-reserve',
      isCore: true,
      x: 0,
      y: 0,
      statusTags: [expect.objectContaining({
        type: 'deployment-first-move-free',
        grantedTurnNumber: authorityState.turn.turnNumber,
      })],
    }))
    expect(authorityState.deployment.reserves[PLAYERS[0]]).toEqual([])
    expect(authorityState.players.find((player: any) => player.playerId === PLAYERS[0]).actionPoints)
      .toBe(beforeAp)

    expect(authorityState.turn.phase).toBe('action')
    expect(authorityState.deployment.status).toBe('turn-ready')
    expect(store.writes).toBe(1)
  })
})

describe('RED-31 authoritative deployment room actions', () => {
  it('accepts a late deployment lock without settling timeout when the timer flag is disabled', async () => {
    const savedFlag = process.env.RVB_TURN_TIMER_ENABLED
    const store = new MemoryRoomStore(makeDeploymentRoom('timer-off-late-deployment-room'))

    try {
      delete process.env.RVB_TURN_TIMER_ENABLED
      const result = await dispatchRoomBattleAction(store, store.room.id, PLAYERS[0], {
        type: 'deploymentLock',
        playerId: PLAYERS[0],
        clientActionId: 'timer-off-late-deployment-lock',
      }, { clock: { now: () => 50_000 } })

      expect(result.kind).toBe('applied')
      expect(result.expiredReason).toBeUndefined()
      const state = (store.room.battleState as any).state
      expect(state.deployment.locks[PLAYERS[0]]).toMatchObject({ locked: true, reason: 'player' })
      expect(state.deployment.timedOutPlayerIds ?? []).not.toContain(PLAYERS[0])
    } finally {
      if (savedFlag === undefined) delete process.env.RVB_TURN_TIMER_ENABLED
      else process.env.RVB_TURN_TIMER_ENABLED = savedFlag
    }
  })
  it('serializes simultaneous locks with room CAS and resolves final positions exactly once', async () => {
    const store = new MemoryRoomStore(makeDeploymentRoom())

    const [red, blue] = await Promise.all([
      dispatchRoomBattleAction(store, store.room.id, PLAYERS[0], {
        type: 'deploymentLock',
        playerId: PLAYERS[0],
        clientActionId: 'red-lock',
      }, { clock: { now: () => 2_000 } }),
      dispatchRoomBattleAction(store, store.room.id, PLAYERS[1], {
        type: 'deploymentLock',
        playerId: PLAYERS[1],
        clientActionId: 'blue-lock',
      }, { clock: { now: () => 2_000 } }),
    ])

    expect([red.snapshot.authorityVersion, blue.snapshot.authorityVersion].sort()).toEqual([1, 2])
    expect(store.room.battleAuthorityVersion).toBe(2)
    expect(store.writes).toBe(2)
    const state = (store.room.battleState as any).state
    expect(state.deployment.status).toBe('complete')
    expect(state.turn.phase).toBe('action')
    expect([red.transition, blue.transition].filter(transition => transition?.toVersion === 2))
      .toHaveLength(1)
    expect([red.nextAuthorityState, blue.nextAuthorityState].find(candidate => (
      candidate?.deployment?.status === 'complete'
    ))?.deployment?.revision).toBeGreaterThan(0)
  })

  it('atomically commits surrender during deployment and rejects every later command', async () => {
    const store = new MemoryRoomStore(makeDeploymentRoom('terminal-room'))

    const result = await dispatchRoomBattleAction(store, store.room.id, PLAYERS[0], {
      type: 'surrender',
      playerId: PLAYERS[0],
      reason: 'voluntary',
      clientActionId: 'deployment-surrender',
    } as any, { clock: { now: () => 2_000 } })

    expect(result.kind).toBe('applied')
    expect(result.snapshot.state.terminalResult).toMatchObject({
      status: 'finished',
      winnerPlayerId: PLAYERS[1],
      loserPlayerId: PLAYERS[0],
      reason: 'surrender',
    })
    expect(store.room).toMatchObject({ status: 'finished', battleAuthorityVersion: 1 })
    expect(store.writes).toBe(1)

    await expect(dispatchRoomBattleAction(store, store.room.id, PLAYERS[1], {
      type: 'deploymentLock',
      playerId: PLAYERS[1],
      clientActionId: 'late-blue-lock',
    })).rejects.toMatchObject({ code: 'BATTLE_ALREADY_TERMINAL' })
    expect(store.room).toMatchObject({ status: 'finished', battleAuthorityVersion: 1 })
    expect(store.writes).toBe(1)
  })

  it('rejects forged, non-participant, and client-authored timeout identities without a write', async () => {
    const store = new MemoryRoomStore(makeDeploymentRoom())
    const before = clone(store.room)

    await expect(dispatchRoomBattleAction(store, store.room.id, PLAYERS[0], {
      type: 'deploymentLock',
      playerId: PLAYERS[1],
      clientActionId: 'forged-player',
    }, { clock: { now: () => 2_000 } })).rejects.toMatchObject({ code: 'ACTION_PLAYER_MISMATCH' })
    await expect(dispatchRoomBattleAction(store, store.room.id, 'outsider', {
      type: 'deploymentLock',
      playerId: 'outsider',
      clientActionId: 'outsider-lock',
    }, { clock: { now: () => 2_000 } })).rejects.toMatchObject({ code: 'VIEWER_FORBIDDEN' })
    await expect(dispatchRoomBattleAction(store, store.room.id, PLAYERS[0], {
      type: 'deploymentTimeout',
      now: 46_000,
      clientActionId: 'forged-timeout',
    }, { clock: { now: () => 46_000 } })).rejects.toMatchObject({ code: 'DEPLOYMENT_SYSTEM_ACTION_FORBIDDEN' })

    await expect(dispatchRoomBattleAction(store, store.room.id, undefined, {
      type: 'deploymentTimeout',
      now: 46_000,
      clientActionId: 'forged-server-time',
    }, {
      allowSystem: true,
      clock: { now: () => 2_000 },
    })).rejects.toThrow(/before the deadline/i)
    expect(store.room).toEqual(before)
    expect(store.writes).toBe(0)
  })

  it('commits timeout instead of a player command that arrives at the deadline', async () => {
    const room = makeDeploymentRoom('timeout-room', 5_000)
    const beforePositions = room.battleState && clone((room.battleState as any).state.pieces)
    const store = new MemoryRoomStore(room)

    const result = await dispatchRoomBattleAction(store, room.id, PLAYERS[0], {
      type: 'deploymentChoice',
      playerId: PLAYERS[0],
      pieceId: 'piece-1',
      clientActionId: 'late-choice',
    }, { clock: { now: () => 5_000 } })

    expect(result.kind).toBe('expired')
    expect(result.snapshot.authorityVersion).toBe(1)
    expect(result.snapshot.state.deployment).toMatchObject({
      status: 'complete',
      locks: {
        [PLAYERS[0]]: { locked: true },
        [PLAYERS[1]]: { locked: true },
      },
    })
    expect((store.room.battleState as any).state.pieces).toEqual(beforePositions)
    expect((store.room.battleState as any).state.deployment.choices).toEqual({
      [PLAYERS[0]]: { pieceId: null },
      [PLAYERS[1]]: { pieceId: null },
    })
  })

  it('accepts the authoritative Watcher option created by deployment timeout after the deadline', async () => {
    const room = makeWatcherDeploymentRoom()
    const store = new MemoryRoomStore(room)

    await dispatchRoomBattleAction(store, room.id, PLAYERS[1], {
      type: 'deploymentLock',
      playerId: PLAYERS[1],
      clientActionId: 'blue-lock-before-watcher-timeout',
    }, { clock: { now: () => 2_000 } })
    await dispatchRoomBattleAction(store, room.id, undefined, {
      type: 'deploymentTimeout',
      now: 5_000,
      clientActionId: 'watcher-deployment-timeout',
    }, {
      allowSystem: true,
      clock: { now: () => 5_000 },
    })

    const timedOutState = (store.room.battleState as any).state
    const pending = timedOutState.pendingOptionSelection
    expect(pending).toMatchObject({
      playerId: PLAYERS[0],
      source: { type: 'rule', id: 'rule-watcher-form', pieceId: 'piece-1' },
    })
    expect(pending.transaction.rootAction).toMatchObject({ type: 'deploymentTimeout' })

    const result = await dispatchRoomBattleAction(store, room.id, PLAYERS[0], {
      type: 'pendingOptionSelect',
      playerId: PLAYERS[0],
      selectedOption: 'calm',
      selectionId: pending.selectionId,
      stateRevision: pending.stateRevision,
      clientActionId: 'watcher-calm-after-deployment-timeout',
    } as any, { clock: { now: () => 5_001 } })
    const completed = (store.room.battleState as any).state

    expect(result.kind).toBe('applied')
    expect(completed.pendingOptionSelection).toBeUndefined()
    expect(completed.deployment.status).toBe('complete')
    expect(completed.turn).toMatchObject({ currentPlayerId: PLAYERS[0], phase: 'action' })
    expect(completed.players.find((player: any) => player.playerId === PLAYERS[0])?.hand)
      .toContainEqual(expect.objectContaining({ cardId: 'watcher-calm' }))
  })


  it('fires the authoritative deadline timer once and broadcasts the committed snapshot', async () => {
    vi.useFakeTimers()
    const room = makeDeploymentRoom('scheduled-timeout-room', 5_000)
    const store = new MemoryRoomStore(room)
    let now = 1_000
    const committed: unknown[] = []

    try {
      await scheduleRoomDeploymentTimeout(store, room.id, {
        clock: { now: () => now },
        onCommitted: snapshot => {
          committed.push(snapshot)
        },
      })
      now = 5_000
      await vi.advanceTimersByTimeAsync(4_000)

      expect(store.writes).toBe(1)
      expect((store.room.battleState as any).state.deployment.status).toBe('complete')
      expect(committed).toHaveLength(1)
      expect((committed[0] as any).authorityVersion).toBe(1)
      await vi.runOnlyPendingTimersAsync()
      expect(store.writes).toBe(1)
    } finally {
      clearRoomDeploymentTimeout(room.id)
      vi.useRealTimers()
    }
  })
  it('does not advance the room version or random cursor for an illegal choice', async () => {
    const store = new MemoryRoomStore(makeDeploymentRoom())
    const before = clone(store.room)

    await expect(dispatchRoomBattleAction(store, store.room.id, PLAYERS[0], {
      type: 'deploymentChoice',
      playerId: PLAYERS[0],
      pieceId: 'piece-16',
      clientActionId: 'enemy-choice',
    }, { clock: { now: () => 2_000 } })).rejects.toThrow(/another player/i)

    expect(store.room).toEqual(before)
    expect(store.writes).toBe(0)
  })

  it('returns the same public state to both players and spectators at one authority version', () => {
    const room = makeDeploymentRoom()
    const internalState = (room.battleState as any).state
    internalState.deployment.choices[PLAYERS[0]] = { pieceId: 'piece-1' }
    const clock = { now: () => 2_000 }

    const red = createPublicBattleSnapshot(room, PLAYERS[0], clock)
    const blue = createPublicBattleSnapshot(room, PLAYERS[1], clock)
    const spectator = createPublicBattleSnapshot(room, undefined, clock)

    expect(red).toEqual(blue)
    expect(blue).toEqual(spectator)
    expect(red.state.pieces.filter(piece => piece.isCore === true)).toHaveLength(16)
    expect(red.state.deployment?.choices).toEqual({})
    expect(red.authorityVersion).toBe(0)
  })
})

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
