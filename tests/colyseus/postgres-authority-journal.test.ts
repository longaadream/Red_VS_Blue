import { describe, expect, it, vi } from 'vitest'

import { BATTLE_AUTHORITY_BUILD_ID } from '@/lib/game/battle-public-patch'
import type { PostgresAuthorityTransitionJob } from '@/lib/server/postgres/authority-types'
import { PostgresAuthorityJournal } from '@/lib/server/postgres/postgres-authority-journal'

describe('RED-160 PostgreSQL authority journal', () => {
  it('flushes each room independently at eight transitions without a global writer queue', async () => {
    const calls: Array<{ roomId: string; size: number }> = []
    const writer = {
      async commitTransitionBatch(roomId: string, jobs: readonly PostgresAuthorityTransitionJob[]) {
        calls.push({ roomId, size: jobs.length })
        return jobs[jobs.length - 1].transition.toVersion
      },
    }
    const journal = new PostgresAuthorityJournal(writer, { maxBatchSize: 8, maxDwellMs: 25 })
    journal.registerRoom('room-a', 0)
    journal.registerRoom('room-b', 0)

    for (let version = 0; version < 8; version += 1) {
      const reservation = journal.reserve(jobAt('room-a', version))
      journal.commit(reservation)
    }
    const reservation = journal.reserve(jobAt('room-b', 0))
    journal.commit(reservation)
    await journal.drain('room-a')
    await journal.drain('room-b')

    expect(calls).toContainEqual({ roomId: 'room-a', size: 8 })
    expect(calls).toContainEqual({ roomId: 'room-b', size: 1 })
    expect(journal.inspect('room-a')).toMatchObject({
      status: 'durable',
      durableAuthorityVersion: 8,
      committedTransitions: 8,
      lastBatchSize: 8,
    })
  })

  it('fails closed before memory commit when bounded capacity is exhausted', () => {
    const writer = { commitTransitionBatch: vi.fn() }
    const journal = new PostgresAuthorityJournal(writer as never, {
      maxPendingPerRoom: 1,
      maxPendingGlobal: 1,
    })
    journal.registerRoom('bounded', 0)
    const first = journal.reserve(jobAt('bounded', 0))
    expect(() => journal.reserve(jobAt('bounded', 1))).toThrowError(
      expect.objectContaining({ code: 'POSTGRES_AUTHORITY_BACKPRESSURE' }),
    )
    journal.cancel(first)
    expect(journal.inspect('bounded').reserved).toBe(0)
  })

  it('quarantines a failed room without degrading another room', async () => {
    const writer = {
      async commitTransitionBatch(roomId: string, jobs: readonly PostgresAuthorityTransitionJob[]) {
        if (roomId === 'fault') throw new Error('database fault')
        return jobs[jobs.length - 1].transition.toVersion
      },
    }
    const journal = new PostgresAuthorityJournal(writer, {
      maxAttempts: 1,
      maxDwellMs: 0,
    })
    journal.registerRoom('fault', 0)
    journal.registerRoom('healthy', 0)
    journal.commit(journal.reserve(jobAt('fault', 0)))
    journal.commit(journal.reserve(jobAt('healthy', 0)))

    await expect(journal.drain('fault')).rejects.toMatchObject({ code: 'POSTGRES_AUTHORITY_DEGRADED' })
    await expect(journal.drain('healthy')).resolves.toBeUndefined()
    expect(journal.inspect('healthy').durableAuthorityVersion).toBe(1)
  })

  it('closes admission, waits for an in-flight reservation, and only then reports durable shutdown', async () => {
    const writer = {
      async commitTransitionBatch(_roomId: string, jobs: readonly PostgresAuthorityTransitionJob[]) {
        return jobs[jobs.length - 1].transition.toVersion
      },
    }
    const journal = new PostgresAuthorityJournal(writer, { maxDwellMs: 25 })
    journal.registerRoom('shutdown', 0)
    const reservation = journal.reserve(jobAt('shutdown', 0))
    let closed = false
    const closing = journal.close().then(() => { closed = true })

    await Promise.resolve()
    expect(closed).toBe(false)
    expect(() => journal.reserve(jobAt('shutdown', 1))).toThrowError(
      expect.objectContaining({ code: 'POSTGRES_AUTHORITY_JOURNAL_CLOSED' }),
    )
    expect(() => journal.registerRoom('late-room', 0)).toThrowError(
      expect.objectContaining({ code: 'POSTGRES_AUTHORITY_JOURNAL_CLOSED' }),
    )

    journal.commit(reservation)
    await expect(closing).resolves.toBeUndefined()
    expect(journal.inspect('shutdown')).toMatchObject({ status: 'durable', durableAuthorityVersion: 1 })
  })

  it('rejects the shutdown barrier when PostgreSQL cannot make a pending transition durable', async () => {
    const journal = new PostgresAuthorityJournal({
      async commitTransitionBatch() { throw new Error('simulated PostgreSQL outage') },
    }, { maxAttempts: 1, maxDwellMs: 25 })
    journal.registerRoom('shutdown-fault', 0)
    journal.commit(journal.reserve(jobAt('shutdown-fault', 0)))

    await expect(journal.close()).rejects.toMatchObject({ code: 'POSTGRES_AUTHORITY_DEGRADED' })
    await expect(journal.close()).rejects.toMatchObject({ code: 'POSTGRES_AUTHORITY_DEGRADED' })
  })
})

function jobAt(roomId: string, fromVersion: number): PostgresAuthorityTransitionJob {
  const toVersion = fromVersion + 1
  const previousTransitionHash = fromVersion === 0 ? 'a'.repeat(64) : hashAt(fromVersion)
  const transitionHash = hashAt(toVersion)
  return {
    roomId,
    epoch: 1,
    nextRoom: {
      id: roomId,
      name: roomId,
      status: 'in-progress',
      players: [],
      spectators: [],
      currentTurnIndex: 0,
      actions: [],
      battleAuthorityVersion: toVersion,
      battleAuthorityTransitionHash: transitionHash,
    },
    transition: {
      protocolVersion: 3,
      authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
      roomId,
      fromVersion,
      toVersion,
      clientActionId: `${roomId}-${toVersion}`,
      playerId: 'player-red',
      command: { type: 'beginPhase', clientActionId: `${roomId}-${toVersion}` } as never,
      commands: [{ type: 'beginPhase', clientActionId: `${roomId}-${toVersion}` } as never],
      internalPatch: [],
      publicPatch: [],
      preStateHash: hashAt(fromVersion + 100),
      postStateHash: hashAt(toVersion + 100),
      prePublicHash: hashAt(fromVersion + 200),
      postPublicHash: hashAt(toVersion + 200),
      actionHash: hashAt(toVersion + 300),
      previousTransitionHash,
      transitionHash,
      receipt: {
        protocolVersion: 3,
        authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
        roomId,
        clientActionId: `${roomId}-${toVersion}`,
        status: 'applied',
        authorityVersion: toVersion,
      },
      traces: [],
      replayFrames: [],
      createdAt: toVersion,
    },
  }
}

function hashAt(value: number): string {
  return value.toString(16).padStart(64, '0')
}
