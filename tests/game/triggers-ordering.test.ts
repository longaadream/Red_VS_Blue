/* eslint-disable @typescript-eslint/no-explicit-any -- dynamic trigger fixtures intentionally exercise runtime shapes */
import { describe, expect, it } from 'vitest'
import { TriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

const rule = (id: string, priority: number, trace: string[]) => ({
  id, name: id, description: id, priority, trigger: { type: 'ordering' },
  effect: () => { trace.push(id); return { success: true } },
})

describe('RED-61 combat trigger ordering', () => {
  it('uses category rank, descending priority, and snapshot order across the four trigger consumers', () => {
    const trace: string[] = []
    const system = new TriggerSystem()
    system.addRules([rule('global-low', 1, trace), rule('global-high', 2, trace)] as any)

    const piece = makePiece({
      rules: [rule('piece-low', 1, trace), rule('piece-high', 2, trace)],
    }) as any
    const state = makeState({ pieces: [piece] }) as any
    state.extensions.trace = trace
    state.players[0].rules = [rule('player-low', 1, trace), rule('player-high', 2, trace)]
    state.players[0].hand = [{
      cardId: 'ordering-response',
      instanceId: 'ordering-response-instance',
      ownerPlayerId: 'player-red',
    }]
    state.customCards = {
      'ordering-response': {
        id: 'ordering-response',
        name: 'ordering-response',
        description: 'ordering-response',
        type: 'reactive',
        trigger: { type: 'ordering' },
        code: "function executeCard(context) { context.battle.extensions.trace.push('response-card'); return { success: true }; }",
      },
    }

    system.checkTriggers(state, { type: 'ordering', playerId: 'player-red' })

    expect(trace).toEqual([
      'global-high', 'global-low',
      'piece-high', 'piece-low',
      'player-high', 'player-low',
      'response-card',
    ])
    expect(state.players[0].hand).toEqual([])
    expect(state.players[0].discardPile).toEqual(['ordering-response'])
  })
})
