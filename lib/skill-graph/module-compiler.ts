/** Semantic RED-252 gameplay module compiler.
 *
 * Author graphs are data only. Native lowering is supplied by a trusted
 * registry descriptor and the result is emitted for the existing SkillCode
 * host; this module does not introduce a runtime interpreter.
 */

import {
  GAMEPLAY_MODULE_COMPILER_VERSION,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  GameplayModuleCompileError,
  type GameplayCallStatement,
  type GameplayCompositeDefinition,
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
  type GameplayReturnStatement,
  type GameplayStatement,
  type GameplayValue,
  type GameplayValueType,
  type GameplayValueTypeName,
} from './module-types'

export { GAMEPLAY_MODULE_COMPILER_VERSION }
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
}
type Rec = Record<string, unknown>
type Port = GameplayPort
type Param = GameplayParameter
type Graph = { readonly version: typeof GAMEPLAY_MODULE_GRAPH_VERSION; readonly surface: GameplayModuleSurface; readonly inputs: readonly Port[]; readonly inputBindings: Readonly<Record<string, GameplayLiteral>>; readonly outputs: readonly Port[]; readonly body: readonly GameplayStatement[]; readonly composites: readonly GameplayCompositeDefinition[]; readonly layout?: Readonly<Record<string, GameplayJsonValue>> }
type Resolved = { readonly kind: 'native'; readonly descriptor: GameplayModuleDescriptor } | { readonly kind: 'composite'; readonly definition: GameplayCompositeDefinition }
type VEnv = { readonly inputs: ReadonlyMap<string, GameplayValueType>; readonly bindings: ReadonlyMap<string, ReadonlyMap<string, GameplayValueType>> }
type CallMeta = { readonly module: Resolved; readonly inputs: Readonly<Record<string, GameplayValue>>; readonly parameters: Readonly<Record<string, GameplayLiteral>> }
type ExpandedCall = { readonly id: string; readonly version: string; readonly kind: 'native' | 'composite'; readonly callId: string; readonly depth: number }
type Resolver = { readonly graph: Graph; readonly composites: ReadonlyMap<string, GameplayCompositeDefinition>; readonly native: Map<string, GameplayModuleDescriptor>; readonly calls: Map<GameplayCallStatement, CallMeta>; readonly dependencies: Map<string, { id: string; version: string; kind: 'native' | 'composite' }>; readonly expanded: ExpandedCall[]; readonly limits: Required<GameplayModuleCompilerOptions>; readonly registry: GameplayModuleRegistry; statementCount: number }
type CBinding = { readonly ports: ReadonlyMap<string, GameplayValueType>; readonly expression: string; readonly portExpressions?: ReadonlyMap<string, string> }
type CEnv = { readonly inputs: ReadonlyMap<string, string>; readonly bindings: ReadonlyMap<string, CBinding> }
type ReturnTarget = { readonly result: string; readonly label: string; readonly outputs: readonly Port[] }
type Codegen = { next: number; readonly resolver: Resolver; readonly loweringDependencies: Set<string> }

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

function typeValue(value: unknown, path: string): GameplayValueType {
  if (typeof value === 'string') {
    if (!publicTypeNames.has(value as GameplayValueTypeName)) fail('unsupported value type "' + value + '"', path, 'GAMEPLAY_MODULE_INVALID_TYPE')
    if (value === 'unknown' || value === 'any') fail('universal value types are not allowed', path, 'GAMEPLAY_MODULE_INVALID_TYPE')
    return value as GameplayValueTypeName
  }
  const record = plain(value, path)
  if (record.kind === 'list') {
    allowed(record, ['kind', 'element'], path)
    if (!own(record, 'element')) fail('list type requires element', path, 'GAMEPLAY_MODULE_INVALID_TYPE')
    return { kind: 'list', element: typeValue(record.element, path + '.element') }
  }
  if (record.kind === 'nullable') {
    allowed(record, ['kind', 'value'], path)
    if (!own(record, 'value')) fail('nullable type requires value', path, 'GAMEPLAY_MODULE_INVALID_TYPE')
    return { kind: 'nullable', value: typeValue(record.value, path + '.value') }
  }
  fail('unsupported value type descriptor', path, 'GAMEPLAY_MODULE_INVALID_TYPE')
}
function port(value: unknown, path: string): Port {
  const record = plain(value, path)
  allowed(record, ['name', 'type', 'optional', 'nullable', 'label', 'description'], path)
  const result: Record<string, unknown> = { name: safeName(record.name, path + '.name'), type: typeValue(record.type, path + '.type') }
  for (const key of ['optional', 'nullable'] as const) if (record[key] !== undefined) result[key] = bool(record[key], path + '.' + key)
  for (const key of ['label', 'description'] as const) if (record[key] !== undefined) result[key] = nonempty(record[key], path + '.' + key)
  return result as Port
}
function ports(value: unknown, path: string): readonly Port[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('ports must be an array', path, 'GAMEPLAY_MODULE_SHAPE')
  const result = value.map((entry, index) => port(entry, path + '[' + index + ']'))
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
function inspectReferences(value: unknown, inputs: readonly Port[], path: string): readonly string[] | undefined {
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
    if (!reference) fail('inspectReferences input "' + name + '" must be a piece or player reference', path + '[' + index + ']', 'GAMEPLAY_MODULE_INVALID_REFERENCE_INSPECTION')
    result.push(name)
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
    allowed(record, ['kind', 'id', 'items', 'item', 'index', 'body', 'layout'], path)
    if (!Array.isArray(record.body)) fail('foreach.body must be an array', path + '.body', 'GAMEPLAY_MODULE_SHAPE')
    const node: Record<string, unknown> = { kind, id: nonempty(record.id, path + '.id'), items: valueRef(record.items, path + '.items'), body: statements(record.body, path + '.body') }
    if (record.item !== undefined) node.item = nonempty(record.item, path + '.item')
    if (record.index !== undefined) node.index = nonempty(record.index, path + '.index')
    const nodeLayout = layout(record.layout, path + '.layout'); if (nodeLayout !== undefined) node.layout = nodeLayout
    return node as GameplayStatement
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
      if (node.kind === 'foreach') visit(node.body, nested + '[' + index + '].body')
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
function graph(value: unknown): Graph {
  const record = plain(value, 'graph')
  allowed(record, ['version', 'surface', 'inputs', 'inputBindings', 'outputs', 'body', 'composites', 'layout'], 'graph')
  if (record.version !== GAMEPLAY_MODULE_GRAPH_VERSION) fail('unsupported graph version "' + String(record.version) + '"', 'graph.version', 'GAMEPLAY_MODULE_VERSION_MISMATCH')
  const surface = nonempty(record.surface, 'graph.surface')
  if (!surfaceSet.has(surface)) fail('unsupported surface "' + surface + '"', 'graph.surface', 'GAMEPLAY_MODULE_INVALID_SURFACE')
  if (!Array.isArray(record.body)) fail('graph.body must be an array', 'graph.body', 'GAMEPLAY_MODULE_SHAPE')
  const graphLayout = layout(record.layout, 'graph.layout')
  const inputPorts = ports(record.inputs, 'graph.inputs')
  const inputBindings = record.inputBindings === undefined ? {} : literalMap(record.inputBindings, 'graph.inputBindings')
  const outputPorts = ports(record.outputs, 'graph.outputs')
  const body = statements(record.body, 'graph.body')
  const composites = record.composites === undefined ? [] : !Array.isArray(record.composites) ? fail('graph.composites must be an array', 'graph.composites', 'GAMEPLAY_MODULE_SHAPE') : record.composites.map((entry, index) => composite(entry, 'graph.composites[' + index + ']'))
  const inputNames = new Set<string>()
  for (const input of inputPorts) {
    if (inputNames.has(input.name)) fail('duplicate input "' + input.name + '"', 'graph.inputs', 'GAMEPLAY_MODULE_DUPLICATE_PORT')
    inputNames.add(input.name)
    if (input.name === 'context' || input.name === 'ctx') fail('reserved root input name', 'graph.inputs', 'GAMEPLAY_MODULE_INVALID_NAME')
    if (surface !== 'preview' && !own(inputBindings as Rec, input.name)) fail('root inputs require static inputBindings', 'graph.inputs.' + input.name, 'GAMEPLAY_MODULE_ROOT_INPUT')
    if (surface === 'preview' && !own(inputBindings as Rec, input.name)) {
      const hostType = previewHostType(input.name)
      if (!hostType) fail('root input requires a static binding or fixed preview host name', 'graph.inputs.' + input.name, 'GAMEPLAY_MODULE_ROOT_INPUT')
      if (!matchesPreviewHostType(effective(input), hostType)) fail('preview host input "' + input.name + '" has an incompatible type', 'graph.inputs.' + input.name, 'GAMEPLAY_MODULE_PORT_TYPE')
    }
    if (own(inputBindings as Rec, input.name)) {
      const actual = typeOfLiteral(inputBindings[input.name])
      if (!assignable(actual, effective(input))) fail('root input binding expects ' + typeName(effective(input)) + ', got ' + typeName(actual), 'graph.inputBindings.' + input.name, 'GAMEPLAY_MODULE_PORT_TYPE')
    }
  }
  for (const key of Object.keys(inputBindings)) if (!inputNames.has(key)) fail('unknown root input binding "' + key + '"', 'graph.inputBindings.' + key, 'GAMEPLAY_MODULE_UNKNOWN_INPUT')
  const compositeKeys = new Set<string>()
  for (const entry of composites) { const key = moduleKey(entry.id, entry.version); if (compositeKeys.has(key)) fail('duplicate composite "' + entry.id + '@' + entry.version + '"', 'graph.composites', 'GAMEPLAY_MODULE_DUPLICATE_MODULE'); compositeKeys.add(key); ids(entry.body, 'graph.composites.' + entry.id + '.body') }
  ids(body, 'graph.body')
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: surface as GameplayModuleSurface, inputs: inputPorts, inputBindings, outputs: outputPorts, body, composites, layout: graphLayout }
}
function validateGraphLiteralBudget(value: Graph, limit: number): void {
  const budget = { bytes: 0, limit }
  const visitValue = (entry: GameplayValue): void => { if (entry.kind === 'literal') json(entry.value, 'graph.literal', budget) }
  const visitBody = (body: readonly GameplayStatement[]): void => {
    for (const node of body) {
      if (node.layout !== undefined) json(node.layout, 'graph.layout', budget)
      if (node.kind === 'call') {
        for (const entry of Object.values(node.inputs ?? {})) visitValue(entry)
        for (const entry of Object.values(node.parameters ?? {})) json(entry, 'graph.parameters', budget)
      } else if (node.kind === 'if') {
        visitValue(node.condition); visitBody(node.then); if (node.else) visitBody(node.else)
      } else if (node.kind === 'foreach') {
        visitValue(node.items); visitBody(node.body)
      } else {
        if (node.values) for (const entry of Object.values(node.values)) visitValue(entry)
        if (node.value) visitValue(node.value)
      }
    }
  }
  for (const entry of Object.values(value.inputBindings)) json(entry, 'graph.inputBindings', budget)
  if (value.layout !== undefined) json(value.layout, 'graph.layout', budget)
  visitBody(value.body)
  for (const compositeValue of value.composites) {
    if (compositeValue.layout !== undefined) json(compositeValue.layout, 'graph.composite.layout', budget)
    for (const parameterValue of compositeValue.parameters ?? []) {
      if (Object.prototype.hasOwnProperty.call(parameterValue, 'default')) json(parameterValue.default as GameplayLiteral, 'graph.composite.parameters', budget)
      for (const entry of parameterValue.enum ?? []) json(entry, 'graph.composite.parameters', budget)
    }
    visitBody(compositeValue.body)
  }
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
  return 'record'
}
function assignable(actual: GameplayValueType, expected: GameplayValueType): boolean {
  if (typeof expected === 'string') {
    if (expected === 'unknown' || expected === 'any') return true
    if (actual === 'never') return true
    if (expected === 'null') return actual === 'null'
    if (typeof actual === 'string') return actual === expected
    return false
  }
  if (expected.kind === 'nullable') {
    if (actual === 'null') return true
    return typeof actual === 'object'
      ? actual.kind === 'nullable' ? assignable(actual.value, expected.value) : assignable(actual, expected.value)
      : assignable(actual, expected.value)
  }
  if (typeof actual !== 'object' || actual.kind !== 'list') return false
  return expected.kind === 'list' && (actual.element === 'never' || assignable(actual.element, expected.element))
}
function typeName(value: GameplayValueType): string { return typeof value === 'string' ? value : value.kind === 'list' ? 'list<' + typeName(value.element) + '>' : 'nullable<' + typeName(value.value) + '>' }
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
  allowed(record, ['id', 'version', 'label', 'description', 'uiDescription', 'inputs', 'outputs', 'parameters', 'inspectReferences', 'allowedSurfaces', 'effects', 'ui', 'lower'], 'registry.' + id)
  const actualId = nonempty(record.id, 'registry.' + id + '.id')
  const actualVersion = nonempty(record.version, 'registry.' + id + '.version')
  if (actualId !== id || actualVersion !== version) fail('registry descriptor does not match requested module', 'registry.' + id, 'GAMEPLAY_MODULE_REGISTRY_INVALID')
  const inputPorts = ports(record.inputs, 'registry.' + id + '.inputs')
  const result: Rec = { id: actualId, version: actualVersion, label: nonempty(record.label, 'registry.' + id + '.label'), inputs: inputPorts, outputs: ports(record.outputs, 'registry.' + id + '.outputs'), allowedSurfaces: allowedSurfaces(record.allowedSurfaces, 'registry.' + id + '.allowedSurfaces'), effects: validateEffects(record.effects, 'registry.' + id + '.effects'), lower: record.lower }
  if (record.description !== undefined) result.description = nonempty(record.description, 'registry.' + id + '.description')
  if (record.uiDescription !== undefined) result.uiDescription = nonempty(record.uiDescription, 'registry.' + id + '.uiDescription')
  const params = parameters(record.parameters, 'registry.' + id + '.parameters'); if (params.length) result.parameters = params
  const inspected = inspectReferences(record.inspectReferences, inputPorts, 'registry.' + id + '.inspectReferences'); if (inspected !== undefined) result.inspectReferences = inspected
  if (record.ui !== undefined) result.ui = plain(record.ui, 'registry.' + id + '.ui')
  if (typeof record.lower !== 'function') fail('registry descriptor lower must be a function', 'registry.' + id + '.lower', 'GAMEPLAY_MODULE_REGISTRY_INVALID')
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
function makeResolver(value: Graph, registry: GameplayModuleRegistry, limits: Required<GameplayModuleCompilerOptions>): Resolver {
  const composites = new Map<string, GameplayCompositeDefinition>()
  for (const entry of value.composites) composites.set(moduleKey(entry.id, entry.version), entry)
  return { graph: value, composites, native: new Map(), calls: new Map(), dependencies: new Map(), expanded: [], limits, registry, statementCount: 0 }
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
function validateBody(list: readonly GameplayStatement[], resolver: Resolver, environment: VEnv, outputs: readonly Port[], path: string, active: readonly string[], depth: number): void {
  const bindings = new Map(environment.bindings)
  for (let index = 0; index < list.length; index += 1) {
    resolver.statementCount += 1
    if (resolver.statementCount > resolver.limits.maxExpandedStatements) fail('statement budget exceeded', path, 'GAMEPLAY_MODULE_BUDGET_EXCEEDED')
    const node = list[index]
    const nodePath = path + '[' + index + ']'
    if (node.kind === 'call') {
      const resolved = resolve(resolver, node.module, node.version, nodePath + '.module')
      if (resolved.kind === 'native') {
        if (!resolved.descriptor.allowedSurfaces.includes(resolver.graph.surface)) fail('module is not allowed on ' + resolver.graph.surface, nodePath + '.module', 'GAMEPLAY_MODULE_SURFACE_FORBIDDEN')
        if (resolver.graph.surface === 'preview' && !previewSafe(resolved.descriptor.effects)) fail('module has effects forbidden in preview', nodePath + '.module', 'GAMEPLAY_MODULE_PREVIEW_EFFECT')
      } else {
        const key = moduleKey(resolved.definition.id, resolved.definition.version)
        if (resolved.definition.allowedSurfaces && !resolved.definition.allowedSurfaces.includes(resolver.graph.surface)) fail('composite is not allowed on ' + resolver.graph.surface, nodePath + '.module', 'GAMEPLAY_MODULE_SURFACE_FORBIDDEN')
        if (active.includes(key)) fail('composite cycle detected', nodePath + '.module', 'GAMEPLAY_MODULE_COMPOSITE_CYCLE')
        if (depth >= resolver.limits.maxCompositeDepth) fail('composite expansion depth exceeded', nodePath + '.module', 'GAMEPLAY_MODULE_BUDGET_EXCEEDED')
        if (resolved.definition.outputs.some(output => !output.optional) && !bodyGuaranteesReturn(resolved.definition.body)) fail('composite can fall through without returning its required outputs', nodePath + '.module', 'GAMEPLAY_MODULE_MISSING_OUTPUT')
      }
      const inputPorts = resolved.kind === 'native' ? resolved.descriptor.inputs : resolved.definition.inputs
      const parameterPorts = resolved.kind === 'native' ? resolved.descriptor.parameters ?? [] : resolved.definition.parameters ?? []
      const declared = mapPorts(inputPorts)
      for (const key of Object.keys(node.inputs ?? {})) {
        const expected = declared.get(key)
        if (!expected) fail('unknown input port "' + key + '"', nodePath + '.inputs.' + key, 'GAMEPLAY_MODULE_UNKNOWN_PORT')
        const actual = valueType((node.inputs ?? {})[key], { inputs: environment.inputs, bindings }, nodePath + '.inputs.' + key)
        if (!assignable(actual, effective(expected))) fail('input "' + key + '" expects ' + typeName(effective(expected)) + ', got ' + typeName(actual), nodePath + '.inputs.' + key, 'GAMEPLAY_MODULE_PORT_TYPE')
      }
      for (const expected of inputPorts) if (!own(node.inputs as Rec, expected.name) && !expected.optional) fail('missing input port "' + expected.name + '"', nodePath + '.inputs', 'GAMEPLAY_MODULE_MISSING_PORT')
      const params = parameterValues(node.parameters ?? {}, parameterPorts, nodePath + '.parameters')
      const metadata: CallMeta = { module: resolved, inputs: node.inputs ?? {}, parameters: params }
      resolver.calls.set(node, metadata)
      resolver.dependencies.set(moduleKey(node.module, node.version), { id: node.module, version: node.version, kind: resolved.kind })
      resolver.expanded.push({ id: node.module, version: node.version, kind: resolved.kind, callId: node.id, depth })
      const outputPorts = resolved.kind === 'native' ? resolved.descriptor.outputs : resolved.definition.outputs
      const outputTypes = new Map<string, GameplayValueType>()
      for (const output of outputPorts) outputTypes.set(output.name, effective(output))
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
        validateBody(resolved.definition.body, resolver, { inputs: compositeInputs, bindings: new Map() }, resolved.definition.outputs, nodePath + '.composite', active.concat(moduleKey(resolved.definition.id, resolved.definition.version)), depth + 1)
      }
      bindings.set(node.id, outputTypes)
    } else if (node.kind === 'if') {
      const condition = valueType(node.condition, { inputs: environment.inputs, bindings }, nodePath + '.condition')
      if (!assignable(condition, 'boolean')) fail('if condition must be boolean', nodePath + '.condition', 'GAMEPLAY_MODULE_PORT_TYPE')
      validateBody(node.then, resolver, { inputs: environment.inputs, bindings: new Map(bindings) }, outputs, nodePath + '.then', active, depth)
      if (node.else) validateBody(node.else, resolver, { inputs: environment.inputs, bindings: new Map(bindings) }, outputs, nodePath + '.else', active, depth)
    } else if (node.kind === 'foreach') {
      const collection = valueType(node.items, { inputs: environment.inputs, bindings }, nodePath + '.items')
      if (typeof collection !== 'object' || collection.kind !== 'list') fail('foreach items must be a list', nodePath + '.items', 'GAMEPLAY_MODULE_PORT_TYPE')
      const bodyInputs = new Map(environment.inputs)
      if (node.item) { if (bodyInputs.has(node.item)) fail('foreach item shadows an input', nodePath + '.item', 'GAMEPLAY_MODULE_INVALID_NAME'); bodyInputs.set(node.item, collection.element) }
      if (node.index) { if (bodyInputs.has(node.index) || node.index === node.item) fail('foreach index shadows an input', nodePath + '.index', 'GAMEPLAY_MODULE_INVALID_NAME'); bodyInputs.set(node.index, 'number') }
      const loopOutputs = new Map<string, GameplayValueType>([['item', collection.element], ['index', 'number']])
      const loopBindings = new Map(bindings); loopBindings.set(node.id, loopOutputs)
      validateBody(node.body, resolver, { inputs: bodyInputs, bindings: loopBindings }, outputs, nodePath + '.body', active, depth)
    } else validateReturn(node, outputs, { inputs: environment.inputs, bindings }, nodePath)
  }
}

function nextVariable(state: Codegen, prefix: string): string { return '_' + prefix + state.next++ }
function rootStaticInput(graphValue: Graph, name: string): string | undefined {
  if (own(graphValue.inputBindings as Rec, name)) return '(' + literalSource(graphValue.inputBindings[name]) + ')'
  if (graphValue.surface === 'preview' && ['piece', 'skillDef', 'currentCooldown'].includes(name)) return '(context[' + JSON.stringify(name) + '])'
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
function listElement(value: GameplayValue, environment: CEnv, resolver: Resolver): GameplayValueType {
  if (value.kind === 'literal') { const type = typeOfLiteral(value.value); return typeof type === 'object' && type.kind === 'list' ? type.element : 'record' }
  if (value.kind === 'input') { const port = resolver.graph.inputs.find(entry => entry.name === value.name); const type = port && effective(port); return type && typeof type === 'object' && type.kind === 'list' ? type.element : 'record' }
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
  const declared = mapPorts(ports)
  const guards: string[] = []
  for (const key of Object.keys(metadata.inputs)) {
    const expected = declared.get(key)
    if (!expected) continue
    const expression = emit(metadata.inputs[key], environment)
    guards.push('(' + expression + ' === __gameplayInvalid)')
    const expectedType = effective(expected)
    const kind = referenceKind(expectedType)
    if (!expected.optional) guards.push('(' + expression + ' === undefined)')
    if (!nullableType(expectedType)) guards.push('(' + expression + ' === null)')
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
function lower(descriptorValue: GameplayModuleDescriptor, node: GameplayCallStatement, metadata: CallMeta, inputs: Readonly<Record<string, string>>, state: Codegen): { code: string; result: string } {
  const result = nextVariable(state, 'module')
  let lowered: GameplayNativeLoweringResult
  try {
    lowered = descriptorValue.lower({ surface: state.resolver.graph.surface, callId: node.id, moduleId: descriptorValue.id, moduleVersion: descriptorValue.version, inputs, parameters: metadata.parameters, outputPorts: descriptorValue.outputs, emitLiteral: literalSource })
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
function emitStatements(list: readonly GameplayStatement[], environment: CEnv, state: Codegen, outputs: readonly Port[], target: ReturnTarget | undefined, active: readonly string[], depth: number): string {
  const bindings = new Map(environment.bindings)
  const chunks: string[] = []
  for (const node of list) {
    const currentEnvironment: CEnv = { inputs: environment.inputs, bindings }
    if (node.kind === 'call') {
      const metadata = state.resolver.calls.get(node); if (!metadata) fail('missing call metadata', node.id, 'GAMEPLAY_MODULE_INTERNAL_ERROR')
      const inputs = inputExpressions(node, metadata, currentEnvironment)
      if (metadata.module.kind === 'native') {
        const lowered = lower(metadata.module.descriptor, node, metadata, inputs, state)
        const outputTypes = new Map<string, GameplayValueType>(); for (const output of metadata.module.descriptor.outputs) outputTypes.set(output.name, effective(output))
        const guard = inputGuard(metadata.module, metadata, currentEnvironment, state.resolver.graph.surface)
        const code = guard === undefined ? lowered.code : 'if (' + guard + ') { ' + lowered.result + ' = ' + invalidResult(metadata.module.descriptor.outputs) + '; } else { ' + lowered.code + ' }'
        bindings.set(node.id, { ports: outputTypes, expression: lowered.result }); chunks.push(code)
      } else {
        const definition = metadata.module.definition; const key = moduleKey(definition.id, definition.version)
        if (active.includes(key)) fail('composite cycle detected', node.id, 'GAMEPLAY_MODULE_COMPOSITE_CYCLE')
        if (depth >= state.resolver.limits.maxCompositeDepth) fail('composite expansion depth exceeded', node.id, 'GAMEPLAY_MODULE_BUDGET_EXCEEDED')
        const result = nextVariable(state, 'composite'); const label = nextVariable(state, 'done')
        const compositeInputs = new Map<string, string>()
        for (const input of definition.inputs) compositeInputs.set(input.name, metadata.inputs[input.name] === undefined ? '__gameplayInvalid' : emit(metadata.inputs[input.name], currentEnvironment))
        const body = emitStatements(definition.body, { inputs: compositeInputs, bindings: new Map() }, state, definition.outputs, { result, label, outputs: definition.outputs }, active.concat(key), depth + 1)
        const outputTypes = new Map<string, GameplayValueType>(); for (const output of definition.outputs) outputTypes.set(output.name, effective(output))
        const guard = inputGuard(metadata.module, metadata, currentEnvironment, state.resolver.graph.surface)
        const bodyCode = 'var ' + result + ' = ' + invalidResult(definition.outputs) + '; ' + (guard === undefined ? label + ': { ' + body + ' }' : 'if (' + guard + ') { ' + result + ' = ' + invalidResult(definition.outputs) + '; } else { ' + label + ': { ' + body + ' } }')
        bindings.set(node.id, { ports: outputTypes, expression: result }); chunks.push(bodyCode)
      }
    } else if (node.kind === 'if') {
      const thenCode = emitStatements(node.then, { inputs: new Map(environment.inputs), bindings: new Map(bindings) }, state, outputs, target, active, depth)
      const elseCode = node.else ? emitStatements(node.else, { inputs: new Map(environment.inputs), bindings: new Map(bindings) }, state, outputs, target, active, depth) : ''
      const condition = nextVariable(state, 'condition')
      chunks.push('var ' + condition + ' = ' + emit(node.condition, currentEnvironment) + '; if (' + condition + ' !== __gameplayInvalid && ' + condition + ') { ' + thenCode + ' }' + (node.else ? ' else if (' + condition + ' !== __gameplayInvalid) { ' + elseCode + ' }' : ''))
    } else if (node.kind === 'foreach') {
      const index = nextVariable(state, 'index'); const items = nextVariable(state, 'items'); const item = nextVariable(state, 'item')
      const loopInputs = new Map(environment.inputs); if (node.item) loopInputs.set(node.item, item); if (node.index) loopInputs.set(node.index, index)
      const loopPorts = new Map<string, GameplayValueType>([['item', listElement(node.items, currentEnvironment, state.resolver)], ['index', 'number']])
      const loopExpressions = new Map<string, string>([['item', item], ['index', index]])
      const loopBindings = new Map(bindings); loopBindings.set(node.id, { ports: loopPorts, expression: item, portExpressions: loopExpressions })
      const body = emitStatements(node.body, { inputs: loopInputs, bindings: loopBindings }, state, outputs, target, active, depth)
      chunks.push('for (var ' + index + ' = 0, ' + items + ' = ' + emit(node.items, currentEnvironment) + '; ' + items + ' !== __gameplayInvalid && ' + items + ' != null && ' + index + ' < ' + items + '.length; ' + index + ' += 1) { var ' + item + ' = ' + items + '[' + index + ']; ' + body + ' }')
    } else chunks.push(returnCode(node, outputs, currentEnvironment, target))
  }
  return chunks.join(' ')
}
function wrapper(surface: GameplayModuleSurface, body: string): string {
  const prelude = 'var __gameplayInvalid = {}; '
  if (surface === 'skill' || surface === 'triggerSkill') return 'function executeSkill(context) { ' + prelude + body + ' }'
  if (surface === 'card') return 'function executeCard(context) { ' + prelude + body + ' }'
  if (surface === 'rule') return prelude + body
  if (surface === 'pending') return 'function(ctx) { ' + prelude + body + ' }'
  return 'function calculatePreview(piece, skillDef, currentCooldown) { var context = { piece: piece, skillDef: skillDef, currentCooldown: currentCooldown }; ' + prelude + body + ' }'
}
function options(value: GameplayModuleCompilerOptions | undefined): Required<GameplayModuleCompilerOptions> {
  const result = { ...limitsDefault }; if (!value) return result
  for (const key of Object.keys(value) as (keyof GameplayModuleCompilerOptions)[]) { if (!(key in limitsDefault)) fail('unknown compiler option', 'options.' + key, 'GAMEPLAY_MODULE_UNKNOWN_FIELD'); const item = value[key]; if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0) fail('compiler option must be a positive integer', 'options.' + key, 'GAMEPLAY_MODULE_INVALID_OPTION'); result[key] = item }
  return result
}

export function compileGameplayModuleGraph(input: unknown, registry: GameplayModuleRegistry, compilerOptions?: GameplayModuleCompilerOptions): GameplayModuleCompileResult {
  const compileLimits = options(compilerOptions); const graphValue = graph(input); validateGraphLiteralBudget(graphValue, compileLimits.maxLiteralBytes); const resolver = makeResolver(graphValue, registry, compileLimits)
  const inputTypes = new Map<string, GameplayValueType>(); for (const inputPort of graphValue.inputs) inputTypes.set(inputPort.name, effective(inputPort))
  validateBody(graphValue.body, resolver, { inputs: inputTypes, bindings: new Map() }, graphValue.outputs, 'graph.body', [], 0)
  if (graphValue.outputs.some(output => !output.optional) && !bodyGuaranteesReturn(graphValue.body)) fail('graph can fall through without returning its required outputs', 'graph.body', 'GAMEPLAY_MODULE_MISSING_OUTPUT')
  if (resolver.expanded.length > resolver.limits.maxExpandedCalls) fail('module call budget exceeded', 'graph.body', 'GAMEPLAY_MODULE_BUDGET_EXCEEDED')
  const state: Codegen = { next: 0, resolver, loweringDependencies: new Set() }
  const rootInputs = new Map<string, string>(); for (const inputPort of graphValue.inputs) { const expression = rootStaticInput(graphValue, inputPort.name); if (expression) rootInputs.set(inputPort.name, expression) }
  const body = emitStatements(graphValue.body, { inputs: rootInputs, bindings: new Map() }, state, graphValue.outputs, undefined, [], 0)
  const code = wrapper(graphValue.surface, body)
  const dependencyMap = new Map(resolver.dependencies)
  for (const dependency of state.loweringDependencies) if (![...dependencyMap.values()].some(entry => entry.id === dependency || entry.id + '@' + entry.version === dependency)) dependencyMap.set(dependency, { id: dependency, version: '', kind: 'native' })
  return Object.freeze({ compilerVersion: GAMEPLAY_MODULE_COMPILER_VERSION, graphVersion: GAMEPLAY_MODULE_GRAPH_VERSION, surface: graphValue.surface, code, source: code, dependencies: Object.freeze([...dependencyMap.values()].map(entry => Object.freeze({ ...entry }))), expanded: Object.freeze({ surface: graphValue.surface, calls: Object.freeze(resolver.expanded.map(entry => Object.freeze({ ...entry }))) }), diagnostics: Object.freeze([]) })
}
export const compileModuleGraph = compileGameplayModuleGraph
export const compileGameplayGraph = compileGameplayModuleGraph
export const compileSemanticModuleGraph = compileGameplayModuleGraph
export { GameplayModuleCompileError }
