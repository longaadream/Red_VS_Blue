import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'

export const RECOVERY_RULE_IDS = ['rule-shishio-no-heal', 'rule-hashirama-edo-regen', 'rule-shelly-bandage', 'rule-tirion-divine-glory', 'rule-tirion-divine-shield-start'] as const
const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const out = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
export function buildRecoveryRuleGraph(id: string): GameplayModuleGraph {
  if (id.startsWith('rule-tirion-')) return buildTirionGraph(id)
  if (id === 'rule-shelly-bandage') return buildBandageGraph()
  const body: GameplayStatement[] = []
  const require = (name: string, condition: GameplayValue) => body.push(call(name + '-not', 'logic.not', { value: condition }), { kind: 'if', id: name, condition: out(name + '-not', 'value'), then: [{ kind: 'return', id: name + '-return', values: { success: literal(false), ...(id === 'rule-shishio-no-heal' ? {} : { message: literal('') }) } }] })
  body.push(call('holder-ref', 'ref.holder'), call('exists', 'query.has-piece', { pieceId: out('holder-ref', 'piece') }))
  require('require-holder', out('exists', 'exists'))
  body.push(call('holder', 'query.piece', { pieceId: out('holder-ref', 'piece') }))
  const piece = out('holder', 'piece')
  if (id === 'rule-shishio-no-heal') {
    body.push(call('subject-ref', 'ref.event-piece'), call('subject-exists', 'query.has-piece', { pieceId: out('subject-ref', 'piece') }))
    require('require-subject', out('subject-exists', 'exists'))
    body.push(call('subject', 'query.piece', { pieceId: out('subject-ref', 'piece') }), call('same', 'compare.equal-piece', { left: piece, right: out('subject', 'piece') }))
    require('require-same', out('same', 'value'))
    body.push(call('block-heal', 'event.write-number', { value: literal(0) }, { field: 'heal', inputPolicy: 'host' }), call('name', 'attribute.text', { piece }, { attribute: 'name' }), call('message', 'text.concat', { left: out('name', 'text'), right: literal(' 自燃之躯：无法被治疗！') }), { kind: 'return', id: 'blocked', values: { success: literal(true), blocked: literal(true), message: out('message', 'text') } })
  } else if (id === 'rule-hashirama-edo-regen') {
    body.push(call('owner', 'piece.owner', { piece }), call('turn-owner', 'turn.current-player'), call('own-turn', 'compare.player-reference', { left: out('owner', 'player'), right: out('turn-owner', 'player') }))
    require('require-own-turn', out('own-turn', 'value'))
    body.push(call('hp', 'attribute.read', { piece }, { attribute: 'currentHp' }), call('max-hp', 'attribute.read', { piece }, { attribute: 'maxHp' }), call('alive', 'compare.greater-than', { left: out('hp', 'value'), right: literal(0) }))
    require('require-alive', out('alive', 'value'))
    body.push(call('half', 'math.multiply', { left: out('max-hp', 'value'), right: literal(0.5) }), call('half-floor', 'math.floor', { value: out('half', 'value') }), call('below-half', 'compare.less-than', { left: out('hp', 'value'), right: out('half-floor', 'value') }))
    require('require-below-half', out('below-half', 'value'))
    body.push(call('next-hp', 'math.add', { left: out('hp', 'value'), right: literal(2) }), call('write-hp', 'attribute.set-current-hp', { piece, value: out('next-hp', 'value') }), call('name', 'attribute.text', { piece }, { attribute: 'name' }), call('hp-text', 'text.from-number', { value: out('next-hp', 'value') }), call('max-text', 'text.from-number', { value: out('max-hp', 'value') }))
    let message = out('name', 'text')
    ;[literal(' 秽土转生自愈 2 点（'), out('hp-text', 'text'), literal('/'), out('max-text', 'text'), literal('）')].forEach((part, index) => { const key = 'message-' + index; body.push(call(key, 'text.concat', { left: message, right: part })); message = out(key, 'text') })
    body.push({ kind: 'return', id: 'healed', values: { success: literal(true), message } })
  } else throw new Error('Unknown recovery rule ' + id)
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string', optional: true }, { name: 'blocked', type: 'boolean', optional: true }], body }
}

function buildBandageGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const require = (key: string, condition: GameplayValue) => body.push(call(key + '-not', 'logic.not', { value: condition }), { kind: 'if', id: key, condition: out(key + '-not', 'value'), then: [{ kind: 'return', id: key + '-result', values: { success: literal(false), message: literal('') } }] })
  body.push(call('holder-ref', 'ref.holder'), call('exists', 'query.has-piece', { pieceId: out('holder-ref', 'piece') }))
  require('require-holder', out('exists', 'exists'))
  body.push(call('holder', 'query.piece', { pieceId: out('holder-ref', 'piece') }), call('subject-ref', 'ref.event-piece'), call('subject-exists', 'query.has-piece', { pieceId: out('subject-ref', 'piece') }))
  require('require-subject', out('subject-exists', 'exists'))
  const piece = out('holder', 'piece')
  body.push(call('subject', 'query.piece', { pieceId: out('subject-ref', 'piece') }), call('same', 'compare.equal-piece', { left: piece, right: out('subject', 'piece') }))
  require('require-same', out('same', 'value'))
  body.push(call('damage', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }), call('positive', 'compare.greater-than', { left: out('damage', 'value'), right: literal(0) }))
  require('require-damage', out('positive', 'value'))
  body.push(call('hp', 'attribute.read', { piece }, { attribute: 'currentHp' }), call('alive', 'compare.greater-than', { left: out('hp', 'value'), right: literal(0) }), call('low', 'compare.less-or-equal', { left: out('hp', 'value'), right: literal(6) }))
  require('require-alive', out('alive', 'value')); require('require-low', out('low', 'value'))
  body.push(call('spent', 'ability.was-spent', { piece }, { abilityId: 'shelly-bandage' }), call('available', 'logic.not', { value: out('spent', 'value') }))
  require('require-available', out('available', 'value'))
  body.push(call('consume', 'ability.mark-spent', { piece }, { abilityId: 'shelly-bandage' }), call('max', 'attribute.read', { piece }, { attribute: 'maxHp' }), call('plus', 'math.add', { left: out('hp', 'value'), right: literal(4) }), call('next', 'math.min', { left: out('max', 'value'), right: out('plus', 'value') }), call('write', 'attribute.set-current-hp', { piece, value: out('next', 'value') }), call('identity', 'piece.identifier', { piece }), call('status-id', 'text.concat', { left: literal('shelly-bandage-used-'), right: out('identity', 'id') }), { kind: 'record.create', id: 'status', schema: 'bandage-record@1', fields: { id: out('status-id', 'text'), type: literal('shelly-bandage-used'), name: literal('止血绷带已触发'), stacks: literal(1), currentDuration: literal(-1), currentUses: literal(-1) } }, call('apply-status', 'status.apply-record', { target: piece, record: out('status', 'value') }, { inputPolicy: 'host' }), call('name', 'attribute.text', { piece }, { attribute: 'name' }), call('restored', 'math.subtract', { left: out('next', 'value'), right: out('hp', 'value') }), call('amount-text', 'text.from-number', { value: out('restored', 'value') }), call('prefix', 'text.concat', { left: out('name', 'text'), right: literal('触发止血绷带，恢复') }), call('number', 'text.concat', { left: out('prefix', 'text'), right: out('amount-text', 'text') }), call('message', 'text.concat', { left: out('number', 'text'), right: literal('点生命') }), { kind: 'return', id: 'success', values: { success: literal(true), message: out('message', 'text') } })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }], schemas: [{ id: 'bandage-record', version: '1', fields: [{ name: 'id', type: 'string' }, { name: 'type', type: 'string' }, { name: 'name', type: 'string' }, { name: 'stacks', type: 'number' }, { name: 'currentDuration', type: 'number' }, { name: 'currentUses', type: 'number' }] }], body }
}

function buildTirionGraph(id: string): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const shield = { id: 'divine-shield', type: 'divine-shield', name: '圣盾', currentDuration: -1, currentUses: -1, intensity: 1, stacks: 1, relatedRules: ['rule-divine-shield'] }
  const require = (key: string, condition: GameplayValue) => body.push(call(key + '-not', 'logic.not', { value: condition }), { kind: 'if', id: key, condition: out(key + '-not', 'value'), then: [{ kind: 'return', id: key + '-result', values: { success: literal(false), message: literal('') } }] })
  body.push(call('holder-ref', 'ref.holder'), call('exists', 'query.has-piece', { pieceId: out('holder-ref', 'piece') }))
  require('require-holder', out('exists', 'exists'))
  body.push(call('holder', 'query.piece', { pieceId: out('holder-ref', 'piece') }), call('source-ref', 'ref.source'), call('source-exists', 'query.has-piece', { pieceId: out('source-ref', 'piece') }))
  require('require-source', out('source-exists', 'exists'))
  const piece = out('holder', 'piece')
  body.push(call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }), call('same', 'compare.equal-piece', { left: piece, right: out('source', 'piece') }))
  require('require-same', out('same', 'value'))
  if (id === 'rule-tirion-divine-glory') {
    body.push(call('hp', 'attribute.read', { piece }, { attribute: 'currentHp' }), call('alive', 'compare.greater-than', { left: out('hp', 'value'), right: literal(0) }))
    require('require-alive', out('alive', 'value'))
    body.push(call('type', 'event.status-text', {}, { field: 'statusType' }), call('id', 'event.status-text', {}, { field: 'statusId' }), call('type-match', 'compare.text', { left: out('type', 'value'), right: literal('divine-shield') }), call('id-match', 'compare.text', { left: out('id', 'value'), right: literal('divine-shield') }), call('match', 'logic.or', { left: out('type-match', 'value'), right: out('id-match', 'value') }))
    require('require-shield', out('match', 'value'))
    body.push(call('increase', 'attribute.adjust', { piece, amount: literal(1) }, { attribute: 'attack' }))
  } else {
    body.push(call('has-shield', 'status.has-piece', { piece }, { statusType: 'divine-shield' }), call('no-shield', 'logic.not', { value: out('has-shield', 'value') }))
    require('require-no-shield', out('no-shield', 'value'))
    body.push({ kind: 'record.create', id: 'shield-record', schema: 'shield@1', fields: Object.fromEntries(Object.entries(shield).map(([key, value]) => [key, literal(value)])) }, call('apply', 'status.apply-record', { target: piece, record: out('shield-record', 'value') }, { inputPolicy: 'host' }), call('has-rule', 'rule.has-piece', { piece }, { ruleId: 'rule-divine-shield' }), call('missing-rule', 'logic.not', { value: out('has-rule', 'value') }), { kind: 'if', id: 'ensure-rule', condition: out('missing-rule', 'value'), then: [call('rule', 'rule.apply-piece', { target: piece }, { ruleId: 'rule-divine-shield' })] })
  }
  body.push(call('name', 'attribute.text', { piece }, { attribute: 'name' }), call('message', 'text.concat', { left: out('name', 'text'), right: literal(id === 'rule-tirion-divine-glory' ? '失去圣盾，攻击力+1' : '散发出神圣光辉，获得圣盾保护！') }), { kind: 'return', id: 'success', values: { success: literal(true), message: out('message', 'text') } })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', schemas: [{ id: 'shield', version: '1', fields: Object.entries(shield).map(([name, value]) => ({ name, type: Array.isArray(value) ? { kind: 'list' as const, element: 'string' as const } : typeof value === 'number' ? 'number' as const : 'string' as const })) }], outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }], body }
}

export function migrateRecoveryRules(root: string, write = false): string[] {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries
  const ignored = new Set(['skillCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: { file: string; next: Record<string, unknown> }[] = []
  for (const id of RECOVERY_RULE_IDS) {
    const file = path.join(root, 'data/rules', id + '.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (current.gameplayModules?.entries?.skillCode) { assertGameplayModuleDocument(current); continue }
    const original = baseline['rules/' + id]
    assertFrozenExecutable(current, original, 'skillCode', 'rule', id)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!ignored.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    pending.push({ file, next: applyGameplayModuleGraph(current, buildRecoveryRuleGraph(id), 'skillCode') })
  }
  if (write) for (const { file, next } of pending) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return pending.map(item => path.basename(item.file, '.json'))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(migrateRecoveryRules(process.cwd(), process.argv.includes('--write'))))

