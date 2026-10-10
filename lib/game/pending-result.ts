import type { TriggerResult } from './triggers'

type TargetEnvelope = {
  playerId?: string
  title?: string
  targetType?: string
  range?: number
  filter?: string
  candidates?: unknown[]
  targetCandidates?: unknown[]
  selectionMode?: 'single' | 'multi'
  min?: number
  max?: number
  minSelections?: number
  maxSelections?: number
  canCancel?: boolean
  resumeOnCancel?: boolean
  rollbackOnCancel?: boolean
  effectCode?: string
  payload?: unknown
}

/** Adapt the compiled continuation envelope at trigger/continuation boundaries.
 * Target-session creation still owns candidate and owner validation. */
export function normalizePendingResult(result: TriggerResult | undefined): TriggerResult | undefined {
  const pending = (result as (TriggerResult & { pendingTargetSelection?: TargetEnvelope }) | undefined)?.pendingTargetSelection
  if (!pending) return result
  return {
    ...result!,
    needsTargetSelection: true,
    playerId: pending.playerId,
    title: pending.title,
    targetType: pending.targetType,
    range: pending.range,
    filter: pending.filter,
    targetCandidates: pending.targetCandidates ?? pending.candidates,
    selectionMode: pending.selectionMode,
    minSelections: pending.minSelections ?? pending.min,
    maxSelections: pending.maxSelections ?? pending.max,
    canCancel: pending.canCancel,
    resumeOnCancel: pending.resumeOnCancel,
    rollbackOnCancel: pending.rollbackOnCancel,
    effectCode: pending.effectCode,
    payload: pending.payload,
  }
}
