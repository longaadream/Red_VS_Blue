import { parseAuthorExpression, type AuthorExpression } from './author-expression'
import { lowerAuthorExpression, type AuthorExpressionContext, type AuthorExtensionScope, type LoweredAuthorExpression } from './author-expression-graph'
import { getGameplayModule } from './module-registry'
import type { GameplayCallStatement, GameplayJsonValue, GameplayRecordSchema, GameplayStatement, GameplayValue, GameplayValueType } from './module-types'

export type LoweredAuthorStatement = {
  statements: GameplayStatement[]
  schemas: GameplayRecordSchema[]
  valueType: GameplayValueType
}
const encode = (type: GameplayValueType) => typeof type === 'string' ? type : JSON.stringify(type)
const unwrap = (type: GameplayValueType): GameplayValueType => typeof type === 'object' && type.kind === 'nullable' ? type.value : type
function compatible(actual: GameplayValueType, expected: GameplayValueType): boolean {
  if (actual === expected) return true
  if (typeof expected === 'object' && expected.kind === 'nullable') return actual === 'null' || compatible(unwrap(actual), expected.value)
  if (expected === 'record' && typeof actual === 'object' && actual.kind === 'record') return true
  if (typeof actual === 'string' || typeof expected === 'string' || actual.kind !== expected.kind) return false
  if (actual.kind === 'list' || actual.kind === 'set') return (expected.kind === 'list' || expected.kind === 'set') && compatible(actual.element, expected.element)
  if (actual.kind === 'map') return expected.kind === 'map' && compatible(actual.key, expected.key) && compatible(actual.value, expected.value)
  return actual.kind === 'record' && expected.kind === 'record' && actual.schema === expected.schema
}
function requireType(actual: GameplayValueType, expected: GameplayValueType): void {
  if (!compatible(actual, expected)) throw new Error('表达式类型与目标变量或字段的类型不一致')
}
function validateName(name: string): void {
  if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name)) throw new Error('变量名须以文字或下划线开头，且不能使用保留名称')
}
const domainScopes: Readonly<Record<string, AuthorExtensionScope>> = {
  'skill-instance': 'skill', 'status-instance': 'status', 'rule-instance': 'rule',
  'card-instance': 'card', 'cluster-instance': 'cluster', 'tile-effect': 'tile-effect',
}

/** One author declaration, lowered to the existing bounded host adapters. */
export function lowerAuthorExtensionDeclaration(
  ownerSource: string, name: string, valueType: GameplayValueType, initialSource: string, options: AuthorExpressionContext,
): LoweredAuthorStatement & { scope: AuthorExtensionScope } {
  validateName(name)
  const prefix = options.prefix ?? 'extension'
  const ownerSyntax = parseAuthorExpression(ownerSource)
  const global = ownerSyntax.kind === 'identifier' && ['全局', '当前对局'].includes(ownerSyntax.name)
  const owner = global ? undefined : lowerAuthorExpression(ownerSource, { ...options, expectedType: undefined, prefix: `${prefix}_owner` })
  const ownerType = owner && unwrap(owner.type)
  const scope = global ? 'battle' : owner?.domain ? domainScopes[owner.domain]
    : ownerType === 'piece' || ownerType === 'player' ? ownerType : undefined
  if (!scope) throw new Error('此对象没有可写的扩展变量入口')
  const initial = lowerAuthorExpression(initialSource, { ...options, schemas: owner?.schemas ?? options.schemas, expectedType: valueType, prefix: `${prefix}_initial` })
  requireType(initial.type, valueType)
  const instance = !['piece', 'player', 'battle'].includes(scope)
  const statement: GameplayCallStatement = {
    kind: 'call', id: `${prefix}_declare`, module: `extension.declare-${instance ? 'instance' : scope}`, version: scope === 'battle' ? '2' : '1',
    parameters: { namespace: 'content', name, valueType: encode(valueType), ...(instance ? { entityKind: scope } : {}) },
    inputs: { ...(owner ? { [instance ? 'entity' : 'owner']: owner.value } : {}), value: initial.value },
  }
  return { statements: [...(owner?.statements ?? []), ...initial.statements, statement], schemas: initial.schemas, valueType, scope }
}

function writerFor(read: GameplayCallStatement): { module: string; version: string; inputs: Record<string, GameplayValue>; parameters: Record<string, GameplayJsonValue> } {
  const field = read.parameters?.field
  if (/^extension\.read-(piece|player|battle|instance)$/.test(read.module)) return {
    module: read.module.replace('.read-', '.write-'), version: read.module.endsWith('-battle') ? '2' : '1',
    inputs: { ...read.inputs }, parameters: { ...read.parameters },
  }
  const modules: Record<string, string> = { 'piece.field': 'piece.write-field', 'player.field': 'player.write-field', 'author.skill-instance.field': 'author.skill-instance.write', 'event.field': 'event.write-number' }
  const moduleId = modules[read.module]
  if (!moduleId) throw new Error('此字段只读，不能作为赋值目标')
  const version = moduleId === 'piece.write-field' ? '2' : '1'
  const descriptor = getGameplayModule(moduleId, version)
  const allowed = descriptor?.parameters?.find(parameter => parameter.name === 'field')?.enum
  if (!allowed?.includes(field!)) throw new Error('此字段只读，或须通过对应的游戏效果修改')
  return { module: moduleId, version, inputs: { ...read.inputs }, parameters: { field: field!, ...(moduleId === 'piece.write-field' ? { scope: 'live' } : {}), ...(moduleId === 'event.write-number' ? { inputPolicy: 'floor' } : {}) } }
}

/** Assignment is syntax over existing writes, never an arbitrary object-path setter. */
export function lowerAuthorAssignment(targetSource: string, valueSource: string, options: AuthorExpressionContext): LoweredAuthorStatement {
  const targetSyntax = parseAuthorExpression(targetSource)
  if (!['identifier', 'member', 'index'].includes(targetSyntax.kind)) throw new Error('赋值左侧须为已声明变量或可写字段')
  const prefix = options.prefix ?? 'assignment'
  const local = targetSyntax.kind === 'identifier' && Object.hasOwn(options.bindings ?? {}, targetSyntax.name) ? options.bindings![targetSyntax.name] : undefined
  if (targetSyntax.kind === 'identifier') {
    if (!local) throw new Error(`变量「${targetSyntax.name}」尚未声明`)
    if (!local.local) throw new Error('此结果为只读值；需要修改时，请先新建局部变量')
    const value = lowerAuthorExpression(valueSource, { ...options, expectedType: local.type, prefix: `${prefix}_value` })
    requireType(value.type, local.type)
    return { statements: [...value.statements, { kind: 'call', id: `${prefix}_write`, module: 'local.write', version: '1', parameters: { valueType: encode(local.type) }, inputs: { handle: local.value, value: value.value } }], schemas: value.schemas, valueType: local.type }
  }
  let target: LoweredAuthorExpression
  let value: LoweredAuthorExpression
  // An external extension may be typed by the RHS, but a known field's type
  // always wins. A missing runtime field still uses normal invalid semantics.
  try { target = lowerAuthorExpression(targetSource, { ...options, expectedType: undefined, prefix: `${prefix}_target` }) }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes('请声明此扩展变量的类型')) throw error
    value = lowerAuthorExpression(valueSource, { ...options, expectedType: undefined, prefix: `${prefix}_value` })
    target = lowerAuthorExpression(targetSource, { ...options, expectedType: value.type, prefix: `${prefix}_target` })
  }
  value = lowerAuthorExpression(valueSource, { ...options, schemas: target.schemas, expectedType: target.type, prefix: `${prefix}_value` })
  requireType(value.type, target.type)
  const reads = new Map(target.statements.map(statement => [statement.id, statement]))
  let sequence = 0
  // Commit through the already evaluated receiver/index references. Re-lowering
  // the parent source here would repeat random or other state-dependent reads.
  function commit(reference: GameplayValue, syntax: AuthorExpression, updated: GameplayValue, type: GameplayValueType): GameplayStatement[] {
    const read = reference.kind === 'output' ? reads.get(reference.node) : undefined
    if (!read) throw new Error('此结果为只读值；需要修改时，请先新建局部变量')
    if (read.kind === 'record.get' || read.kind === 'call' && read.module === 'map.get') {
      if (syntax.kind !== 'member' && syntax.kind !== 'index') throw new Error('赋值目标不是可写结构')
      const parentSyntax = syntax.object
      // This compilation supplies type information only; none of its nodes are
      // emitted or executed. The commit reuses the original graph's references.
      const parentType = lowerAuthorExpression(targetSource.slice(parentSyntax.start, parentSyntax.end), { ...options, schemas: value.schemas, expectedType: undefined }).type
      const replacementId = `${prefix}_replace_${++sequence}`
      const parentReference = read.kind === 'record.get' ? read.record : read.inputs?.map
      if (!parentReference) throw new Error('赋值目标缺少容器引用')
      const replacement: GameplayStatement = read.kind === 'record.get'
        ? { kind: 'record.with', id: replacementId, record: read.record, fields: { [read.field]: updated } }
        : { ...read, id: replacementId, module: 'map.set', inputs: { ...read.inputs, value: updated } }
      return [replacement, ...commit(parentReference, parentSyntax, { kind: 'output', node: replacementId, port: 'value' }, parentType)]
    }
    if (read.kind !== 'call') throw new Error('此字段只读，不能作为赋值目标')
    const writer = read.module === 'local.read'
      ? { module: 'local.write', version: '1', inputs: { handle: read.inputs!.handle }, parameters: { valueType: encode(type) } }
      : writerFor(read)
    const parameters = { ...writer.parameters }
    const descriptor = getGameplayModule(writer.module, writer.version)
    if (descriptor?.parameters?.some(parameter => parameter.name === 'valueType')) parameters.valueType = encode(type)
    return [{ kind: 'call', id: `${prefix}_write`, ...writer, parameters, inputs: { ...writer.inputs, value: updated } }]
  }
  const terminal = target.statements.at(-1)
  if (!terminal || target.value.kind !== 'output' || terminal.id !== target.value.node) throw new Error('此字段只读，不能作为赋值目标')
  return {
    statements: [...target.statements.slice(0, -1), ...value.statements, ...commit(target.value, targetSyntax, value.value, target.type)],
    schemas: value.schemas, valueType: target.type,
  }
}
