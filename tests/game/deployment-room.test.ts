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
import type { Room } from '@/lib/game/room-store'
import { createTestServerBattleState, pinTestBattleState } from './profile-test-identity'
import { RuleRuntime } from '@/lib/game/rule-runtime'
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

    expect([red.snapshot.authorityVersion, blue.snapshot.authorityVersion].sort()).toEqual([2, 3])
    expect(store.room.version).toBe(3)
    expect(store.writes).toBe(2)
    const state = (store.room.battleState as any).state
    expect(state.deployment.status).toBe('complete')
    expect(state.turn.phase).toBe('action')
    expect(state.extensions.debugBattle.actionLog.filter(
      (entry: any) => entry.deployment?.finalPositions,
    )).toHaveLength(1)
    const finalTrace = state.extensions.debugBattle.actionLog.findLast(
      (entry: any) => entry.deployment?.finalPositions,
    )
    expect(finalTrace.deployment.authorityVersion).toBe(3)
    expect(state.extensions.debugBattle.actionLog.every((entry: any) => !entry.deployment || Number.isSafeInteger(entry.deployment.authorityVersion))).toBe(true)
  })

  it('atomically commits surrender during deployment and rejects every later command', async () => {
    const store = new MemoryRoomStore(makeDeploymentRoom('terminal-room'))

    const result = await dispatchRoomBattleAction(store, store.room.id, PLAYERS[0], {
      type: 'surrender',
      playerId: PLAYERS[0],
      reason: 'voluntary',
    }, { clock: { now: () => 2_000 } })

    expect(result.kind).toBe('applied')
    expect(result.snapshot.state.terminalResult).toMatchObject({
      status: 'finished',
      winnerPlayerId: PLAYERS[1],
      loserPlayerId: PLAYERS[0],
      reason: 'surrender',
    })
    expect(store.room).toMatchObject({ status: 'finished', version: 2 })
    expect(store.writes).toBe(1)

    await expect(dispatchRoomBattleAction(store, store.room.id, PLAYERS[1], {
      type: 'deploymentLock',
      playerId: PLAYERS[1],
      clientActionId: 'late-blue-lock',
    })).rejects.toMatchObject({ code: 'BATTLE_ALREADY_TERMINAL' })
    expect(store.room).toMatchObject({ status: 'finished', version: 2 })
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
    expect(result.snapshot.authorityVersion).toBe(2)
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
      expect((committed[0] as any).authorityVersion).toBe(2)
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
    expect(red.authorityVersion).toBe(1)
  })
})

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
