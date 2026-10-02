/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures exercise the serialized battle contract. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { planBotActions } from '@/lib/game/ai'
import { planTutorialAiAction } from '@/lib/game/tutorial-ai'
import { hashStable } from '@/lib/game/battle-trace'
import { practiceEnvironment } from '@/lib/practice/environment'
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
