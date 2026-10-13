/**
 * Runtime adapter for author-owned, data-only pending code blocks.
 *
 * The persisted block is always revalidated and compiled by
 * `compileAuthorCodeBlockWithArguments` before this adapter asks the dynamic
 * code runtime to materialize the trusted compiler output.  This module does
 * not interpret author data and does not retain a process-wide execution
 * budget.
 */

import {
  compileAuthorCodeBlockWithArguments,
  type AuthorCodeBlockArguments,
} from '../skill-graph/author-code-block'
import { GAMEPLAY_MODULE_REGISTRY } from '../skill-graph/module-registry'
import type {
  GameplayModuleCompilerOptions,
  GameplayModuleRegistry,
  GameplayPort,
  GameplayRecordSchema,
  GameplayValueType,
} from '../skill-graph/module-types'
import type { DynamicCodeRequest } from './dynamic-code-runtime'

/**
 * The injected shape matches `DynamicCodeRuntime.compileExpression` while
 * also allowing a test double or a host-owned runtime facade.
 */
export type AuthorCodeBlockCompileExpression = (request: DynamicCodeRequest) => unknown

/** Ephemeral host key used by a generic registry module to invoke a child block. */
export const AUTHOR_CODE_BLOCK_INVOKE_CONTEXT_KEY = '__authorCodeBlockInvoke' as const

export type AuthorCodeBlockRuntimeLimits = {
  /** Maximum block entries in one top-level adapter invocation. */
  readonly maxInvocations?: number
  /** Maximum nested block depth in one top-level adapter invocation. */
  readonly maxRecursionDepth?: number
}

/**
 * The result contract supplied by the calling graph's type binding.  It is
 * deliberately accepted as an unknown value at the host boundary and copied
 * into this closed shape only after validation.
 */
export type AuthorCodeBlockExpectedResult = {
  readonly type: GameplayValueType
  readonly schemas: readonly GameplayRecordSchema[]
}

export type AuthorCodeBlockRuntimeOptions = AuthorCodeBlockRuntimeLimits & {
  readonly compileExpression: AuthorCodeBlockCompileExpression
  /** Current gameplay flow exposed to generated pending modules as `ctx.flow`. */
  readonly flow?: unknown
  /** Current host execution context. Its diagnostic host is preserved. */
  readonly context?: object
  readonly registry?: GameplayModuleRegistry
  readonly compilerOptions?: GameplayModuleCompilerOptions
  /** Optional nested form for callers that keep runtime limits together. */
  readonly limits?: AuthorCodeBlockRuntimeLimits
}

export type AuthorCodeBlockNestedInvoke = (
  block: unknown,
  argumentsValue: AuthorCodeBlockArguments,
  expectedResult?: unknown,
) => unknown

export type AuthorCodeBlockExecutor = {
  (block: unknown, argumentsValue: AuthorCodeBlockArguments, expectedResult?: unknown): unknown
  /** Execute one top-level block with a fresh invocation budget. */
  readonly execute: (block: unknown, argumentsValue: AuthorCodeBlockArguments, expectedResult?: unknown) => unknown
  /** Alias used by generic host modules for nested block calls. */
  readonly invoke: (block: unknown, argumentsValue: AuthorCodeBlockArguments, expectedResult?: unknown) => unknown
}

export type AuthorCodeBlockRuntimeErrorCode =
  | 'AUTHOR_CODE_BLOCK_RUNTIME_INVALID_LIMIT'
  | 'AUTHOR_CODE_BLOCK_RUNTIME_INVOCATION_LIMIT'
  | 'AUTHOR_CODE_BLOCK_RUNTIME_RECURSION_LIMIT'
  | 'AUTHOR_CODE_BLOCK_RUNTIME_ENTRY'
  | 'AUTHOR_CODE_BLOCK_RUNTIME_RESULT'

export class AuthorCodeBlockRuntimeError extends Error {
  readonly name = 'AuthorCodeBlockRuntimeError'

  constructor(
    readonly code: AuthorCodeBlockRuntimeErrorCode,
    message: string,
    readonly limit?: number,
    readonly used?: number,
  ) {
    super(message)
  }
}

const DEFAULT_MAX_INVOCATIONS = 64
const DEFAULT_MAX_RECURSION_DEPTH = 64

type InvocationBudget = {
  invocations: number
  depth: number
}

function readDataProperty(value: object | undefined, key: string): unknown {
  let current: object | null = value ?? null
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor) return 'value' in descriptor ? descriptor.value : undefined
    current = Object.getPrototypeOf(current)
  }
  return undefined
}

function positiveLimit(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new AuthorCodeBlockRuntimeError(
      'AUTHOR_CODE_BLOCK_RUNTIME_INVALID_LIMIT',
      `${name} must be a positive safe integer`,
    )
  }
  return value
}

/**
 * Add runtime-only fields without spreading the current context.  The
 * prototype preserves non-enumerable diagnostic hosts installed by the game
 * runtime, while own `flow` and `payload` fields are isolated per call.
 */
function makeExecutionContext(
  baseContext: object | undefined,
  flow: unknown,
  payload: Readonly<Record<string, unknown>>,
  invoke: AuthorCodeBlockNestedInvoke,
): Record<string, unknown> {
  const context = Object.create(baseContext ?? null) as Record<string, unknown>
  Object.defineProperties(context, {
    flow: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: flow,
    },
    payload: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: payload,
    },
    [AUTHOR_CODE_BLOCK_INVOKE_CONTEXT_KEY]: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: invoke,
    },
  })
  return context
}

function runtimeLimit(
  direct: number | undefined,
  nested: number | undefined,
  name: string,
  fallback: number,
): number {
  return positiveLimit(direct ?? nested, name, fallback)
}

type RuntimeRecord = Record<string, unknown>

function isPlainRuntimeRecord(value: unknown): value is RuntimeRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function resultActualType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value === 'object' ? 'object' : typeof value
}

function resultFailure(path: string, expected: string, value: unknown): never {
  throw new AuthorCodeBlockRuntimeError(
    'AUTHOR_CODE_BLOCK_RUNTIME_RESULT',
    `author code block result ${path} expected ${expected}, received ${resultActualType(value)}`,
  )
}

function resultDataFailure(path: string, message: string): never {
  throw new AuthorCodeBlockRuntimeError(
    'AUTHOR_CODE_BLOCK_RUNTIME_RESULT',
    `author code block result ${path} ${message}`,
  )
}

function ownResultEntries(value: object, path: string, enumerableOnly: boolean): Map<string, unknown> {
  const entries = new Map<string, unknown>()
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') resultDataFailure(path, 'cannot contain symbol keys')
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') resultDataFailure(`${path}.${key}`, 'contains an unsafe key')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) resultDataFailure(`${path}.${key}`, 'cannot contain accessors')
    if (enumerableOnly && !descriptor.enumerable) resultDataFailure(`${path}.${key}`, 'must be enumerable')
    entries.set(key, descriptor.value)
  }
  return entries
}

const EXPECTED_VALUE_TYPE_NAMES = new Set([
  'number', 'boolean', 'string', 'piece', 'player', 'cell', 'path', 'card',
  'content', 'status', 'event', 'choice', 'record', 'null', 'never', 'unknown', 'any',
])

function expectedTypeKeys(entries: Map<string, unknown>, keys: readonly string[], path: string): void {
  if (entries.size !== keys.length || keys.some(key => !entries.has(key))) {
    resultDataFailure(path, `must contain exactly ${keys.join(', ')} fields`)
  }
}

/** Normalize the caller-owned result descriptor before it can reach a validator. */
function normalizeExpectedType(
  value: unknown,
  path: string,
  active: WeakSet<object> = new WeakSet<object>(),
): GameplayValueType {
  if (typeof value === 'string') {
    if (!EXPECTED_VALUE_TYPE_NAMES.has(value)) resultDataFailure(path, `contains an unsupported value type "${value}"`)
    return value as GameplayValueType
  }
  if (!isPlainRuntimeRecord(value)) resultDataFailure(path, 'must be a closed value type descriptor')
  if (active.has(value)) resultDataFailure(path, 'cannot contain cycles')
  active.add(value)
  try {
    const entries = ownResultEntries(value, path, true)
    const kind = entries.get('kind')
    if (kind === 'list' || kind === 'set') {
      expectedTypeKeys(entries, ['kind', 'element'], path)
      return { kind, element: normalizeExpectedType(entries.get('element'), `${path}.element`, active) }
    }
    if (kind === 'map') {
      expectedTypeKeys(entries, ['kind', 'key', 'value'], path)
      return {
        kind: 'map',
        key: normalizeExpectedType(entries.get('key'), `${path}.key`, active),
        value: normalizeExpectedType(entries.get('value'), `${path}.value`, active),
      }
    }
    if (kind === 'nullable') {
      expectedTypeKeys(entries, ['kind', 'value'], path)
      return { kind: 'nullable', value: normalizeExpectedType(entries.get('value'), `${path}.value`, active) }
    }
    if (kind === 'record') {
      expectedTypeKeys(entries, ['kind', 'schema'], path)
      const schema = entries.get('schema')
      if (typeof schema !== 'string' || schema.trim().length === 0) resultDataFailure(`${path}.schema`, 'must be a non-empty schema reference')
      return { kind: 'record', schema }
    }
    resultDataFailure(path, 'contains an unsupported value type descriptor')
  } finally {
    active.delete(value)
  }
}

function normalizeExpectedSchemas(value: unknown, path: string): readonly GameplayRecordSchema[] {
  assertExpectedArray(value, path, 'schema')
  const result: GameplayRecordSchema[] = []
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) resultDataFailure(`${path}[${index}]`, 'is missing from a dense array')
    const schemaValue = value[index]
    if (!isPlainRuntimeRecord(schemaValue)) resultDataFailure(`${path}[${index}]`, 'must be a closed record schema')
    const schemaEntries = ownResultEntries(schemaValue, `${path}[${index}]`, true)
    expectedTypeKeys(schemaEntries, ['id', 'version', 'fields'], `${path}[${index}]`)
    const id = schemaEntries.get('id')
    const version = schemaEntries.get('version')
    if (typeof id !== 'string' || id.trim().length === 0) resultDataFailure(`${path}[${index}].id`, 'must be non-empty text')
    if (typeof version !== 'string' || version.trim().length === 0) resultDataFailure(`${path}[${index}].version`, 'must be non-empty text')
    const fieldsValue = schemaEntries.get('fields')
    assertExpectedArray(fieldsValue, `${path}[${index}].fields`, 'field')
    const fields: GameplayPort[] = []
    for (let fieldIndex = 0; fieldIndex < fieldsValue.length; fieldIndex += 1) {
      if (!Object.prototype.hasOwnProperty.call(fieldsValue, fieldIndex)) resultDataFailure(`${path}[${index}].fields[${fieldIndex}]`, 'is missing from a dense array')
      const fieldValue = fieldsValue[fieldIndex]
      if (!isPlainRuntimeRecord(fieldValue)) resultDataFailure(`${path}[${index}].fields[${fieldIndex}]`, 'must be a closed port')
      const fieldEntries = ownResultEntries(fieldValue, `${path}[${index}].fields[${fieldIndex}]`, true)
      for (const key of fieldEntries.keys()) {
        if (!['name', 'type', 'optional', 'nullable', 'label', 'description'].includes(key)) resultDataFailure(`${path}[${index}].fields[${fieldIndex}].${key}`, 'is not an allowed port field')
      }
      const name = fieldEntries.get('name')
      if (typeof name !== 'string' || name.trim().length === 0) resultDataFailure(`${path}[${index}].fields[${fieldIndex}].name`, 'must be non-empty text')
      const field: Record<string, unknown> = {
        name,
        type: normalizeExpectedType(fieldEntries.get('type'), `${path}[${index}].fields[${fieldIndex}].type`),
      }
      for (const key of ['optional', 'nullable'] as const) {
        if (fieldEntries.has(key)) {
          const entry = fieldEntries.get(key)
          if (typeof entry !== 'boolean') resultDataFailure(`${path}[${index}].fields[${fieldIndex}].${key}`, 'must be boolean')
          field[key] = entry
        }
      }
      for (const key of ['label', 'description'] as const) {
        if (fieldEntries.has(key)) {
          const entry = fieldEntries.get(key)
          if (typeof entry !== 'string') resultDataFailure(`${path}[${index}].fields[${fieldIndex}].${key}`, 'must be text')
          field[key] = entry
        }
      }
      fields.push(field as GameplayPort)
    }
    result.push({ id, version, fields })
  }
  return result
}

function assertExpectedArray(value: unknown, path: string, label: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) resultDataFailure(path, `must be an ordinary ${label} array`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Array.prototype && prototype !== null) resultDataFailure(path, 'must use the ordinary array prototype')
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) resultDataFailure(path, 'must have a data length')
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) resultDataFailure(`${path}[${String(key)}]`, 'contains an invalid array property')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) resultDataFailure(`${path}[${key}]`, 'must contain enumerable data values')
  }
}

function normalizeExpectedResult(value: unknown): AuthorCodeBlockExpectedResult | undefined {
  if (value === undefined) return undefined
  if (!isPlainRuntimeRecord(value)) resultDataFailure('expectedResult', 'must be a closed result descriptor')
  const entries = ownResultEntries(value, 'expectedResult', true)
  expectedTypeKeys(entries, ['type', 'schemas'], 'expectedResult')
  return {
    type: normalizeExpectedType(entries.get('type'), 'expectedResult.type'),
    schemas: normalizeExpectedSchemas(entries.get('schemas'), 'expectedResult.schemas'),
  }
}

function isBroadResultType(type: GameplayValueType): boolean {
  if (typeof type === 'string') return type === 'record' || type === 'unknown' || type === 'any'
  if (type.kind === 'record') return true
  return type.kind === 'nullable' && isBroadResultType(type.value)
}

/**
 * Check the part of the caller contract that can be known without executing
 * generated code. Record contracts remain broad here because the generated
 * graph may return either a scalar or a one-output record wrapper; the actual
 * value is checked against the caller's schema after execution.
 */
function resultTypesCompatible(declared: GameplayValueType, expected: GameplayValueType): boolean {
  if (isBroadResultType(expected)) return true
  if (typeof expected === 'object' && expected.kind === 'nullable') {
    if (declared === 'null') return true
    if (typeof declared === 'object' && declared.kind === 'nullable') return resultTypesCompatible(declared.value, expected.value)
    return resultTypesCompatible(declared, expected.value)
  }
  if (typeof declared === 'object' && declared.kind === 'nullable') return false
  if (isBroadResultType(declared)) return false
  if (typeof declared !== typeof expected) return false
  if (typeof declared === 'string' || typeof expected === 'string') return declared === expected
  if (declared.kind !== expected.kind) return false
  if ((declared.kind === 'list' || declared.kind === 'set') && (expected.kind === 'list' || expected.kind === 'set')) {
    return resultTypesCompatible(declared.element, expected.element)
  }
  if (declared.kind === 'map' && expected.kind === 'map') return resultTypesCompatible(declared.key, expected.key) && resultTypesCompatible(declared.value, expected.value)
  if (declared.kind === 'record' && expected.kind === 'record') return declared.schema === expected.schema
  return false
}

function declaredResultType(outputs: readonly GameplayPort[]): GameplayValueType {
  if (outputs.length === 0) return 'null'
  if (outputs.length === 1) return outputs[0].nullable ? { kind: 'nullable', value: outputs[0].type } : outputs[0].type
  return 'record'
}

function validateResultArray(
  value: unknown,
  elementType: GameplayValueType,
  schemas: readonly GameplayRecordSchema[],
  path: string,
  active: WeakSet<object>,
): void {
  if (!Array.isArray(value)) resultFailure(path, 'an array', value)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Array.prototype && prototype !== null) resultDataFailure(path, 'must use the ordinary array prototype')
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) resultDataFailure(path, 'must have a data length')
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) resultDataFailure(`${path}[${String(key)}]`, 'contains an invalid array property')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) resultDataFailure(`${path}[${key}]`, 'must be an enumerable data value')
  }
  if (active.has(value)) resultDataFailure(path, 'cannot contain cycles')
  active.add(value)
  try {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) resultDataFailure(`${path}[${index}]`, 'is missing from a dense array')
      validateResultValue(value[index], elementType, schemas, `${path}[${index}]`, active)
    }
  } finally {
    active.delete(value)
  }
}

function validateOpaqueResultReference(value: unknown, path: string): void {
  if (typeof value === 'string') return
  if (value === null || typeof value !== 'object' || Array.isArray(value)) resultFailure(path, 'an opaque entity reference', value)
  // Entity references are host-owned objects and may have a custom prototype.
  // Their own surface still must not expose executable values or accessors.
  ownResultEntries(value, path, false)
  for (const [key, entry] of ownResultEntries(value, path, false)) {
    if (typeof entry === 'undefined' || typeof entry === 'function' || typeof entry === 'symbol' || typeof entry === 'bigint') {
      resultDataFailure(`${path}.${key}`, 'cannot contain executable or non-serializable values')
    }
    if (typeof entry === 'number' && !Number.isFinite(entry)) resultDataFailure(`${path}.${key}`, 'must contain finite numbers')
  }
}

function validateCellResult(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) resultFailure(path, 'a cell object', value)
  const entries = ownResultEntries(value, path, false)
  if (!Number.isInteger(entries.get('x')) || !Number.isInteger(entries.get('y'))) resultFailure(path, 'a cell with integer x and y fields', value)
  for (const [key, entry] of entries) {
    if (typeof entry === 'undefined' || typeof entry === 'function' || typeof entry === 'symbol' || typeof entry === 'bigint') {
      resultDataFailure(`${path}.${key}`, 'cannot contain executable or non-serializable values')
    }
    if (typeof entry === 'number' && !Number.isFinite(entry)) resultDataFailure(`${path}.${key}`, 'must contain finite numbers')
  }
}

function findResultSchema(schemas: readonly GameplayRecordSchema[], reference: string, path: string): GameplayRecordSchema {
  const matches = schemas.filter(schema => schema.id === reference || `${schema.id}@${schema.version}` === reference)
  if (matches.length !== 1) resultDataFailure(path, `references an unknown or ambiguous record schema "${reference}"`)
  return matches[0]
}

function validateUntypedResultRecord(
  value: unknown,
  schemas: readonly GameplayRecordSchema[],
  path: string,
  active: WeakSet<object>,
): void {
  if (!isPlainRuntimeRecord(value)) resultFailure(path, 'a record object', value)
  if (active.has(value)) resultDataFailure(path, 'cannot contain cycles')
  active.add(value)
  try {
    for (const [key, entry] of ownResultEntries(value, path, true)) {
      if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') continue
      if (typeof entry === 'number') {
        if (!Number.isFinite(entry)) resultDataFailure(`${path}.${key}`, 'must contain finite numbers')
        continue
      }
      if (Array.isArray(entry)) {
        validateResultArray(entry, 'unknown', schemas, `${path}.${key}`, active)
        continue
      }
      if (isPlainRuntimeRecord(entry)) {
        validateUntypedResultRecord(entry, schemas, `${path}.${key}`, active)
        continue
      }
      resultDataFailure(`${path}.${key}`, 'must contain data-only values')
    }
  } finally {
    active.delete(value)
  }
}

function validateResultRecord(
  value: unknown,
  schemaReference: string,
  schemas: readonly GameplayRecordSchema[],
  path: string,
  active: WeakSet<object>,
): void {
  if (!isPlainRuntimeRecord(value)) resultFailure(path, `record<${schemaReference}>`, value)
  const schema = findResultSchema(schemas, schemaReference, `${path}.__schema`)
  if (active.has(value)) resultDataFailure(path, 'cannot contain cycles')
  active.add(value)
  try {
    const fields = new Map(schema.fields.map(field => [field.name, field]))
    const entries = ownResultEntries(value, path, true)
    for (const key of entries.keys()) if (!fields.has(key)) resultDataFailure(`${path}.${key}`, 'is not declared by its record schema')
    for (const field of schema.fields) {
      if (!entries.has(field.name)) {
        if (!field.optional) resultDataFailure(`${path}.${field.name}`, 'is required by its record schema')
        continue
      }
      validateResultValue(entries.get(field.name), field.nullable ? { kind: 'nullable', value: field.type } : field.type, schemas, `${path}.${field.name}`, active)
    }
  } finally {
    active.delete(value)
  }
}

function validateResultValue(
  value: unknown,
  type: GameplayValueType,
  schemas: readonly GameplayRecordSchema[],
  path: string,
  active: WeakSet<object>,
): void {
  if (typeof type === 'object') {
    if (type.kind === 'nullable') {
      if (value === null) return
      validateResultValue(value, type.value, schemas, path, active)
      return
    }
    if (type.kind === 'list') {
      validateResultArray(value, type.element, schemas, path, active)
      return
    }
    if (type.kind === 'set') {
      if (!isPlainRuntimeRecord(value)) resultFailure(path, 'a serialized set', value)
      if (active.has(value)) resultDataFailure(path, 'cannot contain cycles')
      active.add(value)
      try {
        const entries = ownResultEntries(value, path, true)
        if (entries.size !== 2 || entries.get('format') !== 'author-set/v1' || !Array.isArray(entries.get('items'))) {
          resultDataFailure(path, 'must use the author-set/v1/items representation')
        }
        validateResultArray(entries.get('items'), type.element, schemas, `${path}.items`, active)
      } finally {
        active.delete(value)
      }
      return
    }
    if (type.kind === 'map') {
      if (!isPlainRuntimeRecord(value)) resultFailure(path, 'a serialized map', value)
      if (active.has(value)) resultDataFailure(path, 'cannot contain cycles')
      active.add(value)
      try {
        const entries = ownResultEntries(value, path, true)
        const rawEntries = entries.get('entries')
        if (entries.size !== 2 || entries.get('format') !== 'author-map/v1' || !Array.isArray(rawEntries)) {
          resultDataFailure(path, 'must use the author-map/v1/entries representation')
        }
        validateResultArray(rawEntries, 'unknown', schemas, `${path}.entries`, active)
        for (let index = 0; index < rawEntries.length; index += 1) {
          const entry = rawEntries[index]
          if (!Array.isArray(entry) || entry.length !== 2) resultFailure(`${path}.entries[${index}]`, 'a two-item map tuple', entry)
          const lengthDescriptor = Object.getOwnPropertyDescriptor(entry, 'length')
          if (!lengthDescriptor || !('value' in lengthDescriptor) || lengthDescriptor.value !== 2 || !Object.prototype.hasOwnProperty.call(entry, 0) || !Object.prototype.hasOwnProperty.call(entry, 1)) resultDataFailure(`${path}.entries[${index}]`, 'must be a dense two-item tuple')
          validateResultValue(entry[0], type.key, schemas, `${path}.entries[${index}][0]`, active)
          validateResultValue(entry[1], type.value, schemas, `${path}.entries[${index}][1]`, active)
        }
      } finally {
        active.delete(value)
      }
      return
    }
    validateResultRecord(value, type.schema, schemas, path, active)
    return
  }
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) resultFailure(path, 'a finite number', value)
    return
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') resultFailure(path, 'a boolean', value)
    return
  }
  if (type === 'string') {
    if (typeof value !== 'string') resultFailure(path, 'a string', value)
    return
  }
  if (type === 'null') {
    if (value !== null) resultFailure(path, 'null', value)
    return
  }
  if (type === 'record') {
    validateUntypedResultRecord(value, schemas, path, active)
    return
  }
  if (type === 'cell') {
    validateCellResult(value, path)
    return
  }
  if (type === 'path') {
    validateResultArray(value, 'cell', schemas, path, active)
    return
  }
  if (type === 'unknown' || type === 'any') {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) resultDataFailure(path, 'must contain finite numbers')
      return
    }
    if (Array.isArray(value)) {
      validateResultArray(value, 'unknown', schemas, path, active)
      return
    }
    if (isPlainRuntimeRecord(value)) {
      validateUntypedResultRecord(value, schemas, path, active)
      return
    }
    resultDataFailure(path, 'must contain data-only values')
  }
  if (type === 'never') {
    resultFailure(path, 'a value that is never produced', value)
    return
  }
  // Entity values remain opaque to the adapter; the graph compiler checks
  // their semantic source types while this boundary rejects executable data.
  validateOpaqueResultReference(value, path)
}

function validateAuthorCodeBlockResult(
  result: unknown,
  definition: { readonly graph: { readonly outputs?: readonly GameplayPort[]; readonly schemas?: readonly GameplayRecordSchema[] } },
  signatureOutputs: readonly GameplayPort[] | undefined,
): void {
  const outputs = signatureOutputs ?? definition.graph.outputs ?? []
  const schemas = definition.graph.schemas ?? []
  const active = new WeakSet<object>()
  if (outputs.length === 0) {
    if (result !== undefined) resultFailure('$', 'undefined', result)
    return
  }

  if (outputs.length === 1) {
    const output = outputs[0]
    if (result === undefined && output.optional) return
    const type = output.nullable ? { kind: 'nullable', value: output.type } as GameplayValueType : output.type
    // A one-output graph may use either `return value` or `return { name: value }`.
    // Prefer the declared output record shape when it is unambiguous, then
    // retain scalar support for graphs that use the scalar return form.
    if (isPlainRuntimeRecord(result)) {
      const entries = ownResultEntries(result, '$', true)
      if (output.optional && entries.size === 0) return
      if (entries.size === 1 && entries.has(output.name)) {
        try {
          validateResultValue(entries.get(output.name), type, schemas, `$.${output.name}`, active)
          return
        } catch (error) {
          if (!(error instanceof AuthorCodeBlockRuntimeError) || error.code !== 'AUTHOR_CODE_BLOCK_RUNTIME_RESULT') throw error
          // A scalar record may itself happen to contain a property named like
          // the output. Primitive/entity outputs have an unambiguous wrapper,
          // so retain the first typed failure for those cases.
          if (!recordOutputType(type)) throw error
        }
      }
    }
    validateResultValue(result, type, schemas, '$', active)
    return
  }

  if (!isPlainRuntimeRecord(result)) resultFailure('$', 'an output record', result)
  const entries = ownResultEntries(result, '$', true)
  const fields = new Map(outputs.map(output => [output.name, output]))
  for (const key of entries.keys()) if (!fields.has(key)) resultDataFailure(`$.${key}`, 'is not a declared output')
  for (const output of outputs) {
    if (!entries.has(output.name)) {
      if (!output.optional) resultDataFailure(`$.${output.name}`, 'is required')
      continue
    }
    const type = output.nullable ? { kind: 'nullable', value: output.type } as GameplayValueType : output.type
    validateResultValue(entries.get(output.name), type, schemas, `$.${output.name}`, active)
  }
}

function recordOutputType(type: GameplayValueType): boolean {
  if (typeof type === 'string') return type === 'record' || type === 'unknown' || type === 'any'
  if (type.kind === 'nullable') return recordOutputType(type.value)
  return type.kind === 'record'
}

/**
 * Create a host adapter for data-only author blocks.
 *
 * Example integration from a pending host:
 *
 * ```ts
 * const executeBlock = createAuthorCodeBlockExecutor({
 *   compileExpression: dynamicCodeRuntime.compileExpression.bind(dynamicCodeRuntime),
 *   flow: executionContext.flow,
 *   context: executionContext,
 * })
 * const value = executeBlock(blockRecord, { target: targetPiece.instanceId })
 * // A generic registry caller may additionally pass its validated result
 * // binding: executeBlock(blockRecord, args, { type: 'record', schemas })
 * ```
 *
 * The returned callable starts a fresh budget for every top-level call.  A
 * generic registry module may call the function at
 * `AUTHOR_CODE_BLOCK_INVOKE_CONTEXT_KEY` to share that same budget with a
 * nested block.  Nested calls do not receive a new top-level budget.
 */
export function createAuthorCodeBlockExecutor(options: AuthorCodeBlockRuntimeOptions): AuthorCodeBlockExecutor {
  const maxInvocations = runtimeLimit(
    options.maxInvocations,
    options.limits?.maxInvocations,
    'maxInvocations',
    DEFAULT_MAX_INVOCATIONS,
  )
  const maxRecursionDepth = runtimeLimit(
    options.maxRecursionDepth,
    options.limits?.maxRecursionDepth,
    'maxRecursionDepth',
    DEFAULT_MAX_RECURSION_DEPTH,
  )
  const registry = options.registry ?? GAMEPLAY_MODULE_REGISTRY
  const baseFlow = options.flow === undefined
    ? readDataProperty(options.context, 'flow')
    : options.flow

  const run = (
    block: unknown,
    argumentsValue: AuthorCodeBlockArguments,
    expectedResultValue: unknown,
    budget: InvocationBudget,
  ): unknown => {
    if (budget.invocations >= maxInvocations) {
      throw new AuthorCodeBlockRuntimeError(
        'AUTHOR_CODE_BLOCK_RUNTIME_INVOCATION_LIMIT',
        `author code block invocation budget exceeded (${maxInvocations})`,
        maxInvocations,
        budget.invocations,
      )
    }
    if (budget.depth >= maxRecursionDepth) {
      throw new AuthorCodeBlockRuntimeError(
        'AUTHOR_CODE_BLOCK_RUNTIME_RECURSION_LIMIT',
        `author code block recursion depth exceeded (${maxRecursionDepth})`,
        maxRecursionDepth,
        budget.depth,
      )
    }

    budget.invocations += 1
    budget.depth += 1
    try {
      // This call is intentionally first. It clones/revalidates the
      // definition, checks typed arguments, and compiles against the trusted
      // registry before any generated function is materialized or invoked.
      const invocation = compileAuthorCodeBlockWithArguments(
        block,
        argumentsValue,
        registry,
        options.compilerOptions,
      )
      const expectedResult = normalizeExpectedResult(expectedResultValue)
      if (expectedResult && !resultTypesCompatible(declaredResultType(invocation.signature.outputs ?? []), expectedResult.type)) {
        throw new AuthorCodeBlockRuntimeError(
          'AUTHOR_CODE_BLOCK_RUNTIME_RESULT',
          `author code block ${invocation.definition.id} result type is incompatible with the requested result type`,
        )
      }
      const execute = options.compileExpression({
        surface: 'pendingEffectCode',
        contentId: invocation.definition.id,
        contentVersion: invocation.definition.version,
        code: invocation.compiled.code,
        entry: `author code block ${invocation.definition.id}`,
      })
      if (typeof execute !== 'function') {
        throw new AuthorCodeBlockRuntimeError(
          'AUTHOR_CODE_BLOCK_RUNTIME_ENTRY',
          `author code block ${invocation.definition.id} did not compile to a function`,
        )
      }

      const nestedInvoke: AuthorCodeBlockNestedInvoke = (nestedBlock, nestedArguments, nestedExpectedResult) => run(nestedBlock, nestedArguments, nestedExpectedResult, budget)
      const context = makeExecutionContext(
        options.context,
        baseFlow,
        invocation.argumentBinding.payload,
        nestedInvoke,
      )
      // Do not catch this call. Dynamic runtime errors, fatal effect signals,
      // pending suspension signals, and host-thrown diagnostics retain their
      // original identity and control flow.
      const result = (execute as (context: unknown) => unknown)(context)
      // The descriptor's generic result type is a compile-time binding. The
      // adapter still checks the actual generated value against the block's
      // validated output signature before returning it to the host.
      validateAuthorCodeBlockResult(result, invocation.definition, invocation.signature.outputs)
      if (expectedResult) validateResultValue(result, expectedResult.type, expectedResult.schemas, '$', new WeakSet<object>())
      return result
    } finally {
      budget.depth -= 1
    }
  }

  const execute = ((block: unknown, argumentsValue: AuthorCodeBlockArguments, expectedResult?: unknown) => run(
    block,
    argumentsValue,
    expectedResult,
    { invocations: 0, depth: 0 },
  )) as AuthorCodeBlockExecutor
  Object.defineProperties(execute, {
    execute: { configurable: false, enumerable: false, value: execute },
    invoke: { configurable: false, enumerable: false, value: execute },
  })
  return execute
}

/** Compatibility name for hosts that call the adapter a runtime. */
export const createAuthorCodeBlockRuntime = createAuthorCodeBlockExecutor
