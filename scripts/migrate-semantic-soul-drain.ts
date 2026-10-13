import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'
const l = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const o = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const c = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
function message(body: GameplayStatement[], prefix: string, parts: GameplayValue[]): GameplayValue {
  let text = l('')
  parts.forEach((part, index) => { body.push(c(prefix + index, 'text.concat', { left: text, right: part })); text = o(prefix + index, 'text') })
  return text
}
export function buildSoulDrainGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    c('holder', 'ref.holder'), c('source', 'query.piece', { pieceId: o('holder', 'piece') }), c('saved-source', 'source.capture', { source: o('source', 'piece') }),
    c('owner', 'source.captured-owner', { source: o('saved-source', 'source') }), c('enemies', 'query.pieces', { ownerId: o('owner', 'player') }, { relation: 'enemy', includeDead: false }),
    c('count', 'collection.piece-count', { pieces: o('enemies', 'pieces') }), c('empty', 'compare.equal', { left: o('count'), right: l(0) }),
    { kind: 'if', id: 'empty-check', condition: o('empty'), then: [{ kind: 'return', id: 'no-enemies', values: { success: l(false), message: l('没有存活的敌方棋子') } }] },
    c('weakest', 'query.lowest-hp', { pieces: o('enemies', 'pieces') }), c('target', 'query.piece', { pieceId: o('weakest', 'piece') }), c('saved-target', 'source.capture', { source: o('target', 'piece') }),
    c('max-hp', 'attribute.read', { piece: o('target', 'piece') }, { attribute: 'maxHp' }),
    c('scaled', 'math.multiply', { left: o('max-hp'), right: l(0.3) }), c('floored', 'math.floor', { value: o('scaled') }), c('splash', 'math.max', { left: l(1), right: o('floored') }),
    c('kill', 'effect.damage-captured', { source: o('saved-source', 'source'), target: o('saved-target', 'source'), amount: l(999) }, { damageType: 'true', skillId: 'kiljaedan-soul-drain' }),
    c('name', 'piece.captured-name', { source: o('saved-source', 'source') }), c('target-name', 'piece.captured-name', { source: o('saved-target', 'source') }),
    c('max-text', 'text.from-number', { value: o('max-hp') }), c('splash-text', 'text.from-number', { value: o('splash') }),
  ]
  const prefix = message(body, 'prefix-', [o('name'), l('对以下目标使用了灵魂汲取：'), o('target-name'), l('（以其maxHp='), o('max-text', 'text'), l('x30%='), o('splash-text', 'text'), l('）')])
  body.push(c('current-owner', 'source.captured-owner', { source: o('saved-source', 'source') }), c('remaining', 'query.pieces', { ownerId: o('current-owner', 'player') }, { relation: 'enemy', includeDead: false }), c('remaining-count', 'collection.piece-count', { pieces: o('remaining', 'pieces') }), c('has-remaining', 'compare.greater-than', { left: o('remaining-count'), right: l(0) }))
  const splash: GameplayStatement[] = [c('batch', 'effect.damage-many-captured', { source: o('saved-source', 'source'), targets: o('remaining', 'pieces'), amount: o('splash') }, { damageType: 'magical' }), c('count-text', 'text.from-number', { value: o('remaining-count') })]
  const splashMessage = message(splash, 'splash-message-', [prefix, l('，随后对'), o('count-text', 'text'), l('个存活敌方棋子各造成'), o('splash-text', 'text'), l('点法术伤害')])
  splash.push({ kind: 'return', id: 'splash-result', values: { success: l(true), message: splashMessage } })
  body.push({ kind: 'if', id: 'remaining-check', condition: o('has-remaining'), then: splash }, c('no-remaining-message', 'text.concat', { left: prefix, right: l('（没有存活敌人）') }), { kind: 'return', id: 'done', values: { success: l(true), message: o('no-remaining-message', 'text') } })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }], body }
}
export function migrateSoulDrain(root: string, write = false): void {
  const file = path.join(root, 'data/skills/kiljaedan-soul-drain.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (current.gameplayModules?.entries?.code) { assertGameplayModuleDocument(current); return }
  const original = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries['skills/kiljaedan-soul-drain']
  assertFrozenExecutable(current, original, 'code', 'skill', 'kiljaedan-soul-drain')
  const generated = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!generated.has(key) && JSON.stringify(current[key]) !== JSON.stringify(original[key])) throw new Error(`kiljaedan-soul-drain: changed compatibility field ${key}`)
  const next = applyGameplayModuleGraph(current, buildSoulDrainGraph())
  if (write) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) migrateSoulDrain(process.cwd(), process.argv.includes('--write'))
