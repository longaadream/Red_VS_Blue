import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'

export const DEATH_GUARD_RULE_IDS = ['rule-hidan-undying', 'rule-hidan-dying-immune', 'rule-obito-kamui-block'] as const
const l = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const o = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const c = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const ret = (id: string, success: boolean, message: GameplayValue = l(''), blocked = false): GameplayStatement => ({ kind: 'return', id, values: { success: l(success), message, ...(blocked ? { blocked: l(true) } : {}) } })
function message(body: GameplayStatement[], id: string, parts: GameplayValue[]): GameplayValue {
  let value = l('')
  parts.forEach((part, index) => { const key = id + index; body.push(c(key, 'text.concat', { left: value, right: part })); value = o(key, 'text') })
  return value
}
export function buildDeathGuardGraph(id: string): GameplayModuleGraph {
  if (!(DEATH_GUARD_RULE_IDS as readonly string[]).includes(id)) throw new Error('Unknown death guard ' + id)
  const body: GameplayStatement[] = [c('holder-ref', 'ref.holder'), c('holder', 'query.piece', { pieceId: o('holder-ref', 'piece') }), c('subject-ref', 'ref.event-piece'), c('subject', 'query.piece', { pieceId: o('subject-ref', 'piece') }), c('same', 'compare.equal-piece', { left: o('holder', 'piece'), right: o('subject', 'piece') })]
  const require = (key: string, condition: GameplayValue) => body.push(c(key + '-not', 'logic.not', { value: condition }), { kind: 'if', id: key, condition: o(key + '-not', 'value'), then: [ret(key + '-fail', false)] })
  require('same-guard', o('same', 'value'))
  const piece = o('holder', 'piece')
  body.push(c('name', 'attribute.text', { piece }, { attribute: 'name' }), c('damage', 'event.read-number', { fallback: l(0) }, { field: 'damage' }))
  const schemas: NonNullable<GameplayModuleGraph['schemas']>[number][] = []
  if (id === 'rule-hidan-undying') {
    for (const [index, statusType] of ['hidan-dying', 'hidan-undying-used'].entries()) {
      body.push(c('has-' + index, 'status.has-piece', { piece }, { statusType }), c('absent-' + index, 'logic.not', { value: o('has-' + index, 'value') }))
      require('status-guard-' + index, o('absent-' + index, 'value'))
    }
    body.push(c('spent', 'ability.was-spent', { piece }, { abilityId: 'hidan-undying' }), c('available', 'logic.not', { value: o('spent', 'value') }))
    require('available-guard', o('available', 'value'))
    body.push(c('hp', 'attribute.read', { piece }, { attribute: 'currentHp' }), c('lethal', 'compare.greater-or-equal', { left: o('damage', 'value'), right: o('hp', 'value') }))
    require('lethal-guard', o('lethal', 'value'))
    body.push(c('spent-mark', 'ability.mark-spent', { piece }, { abilityId: 'hidan-undying' }), c('retain-hp', 'attribute.set-current-hp', { piece, value: l(1) }))
    for (const [index, status] of [
      { id: 'hidan-dying', name: '濒死', type: 'hidan-dying', currentDuration: -1, currentUses: -1, intensity: 1, stacks: 1, remainingTurns: 2 },
      { id: 'hidan-undying-used', name: '不死已触发', type: 'hidan-undying-used', currentDuration: -1, currentUses: -1, intensity: 1, stacks: 1 },
    ].entries()) {
      schemas.push({ id: 'status-' + index, version: '1', fields: Object.entries(status).map(([name, value]) => ({ name, type: typeof value === 'number' ? 'number' : 'string' })) })
      body.push({ kind: 'record.create', id: 'status-' + index, schema: 'status-' + index + '@1', fields: Object.fromEntries(Object.entries(status).map(([key, value]) => [key, l(value)])) }, c('add-' + index, 'status.apply-record', { target: piece, record: o('status-' + index, 'value') }, { inputPolicy: 'host' }))
    }
    body.push(c('tick-rule', 'rule.apply-piece', { target: piece }, { ruleId: 'rule-hidan-undying-tick' }))
    const text = message(body, 'message-', [o('name', 'text'), l('的不死神体触发！HP强制保留1点，进入濒死状态（下回合结束后死亡）')])
    body.push(ret('done', true, text, true))
  } else if (id === 'rule-hidan-dying-immune') {
    body.push(c('dying', 'status.has-piece', { piece }, { statusType: 'hidan-dying' }))
    require('dying-guard', o('dying', 'value'))
    body.push(c('positive', 'compare.greater-than', { left: o('damage', 'value'), right: l(0) }))
    const reflect: GameplayStatement[] = [c('owner', 'piece.owner', { piece }), c('enemies', 'query.pieces', { ownerId: o('owner', 'player') }, { relation: 'enemy' })]
    const target = o('enemy-loop', 'item')
    const hit: GameplayStatement[] = [c('queue', 'effect.queue-damage', { attacker: piece, target, amount: o('damage', 'value') }, { damageType: 'true', skillId: 'blood-oath-reflect-dying' }), c('target-name', 'attribute.text', { piece: target }, { attribute: 'name' }), c('amount-text', 'text.from-number', { value: o('damage', 'value') })]
    const text = message(hit, 'reflected-', [o('name', 'text'), l('处于濒死状态，免疫'), o('amount-text', 'text'), l('点伤害，但诅咒将'), o('amount-text', 'text'), l('点反射给'), o('target-name', 'text')])
    hit.push(ret('reflected', true, text, true))
    reflect.push({ kind: 'foreach', id: 'enemy-loop', items: o('enemies', 'pieces'), body: [c('oathed', 'status.has-piece', { piece: target }, { statusType: 'blood-oath' }), { kind: 'if', id: 'oath-guard', condition: o('oathed', 'value'), then: hit }] })
    body.push({ kind: 'if', id: 'positive-guard', condition: o('positive', 'value'), then: reflect })
    const immune = message(body, 'immune-', [o('name', 'text'), l('处于濒死状态，免疫伤害')])
    body.push(ret('immune', true, immune, true))
  } else {
    body.push(c('shield', 'status.has-piece', { piece }, { statusType: 'kamui-shield' }), c('missing', 'logic.not', { value: o('shield', 'value') }), { kind: 'if', id: 'remove-unused', condition: o('missing', 'value'), then: [c('remove-unused-rule', 'rule.remove-piece', { target: piece }, { ruleId: id }), ret('no-shield', false)] }, c('positive', 'compare.greater-than', { left: o('damage', 'value'), right: l(0) }))
    require('positive-guard', o('positive', 'value'))
    body.push(c('remove-shield', 'status.remove-piece', { target: piece }, { statusId: 'kamui-shield' }), c('remove-rule', 'rule.remove-piece', { target: piece }, { ruleId: id }), c('attacker-ref', 'ref.target'), c('attacker-exists', 'query.has-piece', { pieceId: o('attacker-ref', 'piece') }), c('amount-text', 'text.from-number', { value: o('damage', 'value') }))
    const prefix = message(body, 'prefix-', [o('name', 'text'), l('的神威吸收了'), o('amount-text', 'text'), l('点伤害')])
    const reflected: GameplayStatement[] = [c('queue', 'effect.queue-damage', { attacker: piece, target: o('attacker', 'piece'), amount: o('damage', 'value') }, { damageType: 'true', skillId: 'kamui-reflect' }), c('attacker-name', 'attribute.text', { piece: o('attacker', 'piece') }, { attribute: 'name' })]
    const text = message(reflected, 'reflection-', [prefix, l('，并将其反弹给'), o('attacker-name', 'text'), l('！')]); reflected.push(ret('reflected', true, text, true))
    body.push({ kind: 'if', id: 'has-attacker', condition: o('attacker-exists', 'exists'), then: [c('attacker', 'query.piece', { pieceId: o('attacker-ref', 'piece') }), c('attacker-hp', 'attribute.read', { piece: o('attacker', 'piece') }, { attribute: 'currentHp' }), c('alive', 'compare.greater-than', { left: o('attacker-hp', 'value'), right: l(0) }), { kind: 'if', id: 'attacker-alive', condition: o('alive', 'value'), then: reflected }] })
    const absorbed = message(body, 'absorbed-', [prefix, l('！')]); body.push(ret('absorbed', true, absorbed, true))
  }
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', schemas, outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }, { name: 'blocked', type: 'boolean', optional: true }], body }
}
export function migrateDeathGuards(root: string, write = false): string[] {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries
  const ignored = new Set(['skillCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: { file: string; next: Record<string, unknown> }[] = []
  for (const id of DEATH_GUARD_RULE_IDS) {
    const file = path.join(root, 'data/rules', id + '.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (current.gameplayModules?.entries?.skillCode) {
      const graph = buildDeathGuardGraph(id)
      if (JSON.stringify(current.gameplayModules.entries.skillCode.graph) === JSON.stringify(graph)) pending.push({ file, next: applyGameplayModuleGraph(current, graph, 'skillCode') })
      else assertGameplayModuleDocument(current)
      continue
    }
    const original = baseline['rules/' + id]
    assertFrozenExecutable(current, original, 'skillCode', 'rule', id)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!ignored.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    pending.push({ file, next: applyGameplayModuleGraph(current, buildDeathGuardGraph(id), 'skillCode') })
  }
  if (write) for (const { file, next } of pending) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return pending.map(item => path.basename(item.file, '.json'))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(migrateDeathGuards(process.cwd(), process.argv.includes('--write'))))
