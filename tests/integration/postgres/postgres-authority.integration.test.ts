import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hashBattleState } from '@/lib/game/battle-runner'
import {
  BATTLE_AUTHORITY_BUILD_ID,
  BATTLE_AUTHORITY_PROTOCOL_VERSION,
} from '@/lib/game/battle-public-patch'
import { getBattleStorage } from '@/lib/game/battle-storage'
import { dispatchRoomBattleAction } from '@/lib/game/room-battle-actions'
import type { BattleAuthorityTransitionRecord } from '@/lib/game/battle-transition'
import type { Room } from '@/lib/game/room-store'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { CandidateBattleStore } from '@/lib/server/colyseus/candidate-battle-store'
import { createDevelopmentBattleRoom } from '@/lib/server/colyseus/development-battle-fixture'
import { PostgresAuthorityJournal } from '@/lib/server/postgres/postgres-authority-journal'
import { PostgresAuthorityRepository } from '@/lib/server/postgres/postgres-authority-repository'
import type { PostgresAuthorityTransitionJob } from '@/lib/server/postgres/authority-types'

const databaseUrl = process.env.RVB_TEST_POSTGRES_URL
const originalAuthority = process.env.RVB_BATTLE_AUTHORITY_V2

describe.skipIf(!databaseUrl)('RED-160 real PostgreSQL authority integration', () => {
  beforeAll(() => {
    process.env.RVB_BATTLE_AUTHORITY_V2 = '1'
  })

  afterAll(() => {
    if (originalAuthority === undefined) delete process.env.RVB_BATTLE_AUTHORITY_V2
    else process.env.RVB_BATTLE_AUTHORITY_V2 = originalAuthority
  })

  it('commits a contiguous prefix, restores from checkpoint/replay, deduplicates, and persists terminal barrier', async () => {
    const battleId = `red160-pg-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const pool = new Pool({ connectionString: databaseUrl!, max: 4 })
    const repository = new PostgresAuthorityRepository(pool)
    await repository.initializeSchema()
    const firstJournal = new PostgresAuthorityJournal(repository, { maxBatchSize: 8, maxDwellMs: 25 })
    const firstStore = await CandidateBattleStore.open({
      roomId: battleId,
      repository,
      journal: firstJournal,
      fixtureFactory: createDevelopmentBattleRoom,
    })

    try {
      const genesisRoom = await requiredRoom(firstStore, battleId)
      await expect(repository.commitTransitionBatch(
        battleId,
        rollbackProbeBatch(genesisRoom),
      )).rejects.toBeDefined()
      const rolledBack = await pool.query(
        `SELECT
          (SELECT durable_version FROM battle_room_authority WHERE battle_id = $1) AS durable_version,
          (SELECT COUNT(*) FROM battle_transition WHERE battle_id = $1) AS transitions,
          (SELECT COUNT(*) FROM battle_receipt WHERE battle_id = $1) AS receipts`,
        [battleId],
      )
      expect(Number(rolledBack.rows[0].durable_version)).toBe(0)
      expect(Number(rolledBack.rows[0].transitions)).toBe(0)
      expect(Number(rolledBack.rows[0].receipts)).toBe(0)

      let lastHash = ''
      for (let index = 0; index < 20; index += 1) {
        const room = await requiredRoom(firstStore, battleId)
        const state = getBattleStorage(room)!.state as BattleState
        const playerId = state.turn.currentPlayerId
        const action = index % 2 === 0
          ? {
              type: 'endTurn',
              playerId,
              clientActionId: `pg-action-${index + 1}`,
            }
          : {
              type: 'beginPhase',
              clientActionId: `pg-action-${index + 1}`,
            }
        const result = await dispatchRoomBattleAction(
          firstStore,
          battleId,
          playerId,
          action as BattleAction,
          { expectedAuthorityVersion: index },
        )
        expect(result.kind).toBe('applied')
        // snapshot.stateHash is the viewer-safe public projection hash. Restore
        // is validated against the authoritative internal transition hash.
        lastHash = result.transition!.postStateHash
      }
      await firstJournal.drain(battleId)
      await firstJournal.close()

      const counts = await pool.query<{
        transitions: string
        receipts: string
        checkpoints: string
      }>(
        `SELECT
          (SELECT COUNT(*) FROM battle_transition WHERE battle_id = $1) AS transitions,
          (SELECT COUNT(*) FROM battle_receipt WHERE battle_id = $1) AS receipts,
          (SELECT COUNT(*) FROM battle_checkpoint WHERE battle_id = $1) AS checkpoints`,
        [battleId],
      )
      expect(Number(counts.rows[0].transitions)).toBe(20)
      expect(Number(counts.rows[0].receipts)).toBe(20)
      expect(Number(counts.rows[0].checkpoints)).toBeGreaterThanOrEqual(2)

      const restoredJournal = new PostgresAuthorityJournal(repository, { maxBatchSize: 8, maxDwellMs: 25 })
      const restoredStore = await CandidateBattleStore.open({
        roomId: battleId,
        repository,
        journal: restoredJournal,
        fixtureFactory: () => { throw new Error('restore unexpectedly requested a fixture') },
      })
      const restoredRoom = await requiredRoom(restoredStore, battleId)
      expect(restoredRoom.battleAuthorityVersion).toBe(20)
      expect(hashBattleState(getBattleStorage(restoredRoom)!.state as BattleState)).toBe(lastHash)

      const duplicate = await dispatchRoomBattleAction(
        restoredStore,
        battleId,
        'player-blue',
        { type: 'beginPhase', clientActionId: 'pg-action-20' } as BattleAction,
        { expectedAuthorityVersion: 19 },
      )
      expect(duplicate.kind).toBe('duplicate')

      const terminalState = getBattleStorage(await requiredRoom(restoredStore, battleId))!.state as BattleState
      const terminal = await dispatchRoomBattleAction(
        restoredStore,
        battleId,
        terminalState.turn.currentPlayerId,
        {
          type: 'surrender',
          playerId: terminalState.turn.currentPlayerId,
          clientActionId: 'pg-terminal',
        } as BattleAction,
        { expectedAuthorityVersion: 20 },
      )
      expect(terminal.snapshot).toMatchObject({
        authorityVersion: 21,
        durableAuthorityVersion: 21,
      })
      const barrier = await pool.query(
        'SELECT authority_version, transition_hash FROM battle_terminal_barrier WHERE battle_id = $1',
        [battleId],
      )
      expect(barrier.rows).toHaveLength(1)
      expect(Number(barrier.rows[0].authority_version)).toBe(21)
      const authority = await pool.query(
        'SELECT durable_version, terminal FROM battle_room_authority WHERE battle_id = $1',
        [battleId],
      )
      expect(authority.rows[0]).toMatchObject({ terminal: true })
      expect(Number(authority.rows[0].durable_version)).toBe(21)
      await restoredJournal.close()
    } finally {
      await pool.query('DELETE FROM battle_room_authority WHERE battle_id = $1', [battleId])
      await repository.close()
    }
  }, 30_000)
})

async function requiredRoom(store: CandidateBattleStore, roomId: string) {
  const room = await store.getRoom(roomId)
  if (!room) throw new Error(`Missing test room ${roomId}`)
  return room
}

function rollbackProbeBatch(room: Room): PostgresAuthorityTransitionJob[] {
  const roomId = room.id
  const genesis = room.battleAuthorityTransitionHash!
  const firstHash = hashAt(901)
  const secondHash = hashAt(902)
  const clientActionId = 'rollback-duplicate-action'
  return [
    {
      roomId,
      epoch: 1,
      nextRoom: { ...structuredClone(room), battleAuthorityVersion: 1, battleAuthorityTransitionHash: firstHash },
      transition: probeTransition(roomId, 0, genesis, firstHash, clientActionId),
    },
    {
      roomId,
      epoch: 1,
      nextRoom: { ...structuredClone(room), battleAuthorityVersion: 2, battleAuthorityTransitionHash: secondHash },
      transition: probeTransition(roomId, 1, firstHash, secondHash, clientActionId),
    },
  ]
}

function probeTransition(
  roomId: string,
  fromVersion: number,
  previousTransitionHash: string,
  transitionHash: string,
  clientActionId: string,
): BattleAuthorityTransitionRecord {
  const toVersion = fromVersion + 1
  return {
    protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
    authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
    roomId,
    fromVersion,
    toVersion,
    clientActionId,
    playerId: 'player-red',
    command: { type: 'beginPhase', clientActionId } as BattleAction,
    commands: [{ type: 'beginPhase', clientActionId } as BattleAction],
    internalPatch: [],
    publicPatch: [],
    preStateHash: hashAt(100 + fromVersion),
    postStateHash: hashAt(100 + toVersion),
    prePublicHash: hashAt(200 + fromVersion),
    postPublicHash: hashAt(200 + toVersion),
    actionHash: hashAt(300 + toVersion),
    previousTransitionHash,
    transitionHash,
    receipt: {
      protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
      authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
      roomId,
      clientActionId,
      status: 'applied',
      authorityVersion: toVersion,
    },
    traces: [],
    replayFrames: [],
    createdAt: toVersion,
  }
}

function hashAt(value: number): string {
  return value.toString(16).padStart(64, '0')
}
