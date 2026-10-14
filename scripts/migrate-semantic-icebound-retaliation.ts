import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'
export const ICEBOUND_RETALIATION_IDS = ['rule-arthas-icebound-retaliate'] as const
const l = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const o = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const c = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
export function buildIceboundRetaliationGraph(id: string): GameplayModuleGraph {
  if (id !== 'rule-arthas-icebound-retaliate') throw new Error('Unknown retaliation rule ' + id)
  const body: GameplayStatement[] = []
  const require = (key: string, condition: GameplayValue) => body.push(c(key + '-not', 'logic.not', { value: condition }), { kind: 'if', id: key, condition: o(key + '-not', 'value'), then: [{ kind: 'return', id: key + '-fail', values: { success: l(false), message: l('') } }] })
  const capture = (name: string, field: string) => {
    body.push(c(name + '-ref', 'source.capture-event-piece', {}, { field }), c(name + '-exists', 'source.is-present', { source: o(name + '-ref', 'source') }))
    require(name + '-guard', o(name + '-exists', 'value'))
    body.push(c(name, 'source.require-present', { source: o(name + '-ref', 'source') }), c(name + '-id', 'source.captured-identifier', { source: o(name, 'source') }))
  }
  capture('defender', 'rulePiece'); capture('subject', 'piece')
  body.push(c('same', 'compare.text', { left: o('defender-id', 'value'), right: o('subject-id', 'value') }))
  require('same-guard', o('same', 'value'))
  body.push(c('damage', 'event.read-number', { fallback: l(0) }, { field: 'damage' }), c('positive', 'compare.greater-than', { left: o('damage', 'value'), right: l(0) }))
  require('damage-guard', o('positive', 'value'))
  body.push(c('status', 'source.captured-has-status', { source: o('defender', 'source') }, { statusType: 'icebound-fortitude' }))
  require('status-guard', o('status', 'value'))
  capture('attacker', 'targetPiece')
  body.push(c('hp', 'source.captured-number', { source: o('attacker', 'source') }, { field: 'currentHp' }), c('alive', 'compare.greater-than', { left: o('hp', 'value'), right: l(0) }))
  require('alive-guard', o('alive', 'value'))
  body.push(c('attacker-owner', 'source.captured-owner', { source: o('attacker', 'source') }), c('defender-owner', 'source.captured-owner', { source: o('defender', 'source') }), c('same-owner', 'compare.player-reference', { left: o('attacker-owner', 'player'), right: o('defender-owner', 'player') }), c('enemy', 'logic.not', { value: o('same-owner', 'value') }))
  require('enemy-guard', o('enemy', 'value'))
  body.push(c('attacker-board-ref', 'source.captured-piece-reference', { source: o('attacker', 'source') }), c('board', 'query.has-piece', { pieceId: o('attacker-board-ref', 'piece') }))
  require('board-guard', o('board', 'exists'))
  body.push(c('target', 'query.piece', { pieceId: o('attacker-board-ref', 'piece') }), c('tag-id', 'text.concat', { left: l('icebound-freeze-'), right: o('attacker-id', 'value') }), { kind: 'record.create', id: 'tag', schema: 'freeze@1', fields: { id: o('tag-id', 'text'), name: l('冰冻'), type: l('freeze'), currentDuration: l(1), intensity: l(1), relatedRules: l(['rule-freeze-prevent-move', 'rule-freeze-prevent-skill']) } }, c('apply', 'status.apply-record', { target: o('target', 'piece'), record: o('tag', 'value') }, { inputPolicy: 'host' }), c('move-rule', 'rule.apply-piece', { target: o('target', 'piece') }, { ruleId: 'rule-freeze-prevent-move' }), c('skill-rule', 'rule.apply-piece', { target: o('target', 'piece') }, { ruleId: 'rule-freeze-prevent-skill' }), c('name', 'piece.captured-name', { source: o('attacker', 'source') }), c('message', 'text.concat', { left: o('name', 'value'), right: l('被寒冰坚忍冰冻1回合') }), { kind: 'return', id: 'done', values: { success: l(true), message: o('message', 'text') } })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }], schemas: [{ id: 'freeze', version: '1', fields: [{ name: 'id', type: 'string' }, { name: 'name', type: 'string' }, { name: 'type', type: 'string' }, { name: 'currentDuration', type: 'number' }, { name: 'intensity', type: 'number' }, { name: 'relatedRules', type: { kind: 'list', element: 'string' } }] }], body }
}
export function migrateIceboundRetaliation(root: string, write = false): string[] {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries
  const ignored = new Set(['skillCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: { file: string; next: Record<string, unknown> }[] = []
  for (const id of ICEBOUND_RETALIATION_IDS) {
    const file = path.join(root, 'data/rules', id + '.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (current.gameplayModules?.entries?.skillCode) { assertGameplayModuleDocument(current); continue }
    const original = baseline['rules/' + id]
    assertFrozenExecutable(current, original, 'skillCode', 'rule', id)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!ignored.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    pending.push({ file, next: applyGameplayModuleGraph(current, buildIceboundRetaliationGraph(id), 'skillCode') })
  }
  if (write) for (const { file, next } of pending) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return pending.map(item => path.basename(item.file, '.json'))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(migrateIceboundRetaliation(process.cwd(), process.argv.includes('--write'))))
