import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayPort, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'

type Status = Record<string, GameplayJsonValue>
type Recipe = {
  target?: { range: number; filter: 'ally' | 'enemy' }
  status: Status; prefix?: string; clockId?: boolean; turnSuffix?: boolean; sourceOwner?: boolean
  duplicate?: { mode: 'reject' | 'skip'; message: string[] }
  rules: string[]; ruleOnSource?: boolean; guardedRules?: boolean
  beforeSkills?: [string, 'add' | 'remove'][]; afterSkills?: [string, 'add' | 'remove'][]
  attributes?: { attribute: 'attack' | 'defense' | 'moveRange'; amount: number; minimum?: number }[]
  selfRefund?: boolean; rejectSelf?: string; message: string[]
}
const status = (type: string, name: string, duration: number, rules: string[] = []): Status => ({ type, name, currentDuration: duration, currentUses: -1, intensity: 1, stacks: 1, ...(rules.length ? { relatedRules: rules } : {}) })
export const STATUS_SKILL_RECIPES: Record<string, Recipe> = {
  'shield-of-light': {
    target: { range: 7, filter: 'ally' }, status: { id: 'divine-shield', type: 'divine-shield', currentDuration: -1, currentUses: -1, intensity: 1, stacks: 1, relatedRules: ['rule-divine-shield'] },
    rules: ['rule-divine-shield'], afterSkills: [['divine-shield-defense', 'add']], selfRefund: true, message: ['$source', '为', '$target', '施加了圣盾', '$refund'],
  },
  'hardy-block': {
    status: { id: 'hardy-block', type: 'hardy-block', currentDuration: 2, currentUses: -1, intensity: 50, stacks: 1, relatedRules: ['rule-hardy-block'] },
    rules: ['rule-hardy-block'], message: ['$source', ' 激活了悍猛格挡，持续2回合，受到伤害时将50%伤害转化为攻击力'],
  },
  'el-primo-meteor-belt': {
    status: { type: 'el-primo-meteor-belt', name: '流星腰带', visible: true, stacking: 'none', currentDuration: 2, remainingDuration: 2, stacks: 1, relatedRules: ['rule-el-primo-meteor-belt'] },
    prefix: 'el-primo-meteor-belt-', turnSuffix: true, rules: ['rule-el-primo-meteor-belt'], message: ['$source', '获得流星腰带，持续2回合'],
  },
  'tirion-holy-recall': {
    status: { id: 'divine-shield', ...status('divine-shield', '圣盾', -1, ['rule-divine-shield']) },
    duplicate: { mode: 'reject', message: ['已经拥有圣盾'] }, rules: ['rule-divine-shield'],
    message: ['$source', '以圣光重召获得圣盾'],
  },
  'arthas-icebound-fortitude': {
    status: status('icebound-fortitude', '寒冰坚忍', 2, ['rule-arthas-icebound', 'rule-arthas-icebound-retaliate']), prefix: 'icebound-fortitude-',
    duplicate: { mode: 'reject', message: ['寒冰坚忍已激活中'] }, rules: ['rule-arthas-icebound', 'rule-arthas-icebound-retaliate'],
    message: ['$source', '激活了寒冰坚忍：持续2回合，受到伤害降低50%，攻击者会被冰冻1回合'],
  },
  'arthas-lich-covenant': {
    target: { range: 3, filter: 'ally' }, status: status('lich-covenant', '巫妖誓约', -1, ['rule-arthas-lich-covenant']), prefix: 'lich-covenant-',
    duplicate: { mode: 'reject', message: ['$target', '已拥有巫妖誓约'] }, rules: ['rule-arthas-lich-covenant'], message: ['$source', '对', '$target', '施加了巫妖誓约'],
  },
  'naruto-sage-mode': {
    status: { ...status('sage-mode', '仙人模式', -1, ['rule-naruto-sage-immobile', 'rule-naruto-sage-block-skill', 'rule-naruto-sage-tick']), stacks: 6 }, prefix: 'sage-mode-',
    duplicate: { mode: 'reject', message: ['$source', '已处于仙人模式中'] }, rules: ['rule-naruto-sage-immobile', 'rule-naruto-sage-block-skill', 'rule-naruto-sage-tick'],
    message: ['$source', '进入仙人模式！你的回合开始时推进准备，完成后获得3行动点和1充能点'],
  },
  'hidan-blood-oath': {
    target: { range: 4, filter: 'enemy' }, status: { ...status('blood-oath', '血誓诅咒', 3), remainingDuration: 3 }, prefix: 'blood-oath-', sourceOwner: true,
    duplicate: { mode: 'reject', message: ['$target', '已处于血誓诅咒中'] }, rules: ['rule-hidan-blood-oath-reflect'], ruleOnSource: true,
    message: ['$source', '对', '$target', '施加了血誓诅咒（持续3回合），飞段受到的所有伤害将同时施加给目标'],
  },
  'itachi-tsukuyomi': {
    target: { range: 6, filter: 'enemy' }, status: { ...status('itachi-tsukuyomi', '月读', -1, ['rule-itachi-tsukuyomi']), currentUses: 1 }, prefix: 'itachi-tsukuyomi-',
    duplicate: { mode: 'skip', message: [] }, rules: ['rule-itachi-tsukuyomi'], guardedRules: true,
    message: ['$source', '对', '$target', '施加月读，其下一个使用的技能额外增加1回合冷却'],
  },
  'sasuke-susanoo': {
    status: { id: 'susanoo-active', ...status('susanoo-active', '须佐能乎', -1) }, rules: [],
    attributes: [{ attribute: 'defense', amount: 1 }], beforeSkills: [['sasuke-chidori', 'remove'], ['sasuke-kagutsuchi', 'add'], ['sasuke-indra-arrow', 'add']],
    message: ['$source', '激活完全体须佐能乎，防御力+1，失去千鸟并获得加具土命与因陀罗之矢'],
  },
  'illidan-metamorphosis': {
    status: { id: 'demon-strike-charges', ...status('demon-strike-charges', '恶魔冲击次数', -1), currentUses: 2, intensity: 2 },
    attributes: [{ attribute: 'attack', amount: 2 }, { attribute: 'defense', amount: -1, minimum: 0 }], rules: ['rule-illidan-demon-strike'], afterSkills: [['illidan-demon-strike', 'add']],
    message: ['$source', '进入恶魔变形！攻击力+2（现为', '$attack', '），防御力-1（现为', '$defense', '），获得恶魔冲击技能（2次）'],
  },
  'nano-boost': {
    target: { range: 10, filter: 'ally' }, rejectSelf: '不能对自己使用纳米激素',
    status: { type: 'nano-boost', currentDuration: -1, currentUses: -1, intensity: 1, value: 3, relatedRules: ['rule-nano-boost-damage'] }, prefix: 'nano-boost-', clockId: true,
    attributes: [{ attribute: 'defense', amount: 3 }, { attribute: 'moveRange', amount: 1 }], rules: ['rule-nano-boost-damage'], afterSkills: [['nano-boost-damage', 'add']],
    message: ['$source', '对', '$target', '使用纳米激素，防御力+3、移速+1、伤害+1'],
  },
}
const value = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const out = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })

export function buildStatusSkillGraph(id: string): GameplayModuleGraph {
  const recipe = STATUS_SKILL_RECIPES[id]
  if (!recipe) throw new Error('Unknown status skill ' + id)
  const body: GameplayStatement[] = [call('source-ref', 'ref.holder'), call('source', 'query.piece', { pieceId: out('source-ref', 'piece') })]
  const source = out('source', 'piece')
  let target = source
  if (recipe.target) {
    body.push(call('choice', 'choice.target-piece', {}, recipe.target), call('unresolved', 'choice.is-unresolved', { choice: out('choice', 'choice') }), {
      kind: 'if', id: 'return-choice', condition: out('unresolved', 'value'), then: [call('choice-result', 'choice.as-result', { choice: out('choice', 'choice') }), { kind: 'return', id: 'waiting', value: out('choice-result', 'result') }],
    }, call('target', 'choice.piece', { choice: out('choice', 'choice') }))
    target = out('target', 'piece')
  }
  body.push(call('source-name', 'attribute.text', { piece: source }, { attribute: 'name' }), call('target-name', 'attribute.text', { piece: target }, { attribute: 'name' }))
  const aliases: Record<string, GameplayValue> = { $source: out('source-name', 'text'), $target: out('target-name', 'text') }
  const message = (parts: string[], prefix: string, into: GameplayStatement[]) => {
    let result: GameplayValue = value('')
    parts.forEach((part, index) => { const name = `${prefix}-${index}`; into.push(call(name, 'text.concat', { left: result, right: aliases[part] ?? value(part) })); result = out(name, 'text') })
    return result
  }
  const returned = (success: boolean, parts: string[], prefix: string): GameplayStatement[] => {
    const nodes: GameplayStatement[] = []
    const text = message(parts, prefix + '-text', nodes)
    nodes.push(call(prefix, 'result.action', { success: value(success), message: text }), { kind: 'return', id: prefix + '-return', value: out(prefix, 'result') })
    return nodes
  }
  if (recipe.rejectSelf) body.push(call('self', 'compare.equal-piece', { left: source, right: target }), { kind: 'if', id: 'reject-self', condition: out('self', 'value'), then: returned(false, [recipe.rejectSelf], 'self-error') })
  if (recipe.duplicate) body.push(call('already', 'status.has-piece', { piece: target }, { statusType: recipe.status.type }), ...(recipe.duplicate.mode === 'reject' ? [{ kind: 'if' as const, id: 'reject-duplicate', condition: out('already', 'value'), then: returned(false, recipe.duplicate.message, 'duplicate-error') }] : []))
  const effects: GameplayStatement[] = []
  for (const { attribute, amount, minimum } of recipe.attributes ?? []) {
    effects.push(call(attribute, 'attribute.read', { piece: target }, { attribute }), call(attribute + '-next', 'math.add', { left: out(attribute, 'value'), right: value(amount) }))
    let next = out(attribute + '-next', 'value')
    if (minimum !== undefined) { effects.push(call(attribute + '-minimum', 'math.max', { left: next, right: value(minimum) })); next = out(attribute + '-minimum', 'value') }
    effects.push(call(attribute + '-set', 'attribute.set', { piece: target, value: next }, { attribute }), call(attribute + '-text', 'text.from-number', { value: next }))
    aliases['$' + attribute] = out(attribute + '-text', 'text')
  }
  const skills = (items: Recipe['beforeSkills']) => { for (const [skillId, operation] of items ?? []) effects.push(call(operation + '-' + skillId, 'skill.' + operation, { piece: target }, { skillId })) }
  skills(recipe.beforeSkills)
  const fields: Record<string, GameplayValue> = Object.fromEntries(Object.entries(recipe.status).map(([key, item]) => [key, value(item)]))
  const schemaFields: GameplayPort[] = Object.entries(recipe.status).map(([name, item]) => ({ name, type: Array.isArray(item) ? { kind: 'list', element: 'string' } : typeof item === 'number' ? 'number' : typeof item === 'boolean' ? 'boolean' : 'string' }))
  if (recipe.prefix) {
    if (recipe.clockId) effects.push(call('timestamp', 'identity.host-time'), call('identity', 'text.from-number', { value: out('timestamp', 'value') }))
    else effects.push(call('identity', 'piece.identifier', { piece: target }))
    effects.push(call('status-id', 'text.concat', { left: value(recipe.prefix), right: out('identity', recipe.clockId ? 'text' : 'id') }))
    fields.id = out('status-id', 'text'); schemaFields.push({ name: 'id', type: 'string' })
    if (recipe.turnSuffix) {
      effects.push(call('turn', 'turn.number'), call('turn-text', 'text.from-number', { value: out('turn', 'value') }), call('status-id-separator', 'text.concat', { left: fields.id, right: value('-') }), call('status-id-turn', 'text.concat', { left: out('status-id-separator', 'text'), right: out('turn-text', 'text') }))
      fields.id = out('status-id-turn', 'text')
    }
  }
  if (recipe.sourceOwner) {
    effects.push(call('owner', 'piece.owner', { piece: source })); fields.sourcePlayerId = out('owner', 'player'); schemaFields.push({ name: 'sourcePlayerId', type: 'player' })
  }
  effects.push({ kind: 'record.create', id: 'status-record', schema: 'status-payload@1', fields }, call('apply-status', 'status.apply-record', { target, record: out('status-record', 'value') }, { inputPolicy: 'host' }))
  // Preserve each legacy skill's order between explicit rule and skill installs.
  if (id === 'illidan-metamorphosis') skills(recipe.afterSkills)
  recipe.rules.forEach((ruleId, index) => {
    const ruleTarget = recipe.ruleOnSource ? source : target
    const install = call('rule-' + index, 'rule.apply-piece', { target: ruleTarget }, { ruleId })
    if (recipe.guardedRules) effects.push(call('has-rule-' + index, 'rule.has-piece', { piece: ruleTarget }, { ruleId }), call('missing-rule-' + index, 'logic.not', { value: out('has-rule-' + index, 'value') }), { kind: 'if', id: 'install-rule-' + index, condition: out('missing-rule-' + index, 'value'), then: [install] })
    else effects.push(install)
  })
  if (id !== 'illidan-metamorphosis') skills(recipe.afterSkills)
  if (recipe.duplicate?.mode === 'skip') body.push(call('needs-status', 'logic.not', { value: out('already', 'value') }), { kind: 'if', id: 'apply-only-once', condition: out('needs-status', 'value'), then: effects })
  else body.push(...effects)
  if (recipe.selfRefund) {
    body.push(call('is-self', 'compare.equal-piece', { left: source, right: target }), { kind: 'if', id: 'self-refund', condition: out('is-self', 'value'), then: [
      call('refund-owner', 'piece.owner', { piece: source }), call('refund-current', 'resource.read', { player: out('refund-owner', 'player') }, { resource: 'actionPoints' }), call('refund-limit', 'resource.limit', { player: out('refund-owner', 'player') }, { resource: 'actionPoints' }), call('refund-next', 'math.add', { left: out('refund-current', 'value'), right: value(1) }), call('refund-capped', 'math.min', { left: out('refund-next', 'value'), right: out('refund-limit', 'value') }), call('refund-delta', 'math.subtract', { left: out('refund-capped', 'value'), right: out('refund-current', 'value') }), call('refund-apply', 'resource.adjust', { player: out('refund-owner', 'player'), amount: out('refund-delta', 'value') }, { resource: 'actionPoints' }),
    ] }, call('refund-text', 'value.select-text', { condition: out('is-self', 'value'), whenTrue: value('，并回复了1点行动点'), whenFalse: value('') }))
    aliases.$refund = out('refund-text', 'text')
  }
  body.push(...returned(true, recipe.message, 'success'))
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', schemas: [{ id: 'status-payload', version: '1', fields: schemaFields }], outputs: [{ name: 'result', type: 'record', nullable: true }], body }
}

export function migrateStatusSkills(root: string, write = false): string[] {
  const entries = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries
  const generated = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: { file: string; next: Record<string, unknown> }[] = []
  for (const id of Object.keys(STATUS_SKILL_RECIPES)) {
    const file = path.join(root, 'data/skills', id + '.json'), current = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (current.gameplayModules?.entries?.code) { assertGameplayModuleDocument(current); continue }
    const original = entries['skills/' + id]
    assertFrozenExecutable(current, original, 'code', 'skill', id)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) if (!generated.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    pending.push({ file, next: applyGameplayModuleGraph(current, buildStatusSkillGraph(id)) })
  }
  if (write) for (const { file, next } of pending) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return pending.map(item => path.basename(item.file, '.json'))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(migrateStatusSkills(process.cwd(), process.argv.includes('--write'))))
