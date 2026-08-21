/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest'

import { recordBattleInitialization } from '@/lib/game/battle-trace'
import {
  clearRoomBattleTimeout,
  createPublicBattleSnapshot,
  dispatchRoomBattleAction,
  scheduleRoomBattleTimeout,
  type DeploymentRoomStore,
  type PublicBattleSnapshot,
} from '@/lib/game/room-battle-actions'
import type { Room } from '@/lib/game/room-store'
import { RuleRuntime } from '@/lib/game/rule-runtime'
import { createRunningTurnTimer, syncTurnTimerAfterAcceptedAction } from '@/lib/game/turn-timer'
import type { BattleState } from '@/lib/game/turn'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

const PLAYERS = ['player-red', 'player-blue'] as const
const ROOT_SEED = 3636

class MemoryRoomStore implements DeploymentRoomStore {
  room: Room
  writes = 0

  constructor(room: Room, private readonly afterCommit?: (writeNumber: number) => void) {
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
    this.afterCommit?.(this.writes)
    return true
  }
}

class ConflictOnceRoomStore extends MemoryRoomStore {
  attempts = 0

  override async setRoomIfVersion(roomId: string, room: Room, expectedVersion: number): Promise<boolean> {
    this.attempts += 1
    if (this.attempts === 1) {
      this.room = { ...clone(this.room), version: expectedVersion + 1 }
      return false
    }
    return super.setRoomIfVersion(roomId, room, expectedVersion)
  }
}

class FakeClock {
  constructor(public value: number) {}
  now() { return this.value }
}

class SequenceClock {
  private index = 0
  constructor(private readonly values: number[]) {}
  now() {
    const value = this.values[Math.min(this.index, this.values.length - 1)]
    this.index += 1
    return value
  }
}

function makeTimedRoom(id = 'turn-timer-room', now = 0): Room {
  const redPiece = {
    ...makePiece({ instanceId: 'red-piece', ownerPlayerId: PLAYERS[0], x: 0, y: 0 }),
    isCore: true,
  }
  const bluePiece = {
    ...makePiece({ instanceId: 'blue-piece', ownerPlayerId: PLAYERS[1], faction: 'blue', x: 4, y: 4 }),
    isCore: true,
  }
  const state = makeState({ pieces: [redPiece as any, bluePiece as any], phase: 'action' })
  state.turnTimer = createRunningTurnTimer(state, now)
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
    battleState: { type: 'server-state', seed: ROOT_SEED, state } as any,
  }
}

function authoritativeState(store: MemoryRoomStore): BattleState {
  return (store.room.battleState as any).state
}

async function expireCurrentTurn(store: MemoryRoomStore, clock: FakeClock) {
  const state = authoritativeState(store)
  clock.value = state.turnTimer!.deadlineAt
  return dispatchRoomBattleAction(store, store.room.id, state.turn.currentPlayerId, {
    type: 'endTurn',
    playerId: state.turn.currentPlayerId,
    clientActionId: `late-end:${state.turn.turnNumber}`,
  } as any, { clock })
}

async function finishCurrentTurnNormally(store: MemoryRoomStore, clock: FakeClock) {
  let state = authoritativeState(store)
  const playerId = state.turn.currentPlayerId
  clock.value += 1
  await dispatchRoomBattleAction(store, store.room.id, playerId, {
    type: 'endTurn',
    playerId,
    clientActionId: `normal-end:${state.turn.turnNumber}`,
  } as any, { clock })
  state = authoritativeState(store)
  expect(state.turn.phase).toBe('end')
  clock.value += 1
  await dispatchRoomBattleAction(store, store.room.id, playerId, {
    type: 'beginPhase',
    clientActionId: `normal-begin:${state.turn.turnNumber}`,
  } as any, { clock })
}

describe('RED-36 authoritative room timer integration', () => {
  it('excludes accepted command processing time and resets the acting player streak', async () => {
    const store = new MemoryRoomStore(makeTimedRoom('pause-resume-room'))
    const clock = new SequenceClock([10_000, 20_000, 20_000])

    await dispatchRoomBattleAction(store, store.room.id, PLAYERS[0], {
      type: 'move',
      playerId: PLAYERS[0],
      pieceId: 'red-piece',
      toX: 1,
      toY: 0,
      clientActionId: 'slow-server-move',
    } as any, { clock })

    const timer = authoritativeState(store).turnTimer!
    expect(timer).toMatchObject({
      deadlineAt: 55_000,
      lastPausedAt: 10_000,
      lastResumedAt: 20_000,
      acceptedGameplayAction: true,
      noOpStreaks: { [PLAYERS[0]]: 0, [PLAYERS[1]]: 0 },
    })
  })

  it('excludes room persistence and result-delivery work from the remaining budget', async () => {
    const clock = new FakeClock(10_000)
    const store = new MemoryRoomStore(makeTimedRoom('post-commit-resume-room'), () => {
      clock.value += 20_000
    })
    let delivered: PublicBattleSnapshot | undefined

    const result = await dispatchRoomBattleAction(store, store.room.id, PLAYERS[0], {
      type: 'move',
      playerId: PLAYERS[0],
      pieceId: 'red-piece',
      toX: 1,
      toY: 0,
      clientActionId: 'persisted-slow-move',
    } as any, {
      clock,
      onCommittedBeforeTimerResume: snapshot => {
        clock.value += 5_000
        delivered = snapshot
      },
    })

    expect(store.writes).toBe(1)
    expect(authoritativeState(store).turnTimer?.deadlineAt).toBe(45_000)
    expect(result.snapshot.turnTimer?.remainingMs).toBe(35_000)
    expect(delivered?.turnTimer?.remainingMs).toBe(35_000)
    expect(createPublicBattleSnapshot(store.room, PLAYERS[0], clock)).toMatchObject({
      serverNow: 10_000,
      turnTimer: { remainingMs: 35_000 },
    })
  })

  it('retries a conflicting CAS without publishing a speculative authority version', async () => {
    const clock = new FakeClock(10_000)
    const store = new ConflictOnceRoomStore(makeTimedRoom('single-cas-conflict-room'))
    const delivered: PublicBattleSnapshot[] = []

    const result = await dispatchRoomBattleAction(store, store.room.id, PLAYERS[0], {
      type: 'move', playerId: PLAYERS[0], pieceId: 'red-piece', toX: 1, toY: 0,
      clientActionId: 'conflicting-move',
    } as any, {
      clock,
      onCommittedBeforeTimerResume: snapshot => { delivered.push(snapshot) },
    })

    expect(store.attempts).toBe(2)
    expect(store.writes).toBe(1)
    expect(delivered).toHaveLength(1)
    expect(delivered[0].authorityVersion).toBe(3)
    expect(result.snapshot.authorityVersion).toBe(3)
    expect(delivered[0].stateHash).toBe(result.snapshot.stateHash)
  })

  it('keeps burn projection stable when processing crosses the 15-second threshold', async () => {
    const clock = new FakeClock(29_500)
    const store = new MemoryRoomStore(makeTimedRoom('stable-burn-delivery-room'))
    let delivered: PublicBattleSnapshot | undefined
    const result = await dispatchRoomBattleAction(store, store.room.id, PLAYERS[0], {
      type: 'move', playerId: PLAYERS[0], pieceId: 'red-piece', toX: 1, toY: 0,
      clientActionId: 'threshold-crossing-move',
    } as any, { clock, onCommittedBeforeTimerResume: snapshot => {
      delivered = snapshot
      clock.value = 31_000
    } })

    expect(delivered?.turnTimer).toMatchObject({ remainingMs: 15_500, burning: false })
    expect(result.snapshot.turnTimer).toMatchObject({ remainingMs: 15_500, burning: false })
    expect(result.finalSnapshotAlreadyDelivered).toBe(true)
  })
  it('keeps fast rope player-local, clears it after a valid action, and restores the growing budget next turn', async () => {
    const clock = new FakeClock(0)
    const store = new MemoryRoomStore(makeTimedRoom('streak-reset-room'))

    await expireCurrentTurn(store, clock)
    expect(authoritativeState(store).turnTimer).toMatchObject({
      ownerPlayerId: PLAYERS[1],
      durationMs: 45_000,
      fast: false,
      noOpStreaks: { [PLAYERS[0]]: 1, [PLAYERS[1]]: 0 },
    })
    await finishCurrentTurnNormally(store, clock)
    expect(authoritativeState(store).turnTimer).toMatchObject({
      ownerPlayerId: PLAYERS[0],
      durationMs: 20_000,
      fast: true,
    })

    clock.value += 1_000
    await dispatchRoomBattleAction(store, store.room.id, PLAYERS[0], {
      type: 'move',
      playerId: PLAYERS[0],
      pieceId: 'red-piece',
      toX: 1,
      toY: 0,
      clientActionId: 'red-valid-reset',
    } as any, { clock })
    expect(authoritativeState(store).turnTimer).toMatchObject({
      acceptedGameplayAction: true,
      noOpStreaks: { [PLAYERS[0]]: 0, [PLAYERS[1]]: 0 },
    })

    await finishCurrentTurnNormally(store, clock)
    await finishCurrentTurnNormally(store, clock)
    expect(authoritativeState(store).turnTimer).toMatchObject({
      ownerPlayerId: PLAYERS[0],
      turnNumber: 5,
      fullRound: 3,
      durationMs: 60_000,
      fast: false,
    })
  })

  it('charges a pending response timeout to its actual input owner', async () => {
    const clock = new FakeClock(0)
    const room = makeTimedRoom('pending-input-timeout-room')
    const state = (room.battleState as any).state as BattleState
    state.pendingOptionSelection = {
      playerId: PLAYERS[1],
      title: 'Respond',
      options: ['accept'],
    }
    state.turnTimer = createRunningTurnTimer(state, clock.value)
    const store = new MemoryRoomStore(room)

    clock.value = authoritativeState(store).turnTimer!.deadlineAt
    const result = await dispatchRoomBattleAction(store, store.room.id, PLAYERS[0], {
      type: 'endTurn',
      playerId: PLAYERS[0],
      clientActionId: 'late-while-blue-responds',
    } as any, { clock })

    expect(result.expiredReason).toBe('turn')
    expect(authoritativeState(store).turn).toMatchObject({
      currentPlayerId: PLAYERS[1],
      phase: 'action',
    })
    expect(authoritativeState(store).turnTimer).toMatchObject({
      ownerPlayerId: PLAYERS[1],
      turnOwnerPlayerId: PLAYERS[1],
      durationMs: 45_000,
      fast: false,
      noOpStreaks: {
        [PLAYERS[0]]: 0,
        [PLAYERS[1]]: 0,
      },
    })
  })

  it('keeps timing an end-of-turn pending input and restores the original turn budget', async () => {
    const clock = new FakeClock(15_000)
    const room = makeTimedRoom('end-turn-pending-room')
    const state = (room.battleState as any).state as BattleState
    state.turn.phase = 'end'
    state.pendingOptionSelection = {
      playerId: PLAYERS[1],
      title: 'Resolve end-of-turn effect',
      options: ['resolve'],
      triggerContext: {
        type: 'endTurn',
        turnNumber: state.turn.turnNumber,
        playerId: PLAYERS[0],
      },
    }
    state.turnTimer = syncTurnTimerAfterAcceptedAction(state, {
      receivedAt: 10_000,
      resumedAt: 10_000,
      actorPlayerId: PLAYERS[0],
      acceptedActionType: 'endTurn',
    })
    const store = new MemoryRoomStore(room)

    const result = await dispatchRoomBattleAction(store, store.room.id, PLAYERS[1], {
      type: 'pendingOptionSelect',
      playerId: PLAYERS[1],
      selectedOption: 'resolve',
      clientActionId: 'resolve-end-turn-pending',
    } as any, { clock })

    expect(result.kind).toBe('applied')
    expect(authoritativeState(store).turn).toMatchObject({
      currentPlayerId: PLAYERS[0],
      phase: 'end',
    })
    expect(authoritativeState(store).pendingOptionSelection).toBeUndefined()
    expect(authoritativeState(store).turnTimer).toMatchObject({
      ownerPlayerId: PLAYERS[0],
      turnOwnerPlayerId: PLAYERS[0],
      remainingMs: 35_000,
      deadlineAt: 50_000,
      acceptedGameplayAction: true,
    })
  })

  it('times out end-of-turn pending input without running end-turn settlement twice', async () => {
    const clock = new FakeClock(55_000)
    const room = makeTimedRoom('end-turn-pending-timeout-room')
    const state = (room.battleState as any).state as BattleState
    state.turn.phase = 'end'
    state.pendingOptionSelection = {
      playerId: PLAYERS[1],
      title: 'Resolve end-of-turn effect',
      options: ['resolve'],
    }
    state.turnTimer = syncTurnTimerAfterAcceptedAction(state, {
      receivedAt: 10_000,
      resumedAt: 10_000,
      actorPlayerId: PLAYERS[0],
      acceptedActionType: 'endTurn',
    })
    const redPiece = state.pieces.find(piece => piece.instanceId === 'red-piece')!
    redPiece.statusTags = [{
      id: 'end-turn-duration-proof',
      name: 'End turn already settled',
      type: 'end-turn-duration-proof',
      remainingDuration: 1,
    } as any]
    const store = new MemoryRoomStore(room)

    const result = await dispatchRoomBattleAction(store, store.room.id, PLAYERS[1], {
      type: 'pendingOptionSelect',
      playerId: PLAYERS[1],
      selectedOption: 'resolve',
      clientActionId: 'late-end-turn-pending',
    } as any, { clock })

    expect(result).toMatchObject({ kind: 'expired', expiredReason: 'turn' })
    expect(authoritativeState(store).turn).toMatchObject({
      currentPlayerId: PLAYERS[1],
      phase: 'action',
    })
    expect(authoritativeState(store).pendingOptionSelection).toBeUndefined()
    expect(authoritativeState(store).pieces.find(piece => piece.instanceId === 'red-piece')?.statusTags)
      .toContainEqual(expect.objectContaining({ id: 'end-turn-duration-proof', remainingDuration: 1 }))
  })

  it('skips a pending input created only after an action-phase timeout', async () => {
    const clock = new FakeClock(0)
    const store = new MemoryRoomStore(makeTimedRoom('action-timeout-end-turn-pending-room'))
    const previousRules = [...globalTriggerSystem.getRules()]
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRules([{
      id: 'timeout-end-turn-pending-probe',
      name: 'Timeout end-turn pending probe',
      description: 'Proves the forced endTurn path produced a pending choice',
      priority: 1,
      trigger: { type: 'endTurn' },
      effect: (battle: BattleState) => {
        ;(battle as any).timeoutEndTurnPendingTriggered = true
        return {
          needsOptionSelection: true,
          playerId: PLAYERS[0],
          title: 'Resolve forced end-turn effect',
          options: ['resolve'],
        }
      },
    }] as any)

    try {
      const result = await expireCurrentTurn(store, clock)
      const state = authoritativeState(store)

      expect(result).toMatchObject({ kind: 'expired', expiredReason: 'turn' })
      expect((state as any).timeoutEndTurnPendingTriggered).toBe(true)
      expect(state.pendingOptionSelection).toBeUndefined()
      expect(state.pendingTargetSelection).toBeUndefined()
      expect(state.turn).toMatchObject({
        currentPlayerId: PLAYERS[1],
        phase: 'action',
      })
      expect(state.turnTimer).toMatchObject({
        ownerPlayerId: PLAYERS[1],
        turnOwnerPlayerId: PLAYERS[1],
        status: 'running',
        durationMs: 45_000,
      })
    } finally {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRules(previousRules)
    }
  })

  it('does not let an illegal action clear or evade the no-op streak', async () => {
    const clock = new FakeClock(0)
    const store = new MemoryRoomStore(makeTimedRoom('illegal-action-room'))

    await expireCurrentTurn(store, clock)
    await finishCurrentTurnNormally(store, clock)
    const before = clone(store.room)
    clock.value += 1_000
    await expect(dispatchRoomBattleAction(store, store.room.id, PLAYERS[0], {
      type: 'move',
      playerId: PLAYERS[0],
      pieceId: 'blue-piece',
      toX: 3,
      toY: 4,
      clientActionId: 'illegal-enemy-move',
    } as any, { clock })).rejects.toThrow(/does not belong/i)
    expect(store.room).toEqual(before)

    const result = await expireCurrentTurn(store, clock)
    expect(result.expiredReason).toBe('turn')
    expect(authoritativeState(store).turnTimer?.noOpStreaks[PLAYERS[0]]).toBe(2)
  })

  it('commits exactly one timeout surrender on the third no-action turn', async () => {
    const clock = new FakeClock(0)
    const store = new MemoryRoomStore(makeTimedRoom('timeout-forfeit-room'))

    await expireCurrentTurn(store, clock)
    await finishCurrentTurnNormally(store, clock)
    await expireCurrentTurn(store, clock)
    await finishCurrentTurnNormally(store, clock)
    const third = await expireCurrentTurn(store, clock)

    expect(third.expiredReason).toBe('turn')
    expect(authoritativeState(store).terminalResult).toMatchObject({
      status: 'finished',
      winnerPlayerId: PLAYERS[1],
      loserPlayerId: PLAYERS[0],
      reason: 'timeout-surrender',
    })
    expect(authoritativeState(store).actions?.filter(action => action.type === 'terminalResult')).toHaveLength(1)
    expect(store.room.status).toBe('finished')
    const writes = store.writes

    await expect(dispatchRoomBattleAction(store, store.room.id, PLAYERS[1], {
      type: 'endTurn',
      playerId: PLAYERS[1],
      clientActionId: 'after-timeout-terminal',
    } as any, { clock })).rejects.toMatchObject({ code: 'BATTLE_ALREADY_TERMINAL' })
    expect(store.writes).toBe(writes)
    expect(authoritativeState(store).actions?.filter(action => action.type === 'terminalResult')).toHaveLength(1)
  })

  it('commits the burn event once, survives refresh projections, then times out deterministically', async () => {
    vi.useFakeTimers()
    const clock = new FakeClock(0)
    const store = new MemoryRoomStore(makeTimedRoom('burn-schedule-room'))
    const committed: Array<ReturnType<typeof createPublicBattleSnapshot>> = []

    try {
      const initialDeadline = authoritativeState(store).turnTimer!.deadlineAt
      createPublicBattleSnapshot(store.room, PLAYERS[0], clock)
      createPublicBattleSnapshot(store.room, PLAYERS[1], clock)
      expect(store.writes).toBe(0)
      expect(authoritativeState(store).turnTimer!.deadlineAt).toBe(initialDeadline)

      await scheduleRoomBattleTimeout(store, store.room.id, {
        clock,
        onCommitted: snapshot => { committed.push(snapshot) },
      })
      clock.value = 30_000
      await vi.advanceTimersByTimeAsync(30_000)

      expect(store.writes).toBe(1)
      expect(authoritativeState(store).turnTimer?.burnPhase).toBe('burning')
      expect(authoritativeState(store).actions?.filter(action => action.type === 'turnTimerBurn')).toHaveLength(1)
      expect(createPublicBattleSnapshot(store.room, PLAYERS[0], clock).turnTimer).toMatchObject({
        remainingMs: 15_000,
        burning: true,
      })
      expect(store.writes).toBe(1)

      clock.value = 45_000
      await vi.advanceTimersByTimeAsync(15_000)
      expect(store.writes).toBe(2)
      expect(authoritativeState(store).turn.turnNumber).toBe(2)
      expect(authoritativeState(store).turnTimer?.ownerPlayerId).toBe(PLAYERS[1])
      expect(committed).toHaveLength(2)
    } finally {
      clearRoomBattleTimeout(store.room.id)
      vi.useRealTimers()
    }
  })

  it('hands a player timeout directly to the bot turn callback', async () => {
    vi.useFakeTimers()
    const clock = new FakeClock(0)
    const room = makeTimedRoom('bot-timeout-room')
    const state = (room.battleState as any).state as BattleState
    state.players[1].playerId = 'bot'
    state.pieces.find(piece => piece.ownerPlayerId === PLAYERS[1])!.ownerPlayerId = 'bot'
    state.turnTimer!.noOpStreaks = { [PLAYERS[0]]: 0, bot: 0 }
    room.players[1] = { ...room.players[1], id: 'bot', isBot: true }
    const store = new MemoryRoomStore(room)
    const botTurnReady = vi.fn()

    try {
      await scheduleRoomBattleTimeout(store, store.room.id, {
        clock,
        onBotTurnReady: botTurnReady,
      })
      clock.value = 30_000
      await vi.advanceTimersByTimeAsync(30_000)
      clock.value = 45_000
      await vi.advanceTimersByTimeAsync(15_000)

      expect(authoritativeState(store).turn).toMatchObject({
        currentPlayerId: 'bot',
        phase: 'action',
      })
      expect(botTurnReady).toHaveBeenCalledTimes(1)
      expect(botTurnReady.mock.calls[0][0].state.turn.currentPlayerId).toBe('bot')
    } finally {
      clearRoomBattleTimeout(store.room.id)
      vi.useRealTimers()
    }
  })
  it('rejects every client-authored turn timer event without a write', async () => {
    const clock = new FakeClock(45_000)
    const store = new MemoryRoomStore(makeTimedRoom('forged-turn-timeout-room'))
    const before = clone(store.room)

    await expect(dispatchRoomBattleAction(store, store.room.id, PLAYERS[0], {
      type: 'turnTimeout',
      now: 45_000,
      clientActionId: 'forged-turn-timeout',
    } as any, { clock })).rejects.toMatchObject({ code: 'TURN_TIMER_SYSTEM_ACTION_FORBIDDEN' })
    await expect(dispatchRoomBattleAction(store, store.room.id, PLAYERS[0], {
      type: 'turnTimerBurn',
      now: 30_000,
      clientActionId: 'forged-turn-burn',
    } as any, { clock })).rejects.toMatchObject({ code: 'TURN_TIMER_SYSTEM_ACTION_FORBIDDEN' })
    expect(store.room).toEqual(before)
    expect(store.writes).toBe(0)
  })
})

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
