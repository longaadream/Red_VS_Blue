import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'

export const REACTION_SKILL_IDS = ['anti-heal-block', 'freeze-prevent', 'sleep-prevent', 'sleep-remove', 'divine-shield-defense', 'hardy-block-trigger'] as const
const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const out = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const result = (id: string, success: boolean, message?: GameplayValue, extra: Record<string, GameplayValue> = {}): GameplayStatement => ({ kind: 'return', id, values: { success: literal(success), ...(message ? { message } : {}), ...extra } })

export function buildReactionSkillGraph(id: string): GameplayModuleGraph {
  const body: GameplayStatement[] = [call('subject-ref', 'ref.event-piece'), call('exists', 'query.has-piece', { pieceId: out('subject-ref', 'piece') }), call('missing', 'logic.not', { value: out('exists', 'exists') }), { kind: 'if', id: 'missing-subject', condition: out('missing', 'value'), then: [result('no-subject', false, id === 'freeze-prevent' ? undefined : literal('没有目标'))] }, call('subject', 'query.piece', { pieceId: out('subject-ref', 'piece') })]
  const piece = out('subject', 'piece')
  const statusType = { 'anti-heal-block': 'anti-heal', 'freeze-prevent': 'freeze', 'sleep-prevent': 'sleep', 'sleep-remove': 'sleep', 'divine-shield-defense': 'divine-shield', 'hardy-block-trigger': 'hardy-block' }[id]
  if (!statusType) throw new Error('Unknown reaction skill ' + id)
  body.push(call('status', 'status.matches-type', { piece }, { statusType, legacyStrings: id === 'anti-heal-block' ? 'contains' : id === 'freeze-prevent' ? 'exact' : 'ignore' }), call('absent', 'logic.not', { value: out('status', 'value') }))
  const absent: GameplayStatement[] = id === 'divine-shield-defense' ? [result('absent-result', true, literal(''), { blocked: literal(false) })] : id === 'hardy-block-trigger' ? [call('remove-rule', 'rule.remove-piece', { target: piece }, { ruleId: 'rule-hardy-block' }), result('absent-result', false, literal(''))] : [result('absent-result', id !== 'sleep-prevent' && id !== 'sleep-remove', id === 'freeze-prevent' ? undefined : literal(id === 'sleep-prevent' ? '目标未处于麻醉状态或行动未被阻止' : id === 'sleep-remove' ? '目标未处于麻醉状态' : '目标未处于禁疗状态'))]
  body.push({ kind: 'if', id: 'without-status', condition: out('absent', 'value'), then: absent }, call('name', 'attribute.text', { piece }, { attribute: 'name' }))
  if (id === 'divine-shield-defense') {
    body.push(call('shield-damage', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }), call('shield-positive', 'compare.greater-than', { left: out('shield-damage', 'value'), right: literal(0) }), call('shield-no-damage', 'logic.not', { value: out('shield-positive', 'value') }), { kind: 'if', id: 'shield-without-damage', condition: out('shield-no-damage', 'value'), then: [result('shield-empty', true, literal('没有需要抵挡的伤害'), { blocked: literal(false) })] }, call('consume-shield', 'status.remove-id', { piece, statusId: literal('divine-shield') }), call('remove-shield-rule', 'rule.remove-piece', { target: piece }, { ruleId: 'rule-divine-shield' }), call('remove-shield-skill', 'skill.remove', { piece }, { skillId: 'divine-shield-defense' }), call('attacker', 'ref.target'), call('attacker-name', 'piece.name-or', { piece: out('attacker', 'piece'), fallback: literal('未知敌人') }), call('shield-prefix', 'text.concat', { left: out('name', 'text'), right: literal('的圣盾破裂，抵挡了来自') }), call('shield-attacker', 'text.concat', { left: out('shield-prefix', 'text'), right: out('attacker-name', 'text') }), call('message', 'text.concat', { left: out('shield-attacker', 'text'), right: literal('的伤害') }), result('blocked', true, out('message', 'text'), { blocked: literal(true) }))
  } else if (id === 'sleep-remove') {
    body.push(call('remove-sleep', 'status.remove-record', { piece, value: literal('sleep') }, { selector: 'type' }))
    for (const ruleId of ['rule-sleep-prevent-move', 'rule-sleep-prevent-skill', 'rule-sleep-remove-on-damage']) body.push(call('remove-' + ruleId, 'rule.remove-piece', { target: piece }, { ruleId }))
    for (const skillId of ['sleep-prevent', 'sleep-remove']) body.push(call('remove-' + skillId, 'skill.remove', { piece }, { skillId }))
    body.push(call('message', 'text.concat', { left: out('name', 'text'), right: literal('受到伤害，麻醉状态解除') }), result('success', true, out('message', 'text')))
  } else if (id === 'anti-heal-block') {
    body.push(call('message', 'text.concat', { left: out('name', 'text'), right: literal('处于禁疗状态，无法受到治疗') }), result('blocked', false, out('message', 'text'), { blocked: literal(true), showUIEffect: literal(true) }))
  } else if (id === 'freeze-prevent' || id === 'sleep-prevent') {
    body.push(call('event', 'event.type'), call('move', 'compare.text', { left: out('event', 'value'), right: literal('beforeMove') }), call('skill', 'compare.text', { left: out('event', 'value'), right: literal('beforeSkillUse') }), call('skill-text', 'value.select-text', { condition: out('skill', 'value'), whenTrue: literal('使用技能'), whenFalse: literal('执行该操作') }), call('action-text', 'value.select-text', { condition: out('move', 'value'), whenTrue: literal('移动'), whenFalse: out('skill-text', 'text') }), call('prefix', 'text.concat', { left: out('name', 'text'), right: literal(id === 'freeze-prevent' ? '被冰冻，无法' : '处于麻醉状态，无法') }), call('message', 'text.concat', { left: out('prefix', 'text'), right: out('action-text', 'text') }), result('blocked', true, out('message', 'text'), { blocked: literal(true), ...(id === 'sleep-prevent' ? { showUIEffect: literal(true) } : {}) }))
  } else {
    body.push(call('damage', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }), call('positive', 'compare.greater-than', { left: out('damage', 'value'), right: literal(0) }), call('no-damage', 'logic.not', { value: out('positive', 'value') }), { kind: 'if', id: 'without-damage', condition: out('no-damage', 'value'), then: [result('no-damage-result', false, literal(''))] }, call('half', 'math.multiply', { left: out('damage', 'value'), right: literal(0.5) }), call('gain', 'math.floor', { value: out('half', 'value') }), call('attack', 'attribute.read', { piece }, { attribute: 'attack' }), call('sum', 'math.add', { left: out('attack', 'value'), right: out('gain', 'value') }), call('positive-gain', 'compare.greater-than', { left: out('gain', 'value'), right: literal(0) }), { kind: 'if', id: 'gain-attack', condition: out('positive-gain', 'value'), then: [call('write-attack', 'attribute.set', { piece, value: out('sum', 'value') }, { attribute: 'attack' })] })
    const parts: GameplayValue[] = [out('name', 'text'), literal(' 的悍猛格挡生效，将')]
    for (const [key, suffix] of [['damage', ' 点伤害的50%转化为'], ['gain', ' 点攻击力，当前攻击力为'], ['sum', '']] as const) { body.push(call(key + '-text', 'text.from-number', { value: out(key, 'value') })); parts.push(out(key + '-text', 'text'), literal(suffix)) }
    let text = parts[0]
    parts.slice(1).forEach((part, index) => { const key = 'message-' + index; body.push(call(key, 'text.concat', { left: text, right: part })); text = out(key, 'text') })
    body.push(result('success', true, text))
  }
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'triggerSkill', outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string', optional: true }, { name: 'blocked', type: 'boolean', optional: true }, { name: 'showUIEffect', type: 'boolean', optional: true }], body }
}

export function migrateReactionSkills(root: string, write = false): string[] {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries
  const ignored = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: { file: string; next: Record<string, unknown> }[] = []
  for (const id of REACTION_SKILL_IDS) {
    const file = path.join(root, 'data/skills', id + '.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (current.gameplayModules?.entries?.code) { assertGameplayModuleDocument(current); continue }
    const original = baseline['skills/' + id]
    assertFrozenExecutable(current, original, 'code', 'triggerSkill', id)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!ignored.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    pending.push({ file, next: applyGameplayModuleGraph(current, buildReactionSkillGraph(id)) })
  }
  if (write) for (const { file, next } of pending) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return pending.map(item => path.basename(item.file, '.json'))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(migrateReactionSkills(process.cwd(), process.argv.includes('--write'))))
