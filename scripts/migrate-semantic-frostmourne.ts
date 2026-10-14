import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'
const l = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const o = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const c = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const result = (id: string, message: GameplayValue): GameplayStatement[] => [c(id + '-record', 'result.action', { success: l(true), message }), { kind: 'return', id, value: o(id + '-record', 'result') }]

export function buildFrostmourneGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    c('holder', 'ref.holder'), c('source', 'query.piece', { pieceId: o('holder', 'piece') }),
    c('choice', 'choice.target-piece', {}, { range: 1, filter: 'enemy' }),
    c('unresolved', 'choice.is-unresolved', { choice: o('choice', 'choice') }),
    { kind: 'if', id: 'choice-check', condition: o('unresolved'), then: [c('pending', 'choice.as-result', { choice: o('choice', 'choice') }), { kind: 'return', id: 'pending-result', value: o('pending', 'result') }] },
    c('target', 'choice.piece', { choice: o('choice', 'choice') }),
    c('saved-source', 'source.capture', { source: o('source', 'piece') }), c('saved-target', 'source.capture', { source: o('target', 'piece') }),
    c('owner', 'piece.owner', { piece: o('source', 'piece') }), c('has-player', 'query.has-player', { playerId: o('owner', 'player') }),
    c('charge-before', 'local.counter-create', { initial: l(0) }),
    { kind: 'if', id: 'capture-charge', condition: o('has-player', 'exists'), then: [
      c('charge', 'resource.read', { player: o('owner', 'player') }, { resource: 'chargePoints' }),
      c('save-charge', 'local.counter-add', { counter: o('charge-before', 'counter'), amount: o('charge') }),
    ] },
    c('attack', 'attribute.read', { piece: o('source', 'piece') }, { attribute: 'attack' }), c('power', 'skill.power-multiplier'),
    c('scaled', 'math.multiply', { left: o('attack'), right: o('power') }), c('amount', 'math.floor', { value: o('scaled') }),
    c('hit', 'effect.damage-captured', { source: o('saved-source', 'source'), target: o('saved-target', 'source'), amount: o('amount') }, { damageType: 'physical', skillId: 'arthas-frostmourne' }),
    c('damage', 'effect.result-number', { result: o('hit', 'result') }, { field: 'damage' }), c('damage-text', 'text.from-number', { value: o('damage') }),
    c('source-name', 'piece.captured-name', { source: o('saved-source', 'source') }), c('target-name', 'piece.captured-name', { source: o('saved-target', 'source') }),
  ]
  let text: GameplayValue = l('')
  const parts = [o('source-name'), l('用霜之哀伤斩击'), o('target-name'), l('，造成'), o('damage-text', 'text'), l('点物理伤害')]
  parts.forEach((part, index) => { body.push(c('message-' + index, 'text.concat', { left: text, right: part })); text = o('message-' + index, 'text') })
  body.push(
    c('killed', 'effect.result-killed', { result: o('hit', 'result') }),
    c('no-charge', 'source.captured-no-kill-charge', { source: o('saved-target', 'source') }), c('can-charge', 'logic.not', { value: o('no-charge') }),
    c('kill-player', 'logic.and', { left: o('killed', 'killed'), right: o('has-player', 'exists') }),
    c('grant', 'logic.and', { left: o('kill-player'), right: o('can-charge') }),
    { kind: 'if', id: 'grant-check', condition: o('grant'), then: [
      c('before', 'local.counter-read', { counter: o('charge-before', 'counter') }),
      c('desired', 'math.add', { left: o('before'), right: l(1) }),
      c('current', 'resource.read', { player: o('owner', 'player') }, { resource: 'chargePoints' }),
      c('difference', 'math.subtract', { left: o('desired'), right: o('current') }),
      c('set-charge', 'resource.adjust', { player: o('owner', 'player'), amount: o('difference') }, { resource: 'chargePoints' }),
      c('extra-message', 'text.concat', { left: text, right: l('，并额外获得1点充能') }), ...result('charged', o('extra-message', 'text')),
    ] }, ...result('done', text),
  )
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'result', type: 'record', nullable: true }], body }
}
export function migrateFrostmourne(root: string, write = false): void {
  const file = path.join(root, 'data/skills/arthas-frostmourne.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (current.gameplayModules?.entries?.code) { assertGameplayModuleDocument(current); return }
  const original = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries['skills/arthas-frostmourne']
  assertFrozenExecutable(current, original, 'code', 'skill', 'arthas-frostmourne')
  const generated = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!generated.has(key) && JSON.stringify(current[key]) !== JSON.stringify(original[key])) throw new Error(`arthas-frostmourne: changed compatibility field ${key}`)
  const next = applyGameplayModuleGraph(current, buildFrostmourneGraph())
  if (write) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) migrateFrostmourne(process.cwd(), process.argv.includes('--write'))
