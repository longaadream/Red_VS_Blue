import { describe, expect, it } from 'vitest'
import { normalizePendingResult } from '@/lib/game/pending-result'
import { TriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

describe('compiled target continuation boundary', () => {
  it('preserves candidates, cancellation policy and continuation through rule aggregation', () => {
    const piece = makePiece({ instanceId: 'holder' })
    const battle = makeState({ pieces: [piece] })
    const payload = { sourceId: piece.instanceId, count: 2 }
    const envelope = { success: true, pendingTargetSelection: {
      playerId: 'player-red', title: 'Continue', targetType: 'cell',
      candidates: [{ type: 'cell', x: 1, y: 0 }], selectionMode: 'single' as const,
      min: 1, max: 1, canCancel: true, resumeOnCancel: true,
      effectCode: 'function(ctx) { return {success:true}; }', payload,
    } }
    const triggers = new TriggerSystem()
    triggers.addRule({ id: 'pending-test', name: 'Pending', description: '', trigger: { type: 'endTurn' }, effect: () => envelope })
    const result = triggers.checkTriggers(battle, { type: 'endTurn', piece: battle.pieces[0], sourcePiece: battle.pieces[0], playerId: 'player-red' })
    expect(result).toMatchObject({ needsTargetSelection: true, playerId: 'player-red', targetType: 'cell',
      targetCandidates: envelope.pendingTargetSelection.candidates, effectCode: envelope.pendingTargetSelection.effectCode,
      payload, resumeOnCancel: true, canCancel: true, minSelections: 1, maxSelections: 1,
    })
    expect(envelope).not.toHaveProperty('needsTargetSelection')
  })
  it('leaves ordinary results intact and preserves explicit zero selection bounds', () => {
    const ordinary = { success: true, message: 'Done', messages: [], blocked: false }
    expect(normalizePendingResult(ordinary)).toBe(ordinary)
    expect(normalizePendingResult(undefined)).toBeUndefined()
    const envelope = { ...ordinary, pendingTargetSelection: { min: 0, max: 0, canCancel: false } }
    expect(normalizePendingResult(envelope)).toMatchObject({ minSelections: 0, maxSelections: 0, canCancel: false })
  })
})
