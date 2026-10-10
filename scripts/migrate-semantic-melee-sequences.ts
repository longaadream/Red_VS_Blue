import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'
export const MELEE_SEQUENCE_SKILL_IDS = ['edgar-fisticuffs', 'el-primo-punch'] as const
const l = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const o = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const c = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const branch = (id: string, condition: GameplayValue, then: GameplayStatement[]): GameplayStatement => ({ kind: 'if', id, condition, then })
function message(body: GameplayStatement[], prefix: string, parts: GameplayValue[]): GameplayValue {
  let text = l('')
  parts.forEach((part, index) => { const id = prefix + index; body.push(c(id, 'text.concat', { left: text, right: part })); text = o(id, 'text') })
  return text
}
export function buildMeleeSequenceGraph(id: string): GameplayModuleGraph {
  const edgar = id === 'edgar-fisticuffs'
  if (!(MELEE_SEQUENCE_SKILL_IDS as readonly string[]).includes(id)) throw new Error('Unknown sequence ' + id)
  const body: GameplayStatement[] = [c('source-ref', 'ref.holder'), c('source', 'query.piece', { pieceId: o('source-ref', 'piece') }), c('choice', 'choice.target-piece', {}, { range: 1, filter: 'enemy' }), c('unresolved', 'choice.is-unresolved', { choice: o('choice', 'choice') }), branch('choice-guard', o('unresolved', 'value'), [c('pending', 'choice.as-result', { choice: o('choice', 'choice') }), { kind: 'return', id: 'pending-result', value: o('pending', 'result') }]), c('target', 'choice.piece', { choice: o('choice', 'choice') }), c('saved-source', 'source.capture', { source: o('source', 'piece') }), c('saved-target', 'source.capture', { source: o('target', 'piece') }), c('total', 'local.counter-create', { initial: l(0) }), c('hits', 'local.counter-create', { initial: l(0) }), c('healed', 'local.counter-create', { initial: l(0) })]
  if (edgar) body.push(c('attack', 'attribute.read', { piece: o('source', 'piece') }, { attribute: 'attack' }), c('multiplier', 'skill.power-multiplier'), c('scaled', 'math.multiply', { left: o('attack', 'value'), right: o('multiplier', 'value') }), c('amount', 'math.floor', { value: o('scaled', 'value') }))
  else body.push(c('initial-hp', 'attribute.read', { piece: o('target', 'piece') }, { attribute: 'currentHp' }), c('initial-dead', 'compare.less-or-equal', { left: o('initial-hp', 'value'), right: l(0) }), branch('initial-target-alive', o('initial-dead', 'value'), [{ kind: 'return', id: 'invalid-target', values: { success: l(false), message: l('目标不存在或不相邻') } }]))
  const hit: GameplayStatement[] = []
  if (!edgar) hit.push(c('current-attack', 'source.captured-number', { source: o('saved-source', 'source') }, { field: 'attack' }), c('quarter', 'math.multiply', { left: o('current-attack', 'value'), right: l(0.25) }), c('amount', 'math.floor', { value: o('quarter', 'value') }))
  hit.push(c('damage', 'effect.damage-captured', { source: o('saved-source', 'source'), target: o('saved-target', 'source'), amount: o('amount', 'value') }, { damageType: 'physical', skillId: id }), c('dealt', 'effect.result-number', { result: o('damage', 'result') }, { field: 'damage' }), c('count-hit', 'local.counter-add', { counter: o('hits', 'counter'), amount: l(1) }), c('sum-damage', 'local.counter-add', { counter: o('total', 'counter'), amount: o('dealt', 'value') }))
  if (edgar) {
    hit.push(c('dealt-positive', 'compare.greater-than', { left: o('dealt', 'value'), right: l(0) }), c('source-exists-after', 'query.has-piece', { pieceId: o('source', 'piece') }), c('source-hp-after', 'source.captured-number', { source: o('saved-source', 'source') }, { field: 'currentHp' }), c('source-alive-after', 'compare.greater-than', { left: o('source-hp-after', 'value'), right: l(0) }), c('can-heal-source', 'logic.and', { left: o('source-exists-after', 'exists'), right: o('source-alive-after', 'value') }), c('can-heal', 'logic.and', { left: o('can-heal-source', 'value'), right: o('dealt-positive', 'value') }), branch('heal-after-hit', o('can-heal', 'value'), [c('heal', 'effect.heal', { source: o('source', 'piece'), target: o('source', 'piece'), amount: l(1) }, { skillId: id }), c('sum-heal', 'local.counter-add', { counter: o('healed', 'counter'), amount: o('heal', 'heal') })]))
  }
  const each: GameplayStatement[] = [c('target-hp', 'source.captured-number', { source: o('saved-target', 'source') }, { field: 'currentHp' }), c('target-alive', 'compare.greater-than', { left: o('target-hp', 'value'), right: l(0) })]
  if (edgar) {
    each.push(c('source-hp', 'source.captured-number', { source: o('saved-source', 'source') }, { field: 'currentHp' }), c('source-alive', 'compare.greater-than', { left: o('source-hp', 'value'), right: l(0) }), c('source-exists', 'query.has-piece', { pieceId: o('source', 'piece') }), c('target-exists', 'query.has-piece', { pieceId: o('target', 'piece') }), c('both-exist', 'logic.and', { left: o('source-exists', 'exists'), right: o('target-exists', 'exists') }), c('both-alive', 'logic.and', { left: o('source-alive', 'value'), right: o('target-alive', 'value') }), c('can-hit', 'logic.and', { left: o('both-exist', 'value'), right: o('both-alive', 'value') }), branch('hit-guard', o('can-hit', 'value'), hit))
  } else each.push(branch('hit-guard', o('target-alive', 'value'), hit))
  body.push({ kind: 'foreach', id: 'hit-sequence', items: l(edgar ? [0, 1] : [0, 1, 2, 3]), body: each }, c('source-name', 'piece.captured-name', { source: o('saved-source', 'source') }), c('target-name', 'piece.captured-name', { source: o('saved-target', 'source') }), c('damage-total', 'local.counter-read', { counter: o('total', 'counter') }), c('damage-text', 'text.from-number', { value: o('damage-total', 'value') }), c('hit-total', 'local.counter-read', { counter: o('hits', 'counter') }), c('hit-text', 'text.from-number', { value: o('hit-total', 'value') }))
  const text = message(body, 'message-', edgar ? [o('source-name', 'value'), l('对'), o('target-name', 'value'), l('造成'), o('damage-text', 'text'), l('点伤害')] : [o('source-name', 'value'), l('连续挥拳'), o('hit-text', 'text'), l('次，造成'), o('damage-text', 'text'), l('点伤害')])
  if (edgar) {
    body.push(c('heal-total', 'local.counter-read', { counter: o('healed', 'counter') }), c('did-heal', 'compare.greater-than', { left: o('heal-total', 'value'), right: l(0) }))
    const healBody: GameplayStatement[] = [c('heal-text', 'text.from-number', { value: o('heal-total', 'value') })]
    const healedText = message(healBody, 'healed-message-', [text, l('并回复'), o('heal-text', 'text'), l('点生命')])
    healBody.push({ kind: 'return', id: 'healed-result', values: { success: l(true), message: healedText } }); body.push(branch('healed-guard', o('did-heal', 'value'), healBody))
  }
  body.push({ kind: 'return', id: 'done', values: { success: l(true), message: text } })
  const returns = (nodes: readonly GameplayStatement[]): GameplayStatement[] => nodes.flatMap(node => {
    if (node.kind === 'return' && node.values) return [c(node.id + '-record', 'result.action', { success: node.values.success, message: node.values.message }), { kind: 'return', id: node.id, value: o(node.id + '-record', 'result') }]
    if (node.kind === 'if') return [{ ...node, then: returns(node.then), ...(node.else ? { else: returns(node.else) } : {}) }]
    if (node.kind === 'foreach') return [{ ...node, body: returns(node.body) }]
    return [node]
  })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'result', type: 'record', nullable: true }], body: returns(body) }
}
export function migrateMeleeSequences(root: string, write = false): string[] {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries
  const ignored = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: { file: string; next: Record<string, unknown> }[] = []
  for (const id of MELEE_SEQUENCE_SKILL_IDS) {
    const file = path.join(root, 'data/skills', id + '.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (current.gameplayModules?.entries?.code) { assertGameplayModuleDocument(current); continue }
    const original = baseline['skills/' + id]
    assertFrozenExecutable(current, original, 'code', 'skill', id)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!ignored.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    pending.push({ file, next: applyGameplayModuleGraph(current, buildMeleeSequenceGraph(id)) })
  }
  if (write) for (const { file, next } of pending) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return pending.map(item => path.basename(item.file, '.json'))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(migrateMeleeSequences(process.cwd(), process.argv.includes('--write'))))
