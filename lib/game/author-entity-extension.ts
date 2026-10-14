import {
  authorValueSchemas,
  cloneAuthorValue,
  requireAuthorValue,
  type AuthorValueDeclaration,
} from './author-extension'
import type { GameplayRecordSchema, GameplayValueType } from '../skill-graph/module-types'

/** Runtime entities that own an actual, serialized extension record. */
export type AuthorEntityKind = 'skill' | 'status' | 'rule' | 'card' | 'cluster' | 'tile-effect'

/**
 * Optional declaration metadata stored beside an entity's extension.
 *
 * The metadata is intentionally attached to the entity instead of a flow
 * state table. It lets old saves acquire a declaration on first use while
 * keeping the concrete extension value as the only mutable runtime source.
 */
export type AuthorEntityExtensionDeclarations = Record<string, AuthorValueDeclaration>

export type AuthorEntityExtensionTarget = {
  extension?: Record<string, unknown>
  authorExtensionDeclarations?: AuthorEntityExtensionDeclarations
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor', '__authorNamespaces'])
/**
 * Content extensions historically live directly under `extension[name]`.
 * Keep that layout for the default content namespace, and put every other
 * namespace below this reserved record so two authors can use the same name
 * without sharing a value.  The key is deliberately reserved above instead
 * of being available as an ordinary content field.
 */
const NAMESPACED_EXTENSIONS_KEY = '__authorNamespaces'
const MAX_PATH_SEGMENTS = 40
const MAX_KEY_LENGTH = 120
const MISSING = Symbol('author-entity-extension-missing')

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  } catch {
    return false
  }
}

function assertKey(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_KEY_LENGTH || FORBIDDEN_KEYS.has(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`extension：${label}无效`)
  }
  return value
}

function declarationKey(namespace: string, name: string): string {
  const checkedNamespace = assertKey(namespace, '扩展分组')
  const checkedName = assertKey(name, '扩展变量')
  // Retain the original metadata spelling for the common case so existing
  // saves and editor diagnostics remain readable. Once either component has
  // a dot, a separator-only key is ambiguous (a.b/c == a/b.c); a NUL-prefixed
  // JSON tuple is unambiguous while remaining a normal JSON object key.
  return checkedNamespace.includes('.') || checkedName.includes('.')
    ? `\u0000${JSON.stringify([checkedNamespace, checkedName])}`
    : `${checkedNamespace}.${checkedName}`
}

export function authorEntityDeclarationKey(namespace: string, name: string): string {
  return declarationKey(namespace, name)
}

function normalizePath(path: string | readonly string[] | undefined): string[] {
  const segments = path === undefined
    ? []
    : typeof path === 'string'
      ? (path === '' ? [] : path.split('.'))
      : Array.from(path)
  if (segments.length > MAX_PATH_SEGMENTS || segments.some(segment => typeof segment !== 'string' || segment.length === 0 || segment.length > MAX_KEY_LENGTH || FORBIDDEN_KEYS.has(segment))) {
    throw new Error('extension：字段路径无效')
  }
  return segments
}

function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (seen.has(value)) throw new Error('extension：声明数据不能循环引用')
  seen.add(value)
  try {
    if (Array.isArray(value)) return `[${value.map(item => canonical(item, seen)).join(',')}]`
    if (!isPlainRecord(value)) throw new Error('extension：声明数据必须是普通记录')
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], seen)}`).join(',')}}`
  } finally {
    seen.delete(value)
  }
}

function cloneDeclaration(type: GameplayValueType, schemas: readonly GameplayRecordSchema[]): AuthorValueDeclaration {
  const selectedSchemas = authorValueSchemas(type, schemas)
  // Definitions originate from the validated graph schema table. A JSON
  // round-trip here detaches them from compiler/editor arrays before storing
  // them on the entity, so later graph mutations cannot alter a save.
  const detachedType = JSON.parse(JSON.stringify(type)) as GameplayValueType
  const detachedSchemas = JSON.parse(JSON.stringify(selectedSchemas)) as GameplayRecordSchema[]
  return { type: detachedType, schemas: detachedSchemas }
}

function declarationMatches(existing: AuthorValueDeclaration, type: GameplayValueType, schemas: readonly GameplayRecordSchema[]): boolean {
  try {
    const selected = cloneDeclaration(type, schemas)
    return canonical(existing.type) === canonical(selected.type) && canonical(existing.schemas) === canonical(selected.schemas)
  } catch {
    return false
  }
}

function declarationFor(
  target: AuthorEntityExtensionTarget,
  key: string,
): AuthorValueDeclaration | undefined {
  const declarations = target.authorExtensionDeclarations
  if (declarations === undefined) return undefined
  if (!isPlainRecord(declarations)) throw new Error('extension：实体声明数据无效')
  if (!hasOwn(declarations, key)) return undefined
  const declaration = declarations[key]
  if (!isPlainRecord(declaration) || !('type' in declaration) || !('schemas' in declaration) || !Array.isArray(declaration.schemas)) {
    throw new Error('extension：实体声明数据无效')
  }
  return declaration as unknown as AuthorValueDeclaration
}

function readPath(root: unknown, segments: readonly string[]): unknown {
  let value: unknown = root
  for (const segment of segments) {
    if (!isPlainRecord(value) && !Array.isArray(value)) throw new Error(`extension：字段不存在 ${segments.join('.')}`)
    const key: string | number = Array.isArray(value)
      ? (/^[1-9][0-9]*$/u.test(segment) ? Number(segment) - 1 : -1)
      : segment
    if (typeof key === 'number' && (!Number.isSafeInteger(key) || key < 0)) throw new Error('extension：字段路径无效')
    if (!hasOwn(value, key)) throw new Error(`extension：字段不存在 ${segments.join('.')}`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('extension：不允许访问器字段')
    value = descriptor.value
  }
  return value
}

function writePath(root: unknown, segments: readonly string[], nextValue: unknown): void {
  if (segments.length === 0) throw new Error('extension：字段路径不能为空')
  let value: unknown = root
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]
    if (!isPlainRecord(value) && !Array.isArray(value)) throw new Error(`extension：字段不存在 ${segments.join('.')}`)
    const key: string | number = Array.isArray(value)
      ? (/^[1-9][0-9]*$/u.test(segment) ? Number(segment) - 1 : -1)
      : segment
    if (typeof key === 'number' && (!Number.isSafeInteger(key) || key < 0)) throw new Error('extension：字段路径无效')
    if (!hasOwn(value, key)) throw new Error(`extension：字段不存在 ${segments.join('.')}`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('extension：不允许访问器字段')
    value = descriptor.value
  }
  if (!isPlainRecord(value) && !Array.isArray(value)) throw new Error(`extension：字段不存在 ${segments.join('.')}`)
  const finalSegment = segments[segments.length - 1]
  const key: string | number = Array.isArray(value)
    ? (/^[1-9][0-9]*$/u.test(finalSegment) ? Number(finalSegment) - 1 : -1)
    : finalSegment
  if (typeof key === 'number' && (!Number.isSafeInteger(key) || key < 0)) throw new Error('extension：字段路径无效')
  if (!hasOwn(value, key)) throw new Error(`extension：字段不存在 ${segments.join('.')}`)
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || descriptor.writable === false) throw new Error('extension：字段不可写')
  ;(value as Record<string | number, unknown>)[key] = nextValue
}

type RecordSnapshot = { target: Record<string, unknown>; descriptors: Map<PropertyKey, PropertyDescriptor> }

function captureRecord(value: Record<string, unknown>): RecordSnapshot {
  return { target: value, descriptors: new Map(Reflect.ownKeys(value).map(key => [key, Object.getOwnPropertyDescriptor(value, key)!])) }
}

function restoreRecord(snapshot: RecordSnapshot): void {
  const currentKeys = Reflect.ownKeys(snapshot.target)
  const originalKeys = new Set(snapshot.descriptors.keys())
  for (const key of currentKeys) if (!originalKeys.has(key)) Reflect.deleteProperty(snapshot.target, key)
  for (const [key, descriptor] of snapshot.descriptors) Object.defineProperty(snapshot.target, key, descriptor)
}

/** Replace a plain record without replacing its object identity. */
function commitRecord(target: Record<string, unknown>, candidate: Record<string, unknown>): void {
  const snapshot = captureRecord(target)
  try {
    for (const key of Reflect.ownKeys(target)) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key)
      if (!descriptor?.configurable) throw new Error('extension：实体扩展字段不可重写')
    }
    for (const key of Reflect.ownKeys(target)) Reflect.deleteProperty(target, key)
    for (const key of Reflect.ownKeys(candidate)) {
      if (typeof key !== 'string') throw new Error('extension：实体扩展不支持Symbol字段')
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key)
      if (!descriptor || !('value' in descriptor)) throw new Error('extension：实体扩展字段无效')
      Object.defineProperty(target, key, { configurable: true, enumerable: true, writable: true, value: descriptor.value })
    }
  } catch (error) {
    try { restoreRecord(snapshot) } catch { /* Preserve the first mutation failure. */ }
    throw error
  }
}

function ensureExtensionRoot(target: AuthorEntityExtensionTarget, create: boolean): Record<string, unknown> {
  const root = target.extension
  if (root === undefined) {
    if (!create) throw new Error('extension：实体扩展尚未声明')
    const created: Record<string, unknown> = {}
    target.extension = created
    return created
  }
  if (!isPlainRecord(root)) throw new Error('extension：实体扩展必须是普通记录')
  // Validate the complete persisted root before any read or write. This keeps
  // legacy saves with accessors, sparse arrays, reserved fields, or oversized
  // containers from becoming an alternate mutable representation.
  try {
    requireAuthorValue(root, 'record', [])
  } catch (error) {
    throw new Error(`extension：实体扩展数据无效${error instanceof Error ? `：${error.message}` : ''}`)
  }
  return root
}

/** Resolve the physical record for one entity extension namespace. */
function extensionContainer(
  root: Record<string, unknown>,
  namespace: string,
  create: boolean,
): Record<string, unknown> | undefined {
  const checkedNamespace = assertKey(namespace, '扩展分组')
  if (checkedNamespace === 'content') return root

  let namespaces: Record<string, unknown>
  if (hasOwn(root, NAMESPACED_EXTENSIONS_KEY)) {
    const value = root[NAMESPACED_EXTENSIONS_KEY]
    if (!isPlainRecord(value)) throw new Error('extension：实体命名空间数据无效')
    namespaces = value
  } else {
    if (!create) return undefined
    namespaces = {}
    Object.defineProperty(root, NAMESPACED_EXTENSIONS_KEY, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: namespaces,
    })
  }

  if (hasOwn(namespaces, checkedNamespace)) {
    const value = namespaces[checkedNamespace]
    if (!isPlainRecord(value)) throw new Error('extension：实体命名空间数据无效')
    return value
  }
  if (!create) return undefined
  const created: Record<string, unknown> = {}
  Object.defineProperty(namespaces, checkedNamespace, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: created,
  })
  return created
}

function ensureDeclarationsRoot(target: AuthorEntityExtensionTarget): AuthorEntityExtensionDeclarations {
  const existing = target.authorExtensionDeclarations
  if (existing !== undefined) {
    if (!isPlainRecord(existing)) throw new Error('extension：实体声明数据无效')
    try {
      requireAuthorValue(existing, 'record', [])
    } catch (error) {
      throw new Error(`extension：实体声明数据无效${error instanceof Error ? `：${error.message}` : ''}`)
    }
    return existing as AuthorEntityExtensionDeclarations
  }
  const created: AuthorEntityExtensionDeclarations = {}
  target.authorExtensionDeclarations = created
  return created
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return cloneAuthorValue(value, 'record', []) as Record<string, unknown>
}

function checkDeclaration(
  target: AuthorEntityExtensionTarget,
  namespace: string,
  name: string,
  type: GameplayValueType,
  schemas: readonly GameplayRecordSchema[],
): { key: string; declaration: AuthorValueDeclaration } {
  const key = declarationKey(namespace, name)
  const declaration = declarationFor(target, key)
  if (!declaration || !declarationMatches(declaration, type, schemas)) {
    throw new Error('extension：同名实体变量的声明类型不一致或尚未声明')
  }
  return { key, declaration }
}

export function declareAuthorEntityExtension(
  target: AuthorEntityExtensionTarget,
  namespace: string,
  name: string,
  type: GameplayValueType,
  schemas: readonly GameplayRecordSchema[],
  initial: unknown,
): unknown {
  const key = declarationKey(namespace, name)
  const detachedDeclaration = cloneDeclaration(type, schemas)
  const initialCopy = cloneAuthorValue(initial, type, schemas)
  const root = target.extension === undefined ? undefined : ensureExtensionRoot(target, false)
  const declarations = target.authorExtensionDeclarations === undefined ? undefined : ensureDeclarationsRoot(target)
  const existingDeclaration = declarations ? declarationFor(target, key) : undefined
  if (existingDeclaration && !declarationMatches(existingDeclaration, type, schemas)) {
    throw new Error('extension：同名实体变量的声明类型不一致')
  }

  const currentContainer = root === undefined ? undefined : extensionContainer(root, namespace, false)
  const currentValue = currentContainer && hasOwn(currentContainer, name) ? readPath(currentContainer, [name]) : MISSING
  if (currentValue !== MISSING) {
    const currentCopy = cloneAuthorValue(currentValue, type, schemas)
    if (existingDeclaration) return currentCopy
    // Existing extension data from an older save is authoritative. Declaration
    // metadata is added only after its value has passed the new type boundary.
    const declarationRoot = declarations ?? ensureDeclarationsRoot(target)
    const snapshot = captureRecord(declarationRoot)
    try {
      Object.defineProperty(declarationRoot, key, { configurable: true, enumerable: true, writable: true, value: detachedDeclaration })
    } catch (error) {
      try { restoreRecord(snapshot) } catch { /* Preserve the first failure. */ }
      throw error
    }
    return currentCopy
  }

  const candidate = root === undefined ? {} : cloneRecord(root)
  const candidateContainer = extensionContainer(candidate, namespace, true)!
  Object.defineProperty(candidateContainer, name, { configurable: true, enumerable: true, writable: true, value: initialCopy })
  const declarationRoot = declarations === undefined ? {} : cloneRecord(declarations as Record<string, unknown>) as AuthorEntityExtensionDeclarations
  Object.defineProperty(declarationRoot, key, { configurable: true, enumerable: true, writable: true, value: detachedDeclaration })

  const rootBefore = root && captureRecord(root)
  const declarationsBefore = target.authorExtensionDeclarations && captureRecord(target.authorExtensionDeclarations as Record<string, unknown>)
  try {
    if (root === undefined) target.extension = candidate
    else commitRecord(root, candidate)
    if (target.authorExtensionDeclarations === undefined) target.authorExtensionDeclarations = declarationRoot
    else commitRecord(target.authorExtensionDeclarations as Record<string, unknown>, declarationRoot)
  } catch (error) {
    if (root && rootBefore) {
      try { restoreRecord(rootBefore) } catch { /* Preserve the first failure. */ }
    } else if (root === undefined) delete target.extension
    if (target.authorExtensionDeclarations && declarationsBefore) {
      try { restoreRecord(declarationsBefore) } catch { /* Preserve the first failure. */ }
    } else if (declarations === undefined) delete target.authorExtensionDeclarations
    throw error
  }
  return cloneAuthorValue(initialCopy, type, schemas)
}

export function readAuthorEntityExtension(
  target: AuthorEntityExtensionTarget,
  namespace: string,
  name: string,
  path: string | readonly string[] | undefined,
  type: GameplayValueType,
  schemas: readonly GameplayRecordSchema[],
): unknown {
  checkDeclaration(target, namespace, name, type, schemas)
  const root = ensureExtensionRoot(target, false)
  const container = extensionContainer(root, namespace, false)
  if (!container) throw new Error(`extension：字段不存在 ${name}`)
  const value = readPath(container, [name, ...normalizePath(path)])
  return cloneAuthorValue(value, type, schemas)
}

export function writeAuthorEntityExtension(
  target: AuthorEntityExtensionTarget,
  namespace: string,
  name: string,
  path: string | readonly string[] | undefined,
  type: GameplayValueType,
  schemas: readonly GameplayRecordSchema[],
  value: unknown,
): unknown {
  checkDeclaration(target, namespace, name, type, schemas)
  const root = ensureExtensionRoot(target, false)
  const container = extensionContainer(root, namespace, false)
  if (!container) throw new Error(`extension：字段不存在 ${name}`)
  const segments = [name, ...normalizePath(path)]
  const current = readPath(container, segments)
  requireAuthorValue(current, type, schemas)
  const valueCopy = cloneAuthorValue(value, type, schemas)
  const candidate = cloneRecord(root)
  const candidateContainer = extensionContainer(candidate, namespace, false)
  if (!candidateContainer) throw new Error(`extension：字段不存在 ${name}`)
  writePath(candidateContainer, segments, valueCopy)
  // The declaration covers the named root, so validate the complete root value
  // before touching the authoritative object. This makes malformed writes
  // atomic even when nested containers or accessors are involved.
  const declaration = checkDeclaration(target, namespace, name, type, schemas).declaration
  const candidateValue = extensionContainer(candidate, namespace, false)
  if (!candidateValue) throw new Error(`extension：字段不存在 ${name}`)
  const rootValue = readPath(candidateValue, [name])
  requireAuthorValue(rootValue, declaration.type, declaration.schemas)
  commitRecord(root, candidate)
  const committedContainer = extensionContainer(root, namespace, false)
  if (!committedContainer) throw new Error(`extension：字段不存在 ${name}`)
  return cloneAuthorValue(readPath(committedContainer, segments), type, schemas)
}

/** Small adapter used by flow-runtime and tests to keep resolution separate. */
export function createAuthorEntityExtensionRuntime(
  resolve: (kind: AuthorEntityKind, reference: unknown) => AuthorEntityExtensionTarget | undefined,
) {
  const target = (kind: AuthorEntityKind, reference: unknown): AuthorEntityExtensionTarget => {
    const resolved = resolve(kind, reference)
    if (!resolved) throw new Error(`extension：${kind}实例已经失效`)
    return resolved
  }
  return {
    declare: (kind: AuthorEntityKind, reference: unknown, namespace: string, name: string, type: GameplayValueType, schemas: readonly GameplayRecordSchema[], initial: unknown) => declareAuthorEntityExtension(target(kind, reference), namespace, name, type, schemas, initial),
    read: (kind: AuthorEntityKind, reference: unknown, namespace: string, name: string, path: string | readonly string[] | undefined, type: GameplayValueType, schemas: readonly GameplayRecordSchema[]) => readAuthorEntityExtension(target(kind, reference), namespace, name, path, type, schemas),
    write: (kind: AuthorEntityKind, reference: unknown, namespace: string, name: string, path: string | readonly string[] | undefined, type: GameplayValueType, schemas: readonly GameplayRecordSchema[], value: unknown) => writeAuthorEntityExtension(target(kind, reference), namespace, name, path, type, schemas, value),
  }
}
