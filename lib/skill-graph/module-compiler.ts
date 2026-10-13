/** Semantic RED-252 gameplay module compiler.
 *
 * Author graphs are data only. Native lowering is supplied by a trusted
 * registry descriptor and the result is emitted for the existing SkillCode
 * host; this module does not introduce a runtime interpreter.
 */

import { isAuthorMap, isAuthorSet } from '../game/author-containers'
import {
  GAMEPLAY_MODULE_COMPILER_VERSION,
  GAMEPLAY_MODULE_COMPILER_V1_VERSION,
  GAMEPLAY_MODULE_COMPILER_V2_VERSION,
  GAMEPLAY_MODULE_COMPILER_V3_VERSION,
  type GameplayModuleCompilerVersion,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  GameplayModuleCompileError,
  type GameplayCallStatement,
  type GameplayCollectionStatement,
  type GameplayCompositeDefinition,
  type GameplayDeferChoiceStatement,
  type GameplayEffectMetadata,
  type GameplayJsonValue,
  type GameplayLiteral,
  type GameplayModuleCompileResult,
  type GameplayModuleCompilerOptions,
  type GameplayModuleDescriptor,
  type GameplayModuleRegistry,
  type GameplayModuleSurface,
  type GameplayNativeLoweringResult,
  type GameplayParameter,
  type GameplayPort,
  type GameplayRecordCreateStatement,
  type GameplayRecordGetStatement,
  type GameplayRecordSchema,
  type GameplayRecordWithStatement,
  type GameplayReturnStatement,
  type GameplayStatement,
  type GameplayValue,
  type GameplayValueType,
  type GameplayValueTypeName,
} from './module-types'

export { GAMEPLAY_MODULE_COMPILER_VERSION }
export { GAMEPLAY_MODULE_COMPILER_V1_VERSION, GAMEPLAY_MODULE_COMPILER_V2_VERSION, GAMEPLAY_MODULE_COMPILER_V3_VERSION }
export const GAMEPLAY_COMPILER_VERSION = GAMEPLAY_MODULE_COMPILER_VERSION
export const MODULE_COMPILER_VERSION = GAMEPLAY_MODULE_COMPILER_VERSION

const surfaces: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview']
const surfaceSet = new Set<string>(surfaces)
const publicTypeNames = new Set<GameplayValueTypeName>([
  'number', 'boolean', 'string', 'piece', 'player', 'cell', 'path', 'card',
  'content', 'status', 'event', 'choice', 'record', 'null', 'unknown', 'any',
])
const limitsDefault: Required<GameplayModuleCompilerOptions> = {
  maxCompositeDepth: 32,
  maxExpandedStatements: 10_000,
  maxExpandedCalls: 2_000,
  maxLiteralBytes: 256 * 1024,
  maxCollectionIterations: 10_000,
  maxWhileIterations: 10_000,
}
type Rec = Record<string, unknown>
type Port = GameplayPort
type Param = GameplayParameter
type StructuredContinuation = { readonly id: string; readonly version: string; readonly graph: Graph; readonly payloadType?: GameplayValueType }
type Graph = { readonly version: typeof GAMEPLAY_MODULE_GRAPH_VERSION; readonly surface: GameplayModuleSurface; readonly inputs: readonly Port[]; readonly inputBindings: Readonly<Record<string, GameplayLiteral>>; readonly outputs: readonly Port[]; readonly body: readonly GameplayStatement[]; readonly composites: readonly GameplayCompositeDefinition[]; readonly schemas: readonly GameplayRecordSchema[]; readonly hostBindings: Readonly<Record<string, GameplayValueType>>; readonly continuations: readonly StructuredContinuation[]; readonly layout?: Readonly<Record<string, GameplayJsonValue>> }
type Resolved = { readonly kind: 'native'; readonly descriptor: GameplayModuleDescriptor } | { readonly kind: 'composite'; readonly definition: GameplayCompositeDefinition }
type VEnv = { readonly inputs: ReadonlyMap<string, GameplayValueType>; readonly bindings: ReadonlyMap<string, ReadonlyMap<string, GameplayValueType>> }
type CallMeta = { readonly module: Resolved; readonly inputs: Readonly<Record<string, GameplayValue>>; readonly parameters: Readonly<Record<string, GameplayLiteral>>; readonly inputTypes?: ReadonlyMap<string, GameplayValueType>; readonly outputTypes: ReadonlyMap<string, GameplayValueType> }
type ExpandedCall = { readonly id: string; readonly version: string; readonly kind: 'native' | 'composite'; readonly callId: string; readonly depth: number }
type Resolver = { readonly graph: Graph; readonly composites: ReadonlyMap<string, GameplayCompositeDefinition>; readonly native: Map<string, GameplayModuleDescriptor>; readonly calls: Map<GameplayCallStatement, CallMeta>; readonly dependencies: Map<string, { id: string; version: string; kind: 'native' | 'composite' }>; readonly expanded: ExpandedCall[]; readonly limits: Required<GameplayModuleCompilerOptions>; readonly registry: GameplayModuleRegistry; readonly schemas: SchemaTable; statementCount: number }
type CBinding = { readonly ports: ReadonlyMap<string, GameplayValueType>; readonly expression: string; readonly portExpressions?: ReadonlyMap<string, string> }
type CEnv = { readonly inputs: ReadonlyMap<string, string>; readonly bindings: ReadonlyMap<string, CBinding>; readonly inputTypes?: ReadonlyMap<string, GameplayValueType> }
type ReturnTarget = { readonly result: string; readonly label: string; readonly outputs: readonly Port[] }
type Codegen = { next: number; readonly resolver: Resolver; readonly loweringDependencies: Set<string>; readonly continuationStack: readonly string[]; readonly compilerVersion: GameplayModuleCompilerVersion }

class CompilerFailure extends GameplayModuleCompileError {
  constructor(message: string, path?: string, code = 'GAMEPLAY_MODULE_INVALID') { super(message, path, code) }
}
function fail(message: string, path?: string, code?: string): never { throw new CompilerFailure(message, path, code) }
function own(record: Rec, key: string): boolean { return Object.prototype.hasOwnProperty.call(record, key) }
function isObject(value: unknown): value is Rec {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype === Object.prototype || prototype === null) return true
  // Graphs can cross the editor/VM boundary.  An object created by another
  // realm has a different Object.prototype identity, but its prototype still
  // has the same JSON-object shape: a null parent and the native Object
  // constructor.  Class instances retain a non-null prototype parent and are
  // rejected below.
  if (typeof prototype !== 'object' || prototype === null || Object.getPrototypeOf(prototype) !== null) return false
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')
  return Boolean(constructor && 'value' in constructor && typeof constructor.value === 'function' && constructor.value.name === 'Object')
}
function plain(value: unknown, path: string): Rec {
  if (!isObject(value)) fail('expected a plain object', path, 'GAMEPLAY_MODULE_SHAPE')
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail('symbol keys are not allowed', path, 'GAMEPLAY_MODULE_UNSAFE_VALUE')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) fail('accessor properties are not allowed', path + '.' + key, 'GAMEPLAY_MODULE_UNSAFE_VALUE')
    if (!descriptor.enumerable) fail('non-enumerable properties are not allowed', path + '.' + key, 'GAMEPLAY_MODULE_UNSAFE_VALUE')
  }
  return value
}
function allowed(record: Rec, keys: readonly string[], path: string): void {
  const set = new Set(keys)
  for (const key of Object.keys(record)) if (!set.has(key)) fail('unknown field "' + key + '"', path + '.' + key, 'GAMEPLAY_MODULE_UNKNOWN_FIELD')
}
function nonempty(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail('must be a non-empty string', path, 'GAMEPLAY_MODULE_INVALID_NAME')
  return value
}
function safeName(value: unknown, path: string): string {
  const name = nonempty(value, path)
  if (name === '__proto__' || name === 'prototype' || name === 'constructor') fail('unsafe name "' + name + '"', path, 'GAMEPLAY_MODULE_UNSAFE_VALUE')
  return name
}
function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail('must be a boolean', path, 'GAMEPLAY_MODULE_INVALID_BOOLEAN')
  return value
}
function json(value: unknown, path: string, budget: { bytes: number; readonly limit: number }): asserts value is GameplayJsonValue {
  if (value === null) return
  if (typeof value === 'string') {
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i)
      if (code >= 0xD800 && code <= 0xDBFF) {
        const next = value.charCodeAt(i + 1)
        if (next < 0xDC00 || next > 0xDFFF) fail('lone surrogate is not allowed', path, 'GAMEPLAY_MODULE_UNSAFE_VALUE')
        i += 1
      } else if (code >= 0xDC00 && code <= 0xDFFF) fail('lone surrogate is not allowed', path, 'GAMEPLAY_MODULE_UNSAFE_VALUE')
    }
    budget.bytes += value.length
    if (budget.bytes > budget.limit) fail('literal budget exceeded', path, 'GAMEPLAY_MODULE_BUDGET_EXCEEDED')
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('numbers must be finite', path, 'GAMEPLAY_MODULE_UNSAFE_VALUE')
    return
  }
  if (typeof value === 'boolean') return
  if (typeof value !== 'object') fail('functions and non-JSON values are not allowed', path, 'GAMEPLAY_MODULE_UNSAFE_VALUE')
  if (Array.isArray(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') fail('symbol keys are not allowed', path, 'GAMEPLAY_MODULE_UNSAFE_VALUE')
      if (key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) fail('accessor properties are not allowed', path + '[' + key + ']', 'GAMEPLAY_MODULE_UNSAFE_VALUE')
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) fail('array properties are not allowed', path + '[' + key + ']', 'GAMEPLAY_MODULE_UNSAFE_VALUE')
    }
    for (let i = 0; i < value.length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) fail('sparse arrays are not allowed', path + '[' + i + ']', 'GAMEPLAY_MODULE_UNSAFE_VALUE')
      json(value[i], path + '[' + i + ']', budget)
    }
    return
  }
  const record = plain(value, path)
  for (const key of Object.keys(record)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') fail('unsafe object key "' + key + '"', path + '.' + key, 'GAMEPLAY_MODULE_UNSAFE_VALUE')
    json(record[key], path + '.' + key, budget)
  }
}
function clone(value: GameplayJsonValue): GameplayJsonValue {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(clone)
  const result: Record<string, GameplayJsonValue> = Object.create(null) as Record<string, GameplayJsonValue>
  const record = value as { readonly [key: string]: GameplayJsonValue }
  for (const key of Object.keys(record)) result[key] = clone(record[key])
  return result
}
function rejectUnschematizedRecord(value: GameplayJsonValue, path: string): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) rejectUnschematizedRecord(value[index], path + '[' + index + ']')
    return
  }
  fail('structured literal requires a registered record schema', path, 'GAMEPLAY_MODULE_UNTYPED_RECORD')
}
function literalSource(value: GameplayLiteral): string {
  const text = JSON.stringify(value)
  if (text === undefined) fail('literal cannot be serialized', undefined, 'GAMEPLAY_MODULE_UNSAFE_VALUE')
  return value !== null && typeof value === 'object' ? 'JSON.parse(' + JSON.stringify(text) + ')' : text
}
function moduleKey(id: string, version: string): string { return id + String.fromCharCode(0) + version }
function previewHostType(name: string): GameplayValueType | undefined {
  if (name === 'piece') return { kind: 'nullable', value: 'piece' }
  if (name === 'skillDef') return { kind: 'nullable', value: 'content' }
  if (name === 'currentCooldown') return { kind: 'nullable', value: 'number' }
  return undefined
}
function matchesPreviewHostType(actual: GameplayValueType, expected: GameplayValueType): boolean {
  if (typeof expected === 'object' && expected.kind === 'nullable') return actual === expected.value || (typeof actual === 'object' && actual.kind === 'nullable' && actual.value === expected.value)
  return actual === expected
}

function typeValue(value: unknown, path: string, trustedGeneric = false): GameplayValueType {
  if (typeof value === 'string') {
    if (!publicTypeNames.has(value as GameplayValueTypeName)) fail('unsupported value type "' + value + '"', path, 'GAMEPLAY_MODULE_INVALID_TYPE')
    if (!trustedGeneric && (value === 'unknown' || value === 'any')) fail('universal value types are not allowed', path, 'GAMEPLAY_MODULE_INVALID_TYPE')
    return value as GameplayValueTypeName
  }
  const record = plain(value, path)
  if (record.kind === 'list' || record.kind === 'set') {
    allowed(record, ['kind', 'element'], path)
    if (!own(record, 'element')) fail('list type requires element', path, 'GAMEPLAY_MODULE_INVALID_TYPE')
    return { kind: record.kind, element: typeValue(record.element, path + '.element', trustedGeneric) }
  }
  if (record.kind === 'map') {
    allowed(record, ['kind', 'key', 'value'], path)
    return { kind: 'map', key: typeValue(record.key, path + '.key', trustedGeneric), value: typeValue(record.value, path + '.value', trustedGeneric) }
  }
  if (record.kind === 'nullable') {
    allowed(record, ['kind', 'value'], path)
    if (!own(record, 'value')) fail('nullable type requires value', path, 'GAMEPLAY_MODULE_INVALID_TYPE')
    return { kind: 'nullable', value: typeValue(record.value, path + '.value', trustedGeneric) }
  }
  if (record.kind === 'record') {
    allowed(record, ['kind', 'schema'], path)
    return { kind: 'record', schema: nonempty(record.schema, path + '.schema') }
  }
  fail('unsupported value type descriptor', path, 'GAMEPLAY_MODULE_INVALID_TYPE')
}
function port(value: unknown, path: string, trustedGeneric = false): Port {
  const record = plain(value, path)
  allowed(record, ['name', 'type', 'optional', 'nullable', 'label', 'description'], path)
  const result: Record<string, unknown> = { name: safeName(record.name, path + '.name'), type: typeValue(record.type, path + '.type', trustedGeneric) }
  for (const key of ['optional', 'nullable'] as const) if (record[key] !== undefined) result[key] = bool(record[key], path + '.' + key)
  for (const key of ['label', 'description'] as const) if (record[key] !== undefined) result[key] = nonempty(record[key], path + '.' + key)
  return result as Port
}
function ports(value: unknown, path: string, trustedGeneric = false): readonly Port[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('ports must be an array', path, 'GAMEPLAY_MODULE_SHAPE')
  const result = value.map((entry, index) => port(entry, path + '[' + index + ']', trustedGeneric))
  const names = new Set<string>()
  for (const entry of result) { if (names.has(entry.name)) fail('duplicate port "' + entry.name + '"', path, 'GAMEPLAY_MODULE_DUPLICATE_PORT'); names.add(entry.name) }
  return result
}
function parameter(value: unknown, path: string): Param {
  const record = plain(value, path)
  allowed(record, ['name', 'type', 'optional', 'nullable', 'label', 'description', 'default', 'enum', 'minimum', 'maximum'], path)
  const base: Rec = Object.create(null) as Rec
  for (const key of ['name', 'type', 'optional', 'nullable', 'label', 'description']) if (own(record, key)) base[key] = record[key]
  const result = { ...port(base, path) } as Record<string, unknown>
  if (own(record, 'default')) { const budget = { bytes: 0, limit: limitsDefault.maxLiteralBytes }; json(record.default, path + '.default', budget); rejectUnschematizedRecord(record.default, path + '.default'); result.default = clone(record.default) }
  if (record.enum !== undefined) {
    if (!Array.isArray(record.enum)) fail('enum must be an array', path + '.enum', 'GAMEPLAY_MODULE_INVALID_PARAMETER')
    const values: GameplayLiteral[] = []
    for (let i = 0; i < record.enum.length; i += 1) { const budget = { bytes: 0, limit: limitsDefault.maxLiteralBytes }; json(record.enum[i], path + '.enum[' + i + ']', budget); rejectUnschematizedRecord(record.enum[i], path + '.enum[' + i + ']'); values.push(clone(record.enum[i])) }
    result.enum = values
  }
  for (const key of ['minimum', 'maximum'] as const) if (own(record, key)) {
    if (typeof record[key] !== 'number' || !Number.isFinite(record[key])) fail(key + ' must be a finite number', path + '.' + key, 'GAMEPLAY_MODULE_INVALID_PARAMETER')
    result[key] = record[key]
  }
  const declaration = result as Param
  if (own(result, 'default')) {
    const defaultValue = result.default as GameplayLiteral
    const actual = typeOfLiteral(defaultValue)
    if (!assignable(actual, effective(declaration))) fail('default expects ' + typeName(effective(declaration)) + ', got ' + typeName(actual), path + '.default', 'GAMEPLAY_MODULE_PARAMETER_TYPE')
    if (declaration.enum && !declaration.enum.some(entry => JSON.stringify(entry) === JSON.stringify(defaultValue))) fail('default is outside its enum', path + '.default', 'GAMEPLAY_MODULE_PARAMETER_VALUE')
    if (typeof defaultValue === 'number') {
      if (declaration.minimum !== undefined && defaultValue < declaration.minimum) fail('default is below minimum', path + '.default', 'GAMEPLAY_MODULE_PARAMETER_VALUE')
      if (declaration.maximum !== undefined && defaultValue > declaration.maximum) fail('default is above maximum', path + '.default', 'GAMEPLAY_MODULE_PARAMETER_VALUE')
    }
  }
  if (Array.isArray(result.enum)) {
    for (let index = 0; index < result.enum.length; index += 1) {
      const actual = typeOfLiteral(result.enum[index])
      if (!assignable(actual, effective(declaration))) fail('enum value expects ' + typeName(effective(declaration)) + ', got ' + typeName(actual), path + '.enum[' + index + ']', 'GAMEPLAY_MODULE_PARAMETER_TYPE')
    }
  }
  if (declaration.minimum !== undefined && declaration.maximum !== undefined && declaration.minimum > declaration.maximum) fail('minimum cannot exceed maximum', path, 'GAMEPLAY_MODULE_INVALID_PARAMETER')
  return result as Param
}
function parameters(value: unknown, path: string): readonly Param[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('parameters must be an array', path, 'GAMEPLAY_MODULE_INVALID_PARAMETER')
  const result = value.map((entry, index) => parameter(entry, path + '[' + index + ']'))
  const names = new Set<string>()
  for (const entry of result) { if (names.has(entry.name)) fail('duplicate parameter "' + entry.name + '"', path, 'GAMEPLAY_MODULE_DUPLICATE_PARAMETER'); names.add(entry.name) }
  return result
}
function inspectReferences(
  value: unknown,
  inputs: readonly Port[],
  path: string,
  inputValueTypeBindings?: unknown,
  declarations: readonly Param[] = [],
): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) fail('inspectReferences must be an array', path, 'GAMEPLAY_MODULE_INVALID_REFERENCE_INSPECTION')
  const inputMap = mapPorts(inputs)
  const result: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const name = nonempty(value[index], path + '[' + index + ']')
    if (result.includes(name)) fail('duplicate inspected input "' + name + '"', path, 'GAMEPLAY_MODULE_DUPLICATE_REFERENCE_INSPECTION')
    const input = inputMap.get(name)
    if (!input) fail('inspectReferences names unknown input "' + name + '"', path + '[' + index + ']', 'GAMEPLAY_MODULE_UNKNOWN_PORT')
    const reference = referenceKind(effective(input))
    const rawBinding = isObject(inputValueTypeBindings) && own(inputValueTypeBindings, name)
      ? inputValueTypeBindings[name]
      : undefined
    const binding = isObject(rawBinding) ? rawBinding : undefined
    const bindingParameter = typeof binding?.parameter === 'string' ? binding.parameter : undefined
    const dynamicBinding = bindingParameter !== undefined
      && declarations.some(declaration => declaration.name === bindingParameter && declaration.type === 'string')
    // Generic value modules bind their record-shaped ports to a closed type
    // selected by a string parameter.  The selected type can be a piece or a
    // player, and those modules intentionally compare opaque identities
    // without asking the host to resolve a live entity first.  Accept the
    // trusted binding here while continuing to reject ordinary record ports.
    if (!reference && !dynamicBinding) fail('inspectReferences input "' + name + '" must be a piece or player reference or a trusted value binding', path + '[' + index + ']', 'GAMEPLAY_MODULE_INVALID_REFERENCE_INSPECTION')
    result.push(name)
  }
  return result
}
function livingReferences(value: unknown, inputs: readonly Port[], path: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) fail('livingReferences must be an array', path, 'GAMEPLAY_MODULE_INVALID_LIVING_REFERENCE')
  const inputMap = mapPorts(inputs)
  const result: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const name = nonempty(value[index], path + '[' + index + ']')
    if (result.includes(name)) fail('duplicate living input "' + name + '"', path, 'GAMEPLAY_MODULE_DUPLICATE_LIVING_REFERENCE')
    const input = inputMap.get(name)
    if (!input) fail('livingReferences names unknown input "' + name + '"', path + '[' + index + ']', 'GAMEPLAY_MODULE_UNKNOWN_PORT')
    if (referenceKind(effective(input)) !== 'piece') fail('livingReferences input "' + name + '" must be a piece reference', path + '[' + index + ']', 'GAMEPLAY_MODULE_INVALID_LIVING_REFERENCE')
    result.push(name)
  }
  return result
}
function outputParameterTypeBindings(
  value: unknown,
  outputs: readonly Port[],
  declarations: readonly Param[],
  path: string,
): Readonly<Record<string, { parameter: string; types: Readonly<Record<string, GameplayValueType>> }>> | undefined {
  if (value === undefined) return undefined
  const record = plain(value, path)
  const outputMap = mapPorts(outputs)
  const parameterMap = mapParams(declarations)
  const result: Record<string, { parameter: string; types: Readonly<Record<string, GameplayValueType>> }> = Object.create(null) as Record<string, { parameter: string; types: Readonly<Record<string, GameplayValueType>> }>
  for (const [outputName, rawBinding] of Object.entries(record)) {
    const bindingPath = path + '.' + outputName
    const binding = plain(rawBinding, bindingPath)
    allowed(binding, ['parameter', 'types'], bindingPath)
    const output = outputMap.get(outputName)
    if (!output) fail('field type binding must name an output port', bindingPath, 'GAMEPLAY_MODULE_UNKNOWN_PORT')
    const parameterName = safeName(binding.parameter, bindingPath + '.parameter')
    const declaration = parameterMap.get(parameterName)
    if (!declaration || declaration.type !== 'string') fail('field type binding parameter must be a string parameter', bindingPath + '.parameter', 'GAMEPLAY_MODULE_INVALID_TYPE_BINDING')
    const types = plain(binding.types, bindingPath + '.types')
    const normalized: Record<string, GameplayValueType> = Object.create(null) as Record<string, GameplayValueType>
    for (const [fieldName, rawType] of Object.entries(types)) {
      const safeField = safeName(fieldName, bindingPath + '.types.' + fieldName)
      if (Object.prototype.hasOwnProperty.call(normalized, safeField)) fail('duplicate field type binding "' + safeField + '"', bindingPath + '.types', 'GAMEPLAY_MODULE_DUPLICATE_FIELD')
      normalized[safeField] = typeValue(rawType, bindingPath + '.types.' + safeField)
    }
    if (Object.keys(normalized).length === 0) fail('field type binding requires at least one field', bindingPath + '.types', 'GAMEPLAY_MODULE_INVALID_TYPE_BINDING')
    result[outputName] = { parameter: parameterName, types: normalized }
  }
  return result
}
function layout(value: unknown, path: string): Readonly<Record<string, GameplayJsonValue>> | undefined {
  if (value === undefined) return undefined
  const record = plain(value, path)
  const budget = { bytes: 0, limit: limitsDefault.maxLiteralBytes }
  json(record, path, budget)
  const result: Record<string, GameplayJsonValue> = Object.create(null) as Record<string, GameplayJsonValue>
  for (const key of Object.keys(record)) result[key] = clone(record[key])
  return result
}
function valueRef(value: unknown, path: string): GameplayValue {
  const record = plain(value, path)
  const kind = nonempty(record.kind, path + '.kind')
  if (kind === 'literal') {
    allowed(record, ['kind', 'value'], path)
    if (!own(record, 'value')) fail('literal requires value', path, 'GAMEPLAY_MODULE_INVALID_VALUE')
    const budget = { bytes: 0, limit: limitsDefault.maxLiteralBytes }
    json(record.value, path + '.value', budget)
    rejectUnschematizedRecord(record.value, path + '.value')
    return { kind: 'literal', value: clone(record.value) }
  }
  if (kind === 'input') { allowed(record, ['kind', 'name'], path); return { kind: 'input', name: nonempty(record.name, path + '.name') } }
  if (kind === 'output') {
    allowed(record, ['kind', 'node', 'port'], path)
    return { kind: 'output', node: nonempty(record.node, path + '.node'), port: nonempty(record.port, path + '.port') }
  }
  fail('unsupported value kind "' + kind + '"', path, 'GAMEPLAY_MODULE_UNSAFE_VALUE')
}
function valueMap(value: unknown, path: string): Readonly<Record<string, GameplayValue>> {
  const record = plain(value, path)
  const result: Record<string, GameplayValue> = Object.create(null) as Record<string, GameplayValue>
  for (const key of Object.keys(record)) result[key] = valueRef(record[key], path + '.' + key)
  return result
}
function literalMap(value: unknown, path: string): Readonly<Record<string, GameplayLiteral>> {
  const record = plain(value, path)
  const result: Record<string, GameplayLiteral> = Object.create(null) as Record<string, GameplayLiteral>
  for (const key of Object.keys(record)) { const budget = { bytes: 0, limit: limitsDefault.maxLiteralBytes }; json(record[key], path + '.' + key, budget); rejectUnschematizedRecord(record[key], path + '.' + key); result[key] = clone(record[key]) }
  return result
}

function recordFields(value: unknown, path: string): Readonly<Record<string, GameplayValue>> {
  if (value === undefined) return {}
  return valueMap(value, path)
}

function collectionStatement(value: unknown, path: string): GameplayCollectionStatement {
  const record = plain(value, path)
  const rawKind = nonempty(record.kind, path + '.kind')
  const method = rawKind === 'collection' ? nonempty(record.method, path + '.method') : rawKind.slice('collection.'.length)
  if (method !== 'map' && method !== 'filter' && method !== 'reduce' && method !== 'find') fail('unsupported collection method "' + method + '"', path + '.method', 'GAMEPLAY_MODULE_UNSUPPORTED_STATEMENT')
  const allowedFields = ['kind', 'method', 'id', 'items', 'inputs', 'item', 'index', 'accumulator', 'initial', 'body']
  allowed(record, allowedFields, path)
  if (rawKind !== 'collection' && (own(record, 'method') || (method !== 'reduce' && (own(record, 'accumulator') || own(record, 'initial'))))) fail('collection discriminator conflicts with method fields', path, 'GAMEPLAY_MODULE_INVALID_STATEMENT')
  if (method !== 'reduce' && (own(record, 'accumulator') || own(record, 'initial'))) fail('map/filter collections cannot declare accumulator or initial', path, 'GAMEPLAY_MODULE_INVALID_STATEMENT')
  if (!Array.isArray(record.body)) fail('collection.body must be an array', path + '.body', 'GAMEPLAY_MODULE_SHAPE')
  const node: Record<string, unknown> = {
    kind: 'collection',
    id: nonempty(record.id, path + '.id'),
    method,
    items: valueRef(record.items, path + '.items'),
    inputs: record.inputs === undefined ? {} : valueMap(record.inputs, path + '.inputs'),
    body: statements(record.body, path + '.body'),
  }
  if (record.item !== undefined) node.item = safeName(record.item, path + '.item')
  if (record.index !== undefined) node.index = safeName(record.index, path + '.index')
  if (record.accumulator !== undefined) node.accumulator = safeName(record.accumulator, path + '.accumulator')
  if (record.initial !== undefined) node.initial = valueRef(record.initial, path + '.initial')
  return node as GameplayCollectionStatement
}

function whileCondition(value: unknown, path: string): { readonly inputs: Readonly<Record<string, GameplayValue>>; readonly body: readonly GameplayStatement[] } {
  const record = plain(value, path)
  allowed(record, ['inputs', 'body'], path)
  if (!Array.isArray(record.body)) fail('while.condition.body must be an array', path + '.body', 'GAMEPLAY_MODULE_SHAPE')
  return {
    inputs: record.inputs === undefined ? {} : valueMap(record.inputs, path + '.inputs'),
    body: statements(record.body, path + '.body'),
  }
}

function whileStatement(value: unknown, path: string): GameplayStatement {
  const record = plain(value, path)
  allowed(record, ['kind', 'id', 'condition', 'index', 'budget', 'body', 'layout'], path)
  if (!Array.isArray(record.body)) fail('while.body must be an array', path + '.body', 'GAMEPLAY_MODULE_SHAPE')
  if (!Number.isSafeInteger(record.budget) || (record.budget as number) <= 0) fail('while.budget must be a positive safe integer', path + '.budget', 'GAMEPLAY_MODULE_INVALID_VALUE')
  const node: Record<string, unknown> = {
    kind: 'while',
    id: nonempty(record.id, path + '.id'),
    condition: whileCondition(record.condition, path + '.condition'),
    budget: record.budget,
    body: statements(record.body, path + '.body'),
  }
  if (record.index !== undefined) node.index = safeName(record.index, path + '.index')
  const nodeLayout = layout(record.layout, path + '.layout'); if (nodeLayout !== undefined) node.layout = nodeLayout
  return node as GameplayStatement
}

function statement(value: unknown, path: string): GameplayStatement {
  const record = plain(value, path)
  const kind = nonempty(record.kind, path + '.kind')
  if (kind === 'call') {
    allowed(record, ['kind', 'id', 'module', 'version', 'inputs', 'parameters', 'layout'], path)
    const node: Record<string, unknown> = { kind, id: nonempty(record.id, path + '.id'), module: nonempty(record.module, path + '.module'), version: nonempty(record.version, path + '.version'), inputs: record.inputs === undefined ? {} : valueMap(record.inputs, path + '.inputs'), parameters: record.parameters === undefined ? {} : literalMap(record.parameters, path + '.parameters') }
    const nodeLayout = layout(record.layout, path + '.layout'); if (nodeLayout !== undefined) node.layout = nodeLayout
    return node as GameplayStatement
  }
  if (kind === 'if') {
    allowed(record, ['kind', 'id', 'condition', 'then', 'else', 'layout'], path)
    if (!Array.isArray(record.then)) fail('if.then must be an array', path + '.then', 'GAMEPLAY_MODULE_SHAPE')
    if (record.else !== undefined && !Array.isArray(record.else)) fail('if.else must be an array', path + '.else', 'GAMEPLAY_MODULE_SHAPE')
    const node: Record<string, unknown> = { kind, id: nonempty(record.id, path + '.id'), condition: valueRef(record.condition, path + '.condition'), then: statements(record.then, path + '.then') }
    if (record.else !== undefined) node.else = statements(record.else, path + '.else')
    const nodeLayout = layout(record.layout, path + '.layout'); if (nodeLayout !== undefined) node.layout = nodeLayout
    return node as GameplayStatement
  }
  if (kind === 'foreach') {
    allowed(record, ['kind', 'id', 'items', 'item', 'index', 'body', 'presentation', 'layout'], path)
    if (!Array.isArray(record.body)) fail('foreach.body must be an array', path + '.body', 'GAMEPLAY_MODULE_SHAPE')
    const node: Record<string, unknown> = { kind, id: nonempty(record.id, path + '.id'), items: valueRef(record.items, path + '.items'), body: statements(record.body, path + '.body') }
    if (record.item !== undefined) node.item = nonempty(record.item, path + '.item')
    if (record.index !== undefined) node.index = nonempty(record.index, path + '.index')
    if (record.presentation !== undefined) {
      if (!['statusAdded', 'statusRemoved', 'tileEffectAdded', 'tileEffectRemoved'].includes(String(record.presentation))) fail('unknown presentation batch kind', path + '.presentation', 'GAMEPLAY_MODULE_INVALID_VALUE')
      node.presentation = record.presentation
    }
    const nodeLayout = layout(record.layout, path + '.layout'); if (nodeLayout !== undefined) node.layout = nodeLayout
    return node as GameplayStatement
  }
  if (kind === 'while') return whileStatement(value, path)
  if (kind === 'record.create') {
    allowed(record, ['kind', 'id', 'schema', 'fields'], path)
    return {
      kind,
      id: safeName(record.id, path + '.id'),
      schema: nonempty(record.schema, path + '.schema'),
      fields: recordFields(record.fields, path + '.fields'),
    } as GameplayRecordCreateStatement
  }
  if (kind === 'record.get') {
    allowed(record, ['kind', 'id', 'record', 'field'], path)
    return {
      kind,
      id: safeName(record.id, path + '.id'),
      record: valueRef(record.record, path + '.record'),
      field: safeName(record.field, path + '.field'),
    } as GameplayRecordGetStatement
  }
  if (kind === 'record.with') {
    allowed(record, ['kind', 'id', 'record', 'fields'], path)
    return {
      kind,
      id: safeName(record.id, path + '.id'),
      record: valueRef(record.record, path + '.record'),
      fields: recordFields(record.fields, path + '.fields'),
    } as GameplayRecordWithStatement
  }
  if (kind === 'collection' || kind === 'collection.map' || kind === 'collection.filter' || kind === 'collection.find' || kind === 'collection.reduce') return collectionStatement(value, path)
  if (kind === 'defer-choice') {
    allowed(record, ['kind', 'id', 'graph', 'payload', 'player', 'title', 'targetType', 'range', 'filter', 'candidates', 'selectionMode', 'min', 'max', 'minSelections', 'maxSelections', 'canCancel', 'resumeOnCancel', 'message'], path)
    if (own(record, 'min') && own(record, 'minSelections')) fail('defer-choice cannot contain both min and minSelections', path, 'GAMEPLAY_MODULE_INVALID_STATEMENT')
    if (own(record, 'max') && own(record, 'maxSelections')) fail('defer-choice cannot contain both max and maxSelections', path, 'GAMEPLAY_MODULE_INVALID_STATEMENT')
    const node: Record<string, unknown> = {
      kind,
      id: safeName(record.id, path + '.id'),
      graph: nonempty(record.graph, path + '.graph'),
      payload: valueRef(record.payload, path + '.payload'),
    }
    for (const key of ['player', 'title', 'targetType', 'range', 'filter', 'candidates', 'selectionMode', 'min', 'max', 'minSelections', 'maxSelections', 'canCancel', 'resumeOnCancel', 'message'] as const) {
      if (record[key] !== undefined) node[key] = valueRef(record[key], path + '.' + key)
    }
    return node as GameplayDeferChoiceStatement
  }
  if (kind === 'return') {
    allowed(record, ['kind', 'id', 'values', 'value', 'layout'], path)
    if (own(record, 'values') && own(record, 'value')) fail('return cannot contain both values and value', path, 'GAMEPLAY_MODULE_INVALID_RETURN')
    const node: Record<string, unknown> = { kind, id: nonempty(record.id, path + '.id') }
    if (own(record, 'values')) node.values = valueMap(record.values, path + '.values')
    if (own(record, 'value')) node.value = valueRef(record.value, path + '.value')
    const nodeLayout = layout(record.layout, path + '.layout'); if (nodeLayout !== undefined) node.layout = nodeLayout
    return node as GameplayStatement
  }
  fail('unsupported statement kind "' + kind + '"', path + '.kind', 'GAMEPLAY_MODULE_UNSUPPORTED_STATEMENT')
}
function statements(value: unknown, path: string): readonly GameplayStatement[] {
  if (!Array.isArray(value)) fail('body must be an array', path, 'GAMEPLAY_MODULE_SHAPE')
  return value.map((entry, index) => statement(entry, path + '[' + index + ']'))
}
function allowedSurfaces(value: unknown, path: string): readonly GameplayModuleSurface[] {
  if (!Array.isArray(value) || value.length === 0) fail('allowedSurfaces must be a non-empty array', path, 'GAMEPLAY_MODULE_INVALID_SURFACE')
  const result: GameplayModuleSurface[] = []
  for (let i = 0; i < value.length; i += 1) {
    const surface = nonempty(value[i], path + '[' + i + ']')
    if (!surfaceSet.has(surface)) fail('unsupported surface "' + surface + '"', path + '[' + i + ']', 'GAMEPLAY_MODULE_INVALID_SURFACE')
    if (result.includes(surface as GameplayModuleSurface)) fail('duplicate surface "' + surface + '"', path, 'GAMEPLAY_MODULE_INVALID_SURFACE')
    result.push(surface as GameplayModuleSurface)
  }
  return result
}
function composite(value: unknown, path: string): GameplayCompositeDefinition {
  const record = plain(value, path)
  allowed(record, ['id', 'version', 'label', 'description', 'inputs', 'outputs', 'parameters', 'allowedSurfaces', 'body', 'layout'], path)
  const result: Record<string, unknown> = { id: nonempty(record.id, path + '.id'), version: nonempty(record.version, path + '.version'), inputs: ports(record.inputs, path + '.inputs'), outputs: ports(record.outputs, path + '.outputs'), body: statements(record.body, path + '.body') }
  if (record.label !== undefined) result.label = nonempty(record.label, path + '.label')
  if (record.description !== undefined) result.description = nonempty(record.description, path + '.description')
  const params = parameters(record.parameters, path + '.parameters'); if (params.length) result.parameters = params
  if (params.length) fail('composite parameters are not supported; use typed inputs', path + '.parameters', 'GAMEPLAY_MODULE_UNSUPPORTED_PARAMETER')
  if (record.allowedSurfaces !== undefined) result.allowedSurfaces = allowedSurfaces(record.allowedSurfaces, path + '.allowedSurfaces')
  const nodeLayout = layout(record.layout, path + '.layout'); if (nodeLayout !== undefined) result.layout = nodeLayout
  return result as GameplayCompositeDefinition
}
function ids(body: readonly GameplayStatement[], path: string): void {
  const seen = new Set<string>()
  const visit = (list: readonly GameplayStatement[], nested: string): void => {
    list.forEach((node, index) => {
      if (seen.has(node.id)) fail('duplicate statement id "' + node.id + '"', nested + '[' + index + '].id', 'GAMEPLAY_MODULE_DUPLICATE_ID')
      seen.add(node.id)
      if (node.kind === 'if') { visit(node.then, nested + '[' + index + '].then'); if (node.else) visit(node.else, nested + '[' + index + '].else') }
      if (node.kind === 'foreach' || node.kind === 'collection') visit(node.body, nested + '[' + index + '].body')
      if (node.kind === 'while') {
        visit(node.condition.body, nested + '[' + index + '].condition.body')
        visit(node.body, nested + '[' + index + '].body')
      }
    })
  }
  visit(body, path)
}
function bodyGuaranteesReturn(body: readonly GameplayStatement[]): boolean {
  for (const node of body) {
    if (node.kind === 'return') return true
    if (node.kind === 'if' && node.else && bodyGuaranteesReturn(node.then) && bodyGuaranteesReturn(node.else)) return true
  }
  return false
}
const pendingHostNames = new Set(['payload', 'selectedTargets', 'targetCell', 'targetPiece', 'sourcePiece', 'player'])
const pendingHostTypeNames: Readonly<Record<string, GameplayValueType>> = {
  selectedTargets: { kind: 'list', element: 'choice' },
  targetCell: { kind: 'nullable', value: 'cell' },
  targetPiece: 'piece',
  sourcePiece: 'piece',
  player: 'player',
}

function schema(value: unknown, path: string): GameplayRecordSchema {
  const record = plain(value, path)
  allowed(record, ['id', 'version', 'fields'], path)
  if (!own(record, 'fields')) fail('record schema requires fields', path + '.fields', 'GAMEPLAY_MODULE_SHAPE')
  return { id: safeName(record.id, path + '.id'), version: nonempty(record.version, path + '.version'), fields: ports(record.fields, path + '.fields') }
}

function schemaList(value: unknown, path: string): readonly GameplayRecordSchema[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('schemas must be an array', path, 'GAMEPLAY_MODULE_SHAPE')
  const result = value.map((entry, index) => schema(entry, path + '[' + index + ']'))
  const seen = new Set<string>()
  for (const entry of result) {
    const key = moduleKey(entry.id, entry.version)
    if (seen.has(key)) fail('duplicate record schema "' + entry.id + '@' + entry.version + '"', path, 'GAMEPLAY_MODULE_DUPLICATE_SCHEMA')
    seen.add(key)
  }
  return result
}

function hostBindingType(value: unknown, name: string, path: string): GameplayValueType {
  if (isObject(value) && own(value, 'type')) {
    allowed(value, ['name', 'type', 'optional', 'nullable', 'label', 'description'], path)
    const declared = port(value, path)
    if (declared.name !== name) fail('host binding port name must match its key', path + '.name', 'GAMEPLAY_MODULE_INVALID_HOST_BINDING')
    return effective(declared)
  }
  return typeValue(value, path)
}

function hostBindings(value: unknown, surface: GameplayModuleSurface, path: string): Readonly<Record<string, GameplayValueType>> {
  if (value === undefined) return {}
  if (surface !== 'pending') fail('hostBindings are only available on pending graphs', path, 'GAMEPLAY_MODULE_SURFACE_FORBIDDEN')
  const record = plain(value, path)
  const result: Record<string, GameplayValueType> = Object.create(null) as Record<string, GameplayValueType>
  for (const key of Object.keys(record)) {
    if (!pendingHostNames.has(key)) fail('unsupported pending host binding "' + key + '"', path + '.' + key, 'GAMEPLAY_MODULE_INVALID_HOST_BINDING')
    result[key] = hostBindingType(record[key], key, path + '.' + key)
  }
  const payload = result.payload
  if (payload !== undefined && (typeof payload !== 'object' || payload.kind !== 'record')) fail('pending payload host binding must be a typed record', path + '.payload', 'GAMEPLAY_MODULE_INVALID_HOST_BINDING')
  for (const name of Object.keys(pendingHostTypeNames)) if (result[name] !== undefined && (!assignable(result[name], pendingHostTypeNames[name]) || !assignable(pendingHostTypeNames[name], result[name]))) fail('pending host binding "' + name + '" has the wrong type', path + '.' + name, 'GAMEPLAY_MODULE_PORT_TYPE')
  return result
}

type GraphParseContext = { readonly active: ReadonlySet<object> }
function continuationList(value: unknown, context: GraphParseContext, path: string): readonly StructuredContinuation[] {
  if (value === undefined) return []
  const entries: unknown[] = Array.isArray(value)
    ? value
    : isObject(value) ? Object.keys(value).map(id => {
      const entry = value[id]
      return isObject(entry) && !own(entry, 'id') ? { ...entry, id } : entry
    }) : []
  if (!Array.isArray(value) && !isObject(value)) fail('continuations must be an array or object map', path, 'GAMEPLAY_MODULE_SHAPE')
  const result: StructuredContinuation[] = []
  const seen = new Set<string>()
  entries.forEach((entry, index) => {
    const record = plain(entry, path + '[' + index + ']')
    allowed(record, ['id', 'version', 'graph', 'payloadType', 'payload'], path + '[' + index + ']')
    const id = safeName(record.id, path + '[' + index + '].id')
    const version = nonempty(record.version, path + '[' + index + '].version')
    const key = moduleKey(id, version)
    if (seen.has(key)) fail('duplicate continuation "' + id + '@' + version + '"', path, 'GAMEPLAY_MODULE_DUPLICATE_CONTINUATION')
    seen.add(key)
    if (!own(record, 'graph')) fail('continuation requires a pending graph', path + '[' + index + '].graph', 'GAMEPLAY_MODULE_INVALID_CONTINUATION')
    const payloadTypeValue = record.payloadType ?? record.payload
    if (record.payloadType !== undefined && record.payload !== undefined) fail('continuation cannot contain both payloadType and payload', path + '[' + index + ']', 'GAMEPLAY_MODULE_INVALID_CONTINUATION')
    const child = parseGraph(record.graph, { active: new Set([...context.active]) }, path + '[' + index + '].graph')
    if (child.surface !== 'pending') fail('continuation graph must use the pending surface', path + '[' + index + '].graph.surface', 'GAMEPLAY_MODULE_SURFACE_FORBIDDEN')
    result.push({ id, version, graph: child, payloadType: payloadTypeValue === undefined ? undefined : typeValue(payloadTypeValue, path + '[' + index + '].payloadType') })
  })
  return result
}

function parseGraph(value: unknown, context: GraphParseContext = { active: new Set() }, rootPath = 'graph'): Graph {
  const record = plain(value, rootPath)
  if (context.active.has(value as object)) fail('continuation graph cycle detected', rootPath, 'GAMEPLAY_MODULE_CONTINUATION_CYCLE')
  const active = new Set(context.active); active.add(value as object)
  allowed(record, ['version', 'surface', 'inputs', 'inputBindings', 'outputs', 'body', 'composites', 'schemas', 'hostBindings', 'continuations', 'layout'], rootPath)
  if (record.version !== GAMEPLAY_MODULE_GRAPH_VERSION) fail('unsupported graph version "' + String(record.version) + '"', rootPath + '.version', 'GAMEPLAY_MODULE_VERSION_MISMATCH')
  const surface = nonempty(record.surface, rootPath + '.surface')
  if (!surfaceSet.has(surface)) fail('unsupported surface "' + surface + '"', rootPath + '.surface', 'GAMEPLAY_MODULE_INVALID_SURFACE')
  if (!Array.isArray(record.body)) fail('graph.body must be an array', rootPath + '.body', 'GAMEPLAY_MODULE_SHAPE')
  const graphLayout = layout(record.layout, rootPath + '.layout')
  const inputPorts = ports(record.inputs, rootPath + '.inputs')
  const inputBindings = record.inputBindings === undefined ? {} : literalMap(record.inputBindings, rootPath + '.inputBindings')
  const outputPorts = ports(record.outputs, rootPath + '.outputs')
  const body = statements(record.body, rootPath + '.body')
  const composites = record.composites === undefined ? [] : !Array.isArray(record.composites) ? fail('graph.composites must be an array', rootPath + '.composites', 'GAMEPLAY_MODULE_SHAPE') : record.composites.map((entry, index) => composite(entry, rootPath + '.composites[' + index + ']'))
  const schemas = schemaList(record.schemas, rootPath + '.schemas')
  const bindings = hostBindings(record.hostBindings, surface as GameplayModuleSurface, rootPath + '.hostBindings')
  const continuationValues = continuationList(record.continuations, { active }, rootPath + '.continuations')
  const hostInputPorts: Port[] = []
  if (surface === 'pending') for (const [name, type] of Object.entries(bindings)) hostInputPorts.push({ name, type })
  const normalizedInputs = inputPorts.length ? inputPorts : hostInputPorts
  const inputNames = new Set<string>()
  for (const input of normalizedInputs) {
    if (inputNames.has(input.name)) fail('duplicate input "' + input.name + '"', rootPath + '.inputs', 'GAMEPLAY_MODULE_DUPLICATE_PORT')
    inputNames.add(input.name)
    if (input.name === 'context' || input.name === 'ctx') fail('reserved root input name', rootPath + '.inputs', 'GAMEPLAY_MODULE_INVALID_NAME')
    const hostType = surface === 'pending' ? bindings[input.name] : undefined
    if (hostType !== undefined && (!assignable(effective(input), hostType) || !assignable(hostType, effective(input)))) fail('pending host input "' + input.name + '" has an incompatible type', rootPath + '.inputs.' + input.name, 'GAMEPLAY_MODULE_PORT_TYPE')
    if (surface === 'pending' && hostType !== undefined && own(inputBindings as Rec, input.name)) fail('pending host input cannot have a static binding', rootPath + '.inputBindings.' + input.name, 'GAMEPLAY_MODULE_INVALID_HOST_BINDING')
    if (surface !== 'pending' && !own(inputBindings as Rec, input.name)) {
      if (surface !== 'preview') fail('root inputs require static inputBindings', rootPath + '.inputs.' + input.name, 'GAMEPLAY_MODULE_ROOT_INPUT')
      const previewType = previewHostType(input.name)
      if (!previewType) fail('root input requires a static binding or fixed preview host name', rootPath + '.inputs.' + input.name, 'GAMEPLAY_MODULE_ROOT_INPUT')
      if (!matchesPreviewHostType(effective(input), previewType)) fail('preview host input "' + input.name + '" has an incompatible type', rootPath + '.inputs.' + input.name, 'GAMEPLAY_MODULE_PORT_TYPE')
    }
    if (surface === 'pending' && hostType === undefined && !own(inputBindings as Rec, input.name)) fail('pending root input requires a fixed host binding or static binding', rootPath + '.inputs.' + input.name, 'GAMEPLAY_MODULE_ROOT_INPUT')
    if (own(inputBindings as Rec, input.name)) {
      const actual = typeOfLiteral(inputBindings[input.name])
      if (!assignable(actual, effective(input))) fail('root input binding expects ' + typeName(effective(input)) + ', got ' + typeName(actual), rootPath + '.inputBindings.' + input.name, 'GAMEPLAY_MODULE_PORT_TYPE')
    }
  }
  for (const key of Object.keys(inputBindings)) if (!inputNames.has(key)) fail('unknown root input binding "' + key + '"', rootPath + '.inputBindings.' + key, 'GAMEPLAY_MODULE_UNKNOWN_INPUT')
  if (surface !== 'pending' && Object.keys(bindings).length) fail('hostBindings are only available on pending graphs', rootPath + '.hostBindings', 'GAMEPLAY_MODULE_SURFACE_FORBIDDEN')
  const compositeKeys = new Set<string>()
  for (const entry of composites) { const key = moduleKey(entry.id, entry.version); if (compositeKeys.has(key)) fail('duplicate composite "' + entry.id + '@' + entry.version + '"', rootPath + '.composites', 'GAMEPLAY_MODULE_DUPLICATE_MODULE'); compositeKeys.add(key); ids(entry.body, rootPath + '.composites.' + entry.id + '.body') }
  ids(body, rootPath + '.body')
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: surface as GameplayModuleSurface, inputs: normalizedInputs, inputBindings, outputs: outputPorts, body, composites, schemas, hostBindings: bindings, continuations: continuationValues, layout: graphLayout }
}

function graph(value: unknown): Graph { return parseGraph(value) }

type SchemaTable = ReadonlyMap<string, GameplayRecordSchema>
function schemaTable(graphValue: Graph, inherited: SchemaTable = new Map()): Map<string, GameplayRecordSchema> {
  const table = new Map(inherited)
  for (const entry of graphValue.schemas) {
    const key = moduleKey(entry.id, entry.version)
    const previous = table.get(key)
    if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) fail('continuation redeclares a record schema with different fields', 'graph.schemas.' + entry.id, 'GAMEPLAY_MODULE_DUPLICATE_SCHEMA')
    table.set(key, entry)
    // A bare schema id is accepted only when it resolves uniquely.  The map
    // stores the first declaration and ambiguity is checked below.
  }
  return table
}
function schemaFor(table: SchemaTable, reference: string, path: string): GameplayRecordSchema {
  const matches = [...table.values()].filter(entry => entry.id === reference || moduleKey(entry.id, entry.version) === reference || entry.id + '@' + entry.version === reference)
  if (!matches.length) fail('unknown record schema "' + reference + '"', path, 'GAMEPLAY_MODULE_UNKNOWN_SCHEMA')
  if (matches.length > 1 && !reference.includes('@')) fail('record schema id is ambiguous; use id@version', path, 'GAMEPLAY_MODULE_AMBIGUOUS_SCHEMA')
  return matches[0]
}
function validateTypeSchemas(value: GameplayValueType, table: SchemaTable, path: string): void {
  if (typeof value === 'string') return
  if (value.kind === 'list' || value.kind === 'set') return validateTypeSchemas(value.element, table, path + '.element')
  if (value.kind === 'map') { validateTypeSchemas(value.key, table, path + '.key'); validateTypeSchemas(value.value, table, path + '.value'); return }
  if (value.kind === 'nullable') return validateTypeSchemas(value.value, table, path + '.value')
  schemaFor(table, value.schema, path + '.schema')
}
function validatePortSchemas(value: readonly Port[], table: SchemaTable, path: string): void {
  value.forEach((entry, index) => validateTypeSchemas(effective(entry), table, path + '[' + index + '].type'))
}
function validateGraphSchemas(graphValue: Graph, inherited: SchemaTable = new Map(), path = 'graph', active = new Set<Graph>()): void {
  if (active.has(graphValue)) fail('continuation graph cycle detected', path, 'GAMEPLAY_MODULE_CONTINUATION_CYCLE')
  const nextActive = new Set(active); nextActive.add(graphValue)
  const table = schemaTable(graphValue, inherited)
  for (const schemaValue of graphValue.schemas) validatePortSchemas(schemaValue.fields, table, path + '.schemas.' + schemaValue.id + '@' + schemaValue.version + '.fields')
  validatePortSchemas(graphValue.inputs, table, path + '.inputs')
  validatePortSchemas(graphValue.outputs, table, path + '.outputs')
  for (const [name, value] of Object.entries(graphValue.hostBindings)) validateTypeSchemas(value, table, path + '.hostBindings.' + name)
  for (const compositeValue of graphValue.composites) {
    validatePortSchemas(compositeValue.inputs, table, path + '.composites.' + compositeValue.id + '.inputs')
    validatePortSchemas(compositeValue.outputs, table, path + '.composites.' + compositeValue.id + '.outputs')
  }
  for (const continuation of graphValue.continuations) {
    if (continuation.payloadType) validateTypeSchemas(continuation.payloadType, table, path + '.continuations.' + continuation.id + '.payloadType')
    validateGraphSchemas(continuation.graph, table, path + '.continuations.' + continuation.id + '.graph', nextActive)
    const payload = continuation.graph.hostBindings.payload
    if (payload && continuation.payloadType && (!assignable(continuation.payloadType, payload) || !assignable(payload, continuation.payloadType))) fail('continuation payload type does not match pending payload host binding', path + '.continuations.' + continuation.id, 'GAMEPLAY_MODULE_WRONG_PAYLOAD_TYPE')
  }
}
function validateGraphLiteralBudget(value: Graph, limit: number): void {
  const budget = { bytes: 0, limit }
  const visitValue = (entry: GameplayValue, currentBudget = budget): void => { if (entry.kind === 'literal') json(entry.value, 'graph.literal', currentBudget) }
  const visitBody = (body: readonly GameplayStatement[], currentBudget = budget): void => {
    for (const node of body) {
      if ('layout' in node && node.layout !== undefined) json(node.layout, 'graph.layout', currentBudget)
      if (node.kind === 'call') {
        for (const entry of Object.values(node.inputs ?? {})) visitValue(entry, currentBudget)
        for (const entry of Object.values(node.parameters ?? {})) json(entry, 'graph.parameters', currentBudget)
      } else if (node.kind === 'if') {
        visitValue(node.condition, currentBudget); visitBody(node.then, currentBudget); if (node.else) visitBody(node.else, currentBudget)
      } else if (node.kind === 'foreach') {
        visitValue(node.items, currentBudget); visitBody(node.body, currentBudget)
      } else if (node.kind === 'while') {
        for (const entry of Object.values(node.condition.inputs ?? {})) visitValue(entry, currentBudget)
        visitBody(node.condition.body, currentBudget); visitBody(node.body, currentBudget)
      } else if (node.kind === 'record.create') {
        for (const entry of Object.values(node.fields ?? {})) visitValue(entry, currentBudget)
      } else if (node.kind === 'record.get') {
        visitValue(node.record, currentBudget)
      } else if (node.kind === 'record.with') {
        visitValue(node.record, currentBudget); for (const entry of Object.values(node.fields ?? {})) visitValue(entry, currentBudget)
      } else if (node.kind === 'collection') {
        visitValue(node.items, currentBudget); for (const entry of Object.values(node.inputs ?? {})) visitValue(entry, currentBudget); if (node.initial !== undefined) visitValue(node.initial, currentBudget); visitBody(node.body, currentBudget)
      } else if (node.kind === 'defer-choice') {
        visitValue(node.payload, currentBudget)
        for (const name of ['player', 'title', 'targetType', 'range', 'filter', 'candidates', 'selectionMode', 'min', 'max', 'minSelections', 'maxSelections', 'canCancel', 'resumeOnCancel', 'message'] as const) {
          const value = node[name]
          if (value !== undefined) visitValue(value, currentBudget)
        }
      } else if (node.kind === 'return') {
        if (node.values) for (const entry of Object.values(node.values)) visitValue(entry, currentBudget)
        if (node.value) visitValue(node.value, currentBudget)
      }
    }
  }
  const visitGraph = (graphValue: Graph): void => {
    for (const entry of Object.values(graphValue.inputBindings)) json(entry, 'graph.inputBindings', budget)
    if (graphValue.layout !== undefined) json(graphValue.layout, 'graph.layout', budget)
    visitBody(graphValue.body, budget)
    for (const compositeValue of graphValue.composites) {
      if (compositeValue.layout !== undefined) json(compositeValue.layout, 'graph.composite.layout', budget)
      for (const parameterValue of compositeValue.parameters ?? []) {
        if (Object.prototype.hasOwnProperty.call(parameterValue, 'default')) json(parameterValue.default as GameplayLiteral, 'graph.composite.parameters', budget)
        for (const entry of parameterValue.enum ?? []) json(entry, 'graph.composite.parameters', budget)
      }
      visitBody(compositeValue.body, budget)
    }
    for (const continuation of graphValue.continuations) visitGraph(continuation.graph)
  }
  visitGraph(value)
}

function typeOfLiteral(value: GameplayLiteral): GameplayValueType {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: 'list', element: 'never' }
    const element = typeOfLiteral(value[0])
    for (let i = 1; i < value.length; i += 1) if (!assignable(typeOfLiteral(value[i]), element) || !assignable(element, typeOfLiteral(value[i]))) return { kind: 'list', element: 'record' }
    return { kind: 'list', element }
  }
  if (isAuthorSet(value)) {
    const items = typeOfLiteral(value.items as GameplayLiteral)
    if (typeof items === 'object' && items.kind === 'list') return { kind: 'set', element: items.element }
  }
  if (isAuthorMap(value)) {
    const keys = typeOfLiteral(value.entries.map(entry => entry[0]) as GameplayLiteral)
    const values = typeOfLiteral(value.entries.map(entry => entry[1]) as GameplayLiteral)
    if (typeof keys === 'object' && keys.kind === 'list' && typeof values === 'object' && values.kind === 'list') return { kind: 'map', key: keys.element, value: values.element }
  }
  return 'record'
}
function assignable(actual: GameplayValueType, expected: GameplayValueType): boolean {
  if (typeof expected === 'string') {
    if (expected === 'unknown' || expected === 'any') return true
    if (actual === 'never') return true
    if (expected === 'null') return actual === 'null'
    if (typeof actual === 'string') return actual === expected
    if (expected === 'record' && actual.kind === 'record') return true
    return false
  }
  if (expected.kind === 'nullable') {
    if (actual === 'null') return true
    return typeof actual === 'object'
      ? actual.kind === 'nullable' ? assignable(actual.value, expected.value) : assignable(actual, expected.value)
      : assignable(actual, expected.value)
  }
  if (expected.kind === 'record') {
    if (typeof actual !== 'object' || actual.kind !== 'record') return false
    return actual.schema === expected.schema
      || (actual.schema.indexOf('@') < 0 && expected.schema.startsWith(actual.schema + '@'))
      || (expected.schema.indexOf('@') < 0 && actual.schema.startsWith(expected.schema + '@'))
  }
  if (expected.kind === 'map') return typeof actual === 'object' && actual.kind === 'map' && assignable(actual.key, expected.key) && assignable(actual.value, expected.value)
  if (expected.kind === 'set') return typeof actual === 'object' && actual.kind === 'set' && (actual.element === 'never' || assignable(actual.element, expected.element))
  if (typeof actual !== 'object' || actual.kind !== 'list') return false
  return expected.kind === 'list' && (actual.element === 'never' || assignable(actual.element, expected.element))
}
function typeName(value: GameplayValueType): string {
  if (typeof value === 'string') return value
  if (value.kind === 'list') return 'list<' + typeName(value.element) + '>'
  if (value.kind === 'set') return 'set<' + typeName(value.element) + '>'
  if (value.kind === 'map') return 'map<' + typeName(value.key) + ',' + typeName(value.value) + '>'
  if (value.kind === 'nullable') return 'nullable<' + typeName(value.value) + '>'
  return 'record<' + value.schema + '>'
}
function effective(portValue: Port): GameplayValueType { return portValue.nullable ? { kind: 'nullable', value: portValue.type } : portValue.type }
function mapPorts(values: readonly Port[]): ReadonlyMap<string, Port> { const map = new Map<string, Port>(); for (const value of values) map.set(value.name, value); return map }
function mapParams(values: readonly Param[]): ReadonlyMap<string, Param> { const map = new Map<string, Param>(); for (const value of values) map.set(value.name, value); return map }
function validateEffects(value: unknown, path: string): GameplayEffectMetadata {
  const record = plain(value, path)
  allowed(record, ['previewSafe', 'pure', 'writes', 'reads', 'random', 'pending', 'events', 'description'], path)
  const result: Rec = {}
  for (const key of ['previewSafe', 'pure', 'random', 'pending'] as const) if (record[key] !== undefined) result[key] = bool(record[key], path + '.' + key)
  for (const key of ['writes', 'reads', 'events'] as const) if (record[key] !== undefined) {
    if (!Array.isArray(record[key])) fail(key + ' must be an array', path + '.' + key, 'GAMEPLAY_MODULE_INVALID_EFFECTS')
    result[key] = record[key].map((entry, index) => nonempty(entry, path + '.' + key + '[' + index + ']'))
  }
  if (record.description !== undefined) result.description = nonempty(record.description, path + '.description')
  return result as GameplayEffectMetadata
}
function descriptor(value: unknown, id: string, version: string): GameplayModuleDescriptor {
  if (!isObject(value)) fail('registry returned an invalid descriptor', 'registry.' + id, 'GAMEPLAY_MODULE_REGISTRY_INVALID')
  const record = value as Rec
  for (const key of ['id', 'version', 'label', 'inputs', 'outputs', 'allowedSurfaces', 'effects', 'lower']) if (!own(record, key)) fail('registry descriptor is missing ' + key, 'registry.' + id, 'GAMEPLAY_MODULE_REGISTRY_INVALID')
  allowed(record, ['id', 'version', 'label', 'description', 'uiDescription', 'inputs', 'outputs', 'outputTypeBindings', 'outputSchemaBindings', 'inputSchemaBindings', 'outputValueTypeBindings', 'inputValueTypeBindings', 'outputParameterTypeBindings', 'parameters', 'inspectReferences', 'livingReferences', 'allowedSurfaces', 'effects', 'ui', 'lower'], 'registry.' + id)
  const actualId = nonempty(record.id, 'registry.' + id + '.id')
  const actualVersion = nonempty(record.version, 'registry.' + id + '.version')
  if (actualId !== id || actualVersion !== version) fail('registry descriptor does not match requested module', 'registry.' + id, 'GAMEPLAY_MODULE_REGISTRY_INVALID')
  const inputPorts = ports(record.inputs, 'registry.' + id + '.inputs', true)
  const result: Rec = { id: actualId, version: actualVersion, label: nonempty(record.label, 'registry.' + id + '.label'), inputs: inputPorts, outputs: ports(record.outputs, 'registry.' + id + '.outputs', true), allowedSurfaces: allowedSurfaces(record.allowedSurfaces, 'registry.' + id + '.allowedSurfaces'), effects: validateEffects(record.effects, 'registry.' + id + '.effects'), lower: record.lower }
  for (const input of inputPorts) if (input.type === 'any' || input.type === 'unknown') fail('universal input types are not allowed', 'registry.' + id + '.inputs', 'GAMEPLAY_MODULE_INVALID_TYPE')
  for (const output of result.outputs as Port[]) if ((output.type === 'any' || output.type === 'unknown') && !isObject(record.outputTypeBindings) && !isObject(record.outputParameterTypeBindings)) fail('unbound universal output types are not allowed', 'registry.' + id + '.outputs', 'GAMEPLAY_MODULE_INVALID_TYPE')
  if (record.description !== undefined) result.description = nonempty(record.description, 'registry.' + id + '.description')
  if (record.uiDescription !== undefined) result.uiDescription = nonempty(record.uiDescription, 'registry.' + id + '.uiDescription')
  const params = parameters(record.parameters, 'registry.' + id + '.parameters'); if (params.length) result.parameters = params
  const inspected = inspectReferences(record.inspectReferences, inputPorts, 'registry.' + id + '.inspectReferences', record.inputValueTypeBindings, params); if (inspected !== undefined) result.inspectReferences = inspected
  const living = livingReferences(record.livingReferences, inputPorts, 'registry.' + id + '.livingReferences')
  if (living !== undefined) {
    if (inspected?.some(name => living.includes(name))) fail('an input cannot be listed in both livingReferences and inspectReferences', 'registry.' + id + '.livingReferences', 'GAMEPLAY_MODULE_CONFLICTING_REFERENCE_METADATA')
    result.livingReferences = living
  }
  if (record.outputTypeBindings !== undefined) {
    const bindings = plain(record.outputTypeBindings, 'registry.' + id + '.outputTypeBindings')
    const normalized: Record<string, { input: string; projection: 'same' | 'element' | 'singleton' }> = Object.create(null)
    for (const [output, rawBinding] of Object.entries(bindings)) {
      const path = 'registry.' + id + '.outputTypeBindings.' + output
      const binding = plain(rawBinding, path)
      allowed(binding, ['input', 'projection'], path)
      const input = nonempty(binding.input, path + '.input')
      if (!(result.outputs as Port[]).some(port => port.name === output) || !inputPorts.some(port => port.name === input && !port.optional)) fail('type binding must name an output and a required input', path, 'GAMEPLAY_MODULE_REGISTRY_INVALID')
      if (binding.projection !== 'same' && binding.projection !== 'element' && binding.projection !== 'singleton') fail('unknown type binding projection', path, 'GAMEPLAY_MODULE_REGISTRY_INVALID')
      normalized[output] = { input, projection: binding.projection }
    }
    result.outputTypeBindings = normalized
  }
  for (const output of result.outputs as Port[]) if ((output.type === 'any' || output.type === 'unknown') && !(result.outputTypeBindings as Record<string, unknown> | undefined)?.[output.name] && !(record.outputParameterTypeBindings && isObject(record.outputParameterTypeBindings) && own(record.outputParameterTypeBindings, output.name))) fail('unbound universal output types are not allowed', 'registry.' + id + '.outputs', 'GAMEPLAY_MODULE_INVALID_TYPE')
  if (record.ui !== undefined) result.ui = plain(record.ui, 'registry.' + id + '.ui')
  for (const kind of ['outputSchemaBindings', 'inputSchemaBindings'] as const) if (record[kind] !== undefined) {
    const bindings = plain(record[kind], 'registry.' + id + '.' + kind)
    const normalized: Record<string, { parameter: string; list?: boolean }> = Object.create(null)
    for (const [name, raw] of Object.entries(bindings)) {
      const path = 'registry.' + id + '.' + kind + '.' + name
      const binding = plain(raw, path)
      allowed(binding, ['parameter', 'list'], path)
      const parameter = nonempty(binding.parameter, path + '.parameter')
      const boundPorts = kind === 'outputSchemaBindings' ? result.outputs as Port[] : inputPorts
      if (!boundPorts.some(port => port.name === name) || !params.some(port => port.name === parameter && port.type === 'string')) fail('schema binding must name a port and a string parameter', path, 'GAMEPLAY_MODULE_REGISTRY_INVALID')
      normalized[name] = { parameter, ...(binding.list === undefined ? {} : { list: bool(binding.list, path + '.list') }) }
    }
    result[kind] = normalized
  }
  if (typeof record.lower !== 'function') fail('registry descriptor lower must be a function', 'registry.' + id + '.lower', 'GAMEPLAY_MODULE_REGISTRY_INVALID')
  for (const kind of ['outputValueTypeBindings', 'inputValueTypeBindings'] as const) if (record[kind] !== undefined) {
    const bindings = plain(record[kind], 'registry.' + id + '.' + kind)
    const normalized: Record<string, { parameter: string; nullable?: boolean }> = Object.create(null)
    for (const [name, raw] of Object.entries(bindings)) {
      const path = 'registry.' + id + '.' + kind + '.' + name
      const binding = plain(raw, path)
      allowed(binding, kind === 'inputValueTypeBindings' ? ['parameter', 'nullable'] : ['parameter'], path)
      if (binding.nullable !== undefined && typeof binding.nullable !== 'boolean') fail('nullable binding must be boolean', path + '.nullable')
      const parameter = nonempty(binding.parameter, path + '.parameter')
      const boundPorts = kind === 'outputValueTypeBindings' ? result.outputs as Port[] : inputPorts
      if (!boundPorts.some(port => port.name === name) || !params.some(port => port.name === parameter && port.type === 'string')) fail('value type binding must name a port and a string parameter', path, 'GAMEPLAY_MODULE_REGISTRY_INVALID')
      normalized[name] = { parameter, ...(binding.nullable === undefined ? {} : { nullable: binding.nullable as boolean }) }
    }
    result[kind] = normalized
  }
  const fieldBindings = outputParameterTypeBindings(record.outputParameterTypeBindings, result.outputs as Port[], params, 'registry.' + id + '.outputParameterTypeBindings')
  if (fieldBindings !== undefined) result.outputParameterTypeBindings = fieldBindings
  return result as GameplayModuleDescriptor
}
function registryGet(registry: GameplayModuleRegistry, id: string, version: string): unknown {
  if (registry instanceof Map) {
    const value = registry.get(moduleKey(id, version)) ?? registry.get(id + '@' + version) ?? registry.get(id)
    return Array.isArray(value) ? value.find(entry => isObject(entry) && entry.id === id && entry.version === version) : value
  }
  const object = registry as Exclude<GameplayModuleRegistry, ReadonlyMap<string, unknown>>
  if (typeof object.resolve === 'function') { const value = object.resolve(id, version); if (value) return value }
  if (typeof object.get === 'function') {
    const value = object.get(id, version) ?? object.get(id)
    return Array.isArray(value) ? value.find(entry => isObject(entry) && entry.id === id && entry.version === version) : value
  }
  if (Array.isArray(object.descriptors)) return object.descriptors.find(entry => entry.id === id && entry.version === version)
  fail('registry must expose get, resolve, descriptors, or Map lookup', 'registry', 'GAMEPLAY_MODULE_REGISTRY_INVALID')
}
function makeResolver(value: Graph, registry: GameplayModuleRegistry, limits: Required<GameplayModuleCompilerOptions>, inheritedSchemas: SchemaTable = new Map()): Resolver {
  const composites = new Map<string, GameplayCompositeDefinition>()
  for (const entry of value.composites) composites.set(moduleKey(entry.id, entry.version), entry)
  return { graph: value, composites, native: new Map(), calls: new Map(), dependencies: new Map(), expanded: [], limits, registry, schemas: schemaTable(value, inheritedSchemas), statementCount: 0 }
}
function resolve(resolver: Resolver, id: string, version: string, path: string): Resolved {
  const compositeValue = resolver.composites.get(moduleKey(id, version))
  const nativeValue = resolver.native.get(moduleKey(id, version))
  if (compositeValue && nativeValue) fail('module is ambiguous', path, 'GAMEPLAY_MODULE_AMBIGUOUS_MODULE')
  if (compositeValue) return { kind: 'composite', definition: compositeValue }
  if (nativeValue) return { kind: 'native', descriptor: nativeValue }
  const nativeDescriptor = descriptor(registryGet(resolver.registry, id, version), id, version)
  resolver.native.set(moduleKey(id, version), nativeDescriptor)
  return { kind: 'native', descriptor: nativeDescriptor }
}
function parameterValues(value: Readonly<Record<string, GameplayLiteral>>, declarations: readonly Param[], path: string): Readonly<Record<string, GameplayLiteral>> {
  const declared = mapParams(declarations)
  const result: Record<string, GameplayLiteral> = Object.create(null) as Record<string, GameplayLiteral>
  for (const key of Object.keys(value)) {
    const declaration = declared.get(key)
    if (!declaration) fail('unknown parameter "' + key + '"', path + '.' + key, 'GAMEPLAY_MODULE_UNKNOWN_PARAMETER')
    result[key] = clone(value[key])
    const actual = typeOfLiteral(value[key])
    if (!assignable(actual, effective(declaration))) fail('parameter "' + key + '" expects ' + typeName(effective(declaration)) + ', got ' + typeName(actual), path + '.' + key, 'GAMEPLAY_MODULE_PARAMETER_TYPE')
    if (declaration.enum && !declaration.enum.some(entry => JSON.stringify(entry) === JSON.stringify(value[key]))) fail('parameter "' + key + '" is outside its enum', path + '.' + key, 'GAMEPLAY_MODULE_PARAMETER_VALUE')
    if (typeof value[key] === 'number') {
      if (declaration.minimum !== undefined && value[key] < declaration.minimum) fail('parameter "' + key + '" is below minimum', path + '.' + key, 'GAMEPLAY_MODULE_PARAMETER_VALUE')
      if (declaration.maximum !== undefined && value[key] > declaration.maximum) fail('parameter "' + key + '" is above maximum', path + '.' + key, 'GAMEPLAY_MODULE_PARAMETER_VALUE')
    }
  }
  for (const declaration of declarations) {
    if (own(value as Rec, declaration.name)) continue
    if (own(declaration as unknown as Rec, 'default')) result[declaration.name] = clone((declaration as Param & { default: GameplayLiteral }).default)
    else if (!declaration.optional) fail('missing parameter "' + declaration.name + '"', path, 'GAMEPLAY_MODULE_MISSING_PARAMETER')
  }
  return result
}
function valueType(value: GameplayValue, environment: VEnv, path: string): GameplayValueType {
  if (value.kind === 'literal') return typeOfLiteral(value.value)
  if (value.kind === 'input') {
    const type = environment.inputs.get(value.name)
    if (!type) fail('unknown input "' + value.name + '"', path, 'GAMEPLAY_MODULE_UNKNOWN_INPUT')
    return type
  }
  const binding = environment.bindings.get(value.node)
  if (!binding) fail('output is not in scope or does not dominate this statement', path, 'GAMEPLAY_MODULE_OUTPUT_SCOPE')
  const type = binding.get(value.port)
  if (!type) fail('unknown output port "' + value.node + '.' + value.port + '"', path, 'GAMEPLAY_MODULE_UNKNOWN_OUTPUT')
  return type
}
function previewSafe(effects: GameplayEffectMetadata): boolean {
  if (effects.previewSafe === false) return false
  if (effects.previewSafe === true) return true
  return effects.pure === true && !effects.random && !effects.pending && !(effects.writes && effects.writes.length) && !(effects.events && effects.events.length)
}
function validateReturn(node: GameplayReturnStatement, outputs: readonly Port[], environment: VEnv, path: string): void {
  const declared = mapPorts(outputs)
  if (node.values !== undefined) {
    for (const key of Object.keys(node.values)) {
      const output = declared.get(key)
      if (!output) fail('unknown graph output "' + key + '"', path + '.values.' + key, 'GAMEPLAY_MODULE_UNKNOWN_OUTPUT')
      const actual = valueType(node.values[key], environment, path + '.values.' + key)
      if (!assignable(actual, effective(output))) fail('return output "' + key + '" expects ' + typeName(effective(output)) + ', got ' + typeName(actual), path + '.values.' + key, 'GAMEPLAY_MODULE_PORT_TYPE')
    }
    for (const output of outputs) if (!output.optional && !own(node.values as Rec, output.name)) fail('missing graph output "' + output.name + '"', path + '.values', 'GAMEPLAY_MODULE_MISSING_OUTPUT')
    return
  }
  if (node.value !== undefined) {
    if (outputs.length !== 1) fail('scalar return requires exactly one declared output', path, 'GAMEPLAY_MODULE_INVALID_RETURN')
    const actual = valueType(node.value, environment, path + '.value')
    if (!assignable(actual, effective(outputs[0]))) fail('return value expects ' + typeName(effective(outputs[0])) + ', got ' + typeName(actual), path + '.value', 'GAMEPLAY_MODULE_PORT_TYPE')
    return
  }
  if (outputs.some(output => !output.optional)) fail('return must provide all declared outputs', path, 'GAMEPLAY_MODULE_MISSING_OUTPUT')
}

function recordType(schemaReference: string): GameplayValueType { return { kind: 'record', schema: schemaReference } }
function parameterValueType(value: GameplayLiteral, resolver: Resolver, path: string): GameplayValueType {
  let parsed: unknown = value
  if (typeof value === 'string' && value.trimStart().startsWith('{')) {
    try { parsed = JSON.parse(value) } catch { fail('invalid value type descriptor', path, 'GAMEPLAY_MODULE_INVALID_TYPE') }
  }
  const type = typeValue(parsed, path)
  validateTypeSchemas(type, resolver.schemas, path)
  return type
}
function resolveRecordSchema(resolver: Resolver, reference: string, path: string): GameplayRecordSchema {
  return schemaFor(resolver.schemas, reference, path)
}
function collectionNames(node: GameplayCollectionStatement, method: GameplayCollectionStatement['method'], path: string): { item: string; index: string; accumulator?: string } {
  const item = node.item ?? 'item'
  const index = node.index ?? 'index'
  const accumulator = method === 'reduce' ? node.accumulator ?? 'accumulator' : undefined
  if (item === index || accumulator === item || accumulator === index) fail('collection local names must be distinct', path, 'GAMEPLAY_MODULE_INVALID_NAME')
  return { item, index, accumulator }
}
function collectionReturnValue(node: GameplayReturnStatement, environment: VEnv, path: string): GameplayValueType {
  if (node.value !== undefined) return valueType(node.value, environment, path + '.value')
  if (node.values !== undefined) {
    const keys = Object.keys(node.values)
    if (keys.length !== 1 || !own(node.values as Rec, 'value')) fail('collection body return must provide one scalar value', path + '.values', 'GAMEPLAY_MODULE_INVALID_RETURN')
    return valueType(node.values.value, environment, path + '.values.value')
  }
  fail('collection body must return a typed value', path, 'GAMEPLAY_MODULE_MISSING_OUTPUT')
}

type WhileEnvironments = {
  readonly condition: VEnv
  readonly body: VEnv
}

function whileEnvironments(node: Extract<GameplayStatement, { kind: 'while' }>, environment: VEnv, path: string): WhileEnvironments {
  const conditionInputs = new Map<string, GameplayValueType>()
  for (const [name, value] of Object.entries(node.condition.inputs ?? {})) {
    conditionInputs.set(name, valueType(value, environment, path + '.condition.inputs.' + name))
  }
  const bodyInputs = new Map(environment.inputs)
  if (node.index) {
    if (bodyInputs.has(node.index)) fail('while index shadows an input', path + '.index', 'GAMEPLAY_MODULE_INVALID_NAME')
    bodyInputs.set(node.index, 'number')
  }
  const loopBindings = new Map(environment.bindings)
  loopBindings.set(node.id, new Map([['index', 'number']]))
  return {
    condition: { inputs: conditionInputs, bindings: new Map() },
    body: { inputs: bodyInputs, bindings: loopBindings },
  }
}

function validateWhileCondition(node: Extract<GameplayStatement, { kind: 'while' }>, resolver: Resolver, environment: VEnv, path: string, active: readonly string[], depth: number): void {
  const environments = whileEnvironments(node, environment, path)
  const outputs: readonly Port[] = [{ name: 'value', type: 'boolean' }]
  validateBody(node.condition.body, resolver, environments.condition, outputs, path + '.condition.body', active, depth, true)
  if (!bodyGuaranteesReturn(node.condition.body)) fail('while condition can fall through without returning a boolean', path + '.condition.body', 'GAMEPLAY_MODULE_MISSING_OUTPUT')
  const returns = collectCollectionReturns(node.condition.body, resolver, environments.condition, path + '.condition.body', true)
  if (!returns.length) fail('while condition must return a boolean', path + '.condition.body', 'GAMEPLAY_MODULE_MISSING_OUTPUT')
  for (const value of returns) if (!assignable(value, 'boolean')) fail('while condition must return a boolean', path + '.condition.body', 'GAMEPLAY_MODULE_PORT_TYPE')
}

function collectCollectionReturns(list: readonly GameplayStatement[], resolver: Resolver, environment: VEnv, path: string, validateCollections = true): GameplayValueType[] {
  const bindings = new Map(environment.bindings)
  const result: GameplayValueType[] = []
  list.forEach((node, index) => {
    const nodePath = path + '[' + index + ']'
    if (node.kind === 'call') {
      const metadata = resolver.calls.get(node)
      if (!metadata) fail('missing collection call metadata', nodePath, 'GAMEPLAY_MODULE_INTERNAL_ERROR')
      bindings.set(node.id, metadata.outputTypes)
    } else if (node.kind === 'record.create') {
      resolveRecordSchema(resolver, node.schema, nodePath + '.schema'); bindings.set(node.id, new Map([['value', recordType(node.schema)]]))
    } else if (node.kind === 'record.get') {
      const actual = valueType(node.record, { inputs: environment.inputs, bindings }, nodePath + '.record')
      const schemaValue = typeof actual === 'object' && actual.kind === 'record' ? resolveRecordSchema(resolver, actual.schema, nodePath + '.record.schema') : undefined
      if (!schemaValue) fail('record.get requires a typed record', nodePath + '.record', 'GAMEPLAY_MODULE_UNTYPED_RECORD')
      const field = schemaValue.fields.find(entry => entry.name === node.field)
      if (!field) fail('unknown record field "' + node.field + '"', nodePath + '.field', 'GAMEPLAY_MODULE_UNKNOWN_FIELD')
      bindings.set(node.id, new Map([['value', effective(field)]]))
    } else if (node.kind === 'record.with') {
      const actual = valueType(node.record, { inputs: environment.inputs, bindings }, nodePath + '.record')
      if (typeof actual !== 'object' || actual.kind !== 'record') fail('record.with requires a typed record', nodePath + '.record', 'GAMEPLAY_MODULE_UNTYPED_RECORD')
      const schemaValue = resolveRecordSchema(resolver, actual.schema, nodePath + '.record.schema')
      const fields = node.fields ?? {}
      const declared = mapPorts(schemaValue.fields)
      for (const key of Object.keys(fields)) {
        const field = declared.get(key); if (!field) fail('unknown record field "' + key + '"', nodePath + '.fields.' + key, 'GAMEPLAY_MODULE_UNKNOWN_FIELD')
        const type = valueType(fields[key], { inputs: environment.inputs, bindings }, nodePath + '.fields.' + key)
        if (!assignable(type, effective(field))) fail('record field "' + key + '" expects ' + typeName(effective(field)) + ', got ' + typeName(type), nodePath + '.fields.' + key, 'GAMEPLAY_MODULE_PORT_TYPE')
      }
      bindings.set(node.id, new Map([['value', recordType(actual.schema)]]))
    } else if (node.kind === 'collection') {
      const output = collectionOutputType(node, resolver, { inputs: environment.inputs, bindings }, nodePath, validateCollections)
      bindings.set(node.id, new Map([['value', output]]))
    } else if (node.kind === 'if') {
      result.push(...collectCollectionReturns(node.then, resolver, { inputs: environment.inputs, bindings: new Map(bindings) }, nodePath + '.then', validateCollections))
      if (node.else) result.push(...collectCollectionReturns(node.else, resolver, { inputs: environment.inputs, bindings: new Map(bindings) }, nodePath + '.else', validateCollections))
    } else if (node.kind === 'foreach') {
      const collection = valueType(node.items, { inputs: environment.inputs, bindings }, nodePath + '.items')
      if (typeof collection !== 'object' || collection.kind !== 'list') fail('foreach items must be a list', nodePath + '.items', 'GAMEPLAY_MODULE_PORT_TYPE')
      const loopInputs = new Map(environment.inputs); if (node.item) loopInputs.set(node.item, collection.element); if (node.index) loopInputs.set(node.index, 'number')
      const loopBindings = new Map(bindings); loopBindings.set(node.id, new Map([['item', collection.element], ['index', 'number']]))
      result.push(...collectCollectionReturns(node.body, resolver, { inputs: loopInputs, bindings: loopBindings }, nodePath + '.body', validateCollections))
    } else if (node.kind === 'while') {
      const environments = whileEnvironments(node, { inputs: environment.inputs, bindings }, nodePath)
      result.push(...collectCollectionReturns(node.body, resolver, environments.body, nodePath + '.body', validateCollections))
    } else if (node.kind === 'return') {
      result.push(collectionReturnValue(node, { inputs: environment.inputs, bindings }, nodePath))
    }
  })
  return result
}
function collectionOutputType(node: GameplayCollectionStatement, resolver: Resolver, environment: VEnv, path: string, validate = true): GameplayValueType {
  const collection = valueType(node.items, environment, path + '.items')
  if (typeof collection !== 'object' || collection.kind !== 'list') fail('collection items must be a list', path + '.items', 'GAMEPLAY_MODULE_PORT_TYPE')
  const names = collectionNames(node, node.method, path)
  // A collection subprocess has a closed environment.  Surrounding graph
  // inputs are visible only when explicitly passed through `inputs`.
  const bodyInputs = new Map<string, GameplayValueType>()
  const captures = node.inputs ?? {}
  for (const key of Object.keys(captures)) {
    if (key === names.item || key === names.index || key === names.accumulator) fail('collection capture shadows a local input', path + '.inputs.' + key, 'GAMEPLAY_MODULE_INVALID_NAME')
    bodyInputs.set(key, valueType(captures[key], environment, path + '.inputs.' + key))
  }
  bodyInputs.set(names.item, collection.element); bodyInputs.set(names.index, 'number')
  let accumulatorType: GameplayValueType | undefined
  if (node.method === 'reduce') {
    if (node.initial !== undefined) accumulatorType = valueType(node.initial, environment, path + '.initial')
    else accumulatorType = collection.element
    bodyInputs.set(names.accumulator!, accumulatorType)
  }
  const bodyEnvironment: VEnv = { inputs: bodyInputs, bindings: new Map() }
  // Validate nested calls/control flow against a synthetic scalar output.  The
  // actual scalar type is inferred below from all reachable return statements.
  if (validate) validateBody(node.body, resolver, bodyEnvironment, [{ name: 'value', type: 'any' }], path + '.body', [], 0, true)
  const returns = collectCollectionReturns(node.body, resolver, bodyEnvironment, path + '.body', validate)
  if (!returns.length) fail('collection body must return a typed value', path + '.body', 'GAMEPLAY_MODULE_MISSING_OUTPUT')
  const output = returns[0]
  for (const value of returns.slice(1)) if (!assignable(value, output) || !assignable(output, value)) fail('collection body returns inconsistent types', path + '.body', 'GAMEPLAY_MODULE_PORT_TYPE')
  if (node.method === 'filter') {
    if (!assignable(output, 'boolean')) fail('filter body must return boolean', path + '.body', 'GAMEPLAY_MODULE_PORT_TYPE')
    return { kind: 'list', element: collection.element }
  }
  if (node.method === 'find') {
    if (!assignable(output, 'boolean')) fail('find body must return boolean', path + '.body', 'GAMEPLAY_MODULE_PORT_TYPE')
    return { kind: 'nullable', value: collection.element }
  }
  if (node.method === 'map') return { kind: 'list', element: output }
  if (accumulatorType && (!assignable(output, accumulatorType) || !assignable(accumulatorType, output))) fail('reduce body must return the accumulator type', path + '.body', 'GAMEPLAY_MODULE_PORT_TYPE')
  return output
}
const deferChoiceFieldTypes: Readonly<Record<string, GameplayValueType>> = {
  player: 'player',
  title: 'string',
  targetType: 'string',
  range: 'number',
  filter: 'string',
  candidates: { kind: 'list', element: 'choice' },
  selectionMode: 'string',
  min: 'number',
  max: 'number',
  minSelections: 'number',
  maxSelections: 'number',
  canCancel: 'boolean',
  resumeOnCancel: 'boolean',
  message: 'string',
}
function validateDeferChoiceField(name: string, value: GameplayValue, environment: VEnv, path: string): GameplayValueType {
  const actual = valueType(value, environment, path)
  const expected = deferChoiceFieldTypes[name]
  if (!assignable(actual, expected)) fail('pending field "' + name + '" expects ' + typeName(expected) + ', got ' + typeName(actual), path, 'GAMEPLAY_MODULE_PORT_TYPE')
  if (value.kind === 'literal') {
    if (name === 'targetType' && !['piece', 'cell', 'grid'].includes(value.value as string)) fail('targetType must be piece, cell, or grid', path, 'GAMEPLAY_MODULE_INVALID_VALUE')
    if (name === 'range' && (typeof value.value !== 'number' || !Number.isFinite(value.value) || value.value < 0)) fail('range must be a finite non-negative number', path, 'GAMEPLAY_MODULE_INVALID_VALUE')
    if (name === 'filter' && !['enemy', 'ally', 'all'].includes(value.value as string)) fail('filter must be enemy, ally, or all', path, 'GAMEPLAY_MODULE_INVALID_VALUE')
    if (name === 'selectionMode' && !['single', 'multi'].includes(value.value as string)) fail('selectionMode must be single or multi', path, 'GAMEPLAY_MODULE_INVALID_VALUE')
    if ((name === 'min' || name === 'max' || name === 'minSelections' || name === 'maxSelections') && (!Number.isSafeInteger(value.value) || (value.value as number) < 0)) fail('selection bounds must be non-negative integers', path, 'GAMEPLAY_MODULE_INVALID_VALUE')
  }
  return actual
}
function collectionEffectError(resolved: Resolved, path: string): void {
  if (resolved.kind !== 'native') return
  const effects = resolved.descriptor.effects
  if (effects.pure === false || effects.random === true || effects.pending === true || (effects.writes?.length ?? 0) > 0 || (effects.events?.length ?? 0) > 0) {
    fail('collection body cannot call effectful module "' + resolved.descriptor.id + '"', path, 'GAMEPLAY_MODULE_COLLECTION_EFFECT')
  }
}

function validateBody(list: readonly GameplayStatement[], resolver: Resolver, environment: VEnv, outputs: readonly Port[], path: string, active: readonly string[], depth: number, dataOnly = false): void {
  const bindings = new Map(environment.bindings)
  for (let index = 0; index < list.length; index += 1) {
    resolver.statementCount += 1
    if (resolver.statementCount > resolver.limits.maxExpandedStatements) fail('statement budget exceeded', path, 'GAMEPLAY_MODULE_BUDGET_EXCEEDED')
    const node = list[index]
    const nodePath = path + '[' + index + ']'
    if (node.kind === 'call') {
      const resolved = resolve(resolver, node.module, node.version, nodePath + '.module')
      if (dataOnly) collectionEffectError(resolved, nodePath + '.module')
      if (resolved.kind === 'native') {
        if (!resolved.descriptor.allowedSurfaces.includes(resolver.graph.surface)) fail('module is not allowed on ' + resolver.graph.surface, nodePath + '.module', 'GAMEPLAY_MODULE_SURFACE_FORBIDDEN')
        if (resolver.graph.surface === 'preview' && !previewSafe(resolved.descriptor.effects)) fail('module has effects forbidden in preview', nodePath + '.module', 'GAMEPLAY_MODULE_PREVIEW_EFFECT')
        validatePortSchemas(resolved.descriptor.inputs, resolver.schemas, nodePath + '.module.inputs')
        validatePortSchemas(resolved.descriptor.outputs, resolver.schemas, nodePath + '.module.outputs')
      } else {
        const key = moduleKey(resolved.definition.id, resolved.definition.version)
        if (resolved.definition.allowedSurfaces && !resolved.definition.allowedSurfaces.includes(resolver.graph.surface)) fail('composite is not allowed on ' + resolver.graph.surface, nodePath + '.module', 'GAMEPLAY_MODULE_SURFACE_FORBIDDEN')
        if (active.includes(key)) fail('composite cycle detected', nodePath + '.module', 'GAMEPLAY_MODULE_COMPOSITE_CYCLE')
        if (depth >= resolver.limits.maxCompositeDepth) fail('composite expansion depth exceeded', nodePath + '.module', 'GAMEPLAY_MODULE_BUDGET_EXCEEDED')
        if (resolved.definition.outputs.some(output => !output.optional) && !bodyGuaranteesReturn(resolved.definition.body)) fail('composite can fall through without returning its required outputs', nodePath + '.module', 'GAMEPLAY_MODULE_MISSING_OUTPUT')
        validatePortSchemas(resolved.definition.inputs, resolver.schemas, nodePath + '.module.inputs')
        validatePortSchemas(resolved.definition.outputs, resolver.schemas, nodePath + '.module.outputs')
      }
      const inputPorts = resolved.kind === 'native' ? resolved.descriptor.inputs : resolved.definition.inputs
      const parameterPorts = resolved.kind === 'native' ? resolved.descriptor.parameters ?? [] : resolved.definition.parameters ?? []
      const params = parameterValues(node.parameters ?? {}, parameterPorts, nodePath + '.parameters')
      const inputTypes = new Map<string, GameplayValueType>()
      for (const input of inputPorts) {
        const binding = resolved.kind === 'native' ? resolved.descriptor.inputValueTypeBindings?.[input.name] : undefined
        const bound = binding ? parameterValueType(params[binding.parameter], resolver, nodePath + '.parameters.' + binding.parameter) : effective(input)
        inputTypes.set(input.name, binding?.nullable && !(typeof bound === 'object' && bound.kind === 'nullable') ? { kind: 'nullable', value: bound } : bound)
      }
      const declared = mapPorts(inputPorts)
      for (const key of Object.keys(node.inputs ?? {})) {
        const expected = declared.get(key)
        if (!expected) fail('unknown input port "' + key + '"', nodePath + '.inputs.' + key, 'GAMEPLAY_MODULE_UNKNOWN_PORT')
        const actual = valueType((node.inputs ?? {})[key], { inputs: environment.inputs, bindings }, nodePath + '.inputs.' + key)
        // A nullable reference may feed a required native port. Its generated
        // input guard skips the statement if that reference is absent; authors
        // do not need an existence test and a second "require" adapter.
        const expectedType = inputTypes.get(key)!
        const guardedNullable = resolved.kind === 'native' && typeof actual === 'object' && actual.kind === 'nullable' && assignable(actual.value, expectedType)
        if (!assignable(actual, expectedType) && !guardedNullable) fail('input "' + key + '" expects ' + typeName(expectedType) + ', got ' + typeName(actual), nodePath + '.inputs.' + key, 'GAMEPLAY_MODULE_PORT_TYPE')
      }
      for (const expected of inputPorts) if (!own(node.inputs as Rec, expected.name) && !expected.optional) fail('missing input port "' + expected.name + '"', nodePath + '.inputs', 'GAMEPLAY_MODULE_MISSING_PORT')
      if (resolved.kind === 'native') for (const [name, binding] of Object.entries(resolved.descriptor.inputSchemaBindings ?? {})) {
        resolveRecordSchema(resolver, String(params[binding.parameter]), nodePath + '.parameters.' + binding.parameter)
        const value = node.inputs?.[name]
        if (value !== undefined) {
          const type: GameplayValueType = { kind: 'record', schema: String(params[binding.parameter]) }
          const expected: GameplayValueType = binding.list ? { kind: 'list', element: type } : type
          if (!assignable(valueType(value, { inputs: environment.inputs, bindings }, nodePath + '.inputs.' + name), expected)) fail('input must use declared record schema', nodePath + '.inputs.' + name, 'GAMEPLAY_MODULE_PORT_TYPE')
        }
      }
      const outputPorts = resolved.kind === 'native' ? resolved.descriptor.outputs : resolved.definition.outputs
      const outputTypes = new Map<string, GameplayValueType>()
      for (const output of outputPorts) {
        const binding = resolved.kind === 'native' ? resolved.descriptor.outputTypeBindings?.[output.name] : undefined
        let type = effective(output)
        const valueBinding = resolved.kind === 'native' ? resolved.descriptor.outputValueTypeBindings?.[output.name] : undefined
        if (valueBinding) type = parameterValueType(params[valueBinding.parameter], resolver, nodePath + '.parameters.' + valueBinding.parameter)
        const fieldBinding = resolved.kind === 'native' ? resolved.descriptor.outputParameterTypeBindings?.[output.name] : undefined
        if (fieldBinding) {
          const selected = params[fieldBinding.parameter]
          if (typeof selected !== 'string') fail('field type binding parameter must select a string field', nodePath + '.parameters.' + fieldBinding.parameter, 'GAMEPLAY_MODULE_INVALID_TYPE_BINDING')
          const selectedType = fieldBinding.types[selected]
          if (!selectedType) fail('unknown field "' + selected + '"', nodePath + '.parameters.' + fieldBinding.parameter, 'GAMEPLAY_MODULE_UNKNOWN_FIELD')
          type = selectedType
          if (output.type !== 'any' && output.type !== 'unknown' && !assignable(type, effective(output))) fail('field type does not match its output declaration', nodePath + '.module.outputs.' + output.name, 'GAMEPLAY_MODULE_INVALID_TYPE_BINDING')
        }
        const schemaBinding = resolved.kind === 'native' ? resolved.descriptor.outputSchemaBindings?.[output.name] : undefined
        if (schemaBinding) {
          resolveRecordSchema(resolver, String(params[schemaBinding.parameter]), nodePath + '.parameters.' + schemaBinding.parameter)
          const record: GameplayValueType = { kind: 'record', schema: String(params[schemaBinding.parameter]) }
          type = schemaBinding.list ? { kind: 'list', element: record } : record
        }
        if (binding) {
          const supplied = node.inputs?.[binding.input]
          if (!supplied) fail('type binding requires an input', nodePath + '.inputs', 'GAMEPLAY_MODULE_MISSING_PORT')
          const inputType = valueType(supplied, { inputs: environment.inputs, bindings }, nodePath + '.inputs.' + binding.input)
          if (binding.projection === 'element') {
            if (typeof inputType !== 'object' || inputType.kind !== 'list') fail('element type binding requires a collection', nodePath + '.inputs.' + binding.input, 'GAMEPLAY_MODULE_PORT_TYPE')
            type = inputType.element
          } else type = binding.projection === 'singleton' ? { kind: 'list', element: inputTypes.get(binding.input)! } : inputType
          if (output.nullable && !(typeof type === 'object' && type.kind === 'nullable')) type = { kind: 'nullable', value: type }
          if (!assignable(type, effective(output))) fail('inferred output type does not match its declaration', nodePath + '.module', 'GAMEPLAY_MODULE_REGISTRY_INVALID')
        }
        outputTypes.set(output.name, type)
      }
      const metadata: CallMeta = { module: resolved, inputs: node.inputs ?? {}, parameters: params, inputTypes, outputTypes }
      resolver.calls.set(node, metadata)
      resolver.dependencies.set(moduleKey(node.module, node.version), { id: node.module, version: node.version, kind: resolved.kind })
      resolver.expanded.push({ id: node.module, version: node.version, kind: resolved.kind, callId: node.id, depth })
      if (resolved.kind === 'composite') {
        const compositeInputs = new Map<string, GameplayValueType>()
        const declaredInputs = mapPorts(resolved.definition.inputs)
        for (const input of resolved.definition.inputs) {
          const supplied = node.inputs?.[input.name]
          if (supplied === undefined) { if (!input.optional) fail('missing composite input "' + input.name + '"', nodePath + '.inputs', 'GAMEPLAY_MODULE_MISSING_PORT'); compositeInputs.set(input.name, effective(input)) }
          else {
            const actual = valueType(supplied, { inputs: environment.inputs, bindings }, nodePath + '.inputs.' + input.name)
            if (!assignable(actual, effective(input))) fail('composite input type mismatch', nodePath + '.inputs.' + input.name, 'GAMEPLAY_MODULE_PORT_TYPE')
            compositeInputs.set(input.name, effective(input))
          }
        }
        for (const key of Object.keys(node.inputs ?? {})) if (!declaredInputs.has(key)) fail('unknown composite input "' + key + '"', nodePath + '.inputs.' + key, 'GAMEPLAY_MODULE_UNKNOWN_PORT')
        validateBody(resolved.definition.body, resolver, { inputs: compositeInputs, bindings: new Map() }, resolved.definition.outputs, nodePath + '.composite', active.concat(moduleKey(resolved.definition.id, resolved.definition.version)), depth + 1, dataOnly)
      }
      bindings.set(node.id, outputTypes)
    } else if (node.kind === 'record.create') {
      const schemaValue = resolveRecordSchema(resolver, node.schema, nodePath + '.schema')
      const declared = mapPorts(schemaValue.fields)
      const fields = node.fields ?? {}
      for (const key of Object.keys(fields)) {
        const field = declared.get(key)
        if (!field) fail('unknown record field "' + key + '"', nodePath + '.fields.' + key, 'GAMEPLAY_MODULE_UNKNOWN_FIELD')
        const actual = valueType(fields[key], { inputs: environment.inputs, bindings }, nodePath + '.fields.' + key)
        if (!assignable(actual, effective(field))) fail('record field "' + key + '" expects ' + typeName(effective(field)) + ', got ' + typeName(actual), nodePath + '.fields.' + key, 'GAMEPLAY_MODULE_PORT_TYPE')
      }
      for (const field of schemaValue.fields) if (!field.optional && !own(fields as Rec, field.name)) fail('missing record field "' + field.name + '"', nodePath + '.fields', 'GAMEPLAY_MODULE_MISSING_FIELD')
      bindings.set(node.id, new Map([['value', recordType(node.schema)]]))
    } else if (node.kind === 'record.get') {
      const actual = valueType(node.record, { inputs: environment.inputs, bindings }, nodePath + '.record')
      if (typeof actual !== 'object' || actual.kind !== 'record') fail('record.get requires a typed record', nodePath + '.record', 'GAMEPLAY_MODULE_UNTYPED_RECORD')
      const schemaValue = resolveRecordSchema(resolver, actual.schema, nodePath + '.record.schema')
      const field = schemaValue.fields.find(entry => entry.name === node.field)
      if (!field) fail('unknown record field "' + node.field + '"', nodePath + '.field', 'GAMEPLAY_MODULE_UNKNOWN_FIELD')
      bindings.set(node.id, new Map([['value', effective(field)]]))
    } else if (node.kind === 'record.with') {
      const actual = valueType(node.record, { inputs: environment.inputs, bindings }, nodePath + '.record')
      if (typeof actual !== 'object' || actual.kind !== 'record') fail('record.with requires a typed record', nodePath + '.record', 'GAMEPLAY_MODULE_UNTYPED_RECORD')
      const schemaValue = resolveRecordSchema(resolver, actual.schema, nodePath + '.record.schema')
      const declared = mapPorts(schemaValue.fields)
      for (const key of Object.keys(node.fields ?? {})) {
        const field = declared.get(key)
        if (!field) fail('unknown record field "' + key + '"', nodePath + '.fields.' + key, 'GAMEPLAY_MODULE_UNKNOWN_FIELD')
        const type = valueType(node.fields![key], { inputs: environment.inputs, bindings }, nodePath + '.fields.' + key)
        if (!assignable(type, effective(field))) fail('record field "' + key + '" expects ' + typeName(effective(field)) + ', got ' + typeName(type), nodePath + '.fields.' + key, 'GAMEPLAY_MODULE_PORT_TYPE')
      }
      bindings.set(node.id, new Map([['value', actual]]))
    } else if (node.kind === 'collection') {
      const collection = valueType(node.items, { inputs: environment.inputs, bindings }, nodePath + '.items')
      if (typeof collection === 'object' && collection.kind === 'list' && node.items.kind === 'literal' && Array.isArray(node.items.value) && node.items.value.length > resolver.limits.maxCollectionIterations) fail('collection iteration budget exceeded', nodePath + '.items', 'GAMEPLAY_MODULE_BUDGET_EXCEEDED')
      const output = collectionOutputType(node, resolver, { inputs: environment.inputs, bindings }, nodePath)
      bindings.set(node.id, new Map([['value', output]]))
    } else if (node.kind === 'defer-choice') {
      if (dataOnly) fail('collection body cannot suspend into a pending choice', nodePath, 'GAMEPLAY_MODULE_COLLECTION_EFFECT')
      if (resolver.graph.surface === 'preview') fail('defer-choice is not allowed on preview graphs', nodePath, 'GAMEPLAY_MODULE_PREVIEW_EFFECT')
      const continuation = continuationFor(resolver, node.graph, nodePath + '.graph')
      const payload = valueType(node.payload, { inputs: environment.inputs, bindings }, nodePath + '.payload')
      const expected = continuation.payloadType ?? continuation.graph.hostBindings.payload
      if (!expected || typeof expected !== 'object' || expected.kind !== 'record') fail('continuation payload must be a typed record', nodePath + '.payload', 'GAMEPLAY_MODULE_WRONG_PAYLOAD_TYPE')
      if (!assignable(payload, expected)) fail('continuation payload type mismatch', nodePath + '.payload', 'GAMEPLAY_MODULE_WRONG_PAYLOAD_TYPE')
      for (const name of Object.keys(deferChoiceFieldTypes)) {
        const value = (node as unknown as Record<string, GameplayValue | undefined>)[name]
        if (value !== undefined) validateDeferChoiceField(name, value, { inputs: environment.inputs, bindings }, nodePath + '.' + name)
      }
      const min = node.min ?? node.minSelections
      const max = node.max ?? node.maxSelections
      const minValue = min?.kind === 'literal' && typeof min.value === 'number' ? min.value : min === undefined ? 1 : undefined
      const maxValue = max?.kind === 'literal' && typeof max.value === 'number' ? max.value : max === undefined ? 1 : undefined
      if (minValue !== undefined && maxValue !== undefined && minValue > maxValue) fail('pending minimum cannot exceed maximum', nodePath, 'GAMEPLAY_MODULE_INVALID_VALUE')
    } else if (node.kind === 'if') {
      const condition = valueType(node.condition, { inputs: environment.inputs, bindings }, nodePath + '.condition')
      if (!assignable(condition, 'boolean')) fail('if condition must be boolean', nodePath + '.condition', 'GAMEPLAY_MODULE_PORT_TYPE')
      validateBody(node.then, resolver, { inputs: environment.inputs, bindings: new Map(bindings) }, outputs, nodePath + '.then', active, depth, dataOnly)
      if (node.else) validateBody(node.else, resolver, { inputs: environment.inputs, bindings: new Map(bindings) }, outputs, nodePath + '.else', active, depth, dataOnly)
    } else if (node.kind === 'foreach') {
      if (node.presentation !== undefined) {
        if (dataOnly || resolver.graph.surface !== 'skill') fail('presentation groups currently require a skill surface', nodePath + '.presentation', 'GAMEPLAY_MODULE_COLLECTION_EFFECT')
        const escapes = (body: readonly GameplayStatement[]): boolean => body.some(item => (
          item.kind === 'return'
          || item.kind === 'defer-choice'
          || (item.kind === 'if' && (escapes(item.then) || escapes(item.else ?? [])))
          || (item.kind === 'foreach' && escapes(item.body))
          // A while condition returns into its local condition frame; only
          // the execution body can escape the enclosing presentation group.
          || (item.kind === 'while' && escapes(item.body))
        ))
        if (escapes(node.body)) fail('presentation group cannot return or suspend', nodePath + '.body', 'GAMEPLAY_MODULE_INVALID_VALUE')
      }
      const collection = valueType(node.items, { inputs: environment.inputs, bindings }, nodePath + '.items')
      if (typeof collection !== 'object' || collection.kind !== 'list') fail('foreach items must be a list', nodePath + '.items', 'GAMEPLAY_MODULE_PORT_TYPE')
      const bodyInputs = new Map(environment.inputs)
      if (node.item) { if (bodyInputs.has(node.item)) fail('foreach item shadows an input', nodePath + '.item', 'GAMEPLAY_MODULE_INVALID_NAME'); bodyInputs.set(node.item, collection.element) }
      if (node.index) { if (bodyInputs.has(node.index) || node.index === node.item) fail('foreach index shadows an input', nodePath + '.index', 'GAMEPLAY_MODULE_INVALID_NAME'); bodyInputs.set(node.index, 'number') }
      const loopOutputs = new Map<string, GameplayValueType>([['item', collection.element], ['index', 'number']])
      const loopBindings = new Map(bindings); loopBindings.set(node.id, loopOutputs)
      validateBody(node.body, resolver, { inputs: bodyInputs, bindings: loopBindings }, outputs, nodePath + '.body', active, depth, dataOnly)
    } else if (node.kind === 'while') {
      if (node.budget > resolver.limits.maxWhileIterations) fail('while iteration budget exceeded', nodePath + '.budget', 'GAMEPLAY_MODULE_BUDGET_EXCEEDED')
      validateWhileCondition(node, resolver, { inputs: environment.inputs, bindings }, nodePath, active, depth)
      const environments = whileEnvironments(node, { inputs: environment.inputs, bindings }, nodePath)
      validateBody(node.body, resolver, environments.body, outputs, nodePath + '.body', active, depth, dataOnly)
    } else if (node.kind === 'return') validateReturn(node, outputs, { inputs: environment.inputs, bindings }, nodePath)
  }
}

function nextVariable(state: Codegen, prefix: string): string { return '_' + prefix + state.next++ }
function rootStaticInput(graphValue: Graph, name: string): string | undefined {
  if (own(graphValue.inputBindings as Rec, name)) return '(' + literalSource(graphValue.inputBindings[name]) + ')'
  if (graphValue.surface === 'preview' && ['piece', 'skillDef', 'currentCooldown'].includes(name)) return '(context[' + JSON.stringify(name) + '])'
  if (graphValue.surface === 'pending' && own(graphValue.hostBindings as Rec, name)) {
    if (name === 'payload') return '(ctx["payload"])'
    if (name === 'selectedTargets') return '((ctx["pending"] && Array.isArray(ctx["pending"]["selectedTargets"])) ? ctx["pending"]["selectedTargets"] : [])'
    if (name === 'targetCell') return '((ctx["targetX"] !== undefined && ctx["targetY"] !== undefined) ? { x: ctx["targetX"], y: ctx["targetY"] } : null)'
    if (name === 'targetPiece') return '((ctx["targetPiece"] && ctx["targetPiece"]["instanceId"] !== undefined) ? ctx["targetPiece"]["instanceId"] : undefined)'
    if (name === 'sourcePiece') return '((ctx["pending"] && ctx["pending"]["triggerContext"] && ctx["pending"]["triggerContext"]["sourcePiece"] && ctx["pending"]["triggerContext"]["sourcePiece"]["instanceId"] !== undefined) ? ctx["pending"]["triggerContext"]["sourcePiece"]["instanceId"] : ((ctx["pending"] && ctx["pending"]["source"] && ctx["pending"]["source"]["pieceId"] !== undefined) ? ctx["pending"]["source"]["pieceId"] : undefined))'
    if (name === 'player') return '(ctx["playerId"])'
  }
  return undefined
}
function emit(value: GameplayValue, environment: CEnv): string {
  if (value.kind === 'literal') return literalSource(value.value)
  if (value.kind === 'input') {
    const expression = environment.inputs.get(value.name)
    if (!expression) fail('root input is not statically bound', value.name, 'GAMEPLAY_MODULE_ROOT_INPUT')
    return expression
  }
  const binding = environment.bindings.get(value.node)
  if (!binding) fail('output is not in scope during code generation', value.node + '.' + value.port, 'GAMEPLAY_MODULE_OUTPUT_SCOPE')
  if (!binding.ports.has(value.port)) fail('unknown output port', value.node + '.' + value.port, 'GAMEPLAY_MODULE_UNKNOWN_OUTPUT')
  const direct = binding.portExpressions?.get(value.port)
  if (direct) return direct
  const key = JSON.stringify(value.port)
  if (binding.ports.size === 1) return '((' + binding.expression + ' !== null && typeof ' + binding.expression + ' === "object" && Object.prototype.hasOwnProperty.call(' + binding.expression + ', ' + key + ')) ? ' + binding.expression + '[' + key + '] : ' + binding.expression + ')'
  return '(' + binding.expression + '[' + key + '])'
}
function compileValueType(value: GameplayValue, environment: CEnv, resolver: Resolver): GameplayValueType | undefined {
  if (value.kind === 'input') {
    const type = environment.inputTypes?.get(value.name)
    if (type !== undefined) return type
    const port = resolver.graph.inputs.find(entry => entry.name === value.name)
    return port === undefined ? undefined : effective(port)
  }
  return value.kind === 'output' ? environment.bindings.get(value.node)?.ports.get(value.port) : typeOfLiteral(value.value)
}
function listElement(value: GameplayValue, environment: CEnv, resolver: Resolver): GameplayValueType {
  if (value.kind === 'literal') { const type = typeOfLiteral(value.value); return typeof type === 'object' && type.kind === 'list' ? type.element : 'record' }
  if (value.kind === 'input') {
    const type = environment.inputTypes?.get(value.name) ?? (() => {
      const port = resolver.graph.inputs.find(entry => entry.name === value.name)
      return port === undefined ? undefined : effective(port)
    })()
    return type && typeof type === 'object' && type.kind === 'list' ? type.element : 'record'
  }
  const binding = environment.bindings.get(value.node); const type = binding?.ports.get(value.port); return type && typeof type === 'object' && type.kind === 'list' ? type.element : 'record'
}
function inputExpressions(node: GameplayCallStatement, metadata: CallMeta, environment: CEnv): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  for (const key of Object.keys(metadata.inputs)) result[key] = emit(metadata.inputs[key], environment)
  return result
}
function referenceKind(value: GameplayValueType): 'piece' | 'player' | undefined {
  if (value === 'piece' || value === 'player') return value
  return typeof value === 'object' && value.kind === 'nullable' ? referenceKind(value.value) : undefined
}
function nullableType(value: GameplayValueType): boolean { return typeof value === 'object' && value.kind === 'nullable' }
function runtimeFacade(surface: GameplayModuleSurface): string { return surface === 'pending' ? 'ctx.flow' : 'flow' }
function inputGuard(
  resolved: Resolved,
  metadata: CallMeta,
  environment: CEnv,
  surface: GameplayModuleSurface,
): string | undefined {
  const ports = resolved.kind === 'native' ? resolved.descriptor.inputs : resolved.definition.inputs
  const inspectedReferences = resolved.kind === 'native' ? new Set(resolved.descriptor.inspectReferences ?? []) : undefined
  const livingReferences = resolved.kind === 'native' ? new Set(resolved.descriptor.livingReferences ?? []) : undefined
  const declared = mapPorts(ports)
  const guards: string[] = []
  for (const key of Object.keys(metadata.inputs)) {
    const expected = declared.get(key)
    if (!expected) continue
    const expression = emit(metadata.inputs[key], environment)
    guards.push('(' + expression + ' === __gameplayInvalid)')
    const expectedType = metadata.inputTypes?.get(key) ?? effective(expected)
    const kind = referenceKind(expectedType)
    if (!expected.optional) guards.push('(' + expression + ' === undefined)')
    if (!nullableType(expectedType)) guards.push('(' + expression + ' === null)')
    if (livingReferences?.has(key)) {
      const facade = runtimeFacade(surface)
      const query = facade + '.query'
      guards.push('(' + expression + ' != null && (typeof ' + facade + ' === "undefined" || ' + facade + ' === null || !' + query + ' || typeof ' + query + '.hasPiece !== "function" || typeof ' + query + '.piece !== "function" || !' + query + '.hasPiece(' + expression + ') || !' + query + '.piece(' + expression + ') || !(' + query + '.piece(' + expression + ').currentHp > 0)))')
      continue
    }
    if (!kind || inspectedReferences?.has(key)) continue
    const facade = runtimeFacade(surface)
    const checker = facade + '.query.has' + (kind === 'piece' ? 'Piece' : 'Player')
    guards.push('(' + expression + ' != null && typeof ' + facade + ' !== "undefined" && ' + facade + ' !== null && ' + facade + '.query && typeof ' + checker + ' === "function" && !' + checker + '(' + expression + '))')
  }
  return guards.length === 0 ? undefined : guards.join(' || ')
}
function invalidResult(outputs: readonly GameplayPort[]): string {
  if (outputs.length <= 1) return '__gameplayInvalid'
  return '{ ' + outputs.map(output => JSON.stringify(output.name) + ': __gameplayInvalid').join(', ') + ' }'
}
const diagnosticHostKey = '__gameplayModuleDiagnosticHost'
function isFaultIsolatingEmitter(state: Codegen): boolean { return state.compilerVersion !== GAMEPLAY_MODULE_COMPILER_V1_VERSION }
function statementBoundary(state: Codegen, node: GameplayStatement, code: string, recovery = '', moduleId?: string): string {
  if (!isFaultIsolatingEmitter(state)) return code
  return 'try { ' + code + ' } catch (__gameplayError) { if (__gameplayIsBudgetControl(__gameplayError)) throw __gameplayError; __gameplayRecordFault(' + JSON.stringify(node.id) + ', __gameplayError' + (moduleId ? ', ' + JSON.stringify(moduleId) : '') + ');' + (recovery ? ' ' + recovery : '') + ' }'
}
function loopBoundary(state: Codegen, node: GameplayStatement, code: string, recovery = ''): string {
  if (!isFaultIsolatingEmitter(state)) return code
  const root = nextVariable(state, 'loopRoot')
  return 'var ' + root + ' = (__gameplayLoopDepth === 0); __gameplayLoopDepth += 1; try { ' + code + ' } catch (__gameplayError) { if (__gameplayIsBudgetControl(__gameplayError)) { if (!' + root + ') throw __gameplayError; __gameplayBudget.remaining = 0; __gameplayRecordFault(' + JSON.stringify(node.id) + ', new Error("gameplay shared iteration budget exceeded"));' + (recovery ? ' ' + recovery : '') + ' } else { __gameplayRecordFault(' + JSON.stringify(node.id) + ', __gameplayError);' + (recovery ? ' ' + recovery : '') + ' } } finally { __gameplayLoopDepth -= 1; }'
}
function lower(descriptorValue: GameplayModuleDescriptor, node: GameplayCallStatement, metadata: CallMeta, inputs: Readonly<Record<string, string>>, state: Codegen): { code: string; result: string } {
  const result = nextVariable(state, 'module')
  let lowered: GameplayNativeLoweringResult
  try {
    lowered = descriptorValue.lower({ surface: state.resolver.graph.surface, callId: node.id, moduleId: descriptorValue.id, moduleVersion: descriptorValue.version, inputs, parameters: metadata.parameters, outputPorts: descriptorValue.outputs, recordSchemas: [...state.resolver.schemas.values()], emitLiteral: literalSource })
  } catch (error) { fail('native lowering failed: ' + (error instanceof Error ? error.message : 'unknown failure'), 'graph.' + node.id, 'GAMEPLAY_MODULE_LOWERING_FAILED') }
  if (typeof lowered === 'string') { if (!lowered.trim()) fail('native lowering returned empty source', 'graph.' + node.id, 'GAMEPLAY_MODULE_LOWERING_FAILED'); return { code: 'var ' + result + ' = (' + lowered + ');', result } }
  if (isObject(lowered) && 'expression' in lowered && typeof lowered.expression === 'string') { if (!lowered.expression.trim()) fail('native lowering returned empty expression', 'graph.' + node.id, 'GAMEPLAY_MODULE_LOWERING_FAILED'); for (const dependency of (lowered.dependencies as readonly string[] | undefined) ?? []) state.loweringDependencies.add(nonempty(dependency, 'graph.' + node.id + '.dependencies')); return { code: 'var ' + result + ' = (' + lowered.expression + ');', result } }
  if (isObject(lowered) && 'statements' in lowered && typeof lowered.statements === 'string') { if (!lowered.statements.trim()) fail('native lowering returned empty statements', 'graph.' + node.id, 'GAMEPLAY_MODULE_LOWERING_FAILED'); for (const dependency of (lowered.dependencies as readonly string[] | undefined) ?? []) state.loweringDependencies.add(nonempty(dependency, 'graph.' + node.id + '.dependencies')); const assignment = lowered.result === undefined ? '' : '\n' + result + ' = (' + lowered.result + ');'; return { code: 'var ' + result + '; ' + lowered.statements + assignment, result } }
  fail('native lowering returned an invalid result', 'graph.' + node.id, 'GAMEPLAY_MODULE_LOWERING_FAILED')
}
function returnCode(node: GameplayReturnStatement, outputs: readonly Port[], environment: CEnv, target: ReturnTarget | undefined): string {
  const invalidChecks: string[] = []
  const rendered = (value: GameplayValue): string => {
    const expression = emit(value, environment)
    invalidChecks.push('(' + expression + ' === __gameplayInvalid)')
    return expression
  }
  let action: string
  if (target) {
    const entries: string[] = []
    if (node.values) for (const output of outputs) {
      if (own(node.values as Rec, output.name)) entries.push(JSON.stringify(output.name) + ': ' + rendered(node.values[output.name]))
      else if (output.optional) entries.push(JSON.stringify(output.name) + ': __gameplayInvalid')
    }
    if (node.value !== undefined && outputs.length === 1) entries.push(JSON.stringify(outputs[0].name) + ': ' + rendered(node.value))
    if (node.value === undefined && node.values === undefined) for (const output of outputs) if (output.optional) entries.push(JSON.stringify(output.name) + ': __gameplayInvalid')
    action = target.result + ' = { ' + entries.join(', ') + ' }; break ' + target.label + ';'
  } else if (node.values) {
    action = 'return { ' + Object.keys(node.values).map(key => JSON.stringify(key) + ': ' + rendered(node.values![key])).join(', ') + ' };'
  } else {
    action = node.value === undefined ? 'return;' : 'return ' + rendered(node.value) + ';'
  }
  const guard = invalidChecks.length === 0 ? undefined : invalidChecks.join(' || ')
  return guard === undefined ? action : 'if (!(' + guard + ')) { ' + action + ' }'
}

function emitRecordCreate(node: GameplayRecordCreateStatement, environment: CEnv, resolver: Resolver, state: Codegen): string {
  const schemaValue = resolveRecordSchema(resolver, node.schema, 'graph.' + node.id + '.schema')
  const fields = node.fields ?? {}
  const entries: string[] = []
  const suppliedFields = schemaValue.fields.filter(field => own(fields as Rec, field.name))
  if (!isFaultIsolatingEmitter(state)) {
    for (const field of suppliedFields) entries.push(JSON.stringify(field.name) + ': ' + emit(fields[field.name], environment))
    return '({' + entries.join(', ') + '})'
  }

  // v2 keeps the invalid dependency sentinel distinct from an absent optional
  // value.  Native outputs may use `undefined` to mean that an optional field
  // is not present; materializing that as an own property makes JSON-backed
  // status records invalid.  Evaluate each input once, reject any sentinel,
  // then assign optional fields only when their value is defined.
  const parameters = suppliedFields.map((_field, index) => '__gameplayRecordValue' + String(index))
  const values = suppliedFields.map(field => emit(fields[field.name], environment))
  const invalidGuard = parameters.length === 0
    ? undefined
    : parameters.map(parameter => '(' + parameter + ' === __gameplayInvalid)').join(' || ')
  const assignments = suppliedFields.map((field, index) => {
    const parameter = parameters[index]
    const assignment = '__gameplayRecord[' + JSON.stringify(field.name) + '] = ' + parameter + ';'
    return field.optional
      ? 'if (' + parameter + ' !== undefined) { ' + assignment + ' }'
      : assignment
  })
  return '((function(' + parameters.join(', ') + '){ '
    + (invalidGuard ? 'if (' + invalidGuard + ') return __gameplayInvalid; ' : '')
    + 'var __gameplayRecord = {}; '
    + assignments.join(' ')
    + ' return __gameplayRecord; })(' + values.join(', ') + '))'
}
function emitRecordGet(node: GameplayRecordGetStatement, environment: CEnv): string {
  const recordValue = emit(node.record, environment)
  return '((' + recordValue + ' === __gameplayInvalid || ' + recordValue + ' == null) ? __gameplayInvalid : (' + recordValue + ')[' + JSON.stringify(node.field) + '])'
}
function emitRecordWith(node: GameplayRecordWithStatement, environment: CEnv, resolver: Resolver, state: Codegen): string {
  const actual = compileValueType(node.record, environment, resolver)
  const schemaValue = typeof actual === 'object' && actual.kind === 'record' ? resolveRecordSchema(resolver, actual.schema, 'record.with') : undefined
  const recordValue = emit(node.record, environment)
  if (!schemaValue) return '__gameplayInvalid'
  const fields = node.fields ?? {}
  if (!isFaultIsolatingEmitter(state)) {
    const entries: string[] = []
    for (const field of schemaValue.fields) entries.push(JSON.stringify(field.name) + ': ' + (own(fields as Rec, field.name) ? emit(fields[field.name], environment) : '(' + recordValue + ')[' + JSON.stringify(field.name) + ']'))
    return '((function(__gameplayRecord){ return (__gameplayRecord === __gameplayInvalid || __gameplayRecord == null) ? __gameplayInvalid : ({' + entries.join(', ') + '}); })(' + recordValue + '))'
  }

  // A v2 record update has the same JSON-shape rules as record.create:
  // missing optional fields stay absent, while invalid dependencies must not
  // become ordinary undefined values. Evaluate overrides once and copy the
  // remaining fields from the input record inside the guarded function.
  const suppliedFields = schemaValue.fields.filter(field => own(fields as Rec, field.name))
  const parameters = suppliedFields.map((_field, index) => '__gameplayRecordWithValue' + String(index))
  const values = suppliedFields.map(field => emit(fields[field.name], environment))
  const fieldValues = schemaValue.fields.map((field, index) => {
    const suppliedIndex = suppliedFields.indexOf(field)
    const value = suppliedIndex >= 0
      ? parameters[suppliedIndex]
      : '__gameplayRecordInput[' + JSON.stringify(field.name) + ']'
    return 'var __gameplayRecordField' + String(index) + ' = ' + value + ';'
  })
  const invalidGuard = schemaValue.fields
    .map((_field, index) => '(__gameplayRecordField' + String(index) + ' === __gameplayInvalid)')
    .join(' || ')
  const assignments = schemaValue.fields.map((field, index) => {
    const value = '__gameplayRecordField' + String(index)
    const assignment = '__gameplayRecord[' + JSON.stringify(field.name) + '] = ' + value + ';'
    return field.optional ? 'if (' + value + ' !== undefined) { ' + assignment + ' }' : assignment
  })
  return '((function(__gameplayRecordInput' + (parameters.length ? ', ' + parameters.join(', ') : '') + '){ '
    + 'if (__gameplayRecordInput === __gameplayInvalid || __gameplayRecordInput == null) return __gameplayInvalid; '
    + fieldValues.join(' ')
    + (invalidGuard ? ' if (' + invalidGuard + ') return __gameplayInvalid; ' : '')
    + 'var __gameplayRecord = {}; ' + assignments.join(' ')
    + ' return __gameplayRecord; })(' + recordValue + (values.length ? ', ' + values.join(', ') : '') + '))'
}
function emitCollection(node: GameplayCollectionStatement, environment: CEnv, state: Codegen, outputs: readonly Port[], active: readonly string[], depth: number): { code: string; result: string } {
  const result = nextVariable(state, 'collection')
  const items = nextVariable(state, 'items')
  const index = nextVariable(state, 'index')
  const item = nextVariable(state, 'item')
  const accumulator = node.method === 'reduce' ? nextVariable(state, 'accumulator') : undefined
  const start = node.method === 'reduce' ? nextVariable(state, 'start') : undefined
  const stepResult = nextVariable(state, 'collectionResult')
  const label = nextVariable(state, 'collectionDone')
  const names = collectionNames(node, node.method, 'graph.' + node.id)
  const strictDependencies = state.compilerVersion === GAMEPLAY_MODULE_COMPILER_V3_VERSION
  const dependencies: string[] = []
  const declarations: string[] = []
  const captured = (value: GameplayValue): string => {
    if (!strictDependencies) return emit(value, environment)
    const variable = nextVariable(state, 'capture')
    declarations.push('var ' + variable + ' = ' + emit(value, environment) + ';')
    dependencies.push(variable + ' !== __gameplayInvalid && ' + variable + ' !== undefined')
    return variable
  }
  const initial = node.initial === undefined ? undefined : captured(node.initial)
  const itemInputs = new Map<string, string>()
  const itemInputTypes = new Map<string, GameplayValueType>()
  for (const [key, value] of Object.entries(node.inputs ?? {})) itemInputs.set(key, captured(value))
  for (const [key, value] of Object.entries(node.inputs ?? {})) {
    const type = compileValueType(value, environment, state.resolver)
    if (type) itemInputTypes.set(key, type)
  }
  itemInputs.set(names.item, item)
  itemInputs.set(names.index, index)
  const itemsType = compileValueType(node.items, environment, state.resolver)
  if (itemsType && typeof itemsType === 'object' && itemsType.kind === 'list') itemInputTypes.set(names.item, itemsType.element)
  itemInputTypes.set(names.index, 'number')
  if (names.accumulator && accumulator) itemInputs.set(names.accumulator, accumulator)
  if (names.accumulator && accumulator) itemInputTypes.set(names.accumulator, node.initial === undefined ? (itemsType && typeof itemsType === 'object' && itemsType.kind === 'list' ? itemsType.element : 'any') : (compileValueType(node.initial!, environment, state.resolver) ?? 'any'))
  const body = emitStatements(node.body, { inputs: itemInputs, inputTypes: itemInputTypes, bindings: new Map() }, state, [{ name: 'value', type: 'any' }], { result: stepResult, label, outputs: [{ name: 'value', type: 'any' }] }, active, depth)
  const output = nextVariable(state, 'collectionValues')
  const startCode = node.method === 'reduce'
    ? (initial === undefined
      ? 'var ' + accumulator + ' = ' + items + '.length === 0 ? __gameplayInvalid : ' + items + '[0]; var ' + start + ' = ' + items + '.length === 0 ? 0 : 1;'
      : 'var ' + accumulator + ' = ' + initial + '; var ' + start + ' = 0;')
    : ''
  const perIteration = node.method === 'find'
    ? 'if (' + stepResult + ' !== __gameplayInvalid && ' + stepResult + ' != null && ' + stepResult + '["value"]) { ' + result + ' = ' + item + '; break; }'
    : node.method === 'map'
    ? 'if (' + stepResult + ' !== __gameplayInvalid && ' + stepResult + ' != null) { ' + output + '.push(' + stepResult + '["value"]); }'
    : node.method === 'filter'
      ? 'if (' + stepResult + ' !== __gameplayInvalid && ' + stepResult + ' != null && ' + stepResult + '["value"]) { ' + output + '.push(' + item + '); }'
      : 'if (' + stepResult + ' !== __gameplayInvalid && ' + stepResult + ' != null) { ' + accumulator + ' = ' + stepResult + '["value"]; }'
  const finalResult = node.method === 'reduce' ? accumulator! : output
  const outputInitialization = node.method === 'find' ? '' : 'var ' + output + ' = [];'
  const findInitialization = node.method === 'find' ? 'var ' + result + ' = null;' : ''
  const resultAssignment = node.method === 'find' ? '' : 'var ' + result + ' = ' + finalResult + ';'
  const iterationGuard = isFaultIsolatingEmitter(state) ? '__gameplayConsumeIteration(); ' : ''
  const code = [
    'var ' + result + ' = __gameplayInvalid; var ' + items + ' = ' + emit(node.items, environment) + ';',
    ...(strictDependencies ? declarations : []),
    'if (Array.isArray(' + items + ')' + (dependencies.length ? ' && ' + dependencies.join(' && ') : '') + ') {',
    'if (' + items + '.length > ' + String(state.resolver.limits.maxCollectionIterations) + ') { throw new Error("gameplay collection iteration budget exceeded"); }',
    ...(outputInitialization ? [outputInitialization] : []),
    ...(findInitialization ? [findInitialization] : []),
    startCode,
    'for (var ' + index + ' = ' + (start ?? '0') + '; ' + index + ' < ' + items + '.length; ' + index + ' += 1) {',
    iterationGuard + 'var ' + item + ' = ' + items + '[' + index + ']; var ' + stepResult + ' = __gameplayInvalid;',
    label + ': { ' + body + ' }',
    perIteration,
    '}',
    resultAssignment,
    '}',
  ].join(' ')
  return { code, result }
}

function emitWhileCondition(node: Extract<GameplayStatement, { kind: 'while' }>, environment: CEnv, state: Codegen, active: readonly string[], depth: number): { code: string; result: string } {
  const result = nextVariable(state, 'whileCondition')
  const label = nextVariable(state, 'whileConditionDone')
  const inputExpressions = new Map<string, string>()
  const inputTypes = new Map<string, GameplayValueType>()
  const strictDependencies = state.compilerVersion === GAMEPLAY_MODULE_COMPILER_V3_VERSION
  const declarations: string[] = []
  const dependencies: string[] = []
  for (const [name, value] of Object.entries(node.condition.inputs ?? {})) {
    const expression = emit(value, environment)
    if (strictDependencies) {
      const captured = nextVariable(state, 'whileCapture')
      declarations.push('var ' + captured + ' = ' + expression + ';')
      dependencies.push(captured + ' !== __gameplayInvalid && ' + captured + ' !== undefined')
      inputExpressions.set(name, captured)
    } else inputExpressions.set(name, expression)
    inputTypes.set(name, compileValueType(value, environment, state.resolver) ?? 'any')
  }
  const outputs: readonly Port[] = [{ name: 'value', type: 'boolean' }]
  const body = emitStatements(node.condition.body, { inputs: inputExpressions, inputTypes, bindings: new Map() }, state, outputs, { result, label, outputs }, active, depth)
  const condition = label + ': { ' + body + ' }'
  return { code: 'var ' + result + ' = __gameplayInvalid; ' + (dependencies.length ? declarations.join(' ') + ' if (' + dependencies.join(' && ') + ') { ' + condition + ' }' : condition), result }
}

function continuationFor(resolver: Resolver, reference: string, path: string): StructuredContinuation {
  const matches = resolver.graph.continuations.filter(entry => entry.id === reference || entry.id + '@' + entry.version === reference)
  if (!matches.length) fail('unknown continuation graph "' + reference + '"', path, 'GAMEPLAY_MODULE_UNKNOWN_CONTINUATION')
  if (matches.length > 1 && !reference.includes('@')) fail('continuation graph id is ambiguous; use id@version', path, 'GAMEPLAY_MODULE_AMBIGUOUS_CONTINUATION')
  return matches[0]
}

function compileContinuation(continuation: StructuredContinuation, state: Codegen, path: string): string {
  const key = moduleKey(continuation.id, continuation.version)
  if (state.continuationStack.includes(key)) fail('continuation graph cycle detected', path, 'GAMEPLAY_MODULE_CONTINUATION_CYCLE')
  const child = continuation.graph
  const childResolver = makeResolver(child, state.resolver.registry, state.resolver.limits, state.resolver.schemas)
  childResolver.statementCount = state.resolver.statementCount
  validateGraphSchemas(child, state.resolver.schemas, path + '.graph')
  const inputTypes = new Map<string, GameplayValueType>(); for (const inputPort of child.inputs) inputTypes.set(inputPort.name, effective(inputPort))
  validateBody(child.body, childResolver, { inputs: inputTypes, bindings: new Map() }, child.outputs, path + '.graph.body', [], 0)
  if (child.outputs.some(output => !output.optional) && !bodyGuaranteesReturn(child.body)) fail('continuation graph can fall through without returning its required outputs', path + '.graph.body', 'GAMEPLAY_MODULE_MISSING_OUTPUT')
  childResolver.statementCount = Math.max(childResolver.statementCount, state.resolver.statementCount)
  state.resolver.statementCount = childResolver.statementCount
  if (childResolver.expanded.length + state.resolver.expanded.length > state.resolver.limits.maxExpandedCalls) fail('module call budget exceeded', path, 'GAMEPLAY_MODULE_BUDGET_EXCEEDED')
  for (const [dependency, value] of childResolver.dependencies) state.resolver.dependencies.set(dependency, value)
  for (const entry of childResolver.expanded) state.resolver.expanded.push({ ...entry, depth: entry.depth + 1 })
  const childState: Codegen = { next: state.next, resolver: childResolver, loweringDependencies: state.loweringDependencies, continuationStack: state.continuationStack.concat(key), compilerVersion: state.compilerVersion }
  const rootInputs = new Map<string, string>(); for (const inputPort of child.inputs) { const expression = rootStaticInput(child, inputPort.name); if (expression) rootInputs.set(inputPort.name, expression) }
  const body = emitStatements(child.body, { inputs: rootInputs, bindings: new Map() }, childState, child.outputs, undefined, [], 0)
  state.next = childState.next
  return wrapper('pending', body, state.compilerVersion, childResolver.limits.maxCollectionIterations)
}
function valueEnvironment(environment: CEnv, resolver: Resolver, bindings: ReadonlyMap<string, CBinding>): VEnv {
  const inputs = new Map(environment.inputTypes ?? [])
  if (!environment.inputTypes) for (const input of resolver.graph.inputs) inputs.set(input.name, effective(input))
  const typedBindings = new Map<string, ReadonlyMap<string, GameplayValueType>>()
  for (const [name, binding] of bindings) typedBindings.set(name, binding.ports)
  return { inputs, bindings: typedBindings }
}
function recordOutputType(node: GameplayRecordGetStatement, environment: CEnv, resolver: Resolver): GameplayValueType {
  const actual = compileValueType(node.record, environment, resolver)
  if (actual && typeof actual === 'object' && actual.kind === 'record') {
    const schemaValue = resolveRecordSchema(resolver, actual.schema, 'graph.' + node.id + '.record.schema')
    const field = schemaValue.fields.find(entry => entry.name === node.field)
    if (field) return effective(field)
  }
  return 'record'
}
function emitPendingChoice(node: GameplayDeferChoiceStatement, continuation: StructuredContinuation, payload: string, effectCode: string, environment: CEnv, target: ReturnTarget | undefined): string {
  if (target !== undefined) fail('defer-choice cannot be nested in a composite or collection body', 'graph.' + node.id, 'GAMEPLAY_MODULE_PENDING_NESTING')
  const field = (name: keyof GameplayDeferChoiceStatement): string | undefined => {
    const value = node[name]
    return value && typeof value === 'object' && 'kind' in value ? emit(value as GameplayValue, environment) : undefined
  }
  // Active wrappers already receive the authoritative actor in their host
  // context.  The fallback is compiler-owned and fixed; authors cannot name a
  // context path in the graph.
  const player = field('player') ?? environment.inputs.get('player') ?? '(typeof context !== "undefined" ? context["playerId"] : undefined)'
  const title = field('title') ?? literalSource('请选择目标')
  const targetType = field('targetType') ?? (continuation.graph.hostBindings.targetPiece !== undefined ? literalSource('piece') : literalSource('cell'))
  const range = field('range')
  const filter = field('filter')
  const candidates = field('candidates') ?? 'undefined'
  const selectionMode = field('selectionMode') ?? literalSource('single')
  const min = field('min') ?? field('minSelections') ?? '1'
  const max = field('max') ?? field('maxSelections') ?? '1'
  const canCancel = field('canCancel') ?? 'true'
  const resume = field('resumeOnCancel')
  const message = field('message')
  // The active skill host treats this as a successful root result carrying the
  // legacy pending descriptor.  It then stamps source/owner/revision fields
  // and owns validation when applyBattleAction resumes the generated effect.
  const pending = '{ success: true' + (message === undefined ? '' : ', message: ' + message) + ', pendingTargetSelection: { playerId: ' + player + ', title: ' + title + ', targetType: ' + targetType + (range === undefined ? '' : ', range: ' + range) + (filter === undefined ? '' : ', filter: ' + filter) + ', candidates: ' + candidates + ', selectionMode: ' + selectionMode + ', min: ' + min + ', max: ' + max + ', minSelections: ' + min + ', maxSelections: ' + max + ', canCancel: ' + canCancel + (resume === undefined ? '' : ', resumeOnCancel: ' + resume) + ', payload: ' + payload + ', effectCode: ' + literalSource(effectCode) + ' } }'
  const action = 'return ' + pending + ';'
  const checks = [payload, '(' + payload + ' !== null)', '(typeof ' + payload + ' === "object")', '(!Array.isArray(' + payload + '))']
  if (node.player || environment.inputs.has('player')) checks.push(player)
  for (const name of ['title', 'targetType', 'range', 'filter', 'candidates', 'selectionMode', 'min', 'max', 'minSelections', 'maxSelections', 'canCancel', 'resumeOnCancel', 'message'] as const) {
    const value = node[name]
    if (value !== undefined) {
      const expression = field(name)
      if (expression) checks.push(expression)
    }
  }
  return 'if (' + checks.map(expression => '(' + expression + ' !== __gameplayInvalid)').join(' && ') + ') { ' + action + ' }'
}
function emitStatements(list: readonly GameplayStatement[], environment: CEnv, state: Codegen, outputs: readonly Port[], target: ReturnTarget | undefined, active: readonly string[], depth: number): string {
  const bindings = new Map(environment.bindings)
  const chunks: string[] = []
  for (const node of list) {
    const currentEnvironment: CEnv = { inputs: environment.inputs, inputTypes: environment.inputTypes, bindings }
    if (node.kind === 'call') {
      const metadata = state.resolver.calls.get(node); if (!metadata) fail('missing call metadata', node.id, 'GAMEPLAY_MODULE_INTERNAL_ERROR')
      const inputs = inputExpressions(node, metadata, currentEnvironment)
      if (metadata.module.kind === 'native') {
        const lowered = lower(metadata.module.descriptor, node, metadata, inputs, state)
        const outputTypes = metadata.outputTypes
        const guard = inputGuard(metadata.module, metadata, currentEnvironment, state.resolver.graph.surface)
        const code = guard === undefined ? lowered.code : 'if (' + guard + ') { ' + lowered.result + ' = ' + invalidResult(metadata.module.descriptor.outputs) + '; } else { ' + lowered.code + ' }'
        bindings.set(node.id, { ports: outputTypes, expression: lowered.result }); chunks.push(statementBoundary(state, node, code, lowered.result + ' = ' + invalidResult(metadata.module.descriptor.outputs) + ';', metadata.module.descriptor.id))
      } else {
        const definition = metadata.module.definition; const key = moduleKey(definition.id, definition.version)
        if (active.includes(key)) fail('composite cycle detected', node.id, 'GAMEPLAY_MODULE_COMPOSITE_CYCLE')
        if (depth >= state.resolver.limits.maxCompositeDepth) fail('composite expansion depth exceeded', node.id, 'GAMEPLAY_MODULE_BUDGET_EXCEEDED')
        const result = nextVariable(state, 'composite'); const label = nextVariable(state, 'done')
        const compositeInputs = new Map<string, string>()
        const compositeInputTypes = new Map<string, GameplayValueType>()
        for (const input of definition.inputs) {
          compositeInputs.set(input.name, metadata.inputs[input.name] === undefined ? '__gameplayInvalid' : emit(metadata.inputs[input.name], currentEnvironment))
          compositeInputTypes.set(input.name, effective(input))
        }
        const body = emitStatements(definition.body, { inputs: compositeInputs, inputTypes: compositeInputTypes, bindings: new Map() }, state, definition.outputs, { result, label, outputs: definition.outputs }, active.concat(key), depth + 1)
        const outputTypes = new Map<string, GameplayValueType>(); for (const output of definition.outputs) outputTypes.set(output.name, effective(output))
        const guard = inputGuard(metadata.module, metadata, currentEnvironment, state.resolver.graph.surface)
        const bodyCode = 'var ' + result + ' = ' + invalidResult(definition.outputs) + '; ' + (guard === undefined ? label + ': { ' + body + ' }' : 'if (' + guard + ') { ' + result + ' = ' + invalidResult(definition.outputs) + '; } else { ' + label + ': { ' + body + ' } }')
        bindings.set(node.id, { ports: outputTypes, expression: result }); chunks.push(statementBoundary(state, node, bodyCode, result + ' = ' + invalidResult(definition.outputs) + ';', definition.id))
      }
    } else if (node.kind === 'record.create') {
      const expression = emitRecordCreate(node, currentEnvironment, state.resolver, state)
      const variable = nextVariable(state, 'record')
      chunks.push(statementBoundary(state, node, 'var ' + variable + ' = ' + expression + ';', variable + ' = __gameplayInvalid;'))
      bindings.set(node.id, { ports: new Map([['value', { kind: 'record', schema: node.schema }]]), expression: variable, portExpressions: new Map([['value', variable]]) })
    } else if (node.kind === 'record.get') {
      const expression = emitRecordGet(node, currentEnvironment)
      const variable = nextVariable(state, 'recordGet')
      chunks.push(statementBoundary(state, node, 'var ' + variable + ' = ' + expression + ';', variable + ' = __gameplayInvalid;'))
      bindings.set(node.id, { ports: new Map([['value', recordOutputType(node, currentEnvironment, state.resolver)]]), expression: variable, portExpressions: new Map([['value', variable]]) })
    } else if (node.kind === 'record.with') {
      const expression = emitRecordWith(node, currentEnvironment, state.resolver, state)
      const variable = nextVariable(state, 'recordWith')
      chunks.push(statementBoundary(state, node, 'var ' + variable + ' = ' + expression + ';', variable + ' = __gameplayInvalid;'))
      const actual = compileValueType(node.record, currentEnvironment, state.resolver)
      const outputType = actual && typeof actual === 'object' && actual.kind === 'record' ? actual : { kind: 'record' as const, schema: node.id }
      bindings.set(node.id, { ports: new Map([['value', outputType]]), expression: variable, portExpressions: new Map([['value', variable]]) })
    } else if (node.kind === 'collection') {
      const emitted = emitCollection(node, currentEnvironment, state, outputs, active, depth)
      const outputType = collectionOutputType(node, state.resolver, valueEnvironment(currentEnvironment, state.resolver, bindings), 'graph.' + node.id, false)
      bindings.set(node.id, { ports: new Map([['value', outputType]]), expression: emitted.result, portExpressions: new Map([['value', emitted.result]]) })
      chunks.push(loopBoundary(state, node, emitted.code, emitted.result + ' = __gameplayInvalid;'))
    } else if (node.kind === 'defer-choice') {
      const continuation = continuationFor(state.resolver, node.graph, node.id + '.graph')
      const effectCode = compileContinuation(continuation, state, node.id + '.graph')
      chunks.push(statementBoundary(state, node, emitPendingChoice(node, continuation, emit(node.payload, currentEnvironment), effectCode, currentEnvironment, target)))
    } else if (node.kind === 'if') {
      const thenCode = emitStatements(node.then, { inputs: new Map(environment.inputs), inputTypes: environment.inputTypes && new Map(environment.inputTypes), bindings: new Map(bindings) }, state, outputs, target, active, depth)
      const elseCode = node.else ? emitStatements(node.else, { inputs: new Map(environment.inputs), inputTypes: environment.inputTypes && new Map(environment.inputTypes), bindings: new Map(bindings) }, state, outputs, target, active, depth) : ''
      const condition = nextVariable(state, 'condition')
      chunks.push(statementBoundary(state, node, 'var ' + condition + ' = ' + emit(node.condition, currentEnvironment) + '; if (' + condition + ' !== __gameplayInvalid && ' + condition + ') { ' + thenCode + ' }' + (node.else ? ' else if (' + condition + ' !== __gameplayInvalid) { ' + elseCode + ' }' : ''), condition + ' = __gameplayInvalid;'))
    } else if (node.kind === 'foreach') {
      const index = nextVariable(state, 'index'); const items = nextVariable(state, 'items'); const item = nextVariable(state, 'item')
      const loopInputs = new Map(environment.inputs); const loopInputTypes = environment.inputTypes ? new Map(environment.inputTypes) : new Map<string, GameplayValueType>(); if (node.item) { loopInputs.set(node.item, item); loopInputTypes.set(node.item, listElement(node.items, currentEnvironment, state.resolver)) } if (node.index) { loopInputs.set(node.index, index); loopInputTypes.set(node.index, 'number') }
      const loopPorts = new Map<string, GameplayValueType>([['item', listElement(node.items, currentEnvironment, state.resolver)], ['index', 'number']])
      const loopExpressions = new Map<string, string>([['item', item], ['index', index]])
      const loopBindings = new Map(bindings); loopBindings.set(node.id, { ports: loopPorts, expression: item, portExpressions: loopExpressions })
      const body = emitStatements(node.body, { inputs: loopInputs, inputTypes: loopInputTypes, bindings: loopBindings }, state, outputs, target, active, depth)
      const legacyLoop = 'for (var ' + index + ' = 0, ' + items + ' = ' + emit(node.items, currentEnvironment) + '; ' + items + ' !== __gameplayInvalid && ' + items + ' != null && ' + index + ' < ' + items + '.length; ' + index + ' += 1) { var ' + item + ' = ' + items + '[' + index + ']; ' + body + ' }'
      const loop = isFaultIsolatingEmitter(state)
        ? 'var ' + items + ' = ' + emit(node.items, currentEnvironment) + '; if (' + items + ' !== __gameplayInvalid && ' + items + ' != null) { if (!Array.isArray(' + items + ')) { throw new Error("gameplay foreach items must be an array"); } if (' + items + '.length > ' + String(state.resolver.limits.maxCollectionIterations) + ') { throw new Error("gameplay foreach iteration budget exceeded"); } for (var ' + index + ' = 0; ' + index + ' < ' + items + '.length; ' + index + ' += 1) { __gameplayConsumeIteration(); var ' + item + ' = ' + items + '[' + index + ']; ' + body + ' } }'
        : legacyLoop
      if (node.presentation !== undefined) {
        const host = state.resolver.graph.surface === 'pending' ? 'ctx' : 'context'
        chunks.push(host + '.presentationQueue.push(' + literalSource(node.presentation) + ', function() { ' + loopBoundary(state, node, loop, item + ' = __gameplayInvalid; ' + index + ' = __gameplayInvalid;') + ' });')
      } else chunks.push(loopBoundary(state, node, loop, item + ' = __gameplayInvalid; ' + index + ' = __gameplayInvalid;'))

    } else if (node.kind === 'while') {
      const iterations = nextVariable(state, 'whileIterations')
      const index = nextVariable(state, 'whileIndex')
      const loopInputs = new Map(environment.inputs)
      const loopInputTypes = environment.inputTypes ? new Map(environment.inputTypes) : new Map<string, GameplayValueType>()
      if (node.index) { loopInputs.set(node.index, index); loopInputTypes.set(node.index, 'number') }
      const loopBindings = new Map(bindings)
      loopBindings.set(node.id, { ports: new Map([['index', 'number']]), expression: index, portExpressions: new Map([['index', index]]) })
      const condition = emitWhileCondition(node, currentEnvironment, state, active, depth)
      const body = emitStatements(node.body, { inputs: loopInputs, inputTypes: loopInputTypes, bindings: loopBindings }, state, outputs, target, active, depth)
      const conditionValue = '(' + condition.result + ' !== __gameplayInvalid && ' + condition.result + ' != null && ' + condition.result + '["value"] === true)'
      const budgetError = 'throw new Error("gameplay while iteration budget exceeded: ' + node.id.replace(/[^a-zA-Z0-9_.:-]/g, '_') + '");'
      const whileIterationGuard = isFaultIsolatingEmitter(state) ? '__gameplayConsumeIteration(); ' : ''
      chunks.push(loopBoundary(state, node, 'var ' + iterations + ' = 0; while (true) { ' + condition.code + ' if (!' + conditionValue + ') break; if (' + iterations + ' >= ' + String(node.budget) + ') { ' + budgetError + ' } ' + whileIterationGuard + 'var ' + index + ' = ' + iterations + '; ' + body + ' ' + iterations + ' += 1; }'))

    } else if (node.kind === 'return') chunks.push(statementBoundary(state, node, returnCode(node, outputs, currentEnvironment, target)))
  }
  return chunks.join(' ')
}
function wrapper(surface: GameplayModuleSurface, body: string, compilerVersion: GameplayModuleCompilerVersion, iterationBudget = 10_000): string {
  const prelude = 'var __gameplayInvalid = {}; '
  if (compilerVersion === GAMEPLAY_MODULE_COMPILER_V1_VERSION) {
    if (surface === 'skill' || surface === 'triggerSkill') return 'function executeSkill(context) { ' + prelude + body + ' }'
    if (surface === 'card') return 'function executeCard(context) { ' + prelude + body + ' }'
    if (surface === 'rule') return prelude + body
    if (surface === 'pending') return 'function(ctx) { ' + prelude + body + ' }'
    return 'function calculatePreview(piece, skillDef, currentCooldown) { var context = { piece: piece, skillDef: skillDef, currentCooldown: currentCooldown }; ' + prelude + body + ' }'
  }
  const hostContext = surface === 'pending' ? 'ctx' : 'context'
  const hostPrelude = 'var __gameplayHost = (typeof ' + hostContext + ' !== "undefined" && ' + hostContext + ' !== null) ? ' + hostContext + '[' + JSON.stringify(diagnosticHostKey) + '] : undefined; var __gameplayBudget = { remaining: ' + String(iterationBudget) + ' }; var __gameplayLoopDepth = 0; var __gameplayBudgetExceeded = {}; var __gameplayIsBudgetControl = function(error) { return error === __gameplayBudgetExceeded; }; var __gameplayConsumeIteration = function() { if (__gameplayBudget.remaining <= 0) throw __gameplayBudgetExceeded; __gameplayBudget.remaining -= 1; }; var __gameplayRecordFault = function(statementId, error, moduleId) { if (!__gameplayHost || typeof __gameplayHost.shouldRethrow !== "function" || __gameplayHost.shouldRethrow(error)) throw error; if (typeof __gameplayHost.record !== "function") throw error; __gameplayHost.record(statementId, error, moduleId); }; '
  const v2Prelude = prelude + hostPrelude
  if (surface === 'skill' || surface === 'triggerSkill') return 'function executeSkill(context) { ' + v2Prelude + body + ' }'
  if (surface === 'card') return 'function executeCard(context) { ' + v2Prelude + body + ' }'
  if (surface === 'rule') return v2Prelude + body
  if (surface === 'pending') return 'function(ctx) { ' + v2Prelude + body + ' }'
  return 'function calculatePreview(piece, skillDef, currentCooldown) { var context = { piece: piece, skillDef: skillDef, currentCooldown: currentCooldown }; if (skillDef && typeof skillDef === "object") context[' + JSON.stringify(diagnosticHostKey) + '] = skillDef[' + JSON.stringify(diagnosticHostKey) + ']; ' + v2Prelude + body + ' }'
}
function options(value: GameplayModuleCompilerOptions | undefined): Required<GameplayModuleCompilerOptions> {
  const result = { ...limitsDefault }; if (!value) return result
  for (const key of Object.keys(value) as (keyof GameplayModuleCompilerOptions)[]) { if (!(key in limitsDefault)) fail('unknown compiler option', 'options.' + key, 'GAMEPLAY_MODULE_UNKNOWN_FIELD'); const item = value[key]; if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0) fail('compiler option must be a positive integer', 'options.' + key, 'GAMEPLAY_MODULE_INVALID_OPTION'); result[key] = item }
  return result
}

function validatePresentationNesting(body: readonly GameplayStatement[], resolver: Resolver, inside = false): void {
  for (const node of body) {
    if (node.kind === 'foreach') {
      if (inside && node.presentation !== undefined) fail('nested presentation groups are not supported', 'graph.body.' + node.id, 'GAMEPLAY_MODULE_INVALID_VALUE')
      validatePresentationNesting(node.body, resolver, inside || node.presentation !== undefined)
    } else if (node.kind === 'while') {
      // Walk both subgraphs. Returns from the condition are local, while
      // presentation scopes in the execution body remain nested in `inside`.
      validatePresentationNesting(node.condition.body, resolver, inside)
      validatePresentationNesting(node.body, resolver, inside)
    } else if (node.kind === 'collection') {
      // Collection bodies are closed subgraphs; do not let them hide nested
      // presentation groups from the structural validator.
      validatePresentationNesting(node.body, resolver, inside)
    } else if (node.kind === 'if') {
      validatePresentationNesting(node.then, resolver, inside)
      validatePresentationNesting(node.else ?? [], resolver, inside)
    } else if (node.kind === 'call') {
      const resolvedModule = resolver.calls.get(node)?.module
      if (resolvedModule?.kind === 'composite') validatePresentationNesting(resolvedModule.definition.body, resolver, inside)
    }
  }
}

function compileGameplayModuleGraphVersioned(input: unknown, registry: GameplayModuleRegistry, compilerOptions: GameplayModuleCompilerOptions | undefined, compilerVersion: GameplayModuleCompilerVersion): GameplayModuleCompileResult {
  const compileLimits = options(compilerOptions); const graphValue = graph(input); validateGraphSchemas(graphValue); validateGraphLiteralBudget(graphValue, compileLimits.maxLiteralBytes); const resolver = makeResolver(graphValue, registry, compileLimits)
  const inputTypes = new Map<string, GameplayValueType>(); for (const inputPort of graphValue.inputs) inputTypes.set(inputPort.name, effective(inputPort))
  validateBody(graphValue.body, resolver, { inputs: inputTypes, bindings: new Map() }, graphValue.outputs, 'graph.body', [], 0)
  validatePresentationNesting(graphValue.body, resolver)
  if (graphValue.outputs.some(output => !output.optional) && !bodyGuaranteesReturn(graphValue.body)) fail('graph can fall through without returning its required outputs', 'graph.body', 'GAMEPLAY_MODULE_MISSING_OUTPUT')
  if (resolver.expanded.length > resolver.limits.maxExpandedCalls) fail('module call budget exceeded', 'graph.body', 'GAMEPLAY_MODULE_BUDGET_EXCEEDED')
  const state: Codegen = { next: 0, resolver, loweringDependencies: new Set(), continuationStack: [], compilerVersion }
  const rootInputs = new Map<string, string>(); for (const inputPort of graphValue.inputs) { const expression = rootStaticInput(graphValue, inputPort.name); if (expression) rootInputs.set(inputPort.name, expression) }
  const body = emitStatements(graphValue.body, { inputs: rootInputs, inputTypes, bindings: new Map() }, state, graphValue.outputs, undefined, [], 0)
  const code = wrapper(graphValue.surface, body, compilerVersion, resolver.limits.maxCollectionIterations)
  const dependencyMap = new Map(resolver.dependencies)
  for (const dependency of state.loweringDependencies) if (![...dependencyMap.values()].some(entry => entry.id === dependency || entry.id + '@' + entry.version === dependency)) dependencyMap.set(dependency, { id: dependency, version: '', kind: 'native' })
  return Object.freeze({ compilerVersion, graphVersion: GAMEPLAY_MODULE_GRAPH_VERSION, surface: graphValue.surface, code, source: code, dependencies: Object.freeze([...dependencyMap.values()].map(entry => Object.freeze({ ...entry }))), expanded: Object.freeze({ surface: graphValue.surface, calls: Object.freeze(resolver.expanded.map(entry => Object.freeze({ ...entry }))) }), diagnostics: Object.freeze([]) })
}
/** Compile new artifacts with the fault-isolating v2 emitter. */
export function compileGameplayModuleGraph(input: unknown, registry: GameplayModuleRegistry, compilerOptions?: GameplayModuleCompilerOptions): GameplayModuleCompileResult {
  return compileGameplayModuleGraphVersioned(input, registry, compilerOptions, GAMEPLAY_MODULE_COMPILER_V3_VERSION)
}

/** Preserve byte-for-byte v2 proofs for previously saved module documents. */
export function compileGameplayModuleGraphV2(input: unknown, registry: GameplayModuleRegistry, compilerOptions?: GameplayModuleCompilerOptions): GameplayModuleCompileResult {
  return compileGameplayModuleGraphVersioned(input, registry, compilerOptions, GAMEPLAY_MODULE_COMPILER_V2_VERSION)
}
/** Validate/reproduce legacy v1 artifacts without changing their emitted bytes. */
export function compileGameplayModuleGraphV1(input: unknown, registry: GameplayModuleRegistry, compilerOptions?: GameplayModuleCompilerOptions): GameplayModuleCompileResult {
  return compileGameplayModuleGraphVersioned(input, registry, compilerOptions, GAMEPLAY_MODULE_COMPILER_V1_VERSION)
}
export const compileModuleGraph = compileGameplayModuleGraph
export const compileGameplayGraph = compileGameplayModuleGraph
export const compileSemanticModuleGraph = compileGameplayModuleGraph
export { GameplayModuleCompileError }
