import type { RuleRuntimeSnapshot } from './rule-runtime'

export const SUSPENDABLE_ACTION_TRANSACTION_PROTOCOL_VERSION = 1

export type SuspendableInteractionConsumerKind = 'rule' | 'reactiveCard' | 'skill' | 'card'

export interface SuspendableInteractionKey {
  consumerKind: SuspendableInteractionConsumerKind
  consumerId: string
  sourceId?: string
  eventType?: string
  consumerOrdinal: number
}

export interface SuspendableInteractionInput {
  selectedOption?: unknown
  cancelled?: boolean
  targetPieceId?: string
  targetX?: number
  targetY?: number
  selectedTargets?: unknown[]
  /** Internal deterministic-stream bound used by timeout auto-resolution replay. */
  timeoutRandomBound?: number
}

export interface SuspendableInteractionAnswer {
  key: SuspendableInteractionKey
  input: SuspendableInteractionInput
}
export interface SuspendableTurnCheckpoint {
  currentPlayerId: string
  turnNumber: number
  phase: string
}


export interface SuspendableInteractionPrompt {
  kind: 'option' | 'target'
  playerId?: string
  title?: string
  options?: unknown[]
  canCancel?: boolean
  cancelValue?: unknown
  targetType?: string
  range?: number
  filter?: string
  suspendedTurn?: SuspendableTurnCheckpoint
  sourcePieceId?: string
  /** Server-private, candidate-only snapshot of the suspended provisional state. */
  candidateState?: unknown
}

export interface SuspendableActionRuntimeCheckpoint {
  rootSeed: number
  tick: number
  snapshot: RuleRuntimeSnapshot
}

export interface SuspendableActionTransaction {
  protocolVersion: typeof SUSPENDABLE_ACTION_TRANSACTION_PROTOCOL_VERSION
  rootAction: unknown
  baseTargetingRevision: number
  answers: SuspendableInteractionAnswer[]
  currentInteraction?: SuspendableInteractionKey
  runtimeCheckpoint?: SuspendableActionRuntimeCheckpoint
}

export class SuspendableActionReplayError extends Error {
  readonly code = 'SUSPENDABLE_ACTION_REPLAY_MISMATCH'

  constructor(message: string) {
    super(message)
    this.name = 'SuspendableActionReplayError'
  }
}

export class SuspendableActionPending extends Error {
  readonly code = 'SUSPENDABLE_ACTION_PENDING'

  constructor(
    readonly key: SuspendableInteractionKey,
    readonly prompt: SuspendableInteractionPrompt,
  ) {
    super(`Suspendable action requires ${prompt.kind} input from ${key.consumerKind}:${key.consumerId}`)
    this.name = 'SuspendableActionPending'
  }
}

function sameKey(left: SuspendableInteractionKey, right: SuspendableInteractionKey): boolean {
  return left.consumerKind === right.consumerKind
    && left.consumerId === right.consumerId
    && left.sourceId === right.sourceId
    && left.eventType === right.eventType
    && left.consumerOrdinal === right.consumerOrdinal
}

export class SuspendableActionRuntime {
  private answerCursor = 0
  private consumerOrdinal = 0

  constructor(private readonly answers: readonly SuspendableInteractionAnswer[]) {}

  enterConsumer(
    input: Omit<SuspendableInteractionKey, 'consumerOrdinal'>,
  ): SuspendableInteractionKey {
    const key = { ...input, consumerOrdinal: this.consumerOrdinal }
    this.consumerOrdinal += 1
    return key
  }

  takeAnswer(key: SuspendableInteractionKey): SuspendableInteractionInput | undefined {
    const answer = this.answers[this.answerCursor]
    if (!answer || !sameKey(answer.key, key)) return undefined
    this.answerCursor += 1
    return { ...answer.input }
  }

  suspend(
    key: SuspendableInteractionKey,
    prompt: SuspendableInteractionPrompt,
  ): never {
    const unconsumed = this.answers[this.answerCursor]
    if (unconsumed) {
      throw new SuspendableActionReplayError(
        `Expected ${formatKey(unconsumed.key)}, but replay requested ${formatKey(key)}`,
      )
    }
    throw new SuspendableActionPending(key, prompt)
  }

  assertReplayComplete(): void {
    const unconsumed = this.answers[this.answerCursor]
    if (!unconsumed) return
    throw new SuspendableActionReplayError(
      `Replay completed before consuming ${formatKey(unconsumed.key)}`,
    )
  }
}

function formatKey(key: SuspendableInteractionKey): string {
  return [
    key.consumerKind,
    key.consumerId,
    key.sourceId || '-',
    key.eventType || '-',
    key.consumerOrdinal,
  ].join(':')
}

let activeSuspendableActionRuntime: SuspendableActionRuntime | undefined

export function getActiveSuspendableActionRuntime(): SuspendableActionRuntime | undefined {
  return activeSuspendableActionRuntime
}

export function withSuspendableActionRuntime<T>(
  runtime: SuspendableActionRuntime,
  operation: () => T,
): T {
  const previous = activeSuspendableActionRuntime
  activeSuspendableActionRuntime = runtime
  try {
    return operation()
  } finally {
    activeSuspendableActionRuntime = previous
  }
}

export function isSuspendableActionPending(error: unknown): error is SuspendableActionPending {
  return error instanceof SuspendableActionPending
}
