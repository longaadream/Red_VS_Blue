export const BATTLE_STATE_HASH_ALGORITHM_VERSION = 1 as const
export const BATTLE_STATE_HASH_CHUNK_SIZE = 32

export type BattleStateHashValue = (value: unknown) => string
export type BattleStateHashPath = Array<string | number>
export type BattleStateHashPatchOperation =
  | { op: 'set'; path: BattleStateHashPath; value: unknown }
  | { op: 'remove'; path: BattleStateHashPath }

interface BattleStateValueFieldHashIndex {
  kind: 'value'
  hash: string
}

interface BattleStateArrayFieldHashIndex {
  kind: 'array'
  hash: string
  length: number
  chunkSize: number
  chunkHashes: string[]
}

export type BattleStateFieldHashIndex =
  | BattleStateValueFieldHashIndex
  | BattleStateArrayFieldHashIndex

export interface BattleStateHashIndex {
  algorithmVersion: typeof BATTLE_STATE_HASH_ALGORITHM_VERSION
  chunkSize: number
  fields: Record<string, BattleStateFieldHashIndex>
  rootHash: string
}

export interface BattleStateHashUpdateStats {
  fullRebuild: boolean
  touchedFieldCount: number
  touchedChunkCount: number
}

export interface BattleStateHashUpdateResult {
  index: BattleStateHashIndex
  stats: BattleStateHashUpdateStats
}

/**
 * Builds the path-only change set used by the incremental hash index.
 *
 * Authoritative states may temporarily contain executable rule callbacks. The
 * stable JSON hash omits callbacks from object properties (and serializes them
 * as null in arrays), so the hash differ must mirror those semantics without
 * feeding the runtime-only values through the public JSON patch validator.
 */
export function createBattleStateHashPatch(
  beforeValue: unknown,
  afterValue: unknown,
): BattleStateHashPatchOperation[] {
  const before = assertRootObject(beforeValue)
  const after = assertRootObject(afterValue)
  const patch: BattleStateHashPatchOperation[] = []
  const beforeFields = jsonObjectKeys(before)
  const afterFields = jsonObjectKeys(after)
  const fieldNames = new Set([...beforeFields, ...afterFields])
  for (const fieldName of [...fieldNames].sort()) {
    if (!afterFields.has(fieldName)) {
      patch.push({ op: 'remove', path: [fieldName] })
      continue
    }
    if (!beforeFields.has(fieldName)) {
      patch.push({ op: 'set', path: [fieldName], value: undefined })
      continue
    }
    diffHashValue(before[fieldName], after[fieldName], [fieldName], patch, false)
  }
  return patch
}

interface AffectedField {
  rebuild: boolean
  chunks: Set<number>
  fromChunk?: number
}

export function buildBattleStateHashIndex(
  value: unknown,
  hashValue: BattleStateHashValue,
): BattleStateHashIndex {
  const root = assertRootObject(value)
  const fields: Record<string, BattleStateFieldHashIndex> = {}
  for (const fieldName of [...jsonObjectKeys(root)].sort()) {
    fields[fieldName] = buildFieldIndex(fieldName, root[fieldName], hashValue)
  }
  return {
    algorithmVersion: BATTLE_STATE_HASH_ALGORITHM_VERSION,
    chunkSize: BATTLE_STATE_HASH_CHUNK_SIZE,
    fields,
    rootHash: hashRoot(fields, hashValue),
  }
}

export function updateBattleStateHashIndex(
  previous: BattleStateHashIndex,
  nextValue: unknown,
  patch: BattleStateHashPatchOperation[],
  hashValue: BattleStateHashValue,
): BattleStateHashUpdateResult {
  assertCompatibleIndex(previous)
  const next = assertRootObject(nextValue)
  const affected = new Map<string, AffectedField>()
  let fullRebuild = false

  for (const operation of patch) {
    if (!operation || !Array.isArray(operation.path) || operation.path.length === 0) {
      fullRebuild = true
      break
    }
    const fieldName = operation.path[0]
    if (typeof fieldName !== 'string') {
      fullRebuild = true
      break
    }
    const existing = affected.get(fieldName) ?? { rebuild: false, chunks: new Set<number>() }
    affected.set(fieldName, existing)
    if (operation.path.length === 1) {
      existing.rebuild = true
      continue
    }

    const nextField = next[fieldName]
    const previousField = previous.fields[fieldName]
    const arrayIndex = operation.path[1]
    if (
      !Array.isArray(nextField)
      || previousField?.kind !== 'array'
      || typeof arrayIndex !== 'number'
      || !Number.isSafeInteger(arrayIndex)
      || arrayIndex < 0
    ) {
      existing.rebuild = true
      continue
    }

    const chunk = Math.floor(arrayIndex / previous.chunkSize)
    existing.chunks.add(chunk)
    if (operation.op === 'remove' && arrayIndex < nextField.length) {
      existing.fromChunk = existing.fromChunk === undefined
        ? chunk
        : Math.min(existing.fromChunk, chunk)
    }
  }

  if (fullRebuild) {
    const index = buildBattleStateHashIndex(next, hashValue)
    return {
      index,
      stats: {
        fullRebuild: true,
        touchedFieldCount: Object.keys(index.fields).length,
        touchedChunkCount: countChunks(index.fields),
      },
    }
  }

  const fields = cloneFields(previous.fields)
  let touchedChunkCount = 0
  for (const [fieldName, change] of affected) {
    if (!isJsonRootFieldPresent(next, fieldName)) {
      const removed = fields[fieldName]
      if (removed?.kind === 'array') touchedChunkCount += removed.chunkHashes.length
      delete fields[fieldName]
      continue
    }

    const nextField = next[fieldName]
    const current = fields[fieldName]
    if (change.rebuild || !Array.isArray(nextField) || current?.kind !== 'array') {
      const replacement = buildFieldIndex(fieldName, nextField, hashValue)
      fields[fieldName] = replacement
      if (replacement.kind === 'array') touchedChunkCount += replacement.chunkHashes.length
      continue
    }

    const nextChunkCount = Math.ceil(nextField.length / previous.chunkSize)
    const chunks = new Set(change.chunks)
    if (change.fromChunk !== undefined) {
      const lastAffectedChunk = Math.max(nextChunkCount, current.chunkHashes.length) - 1
      for (let chunk = change.fromChunk; chunk <= lastAffectedChunk; chunk += 1) chunks.add(chunk)
    }
    const chunkHashes = current.chunkHashes.slice(0, nextChunkCount)
    for (const chunk of [...chunks].sort((left, right) => left - right)) {
      touchedChunkCount += 1
      if (chunk < 0 || chunk >= nextChunkCount) continue
      chunkHashes[chunk] = hashArrayChunk(fieldName, chunk, nextField, previous.chunkSize, hashValue)
    }
    while (chunkHashes.length < nextChunkCount) {
      const chunk = chunkHashes.length
      chunkHashes.push(hashArrayChunk(fieldName, chunk, nextField, previous.chunkSize, hashValue))
      if (!chunks.has(chunk)) touchedChunkCount += 1
    }
    fields[fieldName] = buildArrayFieldIndex(
      fieldName,
      nextField.length,
      previous.chunkSize,
      chunkHashes,
      hashValue,
    )
  }

  return {
    index: {
      algorithmVersion: BATTLE_STATE_HASH_ALGORITHM_VERSION,
      chunkSize: previous.chunkSize,
      fields,
      rootHash: hashRoot(fields, hashValue),
    },
    stats: {
      fullRebuild: false,
      touchedFieldCount: affected.size,
      touchedChunkCount,
    },
  }
}

export function assertBattleStateHashIndex(
  value: unknown,
  index: BattleStateHashIndex,
  hashValue: BattleStateHashValue,
  context = 'battle state',
): void {
  const full = buildBattleStateHashIndex(value, hashValue)
  if (full.rootHash !== index.rootHash) {
    const divergentFields = [...new Set([
      ...Object.keys(full.fields),
      ...Object.keys(index.fields),
    ])].filter(fieldName => full.fields[fieldName]?.hash !== index.fields[fieldName]?.hash)
    throw new Error(
      `${context} incremental hash mismatch: expected ${full.rootHash}, got ${index.rootHash}; fields=${divergentFields.join(',') || 'root'}`,
    )
  }
}

function buildFieldIndex(
  fieldName: string,
  value: unknown,
  hashValue: BattleStateHashValue,
): BattleStateFieldHashIndex {
  if (!Array.isArray(value)) {
    return {
      kind: 'value',
      hash: hashValue({
        kind: 'battle-state-field',
        algorithmVersion: BATTLE_STATE_HASH_ALGORITHM_VERSION,
        fieldName,
        valueType: jsonValueType(value),
        value,
      }),
    }
  }
  const chunkHashes: string[] = []
  for (let chunk = 0; chunk * BATTLE_STATE_HASH_CHUNK_SIZE < value.length; chunk += 1) {
    chunkHashes.push(hashArrayChunk(
      fieldName,
      chunk,
      value,
      BATTLE_STATE_HASH_CHUNK_SIZE,
      hashValue,
    ))
  }
  return buildArrayFieldIndex(
    fieldName,
    value.length,
    BATTLE_STATE_HASH_CHUNK_SIZE,
    chunkHashes,
    hashValue,
  )
}

function buildArrayFieldIndex(
  fieldName: string,
  length: number,
  chunkSize: number,
  chunkHashes: string[],
  hashValue: BattleStateHashValue,
): BattleStateArrayFieldHashIndex {
  return {
    kind: 'array',
    length,
    chunkSize,
    chunkHashes,
    hash: hashValue({
      kind: 'battle-state-array-field',
      algorithmVersion: BATTLE_STATE_HASH_ALGORITHM_VERSION,
      fieldName,
      length,
      chunkSize,
      chunkHashes,
    }),
  }
}

function hashArrayChunk(
  fieldName: string,
  chunk: number,
  value: unknown[],
  chunkSize: number,
  hashValue: BattleStateHashValue,
): string {
  const start = chunk * chunkSize
  return hashValue({
    kind: 'battle-state-array-chunk',
    algorithmVersion: BATTLE_STATE_HASH_ALGORITHM_VERSION,
    fieldName,
    chunk,
    values: value.slice(start, start + chunkSize),
  })
}

function hashRoot(
  fields: Record<string, BattleStateFieldHashIndex>,
  hashValue: BattleStateHashValue,
): string {
  return hashValue({
    kind: 'battle-state-root',
    algorithmVersion: BATTLE_STATE_HASH_ALGORITHM_VERSION,
    fields: Object.keys(fields).sort().map(fieldName => {
      const field = fields[fieldName]
      return field.kind === 'array'
        ? {
            fieldName,
            kind: field.kind,
            length: field.length,
            chunkSize: field.chunkSize,
            hash: field.hash,
          }
        : { fieldName, kind: field.kind, hash: field.hash }
    }),
  })
}

function assertCompatibleIndex(index: BattleStateHashIndex): void {
  if (
    index.algorithmVersion !== BATTLE_STATE_HASH_ALGORITHM_VERSION
    || index.chunkSize !== BATTLE_STATE_HASH_CHUNK_SIZE
  ) {
    throw new Error('Battle state hash index version is incompatible')
  }
}

function assertRootObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Battle state hash root must be a JSON object')
  }
  return value as Record<string, unknown>
}

function jsonValueType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function cloneFields(
  fields: Record<string, BattleStateFieldHashIndex>,
): Record<string, BattleStateFieldHashIndex> {
  const clone: Record<string, BattleStateFieldHashIndex> = {}
  for (const [fieldName, field] of Object.entries(fields)) {
    clone[fieldName] = field.kind === 'array'
      ? { ...field, chunkHashes: [...field.chunkHashes] }
      : { ...field }
  }
  return clone
}

function countChunks(fields: Record<string, BattleStateFieldHashIndex>): number {
  return Object.values(fields).reduce(
    (count, field) => count + (field.kind === 'array' ? field.chunkHashes.length : 0),
    0,
  )
}

function diffHashValue(
  beforeValue: unknown,
  afterValue: unknown,
  path: BattleStateHashPath,
  patch: BattleStateHashPatchOperation[],
  arrayElement: boolean,
): void {
  const before = normalizeJsonPrimitive(beforeValue, arrayElement)
  const after = normalizeJsonPrimitive(afterValue, arrayElement)
  if (Object.is(before, after)) return

  if (Array.isArray(before) && Array.isArray(after)) {
    const sharedLength = Math.min(before.length, after.length)
    for (let index = 0; index < sharedLength; index += 1) {
      diffHashValue(before[index], after[index], [...path, index], patch, true)
    }
    for (let index = before.length - 1; index >= after.length; index -= 1) {
      patch.push({ op: 'remove', path: [...path, index] })
    }
    for (let index = before.length; index < after.length; index += 1) {
      patch.push({ op: 'set', path: [...path, index], value: undefined })
    }
    return
  }

  if (isJsonObject(before) && isJsonObject(after)) {
    const beforeKeys = jsonObjectKeys(before)
    const afterKeys = jsonObjectKeys(after)
    const keys = new Set([...beforeKeys, ...afterKeys])
    for (const key of [...keys].sort()) {
      if (!afterKeys.has(key)) {
        patch.push({ op: 'remove', path: [...path, key] })
        continue
      }
      if (!beforeKeys.has(key)) {
        patch.push({ op: 'set', path: [...path, key], value: undefined })
        continue
      }
      diffHashValue(before[key], after[key], [...path, key], patch, false)
    }
    return
  }

  patch.push({ op: 'set', path, value: undefined })
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function jsonObjectKeys(value: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(value).filter(key => !isOmittedJsonObjectValue(value[key])))
}

function isOmittedJsonObjectValue(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol'
}

function isJsonRootFieldPresent(value: Record<string, unknown>, fieldName: string): boolean {
  return Object.hasOwn(value, fieldName) && !isOmittedJsonObjectValue(value[fieldName])
}

function normalizeJsonPrimitive(value: unknown, arrayElement: boolean): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    if (Object.is(value, -0)) return 0
  }
  if (
    arrayElement
    && (value === undefined || typeof value === 'function' || typeof value === 'symbol')
  ) {
    return null
  }
  return value
}
