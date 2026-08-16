import { describe, expect, it } from 'vitest'
import { TriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

const rule = (id: string, priority: number, trace: string[]) => ({
  id, name: id, description: id, priority, trigger: { type: 'ordering' },
  effect: () => { trace.push(id); return { success: true } },
})

describe('RED-61 combat trigger ordering', () => {
  it('uses category rank, descending priority, and snapshot order across trigger consumers', () => {
    const trace: string[] = []
    const system = new TriggerSystem()
    system.addRules([rule('global-low', 1, trace), rule('global-high', 2, trace)] as any)

    const piece = makePiece({
      rules: [rule('piece-low', 1, trace), rule('piece-high', 2, trace)],
    }) as any
    piece.attachedEffects = [{
      instanceId: 'effect-1', definitionId: 'effect-1', ownerId: piece.instanceId, data: {},
      triggers: [
        { on: 'ordering', priority: 1, filterCode: 'function() { return true }', effectCode: "function(ctx, battle) { battle.extensions.trace.push('effect-low'); return { success: true } }" },
        { on: 'ordering', priority: 2, filterCode: 'function() { return true }', effectCode: "function(ctx, battle) { battle.extensions.trace.push('effect-high'); return { success: true } }" },
      ],
    }, {
      instanceId: 'effect-2', definitionId: 'effect-2', ownerId: piece.instanceId, data: {},
      triggers: [{
        on: 'ordering', priority: 3, filterCode: 'function() { return true }',
        effectCode: "function(ctx, battle) { battle.extensions.trace.push('effect-top'); return { success: true } }",
      }],
    }]
    const state = makeState({ pieces: [piece] }) as any
    state.extensions.trace = trace
    state.players[0].rules = [rule('player-low', 1, trace), rule('player-high', 2, trace)]
    system.checkTriggers(state, { type: 'ordering', playerId: 'player-red' })

    expect(trace).toEqual([
      'global-high', 'global-low',
      'piece-high', 'piece-low',
      'player-high', 'player-low',
      'effect-top', 'effect-high', 'effect-low',
    ])
  })
})
