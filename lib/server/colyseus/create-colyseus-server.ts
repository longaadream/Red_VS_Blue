import { defineRoom, defineServer, matchMaker } from 'colyseus'
import { WebSocketTransport } from '@colyseus/ws-transport'
import { Pool } from 'pg'

import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { getSelectableMapCatalog } from '@/lib/game/map-selection'
import { getAllPieces } from '@/lib/game/piece-repository'
import { loadCardById } from '@/lib/game/skills'
import { getAllSkills } from '@/lib/game/skill-repository'
import { installNativeBattleSha256 } from '@/lib/server/battle-hash'
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
  listRestorableRoomIds?(): Promise<string[]>
  close?(): Promise<void>
}

export interface CreateColyseusBattleServerOptions {
  databaseUrl?: string
  repository?: BattleServerRepository
  journal?: PostgresAuthorityJournal
  journalOptions?: PostgresAuthorityJournalOptions
  fixtureFactory?: BattleRoomFixtureFactory
  poolMax?: number
  healthIdentity?: {
    runtime: string
    database: string
  }
}

interface HealthResponse {
  status(code: number): HealthResponse
  json(body: unknown): void
}

interface JsonRequest {
  params?: Record<string, string | undefined>
}

interface ExpressLikeApp {
  use(handler: (
    request: { method?: string },
    response: { setHeader(name: string, value: string): void; sendStatus(code: number): void },
    next: () => void,
  ) => void): void
  get(path: string, handler: (request: JsonRequest, response: HealthResponse) => void | Promise<void>): void
}

export function createColyseusBattleServer(options: CreateColyseusBattleServerOptions = {}) {
  // This runtime is the authority-v2 product boundary. Keep the flags local to
  // the process so callers cannot accidentally start Colyseus on the legacy
  // synchronous persistence path.
  process.env.RVB_BATTLE_AUTHORITY_V2 ??= '1'
  process.env.RVB_BATTLE_ASYNC_JOURNAL ??= '1'
  process.env.RVB_TURN_TIMER_ENABLED ??= '1'
  installNativeBattleSha256()
  const ownsRepository = !options.repository
  const repository = options.repository ?? createRepository(options)
  const journal = options.journal ?? new PostgresAuthorityJournal(repository, options.journalOptions)
  const healthIdentity = options.healthIdentity ?? {
    runtime: 'colyseus-postgresql',
    database: 'postgresql',
  }
  const BattleRoom = createBattleRoomClass({
    repository,
    journal,
    fixtureFactory: options.fixtureFactory ?? createDevelopmentBattleRoom,
  })
  let ready = false
  let healthError: string | undefined
  const server = defineServer({
    // Keep the transport as a static dependency so the packaged authority does
    // not rely on Colyseus' runtime dynamic import from node_modules.
    transport: new WebSocketTransport(),
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
    express: rawApp => {
      const app = rawApp as unknown as ExpressLikeApp
      app.use((_request, response, next) => {
        response.setHeader('Access-Control-Allow-Origin', '*')
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        if (_request.method === 'OPTIONS') {
          response.sendStatus(204)
          return
        }
        next()
      })
      app.get('/healthz', async (_request: unknown, response: HealthResponse) => {
        try {
          await repository.healthCheck()
          response.status(ready ? 200 : 503).json({
            ok: ready,
            protocol: 'rvb-colyseus',
            ...healthIdentity,
            ...(healthError ? { error: healthError } : {}),
          })
        } catch (error) {
          response.status(503).json({
            ok: false,
            protocol: 'rvb-colyseus',
            ...healthIdentity,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })
      app.get('/api/ping', (_request, response) => response.status(200).json({
        ok: true,
        protocol: 'rvb-colyseus',
        ...healthIdentity,
      }))
      app.get('/catalog/identity', (_request, response) => response.status(200).json({
        profileIdentity: getServerGameProfileIdentityV1(),
      }))
      app.get('/catalog/maps', (_request, response) => response.status(200).json({
        maps: getSelectableMapCatalog(),
      }))
      app.get('/catalog/pieces', (_request, response) => response.status(200).json({ pieces: getAllPieces() }))
      app.get('/catalog/skills', (_request, response) => response.status(200).json({ skills: getAllSkills() }))
      app.get('/rooms', async (_request, response) => {
        const listings = await matchMaker.query({ name: BATTLE_ROOM_TYPE })
        const rooms = listings
          .map(listing => listing.metadata as { product?: boolean; room?: unknown; visibility?: string } | undefined)
          .filter(metadata => metadata?.product === true && metadata.visibility !== 'private')
          .map(metadata => metadata?.room)
          .filter(Boolean)
        response.status(200).json({ rooms })
      })
      app.get('/catalog/cards/:cardId', (request, response) => {
        const card = loadCardById(String(request.params?.cardId ?? ''))
        response.status(card ? 200 : 404).json(card ?? { error: 'Card not found', code: 'CARD_NOT_FOUND' })
      })
    },
  })
  server.onBeforeShutdown(() => journal.close())
  if (ownsRepository) server.onShutdown(() => repository.close?.())
  let roomsRestored = false
  const restoreProductRooms = async (): Promise<string[]> => {
    if (roomsRestored) return []
    roomsRestored = true
    const roomIds = await repository.listRestorableRoomIds?.() ?? []
    for (const battleId of roomIds) {
      await matchMaker.createRoom(BATTLE_ROOM_TYPE, { product: true, restore: true, battleId })
    }
    return roomIds
  }
  return { server, repository, journal, restoreProductRooms }
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
  attachPostgresPoolErrorHandler(pool)
  return new PostgresAuthorityRepository(pool)
}

export function attachPostgresPoolErrorHandler(
  pool: Pick<Pool, 'on'>,
  logger: Pick<Console, 'error'> = console,
): void {
  pool.on('error', error => {
    logger.error('[colyseus-postgres] idle pool client error', {
      code: (error as Error & { code?: string }).code,
      message: error.message,
    })
  })
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}
