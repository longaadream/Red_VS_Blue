/* eslint-disable @typescript-eslint/no-explicit-any -- deterministic environment fixtures. */
import { describe, expect, it } from 'vitest'

import {
  searchGoalRoute,
  type GoalSearchOptions,
} from '@/lib/game/ai-goal-search'
import type { AIEnvironment, CandidateAction, TransitionResult } from '@/lib/game/ai-types'
import { hashStable } from '@/lib/game/battle-trace'
import type { BattleState } from '@/lib/game/turn'
import { createOfflineDemonGoalFixture } from '@/lib/ai-bot/offline-goal-fixture'
import { aiEnvironmentV1 } from '@/lib/game/ai-environment'
import { makePiece, makeState } from '../helpers/minimal-state'

const seed = 123

function action(id: string, stage: number, playerId = 'player-red'): CandidateAction {
  return {
    protocolVersion: 1,
    id,
    kind: 'basic-skill',
    action: { type: `fixture-${stage}`, playerId, pieceId: 'red-piece' } as any,
  }
}

function transition(state: BattleState, candidate: CandidateAction, next: BattleState): TransitionResult {
  return {
    protocolVersion: 1,
    accepted: true,
    state: next,
    stateHash: hashStable(next),
    transitionHash: hashStable({ state, candidate }),
    trace: { actionLog: [], stateChanges: [] },
  }
}

function fixtureState() {
  return makeState({
    pieces: [makePiece({ instanceId: 'red-piece', ownerPlayerId: 'player-red' })],
    currentPlayerId: 'player-red',
  }) as BattleState & { stage?: number }
}

function fixtureEnvironment(
  listLegalActions: AIEnvironment['listLegalActions'],
  simulate: AIEnvironment['simulate'],
): AIEnvironment {
  return {
    protocolVersion: 1,
    capabilities: { protocolVersion: 1, supportedActionTypes: [], unsupportedActionTypes: [] },
    observe: () => ({}) as never,
    isTerminal: state => Boolean(state.terminalResult),
    stateKey: state => String((state as BattleState & { stage?: number }).stage ?? 0),
    listLegalActions,
    simulate,
  }
}

function searchOptions(environment: AIEnvironment, overrides: Partial<GoalSearchOptions> = {}): GoalSearchOptions {
  return {
    environment,
    rootSeed: seed,
    goal: state => (state as BattleState & { stage?: number }).stage === 2,
    maxNodes: 32,
    maxDepth: 4,
    maxTimeMs: 10_000,
    ...overrides,
  }
}

describe('generic bounded goal search', () => {
  it('keeps zero/negative-progress setup steps and returns the shortest deterministic route', () => {
    const state = fixtureState()
    const environment = fixtureEnvironment(
      current => {
        const stage = (current as any).stage ?? 0
        if (stage === 0) return [action('z-direct-dead-end', 9), action('a-setup', 1)]
        if (stage === 1) return [action('b-finish', 2)]
        return []
      },
      (current, input) => {
        const candidate = 'action' in input ? input : action('raw', 0)
        const next = structuredClone(current) as BattleState & { stage?: number }
        const id = candidate.id
        if (id === 'a-setup') next.stage = 1
        else if (id === 'b-finish') next.stage = 2
        else next.stage = 9
        return transition(current, candidate, next)
      },
    )
    const result = searchGoalRoute(state, 'player-red', searchOptions(environment, {
      progress: current => (current as any).stage === 1 ? -5 : 0,
    }))

    expect(result.status).toBe('found')
    if (result.status !== 'found') return
    expect(result.route.map(candidate => candidate.id)).toEqual(['a-setup', 'b-finish'])
    expect(result.firstAction?.id).toBe('a-setup')
    expect(result.stats.stateDuplicates).toBe(0)
  })

  it('distinguishes a capped search from a fully exhausted no-route search', () => {
    const state = fixtureState()
    const environment = fixtureEnvironment(
      current => {
        const stage = (current as any).stage ?? 0
        return stage === 0 ? [action('only-step', 1)] : []
      },
      (current, input) => {
        const candidate = 'action' in input ? input : action('raw', 0)
        const next = structuredClone(current) as BattleState & { stage?: number }
        next.stage = 1
        return transition(current, candidate, next)
      },
    )
    const noRoute = searchGoalRoute(state, 'player-red', searchOptions(environment, {
      goal: () => false,
      maxDepth: 2,
    }))
    const depthCapped = searchGoalRoute(state, 'player-red', searchOptions(environment, {
      maxDepth: 0,
    }))
    const nodeCapped = searchGoalRoute(state, 'player-red', searchOptions(environment, {
      maxNodes: 1,
    }))

    expect(noRoute.status).toBe('no-route')
    expect(depthCapped).toMatchObject({ status: 'budget-exhausted', reason: 'depth' })
    expect(nodeCapped).toMatchObject({ status: 'budget-exhausted', reason: 'node' })
  })

  it('deduplicates full states and keeps authority rejects separate from simulation errors', () => {
    const state = fixtureState()
    let throwOnce = true
    const environment = fixtureEnvironment(
      current => ((current as any).stage ?? 0) === 0
        ? [action('reject', 0), action('duplicate-a', 1), action('duplicate-b', 2), action('duplicate-c', 3)]
        : [],
      (current, input) => {
        const candidate = 'action' in input ? input : action('raw', 0)
        if (candidate.id === 'reject') return {
          protocolVersion: 1,
          accepted: false,
          state: current,
          stateHash: hashStable(current),
          transitionHash: hashStable({ rejected: candidate.id }),
          error: { code: 'FIXTURE_REJECTED', name: 'FixtureReject', message: 'rejected by authority' },
          trace: { actionLog: [], stateChanges: [] },
        }
        if (candidate.id === 'duplicate-b' && throwOnce) {
          throwOnce = false
          throw new Error('fixture runner error')
        }
        const next = structuredClone(current) as BattleState & { stage?: number }
        next.stage = 1
        return transition(current, candidate, next)
      },
    )
    const result = searchGoalRoute(state, 'player-red', searchOptions(environment, { goal: () => false }))

    expect(result.status).toBe('invalid-input')
    expect(result.stats.simulationRejects).toBe(1)
    expect(result.stats.simulationErrors).toBe(1)
    expect(result.stats.simulationErrorDetails[0]?.message).toContain('fixture runner error')
    expect(result.stats.stateDuplicates).toBe(1)
  })

  it('stops when an accepted transition changes the player or turn', () => {
    const state = fixtureState()
    const environment = fixtureEnvironment(
      current => ((current as any).stage ?? 0) === 0 ? [action('switch-turn', 0)] : [],
      (current, input) => {
        const candidate = 'action' in input ? input : action('raw', 0)
        const next = structuredClone(current) as BattleState & { stage?: number }
        next.turn.currentPlayerId = 'player-blue'
        next.turn.turnNumber += 1
        next.stage = 2
        return transition(current, candidate, next)
      },
    )
    const result = searchGoalRoute(state, 'player-red', searchOptions(environment))
    expect(result.status).toBe('no-route')
  })

  it('treats slow synchronous action enumeration as a time budget exhaustion', () => {
    const state = fixtureState()
    let ticks = 0
    const environment = fixtureEnvironment(
      () => [action('never-reached', 0)],
      () => { throw new Error('must not simulate') },
    )
    const result = searchGoalRoute(state, 'player-red', searchOptions(environment, {
      maxTimeMs: 1,
      now: () => {
        ticks += 1
        return ticks <= 2 ? 0 : 2
      },
    }))
    expect(result).toMatchObject({ status: 'budget-exhausted', reason: 'enumeration' })
  })

  it('finds the real five-card demon chain through the official environment', async () => {
    const fixture = await createOfflineDemonGoalFixture({ rootSeed: 0x8b0139 })
    const beforeStateHash = hashStable(fixture.state)
    const result = searchGoalRoute(fixture.state, fixture.playerId, {
      environment: aiEnvironmentV1,
      rootSeed: fixture.rootSeed,
      goal: fixture.goal,
      progress: fixture.progress,
      maxNodes: 64,
      maxDepth: 5,
      maxTimeMs: 10_000,
    })

    expect(result.status).toBe('found')
    if (result.status !== 'found') return
    expect(result.route).toHaveLength(5)
    expect(result.route.every(candidate => candidate.action.type === 'playCard')).toBe(true)
    expect(result.state.players.find(player => player.playerId === fixture.playerId)?.actionPoints).toBe(0)
    expect(result.state.players.find(player => player.playerId === fixture.playerId)?.discardPile).toEqual([...fixture.expectedCardIds])
    expect(result.state.pieces.some(piece => piece.templateId === fixture.goalTemplateId && piece.currentHp > 0)).toBe(true)
    expect(result.state.pieces.find(piece => piece.instanceId === 'offline-demon-anchor')?.currentHp).toBe(10)
    expect(hashStable(fixture.state)).toBe(beforeStateHash)
  })

  it('rejects invalid seed and bounds before invoking the environment', () => {
    const state = fixtureState()
    const environment = fixtureEnvironment(() => { throw new Error('not invoked') }, () => { throw new Error('not invoked') })
    expect(searchGoalRoute(state, 'player-red', searchOptions(environment, { rootSeed: -1 }))).toMatchObject({
      status: 'invalid-input', error: { code: 'AI_GOAL_SEARCH_SEED_INVALID' },
    })
    expect(searchGoalRoute(state, 'player-red', searchOptions(environment, { maxNodes: 0 }))).toMatchObject({
      status: 'invalid-input', error: { code: 'AI_GOAL_SEARCH_BOUNDS_INVALID' },
    })
  })
})
