import { describe, expect, it } from 'vitest'

import { createBattlePublicPatch } from '@/lib/game/battle-public-patch'
import { toPublicBattleState } from '@/lib/game/deployment'
import { makeState } from '../helpers/minimal-state'

describe('battle public pending projection', () => {
  it('keeps option candidates private to the pending owner', () => {
    const state = makeState()
    state.pendingOptionSelection = {
      playerId: 'player-red',
      title: 'Choose a form',
      options: ['calm', 'rage'],
      source: { type: 'rule', id: 'rule-watcher-form', pieceId: 'watcher' },
      selectionId: 'pending-option-1',
      stateRevision: 8,
      canCancel: false,
      continuationContext: { private: 'continuation' },
      pendingAction: { type: 'beginPhase' },
    } as never

    const ownerState = toPublicBattleState(state, 'player-red')
    const opponentState = toPublicBattleState(state, 'player-blue')
    const spectatorState = toPublicBattleState(state)
    const owner = ownerState.pendingOptionSelection as any
    const opponent = opponentState.pendingOptionSelection as any
    const spectator = spectatorState.pendingOptionSelection as any

    for (const projection of [ownerState, opponentState, spectatorState]) {
      expect(JSON.parse(JSON.stringify(projection))).toEqual(projection)
    }
    expect(() => createBattlePublicPatch(
      toPublicBattleState(makeState(), 'player-red'),
      ownerState,
    )).not.toThrow()

    expect(owner.options).toEqual(['calm', 'rage'])
    expect(opponent.options).toEqual([])
    expect(spectator.options).toEqual([])
    for (const projection of [owner, opponent, spectator]) {
      expect(projection).toMatchObject({
        playerId: 'player-red',
        selectionId: 'pending-option-1',
        stateRevision: 8,
      })
      expect(projection.continuationContext).toBeUndefined()
      expect(projection.pendingAction).toBeUndefined()
    }
  })

  it('keeps target candidates and targeting internals private to the pending owner', () => {
    const state = makeState()
    state.pendingTargetSelection = {
      playerId: 'player-red',
      ownerPlayerId: 'player-red',
      title: 'Choose an anchor',
      targetType: 'cell',
      range: 99,
      filter: 'all',
      source: { type: 'rule', id: 'rule-minato-anchor-begin-turn', pieceId: 'minato' },
      selectionId: 'pending-target-1',
      stateRevision: 9,
      step: 0,
      canCancel: true,
      selectedTargets: [],
      candidates: [{ type: 'cell', x: 2, y: 3 }],
      effectCode: 'private-effect-code',
      continuationContext: { private: 'continuation' },
      pendingAction: { type: 'beginPhase' },
    } as never

    const ownerState = toPublicBattleState(state, 'player-red')
    const opponentState = toPublicBattleState(state, 'player-blue')
    const spectatorState = toPublicBattleState(state)
    const owner = ownerState.pendingTargetSelection as any
    const opponent = opponentState.pendingTargetSelection as any
    const spectator = spectatorState.pendingTargetSelection as any

    for (const projection of [ownerState, opponentState, spectatorState]) {
      expect(JSON.parse(JSON.stringify(projection))).toEqual(projection)
    }
    expect(() => createBattlePublicPatch(
      toPublicBattleState(makeState(), 'player-red'),
      ownerState,
    )).not.toThrow()

    expect(owner.candidates).toEqual([{ type: 'cell', x: 2, y: 3 }])
    expect(owner.range).toBe(99)
    for (const projection of [opponent, spectator]) {
      expect(projection.candidates).toEqual([])
      expect(projection.range).toBeUndefined()
      expect(projection.filter).toBeUndefined()
      expect(projection.selectedTargets).toBeUndefined()
    }
    for (const projection of [owner, opponent, spectator]) {
      expect(projection).toMatchObject({
        playerId: 'player-red',
        targetType: 'cell',
        selectionId: 'pending-target-1',
        stateRevision: 9,
      })
      expect(projection.effectCode).toBeUndefined()
      expect(projection.continuationContext).toBeUndefined()
      expect(projection.pendingAction).toBeUndefined()
    }
  })
})