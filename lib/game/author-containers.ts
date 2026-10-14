/**
 * Immutable, JSON-safe containers used by author runtime integrations.
 *
 * Tuples remain ordinary arrays and retain their existing one-based author
 * indexing convention. Maps and sets use tagged records so their identity and
 * insertion order survive a JSON round trip without coercing keys to strings.
 */

export const AUTHOR_CONTAINER_MAX_ITEMS = 4096
export const AUTHOR_CONTAINER_MAX_DEPTH = 40
export const AUTHOR_CONTAINER_MAX_NODES = 16384
export const AUTHOR_CONTAINER_MAX_BYTES = 65536

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export type AuthorContainerValue =
  | null
  | string
  | boolean
  | number
  | readonly AuthorContainerValue[]
  | { readonly [key: string]: AuthorContainerValue }

export type AuthorTuple = readonly AuthorContainerValue[]
export type AuthorMapEntry = readonly [AuthorContainerValue, AuthorContainerValue]

export interface AuthorMap {
  readonly format: 'author-map/v1'
  readonly entries: readonly AuthorMapEntry[]
}

export interface AuthorSet {
  readonly format: 'author-set/v1'
  readonly items: readonly AuthorContainerValue[]
}

export interface AuthorMapGetResult {
  readonly value: AuthorContainerValue | undefined
  readonly found: boolean
}

type Seen = Set<object>
type CloneBudget = { nodes: number }

function fail(message: string): never {
  throw new AuthorContainerError('invalid-value', message)
}

export type AuthorContainerErrorCode =
  | 'invalid-value'
  | 'invalid-container'
  | 'limit-exceeded'

export class AuthorContainerError extends Error {
  readonly code: AuthorContainerErrorCode

  constructor(code: AuthorContainerErrorCode, message: string) {
    super(message)
    this.name = 'AuthorContainerError'
    this.code = code
  }
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object'
}

function ownKeys(value: object): readonly (string | symbol)[] {
  try {
    return Reflect.ownKeys(value)
  } catch (error) {
    throw new AuthorContainerError('invalid-value', `Unable to inspect author value: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function ownDescriptors(value: object): Record<string, PropertyDescriptor> {
  try {
    return Object.getOwnPropertyDescriptors(value)
  } catch (error) {
    throw new AuthorContainerError('invalid-value', `Unable to inspect author value: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function plainRecord(value: object): value is Record<string, unknown> {
  try {
    return Object.getPrototypeOf(value) === Object.prototype
  } catch (error) {
    throw new AuthorContainerError('invalid-value', `Unable to inspect author value: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function checkDepth(depth: number): void {
  if (depth > AUTHOR_CONTAINER_MAX_DEPTH) throw new AuthorContainerError('limit-exceeded', 'Author value nesting exceeds the runtime limit')
}

function checkNodes(budget: CloneBudget): void {
  budget.nodes += 1
  if (budget.nodes > AUTHOR_CONTAINER_MAX_NODES) throw new AuthorContainerError('limit-exceeded', 'Author value contains too many nodes')
}

function checkCollectionSize(size: number, label: string): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > AUTHOR_CONTAINER_MAX_ITEMS) {
    throw new AuthorContainerError('limit-exceeded', `${label} exceeds the ${AUTHOR_CONTAINER_MAX_ITEMS}-item limit`)
  }
}

function arrayShape(value: unknown, label: string): readonly PropertyDescriptor[] {
  if (!Array.isArray(value)) throw new AuthorContainerError('invalid-value', `${label} must be an array`)
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new AuthorContainerError('invalid-value', `${label} must use the standard array prototype`)
  } catch (error) {
    if (error instanceof AuthorContainerError) throw error
    throw new AuthorContainerError('invalid-value', `Unable to inspect ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
  checkCollectionSize(value.length, label)
  const descriptors = ownDescriptors(value)
  const keys = ownKeys(value)
  const lengthDescriptor = descriptors.length
  if (!lengthDescriptor || !('value' in lengthDescriptor) || lengthDescriptor.enumerable || lengthDescriptor.value !== value.length) {
    throw new AuthorContainerError('invalid-value', `${label} must have a valid length field`)
  }
  for (const key of keys) {
    if (typeof key !== 'string') throw new AuthorContainerError('invalid-value', `${label} does not support Symbol fields`)
    if (key === 'length') continue
    if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) throw new AuthorContainerError('invalid-value', `${label} must be dense indexed arrays`)
    const descriptor = descriptors[key]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new AuthorContainerError('invalid-value', `${label} does not support accessor or hidden fields`)
  }
  const result: PropertyDescriptor[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new AuthorContainerError('invalid-value', `${label} must be dense indexed arrays`)
    result.push(descriptor)
  }
  return result
}

function cloneValue(value: unknown, seen: Seen, depth: number, budget: CloneBudget): AuthorContainerValue {
  checkDepth(depth)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Author values must contain finite numbers')
    return value
  }
  if (!isObject(value)) fail('Author values must be finite JSON values')
  if (seen.has(value)) fail('Author values cannot contain cycles')
  checkNodes(budget)

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const descriptors = arrayShape(value, 'Author tuple')
      const result: AuthorContainerValue[] = []
      for (const descriptor of descriptors) {
        result.push(cloneValue(descriptor.value, seen, depth + 1, budget))
      }
      return Object.freeze(result)
    }

    if (!plainRecord(value)) fail('Author values must use plain records')
    const keys = ownKeys(value)
    const descriptors = ownDescriptors(value)
    checkCollectionSize(keys.length, 'Author record')
    if (keys.some(key => typeof key !== 'string')) fail('Author values do not support Symbol fields')
    const result: Record<string, AuthorContainerValue> = {}
    for (const key of keys as readonly string[]) {
      if (FORBIDDEN_KEYS.has(key)) fail(`Author value field ${key} is not allowed`)
      const descriptor = descriptors[key]
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('Author records do not support accessor or hidden fields')
      Object.defineProperty(result, key, {
        configurable: false,
        enumerable: true,
        value: cloneValue(descriptor.value, seen, depth + 1, budget),
        writable: false,
      })
    }
    return Object.freeze(result)
  } finally {
    seen.delete(value)
  }
}

function cloneAuthorValue(value: unknown): AuthorContainerValue {
  return cloneValue(value, new Set(), 0, { nodes: 0 })
}

function encodedSize(value: AuthorMap | AuthorSet): void {
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(value)
  } catch (error) {
    throw new AuthorContainerError('invalid-value', `Author container cannot be serialized: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > AUTHOR_CONTAINER_MAX_BYTES) {
    throw new AuthorContainerError('limit-exceeded', 'Author container exceeds the serialized size limit')
  }
}

function canonical(value: AuthorContainerValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  const record = value as { readonly [key: string]: AuthorContainerValue }
  return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}'
}

function equal(left: AuthorContainerValue, right: AuthorContainerValue): boolean {
  return canonical(left) === canonical(right)
}

function tupleEntries(entries: readonly (readonly unknown[])[]): AuthorMapEntry[] {
  const entryDescriptors = arrayShape(entries, 'Author map')
  const result: AuthorMapEntry[] = []
  const keys: AuthorContainerValue[] = []
  for (const entryDescriptor of entryDescriptors) {
    const entry = entryDescriptor.value
    if (!Array.isArray(entry) || entry.length !== 2) fail('Author map entries must be two-item tuples')
    const descriptors = arrayShape(entry, 'Author map entry')
    const key = cloneAuthorValue(descriptors[0].value)
    const value = cloneAuthorValue(descriptors[1].value)
    const index = keys.findIndex(existing => equal(existing, key))
    if (index < 0) {
      keys.push(key)
      result.push(Object.freeze([key, value]) as AuthorMapEntry)
    } else {
      result[index] = Object.freeze([result[index][0], value]) as AuthorMapEntry
    }
  }
  return result
}

function taggedCollection(value: unknown, format: AuthorMap['format'] | AuthorSet['format'], property: 'entries' | 'items'): readonly unknown[] {
  if (!isObject(value) || Array.isArray(value)) throw new AuthorContainerError('invalid-container', `Expected an ${property === 'entries' ? 'author map' : 'author set'}`)
  if (!plainRecord(value)) throw new AuthorContainerError('invalid-container', 'Author containers must use plain records')
  const keys = ownKeys(value)
  const descriptors = ownDescriptors(value)
  if (keys.length !== 2 || keys.some(key => typeof key !== 'string' || (key !== 'format' && key !== property))) {
    throw new AuthorContainerError('invalid-container', 'Author containers may only contain their format and collection fields')
  }
  const formatDescriptor = descriptors.format
  const collectionDescriptor = descriptors[property]
  if (!formatDescriptor || !('value' in formatDescriptor) || !formatDescriptor.enumerable || formatDescriptor.value !== format) {
    throw new AuthorContainerError('invalid-container', `Invalid ${format} container format`)
  }
  if (!collectionDescriptor || !('value' in collectionDescriptor) || !collectionDescriptor.enumerable || !Array.isArray(collectionDescriptor.value)) {
    throw new AuthorContainerError('invalid-container', `Invalid ${format} container collection`)
  }
  return collectionDescriptor.value
}

function mapEntries(map: unknown): AuthorMapEntry[] {
  const rawEntries = taggedCollection(map, 'author-map/v1', 'entries')
  const entryDescriptors = arrayShape(rawEntries, 'Author map')
  const result: AuthorMapEntry[] = []
  const keys: AuthorContainerValue[] = []
  for (const entryDescriptor of entryDescriptors) {
    const entry = entryDescriptor.value
    if (!Array.isArray(entry) || entry.length !== 2) throw new AuthorContainerError('invalid-container', 'Author map entries must be two-item tuples')
    const descriptors = arrayShape(entry, 'Author map entry')
    const key = cloneAuthorValue(descriptors[0].value)
    const value = cloneAuthorValue(descriptors[1].value)
    if (keys.some(existing => equal(existing, key))) throw new AuthorContainerError('invalid-container', 'Author maps cannot contain duplicate keys')
    keys.push(key)
    result.push(Object.freeze([key, value]) as AuthorMapEntry)
  }
  encodedSize({ format: 'author-map/v1', entries: result.slice() })
  return result
}

function setItems(items: readonly unknown[]): AuthorContainerValue[] {
  const itemDescriptors = arrayShape(items, 'Author set')
  const result: AuthorContainerValue[] = []
  for (const itemDescriptor of itemDescriptors) {
    const cloned = cloneAuthorValue(itemDescriptor.value)
    if (!result.some(existing => equal(existing, cloned))) result.push(cloned)
  }
  return result
}

function readSetItems(set: unknown): AuthorContainerValue[] {
  const rawItems = taggedCollection(set, 'author-set/v1', 'items')
  const itemDescriptors = arrayShape(rawItems, 'Author set')
  const result: AuthorContainerValue[] = []
  for (const itemDescriptor of itemDescriptors) {
    const cloned = cloneAuthorValue(itemDescriptor.value)
    if (result.some(existing => equal(existing, cloned))) throw new AuthorContainerError('invalid-container', 'Author sets cannot contain duplicate items')
    result.push(cloned)
  }
  encodedSize({ format: 'author-set/v1', items: result.slice() })
  return result
}

function containerMap(entries: readonly AuthorMapEntry[]): AuthorMap {
  checkCollectionSize(entries.length, 'Author map')
  const result: AuthorMap = Object.freeze({
    format: 'author-map/v1',
    entries: Object.freeze(entries.map(entry => Object.freeze([entry[0], entry[1]]) as AuthorMapEntry)),
  })
  encodedSize(result)
  return result
}

function containerSet(items: readonly AuthorContainerValue[]): AuthorSet {
  checkCollectionSize(items.length, 'Author set')
  const result: AuthorSet = Object.freeze({ format: 'author-set/v1', items: Object.freeze([...items]) })
  encodedSize(result)
  return result
}

/** Create an empty or initialized immutable map from ordered key/value tuples. */
export function createAuthorMap(entries: readonly (readonly unknown[])[] = []): AuthorMap {
  return containerMap(tupleEntries(entries))
}

/** Create an immutable map from separate ordered key and value arrays. */
export function authorMapCreate(keys: readonly unknown[], values: readonly unknown[]): AuthorMap
export function authorMapCreate(entries?: readonly (readonly unknown[])[]): AuthorMap
export function authorMapCreate(first: readonly unknown[] = [], values?: readonly unknown[]): AuthorMap {
  if (values === undefined) return createAuthorMap(first as readonly (readonly unknown[])[])
  if (!Array.isArray(first) || !Array.isArray(values)) throw new AuthorContainerError('invalid-value', 'Author map keys and values must be arrays')
  const keyDescriptors = arrayShape(first, 'Author map keys')
  const valueDescriptors = arrayShape(values, 'Author map values')
  if (keyDescriptors.length !== valueDescriptors.length) throw new AuthorContainerError('invalid-value', 'Author map keys and values must have the same length')
  const entries = keyDescriptors.map((keyDescriptor, index) => [keyDescriptor.value, valueDescriptors[index].value] as const)
  return createAuthorMap(entries)
}

/** Create an immutable map from an existing ordered tuple array. */
export function authorMapFromTuples(entries: readonly (readonly unknown[])[]): AuthorMap {
  return createAuthorMap(entries)
}

/** Create an empty or initialized immutable set from an ordered tuple/array. */
export function createAuthorSet(items: readonly unknown[] = []): AuthorSet {
  return containerSet(setItems(items))
}

export const authorSetCreate = createAuthorSet

/** Create an immutable set from an existing ordered tuple/array. */
export function authorSetFromTuple(items: readonly unknown[]): AuthorSet {
  return createAuthorSet(items)
}

export function authorMapContains(map: unknown, key: unknown): boolean {
  const entries = mapEntries(map)
  const normalizedKey = cloneAuthorValue(key)
  return entries.some(entry => equal(entry[0], normalizedKey))
}

export const authorMapHas = authorMapContains

/** Missing keys are represented explicitly by found:false and value:undefined. */
export function authorMapGet(map: unknown, key: unknown): AuthorMapGetResult {
  const entries = mapEntries(map)
  const normalizedKey = cloneAuthorValue(key)
  const entry = entries.find(candidate => equal(candidate[0], normalizedKey))
  return entry ? { value: cloneAuthorValue(entry[1]), found: true } : { value: undefined, found: false }
}

export function authorMapSet(map: unknown, key: unknown, value: unknown): AuthorMap {
  const entries = mapEntries(map)
  const normalizedKey = cloneAuthorValue(key)
  const normalizedValue = cloneAuthorValue(value)
  const index = entries.findIndex(entry => equal(entry[0], normalizedKey))
  if (index < 0) entries.push(Object.freeze([normalizedKey, normalizedValue]) as AuthorMapEntry)
  else entries[index] = Object.freeze([entries[index][0], normalizedValue]) as AuthorMapEntry
  return containerMap(entries)
}

export function authorMapDelete(map: unknown, key: unknown): AuthorMap {
  const entries = mapEntries(map)
  const normalizedKey = cloneAuthorValue(key)
  return containerMap(entries.filter(entry => !equal(entry[0], normalizedKey)))
}

export function authorMapKeys(map: unknown): AuthorTuple {
  return Object.freeze(mapEntries(map).map(entry => cloneAuthorValue(entry[0])))
}

export function authorMapValues(map: unknown): AuthorTuple {
  return Object.freeze(mapEntries(map).map(entry => cloneAuthorValue(entry[1])))
}

export function authorMapItems(map: unknown): readonly AuthorMapEntry[] {
  return Object.freeze(mapEntries(map).map(entry => Object.freeze([cloneAuthorValue(entry[0]), cloneAuthorValue(entry[1])]) as AuthorMapEntry))
}

export function authorMapCount(map: unknown): number {
  return mapEntries(map).length
}

export function authorSetContains(set: unknown, value: unknown): boolean {
  const items = readSetItems(set)
  const normalized = cloneAuthorValue(value)
  return items.some(item => equal(item, normalized))
}

export const authorSetHas = authorSetContains

export function authorSetSet(set: unknown, value: unknown): AuthorSet {
  const items = readSetItems(set)
  const normalized = cloneAuthorValue(value)
  if (!items.some(item => equal(item, normalized))) items.push(normalized)
  return containerSet(items)
}

export const authorSetAdd = authorSetSet

export function authorSetDelete(set: unknown, value: unknown): AuthorSet {
  const items = readSetItems(set)
  const normalized = cloneAuthorValue(value)
  return containerSet(items.filter(item => !equal(item, normalized)))
}

export function authorSetItems(set: unknown): AuthorTuple {
  return Object.freeze(readSetItems(set))
}

export const authorSetValues = authorSetItems
export const authorSetKeys = authorSetItems

export function authorSetCount(set: unknown): number {
  return authorSetItems(set).length
}

export function isAuthorMap(value: unknown): value is AuthorMap {
  try {
    mapEntries(value)
    return true
  } catch {
    return false
  }
}

export function isAuthorSet(value: unknown): value is AuthorSet {
  try {
    readSetItems(value)
    return true
  } catch {
    return false
  }
}
