import {
  assertGameProfileCompatibleV1,
  getServerGameProfileIdentityV1,
  type GameProfileIdentityV1,
} from '../content-pipeline/runtime/profile-game-identity'
import { httpEndpoint } from './official-session'

export interface OfficialMatchOptions {
  serverUrl: string
  token: string
  profileIdentity?: GameProfileIdentityV1
  alignment: 'light' | 'dark'
  pieces: Array<string | { templateId: string }>
  roomId?: string
  expectedPlayerId?: string
  expectedPlayerName?: string
  banMapId?: string
  maxRuntimeMs?: number
  pollMs?: number
  fetchFn?: typeof fetch
  signal?: AbortSignal
  /** Test clocks must advance along with sleep. */
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export class OfficialLobbyError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(message)
    this.name = 'OfficialLobbyError'
  }
}

type JsonObject = Record<string, unknown>
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value)
  ? value as JsonObject : {}

/** Existing official account -> queue/pregame -> assigned battle. No account creation. */
export async function prepareOfficialMatch(options: OfficialMatchOptions): Promise<{
  roomId: string; playerId: string; playerName: string; elapsedMs: number
}> {
  httpEndpoint(options.serverUrl, '/official/me')
  if (!options.token.trim()) throw new OfficialLobbyError('TOKEN_REQUIRED', 'An official session is required')
  const ids = options.pieces.map(piece => typeof piece === 'string' ? piece : piece.templateId)
  if (ids.length !== 8 || new Set(ids).size !== 8 || ids.some(id => typeof id !== 'string' || !id)) {
    throw new OfficialLobbyError('ROSTER_INVALID', 'Eight different piece template IDs are required')
  }
  if (options.alignment !== 'light' && options.alignment !== 'dark') {
    throw new OfficialLobbyError('ALIGNMENT_INVALID', 'Alignment must be light or dark')
  }
  const limit = options.maxRuntimeMs ?? 600_000
  const pollMs = options.pollMs ?? 1_000
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 5_000) {
    throw new OfficialLobbyError('BOUNDS_INVALID', 'Positive runtime and a poll interval of 1–5000ms are required')
  }
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? abortableSleep
  const start = now()
  let queuedHere = false
  let matchId: string | undefined
  let conflicts = 0
  const check = () => {
    if (options.signal?.aborted) throw new OfficialLobbyError('STOPPED', 'Official preparation was stopped')
    if (now() - start >= limit) throw new OfficialLobbyError('RUNTIME_LIMIT', 'Official preparation reached its runtime limit')
  }
  const request = async (path: string, body?: JsonObject, cleanup = false): Promise<JsonObject> => {
    if (!cleanup) check()
    const timeout = cleanup ? 2_000 : Math.max(1, Math.min(10_000, limit - (now() - start)))
    const signal = cleanup ? AbortSignal.timeout(timeout)
      : AbortSignal.any([AbortSignal.timeout(timeout), ...(options.signal ? [options.signal] : [])])
    try {
      const response = await (options.fetchFn ?? fetch)(httpEndpoint(options.serverUrl, path), {
        method: body === undefined ? 'GET' : 'POST',
        headers: { accept: 'application/json', authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', signal,
      })
      if (!response.ok) throw new OfficialLobbyError('HTTP_REJECTED', `Official request failed with HTTP ${response.status}`, response.status)
      const value: unknown = await response.json()
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OfficialLobbyError('RESPONSE_INVALID', 'Official response must be an object')
      return value as JsonObject
    } catch (error) {
      if (error instanceof OfficialLobbyError) throw error
      throw new OfficialLobbyError('REQUEST_FAILED', 'Official request failed or timed out')
    }
  }
  try {
    const identity = options.profileIdentity ?? getServerGameProfileIdentityV1()
    const remote = await request('/catalog/identity')
    assertGameProfileCompatibleV1(remote.profileIdentity, identity)
    let me = await request('/official/me')
    const account = object(me.account)
    if (typeof account.id !== 'string' || !account.id || typeof account.name !== 'string' || !account.name) {
      throw new OfficialLobbyError('ACCOUNT_INVALID', 'Official account identity is missing')
    }
    const playerId = account.id
    const playerName = account.name
    if (options.expectedPlayerId && options.expectedPlayerId !== playerId) {
      throw new OfficialLobbyError('ACCOUNT_MISMATCH', 'Configured identity does not match the authenticated account')
    }
    if (options.expectedPlayerName && options.expectedPlayerName !== playerName) {
      throw new OfficialLobbyError('ACCOUNT_NAME_MISMATCH', 'Configured name does not match the authenticated account')
    }
    if (options.roomId && me.matchId !== options.roomId) {
      throw new OfficialLobbyError('MATCH_MISMATCH', 'The configured room is not this account’s active match')
    }
    if (!me.matchId && !me.queued) {
      // A lost HTTP response does not prove enqueueing failed. Cleanup uses
      // the account's idempotent queue cancellation, never match withdrawal.
      queuedHere = true
      await request('/official/queue/join', { profileIdentity: identity })
    }
    while (!me.matchId) {
      check()
      await sleep(Math.min(pollMs, Math.max(1, limit - (now() - start))), options.signal)
      me = await request('/official/me')
      if (object(me.account).id !== playerId) throw new OfficialLobbyError('ACCOUNT_CHANGED', 'Official account changed during preparation')
      if (!me.matchId && me.queued !== true) throw new OfficialLobbyError('QUEUE_ENDED', 'Official matchmaking is no longer queued')
    }
    if (typeof me.matchId !== 'string' || !me.matchId) throw new OfficialLobbyError('MATCH_INVALID', 'Official match ID is missing')
    matchId = me.matchId
    const path = `/official/pregame/${encodeURIComponent(matchId)}`
    while (true) {
      check()
      const pregame = await request(path)
      const players = Array.isArray(pregame.players) ? pregame.players : []
      const own = players.map(object).find(player => player.id === playerId)
      if (!own) throw new OfficialLobbyError('SEAT_MISSING', 'The official match does not contain this player')
      if (pregame.phase === 'battle') return { roomId: matchId, playerId, playerName, elapsedMs: now() - start }
      let action: JsonObject | undefined
      if (pregame.phase === 'veto' && own.banSubmitted !== true) {
        const maps = Array.isArray(pregame.maps) ? pregame.maps.map(object) : []
        const mapId = options.banMapId ?? maps.find(map => typeof map.id === 'string')?.id
        if (typeof mapId !== 'string' || !maps.some(map => map.id === mapId)) {
          throw new OfficialLobbyError('BAN_MAP_INVALID', 'The selected veto map is not in this match’s public pool')
        }
        action = { action: 'ban', mapId }
      } else if (pregame.phase === 'roster' && own.locked !== true) {
        if (!Number.isSafeInteger(own.revision) || Number(own.revision) < 0) throw new OfficialLobbyError('REVISION_INVALID', 'Player roster revision is missing')
        // publicPregame.version is the schema version, not the roster revision.
        action = { action: 'lock', alignment: options.alignment, pieces: ids, revision: own.revision }
      } else if (!['veto', 'roster', 'starting'].includes(String(pregame.phase))) {
        throw new OfficialLobbyError('PHASE_INVALID', 'Unknown official preparation phase')
      }
      if (action) {
        try { await request(path, action) } catch (error) {
          if (!(error instanceof OfficialLobbyError) || error.status !== 409 || ++conflicts > 3) throw error
          // A concurrent lock/phase transition requires a fresh descriptor.
        }
      }
      await sleep(Math.min(pollMs, Math.max(1, limit - (now() - start))), options.signal)
    }
  } catch (error) {
    if (queuedHere && !matchId) {
      try { await request('/official/queue/cancel', {}, true) } catch {
        throw new OfficialLobbyError('QUEUE_CLEANUP_FAILED', 'Preparation failed and queue cancellation could not be confirmed')
      }
    }
    throw error
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = () => { clearTimeout(timer); signal?.removeEventListener('abort', fail); reject(new OfficialLobbyError('STOPPED', 'Official preparation was stopped')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', fail); resolve() }, ms)
    if (signal?.aborted) fail()
    else signal?.addEventListener('abort', fail, { once: true })
  })
}
