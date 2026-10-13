/* eslint-disable @typescript-eslint/no-explicit-any -- Trusted SkillCode fixture contexts. */
import { beforeEach, describe, expect, it } from 'vitest'
import { createSkillCodeFlow, loadAllSkillsById, loadRuleById, clearRuleCache, clearSkillDefinitionCache } from '../../lib/game/skills'
import { convertToTriggerRule } from '../../lib/game/rule-loader'
import { toPublicBattleState } from '../../lib/game/deployment'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBattleAction, hashBattleState } from '../../lib/game/battle-runner'
import { globalTriggerSystem } from '../../lib/game/triggers'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { makePiece, makePlayer, makeState } from '../helpers/minimal-state'
import { applyBattleAction } from '../../lib/game/turn'

beforeEach(() => globalTriggerSystem.clearRules())
function fixture() {
  return makeState({ pieces: [makePiece({ instanceId: 'self' }), makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 3, currentHp: 20 })] })
}
describe('trusted code-node runtime facade', () => {
  it('materializes large verified templates with data bindings without changing their executable or source', () => {
    const battle = fixture()
    const template = { id: 'template', name: '样本', isSample: true, image: 'sample.png', code: 'x'.repeat(70000), gameplayModules: { entries: { code: { graph: {} } } } }
    const flow = createFlowRuntime(battle, {}, 'rule', { loadCardDefinition: () => template })
    const options = { kind: 'card' as const, templateId: 'template', cardId: 'generated', name: '生成卡', description: '说明', fields: { damageAmount: 4, trigger: { type: 'endTurn' } }, extension: { sourcePlayerId: 'player-red' }, omitFields: ['isSample', 'image'] }
    expect(flow.content.materializeTemplate(options)).toEqual({ cardId: 'generated', success: true })
    expect(battle.customCards?.generated).toMatchObject({ code: template.code, damageAmount: 4, extension: { sourcePlayerId: 'player-red' } })
    expect(battle.customCards?.generated).not.toHaveProperty('image')
    expect(template.image).toBe('sample.png')
    const before = JSON.stringify(battle.customCards)
    expect(() => flow.content.materializeTemplate({ ...options, fields: { code: 'bad' } })).toThrow('不可绑定')
    expect(() => flow.content.materializeTemplate({ ...options, omitFields: ['code'] })).toThrow('展示字段')
    expect(() => flow.content.materializeTemplate({ ...options, extension: { text: 'x'.repeat(70000) } })).toThrow('64KB')
    expect(JSON.stringify(battle.customCards)).toBe(before)
  })
  it('isolates loop counters from battle state and other executions', () => {
    const battle = fixture(), before = JSON.stringify(battle)
    const first = createFlowRuntime(battle, {}, 'skill', {}), second = createFlowRuntime(battle, {}, 'skill', {})
    const counter = first.execution.counter(0.5)
    expect(first.execution.addCounter(counter, 2)).toBe(2.5)
    expect(first.execution.readCounter(counter)).toBe(2.5)
    expect(() => first.execution.addCounter(counter, Infinity)).toThrow('有限')
    expect(() => second.execution.readCounter(counter)).toThrow('不属于当前执行')
    expect(() => first.execution.readCounter({ ...counter })).toThrow('不属于当前执行')
    expect(first.execution.readCounter(counter)).toBe(2.5)
    expect(JSON.stringify(battle)).toBe(before)
  })
  it('preserves registered player counter storage and rejects arbitrary paths before mutation', () => {
    const battle = fixture(), flow = createFlowRuntime(battle, {}, 'rule', {})
    const owner = battle.players[0].playerId
    expect(flow.state.getPlayerNumber('contentCounters', owner)).toBe(0)
    flow.state.setPlayerNumber('contentCounters', owner, 2.5)
    flow.state.setPlayerNumber('contentCounters.elPrimoChargeDiscount', owner, 1)
    expect(battle.extensions?.contentCounters).toEqual({ [owner]: 2.5, elPrimoChargeDiscount: { [owner]: 1 } })
    const before = JSON.stringify(battle)
    expect(() => flow.state.setPlayerNumber('contentCounters.other', owner, 3)).toThrow('未注册')
    expect(() => flow.state.setPlayerNumber('contentCounters', owner, NaN)).toThrow('有限')
    expect(() => flow.state.setPlayerNumber('contentCounters', 'missing', 3)).toThrow('玩家不存在')
    expect(JSON.stringify(battle)).toBe(before)
  })
  it('retains an in-progress source without accepting forged or cross-execution handles', () => {
    const battle = fixture(), flow = createSkillCodeFlow(battle, { piece: battle.pieces[0] }, 'skill')
    const handle = flow.effects.captureSource('self')
    battle.pieces = battle.pieces.filter(piece => piece.instanceId !== 'self')
    expect(flow.effects.damageManyCaptured(handle, ['enemy'], 2, 'true').success).toBe(true)
    expect(battle.pieces[0].currentHp).toBe(18)
    expect(() => flow.effects.damageManyCaptured({ ...handle }, ['enemy'], 2, 'true')).toThrow('不属于当前执行')
    const another = createSkillCodeFlow(battle, {}, 'skill')
    another.effects.captureSource('enemy')
    expect(() => another.effects.damageManyCaptured(handle, ['enemy'], 2, 'true')).toThrow('不属于当前执行')
    expect(battle.pieces[0].currentHp).toBe(18)
  })
  it('keeps the captured damage default while allowing an explicit unattributed policy', () => {
    const battle = fixture(), skillIds: unknown[] = []
    const flow = createFlowRuntime(battle, { skill: { id: 'captured-context' } }, 'skill', {
      dealDamage: (_source: unknown, _target: unknown, _amount: number, _type: string, _battle: unknown, skillId?: string) => {
        skillIds.push(skillId)
        return { success: true, damage: 1 }
      },
    })
    const handle = flow.effects.captureSource('self')
    flow.effects.damageManyCaptured(handle, ['enemy'], 1, 'true')
    flow.effects.damageManyCaptured(handle, ['enemy'], 1, 'true', undefined, 'unattributed')
    flow.effects.damageManyCaptured(handle, ['enemy'], 1, 'true', '')
    expect(skillIds).toEqual(['captured-context', undefined, ''])
  })
  it('keeps ritual bookkeeping bound to its captured execution object', () => {
    const battle = fixture(), source = battle.pieces[0], queue: any[] = []
    source.name = '仪式来源'
    const flow = createFlowRuntime(battle, { summonQueue: queue }, 'card', {})
    const handle = flow.effects.captureSource(source.instanceId)
    battle.pieces.splice(0, 1)
    const attack = source.attack
    expect(flow.effects.capturedAttribute(handle, 'attack', 1)).toBe(attack + 1)
    expect(flow.effects.capturedName(handle)).toBe('仪式来源')
    flow.lifecycle.summonCaptured(handle, { x: 2, y: 2 })
    expect(queue).toEqual([{ sourceId: source.instanceId, summons: [{ x: 2, y: 2 }] }])
    expect(() => flow.effects.capturedAttribute({ ...handle }, 'attack', 1)).toThrow('不属于当前执行')
    expect(() => flow.effects.capturedAttribute(handle, 'currentHp' as never, 1)).toThrow('无效结算属性')
    expect(() => flow.lifecycle.summonCaptured({ ...handle }, { x: 2, y: 2 })).toThrow('不属于当前执行')
    expect(battle.pieces.some(piece => piece.instanceId === source.instanceId)).toBe(false)
  })
  it('limits numeric rewrites to the fields owned by the current event', () => {
    for (const type of ['beforeTurnStart', 'beforeMove', 'beforeHealTaken']) {
      const context: any = { type, damage: 4 }, flow = createFlowRuntime(fixture(), context, 'rule', {})
      expect(() => flow.event.modify('damage', 2)).toThrow('当前事件')
      expect(context.damage).toBe(4)
    }
    const context = { type: 'beforeHealTaken', heal: 4 }, flow = createFlowRuntime(fixture(), context, 'rule', {})
    flow.event.modify('heal', 0)
    expect(context.heal).toBe(0)
    expect(() => flow.event.modify('targetX', 2)).toThrow('当前事件')
  })
  it('validates a complete target batch before dispatch and preserves explicit kill ownership', () => {
    const battle = fixture(), calls: any[] = []
    const flow = createFlowRuntime(battle, {}, 'rule', { dealDamage: (...args: any[]) => { calls.push(args); return { success: true } } })
    expect(() => flow.effects.damageMany('self', ['enemy', 'missing'], 2, 'physical')).toThrow('棋子不存在')
    expect(calls).toHaveLength(0)
    flow.effects.damageWithKiller('self', 'enemy', 2.5, 'true', 'test', 'player-blue', 'host')
    expect(calls[0][2]).toBe(2.5)
    expect(calls[0].slice(5)).toEqual(['test', false, 'player-blue'])
    expect(() => flow.effects.damageWithKiller('self', 'enemy', 2, 'true', 'test', 'missing')).toThrow('玩家不存在')
    expect(calls).toHaveLength(1)
  })
  it('separates raw status edits from lifecycle counters and rejects raw death or revival', () => {
    const battle = fixture(), flow = createFlowRuntime(battle, {}, 'rule', {})
    battle.pieces[0].statusTags = [{ id: 'one', type: 'sleep', remainingTurns: 2 }, { id: 'two', type: 'sleep' }] as any
    expect(flow.status.consumeCounter('self', 'one', 'remainingTurns')).toBe(1)
    expect(() => flow.status.consumeCounter('self', 'one', 'currentDuration' as any)).toThrow('状态计数器')
    expect(flow.status.removeRaw('self', 'type', 'sleep')).toBe(true)
    expect(battle.pieces[0].statusTags.map(tag => tag.id)).toEqual(['two'])
    expect(() => flow.attributes.setCurrentHp('self', 0)).toThrow('死亡或复活')
    battle.pieces[1].currentHp = 0
    expect(() => flow.attributes.setCurrentHp('enemy', 10)).toThrow('死亡或复活')
    expect(battle.pieces[1].currentHp).toBe(0)
  })
  it('writes stored numeric and presentation fields with active-first resolution', () => {
    const active = makePiece({ instanceId: 'stored-target', attack: 4 }) as any
    const graveyard = makePiece({ instanceId: 'stored-target', attack: 9 }) as any
    const battle = makeState({ pieces: [active] }) as any
    battle.graveyard = [graveyard]
    const flow = createFlowRuntime(battle, {}, 'skill', {})

    expect(flow.attributes.setStored('stored-target', 'attack', 6.5)).toBe(true)
    expect(active.attack).toBe(6.5)
    expect(graveyard.attack).toBe(9)
    expect(flow.attributes.setStored('stored-target', 'showFreezeEffect', true)).toBe(true)
    expect(active.showFreezeEffect).toBe(true)
    expect(flow.attributes.setStored('missing', 'defense', 2)).toBe(false)
    expect(() => flow.attributes.setStored('stored-target', 'showFreezeEffect', 1 as any)).toThrow('保存属性无效')
    expect(() => flow.attributes.setStored('stored-target', 'attack', true as any)).toThrow('保存属性无效')
    expect(active.attack).toBe(6.5)
  })
  it('rejects non-module templates before creating dynamic content', () => {
    const battle = fixture(), flow = createFlowRuntime(battle, {}, 'skill', { loadCardDefinition: () => ({ id: 'legacy', code: 'function executeCard(){}' }) })
    expect(() => flow.content.materializeTemplate({ kind: 'card', templateId: 'legacy', cardId: 'copy', name: '复制', description: '' })).toThrow('已验证模块图')
    expect(battle.customCards).toBeUndefined()
  })
  it('keeps fractional event writes explicit and rejects writes after settlement or to unrelated fields', () => {
    const battle = fixture(), context: any = { type: 'beforeDamageTaken', damage: 5 }
    const flow = createFlowRuntime(battle, context, 'rule', {})
    flow.event.modify('damage', 1.5, 'host'); expect(context.damage).toBe(1.5)
    flow.event.modify('damage', 1.5); expect(context.damage).toBe(1)
    expect(() => flow.event.modify('damage', NaN, 'host')).toThrow('数值策略')
    expect(() => flow.event.modify('damage', 2, 'invalid' as any)).toThrow('数值策略')
    expect(() => flow.event.modify('playerId' as any, 2, 'host')).toThrow('结果字段')
    context.type = 'afterDamageTaken'
    expect(() => flow.event.modify('damage', 2, 'host')).toThrow('before')
    expect(context.damage).toBe(1)
  })
  it('updates only the identified status and declared numeric fields without emitting removal events', () => {
    const battle = fixture(), flow = createFlowRuntime(battle, {}, 'rule', {})
    battle.pieces[0].statusTags = [{ id: 'one', type: 'shield', intensity: 4 }, { id: 'two', type: 'shield', intensity: 8 }] as any
    expect(flow.status.setNumber('self', 'one', 'intensity', 2.5)).toBe(true)
    expect(flow.status.setNumber('self', 'missing', 'intensity', 2)).toBe(false)
    expect(() => flow.status.setNumber('self', 'one', 'ownerPlayerId', 2)).toThrow('状态数值字段')
    for (const field of ['currentDuration', 'remainingDuration', 'currentUses', 'remainingUses']) expect(() => flow.status.setNumber('self', 'one', field, 0)).toThrow('状态数值字段')
    expect(() => flow.status.setNumber('self', 'one', 'intensity', Infinity)).toThrow('状态数值字段')
    expect(battle.pieces[0].statusTags.map(tag => tag.intensity)).toEqual([2.5, 8])
  })
  it('keeps no-id status instance references exact across reorder and replacement', () => {
    const battle = fixture(), flow = createFlowRuntime(battle, {}, 'rule', {})
    const first = { type: 'momentum-core', stacks: 0, skillIds: ['skill-a'] }, second = { type: 'momentum-core', stacks: 9, skillIds: ['skill-b'] }, unrelated = { type: 'other', stacks: 4 }
    battle.pieces[0].statusTags = [first, second, unrelated] as any
    const handle = flow.status.findInstance('self', 'momentum-core')
    expect(handle).toBeTypeOf('object')
    expect(flow.status.readNumberInstance(handle, 'stacks', 7)).toBe(0)
    expect(flow.status.hasSkillInstance(handle, 'skill-a')).toBe(true)
    expect(flow.status.hasSkillInstance(handle, 'skill-b')).toBe(false)
    expect(flow.status.hasSkillInstance({ ...(handle as object) }, 'skill-a')).toBe(false)
    expect(flow.status.setNumberInstance(handle, 'stacks', 3)).toBe(true)
    const otherFlow = createFlowRuntime(battle, {}, 'rule', {})
    expect(otherFlow.status.readNumberInstance(handle, 'stacks', 7)).toBe(7)
    expect(otherFlow.status.hasSkillInstance(handle, 'skill-a')).toBe(false)
    expect(otherFlow.status.setNumberInstance(handle, 'stacks', 15)).toBe(false)
    expect(first.stacks).toBe(3)
    expect(second.stacks).toBe(9)
    expect(unrelated.stacks).toBe(4)
    expect(first).not.toHaveProperty('id')

    battle.pieces[0].statusTags = [second, first, unrelated] as any
    expect(flow.status.readNumberInstance(handle, 'stacks', 7)).toBe(3)
    battle.pieces[0].statusTags = [second, { type: 'momentum-core', stacks: 12 }, unrelated] as any
    expect(flow.status.readNumberInstance(handle, 'stacks', 7)).toBe(7)
    expect(flow.status.hasSkillInstance(handle, 'skill-a')).toBe(false)
    expect(flow.status.setNumberInstance(handle, 'stacks', 15)).toBe(false)
    expect((battle.pieces[0].statusTags[1] as any).stacks).toBe(12)
    expect(flow.status.readNumberInstance({ ...(handle as object) }, 'stacks', 7)).toBe(7)
  })
  it('retains explicit status origins under host input policy and validates attribute sets', () => {
    const battle = fixture(), flow = createSkillCodeFlow(battle, { piece: battle.pieces[0] }, 'skill')
    flow.status.add('self', { id: 'explicit', type: 'custom', currentDuration: 2 }, 'piece', 'host')
    expect(battle.pieces[0].statusTags.find(tag => tag.id === 'explicit')).not.toHaveProperty('sourceId')
    flow.status.add('self', { id: 'inferred', type: 'another-custom', currentDuration: 2 })
    expect(battle.pieces[0].statusTags.find(tag => tag.id === 'inferred')).toHaveProperty('sourceId', 'self')
    expect(flow.attributes.set('self', 'defense', 0.5)).toBe(0.5)
    expect(() => flow.attributes.set('self', 'defense', Infinity)).toThrow('属性无效')
    expect(() => flow.attributes.set('self', 'x' as any, 5)).toThrow('无效属性')
    expect(battle.pieces[0].defense).toBe(0.5)
  })
  it('preserves authoritative rejection of negative damage under the host input policy', () => {
    const battle = fixture(), flow = createSkillCodeFlow(battle, { piece: battle.pieces[0] }, 'skill')
    expect(() => flow.effects.damage('self', 'enemy', -0.5, 'true', 'negative-input', 'host')).toThrow(/finite non-negative/i)
    expect(battle.pieces[1].currentHp).toBe(20)
  })
  it('probes missing dependencies while preserving references during death settlement', () => {
    const battle = fixture(), flow = createSkillCodeFlow(battle, { piece: battle.pieces[0] }, 'skill')
    expect(flow.query.hasPiece('self')).toBe(true)
    expect(flow.query.hasPlayer('player-red')).toBe(true)
    expect(flow.query.hasPiece(null)).toBe(false)
    expect(flow.query.hasPlayer('missing')).toBe(false)
    battle.pieces[1].currentHp = 0
    expect(flow.query.hasPiece('enemy')).toBe(true)
    battle.pieces.splice(0, 1)
    expect(flow.query.hasPiece('self')).toBe(false)
  })
  it('uses team relations in four seats while ownerId alone remains exact ownership', () => {
    const ids = ['blue1', 'red1', 'red2', 'blue2']
    const battle = makeState({ pieces: ids.map(id => makePiece({ instanceId: id, ownerPlayerId: id })) })
    battle.players = ids.map(id => ({ ...makePlayer(id, id.startsWith('blue') ? 'blue' : 'red'), teamId: id.startsWith('blue') ? 'blue' as const : 'red' as const }))
    const flow = createSkillCodeFlow(battle, { piece: battle.pieces[0] }, 'skill')
    expect(flow.query.pieces({ relation: 'ally' })).toEqual(['blue1', 'blue2'])
    expect(flow.query.pieces({ relation: 'enemy' })).toEqual(['red1', 'red2'])
    expect(flow.query.pieces({ ownerId: 'blue1' })).toEqual(['blue1'])
  })
  it('distinguishes holder/source/target across skill and rule entry points', () => {
    const battle = fixture(), context = { piece: battle.pieces[1], rulePiece: battle.pieces[0], sourcePiece: battle.pieces[1], targetPiece: battle.pieces[0], playerId: 'player-red', triggerPlayerId: 'player-blue' }
    const flow = createSkillCodeFlow(battle, context, 'triggerSkill')
    expect('refs' in flow).toBe(true)
    expect(Object.keys(flow)).toContain('effects')
    expect(flow.refs).toBe(flow.refs)
    expect(flow.refs.holder()).toBe('self'); expect(flow.refs.source()).toBe('enemy')
    expect(flow.refs.player()).toBe('player-red'); expect(flow.refs.eventPlayer()).toBe('player-blue')
    expect(flow.query.pieces({ relation: 'enemy' })).toEqual(['enemy'])
    expect(flow.query.pieces({ ownerId: 'player-red' })).toEqual(['self'])
    expect(() => flow.lifecycle.removeEnemy('enemy')).toThrow('主动技能入口')
    expect(flow.query.distance('self', 'enemy')).toBe(3)
    expect(() => flow.choice.target({})).toThrow('未提供')
    expect(flow.choice.deferTarget({ playerId: 'player-red', targetType: 'piece', candidates: [{ pieceId: 'enemy' }], effectCode: 'function(ctx){return {success:true}}' })).toMatchObject({ needsTargetSelection: true, minSelections: 1 })
  })
  it('stores finite JSON with ownership and lifetime, preserving it through serialization', () => {
    const battle = fixture(), flow = createSkillCodeFlow(battle, { piece: battle.pieces[0] }, 'skill')
    const value = { remaining: 6, sources: ['self'] }
    flow.state.set('piece', 'self', 'naruto', 'meditation', value, 'while-alive')
    value.remaining = 0
    expect(flow.state.get('piece', 'self', 'naruto', 'meditation')).toEqual({ remaining: 6, sources: ['self'] })
    const restored = JSON.parse(JSON.stringify(battle))
    expect(createSkillCodeFlow(restored, {}, 'rule').state.get('piece', 'self', 'naruto', 'meditation')).toEqual({ remaining: 6, sources: ['self'] })
    expect((battle.extensions!.flowState as any[])[0]).toMatchObject({ schemaVersion: 1, ownerPlayerId: 'player-red', projectionVisibility: 'owner' })
    expect(toPublicBattleState(battle, 'player-blue').extensions!.flowState).toEqual([])
    expect(toPublicBattleState(battle, 'player-red').extensions!.flowState).toHaveLength(1)
    const before = JSON.stringify(battle)
    const hidden = Object.defineProperty({}, 'value', { value: 7, enumerable: false })
    const sparse = new Array(1)
    const extra = Object.assign([], { other: 1 })
    for (const invalid of [NaN, sparse, extra, hidden, '😀'.repeat(20000), { fn() {} }, { get x() { throw Error('must not invoke') } }]) expect(() => flow.state.set('piece', 'self', 'naruto', 'meditation', invalid)).toThrow()
    expect(JSON.stringify(battle)).toBe(before)
    battle.pieces[0].currentHp = 0
    expect(flow.state.get('piece', 'self', 'naruto', 'meditation')).toBeUndefined()
    flow.state.cleanup(); expect(battle.extensions!.flowState).toEqual([])
    battle.extensions!.flowState = [{ schemaVersion: 2 }]
    expect(() => flow.state.get('battle', 'battle', 'test', 'value')).toThrow('版本')
  })
  it('injects the facade into inline, triggered and legacy rules with event writeback', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-flow-rules-')), previous = process.env.RVB_PROFILE_ROOT
    const code = 'if(flow.refs.holder()!=="self" || flow.refs.source()!=="enemy" || flow.refs.eventPlayer()!=="player-blue") throw Error("refs"); flow.event.modify("damage", flow.event.read().damage-2); return {success:true,message:"flow rule"};'
    const skill = { id: 'flow-triggered', name: 'flow', kind: 'passive', type: 'normal', actionPointCost: 0, cooldownTurns: 0, maxCharges: 0, powerMultiplier: 1, code: 'function executeSkill(){' + code + '}' }
    try {
      for (const type of ['rules','skills']) mkdirSync(join(root, 'data', type), { recursive: true })
      writeFileSync(join(root, 'data/skills/flow-triggered.json'), JSON.stringify(skill))
      for (const [id, extra] of [['flow-inline', { skillCode: code }], ['flow-rule-trigger', { effect: { type: 'triggerSkill', skillId: skill.id } }]] as const)
        writeFileSync(join(root, 'data/rules', id + '.json'), JSON.stringify({ id, name: id, trigger: { type: 'beforeDamageDealt' }, ...extra }))
      process.env.RVB_PROFILE_ROOT = root; clearRuleCache(); clearSkillDefinitionCache()
      const battle = fixture(); battle.skillsById = { [skill.id]: skill as any }
      const context = (): any => ({ type: 'beforeDamageDealt', rulePiece: battle.pieces[0], sourcePiece: battle.pieces[1], playerId: 'player-red', triggerPlayerId: 'player-blue', damage: 10 })
      for (const rule of [loadRuleById('flow-inline', true)!, loadRuleById('flow-rule-trigger', true)!, convertToTriggerRule({ id: 'legacy-flow', name: 'legacy', trigger: { type: 'beforeDamageDealt' }, effect: { type: 'triggerSkill', skillId: skill.id } } as any)]) {
        const event = context(), result = rule.effect(battle, event)
        expect(result.success, rule.id).toBe(true); expect(event.damage, rule.id).toBe(8)
      }
    } finally {
      clearRuleCache(); clearSkillDefinitionCache()
      if (previous === undefined) delete process.env.RVB_PROFILE_ROOT; else process.env.RVB_PROFILE_ROOT = previous
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('uses actual damage, authoritative movement and status helpers', () => {
    const battle = fixture(), flow = createSkillCodeFlow(battle, { piece: battle.pieces[0] }, 'skill')
    flow.status.add('self', { id: 'root', type: 'root', name: '定身', currentDuration: 1, visible: true })
    expect(flow.effects.move([{ pieceId: 'self', x: 1, y: 0 }], 'walk').success).toBe(false)
    flow.effects.move([{ pieceId: 'self', x: 1, y: 0 }], 'teleport')
    expect(battle.pieces[0].x).toBe(1)
    flow.effects.damage('self', 'enemy', 100, 'true')
    expect(battle.pieces.find(p => p.instanceId === 'enemy')?.currentHp ?? 0).toBe(0)
    expect(() => flow.resources.add('player-red', 'actionPoints', -999)).toThrow('非负')
    expect(flow.resources.add('player-red', 'actionPoints', 3)).toBe(5)
    expect(flow.attributes.percent('self', 'attack', 25)).toBe(2)
  })
  it('exposes flow inside a production active skill and preserves deterministic extension state', () => {
    const battle = fixture()
    const definition: any = { id: 'flow-fixture', name: 'Flow fixture', kind: 'active', type: 'normal', actionPointCost: 1, cooldownTurns: 1, maxCharges: 0, powerMultiplier: 1,
      code: 'function executeSkill(){ const me=flow.refs.holder(); flow.state.set("piece",me,"test","progress",6); flow.effects.damage(me,"enemy",3,"true"); return {success:true,message:"ok"}; }' }
    battle.skillsById = { ...loadAllSkillsById(), [definition.id]: definition }
    battle.pieces[0].skills = [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 } as any]
    const action = { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'self', skillId: definition.id } as const
    const before = hashBattleState(battle), first = runBattleAction(battle, action, { rootSeed: 192 }).state
    const second = runBattleAction(battle, action, { rootSeed: 192 }).state
    expect(first.pieces[1].currentHp).toBe(17)
    expect((first.extensions!.flowState as any[])[0].value).toBe(6)
    expect(hashBattleState(first)).toBe(hashBattleState(second)); expect(hashBattleState(battle)).toBe(before)
  })
  it('requires formal death context for the existing revival result and declared summon writer', () => {
    const battle = fixture(), context: any = { rulePiece: battle.pieces[0], sourcePiece: battle.pieces[0], type: 'beforeDamageDealt' }
    const flow = createFlowRuntime(battle, context, 'rule', {})
    expect(() => flow.lifecycle.reviveAfterDeath(.5)).toThrow('正式死亡')
    context.type = 'onPieceDied'; battle.pieces[0].currentHp = 0
    expect(flow.lifecycle.reviveAfterDeath(.5)).toMatchObject({ summonAfterDeath: { revive: true, attackBonusMultiplier: .5 } })
    expect(() => flow.lifecycle.summon({})).toThrow('summonCapability')
  })
  it('clears while-alive extension at formal death while retaining historical battle data', () => {
    const battle = fixture(), target = battle.pieces[1] as any
    target.statusTags = [{ id: 'covenant', type: 'lich-covenant' }]
    target.rules = [loadRuleById('rule-arthas-lich-covenant')]
    target.initialDefinition = { stats: { maxHp: 20, attack: 10, defense: 0, moveRange: 3 }, skills: [], rules: [], statusTags: [] }
    const flow = createSkillCodeFlow(battle, { piece: battle.pieces[0] }, 'skill')
    flow.state.set('piece', 'enemy', 'test', 'temporary', 7, 'while-alive')
    flow.state.set('piece', 'enemy', 'test', 'battle-limit', 1)
    flow.effects.damage('self', 'enemy', 100, 'true')
    expect(battle.pieces.find(p => p.ownerPlayerId === 'player-blue')!.currentHp).toBe(20)
    expect(flow.state.get('piece', 'enemy', 'test', 'temporary')).toBeUndefined()
    expect(flow.state.get('piece', 'enemy', 'test', 'battle-limit')).toBe(1)
  })
  it('reconstructs ctx.flow after a serialized target selection without copying runtime functions', () => {
    const battle = fixture(), id = 'flow-pending'
    battle.pieces[0].skills = [{ skillId: id, currentCooldown: 0, usesRemaining: -1 } as any]
    battle.skillsById[id] = { id, name: id, description: '', kind: 'active', type: 'normal', cooldownTurns: 1, maxCharges: 0, powerMultiplier: 1, actionPointCost: 1,
      code: 'function executeSkill(context){return {success:true, pendingTargetSelection:{playerId:context.piece.ownerPlayerId,targetType:"cell",range:2,filter:"all",canCancel:false,effectCode:"function(ctx){ctx.flow.state.set(\\"player\\",ctx.playerId,\\"test\\",\\"cell\\",{x:ctx.targetX,y:ctx.targetY});return {success:true};}"}};}' } as any
    const pending = applyBattleAction(battle, { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'self', skillId: id })
    expect(pending.pendingTargetSelection).toBeDefined()
    const reloaded = JSON.parse(JSON.stringify(pending)), session = reloaded.pendingTargetSelection
    const completed = applyBattleAction(reloaded, { type: 'pendingTargetSelect', playerId: 'player-red', targetX: 1, targetY: 0, selectionId: session.selectionId, stateRevision: session.stateRevision })
    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(createSkillCodeFlow(completed, {}, 'pending').state.get('player','player-red','test','cell')).toEqual({ x: 1, y: 0 })
    expect(completed.players[0].actionPoints).toBe(1)
  })
})
