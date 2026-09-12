import { defineRoom, defineServer, matchMaker } from 'colyseus'
import { randomUUID } from 'node:crypto'
import { WebSocketTransport } from '@colyseus/ws-transport'
import { Pool } from 'pg'
import type { Express } from 'express'
import type { RankedRoomHooks } from '../official/ranked'

import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { getSelectableMapCatalog } from '@/lib/game/map-selection'
import { getAvailablePieces } from '@/lib/game/piece-repository'
import { loadCardById } from '@/lib/game/skills'
import { getAllSkills } from '@/lib/game/skill-repository'
import { installNativeBattleSha256 } from '@/lib/server/battle-hash'
import type { PostgresAuthorityBatchWriter } from '@/lib/server/postgres/authority-types'
import type { PostgresBattleReportReader } from '@/lib/server/postgres/authority-types'
import {
  PostgresAuthorityJournal,
  type PostgresAuthorityJournalOptions,
} from '@/lib/server/postgres/postgres-authority-journal'
import { PostgresAuthorityRepository } from '@/lib/server/postgres/postgres-authority-repository'

import { createBattleRoomClass } from './battle-room'
import { createAdventureRoomClass } from './adventure-room'
import type { AdventureRepository } from './adventure-store'
import { createAdmissionAuthority } from './admission'
import { BATTLE_ROOM_TYPE } from './battle-room-protocol'
import {
  type BattleRoomFixtureFactory,
  type CandidateAuthorityRepository,
} from './candidate-battle-store'
import { createDevelopmentBattleRoom } from './development-battle-fixture'

export interface BattleServerRepository
  extends CandidateAuthorityRepository, PostgresAuthorityBatchWriter, Partial<PostgresBattleReportReader> {
  initializeSchema(): Promise<void>
  healthCheck(): Promise<void>
  listRestorableRoomIds?(): Promise<string[]>
  close?(): Promise<void>
}

export interface CreateColyseusBattleServerOptions {
  adventureRepository?: AdventureRepository
  official?: RankedRoomHooks
  configureExpress?: (app: Express) => void
  requireIdentityProof?: boolean
  reconnectGraceMs?: number
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
  logger?: Pick<Console, 'error'>
}

interface HealthResponse {
  status(code: number): HealthResponse
  json(body: unknown): void
}

interface JsonRequest {
  headers?: Record<string, string | string[] | undefined>
  params?: Record<string, string | undefined>
  query?: Record<string, unknown>
}

interface ExpressLikeApp {
  use(handler: (
    request: { method?: string },
    response: { setHeader(name: string, value: string): void; sendStatus(code: number): void },
    next: () => void,
  ) => void): void
  get(path: string, handler: (request: JsonRequest, response: HealthResponse) => void | Promise<void>): void
}

interface ProductCreationClaim {
  roomId: string
  expiresAt: number
}

interface ProductRoomMetadata {
  product?: boolean
  room?: unknown
  visibility?: string
}

export const POSTGRES_CONNECTION_TIMEOUT_MS = 30_000
const POSTGRES_STARTUP_MAX_ATTEMPTS = 5
const POSTGRES_STARTUP_MAX_RETRY_DELAY_MS = 5_000

interface PostgresStartupOptions {
  logger?: Pick<Console, 'error'>
  sleep?: (delayMs: number) => Promise<void>
}

function isTransientPostgresStartupError(error: unknown): boolean {
  const details = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown }
    : {}
  const code = typeof details.code === 'string' ? details.code : ''
  if (code.startsWith('08') || ['53300', '53400', '57P03', '58000', '58030'].includes(code)) return true
  const message = typeof details.message === 'string' ? details.message : String(error)
  return /connection (?:terminated|timeout|refused|reset)|timed? ?out|ECONN(?:REFUSED|RESET)|database system is starting up|too many (?:clients|connections)/i.test(message)
}

export async function preparePostgresAuthority(
  repository: Pick<BattleServerRepository, 'initializeSchema' | 'healthCheck'>,
  options: PostgresStartupOptions = {},
): Promise<void> {
  const logger = options.logger ?? console
  const sleep = options.sleep ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)))
  for (let attempt = 1; attempt <= POSTGRES_STARTUP_MAX_ATTEMPTS; attempt += 1) {
    try {
      await repository.initializeSchema()
      await repository.healthCheck()
      return
    } catch (error) {
      if (!isTransientPostgresStartupError(error) || attempt === POSTGRES_STARTUP_MAX_ATTEMPTS) throw error
      const details = error && typeof error === 'object'
        ? error as { code?: unknown; message?: unknown }
        : {}
      const retryInMs = Math.min(500 * (2 ** (attempt - 1)), POSTGRES_STARTUP_MAX_RETRY_DELAY_MS)
      logger.error('[colyseus-postgres] startup connection unavailable; retrying', {
        attempt,
        maxAttempts: POSTGRES_STARTUP_MAX_ATTEMPTS,
        retryInMs,
        code: typeof details.code === 'string' ? details.code : undefined,
        message: typeof details.message === 'string' ? details.message : String(error),
      })
      await sleep(retryInMs)
    }
  }
}

export function createColyseusBattleServer(options: CreateColyseusBattleServerOptions = {}) {
  // This runtime is the only Windows player-authority boundary.
  process.env.RVB_TURN_TIMER_ENABLED ??= '1'
  installNativeBattleSha256()
  const ownsRepository = !options.repository
  const repository = options.repository ?? createRepository(options)
  const journal = options.journal ?? new PostgresAuthorityJournal(repository, options.journalOptions)
  const healthIdentity = options.healthIdentity ?? {
    runtime: 'colyseus-postgresql',
    database: 'postgresql',
  }
  const productCreationClaims = new Map<string, ProductCreationClaim>()
  const logger = options.logger ?? console
  const admission = createAdmissionAuthority()
  const adventureStore=options.adventureRepository ?? (repository instanceof PostgresAuthorityRepository ? repository.adventureRepository() : undefined)
  const AdventureRoom=createAdventureRoomClass({store:adventureStore,reconnectGraceMs:options.reconnectGraceMs,
    authenticate:(options.requireIdentityProof??!options.repository)?admission.authenticate:undefined})
  const restoreCapability = randomUUID()
  const roomInvites = new Map<string, string>()
  const BattleRoom = createBattleRoomClass({
    official: options.official,
    updateInvite: (roomId, code) => {
      for (const [existing, id] of roomInvites) if (id === roomId && existing !== code) roomInvites.delete(existing)
      if (code) roomInvites.set(code, roomId)
    },
    restoreCapability,
    reconnectGraceMs: options.reconnectGraceMs,
    authenticate: (options.requireIdentityProof ?? !options.repository) ? admission.authenticate : undefined,
    repository,
    journal,
    fixtureFactory: options.fixtureFactory ?? createDevelopmentBattleRoom,
    claimProductCreation: (creationKey, roomId) => {
      const now = Date.now()
      for (const [key, claim] of productCreationClaims) {
        if (claim.expiresAt <= now) productCreationClaims.delete(key)
      }
      const existing = productCreationClaims.get(creationKey)
      if (existing) return existing.roomId
      productCreationClaims.set(creationKey, { roomId, expiresAt: now + 60_000 })
      return undefined
    },
    releaseProductCreation: (creationKey, roomId) => {
      if (productCreationClaims.get(creationKey)?.roomId === roomId) productCreationClaims.delete(creationKey)
    },
  })
  let ready = false
  let healthError: string | undefined
  const server = defineServer({
    // The official launcher must finish its embedded PostgreSQL shutdown before
    // exiting; Colyseus' automatic process.exit would race that owner.
    gracefullyShutdown: options.official ? false : undefined,
    // Keep the transport as a static dependency so the packaged authority does
    // not rely on Colyseus' runtime dynamic import from node_modules.
    transport: new WebSocketTransport(),
    rooms: {
      [BATTLE_ROOM_TYPE]: defineRoom(BattleRoom),
      adventure: defineRoom(AdventureRoom),
    },
    greet: false,
    beforeListen: async () => {
      try {
        await preparePostgresAuthority(repository, { logger })
        await adventureStore?.initialize()
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
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-RvB-Auth,Authorization')
        response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        if (_request.method === 'OPTIONS') {
          response.sendStatus(204)
          return
        }
        next()
      })
      options.configureExpress?.(rawApp as unknown as Express)
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
      app.get('/admission/challenge', (_request, response) => {
        try { response.status(200).json(admission.challenge()) }
        catch { response.status(429).json({ error: 'ADMISSION_BUSY' }) }
      })
      app.get('/catalog/identity', (_request, response) => response.status(200).json({
        profileIdentity: getServerGameProfileIdentityV1(),
      }))
      app.get('/catalog/maps', (request, response) => response.status(200).json({
        maps: getSelectableMapCatalog(request.query?.mode === '2v2' ? '2v2' : '1v1'),
      }))
      app.get('/catalog/pieces', (_request, response) => response.status(200).json({ pieces: getAvailablePieces('pvp') }))
      app.get('/catalog/skills', (_request, response) => response.status(200).json({ skills: getAllSkills() }))
      app.get('/rooms', async (request, response) => {
        if(request.query?.mode==='pve'){
          const listings=await matchMaker.query({name:'adventure'})
          const rooms=listings.filter(r=>r.metadata?.product&&r.metadata?.mode==='pve'&&r.metadata?.room?.online>0)
            .map(r=>r.metadata.room)
          response.status(200).json({rooms});return
        }
        const listings = await matchMaker.query({ name: BATTLE_ROOM_TYPE })
        const rooms = collectProductRooms(listings, false)
        response.status(200).json({ rooms })
      })
      app.get('/rooms/:roomId', async (request, response) => {
        const roomId = String(request.params?.roomId ?? '').trim().toLowerCase()
        const listings = await matchMaker.query({ name: BATTLE_ROOM_TYPE })
        const room = collectProductRooms(listings, true).find(candidate => candidate.id.toLowerCase() === roomId)
        response.status(room ? 200 : 404).json(room
          ? { room }
          : { code: 'ROOM_NOT_FOUND', error: 'Room not found' })
      })
      app.get('/room-invites/:code', async (request, response) => {
        const code = String(request.params?.code ?? '').trim().toUpperCase()
        const roomId = /^[A-F0-9]{12}$/.test(code) ? roomInvites.get(code) : undefined
        const listings = roomId ? await matchMaker.query({ name: BATTLE_ROOM_TYPE }) : []
        const room = collectProductRooms(listings, true).find(candidate => candidate.id === roomId)
        response.status(room ? 200 : 404).json(room ? { room } : { code: 'ROOM_NOT_FOUND', error: '邀请码无效或房间已关闭' })
      })
      app.get('/battle-reports/:battleId', async (request, response) => {
        const battleId = String(request.params?.battleId ?? '').trim().toLowerCase()
        let playerId: string
        let verifiedKey: string
        try {
          const proof = JSON.parse(String(request.headers?.['x-rvb-auth'] ?? ''))
          playerId = String(proof?.payload?.playerId ?? '')
          verifiedKey = admission.authenticate(playerId, 'report:' + battleId, proof)
        } catch {
          response.status(401).json({ code: 'PLAYER_AUTH_INVALID', error: '请使用参赛玩家身份读取战报' })
          return
        }
        if (!repository.readBattleReport) {
          response.status(501).json({ code: 'BATTLE_REPORT_UNAVAILABLE', error: 'Battle report store is unavailable' })
          return
        }
        try {
          const restored = await repository.restoreRoom(battleId)
          const participant = restored?.room.players.find(player => player.id === playerId)
          if (!participant?.publicKey || participant.publicKey !== verifiedKey) {
            response.status(403).json({ code: 'BATTLE_REPORT_FORBIDDEN', error: '完整战报仅向参赛玩家开放' })
            return
          }
          const report = await repository.readBattleReport(battleId)
          response.status(report ? 200 : 404).json(report
            ? { report }
            : { code: 'BATTLE_REPORT_NOT_FOUND', error: 'Battle report not found' })
        } catch (error) {
          const code = typeof error === 'object' && error && 'code' in error
            ? String(error.code)
            : 'BATTLE_REPORT_INTEGRITY_FAILED'
          response.status(code === 'BATTLE_REPORT_NOT_DURABLE' ? 409 : 500).json({
            code,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })
      app.get('/battle-reports', async (request, response) => {
        const playerId = String(request.query?.playerId ?? '').trim()
        if (!playerId) {
          response.status(400).json({ code: 'PLAYER_ID_REQUIRED', error: 'playerId is required' })
          return
        }
        if (!repository.listBattleReports) {
          response.status(501).json({ code: 'BATTLE_REPORT_UNAVAILABLE', error: 'Battle report store is unavailable' })
          return
        }
        try {
          response.status(200).json({ reports: await repository.listBattleReports(playerId) })
        } catch (error) {
          response.status(500).json({
            code: 'BATTLE_REPORT_INTEGRITY_FAILED',
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })
      app.get('/catalog/cards/:cardId', (request, response) => {
        const card = loadCardById(String(request.params?.cardId ?? ''))
        response.status(card ? 200 : 404).json(card ?? { error: 'Card not found', code: 'CARD_NOT_FOUND' })
      })
    },
  })
  if (!options.official) server.onBeforeShutdown(() => journal.close())
  if (ownsRepository) server.onShutdown(() => repository.close?.())
  let roomsRestored = false
  const restoreProductRooms = async (): Promise<string[]> => {
    if (roomsRestored) return []
    roomsRestored = true
    const roomIds = await repository.listRestorableRoomIds?.() ?? []
    const restoredRoomIds: string[] = []
    for (const battleId of roomIds) {
      if (options.official?.canRestore && !await options.official.canRestore(battleId)) continue
      try {
          await matchMaker.createRoom(BATTLE_ROOM_TYPE, { product: true, restore: true, battleId, restoreCapability })
        restoredRoomIds.push(battleId)
      } catch (error) {
        logger.error('[colyseus] durable room restore skipped', {
          battleId,
          code: (error as Error & { code?: string }).code,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return restoredRoomIds
  }
  const restoreProductRoom = async (battleId: string) => {
    if (options.official?.canRestore && !await options.official.canRestore(battleId)) throw new Error('Room is no longer active')
    if (matchMaker.getLocalRoomById(battleId)) return
    await matchMaker.createRoom(BATTLE_ROOM_TYPE, { product: true, restore: true, battleId, restoreCapability })
  }
  return { server, repository, journal, restoreProductRooms, restoreProductRoom }
}

function collectProductRooms(
  listings: ReadonlyArray<{ metadata?: unknown }>,
  includeUnlisted: boolean,
): Array<Record<string, unknown> & { id: string }> {
  const byId = new Map<string, Record<string, unknown> & { id: string }>()
  for (const listing of listings) {
    const metadata = listing.metadata as ProductRoomMetadata | undefined
    if (metadata?.product !== true || (!includeUnlisted && metadata.visibility === 'private')) continue
    const room = metadata.room && typeof metadata.room === 'object'
      ? metadata.room as Record<string, unknown>
      : undefined
    const id = typeof room?.id === 'string' ? room.id.trim() : ''
    if (!id) continue
    // Direct lookups retain terminal snapshots for participants already in the room.
    // The public playable catalog must not advertise completed matches.
    if (!includeUnlisted && room?.status === 'finished') continue
    const normalizedId = id.toLowerCase()
    if (byId.has(normalizedId)) {
      console.warn('[colyseus:rooms] duplicate room catalog entry ignored', { roomId: normalizedId })
      continue
    }
    byId.set(normalizedId, { ...room, id })
  }
  return [...byId.values()]
}

function createRepository(options: CreateColyseusBattleServerOptions): PostgresAuthorityRepository {
  const connectionString = options.databaseUrl
    ?? process.env.RVB_POSTGRES_URL
    ?? 'postgresql://rvb:rvb@127.0.0.1:5433/rvb_colyseus'
  const pool = new Pool({
    connectionString,
    max: options.poolMax ?? numberFromEnv(process.env.RVB_POSTGRES_POOL_MAX, 8),
    connectionTimeoutMillis: numberFromEnv(
      process.env.RVB_POSTGRES_CONNECTION_TIMEOUT_MS,
      POSTGRES_CONNECTION_TIMEOUT_MS,
    ),
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
