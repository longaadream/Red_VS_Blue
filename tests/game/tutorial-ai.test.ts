/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures exercise the serialized battle contract. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { loadMaps } from '@/config/maps'
import { planBotActions } from '@/lib/game/ai'
import { listLegalAIActions } from '@/lib/game/ai-environment'
import { createInitialBattleForPlayers } from '@/lib/game/battle-setup'
import { runBattleAction } from '@/lib/game/battle-runner'
import { getPieceById } from '@/lib/game/piece-repository'
import { planTutorialAiAction } from '@/lib/game/tutorial-ai'
import { hashStable } from '@/lib/game/battle-trace'
import { practiceEnvironment } from '@/lib/practice/environment'
import { evaluateZeroStageState } from '@/lib/practice/evaluator'
import { makePiece, makeState } from '../helpers/minimal-state'

const ROOT_SEED = 0x228a11
const FIXED_NOW = () => 0
const SEARCH_CONFIG = {
  depth: 3,
  beamWidth: 6,
  rootCandidates: 24,
  childCandidates: 10,
  nodesPerDecision: 128,
  deploymentNodesPerDecision: 384,
  nodesPerTurn: 896,
  maxActionsPerTurn: 24,
  turnTimeMs: 0,
  decisionTimeMs: 0,
  deploymentTimeMs: 0,
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  await loadMaps()
})

function loadJson(relativePath: string): any {
  return JSON.parse(readFileSync(resolve(process.cwd(), relativePath), 'utf8'))
}

function skillState(skillId: string) {
  return { skillId, currentCooldown: 0, usesRemaining: -1 }
}

function card(cardId: string, instanceId: string) {
  return { ...loadJson(`data/cards/${cardId}.json`), cardId, instanceId, ownerPlayerId: 'player-red' }
}

function fixture(options: {
  actionPoints?: number
  chargePoints?: number
  casterX?: number
  casterY?: number
  casterAttack?: number
  casterMoveRange?: number
  casterTemplateId?: string
  casterSkills?: string[]
  targetX?: number
  targetY?: number
  targetHp?: number
  targetMaxHp?: number
  targetShield?: number
  hand?: any[]
  opponentHand?: any[]
  opponentHiddenStatus?: any[]
  progressiveDeployment?: boolean
  fallbackDeployment?: boolean
} = {}) {
  const caster = makePiece({
    instanceId: 'red-caster',
    templateId: options.casterTemplateId ?? 'jaina',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: options.casterX ?? 0,
    y: options.casterY ?? 0,
    moveRange: options.casterMoveRange ?? 0,
    attack: options.casterAttack ?? 4,
    maxHp: 12,
    currentHp: 12,
    skills: (options.casterSkills ?? ['fireball']).map(skillState),
  }) as any
  caster.isCore = true

  const target = makePiece({
    instanceId: 'blue-target',
    templateId: 'target',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: options.targetX ?? 2,
    y: options.targetY ?? 0,
    currentHp: options.targetHp ?? 12,
    maxHp: options.targetMaxHp ?? 12,
    attack: 4,
    actionPoints: 0,
    maxActionPoints: 0,
    statusTags: options.opponentHiddenStatus ?? [],
  }) as any
  target.isCore = true
  if (options.targetShield !== undefined) target.shield = options.targetShield

  const state = makeState({
    pieces: [caster, target],
    width: options.progressiveDeployment ? 3 : 8,
    height: options.progressiveDeployment ? 1 : 3,
    currentPlayerId: 'player-red',
    phase: 'action',
  }) as any
  state.players[0].actionPoints = options.actionPoints ?? 2
  state.players[0].maxActionPoints = Math.max(2, options.actionPoints ?? 2)
  state.players[0].chargePoints = options.chargePoints ?? 0
  state.players[0].maxChargePoints = 10
  state.players[0].hand = options.hand ?? []
  state.players[1].hand = options.opponentHand ?? []

  for (const skillId of options.casterSkills ?? ['fireball']) {
    state.skillsById[skillId] = loadJson(`data/skills/${skillId}.json`)
  }

  if (options.progressiveDeployment) {
    const reserve = makePiece({
      instanceId: 'red-reserve',
      templateId: 'anduin',
      ownerPlayerId: 'player-red',
      faction: 'red',
      x: null as any,
      y: null as any,
    }) as any
    reserve.isCore = true
    reserve.x = null
    reserve.y = null
    const hiddenReserve = makePiece({
      instanceId: 'blue-secret-reserve',
      templateId: 'reaper',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: null as any,
      y: null as any,
    }) as any
    hiddenReserve.isCore = true
    hiddenReserve.x = null
    hiddenReserve.y = null
    state.deployment = {
      mode: 'progressive-reserve-v1',
      status: 'awaiting-reserve-deploy',
      playerIds: ['player-red', 'player-blue'],
      choices: {},
      locks: {},
      startedAt: 0,
      deadlineAt: 0,
      revision: 7,
      openingVanguardsInitialized: true,
      initialPositions: {
        'red-caster': { x: caster.x, y: caster.y },
        'blue-target': { x: target.x, y: target.y },
      },
      reserves: { 'player-red': [reserve], 'player-blue': [hiddenReserve] },
      reserveCounts: { 'player-red': 1, 'player-blue': 1 },
      activePlayerId: 'player-red',
      offerTurnNumber: state.turn.turnNumber,
      offerPieceIds: ['red-reserve'],
      legalPositions: options.fallbackDeployment ? [] : [{ x: 6, y: 2 }],
    }
  }

  return state
}

function plan(state: any, options: Record<string, unknown> = {}) {
  return planTutorialAiAction(state, 'player-red', ROOT_SEED, {
    config: SEARCH_CONFIG,
    now: FIXED_NOW,
    ...options,
  })
}

const deploy = (playerId: string, expectedDeploymentRevision: number, pieceId: string, toX?: number, toY?: number) => ({
  type: 'deployReservePiece', playerId, expectedDeploymentRevision, pieceId,
  ...(toX === undefined ? {} : { toX, toY }),
} as const)
const endTurn = (playerId: string) => ({ type: 'endTurn', playerId } as const)
const beginPhase = () => ({ type: 'beginPhase' } as const)
const basicSkill = (
  playerId: string,
  pieceId: string,
  skillId: string,
  selectionId: string,
  stateRevision: number,
  targetX: number,
  targetY: number,
) => ({ type: 'useBasicSkill', playerId, pieceId, skillId, selectionId, stateRevision, targetX, targetY } as const)

/**
 * Compact replay of the canonical RED-232 late state. The commands are the
 * public action log from seed 18707; replaying them keeps the fixture tied to
 * the real authority/profile without checking in a serialized battle blob.
 */
const CANONICAL_LATE_ACTIONS = [
  deploy('training-red', 1, 'training-red-1', 1, 10),
  endTurn('training-red'), beginPhase(),
  deploy('training-blue', 3, 'training-blue-6', 6, 7),
  basicSkill('training-blue', 'training-blue-6', 'blackwidow-lethal-toxin', 'sel-1-5-hnvo4n', 5, 3, 9),
  { type: 'move', playerId: 'training-blue', pieceId: 'training-blue-6', toX: 1, toY: 9 },
  { type: 'playCard', playerId: 'training-blue', cardInstanceId: 'ci-lucky-coin-00004913-1ufqatl-0-zqxdji' },
  { type: 'move', playerId: 'training-blue', pieceId: 'training-blue-8', toX: 15, toY: 1 },
  endTurn('training-blue'), beginPhase(),
  deploy('training-red', 5, 'training-red-2', 1, 2), endTurn('training-red'), beginPhase(),
  deploy('training-blue', 7, 'training-blue-2', 16, 8), endTurn('training-blue'), beginPhase(),
  deploy('training-red', 9, 'training-red-3', 10, 10), endTurn('training-red'), beginPhase(),
  deploy('training-blue', 11, 'training-blue-3', 12, 14),
  basicSkill('training-blue', 'training-blue-6', 'blackwidow-lethal-strike', 'sel-1-l-y56z55', 21, 1, 10),
  endTurn('training-blue'), beginPhase(),
  deploy('training-red', 13, 'training-red-5', 10, 3), endTurn('training-red'), beginPhase(),
  deploy('training-blue', 15, 'training-blue-1', 7, 7),
  basicSkill('training-blue', 'training-blue-6', 'blackwidow-lethal-strike', 'sel-1-s-1sfhlvy', 28, 1, 10),
  basicSkill('training-blue', 'training-blue-6', 'blackwidow-lethal-toxin', 'sel-1-t-vxii65', 29, 2, 10),
  endTurn('training-blue'), beginPhase(),
  deploy('training-red', 17, 'training-red-4', 17, 13), endTurn('training-red'), beginPhase(),
  deploy('training-blue', 19, 'training-blue-5', 6, 12),
  basicSkill('training-blue', 'training-blue-6', 'blackwidow-lethal-strike', 'sel-1-10-htx2tt', 36, 1, 10),
  endTurn('training-blue'), beginPhase(),
  deploy('training-red', 21, 'training-red-6', 6, 1), endTurn('training-red'), beginPhase(),
  deploy('training-blue', 23, 'training-blue-4'), endTurn('training-blue'), beginPhase(),
  deploy('training-red', 25, 'training-red-7'), endTurn('training-red'), beginPhase(),
  deploy('training-blue', 27, 'training-blue-7'), endTurn('training-blue'), beginPhase(),
  endTurn('training-red'), beginPhase(),
] as const

async function canonicalLateState() {
  const sandbox = {} as { RvBTutorialLessons?: any }
  runInNewContext(readFileSync('data/pages/js/tutorial/tutorial-lessons.js', 'utf8'), sandbox)
  const lessons = sandbox.RvBTutorialLessons!
  const lesson = lessons.get('tactical-intuition')
  let state = await lessons.createBattle({ createInitialBattleForPlayers, getPieceById }, lesson)
  for (const [index, action] of CANONICAL_LATE_ACTIONS.entries()) {
    const transition = runBattleAction(state, action, { rootSeed: lesson.rootSeed })
    if (!transition.state) throw new Error(`Canonical lesson action produced no state at step ${index + 1}`)
    state = transition.state
  }
  return state
}

function applyPlanned(state: any, decision: any) {
  expect(decision.nextAction, `expected an action; stopReason=${decision.stopReason}`).toBeDefined()
  const beforeHash = hashStable(state)
  const transition = practiceEnvironment.simulate(state, decision.nextAction, { rootSeed: ROOT_SEED })
  expect(hashStable(state)).toBe(beforeHash)
  expect(transition.accepted, JSON.stringify(transition)).toBe(true)
  if (!transition.accepted) throw new Error('expected an accepted authoritative transition')
  return transition.state
}

describe('RED-228 tutorial tactical planner', () => {
  it('records the legacy move-only miss and replans a legal move into a real attack', () => {
    const state = fixture({
      actionPoints: 2,
      casterMoveRange: 2,
      casterTemplateId: 'uther',
      casterSkills: ['blessed-hammer'],
      targetX: 4,
      targetHp: 12,
    })

    const legacy = planBotActions(state, 'player-red')
    expect(legacy?.actions[0]?.type).toBe('move')
    expect(legacy?.actions.some(action => action.type === 'useBasicSkill')).toBe(false)

    const first = plan(state)
    expect(first.nextAction?.action.type).toBe('move')
    const afterMove = applyPlanned(state, first)

    const second = plan(afterMove, { continuation: first.continuation, actionsTakenThisTurn: 1 })
    expect(second.nextAction?.action).toMatchObject({
      type: 'useBasicSkill',
      pieceId: 'red-caster',
      skillId: 'blessed-hammer',
      targetPieceId: 'blue-target',
    })
    const afterAttack = applyPlanned(afterMove, second)
    expect(afterAttack.pieces.find((piece: any) => piece.instanceId === 'blue-target')?.currentHp).toBe(8)
    expect(second.continuation.turnKey).toBe(first.continuation.turnKey)
    expect(second.nodes).toBeLessThanOrEqual(SEARCH_CONFIG.nodesPerDecision)
    expect(second.elapsedMs).toBe(0)
  })

  it('chooses a lethal burst before the legacy first-listed cheap skill', () => {
    const state = fixture({
      actionPoints: 2,
      casterSkills: ['frostbolt', 'fireball'],
      targetHp: 5,
    })

    const legacy = planBotActions(state, 'player-red')
    expect(legacy?.actions[0]).toMatchObject({ type: 'useBasicSkill', skillId: 'frostbolt' })
    expect(legacy?.actions.some(action => 'skillId' in action && action.skillId === 'fireball')).toBe(false)

    const decision = plan(state)
    expect(decision.nextAction?.action).toMatchObject({
      type: 'useBasicSkill',
      skillId: 'fireball',
      pieceId: 'red-caster',
      targetPieceId: 'blue-target',
    })
    const after = applyPlanned(state, decision)
    expect(after.terminalResult?.winnerPlayerId).toBe('player-red')
  })

  it('replans the same piece for two distinct real skills instead of batching one attempt', () => {
    const state = fixture({
      actionPoints: 3,
      casterSkills: ['frostbolt', 'fireball'],
      targetHp: 20,
      targetMaxHp: 20,
    })

    const legacy = planBotActions(state, 'player-red')
    expect(legacy?.actions.filter(action => action.type === 'useBasicSkill')).toHaveLength(1)

    const first = plan(state)
    expect(first.nextAction?.action.type).toBe('useBasicSkill')
    const firstSkill = first.nextAction!.action as any
    const afterFirst = applyPlanned(state, first)
    const second = plan(afterFirst, { continuation: first.continuation, actionsTakenThisTurn: 1 })
    expect(second.nextAction?.action).toMatchObject({
      type: 'useBasicSkill',
      pieceId: 'red-caster',
      targetPieceId: 'blue-target',
    })
    expect((second.nextAction!.action as any).skillId).not.toBe(firstSkill.skillId)
    const afterSecond = applyPlanned(afterFirst, second)
    expect(afterSecond.pieces.find((piece: any) => piece.instanceId === 'blue-target')?.currentHp).toBe(10)
  })

  it('spends a zero-AP lucky coin only when a real skill continuation exists', () => {
    const state = fixture({
      actionPoints: 0,
      casterSkills: ['fireball'],
      hand: [card('lucky-coin', 'coin-1')],
      targetHp: 12,
    })

    const legacy = planBotActions(state, 'player-red')
    expect(legacy?.actions[0]?.type).toBe('endTurn')

    const first = plan(state)
    expect(first.nextAction?.action).toMatchObject({ type: 'playCard', cardInstanceId: 'coin-1' })
    const afterCoin = applyPlanned(state, first)
    expect(afterCoin.players[0].actionPoints).toBe(1)

    const second = plan(afterCoin, { continuation: first.continuation, actionsTakenThisTurn: 1 })
    expect(second.nextAction?.action).toMatchObject({
      type: 'useBasicSkill', skillId: 'fireball', targetPieceId: 'blue-target',
    })
    const afterSkill = applyPlanned(afterCoin, second)
    expect(afterSkill.pieces.find((piece: any) => piece.instanceId === 'blue-target')?.currentHp).toBe(6)
  })

  it('ends with a useless coin intact and keeps the opponent hand outside public scoring', () => {
    const state = fixture({
      actionPoints: 0,
      casterSkills: [],
      casterMoveRange: 0,
      targetX: 7,
      hand: [card('lucky-coin', 'coin-1')],
      opponentHand: [card('lucky-coin', 'secret-coin-a')],
    })
    const hiddenVariant = structuredClone(state)
    hiddenVariant.players[1].hand = [card('lucky-coin', 'secret-coin-b'), card('lucky-coin', 'secret-coin-c')]

    const first = plan(state)
    expect(first.nextAction?.action.type).toBe('endTurn')
    const after = applyPlanned(state, first)
    expect(after.players[0].hand).toEqual([expect.objectContaining({ instanceId: 'coin-1', cardId: 'lucky-coin' })])

    const hiddenPlan = plan(hiddenVariant)
    expect(hiddenPlan.nextAction?.action).toEqual(first.nextAction?.action)
    expect(hiddenPlan.score).toBe(first.score)
  })

  it('compares an ordinary root action when the stop baseline consumes the soft cutoff', () => {
    const state = fixture({ casterSkills: ['fireball'], targetHp: 12 })
    let reads = 0
    const decision = plan(state, {
      config: { ...SEARCH_CONFIG, turnTimeMs: 2_000, decisionTimeMs: 250 },
      now: () => ++reads <= 2 ? 0 : 250,
    })
    const endTurnId = practiceEnvironment.listLegalActions(state, 'player-red')
      .find(candidate => candidate.kind === 'end-turn')?.id

    expect(decision.nextAction?.kind).toBe('basic-skill')
    expect(decision.nodes).toBeGreaterThanOrEqual(2)
    expect(decision.trace.filter(row => row.depth === 0 && row.reason === 'evaluated')
      .map(row => row.candidateId)).toEqual(expect.arrayContaining([endTurnId]))
    expect(decision.elapsedMs).toBe(250)
  })

  it('keeps a canonical full-roster late turn from stopping after the baseline only', async () => {
    const state = await canonicalLateState()
    expect(state.turn.turnNumber).toBe(16)
    expect(state.pieces).toHaveLength(15)
    expect(Object.values(state.deployment?.reserves ?? {}).flat()).toHaveLength(0)
    const beforeHash = hashStable(state)
    let reads = 0
    const decision = planTutorialAiAction(state, 'training-blue', 18707, {
      now: () => ++reads <= 2 ? 0 : 251,
      config: { ...SEARCH_CONFIG, turnTimeMs: 2_500, decisionTimeMs: 250 },
    })
    const legalAtRoot = listLegalAIActions(state, 'training-blue')
    const baseline = legalAtRoot.find(candidate => candidate.kind === 'end-turn')!
    const baselineTransition = practiceEnvironment.simulate(state, baseline, { rootSeed: 18707 })
    const baselineScore = baselineTransition.accepted
      ? evaluateZeroStageState(practiceEnvironment.observe(baselineTransition.state, 'training-blue')).total
      : Number.NEGATIVE_INFINITY
    expect(decision.nodes).toBeGreaterThanOrEqual(12)
    expect(decision.overDecisionBudget).toBe(true)
    const evaluatedRoots = decision.trace.filter(row => row.depth === 0 && row.reason === 'evaluated')
    expect(evaluatedRoots).toHaveLength(12)
    expect(evaluatedRoots.map(row => row.candidateId)).toContain(baseline.id)
    expect(evaluatedRoots.some(row => row.candidateId !== baseline.id)).toBe(true)
    expect(decision.nextAction?.action).toMatchObject({
      type: 'useBasicSkill',
      pieceId: 'training-blue-3',
      skillId: 'ulquiorra-cero',
      targetPieceId: 'training-red-7',
    })
    const chosenTransition = practiceEnvironment.simulate(state, decision.nextAction!, { rootSeed: 18707 })
    expect(chosenTransition.accepted, JSON.stringify(chosenTransition)).toBe(true)
    if (!chosenTransition.accepted) throw new Error('expected the canonical ordinary action to be accepted')
    const chosenScore = evaluateZeroStageState(
      practiceEnvironment.observe(chosenTransition.state, 'training-blue'),
    ).total
    expect(decision.score).toBeGreaterThan(baselineScore)
    expect(chosenScore).toBeGreaterThan(baselineScore)
    expect(hashStable(state)).toBe(beforeHash)
  }, 15_000)

  it('uses a deterministic coordinate-less deployment boundary without simulating hidden landing', () => {
    const state = fixture({ progressiveDeployment: true, fallbackDeployment: true, casterSkills: [] })
    const beforeHash = hashStable(state)
    const first = plan(state)
    const second = plan(structuredClone(state))

    expect(first.stopReason).toBe('random-boundary')
    expect(first.nextAction?.action).toMatchObject({
      type: 'deployReservePiece', playerId: 'player-red', pieceId: 'red-reserve',
    })
    const deploymentAction = first.nextAction?.action
    expect(deploymentAction?.type).toBe('deployReservePiece')
    if (deploymentAction?.type !== 'deployReservePiece') throw new Error('expected a reserve deployment action')
    expect(deploymentAction.toX).toBeUndefined()
    expect(deploymentAction.toY).toBeUndefined()
    expect(second.nextAction?.action).toEqual(first.nextAction?.action)
    expect(hashStable(state)).toBe(beforeHash)

    const transitionA = practiceEnvironment.simulate(state, first.nextAction!, { rootSeed: ROOT_SEED })
    const transitionB = practiceEnvironment.simulate(state, first.nextAction!, { rootSeed: ROOT_SEED })
    expect(transitionA.accepted, JSON.stringify(transitionA)).toBe(true)
    expect(transitionB.accepted, JSON.stringify(transitionB)).toBe(true)
    if (transitionA.accepted && transitionB.accepted) {
      expect(transitionA.transitionHash).toBe(transitionB.transitionHash)
      expect(transitionA.state.pieces.find((piece: any) => piece.instanceId === 'red-reserve'))
        .toMatchObject({ x: expect.any(Number), y: expect.any(Number) })
    }
  })

  it('honors the cumulative action and node caps, then resets at a new turn key', () => {
    const state = fixture({ casterSkills: ['fireball'], targetHp: 20, targetMaxHp: 20 })
    const capped = plan(state, {
      actionsTakenThisTurn: SEARCH_CONFIG.maxActionsPerTurn - 1,
      config: { ...SEARCH_CONFIG, maxActionsPerTurn: 2, nodesPerTurn: 2 },
    })
    expect(capped.stopReason).toBe('action-budget')
    expect(capped.nextAction?.action.type).toBe('endTurn')

    const nextTurn = structuredClone(state)
    nextTurn.turn.turnNumber += 1
    const replanned = plan(nextTurn, {
      continuation: capped.continuation,
      actionsTakenThisTurn: 0,
      config: { ...SEARCH_CONFIG, maxActionsPerTurn: 2, nodesPerTurn: 2 },
    })
    expect(replanned.continuation.turnKey).not.toBe(capped.continuation.turnKey)
    expect(replanned.nextAction).toBeDefined()
    expect(replanned.nodes).toBeLessThanOrEqual(2)
  })
})
