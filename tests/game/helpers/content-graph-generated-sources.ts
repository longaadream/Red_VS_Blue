type JsonRecord = Record<string, unknown>

export type GeneratedSourcePair = {
  readonly cardId: string
  readonly legacySource: string
  readonly generatedSource: string
}

export type CanonicalGeneratedCards = {
  readonly legacy: Record<string, JsonRecord>
  readonly generated: Record<string, JsonRecord>
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Remove generated-card code only after the exact old/new source pair has
 * been checked. A caller must supply the source emitted by the compiled child
 * graph with its actual bindings; this helper never infers or ignores code.
 */
export function canonicalizeGeneratedCards(
  legacyCards: Record<string, JsonRecord>,
  generatedCards: Record<string, JsonRecord>,
  pairs: readonly GeneratedSourcePair[],
): CanonicalGeneratedCards {
  const legacyIds = Object.keys(legacyCards).sort()
  const generatedIds = Object.keys(generatedCards).sort()
  if (JSON.stringify(legacyIds) !== JSON.stringify(generatedIds)) {
    throw new Error('generated source pair card IDs differ')
  }

  const pairByCardId = new Map<string, GeneratedSourcePair>()
  for (const pair of pairs) {
    if (pairByCardId.has(pair.cardId)) throw new Error(`duplicate generated source pair: ${pair.cardId}`)
    pairByCardId.set(pair.cardId, pair)
  }
  if (pairByCardId.size !== legacyIds.length || legacyIds.some(id => !pairByCardId.has(id))) {
    throw new Error('every generated card code must have an exact source pair')
  }

  const legacy = cloneJson(legacyCards)
  const generated = cloneJson(generatedCards)
  for (const cardId of legacyIds) {
    const legacyCode = legacy[cardId]?.code
    const generatedCode = generated[cardId]?.code
    const pair = pairByCardId.get(cardId)!
    if (typeof legacyCode !== 'string' || typeof generatedCode !== 'string') {
      throw new Error(`generated source pair ${cardId} requires string code fields`)
    }
    if (pair.legacySource !== legacyCode || pair.generatedSource !== generatedCode) {
      throw new Error(`generated source pair mismatch: ${cardId}`)
    }
    delete legacy[cardId].code
    delete generated[cardId].code
  }
  return { legacy, generated }
}
