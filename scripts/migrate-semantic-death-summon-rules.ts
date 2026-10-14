import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayPort, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'
export const DEATH_SUMMON_RULE_IDS = ['rule-grimmjow-resurreccion', 'rule-arthas-lich-covenant'] as const
const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const out = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
export function buildDeathSummonRuleGraph(id: string): GameplayModuleGraph {
  if (!(DEATH_SUMMON_RULE_IDS as readonly string[]).includes(id)) throw new Error('Unknown death summon rule ' + id)
  const revive = id === 'rule-arthas-lich-covenant'
  const body: GameplayStatement[] = []
  const require = (key: string, condition: GameplayValue) => body.push(call(key + '-not', 'logic.not', { value: condition }), { kind: 'if', id: key, condition: out(key + '-not', 'value'), then: [{ kind: 'return', id: key + '-result', values: { success: literal(false), message: literal('') } }] })
  body.push(call('holder-ref', 'ref.holder'), call('exists', 'query.has-piece', { pieceId: out('holder-ref', 'piece') }))
  require('require-holder', out('exists', 'exists'))
  body.push(call('holder', 'query.piece', { pieceId: out('holder-ref', 'piece') }), call('source-ref', 'ref.source'), call('source-exists', 'query.has-piece', { pieceId: out('source-ref', 'piece') }))
  require('require-source', out('source-exists', 'exists'))
  const piece = out('holder', 'piece')
  body.push(call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }), call('same', 'compare.equal-piece', { left: piece, right: out('source', 'piece') }))
  require('require-same', out('same', 'value'))
  body.push(call('hp', 'attribute.read', { piece }, { attribute: 'currentHp' }), call('dead', 'compare.equal', { left: out('hp', 'value'), right: literal(0) }))
  require('require-dead', out('dead', 'value'))
  body.push(call('has-status', 'status.has-piece', { piece }, { statusType: revive ? 'lich-covenant' : 'resurreccion' }))
  if (revive) require('require-status', out('has-status', 'value'))
  else { body.push(call('first-death', 'logic.not', { value: out('has-status', 'value') })); require('require-first-death', out('first-death', 'value')) }
  body.push(call('name', 'attribute.text', { piece }, { attribute: 'name' }), call('summon-message', 'text.concat', { left: out('name', 'text'), right: literal(revive ? '的巫妖誓约触发：完成死亡结算后满血复活，攻击力提高50%，技能冷却重置' : '以豹王形态在原地重新召唤') }))
  const fields: Record<string, GameplayValue> = { skillId: literal(revive ? 'arthas-lich-covenant' : 'grimmjow-resurreccion'), message: out('summon-message', 'text') }
  const schema: GameplayPort[] = [{ name: 'skillId', type: 'string' }, { name: 'message', type: 'string' }, { name: 'skillIds', type: { kind: 'list', element: 'string' } }]
  for (const attribute of ['maxHp', 'currentHp', 'attack', 'defense', 'moveRange']) {
    schema.push({ name: attribute, type: 'number' })
    if (revive) { body.push(call(attribute, 'attribute.read', { piece }, { attribute: attribute === 'currentHp' ? 'maxHp' : attribute })); fields[attribute] = out(attribute, 'value') }
    else fields[attribute] = literal(({ maxHp: 10, currentHp: 10, attack: 5, defense: 0, moveRange: 5 } as Record<string, number>)[attribute])
  }
  if (revive) {
    body.push(call('skills', 'skill.identifiers', { piece })); fields.skillIds = out('skills', 'ids')
    fields.revive = literal(true); fields.attackBonusMultiplier = literal(0.5)
    schema.push({ name: 'revive', type: 'boolean' }, { name: 'attackBonusMultiplier', type: 'number' })
  } else {
    fields.skillIds = literal(['grimmjow-destruction-instinct', 'grimmjow-hunting-instinct', 'grimmjow-resurreccion', 'grimmjow-panther-claw'])
    body.push({ kind: 'collection.map', id: 'status-list', items: literal([0]), body: [{ kind: 'record.create', id: 'status', schema: 'status@1', fields: { id: literal('grimmjow-resurreccion'), type: literal('resurreccion'), name: literal('归刃'), visible: literal(true), currentDuration: literal(-1), currentUses: literal(-1), intensity: literal(1), stacks: literal(1) } }, { kind: 'return', id: 'status-return', value: out('status', 'value') }] })
    fields.statusTags = out('status-list', 'value'); schema.push({ name: 'statusTags', type: { kind: 'list', element: { kind: 'record', schema: 'status@1' } } })
    body.push(call('message', 'text.concat', { left: out('name', 'text'), right: literal('完成死亡结算，准备在原地重新召唤豹王形态') }))
  }
  body.push({ kind: 'record.create', id: 'profile', schema: 'summon-profile@1', fields }, { kind: 'return', id: 'done', values: { success: literal(true), message: revive ? literal('') : out('message', 'text'), summonAfterDeath: out('profile', 'value') } })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', schemas: [{ id: 'summon-profile', version: '1', fields: schema }, { id: 'status', version: '1', fields: ['id', 'type', 'name', 'visible', 'currentDuration', 'currentUses', 'intensity', 'stacks'].map(name => ({ name, type: ['id', 'type', 'name'].includes(name) ? 'string' : name === 'visible' ? 'boolean' : 'number' })) }], outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }, { name: 'summonAfterDeath', type: 'record', optional: true }], body }
}

export function migrateDeathSummonRules(root: string, write = false): string[] {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries
  const ignored = new Set(['skillCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: { file: string; next: Record<string, unknown> }[] = []
  for (const id of DEATH_SUMMON_RULE_IDS) {
    const file = path.join(root, 'data/rules', id + '.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (current.gameplayModules?.entries?.skillCode) { assertGameplayModuleDocument(current); continue }
    const original = baseline['rules/' + id]
    assertFrozenExecutable(current, original, 'skillCode', 'rule', id)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!ignored.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    pending.push({ file, next: applyGameplayModuleGraph(current, buildDeathSummonRuleGraph(id), 'skillCode') })
  }
  if (write) for (const { file, next } of pending) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return pending.map(item => path.basename(item.file, '.json'))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(migrateDeathSummonRules(process.cwd(), process.argv.includes('--write'))))

