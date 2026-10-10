import { describe, expect, it } from 'vitest'
import { decideGoalAction } from '@/lib/ai-bot/goal-policy'
import type { AIEnvironment, CandidateAction } from '@/lib/game/ai-types'
import type { BattleState } from '@/lib/game/turn'

function state(overrides: Partial<BattleState> = {}): BattleState {
  const base = {
    map: {
      id: 'map', name: 'Map', width: 3, height: 1,
      tiles: [0, 1, 2].map(x => ({ id: `map-${x}`, x, y: 0, props: { walkable: true, bulletPassable: true, type: 'floor' as const } })),
    },
    pieces: [
      { instanceId: 'red-1', templateId: 'unknown-red', name: 'Red', ownerPlayerId: 'red', faction: 'red' as const, currentHp: 10, maxHp: 10, attack: 2, defense: 1, moveRange: 2, x: 0, y: 0, isCore: true, skills: [], buffs: [], debuffs: [], ruleTags: [], statusTags: [], rules: [] },
      { instanceId: 'blue-1', templateId: 'unknown-blue', name: 'Blue', ownerPlayerId: 'blue', faction: 'blue' as const, currentHp: 8, maxHp: 8, attack: 1, defense: 0, moveRange: 1, x: 2, y: 0, isCore: true, skills: [], buffs: [], debuffs: [], ruleTags: [], statusTags: [], rules: [] },
    ],
    graveyard: [], pieceStatsByTemplateId: {}, skillsById: {},
    players: [
      { playerId: 'red', chargePoints: 0, actionPoints: 3, maxActionPoints: 3, hand: [], discardPile: [], rules: [], statusTags: [] },
      { playerId: 'blue', chargePoints: 0, actionPoints: 0, maxActionPoints: 0, hand: [], discardPile: [], rules: [], statusTags: [] },
    ],
    turn: { currentPlayerId: 'red', turnNumber: 1, phase: 'action' as const, actions: { hasMoved: false, hasUsedBasicSkill: false, hasUsedChargeSkill: false } },
    targetingRevision: 4,
  } as unknown as BattleState
  return { ...base, ...overrides }
}

function routeEnvironment(): AIEnvironment {
  const candidate: CandidateAction = {
    protocolVersion: 1,
    id: 'kill-blue',
    kind: 'basic-skill',
    action: { type: 'useBasicSkill', playerId: 'red', pieceId: 'red-1', skillId: 'local-test-skill', targetPieceId: 'blue-1', selectionId: 'sel-4-test', stateRevision: 4 },
  }
  return {
    protocolVersion: 1,
    capabilities: { protocolVersion: 1, supportedActionTypes: [], unsupportedActionTypes: [] },
    observe: () => { throw new Error('goal policy test does not use observe') },
    listLegalActions: () => [candidate],
    simulate: (input) => ({
      protocolVersion: 1,
      accepted: true,
      state: { ...input, pieces: input.pieces.map(piece => piece.instanceId === 'blue-1' ? { ...piece, currentHp: 0 } : piece) },
      stateHash: 'state', transitionHash: 'transition', trace: { actionLog: [], stateChanges: [] },
    }),
    isTerminal: value => value.terminalResult !== undefined,
    stateKey: value => value.pieces.map(piece => `${piece.instanceId}:${piece.currentHp}`).join('|'),
  }
}

describe('decideGoalAction', () => {
  it('returns the first action of a bounded public goal route and uses the local hypothetical seed', () => {
    let capturedSeed: number | undefined
    const environment = routeEnvironment()
    const originalSimulate = environment.simulate
    environment.simulate = (input, action, context) => {
      capturedSeed = context?.rootSeed
      return originalSimulate(input, action, context)
    }
    const result = decideGoalAction(state({ extensions: { battleProfile: { rootSeed: 999 } } } as never), 'red', {
      environment,
      hypotheticalSeed: 123,
      maxNodes: 8,
      maxDepth: 2,
      maxTimeMs: 2_000,
    })
    expect(result.reason).toBe('goal-route-found')
    expect(result.action).toMatchObject({ type: 'useBasicSkill', targetPieceId: 'blue-1', selectionId: 'sel-4-test', stateRevision: 4 })
    expect(result.search?.status).toBe('found')
    expect(capturedSeed).toBe(123)
    expect(result.diagnostics.join('\n')).toContain('budget nodes=8 depth=2 timeMs=2000')
  })

  it('switches an already achieved summon goal to the default visible eliminate goal', () => {
    const result = decideGoalAction(state(), 'red', {
      environment: routeEnvironment(),
      goal: { kind: 'summon', templateId: 'unknown-red' },
      hypotheticalSeed: 123,
      maxNodes: 8,
      maxDepth: 2,
      maxTimeMs: 2_000,
    })
    expect(result.goal).toEqual({ kind: 'eliminate', targetId: 'blue-1' })
    expect(result.reason).toBe('goal-route-found')
    expect(result.diagnostics.join('\n')).toContain('goal already achieved')
  })

  it('uses an improved frontier action when the route search exhausts its node budget', () => {
    const environment = routeEnvironment()
    const originalSimulate = environment.simulate
    environment.simulate = (input, action, context) => {
      const result = originalSimulate(input, action, context)
      if (!result.accepted) return result
      return {
        ...result,
        state: {
          ...result.state,
          pieces: result.state.pieces.map(piece => piece.instanceId === 'blue-1'
            ? { ...piece, currentHp: 7 }
            : piece),
        },
      }
    }
    const result = decideGoalAction(state(), 'red', {
      environment,
      hypotheticalSeed: 123,
      maxNodes: 2,
      maxDepth: 3,
      maxTimeMs: 2_000,
    })
    expect(result.reason).toBe('fallback-budget-exhausted')
    expect(result.action).toMatchObject({ type: 'useBasicSkill', targetPieceId: 'blue-1' })
    expect(result.diagnostics.join('\n')).toContain('improved frontier')
  })

  it('submits a minimum valid pending selection with the server credentials', () => {
    const current = state({
      pendingOptionSelection: {
        playerId: 'red', title: 'Choose', options: [{ value: 'one' }, { value: 'two' }],
        selectionMode: 'multi', minSelections: 2, maxSelections: 2, selectionId: 'option-7', stateRevision: 4,
      } as never,
    })
    const result = decideGoalAction(current, 'red', { environment: { ...routeEnvironment(), listLegalActions: () => { throw new Error('must not search pending') } } })
    expect(result.reason).toBe('pending-option-selection')
    expect(result.action).toEqual({ type: 'pendingOptionSelect', playerId: 'red', selectedOption: ['one', 'two'], selectionId: 'option-7', stateRevision: 4 })
  })

  it('submits the minimum public pending target set with the same credentials', () => {
    const current = state({
      pendingTargetSelection: {
        playerId: 'red', ownerPlayerId: 'red', targetType: 'piece', title: 'Targets',
        candidates: [{ type: 'piece', pieceId: 'blue-1' }, { type: 'piece', pieceId: 'red-1' }],
        selectedTargets: [], selectionMode: 'multi', minSelections: 2, maxSelections: 2,
        selectionId: 'target-7', stateRevision: 4,
      } as never,
    })
    const result = decideGoalAction(current, 'red', { environment: { ...routeEnvironment(), listLegalActions: () => { throw new Error('must not search pending') } } })
    expect(result.reason).toBe('pending-target-selection')
    expect(result.action).toEqual({
      type: 'pendingTargetSelect', playerId: 'red', targetPieceId: 'blue-1',
      extraTargets: [{ pieceId: 'red-1' }], selectionId: 'target-7', stateRevision: 4,
    })
  })

  it('uses public deployment offers and legal cells without reconstructing reserves', () => {
    const current = state({
      deployment: {
        mode: 'progressive-reserve-v1', status: 'awaiting-reserve-deploy', playerIds: ['red', 'blue'], choices: {}, locks: {},
        startedAt: 0, deadlineAt: 100, revision: 9, initialPositions: {}, activePlayerId: 'red', offerTurnNumber: 1,
        offerPieces: [{ instanceId: 'offer-1', templateId: 'public-template', name: 'Offer' }], legalPositions: [{ x: 1, y: 0 }],
      },
    })
    const result = decideGoalAction(current, 'red')
    expect(result.reason).toBe('deployment-selection')
    expect(result.action).toEqual({ type: 'deployReservePiece', playerId: 'red', expectedDeploymentRevision: 9, pieceId: 'offer-1', toX: 1, toY: 0 })
  })
})
