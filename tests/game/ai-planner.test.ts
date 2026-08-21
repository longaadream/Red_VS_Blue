/* eslint-disable @typescript-eslint/no-explicit-any -- isolated synthetic environment fixture. */
import { describe, expect, it } from 'vitest'
import { hashStable } from '@/lib/game/battle-trace'
import { aiPlanTraceHash, planAiTurn } from '@/lib/game/ai-planner'
import { aiEnvironmentV1 } from '@/lib/game/ai-environment'
import type { AIEnvironment, CandidateAction } from '@/lib/game/ai-types'
import { makePiece, makeState } from '../helpers/minimal-state'

const seed = 8675309
const candidate = (id: string, type: string): CandidateAction => ({ protocolVersion: 1, id, kind: type === 'endTurn' ? 'end-turn' : 'basic-skill', action: { type, playerId: 'player-red', pieceId: 'red-a' } as any })

/** A deterministic, roster-neutral transition fixture: each action advances one shared objective stage. */
function stagedEnvironment(loop = false): AIEnvironment {
  return {
    protocolVersion: 1,
    capabilities: { protocolVersion: 1, supportedActionTypes: [] as never, unsupportedActionTypes: [] },
    observe: () => ({} as never),
    isTerminal: state => (state as any).stage >= 3,
    stateKey: state => `${(state as any).stage ?? 0}:${(state as any).turn?.currentPlayerId}`,
    listLegalActions: state => {
      const stage = (state as any).stage ?? 0
      if (stage >= 3) return [candidate('end', 'endTurn')]
      return [candidate(`act-${stage}`, `action-${stage}`), candidate('end', 'endTurn')]
    },
    simulate: (state, action) => {
      const next = structuredClone(state) as any
      const command = 'action' in action ? action.action : action
      if (command.type !== 'endTurn') {
        next.stage = loop ? 0 : ((next.stage ?? 0) + 1)
        // Reduce a generic opponent HP pool: evaluator sees only transition state.
        next.pieces.find((piece: any) => piece.ownerPlayerId === 'player-blue').currentHp -= 10
      }
      return { protocolVersion: 1, accepted: true, state: next, stateHash: hashStable(next), transitionHash: hashStable({ next, action }), trace: { actionLog: [], stateChanges: [] } } as any
    },
  }
}

function fixtureState() {
  return makeState({ pieces: [
    makePiece({ instanceId: 'red-a', ownerPlayerId: 'player-red', x: 1, y: 1 }),
    makePiece({ instanceId: 'red-b', ownerPlayerId: 'player-red', x: 1, y: 2 }),
    makePiece({ instanceId: 'blue-target', ownerPlayerId: 'player-blue', x: 4, y: 1, currentHp: 40 }),
  ] }) as any
}

describe('roster-independent multi-action AI turn planner', () => {
  it('plans a three-step shared goal, returns only its first action, and stays deterministic', () => {
    const state = fixtureState()
    const first = planAiTurn(state, 'player-red', seed, { environment: stagedEnvironment(), config: { nodeBudget: 24, maxActions: 4 } })
    const second = planAiTurn(state, 'player-red', seed, { environment: stagedEnvironment(), config: { nodeBudget: 24, maxActions: 4 } })
    expect(first.goal).toMatchObject({ kind: 'eliminate', targetId: 'blue-target' })
    expect(first.actions).toHaveLength(3)
    expect(first.nextAction).toEqual(first.actions[0])
    expect(first.actions.map(item => item.action.type)).toEqual(['action-0', 'action-1', 'action-2'])
    expect(aiPlanTraceHash(second)).toBe(aiPlanTraceHash(first))
  })

  it('replans from an authoritative new state instead of returning a stale queued action', () => {
    const environment = stagedEnvironment()
    const initial = fixtureState()
    const oldPlan = planAiTurn(initial, 'player-red', seed, { environment })
    const authoritative = environment.simulate(initial, oldPlan.nextAction, { rootSeed: seed })
    const fixtureReplan = planAiTurn(authoritative.state, 'player-red', seed, { environment, previousGoal: oldPlan.goal })
    expect(fixtureReplan.nextAction.action.type).toBe('action-1')
    expect(fixtureReplan.nextAction).not.toEqual(oldPlan.nextAction)
  })

  it('ends safely on a zero-progress loop and records the repeated state', () => {
    const plan = planAiTurn(fixtureState(), 'player-red', seed, { environment: stagedEnvironment(true), config: { nodeBudget: 24, maxActions: 8 } })
    expect(plan.actions.at(-1)?.kind).toBe('end-turn')
    expect(plan.stateDuplicates).toBeGreaterThan(0)
    expect(plan.nodesVisited).toBeLessThanOrEqual(24)
    expect(plan.trace.some(entry => entry.pruned === 'duplicate-state')).toBe(true)
  })

  it('keeps 200 fixed-seed multi-roster movement samples within budgets and never plans an illegal action', () => {
    for (let index = 0; index < 200; index += 1) {
      const state = makeState({ pieces: [
        makePiece({ instanceId: `red-${index}`, ownerPlayerId: 'player-red', x: index % 3, y: (index >> 2) % 3, moveRange: 1 + (index % 3) }),
        makePiece({ instanceId: `blue-${index}`, ownerPlayerId: 'player-blue', x: 4 + (index % 2), y: 1 + (index % 3), currentHp: 20 + (index % 4) }),
      ] }) as any
      const plan = planAiTurn(state, 'player-red', seed + index, { config: { nodeBudget: 2, maxActions: 1, beamWidth: 1, candidateLimit: 1 } })
      expect(plan.nodesVisited, `seed ${seed + index}`).toBeLessThanOrEqual(2)
      let current = state
      for (const action of plan.actions) {
        const result = aiEnvironmentV1.simulate(current, action, { rootSeed: seed + index })
        expect(result.accepted, `seed ${seed + index}: ${action.id}`).toBe(true)
        if (result.accepted) current = result.state
      }
    }
  }, 30_000)
})
