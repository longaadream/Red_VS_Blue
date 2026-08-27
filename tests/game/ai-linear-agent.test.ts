import { describe, expect, it } from 'vitest'

import { aiEnvironmentV1 } from '@/lib/game/ai-environment'
import {
  AI_LINEAR_FEATURE_NAMES,
  encodeLinearObservation,
} from '@/lib/game/ai-linear-features'
import { chooseLinearGreedyAction } from '@/lib/game/ai-linear-agent'
import type { AIEnvironment, CandidateAction, TransitionResult } from '@/lib/game/ai-types'
import type { BattleState } from '@/lib/game/turn'
import { hashStable } from '@/lib/game/battle-trace'
import { agentConfigHash, validateAgentArchive } from '@/lib/game/ai-match-runner'
import { makePiece, makeState } from '@/tests/helpers/minimal-state'

function accepted(state: BattleState, candidate: CandidateAction): TransitionResult {
  const stateHash = hashStable(state)
  return {
    protocolVersion: 1,
    accepted: true,
    state,
    stateHash,
    transitionHash: hashStable({ stateHash, action: candidate.action }),
    trace: { actionLog: [], stateChanges: [] },
  }
}

function candidate(id: string, type: 'endTurn' | 'move'): CandidateAction {
  return {
    protocolVersion: 1,
    id,
    kind: type === 'endTurn' ? 'end-turn' : 'move',
    action: type === 'endTurn'
      ? { type, playerId: 'player-red' }
      : { type, playerId: 'player-red', pieceId: 'red-core', toX: 1, toY: 0 },
  }
}

describe('linear greedy AI observation and decision', () => {
  it('validates and hashes a self-contained linear-greedy archive', () => {
    const archive = {
      schemaVersion: 1 as const,
      agentId: 'linear-fixture-v1',
      version: '1.0.0',
      kind: 'linear-greedy' as const,
      config: {
        version: 1 as const,
        featureSchemaVersion: 1 as const,
        weights: Object.fromEntries(AI_LINEAR_FEATURE_NAMES.map(name => [name, 0])),
      },
    }
    expect(validateAgentArchive(archive)).toEqual(archive)
    expect(agentConfigHash(archive)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('encodes a finite, bounded, versioned vector without opponent hidden hand identity', () => {
    const state = makeState({
      pieces: [
        makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red', x: 0, y: 0 }),
        makePiece({ instanceId: 'blue-core', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 0 }),
      ],
    })
    state.pieces[0].isCore = true
    state.pieces[1].isCore = true
    state.players[1].hand = [{ instanceId: 'secret-a', cardId: 'secret-card-a' }] as typeof state.players[1]['hand']
    const first = encodeLinearObservation(aiEnvironmentV1.observe(state, 'player-red'))

    state.players[1].hand = [{ instanceId: 'secret-b', cardId: 'secret-card-b' }] as typeof state.players[1]['hand']
    state.extensions = { leaked: { privateValue: 999 } } as typeof state.extensions
    const second = encodeLinearObservation(aiEnvironmentV1.observe(state, 'player-red'))

    expect(first.schemaVersion).toBe(1)
    expect(first.featureNames).toEqual(AI_LINEAR_FEATURE_NAMES)
    expect(first.values).toEqual(second.values)
    expect(first.values).toHaveLength(AI_LINEAR_FEATURE_NAMES.length)
    expect(first.values.every(value => Number.isFinite(value) && value >= -1 && value <= 1)).toBe(true)
    expect(first.schemaHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('uses fixed terminal priority and a stable candidate-id tie break', () => {
    const base = makeState({
      pieces: [
        makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red' }),
        makePiece({ instanceId: 'blue-core', ownerPlayerId: 'player-blue', faction: 'blue', x: 2 }),
      ],
    })
    base.pieces.forEach(piece => { piece.isCore = true })
    const end = candidate('candidate-z-end', 'endTurn')
    const moveB = candidate('candidate-b-move', 'move')
    const moveA = { ...moveB, id: 'candidate-a-move' }
    const winning = structuredClone(base)
    winning.terminalResult = {
      status: 'finished', winnerPlayerId: 'player-red', loserPlayerId: 'player-blue', reason: 'core-eliminated',
      settledAt: {
        actionIndex: 1,
        actionType: 'move',
        actorPlayerId: 'player-red',
        turnNumber: winning.turn.turnNumber,
        phase: winning.turn.phase,
        completedRound: 0,
      },
    }
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      listLegalActions: () => [end, moveB, moveA],
      simulate: (state, input) => {
        const selected = 'action' in input ? input : moveA
        return accepted(selected.id === moveB.id ? winning : structuredClone(state), selected)
      },
    }
    const weights = Object.fromEntries(AI_LINEAR_FEATURE_NAMES.map(name => [name, 0]))

    const terminal = chooseLinearGreedyAction(base, 'player-red', 123, { version: 1, featureSchemaVersion: 1, weights }, environment)
    expect(terminal.action?.id).toBe(moveB.id)

    environment.simulate = (state, input) => accepted(structuredClone(state), 'action' in input ? input : moveA)
    const tied = chooseLinearGreedyAction(base, 'player-red', 123, { version: 1, featureSchemaVersion: 1, weights }, environment)
    expect(tied.action?.id).toBe(end.id)
    expect(tied.traceHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('shortlists a large legal set deterministically and traces every cropped candidate', () => {
    const base = makeState({ pieces: [makePiece({ instanceId: 'red-core' })] })
    base.pieces[0].isCore = true
    const legal = Array.from({ length: 10 }, (_, index) => ({
      protocolVersion: 1 as const,
      id: `candidate-${String(index).padStart(2, '0')}`,
      kind: 'move' as const,
      action: { type: 'move' as const, playerId: 'player-red', pieceId: 'red-core', toX: index % 6, toY: 0 },
    }))
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      listLegalActions: () => legal,
      simulate: (state, input) => accepted(structuredClone(state), 'action' in input ? input : legal[0]),
    }
    const weights = Object.fromEntries(AI_LINEAR_FEATURE_NAMES.map(name => [name, 0]))
    const first = chooseLinearGreedyAction(base, 'player-red', 99, {
      version: 1, featureSchemaVersion: 1, weights, maxCandidates: 3,
    }, environment)
    const second = chooseLinearGreedyAction(base, 'player-red', 99, {
      version: 1, featureSchemaVersion: 1, weights, maxCandidates: 3,
    }, environment)
    expect(first).toEqual(second)
    expect(first.nodes).toBe(3)
    expect(first.trace.filter(entry => entry.pruned === 'candidate-budget')).toHaveLength(7)
  })
})
