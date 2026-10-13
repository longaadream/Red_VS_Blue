import { describe, expect, it } from 'vitest'
import { addCardToHandWithTriggers, createSkillCodeFlow, gainCardInstance } from '../../lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '../../lib/game/rule-runtime'
import type { CardInstance } from '../../lib/game/battle-types'
import type { TriggerContext } from '../../lib/game/triggers'
import { makeState } from '../helpers/minimal-state'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { applyBattleAction } from '../../lib/game/turn'

const initial = () => ({ type: 'record' as const, schemas: [], value: { executor: 'caster', parts: [1, 2] } })
describe('per-card extension initialization', () => {
  it('compiles a typed card reference and returns the initialized gained instance', () => withRuleRuntime(new RuleRuntime({ rootSeed: 43 }), () => {
    const battle = makeState(); const player = battle.players[0]
    const context = { playerId: player.playerId }
    const flow = createSkillCodeFlow(battle, context, 'skill')
    const graph = { version: 'rvb-gameplay-modules/v1', surface: 'skill', schemas: [{ id: 'card-extension', version: '1', fields: [{ name: 'executor', type: 'string' }] }], outputs: [{ name: 'instance', type: 'record', nullable: true }], body: [
      { kind: 'call', id: 'player', module: 'ref.player', version: '1' },
      { kind: 'call', id: 'card', module: 'ref.card-definition', version: '1', parameters: { cardId: 'watcher-calm' } },
      { kind: 'record.create', id: 'initial', schema: 'card-extension@1', fields: { executor: { kind: 'literal', value: 'caster' } } },
      { kind: 'call', id: 'gain', module: 'author.card.gain', version: '1', parameters: { extensionType: JSON.stringify({ kind: 'record', schema: 'card-extension@1' }) }, inputs: {
        player: { kind: 'output', node: 'player', port: 'player' }, card: { kind: 'output', node: 'card', port: 'card' },
        extension: { kind: 'output', node: 'initial', port: 'value' },
      } },
      { kind: 'return', id: 'done', values: { instance: { kind: 'output', node: 'gain', port: 'instance' } } },
    ] }
    const code = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code
    const result = Function('context', 'flow', 'battle', `return (${code})(context)`)(context, flow, battle)
    expect(result.instance).toBe(player.hand[0])
    expect(result.instance.extension).toEqual({ executor: 'caster' })
  }))
  it('exposes the played instance to before and after play rules, including after payment', () => withRuleRuntime(new RuleRuntime({ rootSeed: 43 }), () => {
    const battle = makeState({ phase: 'action' }); const player = battle.players[0]
    player.hand = [{ cardId: 'extension-card', instanceId: 'extension-instance', ownerPlayerId: player.playerId, extension: { reward: 9 } }]
    Object.assign(battle, { customCards: { 'extension-card': { id: 'extension-card', name: '测试卡', description: '', type: 'active', actionPointCost: 0, code: 'function executeCard(context){return {success:true}}' } } })
    const seen: unknown[] = []
    player.rules = ['beforeCardPlay', 'afterCardPlay'].map(type => ({ id: `observe-${type}`, name: type, trigger: { type }, effect: (_battle: unknown, event: TriggerContext) => {
      seen.push({ type, id: event.cardInstance?.instanceId, extension: event.cardInstance?.extension })
      return { success: true }
    } }))
    const next = applyBattleAction(battle, { type: 'playCard', playerId: player.playerId, cardInstanceId: 'extension-instance' })
    expect(seen).toEqual(['beforeCardPlay', 'afterCardPlay'].map(type => ({ type, id: 'extension-instance', extension: { reward: 9 } })))
    expect(next.players[0].hand).toHaveLength(0)
  }))
  it('initializes independent instances before both gain events', () => withRuleRuntime(new RuleRuntime({ rootSeed: 43 }), () => {
    const battle = makeState()
    const player = battle.players[0]
    const observations: Array<{ type: string; instance: CardInstance; inHand: boolean }> = []
    player.rules = ['beforeCardAdded', 'afterCardAdded'].map(type => ({
      id: `observe-${type}`, name: type, trigger: { type },
      effect: (_state: unknown, context: TriggerContext) => {
        expect(context.cardInstance?.extension).toEqual({ executor: 'caster', parts: [1, 2] })
        observations.push({ type, instance: context.cardInstance!, inHand: player.hand.includes(context.cardInstance!) })
        return { success: true }
      },
    }))
    const values = initial()
    const first = gainCardInstance(battle, 'watcher-calm', player.playerId, undefined, values)
    const second = gainCardInstance(battle, 'watcher-calm', player.playerId, undefined, values)
    expect(first.placement).toBe('hand')
    expect(first.instance?.instanceId).not.toBe(second.instance?.instanceId)
    expect(observations.map(item => item.inHand)).toEqual([false, true, false, true])
    expect(observations[0].instance).toBe(first.instance)
    expect(observations[1].instance).toBe(first.instance)
    ;(first.instance!.extension!.parts as number[]).push(3)
    expect(second.instance!.extension!.parts).toEqual([1, 2])
    expect(values.value.parts).toEqual([1, 2])
  }))
  it('returns the newly created discarded instance when the hand is full', () => withRuleRuntime(new RuleRuntime({ rootSeed: 43 }), () => {
    const battle = makeState(); const player = battle.players[0]
    player.hand = Array.from({ length: 10 }, (_, index) => ({ cardId: 'watcher-calm', instanceId: `old-${index}`, ownerPlayerId: player.playerId }))
    const original = [...player.hand]
    const result = gainCardInstance(battle, 'watcher-calm', player.playerId, undefined, initial())
    expect(result).toMatchObject({ success: false, placement: 'discard', instance: { extension: initial().value } })
    expect(player.hand).toEqual(original)
    expect(player.discardPile).toEqual(['watcher-calm'])
  }))
  it('does not place a rejected instance and preserves the boolean legacy API', () => withRuleRuntime(new RuleRuntime({ rootSeed: 43 }), () => {
    const battle = makeState(); const player = battle.players[0]
    player.rules = [{ id: 'block-card', name: 'block', trigger: { type: 'beforeCardAdded' }, effect: () => ({ blocked: true, success: true }) }]
    expect(gainCardInstance(battle, 'watcher-calm', player.playerId, undefined, initial())).toEqual({ success: false, instance: null, placement: 'rejected' })
    expect(player.hand).toEqual([]); expect(player.discardPile).toEqual([])
    expect(addCardToHandWithTriggers(battle, 'watcher-calm', player.playerId)).toBe(false)
  }))
  it('rejects invalid or cyclic initialization before allocating or firing events', () => withRuleRuntime(new RuleRuntime({ rootSeed: 43 }), () => {
    const battle = makeState(); const player = battle.players[0]
    let attempts = 0
    player.rules = [{ id: 'observe', name: 'observe', trigger: { type: 'beforeCardAdded' }, effect: () => { attempts++; return { success: true } } }]
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    expect(() => gainCardInstance(battle, 'watcher-calm', player.playerId, undefined, { type: 'record', schemas: [], value: cyclic })).toThrow()
    expect(attempts).toBe(0); expect(player.hand).toHaveLength(0)
  }))
})
