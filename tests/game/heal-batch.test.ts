/* eslint-disable @typescript-eslint/no-explicit-any -- focused engine fixtures use data-driven runtime shapes */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { hashBattleState } from '@/lib/game/battle-trace'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { healDamage } from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

type HealEventMeta = {
  batchId?: string
  chainId?: string
  parentBatchId?: string
  kind?: string
  depth?: number
  enqueueSequence?: number
}

function effectMeta(context: any): HealEventMeta {
  return {
    batchId: context.effectBatchId,
    chainId: context.effectChainId,
    parentBatchId: context.parentEffectBatchId,
    kind: context.effectBatchKind,
    depth: context.effectDepth,
    enqueueSequence: context.effectEnqueueSequence,
  }
}

function healedTargetId(context: any): string | undefined {
  return context.type === 'beforeHealTaken'
    || context.type === 'afterHealTaken'
    || context.type === 'afterHealBlocked'
    ? context.sourcePiece?.instanceId
    : context.targetPiece?.instanceId
}

function eventRule(
  id: string,
  type: string,
  effect: (battle: any, context: any) => any,
  priority = 0,
) {
  return {
    id,
    name: id,
    description: '',
    priority,
    trigger: { type },
    effect: (battle: any, context: any) => effect(battle, context) ?? { success: true },
  }
}

describe('RED-139 deterministic HealBatch', () => {
  beforeEach(() => globalTriggerSystem.clearRules())
  afterEach(() => globalTriggerSystem.clearRules())

  it('prepares each target once, propagates heal modifiers, and commits every HP before after events', () => {
    const healer = makePiece({ instanceId: 'heal-source', ownerPlayerId: 'player-red' }) as any
    const alpha = makePiece({ instanceId: 'heal-alpha', ownerPlayerId: 'player-red', currentHp: 40, maxHp: 100 }) as any
    const zeta = makePiece({ instanceId: 'heal-zeta', ownerPlayerId: 'player-red', currentHp: 50, maxHp: 100 }) as any
    const state = makeState({ pieces: [healer, zeta, alpha] }) as any
    const events: Array<{ type: string; targetId?: string; hp: Array<[string, number]>; meta: HealEventMeta }> = []
    const hpSnapshot = () => [alpha, zeta]
      .map(piece => [piece.instanceId, piece.currentHp] as [string, number])
      .sort((left, right) => left[0].localeCompare(right[0]))

    globalTriggerSystem.addRules([
      eventRule('heal-source-modifier', 'beforeHealDealt', (_battle, context) => {
        events.push({ type: context.type, targetId: healedTargetId(context), hp: hpSnapshot(), meta: effectMeta(context) })
        context.heal += 2
      }),
      eventRule('heal-target-modifier', 'beforeHealTaken', (_battle, context) => {
        events.push({ type: context.type, targetId: healedTargetId(context), hp: hpSnapshot(), meta: effectMeta(context) })
        context.heal += context.sourcePiece.instanceId === alpha.instanceId ? 1 : 3
      }),
      eventRule('heal-after-dealt-observer', 'afterHealDealt', (_battle, context) => {
        events.push({ type: context.type, targetId: healedTargetId(context), hp: hpSnapshot(), meta: effectMeta(context) })
      }),
      eventRule('heal-after-taken-observer', 'afterHealTaken', (_battle, context) => {
        events.push({ type: context.type, targetId: healedTargetId(context), hp: hpSnapshot(), meta: effectMeta(context) })
      }),
    ] as any)

    const result = withRuleRuntime(new RuleRuntime({ rootSeed: 13901, tick: 1 }), () => (
      healDamage(healer, [zeta, alpha], 4, state, 'heal-batch-modifiers')
    ))

    expect(events.map(event => [event.type, event.targetId].join(':'))).toEqual([
      'beforeHealDealt:heal-alpha',
      'beforeHealTaken:heal-alpha',
      'beforeHealTaken:heal-zeta',
      'afterHealDealt:heal-alpha',
      'afterHealTaken:heal-alpha',
      'afterHealDealt:heal-zeta',
      'afterHealTaken:heal-zeta',
    ])
    expect(events.filter(event => event.type.startsWith('before')).map(event => event.hp)).toEqual([
      [['heal-alpha', 40], ['heal-zeta', 50]],
      [['heal-alpha', 40], ['heal-zeta', 50]],
      [['heal-alpha', 40], ['heal-zeta', 50]],
    ])
    expect(events.filter(event => event.type.startsWith('after')).map(event => event.hp)).toEqual([
      [['heal-alpha', 47], ['heal-zeta', 59]],
      [['heal-alpha', 47], ['heal-zeta', 59]],
      [['heal-alpha', 47], ['heal-zeta', 59]],
      [['heal-alpha', 47], ['heal-zeta', 59]],
    ])
    expect(result).toMatchObject({
      success: true,
      heals: [9, 7],
      totalHeal: 16,
      results: [
        { success: true, targetId: zeta.instanceId, heal: 9, targetHp: 59, blocked: false, depth: 0 },
        { success: true, targetId: alpha.instanceId, heal: 7, targetHp: 47, blocked: false, depth: 0 },
      ],
    })
    expect(result.batchId).toEqual(expect.any(String))
    expect(result.chainId).toEqual(expect.any(String))
    expect(result.results.every((entry: any) => (
      entry.batchId === result.batchId && entry.chainId === result.chainId && entry.parentBatchId === undefined
    ))).toBe(true)
    expect(events.every(event => (
      event.meta.batchId === result.batchId
      && event.meta.chainId === result.chainId
      && event.meta.parentBatchId === undefined
      && event.meta.kind === 'heal'
      && event.meta.depth === 0
    ))).toBe(true)
  })

  it.each([
    { blockZeta: false, expectedHp: 60, expectedHeal: 10 },
    { blockZeta: true, expectedHp: 99, expectedHeal: 0 },
  ])(
    'uses batch-start HP across Prepare side effects and skips blocked Commit (blocked=$blockZeta)',
    ({ blockZeta, expectedHp, expectedHeal }) => {
      const healer = makePiece({ instanceId: 'snapshot-source', ownerPlayerId: 'player-red' }) as any
      const alpha = makePiece({ instanceId: 'snapshot-alpha', ownerPlayerId: 'player-red', currentHp: 40, maxHp: 100 }) as any
      const zeta = makePiece({ instanceId: 'snapshot-zeta', ownerPlayerId: 'player-red', currentHp: 50, maxHp: 100 }) as any
      const state = makeState({ pieces: [healer, zeta, alpha] }) as any
      globalTriggerSystem.addRule(eventRule('mutate-later-heal-target', 'beforeHealTaken', (_battle, context) => {
        if (context.sourcePiece.instanceId === alpha.instanceId) zeta.currentHp = 99
        if (blockZeta && context.sourcePiece.instanceId === zeta.instanceId) {
          return { success: true, blocked: true }
        }
      }) as any)

      const result = healDamage(healer, [zeta, alpha], 10, state, 'snapshot-heal')

      expect(alpha.currentHp).toBe(50)
      expect(zeta.currentHp).toBe(expectedHp)
      expect(result.results[0]).toMatchObject({
        targetId: zeta.instanceId,
        heal: expectedHeal,
        blocked: blockZeta,
        targetHp: expectedHp,
      })
      expect(result.results[1]).toMatchObject({ targetId: alpha.instanceId, heal: 10, targetHp: 50 })
    },
  )


  it('reports the final HP when a later Prepare mutates an earlier blocked target', () => {
    const healer = makePiece({ instanceId: 'blocked-result-source', ownerPlayerId: 'player-red' }) as any
    const alpha = makePiece({
      instanceId: 'blocked-result-alpha',
      ownerPlayerId: 'player-red',
      currentHp: 40,
      maxHp: 100,
    }) as any
    const zeta = makePiece({
      instanceId: 'blocked-result-zeta',
      ownerPlayerId: 'player-red',
      currentHp: 50,
      maxHp: 100,
    }) as any
    const state = makeState({ pieces: [healer, zeta, alpha] }) as any
    globalTriggerSystem.addRule(eventRule('mutate-earlier-blocked-target', 'beforeHealTaken', (_battle, context) => {
      if (context.sourcePiece.instanceId === alpha.instanceId) return { success: true, blocked: true }
      if (context.sourcePiece.instanceId === zeta.instanceId) alpha.currentHp = 91
    }) as any)

    const result = healDamage(healer, [alpha, zeta], 10, state, 'blocked-result-heal')

    expect(alpha.currentHp).toBe(91)
    expect(result.results[0]).toMatchObject({
      targetId: alpha.instanceId, heal: 0, blocked: true, targetHp: 91,
    })
  })
  it('source-wide blocking skips all per-target before/after events and HP commit', () => {
    const healer = makePiece({ instanceId: 'blocked-source', ownerPlayerId: 'player-red' }) as any
    const alpha = makePiece({ instanceId: 'blocked-alpha', ownerPlayerId: 'player-red', currentHp: 20, maxHp: 100 }) as any
    const beta = makePiece({ instanceId: 'blocked-beta', ownerPlayerId: 'player-red', currentHp: 30, maxHp: 100 }) as any
    const state = makeState({ pieces: [healer, beta, alpha] }) as any
    const events: string[] = []

    globalTriggerSystem.addRules([
      eventRule('block-whole-heal-batch', 'beforeHealDealt', (_battle, context) => {
        events.push(context.type)
        return { success: true, blocked: true }
      }, 100),
      ...['beforeHealTaken', 'afterHealBlocked', 'afterHealDealt', 'afterHealTaken'].map(type => (
        eventRule('unexpected-' + type, type, (_battle, context) => {
          events.push(context.type)
        })
      )),
    ] as any)

    const result = healDamage(healer, [beta, alpha], 8, state, 'source-wide-block')

    expect(events).toEqual(['beforeHealDealt'])
    expect([alpha.currentHp, beta.currentHp]).toEqual([20, 30])
    expect(result.success).toBe(false)
    expect(result.totalHeal ?? 0).toBe(0)
    expect(result.blocked === true || result.results?.every((entry: any) => entry.blocked === true)).toBe(true)
  })

  it('blocks one target during Prepare, commits the others, then emits blocked/after in stable order', () => {
    const healer = makePiece({ instanceId: 'partial-source', ownerPlayerId: 'player-red' }) as any
    const alpha = makePiece({ instanceId: 'partial-alpha', ownerPlayerId: 'player-red', currentHp: 30, maxHp: 100 }) as any
    const zeta = makePiece({ instanceId: 'partial-zeta', ownerPlayerId: 'player-red', currentHp: 40, maxHp: 100 }) as any
    const state = makeState({ pieces: [healer, zeta, alpha] }) as any
    const events: Array<{ type: string; targetId?: string; hp: number[] }> = []

    globalTriggerSystem.addRules([
      eventRule('block-alpha-heal', 'beforeHealTaken', (_battle, context) => {
        events.push({ type: context.type, targetId: healedTargetId(context), hp: [alpha.currentHp, zeta.currentHp] })
        if (context.sourcePiece.instanceId === alpha.instanceId) return { success: true, blocked: true }
      }),
      ...['afterHealBlocked', 'afterHealDealt', 'afterHealTaken'].map(type => (
        eventRule('observe-partial-' + type, type, (_battle, context) => {
          events.push({ type: context.type, targetId: healedTargetId(context), hp: [alpha.currentHp, zeta.currentHp] })
        })
      )),
    ] as any)

    const result = healDamage(healer, [zeta, alpha], 5, state, 'partial-block')

    expect(events.map(event => [event.type, event.targetId].join(':'))).toEqual([
      'beforeHealTaken:partial-alpha',
      'beforeHealTaken:partial-zeta',
      'afterHealBlocked:partial-alpha',
      'afterHealDealt:partial-zeta',
      'afterHealTaken:partial-zeta',
    ])
    expect(events.slice(0, 2).map(event => event.hp)).toEqual([[30, 40], [30, 40]])
    expect(events.slice(2).every(event => event.hp[0] === 30 && event.hp[1] === 45)).toBe(true)
    expect(result).toMatchObject({
      success: true,
      heals: [5, 0],
      totalHeal: 5,
      results: [
        { success: true, targetId: zeta.instanceId, heal: 5, blocked: false, targetHp: 45 },
        { success: false, targetId: alpha.instanceId, heal: 0, blocked: true, targetHp: 30 },
      ],
    })
  })

  it('caps over-healing and keeps the one-target facade on the HealBatch pipeline', () => {
    const healer = makePiece({ instanceId: 'overheal-source', ownerPlayerId: 'player-red' }) as any
    const target = makePiece({ instanceId: 'overheal-target', ownerPlayerId: 'player-red', currentHp: 98, maxHp: 100 }) as any
    const state = makeState({ pieces: [healer, target] }) as any

    const result = withRuleRuntime(new RuleRuntime({ rootSeed: 13902, tick: 1 }), () => (
      healDamage(healer, target, 7, state, 'overheal')
    ))

    expect(result).toMatchObject({
      success: true,
      sourceId: healer.instanceId,
      targetId: target.instanceId,
      heal: 2,
      blocked: false,
      targetHp: 100,
      depth: 0,
    })
    expect(result.batchId).toEqual(expect.any(String))
    expect(result.chainId).toEqual(expect.any(String))
    expect(target.currentHp).toBe(100)
  })

  it('rejects duplicate targets and non-finite healing before triggers or state changes', () => {
    const healer = makePiece({ instanceId: 'invalid-heal-source', ownerPlayerId: 'player-red' }) as any
    const target = makePiece({ instanceId: 'invalid-heal-target', ownerPlayerId: 'player-red', currentHp: 50, maxHp: 100 }) as any
    const state = makeState({ pieces: [healer, target] }) as any
    const beforeHash = hashBattleState(state)
    let beforeCount = 0
    globalTriggerSystem.addRule(eventRule('invalid-heal-observer', 'beforeHealDealt', () => {
      beforeCount += 1
    }) as any)

    expect(() => healDamage(healer, [target, target], 1, state, 'duplicate-heal-target')).toThrow(/duplicate target/i)
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(() => healDamage(healer, target, Number.NaN, state, 'nan-heal')).toThrow(/finite non-negative/i)
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(beforeCount).toBe(0)
  })

  it('keeps canonical event metadata and state hash invariant while mapping results to input order', () => {
    let activeTrace: Array<Record<string, unknown>> = []
    globalTriggerSystem.addRules([
      ...['beforeHealDealt', 'beforeHealTaken', 'afterHealDealt', 'afterHealTaken'].map(type => (
        eventRule('permutation-' + type, type, (_battle, context) => {
          activeTrace.push({
            type: context.type,
            targetId: healedTargetId(context),
            ...effectMeta(context),
          })
        })
      )),
    ] as any)
    const triggerCheckpoint = globalTriggerSystem.snapshotTransactionState()

    const run = (reverse: boolean) => {
      globalTriggerSystem.restoreTransactionState(triggerCheckpoint)
      activeTrace = []
      const healer = makePiece({ instanceId: 'permutation-source', ownerPlayerId: 'player-red' }) as any
      const alpha = makePiece({ instanceId: 'permutation-alpha', ownerPlayerId: 'player-red', currentHp: 98, maxHp: 100 }) as any
      const zeta = makePiece({ instanceId: 'permutation-zeta', ownerPlayerId: 'player-red', currentHp: 90, maxHp: 100 }) as any
      const state = makeState({ pieces: [healer, alpha, zeta] }) as any
      const result = withRuleRuntime(new RuleRuntime({ rootSeed: 13903, tick: 1 }), () => (
        healDamage(healer, reverse ? [zeta, alpha] : [alpha, zeta], 5, state, 'permutation-heal')
      ))
      return { state, hash: hashBattleState(state), result, trace: [...activeTrace] }
    }

    const forward = run(false)
    const reverse = run(true)

    expect(reverse.hash).toBe(forward.hash)
    expect(reverse.state).toEqual(forward.state)
    expect(reverse.trace).toEqual(forward.trace)
    expect(forward.result.heals).toEqual([2, 5])
    expect(reverse.result.heals).toEqual([5, 2])
    expect(forward.result.results.map((entry: any) => entry.targetId)).toEqual(['permutation-alpha', 'permutation-zeta'])
    expect(reverse.result.results.map((entry: any) => entry.targetId)).toEqual(['permutation-zeta', 'permutation-alpha'])
    expect(forward.trace.every(entry => (
      typeof entry.batchId === 'string'
      && typeof entry.chainId === 'string'
      && entry.kind === 'heal'
      && entry.depth === 0
    ))).toBe(true)
  })

  it('fails closed on direct healDamage reentry while processing and clears the ambient guard', () => {
    const healer = makePiece({ instanceId: 'reentrant-heal-source', ownerPlayerId: 'player-red' }) as any
    const target = makePiece({ instanceId: 'reentrant-heal-target', ownerPlayerId: 'player-red', currentHp: 90, maxHp: 100 }) as any
    const state = makeState({ pieces: [healer, target] }) as any
    let attempted = false
    globalTriggerSystem.addRule(eventRule('direct-heal-reentry', 'beforeHealDealt', (battle, context) => {
      if (context.skillId !== 'reentrant-heal-root' || attempted) return
      attempted = true
      healDamage(healer, target, 1, battle, 'illegal-nested-heal')
    }) as any)

    let thrown: any
    try {
      healDamage(healer, target, 1, state, 'reentrant-heal-root')
    } catch (error) {
      thrown = error
    }

    globalTriggerSystem.clearRules()
    const retry = healDamage(healer, target, 1, state, 'heal-after-reentry-error')

    expect(thrown).toMatchObject({
      name: 'EffectChainFatalError',
      code: expect.stringMatching(/REENTRANT/),
    })
    expect(thrown.context ?? thrown.details).toMatchObject({ kind: 'heal' })
    expect(retry).toMatchObject({ success: true, heal: 1, targetHp: 91 })
    expect(target.currentHp).toBe(91)
  })

  it('drains healQueue in push order and exposes shared chain, parent, depth, and sequence metadata', () => {
    const healer = makePiece({ instanceId: 'queue-heal-source', ownerPlayerId: 'player-red' }) as any
    const rootTarget = makePiece({ instanceId: 'queue-root-target', ownerPlayerId: 'player-red', currentHp: 90, maxHp: 100 }) as any
    const zulu = makePiece({ instanceId: 'queue-zulu-target', ownerPlayerId: 'player-red', currentHp: 80, maxHp: 100 }) as any
    const alpha = makePiece({ instanceId: 'queue-alpha-target', ownerPlayerId: 'player-red', currentHp: 70, maxHp: 100 }) as any
    const state = makeState({ pieces: [healer, rootTarget, zulu, alpha] }) as any
    const batches: Array<{ skillId?: string; targetId?: string; meta: HealEventMeta }> = []

    globalTriggerSystem.addRules([
      eventRule('observe-heal-queue-batches', 'beforeHealDealt', (_battle, context) => {
        batches.push({ skillId: context.skillId, targetId: healedTargetId(context), meta: effectMeta(context) })
      }),
      eventRule('enqueue-two-heals', 'afterHealTaken', (_battle, context) => {
        if (context.skillId !== 'queue-heal-root') return
        context.healQueue.push({ healer, target: zulu, heal: 2, skillId: 'queue-heal-zulu' })
        context.healQueue.push({ healer, target: alpha, heal: 2, skillId: 'queue-heal-alpha' })
      }),
    ] as any)

    const result = withRuleRuntime(new RuleRuntime({ rootSeed: 13904, tick: 1 }), () => (
      healDamage(healer, rootTarget, 2, state, 'queue-heal-root')
    ))

    expect(batches.map(batch => [batch.skillId, batch.targetId].join(':'))).toEqual([
      'queue-heal-root:queue-root-target',
      'queue-heal-zulu:queue-zulu-target',
      'queue-heal-alpha:queue-alpha-target',
    ])
    const [root, firstQueued, secondQueued] = batches
    expect(root.meta).toMatchObject({
      batchId: result.batchId,
      chainId: result.chainId,
      parentBatchId: undefined,
      kind: 'heal',
      depth: 0,
      enqueueSequence: undefined,
    })
    expect(firstQueued.meta).toMatchObject({
      chainId: root.meta.chainId,
      parentBatchId: root.meta.batchId,
      kind: 'heal',
      depth: 1,
    })
    expect(secondQueued.meta).toMatchObject({
      chainId: root.meta.chainId,
      parentBatchId: root.meta.batchId,
      kind: 'heal',
      depth: 1,
    })
    expect(firstQueued.meta.batchId).not.toBe(secondQueued.meta.batchId)
    expect(firstQueued.meta.enqueueSequence).toEqual(expect.any(Number))
    expect(secondQueued.meta.enqueueSequence).toEqual(expect.any(Number))
    expect(secondQueued.meta.enqueueSequence!).toBeGreaterThan(firstQueued.meta.enqueueSequence!)
    expect([rootTarget.currentHp, zulu.currentHp, alpha.currentHp]).toEqual([92, 82, 72])
  })
})
