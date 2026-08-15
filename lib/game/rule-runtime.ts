export const RANDOM_STREAM_NAMES = {
  deployment: 'deployment',
  deploymentReroll: 'deployment-reroll',
  skillEffect: 'skill/effect',
  turnOrder: 'turn-order',
} as const

export interface RandomStreamTrace {
  name: string
  startCursor: number
  endCursor: number
}

export interface RuleRuntimeOptions {
  rootSeed: number
  cursors?: Record<string, number>
  tick?: number
}

export interface RuleRuntimeSnapshot {
  cursors: Record<string, number>
  clockCursor: number
  lastRandomAccess?: { streamName: string; cursor: number }
}

const UINT32_RANGE = 0x1_0000_0000
const MULBERRY_INCREMENT = 0x6D2B79F5
const FNV_OFFSET = 0x811C9DC5
const FNV_PRIME = 0x01000193

export function normalizeRootSeed(seed: number): number {
  if (!Number.isInteger(seed) || !Number.isFinite(seed)) {
    throw new Error(`Root seed must be a finite integer; received ${String(seed)}`)
  }
  return seed >>> 0
}

export function stableStringHash(value: string): number {
  let hash = FNV_OFFSET
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    hash ^= code & 0xff
    hash = Math.imul(hash, FNV_PRIME) >>> 0
    hash ^= code >>> 8
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash >>> 0
}

export function deriveStreamSeed(rootSeed: number, streamName: string): number {
  const normalizedRootSeed = normalizeRootSeed(rootSeed)
  if (!streamName.trim()) throw new Error('Random stream name must not be empty')
  return stableStringHash(`${normalizedRootSeed}:${streamName}`)
}

function mulberryOutput(state: number): number {
  let value = Math.imul(state ^ (state >>> 15), 1 | state)
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
  return (value ^ (value >>> 14)) >>> 0
}

export function mulberry32(seed: number): () => number {
  let state = normalizeRootSeed(seed)
  return (): number => {
    state = (state + MULBERRY_INCREMENT) >>> 0
    return mulberryOutput(state) / UINT32_RANGE
  }
}

class NamedRandomStream {
  readonly name: string
  readonly seed: number
  cursor: number

  constructor(rootSeed: number, name: string, cursor = 0) {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error(`Random cursor for ${name} must be a non-negative safe integer`)
    }
    this.name = name
    this.seed = deriveStreamSeed(rootSeed, name)
    this.cursor = cursor
  }

  nextUint32(): number {
    this.cursor += 1
    const state = (this.seed + Math.imul(this.cursor, MULBERRY_INCREMENT)) >>> 0
    return mulberryOutput(state)
  }

  nextFloat(): number {
    return this.nextUint32() / UINT32_RANGE
  }
}

export class DeterministicRuleClock {
  readonly tick: number
  private readCursor: number

  constructor(tick = 0, readCursor = 0) {
    if (!Number.isSafeInteger(tick) || tick < 0) throw new Error('Rule clock tick must be a non-negative safe integer')
    if (!Number.isSafeInteger(readCursor) || readCursor < 0) throw new Error('Rule clock cursor must be a non-negative safe integer')
    this.tick = tick
    this.readCursor = readCursor
  }

  now(): number {
    if (this.readCursor >= 1_000_000) {
      throw new Error('Rule clock exceeded one million reads in a single action')
    }
    const value = (this.tick + 1) * 1_000_000 + this.readCursor
    if (!Number.isSafeInteger(value)) throw new Error('Rule clock exceeded the safe integer range')
    this.readCursor += 1
    return value
  }

  snapshot(): number {
    return this.readCursor
  }

  restore(readCursor: number): void {
    if (!Number.isSafeInteger(readCursor) || readCursor < 0) throw new Error('Rule clock cursor must be a non-negative safe integer')
    this.readCursor = readCursor
  }
}

export class RuleRuntime {
  readonly rootSeed: number
  readonly clock: DeterministicRuleClock

  private readonly initialCursors: Record<string, number>
  private readonly streams = new Map<string, NamedRandomStream>()
  private lastRandomAccess?: { streamName: string; cursor: number }

  constructor(options: RuleRuntimeOptions) {
    this.rootSeed = normalizeRootSeed(options.rootSeed)
    this.initialCursors = { ...(options.cursors || {}) }
    for (const [name, cursor] of Object.entries(this.initialCursors)) {
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        throw new Error(`Random cursor for ${name} must be a non-negative safe integer`)
      }
    }
    this.clock = new DeterministicRuleClock(options.tick ?? 0)
  }

  nextRandom(streamName: string): number {
    const stream = this.getStream(streamName)
    const value = stream.nextFloat()
    this.lastRandomAccess = { streamName, cursor: stream.cursor }
    return value
  }

  nextInt(streamName: string, maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`maxExclusive must be a positive safe integer; received ${String(maxExclusive)}`)
    }
    return Math.floor(this.nextRandom(streamName) * maxExclusive)
  }

  nextInstanceId(namespace: string, prefix = namespace): string {
    if (!namespace.trim()) throw new Error('Instance ID namespace must not be empty')
    const streamName = `instance-id/${namespace}`
    const stream = this.getStream(streamName)
    const cursor = stream.cursor
    const token = stream.nextUint32()
    this.lastRandomAccess = { streamName, cursor: stream.cursor }
    const safePrefix = prefix.trim().replace(/[^a-zA-Z0-9_-]+/g, '-') || 'instance'
    const namespaceToken = stableStringHash(namespace).toString(36)
    return `${safePrefix}-${this.rootSeed.toString(16).padStart(8, '0')}-${namespaceToken}-${cursor.toString(36)}-${token.toString(36)}`
  }

  getCursor(streamName: string): number {
    return this.streams.get(streamName)?.cursor ?? this.initialCursors[streamName] ?? 0
  }

  getLastRandomAccess(): { streamName: string; cursor: number } {
    return this.lastRandomAccess
      ? { ...this.lastRandomAccess }
      : {
          streamName: RANDOM_STREAM_NAMES.skillEffect,
          cursor: this.getCursor(RANDOM_STREAM_NAMES.skillEffect),
        }
  }

  randomTrace(includeDefaultSkillStream = false): RandomStreamTrace[] {
    const names = new Set(this.streams.keys())
    if (includeDefaultSkillStream) names.add(RANDOM_STREAM_NAMES.skillEffect)
    return [...names]
      .sort((left, right) => left.localeCompare(right))
      .map(name => ({
        name,
        startCursor: this.initialCursors[name] ?? 0,
        endCursor: this.getCursor(name),
      }))
  }

  snapshot(): RuleRuntimeSnapshot {
    const cursors: Record<string, number> = { ...this.initialCursors }
    for (const [name, stream] of this.streams) cursors[name] = stream.cursor
    return {
      cursors,
      clockCursor: this.clock.snapshot(),
      lastRandomAccess: this.lastRandomAccess ? { ...this.lastRandomAccess } : undefined,
    }
  }

  restore(snapshot: RuleRuntimeSnapshot): void {
    const names = new Set([...Object.keys(snapshot.cursors), ...this.streams.keys()])
    for (const name of names) {
      this.getStream(name).cursor = snapshot.cursors[name] ?? this.initialCursors[name] ?? 0
    }
    this.clock.restore(snapshot.clockCursor)
    this.lastRandomAccess = snapshot.lastRandomAccess ? { ...snapshot.lastRandomAccess } : undefined
  }

  private getStream(streamName: string): NamedRandomStream {
    let stream = this.streams.get(streamName)
    if (!stream) {
      stream = new NamedRandomStream(this.rootSeed, streamName, this.initialCursors[streamName] ?? 0)
      this.streams.set(streamName, stream)
    }
    return stream
  }
}

let activeRuleRuntime: RuleRuntime | undefined

export function getActiveRuleRuntime(): RuleRuntime | undefined {
  return activeRuleRuntime
}

export function withRuleRuntime<T>(runtime: RuleRuntime, operation: () => T): T {
  const previousRuntime = activeRuleRuntime
  activeRuleRuntime = runtime
  try {
    return operation()
  } finally {
    activeRuleRuntime = previousRuntime
  }
}

export function withRuleRuntimeCheckpoint<T>(operation: () => T): T {
  const runtime = activeRuleRuntime
  if (!runtime) return operation()
  const snapshot = runtime.snapshot()
  try {
    return operation()
  } finally {
    runtime.restore(snapshot)
  }
}

const deterministicMath = Object.create(Math) as Math
Object.defineProperty(deterministicMath, 'random', {
  configurable: false,
  enumerable: false,
  writable: false,
  value: () => activeRuleRuntime
    ? activeRuleRuntime.nextRandom(RANDOM_STREAM_NAMES.skillEffect)
    : Math.random(),
})
Object.freeze(deterministicMath)

export function getRuleMath(): Math {
  return deterministicMath
}

const deterministicDate = new Proxy(Date, {
  construct(target, args) {
    const effectiveArgs = args.length === 0 && activeRuleRuntime
      ? [activeRuleRuntime.clock.now()]
      : args
    return Reflect.construct(target, effectiveArgs)
  },
  get(target, property) {
    if (property === 'now') {
      return () => activeRuleRuntime ? activeRuleRuntime.clock.now() : Date.now()
    }
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  },
}) as DateConstructor

export function getRuleDate(): DateConstructor {
  return deterministicDate
}

export function createRootSeed(cryptoSource: Pick<Crypto, 'getRandomValues'> | undefined = globalThis.crypto): number {
  if (!cryptoSource?.getRandomValues) {
    throw new Error('Secure random source is unavailable; inject an explicit root seed')
  }
  const values = new Uint32Array(1)
  cryptoSource.getRandomValues(values)
  return values[0] >>> 0
}
