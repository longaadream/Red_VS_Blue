import { BattleRuleError } from './battle-types'
import type { Faction, PieceInstance } from './piece'
import {
  isSuspendableActionPending,
  type SuspendableActionPending,
} from './suspendable-action-transaction'

export const EFFECT_BATCH_KINDS = ['damage', 'heal', 'summon', 'death'] as const

export type EffectBatchKind = (typeof EFFECT_BATCH_KINDS)[number]
export type EffectChainState = 'idle' | 'processing'
export type EffectDamageType = 'physical' | 'magical' | 'true' | 'toxin'

export interface DamageRequest {
  readonly kind: 'damage'
  readonly attacker: PieceInstance
  readonly targets: readonly PieceInstance[]
  readonly baseDamage: number
  readonly damageType: EffectDamageType
  readonly skillId?: string
  readonly skipBeforeTrigger?: boolean
  readonly killerPlayerId?: string
  readonly selectedOption?: unknown
}

export interface HealRequest {
  readonly kind: 'heal'
  readonly healer: PieceInstance
  readonly targets: readonly PieceInstance[]
  readonly baseHeal: number
  readonly skillId?: string
}

export interface TemplateSummonSpec {
  readonly recipe: 'template'
  readonly templateId: string
  readonly ownerPlayerId: string
  readonly faction: Faction
  readonly x: number
  readonly y: number
  readonly index?: number
}

export interface DeclaredSummonSpec {
  /** Keeps the internal template discriminant observable without accepting it at the writer. */
  readonly recipe?: undefined
  readonly x: number
  readonly y: number
  readonly variant?: string
}

export type SummonSpec = TemplateSummonSpec | DeclaredSummonSpec

export interface SourceMirrorStatusDeclaration {
  readonly idPrefix: string
  readonly name: string
  readonly type: string
  readonly visible: boolean
  readonly remainingDuration: number
  readonly remainingUses: number
  readonly intensity: number
  readonly stacks: number
  readonly relatedRules: readonly string[]
}

export interface SourceMirrorSummonCapabilityDeclaration {
  readonly version: 1
  readonly recipe: 'source-mirror'
  readonly maxSummons: number
  readonly allowedVariants: readonly string[]
  readonly instanceIdPrefix: string
  readonly maxHp: number
  readonly attack: number
  readonly defense: number
  readonly moveRange: number
  readonly noKillCharge: boolean
  readonly resetBoundSkillCooldown: boolean
  readonly rules: readonly string[]
  readonly status: SourceMirrorStatusDeclaration
}

export interface DeclaredPieceSkillDeclaration {
  readonly skillId: string
  readonly level: number
  readonly currentCooldown: number
}

export interface StoredPieceFallbackDeclaration {
  readonly instanceIdPrefix: string
  readonly templateId: string
  readonly name: string
  readonly faction: Faction
  readonly maxHp: number
  readonly attack: number
  readonly defense: number
  readonly moveRange: number
  readonly skills: readonly DeclaredPieceSkillDeclaration[]
}

export interface StoredOrDeclaredPieceSummonCapabilityDeclaration {
  readonly version: 1
  readonly recipe: 'stored-or-declared-piece'
  readonly maxSummons: number
  readonly storageExtensionKey: string
  readonly uniqueTemplateId: string
  readonly fallback: StoredPieceFallbackDeclaration
}

export type SummonCapabilityDeclaration =
  | SourceMirrorSummonCapabilityDeclaration
  | StoredOrDeclaredPieceSummonCapabilityDeclaration

export type DeclaredSummonCapability = Readonly<SummonCapabilityDeclaration>

export interface SummonRequest {
  readonly kind: 'summon'
  readonly contentId: string
  readonly capability?: DeclaredSummonCapability
  readonly summons: readonly SummonSpec[]
  readonly sourceId?: string
  readonly skillId?: string
}

export interface DeathCandidate {
  readonly piece: PieceInstance
  readonly attacker?: PieceInstance
  readonly killerPlayerId?: string
  readonly skillId?: string
}

export interface DeathRequest {
  readonly kind: 'death'
  readonly candidates: readonly DeathCandidate[]
}

export type EffectRequest = DamageRequest | HealRequest | SummonRequest | DeathRequest

export interface DamageQueueRequest {
  readonly attacker: PieceInstance
  readonly target: PieceInstance | readonly PieceInstance[]
  readonly damage: number
  readonly damageType: EffectDamageType
  readonly skillId?: string
  readonly killerPlayerId?: string
  readonly selectedOption?: unknown
}

export interface HealQueueRequest {
  readonly healer: PieceInstance
  readonly target: PieceInstance | readonly PieceInstance[]
  readonly heal: number
  readonly skillId?: string
}

export interface SummonQueueRequest {
  readonly summons: readonly TemplateSummonSpec[]
  readonly sourceId?: string
  readonly skillId?: string
}

export interface DeclaredSummonQueueRequest {
  readonly sourceId: string
  readonly summons: readonly DeclaredSummonSpec[]
}

export interface DeathQueueRequest {
  readonly candidates: readonly DeathCandidate[]
}

export interface EffectQueueWriter<TRequest> {
  push(...requests: readonly TRequest[]): number
}

export type DamageQueueWriter = EffectQueueWriter<DamageQueueRequest>
export type HealQueueWriter = EffectQueueWriter<HealQueueRequest>
export type SummonQueueWriter = EffectQueueWriter<SummonQueueRequest>
export type DeclaredSummonQueueWriter = EffectQueueWriter<DeclaredSummonQueueRequest>
export type DeathQueueWriter = EffectQueueWriter<DeathQueueRequest>

export interface EffectChainLimits {
  readonly maxDepth: number
  readonly maxBatches: number
  readonly maxDispatches: number
}

export const DEFAULT_EFFECT_CHAIN_LIMITS: Readonly<EffectChainLimits> = Object.freeze({
  maxDepth: 20,
  maxBatches: 100,
  maxDispatches: 1000,
})

export function resolveSummonRedirectPosition(
  context: {
    readonly targetPosition?: unknown
    readonly targetX?: unknown
    readonly targetY?: unknown
  },
  reject: (message: string) => never,
): { x: number; y: number } {
  const position = context.targetPosition
  if (!position || typeof position !== 'object' || Array.isArray(position)) {
    reject('Summon redirect targetPosition must be a coordinate pair')
  }
  const positionX = (position as { x?: unknown }).x
  const positionY = (position as { y?: unknown }).y
  if (!Number.isSafeInteger(positionX) || !Number.isSafeInteger(positionY)) {
    reject('Summon redirect targetPosition must contain safe integer x/y coordinates')
  }

  const targetX = context.targetX
  const targetY = context.targetY
  if (!Number.isSafeInteger(targetX) || !Number.isSafeInteger(targetY)) {
    reject('Summon redirect targetX/targetY must both be safe integers')
  }
  if (positionX !== targetX || positionY !== targetY) {
    reject('Summon redirect targetPosition and targetX/targetY must agree')
  }
  return { x: positionX as number, y: positionY as number }
}

export interface EffectBatchIdInput {
  readonly actionId: string
  readonly chainId: string
  readonly kind: EffectBatchKind
  readonly batchSequence: number
  readonly parentBatchId?: string
  readonly depth: number
  readonly enqueueSequence?: number
  readonly originStage?: string
}

export interface EffectChainOptions {
  readonly actionId: string
  readonly chainId: string
  readonly turn: number
  readonly rootSeed: number | null
  readonly detached?: boolean
  /** Tests may lower a budget, but production callers cannot raise ADR-0022 limits. */
  readonly limits?: Partial<EffectChainLimits>
  /** Authoritative callers bind this to RuleRuntime; its state is snapshotted separately. */
  readonly createBatchId?: (input: EffectBatchIdInput) => string
}

export interface EffectWriterBinding {
  readonly parentBatchId?: string
  readonly depth: number
}

export interface EffectLedgerEntry<TRequest extends EffectRequest = EffectRequest> {
  readonly request: TRequest
  readonly kind: TRequest['kind']
  readonly parentBatchId?: string
  readonly depth: number
  readonly enqueueSequence: number
}

export interface EffectBatchContext<TKind extends EffectBatchKind = EffectBatchKind> {
  readonly actionId: string
  readonly chainId: string
  readonly batchId: string
  readonly parentBatchId?: string
  readonly kind: TKind
  readonly depth: number
  readonly enqueueSequence?: number
  readonly originStage?: string
  readonly turn: number
  readonly rootSeed: number | null
  readonly detached: boolean
}

export interface EffectDispatchMetadata {
  readonly kind?: EffectBatchKind
  readonly batchId?: string
  readonly parentBatchId?: string
  readonly depth?: number
  readonly enqueueSequence?: number
  readonly originStage?: string
  readonly sourceId?: string
  readonly skillId?: string
  readonly targetId?: string
  readonly targetIds?: readonly string[]
}

interface FatalMetadata extends Omit<EffectDispatchMetadata, 'kind'> {
  readonly kind?: EffectBatchKind | string | null
}

export type EffectChainBudget = 'kind' | 'depth' | 'batches' | 'dispatches' | 'state' | 'binding'

export interface EffectChainErrorContext {
  readonly actionId: string
  readonly chainId: string
  readonly batchId?: string
  readonly parentBatchId?: string
  readonly kind: EffectBatchKind | string | null
  readonly depth: number | null
  readonly enqueueSequence?: number
  readonly originStage?: string
  readonly processed: number
  readonly limit: number
  readonly turn: number
  readonly rootSeed: number | null
  readonly sourceId?: string
  readonly skillId?: string
  readonly targetId?: string
  readonly targetIds?: readonly string[]
  readonly detached: boolean
  readonly budget: EffectChainBudget
}

export type EffectChainFatalCode =
  | 'RVB_EFFECT_CHAIN_UNKNOWN_KIND'
  | 'RVB_EFFECT_CHAIN_DEPTH_LIMIT'
  | 'RVB_EFFECT_CHAIN_BATCH_LIMIT'
  | 'RVB_EFFECT_CHAIN_DISPATCH_LIMIT'
  | 'RVB_EFFECT_CHAIN_REENTRANT'
  | 'RVB_EFFECT_CHAIN_STATE_INVALID'
  | 'RVB_EFFECT_CHAIN_SNAPSHOT_INVALID'
  | 'RVB_EFFECT_CHAIN_SUMMON_CAPABILITY'
  | 'RVB_EFFECT_CHAIN_BATCH_REJECTED'

export class EffectChainFatalError extends BattleRuleError {
  declare readonly code: EffectChainFatalCode
  readonly context: Readonly<EffectChainErrorContext>
  override readonly cause?: unknown

  constructor(
    code: EffectChainFatalCode,
    message: string,
    context: EffectChainErrorContext,
    cause?: unknown,
  ) {
    super(message + '; context=' + JSON.stringify(context), code)
    this.name = 'EffectChainFatalError'
    this.context = Object.freeze({ ...context })
    this.cause = cause
  }
}

export function isEffectChainFatalError(error: unknown): error is EffectChainFatalError {
  try {
    if (error instanceof EffectChainFatalError) return true
    if (!error || typeof error !== 'object') return false
    const candidate = error as { name?: unknown; code?: unknown; context?: unknown }
    return candidate.name === 'EffectChainFatalError'
      && typeof candidate.code === 'string'
      && candidate.code.startsWith('RVB_EFFECT_CHAIN_')
      && !!candidate.context
      && typeof candidate.context === 'object'
  } catch {
    return false
  }
}

export function isEffectChainPendingSignal(error: unknown): error is SuspendableActionPending {
  try {
    return isSuspendableActionPending(error)
  } catch {
    return false
  }
}


/**
 * Converts an invalid or blocked batch into the structured fatal diagnostic
 * required by ADR-0022. Existing fatal errors are returned unchanged so their
 * original code, context, and cause remain observable at the action boundary.
 */
export function rejectEffectBatch(
  chain: EffectChain,
  context: EffectBatchContext,
  message: string,
  cause?: unknown,
  metadata: EffectDispatchMetadata = {},
): EffectChainFatalError {
  if (isEffectChainFatalError(cause)) return chain.latchFatal(cause)
  return chain.latchFatal(new EffectChainFatalError(
    'RVB_EFFECT_CHAIN_BATCH_REJECTED',
    message,
    {
      actionId: chain.actionId,
      chainId: chain.chainId,
      batchId: context.batchId,
      parentBatchId: context.parentBatchId,
      kind: context.kind,
      depth: context.depth,
      enqueueSequence: context.enqueueSequence,
      originStage: context.originStage,
      processed: chain.processedBatches,
      limit: chain.limits.maxBatches,
      turn: chain.turn,
      rootSeed: chain.rootSeed,
      sourceId: metadata.sourceId,
      skillId: metadata.skillId,
      targetId: metadata.targetId,
      targetIds: metadata.targetIds,
      detached: chain.detached,
      budget: 'state',
    },
    cause,
  ))
}
export type EffectChainRecord =
  | ({ readonly type: 'enqueue' } & EffectLedgerEntry)
  | ({ readonly type: 'batch:start' | 'batch:finish' } & EffectBatchContext)
  | ({ readonly type: 'dispatch'; readonly processedDispatches: number } & EffectBatchContext)

export interface EffectChainSnapshot {
  readonly version: 1
  readonly actionId: string
  readonly chainId: string
  readonly detached: boolean
  readonly state: EffectChainState
  readonly ledger: readonly EffectLedgerEntry[]
  readonly processedBatches: number
  readonly processedDispatches: number
  readonly nextEnqueueSequence: number
  readonly nextBatchSequence: number
  readonly batchStack: readonly EffectBatchContext[]
  readonly records: readonly EffectChainRecord[]
  /** Process-local control flow only; never persisted as BattleState. */
  readonly pendingSignal?: SuspendableActionPending
}

export interface EffectHandlerResultMap {
  readonly damage: unknown
  readonly heal: unknown
  readonly summon: unknown
  readonly death: unknown
}

export type EffectHandlers<TResult extends EffectHandlerResultMap = EffectHandlerResultMap> = {
  readonly [TKind in EffectBatchKind]: (
    request: Extract<EffectRequest, { kind: TKind }>,
    context: EffectBatchContext<TKind>,
    chain: EffectChain,
  ) => TResult[TKind]
}

export interface EffectExecution<TResult = unknown> {
  readonly kind: EffectBatchKind
  readonly request: EffectRequest
  readonly context: EffectBatchContext
  readonly result: TResult
}

interface InternalBatchInput<TRequest extends EffectRequest> {
  readonly request: TRequest
  readonly parentBatchId?: string
  readonly depth: number
  readonly enqueueSequence?: number
  readonly originStage?: string
}

function isEffectBatchKind(value: unknown): value is EffectBatchKind {
  return value === 'damage' || value === 'heal' || value === 'summon' || value === 'death'
}

function assertNever(value: never): never {
  throw new Error('Unreachable effect kind: ' + String(value))
}

function stableTargets(value: PieceInstance | readonly PieceInstance[]): readonly PieceInstance[] {
  return Object.freeze(Array.isArray(value) ? [...value] : [value])
}

function freezeRequest<TRequest extends EffectRequest>(request: TRequest): TRequest {
  switch (request.kind) {
    case 'damage':
      return Object.freeze({ ...request, targets: Object.freeze([...request.targets]) }) as unknown as TRequest
    case 'heal':
      return Object.freeze({ ...request, targets: Object.freeze([...request.targets]) }) as unknown as TRequest
    case 'summon':
      return Object.freeze({
        ...request,
        summons: Object.freeze(request.summons.map(summon => Object.freeze({ ...summon }))),
      }) as unknown as TRequest
    case 'death':
      return Object.freeze({
        ...request,
        candidates: Object.freeze(request.candidates.map(candidate => Object.freeze({ ...candidate }))),
      }) as unknown as TRequest
    default:
      return assertNever(request)
  }
}

function requestDiagnostics(request: EffectRequest): EffectDispatchMetadata {
  switch (request.kind) {
    case 'damage': {
      const targetIds = request.targets.map(target => target.instanceId)
      return {
        kind: request.kind,
        sourceId: request.attacker.instanceId,
        skillId: request.skillId,
        targetId: targetIds[0],
        targetIds,
      }
    }
    case 'heal': {
      const targetIds = request.targets.map(target => target.instanceId)
      return {
        kind: request.kind,
        sourceId: request.healer.instanceId,
        skillId: request.skillId,
        targetId: targetIds[0],
        targetIds,
      }
    }
    case 'summon':
      return { kind: request.kind, sourceId: request.sourceId, skillId: request.skillId }
    case 'death': {
      const targetIds = request.candidates.map(candidate => candidate.piece.instanceId)
      const first = request.candidates[0]
      return {
        kind: request.kind,
        sourceId: first?.attacker?.instanceId,
        skillId: first?.skillId,
        targetId: targetIds[0],
        targetIds,
      }
    }
    default:
      return assertNever(request)
  }
}

function normalizeLimit(name: keyof EffectChainLimits, value: number | undefined): number {
  const maximum = DEFAULT_EFFECT_CHAIN_LIMITS[name]
  if (value === undefined) return maximum
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new BattleRuleError(
      'EffectChain ' + name + ' must be a positive integer no greater than ' + maximum,
      'RVB_EFFECT_CHAIN_CONFIG_INVALID',
    )
  }
  return value
}

function normalizeOptions(options: EffectChainOptions): EffectChainOptions & { limits: EffectChainLimits } {
  if (!options || !options.actionId || !options.chainId) {
    throw new BattleRuleError('EffectChain requires stable actionId and chainId', 'RVB_EFFECT_CHAIN_CONFIG_INVALID')
  }
  if (!Number.isSafeInteger(options.turn) || options.turn < 0) {
    throw new BattleRuleError('EffectChain turn must be a non-negative integer', 'RVB_EFFECT_CHAIN_CONFIG_INVALID')
  }
  if (options.rootSeed !== null && !Number.isSafeInteger(options.rootSeed)) {
    throw new BattleRuleError('EffectChain rootSeed must be an integer or null', 'RVB_EFFECT_CHAIN_CONFIG_INVALID')
  }
  return {
    ...options,
    limits: {
      maxDepth: normalizeLimit('maxDepth', options.limits?.maxDepth),
      maxBatches: normalizeLimit('maxBatches', options.limits?.maxBatches),
      maxDispatches: normalizeLimit('maxDispatches', options.limits?.maxDispatches),
    },
  }
}

export class EffectChain {
  readonly actionId: string
  readonly chainId: string
  readonly turn: number
  readonly rootSeed: number | null
  readonly detached: boolean
  readonly limits: Readonly<EffectChainLimits>

  private readonly createBatchId: (input: EffectBatchIdInput) => string
  private ledger: EffectLedgerEntry[] = []
  private ledgerHead = 0
  private batchStack: EffectBatchContext[] = []
  private recordLog: EffectChainRecord[] = []
  private nextEnqueueSequence = 0
  private nextBatchSequence = 0
  private batchCount = 0
  private dispatchCount = 0
  private currentState: EffectChainState = 'idle'
  private firstFatal?: EffectChainFatalError
  private firstPending?: SuspendableActionPending

  constructor(input: EffectChainOptions) {
    const options = normalizeOptions(input)
    this.actionId = options.actionId
    this.chainId = options.chainId
    this.turn = options.turn
    this.rootSeed = options.rootSeed
    this.detached = options.detached === true
    this.limits = Object.freeze({ ...options.limits })
    this.createBatchId = options.createBatchId ?? (metadata => (
      metadata.chainId + ':' + metadata.kind + ':' + metadata.batchSequence
    ))
  }

  get state(): EffectChainState {
    return this.currentState
  }

  get currentBatch(): EffectBatchContext | undefined {
    return this.batchStack[this.batchStack.length - 1]
  }

  get pendingCount(): number {
    return this.ledger.length - this.ledgerHead
  }

  get processedBatches(): number {
    return this.batchCount
  }

  get processedDispatches(): number {
    return this.dispatchCount
  }

  get records(): readonly EffectChainRecord[] {
    return this.recordLog.slice()
  }

  latchFatal(error: EffectChainFatalError): EffectChainFatalError {
    this.firstFatal ??= error
    return this.firstFatal
  }

  latchPending(error: SuspendableActionPending): SuspendableActionPending {
    this.firstPending ??= error
    return this.firstPending
  }

  assertHealthy(): void {
    if (this.firstFatal) throw this.firstFatal
    if (this.firstPending) throw this.firstPending
  }

  /**
   * Marks the exact latched suspension as handled by the root transaction.
   * A different pending signal cannot supersede the first one observed by the
   * chain, preserving deterministic replay order.
   */
  acknowledgePending(error: SuspendableActionPending): void {
    if (!this.firstPending) return
    if (this.firstPending !== error) throw this.firstPending
    this.firstPending = undefined
  }

  captureWriterBinding(): EffectWriterBinding {
    this.assertHealthy()
    const current = this.currentBatch
    return Object.freeze(current
      ? { parentBatchId: current.batchId, depth: current.depth + 1 }
      : { depth: 0 })
  }

  assertFacadeAllowed(kind: EffectBatchKind, metadata: EffectDispatchMetadata = {}): void {
    this.assertHealthy()
    this.assertKnownKind(kind, metadata)
    if (this.currentState === 'processing') {
      throw this.fatal(
        'RVB_EFFECT_CHAIN_REENTRANT',
        'Direct ' + kind + ' facade calls are forbidden while an EffectChain is processing',
        'state',
        this.batchCount,
        this.limits.maxBatches,
        { ...metadata, kind },
      )
    }
  }

  enqueue<TRequest extends EffectRequest>(
    unsafeRequest: TRequest,
    options: Partial<EffectWriterBinding> = {},
  ): EffectLedgerEntry<TRequest> {
    this.assertHealthy()
    this.assertRequestKind(unsafeRequest)
    const current = this.currentBatch
    const parentBatchId = options.parentBatchId ?? current?.batchId
    const depth = options.depth ?? (current ? current.depth + 1 : 0)
    let request: TRequest
    let diagnostics: EffectDispatchMetadata
    try {
      request = freezeRequest(unsafeRequest)
      diagnostics = requestDiagnostics(request)
    } catch (error) {
      throw this.fatal(
        'RVB_EFFECT_CHAIN_STATE_INVALID',
        'Effect request does not match the closed ' + unsafeRequest.kind + ' request shape',
        'state',
        this.batchCount,
        this.limits.maxBatches,
        { kind: unsafeRequest.kind, parentBatchId, depth },
        error,
      )
    }
    this.assertDepth(depth, { ...diagnostics, parentBatchId, depth })

    const enqueueSequence = this.nextEnqueueSequence
    const entry = Object.freeze({
      request,
      kind: request.kind,
      parentBatchId,
      depth,
      enqueueSequence,
    }) as EffectLedgerEntry<TRequest>
    this.nextEnqueueSequence += 1
    this.ledger.push(entry)
    this.recordLog.push(Object.freeze({ type: 'enqueue', ...entry }))
    return entry
  }

  enqueueMany<TRequest extends EffectRequest>(
    requests: readonly TRequest[],
    options: Partial<EffectWriterBinding> = {},
  ): readonly EffectLedgerEntry<TRequest>[] {
    this.assertHealthy()
    const checkpoint = this.snapshot()
    try {
      return requests.map(request => this.enqueue(request, options))
    } catch (error) {
      this.restore(checkpoint)
      throw error
    }
  }

  drain<TResult extends EffectHandlerResultMap>(
    handlers: EffectHandlers<TResult>,
  ): readonly EffectExecution<TResult[EffectBatchKind]>[] {
    this.assertHealthy()
    if (this.currentState === 'processing') {
      throw this.fatal(
        'RVB_EFFECT_CHAIN_REENTRANT',
        'EffectChain drain cannot be entered recursively; enqueue a typed follow-up instead',
        'state',
        this.batchCount,
        this.limits.maxBatches,
        this.currentBatch ?? {},
      )
    }
    if (this.pendingCount === 0) return []

    const checkpoint = this.snapshot()
    const executions: EffectExecution<TResult[EffectBatchKind]>[] = []
    this.currentState = 'processing'
    try {
      while (this.ledgerHead < this.ledger.length) {
        const entry = this.ledger[this.ledgerHead]
        this.ledgerHead += 1
        executions.push(this.executeQueued(entry, handlers))
      }
      this.ledger = []
      this.ledgerHead = 0
      return executions
    } catch (error) {
      const failedRecords = this.recordLog.slice()
      const failedBatch = [...failedRecords]
        .reverse()
        .find(record => record.type === 'batch:start')
      const pendingFailure = !this.detached && isEffectChainPendingSignal(error)
        ? error
        : undefined
      const failure = isEffectChainFatalError(error)
        ? this.latchFatal(error)
        : this.detached || isEffectChainPendingSignal(error)
          ? error
          : this.fatal(
              'RVB_EFFECT_CHAIN_BATCH_REJECTED',
              'Attached EffectChain batch execution failed',
              'state',
              this.batchCount,
              this.limits.maxBatches,
              failedBatch ?? {},
              error,
            )
      this.restore(checkpoint)
      if (pendingFailure) this.latchPending(pendingFailure)
      this.recordLog = failedRecords
      throw failure
    } finally {
      this.currentState = 'idle'
      this.batchStack = []
    }
  }

  runEndogenousDeath<TResult>(
    unsafeRequest: DeathRequest,
    originStage: 'damage:death',
    handler: (request: DeathRequest, context: EffectBatchContext<'death'>, chain: EffectChain) => TResult,
  ): TResult {
    this.assertHealthy()
    this.assertRequestKind(unsafeRequest)
    if (this.currentState !== 'processing' || !this.currentBatch) {
      throw this.fatal(
        'RVB_EFFECT_CHAIN_STATE_INVALID',
        'Endogenous DeathBatch requires an active parent batch',
        'state',
        this.batchCount,
        this.limits.maxBatches,
        { ...requestDiagnostics(unsafeRequest), originStage },
      )
    }
    const request = freezeRequest(unsafeRequest)
    const parent = this.currentBatch
    return this.executeBatch(
      {
        request,
        parentBatchId: parent.batchId,
        depth: parent.depth + 1,
        originStage,
      },
      context => handler(request, context as EffectBatchContext<'death'>, this),
    )
  }

  recordDispatch(metadata: EffectDispatchMetadata = {}, count = 1): void {
    this.assertHealthy()
    if (metadata.kind !== undefined) this.assertKnownKind(metadata.kind, metadata)
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw this.fatal(
        'RVB_EFFECT_CHAIN_STATE_INVALID',
        'Effect dispatch count must be a positive integer',
        'state',
        count,
        this.limits.maxDispatches,
        metadata,
      )
    }
    const attempted = this.dispatchCount + count
    if (attempted > this.limits.maxDispatches) {
      throw this.fatal(
        'RVB_EFFECT_CHAIN_DISPATCH_LIMIT',
        'EffectChain exceeded ' + this.limits.maxDispatches + ' effect/trigger dispatches',
        'dispatches',
        attempted,
        this.limits.maxDispatches,
        metadata,
      )
    }
    this.dispatchCount = attempted
    const current = this.currentBatch
    if (current) {
      this.recordLog.push(Object.freeze({
        type: 'dispatch',
        ...current,
        processedDispatches: this.dispatchCount,
      }))
    }
  }

  snapshot(): EffectChainSnapshot {
    return Object.freeze({
      version: 1 as const,
      actionId: this.actionId,
      chainId: this.chainId,
      detached: this.detached,
      state: this.currentState,
      ledger: Object.freeze(this.ledger.slice(this.ledgerHead)),
      processedBatches: this.batchCount,
      processedDispatches: this.dispatchCount,
      nextEnqueueSequence: this.nextEnqueueSequence,
      nextBatchSequence: this.nextBatchSequence,
      batchStack: Object.freeze(this.batchStack.slice()),
      records: Object.freeze(this.recordLog.slice()),
      pendingSignal: this.firstPending,
    })
  }

  restore(snapshot: EffectChainSnapshot): void {
    if (
      !snapshot
      || snapshot.version !== 1
      || snapshot.actionId !== this.actionId
      || snapshot.chainId !== this.chainId
      || snapshot.detached !== this.detached
      || (snapshot.state !== 'idle' && snapshot.state !== 'processing')
      || (snapshot.pendingSignal !== undefined && !isEffectChainPendingSignal(snapshot.pendingSignal))
    ) {
      throw this.fatal(
        'RVB_EFFECT_CHAIN_SNAPSHOT_INVALID',
        'EffectChain snapshot belongs to a different chain or has an unsupported version',
        'state',
        this.batchCount,
        this.limits.maxBatches,
        {},
      )
    }
    for (const entry of snapshot.ledger) this.assertRequestKind(entry.request)
    this.ledger = [...snapshot.ledger]
    this.ledgerHead = 0
    this.batchCount = snapshot.processedBatches
    this.dispatchCount = snapshot.processedDispatches
    this.nextEnqueueSequence = snapshot.nextEnqueueSequence
    this.nextBatchSequence = snapshot.nextBatchSequence
    this.batchStack = [...snapshot.batchStack]
    this.recordLog = [...snapshot.records]
    this.currentState = snapshot.state
    this.firstPending = snapshot.pendingSignal
  }

  private executeQueued<TResult extends EffectHandlerResultMap>(
    entry: EffectLedgerEntry,
    handlers: EffectHandlers<TResult>,
  ): EffectExecution<TResult[EffectBatchKind]> {
    const input = {
      request: entry.request,
      parentBatchId: entry.parentBatchId,
      depth: entry.depth,
      enqueueSequence: entry.enqueueSequence,
    }
    switch (entry.request.kind) {
      case 'damage':
        return this.executeBatch(input as InternalBatchInput<DamageRequest>, context => ({
          kind: 'damage',
          request: entry.request,
          context,
          result: handlers.damage(entry.request as DamageRequest, context, this),
        }))
      case 'heal':
        return this.executeBatch(input as InternalBatchInput<HealRequest>, context => ({
          kind: 'heal',
          request: entry.request,
          context,
          result: handlers.heal(entry.request as HealRequest, context, this),
        }))
      case 'summon':
        return this.executeBatch(input as InternalBatchInput<SummonRequest>, context => ({
          kind: 'summon',
          request: entry.request,
          context,
          result: handlers.summon(entry.request as SummonRequest, context, this),
        }))
      case 'death':
        return this.executeBatch(input as InternalBatchInput<DeathRequest>, context => ({
          kind: 'death',
          request: entry.request,
          context,
          result: handlers.death(entry.request as DeathRequest, context, this),
        }))
      default:
        return assertNever(entry.request)
    }
  }

  private executeBatch<TRequest extends EffectRequest, TResult>(
    input: InternalBatchInput<TRequest>,
    execute: (context: EffectBatchContext<TRequest['kind']>) => TResult,
  ): TResult {
    this.assertRequestKind(input.request)
    const metadata = {
      ...requestDiagnostics(input.request),
      parentBatchId: input.parentBatchId,
      depth: input.depth,
      enqueueSequence: input.enqueueSequence,
      originStage: input.originStage,
    }
    this.assertDepth(input.depth, metadata)

    const batchSequence = this.nextBatchSequence
    const batchId = this.createBatchId({
      actionId: this.actionId,
      chainId: this.chainId,
      kind: input.request.kind,
      batchSequence,
      parentBatchId: input.parentBatchId,
      depth: input.depth,
      enqueueSequence: input.enqueueSequence,
      originStage: input.originStage,
    })
    if (typeof batchId !== 'string' || !batchId) {
      throw this.fatal(
        'RVB_EFFECT_CHAIN_STATE_INVALID',
        'EffectChain batch ID factory returned an invalid ID',
        'state',
        batchSequence,
        this.limits.maxBatches,
        metadata,
      )
    }
    const diagnosticMetadata = { ...metadata, batchId }

    const attemptedBatch = this.batchCount + 1
    if (attemptedBatch > this.limits.maxBatches) {
      throw this.fatal(
        'RVB_EFFECT_CHAIN_BATCH_LIMIT',
        'EffectChain exceeded ' + this.limits.maxBatches + ' batches',
        'batches',
        attemptedBatch,
        this.limits.maxBatches,
        diagnosticMetadata,
      )
    }
    const attemptedDispatch = this.dispatchCount + 1
    if (attemptedDispatch > this.limits.maxDispatches) {
      throw this.fatal(
        'RVB_EFFECT_CHAIN_DISPATCH_LIMIT',
        'EffectChain exceeded ' + this.limits.maxDispatches + ' effect/trigger dispatches',
        'dispatches',
        attemptedDispatch,
        this.limits.maxDispatches,
        diagnosticMetadata,
      )
    }

    const context = Object.freeze({
      actionId: this.actionId,
      chainId: this.chainId,
      batchId,
      parentBatchId: input.parentBatchId,
      kind: input.request.kind,
      depth: input.depth,
      enqueueSequence: input.enqueueSequence,
      originStage: input.originStage,
      turn: this.turn,
      rootSeed: this.rootSeed,
      detached: this.detached,
    }) as EffectBatchContext<TRequest['kind']>

    this.nextBatchSequence += 1
    this.batchCount = attemptedBatch
    this.dispatchCount = attemptedDispatch
    this.batchStack.push(context)
    this.recordLog.push(Object.freeze({ type: 'batch:start', ...context }))
    try {
      return execute(context)
    } catch (error) {
      if (isEffectChainFatalError(error)) throw this.latchFatal(error)
      if (this.detached || isEffectChainPendingSignal(error)) throw error
      throw rejectEffectBatch(
        this,
        context,
        'Effect ' + input.request.kind + ' batch handler failed',
        error,
        requestDiagnostics(input.request),
      )
    } finally {
      const popped = this.batchStack.pop()
      if (popped !== context) {
        throw this.fatal(
          'RVB_EFFECT_CHAIN_STATE_INVALID',
          'EffectChain batch stack was corrupted',
          'state',
          this.batchCount,
          this.limits.maxBatches,
          context,
        )
      }
      this.recordLog.push(Object.freeze({ type: 'batch:finish', ...context }))
    }
  }

  private assertRequestKind(request: unknown): asserts request is EffectRequest {
    const kind = request && typeof request === 'object'
      ? (request as { kind?: unknown }).kind
      : undefined
    this.assertKnownKind(kind, { kind: typeof kind === 'string' ? kind : null })
  }

  private assertKnownKind(kind: unknown, metadata: FatalMetadata): asserts kind is EffectBatchKind {
    if (isEffectBatchKind(kind)) return
    const rawKind = typeof kind === 'string' ? kind : null
    throw this.fatal(
      'RVB_EFFECT_CHAIN_UNKNOWN_KIND',
      'Effect request kind ' + String(kind) + ' is not in the ADR-0022 whitelist',
      'kind',
      this.batchCount,
      EFFECT_BATCH_KINDS.length,
      { ...metadata, kind: rawKind },
    )
  }

  private assertDepth(depth: number, metadata: FatalMetadata): void {
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > this.limits.maxDepth) {
      throw this.fatal(
        'RVB_EFFECT_CHAIN_DEPTH_LIMIT',
        'EffectChain batch depth ' + String(depth) + ' exceeds ' + this.limits.maxDepth,
        'depth',
        depth,
        this.limits.maxDepth,
        metadata,
      )
    }
  }

  private fatal(
    code: EffectChainFatalCode,
    message: string,
    budget: EffectChainBudget,
    processed: number,
    limit: number,
    metadata: FatalMetadata,
    cause?: unknown,
  ): EffectChainFatalError {
    const current = this.currentBatch
    return this.latchFatal(new EffectChainFatalError(code, message, {
      actionId: this.actionId,
      chainId: this.chainId,
      batchId: metadata.batchId ?? current?.batchId,
      parentBatchId: metadata.parentBatchId ?? current?.parentBatchId,
      kind: metadata.kind ?? current?.kind ?? null,
      depth: metadata.depth ?? current?.depth ?? null,
      enqueueSequence: metadata.enqueueSequence ?? current?.enqueueSequence,
      originStage: metadata.originStage ?? current?.originStage,
      processed,
      limit,
      turn: this.turn,
      rootSeed: this.rootSeed,
      sourceId: metadata.sourceId,
      skillId: metadata.skillId,
      targetId: metadata.targetId,
      targetIds: metadata.targetIds,
      detached: this.detached,
      budget,
    }, cause))
  }
}

export function createEffectChain(options: EffectChainOptions): EffectChain {
  return new EffectChain(options)
}

function effectWriterFatal(
  chain: EffectChain,
  binding: EffectWriterBinding,
  kind: EffectBatchKind,
  message: string,
  cause: unknown,
  metadata: EffectDispatchMetadata = {},
): EffectChainFatalError {
  if (isEffectChainFatalError(cause)) return chain.latchFatal(cause)
  return chain.latchFatal(new EffectChainFatalError(
    kind === 'summon'
      ? 'RVB_EFFECT_CHAIN_SUMMON_CAPABILITY'
      : 'RVB_EFFECT_CHAIN_STATE_INVALID',
    message,
    {
      actionId: chain.actionId,
      chainId: chain.chainId,
      batchId: chain.chainId + ':' + kind + ':writer-rejected',
      parentBatchId: binding.parentBatchId,
      kind,
      depth: binding.depth,
      originStage: 'writer:validation',
      processed: chain.processedBatches,
      limit: chain.limits.maxBatches,
      turn: chain.turn,
      rootSeed: chain.rootSeed,
      sourceId: metadata.sourceId,
      skillId: metadata.skillId,
      targetId: metadata.targetId,
      targetIds: metadata.targetIds,
      detached: chain.detached,
      budget: 'binding',
    },
    cause,
  ))
}

function bindWriter<TInput, TRequest extends EffectRequest>(
  chain: EffectChain,
  kind: TRequest['kind'],
  createRequest: (input: TInput) => TRequest,
): EffectQueueWriter<TInput> {
  const binding = chain.captureWriterBinding()
  return Object.freeze({
    push: (...inputs: readonly TInput[]) => {
      const checkpoint = chain.snapshot()
      try {
        const requests = inputs.map(input => createRequest(input))
        chain.enqueueMany(requests, binding)
        return chain.pendingCount
      } catch (error) {
        const fatal = isEffectChainFatalError(error)
        chain.restore(checkpoint)
        if (fatal) throw chain.latchFatal(error as EffectChainFatalError)
        throw effectWriterFatal(
          chain,
          binding,
          kind,
          'Malformed ' + kind + ' queue request',
          error,
        )
      }
    },
  })
}

export function createDamageQueueWriter(chain: EffectChain): DamageQueueWriter {
  return bindWriter(chain, 'damage', input => ({
    kind: 'damage',
    attacker: input.attacker,
    targets: stableTargets(input.target),
    baseDamage: input.damage,
    damageType: input.damageType,
    skillId: input.skillId,
    killerPlayerId: input.killerPlayerId,
    selectedOption: input.selectedOption,
  }))
}

export function createHealQueueWriter(chain: EffectChain): HealQueueWriter {
  return bindWriter(chain, 'heal', input => ({
    kind: 'heal',
    healer: input.healer,
    targets: stableTargets(input.target),
    baseHeal: input.heal,
    skillId: input.skillId,
  }))
}

function isRuntimeRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyRuntimeKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function capabilityError(message: string): never {
  throw new TypeError(message)
}

function assertCapabilityKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  if (!hasOnlyRuntimeKeys(value, allowed)) {
    capabilityError(label + ' contains fields outside the closed capability schema')
  }
}

function readCapabilityString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    capabilityError(label + ' must be a non-empty string')
  }
  return value
}

function readCapabilityNumber(
  value: unknown,
  label: string,
  options: { integer?: boolean; minimum?: number } = {},
): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || (options.integer && !Number.isSafeInteger(value))
    || (options.minimum !== undefined && value < options.minimum)
  ) {
    capabilityError(label + ' is outside the supported numeric range')
  }
  return value
}

function readCapabilityBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') capabilityError(label + ' must be boolean')
  return value
}

function readCapabilityStrings(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean } = {},
): readonly string[] {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
    capabilityError(label + ' must be a non-empty string array')
  }
  const strings = value.map((entry, index) => (
    readCapabilityString(entry, label + '[' + String(index) + ']')
  ))
  if (new Set(strings).size !== strings.length) {
    capabilityError(label + ' must not contain duplicates')
  }
  return Object.freeze(strings)
}

function parseSourceMirrorStatus(
  value: unknown,
  rules: readonly string[],
): SourceMirrorStatusDeclaration {
  if (!isRuntimeRecord(value)) capabilityError('source-mirror status must be a plain object')
  assertCapabilityKeys(value, [
    'idPrefix',
    'name',
    'type',
    'visible',
    'remainingDuration',
    'remainingUses',
    'intensity',
    'stacks',
    'relatedRules',
  ], 'source-mirror status')
  const relatedRules = readCapabilityStrings(value.relatedRules, 'source-mirror status.relatedRules')
  if (
    relatedRules.length !== rules.length
    || relatedRules.some((ruleId, index) => ruleId !== rules[index])
  ) {
    capabilityError('source-mirror status.relatedRules must exactly match capability rules')
  }
  return Object.freeze({
    idPrefix: readCapabilityString(value.idPrefix, 'source-mirror status.idPrefix'),
    name: readCapabilityString(value.name, 'source-mirror status.name'),
    type: readCapabilityString(value.type, 'source-mirror status.type'),
    visible: readCapabilityBoolean(value.visible, 'source-mirror status.visible'),
    remainingDuration: readCapabilityNumber(
      value.remainingDuration,
      'source-mirror status.remainingDuration',
      { integer: true },
    ),
    remainingUses: readCapabilityNumber(
      value.remainingUses,
      'source-mirror status.remainingUses',
      { integer: true },
    ),
    intensity: readCapabilityNumber(value.intensity, 'source-mirror status.intensity'),
    stacks: readCapabilityNumber(
      value.stacks,
      'source-mirror status.stacks',
      { integer: true, minimum: 1 },
    ),
    relatedRules,
  })
}

function parseSourceMirrorCapability(
  value: Record<string, unknown>,
): SourceMirrorSummonCapabilityDeclaration {
  assertCapabilityKeys(value, [
    'version',
    'recipe',
    'maxSummons',
    'allowedVariants',
    'instanceIdPrefix',
    'maxHp',
    'attack',
    'defense',
    'moveRange',
    'noKillCharge',
    'resetBoundSkillCooldown',
    'rules',
    'status',
  ], 'source-mirror capability')
  const rules = readCapabilityStrings(value.rules, 'source-mirror rules')
  const capability = Object.freeze({
    version: 1 as const,
    recipe: 'source-mirror' as const,
    maxSummons: readCapabilityNumber(
      value.maxSummons,
      'source-mirror maxSummons',
      { integer: true, minimum: 1 },
    ),
    allowedVariants: readCapabilityStrings(
      value.allowedVariants,
      'source-mirror allowedVariants',
    ),
    instanceIdPrefix: readCapabilityString(
      value.instanceIdPrefix,
      'source-mirror instanceIdPrefix',
    ),
    maxHp: readCapabilityNumber(value.maxHp, 'source-mirror maxHp', { minimum: 1 }),
    attack: readCapabilityNumber(value.attack, 'source-mirror attack', { minimum: 0 }),
    defense: readCapabilityNumber(value.defense, 'source-mirror defense', { minimum: 0 }),
    moveRange: readCapabilityNumber(
      value.moveRange,
      'source-mirror moveRange',
      { minimum: 0 },
    ),
    noKillCharge: readCapabilityBoolean(
      value.noKillCharge,
      'source-mirror noKillCharge',
    ),
    resetBoundSkillCooldown: readCapabilityBoolean(
      value.resetBoundSkillCooldown,
      'source-mirror resetBoundSkillCooldown',
    ),
    rules,
    status: parseSourceMirrorStatus(value.status, rules),
  })
  if (capability.maxSummons > 16 || capability.allowedVariants.length > 16) {
    capabilityError('source-mirror capability exceeds the sealed collection limit')
  }
  return capability
}

function parseDeclaredPieceSkills(value: unknown): readonly DeclaredPieceSkillDeclaration[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    capabilityError('stored piece fallback.skills must contain 1 to 32 declarations')
  }
  const skills = value.map((entry, index) => {
    if (!isRuntimeRecord(entry)) {
      capabilityError('stored piece fallback.skills[' + String(index) + '] must be a plain object')
    }
    assertCapabilityKeys(
      entry,
      ['skillId', 'level', 'currentCooldown'],
      'stored piece fallback skill',
    )
    return Object.freeze({
      skillId: readCapabilityString(
        entry.skillId,
        'stored piece fallback skill.skillId',
      ),
      level: readCapabilityNumber(
        entry.level,
        'stored piece fallback skill.level',
        { integer: true, minimum: 1 },
      ),
      currentCooldown: readCapabilityNumber(
        entry.currentCooldown,
        'stored piece fallback skill.currentCooldown',
        { integer: true, minimum: 0 },
      ),
    })
  })
  if (new Set(skills.map(skill => skill.skillId)).size !== skills.length) {
    capabilityError('stored piece fallback.skills must not contain duplicate skillId values')
  }
  return Object.freeze(skills)
}

function parseStoredPieceFallback(value: unknown): StoredPieceFallbackDeclaration {
  if (!isRuntimeRecord(value)) {
    capabilityError('stored piece fallback must be a plain object')
  }
  assertCapabilityKeys(value, [
    'instanceIdPrefix',
    'templateId',
    'name',
    'faction',
    'maxHp',
    'attack',
    'defense',
    'moveRange',
    'skills',
  ], 'stored piece fallback')
  if (value.faction !== 'red' && value.faction !== 'blue') {
    capabilityError('stored piece fallback.faction must be red or blue')
  }
  return Object.freeze({
    instanceIdPrefix: readCapabilityString(
      value.instanceIdPrefix,
      'stored piece fallback.instanceIdPrefix',
    ),
    templateId: readCapabilityString(
      value.templateId,
      'stored piece fallback.templateId',
    ),
    name: readCapabilityString(value.name, 'stored piece fallback.name'),
    faction: value.faction,
    maxHp: readCapabilityNumber(value.maxHp, 'stored piece fallback.maxHp', { minimum: 1 }),
    attack: readCapabilityNumber(value.attack, 'stored piece fallback.attack', { minimum: 0 }),
    defense: readCapabilityNumber(value.defense, 'stored piece fallback.defense', { minimum: 0 }),
    moveRange: readCapabilityNumber(
      value.moveRange,
      'stored piece fallback.moveRange',
      { minimum: 0 },
    ),
    skills: parseDeclaredPieceSkills(value.skills),
  })
}

function parseStoredPieceCapability(
  value: Record<string, unknown>,
): StoredOrDeclaredPieceSummonCapabilityDeclaration {
  assertCapabilityKeys(value, [
    'version',
    'recipe',
    'maxSummons',
    'storageExtensionKey',
    'uniqueTemplateId',
    'fallback',
  ], 'stored-or-declared-piece capability')
  const storageExtensionKey = readCapabilityString(
    value.storageExtensionKey,
    'stored-or-declared-piece storageExtensionKey',
  )
  if (
    !/^[A-Za-z][A-Za-z0-9_]*$/.test(storageExtensionKey)
    || storageExtensionKey === '__proto__'
    || storageExtensionKey === 'prototype'
    || storageExtensionKey === 'constructor'
  ) {
    capabilityError('stored-or-declared-piece storageExtensionKey is unsafe')
  }
  const fallback = parseStoredPieceFallback(value.fallback)
  const uniqueTemplateId = readCapabilityString(
    value.uniqueTemplateId,
    'stored-or-declared-piece uniqueTemplateId',
  )
  if (uniqueTemplateId !== fallback.templateId) {
    capabilityError('stored-or-declared-piece uniqueTemplateId must match fallback.templateId')
  }
  const maxSummons = readCapabilityNumber(
    value.maxSummons,
    'stored-or-declared-piece maxSummons',
    { integer: true, minimum: 1 },
  )
  if (maxSummons !== 1) {
    capabilityError('stored-or-declared-piece maxSummons must be exactly 1')
  }
  return Object.freeze({
    version: 1 as const,
    recipe: 'stored-or-declared-piece' as const,
    maxSummons,
    storageExtensionKey,
    uniqueTemplateId,
    fallback,
  })
}

const TRUSTED_DECLARED_SUMMON_CAPABILITIES = new WeakSet<object>()
const DECLARED_SUMMON_CAPABILITY_CONTENT_IDS = new WeakMap<object, string>()

function parseSummonCapability(
  value: unknown,
  contentId: string,
): DeclaredSummonCapability {
  if (!isRuntimeRecord(value)) {
    capabilityError('summonCapability must be a plain object')
  }
  if (value.version !== 1) capabilityError('summonCapability.version must be 1')
  const capability = value.recipe === 'source-mirror'
    ? parseSourceMirrorCapability(value)
    : value.recipe === 'stored-or-declared-piece'
      ? parseStoredPieceCapability(value)
      : capabilityError('summonCapability.recipe is not supported')
  DECLARED_SUMMON_CAPABILITY_CONTENT_IDS.set(capability, contentId)
  TRUSTED_DECLARED_SUMMON_CAPABILITIES.add(capability)
  return capability
}

export function isTrustedDeclaredSummonCapability(
  value: unknown,
): value is DeclaredSummonCapability {
  return isRuntimeRecord(value) && TRUSTED_DECLARED_SUMMON_CAPABILITIES.has(value)
}

export function isDeclaredSummonCapabilityBoundToContent(
  value: unknown,
  contentId: string,
): value is DeclaredSummonCapability {
  return isTrustedDeclaredSummonCapability(value)
    && DECLARED_SUMMON_CAPABILITY_CONTENT_IDS.get(value) === contentId
}

function templateSummonSpecError(value: unknown): string | undefined {
  if (!isRuntimeRecord(value)) return 'Template summon spec must be a plain object'
  if (!Number.isSafeInteger(value.x) || !Number.isSafeInteger(value.y)) {
    return 'Template summon spec coordinates must be finite integers'
  }
  if (value.recipe !== 'template') return 'Only template recipe is allowed for internal summon'
  if (!hasOnlyRuntimeKeys(value, [
    'recipe', 'templateId', 'ownerPlayerId', 'faction', 'x', 'y', 'index',
  ])) return 'Template summon spec contains fields outside the sealed recipe'
  if (typeof value.templateId !== 'string' || value.templateId.length === 0) {
    return 'Template summon requires a stable templateId'
  }
  if (typeof value.ownerPlayerId !== 'string' || value.ownerPlayerId.length === 0) {
    return 'Template summon requires a stable ownerPlayerId'
  }
  if (value.faction !== 'red' && value.faction !== 'blue') {
    return 'Template summon faction must be red or blue'
  }
  if (value.index !== undefined && (!Number.isSafeInteger(value.index) || Number(value.index) < 1)) {
    return 'Template summon index must be a positive integer'
  }
  return undefined
}

function templateSummonQueueError(value: unknown): string | undefined {
  if (!isRuntimeRecord(value)) return 'Template summon queue request must be a plain object'
  if (!hasOnlyRuntimeKeys(value, ['summons', 'sourceId', 'skillId'])) {
    return 'Template summon queue request contains fields outside the sealed capability'
  }
  if (!Array.isArray(value.summons) || value.summons.length === 0) {
    return 'Template summon queue request must contain at least one summon spec'
  }
  if (value.sourceId !== undefined && typeof value.sourceId !== 'string') {
    return 'Template summon queue sourceId must be a string when provided'
  }
  if (value.skillId !== undefined && typeof value.skillId !== 'string') {
    return 'Template summon queue skillId must be a string when provided'
  }
  for (const summon of value.summons) {
    const error = templateSummonSpecError(summon)
    if (error) return error
  }
  return undefined
}

export function createSummonQueueWriter(
  chain: EffectChain,
  contentId: 'internal:template',
): SummonQueueWriter {
  const binding = chain.captureWriterBinding()
  if (contentId !== 'internal:template') {
    throw effectWriterFatal(
      chain,
      binding,
      'summon',
      'Internal summon writer rejects an unknown capability',
      new TypeError('Unknown internal summon capability'),
    )
  }
  return Object.freeze({
    push: (...inputs: readonly SummonQueueRequest[]) => {
      const checkpoint = chain.snapshot()
      try {
        const requests = inputs.map(unsafeInput => {
          const validationError = templateSummonQueueError(unsafeInput)
          const record: Record<string, unknown> = isRuntimeRecord(unsafeInput) ? unsafeInput : {}
          if (validationError) {
            throw effectWriterFatal(
              chain,
              binding,
              'summon',
              validationError,
              new TypeError(validationError),
              {
                sourceId: typeof record.sourceId === 'string' ? record.sourceId : undefined,
                skillId: typeof record.skillId === 'string' ? record.skillId : undefined,
              },
            )
          }
          const input = unsafeInput as SummonQueueRequest
          return {
            kind: 'summon' as const,
            contentId,
            summons: input.summons,
            sourceId: input.sourceId,
            skillId: input.skillId,
          }
        })
        chain.enqueueMany(requests, binding)
        return chain.pendingCount
      } catch (error) {
        const fatal = isEffectChainFatalError(error)
        chain.restore(checkpoint)
        if (fatal) throw chain.latchFatal(error as EffectChainFatalError)
        throw effectWriterFatal(
          chain,
          binding,
          'summon',
          'Malformed template summon queue request',
          error,
        )
      }
    },
  })
}

function declaredSummonQueueError(
  capability: DeclaredSummonCapability,
  value: unknown,
): string | undefined {
  if (!isRuntimeRecord(value)) return 'Declared summon queue request must be a plain object'
  if (!hasOnlyRuntimeKeys(value, ['sourceId', 'summons'])) {
    return 'Declared summon queue request contains fields outside the sealed capability'
  }
  if (typeof value.sourceId !== 'string' || value.sourceId.length === 0) {
    return 'Declared summon queue sourceId must be a non-empty string'
  }
  if (
    !Array.isArray(value.summons)
    || value.summons.length === 0
    || value.summons.length > capability.maxSummons
  ) {
    return 'Declared summon queue request exceeds its bound batch size'
  }
  for (const summon of value.summons) {
    if (!isRuntimeRecord(summon)) return 'Declared summon spec must be a plain object'
    if (!hasOnlyRuntimeKeys(summon, ['x', 'y', 'variant'])) {
      return 'Declared summon spec contains fields outside the sealed call schema'
    }
    if (!Number.isSafeInteger(summon.x) || !Number.isSafeInteger(summon.y)) {
      return 'Declared summon spec coordinates must be finite integers'
    }
    if (capability.recipe === 'source-mirror') {
      if (
        typeof summon.variant !== 'string'
        || !capability.allowedVariants.includes(summon.variant)
      ) {
        return 'Declared summon variant is not allowed by its bound capability'
      }
    } else if (summon.variant !== undefined) {
      return 'Stored-piece summon does not accept a variant'
    }
  }
  return undefined
}

export function createDeclaredSummonQueueWriter(
  chain: EffectChain,
  contentId: string,
  declaration: unknown,
): DeclaredSummonQueueWriter {
  const binding = chain.captureWriterBinding()
  let capability: DeclaredSummonCapability
  try {
    if (!contentId) capabilityError('Declared summon contentId must be non-empty')
    capability = parseSummonCapability(declaration, contentId)
  } catch (error) {
    throw effectWriterFatal(
      chain,
      binding,
      'summon',
      'Invalid declared summon capability',
      error,
      { skillId: contentId || undefined },
    )
  }

  return Object.freeze({
    push: (...inputs: readonly DeclaredSummonQueueRequest[]) => {
      const checkpoint = chain.snapshot()
      try {
        const requests = inputs.map(unsafeInput => {
          const validationError = declaredSummonQueueError(capability, unsafeInput)
          const record: Record<string, unknown> = isRuntimeRecord(unsafeInput) ? unsafeInput : {}
          if (validationError) {
            throw effectWriterFatal(
              chain,
              binding,
              'summon',
              validationError,
              new TypeError(validationError),
              {
                sourceId: typeof record.sourceId === 'string' ? record.sourceId : undefined,
                skillId: contentId,
              },
            )
          }
          const input = unsafeInput as DeclaredSummonQueueRequest
          return {
            kind: 'summon' as const,
            contentId,
            capability,
            summons: input.summons.map(summon => ({
              x: summon.x,
              y: summon.y,
              ...(summon.variant === undefined ? {} : { variant: summon.variant }),
            })),
            sourceId: input.sourceId,
            skillId: contentId,
          }
        })
        chain.enqueueMany(requests, binding)
        return chain.pendingCount
      } catch (error) {
        const fatal = isEffectChainFatalError(error)
        chain.restore(checkpoint)
        if (fatal) throw chain.latchFatal(error as EffectChainFatalError)
        throw effectWriterFatal(
          chain,
          binding,
          'summon',
          'Malformed declared summon queue request',
          error,
          { skillId: contentId },
        )
      }
    },
  })
}

/** Internal engine surface only. Do not expose this writer to SkillCode. */
export function createInternalDeathQueueWriter(chain: EffectChain): DeathQueueWriter {
  return bindWriter(chain, 'death', input => ({ kind: 'death', candidates: input.candidates }))
}

const ACTIVE_EFFECT_CHAINS = new WeakMap<object, EffectChain>()
const EFFECT_CHAIN_SCOPES = new Map<EffectChain, Set<object>>()

export function getActiveEffectChain(scope: object): EffectChain | undefined {
  return ACTIVE_EFFECT_CHAINS.get(scope)
}

export function uninstallEffectChain(scope: object, expected?: EffectChain): void {
  const active = ACTIVE_EFFECT_CHAINS.get(scope)
  if (!active) return
  if (expected && active !== expected) return
  ACTIVE_EFFECT_CHAINS.delete(scope)
  const scopes = EFFECT_CHAIN_SCOPES.get(active)
  scopes?.delete(scope)
  if (scopes?.size === 0) EFFECT_CHAIN_SCOPES.delete(active)
}

export function uninstallEffectChainScopes(chain: EffectChain): void {
  const scopes = EFFECT_CHAIN_SCOPES.get(chain)
  if (!scopes) return
  for (const scope of scopes) {
    if (ACTIVE_EFFECT_CHAINS.get(scope) === chain) ACTIVE_EFFECT_CHAINS.delete(scope)
  }
  EFFECT_CHAIN_SCOPES.delete(chain)
}

export function installEffectChain(scope: object, chain: EffectChain): () => void {
  const active = ACTIVE_EFFECT_CHAINS.get(scope)
  if (active && active !== chain) {
    throw new BattleRuleError(
      'EffectChain ' + active.chainId + ' is already installed for this action scope',
      'RVB_EFFECT_CHAIN_ALREADY_ACTIVE',
    )
  }
  ACTIVE_EFFECT_CHAINS.set(scope, chain)
  const scopes = EFFECT_CHAIN_SCOPES.get(chain) ?? new Set<object>()
  scopes.add(scope)
  EFFECT_CHAIN_SCOPES.set(chain, scopes)
  let installed = true
  return () => {
    if (!installed) return
    installed = false
    uninstallEffectChain(scope, chain)
  }
}

export function withEffectChain<TResult>(scope: object, chain: EffectChain, execute: () => TResult): TResult {
  const ownsScopeBoundary = !EFFECT_CHAIN_SCOPES.has(chain)
  const cleanup = installEffectChain(scope, chain)
  try {
    return execute()
  } finally {
    if (ownsScopeBoundary) uninstallEffectChainScopes(chain)
    else cleanup()
  }
}
