export const LEGACY_ATTACHED_EFFECT_UNSUPPORTED = 'LEGACY_ATTACHED_EFFECT_UNSUPPORTED'

export class LegacyAttachedEffectUnsupportedError extends Error {
  readonly code = LEGACY_ATTACHED_EFFECT_UNSUPPORTED

  constructor(location: string) {
    super(`${LEGACY_ATTACHED_EFFECT_UNSUPPORTED}: ${location}`)
    this.name = 'LegacyAttachedEffectUnsupportedError'
  }
}

function hasLegacyEntries(value: unknown): boolean {
  return value !== undefined && (!Array.isArray(value) || value.length > 0)
}

/**
 * AttachedEffect was never part of the supported public-test save contract.
 * Reject executable legacy payloads at the reducer boundary instead of
 * silently ignoring them or retaining an execution path for old code.
 */
export function assertNoLegacyAttachedEffects(state: unknown): void {
  if (!state || typeof state !== 'object') return

  const candidate = state as Record<string, unknown>
  for (const collectionName of ['pieces', 'graveyard'] as const) {
    const collection = candidate[collectionName]
    if (!Array.isArray(collection)) continue

    for (const entry of collection) {
      if (!entry || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      if (!hasLegacyEntries(record.attachedEffects)) continue

      const pieceId = typeof record.instanceId === 'string' ? record.instanceId : 'unknown-piece'
      throw new LegacyAttachedEffectUnsupportedError(`${collectionName}.${pieceId}.attachedEffects`)
    }
  }
}

/** Reject old/custom piece definitions instead of partially initializing them. */
export function assertNoLegacyInitialEffects(template: unknown): void {
  if (!template || typeof template !== 'object') return

  const record = template as Record<string, unknown>
  if (!hasLegacyEntries(record.initialEffects)) return

  const templateId = typeof record.id === 'string' ? record.id : 'unknown-template'
  throw new LegacyAttachedEffectUnsupportedError(`pieceTemplate.${templateId}.initialEffects`)
}
