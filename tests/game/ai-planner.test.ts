/* eslint-disable @typescript-eslint/no-explicit-any -- isolated serialized battle and environment fixtures. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { generateBotActions } from '@/lib/game/ai'
import { evaluateAiTransition } from '@/lib/game/ai-evaluator'
import { aiEnvironmentV1 } from '@/lib/game/ai-environment'
import { aiPlanTraceHash, planAiTurn, planNextAiAction } from '@/lib/game/ai-planner'
import { DEFAULT_AI_PLANNER_CONFIG } from '@/lib/game/ai-profiles'
import { hashStable } from '@/lib/game/battle-trace'
import type { AIEnvironment, AiTurnGoal, AiTurnPlan, CandidateAction, TransitionResult } from '@/lib/game/ai-types'
import type { BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const seed = 8675309

function candidate(
  id: string,
  type: string,
  pieceId = 'red-a',
  kind: CandidateAction['kind'] = type === 'endTurn' ? 'end-turn' : 'basic-skill',
  extra: Record<string, unknown> = {},
): CandidateAction {
  return {
    protocolVersion: 1,
    id,
    kind,
    action: type === 'endTurn'
      ? { type, playerId: 'player-red', ...extra } as any
      : { type, playerId: 'player-red', pieceId, ...extra } as any,
  }
}

function accepted(state: BattleState, action: CandidateAction): TransitionResult {
  return {
    protocolVersion: 1,
    accepted: true,
    state,
    stateHash: hashStable(state),
    transitionHash: hashStable({ state, action }),
    trace: { actionLog: [], stateChanges: [] },
  }
}

function rejected(state: BattleState, action: CandidateAction, code: string): TransitionResult {
  return {
    protocolVersion: 1,
    accepted: false,
    state,
    stateHash: hashStable(state),
    transitionHash: hashStable({ state, action, code }),
    error: { code, name: 'FixtureRejection', message: code },
    trace: { actionLog: [], stateChanges: [] },
  }
}

function baseEnvironment(overrides: Partial<AIEnvironment>): AIEnvironment {
  return {
    protocolVersion: 1,
    capabilities: { protocolVersion: 1, supportedActionTypes: [] as never, unsupportedActionTypes: [] },
    observe: () => ({} as never),
    isTerminal: state => state.terminalResult !== undefined,
    stateKey: state => hashStable({
      stage: (state as any).stage ?? 0,
      phase: state.turn.phase,
      currentPlayerId: state.turn.currentPlayerId,
      pieces: state.pieces.map(piece => ({ id: piece.instanceId, hp: piece.currentHp, x: piece.x, y: piece.y })),
      fixtureRevision: (state as any).fixtureRevision,
    }),
    listLegalActions: () => [],
    simulate: (state, input) => accepted(structuredClone(state), 'action' in input ? input : candidate('fixture', input.type)),
    ...overrides,
  }
}

/** Deterministic authority fixture: every stage requires a different roster member for one shared objective. */
function stagedEnvironment(actors = ['red-a', 'red-b', 'red-c']): AIEnvironment {
  return baseEnvironment({
    listLegalActions: state => {
      const stage = (state as any).stage ?? 0
      if (stage >= actors.length) return [candidate('end', 'endTurn')]
      return [
        candidate(`act-${stage}`, `action-${stage}`, actors[stage]),
        candidate('end', 'endTurn'),
      ]
    },
    simulate: (state, input) => {
      const action = 'action' in input ? input : candidate('fixture', input.type)
      const command = action.action as any
      const stage = (state as any).stage ?? 0
      if (command.type === 'endTurn') {
        const next = structuredClone(state)
        next.turn.phase = 'end'
        return accepted(next, action)
      }
      if (command.type !== `action-${stage}` || command.pieceId !== actors[stage]) {
        return rejected(state, action, 'FIXTURE_ILLEGAL_ACTION')
      }
      const next = structuredClone(state) as any
      next.stage = stage + 1
      next.pieces.find((piece: any) => piece.ownerPlayerId === 'player-blue').currentHp -= 5
      return accepted(next, action)
    },
  })
}

function fixtureState(rosterSize = 3): BattleState {
  const allies = Array.from({ length: rosterSize }, (_, index) => makePiece({
    instanceId: `red-${String.fromCharCode(97 + index)}`,
    ownerPlayerId: 'player-red',
    x: index,
    y: 1,
  }))
  return makeState({ pieces: [
    ...allies,
    makePiece({ instanceId: 'blue-target', ownerPlayerId: 'player-blue', x: 5, y: 1, currentHp: 100 }),
  ] }) as any
}

function skill(id: string, code?: string) {
  if (!code) return JSON.parse(readFileSync(resolve(process.cwd(), `data/skills/${id}.json`), 'utf8'))
  return {
    id,
    name: id,
    description: id,
    kind: 'active',
    type: 'normal',
    cooldownTurns: 1,
    maxCharges: 0,
    powerMultiplier: 1,
    actionPointCost: 1,
    requiresTarget: true,
    code,
  }
}

function stateWithSkills(options: {
  pieces: any[]
  skills: Array<{ pieceId: string; definition: any }>
  actionPoints?: number
}): BattleState {
  const state = makeState({ pieces: options.pieces }) as any
  state.players[0].actionPoints = options.actionPoints ?? 4
  state.players[0].maxActionPoints = options.actionPoints ?? 4
  for (const entry of options.skills) {
    state.skillsById[entry.definition.id] = entry.definition
    state.pieces.find((piece: any) => piece.instanceId === entry.pieceId).skills.push({
      skillId: entry.definition.id,
      currentCooldown: 0,
      usesRemaining: -1,
    })
  }
  return state
}

function replayActions(
  initialState: BattleState,
  actions: Array<CandidateAction | CandidateAction['action']>,
  rootSeed: number,
): { complete: boolean; illegalActions: number } {
  let state = structuredClone(initialState)
  let illegalActions = 0
  const initialPlayerId = state.turn.currentPlayerId

  for (const action of actions) {
    const result = aiEnvironmentV1.simulate(state, action as any, { rootSeed })
    if (!result.accepted) {
      illegalActions += 1
      break
    }
    state = result.state
  }

  return {
    complete: aiEnvironmentV1.isTerminal(state)
      || state.turn.phase === 'end'
      || state.turn.currentPlayerId !== initialPlayerId,
    illegalActions,
  }
}

function runPlannerAuthorityTurn(
  initialState: BattleState,
  rootSeed: number,
  config: any,
): { complete: boolean; illegalActions: number; decisionNodes: number } {
  let state = structuredClone(initialState)
  let previous: AiTurnPlan | undefined
  let illegalActions = 0
  let decisionNodes = 0
  const initialPlayerId = state.turn.currentPlayerId

  for (let guard = 0; guard <= config.maxActions; guard += 1) {
    const plan = previous
      ? planNextAiAction(state, 'player-red', rootSeed, previous, { config })
      : planAiTurn(state, 'player-red', rootSeed, { config })
    decisionNodes += plan.nodesVisited
    if (!plan.nextAction) break
    const result = aiEnvironmentV1.simulate(state, plan.nextAction, { rootSeed })
    if (!result.accepted) {
      illegalActions += 1
      break
    }
    state = result.state
    if (
      aiEnvironmentV1.isTerminal(state)
      || state.turn.phase === 'end'
      || state.turn.currentPlayerId !== initialPlayerId
    ) {
      return { complete: true, illegalActions, decisionNodes }
    }
    previous = plan
  }

  return { complete: false, illegalActions, decisionNodes }
}

describe('roster-independent multi-action AI turn planner', () => {
  it('plans a complete three-step shared goal across multiple pieces and exposes only its first action', () => {
    const state = fixtureState()
    const first = planAiTurn(state, 'player-red', seed, {
      environment: stagedEnvironment(),
      config: { nodeBudget: 16, maxActions: 5, candidateLimit: 4 },
    })
    const second = planAiTurn(state, 'player-red', seed, {
      environment: stagedEnvironment(),
      config: { nodeBudget: 16, maxActions: 5, candidateLimit: 4 },
    })

    expect(first.goal).toMatchObject({ kind: 'reposition', targetId: 'blue-target' })
    expect(first.actions.map(item => (item.action as any).pieceId)).toEqual(['red-a', 'red-b', 'red-c', undefined])
    expect(first.actions.map(item => item.action.type)).toEqual(['action-0', 'action-1', 'action-2', 'endTurn'])
    expect(first.nextAction).toEqual(first.actions[0])
    expect(first.stopReason).toBe('completed-turn')
    expect(aiPlanTraceHash(second)).toBe(aiPlanTraceHash(first))
  })

  it('replans from the authoritative state, preserves a valid goal, and never returns a queued stale action', () => {
    const environment = stagedEnvironment()
    const initial = fixtureState()
    const oldPlan = planAiTurn(initial, 'player-red', seed, { environment })
    const authoritative = environment.simulate(initial, oldPlan.nextAction!, { rootSeed: seed })
    expect(authoritative.accepted).toBe(true)
    if (!authoritative.accepted) throw new Error('fixture transition must be accepted')

    const replanned = planNextAiAction(authoritative.state, 'player-red', seed, oldPlan, { environment })
    expect(replanned.goal).toEqual(oldPlan.goal)
    expect(replanned.goalChanged).toBe(false)
    expect(replanned.nextAction?.action.type).toBe('action-1')
    expect(replanned.nextAction).not.toEqual(oldPlan.nextAction)
  })

  it('switches goals only after the previous target becomes invalid', () => {
    const state = fixtureState()
    state.pieces.push(makePiece({
      instanceId: 'blue-second', ownerPlayerId: 'player-blue', x: 4, y: 4, currentHp: 80,
    }) as any)
    const previous: AiTurnGoal = { kind: 'eliminate', targetId: 'blue-target', rationale: 'fixture' }
    state.pieces.find(piece => piece.instanceId === 'blue-target')!.currentHp = 0

    const plan = planAiTurn(state, 'player-red', seed, { environment: stagedEnvironment(), previousGoal: previous })
    expect(plan.goal.targetId).toBe('blue-second')
    expect(plan.goalChanged).toBe(true)
  })

  it('uses stable state dominance and deterministic tie-breaking', () => {
    const environment = baseEnvironment({
      listLegalActions: state => (state as any).stage
        ? [candidate('end', 'endTurn')]
        : [candidate('same-b', 'same-b'), candidate('same-a', 'same-a'), candidate('end', 'endTurn')],
      simulate: (state, input) => {
        const action = 'action' in input ? input : candidate('fixture', input.type)
        const next = structuredClone(state) as any
        if (action.kind === 'end-turn') next.turn.phase = 'end'
        else {
          next.stage = 1
          next.pieces.find((piece: any) => piece.instanceId === 'blue-target').currentHp -= 5
        }
        return accepted(next, action)
      },
    })
    const plan = planAiTurn(fixtureState(), 'player-red', seed, { environment })

    expect(plan.nextAction?.id).toBe('same-a')
    expect(plan.stateDuplicates).toBe(1)
    expect(plan.trace.some(entry => entry.candidateId === 'same-b' && entry.pruned === 'dominated-state')).toBe(true)
  })

  it('ends safely on zero-progress and non-positive actions without looping', () => {
    const environment = baseEnvironment({
      listLegalActions: () => [candidate('loop', 'zero-cost-loop'), candidate('noise', 'noise'), candidate('end', 'endTurn')],
      simulate: (state, input) => {
        const action = 'action' in input ? input : candidate('fixture', input.type)
        const next = structuredClone(state) as any
        if (action.id === 'noise') next.fixtureRevision = ((next.fixtureRevision ?? 0) + 1)
        if (action.kind === 'end-turn') next.turn.phase = 'end'
        return accepted(next, action)
      },
    })
    const plan = planAiTurn(fixtureState(), 'player-red', seed, {
      environment,
      config: { nodeBudget: 12, maxActions: 8 },
    })

    expect(plan.actions.map(item => item.kind)).toEqual(['end-turn'])
    expect(plan.nodesVisited).toBeLessThanOrEqual(12)
    expect(plan.trace.some(entry => entry.candidateId === 'loop' && entry.pruned === 'duplicate-state')).toBe(true)
    expect(plan.trace.some(entry => entry.candidateId === 'noise' && entry.pruned === 'non-positive-action')).toBe(true)
  })

  it('carries state history across authoritative replans and ends instead of cycling', () => {
    const environment = baseEnvironment({
      stateKey: state => String((state as any).fixtureRevision ?? 0),
      listLegalActions: () => [
        candidate('toggle', 'fixture-toggle', 'red-a', 'phase-advance'),
        candidate('end', 'endTurn'),
      ],
      simulate: (state, input) => {
        const action = 'action' in input ? input : candidate('fixture', input.type)
        const next = structuredClone(state) as any
        if (action.kind === 'end-turn') next.turn.phase = 'end'
        else {
          next.fixtureRevision = next.fixtureRevision === 1 ? 0 : 1
          next.pieces.find((piece: any) => piece.instanceId === 'blue-target').currentHp -= 5
        }
        return accepted(next, action)
      },
    })
    const initial = fixtureState() as any
    initial.fixtureRevision = 0
    const first = planAiTurn(initial, 'player-red', seed, {
      environment, config: { maxActions: 4, nodeBudget: 12 },
    })
    expect(first.nextAction?.id).toBe('toggle')
    const authoritative = environment.simulate(initial, first.nextAction!, { rootSeed: seed })
    expect(authoritative.accepted).toBe(true)
    if (!authoritative.accepted) throw new Error('fixture transition must be accepted')

    const second = planNextAiAction(authoritative.state, 'player-red', seed, first, { environment })
    expect(second.nextAction?.kind).toBe('end-turn')
    expect(second.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: 'toggle', pruned: 'dominated-state' }),
    ]))
  })

  it('forces authoritative endTurn when the cross-replan action limit is reached', () => {
    const environment = baseEnvironment({
      stateKey: state => String((state as any).fixtureRevision ?? 0),
      listLegalActions: () => [
        candidate('progress', 'fixture-progress', 'red-a', 'move'),
        candidate('end', 'endTurn'),
      ],
      simulate: (state, input) => {
        const action = 'action' in input ? input : candidate('fixture', input.type)
        const next = structuredClone(state) as any
        if (action.kind === 'end-turn') next.turn.phase = 'end'
        else {
          next.fixtureRevision = (next.fixtureRevision ?? 0) + 1
          next.pieces.find((piece: any) => piece.instanceId === 'blue-target').currentHp -= 5
        }
        return accepted(next, action)
      },
    })
    let state = fixtureState() as any
    state.fixtureRevision = 0
    let plan = planAiTurn(state, 'player-red', seed, {
      environment, config: { maxActions: 3, nodeBudget: 12 },
    })
    for (let index = 0; index < 2; index += 1) {
      expect(plan.nextAction?.id).toBe('progress')
      const result = environment.simulate(state, plan.nextAction!, { rootSeed: seed })
      expect(result.accepted).toBe(true)
      if (!result.accepted) throw new Error('fixture transition must be accepted')
      state = result.state
      plan = planNextAiAction(state, 'player-red', seed, plan, { environment, config: { maxActions: 3 } })
    }

    expect(plan.nextAction?.kind).toBe('end-turn')
    expect(plan.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: 'progress', pruned: 'turn-safety-limit', pruneDetail: 'max-actions-reached' }),
    ]))
  })

  it('returns explicit terminal/no-action results instead of throwing', () => {
    const terminal = fixtureState() as any
    terminal.terminalResult = { winnerPlayerId: 'player-red', reason: 'fixture' }
    const terminalPlan = planAiTurn(terminal, 'player-red', seed, { environment: baseEnvironment({}) })
    expect(terminalPlan).toMatchObject({ actions: [], nextAction: undefined, stopReason: 'terminal' })

    const noActions = planAiTurn(fixtureState(), 'player-red', seed, {
      environment: baseEnvironment({ listLegalActions: () => [] }),
    })
    expect(noActions).toMatchObject({ actions: [], nextAction: undefined, stopReason: 'no-legal-actions' })
  })

  it('records rejected, unsupported, metadata-required, and candidate-limit evidence', () => {
    const manyMoves = Array.from({ length: 6 }, (_, index) => candidate(
      `move-${index}`,
      'move',
      'red-a',
      'move',
      { toX: index, toY: 0 },
    ))
    const environment = baseEnvironment({
      listLegalActions: () => [
        candidate('unsupported', 'useBasicSkill', 'red-a', 'basic-skill', { skillId: 'evil-explosion' }),
        candidate('unknown', 'useBasicSkill', 'red-a', 'basic-skill', { skillId: 'not-in-semantic-manifest' }),
        candidate('metadata', 'useBasicSkill', 'red-a', 'basic-skill', { skillId: 'naruto-shadow-clone' }),
        candidate('rejected', 'fixture-rejected'),
        ...manyMoves,
        candidate('end', 'endTurn'),
      ],
      simulate: (state, input) => {
        const action = 'action' in input ? input : candidate('fixture', input.type)
        if (['unsupported', 'unknown', 'metadata'].includes(action.id)) throw new Error('semantic fallback must not simulate')
        if (action.id === 'rejected') return rejected(state, action, 'FIXTURE_REJECTED')
        const next = structuredClone(state)
        if (action.kind === 'end-turn') next.turn.phase = 'end'
        return accepted(next, action)
      },
    })
    const plan = planAiTurn(fixtureState(), 'player-red', seed, {
      environment,
      config: { candidateLimit: 2, nodeBudget: 8, maxActions: 2 },
    })

    expect(plan.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: 'unsupported', pruned: 'unsupported' }),
      expect.objectContaining({
        candidateId: 'unknown', pruned: 'unsupported',
        pruneDetail: expect.stringContaining('unknown-skills-content'),
      }),
      expect.objectContaining({ candidateId: 'metadata', pruned: 'metadata-required' }),
      expect.objectContaining({ candidateId: 'rejected', rejected: 'FIXTURE_REJECTED' }),
      expect.objectContaining({ pruned: 'candidate-limit', pruneDetail: expect.stringContaining('rank=') }),
    ]))
  })

  it('records legality, completion, and decision-node baselines against the retained simple AI', () => {
    const baseline = {
      samples: 24,
      legacy: { completedTurns: 0, illegalActions: 0, decisionNodes: null as null },
      planner: { completedTurns: 0, illegalActions: 0, decisionNodes: 0 },
    }

    for (let index = 0; index < baseline.samples; index += 1) {
      const state = fixtureState(3 + (index % 3))
      state.players[0].actionPoints = 1
      state.players[0].maxActionPoints = 1
      const sampleSeed = seed + index
      const legacyReplay = replayActions(state, generateBotActions(state, 'player-red'), sampleSeed)
      const plannerReplay = runPlannerAuthorityTurn(
        state, sampleSeed, { nodeBudget: 8, maxActions: 2, beamWidth: 1, candidateLimit: 2 },
      )

      baseline.legacy.completedTurns += Number(legacyReplay.complete)
      baseline.legacy.illegalActions += legacyReplay.illegalActions
      baseline.planner.completedTurns += Number(plannerReplay.complete)
      baseline.planner.illegalActions += plannerReplay.illegalActions
      baseline.planner.decisionNodes += plannerReplay.decisionNodes
    }

    expect(baseline.legacy).toEqual({ completedTurns: 24, illegalActions: 0, decisionNodes: null })
    expect(baseline.planner.completedTurns).toBe(24)
    expect(baseline.planner.illegalActions).toBe(0)
    expect(baseline.planner.decisionNodes).toBeGreaterThanOrEqual(24)
    expect(baseline.planner.decisionNodes).toBeLessThanOrEqual(24 * 8)
  }, 60_000)

  it('completes 200 fixed-seed multi-roster full-turn samples within budgets with zero illegal actions', () => {
    let illegalActions = 0
    for (let index = 0; index < 200; index += 1) {
      const rosterSize = 3 + (index % 3)
      const state = fixtureState(rosterSize)
      state.players[0].actionPoints = index % 4 === 0 ? 1 : 0
      state.players[0].maxActionPoints = state.players[0].actionPoints
      const sampleSeed = seed + index
      const replay = runPlannerAuthorityTurn(
        state, sampleSeed, { nodeBudget: 4, maxActions: 2, beamWidth: 1, candidateLimit: 1 },
      )

      illegalActions += replay.illegalActions
      expect(replay.illegalActions, `seed ${sampleSeed}`).toBe(0)
      expect(replay.complete, `seed ${sampleSeed}`).toBe(true)
      expect(replay.decisionNodes, `seed ${sampleSeed}`).toBeLessThanOrEqual(8)
    }
    expect(illegalActions).toBe(0)
  }, 120_000)
})

describe('representative real transition fixtures', () => {
  it('focuses one goal with three registered actors across authoritative replans', () => {
    const fireball = skill('fireball')
    const attackers = [
      makePiece({ instanceId: 'caster-a', ownerPlayerId: 'player-red', x: 0, y: 0, attack: 10 }),
      makePiece({ instanceId: 'caster-b', ownerPlayerId: 'player-red', x: 0, y: 1, attack: 10 }),
      makePiece({ instanceId: 'caster-c', ownerPlayerId: 'player-red', x: 0, y: 2, attack: 10 }),
    ] as any[]
    const focus = makePiece({ instanceId: 'focus', ownerPlayerId: 'player-blue', x: 3, y: 1, currentHp: 40 }) as any
    const reserve = makePiece({ instanceId: 'reserve', ownerPlayerId: 'player-blue', x: 5, y: 4, currentHp: 100 }) as any
    let state = stateWithSkills({
      pieces: [...attackers, focus, reserve],
      skills: attackers.map(piece => ({ pieceId: piece.instanceId, definition: fireball })),
      actionPoints: 6,
    })
    let previous: AiTurnPlan | undefined
    const actors: string[] = []
    const goalTargets: Array<string | undefined> = []
    let complete = false

    for (let guard = 0; guard <= DEFAULT_AI_PLANNER_CONFIG.maxActions; guard += 1) {
      const plan = previous
        ? planNextAiAction(state, 'player-red', seed, previous, {
            config: { nodeBudget: 48, beamWidth: 3, candidateLimit: 8 },
          })
        : planAiTurn(state, 'player-red', seed, {
            config: { nodeBudget: 48, beamWidth: 3, candidateLimit: 8 },
          })
      expect(plan.nextAction).toBeDefined()
      const action = plan.nextAction!.action as any
      if (action.type === 'useBasicSkill' && action.targetPieceId === 'focus') {
        actors.push(action.pieceId)
        goalTargets.push(plan.goal.targetId)
      }
      const result = aiEnvironmentV1.simulate(state, plan.nextAction!, { rootSeed: seed })
      expect(result.accepted).toBe(true)
      if (!result.accepted) throw new Error('formal focus-fire transition must be accepted')
      state = result.state
      previous = plan
      complete = aiEnvironmentV1.isTerminal(state)
        || state.turn.phase === 'end'
        || state.turn.currentPlayerId !== 'player-red'
      if (complete) break
    }

    expect(actors.slice(0, 3)).toHaveLength(3)
    expect(new Set(actors.slice(0, 3)).size).toBe(3)
    expect(goalTargets.slice(0, 3)).toEqual(['focus', 'focus', 'focus'])
    expect(state.pieces.find(piece => piece.instanceId === 'focus')).toBeUndefined()
    expect(complete).toBe(true)
  }, 60_000)

  it('selects simple lethal damage and wounded-ally healing through the formal environment', () => {
    const attack = skill('ashbringer')
    const attacker = makePiece({ instanceId: 'attacker', ownerPlayerId: 'player-red', x: 1, y: 1, attack: 10 }) as any
    const target = makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', x: 2, y: 1, currentHp: 5 }) as any
    const damageState = stateWithSkills({ pieces: [attacker, target], skills: [{ pieceId: 'attacker', definition: attack }] })
    const damagePlan = planAiTurn(damageState, 'player-red', seed)
    expect(damagePlan.nextAction?.action).toMatchObject({
      type: 'useBasicSkill', pieceId: 'attacker', skillId: 'ashbringer', targetPieceId: 'target',
    })

    const heal = skill('light-of-the-light')
    const healer = makePiece({ instanceId: 'healer', ownerPlayerId: 'player-red', x: 1, y: 1 }) as any
    const wounded = makePiece({ instanceId: 'wounded', ownerPlayerId: 'player-red', x: 2, y: 1, currentHp: 20 }) as any
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 5, y: 4, currentHp: 100 }) as any
    const healState = stateWithSkills({ pieces: [healer, wounded, enemy], skills: [{ pieceId: 'healer', definition: heal }] })
    const healPlan = planAiTurn(healState, 'player-red', seed)
    expect(healPlan.goal).toMatchObject({ kind: 'protect', targetId: 'wounded' })
    expect(healPlan.actions.some(item => (
      item.action.type === 'useBasicSkill'
      && item.action.pieceId === 'healer'
      && item.action.skillId === 'light-of-the-light'
      && item.action.targetPieceId === 'wounded'
    ))).toBe(true)
  }, 30_000)

  it('plans movement before casting and retreats a critically injured piece from danger', () => {
    const attack = skill('ashbringer')
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 1, y: 1, attack: 10, moveRange: 1 }) as any
    const target = makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', x: 3, y: 1, currentHp: 5 }) as any
    const state = stateWithSkills({ pieces: [caster, target], skills: [{ pieceId: 'caster', definition: attack }] })
    const plan = planAiTurn(state, 'player-red', seed, { config: { nodeBudget: 64, maxActions: 4 } })
    expect(plan.actions.slice(0, 2).map(item => item.action.type)).toEqual(['move', 'useBasicSkill'])
    expect(plan.actions[1].action).toMatchObject({ targetPieceId: 'target' })

    const injured = makePiece({
      instanceId: 'injured', ownerPlayerId: 'player-red', x: 1, y: 1, currentHp: 10, moveRange: 1,
    }) as any
    const threat = makePiece({ instanceId: 'threat', ownerPlayerId: 'player-blue', x: 2, y: 1, attack: 30 }) as any
    const retreatState = makeState({ pieces: [injured, threat] }) as any
    const retreatPlan = planAiTurn(retreatState, 'player-red', seed)
    expect(retreatPlan.goal).toMatchObject({ kind: 'protect', targetId: 'injured' })
    expect(retreatPlan.nextAction?.kind).toBe('move')
    const move = retreatPlan.nextAction?.action as Extract<CandidateAction['action'], { type: 'move' }>
    expect(Math.abs(move.toX - threat.x!) + Math.abs(move.toY - threat.y!)).toBeGreaterThan(1)
  })

  it('scores control, cleanse, summon, and transform generically without roster-ID branches', () => {
    const controller = makePiece({ instanceId: 'controller', ownerPlayerId: 'player-red', x: 1, y: 1, attack: 5 }) as any
    const threat = makePiece({ instanceId: 'threat', ownerPlayerId: 'player-blue', x: 3, y: 1, currentHp: 100, attack: 30 }) as any
    const afflicted = makePiece({ instanceId: 'afflicted', ownerPlayerId: 'player-red', x: 2, y: 1 }) as any
    afflicted.statusTags = [{ id: 'fixture-debuff', type: 'control', visible: true }]
    const before = makeState({ pieces: [controller, afflicted, threat] }) as any

    const controlled = structuredClone(before) as any
    controlled.pieces.find((piece: any) => piece.instanceId === 'threat').statusTags.push({
      id: 'visible-control', type: 'control', visible: true,
    })
    const controlGoal: AiTurnGoal = { kind: 'control', targetId: 'threat', rationale: 'fixture' }
    const controlScore = evaluateAiTransition(before, controlled, 'player-red', controlGoal, DEFAULT_AI_PLANNER_CONFIG)
    expect(controlScore.components.enemyStatusAdded).toBeGreaterThan(0)

    const cleansed = structuredClone(before) as any
    cleansed.pieces.find((piece: any) => piece.instanceId === 'afflicted').statusTags = []
    const protectGoal: AiTurnGoal = { kind: 'protect', targetId: 'afflicted', rationale: 'fixture' }
    const cleanseScore = evaluateAiTransition(before, cleansed, 'player-red', protectGoal, DEFAULT_AI_PLANNER_CONFIG)
    expect(cleanseScore.components.ownStatusRemoved).toBeGreaterThan(0)

    const summoned = structuredClone(before) as any
    summoned.pieces.push(makePiece({ instanceId: 'summon', ownerPlayerId: 'player-red', x: 0, y: 0 }))
    const summonScore = evaluateAiTransition(before, summoned, 'player-red', controlGoal, DEFAULT_AI_PLANNER_CONFIG)
    expect(summonScore.components.ownSummoned).toBeGreaterThan(0)

    const transformed = structuredClone(before) as any
    transformed.pieces[0].templateId = 'transformed-template'
    transformed.pieces[0].attack += 5
    const transformScore = evaluateAiTransition(before, transformed, 'player-red', controlGoal, DEFAULT_AI_PLANNER_CONFIG)
    expect(transformScore.components.ownTransformed).toBeGreaterThan(0)

    const summonSkill = skill('naruto-shadow-clone')
    const transformSkill = skill('illidan-metamorphosis')
    const complexState = stateWithSkills({
      pieces: [controller, afflicted, threat],
      skills: [
        { pieceId: 'controller', definition: summonSkill },
        { pieceId: 'afflicted', definition: transformSkill },
      ],
    }) as any
    complexState.players[0].chargePoints = 3
    const complexPlan = planAiTurn(complexState, 'player-red', seed, {
      config: { nodeBudget: 12, candidateLimit: 4, beamWidth: 1, maxActions: 2 },
    })
    expect(complexPlan.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ contentId: 'naruto-shadow-clone', pruned: 'metadata-required' }),
      expect.objectContaining({ contentId: 'illidan-metamorphosis', pruned: 'metadata-required' }),
    ]))
  }, 30_000)
})
