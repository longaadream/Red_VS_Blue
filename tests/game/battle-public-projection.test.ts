import { describe, expect, it } from 'vitest'

import { createBattlePublicPatch } from '@/lib/game/battle-public-patch'
import { toPublicBattleState } from '@/lib/game/deployment'
import { makePiece, makeState } from '../helpers/minimal-state'

describe('battle public pending projection', () => {
  it('keeps only the viewer hand visible and uses the same redaction for spectators', () => {
    const state = makeState()
    state.players[0].hand = [{
      cardId: 'red-secret', instanceId: 'red-secret-1', ownerPlayerId: 'player-red',
    }]
    state.players[1].hand = [{
      cardId: 'blue-secret', instanceId: 'blue-secret-1', ownerPlayerId: 'player-blue',
    }]

    const red = toPublicBattleState(state, 'player-red')
    expect(red.players[0].hand[0]).toMatchObject({ cardId: 'red-secret', instanceId: 'red-secret-1' })
    expect(red.players[1].hand[0]).toEqual({
      cardId: 'hidden', instanceId: 'hidden-card-0', ownerPlayerId: 'player-blue',
    })
    for (const player of toPublicBattleState(state).players) {
      expect(player.hand[0]).toMatchObject({ cardId: 'hidden', instanceId: 'hidden-card-0' })
    }
  })

  it('keeps invisible piece status data private to its owner', () => {
    const state = makeState({ pieces: [makePiece({ ownerPlayerId: 'player-red' })] })
    const piece = state.pieces[0]
    piece.ownerPlayerId = 'player-red'
    piece.statusTags = [
      { id: 'public-active', type: 'public-active', visible: true },
      { id: 'secret-choice', type: 'secret-choice', visible: false, targetPieceId: 'secret-ally' },
    ] as never

    expect(toPublicBattleState(state, 'player-red').pieces[0].statusTags)
      .toContainEqual(expect.objectContaining({ id: 'secret-choice', targetPieceId: 'secret-ally' }))
    expect(toPublicBattleState(state, 'player-blue').pieces[0].statusTags)
      .toEqual([{ id: 'public-active', type: 'public-active', visible: true }])
    expect(toPublicBattleState(state).pieces[0].statusTags)
      .toEqual([{ id: 'public-active', type: 'public-active', visible: true }])
  })

  it('keeps Tracer Recall numeric choices private to their owner', () => {
    const state = makeState() as any
    state.extensions.recallData = [{
      pieceId: 'tracer-red', ownerPlayerId: 'player-red', projectionVisibility: 'owner', targetCount: 7, actionCount: 0,
      snapshot: { x: 1, y: 2, hp: 9 },
    }]

    expect((toPublicBattleState(state, 'player-red').extensions as any).recallData).toHaveLength(1)
    expect((toPublicBattleState(state, 'player-blue').extensions as any).recallData).toEqual([])
    expect((toPublicBattleState(state).extensions as any).recallData).toEqual([])
  })

  it('redacts invisible status data after a piece enters the graveyard', () => {
    const piece = makePiece({ instanceId: 'fallen-aizen', ownerPlayerId: 'player-red' })
    piece.statusTags = [
      { id: 'public-active', type: 'public-active', visible: true },
      { id: 'secret-choice', type: 'secret-choice', visible: false, targetPieceId: 'secret-ally' },
    ] as never
    const state = makeState({ pieces: [] })
    state.graveyard = [piece] as never

    expect(toPublicBattleState(state, 'player-red').graveyard[0].statusTags)
      .toContainEqual(expect.objectContaining({ id: 'secret-choice', targetPieceId: 'secret-ally' }))
    expect(toPublicBattleState(state, 'player-blue').graveyard[0].statusTags)
      .toEqual([{ id: 'public-active', type: 'public-active', visible: true }])
    expect(toPublicBattleState(state).graveyard[0].statusTags)
      .toEqual([{ id: 'public-active', type: 'public-active', visible: true }])
  })

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
      selectionMode: 'multi',
      presentation: 'hand',
      minSelections: 1,
      maxSelections: 4,
      continuationContext: { private: 'continuation' },
      pendingAction: { type: 'beginPhase' },
      transaction: {
        protocolVersion: 1,
        rootAction: { type: 'playCard', cardInstanceId: 'private-card' },
        baseTargetingRevision: 7,
        answers: [{ key: { consumerKind: 'rule', consumerId: 'private-rule', consumerOrdinal: 0 }, input: { selectedOption: 'secret' } }],
        currentInteraction: { consumerKind: 'rule', consumerId: 'private-rule', consumerOrdinal: 1 },
        runtimeCheckpoint: { rootSeed: 42, tick: 3, snapshot: { cursors: { secret: 2 }, clockCursor: 1 } },
      },
      suspendedTurn: { currentPlayerId: 'player-red', turnNumber: 3, phase: 'end' },
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
    expect(owner).toMatchObject({
      selectionMode: 'multi',
      presentation: 'hand',
      minSelections: 1,
      maxSelections: 4,
    })
    for (const projection of [opponent, spectator]) {
      expect(projection.selectionMode).toBeUndefined()
      expect(projection.presentation).toBeUndefined()
    }
    for (const projection of [owner, opponent, spectator]) {
      expect(projection).toMatchObject({
        playerId: 'player-red',
        selectionId: 'pending-option-1',
        stateRevision: 8,
      })
      expect(projection.continuationContext).toBeUndefined()
      expect(projection.pendingAction).toBeUndefined()
      expect(projection.transaction).toBeUndefined()
      expect(projection.suspendedTurn).toBeUndefined()
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
      source: { type: 'rule', id: 'rule-minato-anchor-end-turn', pieceId: 'minato' },
      selectionId: 'pending-target-1',
      stateRevision: 9,
      step: 0,
      canCancel: false,
      selectedTargets: [],
      candidates: [{ type: 'cell', x: 2, y: 3 }],
      effectCode: 'private-effect-code',
      continuationContext: { private: 'continuation' },
      pendingAction: { type: 'endTurn', playerId: 'player-red' },
      transaction: {
        protocolVersion: 1,
        rootAction: { type: 'endTurn', playerId: 'player-red' },
        baseTargetingRevision: 8,
        answers: [],
        currentInteraction: {
          consumerKind: 'rule',
          consumerId: 'rule-minato-anchor-end-turn',
          consumerOrdinal: 0,
          eventType: 'endTurn',
        },
        runtimeCheckpoint: { rootSeed: 7, tick: 4, snapshot: { cursors: {}, clockCursor: 0 } },
      },
      suspendedTurn: { currentPlayerId: 'player-red', turnNumber: 4, phase: 'action' },
      candidateState: { private: 'candidate-checkpoint' },
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
      expect(projection.transaction).toBeUndefined()
      expect(projection.suspendedTurn).toBeUndefined()
      expect(projection.candidateState).toBeUndefined()
    }
  })
})
