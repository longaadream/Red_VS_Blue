import type { Pool, PoolClient } from 'pg'

import {
  replayBattleAuthorityTransitions,
  type BattleAuthorityCheckpointRecord,
  type BattleAuthorityReceipt,
  type BattleAuthorityTransitionRecord,
} from '@/lib/game/battle-transition'
import type { Room } from '@/lib/game/room-model'

import { POSTGRES_AUTHORITY_SCHEMA_STATEMENTS } from './authority-schema'
import type {
  PostgresBattleReportV1,
  PostgresBattleReportReader,
  PostgresBattleReportSummaryV1,
  PostgresAuthorityBatchWriter,
  PostgresAuthorityTransitionJob,
  RestoredPostgresAuthorityRoom,
} from './authority-types'

interface AuthorityRow {
  epoch: string | number
  room_json: Room
  authority_version: string | number
  durable_version: string | number
  state_hash: string
  public_hash: string
  transition_hash: string
  terminal: boolean
}

interface BattleReportSummaryRow extends AuthorityRow {
  battle_id: string
  terminal_authority_version: string | number
  terminal_state_hash: string
  terminal_transition_hash: string
  terminal_checkpoint_json: BattleAuthorityCheckpointRecord
  committed_at: Date | string
}

interface StoredTransitionSummaryRow {
  battle_id: string
  epoch: string | number
  from_version: string | number
  to_version: string | number
  client_action_id: string
  action_hash: string
  pre_state_hash: string
  post_state_hash: string
  previous_transition_hash: string
  transition_hash: string
  protocol_version_json: string | number
  authority_build_id_json?: string
  room_id_json: string
  from_version_json: string | number
  to_version_json: string | number
  client_action_id_json: string
  action_hash_json: string
  pre_state_hash_json: string
  post_state_hash_json: string
  pre_public_hash_json: string
  post_public_hash_json: string
  previous_transition_hash_json: string
  transition_hash_json: string
  transition_receipt_json: BattleAuthorityReceipt
}

interface StoredReceiptRow {
  battle_id: string
  client_action_id: string
  authority_version: string | number
  status: string
  receipt_json: BattleAuthorityReceipt
}

interface StoredInitialCheckpointRow {
  battle_id: string
  state_hash: string
  public_hash: string
  transition_hash: string
  checkpoint_json: BattleAuthorityCheckpointRecord
}

export class PostgresAuthorityRepository implements PostgresAuthorityBatchWriter, PostgresBattleReportReader {
  constructor(private readonly pool: Pool) {}

  async initializeSchema(): Promise<void> {
    await this.transaction(async client => {
      for (const statement of POSTGRES_AUTHORITY_SCHEMA_STATEMENTS) await client.query(statement)
      const version = await client.query<{ version: number }>(
        'SELECT version FROM battle_authority_schema_version WHERE singleton = TRUE',
      )
      if (version.rows[0]?.version !== 1) {
        throw new Error(`Unsupported PostgreSQL authority schema version: ${String(version.rows[0]?.version)}`)
      }
    })
  }

  async healthCheck(): Promise<void> {
    await this.pool.query('SELECT 1')
  }

  async listRestorableRoomIds(): Promise<string[]> {
    const result = await this.pool.query<{ battle_id: string }>(
      `SELECT battle_id FROM battle_room_authority
       WHERE terminal = FALSE
       ORDER BY updated_at, battle_id`,
    )
    return result.rows.map(row => normalizeRoomId(row.battle_id))
  }

  async initializeRoom(
    room: Room,
    checkpoint: BattleAuthorityCheckpointRecord,
    epoch = 1,
  ): Promise<void> {
    const roomId = normalizeRoomId(room.id)
    if (checkpoint.roomId !== roomId || checkpoint.authorityVersion !== 0 || checkpoint.reason !== 'initial') {
      throw new Error(`Initial PostgreSQL checkpoint is invalid for ${roomId}`)
    }
    await this.transaction(async client => {
      const inserted = await client.query(
        `INSERT INTO battle_room_authority (
          battle_id, epoch, room_json, authority_version, durable_version,
          state_hash, public_hash, transition_hash, terminal
        ) VALUES ($1, $2, $3::jsonb, 0, 0, $4, $5, $6, FALSE)
        ON CONFLICT (battle_id) DO NOTHING`,
        [roomId, epoch, JSON.stringify(room), checkpoint.stateHash, checkpoint.publicHash, checkpoint.transitionHash],
      )
      if (inserted.rowCount === 1) {
        await insertCheckpoint(client, checkpoint)
        return
      }
      const existing = await lockAuthorityRow(client, roomId)
      if (
        numberValue(existing.durable_version) !== 0
        || existing.state_hash !== checkpoint.stateHash
        || existing.public_hash !== checkpoint.publicHash
        || existing.transition_hash !== checkpoint.transitionHash
      ) {
        throw new Error(`PostgreSQL authority room ${roomId} already exists with a different genesis`)
      }
    })
  }

  async commitTransitionBatch(
    roomId: string,
    jobs: readonly PostgresAuthorityTransitionJob[],
  ): Promise<number> {
    const normalizedRoomId = normalizeRoomId(roomId)
    if (jobs.length === 0) throw new Error('PostgreSQL authority batch must not be empty')
    if (jobs.some(job => job.roomId !== normalizedRoomId)) {
      throw new Error(`PostgreSQL authority batch mixed multiple rooms for ${normalizedRoomId}`)
    }
    if (jobs.some(job => (
      job.epoch !== jobs[0].epoch
      || job.transition.roomId !== normalizedRoomId
      || job.transition.receipt.roomId !== normalizedRoomId
    ))) throw new Error(`PostgreSQL authority batch identity mismatch for ${normalizedRoomId}`)
    assertContiguousBatch(jobs)

    return this.transaction(async client => {
      const authority = await lockAuthorityRow(client, normalizedRoomId)
      const first = jobs[0]
      const last = jobs[jobs.length - 1]
      const currentDurableVersion = numberValue(authority.durable_version)
      if (currentDurableVersion === last.transition.toVersion) {
        await assertAlreadyCommittedBatch(client, normalizedRoomId, jobs)
        return currentDurableVersion
      }
      if (
        currentDurableVersion !== first.transition.fromVersion
        || numberValue(authority.epoch) !== first.epoch
        || authority.transition_hash !== first.transition.previousTransitionHash
      ) {
        throw new Error(
          `PostgreSQL authority CAS failed for ${normalizedRoomId}: durable=${currentDurableVersion}, from=${first.transition.fromVersion}`,
        )
      }
      for (const job of jobs) {
        await insertTransition(client, job)
        await insertReceipt(client, job.transition.receipt)
        if (job.baseCheckpoint) await insertCheckpoint(client, job.baseCheckpoint, true)
        if (job.checkpoint) await insertCheckpoint(client, job.checkpoint, true)
      }
      const terminalJob = [...jobs].reverse().find(job => job.checkpoint?.reason === 'terminal')
      if (terminalJob?.checkpoint) await insertTerminalBarrier(client, terminalJob)
      const updated = await client.query(
        `UPDATE battle_room_authority
         SET room_json = $3::jsonb, authority_version = $4, durable_version = $4,
             state_hash = $5, public_hash = $6, transition_hash = $7,
             terminal = $8, updated_at = NOW()
         WHERE battle_id = $1 AND epoch = $2 AND durable_version = $9`,
        [
          normalizedRoomId,
          last.epoch,
          JSON.stringify(last.nextRoom),
          last.transition.toVersion,
          last.transition.postStateHash,
          last.transition.postPublicHash,
          last.transition.transitionHash,
          last.checkpoint?.reason === 'terminal',
          first.transition.fromVersion,
        ],
      )
      if (updated.rowCount !== 1) {
        throw new Error(`PostgreSQL authority watermark CAS failed for ${normalizedRoomId}`)
      }
      return last.transition.toVersion
    })
  }

  async restoreRoom(roomId: string): Promise<RestoredPostgresAuthorityRoom | undefined> {
    const normalizedRoomId = normalizeRoomId(roomId)
    const authorityResult = await this.pool.query<AuthorityRow>(
      'SELECT * FROM battle_room_authority WHERE battle_id = $1',
      [normalizedRoomId],
    )
    const authority = authorityResult.rows[0]
    if (!authority) return undefined
    const durableVersion = numberValue(authority.durable_version)
    const checkpointResult = await this.pool.query<{ checkpoint_json: BattleAuthorityCheckpointRecord }>(
      `SELECT checkpoint_json FROM battle_checkpoint
       WHERE battle_id = $1 AND authority_version <= $2
       ORDER BY authority_version DESC LIMIT 1`,
      [normalizedRoomId, durableVersion],
    )
    const checkpoint = checkpointResult.rows[0]?.checkpoint_json
    if (!checkpoint) throw new Error(`PostgreSQL authority checkpoint missing for ${normalizedRoomId}`)
    const replayRows = await this.pool.query<{ transition_json: BattleAuthorityTransitionRecord }>(
      `SELECT transition_json FROM battle_transition
       WHERE battle_id = $1 AND to_version > $2 AND to_version <= $3
       ORDER BY to_version`,
      [normalizedRoomId, checkpoint.authorityVersion, durableVersion],
    )
    const replayTransitions = replayRows.rows.map(row => row.transition_json)
    const storage = replayBattleAuthorityTransitions({
      roomId: normalizedRoomId,
      checkpointStorage: checkpoint.storage,
      checkpointProtocolVersion: checkpoint.protocolVersion,
      checkpointAuthorityBuildId: checkpoint.authorityBuildId,
      checkpointVersion: checkpoint.authorityVersion,
      checkpointStateHash: checkpoint.stateHash,
      checkpointPublicHash: checkpoint.publicHash,
      checkpointTransitionHash: checkpoint.transitionHash,
      targetVersion: durableVersion,
      targetTransitionHash: authority.transition_hash,
      transitions: replayTransitions,
    })
    const allTransitions = await this.pool.query<{ transition_json: BattleAuthorityTransitionRecord }>(
      'SELECT transition_json FROM battle_transition WHERE battle_id = $1 ORDER BY to_version',
      [normalizedRoomId],
    )
    const receipts = await this.pool.query<{ receipt_json: BattleAuthorityReceipt }>(
      'SELECT receipt_json FROM battle_receipt WHERE battle_id = $1 ORDER BY authority_version, client_action_id',
      [normalizedRoomId],
    )
    return {
      room: {
        ...authority.room_json,
        battleState: storage as unknown as Room['battleState'],
        battleAuthorityVersion: durableVersion,
        battleAuthorityDurableVersion: durableVersion,
        battleAuthorityTransitionHash: authority.transition_hash,
        battleAuthorityPersistenceStatus: 'durable',
        ...(authority.terminal ? { status: 'finished' as const } : {}),
      },
      epoch: numberValue(authority.epoch),
      durableAuthorityVersion: durableVersion,
      receipts: receipts.rows.map(row => row.receipt_json),
      transitions: allTransitions.rows.map(row => row.transition_json),
    }
  }

  async readBattleReport(battleId: string): Promise<PostgresBattleReportV1 | undefined> {
    const roomId = normalizeRoomId(battleId)
    const authorityResult = await this.pool.query<AuthorityRow>(
      'SELECT * FROM battle_room_authority WHERE battle_id = $1',
      [roomId],
    )
    const authority = authorityResult.rows[0]
    if (!authority) return undefined
    const authorityVersion = numberValue(authority.durable_version)
    if (!authority.terminal || numberValue(authority.authority_version) !== authorityVersion) {
      throw reportError('BATTLE_REPORT_NOT_DURABLE', 'Battle report is not terminal and durable')
    }

    const initialResult = await this.pool.query<{ checkpoint_json: BattleAuthorityCheckpointRecord }>(
      `SELECT checkpoint_json FROM battle_checkpoint
       WHERE battle_id = $1 AND authority_version = 0 AND reason = 'initial'`,
      [roomId],
    )
    const initial = initialResult.rows[0]?.checkpoint_json
    if (!initial) throw reportError('BATTLE_REPORT_INTEGRITY_FAILED', 'Initial report checkpoint is missing')
    const transitionResult = await this.pool.query<{ transition_json: BattleAuthorityTransitionRecord }>(
      'SELECT transition_json FROM battle_transition WHERE battle_id = $1 ORDER BY to_version',
      [roomId],
    )
    const transitions = transitionResult.rows.map(row => row.transition_json)
    try {
      replayBattleAuthorityTransitions({
        roomId,
        checkpointStorage: initial.storage,
        checkpointProtocolVersion: initial.protocolVersion,
        checkpointAuthorityBuildId: initial.authorityBuildId,
        checkpointVersion: initial.authorityVersion,
        checkpointStateHash: initial.stateHash,
        checkpointPublicHash: initial.publicHash,
        checkpointTransitionHash: initial.transitionHash,
        targetVersion: authorityVersion,
        targetTransitionHash: authority.transition_hash,
        transitions,
      })
    } catch (error) {
      throw reportError(
        'BATTLE_REPORT_INTEGRITY_FAILED',
        error instanceof Error ? error.message : String(error),
      )
    }

    const terminalResult = await this.pool.query<{
      authority_version: string | number
      state_hash: string
      transition_hash: string
      checkpoint_json: BattleAuthorityCheckpointRecord
      committed_at: Date | string
    }>(
      'SELECT * FROM battle_terminal_barrier WHERE battle_id = $1',
      [roomId],
    )
    const terminal = terminalResult.rows[0]
    const terminalVersion = terminal ? numberValue(terminal.authority_version) : -1
    if (
      !terminal
      || terminalVersion !== authorityVersion
      || terminal.state_hash !== authority.state_hash
      || terminal.transition_hash !== authority.transition_hash
      || terminal.checkpoint_json.authorityVersion !== authorityVersion
      || terminal.checkpoint_json.stateHash !== authority.state_hash
      || terminal.checkpoint_json.publicHash !== authority.public_hash
      || terminal.checkpoint_json.transitionHash !== authority.transition_hash
      || terminal.checkpoint_json.reason !== 'terminal'
    ) throw reportError('BATTLE_REPORT_INTEGRITY_FAILED', 'Terminal report barrier does not match authority')

    const finalTransition = transitions.at(-1)
    if (
      (finalTransition?.postStateHash ?? initial.stateHash) !== authority.state_hash
      || (finalTransition?.postPublicHash ?? initial.publicHash) !== authority.public_hash
    ) throw reportError('BATTLE_REPORT_INTEGRITY_FAILED', 'Authority hashes do not match the verified transition chain')
    try {
      replayBattleAuthorityTransitions({
        roomId,
        checkpointStorage: terminal.checkpoint_json.storage,
        checkpointProtocolVersion: terminal.checkpoint_json.protocolVersion,
        checkpointAuthorityBuildId: terminal.checkpoint_json.authorityBuildId,
        checkpointVersion: terminal.checkpoint_json.authorityVersion,
        checkpointStateHash: terminal.checkpoint_json.stateHash,
        checkpointPublicHash: terminal.checkpoint_json.publicHash,
        checkpointTransitionHash: terminal.checkpoint_json.transitionHash,
        targetVersion: authorityVersion,
        targetTransitionHash: authority.transition_hash,
        transitions: [],
      })
    } catch (error) {
      throw reportError(
        'BATTLE_REPORT_INTEGRITY_FAILED',
        `Terminal checkpoint verification failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const receiptResult = await this.pool.query<{ receipt_json: BattleAuthorityReceipt }>(
      'SELECT receipt_json FROM battle_receipt WHERE battle_id = $1 ORDER BY authority_version, client_action_id',
      [roomId],
    )
    const receipts = receiptResult.rows.map(row => row.receipt_json)
    if (
      receipts.length !== transitions.length
      || receipts.some((receipt, index) => !receiptMatchesTransition(receipt, transitions[index]))
    ) throw reportError('BATTLE_REPORT_INTEGRITY_FAILED', 'Battle receipts do not match the verified transition chain')
    const room = authority.room_json
    return {
      schemaVersion: 'rvb-postgres-battle-report/v1',
      verified: true,
      battleId: roomId,
      room: {
        id: roomId,
        name: room.name,
        mapId: room.mapId,
        createdAt: room.createdAt,
        players: room.players.map(player => ({
          id: player.id,
          accountId: player.accountId,
          name: player.name,
          seat: player.seat,
          alignment: player.alignment,
        })),
      },
      authority: {
        authorityVersion,
        durableAuthorityVersion: authorityVersion,
        stateHash: authority.state_hash,
        publicHash: authority.public_hash,
        transitionHash: authority.transition_hash,
      },
      terminal: {
        committedAt: new Date(terminal.committed_at).toISOString(),
        checkpoint: terminal.checkpoint_json,
      },
      receipts,
      transitions,
    }
  }

  async listBattleReports(playerId: string, limit = 100) {
    const normalizedPlayerId = String(playerId ?? '').trim().toLowerCase()
    if (!normalizedPlayerId) throw reportError('PLAYER_ID_REQUIRED', 'playerId is required')
    const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 100
    const result = await this.pool.query<BattleReportSummaryRow>(
      `SELECT authority.*,
          terminal.authority_version AS terminal_authority_version,
          terminal.state_hash AS terminal_state_hash,
          terminal.transition_hash AS terminal_transition_hash,
          terminal.checkpoint_json AS terminal_checkpoint_json,
          terminal.committed_at
       FROM battle_room_authority authority
       INNER JOIN battle_terminal_barrier terminal ON terminal.battle_id = authority.battle_id
       WHERE authority.terminal = TRUE AND authority.room_json->'players' @> $1::jsonb
       ORDER BY authority.updated_at DESC, authority.battle_id
       LIMIT $2`,
      [JSON.stringify([{ id: normalizedPlayerId }]), boundedLimit],
    )
    if (result.rows.length === 0) return []
    const battleIds = result.rows.map(row => normalizeRoomId(row.battle_id))
    const [initialResult, transitionResult, receiptResult] = await Promise.all([
      this.pool.query<StoredInitialCheckpointRow>(
        `SELECT battle_id, state_hash, public_hash, transition_hash, checkpoint_json
         FROM battle_checkpoint
         WHERE battle_id = ANY($1::text[]) AND authority_version = 0 AND reason = 'initial'`,
        [battleIds],
      ),
      this.pool.query<StoredTransitionSummaryRow>(
        `SELECT battle_id, epoch, from_version, to_version, client_action_id, action_hash,
            pre_state_hash, post_state_hash, previous_transition_hash, transition_hash,
            transition_json->>'protocolVersion' AS protocol_version_json,
            transition_json->>'authorityBuildId' AS authority_build_id_json,
            transition_json->>'roomId' AS room_id_json,
            transition_json->>'fromVersion' AS from_version_json,
            transition_json->>'toVersion' AS to_version_json,
            transition_json->>'clientActionId' AS client_action_id_json,
            transition_json->>'actionHash' AS action_hash_json,
            transition_json->>'preStateHash' AS pre_state_hash_json,
            transition_json->>'postStateHash' AS post_state_hash_json,
            transition_json->>'prePublicHash' AS pre_public_hash_json,
            transition_json->>'postPublicHash' AS post_public_hash_json,
            transition_json->>'previousTransitionHash' AS previous_transition_hash_json,
            transition_json->>'transitionHash' AS transition_hash_json,
            transition_json->'receipt' AS transition_receipt_json
         FROM battle_transition WHERE battle_id = ANY($1::text[]) ORDER BY battle_id, to_version`,
        [battleIds],
      ),
      this.pool.query<StoredReceiptRow>(
        `SELECT battle_id, client_action_id, authority_version, status, receipt_json
         FROM battle_receipt
         WHERE battle_id = ANY($1::text[]) ORDER BY battle_id, authority_version, client_action_id`,
        [battleIds],
      ),
    ])
    const initialByBattleId = new Map(initialResult.rows.map(row => [normalizeRoomId(row.battle_id), row]))
    const transitionsByBattleId = groupReportRows(transitionResult.rows)
    const receiptsByBattleId = groupReportRows(receiptResult.rows)
    const reports = result.rows.map(row => {
      try {
        const roomId = normalizeRoomId(row.battle_id)
        return this.readBattleReportSummary(
          row,
          initialByBattleId.get(roomId),
          transitionsByBattleId.get(roomId) ?? [],
          receiptsByBattleId.get(roomId) ?? [],
        )
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : ''
        if (code !== 'BATTLE_REPORT_INTEGRITY_FAILED' && code !== 'BATTLE_REPORT_NOT_DURABLE') throw error
        console.error('[postgres-authority] excluded unverified battle report from list', {
          battleId: normalizeRoomId(row.battle_id),
          code,
          message: error instanceof Error ? error.message : String(error),
        })
        return undefined
      }
    })
    return reports.filter((report): report is PostgresBattleReportSummaryV1 => report !== undefined)
  }

  private readBattleReportSummary(
    row: BattleReportSummaryRow,
    initialRow: StoredInitialCheckpointRow | undefined,
    transitions: StoredTransitionSummaryRow[],
    receipts: StoredReceiptRow[],
  ): PostgresBattleReportSummaryV1 {
    const roomId = normalizeRoomId(row.battle_id)
    const authorityVersion = numberValue(row.authority_version)
    const durableVersion = numberValue(row.durable_version)
    const terminalVersion = numberValue(row.terminal_authority_version)
    const terminal = row.terminal_checkpoint_json
    if (
      !row.terminal
      || authorityVersion !== durableVersion
      || terminalVersion !== authorityVersion
      || row.terminal_state_hash !== row.state_hash
      || row.terminal_transition_hash !== row.transition_hash
      || !terminal
      || terminal.roomId !== roomId
      || terminal.authorityVersion !== authorityVersion
      || terminal.stateHash !== row.state_hash
      || terminal.publicHash !== row.public_hash
      || terminal.transitionHash !== row.transition_hash
      || terminal.reason !== 'terminal'
    ) throw reportError('BATTLE_REPORT_INTEGRITY_FAILED', 'Terminal report barrier does not match authority')

    const initial = initialRow?.checkpoint_json
    if (
      !initial
      || initial.roomId !== roomId
      || initial.authorityVersion !== 0
      || initial.reason !== 'initial'
      || initialRow.state_hash !== initial.stateHash
      || initialRow.public_hash !== initial.publicHash
      || initialRow.transition_hash !== initial.transitionHash
    ) throw reportError('BATTLE_REPORT_INTEGRITY_FAILED', 'Initial report checkpoint is invalid')

    if (transitions.length !== authorityVersion || receipts.length !== authorityVersion) {
      throw reportError('BATTLE_REPORT_INTEGRITY_FAILED', 'Battle report chain length does not match authority')
    }
    let expectedVersion = 0
    let expectedStateHash = initial.stateHash
    let expectedPublicHash = initial.publicHash
    let expectedTransitionHash = initial.transitionHash
    for (let index = 0; index < transitions.length; index += 1) {
      const stored = transitions[index]
      const storedReceipt = receipts[index]
      const receipt = storedReceipt?.receipt_json
      if (
        numberValue(stored.epoch) !== numberValue(row.epoch)
        || numberValue(stored.from_version) !== numberValue(stored.from_version_json)
        || numberValue(stored.to_version) !== numberValue(stored.to_version_json)
        || stored.client_action_id !== stored.client_action_id_json
        || stored.action_hash !== stored.action_hash_json
        || stored.pre_state_hash !== stored.pre_state_hash_json
        || stored.post_state_hash !== stored.post_state_hash_json
        || stored.previous_transition_hash !== stored.previous_transition_hash_json
        || stored.transition_hash !== stored.transition_hash_json
        || numberValue(stored.protocol_version_json) !== initial.protocolVersion
        || stored.authority_build_id_json !== initial.authorityBuildId
        || stored.room_id_json !== roomId
        || numberValue(stored.from_version) !== expectedVersion
        || numberValue(stored.to_version) !== expectedVersion + 1
        || stored.pre_state_hash !== expectedStateHash
        || stored.pre_public_hash_json !== expectedPublicHash
        || stored.previous_transition_hash !== expectedTransitionHash
        || !receipt
        || storedReceipt.client_action_id !== receipt.clientActionId
        || numberValue(storedReceipt.authority_version) !== receipt.authorityVersion
        || storedReceipt.status !== receipt.status
        || !receiptMatchesStoredTransition(receipt, stored)
      ) throw reportError('BATTLE_REPORT_INTEGRITY_FAILED', `Battle report chain is invalid at ${expectedVersion + 1}`)
      expectedVersion = numberValue(stored.to_version)
      expectedStateHash = stored.post_state_hash
      expectedPublicHash = stored.post_public_hash_json
      expectedTransitionHash = stored.transition_hash
    }
    if (
      expectedVersion !== authorityVersion
      || expectedStateHash !== row.state_hash
      || expectedPublicHash !== row.public_hash
      || expectedTransitionHash !== row.transition_hash
    ) throw reportError('BATTLE_REPORT_INTEGRITY_FAILED', 'Battle report chain head does not match authority')

    try {
      replayBattleAuthorityTransitions({
        roomId,
        checkpointStorage: terminal.storage,
        checkpointProtocolVersion: terminal.protocolVersion,
        checkpointAuthorityBuildId: terminal.authorityBuildId,
        checkpointVersion: terminal.authorityVersion,
        checkpointStateHash: terminal.stateHash,
        checkpointPublicHash: terminal.publicHash,
        checkpointTransitionHash: terminal.transitionHash,
        targetVersion: authorityVersion,
        targetTransitionHash: row.transition_hash,
        transitions: [],
      })
    } catch (error) {
      throw reportError(
        'BATTLE_REPORT_INTEGRITY_FAILED',
        `Terminal checkpoint verification failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const room = row.room_json
    return {
      battleId: roomId,
      name: room.name,
      mapId: room.mapId,
      createdAt: room.createdAt,
      committedAt: new Date(row.committed_at).toISOString(),
      authorityVersion,
      transitionHash: row.transition_hash,
      players: room.players.map(player => ({
        id: player.id,
        accountId: player.accountId,
        name: player.name,
        seat: player.seat,
        alignment: player.alignment,
      })),
      terminalResult: (terminal.storage.state as { terminalResult?: unknown }).terminalResult,
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Preserve the original PostgreSQL failure.
      }
      throw error
    } finally {
      client.release()
    }
  }
}

async function lockAuthorityRow(client: PoolClient, roomId: string): Promise<AuthorityRow> {
  const result = await client.query<AuthorityRow>(
    'SELECT * FROM battle_room_authority WHERE battle_id = $1 FOR UPDATE',
    [roomId],
  )
  const row = result.rows[0]
  if (!row) throw new Error(`PostgreSQL authority room ${roomId} does not exist`)
  return row
}

async function insertTransition(client: PoolClient, job: PostgresAuthorityTransitionJob): Promise<void> {
  const transition = job.transition
  await client.query(
    `INSERT INTO battle_transition (
      battle_id, epoch, from_version, to_version, client_action_id, action_hash,
      pre_state_hash, post_state_hash, previous_transition_hash, transition_hash, transition_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [
      job.roomId,
      job.epoch,
      transition.fromVersion,
      transition.toVersion,
      transition.clientActionId,
      transition.actionHash,
      transition.preStateHash,
      transition.postStateHash,
      transition.previousTransitionHash,
      transition.transitionHash,
      JSON.stringify(transition),
    ],
  )
}

async function insertReceipt(client: PoolClient, receipt: BattleAuthorityReceipt): Promise<void> {
  await client.query(
    `INSERT INTO battle_receipt (
      battle_id, client_action_id, authority_version, status, receipt_json
    ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [receipt.roomId, receipt.clientActionId, receipt.authorityVersion, receipt.status, JSON.stringify(receipt)],
  )
}

async function insertCheckpoint(
  client: PoolClient,
  checkpoint: BattleAuthorityCheckpointRecord,
  ignoreConflict = false,
): Promise<void> {
  await client.query(
    `INSERT INTO battle_checkpoint (
      battle_id, authority_version, state_hash, public_hash, transition_hash, reason, checkpoint_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    ${ignoreConflict ? 'ON CONFLICT (battle_id, authority_version) DO NOTHING' : ''}`,
    [
      checkpoint.roomId,
      checkpoint.authorityVersion,
      checkpoint.stateHash,
      checkpoint.publicHash,
      checkpoint.transitionHash,
      checkpoint.reason,
      JSON.stringify(checkpoint),
    ],
  )
}

async function insertTerminalBarrier(client: PoolClient, job: PostgresAuthorityTransitionJob): Promise<void> {
  const checkpoint = job.checkpoint!
  await client.query(
    `INSERT INTO battle_terminal_barrier (
      battle_id, authority_version, state_hash, transition_hash, checkpoint_json
    ) VALUES ($1, $2, $3, $4, $5::jsonb)
    ON CONFLICT (battle_id) DO UPDATE SET
      authority_version = EXCLUDED.authority_version,
      state_hash = EXCLUDED.state_hash,
      transition_hash = EXCLUDED.transition_hash,
      checkpoint_json = EXCLUDED.checkpoint_json,
      committed_at = NOW()`,
    [job.roomId, checkpoint.authorityVersion, checkpoint.stateHash, checkpoint.transitionHash, JSON.stringify(checkpoint)],
  )
}

async function assertAlreadyCommittedBatch(
  client: PoolClient,
  roomId: string,
  jobs: readonly PostgresAuthorityTransitionJob[],
): Promise<void> {
  const rows = await client.query<{ to_version: string | number; transition_hash: string }>(
    `SELECT to_version, transition_hash FROM battle_transition
     WHERE battle_id = $1 AND to_version BETWEEN $2 AND $3 ORDER BY to_version`,
    [roomId, jobs[0].transition.toVersion, jobs[jobs.length - 1].transition.toVersion],
  )
  if (
    rows.rows.length !== jobs.length
    || rows.rows.some((row, index) => (
      numberValue(row.to_version) !== jobs[index].transition.toVersion
      || row.transition_hash !== jobs[index].transition.transitionHash
    ))
  ) throw new Error(`PostgreSQL authority retry verification failed for ${roomId}`)
}

function assertContiguousBatch(jobs: readonly PostgresAuthorityTransitionJob[]): void {
  for (let index = 0; index < jobs.length; index += 1) {
    const transition = jobs[index].transition
    if (transition.toVersion !== transition.fromVersion + 1) {
      throw new Error('Authority transition is not contiguous')
    }
    if (index > 0) {
      const previous = jobs[index - 1].transition
      if (
        transition.fromVersion !== previous.toVersion
        || transition.previousTransitionHash !== previous.transitionHash
      ) throw new Error('PostgreSQL authority batch contains a version or hash gap')
    }
  }
}

function groupReportRows<T extends { battle_id: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const row of rows) {
    const roomId = normalizeRoomId(row.battle_id)
    const group = grouped.get(roomId)
    if (group) group.push(row)
    else grouped.set(roomId, [row])
  }
  return grouped
}

function numberValue(value: string | number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid PostgreSQL authority integer: ${String(value)}`)
  }
  return parsed
}

function normalizeRoomId(roomId: string): string {
  const normalized = String(roomId ?? '').trim().toLowerCase()
  if (!normalized) throw new Error('roomId is required')
  return normalized
}

function reportError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function receiptMatchesTransition(
  receipt: BattleAuthorityReceipt,
  transition: BattleAuthorityTransitionRecord | undefined,
): boolean {
  if (!transition) return false
  return receiptsMatch(receipt, transition.receipt)
}

function receiptMatchesStoredTransition(
  receipt: BattleAuthorityReceipt,
  transition: StoredTransitionSummaryRow,
): boolean {
  return receiptsMatch(receipt, transition.transition_receipt_json)
}

function receiptsMatch(
  receipt: BattleAuthorityReceipt,
  expected: BattleAuthorityReceipt | undefined,
): boolean {
  if (!expected) return false
  return receipt.protocolVersion === expected.protocolVersion
    && receipt.authorityBuildId === expected.authorityBuildId
    && receipt.roomId === expected.roomId
    && receipt.clientActionId === expected.clientActionId
    && receipt.status === expected.status
    && receipt.authorityVersion === expected.authorityVersion
    && receipt.code === expected.code
    && receipt.message === expected.message
}
