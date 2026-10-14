import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'

type Recipe = { reference: 'source' | 'event-piece'; status: string; alive?: boolean; cleanup?: boolean; consume?: boolean; block?: boolean; scale?: number; positiveOnly?: boolean; suffix: string; numbers?: boolean; absorb?: boolean }
export const STATUS_EVENT_RECIPES: Record<string, Recipe> = {
  'rule-naruto-sage-tick': { reference: 'event-piece', status: 'sage-mode', alive: true, suffix: '' },
  'rule-watcher-shield': { reference: 'source', status: 'calm-shield', absorb: true, suffix: '的平静护盾格挡了' },
  'rule-divine-shield': { reference: 'source', status: 'divine-shield', consume: true, block: true, suffix: '的圣盾抵挡了这次伤害！' },
  'rule-naruto-sage-immunity': { reference: 'event-piece', status: 'sage-mode-shield', alive: true, cleanup: true, consume: true, block: true, suffix: '仙人之盾抵挡了一次伤害！' },
  'rule-arthas-icebound': { reference: 'event-piece', status: 'icebound-fortitude', scale: 0.5, positiveOnly: true, suffix: '的寒冰坚忍使伤害减少50%' },
  'rule-watcher-rage-dealt': { reference: 'source', status: 'rage-stance', scale: 2, suffix: '暴怒姿态：伤害翻倍！', numbers: true },
  'rule-watcher-rage-taken': { reference: 'event-piece', status: 'rage-stance', scale: 2, suffix: '处于暴怒姿态，受到双倍伤害！', numbers: true },
}
const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const out = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const fail = (id: string): GameplayStatement => ({ kind: 'return', id, values: { success: literal(false), message: literal('') } })

export function buildStatusEventGraph(id: string): GameplayModuleGraph {
  if (id === 'rule-naruto-sage-tick') return buildSageTimerGraph()
  const recipe = STATUS_EVENT_RECIPES[id]
  if (!recipe) throw new Error('Unknown status event ' + id)
  const body: GameplayStatement[] = []
  const require = (name: string, condition: GameplayValue, cleanup: GameplayStatement[] = []) => {
    body.push(call(name + '-not', 'logic.not', { value: condition }), { kind: 'if', id: name, condition: out(name + '-not', 'value'), then: [...cleanup, fail(name + '-return')] })
  }
  body.push(call('holder-ref', 'ref.holder'), call('exists', 'query.has-piece', { pieceId: out('holder-ref', 'piece') }))
  require('require-holder', out('exists', 'exists'))
  body.push(call('holder', 'query.piece', { pieceId: out('holder-ref', 'piece') }))
  const piece = out('holder', 'piece')
  if (recipe.alive) { body.push(call('hp', 'attribute.read', { piece }, { attribute: 'currentHp' }), call('alive', 'compare.greater-than', { left: out('hp', 'value'), right: literal(0) })); require('require-alive', out('alive', 'value')) }
  body.push(call('subject-ref', 'ref.' + recipe.reference), call('subject-exists', 'query.has-piece', { pieceId: out('subject-ref', 'piece') }))
  require('require-subject', out('subject-exists', 'exists'))
  body.push(call('subject', 'query.piece', { pieceId: out('subject-ref', 'piece') }), call('same', 'compare.equal-piece', { left: piece, right: out('subject', 'piece') }))
  require('require-same', out('same', 'value'))
  body.push(call('has-status', 'status.has-piece', { piece }, { statusType: recipe.status }))
  require('require-status', out('has-status', 'value'), recipe.cleanup ? [call('cleanup', 'rule.remove-piece', { target: piece }, { ruleId: id })] : [])
  if (recipe.absorb) {
    body.push(call('shield-id', 'status.find-id', { piece }, { statusType: recipe.status }), call('intensity', 'status.read-number', { piece, statusId: out('shield-id', 'id'), fallback: literal(0) }, { field: 'intensity' }), call('damage', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }), call('absorbed', 'math.min', { left: out('intensity', 'value'), right: out('damage', 'value') }), call('positive', 'compare.greater-than', { left: out('absorbed', 'value'), right: literal(0) }))
    require('require-positive', out('positive', 'value'))
    body.push(call('remaining-shield', 'math.subtract', { left: out('intensity', 'value'), right: out('absorbed', 'value') }), call('remaining-damage', 'math.subtract', { left: out('damage', 'value'), right: out('absorbed', 'value') }), call('save-shield', 'status.set-number', { piece, statusId: out('shield-id', 'id'), value: out('remaining-shield', 'value') }, { field: 'intensity' }), call('save-damage', 'event.write-number', { value: out('remaining-damage', 'value') }, { field: 'damage', inputPolicy: 'host' }), call('name', 'attribute.text', { piece }, { attribute: 'name' }), call('prefix', 'text.concat', { left: out('name', 'text'), right: literal(recipe.suffix) }), call('absorbed-text', 'text.from-number', { value: out('absorbed', 'value') }), call('damage-text', 'text.concat', { left: out('prefix', 'text'), right: out('absorbed-text', 'text') }), call('message', 'text.concat', { left: out('damage-text', 'text'), right: literal('点伤害') }), call('still-active', 'compare.greater-than', { left: out('remaining-shield', 'value'), right: literal(0) }), {
      kind: 'if', id: 'remaining-or-broken', condition: out('still-active', 'value'), then: [
        call('remaining-prefix', 'text.concat', { left: out('message', 'text'), right: literal('，剩余护盾') }), call('remaining-number', 'text.from-number', { value: out('remaining-shield', 'value') }), call('remaining-count', 'text.concat', { left: out('remaining-prefix', 'text'), right: out('remaining-number', 'text') }), call('remaining-text', 'text.concat', { left: out('remaining-count', 'text'), right: literal('点') }), { kind: 'return', id: 'remaining-result', values: { success: literal(true), message: out('remaining-text', 'text') } },
      ], else: [
        call('consume', 'status.remove-id', { piece, statusId: out('shield-id', 'id') }), call('remove-rule', 'rule.remove-piece', { target: piece }, { ruleId: id }), call('broken-text', 'text.concat', { left: out('message', 'text'), right: literal('，护盾破碎') }), { kind: 'return', id: 'broken-result', values: { success: literal(true), message: out('broken-text', 'text') } },
      ],
    })
    return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }], body }
  }
  if (recipe.consume) body.push(call('status-id', 'status.find-id', { piece }, { statusType: recipe.status }), call('consume', 'status.remove-id', { piece, statusId: out('status-id', 'id') }), call('remove-rule', 'rule.remove-piece', { target: piece }, { ruleId: id }))
  if (recipe.scale !== undefined) {
    body.push(call('damage', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }), call('scaled', 'math.multiply', { left: out('damage', 'value'), right: literal(recipe.scale) }))
    const modify: GameplayStatement[] = [call('write-damage', 'event.write-number', { value: out('scaled', 'value') }, { field: 'damage', inputPolicy: recipe.positiveOnly ? 'floor' : 'host' })]
    if (recipe.positiveOnly) body.push(call('positive', 'compare.greater-than', { left: out('damage', 'value'), right: literal(0) }), { kind: 'if', id: 'modify-positive', condition: out('positive', 'value'), then: modify })
    else body.push(...modify)
  }
  body.push(call('name', 'attribute.text', { piece }, { attribute: 'name' }), call('message', 'text.concat', { left: out('name', 'text'), right: literal(recipe.suffix) }))
  let message = out('message', 'text')
  if (recipe.numbers) {
    body.push(call('before-text', 'text.from-number', { value: out('damage', 'value') }), call('after-text', 'text.from-number', { value: out('scaled', 'value') }))
    for (const [i, part] of [out('before-text', 'text'), literal('→'), out('after-text', 'text'), literal('点')].entries()) { body.push(call('message-' + i, 'text.concat', { left: message, right: part })); message = out('message-' + i, 'text') }
  }
  body.push({ kind: 'return', id: 'result', values: { success: literal(true), ...(recipe.block ? { blocked: literal(true) } : {}), message } })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: [{ name: 'success', type: 'boolean' }, { name: 'blocked', type: 'boolean', optional: true }, { name: 'message', type: 'string' }], body }
}

function buildSageTimerGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const require = (id: string, condition: GameplayValue, cleanup: GameplayStatement[] = []) => body.push(call(id + '-not', 'logic.not', { value: condition }), { kind: 'if', id, condition: out(id + '-not', 'value'), then: [...cleanup, fail(id + '-return')] })
  body.push(call('holder-ref', 'ref.holder'), call('exists', 'query.has-piece', { pieceId: out('holder-ref', 'piece') }))
  require('require-holder', out('exists', 'exists'))
  body.push(call('holder', 'query.piece', { pieceId: out('holder-ref', 'piece') }))
  const piece = out('holder', 'piece')
  body.push(call('hp', 'attribute.read', { piece }, { attribute: 'currentHp' }), call('alive', 'compare.greater-than', { left: out('hp', 'value'), right: literal(0) }))
  require('require-alive', out('alive', 'value'))
  body.push(call('owner', 'piece.owner', { piece }), call('event-player', 'ref.event-player'), call('own-turn', 'compare.player-reference', { left: out('owner', 'player'), right: out('event-player', 'player') }))
  require('require-own-turn', out('own-turn', 'value'))
  body.push(call('has-status', 'status.has-piece', { piece }, { statusType: 'sage-mode' }))
  require('require-status', out('has-status', 'value'), [call('cleanup', 'rule.remove-piece', { target: piece }, { ruleId: 'rule-naruto-sage-tick' })])
  body.push(call('tag', 'status.find-id', { piece }, { statusType: 'sage-mode' }), call('progress', 'status.read-number', { piece, statusId: out('tag', 'id'), fallback: literal(6) }, { field: 'stacks' }), call('owned', 'query.pieces', { ownerId: out('owner', 'player') }), {
    kind: 'collection.reduce', id: 'clone-count', items: out('owned', 'pieces'), initial: literal(0),
    body: [call('clone', 'status.has-piece', { piece: { kind: 'input', name: 'item' } }, { statusType: 'naruto-clone' }), {
      kind: 'if', id: 'count-clone', condition: out('clone', 'value'), then: [call('increment', 'math.add', { left: { kind: 'input', name: 'accumulator' }, right: literal(1) }), { kind: 'return', id: 'incremented', value: out('increment', 'value') }],
    }, { kind: 'return', id: 'unchanged', value: { kind: 'input', name: 'accumulator' } }],
  }, call('decrement', 'math.add', { left: out('clone-count', 'value'), right: literal(1) }), call('remaining', 'math.subtract', { left: out('progress', 'value'), right: out('decrement', 'value') }), call('clamped', 'math.max', { left: out('remaining', 'value'), right: literal(0) }), call('save-progress', 'status.set-number', { piece, statusId: out('tag', 'id'), value: out('clamped', 'value') }, { field: 'stacks' }), call('name', 'attribute.text', { piece }, { attribute: 'name' }), call('not-ready', 'compare.greater-than', { left: out('clamped', 'value'), right: literal(0) }), {
    kind: 'if', id: 'preparing', condition: out('not-ready', 'value'), then: [
      call('prefix', 'text.concat', { left: out('name', 'text'), right: literal('仙人模式还剩') }), call('number', 'text.from-number', { value: out('clamped', 'value') }), call('remaining-text', 'text.concat', { left: out('prefix', 'text'), right: out('number', 'text') }), call('message', 'text.concat', { left: out('remaining-text', 'text'), right: literal('点准备进度') }), { kind: 'return', id: 'waiting', values: { success: literal(true), message: out('message', 'text') } },
    ],
  }, call('shield', 'status.find-id', { piece }, { statusType: 'sage-mode-shield' }), call('remove-shield', 'status.remove-id', { piece, statusId: out('shield', 'id') }), call('remove-mode', 'status.remove-id', { piece, statusId: out('tag', 'id') }), call('player-exists', 'query.has-player', { playerId: out('owner', 'player') }), {
    kind: 'if', id: 'reward-player', condition: out('player-exists', 'exists'), then: [call('action-points', 'resource.adjust', { player: out('owner', 'player'), amount: literal(3) }, { resource: 'actionPoints' }), call('charge-points', 'resource.adjust', { player: out('owner', 'player'), amount: literal(1) }, { resource: 'chargePoints' })],
  }, call('complete-text', 'text.concat', { left: out('name', 'text'), right: literal('仙人模式完成！获得3行动点和1充能点') }), { kind: 'return', id: 'completed', values: { success: literal(true), message: out('complete-text', 'text') } })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }], body }
}

export function migrateStatusEvents(root: string, write = false): string[] {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries
  const ignored = new Set(['skillCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: { file: string; next: Record<string, unknown> }[] = []
  for (const id of Object.keys(STATUS_EVENT_RECIPES)) {
    const file = path.join(root, 'data/rules', id + '.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (current.gameplayModules?.entries?.skillCode) { assertGameplayModuleDocument(current); continue }
    const original = baseline['rules/' + id]
    assertFrozenExecutable(current, original, 'skillCode', 'rule', id)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!ignored.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    pending.push({ file, next: applyGameplayModuleGraph(current, buildStatusEventGraph(id), 'skillCode') })
  }
  if (write) for (const { file, next } of pending) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return pending.map(item => path.basename(item.file, '.json'))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(migrateStatusEvents(process.cwd(), process.argv.includes('--write'))))
