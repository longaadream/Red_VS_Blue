import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'
export const OATH_REFLECTION_IDS = ['rule-hidan-blood-oath-reflect'] as const
const l = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const o = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const c = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
export function buildOathReflectionGraph(id: string): GameplayModuleGraph {
  if (id !== 'rule-hidan-blood-oath-reflect') throw new Error('Unknown reflection rule ' + id)
  const body: GameplayStatement[] = []
  const ret = (id: string, success: boolean, message: GameplayValue = l('')): GameplayStatement => ({ kind: 'return', id, values: { success: l(success), message } })
  const guard = (id: string, condition: GameplayValue) => body.push(c(id + '-not', 'logic.not', { value: condition }), { kind: 'if', id, condition: o(id + '-not', 'value'), then: [ret(id + '-fail', false)] })
  for (const [name, field] of [['holder', 'rulePiece'], ['subject', 'piece']]) {
    body.push(c(name + '-ref', 'source.capture-event-piece', {}, { field }), c(name + '-exists', 'source.is-present', { source: o(name + '-ref', 'source') }))
    guard(name + '-guard', o(name + '-exists', 'value'))
    body.push(c(name, 'source.require-present', { source: o(name + '-ref', 'source') }), c(name + '-id', 'source.captured-identifier', { source: o(name, 'source') }))
  }
  body.push(c('same', 'compare.text', { left: o('holder-id', 'value'), right: o('subject-id', 'value') }))
  guard('same-guard', o('same', 'value'))
  body.push(c('damage', 'event.read-number', { fallback: l(0) }, { field: 'damage' }), c('positive', 'compare.greater-than', { left: o('damage', 'value'), right: l(0) }))
  guard('damage-guard', o('positive', 'value'))
  body.push(c('owner', 'source.captured-owner', { source: o('holder', 'source') }), c('enemies', 'query.pieces', { ownerId: o('owner', 'player') }, { relation: 'enemy' }), { kind: 'foreach', id: 'each', items: o('enemies', 'pieces'), body: [
    c('oathed', 'status.has-piece', { piece: o('each', 'item') }, { statusType: 'blood-oath' }), { kind: 'if', id: 'oath-guard', condition: o('oathed', 'value'), then: [
      c('target', 'source.capture', { source: o('each', 'item') }), c('queue', 'effect.queue-damage-captured', { source: o('holder', 'source'), target: o('target', 'source'), amount: o('damage', 'value') }, { damageType: 'true', skillId: 'blood-oath-reflect' }), c('name', 'attribute.text', { piece: o('each', 'item') }, { attribute: 'name' }), c('amount', 'text.from-number', { value: o('damage', 'value') }), c('prefix', 'text.concat', { left: l('血誓触发：'), right: o('name', 'text') }), c('verb', 'text.concat', { left: o('prefix', 'text'), right: l('将受到') }), c('number', 'text.concat', { left: o('verb', 'text'), right: o('amount', 'text') }), c('message', 'text.concat', { left: o('number', 'text'), right: l('点诅咒真实伤害') }), ret('reflected', true, o('message', 'text')),
    ] },
  ] }, c('remove-rule', 'rule.remove-captured', { source: o('holder', 'source') }, { ruleId: id }), ret('no-oath', false))
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }], body }
}
export function migrateOathReflection(root: string, write = false): string[] {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries
  const ignored = new Set(['skillCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: { file: string; next: Record<string, unknown> }[] = []
  for (const id of OATH_REFLECTION_IDS) {
    const file = path.join(root, 'data/rules', id + '.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (current.gameplayModules?.entries?.skillCode) { assertGameplayModuleDocument(current); continue }
    const original = baseline['rules/' + id]
    assertFrozenExecutable(current, original, 'skillCode', 'rule', id)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!ignored.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    pending.push({ file, next: applyGameplayModuleGraph(current, buildOathReflectionGraph(id), 'skillCode') })
  }
  if (write) for (const { file, next } of pending) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return pending.map(item => path.basename(item.file, '.json'))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(migrateOathReflection(process.cwd(), process.argv.includes('--write'))))
