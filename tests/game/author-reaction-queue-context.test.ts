/* eslint-disable @typescript-eslint/no-explicit-any -- forwarded trigger fixtures intentionally model the dynamic author boundary. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getActiveEffectChain } from '@/lib/game/effect-batch'
import { createSkillCodeFlow, dealDamage, loadRuleById } from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import type { BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

let previousRules: any[] = []

beforeEach(() => {
  previousRules = [...globalTriggerSystem.getRules()]
  globalTriggerSystem.clearRules()
})

afterEach(() => {
  globalTriggerSystem.clearRules()
  globalTriggerSystem.addRules(previousRules)
})

function fixture(): { state: BattleState; source: any; target: any } {
  const source = makePiece({
    instanceId: 'reaction-source',
    ownerPlayerId: 'player-red',
    currentHp: 20,
    maxHp: 20,
  })
  const target = makePiece({
    instanceId: 'reaction-target',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    currentHp: 20,
    maxHp: 30,
  })
  return {
    state: makeState({ pieces: [source, target] }) as BattleState,
    source,
    target,
  }
}

describe('author reaction queue context', () => {
  it('binds damage and heal author effects from a forwarded event to the active chain in FIFO order', () => {
    const { state, source, target } = fixture()
    const queuedRequests: any[] = []
    let forwardedResult: unknown

    globalTriggerSystem.addRule({
      id: 'forward-author-reaction-event',
      name: 'forward-author-reaction-event',
      description: '',
      trigger: { type: 'afterDamageDealt' },
      effect: (battle: BattleState, context: any) => {
        if (context.skillId !== 'reaction-root') return { success: true }
        // Model a host-forwarded event: only semantic fields cross the event
        // boundary, so transient damageQueue/healQueue writers are absent.
        forwardedResult = globalTriggerSystem.checkTriggers(battle, {
          type: 'afterHealDealt',
          piece: context.sourcePiece,
          sourcePiece: context.sourcePiece,
          targetPiece: context.targetPiece,
          target: context.targetPiece,
          playerId: context.playerId,
          skillId: 'forwarded-author-reaction',
          heal: 0,
        } as any)
        return { success: true }
      },
    } as any)
    globalTriggerSystem.addRule({
      id: 'forwarded-author-reaction',
      name: 'forwarded-author-reaction',
      description: '',
      trigger: { type: 'afterHealDealt' },
      effect: (battle: BattleState, context: any) => {
        if (context.skillId !== 'forwarded-author-reaction') return { success: true }
        const flow = createSkillCodeFlow(battle, {
          ...context,
          piece: source,
          rulePiece: source,
          sourcePiece: source,
          targetPiece: target,
          skill: { id: 'forwarded-author-reaction' },
        }, 'rule') as any
        flow.effects.apply(
          'damage', source.instanceId, 'piece', target.instanceId, 3, 'true',
          'forwarded-author-damage', 'player-red',
        )
        flow.effects.apply(
          'heal', source.instanceId, 'piece', target.instanceId, 4, 'normal',
          'forwarded-author-heal',
        )
        const chain = getActiveEffectChain(battle)
        queuedRequests.push(...(chain?.records ?? [])
          .filter((record: any) => record.type === 'enqueue')
          .map((record: any) => record.request))
        return { success: true }
      },
    } as any)

    const root = dealDamage(source, target, 2, 'true', state, 'reaction-root')

    expect(root).toMatchObject({ success: true, damage: 2, targetHp: 18 })
    expect(forwardedResult).toMatchObject({ success: true })
    expect(target.currentHp).toBe(19)
    expect((state.actions ?? [])
      .filter((action: any) => action.type === 'damage')
      .map((action: any) => [action.type, action.payload.skillId]))
      .toEqual([
        ['damage', 'reaction-root'],
        ['damage', 'forwarded-author-damage'],
      ])
    expect(queuedRequests
      .filter(request => request.skillId === 'forwarded-author-damage' || request.skillId === 'forwarded-author-heal')
      .map(request => [request.kind, request.skillId]))
      .toEqual([
        ['damage', 'forwarded-author-damage'],
        ['heal', 'forwarded-author-heal'],
      ])
    expect(queuedRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'damage',
        skillId: 'forwarded-author-damage',
        killerPlayerId: 'player-red',
        sourceLifetime: 'active-piece',
      }),
      expect.objectContaining({
        kind: 'heal',
        skillId: 'forwarded-author-heal',
        sourceLifetime: 'active-piece',
      }),
    ]))
    expect(queuedRequests.find(request => request.skillId === 'forwarded-author-damage')?.killerPlayerId).toBe('player-red')
    expect(queuedRequests.find(request => request.skillId === 'forwarded-author-heal')?.killerPlayerId).toBeUndefined()
  })

  it('keeps direct damage reentry fatal when a forwarded reaction omits queue writers', () => {
    const { state, source, target } = fixture()

    globalTriggerSystem.addRule({
      id: 'forward-direct-reentry',
      name: 'forward-direct-reentry',
      description: '',
      trigger: { type: 'afterDamageDealt' },
      effect: (battle: BattleState, context: any) => {
        if (context.skillId !== 'direct-reentry-root') return { success: true }
        globalTriggerSystem.checkTriggers(battle, {
          type: 'afterHealDealt',
          piece: context.sourcePiece,
          sourcePiece: context.sourcePiece,
          targetPiece: context.targetPiece,
          target: context.targetPiece,
          skillId: 'forwarded-direct-reentry',
          heal: 0,
        } as any)
        return { success: true }
      },
    } as any)
    globalTriggerSystem.addRule({
      id: 'direct-reentry-reaction',
      name: 'direct-reentry-reaction',
      description: '',
      trigger: { type: 'afterHealDealt' },
      effect: (battle: BattleState) => {
        dealDamage(source, target, 1, 'true', battle, 'direct-reentry-follow-up')
        return { success: true }
      },
    } as any)

    expect(() => dealDamage(source, target, 2, 'true', state, 'direct-reentry-root'))
      .toThrow(/Nested dealDamage calls must enqueue follow-up damage/)
    expect(target.currentHp).toBe(18)
  })

  it('runs the real Hidan undying tick through a forwarded event without queue fields', () => {
    const attacker = makePiece({
      instanceId: 'real-reaction-attacker',
      ownerPlayerId: 'player-red',
      currentHp: 20,
      maxHp: 20,
    })
    const defender = makePiece({
      instanceId: 'real-reaction-defender',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      currentHp: 20,
      maxHp: 20,
    })
    const hidanRule = loadRuleById('rule-hidan-undying-tick', true)
    expect(hidanRule).toBeTruthy()
    const hidan = makePiece({
      instanceId: 'real-hidan',
      templateId: 'hidan',
      ownerPlayerId: 'player-red',
      name: 'Hidan',
      currentHp: 1,
      maxHp: 10,
      statusTags: [{ id: 'hidan-dying', type: 'hidan-dying', remainingTurns: 1 }],
      rules: [hidanRule!],
    })
    const state = makeState({
      pieces: [attacker, defender, hidan],
      currentPlayerId: 'player-red',
    }) as BattleState
    const forwardedContexts: any[] = []
    const diagnostics: any[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: any[]) => {
      if (args[0] === '[gameplay-module-diagnostic]') diagnostics.push(args[1])
    })

    globalTriggerSystem.addRule({
      id: 'forward-real-hidan-end-turn',
      name: 'forward-real-hidan-end-turn',
      description: '',
      trigger: { type: 'beforeDamageTaken' },
      effect: (battle: BattleState, context: any) => {
        if (context.skillId !== 'real-forwarded-root') return { success: true }
        forwardedContexts.push(context)
        // A host-forwarded event carries only the authoritative event fields;
        // transient damageQueue/healQueue writers are deliberately absent.
        return globalTriggerSystem.checkTriggers(battle, {
          type: 'endTurn',
          playerId: 'player-red',
        } as any)
      },
    } as any)

    try {
      const root = dealDamage(attacker as any, defender as any, 1, 'true', state, 'real-forwarded-root')

      expect(root).toMatchObject({ success: true, damage: 1, targetHp: 19 })
      expect(forwardedContexts).toHaveLength(1)
      expect((state.actions ?? [])
        .filter((action: any) => action.type === 'damage')
        .map((action: any) => action.payload.skillId))
        .toEqual(['real-forwarded-root', 'undying-expire'])
      expect(defender.currentHp).toBe(19)
      expect(state.pieces.some((piece: any) => piece.instanceId === hidan.instanceId)).toBe(false)
      expect(state.graveyard.find((piece: any) => piece.instanceId === hidan.instanceId)).toMatchObject({
        currentHp: 0,
      })
      expect(diagnostics).toEqual([])
    } finally {
      consoleError.mockRestore()
    }
  })
})
