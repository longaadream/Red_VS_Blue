import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSemanticPreviewGraph } from './migrate-semantic-previews'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'

const value = (value: string | number | boolean): GameplayValue => ({ kind: 'literal', value })
const out = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, string | number | boolean> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
type Recipe = { range: number; ally?: boolean; damage?: 'normal' | 'true'; spell?: boolean; amount?: number; multiplier?: boolean; fixedMultiplier?: number; previewMultiplier?: number; floor?: boolean; minimumDistance?: number; damageFallback?: boolean; heal?: number; drain?: boolean; attackBonus?: number; blockedMessage?: string; freeze?: boolean; message: readonly (string | { node: string; port: string })[] }
const sourceName = { node: 'source-name', port: 'text' }, targetName = { node: 'target-name', port: 'text' }, damageText = { node: 'damage-text', port: 'text' }, healText = { node: 'heal-text', port: 'text' }
export const TARGET_EFFECT_RECIPES: Readonly<Record<string, Recipe>> = {
  frostbolt: { range: 5, damage: 'normal', spell: true, multiplier: true, freeze: true, message: [sourceName, '使用了冰霜箭，对', targetName, '造成', damageText, '点伤害并使其冰冻'] },
  'venom-claw-rend': { range: 1, damage: 'normal', multiplier: true, floor: true, blockedMessage: '使用利爪撕裂，伤害被阻挡', message: [sourceName, '使用利爪撕裂对', targetName, '造成', damageText, '点物理伤害'] },
  ashbringer: { range: 1, damage: 'true', message: [sourceName, '使用灰烬使者对', targetName, '造成', damageText, '点真实伤害'] },
  'blessed-hammer': { range: 2, damage: 'normal', message: [sourceName, '的祝福之锤对', targetName, '造成', damageText, '点物理伤害'] },
  fireball: { range: 5, damage: 'normal', spell: true, multiplier: true, message: [sourceName, '使用了火球术，对', targetName, '造成', damageText, '点伤害'] },
  'fel-blessing': { range: 99, ally: true, damage: 'true', amount: 2, attackBonus: 2, message: [sourceName, '使用邪能赐福，使', targetName, '攻击力+2并受到', damageText, '点真实伤害'] },
  'illidan-demon-strike': { range: 99, damage: 'normal', message: [sourceName, '使用恶魔冲击，对', targetName, '造成', damageText, '点伤害'] },
  'illidan-eye-beam': { range: 4, damage: 'normal', spell: true, drain: true, message: [sourceName, '释放眼棱，对', targetName, '造成', damageText, '点伤害并恢复', healText, '点生命值'] },
  'light-of-the-light': { range: 7, ally: true, heal: 5, message: [sourceName, '使', targetName, '恢复', healText, '点生命'] },
  'ulquiorra-black-cero': { range: 2, damage: 'normal', spell: true, fixedMultiplier: 2, damageFallback: true, message: [sourceName, '释放黑虚闪，造成', damageText, '点魔法伤害'] },
  'ulquiorra-cero': { range: 4, damage: 'normal', spell: true, fixedMultiplier: 0.75, floor: true, damageFallback: true, message: [sourceName, '释放虚闪，造成', damageText, '点魔法伤害'] },
  'ichigo-zangetsu': { range: 1, damage: 'normal', multiplier: true, floor: true, message: [sourceName, '以斩月对', targetName, '造成', damageText, '点物理伤害'] },
  'blackwidow-deadly-gaze': { range: 99, damage: 'normal', multiplier: true, floor: true, previewMultiplier: 2, minimumDistance: 7, message: [sourceName, '发动致命视线，对', targetName, '造成', damageText, '点伤害（距离', { node: 'distance-text', port: 'text' }, '格）'] },
}

export function buildTargetEffectGraph(id: string): GameplayModuleGraph {
  const recipe = TARGET_EFFECT_RECIPES[id]
  if (!recipe) throw new Error('Unknown target effect recipe ' + id)
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: out('source-ref', 'piece') }),
    call('choice', 'choice.target-piece', {}, { range: recipe.range, filter: recipe.ally ? 'ally' : 'enemy' }),
    call('unresolved', 'choice.is-unresolved', { choice: out('choice', 'choice') }),
    { kind: 'if', id: 'wait-or-cancel', condition: out('unresolved', 'value'), then: [
      call('selection-result', 'choice.as-result', { choice: out('choice', 'choice') }),
      { kind: 'return', id: 'return-selection', value: out('selection-result', 'result') },
    ] },
    call('target', 'choice.piece', { choice: out('choice', 'choice') }),
    call('source-name', 'attribute.text', { piece: out('source', 'piece') }, { attribute: 'name' }),
    call('target-name', 'attribute.text', { piece: out('target', 'piece') }, { attribute: 'name' }),
  ]
  if (recipe.minimumDistance !== undefined) body.push(
    call('distance', 'query.distance', { from: out('source', 'piece'), to: out('target', 'piece') }),
    call('too-close', 'compare.less-than', { left: out('distance', 'distance'), right: value(recipe.minimumDistance) }),
    { kind: 'if', id: 'distance-guard', condition: out('too-close', 'value'), then: [
      call('invalid-distance', 'result.action', { success: value(false), message: value('目标距离太近，必须选择6格外的敌人') }),
      { kind: 'return', id: 'return-invalid-distance', value: out('invalid-distance', 'result') },
    ] },
    call('distance-text', 'text.from-number', { value: out('distance', 'distance') }),
  )
  if (recipe.attackBonus !== undefined) body.push(call('attack-bonus', 'attribute.adjust', { piece: out('target', 'piece'), amount: value(recipe.attackBonus) }, { attribute: 'attack' }))
  if (recipe.damage) {
    let amount: GameplayValue = value(recipe.amount ?? 0)
    if (recipe.amount === undefined) {
      body.push(call('attack', 'attribute.read', { piece: out('source', 'piece') }, { attribute: 'attack' }))
      amount = out('attack', 'value')
    }
    if (recipe.multiplier) {
      body.push(call('multiplier', 'skill.power-multiplier'), call('scaled', 'math.multiply', { left: amount, right: out('multiplier', 'value') }))
      amount = out('scaled', 'value')
    }
    if (recipe.fixedMultiplier !== undefined) {
      body.push(call('scaled', 'math.multiply', { left: amount, right: value(recipe.fixedMultiplier) }))
      amount = out('scaled', 'value')
    }
    if (recipe.floor) {
      body.push(call('floor', 'math.floor', { value: amount }))
      amount = out('floor', 'value')
    }
    body.push(call('damage', 'effect.damage', { source: out('source', 'piece'), target: out('target', 'piece'), amount }, { damageType: recipe.damage, inputPolicy: 'host', ...(recipe.spell ? { legacyNormalSpelling: 'magical' } : {}) }))
    if (recipe.damageFallback) body.push(call('damage-fallback', 'value.number-or-zero', { value: out('damage', 'damage') }))
    body.push(call('damage-text', 'text.from-number', { value: out(recipe.damageFallback ? 'damage-fallback' : 'damage', recipe.damageFallback ? 'value' : 'damage') }))
  }
  if (recipe.freeze) {
    body.push({ kind: 'if', id: 'freeze-after-success', condition: out('damage', 'success'), then: [
      call('freeze-clock', 'identity.host-time'), call('freeze-clock-text', 'text.from-number', { value: out('freeze-clock', 'value') }), call('freeze-id', 'text.concat', { left: value('freeze-'), right: out('freeze-clock-text', 'text') }),
      { kind: 'record.create', id: 'freeze-record', schema: 'freeze-payload@1', fields: { id: out('freeze-id', 'text'), type: value('freeze'), currentDuration: value(1), intensity: value(1), relatedRules: { kind: 'literal', value: ['rule-freeze-prevent-move', 'rule-freeze-prevent-skill'] } } },
      call('freeze-status', 'status.apply-record', { target: out('target', 'piece'), record: out('freeze-record', 'value') }, { inputPolicy: 'host' }),
      call('freeze-move-rule', 'rule.apply-piece', { target: out('target', 'piece') }, { ruleId: 'rule-freeze-prevent-move' }),
      call('freeze-skill-rule', 'rule.apply-piece', { target: out('target', 'piece') }, { ruleId: 'rule-freeze-prevent-skill' }),
      call('freeze-skill', 'skill.add', { piece: out('target', 'piece') }, { skillId: 'freeze-prevent' }),
    ] })
  }
  if (recipe.heal !== undefined || recipe.drain) {
    body.push(call('heal', 'effect.heal', { source: out('source', 'piece'), target: out(recipe.drain ? 'source' : 'target', 'piece'), amount: recipe.drain ? out('damage', 'damage') : value(recipe.heal!) }))
    body.push(call('heal-text', 'text.from-number', { value: out('heal', 'heal') }))
  }
  let message: GameplayValue = value('')
  recipe.message.forEach((part, index) => {
    body.push(call('message-' + index, 'text.concat', { left: message, right: typeof part === 'string' ? value(part) : out(part.node, part.port) }))
    message = out('message-' + index, 'text')
  })
  if (recipe.blockedMessage) {
    body.push(call('was-blocked', 'damage.was-blocked', { result: out('damage', 'result') }), {
      kind: 'if', id: 'blocked-message', condition: out('was-blocked', 'value'), then: [call('blocked-text', 'text.concat', { left: out('source-name', 'text'), right: value(recipe.blockedMessage) }), call('blocked-result', 'result.action', { success: value(true), message: out('blocked-text', 'text') }), { kind: 'return', id: 'return-blocked', value: out('blocked-result', 'result') }],
    })
  }
  body.push(call('result', 'result.action', { success: recipe.blockedMessage ? out('damage', 'success') : value(true), message }), { kind: 'return', id: 'return-result', value: out('result', 'result') })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', ...(recipe.freeze ? { schemas: [{ id: 'freeze-payload', version: '1', fields: [{ name: 'id', type: 'string' as const }, { name: 'type', type: 'string' as const }, { name: 'currentDuration', type: 'number' as const }, { name: 'intensity', type: 'number' as const }, { name: 'relatedRules', type: { kind: 'list' as const, element: 'string' as const } }] }] } : {}), outputs: [{ name: 'result', type: 'record', nullable: true }], body }
}

export function migrateTargetEffects(root: string, write = false): string[] {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries
  const documents: { filename: string; id: string; next: ReturnType<typeof applyGameplayModuleGraph> }[] = []
  const generatedFields = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules'])
  for (const id of Object.keys(TARGET_EFFECT_RECIPES)) {
    const filename = path.join(root, 'data', 'skills', id + '.json')
    const current = JSON.parse(fs.readFileSync(filename, 'utf8'))
    const original = baseline['skills/' + id]
    if (!original) throw new Error(`${id}: missing frozen baseline`)
    for (const field of new Set([...Object.keys(current), ...Object.keys(original)])) {
      // Cluster identity/dependencies are authoring metadata; preserve them
      // while checking all actual game fields against the frozen baseline.
      if (field !== 'cluster' && !generatedFields.has(field) && JSON.stringify(current[field]) !== JSON.stringify(original[field])) {
        throw new Error(`${id}: compatibility field changed before migration: ${field}`)
      }
    }
    if (current.gameplayModules) assertGameplayModuleDocument(current)
    if (!current.gameplayModules?.entries?.code) assertFrozenExecutable(current, original, 'code', 'skill', id)
    let next = current.gameplayModules?.entries?.code ? current : applyGameplayModuleGraph(current, buildTargetEffectGraph(id))
    if (original.previewCode && !current.gameplayModules?.entries?.previewCode) next = applyGameplayModuleGraph(next, buildTargetEffectPreview(id), 'previewCode')
    documents.push({ filename, id: 'skills/' + id, next })
  }
  // Validate every candidate before writing any production document.
  if (write) for (const { filename, next } of documents) fs.writeFileSync(filename, JSON.stringify(next, null, 2) + '\n')
  return documents.map(document => document.id)
}
const PREVIEW_TEXT: Record<string, string> = {
  frostbolt: '选择敌人（5），造成1倍伤害，并施加冰冻[1]。',
  ashbringer: '选择敌人（1），造成攻击力的真实伤害。',
  'blessed-hammer': '选择敌人（2），造成1倍伤害。',
  fireball: '选择敌人（5），造成1.5倍伤害。',
  'fel-blessing': '选择全图友军，攻击力+2。目标受到2点真实伤害。',
  'illidan-demon-strike': '选择全图敌人，造成1倍伤害。恶魔变形期间可用2次。',
  'illidan-eye-beam': '选择敌人（4），造成1倍伤害，并回复自身等于实际伤害的点数。',
  'light-of-the-light': '选择友军（7），回复目标5点。',
  'ichigo-zangetsu': '选择敌人（1），造成1倍伤害。',
  'blackwidow-deadly-gaze': '选择敌人（>6），造成2倍伤害。',
}
export function buildTargetEffectPreview(id: string): GameplayModuleGraph {
  if (id === 'venom-claw-rend') return buildSemanticPreviewGraph('function calculatePreview(piece, skillDef) { return { description: "选择敌人（1），造成2倍伤害。", expectedValues: { damage: Math.floor(piece.attack * skillDef.powerMultiplier), range: 1 } }; }')
  const recipe = TARGET_EFFECT_RECIPES[id]
  if (!recipe || !PREVIEW_TEXT[id]) throw new Error('No frozen preview for ' + id)
  const body: GameplayStatement[] = []
  const inputs: Record<string, GameplayValue> = { description: value(PREVIEW_TEXT[id]) }
  if (recipe.attackBonus !== undefined) {
    inputs.attackBonus = value(recipe.attackBonus)
    inputs.selfDamage = value(recipe.amount!)
  } else if (recipe.damage) {
    body.push(call('attack', 'preview.piece-number', { piece: { kind: 'input', name: 'piece' } }, { attribute: 'attack' }))
    inputs.damage = out('attack', 'value')
    if (recipe.multiplier) {
      body.push(call('multiplier', 'preview.skill-number', { skill: { kind: 'input', name: 'skillDef' } }, { attribute: 'powerMultiplier' }),
        call('scaled', 'math.multiply', { left: inputs.damage, right: recipe.previewMultiplier !== undefined ? value(recipe.previewMultiplier) : out('multiplier', 'value') }),
        call('floor', 'math.floor', { value: out('scaled', 'value') }))
      inputs.damage = out('floor', 'value')
    }
    if (recipe.drain) inputs.heal = inputs.damage
  } else if (recipe.heal !== undefined) inputs.heal = value(recipe.heal)
  body.push(call('preview', 'preview.result', inputs), { kind: 'return', id: 'return', value: out('preview', 'result') })
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'preview', inputs: [{ name: 'piece', type: 'piece' }, { name: 'skillDef', type: 'content' }], outputs: [{ name: 'result', type: 'record' }], body }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(migrateTargetEffects(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), process.argv.includes('--write'))))
