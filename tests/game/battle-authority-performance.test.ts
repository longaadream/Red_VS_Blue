import { performance } from 'node:perf_hooks'

import { describe, expect, it } from 'vitest'

import { getBattleStorage } from '@/lib/game/battle-storage'
import { dispatchRoomBattleAction } from '@/lib/game/room-battle-actions'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { CandidateBattleStore } from '@/lib/server/colyseus/candidate-battle-store'
import { createDevelopmentBattleRoom } from '@/lib/server/colyseus/development-battle-fixture'
import { PostgresAuthorityJournal } from '@/lib/server/postgres/postgres-authority-journal'
import { FakeAuthorityRepository } from '../colyseus/fake-authority-repository'

const TRANSITION_COUNT = 100

describe('PostgreSQL transition authority performance', () => {
  it('commits a 100-transition contiguous hash chain without a full-room fallback', async () => {
    const roomId = 'authority-performance-100'
    const repository = new FakeAuthorityRepository()
    const journal = new PostgresAuthorityJournal(repository, { maxBatchSize: 8, maxDwellMs: 10 })
    const store = await CandidateBattleStore.open({
      roomId,
      repository,
      journal,
      fixtureFactory: createDevelopmentBattleRoom,
    })
    const timings: number[] = []

    try {
      for (let index = 0; index < TRANSITION_COUNT; index += 1) {
        const room = await store.getRoom(roomId)
        if (!room) throw new Error('Authority performance fixture disappeared')
        const state = getBattleStorage(room)!.state as BattleState
        const playerId = state.turn.currentPlayerId
        const action = (index % 2 === 0
          ? { type: 'endTurn', playerId, clientActionId: `authority-perf-${index + 1}` }
          : { type: 'beginPhase', clientActionId: `authority-perf-${index + 1}` }) as unknown as BattleAction
        const startedAt = performance.now()
        const result = await dispatchRoomBattleAction(store, roomId, playerId, action, {
          expectedAuthorityVersion: index,
          checkpointInterval: 16,
        })
        timings.push(performance.now() - startedAt)
        expect(result.kind).toBe('applied')
        expect(result.transition).toMatchObject({ fromVersion: index, toVersion: index + 1 })
      }

      await journal.drain(roomId)
      const restored = await repository.restoreRoom(roomId)
      expect(restored?.durableAuthorityVersion).toBe(TRANSITION_COUNT)
      expect(restored?.transitions).toHaveLength(TRANSITION_COUNT)
      expect(restored?.transitions.every((transition, index) => (
        transition.fromVersion === index
        && transition.toVersion === index + 1
        && (index === 0
          || transition.previousTransitionHash === restored.transitions[index - 1].transitionHash)
      ))).toBe(true)
      expect(percentile(timings, 0.95)).toBeLessThan(100)
    } finally {
      await journal.close()
    }
  }, 120_000)
})

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))
  return sorted[index] ?? 0
}
