import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'
export const DEATH_CARD_RULE_IDS = ['rule-soul-fracture', 'rule-soul-fracture-player'] as const
const l = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const o = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const c = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
export function buildDeathCardRuleGraph(id: string): GameplayModuleGraph {
  const player = id === 'rule-soul-fracture-player'
  if (!(DEATH_CARD_RULE_IDS as readonly string[]).includes(id)) throw new Error('Unknown death card rule ' + id)
  const body: GameplayStatement[] = []
  const require = (key: string, condition: GameplayValue) => body.push(c(key + '-not', 'logic.not', { value: condition }), { kind: 'if', id: key, condition: o(key + '-not', 'value'), then: [{ kind: 'return', id: key + '-fail', values: { success: l(false) } }] })
  const capture = (name: string, field: string) => {
    body.push(c(name + '-ref', 'source.capture-event-piece', {}, { field }), c(name + '-exists', 'source.is-present', { source: o(name + '-ref', 'source') }))
    require(name + '-guard', o(name + '-exists', 'value'))
    body.push(c(name, 'source.require-present', { source: o(name + '-ref', 'source') }))
  }
  if (!player) capture('holder', 'rulePiece')
  capture('dead', 'sourcePiece')
  if (player) {
    body.push(c('owner-ref', 'ref.event-player'), c('owner-exists', 'query.has-player', { playerId: o('owner-ref', 'player') }))
    require('owner-guard', o('owner-exists', 'exists'))
    body.push(c('owner', 'query.player', { playerId: o('owner-ref', 'player') }))
  } else body.push(c('owner', 'source.captured-owner', { source: o('holder', 'source') }))
  body.push(c('add-card', 'card.hand-add', { player: o('owner', 'player') }, { cardId: 'soul-fragment' }), c('dead-name', 'piece.captured-name', { source: o('dead', 'source') }, { fallback: player ? 'templateId' : 'none' }))
  if (!player) body.push(c('holder-name', 'piece.captured-name', { source: o('holder', 'source') }))
  const parts = player ? [l('裂魂：'), o('dead-name', 'value'), l('死亡，你获得1张灵魂残片')] : [o('holder-name', 'value'), l('的裂魂触发：'), o('dead-name', 'value'), l('死亡，获得一张灵魂残片')]
  let text = l('')
  parts.forEach((part, index) => { body.push(c('message-' + index, 'text.concat', { left: text, right: part })); text = o('message-' + index, 'text') })
  if (!player) body.push(c('log', 'log.trigger-effect', { player: o('owner', 'player'), message: text }))
  body.push({ kind: 'return', id: 'done', values: { success: l(true), message: text } })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string', optional: true }], body }
}
export function migrateDeathCardRules(root: string, write = false): string[] {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries
  const ignored = new Set(['skillCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: { file: string; next: Record<string, unknown> }[] = []
  for (const id of DEATH_CARD_RULE_IDS) {
    const file = path.join(root, 'data/rules', id + '.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (current.gameplayModules?.entries?.skillCode) { assertGameplayModuleDocument(current); continue }
    const original = baseline['rules/' + id]
    assertFrozenExecutable(current, original, 'skillCode', 'rule', id)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!ignored.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    pending.push({ file, next: applyGameplayModuleGraph(current, buildDeathCardRuleGraph(id), 'skillCode') })
  }
  if (write) for (const { file, next } of pending) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return pending.map(item => path.basename(item.file, '.json'))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(migrateDeathCardRules(process.cwd(), process.argv.includes('--write'))))
