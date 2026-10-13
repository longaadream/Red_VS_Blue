import { authorFieldAliases, authorFunctionSpecs, authorRecordFieldDisplayName, lowerAuthorExpression, type AuthorExpressionContext, type AuthorExtensionScope, type AuthorValue } from './author-expression-graph'
import { getGameplayModule } from './module-registry'
import type { GameplayValueType } from './module-types'

export type AuthorSuggestion = { label: string; value: string; kind: string; description?: string; signature?: string }
export function authorTypeLabel(type: GameplayValueType): string {
  if (typeof type === 'object') return type.kind === 'list' ? `元组<${authorTypeLabel(type.element)}>` : type.kind === 'set' ? `集合<${authorTypeLabel(type.element)}>` : type.kind === 'map' ? `映射<${authorTypeLabel(type.key)}, ${authorTypeLabel(type.value)}>` : type.kind === 'nullable' ? `${authorTypeLabel(type.value)}或空` : '结构体'
  return ({ number: '数值', boolean: '布尔', string: '文本', piece: '棋子', player: '玩家', cell: '地格', card: '手牌', status: '状态', record: '结构体', event: '事件', null: '空' } as Record<string, string>)[type] ?? type
}

/** Complete an unfinished call only for type inspection. No game expression is evaluated. */
function closePrefix(prefix: string): string {
  const stack: string[] = []; let quote = ''; let escape = false
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}', '（': '）', '［': '］', '｛': '｝' }
  for (const character of prefix) {
    if (quote) { if (escape) escape = false; else if (character === '\\') escape = true; else if (character === quote) quote = ''; continue }
    if ('"\'“‘＂＇'.includes(character)) { quote = ({ '“': '”', '‘': '’' } as Record<string, string>)[character] ?? character; continue }
    if (pairs[character]) stack.push(pairs[character])
    else if (stack.at(-1) === character) stack.pop()
  }
  return prefix + stack.reverse().join('')
}

function fieldsFor(value: AuthorValue, options: AuthorExpressionContext): Record<string, GameplayValueType> {
  const type = typeof value.type === 'object' && value.type.kind === 'nullable' ? value.type.value : value.type
  if (type === 'cell') return { x: 'number', y: 'number', 可行走: 'boolean', 被占用: 'boolean', 地格效果: { kind: 'list', element: 'record' } }
  if (typeof type === 'object' && type.kind === 'record') {
    const schema = options.schemas?.find(schema => schema.id === type.schema || `${schema.id}@${schema.version}` === type.schema)
    return schema ? Object.fromEntries(schema.fields.map(field => [authorRecordFieldDisplayName(schema, field), field.type])) : {}
  }
  const moduleId = value.domain === 'skill-instance' ? 'author.skill-instance.field'
    : value.domain === 'card-instance' ? 'card.instance-field'
      : value.domain === 'tile-effect' ? 'tile.effect-field'
        : type === 'piece' ? 'piece.field' : type === 'player' ? 'player.field' : type === 'event' ? 'event.field' : undefined
  const descriptor = moduleId && getGameplayModule(moduleId, type === 'piece' ? '2' : '1')
  const raw = descriptor && descriptor.outputParameterTypeBindings?.value?.types || {}
  const result: Record<string, GameplayValueType> = {}
  for (const [name, fieldType] of Object.entries(raw)) {
    const label = Object.keys(authorFieldAliases).find(alias => authorFieldAliases[alias] === name) ?? name
    result[name === 'tileType' ? '类型' : label] = fieldType
  }
  if (type === 'piece') { result.位置 = 'cell'; result.能力组 = { kind: 'list', element: 'record' } }
  return result
}

function extensionScope(value: AuthorValue): AuthorExtensionScope | undefined {
  const domain = value.domain
  if (domain === 'skill-instance' || domain === 'skill-instances') return 'skill'
  if (domain === 'status-instance' || domain === 'status-instances') return 'status'
  if (domain === 'rule-instance' || domain === 'rule-instances') return 'rule'
  if (domain === 'card-instance' || domain === 'card-instances') return 'card'
  if (domain === 'cluster-instance' || domain === 'cluster-instances') return 'cluster'
  if (domain === 'tile-effect' || domain === 'tile-effects') return 'tile-effect'
  const type = typeof value.type === 'object' && value.type.kind === 'nullable' ? value.type.value : value.type
  return type === 'piece' || type === 'player' ? type : undefined
}

function containerMethods(type: GameplayValueType): readonly string[] {
  const selected = typeof type === 'object' && type.kind === 'nullable' ? type.value : type
  if (typeof selected !== 'object') return []
  if (selected.kind === 'list') return ['包含', '首项序号', '筛选', '逐项变换', '任意满足', '全部满足', '查找首项', '数量', '截取', '反转']
  if (selected.kind === 'set') return ['包含', '数量', '加入', '移除', '转元组']
  if (selected.kind === 'map') return ['包含键', '键列表', '值列表', '数量', '读取', '写入', '移除']
  return []
}

/** Hints use exactly the same lexical lowering as execution, including nested 每项. */
export function completeAuthorExpression(prefix: string, options: AuthorExpressionContext): AuthorSuggestion[] {
  const match = prefix.match(/[\p{L}\p{N}_.$。．]*$/u)
  const query = (match?.[0] ?? '').replace(/[。．]/gu, '.')
  const normalizedPrefix = prefix.replace(/[。．]/gu, '.')
  const trailingDot = normalizedPrefix.endsWith('.')
  // A finished literal/call is not a new argument. Opening every candidate
  // here would cover the Apply action even though there is nothing to complete.
  if (/^\d+(?:\.\d*)?$/u.test(query) || !query && /[)）\]}｝"'”’]\s*$/u.test(prefix)) return []
  const leading = prefix.slice(0, prefix.length - (match?.[0].length ?? 0))
  const marker = '__author_completion_probe'
  let bindings = options.bindings ?? {}
  let schemas = options.schemas
  try {
    lowerAuthorExpression(closePrefix(leading + marker), { ...options, observeIdentifier(name, scope, visibleSchemas) { if (name === marker) { bindings = scope; schemas = visibleSchemas } } })
  } catch { /* An incomplete editor expression has no executable effect. The observed lexical scope remains usable. */ }
  const dot = trailingDot ? normalizedPrefix.length - 1 : query.lastIndexOf('.')
  let receiver = trailingDot ? normalizedPrefix.slice(0, -1).trim() : dot >= 0 ? query.slice(0, dot) : query
  let owner: AuthorValue | undefined
  if (receiver) {
    try { owner = lowerAuthorExpression(receiver, { ...options, bindings, schemas }) } catch { /* Only successfully inferred fields are offered. */ }
    if (!owner && trailingDot) {
      const lexicalDot = query.lastIndexOf('.')
      const lexicalReceiver = lexicalDot >= 0 ? query.slice(0, lexicalDot) : query
      try {
        owner = lowerAuthorExpression(lexicalReceiver, { ...options, bindings, schemas })
        if (owner) receiver = lexicalReceiver
      } catch { /* Nested lexical receivers use the observed scope. */ }
    }
  }
  if (receiver === '当前事件') owner = { value: { kind: 'literal', value: null }, type: 'event' }
  const suggestions: AuthorSuggestion[] = []
  const extensionReceiver = receiver.match(/^(.*)\.(?:extension|扩展变量)$/u)
  if (extensionReceiver) {
    let scope: AuthorExtensionScope | undefined
    if (['全局', '当前对局'].includes(extensionReceiver[1])) scope = 'battle'
    else {
      try { scope = extensionScope(lowerAuthorExpression(extensionReceiver[1], { ...options, bindings, schemas })) } catch { /* Incomplete receiver has no fields. */ }
    }
    for (const declaration of options.extensions ?? []) if (declaration.scope === scope) suggestions.push({ label: `${receiver}.${declaration.name}`, value: `${receiver}.${declaration.name}`, kind: authorTypeLabel(declaration.type) })
  }
  if (receiver === '全局' || receiver === '当前对局') {
    for (const [field, type] of Object.entries({ turnNumber: 'number', currentPlayerId: 'player' } as const)) suggestions.push({ label: `${receiver}.${field}`, value: `${receiver}.${field}`, kind: authorTypeLabel(type) })
  }
  if (owner) {
    if (extensionScope(owner)) suggestions.push({ label: `${receiver}.extension`, value: `${receiver}.extension`, kind: '扩展变量' })
    for (const [field, type] of Object.entries(fieldsFor(owner, { ...options, schemas }))) suggestions.push({ label: `${receiver}.${field}`, value: `${receiver}.${field}`, kind: authorTypeLabel(type) })
    for (const method of containerMethods(owner.type)) suggestions.push({ label: `${receiver}.${method}`, value: `${receiver}.${method}()`, kind: '方法', signature: `${receiver}.${method}()` })
  }
  if (receiver === '全局' || receiver === '当前对局') suggestions.push({ label: `${receiver}.extension`, value: `${receiver}.extension`, kind: '扩展变量' })
  if (dot >= 0) return suggestions
  for (const [name, value] of Object.entries(bindings)) suggestions.push({ label: name, value: name, kind: authorTypeLabel(value.type) })
  for (const [name, type] of Object.entries({ 当前棋子: 'piece', 当前玩家: 'player', 目标: 'piece', 当前事件: 'event', 全局: 'record' } as const)) suggestions.push({ label: name, value: name, kind: authorTypeLabel(type) })
  if (['skill', 'pending'].includes(options.surface)) suggestions.push({ label: '当前技能', value: '当前技能', kind: '技能实例' })
  if (['rule', 'triggerSkill', 'pending'].includes(options.surface)) suggestions.push({ label: '当前规则', value: '当前规则', kind: '规则实例' })
  if (['card', 'rule', 'triggerSkill', 'pending'].includes(options.surface)) suggestions.push({ label: '当前手牌', value: '当前手牌', kind: '手牌实例' })
  for (const [name, spec] of Object.entries(authorFunctionSpecs)) suggestions.push({ label: name, value: `${name}()`, kind: '函数', signature: `${name}()`, description: (spec.labels ?? spec.args).join('，') })
  for (const name of ['筛选', '逐项变换', '查找首项', '任意满足', '全部满足']) suggestions.push({ label: name, value: `${name}()`, kind: '函数', signature: `${name}()`, description: '容器，关于每项的表达式' })
  // Keep the English spellings accepted by the parser for compatibility,
  // while inserting the Chinese spellings that authors see in the editor.
  for (const [label, value] of [['真', '真'], ['假', '假'], ['空', '空']] as const) suggestions.push({ label, value, kind: '取值' })
  return suggestions
}

/** Placeholder text at the caret is metadata, never part of the expression. */
export function authorExpressionParameterHint(prefix: string, options: AuthorExpressionContext): { empty: true; label: string; type: string } | null {
  if (prefix.trim() && !/[（(，,:：+\-*/%^=<>!&|]\s*$/u.test(prefix)) return null
  const marker = '__author_parameter_probe'
  let expected: GameplayValueType | undefined
  try {
    lowerAuthorExpression(closePrefix(prefix + marker), { ...options, observeIdentifier(name, _bindings, _schemas, type) { if (name === marker) expected = type } })
  } catch { /* Partial expressions are inspected but never executed. */ }
  return expected && !['any', 'unknown', 'never'].includes(String(expected)) ? { empty: true, label: '填写', type: authorTypeLabel(expected) } : null
}

export function describeAuthorReference(reference: string, prefix: string, options: AuthorExpressionContext) {
  const marker = '__author_inspect_probe'
  let bindings = options.bindings; let schemas = options.schemas
  try { lowerAuthorExpression(closePrefix(prefix + marker), { ...options, observeIdentifier(name, scope, visible) { if (name === marker) { bindings = scope; schemas = visible } } }) } catch { /* Use only observed lexical scope. */ }
  const value = lowerAuthorExpression(reference, { ...options, bindings, schemas })
  return { name: reference, type: authorTypeLabel(value.type), fields: Object.entries(fieldsFor(value, { ...options, schemas })).map(([name, type]) => ({ name, type: authorTypeLabel(type) })), ...(value.value.kind === 'literal' ? { value: value.value.value } : {}) }
}
