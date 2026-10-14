import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'
const l = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const o = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const c = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
export function buildInfiniteBladeGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    c('holder', 'ref.holder'), c('source', 'query.piece', { pieceId: o('holder', 'piece') }),
    c('tag', 'status.find-id', { piece: o('source', 'piece') }, { statusType: 'shishio-kills' }),
    c('kills', 'status.read-number', { piece: o('source', 'piece'), statusId: o('tag', 'id'), fallback: l(0) }, { field: 'intensity' }),
    c('two', 'compare.greater-or-equal', { left: o('kills'), right: l(2) }), c('one', 'compare.greater-or-equal', { left: o('kills'), right: l(1) }),
    c('lower-multiplier', 'value.select-number', { condition: o('one'), whenTrue: l(1.5), whenFalse: l(1) }),
    c('multiplier', 'value.select-number', { condition: o('two'), whenTrue: l(2), whenFalse: o('lower-multiplier') }),
    c('choice', 'choice.target-piece', {}, { range: 2, filter: 'enemy' }), c('unresolved', 'choice.is-unresolved', { choice: o('choice', 'choice') }),
    { kind: 'if', id: 'selection-check', condition: o('unresolved'), then: [c('pending', 'choice.as-result', { choice: o('choice', 'choice') }), { kind: 'return', id: 'waiting', value: o('pending', 'result') }] },
    c('target', 'choice.piece', { choice: o('choice', 'choice') }), c('saved-source', 'source.capture', { source: o('source', 'piece') }), c('saved-target', 'source.capture', { source: o('target', 'piece') }),
    c('attack', 'attribute.read', { piece: o('source', 'piece') }, { attribute: 'attack' }), c('scaled', 'math.multiply', { left: o('attack'), right: o('multiplier') }), c('amount', 'math.floor', { value: o('scaled') }),
    c('hit', 'effect.damage-captured', { source: o('saved-source', 'source'), target: o('saved-target', 'source'), amount: o('amount') }, { damageType: 'true', skillId: 'shishio-infinite-blade' }),
    c('damage', 'effect.result-number', { result: o('hit', 'result') }, { field: 'damage' }), c('damage-text', 'text.from-number', { value: o('damage') }),
    c('name', 'piece.captured-name', { source: o('saved-source', 'source') }), c('target-name', 'piece.captured-name', { source: o('saved-target', 'source') }),
  ]
  let message: GameplayValue = o('name')
  const parts = [l('发动无限刃，对'), o('target-name'), l('造成'), o('damage-text', 'text'), l('点真实伤害')]
  parts.forEach((part, index) => { body.push(c('text-' + index, 'text.concat', { left: message, right: part })); message = o('text-' + index, 'text') })
  body.push(c('result', 'result.action', { success: l(true), message }), { kind: 'return', id: 'done', value: o('result', 'result') })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'result', type: 'record', nullable: true }], body }
}

export function migrateInfiniteBlade(root: string, write = false): void {
  const file = path.join(root, 'data/skills/shishio-infinite-blade.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (current.gameplayModules?.entries?.code) { assertGameplayModuleDocument(current); return }
  const original = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries['skills/shishio-infinite-blade']
  assertFrozenExecutable(current, original, 'code', 'skill', 'shishio-infinite-blade')
  const generated = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!generated.has(key) && JSON.stringify(current[key]) !== JSON.stringify(original[key])) throw new Error(`shishio-infinite-blade: changed compatibility field ${key}`)
  const next = applyGameplayModuleGraph(current, buildInfiniteBladeGraph())
  if (write) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) migrateInfiniteBlade(process.cwd(), process.argv.includes('--write'))
