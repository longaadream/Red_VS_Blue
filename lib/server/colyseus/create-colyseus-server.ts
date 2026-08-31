import { defineRoom, defineServer } from 'colyseus'
import { Pool } from 'pg'

import type { PostgresAuthorityBatchWriter } from '@/lib/server/postgres/authority-types'
import {
  PostgresAuthorityJournal,
  type PostgresAuthorityJournalOptions,
} from '@/lib/server/postgres/postgres-authority-journal'
import { PostgresAuthorityRepository } from '@/lib/server/postgres/postgres-authority-repository'

import { createBattleRoomClass } from './battle-room'
import { BATTLE_ROOM_TYPE } from './battle-room-protocol'
import {
  type BattleRoomFixtureFactory,
  type CandidateAuthorityRepository,
} from './candidate-battle-store'
import { createDevelopmentBattleRoom } from './development-battle-fixture'

export interface BattleServerRepository
  extends CandidateAuthorityRepository, PostgresAuthorityBatchWriter {
  initializeSchema(): Promise<void>
  healthCheck(): Promise<void>
  close?(): Promise<void>
}

export interface CreateColyseusBattleServerOptions {
  databaseUrl?: string
  repository?: BattleServerRepository
  journal?: PostgresAuthorityJournal
  journalOptions?: PostgresAuthorityJournalOptions
  fixtureFactory?: BattleRoomFixtureFactory
  poolMax?: number
}

interface HealthResponse {
  status(code: number): HealthResponse
  json(body: Record<string, unknown>): void
}

export function createColyseusBattleServer(options: CreateColyseusBattleServerOptions = {}) {
  const ownsRepository = !options.repository
  const repository = options.repository ?? createRepository(options)
  const journal = options.journal ?? new PostgresAuthorityJournal(repository, options.journalOptions)
  const BattleRoom = createBattleRoomClass({
    repository,
    journal,
    fixtureFactory: options.fixtureFactory ?? createDevelopmentBattleRoom,
  })
  let ready = false
  let healthError: string | undefined
  const server = defineServer({
    rooms: {
      [BATTLE_ROOM_TYPE]: defineRoom(BattleRoom),
    },
    greet: false,
    beforeListen: async () => {
      try {
        await repository.initializeSchema()
        await repository.healthCheck()
        ready = true
        healthError = undefined
      } catch (error) {
        ready = false
        healthError = error instanceof Error ? error.message : String(error)
        throw error
      }
    },
    express: app => {
      app.get('/healthz', async (_request: unknown, response: HealthResponse) => {
        try {
          await repository.healthCheck()
          response.status(ready ? 200 : 503).json({
            ok: ready,
            runtime: 'colyseus-postgresql',
            database: 'postgresql',
            ...(healthError ? { error: healthError } : {}),
          })
        } catch (error) {
          response.status(503).json({
            ok: false,
            runtime: 'colyseus-postgresql',
            database: 'postgresql',
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })
    },
  })
  server.onBeforeShutdown(() => journal.close())
  if (ownsRepository) server.onShutdown(() => repository.close?.())
  return { server, repository, journal }
}

function createRepository(options: CreateColyseusBattleServerOptions): PostgresAuthorityRepository {
  const connectionString = options.databaseUrl
    ?? process.env.RVB_POSTGRES_URL
    ?? process.env.DATABASE_URL
    ?? 'postgresql://rvb:rvb@127.0.0.1:5433/rvb_colyseus'
  const pool = new Pool({
    connectionString,
    max: options.poolMax ?? numberFromEnv(process.env.RVB_POSTGRES_POOL_MAX, 8),
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    application_name: 'red-vs-blue-colyseus',
  })
  return new PostgresAuthorityRepository(pool)
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}
