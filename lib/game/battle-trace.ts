import type { RuleRuntime, RandomStreamTrace } from './rule-runtime'
import type { BattleState } from './turn'

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

export interface DebugBattleMetadata {
  appliedActionIds: string[]
  actionLog: Array<BattleActionTrace | Record<string, unknown>>
  commandLog: Array<Record<string, unknown>>
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

export function hashStable(value: unknown): string {
  return sha256Hex(stableJson(value))
}

export function hashBattleState(state: BattleState): string {
  return hashStable(withoutDebugMetadata(state))
}

export function getBattleRootSeed(state: BattleState): number | undefined {
  const metadata = readDebugMetadata(state)
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
  const postStateHash = hashBattleState(state)
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
  }
}

export function getOrCreateDebugMetadata(state: BattleState): DebugBattleMetadata {
  const extensions = state.extensions ?? {}
  state.extensions = extensions
  const metadata = (extensions.debugBattle ?? {}) as {
    appliedActionIds?: string[]
    actionLog?: Array<BattleActionTrace | Record<string, unknown>>
    commandLog?: Array<Record<string, unknown>>
  }
  metadata.appliedActionIds ??= []
  metadata.actionLog ??= []
  metadata.commandLog ??= []
  extensions.debugBattle = metadata
  return metadata as DebugBattleMetadata
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

function withoutDebugMetadata(state: BattleState): BattleState {
  if (!state.extensions?.debugBattle) return state
  const remainingExtensions = { ...state.extensions }
  delete remainingExtensions.debugBattle
  const next = { ...state }
  if (Object.keys(remainingExtensions).length > 0) next.extensions = remainingExtensions
  else delete next.extensions
  return next
}
