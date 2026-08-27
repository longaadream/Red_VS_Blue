/* eslint-disable @typescript-eslint/no-explicit-any -- deterministic serialized AI fixtures. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  aiEnvironmentV1,
  aiPotentialEnvironmentV1,
} from '@/lib/game/ai-environment'
import {
  combineZeroStagePotential,
  evaluateZeroStageState,
} from '@/lib/game/ai-zero-stage-evaluator'
import {
  planZeroStageAction,
  zeroStageDecisionTraceHash,
} from '@/lib/game/ai-zero-stage-agent'
import { DEFAULT_ZERO_STAGE_CONFIG } from '@/lib/game/ai-profiles'
import { hashBattleState, hashStable } from '@/lib/game/battle-trace'
import type {
  AIEnvironment,
  AIPotentialCandidate,
  AIPotentialEnvironment,
  CandidateAction,
  TransitionResult,
} from '@/lib/game/ai-types'
import type { BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const ROOT_SEED = 0x1220cafe

function skill(id: string) {
  return JSON.parse(readFileSync(resolve(process.cwd(), `data/skills/${id}.json`), 'utf8'))
}

function combatState(): BattleState {
  const state = makeState({ pieces: [
    makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red', x: 1, y: 1, currentHp: 80 }),
    makePiece({ instanceId: 'blue-core', ownerPlayerId: 'player-blue', x: 3, y: 1, currentHp: 60 }),
  ] }) as any
  state.pieces[0].isCore = true
  state.pieces[1].isCore = true
  return state
}

function accepted(state: BattleState, action: CandidateAction): TransitionResult {
  return {
    protocolVersion: 1,
    accepted: true,
    state,
    stateHash: hashBattleState(state),
    transitionHash: hashStable({ state, action }),
    trace: { actionLog: [], stateChanges: [] },
  }
}

function candidate(id: string, type = id): CandidateAction {
  return {
    protocolVersion: 1,
    id,
    kind: type === 'endTurn' ? 'end-turn' : 'basic-skill',
    action: type === 'endTurn'
      ? { type: 'endTurn', playerId: 'player-red' }
      : { type: type as any, playerId: 'player-red', pieceId: 'red-core' } as any,
  }
}

function potential(candidateAction: CandidateAction, actionPoints = 0): AIPotentialCandidate {
  return {
    candidate: candidateAction,
    cost: { actionPoints, chargePoints: 0 },
    shortfall: { actionPoints, chargePoints: 0 },
    costBreakthrough: false,
  }
}

describe('zero-stage static evaluator', () => {
  it('keeps the versioned agent asset aligned with the executable default profile', () => {
    const profile = JSON.parse(readFileSync(resolve(process.cwd(), 'config/ai/agents/zero-stage-v1.json'), 'utf8'))
    expect(profile).toMatchObject({
      schemaVersion: DEFAULT_ZERO_STAGE_CONFIG.version,
      nodeBudget: DEFAULT_ZERO_STAGE_CONFIG.nodeBudget,
      lambda: DEFAULT_ZERO_STAGE_CONFIG.lambda,
      topWeights: DEFAULT_ZERO_STAGE_CONFIG.topWeights,
      terminal: DEFAULT_ZERO_STAGE_CONFIG.terminal,
      weights: DEFAULT_ZERO_STAGE_CONFIG.weights,
    })
  })

  it('uses an explicit relative player view and gives terminal outcomes absolute priority', () => {
    const state = combatState()
    const red = evaluateZeroStageState(aiEnvironmentV1.observe(state, 'player-red'))
    const blue = evaluateZeroStageState(aiEnvironmentV1.observe(state, 'player-blue'))

    expect(red.components.health.contribution).toBe(-blue.components.health.contribution)
    expect(red.components.coreSurvival.contribution).toBeCloseTo(-blue.components.coreSurvival.contribution)

    const won = structuredClone(state) as any
    won.terminalResult = {
      status: 'finished', winnerPlayerId: 'player-red', loserPlayerId: 'player-blue',
      reason: 'core-eliminated', settledAt: {
        actionIndex: 0, actionType: 'useBasicSkill', actorPlayerId: 'player-red',
        turnNumber: 1, phase: 'action', completedRound: 0,
      },
    }
    const win = evaluateZeroStageState(aiEnvironmentV1.observe(won, 'player-red'))
    const loss = evaluateZeroStageState(aiEnvironmentV1.observe(won, 'player-blue'))
    expect(win.total).toBe(DEFAULT_ZERO_STAGE_CONFIG.terminal.win)
    expect(loss.total).toBe(DEFAULT_ZERO_STAGE_CONFIG.terminal.loss)
  })

  it('cannot change when opponent-private fields or hidden statuses change', () => {
    const state = combatState() as any
    state.players[1].hand = [{
      cardId: 'private-a', instanceId: 'secret-a', ownerPlayerId: 'player-blue', description: 'secret',
    }]
    state.pieces[1].statusTags = [{ id: 'hidden-a', type: 'hidden', visible: false, stacks: 99 }]
    const before = evaluateZeroStageState(aiEnvironmentV1.observe(state, 'player-red'))

    state.players[1].hand = [{
      cardId: 'private-b', instanceId: 'secret-b', ownerPlayerId: 'player-blue', description: 'different',
    }]
    state.pieces[1].statusTags = [{ id: 'hidden-b', type: 'hidden', visible: false, stacks: 1 }]
    const after = evaluateZeroStageState(aiEnvironmentV1.observe(state, 'player-red'))

    expect(after).toEqual(before)
  })

  it('normalizes the configured top weights for zero through three-plus follow-ups', () => {
    expect(combineZeroStagePotential([], [0.6, 0.3, 0.1], 17)).toMatchObject({ value: 17, selected: [] })
    expect(combineZeroStagePotential([10], [0.6, 0.3, 0.1], 0).value).toBe(10)
    expect(combineZeroStagePotential([10, 4], [0.6, 0.3, 0.1], 0).value).toBeCloseTo(8)
    const top = combineZeroStagePotential([10, 4, 1, 100], [0.6, 0.3, 0.1], 0)
    expect(top.value).toBeCloseTo(63.4)
    expect(top.selected).toEqual([100, 10, 4])
  })
})

describe('zero-stage cost-relaxed potential environment', () => {
  it('unlocks only a cost-blocked action on an exact isolated subsidy and never mutates input resources', () => {
    const attack = skill('basic-attack')
    const state = combatState() as any
    state.pieces[1].x = 2
    state.skillsById[attack.id] = attack
    state.pieces[0].skills = [{ skillId: attack.id, currentCooldown: 0, usesRemaining: -1 }]
    state.players[0].actionPoints = 0
    state.players[0].maxActionPoints = 2
    const beforeHash = hashBattleState(state)

    const legalIds = new Set(aiEnvironmentV1.listLegalActions(state, 'player-red').map(item => item.id))
    const candidates = aiPotentialEnvironmentV1.listPotentialActions(state, 'player-red')
    const relaxed = candidates.find(item => (
      item.candidate.action.type === 'useBasicSkill'
      && item.candidate.action.skillId === 'basic-attack'
      && item.candidate.action.targetPieceId === 'blue-core'
    ))

    expect(relaxed).toMatchObject({
      cost: { actionPoints: 1, chargePoints: 0 },
      shortfall: { actionPoints: 1, chargePoints: 0 },
      costBreakthrough: true,
    })
    expect(legalIds.has(relaxed!.candidate.id)).toBe(false)

    const result = aiPotentialEnvironmentV1.simulatePotential(state, relaxed!, { rootSeed: ROOT_SEED })
    expect(result.transition.accepted).toBe(true)
    if (!result.transition.accepted) throw new Error('cost-relaxed fixture must simulate')
    expect(result.transition.state.players[0].actionPoints).toBe(0)
    expect(result.transition.state.players[0].chargePoints).toBeGreaterThanOrEqual(0)
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(state.players[0].actionPoints).toBe(0)
  })

  it('does not bypass cooldown or ownership constraints', () => {
    const attack = skill('basic-attack')
    const state = combatState() as any
    state.skillsById[attack.id] = attack
    state.pieces[0].skills = [{ skillId: attack.id, currentCooldown: 2, usesRemaining: -1 }]
    state.players[0].actionPoints = 0

    const candidates = aiPotentialEnvironmentV1.listPotentialActions(state, 'player-red')
    expect(candidates.some(item => item.candidate.action.type === 'useBasicSkill')).toBe(false)
    expect(candidates.every(item => (
      !('pieceId' in item.candidate.action)
      || item.candidate.action.pieceId !== 'blue-core'
    ))).toBe(true)
  })
})

describe('zero-stage deterministic action selection', () => {
  it('takes an immediate formal core elimination ahead of ordinary movement or ending the turn', () => {
    const attack = skill('basic-attack')
    const state = combatState() as any
    state.pieces[1].x = 2
    state.pieces[1].currentHp = 5
    state.pieces[0].attack = 20
    state.pieces[0].skills = [{ skillId: attack.id, currentCooldown: 0, usesRemaining: -1 }]
    state.skillsById[attack.id] = attack

    const decision = planZeroStageAction(state, 'player-red', ROOT_SEED)
    expect(decision.nextAction?.action).toMatchObject({
      type: 'useBasicSkill',
      pieceId: 'red-core',
      skillId: 'basic-attack',
      targetPieceId: 'blue-core',
    })
    expect(decision.trace.find(item => item.candidateId === decision.nextAction?.id)?.staticValue)
      .toBe(DEFAULT_ZERO_STAGE_CONFIG.terminal.win)
  })

  it('chooses one authoritative legal outer action, uses top follow-up potential, and replans deterministically', () => {
    const state = combatState() as any
    const outerA = candidate('outer-a', 'fixture-a')
    const outerB = candidate('outer-b', 'fixture-b')
    const end = candidate('outer-end', 'endTurn')
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      listLegalActions: current => (current as any).stage ? [] : [outerB, outerA, end],
      simulate: (current, input) => {
        const selected = 'action' in input ? input : candidate('raw', input.type)
        const next = structuredClone(current) as any
        next.stage = selected.id
        if (selected.id === 'outer-b') next.pieces.find((piece: any) => piece.instanceId === 'blue-core').currentHp -= 5
        if (selected.kind === 'end-turn') next.turn.currentPlayerId = 'player-blue'
        return accepted(next, selected)
      },
    }
    const followA = [candidate('follow-a1'), candidate('follow-a2'), candidate('follow-a3')]
    const followB = [candidate('follow-b1')]
    const potentialEnvironment: AIPotentialEnvironment = {
      protocolVersion: 1,
      listPotentialActions: current => (current as any).stage === 'outer-a'
        ? followA.map(item => potential(item))
        : (current as any).stage === 'outer-b' ? followB.map(item => potential(item)) : [],
      simulatePotential: (current, item) => {
        const next = structuredClone(current) as any
        const damageById: Record<string, number> = {
          'follow-a1': 40, 'follow-a2': 30, 'follow-a3': 20, 'follow-b1': 1,
        }
        next.pieces.find((piece: any) => piece.instanceId === 'blue-core').currentHp -= damageById[item.candidate.id] ?? 0
        return { ...item, transition: accepted(next, item.candidate) }
      },
    }

    const first = planZeroStageAction(state, 'player-red', ROOT_SEED, { environment, potentialEnvironment })
    const second = planZeroStageAction(state, 'player-red', ROOT_SEED, { environment, potentialEnvironment })
    const legalIds = environment.listLegalActions(state, 'player-red').map(item => item.id)

    expect(first.nextAction?.id).toBe('outer-a')
    expect(legalIds).toContain(first.nextAction?.id)
    expect(first.trace.find(item => item.candidateId === 'outer-a')?.topValues).toHaveLength(3)
    expect(first.trace.find(item => item.candidateId === 'outer-b')?.topValues).toHaveLength(1)
    expect(zeroStageDecisionTraceHash(second)).toBe(zeroStageDecisionTraceHash(first))
  })

  it('prefers removing an immediate public core threat over a superficially neutral action', () => {
    const state = combatState() as any
    state.pieces[0].currentHp = 5
    state.pieces[1].x = 2
    state.pieces[1].attack = 10
    const safe = candidate('safe', 'fixture-safe')
    const risky = candidate('risky', 'fixture-risky')
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      listLegalActions: () => [risky, safe],
      simulate: (current, input) => {
        const selected = 'action' in input ? input : candidate('raw', input.type)
        const next = structuredClone(current) as any
        if (selected.id === 'safe') next.pieces.find((piece: any) => piece.instanceId === 'red-core').currentHp = 25
        return accepted(next, selected)
      },
    }
    const potentialEnvironment: AIPotentialEnvironment = {
      protocolVersion: 1,
      listPotentialActions: () => [],
      simulatePotential: () => { throw new Error('no potential candidate should be simulated') },
    }

    const decision = planZeroStageAction(state, 'player-red', ROOT_SEED, { environment, potentialEnvironment })
    expect(decision.nextAction?.id).toBe('safe')
    expect(decision.trace.find(item => item.candidateId === 'safe')?.staticValue)
      .toBeGreaterThan(decision.trace.find(item => item.candidateId === 'risky')?.staticValue ?? Number.NEGATIVE_INFINITY)
  })

  it('reserves deterministic node budget for every legal outer action and traces cropped follow-ups', () => {
    const state = combatState()
    const first = candidate('first', 'fixture-first')
    const second = candidate('second', 'fixture-second')
    const follow = potential(candidate('follow'))
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      listLegalActions: () => [first, second],
      simulate: (current, input) => accepted(structuredClone(current), 'action' in input ? input : first),
    }
    const potentialEnvironment: AIPotentialEnvironment = {
      protocolVersion: 1,
      listPotentialActions: () => [follow],
      simulatePotential: () => { throw new Error('reserved outer budget must crop this follow-up') },
    }

    const decision = planZeroStageAction(state, 'player-red', ROOT_SEED, {
      environment,
      potentialEnvironment,
      config: { nodeBudget: 2 },
    })
    expect(decision.nodesVisited).toBe(2)
    expect(decision.budgetExhausted).toBe(true)
    expect(decision.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({
        followUps: [expect.objectContaining({ candidateId: 'follow', pruned: 'node-budget' })],
      }),
    ]))
  })

  it('returns explicit terminal and no-action outcomes without inventing a fallback', () => {
    const terminal = combatState() as any
    terminal.terminalResult = {
      status: 'finished', winnerPlayerId: 'player-red', loserPlayerId: 'player-blue',
      reason: 'core-eliminated', settledAt: {
        actionIndex: 0, actionType: 'endTurn', actorPlayerId: null,
        turnNumber: 1, phase: 'end', completedRound: 0,
      },
    }
    expect(planZeroStageAction(terminal, 'player-red', ROOT_SEED)).toMatchObject({
      nextAction: undefined, stopReason: 'terminal',
    })

    const environment: AIEnvironment = { ...aiEnvironmentV1, listLegalActions: () => [] }
    expect(planZeroStageAction(combatState(), 'player-red', ROOT_SEED, { environment })).toMatchObject({
      nextAction: undefined, stopReason: 'no-legal-actions',
    })
  })

  it('records a fixed-seed, both-seat, multi-roster legality and decision-time baseline', () => {
    const attack = skill('basic-attack')
    const durations: number[] = []
    let nodes = 0
    let candidates = 0
    let illegalActions = 0
    const samples = 24

    for (let index = 0; index < samples; index += 1) {
      const rosterSize = 3 + (index % 3)
      const activePlayerId = index % 2 === 0 ? 'player-red' : 'player-blue'
      const pieces = []
      for (let slot = 0; slot < rosterSize; slot += 1) {
        pieces.push(makePiece({
          instanceId: `red-${slot}`, ownerPlayerId: 'player-red', faction: 'red',
          x: 0, y: slot, moveRange: 0,
        }))
        pieces.push(makePiece({
          instanceId: `blue-${slot}`, ownerPlayerId: 'player-blue', faction: 'blue',
          x: 1, y: slot, moveRange: 0,
        }))
      }
      const state = makeState({ pieces, currentPlayerId: activePlayerId }) as any
      state.skillsById[attack.id] = attack
      for (const piece of state.pieces) {
        piece.skills = [{ skillId: attack.id, currentCooldown: 0, usesRemaining: -1 }]
        piece.isCore = piece.instanceId.endsWith('-0')
      }
      const activePlayer = state.players.find((player: any) => player.playerId === activePlayerId)
      activePlayer.actionPoints = 1
      activePlayer.maxActionPoints = 1
      const sampleSeed = ROOT_SEED + index

      const started = performance.now()
      const decision = planZeroStageAction(state, activePlayerId, sampleSeed)
      durations.push(performance.now() - started)
      nodes += decision.nodesVisited
      candidates += decision.candidatesConsidered
      expect(decision.budgetExhausted, `seed ${sampleSeed}`).toBe(false)
      const repeated = planZeroStageAction(state, activePlayerId, sampleSeed)
      expect(zeroStageDecisionTraceHash(repeated), `seed ${sampleSeed}`).toBe(zeroStageDecisionTraceHash(decision))
      const legalIds = aiEnvironmentV1.listLegalActions(state, activePlayerId).map(item => item.id)
      expect(legalIds, `seed ${sampleSeed}`).toContain(decision.nextAction?.id)
      const result = aiEnvironmentV1.simulate(state, decision.nextAction!, { rootSeed: sampleSeed })
      const repeatedTransition = aiEnvironmentV1.simulate(state, decision.nextAction!, { rootSeed: sampleSeed })
      expect(repeatedTransition.transitionHash, `seed ${sampleSeed}`).toBe(result.transitionHash)
      illegalActions += Number(!result.accepted)
    }

    const sorted = [...durations].sort((left, right) => left - right)
    const percentile = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]
    const p50 = percentile(0.5)
    const p95 = percentile(0.95)
    console.info(
      `[RED-122 performance] samples=${samples} seats=2 roster=3-5 illegal=${illegalActions} `
      + `nodes=${nodes} candidates=${candidates} p50Ms=${p50.toFixed(2)} p95Ms=${p95.toFixed(2)}`,
    )
    expect(illegalActions).toBe(0)
    expect(p95).toBeLessThan(5_000)
  }, 120_000)
})
