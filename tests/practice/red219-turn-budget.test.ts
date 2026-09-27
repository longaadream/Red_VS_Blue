import { expect, it } from 'vitest'
import { planShortSearchAction, type ShortSearchContinuation } from '@/lib/game/ai-short-search'
import { practiceEnvironment } from '@/lib/practice/environment'
import { evaluateZeroStageState } from '@/lib/practice/evaluator'
import { makePiece, makeState } from '../helpers/minimal-state'

it('continues useful authority actions beyond seven while carrying the real search budget', () => {
  const cells = Array.from({ length: 9 }, (_, index) => ({ x: index % 3, y: Math.floor(index / 3) }))
    .filter(cell => cell.x !== 1 || cell.y !== 1)
  let state = makeState({ width: 3, height: 3, pieces: [
    ...cells.map((cell, index) => makePiece({ instanceId: `caster-${index}`, ...cell, attack: 1, moveRange: 0,
      skills: [{ skillId: 'fireball', currentCooldown: 0, usesRemaining: -1 }] })),
    makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue',
      x: 1, y: 1, moveRange: 0, maxHp: 100, currentHp: 100 }),
  ] })
  state.pieces.forEach(piece => { piece.isCore = true })
  state.players[0].actionPoints = 9
  const original = JSON.stringify(state)
  let continuation: ShortSearchContinuation | undefined
  for (let actionsTaken = 0; actionsTaken < 8; actionsTaken++) {
    if (actionsTaken === 7) {
      const oldCap = planShortSearchAction(state, 'player-red', 219, {
        environment: practiceEnvironment, evaluate: observation => evaluateZeroStageState(observation).total,
        continuation, actionsTakenThisTurn: actionsTaken,
        config: { maxActionsPerTurn: 8, depth: 1, turnTimeMs: 0, decisionTimeMs: 0, deploymentTimeMs: 0 }, now: () => 0,
      })
      expect(oldCap.nextAction?.kind).toBe('end-turn')
      expect(oldCap.stopReason).toBe('action-budget')
    }
    const plan = planShortSearchAction(state, 'player-red', 219, {
      environment: practiceEnvironment, evaluate: observation => evaluateZeroStageState(observation).total,
      continuation, actionsTakenThisTurn: actionsTaken,
      // One-step search isolates the cumulative action guard; node limits remain unchanged.
      config: { depth: 1, turnTimeMs: 0, decisionTimeMs: 0, deploymentTimeMs: 0 }, now: () => 0,
    })
    expect(plan.nextAction?.kind, JSON.stringify({ actionsTaken, trace: plan.trace, skill: state.pieces[0].skills })).toBe('basic-skill')
    expect(plan.continuation.nodes).toBeLessThanOrEqual(896)
    if (actionsTaken === 0) expect(JSON.stringify(state)).toBe(original)
    const result = practiceEnvironment.simulate(state, plan.nextAction!, { rootSeed: 219 })
    expect(result.accepted).toBe(true)
    if (!result.accepted) throw new Error(result.error.code)
    state = result.state
    continuation = plan.continuation
  }
  expect(state.pieces.find(piece => piece.instanceId === 'enemy')?.currentHp).toBe(92)
  expect(state.players[0].actionPoints).toBe(1)
  expect(state.turn.currentPlayerId).toBe('player-red')
})
