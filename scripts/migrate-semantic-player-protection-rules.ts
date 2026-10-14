import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'
export const PLAYER_PROTECTION_RULE_IDS = ['rule-elune-protection', 'rule-elune-protection-player'] as const
const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const out = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
export function buildPlayerProtectionRuleGraph(id: string): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const require = (key: string, condition: GameplayValue) => body.push(call(key + '-not', 'logic.not', { value: condition }), { kind: 'if', id: key, condition: out(key + '-not', 'value'), then: [{ kind: 'return', id: key + '-result', values: { success: literal(false) } }] })
  const grant = id === 'rule-elune-protection'
  if (!(PLAYER_PROTECTION_RULE_IDS as readonly string[]).includes(id)) throw new Error('Unknown protection rule ' + id)
  if (grant) {
    body.push(call('holder-ref', 'ref.holder'), call('holder-exists', 'query.has-piece', { pieceId: out('holder-ref', 'piece') }))
    require('require-holder', out('holder-exists', 'exists'))
    body.push(call('holder', 'query.piece', { pieceId: out('holder-ref', 'piece') }), call('source-ref', 'ref.source'), call('source-exists', 'query.has-piece', { pieceId: out('source-ref', 'piece') }))
    require('require-source', out('source-exists', 'exists'))
    body.push(call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }), call('same', 'compare.equal-piece', { left: out('holder', 'piece'), right: out('source', 'piece') }))
    require('require-same', out('same', 'value'))
    body.push(call('owner-ref', 'piece.owner', { piece: out('holder', 'piece') }))
  } else body.push(call('owner-ref', 'ref.event-player'))
  body.push(call('owner-exists', 'query.has-player', { playerId: out('owner-ref', 'player') }))
  require('require-owner', out('owner-exists', 'exists'))
  body.push(call('owner', 'query.player', { playerId: out('owner-ref', 'player') }))
  const player = out('owner', 'player')
  if (grant) {
    body.push(call('has-protection', 'status.has-player', { player }, { statusType: 'elune-protection' }), call('no-protection', 'logic.not', { value: out('has-protection', 'value') }))
    require('require-no-protection', out('no-protection', 'value'))
    body.push({ kind: 'record.create', id: 'protection', schema: 'protection@1', fields: { id: literal('elune-protection'), type: literal('elune-protection'), name: literal('艾露恩的守护'), description: literal('当友方任意棋子受到致命伤害时，免疫该伤害并恢复5点生命（全队共用一次）') } }, call('apply', 'status.apply-player-record', { player, record: out('protection', 'value') }), call('rule', 'rule.apply-player', { target: player }, { ruleId: 'rule-elune-protection-player' }), { kind: 'return', id: 'granted', values: { success: literal(true), message: literal('艾露恩的守护已就绪') } })
  } else {
    body.push(call('subject-ref', 'ref.event-piece'), call('subject-exists', 'query.has-piece', { pieceId: out('subject-ref', 'piece') }))
    require('require-subject', out('subject-exists', 'exists'))
    body.push(call('subject', 'query.piece', { pieceId: out('subject-ref', 'piece') }), call('subject-owner', 'piece.owner', { piece: out('subject', 'piece') }), call('ally', 'compare.allied-players', { left: player, right: out('subject-owner', 'player') }))
    require('require-ally', out('ally', 'value'))
    body.push(call('damage', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }), call('positive', 'compare.greater-than', { left: out('damage', 'value'), right: literal(0) }))
    require('require-positive', out('positive', 'value'))
    body.push(call('hp', 'attribute.read', { piece: out('subject', 'piece') }, { attribute: 'currentHp' }), call('lethal', 'compare.less-or-equal', { left: out('hp', 'value'), right: out('damage', 'value') }))
    require('require-lethal', out('lethal', 'value'))
    body.push(call('has-protection', 'status.has-player', { player }, { statusType: 'elune-protection' }))
    require('require-protection', out('has-protection', 'value'))
    body.push(call('consume', 'status.remove-player-records', { player }, { statusType: 'elune-protection' }), call('max-hp', 'attribute.read', { piece: out('subject', 'piece') }, { attribute: 'maxHp' }), call('recovered', 'math.add', { left: out('hp', 'value'), right: literal(5) }), call('capped', 'math.min', { left: out('recovered', 'value'), right: out('max-hp', 'value') }), call('write-hp', 'attribute.set-current-hp', { piece: out('subject', 'piece'), value: out('capped', 'value') }), call('name', 'piece.display-name', { piece: out('subject', 'piece') }, { fallback: 'templateId' }), call('prefix', 'text.concat', { left: literal('艾露恩的守护：'), right: out('name', 'value') }), call('message', 'text.concat', { left: out('prefix', 'text'), right: literal('免疫致命伤害并恢复5点生命（守护已消耗）') }), { kind: 'return', id: 'protected', values: { success: literal(true), blocked: literal(true), message: out('message', 'text') } })
  }
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', schemas: [{ id: 'protection', version: '1', fields: ['id', 'type', 'name', 'description'].map(name => ({ name, type: 'string' })) }], outputs: [{ name: 'success', type: 'boolean' }, { name: 'blocked', type: 'boolean', optional: true }, { name: 'message', type: 'string', optional: true }], body }
}

export function migratePlayerProtectionRules(root: string, write = false): string[] {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries
  const ignored = new Set(['skillCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: { file: string; next: Record<string, unknown> }[] = []
  for (const id of PLAYER_PROTECTION_RULE_IDS) {
    const file = path.join(root, 'data/rules', id + '.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (current.gameplayModules?.entries?.skillCode) { assertGameplayModuleDocument(current); continue }
    const original = baseline['rules/' + id]
    assertFrozenExecutable(current, original, 'skillCode', 'rule', id)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!ignored.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    pending.push({ file, next: applyGameplayModuleGraph(current, buildPlayerProtectionRuleGraph(id), 'skillCode') })
  }
  if (write) for (const { file, next } of pending) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return pending.map(item => path.basename(item.file, '.json'))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(migratePlayerProtectionRules(process.cwd(), process.argv.includes('--write'))))

