import { performance } from 'node:perf_hooks'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { dispatchRoomBattleAction } from '@/lib/game/room-battle-actions'
import { recordBattleInitialization } from '@/lib/game/battle-trace'
import { RuleRuntime } from '@/lib/game/rule-runtime'
import { RoomStore, type Room } from '@/lib/game/room-store'
import type { BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const harness = vi.hoisted(() => {
  let releaseTransaction: ((value: boolean) => void) | undefined
  const transaction = vi.fn(() => new Promise<boolean>(resolve => { releaseTransaction = resolve }))
  return {
    prisma: {
      $transaction: transaction,
      $queryRawUnsafe: vi.fn(async () => [{ timeout: 500 }]),
    },
    transaction,
    release(value = true) {
      releaseTransaction?.(value)
      releaseTransaction = undefined
    },
  }
})

vi.mock('@/lib/db', () => ({ prisma: harness.prisma }))

import {
  drainBattleAuthorityPersistence,
  rememberBattleAuthorityRoom,
} from '@/lib/server/battle-authority-persistence'

const originalAsyncFlag = process.env.RVB_BATTLE_ASYNC_JOURNAL
const originalAuthorityFlag = process.env.RVB_BATTLE_AUTHORITY_V2

beforeAll(() => {
  process.env.RVB_BATTLE_AUTHORITY_V2 = '1'
  process.env.RVB_BATTLE_ASYNC_JOURNAL = '1'
})

afterAll(() => {
  harness.release()
  if (originalAsyncFlag === undefined) delete process.env.RVB_BATTLE_ASYNC_JOURNAL
  else process.env.RVB_BATTLE_ASYNC_JOURNAL = originalAsyncFlag
  if (originalAuthorityFlag === undefined) delete process.env.RVB_BATTLE_AUTHORITY_V2
  else process.env.RVB_BATTLE_AUTHORITY_V2 = originalAuthorityFlag
})

describe('battle authority async dispatch', () => {
  it('keeps warm authoritative actions below 100ms while SQLite remains blocked', async () => {
    const room = makeDispatchRoom('async-dispatch-room')
    const store = new RoomStore()
    const samples: Array<{ totalMs: number; wallMs: number; persistenceMs: number }> = []
    rememberBattleAuthorityRoom(room)

    for (let index = 0; index < 20; index += 1) {
      const current = await store.getRoom(room.id)
      const startedAt = performance.now()
      const result = await dispatchRoomBattleAction(
        store,
        room.id,
        'player-red',
        {
          type: 'deploymentChoice',
          playerId: 'player-red',
          pieceId: index % 2 === 0 ? 'piece-red' : null,
          clientActionId: `async-dispatch-action-${index + 1}`,
        },
        {
          expectedAuthorityVersion: current?.battleAuthorityVersion,
          clock: { now: () => 2_000 },
        },
      )
      samples.push({
        totalMs: result.timings?.totalMs ?? Number.POSITIVE_INFINITY,
        wallMs: performance.now() - startedAt,
        persistenceMs: result.timings?.persistenceMs ?? Number.POSITIVE_INFINITY,
      })
      expect(result.kind).toBe('applied')
      expect(result.receipt).toMatchObject({ status: 'applied', authorityVersion: index + 2 })
      expect(result.snapshot).toMatchObject({
        authorityVersion: index + 2,
        durableAuthorityVersion: 0,
        persistenceStatus: 'pending',
      })
    }

    const warm = samples.slice(5)
    expect(percentile(warm.map(sample => sample.persistenceMs), 0.95)).toBeLessThan(100)
    expect(percentile(warm.map(sample => sample.totalMs), 0.95)).toBeLessThan(100)
    expect(percentile(warm.map(sample => sample.wallMs), 0.95)).toBeLessThan(100)
    await vi.waitFor(() => expect(harness.transaction).toHaveBeenCalledTimes(1))

    harness.transaction.mockImplementation(async () => true)
    harness.release(true)
    await drainBattleAuthorityPersistence(room.id)
  })
})

function makeDispatchRoom(roomId: string): Room {
  const state = makeState({
    pieces: [
      Object.assign(
        makePiece({ instanceId: 'piece-red', ownerPlayerId: 'player-red', faction: 'red', x: 1, y: 1 }),
        { isCore: true },
      ),
      Object.assign(
        makePiece({ instanceId: 'piece-blue', ownerPlayerId: 'player-blue', faction: 'blue', x: 8, y: 8 }),
        { isCore: true },
      ),
    ] as never[],
    phase: 'start',
  }) as BattleState
  ;(state as BattleState & { deployment: unknown }).deployment = {
    status: 'awaiting-locks',
    playerIds: ['player-red', 'player-blue'],
    choices: {},
    locks: {
      'player-red': { locked: false },
      'player-blue': { locked: false },
    },
    startedAt: 1_000,
    deadlineAt: 46_000,
    revision: 0,
    initialPositions: {
      'piece-red': { x: 1, y: 1 },
      'piece-blue': { x: 8, y: 8 },
    },
  }
  recordBattleInitialization(state, new RuleRuntime({ rootSeed: 109 }), ['player-red', 'player-blue'])
  return {
    id: roomId,
    name: roomId,
    status: 'in-progress',
    players: [
      { id: 'player-red', name: 'Red', seat: 'red', alignment: 'light' },
      { id: 'player-blue', name: 'Blue', seat: 'blue', alignment: 'dark' },
    ],
    spectators: [],
    currentTurnIndex: 0,
    actions: [],
    version: 9,
    battleAuthorityVersion: 1,
    battleAuthorityTransitionHash: 'a'.repeat(64),
    battleState: { type: 'server-state', seed: 109, state } as unknown as Room['battleState'],
  }
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0
}
