import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'

export const AREA_SKILL_IDS = ['death-blossom', 'holy-light-descend'] as const
const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const out = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const result = (id: string, success: boolean, message: GameplayValue): GameplayStatement[] => [call(id, 'result.action', { success: literal(success), message }), { kind: 'return', id: id + '-return', value: out(id, 'result') }]

export function buildAreaSkillGraph(id: string): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('source-ref', 'ref.holder'), call('source', 'query.piece', { pieceId: out('source-ref', 'piece') })]
  const source = out('source', 'piece')
  body.push(call('owner', 'piece.owner', { piece: source }), call('name', 'attribute.text', { piece: source }, { attribute: 'name' }))
  if (id === 'death-blossom') {
    body.push(call('center', 'spatial.piece-position', { piece: source }), call('enemies', 'query.pieces-around-cell', { center: out('center', 'cell'), owner: out('owner', 'player') }, { relation: 'enemy', metric: 'chebyshev', maximum: 1 }), call('count', 'collection.piece-count', { pieces: out('enemies', 'pieces') }), call('empty', 'compare.equal', { left: out('count', 'value'), right: literal(0) }), { kind: 'if', id: 'empty-area', condition: out('empty', 'value'), then: result('no-targets', false, literal('自身周围3×3范围内没有敌人')) }, {
      kind: 'collection.map', id: 'names', items: out('enemies', 'pieces'), body: [call('item-name', 'attribute.text', { piece: input('item') }, { attribute: 'name' }), { kind: 'return', id: 'name-result', value: out('item-name', 'text') }],
    }, call('attack', 'attribute.read', { piece: source }, { attribute: 'attack' }), call('power', 'skill.power-multiplier'), call('scaled', 'math.multiply', { left: out('attack', 'value'), right: out('power', 'value') }), call('amount', 'math.floor', { value: out('scaled', 'value') }), call('damage', 'effect.damage-many', { source, targets: out('enemies', 'pieces'), amount: out('amount', 'value') }), {
      kind: 'collection.map', id: 'hits', items: out('names', 'value'), inputs: { damage: out('damage', 'result') }, body: [call('hit-damage', 'damage.batch-amount-at', { result: input('damage'), index: input('index') }), call('hit-amount', 'text.from-number', { value: out('hit-damage', 'value') }), call('hit-prefix', 'text.concat', { left: input('item'), right: literal('受到') }), call('hit-number', 'text.concat', { left: out('hit-prefix', 'text'), right: out('hit-amount', 'text') }), call('hit-message', 'text.concat', { left: out('hit-number', 'text'), right: literal('点伤害') }), { kind: 'return', id: 'hit-result', value: out('hit-message', 'text') }],
    }, call('joined', 'text.join-list', { items: out('hits', 'value') }, { separator: '；' }), call('prefix', 'text.concat', { left: out('name', 'text'), right: literal('释放死亡绽放，') }), call('message', 'text.concat', { left: out('prefix', 'text'), right: out('joined', 'text') }), call('kills', 'damage.batch-kill-count', { result: out('damage', 'result') }), call('has-kills', 'compare.greater-than', { left: out('kills', 'value'), right: literal(0) }), {
      kind: 'if', id: 'kill-message', condition: out('has-kills', 'value'), then: [call('kill-prefix', 'text.concat', { left: out('message', 'text'), right: literal('，击杀了') }), call('kill-number', 'text.from-number', { value: out('kills', 'value') }), call('kill-count', 'text.concat', { left: out('kill-prefix', 'text'), right: out('kill-number', 'text') }), call('kill-text', 'text.concat', { left: out('kill-count', 'text'), right: literal('个敌人') }), ...result('killed', true, out('kill-text', 'text'))],
    }, ...result('success', true, out('message', 'text')))
  } else if (id === 'holy-light-descend') {
    body.push(call('captured-source', 'source.capture', { source }))
    body.push(call('choice', 'choice.target-cell', {}, { range: 6, filter: 'enemy' }), call('waiting', 'choice.is-unresolved', { choice: out('choice', 'choice') }), { kind: 'if', id: 'return-choice', condition: out('waiting', 'value'), then: [call('choice-result', 'choice.as-result', { choice: out('choice', 'choice') }), { kind: 'return', id: 'waiting-result', value: out('choice-result', 'result') }] }, call('center', 'choice.cell', { choice: out('choice', 'choice') }))
    for (const [distance, amount] of [9, 7, 4, 4].entries()) {
      for (const relation of ['ally', 'enemy'] as const) {
        const key = 'ring-' + distance + '-' + relation
        body.push(call(key, 'query.pieces-around-cell', { center: out('center', 'cell'), owner: out('owner', 'player') }, { relation, minimum: distance, maximum: distance }), call(key + '-count', 'collection.piece-count', { pieces: out(key, 'pieces') }), call(key + '-present', 'compare.greater-than', { left: out(key + '-count', 'value'), right: literal(0) }))
      }
      for (const relation of ['ally', 'enemy'] as const) {
        const key = 'ring-' + distance + '-' + relation
        body.push({ kind: 'if', id: key + '-apply', condition: out(key + '-present', 'value'), then: [call(key + '-effect', relation === 'ally' ? 'effect.heal-many-captured' : 'effect.damage-many-captured', { source: out('captured-source', 'source'), targets: out(key, 'pieces'), amount: literal(amount) }, relation === 'enemy' ? { damageType: 'magical' } : {})] })
      }
    }
    body.push(call('message', 'text.concat', { left: out('name', 'text'), right: literal('释放了圣光降临') }), ...result('success', true, out('message', 'text')))
  } else throw new Error('Unknown area skill ' + id)
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'result', type: 'record', nullable: true }], body }
}

export function migrateAreaSkills(root: string, write = false): string[] {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries
  const ignored = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: { file: string; next: Record<string, unknown> }[] = []
  for (const id of AREA_SKILL_IDS) {
    const file = path.join(root, 'data/skills', id + '.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (current.gameplayModules?.entries?.code) { assertGameplayModuleDocument(current); continue }
    const original = baseline['skills/' + id]
    assertFrozenExecutable(current, original, 'code', 'skill', id)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!ignored.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    pending.push({ file, next: applyGameplayModuleGraph(current, buildAreaSkillGraph(id)) })
  }
  if (write) for (const { file, next } of pending) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return pending.map(item => path.basename(item.file, '.json'))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(migrateAreaSkills(process.cwd(), process.argv.includes('--write'))))
