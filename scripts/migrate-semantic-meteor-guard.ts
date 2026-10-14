import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'

const l = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const o = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const c = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const fail = (id: string): GameplayStatement[] => [{ kind: 'return', id, values: { success: l(false), message: l('') } }]
const requireTrue = (id: string, condition: GameplayValue): GameplayStatement[] => [c(id + '-not', 'logic.not', { value: condition }), { kind: 'if', id, condition: o(id + '-not'), then: fail(id + '-failure') }]

export function buildMeteorGuardGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  for (const [id, module] of [['guard', 'ref.rule-piece'], ['target', 'ref.event-piece']]) {
    body.push(c(id, module), c(id + '-exists', 'query.has-piece', { pieceId: o(id, 'piece') }), ...requireTrue(id + '-present', o(id + '-exists', 'exists')),
      c(id + '-resolved', 'query.piece', { pieceId: o(id, 'piece') }), c(id + '-hp', 'attribute.read', { piece: o(id + '-resolved', 'piece') }, { attribute: 'currentHp' }),
      c(id + '-living', 'compare.greater-than', { left: o(id + '-hp'), right: l(0) }), ...requireTrue(id + '-alive', o(id + '-living')))
  }
  const guard = o('guard-resolved', 'piece'), target = o('target-resolved', 'piece')
  body.push(c('different', 'compare.not-equal-piece', { left: guard, right: target }), ...requireTrue('not-self', o('different')),
    c('guard-owner', 'piece.owner', { piece: guard }), c('target-owner', 'piece.owner', { piece: target }),
    c('allied', 'compare.allied-players', { left: o('target-owner', 'player'), right: o('guard-owner', 'player') }), ...requireTrue('ally', o('allied')))
  for (const id of ['guard', 'target']) body.push(c(id + '-position', 'spatial.has-position', { piece: o(id + '-resolved', 'piece') }), ...requireTrue(id + '-on-board', o(id + '-position')))
  for (const axis of ['x', 'y']) body.push(c('guard-' + axis, 'attribute.read', { piece: guard }, { attribute: axis }), c('target-' + axis, 'attribute.read', { piece: target }, { attribute: axis }),
    c(axis + '-difference', 'math.subtract', { left: o('guard-' + axis), right: o('target-' + axis) }), c(axis + '-distance', 'math.abs', { value: o(axis + '-difference') }),
    c(axis + '-near', 'compare.less-or-equal', { left: o(axis + '-distance'), right: l(1) }), ...requireTrue(axis + '-range', o(axis + '-near')))
  body.push(c('status', 'status.has-piece', { piece: guard }, { statusType: 'el-primo-meteor-belt' }), ...requireTrue('has-status', o('status')),
    c('redirect', 'event.enqueue-damage-redirect', { target: guard }), ...requireTrue('accepted', o('redirect', 'accepted')),
    c('guard-name', 'attribute.text', { piece: guard }, { attribute: 'name' }), c('target-name', 'attribute.text', { piece: target }, { attribute: 'name' }),
    c('message-prefix', 'text.concat', { left: o('guard-name', 'text'), right: l('代替') }), c('message-target', 'text.concat', { left: o('message-prefix', 'text'), right: o('target-name', 'text') }),
    c('message', 'text.concat', { left: o('message-target', 'text'), right: l('承受伤害') }), c('blocked', 'event.block', { message: o('message', 'text') }),
    { kind: 'return', id: 'done', values: { success: o('blocked', 'success'), blocked: o('blocked', 'blocked'), message: o('blocked', 'message') } })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: [{ name: 'success', type: 'boolean' }, { name: 'blocked', type: 'boolean', optional: true }, { name: 'message', type: 'string' }], body }
}

export function migrateMeteorGuard(root: string, write = false): void {
  const file = path.join(root, 'data/rules/rule-el-primo-meteor-belt.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (current.gameplayModules?.entries?.skillCode) { assertGameplayModuleDocument(current); return }
  const original = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries['rules/rule-el-primo-meteor-belt']
  assertFrozenExecutable(current, original, 'skillCode', 'rule', 'rule-el-primo-meteor-belt')
  const next = applyGameplayModuleGraph(current, buildMeteorGuardGraph(), 'skillCode')
  if (write) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) migrateMeteorGuard(process.cwd(), process.argv.includes('--write'))
