import type { Pool } from 'pg'

import {
  BATTLE_REPLAY_FORMAT,
  hashStable,
  readSanitizedBattleActionTrace,
  readSanitizedBattleReplay,
  type BattleReplayArchive,
  type BattleReplayFrame,
} from '@/lib/game/battle-trace'
import type { BattleState } from '@/lib/game/turn'
import {
  assertPinnedProfileAvailableV1,
  sameGameProfileIdentityV1,
} from '@/lib/content-pipeline/runtime/profile-game-identity'
import { getAllPieces } from '@/lib/game/piece-repository'

import type {
  PostgresBattleReportReader,
  PostgresBattleReportV1,
} from '../postgres/authority-types'
import { OfficialError } from './accounts'

export const OFFICIAL_MATCH_TRACE_FORMAT = 'rvb-match-trace/v2' as const
export const OFFICIAL_MATCH_TRACE_SCHEMA_VERSION = 2 as const

const LEGACY_MATCH_TRACE_FORMAT = 'rvb-match-trace/v1'
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const MAX_TRACE_BYTES = 32 * 1024 * 1024
const MAX_TRACE_DEPTH = 48
const MAX_TRACE_NODES = 750_000
const MAX_ARRAY_ENTRIES = 100_000
const MAX_STRING_LENGTH = 2 * 1024 * 1024

type JsonObject = Record<string, unknown>
type QueryPool = Pick<Pool, 'query'>

export interface OfficialMatchTrace {
  format: typeof OFFICIAL_MATCH_TRACE_FORMAT
  schemaVersion: typeof OFFICIAL_MATCH_TRACE_SCHEMA_VERSION
  exportedAt: string
  roomId: string | null
  seed: number | null
  authorityVersion: number | null
  source?: JsonObject
  integrity: {
    algorithm: 'sha256-stable-json'
    checkpointHashFields: true
  }
  content: {
    pieces: Array<{
      templateId: string
      name: string
      imageId: string | null
      faction: string | null
      stats: unknown
      skillIds: string[]
    }>
    skills: Array<{
      skillId: string
      name: string
      description: string | null
      type: string | null
      cost?: unknown
      cooldownTurns: number | null
      maxCharges: number | null
      chargeCost: number | null
      actionPointCost: number | null
    }>
  }
  initialStateHash: string
  initialCheckpointHash: string
  initialState: JsonObject
  frames: Array<JsonObject>
  final: JsonObject
  summary: JsonObject
  players: Array<{ playerId: string | null; faction: string | null }>
}

interface OfficialMatchAccessRow {
  status: string
  first_id: string
  second_id: string
}

/**
 * A public error for replay requests. The message intentionally contains no
 * database identifiers or report integrity details; the HTTP adapter can
 * expose its status and message safely.
 */
export class OfficialReplayError extends OfficialError {
  constructor(
    readonly code: 'OFFICIAL_REPLAY_NOT_FOUND'
      | 'OFFICIAL_REPLAY_FORBIDDEN'
      | 'OFFICIAL_REPLAY_NOT_SETTLED'
      | 'OFFICIAL_REPLAY_UNAVAILABLE',
    message: string,
    status: number,
  ) {
    super(message, status)
  }
}

export class OfficialReplayService {
  constructor(
    private readonly pool: QueryPool,
    private readonly reports: PostgresBattleReportReader,
  ) {}

  /**
   * Authenticate the participant and terminal barrier before reading the
   * complete PostgreSQL report. Only the derived Trace v2 is returned.
   */
  async read(viewerId: string, matchId: string): Promise<OfficialMatchTrace> {
    const normalizedViewerId = normalizeIdentifier(viewerId, 'viewerId')
    const normalizedMatchId = normalizeIdentifier(matchId, 'matchId')

    const matchResult = await this.pool.query<OfficialMatchAccessRow>(
      `SELECT status, first_id, second_id
       FROM official_matches
       WHERE id = $1`,
      [normalizedMatchId],
    )
    const match = matchResult.rows[0]
    if (!match) {
      throw new OfficialReplayError('OFFICIAL_REPLAY_NOT_FOUND', '对局不存在', 404)
    }

    if (match.first_id !== normalizedViewerId && match.second_id !== normalizedViewerId) {
      throw new OfficialReplayError('OFFICIAL_REPLAY_FORBIDDEN', '没有该回放的读取权限', 403)
    }
    if (match.status !== 'settled') {
      throw new OfficialReplayError('OFFICIAL_REPLAY_NOT_SETTLED', '对局尚未结算，回放暂不可用', 409)
    }

    // This is deliberately a cheap existence check. readBattleReport performs
    // the full transition, receipt, and terminal checkpoint verification only
    // after the participant and settled-state checks above have succeeded.
    const barrierResult = await this.pool.query<{ authority_version: string | number }>(
      `SELECT authority_version
       FROM battle_terminal_barrier
       WHERE battle_id = $1`,
      [normalizedMatchId],
    )
    const barrierVersion = barrierResult.rows[0] && Number(barrierResult.rows[0].authority_version)
    if (!Number.isSafeInteger(barrierVersion) || Number(barrierVersion) < 0) {
      throw new OfficialReplayError('OFFICIAL_REPLAY_UNAVAILABLE', '该对局没有可用的终局回放', 404)
    }

    let report: PostgresBattleReportV1 | undefined
    try {
      report = await this.reports.readBattleReport(normalizedMatchId)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : ''
      if (code === 'BATTLE_REPORT_NOT_DURABLE' || code === 'BATTLE_REPORT_INTEGRITY_FAILED') {
        throw new OfficialReplayError('OFFICIAL_REPLAY_UNAVAILABLE', '该对局没有可用的终局回放', 404)
      }
      throw error
    }

    if (!report) {
      throw new OfficialReplayError('OFFICIAL_REPLAY_UNAVAILABLE', '该对局没有可用的终局回放', 404)
    }

    try {
      return exportVerifiedReport(report, normalizedMatchId, match, Number(barrierVersion))
    } catch (error) {
      if (error instanceof OfficialReplayError) throw error
      // Do not expose malformed legacy archives or raw PostgreSQL checkpoint
      // details through the public endpoint.
      throw new OfficialReplayError('OFFICIAL_REPLAY_UNAVAILABLE', '该对局没有可用的终局回放', 404)
    }
  }
}

/** Compatibility entry point for the HTTP adapter and small callers. */
export async function exportOfficialReplay(
  viewerId: string,
  matchId: string,
  pool: QueryPool,
  reports: PostgresBattleReportReader,
): Promise<OfficialMatchTrace> {
  return new OfficialReplayService(pool, reports).read(viewerId, matchId)
}

function exportVerifiedReport(
  report: PostgresBattleReportV1,
  expectedMatchId: string,
  access: OfficialMatchAccessRow,
  barrierVersion: number,
): OfficialMatchTrace {
  if (report.verified !== true || report.schemaVersion !== 'rvb-postgres-battle-report/v1') {
    throw new OfficialReplayError('OFFICIAL_REPLAY_UNAVAILABLE', '该对局没有可用的终局回放', 404)
  }
  if (
    normalizeIdentifier(report.battleId, 'report.battleId') !== expectedMatchId
    || normalizeIdentifier(report.room.id, 'report.room.id') !== expectedMatchId
    || !Number.isSafeInteger(report.authority.authorityVersion)
    || report.authority.authorityVersion < 0
    || report.authority.authorityVersion !== barrierVersion
  ) {
    throw new Error('Official report identity or authority version is invalid')
  }

  const checkpoint = report.terminal?.checkpoint
  if (!checkpoint || checkpoint.reason !== 'terminal' || checkpoint.roomId !== expectedMatchId) {
    throw new Error('Official terminal barrier is missing')
  }
  if (
    checkpoint.authorityVersion !== report.authority.authorityVersion
    || checkpoint.stateHash !== report.authority.stateHash
    || checkpoint.publicHash !== report.authority.publicHash
    || checkpoint.transitionHash !== report.authority.transitionHash
    || !isSafeHash(checkpoint.stateHash)
    || !isSafeHash(checkpoint.publicHash)
    || !isSafeHash(checkpoint.transitionHash)
  ) {
    throw new Error('Official terminal barrier does not match the report')
  }

  const storage = checkpoint.storage
  const state = storage && typeof storage === 'object' && !Array.isArray(storage)
    ? (storage as { state?: unknown }).state
    : undefined
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('Official terminal checkpoint state is missing')
  }
  // Read the archive through the shared battle-trace boundary before removing
  // debug metadata. That boundary verifies the profile pin carried by the
  // terminal state; sanitizing first would erase the replay envelope and make
  // a valid archive look legacy or incomplete.
  const rawBattleState = state as BattleState
  if (rawBattleState.terminalResult?.status !== 'finished') {
    throw new Error('Official terminal result is missing')
  }
  const replay = readSanitizedBattleReplay(rawBattleState)
  if (!replay || replay.format !== BATTLE_REPLAY_FORMAT) {
    throw new Error('Official Trace v2 archive is missing')
  }
  // The terminal report is trusted only after its storage and replay pins are
  // both verified against the active resource profile.  The piece catalog is
  // read only after this fence, so an image filename cannot be guessed from a
  // template ID or taken from an unrelated profile.
  const storageProfileIdentity = assertPinnedProfileAvailableV1(storage.profileIdentity)
  const replayProfileIdentity = assertPinnedProfileAvailableV1(replay.profileIdentity)
  if (!sameGameProfileIdentityV1(storageProfileIdentity, replayProfileIdentity)) {
    throw new Error('Official replay and checkpoint profiles do not match')
  }
  const actionTrace = readSanitizedBattleActionTrace(rawBattleState)
  const exportReplay = materializeVerifiedReplayArchive(replay, report)
  const pieceImages = verifiedPieceImageMap()

  const stateRecord = sanitizeJsonValue(state)
  if (!stateRecord || typeof stateRecord !== 'object' || Array.isArray(stateRecord)) {
    throw new Error('Official terminal checkpoint state is not serializable')
  }
  const battleState = stateRecord as unknown as BattleState
  const finalFrame = exportReplay.frames.at(-1)
  const lastTrace = actionTrace.at(-1)
  const seed = safeUint32(replay.rootSeed) ?? safeUint32(storage.rootSeed) ?? inferSeed(actionTrace)
  const terminal = sanitizeJsonValue(battleState.terminalResult) as JsonObject
  const statePlayers = Array.isArray(battleState.players) ? battleState.players : []
  const players = statePlayers.map(player => ({
    playerId: stringOrNull(player?.playerId),
    faction: stringOrNull((player as { faction?: unknown })?.faction),
  }))
  const source = buildSafeSource(report, battleState, expectedMatchId, access)
  const exportedAt = normalizeTimestamp(report.terminal.committedAt)
  const record = {
    format: OFFICIAL_MATCH_TRACE_FORMAT,
    schemaVersion: OFFICIAL_MATCH_TRACE_SCHEMA_VERSION,
    exportedAt,
    roomId: expectedMatchId,
    seed,
    authorityVersion: safeInteger(report.authority.authorityVersion),
    source,
    integrity: {
      algorithm: 'sha256-stable-json' as const,
      checkpointHashFields: true as const,
    },
    content: createContentSnapshot(battleState, exportReplay, pieceImages),
    initialStateHash: exportReplay.initialStateHash,
    initialCheckpointHash: exportReplay.initialCheckpointHash || hashStable(exportReplay.initialState),
    initialState: exportReplay.initialState as unknown as JsonObject,
    frames: exportReplay.frames as unknown as JsonObject[],
    final: {
      stateVersion: safeInteger(battleState._v),
      stateHash: stringOrNull(finalFrame?.postStateHash)
        || stringOrNull(lastTrace?.postStateHash)
        || stringOrNull(report.authority.stateHash)
        || stringOrNull(exportReplay.initialStateHash),
      checkpointHash: finalFrame
        ? (finalFrame.postCheckpointHash || hashStable(materializeReplayState(exportReplay, exportReplay.frames.length)))
        : (exportReplay.initialCheckpointHash || hashStable(exportReplay.initialState)),
      mapId: stringOrNull(battleState.map?.id),
      turnNumber: safeInteger(battleState.turn?.turnNumber),
      phase: stringOrNull(battleState.turn?.phase),
      winnerPlayerId: stringOrNull(terminal.winnerPlayerId),
      loserPlayerId: stringOrNull(terminal.loserPlayerId),
      reason: stringOrNull(terminal.reason),
      settledAt: terminal.settledAt ?? null,
    },
    summary: {
      commandCount: exportReplay.frames.length,
      eventCount: exportReplay.frames.reduce((total, frame) => total + (Array.isArray(frame.events) ? frame.events.length : 0), 0),
      playerCount: statePlayers.length,
      livingPieceCount: Array.isArray(battleState.pieces) ? battleState.pieces.length : 0,
      graveyardCount: Array.isArray(battleState.graveyard) ? battleState.graveyard.length : 0,
    },
    players,
  } satisfies OfficialMatchTrace

  return assertOfficialReplayTrace(record)
}

/**
 * Terminal journal mode compacts the checkpoint's replay.frames array after
 * durability. The report reader has already verified each transition hash;
 * use only its replayFrames evidence to restore the public archive, never the
 * private receipt or transition objects themselves.
 */
function materializeVerifiedReplayArchive(
  replay: BattleReplayArchive,
  report: PostgresBattleReportV1,
): BattleReplayArchive {
  if (replay.frames.length > 0) return replay
  const frames: BattleReplayFrame[] = []
  for (const transition of report.transitions) {
    for (const frame of transition.replayFrames ?? []) {
      const sanitized = sanitizeJsonValue(frame)
      if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
        throw new Error('Verified replay frame is not serializable')
      }
      frames.push(sanitized as unknown as BattleReplayFrame)
    }
  }
  if (!frames.length) return replay
  if (frames.some((frame, index) => frame.index !== index)) {
    throw new Error('Verified replay frame indexes are not contiguous')
  }
  return { ...replay, frames }
}

function buildSafeSource(
  report: PostgresBattleReportV1,
  state: BattleState,
  matchId: string,
  access: OfficialMatchAccessRow,
): JsonObject {
  const players = (Array.isArray(report.room.players) ? report.room.players : []).map(player => {
    const battlePlayer = state.players?.find(candidate => candidate.playerId === player.id || candidate.playerId === player.accountId)
    return {
      playerId: stringOrNull(battlePlayer?.playerId || player.id),
      name: safeDisplayText(player.name || battlePlayer?.name),
      seat: safeDisplayText(player.seat),
      alignment: safeDisplayText(player.alignment),
    }
  })
  const mapId = stringOrNull(state.map?.id) || stringOrNull(report.room.mapId)
  const mapName = safeDisplayText(state.map?.name)
  return {
    kind: 'official-match',
    matchId,
    status: access.status,
    map: mapId || mapName ? { id: mapId, name: mapName } : null,
    players,
  }
}

function createContentSnapshot(
  state: BattleState,
  replay: BattleReplayArchive,
  pieceImages: ReadonlyMap<string, string>,
): OfficialMatchTrace['content'] {
  const pieceMap = new Map<string, OfficialMatchTrace['content']['pieces'][number]>()
  const skillMap = new Map<string, OfficialMatchTrace['content']['skills'][number]>()
  const states = materializeReplayStates(replay)
  states.push(state)

  const addSkill = (skillId: string | null, skill: unknown) => {
    if (!skillId || skillMap.has(skillId)) return
    const value = skill && typeof skill === 'object' && !Array.isArray(skill) ? skill as JsonObject : {}
    const entry: OfficialMatchTrace['content']['skills'][number] = {
      skillId,
      name: stringOrNull(value.name) || skillId,
      description: stringOrNull(value.description),
      type: stringOrNull(value.type),
      cost: sanitizeJsonValue(value.cost ?? null),
      cooldownTurns: safeInteger(value.cooldownTurns),
      maxCharges: safeInteger(value.maxCharges),
      chargeCost: safeInteger(value.chargeCost),
      actionPointCost: safeInteger(value.actionPointCost),
    }
    skillMap.set(skillId, entry)
  }

  for (const skill of replay.content?.skills ?? []) addSkill(stringOrNull(skill?.skillId), skill)
  for (const snapshot of states) {
    const skills = snapshot.skillsById
    if (skills && typeof skills === 'object' && !Array.isArray(skills)) {
      for (const [skillId, skill] of Object.entries(skills)) addSkill(skillId, skill)
    }
    for (const piece of [...(snapshot.pieces ?? []), ...(snapshot.graveyard ?? []), ...Object.values(snapshot.deployment?.reserves ?? {}).flat()]) {
      const pieceValue = piece as unknown as JsonObject
      const templateId = stringOrNull(pieceValue.templateId) || stringOrNull(pieceValue.instanceId)
      if (!templateId || pieceMap.has(templateId)) continue
      pieceMap.set(templateId, {
        templateId,
        name: stringOrNull(pieceValue.name) || templateId,
        imageId: pieceImages.get(templateId) ?? null,
        faction: stringOrNull(pieceValue.faction),
        stats: sanitizeJsonValue(pieceValue.stats ?? {
          maxHp: pieceValue.maxHp,
          attack: pieceValue.attack,
          defense: pieceValue.defense,
          moveRange: pieceValue.moveRange,
        }),
        skillIds: (Array.isArray(pieceValue.skills) ? pieceValue.skills : [])
          .map(skill => typeof skill === 'string' ? skill : String(skill && typeof skill === 'object' && ((skill as JsonObject).skillId || (skill as JsonObject).id) || ''))
          .filter(Boolean),
      })
    }
  }

  return {
    pieces: [...pieceMap.values()].sort((left, right) => left.templateId.localeCompare(right.templateId)),
    skills: [...skillMap.values()].sort((left, right) => left.skillId.localeCompare(right.skillId)),
  }
}

function verifiedPieceImageMap(): ReadonlyMap<string, string> {
  const images = new Map<string, string>()
  for (const piece of getAllPieces()) {
    const image = safeAssetId(piece.image)
    if (image) images.set(piece.id, image)
  }
  return images
}

function materializeReplayStates(replay: BattleReplayArchive): BattleState[] {
  const states = [replay.initialState]
  let previous = replay.initialState
  for (const [index, frame] of replay.frames.entries()) {
    if (!frame.postState || typeof frame.postState !== 'object' || Array.isArray(frame.postState)) {
      throw new Error(`Trace frame postState is missing at ${index}`)
    }
    const next = frame.inheritsMap === true
      ? { ...frame.postState, map: previous.map }
      : frame.postState
    states.push(next as BattleState)
    previous = next as BattleState
  }
  return states
}

function materializeReplayState(replay: BattleReplayArchive, index: number): BattleState {
  const states = materializeReplayStates(replay)
  if (!Number.isSafeInteger(index) || index < 0 || index >= states.length) throw new Error('Trace state index is out of range')
  return states[index]!
}

export function assertOfficialReplayTrace(value: unknown): OfficialMatchTrace {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Trace must be a JSON object')
  const record = value as JsonObject
  if (record.format === LEGACY_MATCH_TRACE_FORMAT) throw new Error('Trace v1 is not replayable')
  if (record.format !== OFFICIAL_MATCH_TRACE_FORMAT || record.schemaVersion !== OFFICIAL_MATCH_TRACE_SCHEMA_VERSION) {
    throw new Error('Unsupported match trace version')
  }
  inspectUntrustedValue(record)
  if (record.source !== undefined) requireObject(record.source, 'source')
  requireObject(record.initialState, 'initialState')
  requireBattleCheckpoint(record.initialState, 'initialState')
  requireObject(record.content, 'content')
  validateContentSnapshot(record.content as JsonObject)
  requireObject(record.final, 'final')
  if (!Array.isArray(record.frames) || record.frames.length > 10_000) throw new Error('Trace frames are invalid')

  const initialCheckpointHash = requireHash(
    record.initialCheckpointHash || record.initialStateHash,
    'initialCheckpointHash',
  )
  const actualInitialHash = hashStable(record.initialState)
  if (actualInitialHash !== initialCheckpointHash) throw new Error('Initial checkpoint hash mismatch')

  let previousState = record.initialState
  let previousAuthorityHash = requireHash(record.initialStateHash, 'initialStateHash')
  let previousCheckpointHash = initialCheckpointHash
  record.frames.forEach((frameValue, index) => {
    requireObject(frameValue, `frames[${index}]`)
    const frame = frameValue as JsonObject
    if (frame.index !== index || !Number.isSafeInteger(frame.traceIndex) || Number(frame.traceIndex) < 0) {
      throw new Error(`Trace frame index is invalid at ${index}`)
    }
    requireObject(frame.action, `frames[${index}].action`)
    if (typeof frame.actionType !== 'string' || !frame.actionType) throw new Error(`Trace frame actionType is missing at ${index}`)
    requireObject(frame.postState, `frames[${index}].postState`)
    if (frame.inheritsMap !== undefined && frame.inheritsMap !== true) throw new Error(`Trace frame inheritsMap is invalid at ${index}`)
    if (frame.inheritsMap === true && Object.hasOwn(frame.postState as object, 'map')) throw new Error(`Trace frame cannot contain a map at ${index}`)
    const materializedState = frame.inheritsMap === true
      ? { ...(frame.postState as JsonObject), map: (previousState as JsonObject).map }
      : frame.postState
    requireBattleCheckpoint(materializedState, `frames[${index}].postState`)
    if (!Array.isArray(frame.events)) throw new Error(`Trace frame events are invalid at ${index}`)
    frame.events.forEach((event, eventIndex) => {
      requireObject(event, `frames[${index}].events[${eventIndex}]`)
      if (typeof (event as JsonObject).type !== 'string' || !(event as JsonObject).type) throw new Error(`Trace event type is missing at ${index}`)
    })
    if (!Array.isArray(frame.randomStreams)) throw new Error(`Trace frame randomStreams are invalid at ${index}`)
    frame.randomStreams.forEach((stream, streamIndex) => {
      requireObject(stream, `frames[${index}].randomStreams[${streamIndex}]`)
      const candidate = stream as JsonObject
      if (
        typeof candidate.name !== 'string'
        || !candidate.name
        || !Number.isSafeInteger(candidate.startCursor)
        || Number(candidate.startCursor) < 0
        || !Number.isSafeInteger(candidate.endCursor)
        || Number(candidate.endCursor) < Number(candidate.startCursor)
      ) throw new Error(`Trace random stream is invalid at ${index}:${streamIndex}`)
    })

    const preAuthorityHash = requireHash(frame.preStateHash, `frames[${index}].preStateHash`)
    const postAuthorityHash = requireHash(frame.postStateHash, `frames[${index}].postStateHash`)
    const preCheckpointHash = requireHash(frame.preCheckpointHash || frame.preStateHash, `frames[${index}].preCheckpointHash`)
    const postCheckpointHash = requireHash(frame.postCheckpointHash || frame.postStateHash, `frames[${index}].postCheckpointHash`)
    if (preAuthorityHash !== previousAuthorityHash) throw new Error(`Trace authority hash chain mismatch at ${index}`)
    if (preCheckpointHash !== previousCheckpointHash || hashStable(previousState) !== preCheckpointHash) throw new Error(`Trace checkpoint chain mismatch at ${index}`)
    if (hashStable(materializedState) !== postCheckpointHash) throw new Error(`Trace post-state checkpoint hash mismatch at ${index}`)
    previousState = materializedState
    previousAuthorityHash = postAuthorityHash
    previousCheckpointHash = postCheckpointHash
  })

  const final = record.final as JsonObject
  if (final.stateHash !== undefined && final.stateHash !== null && final.stateHash !== previousAuthorityHash) throw new Error('Trace final authority hash mismatch')
  if (final.checkpointHash !== undefined && final.checkpointHash !== null && final.checkpointHash !== previousCheckpointHash) throw new Error('Trace final checkpoint hash mismatch')
  return record as unknown as OfficialMatchTrace
}

function validateContentSnapshot(content: JsonObject): void {
  if (!Array.isArray(content.pieces) || !Array.isArray(content.skills)) throw new Error('Trace content snapshot must contain arrays')
  if (content.pieces.length > 2_048 || content.skills.length > 8_192) throw new Error('Trace content snapshot is too large')
  content.pieces.forEach((pieceValue, index) => {
    requireObject(pieceValue, `content.pieces[${index}]`)
    const piece = pieceValue as JsonObject
    if (typeof piece.templateId !== 'string' || !piece.templateId || piece.templateId.length > 256) throw new Error(`Trace content piece is invalid at ${index}`)
    if (piece.imageId != null && (
      typeof piece.imageId !== 'string'
      || piece.imageId.length > 512
      || piece.imageId.includes('..')
      || !/^[a-z0-9_./-]+$/i.test(piece.imageId)
    )) throw new Error(`Trace content piece image is unsafe at ${index}`)
  })
  content.skills.forEach((skillValue, index) => {
    requireObject(skillValue, `content.skills[${index}]`)
    const skill = skillValue as JsonObject
    if (typeof skill.skillId !== 'string' || !skill.skillId || skill.skillId.length > 256) throw new Error(`Trace content skill is invalid at ${index}`)
  })
}

function requireBattleCheckpoint(value: unknown, label: string): void {
  requireObject(value, label)
  const checkpoint = value as JsonObject
  requireObject(checkpoint.map, `${label}.map`)
  const map = checkpoint.map as JsonObject
  if (!Number.isSafeInteger(map.width) || !Number.isSafeInteger(map.height)) throw new Error(`${label}.map is invalid`)
  if (!Array.isArray(map.tiles) || !Array.isArray(checkpoint.pieces) || !Array.isArray(checkpoint.players)) throw new Error(`${label} is missing battle collections`)
  requireObject(checkpoint.turn, `${label}.turn`)
}

function requireObject(value: unknown, label: string): asserts value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new Error(`${label} must be a SHA-256 hash`)
  return value.toLowerCase()
}

function inspectUntrustedValue(root: unknown): void {
  let serialized: string
  try {
    serialized = JSON.stringify(root)
  } catch {
    throw new Error('Trace is not valid JSON')
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_TRACE_BYTES) throw new Error('Trace exceeds the 32 MiB size limit')
  let nodes = 0
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }]
  while (stack.length) {
    const entry = stack.pop()!
    nodes += 1
    if (nodes > MAX_TRACE_NODES) throw new Error('Trace contains too many values')
    if (entry.depth > MAX_TRACE_DEPTH) throw new Error('Trace exceeds the maximum nesting depth')
    const value = entry.value
    if (typeof value === 'string') {
      if (value.length > MAX_STRING_LENGTH) throw new Error('Trace contains an oversized string')
      if (/^\s*(?:javascript:|vbscript:|data\s*:\s*text\/html)/i.test(value) || /^\s*https?:\/\//i.test(value)) {
        throw new Error('Trace contains an unsafe URL')
      }
      continue
    }
    if (!value || typeof value !== 'object') continue
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ENTRIES) throw new Error('Trace contains an oversized array')
      for (let index = value.length - 1; index >= 0; index -= 1) stack.push({ value: value[index], depth: entry.depth + 1 })
      continue
    }
    for (const [key, nested] of Object.entries(value)) {
      const normalized = key.toLowerCase()
      if (normalized === '__proto__' || normalized === 'prototype' || normalized === 'constructor') throw new Error('Trace contains a dangerous object key')
      if (isSensitiveKey(key)) throw new Error(`Trace contains a sensitive field: ${key}`)
      stack.push({ value: nested, depth: entry.depth + 1 })
    }
  }
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return normalized === 'auth'
    || normalized.includes('authorization')
    || normalized.includes('signature')
    || normalized.includes('privatekey')
    || normalized.includes('publickey')
    || normalized.includes('accountid')
    || normalized.includes('mnemonic')
    || normalized.includes('password')
    || normalized.includes('passphrase')
    || normalized.includes('credential')
    || normalized.includes('secret')
    || normalized.includes('token')
    || normalized.includes('cookie')
    || normalized.includes('sessionid')
    || normalized.includes('recoveryphrase')
    || normalized.includes('databaseurl')
    || normalized.includes('environment')
    || normalized.includes('localpath')
}

function sanitizeJsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'object') return undefined
  const object = value as object
  if (seen.has(object)) return '[Circular]'
  seen.add(object)
  if (Array.isArray(value)) {
    const result = value.map(entry => {
      const next = sanitizeJsonValue(entry, seen)
      return next === undefined ? null : next
    })
    seen.delete(object)
    return result
  }
  const result: JsonObject = {}
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue
    const next = sanitizeJsonValue(nested, seen)
    if (next !== undefined) result[key] = next
  }
  seen.delete(object)
  return result
}

function safeAssetId(value: unknown): string | null {
  if (typeof value !== 'string' || !value || /^\s*(?:https?:|javascript:|vbscript:|data:)/i.test(value)) return null
  const candidate = value.slice(0, 512)
  return /^[a-z0-9_./-]+$/i.test(candidate) && !candidate.includes('..') ? candidate : null
}

function safeDisplayText(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 256) return null
  if (/^\s*(?:https?:|javascript:|vbscript:|data:)/i.test(value)) return null
  return value
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) ? Number(value) : null
}

function safeUint32(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0xffff_ffff
    ? Number(value) >>> 0
    : null
}

function inferSeed(actionTrace: Array<JsonObject>): number | null {
  for (const entry of actionTrace) {
    const seed = safeUint32(entry.rootSeed)
    if (seed !== null) return seed
  }
  return null
}

function normalizeIdentifier(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new OfficialError(`${field} 无效`, 400)
  return normalized
}

function isSafeHash(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !value || Number.isNaN(Date.parse(value))) throw new Error('Official terminal timestamp is invalid')
  return new Date(value).toISOString()
}
