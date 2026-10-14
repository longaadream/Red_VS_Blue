import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'
export const HAND_GRANT_SKILL_IDS = ['elune-blessing', 'initial-draw'] as const
const l = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const o = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const c = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
export function buildHandGrantGraph(id: string): GameplayModuleGraph {
  if (id === 'initial-draw') return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'triggerSkill', outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }], body: [
    c('players', 'query.players'), { kind: 'foreach', id: 'each-player', items: o('players', 'players'), body: [{ kind: 'foreach', id: 'each-card', items: l([0, 1, 2]), body: [c('random', 'query.random-string', { items: l(['sample-active-card', 'sample-reactive-card']) }), c('add', 'card.hand-add-ref', { player: o('each-player', 'item'), cardId: o('random', 'value') })] }] }, { kind: 'return', id: 'done', values: { success: l(true), message: l('所有玩家抽了3张初始手牌') } },
  ] }
  if (id !== 'elune-blessing') throw new Error('Unknown grant ' + id)
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', schemas: [{ id: 'buff', version: '1', fields: [{ name: 'multiplier', type: 'number' }, { name: 'uses', type: 'number' }] }], outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }], body: [
    c('source-ref', 'ref.holder'), c('source', 'query.piece', { pieceId: o('source-ref', 'piece') }), c('name', 'attribute.text', { piece: o('source', 'piece') }, { attribute: 'name' }), c('owner-ref', 'piece.owner', { piece: o('source', 'piece') }), c('exists', 'query.has-player', { playerId: o('owner-ref', 'player') }), c('missing', 'logic.not', { value: o('exists', 'exists') }), { kind: 'if', id: 'owner-guard', condition: o('missing', 'value'), then: [{ kind: 'return', id: 'no-owner', values: { success: l(false), message: l('找不到玩家') } }] }, c('owner', 'query.player', { playerId: o('owner-ref', 'player') }),
    c('random', 'query.random-string', { items: l(['holy-smite', 'holy-heal', 'holy-charge']) }), c('add', 'card.hand-add-ref', { player: o('owner', 'player'), cardId: o('random', 'value') }), { kind: 'record.create', id: 'buff', schema: 'buff@1', fields: { multiplier: l(1.5), uses: l(1) } }, c('set-buff', 'player.set-buff-record', { player: o('owner', 'player'), record: o('buff', 'value') }, { buffId: 'elune-blessing-buff' }), c('message', 'text.concat', { left: o('name', 'text'), right: l('获得月神赐福，得到1张圣光手牌，下一张圣光手牌效果提高50%') }), { kind: 'return', id: 'done', values: { success: l(true), message: o('message', 'text') } },
  ] }
}
export function migrateHandGrants(root: string, write = false): string[] {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries
  const ignored = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: { file: string; next: Record<string, unknown> }[] = []
  for (const id of HAND_GRANT_SKILL_IDS) {
    const file = path.join(root, 'data/skills', id + '.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (current.gameplayModules?.entries?.code) { assertGameplayModuleDocument(current); continue }
    const original = baseline['skills/' + id], graph = buildHandGrantGraph(id)
    assertFrozenExecutable(current, original, 'code', graph.surface, id)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!ignored.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    pending.push({ file, next: applyGameplayModuleGraph(current, graph) })
  }
  if (write) for (const { file, next } of pending) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return pending.map(item => path.basename(item.file, '.json'))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(migrateHandGrants(process.cwd(), process.argv.includes('--write'))))
