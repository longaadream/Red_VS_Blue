import type { AtomicRecipe, AtomicReplacement } from './atomic-graph-rewrite'
import type { GameplayCallStatement, GameplayLiteral, GameplayStatement, GameplayValue, GameplayValueType } from './module-types'

export const ATOMIC_ACTION_HISTORY_MODULES = new Set([
  'event.actions', 'event.action-text', 'event.action-number', 'event.action-piece',
  'event.last-move-distance', 'event.skill-cast-count',
])
const out = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const lit = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const typeName = (type: GameplayValueType) => typeof type === 'string' ? type : JSON.stringify(type)

/** History searches are ordinary record reads, filters and tuple operations. */
export const atomicActionHistoryRecipe: AtomicRecipe = (node, fresh): AtomicReplacement | undefined => {
  if (!ATOMIC_ACTION_HISTORY_MODULES.has(node.module)) return undefined
  const body: GameplayStatement[] = []
  const push = (module: string, inputs: Record<string, GameplayValue> = {}, parameters?: Record<string, GameplayLiteral>, target = body, version = '1', port = 'value') => {
    const id = fresh(module.replaceAll('.', '-'))
    target.push({ kind: 'call', id, module, version, inputs, ...(parameters ? { parameters } : {}) } as GameplayCallStatement)
    return out(id, port)
  }
  const read = (record: GameplayValue, key: string, type: GameplayValueType, target = body) => push('data.read-key', { record }, { key, valueType: typeName(type) }, target)
  const coalesce = (value: GameplayValue, defaultValue: GameplayValue, type: GameplayValueType, target = body) => push('value.coalesce', { value, defaultValue }, { valueType: typeName(type) }, target)
  const compare = (left: GameplayValue, right: GameplayValue, type: GameplayValueType, target = body, operator = '==') => push('compare.values', { left, right }, { valueType: typeName(type), operator }, target)
  const battleField = (field: string) => push('battle.field', {}, { field }, body, '5')
  if (node.module === 'event.actions') return { statements: [{ ...node, module: 'battle.field', version: '5', parameters: { field: 'actions' } }], outputs: { actions: out(node.id) } }
  if (['event.action-text', 'event.action-number', 'event.action-piece'].includes(node.module)) {
    const field = String(node.parameters!.field)
    const type: GameplayValueType = node.module === 'event.action-piece' ? 'piece' : node.module === 'event.action-text' ? 'string' : 'number'
    const parts = field.split('.')
    let value = node.inputs!.action
    for (let index = 0; index < parts.length; index++) value = read(value, parts[index], index === parts.length - 1 ? type : 'record')
    const result = coalesce(value, node.inputs!.fallback, node.module === 'event.action-piece' ? { kind: 'nullable', value: type } : type)
    return { statements: body, outputs: { value: result } }
  }
  const actions = battleField('actions')
  const items = node.module === 'event.last-move-distance' ? push('collection.reverse', { items: actions }, undefined, body, '1', 'items') : actions
  const turn = node.module === 'event.skill-cast-count' ? battleField('turnNumber') : undefined
  const predicate: GameplayStatement[] = []
  const kind = read(input('item'), 'type', 'string', predicate)
  const kindMatches = compare(kind, lit(turn ? 'useBasicSkill' : 'move'), { kind: 'nullable', value: 'string' }, predicate)
  const payload = read(input('item'), 'payload', 'record', predicate)
  const owner = read(payload, 'pieceId', 'piece', predicate)
  const ownerMatches = compare(owner, input('piece'), { kind: 'nullable', value: 'piece' }, predicate)
  let condition = push('logic.and', { left: kindMatches, right: ownerMatches }, undefined, predicate)
  if (turn) {
    const actionTurn = read(input('item'), 'turn', 'number', predicate)
    const sameTurn = compare(actionTurn, input('turn'), { kind: 'nullable', value: 'number' }, predicate)
    const skill = read(payload, 'skillId', 'string', predicate)
    const sameSkill = compare(skill, lit(node.parameters!.skillId), { kind: 'nullable', value: 'string' }, predicate)
    const interrupted = read(payload, 'interrupted', 'boolean', predicate)
    const completed = compare(interrupted, lit(true), { kind: 'nullable', value: 'boolean' }, predicate, '!=')
    for (const right of [sameTurn, sameSkill, completed]) condition = push('logic.and', { left: condition, right }, undefined, predicate)
  }
  predicate.push({ kind: 'return', id: fresh('matches'), value: condition })
  const selected = fresh('matching-actions')
  body.push({ kind: 'collection', id: selected, method: turn ? 'filter' : 'find', items, inputs: { piece: node.inputs!.piece, ...(turn ? { turn } : {}) }, body: predicate })
  if (turn) return { statements: [...body, { kind: 'call', id: node.id, module: 'collection.length', version: '1', inputs: { items: out(selected) } }], outputs: { count: out(node.id) } }
  const latestPayload = read(out(selected), 'payload', 'record')
  const path = read(latestPayload, 'path', { kind: 'list', element: 'record' })
  const positions = coalesce(path, lit([]), { kind: 'list', element: 'record' })
  const distance = push('collection.length', { items: positions })
  return { statements: body, outputs: { distance } }
}
