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
    for (const invalid of [NaN, { fn() {} }, { get x() { throw Error('must not invoke') } }]) expect(() => flow.state.set('piece', 'self', 'naruto', 'meditation', invalid)).toThrow()
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
        writeFileSync(join(root, 'data/rules', id + '.json'), JSON.stringify({ id, name: id, trigger: { type: 'beforeDamage' }, ...extra }))
      process.env.RVB_PROFILE_ROOT = root; clearRuleCache(); clearSkillDefinitionCache()
      const battle = fixture(); battle.skillsById = { [skill.id]: skill as any }
      const context = (): any => ({ type: 'beforeDamage', rulePiece: battle.pieces[0], sourcePiece: battle.pieces[1], playerId: 'player-red', triggerPlayerId: 'player-blue', damage: 10 })
      for (const rule of [loadRuleById('flow-inline', true)!, loadRuleById('flow-rule-trigger', true)!, convertToTriggerRule({ id: 'legacy-flow', name: 'legacy', trigger: { type: 'beforeDamage' }, effect: { type: 'triggerSkill', skillId: skill.id } } as any)]) {
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
    expect(() => flow.effects.move([{ pieceId: 'self', x: 1, y: 0 }], 'walk')).toThrow()
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
    const battle = fixture(), context: any = { rulePiece: battle.pieces[0], sourcePiece: battle.pieces[0], type: 'beforeDamage' }
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
