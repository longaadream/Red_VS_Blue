/* eslint-disable @typescript-eslint/no-explicit-any -- pending sessions serialize data-authored rule continuations. */

export const PENDING_INTERACTION_PROTOCOL_VERSION = 1

export interface PendingRuleConsumerRef {
  ruleId: string
  sourceId?: string
}

export interface PendingReactiveCardRef {
  playerId: string
  cardInstanceId: string
  cardId: string
}

export interface PendingInteractionSource {
  type: 'skill' | 'card' | 'rule' | 'pending'
  id: string
  pieceId?: string
}

export interface PendingOptionSelectionSession {
  playerId: string
  title: string
  options: any[]
  pendingAction?: any
  triggerContext?: any
  continuationContext?: any
  cancelValue?: any
  pendingQueue?: PendingRuleConsumerRef[]
  pendingReactiveCards?: PendingReactiveCardRef[]
  source?: PendingInteractionSource
  selectionId?: string
  stateRevision?: number
  canCancel?: boolean
}

export class PendingInteractionRuleError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PendingInteractionRuleError'
    this.code = code
  }
}

function normalizePlayerId(playerId: unknown): string {
  return String(playerId ?? '').trim().toLowerCase()
}

function fnv1a(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map(key => (
    `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`
  )).join(',')}}`
}

function optionValues(option: any): unknown[] {
  if (!option || typeof option !== 'object') return [option]
  const values: unknown[] = [option]
  if ('value' in option) values.push(option.value)
  if ('id' in option) values.push(option.id)
  return values
}

function sameOptionValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || stableJson(left) === stableJson(right)
}

function pendingSource(pending: PendingOptionSelectionSession): PendingInteractionSource {
  if (pending.source) return pending.source
  const context = pending.triggerContext || {}
  return {
    type: context.pendingRuleId ? 'rule' : 'pending',
    id: context.pendingRuleId || 'pending-option',
    pieceId: context.pendingRuleSourceId,
  }
}

export function finalizePendingOptionSession(
  pending: PendingOptionSelectionSession,
  revision: number,
): PendingOptionSelectionSession {
  const source = pendingSource(pending)
  const normalized: PendingOptionSelectionSession = {
    ...pending,
    source,
    canCancel: pending.canCancel !== false,
    stateRevision: revision,
  }
  const identity = [
    PENDING_INTERACTION_PROTOCOL_VERSION,
    revision,
    normalizePlayerId(pending.playerId),
    source.type,
    source.id,
    source.pieceId || '',
    stableJson(pending.options),
  ].join('|')
  normalized.selectionId = `option-${PENDING_INTERACTION_PROTOCOL_VERSION}-${revision.toString(36)}-${fnv1a(identity)}`
  return normalized
}

export function validatePendingOptionSubmission(
  state: { targetingRevision?: number; pendingOptionSelection?: PendingOptionSelectionSession },
  action: { playerId: string; selectedOption: unknown; selectionId?: string; stateRevision?: number },
): void {
  const pending = state.pendingOptionSelection
  if (!pending) {
    throw new PendingInteractionRuleError(
      action.selectionId ? 'PENDING_OPTION_ALREADY_RESOLVED' : 'PENDING_OPTION_NOT_FOUND',
      action.selectionId ? 'Option selection was already resolved' : 'No option selection is pending',
    )
  }
  if (normalizePlayerId(pending.playerId) !== normalizePlayerId(action.playerId)) {
    throw new PendingInteractionRuleError('PENDING_OPTION_PLAYER_MISMATCH', 'Option selection belongs to another player')
  }
  const revision = Number.isSafeInteger(state.targetingRevision) ? state.targetingRevision! : 0
  if (action.stateRevision !== revision || pending.stateRevision !== revision) {
    throw new PendingInteractionRuleError('PENDING_OPTION_STALE', 'Option selection state revision is stale')
  }
  if (!pending.selectionId || action.selectionId !== pending.selectionId) {
    throw new PendingInteractionRuleError('PENDING_OPTION_ID_MISMATCH', 'Option selection ID does not match the pending session')
  }
  const allowed = pending.options.some(option => optionValues(option).some(value => sameOptionValue(value, action.selectedOption)))
  if (!allowed) {
    throw new PendingInteractionRuleError('PENDING_OPTION_VALUE_INVALID', 'Selected option is not a candidate in the pending session')
  }
}

export function assertPendingOptionCancellation(
  state: { targetingRevision?: number; pendingOptionSelection?: PendingOptionSelectionSession },
  action: { playerId: string; selectionId?: string; stateRevision?: number },
): void {
  const pending = state.pendingOptionSelection
  if (!pending) {
    throw new PendingInteractionRuleError(
      action.selectionId ? 'PENDING_OPTION_ALREADY_RESOLVED' : 'PENDING_OPTION_NOT_FOUND',
      action.selectionId ? 'Option selection was already resolved' : 'No option selection is pending',
    )
  }
  if (pending.canCancel === false) {
    throw new PendingInteractionRuleError('PENDING_OPTION_CANCEL_FORBIDDEN', 'This option selection cannot be cancelled')
  }
  if (normalizePlayerId(pending.playerId) !== normalizePlayerId(action.playerId)) {
    throw new PendingInteractionRuleError('PENDING_OPTION_PLAYER_MISMATCH', 'Option selection belongs to another player')
  }
  const revision = Number.isSafeInteger(state.targetingRevision) ? state.targetingRevision! : 0
  if (action.stateRevision !== revision || pending.stateRevision !== revision) {
    throw new PendingInteractionRuleError('PENDING_OPTION_STALE', 'Cancellation option selection revision is stale')
  }
  if (!pending.selectionId || action.selectionId !== pending.selectionId) {
    throw new PendingInteractionRuleError('PENDING_OPTION_ID_MISMATCH', 'Cancellation does not match the pending option session')
  }
}
