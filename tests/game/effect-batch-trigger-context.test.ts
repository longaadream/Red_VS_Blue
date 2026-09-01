/* eslint-disable @typescript-eslint/no-explicit-any -- focused trigger fixtures use runtime rule fields */
import { describe, expect, it } from 'vitest'

import {
  TriggerSystem,
  type HealQueueRequest,
  type TriggerContext,
  type TriggerRule,
} from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

function testRule(id: string, type: string, effect: TriggerRule['effect']): TriggerRule {
  return {
    id,
    name: id,
    description: id,
    trigger: { type },
    effect,
  }
}

describe('RED-139 trigger EffectBatch context', () => {
  it('propagates heal mutations through cloned piece and player rule contexts', () => {
    const system = new TriggerSystem()
    const pieceRule = testRule('piece-heal-modifier', 'beforeHealTaken', (_battle, context) => {
      context.heal = Number(context.heal) + 2
      return { success: true }
    })
    const playerRule = testRule('player-heal-modifier', 'beforeHealTaken', (_battle, context) => {
      context.heal = Number(context.heal) * 3
      return { success: true }
    })
    const target = makePiece({
      instanceId: 'heal-context-target',
      ownerPlayerId: 'player-red',
      rules: [pieceRule],
    }) as any
    const state = makeState({ pieces: [target] }) as any
    state.players[0].rules = [playerRule]
    const context: TriggerContext = {
      type: 'beforeHealTaken',
      targetPiece: target,
      heal: 4,
    }

    system.checkTriggers(state, context)

    expect(context.heal).toBe(18)
  })

  it('passes the closed healQueue writer through cloned rule contexts', () => {
    const system = new TriggerSystem()
    const queued: HealQueueRequest[] = []
    const healer = makePiece({ instanceId: 'heal-queue-source', ownerPlayerId: 'player-red' }) as any
    const target = makePiece({
      instanceId: 'heal-queue-target',
      ownerPlayerId: 'player-blue',
      rules: [testRule('queue-follow-up-heal', 'afterDamageDealt', (_battle, context) => {
        context.healQueue?.push({
          healer,
          target,
          heal: 3,
          skillId: 'queued-heal',
        })
        return { success: true }
      })],
    }) as any
    const state = makeState({ pieces: [healer, target] })
    const context: TriggerContext = {
      type: 'afterDamageDealt',
      sourcePiece: healer,
      targetPiece: target,
      healQueue: { push: request => queued.push(request) },
    }

    system.checkTriggers(state, context)

    expect(queued).toEqual([{
      healer,
      target,
      heal: 3,
      skillId: 'queued-heal',
    }])
  })

  it('rethrows marked fatal errors without changing their identity or diagnostics', () => {
    const system = new TriggerSystem()
    const fatal = Object.assign(new Error('effect chain budget exhausted'), {
      name: 'EffectChainFatalError',
      code: 'RVB_EFFECT_CHAIN_FATAL',
      fatal: true,
      context: { chainId: 'chain-1', batchId: 'batch-2' },
    })
    system.addRule(testRule('fatal-consumer', 'afterHealTaken', () => {
      throw fatal
    }))

    let thrown: unknown
    try {
      system.checkTriggers(makeState(), { type: 'afterHealTaken', heal: 2 })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBe(fatal)
    expect(fatal.message).toBe('effect chain budget exhausted')
    expect(fatal).not.toHaveProperty('triggerContext')
  })
})
