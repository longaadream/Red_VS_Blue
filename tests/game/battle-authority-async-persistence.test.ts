import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { hashBattleState } from '@/lib/game/battle-trace'
import {
  buildBattleAuthorityTransition,
  hashBattleAuthorityTransition,
  isBattleAuthorityAsyncJournalEnabled,
  type BattleAuthorityTransitionRecord,
} from '@/lib/game/battle-transition'
import type { ServerBattleState } from '@/lib/game/battle-storage'
import { RoomStore, type Room } from '@/lib/game/room-store'
import type { BattleAction, BattleState } from '@/lib/game/turn'

const harness = vi.hoisted(() => {
  let releaseTransaction: ((value: boolean) => void) | undefined
  const transaction = vi.fn(() => new Promise<boolean>(resolve => { releaseTransaction = resolve }))
  return {
    prisma: {
      $transaction: transaction,
      $queryRawUnsafe: vi.fn(async () => [{ timeout: 500 }]),
      room: {
        findUnique: vi.fn(() => { throw new Error('hot room performed a Prisma read') }),
      },
      battleAuthorityReceipt: {
        findUnique: vi.fn(() => { throw new Error('hot receipt performed a Prisma read') }),
      },
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
  commitBattleAuthorityTransition,
  drainBattleAuthorityPersistence,
  getBattleAuthorityReceipt,
  getRememberedBattleAuthorityRoom,
  inspectBattleAuthorityPersistence,
  readBattleAuthorityHistory,
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

describe('battle authority async persistence integration', () => {
  it('is fail-closed unless explicitly enabled', () => {
    delete process.env.RVB_BATTLE_ASYNC_JOURNAL
    expect(isBattleAuthorityAsyncJournalEnabled()).toBe(false)
    process.env.RVB_BATTLE_AUTHORITY_V2 = '0'
    process.env.RVB_BATTLE_ASYNC_JOURNAL = 'true'
    expect(isBattleAuthorityAsyncJournalEnabled()).toBe(false)
    process.env.RVB_BATTLE_AUTHORITY_V2 = '1'
    expect(isBattleAuthorityAsyncJournalEnabled()).toBe(true)
    process.env.RVB_BATTLE_ASYNC_JOURNAL = '1'
  })

  it('refuses to commit without a hydrated room actor', async () => {
    const input = transitionInput('missing-room-actor')
    await expect(commitBattleAuthorityTransition(input)).resolves.toBe(false)
    expect(harness.transaction).not.toHaveBeenCalled()
  })

  it('commits the room actor and receipt before Prisma becomes durable', async () => {
    const input = transitionInput('async-persistence-room')
    rememberPreTransitionActor(input)

    await expect(commitBattleAuthorityTransition(input)).resolves.toBe(true)
    expect(harness.transaction).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(harness.transaction).toHaveBeenCalledTimes(1))
    expect(harness.prisma.$queryRawUnsafe).toHaveBeenCalledWith('PRAGMA busy_timeout = 500')
    expect(harness.transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      maxWait: 250,
      timeout: 1_250,
    })
    expect(getRememberedBattleAuthorityRoom(input.roomId)).toMatchObject({
      battleAuthorityVersion: 1,
      battleAuthorityTransitionHash: input.transition.transitionHash,
    })
    expect(getRememberedBattleAuthorityRoom(input.roomId))
      .toMatchObject({ battleAuthorityPersistenceStatus: 'pending' })
    await expect(getBattleAuthorityReceipt(input.roomId, input.transition.clientActionId))
      .resolves.toMatchObject({ status: 'applied', authorityVersion: 1 })
    await expect(readBattleAuthorityHistory(input.roomId)).resolves.toHaveLength(1)
    await expect(new RoomStore().getRoom(input.roomId)).resolves.toMatchObject({
      battleAuthorityVersion: 1,
    })
    expect(inspectBattleAuthorityPersistence(input.roomId)).toMatchObject({
      status: 'pending',
      durableAuthorityVersion: 0,
      authorityVersion: 1,
      pending: 1,
    })

    harness.release(true)
    await drainBattleAuthorityPersistence(input.roomId)
    expect(inspectBattleAuthorityPersistence(input.roomId)).toMatchObject({
      status: 'durable',
      durableAuthorityVersion: 1,
      authorityVersion: 1,
      pending: 0,
    })
  })

  it('rejects a drifted in-memory chain head before recording a receipt or scheduling Prisma', async () => {
    harness.transaction.mockClear()
    const input = transitionInput('async-chain-drift-room')
    rememberPreTransitionActor(input, 'tampered-chain-head')

    await expect(commitBattleAuthorityTransition(input)).rejects.toThrow('in-memory chain mismatch')
    expect(harness.transaction).not.toHaveBeenCalled()
    await expect(getBattleAuthorityReceipt(input.roomId, input.transition.clientActionId))
      .resolves.toBeUndefined()
  })

  it('rejects tampered pre-state and action hashes before the in-memory ACK boundary', async () => {
    harness.transaction.mockClear()
    const badPreState = transitionInput('async-bad-pre-state-room')
    badPreState.transition.preStateHash = 'bad-pre-state-hash'
    rememberPreTransitionActor(badPreState)
    await expect(commitBattleAuthorityTransition(badPreState)).rejects.toThrow('checkpoint hash mismatch')

    const badAction = transitionInput('async-bad-action-room')
    badAction.transition.actionHash = 'bad-action-hash'
    rememberPreTransitionActor(badAction)
    await expect(commitBattleAuthorityTransition(badAction)).rejects.toThrow('action hash mismatch')
    expect(harness.transaction).not.toHaveBeenCalled()
  })

  it('rejects a delta that cannot reproduce next state even when its transition hash is recomputed', async () => {
    harness.transaction.mockClear()
    const input = transitionInput('async-bad-delta-room')
    const setOperation = input.transition.internalPatch.find(operation => operation.op === 'set')
    if (!setOperation || setOperation.op !== 'set') throw new Error('Expected a set operation')
    setOperation.value = 999
    input.transition.transitionHash = hashBattleAuthorityTransition(input.transition)
    input.nextRoom.battleAuthorityTransitionHash = input.transition.transitionHash
    rememberPreTransitionActor(input)

    await expect(commitBattleAuthorityTransition(input)).rejects.toThrow('transition state hash mismatch')
    expect(harness.transaction).not.toHaveBeenCalled()
  })

  it('advances multiple same-room transitions while the first SQLite write is blocked', async () => {
    harness.transaction.mockClear()
    const first = transitionInput('async-sequence-room')
    const second = transitionInput(
      'async-sequence-room',
      1,
      first.transition.transitionHash,
    )
    rememberPreTransitionActor(first)

    await expect(commitBattleAuthorityTransition(first)).resolves.toBe(true)
    await expect(commitBattleAuthorityTransition(second)).resolves.toBe(true)
    await vi.waitFor(() => expect(harness.transaction).toHaveBeenCalledTimes(1))
    expect(getRememberedBattleAuthorityRoom(first.roomId)).toMatchObject({
      battleAuthorityVersion: 2,
      battleAuthorityTransitionHash: second.transition.transitionHash,
    })
    expect(inspectBattleAuthorityPersistence(first.roomId)).toMatchObject({
      durableAuthorityVersion: 0,
      authorityVersion: 2,
      pending: 2,
    })

    harness.release(true)
    await vi.waitFor(() => expect(harness.transaction).toHaveBeenCalledTimes(2))
    harness.release(true)
    await drainBattleAuthorityPersistence(first.roomId)
    expect(inspectBattleAuthorityPersistence(first.roomId)).toMatchObject({
      status: 'durable',
      durableAuthorityVersion: 2,
      authorityVersion: 2,
    })
  })
})

function rememberPreTransitionActor(
  input: ReturnType<typeof transitionInput>,
  transitionHash = input.transition.previousTransitionHash,
): void {
  rememberBattleAuthorityRoom({
    ...input.nextRoom,
    battleAuthorityVersion: input.expectedVersion,
    battleAuthorityTransitionHash: transitionHash,
    battleState: storageAt(input.expectedVersion) as unknown as Room['battleState'],
  })
}

function transitionInput(
  roomId: string,
  fromVersion = 0,
  previousTransitionHash?: string,
): {
  roomId: string
  expectedVersion: number
  nextRoom: Room
  transition: BattleAuthorityTransitionRecord
} {
  const previous = storageAt(fromVersion)
  const next = storageAt(fromVersion + 1)
  const clientActionId = `async-action-${fromVersion + 1}`
  const command = { type: 'beginPhase', clientActionId } as BattleAction
  const transition = buildBattleAuthorityTransition({
    roomId,
    fromVersion,
    clientActionId,
    playerId: 'player-red',
    command,
    previousStorage: previous,
    nextStorage: next,
    previousPublicState: previous.state as BattleState,
    nextPublicState: next.state as BattleState,
    preStateHash: hashBattleState(previous.state as BattleState),
    postStateHash: hashBattleState(next.state as BattleState),
    previousTransitionHash,
    now: 1,
  })
  return {
    roomId,
    nextRoom: {
      id: roomId,
      name: roomId,
      status: 'in-progress',
      players: [],
      spectators: [],
      currentTurnIndex: 0,
      actions: [],
      version: 1,
      battleAuthorityVersion: fromVersion,
      battleAuthorityTransitionHash: transition.transitionHash,
      battleState: next as unknown as Room['battleState'],
    },
    expectedVersion: fromVersion,
    transition,
  }
}

function storageAt(revision: number): ServerBattleState {
  return {
    type: 'server-state',
    seed: 109,
    state: {
      pieces: [],
      players: [],
      turn: { turnNumber: 1, phase: 'action', currentPlayerId: 'player-red' },
      authorityTestRevision: revision,
    },
  }
}
