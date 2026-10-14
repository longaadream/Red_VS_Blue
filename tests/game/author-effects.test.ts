/* eslint-disable @typescript-eslint/no-explicit-any -- the author-effect facade is intentionally data-shaped. */
import { runInNewContext } from 'node:vm'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createFlowRuntime } from '@/lib/game/flow-runtime'
import { createSkillCodeFlow, dealDamage, executeCardFunction, healDamage } from '@/lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { applyBattleAction } from '@/lib/game/turn'
import { globalTriggerSystem } from '@/lib/game/triggers'
import {
  compileGameplayModuleGraph,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  GAMEPLAY_MODULE_REGISTRY,
} from '@/lib/skill-graph/module-document'
import type { GameplayModuleGraph, GameplayValue } from '@/lib/skill-graph/module-types'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const literal = (value: unknown): GameplayValue => ({ kind: 'literal', value: value as never })

function fixture(options: { targetHp?: number; secondHp?: number } = {}) {
  const source = asPieceInstance(makePiece({ instanceId: 'author-source', ownerPlayerId: 'player-red' }))
  const target = asPieceInstance(makePiece({
    instanceId: 'author-target', ownerPlayerId: 'player-blue', currentHp: options.targetHp ?? 20, maxHp: 20,
  }))
  const second = asPieceInstance(makePiece({
    instanceId: 'author-second', ownerPlayerId: 'player-blue', currentHp: options.secondHp ?? 20, maxHp: 20,
  }))
  const state = makeState({ pieces: [source, target, second] }) as any
  return { state, source, target, second }
}

function runtimeFor(state: any, context: any = {}) {
  const calls = { damage: 0, heal: 0 }
  const flow = createFlowRuntime(state, context, 'skill', {
    prepareAuthorEffect: (_kind: 'damage' | 'heal', amount: number) => amount,
    authorDealDamage: (attacker: any, targets: any, amount: number, type: any, battle: any, skillId?: string) => {
      calls.damage += 1
      return dealDamage(attacker, targets, amount, type, battle, skillId)
    },
    authorHealDamage: (healer: any, targets: any, amount: number, battle: any, skillId?: string) => {
      calls.heal += 1
      return healDamage(healer, targets, amount, battle, skillId)
    },
  })
  return { flow: flow as any, calls }
}

function sourceCard(state: any) {
  const card = { instanceId: 'author-card', cardId: 'card-template', ownerPlayerId: 'player-red', name: '作者卡牌' }
  state.players[0].hand = [card]
  return card
}

function damageGraph(): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    body: [
      { kind: 'call', id: 'source', module: 'ref.source', version: '1' },
      { kind: 'call', id: 'target', module: 'ref.target', version: '1' },
      {
        kind: 'call',
        id: 'effect',
        module: 'author.effect.damage',
        version: '2',
        inputs: {
          source: output('source', 'piece'),
          target: output('target', 'piece'),
          amount: literal(3),
        },
        parameters: {
          sourceType: 'piece',
          targetType: 'piece',
          amountType: 'number',
          resultType: 'record',
          damageType: 'true',
          skillId: 'compiled-author-effect',
        },
      },
      { kind: 'return', id: 'done', values: { result: output('effect', 'result') } },
    ],
    outputs: [{ name: 'result', type: 'record' }],
  }
}

function tupleDamageGraph(): GameplayModuleGraph {
  const pieceList = JSON.stringify({ kind: 'list', element: 'piece' })
  const numberList = JSON.stringify({ kind: 'list', element: 'number' })
  const recordList = JSON.stringify({ kind: 'list', element: 'record' })
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    body: [
      { kind: 'call', id: 'source', module: 'ref.source', version: '1' },
      {
        kind: 'call', id: 'targets', module: 'query.pieces', version: '1',
        inputs: { originId: output('source', 'piece') },
        parameters: { relation: 'enemy', includeDead: false },
      },
      {
        kind: 'call',
        id: 'effect',
        module: 'author.effect.damage',
        version: '2',
        inputs: {
          source: output('source', 'piece'),
          target: output('targets', 'pieces'),
          amount: literal([2, 3]),
        },
        parameters: {
          sourceType: 'piece',
          targetType: pieceList,
          amountType: numberList,
          resultType: recordList,
          damageType: 'true',
          skillId: 'compiled-author-tuple',
        },
      },
      { kind: 'return', id: 'done', values: { result: output('effect', 'result') } },
    ],
    outputs: [{ name: 'result', type: { kind: 'list', element: 'record' } }],
  }
}

function typedClusterDamageGraph(): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    body: [
      { kind: 'call', id: 'source', module: 'ref.source', version: '1' },
      { kind: 'call', id: 'target', module: 'ref.target', version: '1' },
      {
        kind: 'call',
        id: 'effect',
        module: 'author.effect.damage',
        version: '3',
        inputs: {
          source: output('source', 'piece'),
          target: output('target', 'piece'),
          amount: literal(3),
        },
        parameters: {
          sourceType: 'piece',
          targetType: 'piece',
          amountType: 'number',
          resultType: 'record',
          damageType: 'true',
        },
      },
      { kind: 'return', id: 'done', values: { result: output('effect', 'result') } },
    ],
    outputs: [{ name: 'result', type: 'record' }],
  }
}

describe('author effect runtime', () => {
  beforeEach(() => globalTriggerSystem.clearRules())
  afterEach(() => globalTriggerSystem.clearRules())

  it.each([false, true])('preserves the piece source with independent kill attribution (queued=%s)', queued => {
    const run = (authored: boolean) => {
      globalTriggerSystem.clearRules()
      const { state, source, target } = fixture({ targetHp: 20 })
      source.currentHp = 2
      const perform = (context: any = {}) => {
        if (!authored && queued) {
          context.damageQueue.push({ attacker: source, target: source, damage: 999, damageType: 'true', skillId: 'undying-expire', killerPlayerId: 'player-blue' })
        } else if (!authored) dealDamage(source, source, 999, 'true', state, 'undying-expire', false, 'player-blue')
        else createSkillCodeFlow(state, { ...context, piece: source }, queued ? 'rule' : 'skill').effects.apply(
          'damage', source.instanceId, 'piece', source.instanceId, 999, 'true', 'undying-expire', 'player-blue',
        )
      }
      if (queued) {
        globalTriggerSystem.addRule({
          id: 'attribution-test', name: 'attribution-test', description: '', trigger: { type: 'afterDamageDealt' },
          effect: (_battle: any, context: any) => { if (context.skillId === 'attribution-root') perform(context); return { success: true } },
        } as any)
        dealDamage(source, target, 1, 'true', state, 'attribution-root')
      } else perform()
      return {
        hp: state.pieces.map((piece: any) => [piece.instanceId, piece.currentHp]),
        graveyard: state.graveyard.map((piece: any) => piece.instanceId),
        credits: state.players.map((player: any) => [player.playerId, player.chargePoints]),
        damage: state.actions.filter((action: any) => action.type === 'damage').map((action: any) => ({
          sourceId: action.payload.sourceId, targetId: action.payload.targetId, damageSource: action.payload.damageSource, skillId: action.payload.skillId,
        })),
      }
    }
    const legacy = run(false), authored = run(true)
    expect(authored).toEqual(legacy)
    expect(authored.graveyard).toContain('author-source')
    expect(authored.damage.at(-1)).toMatchObject({ sourceId: 'author-source', skillId: 'undying-expire' })
  })

  it('rejects an invalid kill attribution before effects or modifiers run', () => {
    const { state, source, target } = fixture()
    const { flow, calls } = runtimeFor(state)
    expect(() => flow.effects.apply('damage', source.instanceId, 'piece', target.instanceId, 1, 'true', 'invalid-killer', 'missing-player')).toThrow('击杀归属')
    expect(calls.damage).toBe(0)
    expect(target.currentHp).toBe(20)
  })

  it('applies one target and returns the authoritative scalar damage result', () => {
    const { state, source, target } = fixture()
    const { flow, calls } = runtimeFor(state)

    const result = flow.effects.apply('damage', source.instanceId, 'piece', target.instanceId, 3, 'true', 'author-scalar')

    expect(calls.damage).toBe(1)
    expect(result).toMatchObject({ success: true, targetId: target.instanceId, damage: 3, damageType: 'true' })
    expect(target.currentHp).toBe(17)
  })

  it('preserves ordered target and amount tuples while dispatching each pair independently', () => {
    const { state, source, target, second } = fixture()
    const { flow, calls } = runtimeFor(state)

    const results = flow.effects.apply(
      'damage', source.instanceId, 'piece', [second.instanceId, target.instanceId], [2, 5], 'true', 'author-tuple',
    )

    expect(calls.damage).toBe(2)
    expect(results.map((entry: any) => [entry.targetId, entry.damage])).toEqual([
      [second.instanceId, 2], [target.instanceId, 5],
    ])
    expect(second.currentHp).toBe(18)
    expect(target.currentHp).toBe(15)
  })

  it('broadcasts one scalar amount through one authoritative batch and keeps output order', () => {
    const { state, source, target, second } = fixture()
    const { flow, calls } = runtimeFor(state)

    const results = flow.effects.apply(
      'damage', source.instanceId, 'piece', [second.instanceId, target.instanceId], 4, 'true', 'author-broadcast',
    )

    expect(calls.damage).toBe(1)
    expect(results.map((entry: any) => entry.targetId)).toEqual([second.instanceId, target.instanceId])
    expect(results.map((entry: any) => entry.damage)).toEqual([4, 4])
    expect(second.currentHp).toBe(16)
    expect(target.currentHp).toBe(16)
  })

  it('heals scalar and ordered tuple targets through the same facade', () => {
    const { state, source, target, second } = fixture({ targetHp: 8, secondHp: 10 })
    const { flow, calls } = runtimeFor(state)

    const scalar = flow.effects.apply('heal', source.instanceId, 'piece', target.instanceId, 4, 'normal', 'author-heal')
    const tuple = flow.effects.apply(
      'heal', source.instanceId, 'piece', [second.instanceId, target.instanceId], [3, 2], 'normal', 'author-heal-tuple',
    )

    expect(calls.heal).toBe(3)
    expect(scalar).toMatchObject({ success: true, targetId: target.instanceId, heal: 4, targetHp: 12 })
    expect(tuple.map((entry: any) => [entry.targetId, entry.heal])).toEqual([
      [second.instanceId, 3], [target.instanceId, 2],
    ])
    expect(second.currentHp).toBe(13)
    expect(target.currentHp).toBe(14)
  })

  it.each([
    ['player', 'player-red'],
    ['card', 'author-card'],
  ] as const)('supports %s healing attribution through the current HealBatch host', (sourceKind, sourceId) => {
    const { state, target } = fixture({ targetHp: 8 })
    if (sourceKind === 'card') sourceCard(state)
    const { flow } = runtimeFor(state)

    const result = flow.effects.apply('heal', sourceId, sourceKind, target.instanceId, 3, 'normal', `author-heal-${sourceKind}`)

    expect(result).toMatchObject({ success: true, sourceId, targetId: target.instanceId, heal: 3 })
    expect(target.currentHp).toBe(11)
  })

  it('keeps player/card healing event attribution explicit without inventing a source piece', () => {
    const { state, target } = fixture({ targetHp: 8 })
    const card = sourceCard(state)
    const events: any[] = []
    for (const type of ['beforeHealDealt', 'beforeHealTaken', 'afterHealDealt', 'afterHealTaken']) {
      globalTriggerSystem.addRule({
        id: `author-heal-source-${type}`,
        name: `author-heal-source-${type}`,
        description: '',
        trigger: { type },
        effect: (_battle: any, context: any) => {
          events.push({
            type,
            piece: context.piece?.instanceId,
            sourcePiece: context.sourcePiece?.instanceId,
            targetPiece: context.targetPiece?.instanceId,
            healSource: context.healSource,
          })
          return { success: true }
        },
      } as any)
    }
    const { flow } = runtimeFor(state, { cardInstance: card })

    flow.effects.apply('heal', 'player-red', 'player', target.instanceId, 1, 'normal', 'author-player-heal-events')
    flow.effects.apply('heal', card.instanceId, 'card', target.instanceId, 1, 'normal', 'author-card-heal-events')

    expect(events).toHaveLength(8)
    for (const source of [
      { skillId: 'author-player-heal-events', kind: 'player', sourceId: 'player-red', playerId: 'player-red' },
      { skillId: 'author-card-heal-events', kind: 'card', sourceId: card.instanceId, playerId: 'player-red' },
    ]) {
      const sourceEvents = events.filter(event => event.healSource?.sourceId === source.sourceId)
      expect(sourceEvents).toHaveLength(4)
      expect(sourceEvents.map(event => event.type)).toEqual([
        'beforeHealDealt', 'beforeHealTaken', 'afterHealDealt', 'afterHealTaken',
      ])
      expect(sourceEvents.map(event => event.healSource)).toEqual([
        { kind: source.kind, sourceId: source.sourceId, playerId: source.playerId },
        { kind: source.kind, sourceId: source.sourceId, playerId: source.playerId },
        { kind: source.kind, sourceId: source.sourceId, playerId: source.playerId },
        { kind: source.kind, sourceId: source.sourceId, playerId: source.playerId },
      ])
      expect(sourceEvents.filter(event => event.type === 'beforeHealDealt' || event.type === 'afterHealDealt'))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ piece: undefined, sourcePiece: undefined, targetPiece: target.instanceId }),
        ]))
      expect(sourceEvents.filter(event => event.type === 'beforeHealTaken' || event.type === 'afterHealTaken'))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ piece: target.instanceId, sourcePiece: target.instanceId, targetPiece: undefined }),
        ]))
    }
    expect(target.currentHp).toBe(10)
  })

  it('uses author damage/heal delegates in a real card facade despite legacy modifier overrides', () => {
    const { state, source, target, second } = fixture({ targetHp: 20, secondHp: 10 })
    const card = sourceCard(state) as any
    card.cardId = 'author-card-facade'
    card.effectModifiers = [
      { effect: 'damage', operation: 'multiply', value: 1.5 },
      { effect: 'heal', operation: 'multiply', value: 1.5 },
    ]
    const cardDef = {
      id: 'author-card-facade',
      name: 'Author facade',
      description: '',
      type: 'active',
      actionPointCost: 0,
      code: `function executeCard(context) {
        const target = context.battle.pieces.find(piece => piece.instanceId === 'author-target');
        const second = context.battle.pieces.find(piece => piece.instanceId === 'author-second');
        const pieceSource = context.battle.pieces.find(piece => piece.instanceId === 'author-source');
        return {
          success: true,
          pieceDamage: flow.effects.apply('damage', pieceSource.instanceId, 'piece', target.instanceId, 2, 'true', 'card-piece-author'),
          playerDamage: flow.effects.apply('damage', context.playerId, 'player', target.instanceId, 2, 'true', 'card-player-author'),
          cardDamage: flow.effects.apply('damage', context.cardInstance.instanceId, 'card', target.instanceId, 2, 'true', 'card-card-author'),
          playerHeal: flow.effects.apply('heal', context.playerId, 'player', second.instanceId, 2, 'normal', 'card-player-heal-author'),
          cardHeal: flow.effects.apply('heal', context.cardInstance.instanceId, 'card', second.instanceId, 2, 'normal', 'card-card-heal-author'),
        };
      }`,
    } as any

    const result = executeCardFunction(cardDef, 'player-red', state, undefined, undefined, undefined, undefined, [], card)

    expect(result).toMatchObject({
      success: true,
      pieceDamage: { success: true, damage: 3, damageSource: { kind: 'piece', sourceId: source.instanceId, playerId: 'player-red' } },
      playerDamage: { success: true, damage: 3, damageSource: { kind: 'player', sourceId: 'player-red', playerId: 'player-red' } },
      cardDamage: { success: true, damage: 3, damageSource: { kind: 'card', sourceId: card.instanceId, playerId: 'player-red' } },
      playerHeal: { success: true, heal: 3, sourceId: 'player-red' },
      cardHeal: { success: true, heal: 3, sourceId: card.instanceId },
    })
    expect(target.currentHp).toBe(11)
    expect(second.currentHp).toBe(16)
    expect(state.actions.filter((action: any) => action.type === 'damage').map((action: any) => action.payload.damageSource)).toEqual([
      { kind: 'piece', sourceId: source.instanceId, playerId: 'player-red' },
      { kind: 'player', sourceId: 'player-red', playerId: 'player-red' },
      { kind: 'card', sourceId: card.instanceId, playerId: 'player-red' },
    ])
  })

  it('applies card author damage and healing through applyBattleAction once with the card modifier', () => {
    const { state, source, target } = fixture({ targetHp: 20 })
    source.currentHp = 80
    const card = sourceCard(state) as any
    card.cardId = 'author-card-apply'
    card.effectModifiers = [
      { effect: 'damage', operation: 'multiply', value: 1.5 },
      { effect: 'heal', operation: 'multiply', value: 1.5 },
    ]
    state.customCards = {
      'author-card-apply': {
        id: 'author-card-apply',
        name: 'Author apply facade',
        description: '',
        type: 'active',
        actionPointCost: 0,
        code: `function executeCard(context) {
          const target = context.battle.pieces.find(piece => piece.instanceId === 'author-target');
          const source = context.battle.pieces.find(piece => piece.instanceId === 'author-source');
          const damage = flow.effects.apply('damage', source.instanceId, 'piece', target.instanceId, 2, 'true', 'card-apply-damage');
          const heal = flow.effects.apply('heal', context.playerId, 'player', source.instanceId, 2, 'normal', 'card-apply-heal');
          context.battle.extensions.authorCardObserved = { damage, heal };
          return { success: true, message: 'author effects applied' };
        }`,
      },
    }

    const next = withRuleRuntime(new RuleRuntime({ rootSeed: 20261013 }), () => applyBattleAction(
      state,
      { type: 'playCard', playerId: 'player-red', cardInstanceId: card.instanceId },
    ))
    const nextSource = next.pieces.find(piece => piece.instanceId === source.instanceId) as any
    const nextTarget = next.pieces.find(piece => piece.instanceId === target.instanceId) as any
    const observed = next.extensions?.authorCardObserved as any

    expect(nextSource.currentHp).toBe(83)
    expect(nextTarget.currentHp).toBe(17)
    expect(observed).toMatchObject({
      damage: {
        success: true,
        damage: 3,
        damageSource: { kind: 'piece', sourceId: source.instanceId, playerId: 'player-red' },
      },
      heal: { success: true, heal: 3, sourceId: 'player-red', targetId: source.instanceId },
    })
    expect(next.actions?.filter(action => action.type === 'damage').map(action => action.payload)).toEqual([
      expect.objectContaining({
        sourceId: source.instanceId,
        targetId: target.instanceId,
        finalDamage: 3,
        damageSource: { kind: 'piece', sourceId: source.instanceId, playerId: 'player-red' },
      }),
    ])
  })

  it('rejects a card code replacement of context.cardInstance before author effects run', () => {
    const { state, target } = fixture({ targetHp: 20 })
    const card = sourceCard(state) as any
    card.cardId = 'author-card-identity'
    state.customCards = {
      'author-card-identity': {
        id: 'author-card-identity',
        name: 'Author identity guard',
        description: '',
        type: 'active',
        actionPointCost: 0,
        code: `function executeCard(context) {
          context.cardInstance = { instanceId: 'forged-card-instance', cardId: 'author-card-identity', ownerPlayerId: context.playerId };
          return flow.effects.apply('damage', context.playerId, 'player', 'author-target', 2, 'true', 'card-forged-source');
        }`,
      },
    }

    expect(() => withRuleRuntime(new RuleRuntime({ rootSeed: 20261013 }), () => applyBattleAction(
      state,
      { type: 'playCard', playerId: 'player-red', cardInstanceId: card.instanceId },
    ))).toThrow(/authoritative card instance/)
    expect(target.currentHp).toBe(20)
    expect(state.players[0].hand).toEqual([card])
    expect(state.actions).toEqual([])
  })

  it('applies a reactive card modifier once when scalar author damage is queued inside damage resolution', () => {
    const { state, source, target } = fixture({ targetHp: 20 })
    const card = sourceCard(state) as any
    card.cardId = 'author-reactive-card'
    card.effectModifiers = [{ effect: 'damage', operation: 'multiply', value: 1.5 }]
    state.customCards = {
      'author-reactive-card': {
        id: 'author-reactive-card',
        name: 'Reactive author damage',
        description: '',
        type: 'reactive',
        trigger: { type: 'afterDamageDealt' },
        code: `function executeCard(context) {
          const target = context.battle.pieces.find(piece => piece.instanceId === 'author-target');
          context.battle.extensions.reactiveAuthorQueued = flow.effects.apply(
            'damage', context.cardInstance.instanceId, 'card', target.instanceId, 2, 'true', 'reactive-author-damage',
          );
          return { success: true };
        }`,
      },
    }

    withRuleRuntime(new RuleRuntime({ rootSeed: 20261013 }), () => {
      dealDamage(source, target, 2, 'true', state, 'root-author-damage')
    })

    expect(target.currentHp).toBe(15)
    expect(state.extensions?.reactiveAuthorQueued).toEqual({ queued: true, targetId: target.instanceId })
    expect(state.actions?.filter((action: { type: string }) => action.type === 'damage').map((action: { payload: unknown }) => action.payload)).toEqual([
      expect.objectContaining({ skillId: 'root-author-damage', finalDamage: 2 }),
      expect.objectContaining({
        skillId: 'reactive-author-damage',
        sourceId: card.instanceId,
        finalDamage: 3,
        damageSource: { kind: 'card', sourceId: card.instanceId, playerId: 'player-red' },
      }),
    ])
    expect(state.players[0].hand).toEqual([])
    expect(state.players[0].discardPile).toEqual([card.cardId])
  })

  it('rejects an unequal amount tuple before any host call or state mutation', () => {
    const { state, source, target, second } = fixture()
    const { flow, calls } = runtimeFor(state)
    const before = { targetHp: target.currentHp, secondHp: second.currentHp, actions: JSON.stringify(state.actions) }

    expect(() => flow.effects.apply(
      'damage', source.instanceId, 'piece', [target.instanceId, second.instanceId], [3], 'true', 'author-invalid-tuple',
    )).toThrow('效果数值须与目标逐项对应')

    expect(calls.damage).toBe(0)
    expect({ targetHp: target.currentHp, secondHp: second.currentHp, actions: JSON.stringify(state.actions) }).toEqual(before)
  })

  it('returns a stable skipped record for a missing target while resolving live entries', () => {
    const { state, source, target } = fixture()
    const { flow, calls } = runtimeFor(state)

    const results = flow.effects.apply(
      'damage', source.instanceId, 'piece', ['missing-target', target.instanceId], [7, 2], 'true', 'author-missing-target',
    )

    expect(calls.damage).toBe(1)
    expect(results[0]).toMatchObject({ success: false, targetId: 'missing-target', damage: 0, skipped: 'target-unavailable' })
    expect(results[1]).toMatchObject({ success: true, targetId: target.instanceId, damage: 2 })
    expect(target.currentHp).toBe(18)
  })

  it('preserves duplicate explicit target tuple entries as ordered independent effects', () => {
    const { state, source, target } = fixture()
    const { flow, calls } = runtimeFor(state)

    const results = flow.effects.apply(
      'damage', source.instanceId, 'piece', [target.instanceId, target.instanceId], [2, 3], 'true', 'author-duplicate-tuple',
    )

    expect(calls.damage).toBe(2)
    expect(results.map((entry: any) => [entry.targetId, entry.damage])).toEqual([
      [target.instanceId, 2], [target.instanceId, 3],
    ])
    expect(target.currentHp).toBe(15)
  })

  it('splits scalar broadcast over duplicate tuple positions into ordered singleton effects', () => {
    const { state, source, target } = fixture()
    const { flow, calls } = runtimeFor(state)

    const results = flow.effects.apply(
      'damage', source.instanceId, 'piece', [target.instanceId, target.instanceId], 2, 'true', 'author-duplicate-broadcast',
    )

    expect(calls.damage).toBe(2)
    expect(results.map((entry: any) => [entry.targetId, entry.damage])).toEqual([
      [target.instanceId, 2], [target.instanceId, 2],
    ])
    expect(target.currentHp).toBe(16)
  })

  it.each([
    ['piece', 'author-source'],
    ['player', 'player-red'],
    ['card', 'author-card'],
  ] as const)('preserves %s damage attribution in the real host pipeline', (sourceKind, sourceId) => {
    const { state, target } = fixture()
    if (sourceKind === 'card') sourceCard(state)
    const { flow } = runtimeFor(state)

    const result = flow.effects.apply('damage', sourceId, sourceKind, target.instanceId, 2, 'true', `author-${sourceKind}`)

    expect(result).toMatchObject({
      success: true,
      damage: 2,
      damageSource: { kind: sourceKind, sourceId },
    })
    expect(target.currentHp).toBe(18)
    expect(state.actions.find((action: any) => action.type === 'damage')?.payload).toMatchObject({
      sourceId,
      damageSource: { kind: sourceKind, sourceId },
    })
  })

  it('rejects missing effect sources before changing the target', () => {
    const { state, target } = fixture()
    const { flow } = runtimeFor(state)
    const before = { hp: target.currentHp, actions: JSON.stringify(state.actions) }

    expect(() => flow.effects.apply('damage', 'missing-source', 'piece', target.instanceId, 3, 'true', 'author-missing-source'))
      .toThrow('效果来源棋子已失效')

    expect({ hp: target.currentHp, actions: JSON.stringify(state.actions) }).toEqual(before)
  })

  it('lets an afterDamageDealt rule enqueue a bounded follow-up in the active effect chain', () => {
    const { state, source, target } = fixture()
    globalTriggerSystem.addRule({
      id: 'author-effect-follow-up',
      name: 'author-effect-follow-up',
      description: '',
      trigger: { type: 'afterDamageDealt' },
      effect: (_battle: any, context: any) => {
        if (context.skillId === 'author-chain-root') {
          context.damageQueue.push({
            attacker: context.sourcePiece,
            target: context.targetPiece,
            damage: 3,
            damageType: 'true',
            skillId: 'author-chain-follow-up',
          })
        }
        return { success: true }
      },
    } as any)
    const { flow } = runtimeFor(state)

    const result = withRuleRuntime(new RuleRuntime({ rootSeed: 20261013, tick: 1 }), () =>
      flow.effects.apply('damage', source.instanceId, 'piece', target.instanceId, 2, 'true', 'author-chain-root'))

    expect(result).toMatchObject({ success: true, damage: 2, targetHp: 18 })
    expect(target.currentHp).toBe(15)
    expect(state.actions.filter((action: any) => action.type === 'damage').map((action: any) => action.payload.skillId))
      .toEqual(['author-chain-root', 'author-chain-follow-up'])
  })

  it('enters the author facade from a real afterDamageDealt rule and queues the follow-up', () => {
    const { state, source, target } = fixture()
    globalTriggerSystem.addRule({
      id: 'author-effect-reentry-rule',
      name: 'author-effect-reentry-rule',
      description: '',
      trigger: { type: 'afterDamageDealt' },
      effect: (battle: any, context: any) => {
        if (context.skillId !== 'author-rule-root') return { success: true }
        const ruleFlow = createSkillCodeFlow(battle, {
          ...context,
          piece: context.sourcePiece,
          sourcePiece: context.sourcePiece,
          targetPiece: context.targetPiece,
          target: context.targetPiece,
          skill: { id: 'author-effect-reentry-rule' },
        }, 'rule') as any
        battle.extensions.authorFacadeQueued = ruleFlow.effects.apply(
          'damage', context.sourcePiece.instanceId, 'piece', context.targetPiece.instanceId, 1, 'true', 'author-nested-effect',
        )
        return { success: true }
      },
    } as any)
    const { flow } = runtimeFor(state)

    const result = flow.effects.apply('damage', source.instanceId, 'piece', target.instanceId, 2, 'true', 'author-rule-root')

    expect(result).toMatchObject({ success: true, damage: 2 })
    expect(state.extensions.authorFacadeQueued).toEqual({ queued: true, targetId: target.instanceId })
    expect(Object.keys(state.extensions.authorFacadeQueued)).toEqual(['queued', 'targetId'])
    expect(target.currentHp).toBe(17)
    expect(state.actions.filter((action: any) => action.type === 'damage').map((action: any) => action.payload.skillId))
      .toEqual(['author-rule-root', 'author-nested-effect'])
  })

  it.each(['damage', 'heal'] as const)('invalidates a queued author %s after its source dies while continuing the next effect', kind => {
    const { state, source, target, second } = fixture({ targetHp: 1, secondHp: 10 })
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    globalTriggerSystem.addRule({
      id: 'author-expiring-source', name: 'author-expiring-source', description: '',
      trigger: { type: 'beforeDamageTaken' },
      effect: (battle: any, context: any) => {
        if (context.skillId !== 'author-expiring-root') return { success: true }
        const ruleFlow = createSkillCodeFlow(battle, { ...context, rulePiece: target }, 'rule') as any
        ruleFlow.effects.apply(kind, target.instanceId, 'piece', second.instanceId, 3, 'true', 'author-expired-effect')
        ruleFlow.effects.apply('damage', source.instanceId, 'piece', second.instanceId, 2, 'true', 'author-independent-effect')
        return { success: true }
      },
    } as any)
    try {
      const { flow } = runtimeFor(state)
      flow.effects.apply('damage', source.instanceId, 'piece', target.instanceId, 1, 'true', 'author-expiring-root')
      expect(state.pieces.some((piece: any) => piece.instanceId === target.instanceId)).toBe(false)
      expect(second.currentHp).toBe(8)
      expect(state.actions.filter((action: any) => ['damage', 'heal'].includes(action.type)).map((action: any) => action.payload.skillId))
        .toEqual(['author-expiring-root', 'author-independent-effect'])
      expect(diagnostics).toHaveBeenCalledWith('[gameplay-module-diagnostic]', expect.objectContaining({ contentId: 'author-expired-effect', surface: 'queuedEffect' }))
    } finally {
      diagnostics.mockRestore()
    }
  })

  it('skips remaining tuple entries after the first entry counter-kills its source', () => {
    const { state, source, target, second } = fixture()
    source.currentHp = 1
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    globalTriggerSystem.addRule({
      id: 'author-tuple-counter', name: 'author-tuple-counter', description: '',
      trigger: { type: 'afterDamageTaken' },
      effect: (_battle: any, context: any) => {
        if (context.skillId === 'author-countered-tuple' && context.piece === target) {
          context.damageQueue.push({ attacker: target, target: source, damage: 1, damageType: 'true', skillId: 'author-counter' })
        }
        return { success: true }
      },
    } as any)
    try {
      const { flow } = runtimeFor(state)
      const results = flow.effects.apply('damage', source.instanceId, 'piece', [target.instanceId, second.instanceId], [1, 1], 'true', 'author-countered-tuple')
      expect(state.pieces.includes(source)).toBe(false)
      expect(target.currentHp).toBe(19)
      expect(second.currentHp).toBe(20)
      expect(results[0]).toMatchObject({ success: true, damage: 1 })
      expect(results[1]).toMatchObject({ success: false, damage: 0, skipped: 'source-unavailable' })
      expect(diagnostics).toHaveBeenCalledWith('[gameplay-module-diagnostic]', expect.objectContaining({ contentId: 'author-countered-tuple' }))
    } finally {
      diagnostics.mockRestore()
    }
  })

  it('compiles and executes author.effect.damage@2 through refs and the real flow host', () => {
    const { state, source, target } = fixture()
    const context = { sourcePiece: source, targetPiece: target, piece: source, skill: { id: 'compiled-author-effect' } }
    const { flow } = runtimeFor(state, context)
    const compiled = compileGameplayModuleGraph(damageGraph(), GAMEPLAY_MODULE_REGISTRY)
    expect(compiled.diagnostics).toEqual([])

    const execute = runInNewContext('(' + compiled.code + ')', { flow }) as (value: unknown) => any
    const result = execute(context)

    expect(result).toMatchObject({ result: { success: true, targetId: target.instanceId, damage: 3 } })
    expect(target.currentHp).toBe(17)
  })

  it('compiles and executes a tuple target and tuple amount graph in input order', () => {
    const { state, source, target, second } = fixture()
    const context = { sourcePiece: source, targetPiece: target, piece: source, skill: { id: 'compiled-author-tuple' } }
    const { flow } = runtimeFor(state, context)
    const compiled = compileGameplayModuleGraph(tupleDamageGraph(), GAMEPLAY_MODULE_REGISTRY)
    expect(compiled.diagnostics).toEqual([])

    const execute = runInNewContext('(' + compiled.code + ')', { flow }) as (value: unknown) => any
    const result = execute(context)

    expect(result.result.map((entry: any) => [entry.targetId, entry.damage])).toEqual([
      [target.instanceId, 2], [second.instanceId, 3],
    ])
    expect(target.currentHp).toBe(18)
    expect(second.currentHp).toBe(17)
  })

  it('uses the exact current multi-member Cluster while preserving legacy action attribution', () => {
    const { state, source, target } = fixture()
    source.skills = [{ skillId: 'fireball', instanceId: 'fireball-instance', abilityGroupIds: ['custom-group:0'] }]
    source.abilityGroups = [{ id: 'custom-group', instanceId: 'custom-group:0', skills: ['helper', 'fireball'], rules: [] }]
    const context = {
      sourcePiece: source,
      targetPiece: target,
      piece: source,
      skill: { id: 'fireball' },
      skillInstance: source.skills[0],
      skillInstanceId: 'fireball-instance',
    }
    const { flow } = runtimeFor(state, context)
    const compiled = compileGameplayModuleGraph(typedClusterDamageGraph(), GAMEPLAY_MODULE_REGISTRY)
    expect(compiled.diagnostics).toEqual([])

    const execute = runInNewContext('(' + compiled.code + ')', { flow }) as (value: unknown) => any
    const result = execute(context)

    expect(result).toMatchObject({ result: { success: true, targetId: target.instanceId, damage: 3 } })
    expect(target.currentHp).toBe(17)
    expect(state.actions.filter((action: any) => action.type === 'damage').at(-1)?.payload?.skillId).toBe('custom-group')
  })
})
