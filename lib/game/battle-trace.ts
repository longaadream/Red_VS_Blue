import type { RuleRuntime, RandomStreamTrace } from './rule-runtime'
import type { BattleState } from './turn'
import {
  buildBattleStateHashIndex as buildChunkedBattleStateHashIndex,
  type BattleStateHashIndex,
} from './battle-state-hash'

export const BATTLE_REPLAY_FORMAT = 'rvb-battle-replay/v2' as const

export type Sha256HexProvider = (value: string) => string

const SHA256_PROVIDER_STATE_SYMBOL = Symbol.for('rvb.battle.sha256-hex-provider/v1')
const SHA256_PROVIDER_STATE_VERSION = 1 as const
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/
const SHA256_PROVIDER_SELF_CHECK_INPUTS = [
  '',
  'abc',
  '红蓝',
  '🗡️',
  '\ud800',
  '\udc00',
  'a'.repeat(8_193),
] as const

interface Sha256ProviderState {
  version: typeof SHA256_PROVIDER_STATE_VERSION
  provider: Sha256HexProvider
}

const SHA256_INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const

export interface BattleActionTrace {
  index: number
  rootSeed: number | null
  actionId: string
  actionHash: string
  tick: number
  turn: number
  playerId: string
  preStateHash: string
  postStateHash: string
  randomStreams: RandomStreamTrace[]
  deployment?: DeploymentTraceEvidence
}

export interface DeploymentTraceEvidence {
  command?: 'initialize' | 'select' | 'lock' | 'timeout'
  initialPositions?: Record<string, { x: number; y: number }>
  choices?: Record<string, { pieceId: string | null }>
  locks?: Record<string, { locked: boolean; reason?: 'player' | 'timeout' }>
  timedOutPlayerIds?: string[]
  finalPositions?: Record<string, { x: number; y: number }>
  deadlineAt?: number
  revision?: number
  authorityVersion?: number
}

export interface BattleReplayFrame {
  index: number
  traceIndex: number
  action: Record<string, unknown>
  actionType: string
  playerId: string
  turnBefore: number
  turnAfter: number
  phaseBefore: string
  phaseAfter: string
  preStateHash: string
  postStateHash: string
  preCheckpointHash: string
  postCheckpointHash: string
  /** Unchanged static maps inherit from the previous materialized checkpoint. */
  inheritsMap?: boolean
  postState: Omit<BattleState, 'map'> & { map?: BattleState['map'] }
  events: Array<Record<string, unknown>>
  randomStreams: RandomStreamTrace[]
}

export interface BattleReplaySkillContent {
  skillId: string
  name: string
  description?: string
  type?: string
  cooldownTurns: number
  maxCharges: number
  chargeCost?: number
  actionPointCost: number
}

export interface BattleReplayContentSnapshot {
  skills: BattleReplaySkillContent[]
}

export interface BattleReplayArchive {
  format: typeof BATTLE_REPLAY_FORMAT
  initialStateHash: string
  initialCheckpointHash: string
  initialState: BattleState
  content: BattleReplayContentSnapshot
  frames: BattleReplayFrame[]
}

export interface BattleTraceAuthorityRuntime {
  rootSeed?: number
  actionCount: number
  replayFrameCount: number
  runtimeCursors: Record<string, number>
}

export interface DebugBattleMetadata {
  appliedActionIds: string[]
  actionLog: Array<BattleActionTrace | Record<string, unknown>>
  commandLog: Array<Record<string, unknown>>
  replay?: BattleReplayArchive
  authority?: BattleTraceAuthorityRuntime
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortForStableJson(value))
}

export function sha256Hex(value: string): string {
  const bytes = encodeUtf8(value)
  const bitLength = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)

  const highBitLength = Math.floor(bitLength / 0x1_0000_0000)
  const lowBitLength = bitLength >>> 0
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((highBitLength >>> shift) & 0xff)
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((lowBitLength >>> shift) & 0xff)

  const hash: number[] = [...SHA256_INITIAL_STATE]
  const words = new Uint32Array(64)
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const byteOffset = offset + index * 4
      words[index] = (
        (bytes[byteOffset] << 24)
        | (bytes[byteOffset + 1] << 16)
        | (bytes[byteOffset + 2] << 8)
        | bytes[byteOffset + 3]
      ) >>> 0
    }
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15]
      const word2 = words[index - 2]
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3)
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10)
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0
    }

    let a = hash[0]
    let b = hash[1]
    let c = hash[2]
    let d = hash[3]
    let e = hash[4]
    let f = hash[5]
    let g = hash[6]
    let h = hash[7]

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temp1 = (h + sum1 + choice + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (sum0 + majority) >>> 0

      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    hash[0] = (hash[0] + a) >>> 0
    hash[1] = (hash[1] + b) >>> 0
    hash[2] = (hash[2] + c) >>> 0
    hash[3] = (hash[3] + d) >>> 0
    hash[4] = (hash[4] + e) >>> 0
    hash[5] = (hash[5] + f) >>> 0
    hash[6] = (hash[6] + g) >>> 0
    hash[7] = (hash[7] + h) >>> 0
  }

  return hash.map(word => word.toString(16).padStart(8, '0')).join('')
}

/**
 * Installs a process-wide SHA-256 implementation after proving it preserves the
 * frozen browser-safe UTF-8/hash contract. Symbol.for keeps the first verified
 * provider stable across Next.js module reloads.
 */
export function installSha256HexProvider(provider: Sha256HexProvider): boolean {
  if (typeof provider !== 'function') {
    throw new TypeError('Battle SHA-256 provider must be a function')
  }

  const installed = readInstalledSha256HexProvider()
  if (installed) return false

  assertSha256HexProviderEquivalent(provider)
  const state = Object.freeze<Sha256ProviderState>({
    version: SHA256_PROVIDER_STATE_VERSION,
    provider,
  })
  Object.defineProperty(globalThis, SHA256_PROVIDER_STATE_SYMBOL, {
    value: state,
    configurable: false,
    enumerable: false,
    writable: false,
  })
  return true
}

function readInstalledSha256HexProvider(): Sha256HexProvider | undefined {
  const state = (globalThis as Record<symbol, unknown>)[SHA256_PROVIDER_STATE_SYMBOL]
  if (state === undefined) return undefined
  if (
    !state
    || typeof state !== 'object'
    || (state as Partial<Sha256ProviderState>).version !== SHA256_PROVIDER_STATE_VERSION
    || typeof (state as Partial<Sha256ProviderState>).provider !== 'function'
  ) {
    throw new Error('Battle SHA-256 provider state is invalid')
  }
  return (state as Sha256ProviderState).provider
}

function assertSha256HexProviderEquivalent(provider: Sha256HexProvider): void {
  for (const input of SHA256_PROVIDER_SELF_CHECK_INPUTS) {
    const expected = sha256Hex(input)
    let actual: string
    try {
      actual = provider(input)
    } catch (cause) {
      throw new Error('Battle SHA-256 provider self-check failed', { cause })
    }
    if (!SHA256_HEX_PATTERN.test(actual) || actual !== expected) {
      throw new Error('Battle SHA-256 provider self-check failed')
    }
  }
}

function assertSha256HexDigest(value: string, context: 'runtime'): string {
  if (!SHA256_HEX_PATTERN.test(value)) {
    throw new Error(`Battle SHA-256 provider returned an invalid SHA-256 digest during ${context}`)
  }
  return value
}

export function hashStable(value: unknown): string {
  const serialized = stableJson(value)
  const provider = readInstalledSha256HexProvider()
  if (!provider) return sha256Hex(serialized)
  return assertSha256HexDigest(provider(serialized), 'runtime')
}

export function hashBattleState(state: BattleState): string {
  return createBattleStateHashIndex(state).rootHash
}

export function hashLegacyBattleState(state: BattleState): string {
  return hashStable(canonicalBattleStateForHash(state))
}

export function hashBattleStateForProtocol(state: BattleState, protocolVersion: 2 | 3): string {
  return protocolVersion === 2 ? hashLegacyBattleState(state) : hashBattleState(state)
}

export function createBattleStateHashIndex(state: BattleState): BattleStateHashIndex {
  return buildChunkedBattleStateHashIndex(canonicalBattleStateForHash(state), hashStable)
}

export function canonicalBattleStateForHash(state: BattleState): BattleState {
  return withoutDebugMetadata(state)
}

export function getBattleRootSeed(state: BattleState): number | undefined {
  const metadata = readDebugMetadata(state)
  const compactSeed = metadata.authority?.rootSeed
  if (typeof compactSeed === 'number' && Number.isInteger(compactSeed)) return compactSeed >>> 0
  for (const entry of metadata.actionLog) {
    const rootSeed = (entry as Partial<BattleActionTrace>).rootSeed
    if (typeof rootSeed === 'number' && Number.isInteger(rootSeed)) return rootSeed >>> 0
  }
  return undefined
}

export function recordBattleInitialization(
  state: BattleState,
  runtime: RuleRuntime,
  playerIds: string[],
): BattleActionTrace {
  const metadata = getOrCreateDebugMetadata(state)
  const action = { type: 'initializeBattle', playerIds: [...playerIds] }
  const actionHash = hashStable(action)
  const content = createBattleReplayContentSnapshot(state)
  const canonicalState = withoutReplayRuntimeCaches(state)
  const postStateHash = hashBattleState(canonicalState)
  const trace: BattleActionTrace = {
    index: metadata.actionLog.length,
    rootSeed: runtime.rootSeed,
    actionId: 'system-initialize',
    actionHash,
    tick: 0,
    turn: state.turn?.turnNumber ?? 0,
    playerId: 'system',
    preStateHash: hashStable({ type: 'uninitializedBattle', playerIds: [...playerIds] }),
    postStateHash,
    randomStreams: runtime.randomTrace(true),
    deployment: state.deployment ? {
      command: 'initialize',
      initialPositions: copyPositions(state.deployment.initialPositions),
      locks: copyLocks(state.deployment.locks),
      deadlineAt: state.deployment.deadlineAt,
      revision: state.deployment.revision,
    } : undefined,
  }
  metadata.actionLog.push(trace)
  metadata.commandLog[trace.index] = sanitizeBattleTraceValue(action) as Record<string, unknown>
  metadata.authority = {
    rootSeed: runtime.rootSeed,
    actionCount: trace.index + 1,
    replayFrameCount: 0,
    runtimeCursors: runtimeCursorsFromTrace(trace),
  }
  const initialState = createBattleReplayCheckpoint(canonicalState)
  metadata.replay = {
    format: BATTLE_REPLAY_FORMAT,
    initialStateHash: postStateHash,
    initialCheckpointHash: hashStable(initialState),
    initialState,
    content,
    frames: [],
  }
  return trace
}


export function sanitizeBattleTraceValue(value: unknown): unknown {
  return sanitizeTraceValue(value, new WeakSet<object>())
}

function sanitizeTraceValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'object') return undefined

  const source = value as object
  if (seen.has(source)) return '[Circular]'
  seen.add(source)

  if (Array.isArray(value)) {
    const sanitized = value.map(entry => {
      const next = sanitizeTraceValue(entry, seen)
      return next === undefined ? null : next
    })
    seen.delete(source)
    return sanitized
  }

  const sanitized: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveTraceKey(key)) continue
    const next = sanitizeTraceValue(entry, seen)
    if (next !== undefined) sanitized[key] = next
  }
  seen.delete(source)
  return sanitized
}

function isSensitiveTraceKey(key: string): boolean {
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
}

export function readSanitizedBattleActionTrace(state: BattleState): Array<Record<string, unknown>> {
  const metadata = readDebugMetadata(state)
  return metadata.actionLog.map((entry, index) => {
    const sanitizedEntry = sanitizeBattleTraceValue(entry)
    const trace: Record<string, unknown> = sanitizedEntry && typeof sanitizedEntry === 'object' && !Array.isArray(sanitizedEntry)
      ? { ...(sanitizedEntry as Record<string, unknown>) }
      : { index }
    const command = metadata.commandLog[index]
    if (command) {
      trace.action = sanitizeBattleTraceValue(command)
    }
    return trace
  })
}

export function readSanitizedBattleReplay(state: BattleState): BattleReplayArchive | undefined {
  const replay = readDebugMetadata(state).replay
  if (!replay || replay.format !== BATTLE_REPLAY_FORMAT) return undefined
  return sanitizeBattleTraceValue(replay) as BattleReplayArchive
}

export function createBattleReplayCheckpoint(state: BattleState): BattleState {
  const checkpoint = sanitizeBattleTraceValue(withoutDebugMetadata(state))
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
    throw new Error('Battle replay checkpoint must be a serializable object')
  }
  delete (checkpoint as Partial<BattleState>).actions
  return checkpoint as BattleState
}

export function appendBattleReplayFrame(
  nextState: BattleState,
  beforeState: BattleState,
  afterState: BattleState,
  action: Record<string, unknown>,
  trace: BattleActionTrace,
): BattleReplayFrame | undefined {
  const metadata = getOrCreateDebugMetadata(nextState)
  const replay = metadata.replay
  if (!replay || replay.format !== BATTLE_REPLAY_FORMAT) return undefined

  replay.content = mergeBattleReplayContentSnapshot(replay.content, createBattleReplayContentSnapshot(afterState))
  const preState = createBattleReplayCheckpoint(beforeState)
  const fullPostState = createBattleReplayCheckpoint(afterState)
  const inheritsMap = stableJson(preState.map) === stableJson(fullPostState.map)
  const postState: BattleReplayFrame['postState'] = { ...fullPostState }
  if (inheritsMap) delete postState.map
  const sanitizedAction = sanitizeBattleTraceValue(action) as Record<string, unknown>
  const events = collectCommittedEvents(beforeState.actions, afterState.actions)
  const frame: BattleReplayFrame = {
    index: metadata.authority?.replayFrameCount ?? replay.frames.length,
    traceIndex: trace.index,
    action: sanitizedAction,
    actionType: typeof sanitizedAction.type === 'string' ? sanitizedAction.type : 'unknown',
    playerId: trace.playerId,
    turnBefore: beforeState.turn?.turnNumber ?? 0,
    turnAfter: afterState.turn?.turnNumber ?? 0,
    phaseBefore: String(beforeState.turn?.phase ?? ''),
    phaseAfter: String(afterState.turn?.phase ?? ''),
    preStateHash: trace.preStateHash,
    postStateHash: trace.postStateHash,
    preCheckpointHash: hashStable(preState),
    postCheckpointHash: hashStable(fullPostState),
    inheritsMap: inheritsMap || undefined,
    postState,
    events,
    randomStreams: trace.randomStreams.map(stream => ({ ...stream })),
  }
  replay.frames.push(frame)
  if (metadata.authority) metadata.authority.replayFrameCount = frame.index + 1
  return frame
}

function createBattleReplayContentSnapshot(state: BattleState): BattleReplayContentSnapshot {
  const skillIds = new Set<string>()
  const replayPieces = [...(state.pieces ?? []), ...(state.graveyard ?? [])]
  for (const piece of replayPieces) {
    for (const skill of piece.skills ?? []) {
      if (skill?.skillId) skillIds.add(skill.skillId)
    }
  }

  const skills = [...skillIds].sort().flatMap(skillId => {
    const definition = state.skillsById?.[skillId]
    if (!definition) return []
    return [{
      skillId,
      name: definition.name || skillId,
      description: definition.description || undefined,
      type: definition.type || undefined,
      cooldownTurns: Number.isFinite(definition.cooldownTurns) ? definition.cooldownTurns : 0,
      maxCharges: Number.isFinite(definition.maxCharges) ? definition.maxCharges : 0,
      chargeCost: Number.isFinite(definition.chargeCost) ? definition.chargeCost : undefined,
      actionPointCost: Number.isFinite(definition.actionPointCost) ? definition.actionPointCost : 0,
    }]
  })
  return { skills }
}

function mergeBattleReplayContentSnapshot(
  current: BattleReplayContentSnapshot | undefined,
  next: BattleReplayContentSnapshot,
): BattleReplayContentSnapshot {
  const skillsById = new Map<string, BattleReplaySkillContent>()
  for (const skill of current?.skills ?? []) skillsById.set(skill.skillId, skill)
  for (const skill of next.skills) skillsById.set(skill.skillId, skill)
  return { skills: [...skillsById.values()].sort((left, right) => left.skillId.localeCompare(right.skillId)) }
}

function collectCommittedEvents(
  before: BattleState['actions'],
  after: BattleState['actions'],
): Array<Record<string, unknown>> {
  const previous = Array.isArray(before) ? before : []
  const current = Array.isArray(after) ? after : []
  const keepsPrefix = previous.length <= current.length
    && previous.every((event, index) => stableJson(event) === stableJson(current[index]))
  const committed = keepsPrefix ? current.slice(previous.length) : current
  return sanitizeBattleTraceValue(committed) as Array<Record<string, unknown>>
}

function copyPositions(
  positions: Record<string, { x: number; y: number }> | undefined,
): Record<string, { x: number; y: number }> | undefined {
  if (!positions) return undefined
  return Object.fromEntries(
    Object.entries(positions).map(([pieceId, position]) => [pieceId, { ...position }]),
  )
}

function copyLocks(
  locks: Record<string, { locked: boolean; reason?: 'player' | 'timeout' }> | undefined,
): Record<string, { locked: boolean; reason?: 'player' | 'timeout' }> | undefined {
  if (!locks) return undefined
  return Object.fromEntries(
    Object.entries(locks).map(([playerId, lock]) => [playerId, { ...lock }]),
  )
}


export function readDebugMetadata(state: BattleState): DebugBattleMetadata {
  const metadata = state.extensions?.debugBattle as Partial<DebugBattleMetadata> | undefined
  return {
    appliedActionIds: Array.isArray(metadata?.appliedActionIds) ? [...metadata.appliedActionIds] : [],
    actionLog: Array.isArray(metadata?.actionLog) ? [...metadata.actionLog] : [],
    commandLog: Array.isArray(metadata?.commandLog) ? [...metadata.commandLog] : [],
    replay: metadata?.replay,
    authority: metadata?.authority ? {
      ...metadata.authority,
      runtimeCursors: { ...metadata.authority.runtimeCursors },
    } : undefined,
  }
}

export function getOrCreateDebugMetadata(state: BattleState): DebugBattleMetadata {
  const extensions = state.extensions ?? {}
  state.extensions = extensions
  const metadata = (extensions.debugBattle ?? {}) as {
    appliedActionIds?: string[]
    actionLog?: Array<BattleActionTrace | Record<string, unknown>>
    commandLog?: Array<Record<string, unknown>>
    replay?: BattleReplayArchive
    authority?: BattleTraceAuthorityRuntime
  }
  metadata.appliedActionIds ??= []
  metadata.actionLog ??= []
  metadata.commandLog ??= []
  extensions.debugBattle = metadata
  return metadata as DebugBattleMetadata
}

export function compactBattleTraceForAuthority(state: BattleState): BattleState {
  const metadata = getOrCreateDebugMetadata(state)
  const authority = metadata.authority ?? {
    rootSeed: getBattleRootSeed(state),
    actionCount: metadata.actionLog.length,
    replayFrameCount: metadata.replay?.frames.length ?? 0,
    runtimeCursors: runtimeCursorsFromLog(metadata.actionLog),
  }
  const replay = metadata.replay ? { ...metadata.replay, frames: [] } : undefined
  const initializationTraces = metadata.actionLog.filter(entry => (
    (entry as Partial<BattleActionTrace>).actionId === 'system-initialize'
  ))
  const initializationCommands = initializationTraces.length > 0
    ? metadata.commandLog.slice(0, initializationTraces.length)
    : []
  const extensions = state.extensions ?? {}
  extensions.debugBattle = {
    appliedActionIds: [],
    actionLog: initializationTraces,
    commandLog: initializationCommands,
    replay,
    authority: {
      ...authority,
      runtimeCursors: { ...authority.runtimeCursors },
    },
  }
  state.extensions = extensions
  return state
}

export function materializeBattleTraceForTerminal(
  state: BattleState,
  history: Array<{
    trace?: BattleActionTrace
    command?: Record<string, unknown>
    replayFrame?: BattleReplayFrame
  }>,
): BattleState {
  const metadata = getOrCreateDebugMetadata(state)
  const initializationTraces = metadata.actionLog.filter(entry => (
    (entry as Partial<BattleActionTrace>).actionId === 'system-initialize'
  ))
  const initializationCommands = initializationTraces.length > 0
    ? metadata.commandLog.slice(0, initializationTraces.length)
    : []
  const traces = history.flatMap(entry => entry.trace ? [entry.trace] : [])
  const commands = history.flatMap(entry => entry.command ? [entry.command] : [])
  const frames = history.flatMap(entry => entry.replayFrame ? [entry.replayFrame] : [])
  metadata.actionLog = [...initializationTraces, ...traces]
  metadata.commandLog = [...initializationCommands, ...commands]
  if (metadata.replay) metadata.replay = { ...metadata.replay, frames }
  metadata.appliedActionIds = traces.map(trace => trace.actionId).filter(Boolean)
  return state
}

function runtimeCursorsFromTrace(trace: Pick<BattleActionTrace, 'randomStreams'>): Record<string, number> {
  const cursors: Record<string, number> = {}
  for (const stream of trace.randomStreams) {
    if (!stream || typeof stream.name !== 'string' || !Number.isSafeInteger(stream.endCursor) || stream.endCursor < 0) continue
    cursors[stream.name] = stream.endCursor
  }
  return cursors
}

function runtimeCursorsFromLog(actionLog: DebugBattleMetadata['actionLog']): Record<string, number> {
  const cursors: Record<string, number> = {}
  for (const entry of actionLog) {
    const streams = (entry as Partial<BattleActionTrace>).randomStreams
    Object.assign(cursors, runtimeCursorsFromTrace({ randomStreams: Array.isArray(streams) ? streams : [] }))
  }
  return cursors
}

export function stampPendingDeploymentAuthorityVersion(
  state: BattleState,
  authorityVersion: number,
): void {
  if (!Number.isSafeInteger(authorityVersion) || authorityVersion < 0) return
  const metadata = state.extensions?.debugBattle as Partial<DebugBattleMetadata> | undefined
  if (!Array.isArray(metadata?.actionLog)) return
  for (const entry of metadata.actionLog) {
    const trace = entry as Partial<BattleActionTrace>
    if (!trace.deployment || trace.deployment.authorityVersion !== undefined) continue
    trace.deployment.authorityVersion = authorityVersion
  }
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableJson)
  if (!value || typeof value !== 'object') return value

  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortForStableJson((value as Record<string, unknown>)[key])
  }
  return sorted
}

function encodeUtf8(value: string): number[] {
  const bytes: number[] = []
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index)
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const low = value.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00)
        index += 1
      } else {
        codePoint = 0xfffd
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd
    }

    if (codePoint <= 0x7f) {
      bytes.push(codePoint)
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f))
    } else if (codePoint <= 0xffff) {
      bytes.push(0xe0 | (codePoint >>> 12), 0x80 | ((codePoint >>> 6) & 0x3f), 0x80 | (codePoint & 0x3f))
    } else {
      bytes.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      )
    }
  }
  return bytes
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

function withoutReplayRuntimeCaches(state: BattleState): BattleState {
  const next = { ...state }
  delete (next as Partial<BattleState>).skillsById
  return next
}

function withoutDebugMetadata(state: BattleState): BattleState {
  if (!state.extensions?.debugBattle) return state
  const remainingExtensions = { ...state.extensions }
  delete remainingExtensions.debugBattle
  const next = { ...state }
  if (Object.keys(remainingExtensions).length > 0) next.extensions = remainingExtensions
  else delete next.extensions
  return next
}
