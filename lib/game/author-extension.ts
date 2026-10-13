import type { GameplayRecordSchema, GameplayValueType } from '../skill-graph/module-types'
import {
  AUTHOR_CONTAINER_MAX_BYTES,
  AUTHOR_CONTAINER_MAX_DEPTH,
  AUTHOR_CONTAINER_MAX_ITEMS,
  AUTHOR_CONTAINER_MAX_NODES,
  isAuthorMap,
  isAuthorSet,
} from './author-containers'

type Store = {
  get(scope: Scope, owner: string, namespace: string, name: string): unknown
  getDeclaration(scope: Scope, owner: string, namespace: string, name: string): AuthorValueDeclaration | undefined
  /** `false` is an explicit host-side write rejection; ordinary stores return void. */
  set(scope: Scope, owner: string, namespace: string, name: string, value: unknown, declaration?: AuthorValueDeclaration): void | false
  /**
   * Declare a value without materialising it in the authoritative store.
   *
   * Most stores use `set` for a first declaration because their declaration
   * itself is persistent state.  Legacy projections can opt into this hook
   * when the declaration's initial value is execution-local and a later
   * explicit write is required before the old storage is created.
   */
  declare?(scope: Scope, owner: string, namespace: string, name: string, value: unknown, declaration: AuthorValueDeclaration): unknown | undefined
  /** Remove one declared root value while keeping the owner store intact. */
  remove?(scope: Scope, owner: string, namespace: string, name: string): void
  /**
   * Read a legacy owner-scoped map without materialising a new flowState
   * declaration.  The adapter is deliberately opt-in: ordinary maps still
   * require their explicit declaration and therefore retain the existing
   * validation boundary.
   */
  getLegacyMap?(owner: string, namespace: string, name: string, declaration: Declaration): StoredMap | undefined
  /** Persist a legacy map update through its existing authoritative store. */
  setLegacyMap?(owner: string, namespace: string, name: string, declaration: Declaration, items: Value[]): boolean
}
export type AuthorValueDeclaration = { type: GameplayValueType; schemas: readonly GameplayRecordSchema[] }
export type AuthorInitialValue = AuthorValueDeclaration & { value: unknown }

/** Detached JSON data for one newly created instance, checked before any event. */
export function cloneAuthorInitialValue(initial: AuthorInitialValue): Record<string, unknown> {
  requireAuthorValue(initial.value, initial.type, initial.schemas)
  if (!object(initial.value)) throw new Error('实例扩展初始值必须是结构体')
  const encoded = safeAuthorJson(initial.value)
  if (utf8ByteLength(encoded) > AUTHOR_CONTAINER_MAX_BYTES) throw new Error('实例扩展超过64KB')
  return cloneAuthorJson(initial.value) as Record<string, unknown>
}

/**
 * Clone any validated author value for a concrete runtime instance.
 *
 * `cloneAuthorInitialValue` intentionally only accepts record roots because it
 * is used by the existing instance creation APIs. Entity extensions may store
 * scalar, tuple, map, set, nullable, and record fields, so expose the same
 * strict validation/clone boundary without introducing a second serializer.
 */
export function cloneAuthorValue(
  value: unknown,
  type: GameplayValueType,
  schemas: readonly GameplayRecordSchema[] = [],
): unknown {
  requireAuthorValue(value, type, schemas)
  const encoded = safeAuthorJson(value)
  if (utf8ByteLength(encoded) > AUTHOR_CONTAINER_MAX_BYTES) throw new Error('实例扩展超过64KB')
  return cloneAuthorJson(value)
}
type Scope = 'piece' | 'player' | 'battle'
type Declaration = { schema: GameplayRecordSchema; schemas: readonly GameplayRecordSchema[]; keyField: string }
type Value = Record<string, unknown>
type StoredMap = { format: 'author-extension-map/v1'; declaration: Declaration; items: Value[] }
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
type JsonBudget = { nodes: number }
const object = (value: unknown): value is Value => {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  } catch {
    return false
  }
}

function dataDescriptor(descriptor: PropertyDescriptor | undefined): descriptor is PropertyDescriptor & { value: unknown } {
  return !!descriptor && 'value' in descriptor
}

function ownDescriptors(value: object): Record<string, PropertyDescriptor> {
  return Object.getOwnPropertyDescriptors(value)
}

function strictAuthorJson(value: unknown, depth = 0, seen = new Set<object>(), budget: JsonBudget = { nodes: 0 }): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || value === null || depth > AUTHOR_CONTAINER_MAX_DEPTH || seen.has(value)) return false

  try {
    const array = Array.isArray(value)
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) return false
    const keys = Reflect.ownKeys(value)
    const descriptors = ownDescriptors(value)
    if (keys.some(key => typeof key !== 'string')) return false
    const stringKeys = keys as string[]
    budget.nodes += 1
    if (budget.nodes > AUTHOR_CONTAINER_MAX_NODES) return false
    seen.add(value)
    try {
      if (array) {
        const length = descriptors.length
        if (!dataDescriptor(length) || length.enumerable || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > AUTHOR_CONTAINER_MAX_ITEMS) return false
        const lengthValue = length.value as number
        if (stringKeys.length !== lengthValue + 1) return false
        for (const key of stringKeys) {
          if (key === 'length') continue
          if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= lengthValue) return false
          const descriptor = descriptors[key]
          if (!dataDescriptor(descriptor) || !descriptor.enumerable || !strictAuthorJson(descriptor.value, depth + 1, seen, budget)) return false
        }
        return true
      }

      if (stringKeys.length > AUTHOR_CONTAINER_MAX_ITEMS) return false
      for (const key of stringKeys) {
        if (FORBIDDEN_KEYS.has(key)) return false
        const descriptor = descriptors[key]
        if (!dataDescriptor(descriptor) || !descriptor.enumerable || !strictAuthorJson(descriptor.value, depth + 1, seen, budget)) return false
      }
      return true
    } finally {
      seen.delete(value)
    }
  } catch {
    return false
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/** Serialize validated data without consulting inherited properties or accessors. */
function safeAuthorJson(value: unknown, active = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (typeof value !== 'object' || value === null || active.has(value)) throw new Error('实例扩展必须是无环数据')
  const descriptors = ownDescriptors(value)
  active.add(value)
  try {
    if (Array.isArray(value)) {
      const length = descriptors.length
      if (!dataDescriptor(length)) throw new Error('实例扩展数组长度无效')
      const items = [] as string[]
      for (let index = 0; index < (length.value as number); index += 1) {
        const descriptor = descriptors[String(index)]
        if (!dataDescriptor(descriptor)) throw new Error('实例扩展数组必须连续')
        items.push(safeAuthorJson(descriptor.value, active))
      }
      return '[' + items.join(',') + ']'
    }
    const fields = Reflect.ownKeys(value).filter((key): key is string => typeof key === 'string')
    return '{' + fields.map(key => {
      const descriptor = descriptors[key]
      if (!dataDescriptor(descriptor)) throw new Error('实例扩展字段不合法')
      return JSON.stringify(key) + ':' + safeAuthorJson(descriptor.value, active)
    }).join(',') + '}'
  } finally {
    active.delete(value)
  }
}

function cloneAuthorJson(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value !== 'object' || value === null || seen.has(value)) throw new Error('实例扩展必须是无环数据')
  const descriptors = ownDescriptors(value)
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const length = descriptors.length
      if (!dataDescriptor(length)) throw new Error('实例扩展数组长度无效')
      const result: unknown[] = []
      for (let index = 0; index < (length.value as number); index += 1) {
        const descriptor = descriptors[String(index)]
        if (!dataDescriptor(descriptor)) throw new Error('实例扩展数组必须连续')
        result.push(cloneAuthorJson(descriptor.value, seen))
      }
      return result
    }
    const result: Record<string, unknown> = {}
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new Error('实例扩展不支持Symbol字段')
      const descriptor = descriptors[key]
      if (!dataDescriptor(descriptor)) throw new Error('实例扩展字段不合法')
      Object.defineProperty(result, key, { configurable: true, enumerable: true, value: cloneAuthorJson(descriptor.value, seen), writable: true })
    }
    return result
  } finally {
    seen.delete(value)
  }
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {
    const descriptors = ownDescriptors(value)
    const length = descriptors.length
    if (dataDescriptor(length)) return '[' + Array.from({ length: length.value as number }, (_, index) => {
      const descriptor = descriptors[String(index)]
      return dataDescriptor(descriptor) ? canonical(descriptor.value) : 'null'
    }).join(',') + ']'
  }
  if (object(value)) {
    const descriptors = ownDescriptors(value)
    return '{' + Object.keys(descriptors).sort().map(key => {
      const descriptor = descriptors[key]
      return dataDescriptor(descriptor) ? JSON.stringify(key) + ':' + canonical(descriptor.value) : ''
    }).join(',') + '}'
  }
  return JSON.stringify(value)
}

function resolveRecordSchema(reference: string, schemas: readonly GameplayRecordSchema[]): GameplayRecordSchema | undefined {
  if (reference.includes('@')) return schemas.find(item => item.id + '@' + item.version === reference)
  const matches = schemas.filter(item => item.id === reference)
  if (matches.length > 1) throw new Error('extension：记录类型版本不明确')
  return matches[0]
}

/** Retain only definitions reachable from the declared value type. */
export function authorValueSchemas(type: GameplayValueType, schemas: readonly GameplayRecordSchema[]): GameplayRecordSchema[] {
  const selected: GameplayRecordSchema[] = []
  const visit = (value: GameplayValueType): void => {
    if (typeof value === 'string') return
    if (value.kind === 'list' || value.kind === 'set') return visit(value.element)
    if (value.kind === 'map') { visit(value.key); visit(value.value); return }
    if (value.kind === 'nullable') return visit(value.value)
    const schema = resolveRecordSchema(value.schema, schemas)
    if (!schema) throw new Error('extension：记录类型尚未声明')
    if (selected.some(item => item.id === schema.id && item.version === schema.version)) return
    selected.push(schema)
    schema.fields.forEach(field => visit(field.type))
  }
  visit(type)
  return selected.sort((a, b) => (a.id + '@' + a.version).localeCompare(b.id + '@' + b.version))
}

function validateValue(value: unknown, type: GameplayValueType, schemas: readonly GameplayRecordSchema[], depth = 0): boolean {
  if (depth > AUTHOR_CONTAINER_MAX_DEPTH || !strictAuthorJson(value)) return false
  if (typeof type === 'object') {
    if (type.kind === 'nullable') return value === null || validateValue(value, type.value, schemas, depth + 1)
    if (type.kind === 'list') {
      if (!Array.isArray(value)) return false
      const descriptors = ownDescriptors(value)
      const length = descriptors.length
      return dataDescriptor(length) && Array.from({ length: length.value as number }, (_, index) => descriptors[String(index)]).every(descriptor => dataDescriptor(descriptor) && validateValue(descriptor.value, type.element, schemas, depth + 1))
    }
    if (type.kind === 'set') {
      if (!isAuthorSet(value)) return false
      const items = Object.getOwnPropertyDescriptor(value, 'items')
      return dataDescriptor(items) && Array.isArray(items.value) && validateValue(items.value, { kind: 'list', element: type.element }, schemas, depth + 1)
    }
    if (type.kind === 'map') {
      if (!isAuthorMap(value)) return false
      const entries = Object.getOwnPropertyDescriptor(value, 'entries')
      if (!dataDescriptor(entries) || !Array.isArray(entries.value)) return false
      const entryDescriptors = ownDescriptors(entries.value)
      const length = entryDescriptors.length
      if (!dataDescriptor(length)) return false
      return Array.from({ length: length.value as number }, (_, index) => entryDescriptors[String(index)]).every(entryDescriptor => {
        if (!dataDescriptor(entryDescriptor) || !Array.isArray(entryDescriptor.value)) return false
        const pairDescriptors = ownDescriptors(entryDescriptor.value)
        const pairLength = pairDescriptors.length
        return dataDescriptor(pairLength) && pairLength.value === 2
          && dataDescriptor(pairDescriptors['0']) && dataDescriptor(pairDescriptors['1'])
          && validateValue(pairDescriptors['0'].value, type.key, schemas, depth + 1)
          && validateValue(pairDescriptors['1'].value, type.value, schemas, depth + 1)
      })
    }
    const schema = resolveRecordSchema(type.schema, schemas)
    return !!schema && validateRecord(value, schema, schemas, depth + 1)
  }
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'boolean' || type === 'string') return typeof value === type
  if (type === 'null') return value === null
  if (['piece', 'player', 'card', 'content'].includes(type)) return typeof value === 'string' && value.length > 0
  if (type === 'cell') {
    if (!object(value)) return false
    const x = Object.getOwnPropertyDescriptor(value, 'x')
    const y = Object.getOwnPropertyDescriptor(value, 'y')
    return dataDescriptor(x) && dataDescriptor(y) && Number.isInteger(x.value) && Number.isInteger(y.value)
  }
  if (['record', 'status', 'event', 'choice'].includes(type)) return object(value)
  if (type === 'path') return Array.isArray(value) && validateValue(value, { kind: 'list', element: 'cell' }, schemas, depth + 1)
  return false
}
function validateRecord(value: unknown, schema: GameplayRecordSchema, schemas: readonly GameplayRecordSchema[], depth = 0): value is Value {
  if (!object(value)) return false
  const descriptors = ownDescriptors(value)
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) return false
  if (!Object.keys(descriptors).every(key => schema.fields.some(field => field.name === key))) return false
  return schema.fields.every(field => {
    const descriptor = descriptors[field.name]
    if (!descriptor) return !!field.optional
    if (!dataDescriptor(descriptor) || !descriptor.enumerable) return false
    return field.nullable && descriptor.value === null || validateValue(descriptor.value, field.type, schemas, depth + 1)
  })
}

/** Shared validation for typed author values crossing a host boundary. */
export function requireAuthorValue(value: unknown, type: GameplayValueType, schemas: readonly GameplayRecordSchema[] = []): unknown {
  if (!strictAuthorJson(value)) throw new Error('作者值必须是有限JSON值')
  if (utf8ByteLength(safeAuthorJson(value)) > AUTHOR_CONTAINER_MAX_BYTES) throw new Error('作者值超过64KB')
  if (!validateValue(value, type, schemas)) throw new Error('作者值不符合指定类型')
  return value
}
function declarationValid(declaration: Declaration): void {
  const key = declaration.schema.fields.find(field => field.name === declaration.keyField)
  if (!key || key.optional || key.nullable || !['string', 'number', 'boolean', 'piece', 'player', 'card', 'content', 'cell'].includes(String(key.type))) {
    throw new Error('extension：映射键必须是必填的值或实体引用字段')
  }
}

/** Typed, owner-private maps; storage is the existing versioned flowState. */
export function createAuthorExtensionRuntime(store: Store) {
  const access = (scope: Scope, owner: string, namespace: string, name: string, path: string | readonly string[]) => {
    const stored = store.get(scope, owner, namespace, name)
    if (stored === undefined) throw new Error('extension：变量不存在 ' + namespace + '.' + name)
    if (!strictAuthorJson(stored)) throw new Error('extension：变量数据无效')
    const root = stored
    if (typeof path !== 'string' && !Array.isArray(path)) throw new Error('extension：字段路径无效')
    const segments: string[] = typeof path === 'string' ? (path === '' ? [] : path.split('.')) : [...path]
    if (segments.some(segment => typeof segment !== 'string')) throw new Error('extension：字段路径无效')
    if (segments.length > 40 || segments.some(key => !key || ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('extension：字段路径无效')
    let value: unknown = root
    let parent: Value | unknown[] | undefined
    let key: string | number | undefined
    for (const segment of segments) {
      if (!object(value) && !Array.isArray(value)) throw new Error('extension：字段不存在 ' + path)
      parent = value
      // Author tuples use one-based indices, including in a custom field path.
      key = Array.isArray(value) ? (/^[1-9][0-9]*$/.test(segment) ? Number(segment) - 1 : -1) : segment
      if (!Object.hasOwn(value, key)) throw new Error('extension：字段不存在 ' + path)
      value = (value as Value)[key]
    }
    return { stored, root, value, parent, key }
  }
  const check = (value: unknown, type: GameplayValueType, schemas: readonly GameplayRecordSchema[]) => {
    try {
      requireAuthorValue(value, type, schemas)
    } catch {
      throw new Error('extension：字段不符合指定类型')
    }
  }
  const load = (owner: string, namespace: string, name: string, declaration: Declaration): StoredMap => {
    declarationValid(declaration)
    const stored = store.get('player', owner, namespace, name)
    const legacy = stored === undefined ? store.getLegacyMap?.(owner, namespace, name, declaration) : undefined
    if (legacy !== undefined) {
      if (!strictAuthorJson(legacy) || !object(legacy) || legacy.format !== 'author-extension-map/v1') throw new Error('extension：变量数据无效')
      if (canonical(legacy.declaration) !== canonical(declaration)) throw new Error('extension：同名变量的声明类型不一致')
      if (!Array.isArray(legacy.items) || !legacy.items.every(item => validateRecord(item, declaration.schema, declaration.schemas))) throw new Error('extension：映射记录不符合声明')
      return legacy
    }
    if (!strictAuthorJson(stored) || !object(stored) || stored.format !== 'author-extension-map/v1') throw new Error('extension：变量尚未声明')
    if (canonical(stored.declaration) !== canonical(declaration)) throw new Error('extension：同名变量的声明类型不一致')
    if (!Array.isArray(stored.items) || !stored.items.every(item => validateRecord(item, declaration.schema, declaration.schemas))) throw new Error('extension：映射记录不符合声明')
    return stored as StoredMap
  }
  return {
    declareValue(scope: Scope, owner: string, namespace: string, name: string, type: GameplayValueType, schemas: readonly GameplayRecordSchema[], initial: unknown) {
      const selectedSchemas = authorValueSchemas(type, schemas)
      check(initial, type, schemas)
      const existing = store.get(scope, owner, namespace, name)
      const declaration = store.getDeclaration(scope, owner, namespace, name)
      if (declaration) {
        if (canonical(declaration.type) !== canonical(type) || canonical(authorValueSchemas(declaration.type, declaration.schemas)) !== canonical(selectedSchemas)) throw new Error('extension：同名变量的声明类型不一致')
        check(existing, type, schemas)
        return existing
      }
      const value = existing === undefined ? initial : existing
      check(value, type, schemas)
      const nextDeclaration = { type, schemas: selectedSchemas }
      if (existing === undefined && store.declare) {
        const declared = store.declare(scope, owner, namespace, name, value, nextDeclaration)
        // `undefined` means that this store does not own the declaration-only
        // path for the requested scope.  Normal stores retain their existing
        // persistent-first-declaration behavior.
        if (declared !== undefined) {
          check(declared, type, schemas)
          return declared
        }
      }
      if (store.set(scope, owner, namespace, name, value, nextDeclaration) === false) throw new Error('extension：声明被存储拒绝')
      return value
    },
    readValue(scope: Scope, owner: string, namespace: string, name: string, path: string | readonly string[], type: GameplayValueType, schemas: readonly GameplayRecordSchema[]) {
      const { value } = access(scope, owner, namespace, name, path)
      check(value, type, schemas)
      return value
    },
    /**
     * Read an optional extension root or field without declaring it.
     *
     * Compatibility migrations use this when the legacy state treated a
     * missing value as its caller-provided default.  Returning null keeps the
     * result inside the author value model, while the store remains untouched
     * when the root value is absent.  Existing values still go through the
     * same path and type checks as a normal read.
     */
    readValueOrNull(scope: Scope, owner: string, namespace: string, name: string, path: string | readonly string[], type: GameplayValueType, schemas: readonly GameplayRecordSchema[]) {
      if (store.get(scope, owner, namespace, name) === undefined) return null
      const { value } = access(scope, owner, namespace, name, path)
      check(value, type, schemas)
      return value
    },
    writeValue(scope: Scope, owner: string, namespace: string, name: string, path: string | readonly string[], type: GameplayValueType, schemas: readonly GameplayRecordSchema[], value: unknown) {
      const current = access(scope, owner, namespace, name, path)
      check(current.value, type, schemas)
      check(value, type, schemas)
      if (current.parent !== undefined && current.key !== undefined) (current.parent as Value)[current.key] = value
      const updated = current.parent === undefined ? value : current.root
      const declaration = store.getDeclaration(scope, owner, namespace, name)
      if (declaration) {
        check(updated, declaration.type, declaration.schemas)
        const persisted = store.set(scope, owner, namespace, name, updated, declaration)
        return persisted === false ? null : value
      }
      const persisted = store.set(scope, owner, namespace, name, updated)
      return persisted === false ? null : value
    },
    removeValue(scope: Scope, owner: string, namespace: string, name: string, type: GameplayValueType, schemas: readonly GameplayRecordSchema[]) {
      const existing = store.get(scope, owner, namespace, name)
      if (existing === undefined) return false
      check(existing, type, schemas)
      const declaration = store.getDeclaration(scope, owner, namespace, name)
      if (declaration) check(existing, declaration.type, declaration.schemas)
      if (!store.remove) throw new Error('extension：变量删除未提供')
      store.remove(scope, owner, namespace, name)
      return true
    },
    declareMap(owner: string, namespace: string, name: string, declaration: Declaration) {
      declarationValid(declaration)
      const existing = store.get('player', owner, namespace, name)
      if (existing === undefined) {
        const legacy = store.getLegacyMap?.(owner, namespace, name, declaration)
        if (legacy !== undefined) return load(owner, namespace, name, declaration).items
      }
      if (existing !== undefined) return load(owner, namespace, name, declaration).items
      const value: StoredMap = { format: 'author-extension-map/v1', declaration, items: [] }
      store.set('player', owner, namespace, name, value)
      return []
    },
    mapItems(owner: string, namespace: string, name: string, declaration: Declaration) {
      return load(owner, namespace, name, declaration).items
    },
    mapPut(owner: string, namespace: string, name: string, declaration: Declaration, item: Value) {
      const stored = load(owner, namespace, name, declaration)
      if (!strictAuthorJson(item) || !validateRecord(item, declaration.schema, declaration.schemas)) throw new Error('extension：写入记录不符合声明')
      const key = canonical(item[declaration.keyField])
      const items = stored.items.slice()
      const index = items.findIndex(value => canonical(value[declaration.keyField]) === key)
      if (index === -1) items.push(item)
      else items[index] = item
      if (store.get('player', owner, namespace, name) === undefined && store.setLegacyMap?.(owner, namespace, name, declaration, items)) return true
      store.set('player', owner, namespace, name, { ...stored, items })
      return true
    },
    mapRemove(owner: string, namespace: string, name: string, declaration: Declaration, item: Value) {
      const stored = load(owner, namespace, name, declaration)
      if (!strictAuthorJson(item)) throw new Error('extension：映射键无效')
      const keyDescriptor = Object.getOwnPropertyDescriptor(item, declaration.keyField)
      if (!dataDescriptor(keyDescriptor)) throw new Error('extension：缺少映射键')
      const key = canonical(keyDescriptor.value)
      const items = stored.items.filter(value => canonical(value[declaration.keyField]) !== key)
      if (store.get('player', owner, namespace, name) === undefined && store.setLegacyMap?.(owner, namespace, name, declaration, items)) return true
      store.set('player', owner, namespace, name, { ...stored, items })
      return true
    },
  }
}
