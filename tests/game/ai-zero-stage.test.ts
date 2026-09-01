/* eslint-disable @typescript-eslint/no-explicit-any -- deterministic serialized AI fixtures. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { aiEnvironmentV1 } from '@/lib/game/ai-environment'
import { evaluateZeroStageState } from '@/lib/game/ai-zero-stage-evaluator'
import {
  planZeroStageAction,
  zeroStageDecisionTraceHash,
} from '@/lib/game/ai-zero-stage-agent'
import { DEFAULT_ZERO_STAGE_CONFIG, resolveZeroStageConfig } from '@/lib/game/ai-profiles'
import { hashBattleState, hashStable } from '@/lib/game/battle-trace'
import type {
  AIEnvironment,
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

function candidate(id: string, type = id, playerId = 'player-red'): CandidateAction {
  return {
    protocolVersion: 1,
    id,
    kind: type === 'endTurn' ? 'end-turn' : 'basic-skill',
    action: type === 'endTurn'
      ? { type: 'endTurn', playerId }
      : { type: type as any, playerId, pieceId: `${playerId === 'player-red' ? 'red' : 'blue'}-core` } as any,
  }
}

describe('zero-stage static evaluator', () => {
  it('keeps the versioned agent asset aligned with the executable default profile', () => {
    const profile = JSON.parse(readFileSync(resolve(process.cwd(), 'config/ai/agents/rvb-ai-zimse-v1.json'), 'utf8'))
    expect(profile).toMatchObject({
      agentId: 'rvb-ai-zimse-v1',
      schemaVersion: DEFAULT_ZERO_STAGE_CONFIG.version,
      candidateMode: DEFAULT_ZERO_STAGE_CONFIG.candidateMode,
      maxActionsPerTurn: DEFAULT_ZERO_STAGE_CONFIG.maxActionsPerTurn,
      terminal: DEFAULT_ZERO_STAGE_CONFIG.terminal,
      weights: DEFAULT_ZERO_STAGE_CONFIG.weights,
    })
    expect(profile).not.toHaveProperty('lambda')
    expect(profile).not.toHaveProperty('topWeights')
  })

  it('uses an explicit relative player view and gives terminal outcomes absolute priority', () => {
    const state = combatState()
    const red = evaluateZeroStageState(aiEnvironmentV1.observe(state, 'player-red'))
    const blue = evaluateZeroStageState(aiEnvironmentV1.observe(state, 'player-blue'))

    expect(red.components.health.contribution).toBe(-blue.components.health.contribution)
    expect(red.components.coreSurvival.contribution).toBeCloseTo(-blue.components.coreSurvival.contribution)
    expect(red.components.strategicPosition.contribution)
      .toBeCloseTo(-blue.components.strategicPosition.contribution)
    expect(red.components.enemyProximity.contribution)
      .toBeCloseTo(blue.components.enemyProximity.contribution)

    const won = structuredClone(state) as any
    won.terminalResult = {
      status: 'finished', winnerPlayerId: 'player-red', loserPlayerId: 'player-blue',
      reason: 'core-eliminated', settledAt: {
        actionIndex: 0, actionType: 'useBasicSkill', actorPlayerId: 'player-red',
        turnNumber: 1, phase: 'action', completedRound: 0,
      },
    }
    expect(evaluateZeroStageState(aiEnvironmentV1.observe(won, 'player-red')).total)
      .toBe(DEFAULT_ZERO_STAGE_CONFIG.terminal.win)
    expect(evaluateZeroStageState(aiEnvironmentV1.observe(won, 'player-blue')).total)
      .toBe(DEFAULT_ZERO_STAGE_CONFIG.terminal.loss)
  })

  it('cannot change when opponent-private fields or hidden statuses change', () => {
    const state = combatState() as any
    state.players[1].hand = [{
      cardId: 'private-a', instanceId: 'secret-a', ownerPlayerId: 'player-blue', description: 'secret',
    }]
    state.pieces[1].statusTags = [{ id: 'hidden-a', type: 'hidden', visible: false, stacks: 99 }]
    const before = evaluateZeroStageState(aiEnvironmentV1.observe(state, 'player-red'))
    const beforeDecision = planZeroStageAction(state, 'player-red', ROOT_SEED)

    state.players[1].hand = [{
      cardId: 'private-b', instanceId: 'secret-b', ownerPlayerId: 'player-blue', description: 'different',
    }]
    state.pieces[1].statusTags = [{ id: 'hidden-b', type: 'hidden', visible: false, stacks: 1 }]
    expect(evaluateZeroStageState(aiEnvironmentV1.observe(state, 'player-red'))).toEqual(before)
    const afterDecision = planZeroStageAction(state, 'player-red', ROOT_SEED)
    expect(afterDecision.nextAction).toEqual(beforeDecision.nextAction)
    expect(zeroStageDecisionTraceHash(afterDecision)).toBe(zeroStageDecisionTraceHash(beforeDecision))
  })

  it('produces mirrored pursuit decisions for red and blue seats', () => {
    const redState = makeState({
      width: 7,
      height: 3,
      currentPlayerId: 'player-red',
      pieces: [
        makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red', x: 1, y: 1, moveRange: 1 }),
        makePiece({ instanceId: 'blue-core', ownerPlayerId: 'player-blue', x: 5, y: 1, moveRange: 1 }),
      ],
    }) as any
    redState.pieces.forEach((piece: any) => { piece.isCore = true })
    const blueState = structuredClone(redState) as any
    blueState.turn.currentPlayerId = 'player-blue'

    const redDecision = planZeroStageAction(redState, 'player-red', ROOT_SEED)
    const blueDecision = planZeroStageAction(blueState, 'player-blue', ROOT_SEED)
    expect(redDecision.nextAction?.action).toMatchObject({ type: 'move', toX: 2, toY: 1 })
    expect(blueDecision.nextAction?.action).toMatchObject({ type: 'move', toX: 4, toY: 1 })
    const redValue = redDecision.trace.find(item => item.candidateId === redDecision.nextAction?.id)?.staticValue
    const blueValue = blueDecision.trace.find(item => item.candidateId === blueDecision.nextAction?.id)?.staticValue
    expect(redValue).toBeCloseTo(blueValue ?? Number.NaN)
  })

  it('scores future attack reach, nearby support, open movement space, and beneficial terrain', () => {
    const base = makeState({
      width: 9,
      height: 7,
      pieces: [
        makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red', x: 0, y: 0, moveRange: 3, attack: 14 }),
        makePiece({ instanceId: 'red-support', ownerPlayerId: 'player-red', x: 0, y: 6, moveRange: 3, currentHp: 40 }),
        makePiece({ instanceId: 'blue-core', ownerPlayerId: 'player-blue', x: 8, y: 0, moveRange: 1, attack: 2 }),
      ],
    }) as any
    base.pieces[0].isCore = true
    base.pieces[2].isCore = true
    const baseline = evaluateZeroStageState(aiEnvironmentV1.observe(base, 'player-red'))

    const positioned = structuredClone(base) as any
    positioned.pieces[0].x = 4
    positioned.pieces[0].y = 3
    positioned.pieces[1].x = 3
    positioned.pieces[1].y = 3
    const tile = positioned.map.tiles.find((item: any) => item.x === 4 && item.y === 3)
    tile.props.type = 'cover'
    tile.props.healPerTurn = 5
    const improved = evaluateZeroStageState(aiEnvironmentV1.observe(positioned, 'player-red'))

    expect(improved.components.futureAttackPotential.raw)
      .toBeGreaterThan(baseline.components.futureAttackPotential.raw)
    expect(improved.components.supportPotential.raw).toBeGreaterThan(baseline.components.supportPotential.raw)
    expect(improved.components.mobilityPotential.raw).toBeGreaterThan(baseline.components.mobilityPotential.raw)
    expect(improved.components.terrainValue.raw).toBeGreaterThan(baseline.components.terrainValue.raw)
  })

  it('devalues remote pieces and rewards advancing toward the center and enemy objective', () => {
    const remote = makeState({
      width: 11,
      height: 7,
      pieces: [
        makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red', x: 0, y: 0 }),
        makePiece({ instanceId: 'red-flanker', ownerPlayerId: 'player-red', x: 0, y: 6, moveRange: 3 }),
        makePiece({ instanceId: 'blue-core', ownerPlayerId: 'player-blue', x: 10, y: 3 }),
      ],
    }) as any
    remote.pieces[0].isCore = true
    remote.pieces[2].isCore = true
    const remoteValue = evaluateZeroStageState(aiEnvironmentV1.observe(remote, 'player-red'))

    const advanced = structuredClone(remote) as any
    advanced.pieces[1].x = 5
    advanced.pieces[1].y = 3
    const advancedValue = evaluateZeroStageState(aiEnvironmentV1.observe(advanced, 'player-red'))

    expect(advancedValue.components.strategicPosition.raw)
      .toBeGreaterThan(remoteValue.components.strategicPosition.raw)
    expect(advancedValue.components.enemyProximity.raw)
      .toBeGreaterThan(remoteValue.components.enemyProximity.raw)
    expect(advancedValue.total).toBeGreaterThan(remoteValue.total)
  })

  it('rewards a non-core attacker for every step toward the nearest enemy core', () => {
    const remote = makeState({
      width: 13,
      height: 5,
      pieces: [
        makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red', x: 0, y: 0 }),
        makePiece({ instanceId: 'red-attacker', ownerPlayerId: 'player-red', x: 1, y: 2, moveRange: 2 }),
        makePiece({ instanceId: 'blue-core', ownerPlayerId: 'player-blue', x: 11, y: 2 }),
      ],
    }) as any
    remote.pieces[0].isCore = true
    remote.pieces[2].isCore = true
    const oneStep = structuredClone(remote) as any
    oneStep.pieces[1].x = 2
    const twoSteps = structuredClone(remote) as any
    twoSteps.pieces[1].x = 3

    const remoteValue = evaluateZeroStageState(aiEnvironmentV1.observe(remote, 'player-red'))
    const oneStepValue = evaluateZeroStageState(aiEnvironmentV1.observe(oneStep, 'player-red'))
    const twoStepsValue = evaluateZeroStageState(aiEnvironmentV1.observe(twoSteps, 'player-red'))

    expect(oneStepValue.components.enemyProximity.raw)
      .toBeGreaterThan(remoteValue.components.enemyProximity.raw)
    expect(twoStepsValue.components.enemyProximity.raw)
      .toBeGreaterThan(oneStepValue.components.enemyProximity.raw)
    expect(twoStepsValue.total).toBeGreaterThan(oneStepValue.total)
  })

  it('rewards assigning an extra pursuer to a remote core during cleanup', () => {
    const clustered = makeState({
      width: 21,
      height: 7,
      pieces: [
        makePiece({ instanceId: 'red-left', ownerPlayerId: 'player-red', x: 9, y: 5 }),
        makePiece({ instanceId: 'red-middle', ownerPlayerId: 'player-red', x: 10, y: 5 }),
        makePiece({ instanceId: 'red-right', ownerPlayerId: 'player-red', x: 11, y: 5 }),
        makePiece({ instanceId: 'red-extra', ownerPlayerId: 'player-red', x: 12, y: 5 }),
        makePiece({ instanceId: 'blue-near', ownerPlayerId: 'player-blue', x: 10, y: 0 }),
        makePiece({ instanceId: 'blue-right', ownerPlayerId: 'player-blue', x: 20, y: 0 }),
      ],
    }) as any
    clustered.pieces.forEach((piece: any) => { piece.isCore = true })
    const spread = structuredClone(clustered) as any
    spread.pieces[3].x = 13

    const clusteredValue = evaluateZeroStageState(aiEnvironmentV1.observe(clustered, 'player-red'))
    const spreadValue = evaluateZeroStageState(aiEnvironmentV1.observe(spread, 'player-red'))

    expect(spreadValue.components.enemyProximity.raw)
      .toBeGreaterThan(clusteredValue.components.enemyProximity.raw)
  })

  it('balances multiple pursuers per surviving core instead of stopping at one-to-one cleanup', () => {
    const clustered = makeState({
      width: 21,
      height: 3,
      pieces: [
        makePiece({ instanceId: 'red-near-a', ownerPlayerId: 'player-red', x: 0, y: 1 }),
        makePiece({ instanceId: 'red-near-b', ownerPlayerId: 'player-red', x: 1, y: 1 }),
        makePiece({ instanceId: 'red-extra', ownerPlayerId: 'player-red', x: 2, y: 1 }),
        makePiece({ instanceId: 'red-remote', ownerPlayerId: 'player-red', x: 12, y: 1 }),
        makePiece({ instanceId: 'blue-near', ownerPlayerId: 'player-blue', x: 0, y: 1 }),
        makePiece({ instanceId: 'blue-remote', ownerPlayerId: 'player-blue', x: 20, y: 1 }),
      ],
    }) as any
    clustered.pieces.forEach((piece: any) => { piece.isCore = true })
    const advancingSecondPursuer = structuredClone(clustered) as any
    advancingSecondPursuer.pieces[2].x = 3

    const clusteredValue = evaluateZeroStageState(aiEnvironmentV1.observe(clustered, 'player-red'))
    const advancingValue = evaluateZeroStageState(
      aiEnvironmentV1.observe(advancingSecondPursuer, 'player-red'),
    )

    expect(advancingValue.components.enemyProximity.raw)
      .toBeGreaterThan(clusteredValue.components.enemyProximity.raw)
  })

  it('adds cleanup position value when an assigned pursuer reaches its next-action envelope', () => {
    const outside = makeState({
      width: 21,
      height: 3,
      pieces: [
        makePiece({ instanceId: 'red-near-a', ownerPlayerId: 'player-red', x: 0, y: 1 }),
        makePiece({ instanceId: 'red-near-b', ownerPlayerId: 'player-red', x: 1, y: 1 }),
        makePiece({ instanceId: 'red-stager', ownerPlayerId: 'player-red', x: 14, y: 1, moveRange: 4 }),
        makePiece({ instanceId: 'red-remote', ownerPlayerId: 'player-red', x: 19, y: 0 }),
        makePiece({ instanceId: 'blue-near', ownerPlayerId: 'player-blue', x: 0, y: 1 }),
        makePiece({ instanceId: 'blue-remote', ownerPlayerId: 'player-blue', x: 20, y: 1 }),
      ],
    }) as any
    outside.pieces.forEach((piece: any) => { piece.isCore = true })
    const staged = structuredClone(outside) as any
    staged.pieces[2].x = 15

    const outsideValue = evaluateZeroStageState(aiEnvironmentV1.observe(outside, 'player-red'))
    const stagedValue = evaluateZeroStageState(aiEnvironmentV1.observe(staged, 'player-red'))
    const oneStepDistanceGain = 1 / (outside.map.tiles.length - 1)

    expect(stagedValue.components.enemyProximity.raw
      - outsideValue.components.enemyProximity.raw).toBeGreaterThan(oneStepDistanceGain + 0.04)
  })

  it('focuses distance value more strongly when only one enemy core survives', () => {
    const remote = makeState({
      width: 21,
      height: 7,
      pieces: [
        makePiece({ instanceId: 'red-a', ownerPlayerId: 'player-red', x: 0, y: 1 }),
        makePiece({ instanceId: 'red-b', ownerPlayerId: 'player-red', x: 0, y: 3 }),
        makePiece({ instanceId: 'red-c', ownerPlayerId: 'player-red', x: 0, y: 5 }),
        makePiece({ instanceId: 'blue-last', ownerPlayerId: 'player-blue', x: 20, y: 3 }),
      ],
    }) as any
    remote.pieces.forEach((piece: any) => { piece.isCore = true })
    const advanced = structuredClone(remote) as any
    advanced.pieces[1].x = 1

    const remoteValue = evaluateZeroStageState(aiEnvironmentV1.observe(remote, 'player-red'))
    const advancedValue = evaluateZeroStageState(aiEnvironmentV1.observe(advanced, 'player-red'))

    expect(advancedValue.components.enemyProximity.raw
      - remoteValue.components.enemyProximity.raw).toBeGreaterThan(0.02)
  })

  it('rewards entering an action envelope under a slight numerical advantage', () => {
    const outside = makeState({
      width: 21,
      height: 7,
      pieces: [
        makePiece({ instanceId: 'red-a', ownerPlayerId: 'player-red', x: 0, y: 0 }),
        makePiece({ instanceId: 'red-b', ownerPlayerId: 'player-red', x: 1, y: 0 }),
        makePiece({ instanceId: 'red-c', ownerPlayerId: 'player-red', x: 2, y: 0 }),
        makePiece({ instanceId: 'red-d', ownerPlayerId: 'player-red', x: 3, y: 0 }),
        makePiece({ instanceId: 'red-stager', ownerPlayerId: 'player-red', x: 14, y: 3, moveRange: 4 }),
        makePiece({ instanceId: 'blue-a', ownerPlayerId: 'player-blue', x: 0, y: 6 }),
        makePiece({ instanceId: 'blue-b', ownerPlayerId: 'player-blue', x: 5, y: 6 }),
        makePiece({ instanceId: 'blue-c', ownerPlayerId: 'player-blue', x: 10, y: 6 }),
        makePiece({ instanceId: 'blue-remote', ownerPlayerId: 'player-blue', x: 20, y: 3 }),
      ],
    }) as any
    outside.pieces.forEach((piece: any) => { piece.isCore = true })
    const staged = structuredClone(outside) as any
    staged.pieces[4].x = 15

    const outsideValue = evaluateZeroStageState(aiEnvironmentV1.observe(outside, 'player-red'))
    const stagedValue = evaluateZeroStageState(aiEnvironmentV1.observe(staged, 'player-red'))

    expect(stagedValue.components.enemyProximity.raw
      - outsideValue.components.enemyProximity.raw).toBeGreaterThan(0.04)
  })

  it('strengthens each approach step after an advantage side reduces enemies to four cores', () => {
    const remote = makeState({
      width: 21,
      height: 7,
      pieces: [
        makePiece({ instanceId: 'red-a', ownerPlayerId: 'player-red', x: 0, y: 0 }),
        makePiece({ instanceId: 'red-b', ownerPlayerId: 'player-red', x: 1, y: 0 }),
        makePiece({ instanceId: 'red-c', ownerPlayerId: 'player-red', x: 2, y: 0 }),
        makePiece({ instanceId: 'red-d', ownerPlayerId: 'player-red', x: 3, y: 0 }),
        makePiece({ instanceId: 'red-pursuer', ownerPlayerId: 'player-red', x: 14, y: 3, moveRange: 2 }),
        makePiece({ instanceId: 'blue-a', ownerPlayerId: 'player-blue', x: 0, y: 6 }),
        makePiece({ instanceId: 'blue-b', ownerPlayerId: 'player-blue', x: 5, y: 6 }),
        makePiece({ instanceId: 'blue-c', ownerPlayerId: 'player-blue', x: 10, y: 6 }),
        makePiece({ instanceId: 'blue-remote', ownerPlayerId: 'player-blue', x: 20, y: 3 }),
      ],
    }) as any
    remote.pieces.forEach((piece: any) => { piece.isCore = true })
    const advanced = structuredClone(remote) as any
    advanced.pieces[4].x = 15

    const remoteValue = evaluateZeroStageState(aiEnvironmentV1.observe(remote, 'player-red'))
    const advancedValue = evaluateZeroStageState(aiEnvironmentV1.observe(advanced, 'player-red'))

    expect(advancedValue.components.enemyProximity.raw
      - remoteValue.components.enemyProximity.raw).toBeGreaterThan(0.01)
  })

  it('penalizes exposed low-health positions and rewards deployment lock readiness', () => {
    const exposed = combatState() as any
    exposed.pieces[0].currentHp = 10
    exposed.pieces[1].x = 2
    exposed.pieces[1].attack = 30
    const danger = evaluateZeroStageState(aiEnvironmentV1.observe(exposed, 'player-red'))

    const safe = structuredClone(exposed) as any
    safe.pieces[1].x = 5
    const safety = evaluateZeroStageState(aiEnvironmentV1.observe(safe, 'player-red'))
    expect(safety.components.positionSafety.raw).toBeGreaterThan(danger.components.positionSafety.raw)

    safe.deployment = {
      status: 'awaiting-locks', playerIds: ['player-red', 'player-blue'],
      locks: { 'player-red': { locked: true }, 'player-blue': { locked: false } },
      deadlineAt: 0, revision: 1, initialPositions: {},
    }
    expect(evaluateZeroStageState(aiEnvironmentV1.observe(safe, 'player-red')).components.deploymentReadiness.raw).toBe(1)
  })

  it('values public sourced status tags by whether their source is friendly or hostile', () => {
    const baseline = combatState() as any
    const cursed = structuredClone(baseline) as any
    cursed.pieces[1].statusTags = [{
      id: 'enemy-curse',
      type: 'curse',
      sourcePlayerId: 'player-red',
    }]
    const neutral = structuredClone(baseline) as any
    neutral.pieces[1].statusTags = [{ id: 'unknown-polarity', type: 'stance' }]

    const baselineValue = evaluateZeroStageState(aiEnvironmentV1.observe(baseline, 'player-red'))
    const cursedValue = evaluateZeroStageState(aiEnvironmentV1.observe(cursed, 'player-red'))
    const neutralValue = evaluateZeroStageState(aiEnvironmentV1.observe(neutral, 'player-red'))

    expect(cursedValue.components.status.raw).toBeGreaterThan(baselineValue.components.status.raw)
    expect(neutralValue.components.status.raw).toBe(baselineValue.components.status.raw)
  })

  it('values damage to a core more than equal normalized damage to a non-core piece', () => {
    const base = makeState({
      pieces: [
        makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red', x: 0, y: 0 }),
        makePiece({ instanceId: 'blue-core', ownerPlayerId: 'player-blue', x: 2, y: 0, maxHp: 10, currentHp: 10 }),
        makePiece({ instanceId: 'blue-summon', ownerPlayerId: 'player-blue', x: 3, y: 0, maxHp: 10, currentHp: 10 }),
      ],
    }) as any
    base.pieces[0].isCore = true
    base.pieces[1].isCore = true
    const baseline = evaluateZeroStageState(aiEnvironmentV1.observe(base, 'player-red'))
    const coreDamaged = structuredClone(base) as any
    coreDamaged.pieces[1].currentHp -= 1
    const summonDamaged = structuredClone(base) as any
    summonDamaged.pieces[2].currentHp -= 1
    const coreGain = evaluateZeroStageState(aiEnvironmentV1.observe(coreDamaged, 'player-red'))
      .components.health.raw - baseline.components.health.raw
    const summonGain = evaluateZeroStageState(aiEnvironmentV1.observe(summonDamaged, 'player-red'))
      .components.health.raw - baseline.components.health.raw

    expect(coreGain).toBeGreaterThan(summonGain * 10)
  })


  it('values finishing damage on a wounded core above equal damage spread to a full core', () => {
    const base = makeState({
      pieces: [
        makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red', x: 0, y: 0 }),
        makePiece({ instanceId: 'blue-wounded', ownerPlayerId: 'player-blue', x: 2, y: 0, maxHp: 10, currentHp: 5 }),
        makePiece({ instanceId: 'blue-full', ownerPlayerId: 'player-blue', x: 3, y: 0, maxHp: 10, currentHp: 10 }),
      ],
    }) as any
    base.pieces.forEach((piece: any) => { piece.isCore = true })
    const baseline = evaluateZeroStageState(aiEnvironmentV1.observe(base, 'player-red'))
    const woundedHit = structuredClone(base) as any
    woundedHit.pieces[1].currentHp -= 1
    const fullHit = structuredClone(base) as any
    fullHit.pieces[2].currentHp -= 1
    const woundedGain = evaluateZeroStageState(aiEnvironmentV1.observe(woundedHit, 'player-red'))
      .components.health.raw - baseline.components.health.raw
    const fullGain = evaluateZeroStageState(aiEnvironmentV1.observe(fullHit, 'player-red'))
      .components.health.raw - baseline.components.health.raw

    expect(woundedGain).toBeGreaterThan(fullGain)
  })

  it('gives substantial value to realized enemy core damage', () => {
    const base = makeState({
      pieces: [
        makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red', x: 0, y: 0 }),
        makePiece({ instanceId: 'blue-core', ownerPlayerId: 'player-blue', x: 2, y: 0, maxHp: 100, currentHp: 100 }),
      ],
    }) as any
    base.pieces.forEach((piece: any) => { piece.isCore = true })
    const damaged = structuredClone(base) as any
    damaged.pieces[1].currentHp = 80
    const baseline = evaluateZeroStageState(aiEnvironmentV1.observe(base, 'player-red'))
    const result = evaluateZeroStageState(aiEnvironmentV1.observe(damaged, 'player-red'))

    expect(result.components.health.contribution - baseline.components.health.contribution)
      .toBeGreaterThan(40_000)
  })

  it('values breaking enemy shields while keeping real core damage more valuable', () => {
    const base = makeState({
      pieces: [
        makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red', x: 0, y: 0 }),
        makePiece({ instanceId: 'blue-core', ownerPlayerId: 'player-blue', x: 2, y: 0, maxHp: 100, currentHp: 100 }),
      ],
    }) as any
    base.pieces.forEach((piece: any) => { piece.isCore = true })
    base.pieces[1].shield = 10
    const shieldDamaged = structuredClone(base) as any
    shieldDamaged.pieces[1].shield = 5
    const healthDamaged = structuredClone(base) as any
    healthDamaged.pieces[1].currentHp = 95
    const baseline = evaluateZeroStageState(aiEnvironmentV1.observe(base, 'player-red'))
    const shieldResult = evaluateZeroStageState(aiEnvironmentV1.observe(shieldDamaged, 'player-red'))
    const healthResult = evaluateZeroStageState(aiEnvironmentV1.observe(healthDamaged, 'player-red'))
    const shieldGain = shieldResult.components.shield.contribution - baseline.components.shield.contribution
    const healthGain = healthResult.components.health.contribution - baseline.components.health.contribution

    expect(shieldGain).toBeGreaterThan(1_000)
    expect(healthGain).toBeGreaterThan(shieldGain)
  })

  it('does not reward resource consumption when the resulting public position is unchanged', () => {
    const unspent = combatState() as any
    const redPlayer = unspent.players.find((player: any) => player.playerId === 'player-red')
    redPlayer.maxActionPoints = 2
    redPlayer.actionPoints = 2
    redPlayer.chargePoints = 2
    const baseline = evaluateZeroStageState(aiEnvironmentV1.observe(unspent, 'player-red'))

    const spent = structuredClone(unspent) as any
    const spentPlayer = spent.players.find((player: any) => player.playerId === 'player-red')
    spentPlayer.actionPoints = 1
    spentPlayer.chargePoints = 1
    const converted = evaluateZeroStageState(aiEnvironmentV1.observe(spent, 'player-red'))

    expect(converted.components.resources.raw).toBe(baseline.components.resources.raw)
    expect(converted.components.actionability.raw).toBe(baseline.components.actionability.raw)
    expect(converted.total).toBe(baseline.total)
  })
})

describe('zero-stage deterministic one-step selection', () => {
  it('takes an immediate formal core elimination ahead of movement or ending the turn', () => {
    const attack = skill('hand-cannon')
    const state = combatState() as any
    state.pieces[1].x = 2
    state.pieces[1].currentHp = 1
    state.pieces[0].attack = 20
    state.pieces[0].skills = [{ skillId: attack.id, currentCooldown: 0, usesRemaining: -1 }]
    state.skillsById[attack.id] = attack

    const decision = planZeroStageAction(state, 'player-red', ROOT_SEED)
    expect(decision.nextAction?.action).toMatchObject({
      type: 'useBasicSkill', pieceId: 'red-core', skillId: 'hand-cannon', targetPieceId: 'blue-core',
    })
    expect(decision.trace.find(item => item.candidateId === decision.nextAction?.id)?.staticValue)
      .toBe(DEFAULT_ZERO_STAGE_CONFIG.terminal.win)
  })

  it('always selects a winning transition even when a nonterminal position scores above one million', () => {
    const pieces = Array.from({ length: 60 }, (_, index) => makePiece({
      instanceId: `red-${index}`,
      ownerPlayerId: 'player-red',
      x: index,
      y: 0,
    }))
    pieces.push(makePiece({
      instanceId: 'blue-core', ownerPlayerId: 'player-blue', x: 70, y: 0,
    }))
    const state = makeState({ width: 72, height: 2, pieces }) as any
    state.pieces.at(-1).isCore = true
    const win = candidate('force-win', 'fixture-win')
    const hold = candidate('hold-rich-position', 'fixture-hold')
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      listLegalActions: () => [hold, win],
      simulate: (current, input) => {
        const selected = 'action' in input ? input : hold
        const next = structuredClone(current) as any
        if (selected.id === win.id) {
          next.terminalResult = {
            status: 'finished', winnerPlayerId: 'player-red', loserPlayerId: 'player-blue',
            reason: 'core-eliminated', settledAt: {
              actionIndex: 1, actionType: selected.action.type, actorPlayerId: 'player-red',
              turnNumber: 1, phase: 'action', completedRound: 0,
            },
          }
        }
        return accepted(next, selected)
      },
    }

    const decision = planZeroStageAction(state, 'player-red', ROOT_SEED, { environment })
    const holdValue = decision.trace.find(item => item.candidateId === hold.id)?.staticValue
    expect(holdValue).toBeGreaterThan(DEFAULT_ZERO_STAGE_CONFIG.terminal.win)
    expect(decision.nextAction?.id).toBe(win.id)
    expect(decision.selectionReason).toBe('terminal-outcome')
  })

  it('locks deployment instead of repeating a position-improving deployment choice', () => {
    const state = combatState() as any
    state.deployment = {
      status: 'awaiting-locks',
      playerIds: ['player-red', 'player-blue'],
      choices: {},
      initialPositions: {},
      locks: { 'player-red': { locked: false }, 'player-blue': { locked: true } },
      deadlineAt: 0,
      revision: 1,
    }
    const choose = {
      protocolVersion: 1, id: 'repeat-deployment-choice', kind: 'deployment-choice',
      action: { type: 'deploymentChoice', playerId: 'player-red', pieceId: 'red-core' },
    } satisfies CandidateAction
    const lock = {
      protocolVersion: 1, id: 'finish-deployment', kind: 'deployment-lock',
      action: { type: 'deploymentLock', playerId: 'player-red' },
    } satisfies CandidateAction
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      listLegalActions: () => [choose, lock],
      simulate: (current, input) => {
        const selected = 'action' in input ? input : lock
        const next = structuredClone(current) as any
        if (selected.kind === 'deployment-choice') {
          next.pieces[0].x = 2
          next.pieces[0].y = 1
        } else {
          next.deployment.locks['player-red'].locked = true
        }
        return accepted(next, selected)
      },
    }

    const decision = planZeroStageAction(state, 'player-red', ROOT_SEED, { environment })
    expect(decision.trace.find(item => item.candidateId === choose.id)
      ?.evaluation?.components.enemyProximity.raw).toBe(0)
    expect(decision.nextAction?.id).toBe(lock.id)
  })

  it('simulates each legal candidate exactly once, selects max F, and repeats deterministically', () => {
    const state = combatState() as any
    const outerA = candidate('outer-a', 'fixture-a')
    const outerB = candidate('outer-b', 'fixture-b')
    const simulationCounts = new Map<string, number>()
    const simulationModes: Array<string | undefined> = []
    const simulationIndexes: Array<NonNullable<Parameters<AIEnvironment['simulate']>[2]>['stateHashIndex']> = []
    let legalCalls = 0
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      listLegalActions: () => {
        legalCalls += 1
        return [outerB, outerA]
      },
      simulate: (current, input, context) => {
        const selected = 'action' in input ? input : candidate('raw', input.type)
        simulationModes.push(context?.simulationMode)
        simulationIndexes.push(context?.stateHashIndex)
        simulationCounts.set(selected.id, (simulationCounts.get(selected.id) ?? 0) + 1)
        const next = structuredClone(current) as any
        if (selected.id === 'outer-b') next.pieces.find((piece: any) => piece.instanceId === 'blue-core').currentHp -= 20
        if (selected.kind === 'end-turn') next.turn.currentPlayerId = 'player-blue'
        return accepted(next, selected)
      },
    }

    const first = planZeroStageAction(state, 'player-red', ROOT_SEED, { environment })
    expect(first.nextAction?.id).toBe('outer-b')
    expect(first.nodesVisited).toBe(2)
    expect(first.candidatesConsidered).toBe(2)
    expect(legalCalls).toBe(1)
    expect(Object.fromEntries(simulationCounts)).toEqual({ 'outer-b': 1, 'outer-a': 1 })
    expect(simulationModes).toEqual(['evaluation', 'evaluation'])
    expect(simulationIndexes[0]?.rootHash).toBe(hashBattleState(state))
    expect(simulationIndexes[1]).toBe(simulationIndexes[0])
    expect(first.trace.every(item => item.evaluation !== undefined)).toBe(true)

    simulationCounts.clear()
    simulationModes.length = 0
    legalCalls = 0
    const second = planZeroStageAction(state, 'player-red', ROOT_SEED, { environment })
    expect(zeroStageDecisionTraceHash(second)).toBe(zeroStageDecisionTraceHash(first))
    expect(Object.fromEntries(simulationCounts)).toEqual({ 'outer-b': 1, 'outer-a': 1 })
  })

  it('locks the profile to full legal-candidate enumeration', () => {
    expect(resolveZeroStageConfig().candidateMode).toBe('all-legal')
    expect(() => resolveZeroStageConfig({ candidateMode: 'budgeted' } as any))
      .toThrow(/candidate mode must be all-legal/)
  })

  it('ends the turn instead of spending resources when successor evaluations are equal', () => {
    const state = combatState()
    const move = {
      protocolVersion: 1, id: 'move-costs-one', kind: 'move',
      action: { type: 'move', playerId: 'player-red', pieceId: 'red-core', toX: 1, toY: 2 },
    } satisfies CandidateAction
    const end = candidate('end-costs-zero', 'endTurn')
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      listLegalActions: () => [move, end],
      simulate: (current, input) => accepted(structuredClone(current), 'action' in input ? input : end),
    }
    const decision = planZeroStageAction(state, 'player-red', ROOT_SEED, { environment })
    expect(decision.nextAction?.id).toBe('end-costs-zero')
    expect(decision.selectionReason).toBe('end-turn')
  })

  it('ends the turn instead of spending AP to retreat from a better pursuit position', () => {
    const state = makeState({
      width: 20,
      height: 16,
      pieces: [
        makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red', x: 3, y: 11, moveRange: 3 }),
        makePiece({ instanceId: 'blue-core', ownerPlayerId: 'player-blue', x: 17, y: 7, moveRange: 3 }),
      ],
    }) as any
    state.pieces[0].isCore = true
    state.pieces[1].isCore = true
    state.players[0].maxActionPoints = 8
    state.players[0].actionPoints = 8
    const retreat = {
      protocolVersion: 1, id: 'retreat-and-spend', kind: 'move',
      action: { type: 'move', playerId: 'player-red', pieceId: 'red-core', toX: 3, toY: 12 },
    } satisfies CandidateAction
    const end = candidate('end-from-better-position', 'endTurn')
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      listLegalActions: () => [retreat, end],
      simulate: (current, input) => {
        const selected = 'action' in input ? input : end
        const next = structuredClone(current) as any
        if (selected.action.type === 'move') {
          next.pieces[0].x = selected.action.toX
          next.pieces[0].y = selected.action.toY
          next.players[0].actionPoints -= 1
        } else {
          next.turn.currentPlayerId = 'player-blue'
        }
        return accepted(next, selected)
      },
    }

    const decision = planZeroStageAction(state, 'player-red', ROOT_SEED, { environment })
    const retreatEvaluation = decision.trace.find(item => item.candidateId === retreat.id)?.evaluation
    const endEvaluation = decision.trace.find(item => item.candidateId === end.id)?.evaluation
    expect(endEvaluation?.components.strategicPosition.raw)
      .toBeGreaterThan(retreatEvaluation?.components.strategicPosition.raw ?? Number.NEGATIVE_INFINITY)
    expect(decision.nextAction?.id).toBe(end.id)
  })

  it('pursues enemy cores instead of a larger cluster of expendable summons', () => {
    const summons = Array.from({ length: 7 }, (_, index) => makePiece({
      instanceId: `blue-summon-${index}`,
      ownerPlayerId: 'player-blue',
      x: index % 2,
      y: 2 + index,
      moveRange: 1,
      attack: 2,
      maxHp: 99,
      currentHp: 99,
    }))
    const state = makeState({
      width: 21,
      height: 11,
      pieces: [
        makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red', x: 10, y: 5, moveRange: 3 }),
        makePiece({ instanceId: 'blue-core', ownerPlayerId: 'player-blue', x: 20, y: 5, moveRange: 3 }),
        ...summons,
      ],
    }) as any
    state.pieces[0].isCore = true
    state.pieces[1].isCore = true
    const pursueCore = {
      protocolVersion: 1, id: 'pursue-core', kind: 'move',
      action: { type: 'move', playerId: 'player-red', pieceId: 'red-core', toX: 13, toY: 5 },
    } satisfies CandidateAction
    const pursueSummons = {
      protocolVersion: 1, id: 'pursue-summons', kind: 'move',
      action: { type: 'move', playerId: 'player-red', pieceId: 'red-core', toX: 7, toY: 5 },
    } satisfies CandidateAction
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      listLegalActions: () => [pursueSummons, pursueCore],
      simulate: (current, input) => {
        const selected = 'action' in input ? input : pursueCore
        const next = structuredClone(current) as any
        if (selected.action.type === 'move') {
          next.pieces[0].x = selected.action.toX
          next.pieces[0].y = selected.action.toY
          next.players[0].actionPoints -= 1
        }
        return accepted(next, selected)
      },
    }

    const decision = planZeroStageAction(state, 'player-red', ROOT_SEED, { environment })
    expect(decision.nextAction?.id).toBe(pursueCore.id)
  })

  it('continues pursuing an equal enemy after reaching the map center', () => {
    const state = makeState({
      width: 21,
      height: 11,
      pieces: [
        makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red', x: 10, y: 5, moveRange: 1 }),
        makePiece({ instanceId: 'blue-core', ownerPlayerId: 'player-blue', x: 20, y: 5, moveRange: 1 }),
      ],
    }) as any
    state.pieces.forEach((piece: any) => { piece.isCore = true })

    const decision = planZeroStageAction(state, 'player-red', ROOT_SEED)
    expect(decision.nextAction?.action).toMatchObject({ type: 'move', toX: 11, toY: 5 })
  })

  it('keeps closing to attack distance instead of saturating at move-plus-attack reach', () => {
    const state = makeState({
      width: 11,
      height: 5,
      pieces: [
        makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red', x: 5, y: 2, moveRange: 3 }),
        makePiece({ instanceId: 'blue-core', ownerPlayerId: 'player-blue', x: 8, y: 2, moveRange: 3 }),
      ],
    }) as any
    state.pieces.forEach((piece: any) => { piece.isCore = true })

    const decision = planZeroStageAction(state, 'player-red', ROOT_SEED)
    expect(decision.nextAction?.action).toMatchObject({ type: 'move', toX: 7, toY: 2 })
  })

  it('focuses damage on an enemy core instead of clearing a disposable non-core piece', () => {
    const state = makeState({
      width: 7,
      height: 5,
      pieces: [
        makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red', x: 2, y: 2, attack: 6 }),
        makePiece({ instanceId: 'blue-core', ownerPlayerId: 'player-blue', x: 3, y: 2, maxHp: 12, currentHp: 12 }),
        makePiece({ instanceId: 'blue-summon', ownerPlayerId: 'player-blue', x: 2, y: 3, maxHp: 1, currentHp: 1 }),
      ],
    }) as any
    state.pieces[0].isCore = true
    state.pieces[1].isCore = true
    const damageCore = candidate('damage-core', 'fixture-damage-core')
    const clearSummon = candidate('clear-summon', 'fixture-clear-summon')
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      listLegalActions: () => [clearSummon, damageCore],
      simulate: (current, input) => {
        const selected = 'action' in input ? input : damageCore
        const next = structuredClone(current) as any
        if (selected.id === damageCore.id) {
          next.pieces.find((piece: any) => piece.instanceId === 'blue-core').currentHp -= 3
        } else {
          const index = next.pieces.findIndex((piece: any) => piece.instanceId === 'blue-summon')
          const [removed] = next.pieces.splice(index, 1)
          removed.currentHp = 0
          next.graveyard.push(removed)
        }
        return accepted(next, selected)
      },
    }

    expect(planZeroStageAction(state, 'player-red', ROOT_SEED, { environment }).nextAction?.id)
      .toBe(damageCore.id)
  })

  it('executes a nonterminal core kill instead of preserving duplicated lethal opportunities', () => {
    const state = makeState({
      width: 7,
      height: 5,
      pieces: [
        makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red', x: 1, y: 2, attack: 20 }),
        makePiece({ instanceId: 'red-attacker-1', ownerPlayerId: 'player-red', x: 1, y: 1, attack: 20 }),
        makePiece({ instanceId: 'red-attacker-2', ownerPlayerId: 'player-red', x: 1, y: 3, attack: 20 }),
        makePiece({ instanceId: 'blue-wounded-core', ownerPlayerId: 'player-blue', x: 2, y: 2, maxHp: 10, currentHp: 1 }),
        makePiece({ instanceId: 'blue-healthy-core', ownerPlayerId: 'player-blue', x: 5, y: 2, maxHp: 30, currentHp: 30 }),
      ],
    }) as any
    state.pieces[0].isCore = true
    state.pieces[3].isCore = true
    state.pieces[4].isCore = true
    const kill = candidate('kill-wounded-core', 'fixture-kill')
    const end = candidate('preserve-lethal-and-end', 'endTurn')
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      listLegalActions: () => [end, kill],
      simulate: (current, input) => {
        const selected = 'action' in input ? input : end
        const next = structuredClone(current) as any
        if (selected.id === kill.id) {
          const index = next.pieces.findIndex((piece: any) => piece.instanceId === 'blue-wounded-core')
          const [removed] = next.pieces.splice(index, 1)
          removed.currentHp = 0
          next.graveyard.push(removed)
        }
        return accepted(next, selected)
      },
    }

    expect(planZeroStageAction(state, 'player-red', ROOT_SEED, { environment }).nextAction?.id)
      .toBe(kill.id)
  })

  it('prefers moving toward immediate enemy coverage over an equally costly retreat', () => {
    const state = makeState({
      width: 9,
      height: 5,
      pieces: [
        makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red', x: 1, y: 2, moveRange: 3, attack: 16 }),
        makePiece({ instanceId: 'blue-core', ownerPlayerId: 'player-blue', x: 7, y: 2, moveRange: 1, attack: 4 }),
      ],
    }) as any
    state.pieces[0].isCore = true
    state.pieces[1].isCore = true
    const advance = {
      protocolVersion: 1, id: 'advance', kind: 'move',
      action: { type: 'move', playerId: 'player-red', pieceId: 'red-core', toX: 4, toY: 2 },
    } satisfies CandidateAction
    const retreat = {
      protocolVersion: 1, id: 'retreat', kind: 'move',
      action: { type: 'move', playerId: 'player-red', pieceId: 'red-core', toX: 0, toY: 2 },
    } satisfies CandidateAction
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      listLegalActions: () => [retreat, advance],
      simulate: (current, input) => {
        const selected = 'action' in input ? input : advance
        const next = structuredClone(current) as any
        if (selected.action.type === 'move') {
          next.pieces[0].x = selected.action.toX
          next.pieces[0].y = selected.action.toY
          next.players[0].actionPoints = Math.max(0, next.players[0].actionPoints - 1)
        }
        return accepted(next, selected)
      },
    }

    const decision = planZeroStageAction(state, 'player-red', ROOT_SEED, { environment })
    expect(decision.nextAction?.id).toBe(advance.id)
    expect(decision.trace.find(item => item.candidateId === advance.id)?.evaluation
      ?.components.futureAttackPotential.raw)
      .toBeGreaterThan(decision.trace.find(item => item.candidateId === retreat.id)?.evaluation
        ?.components.futureAttackPotential.raw ?? Number.NEGATIVE_INFINITY)
  })

  it('prefers the central route when equal-cost moves are equally close to the enemy core', () => {
    const state = makeState({
      width: 9,
      height: 9,
      pieces: [
        makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red', x: 0, y: 4 }),
        makePiece({ instanceId: 'red-flanker', ownerPlayerId: 'player-red', x: 4, y: 0, moveRange: 4 }),
        makePiece({ instanceId: 'blue-core', ownerPlayerId: 'player-blue', x: 8, y: 4 }),
      ],
    }) as any
    state.pieces[0].isCore = true
    state.pieces[2].isCore = true
    const center = {
      protocolVersion: 1, id: 'move-center', kind: 'move',
      action: { type: 'move', playerId: 'player-red', pieceId: 'red-flanker', toX: 4, toY: 4 },
    } satisfies CandidateAction
    const edge = {
      protocolVersion: 1, id: 'move-edge', kind: 'move',
      action: { type: 'move', playerId: 'player-red', pieceId: 'red-flanker', toX: 8, toY: 0 },
    } satisfies CandidateAction
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      listLegalActions: () => [edge, center],
      simulate: (current, input) => {
        const selected = 'action' in input ? input : center
        const next = structuredClone(current) as any
        const action = selected.action
        if (action.type === 'move') {
          const mover = next.pieces.find((piece: any) => piece.instanceId === action.pieceId)
          mover.x = action.toX
          mover.y = action.toY
          next.players[0].actionPoints = Math.max(0, next.players[0].actionPoints - 1)
        }
        return accepted(next, selected)
      },
    }

    const decision = planZeroStageAction(state, 'player-red', ROOT_SEED, { environment })
    const centerPosition = decision.trace.find(item => item.candidateId === center.id)
      ?.evaluation?.components.strategicPosition.raw
    const edgePosition = decision.trace.find(item => item.candidateId === edge.id)
      ?.evaluation?.components.strategicPosition.raw

    expect(centerPosition).toBeGreaterThan(edgePosition ?? Number.NEGATIVE_INFINITY)
    expect(decision.nextAction?.id).toBe(center.id)
  })

  it('admits an enemy-closing move ahead of an equal-cost self-buff in a stalled position', () => {
    const selfBuff = skill('naruto-sage-mode')
    const state = makeState({
      width: 11,
      height: 7,
      pieces: [
        makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red', x: 0, y: 3, moveRange: 3 }),
        makePiece({ instanceId: 'blue-core', ownerPlayerId: 'player-blue', x: 10, y: 3 }),
      ],
    }) as any
    state.pieces[0].isCore = true
    state.pieces[1].isCore = true
    state.pieces[0].skills = [{ skillId: selfBuff.id, currentCooldown: 0, usesRemaining: -1 }]
    state.skillsById[selfBuff.id] = selfBuff
    const advance = {
      protocolVersion: 1, id: 'advance-from-stall', kind: 'move',
      action: { type: 'move', playerId: 'player-red', pieceId: 'red-core', toX: 3, toY: 3 },
    } satisfies CandidateAction
    const meditate = {
      protocolVersion: 1, id: 'self-buff-in-stall', kind: 'basic-skill',
      action: {
        type: 'useBasicSkill', playerId: 'player-red', pieceId: 'red-core', skillId: selfBuff.id,
      },
    } satisfies CandidateAction
    const end = candidate('end-stalled-turn', 'endTurn')
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      listLegalActions: () => [meditate, advance, end],
      simulate: (current, input) => {
        const selected = 'action' in input ? input : end
        const next = structuredClone(current) as any
        const action = selected.action
        if (action.type === 'move') {
          next.pieces[0].x = action.toX
          next.pieces[0].y = action.toY
          next.players[0].actionPoints -= 1
        } else if (action.type === 'useBasicSkill') {
          next.pieces[0].buffs = [
            ...(next.pieces[0].buffs ?? []),
            { id: 'self-buff', name: 'Self buff', type: 'self-buff' },
          ]
          next.players[0].actionPoints -= 1
        }
        return accepted(next, selected)
      },
    }

    const decision = planZeroStageAction(state, 'player-red', ROOT_SEED, { environment })
    expect(decision.nodesVisited).toBe(3)
    expect(decision.candidatesConsidered).toBe(3)
    expect(decision.trace.every(item => item.pruned === undefined)).toBe(true)
    expect(decision.trace.every(item => item.evaluation !== undefined)).toBe(true)
    expect(decision.nextAction?.id).toBe(advance.id)
  })

  it('ends the turn instead of repeating a zero-cost action when F is unchanged', () => {
    const state = combatState()
    const repeat = candidate('repeat-no-op', 'fixture-repeat')
    const end = candidate('end-no-op', 'endTurn')
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      listLegalActions: () => [repeat, end],
      simulate: (current, input) => accepted(
        structuredClone(current),
        'action' in input ? input : end,
      ),
    }

    const decision = planZeroStageAction(state, 'player-red', ROOT_SEED, { environment })
    expect(decision.nextAction?.id).toBe(end.id)
    expect(decision.selectionReason).toBe('end-turn')
  })

  it('scores every fallback after an authority-blocked skill instead of ending early', () => {
    const state = combatState() as any
    const attack = skill('hand-cannon')
    state.pieces[0].skills = [{ skillId: attack.id, currentCooldown: 0, usesRemaining: -1 }]
    state.skillsById[attack.id] = attack
    state.pieces[1].x = 2
    const blocked = aiEnvironmentV1.listLegalActions(state, 'player-red')
      .find(item => item.kind === 'basic-skill')
    expect(blocked).toBeDefined()
    const attackFallback = candidate('attack-after-block', 'fixture-attack')
    const end = candidate('end-after-block', 'endTurn')
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      // Deliberately model a stale/leaked candidate returned immediately after the status changed.
      listLegalActions: () => [blocked!, attackFallback, end],
      simulate: (current, input) => {
        const selected = 'action' in input ? input : end
        const next = structuredClone(current) as any
        if (selected.id === attackFallback.id) next.pieces[1].currentHp = 0
        const transition = accepted(next, selected)
        if (selected.id === blocked!.id) {
          transition.trace.blocked = true
        }
        return transition
      },
    }

    const decision = planZeroStageAction(state, 'player-red', ROOT_SEED, { environment })
    const blockedSkill = decision.trace.find(item => (
      item.action.type === 'useBasicSkill' || item.action.type === 'useChargeSkill'
    ))

    expect(blockedSkill).toMatchObject({ blocked: true })
    expect(blockedSkill?.evaluation).toBeUndefined()
    expect(decision.nodesVisited).toBe(3)
    expect(decision.trace.every(item => item.pruned === undefined)).toBe(true)
    expect(decision.nextAction?.id).toBe(attackFallback.id)
  })

  it('scores every fallback after an authority-rejected candidate instead of ending early', () => {
    const state = combatState()
    const rejected = candidate('stale-rejected', 'fixture-stale')
    const winningFallback = candidate('win-after-rejection', 'fixture-attack')
    const end = candidate('end-after-rejection', 'endTurn')
    const simulationCounts = new Map<string, number>()
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      listLegalActions: () => [rejected, winningFallback, end],
      simulate: (current, input) => {
        const selected = 'action' in input ? input : end
        simulationCounts.set(selected.id, (simulationCounts.get(selected.id) ?? 0) + 1)
        if (selected.id === rejected.id) {
          return {
            protocolVersion: 1,
            accepted: false,
            state: current,
            stateHash: hashBattleState(current),
            transitionHash: hashStable({ rejected: selected.id }),
            error: {
              code: 'FIXTURE_REJECTED',
              name: 'BattleRuleError',
              message: 'fixture rejection',
            },
            trace: { actionLog: [], stateChanges: [] },
          }
        }
        const next = structuredClone(current) as any
        if (selected.id === winningFallback.id) next.pieces[1].currentHp = 0
        return accepted(next, selected)
      },
    }

    const decision = planZeroStageAction(state, 'player-red', ROOT_SEED, { environment })
    const rejectedTrace = decision.trace.find(item => item.candidateId === rejected.id)

    expect(Object.fromEntries(simulationCounts)).toEqual({
      'stale-rejected': 1,
      'win-after-rejection': 1,
      'end-after-rejection': 1,
    })
    expect(decision.nodesVisited).toBe(3)
    expect(rejectedTrace).toMatchObject({ rejected: 'FIXTURE_REJECTED' })
    expect(rejectedTrace?.evaluation).toBeUndefined()
    expect(decision.nextAction?.id).toBe(winningFallback.id)
  })

  it('forces the reserved end-turn action at the configured turn-action limit', () => {
    const state = combatState()
    const improve = candidate('improve', 'fixture-improve')
    const end = candidate('end-at-limit', 'endTurn')
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      listLegalActions: () => [improve, end],
      simulate: (current, input) => {
        const selected = 'action' in input ? input : end
        const next = structuredClone(current) as any
        if (selected.id === improve.id) next.pieces[1].currentHp = 1
        return accepted(next, selected)
      },
    }
    const decision = planZeroStageAction(state, 'player-red', ROOT_SEED, {
      environment,
      actionsTakenThisTurn: DEFAULT_ZERO_STAGE_CONFIG.maxActionsPerTurn - 1,
    })

    expect(decision.nextAction?.id).toBe(end.id)
    expect(decision.nodesVisited).toBe(1)
    expect(decision.trace.find(item => item.candidateId === improve.id)?.pruned)
      .toBe('turn-action-budget')
  })

  it('prefers removing an immediate public core threat over a neutral action', () => {
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
    const decision = planZeroStageAction(state, 'player-red', ROOT_SEED, { environment })
    expect(decision.nextAction?.id).toBe('safe')
  })

  it('evaluates every legal outer candidate without a second search layer', () => {
    const state = combatState()
    const first = candidate('first', 'fixture-first')
    const second = candidate('second', 'fixture-second')
    const third = candidate('third', 'fixture-third')
    let simulations = 0
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      listLegalActions: () => [first, second, third],
      simulate: (current, input) => {
        simulations += 1
        return accepted(structuredClone(current), 'action' in input ? input : first)
      },
    }
    const decision = planZeroStageAction(state, 'player-red', ROOT_SEED, { environment })
    expect(decision.nodesVisited).toBe(3)
    expect(decision.candidatesConsidered).toBe(3)
    expect(simulations).toBe(3)
    expect(decision.budgetExhausted).toBe(false)
    expect(decision.trace.every(item => item.pruned === undefined)).toBe(true)
  })

  it('evaluates end turn and every action in a crowded legal set', () => {
    const state = combatState() as any
    const actions = Array.from({ length: 20 }, (_, index) => candidate(`repeat-${index}`, 'fixture-repeat'))
    const end = candidate('end-now', 'endTurn')
    const environment: AIEnvironment = {
      ...aiEnvironmentV1,
      listLegalActions: () => [...actions, end],
      simulate: (current, input) => {
        const selected = 'action' in input ? input : end
        const next = structuredClone(current) as any
        if (selected.kind === 'end-turn') {
          next.turn.currentPlayerId = 'player-blue'
        } else {
          next.actions.push({
            type: 'move', playerId: 'player-red', turn: next.turn.turnNumber,
          })
        }
        return accepted(next, selected)
      },
    }
    const decision = planZeroStageAction(state, 'player-red', ROOT_SEED, { environment })

    expect(decision.candidatesConsidered).toBe(21)
    expect(decision.nodesVisited).toBe(21)
    expect(decision.budgetExhausted).toBe(false)
    expect(decision.trace.every(item => item.pruned === undefined)).toBe(true)
    expect(decision.nextAction?.id).toBe(end.id)
    expect(decision.selectionReason).toBe('end-turn')
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

  it('records two 8v8 roster variants on both seats for legality, nodes, determinism, and timing', () => {
    const durations: number[] = []
    let nodes = 0
    let candidates = 0
    let illegalActions = 0
    const samples = 4

    for (let index = 0; index < samples; index += 1) {
      const activePlayerId = index % 2 === 0 ? 'player-red' : 'player-blue'
      const rosterVariant = Math.floor(index / 2)
      const pieces = []
      for (let slot = 0; slot < 8; slot += 1) {
        pieces.push(makePiece({
          instanceId: `red-${slot}`, ownerPlayerId: 'player-red', faction: 'red',
          x: 1 + (slot % 2), y: 2 + slot,
          moveRange: rosterVariant === 0 ? 2 : 1 + (slot % 3),
          attack: rosterVariant === 0 ? 10 : 6 + slot * 2,
          currentHp: rosterVariant === 0 ? 100 : 45 + slot * 6,
        }))
        pieces.push(makePiece({
          instanceId: `blue-${slot}`, ownerPlayerId: 'player-blue', faction: 'blue',
          x: 14 + (slot % 2), y: 2 + slot,
          moveRange: rosterVariant === 0 ? 2 : 3 - (slot % 3),
          attack: rosterVariant === 0 ? 10 : 20 - slot,
          currentHp: rosterVariant === 0 ? 100 : 90 - slot * 5,
        }))
      }
      const state = makeState({ pieces, currentPlayerId: activePlayerId, width: 18, height: 12 }) as any
      for (const piece of state.pieces) piece.isCore = piece.instanceId.endsWith('-0')
      const activePlayer = state.players.find((player: any) => player.playerId === activePlayerId)
      activePlayer.actionPoints = 1
      activePlayer.maxActionPoints = 1
      const sampleSeed = ROOT_SEED + index

      const started = performance.now()
      const decision = planZeroStageAction(state, activePlayerId, sampleSeed)
      durations.push(performance.now() - started)
      nodes += decision.nodesVisited
      candidates += decision.candidatesConsidered
      expect(decision.nodesVisited, `seed ${sampleSeed}`)
        .toBe(decision.candidatesConsidered)
      expect(decision.budgetExhausted, `seed ${sampleSeed}`).toBe(false)
      expect(decision.trace.every(item => item.pruned === undefined), `seed ${sampleSeed}`).toBe(true)
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
    const maximum = sorted.at(-1) ?? 0
    console.info(
      `[RED-122 performance] samples=${samples} seats=2 roster=8 variants=2 illegal=${illegalActions} `
      + `nodes=${nodes} candidates=${candidates} p50Ms=${p50.toFixed(2)} `
      + `p95Ms=${p95.toFixed(2)} maxMs=${maximum.toFixed(2)}`,
    )
    expect(illegalActions).toBe(0)
    expect(p50).toBeGreaterThanOrEqual(0)
    expect(p95).toBeGreaterThanOrEqual(p50)
    expect(maximum).toBeGreaterThanOrEqual(p95)
  }, 120_000)
})
