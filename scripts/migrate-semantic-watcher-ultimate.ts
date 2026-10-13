import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'
const l = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const o = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const c = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
export function buildWatcherUltimateGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    c('holder', 'ref.holder'), c('source', 'query.piece', { pieceId: o('holder', 'piece') }),
    c('owner', 'piece.owner', { piece: o('source', 'piece') }), c('exists', 'query.has-player', { playerId: o('owner', 'player') }),
    c('missing', 'logic.not', { value: o('exists', 'exists') }),
    { kind: 'if', id: 'missing-player', condition: o('missing'), then: [c('no-player', 'result.action', { success: l(false), message: l('找不到玩家') }), { kind: 'return', id: 'no-player-return', value: o('no-player', 'result') }] },
    c('calm', 'local.counter-create', { initial: l(0) }), c('rage', 'local.counter-create', { initial: l(0) }),
    // Hand capacity is ten. Add/trigger rules may reject or remove an accepted
    // card more than once, so keep an explicit finite safety ceiling instead of
    // assuming a single retry. The condition still rechecks the authoritative
    // hand after every effectful iteration.
    { kind: 'while', id: 'fill-hand', index: 'iteration', budget: 256, condition: {
      inputs: { player: o('owner', 'player') },
      body: [
        c('while-size', 'card.hand-count', { player: { kind: 'input', name: 'player' } }),
        c('while-room', 'compare.less-than', { left: o('while-size'), right: l(10) }),
        { kind: 'return', id: 'while-result', value: o('while-room') },
      ],
    }, body: [
      c('iteration-parity', 'math.modulo', { left: o('fill-hand', 'index'), right: l(2) }),
      c('iteration-calm', 'compare.equal', { left: o('iteration-parity'), right: l(0) }),
      { kind: 'if', id: 'card-kind', condition: o('iteration-calm'), then: [
        c('add-calm', 'card.hand-add', { player: o('owner', 'player') }, { cardId: 'watcher-calm' }),
        c('count-calm', 'local.counter-add', { counter: o('calm', 'counter'), amount: l(1) }),
      ], else: [
        c('add-rage', 'card.hand-add', { player: o('owner', 'player') }, { cardId: 'watcher-rage' }),
        c('count-rage', 'local.counter-add', { counter: o('rage', 'counter'), amount: l(1) }),
      ] },
    ] },
    c('calm-count', 'local.counter-read', { counter: o('calm', 'counter') }), c('rage-count', 'local.counter-read', { counter: o('rage', 'counter') }),
    c('total', 'math.add', { left: o('calm-count'), right: o('rage-count') }), c('empty', 'compare.equal', { left: o('total'), right: l(0) }),
    c('name', 'attribute.text', { piece: o('source', 'piece') }, { attribute: 'name' }),
    { kind: 'if', id: 'no-additions', condition: o('empty'), then: [
      c('full-text', 'text.concat', { left: o('name', 'text'), right: l('手牌已满，无法使用潦草急救') }),
      c('full-result', 'result.action', { success: l(false), message: o('full-text', 'text') }), { kind: 'return', id: 'full-return', value: o('full-result', 'result') },
    ] },
    c('calm-text', 'text.from-number', { value: o('calm-count') }), c('rage-text', 'text.from-number', { value: o('rage-count') }),
  ]
  let message: GameplayValue = o('name', 'text')
  const parts = [l('释放潦草急救，手牌被平静('), o('calm-text', 'text'), l(')和暴怒('), o('rage-text', 'text'), l(')填满')]
  parts.forEach((part, index) => { body.push(c('text-' + index, 'text.concat', { left: message, right: part })); message = o('text-' + index, 'text') })
  body.push(c('result', 'result.action', { success: l(true), message }), { kind: 'return', id: 'done', value: o('result', 'result') })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'result', type: 'record', nullable: true }], body }
}

export function migrateWatcherUltimate(root: string, write = false): void {
  const file = path.join(root, 'data/skills/watcher-ultimate.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
  const original = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries['skills/watcher-ultimate']
  if (current.gameplayModules?.entries?.code) {
    assertGameplayModuleDocument(current)
    const updated = applyGameplayModuleGraph(current, buildWatcherUltimateGraph())
    if (write && JSON.stringify(updated) !== JSON.stringify(current)) fs.writeFileSync(file, JSON.stringify(updated, null, 2) + '\n')
    return
  }
  assertFrozenExecutable(current, original, 'code', 'skill', 'watcher-ultimate')
  const generated = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!generated.has(key) && JSON.stringify(current[key]) !== JSON.stringify(original[key])) throw new Error(`watcher-ultimate: changed compatibility field ${key}`)
  const next = applyGameplayModuleGraph(current, buildWatcherUltimateGraph())
  if (write) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) migrateWatcherUltimate(process.cwd(), process.argv.includes('--write'))
