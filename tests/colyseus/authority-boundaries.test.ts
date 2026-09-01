import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { dispatchRoomBattleAction } from '@/lib/game/room-battle-actions'
import { restoreRoomRuleRuntime } from '@/lib/game/room-rule-runtime'
import type { TriggerRule } from '@/lib/game/triggers'
import type { BattleAction } from '@/lib/game/turn'
import { CandidateBattleStore } from '@/lib/server/colyseus/candidate-battle-store'
import { createDevelopmentBattleRoom } from '@/lib/server/colyseus/development-battle-fixture'
import type { PostgresAuthorityTransitionJob } from '@/lib/server/postgres/authority-types'
import { PostgresAuthorityJournal } from '@/lib/server/postgres/postgres-authority-journal'

import { FakeAuthorityRepository } from './fake-authority-repository'

const originalAuthority = process.env.RVB_BATTLE_AUTHORITY_V2

describe('RED-160 authority commit boundaries', () => {
  beforeEach(() => {
    process.env.RVB_BATTLE_AUTHORITY_V2 = '1'
  })

  afterEach(() => {
    if (originalAuthority === undefined) delete process.env.RVB_BATTLE_AUTHORITY_V2
    else process.env.RVB_BATTLE_AUTHORITY_V2 = originalAuthority
  })

  it('restores TriggerSystem transaction state when journal capacity rejects the outer commit', async () => {
    const roomId = 'red160-runtime-rollback'
    const repository = new FakeAuthorityRepository()
    const journal = new PostgresAuthorityJournal(repository, {
      maxPendingPerRoom: 1,
      maxPendingGlobal: 1,
    })
    const store = await CandidateBattleStore.open({
      roomId,
      repository,
      journal,
      fixtureFactory: createDevelopmentBattleRoom,
    })
    const held = journal.reserve(placeholderJob(roomId))
    const runtime = restoreRoomRuleRuntime(roomId)
    runtime.executionContext.triggerSystem.addRule(markerRule(roomId))

    await expect(dispatchRoomBattleAction(
      store,
      roomId,
      'player-red',
      {
        type: 'endTurn',
        playerId: 'player-red',
        clientActionId: 'capacity-rejected',
      } as BattleAction,
      { expectedAuthorityVersion: 0 },
    )).rejects.toMatchObject({ code: 'POSTGRES_AUTHORITY_BACKPRESSURE' })

    expect(runtime.executionContext.triggerSystem.getRules()[0].limits?.uses).toBe(0)
    await expect(store.getRoom(roomId)).resolves.toMatchObject({ battleAuthorityVersion: 0 })
    journal.cancel(held)
  })

  it('does not resolve a terminal action until its PostgreSQL durable barrier completes', async () => {
    const roomId = 'red160-terminal-barrier'
    let releaseWriter!: () => void
    const writerGate = new Promise<void>(resolve => { releaseWriter = resolve })
    const repository = new FakeAuthorityRepository()
    repository.beforeCommit = () => writerGate
    const journal = new PostgresAuthorityJournal(repository, { maxDwellMs: 0, maxAttempts: 1 })
    const store = await CandidateBattleStore.open({
      roomId,
      repository,
      journal,
      fixtureFactory: createDevelopmentBattleRoom,
    })
    let settled = false
    const terminal = dispatchRoomBattleAction(
      store,
      roomId,
      'player-red',
      {
        type: 'surrender',
        playerId: 'player-red',
        clientActionId: 'terminal-surrender',
      } as BattleAction,
      { expectedAuthorityVersion: 0 },
    ).finally(() => { settled = true })

    await new Promise(resolve => setTimeout(resolve, 30))
    expect(settled).toBe(false)
    await expect(store.getRoom(roomId)).resolves.toMatchObject({ status: 'in-progress' })
    releaseWriter()
    await expect(terminal).resolves.toMatchObject({
      kind: 'applied',
      snapshot: {
        authorityVersion: 1,
        durableAuthorityVersion: 1,
      },
    })
    await expect(store.getRoom(roomId)).resolves.toMatchObject({
      status: 'finished',
      battleAuthorityDurableVersion: 1,
    })
  })
})

function markerRule(roomId: string): TriggerRule {
  return {
    id: `marker:${roomId}`,
    name: roomId,
    description: 'RED-160 rollback marker',
    trigger: { type: 'endTurn' },
    limits: { maxUses: 5, uses: 0 },
    effect: () => ({ success: true }),
  }
}

function placeholderJob(roomId: string): PostgresAuthorityTransitionJob {
  return {
    roomId,
    epoch: 1,
    nextRoom: createDevelopmentBattleRoom(roomId),
    transition: {
      roomId,
      fromVersion: 0,
      toVersion: 1,
    } as PostgresAuthorityTransitionJob['transition'],
  }
}
