import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'
const l = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const o = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const c = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
export function buildFelFireGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    c('holder', 'ref.holder'), c('source', 'query.piece', { pieceId: o('holder', 'piece') }),
    c('choice', 'choice.target-piece', {}, { range: 4, filter: 'enemy' }), c('unresolved', 'choice.is-unresolved', { choice: o('choice', 'choice') }),
    { kind: 'if', id: 'choice-check', condition: o('unresolved'), then: [c('pending', 'choice.as-result', { choice: o('choice', 'choice') }), { kind: 'return', id: 'pending-result', value: o('pending', 'result') }] },
    c('target', 'choice.piece', { choice: o('choice', 'choice') }), c('saved-source', 'source.capture', { source: o('source', 'piece') }), c('saved-target', 'source.capture', { source: o('target', 'piece') }),
    c('center', 'spatial.piece-position', { piece: o('target', 'piece') }), c('target-id', 'piece.identifier', { piece: o('target', 'piece') }),
    c('attack', 'attribute.read', { piece: o('source', 'piece') }, { attribute: 'attack' }), c('power', 'skill.power-multiplier'), c('scaled', 'math.multiply', { left: o('attack'), right: o('power') }), c('amount', 'math.floor', { value: o('scaled') }),
    c('hit', 'effect.damage-captured', { source: o('saved-source', 'source'), target: o('saved-target', 'source'), amount: o('amount') }, { damageType: 'magical', skillId: 'kiljaedan-fel-fire' }),
    c('owner', 'source.captured-owner', { source: o('saved-source', 'source') }),
    c('neighbors', 'query.pieces-around-cell', { center: o('center', 'cell'), owner: o('owner', 'player') }, { relation: 'enemy', metric: 'chebyshev', maximum: 1 }),
    { kind: 'collection.filter', id: 'others', items: o('neighbors', 'pieces'), inputs: { targetId: o('target-id', 'id') }, item: 'neighbor', body: [
      c('neighbor-id', 'piece.identifier', { piece: { kind: 'input', name: 'neighbor' } }), c('different', 'compare.not-equal-string', { left: o('neighbor-id', 'id'), right: { kind: 'input', name: 'targetId' } }),
      { kind: 'return', id: 'neighbor-result', value: o('different') },
    ] },
    c('count', 'collection.piece-count', { pieces: o('others') }), c('has-others', 'compare.greater-than', { left: o('count'), right: l(0) }),
    { kind: 'if', id: 'splash-check', condition: o('has-others'), then: [c('splash', 'effect.damage-many-captured', { source: o('saved-source', 'source'), targets: o('others'), amount: o('amount') }, { damageType: 'magical' })] },
    c('damage', 'effect.result-number', { result: o('hit', 'result') }, { field: 'damage' }), c('nonzero', 'compare.not-equal', { left: o('damage'), right: l(0) }),
    c('display-damage', 'value.select-number', { condition: o('nonzero'), whenTrue: o('damage'), whenFalse: o('amount') }),
    c('damage-text', 'text.from-number', { value: o('display-damage') }), c('count-text', 'text.from-number', { value: o('count') }),
    c('name', 'piece.captured-name', { source: o('saved-source', 'source') }), c('target-name', 'piece.captured-name', { source: o('saved-target', 'source') }),
  ]
  let text: GameplayValue = l('')
  const parts = [o('name'), l('的恒星之火对'), o('target-name'), l('造成'), o('damage-text', 'text'), l('点法术伤害，并波及周围'), o('count-text', 'text'), l('名敌人')]
  parts.forEach((part, i) => { body.push(c('text-' + i, 'text.concat', { left: text, right: part })); text = o('text-' + i, 'text') })
  body.push(c('result', 'result.action', { success: l(true), message: text }), { kind: 'return', id: 'done', value: o('result', 'result') })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'result', type: 'record', nullable: true }], body }
}
export function migrateFelFire(root: string, write = false): void {
  const file = path.join(root, 'data/skills/kiljaedan-fel-fire.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (current.gameplayModules?.entries?.code) { assertGameplayModuleDocument(current); return }
  const original = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries['skills/kiljaedan-fel-fire']
  assertFrozenExecutable(current, original, 'code', 'skill', 'kiljaedan-fel-fire')
  const generated = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!generated.has(key) && JSON.stringify(current[key]) !== JSON.stringify(original[key])) throw new Error(`kiljaedan-fel-fire: changed compatibility field ${key}`)
  const next = applyGameplayModuleGraph(current, buildFelFireGraph())
  if (write) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) migrateFelFire(process.cwd(), process.argv.includes('--write'))
