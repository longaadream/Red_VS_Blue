import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'

export const TRIGGER_SKILL_IDS = ['elune-guidance', 'elune-protection', 'nano-boost-damage'] as const
const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const out = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const result = (id: string, success: boolean, message?: GameplayValue): GameplayStatement => ({ kind: 'return', id, values: { success: literal(success), ...(message ? { message } : {}) } })

export function buildTriggerSkillGraph(id: string): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  if (id === 'elune-guidance' || id === 'elune-protection') {
    body.push(call('subject-ref', 'ref.event-piece'), call('subject', 'query.piece', { pieceId: out('subject-ref', 'piece') }))
    if (id === 'elune-guidance') body.push(call('install', 'rule.apply-piece', { target: out('subject', 'piece') }, { ruleId: 'rule-elune-guidance' }))
    else body.push(call('owner', 'piece.owner', { piece: out('subject', 'piece') }), call('install', 'rule.apply-player', { target: out('owner', 'player') }, { ruleId: 'rule-elune-protection-player' }))
    body.push(result('success', true))
  } else if (id === 'nano-boost-damage') {
    body.push(call('source-ref', 'ref.source'), call('exists', 'query.has-piece', { pieceId: out('source-ref', 'piece') }), call('missing', 'logic.not', { value: out('exists', 'exists') }), { kind: 'if', id: 'missing-source', condition: out('missing', 'value'), then: [result('no-source', false)] }, call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }), call('damage', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }), call('positive', 'compare.greater-than', { left: out('damage', 'value'), right: literal(0) }), call('non-positive', 'logic.not', { value: out('positive', 'value') }), { kind: 'if', id: 'no-damage', condition: out('non-positive', 'value'), then: [result('no-damage-result', false)] }, call('statuses', 'status.list-ids', { piece: out('source', 'piece') }, { statusType: 'nano-boost' }), {
      kind: 'collection.reduce', id: 'bonus', items: out('statuses', 'ids'), inputs: { piece: out('source', 'piece') }, initial: literal(0), body: [call('intensity', 'status.read-number', { piece: input('piece'), statusId: input('item'), fallback: literal(1) }, { field: 'intensity' }), call('sum', 'math.add', { left: input('accumulator'), right: out('intensity', 'value') }), { kind: 'return', id: 'sum-result', value: out('sum', 'value') }],
    }, call('zero', 'compare.equal', { left: out('bonus', 'value'), right: literal(0) }), { kind: 'if', id: 'no-bonus', condition: out('zero', 'value'), then: [result('no-bonus-result', false)] }, call('boosted', 'math.add', { left: out('damage', 'value'), right: out('bonus', 'value') }), call('write', 'event.write-number', { value: out('boosted', 'value') }, { field: 'damage', inputPolicy: 'host' }), call('name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }), call('prefix', 'text.concat', { left: out('name', 'text'), right: literal('的纳米激素使伤害+') }), call('number', 'text.from-number', { value: out('bonus', 'value') }), call('message', 'text.concat', { left: out('prefix', 'text'), right: out('number', 'text') }), result('success', true, out('message', 'text')))
  } else throw new Error('Unknown triggered skill ' + id)
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'triggerSkill', outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string', optional: true }], body }
}

export function migrateTriggerSkills(root: string, write = false): string[] {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries
  const ignored = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: { file: string; next: Record<string, unknown> }[] = []
  for (const id of TRIGGER_SKILL_IDS) {
    const file = path.join(root, 'data/skills', id + '.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (current.gameplayModules?.entries?.code) { assertGameplayModuleDocument(current); continue }
    const original = baseline['skills/' + id]
    assertFrozenExecutable(current, original, 'code', 'triggerSkill', id)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!ignored.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    pending.push({ file, next: applyGameplayModuleGraph(current, buildTriggerSkillGraph(id)) })
  }
  if (write) for (const { file, next } of pending) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return pending.map(item => path.basename(item.file, '.json'))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(migrateTriggerSkills(process.cwd(), process.argv.includes('--write'))))
