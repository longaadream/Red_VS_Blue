/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures exercise serialized game-data contracts. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import { runInNewContext } from 'node:vm'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AI_ENVIRONMENT_CAPABILITIES,
  AI_ENVIRONMENT_V2_CAPABILITIES,
  aiEnvironmentV1,
  aiEnvironmentV2,
  listLegalAIActions,
  observeBattleForAI,
  simulateAITransition,
} from '@/lib/game/ai-environment'
import { generateBotActions, planBotActions, prepareLegalBotAction } from '@/lib/game/ai'
import type { AIEnvironment, AIPendingOptionDecisionSpaceV2, AIPendingTargetDecisionSpaceV2, CandidateAction } from '@/lib/game/ai-types'
import { hashStable, stableJson } from '@/lib/game/battle-trace'
import { finalizePendingOptionSession } from '@/lib/game/pending-interaction'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { finalizePendingTargetSession, getTargetingStateRevision, prepareAction } from '@/lib/game/targeting'
import { getLegalNormalMoveTargetsForPlayer } from '@/lib/game/spatial'
import { loadRuleById } from '@/lib/game/skills'
import { makePiece, makeState } from '../helpers/minimal-state'

const FIXED_SEED = 0x84c0ffee

function activeSkill(id: string, targeting: any, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    description: id,
    kind: 'active',
    type: 'normal',
    cooldownTurns: 0,
    maxCharges: 0,
    powerMultiplier: 1,
    actionPointCost: 0,
    range: 'self',
    requiresTarget: !!targeting?.steps?.some((step: any) => step.kind === 'target'),
    targeting,
    code: "function executeSkill(context) { context.battle.extensions.executed = context.skill.id; return { success: true, message: 'executed' }; }",
    ...overrides,
  }
}

function reserveCore(instanceId: string, ownerPlayerId: 'player-red' | 'player-blue') {
  const piece = makePiece({
    instanceId,
    templateId: `template-${instanceId}`,
    ownerPlayerId,
    faction: ownerPlayerId === 'player-red' ? 'red' : 'blue',
    moveRange: 2,
  }) as any
  piece.name = instanceId
  piece.isCore = true
  piece.x = null
  piece.y = null
  return piece
}

function progressiveDeploymentFixture(options: {
  width?: number
  height?: number
  redPosition?: { x: number; y: number }
  bluePosition?: { x: number; y: number }
  legalPositions?: Array<{ x: number; y: number }>
} = {}) {
  const redPosition = options.redPosition ?? { x: 0, y: 0 }
  const bluePosition = options.bluePosition ?? { x: 1, y: 0 }
  const red = makePiece({
    instanceId: 'red-vanguard',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: redPosition.x,
    y: redPosition.y,
  }) as any
  const blue = makePiece({
    instanceId: 'blue-vanguard',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: bluePosition.x,
    y: bluePosition.y,
  }) as any
  red.name = 'red-vanguard'
  red.isCore = true
  blue.name = 'blue-vanguard'
  blue.isCore = true
  const redOffers = [reserveCore('red-reserve-a', 'player-red'), reserveCore('red-reserve-b', 'player-red')]
  const blueReserve = reserveCore('blue-secret-reserve', 'player-blue')
  const state = makeState({
    pieces: [red, blue],
    currentPlayerId: 'player-red',
    phase: 'start',
    width: options.width ?? 8,
    height: options.height ?? 3,
  }) as any
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
      [red.instanceId]: redPosition,
      [blue.instanceId]: bluePosition,
    },
    reserves: {
      'player-red': redOffers,
      'player-blue': [blueReserve],
    },
    reserveCounts: { 'player-red': redOffers.length, 'player-blue': 1 },
    activePlayerId: 'player-red',
    offerTurnNumber: state.turn.turnNumber,
    offerPieceIds: redOffers.map(piece => piece.instanceId),
    legalPositions: options.legalPositions ?? [{ x: 6, y: 2 }, { x: 7, y: 2 }],
  }
  return state
}

function makeSilencedActionFixture() {
  const caster = makePiece({ instanceId: 'silenced-caster', ownerPlayerId: 'player-red', x: 1, y: 1, moveRange: 2 }) as any
  const enemy = makePiece({ instanceId: 'silenced-enemy', ownerPlayerId: 'player-blue', x: 3, y: 1 }) as any
  const silencedRule = loadRuleById('rule-silenced-block', true)
  if (!silencedRule) throw new Error('Expected rule-silenced-block fixture')
  caster.statusTags = [{
    id: 'silenced-silenced-caster', type: 'silenced', name: '沉默', visible: true,
    remainingDuration: 1, remainingUses: -1, intensity: 1, stacks: 1,
    relatedRules: ['rule-silenced-block'],
    blocksSkillUse: true,
    skillBlockMessage: 'Source piece is silenced',
  }]
  caster.rules = [silencedRule]
  caster.skills = [
    { skillId: 'silenced-basic', currentCooldown: 0, usesRemaining: -1 },
    { skillId: 'silenced-charge', currentCooldown: 0, usesRemaining: 1 },
  ]
  const state = makeState({ pieces: [enemy, caster], width: 5, height: 4 }) as any
  state.players[0].actionPoints = 10
  state.players[0].chargePoints = 10
  state.skillsById['silenced-basic'] = activeSkill('silenced-basic', { steps: [] }, {
    actionPointCost: 2,
  })
  state.skillsById['silenced-charge'] = activeSkill('silenced-charge', { steps: [] }, {
    type: 'ultimate', actionPointCost: 2, chargeCost: 3,
  })
  state.players[0].hand = [{
    ...JSON.parse(readFileSync(resolve(process.cwd(), 'data/cards/lucky-coin.json'), 'utf8')),
    cardId: 'lucky-coin', instanceId: 'silenced-zero-card', ownerPlayerId: 'player-red',
  }]
  return { caster, state }
}

function loadBrowserEnvironment(): AIEnvironment {
  const bundlePath = resolve(process.cwd(), 'data/pages/js/game-engine.js')
  const source = readFileSync(bundlePath, 'utf8')
  const context: Record<string, unknown> = {
    Buffer,
    clearTimeout,
    console: { error: vi.fn(), log: vi.fn(), warn: vi.fn() },
    process,
    require: createRequire(import.meta.url),
    setTimeout,
    TextDecoder,
    TextEncoder,
  }
  runInNewContext(source, context, { filename: bundlePath })
  return (context.GameEngine as { aiEnvironmentV1: AIEnvironment }).aiEnvironmentV1
}

beforeEach(() => globalTriggerSystem.clearRules())
afterEach(() => globalTriggerSystem.clearRules())

describe('versioned headless AI environment', () => {
  it('projects player-visible state without opponent hand, hidden status, code, rules, or debug trace', () => {
    const red = makePiece({ instanceId: 'red-piece', ownerPlayerId: 'player-red' }) as any
    const blue = makePiece({ instanceId: 'blue-piece', ownerPlayerId: 'player-blue', x: 4, y: 4 }) as any
    blue.rules = [{ id: 'secret-rule', effect: () => 'secret' }]
    blue.privateRuntimePayload = { opponentPlan: 'secret-plan' }
    blue.statusTags = [
      { id: 'visible', type: 'visible', visible: true },
      { id: 'hidden', type: 'hidden', visible: false },
    ]
    const state = makeState({ pieces: [red, blue] }) as any
    state.players[0].hand = [{ cardId: 'red-card', instanceId: 'red-card-1', ownerPlayerId: 'player-red' }]
    state.players[1].hand = [{ cardId: 'blue-secret', instanceId: 'blue-card-1', ownerPlayerId: 'player-blue' }]
    state.players[1].statusTags = [{
      id: 'public-player-tag', type: 'aura', visible: true, intensity: 2,
      effectCode: 'secret-player-code', privatePayload: { plan: 'secret-player-plan' },
    }]
    state.extensions.debugBattle = { actionLog: [{ secret: true }], appliedActionIds: [] }
    state.pendingTargetSelection = {
      playerId: 'player-blue',
      effectCode: 'secret-code',
      targetType: 'piece',
      candidates: [{ type: 'piece', pieceId: 'red-piece' }],
    }

    const observation = observeBattleForAI(state, 'player-red')
    const json = JSON.stringify(observation)

    expect(observation.protocolVersion).toBe(1)
    expect(observation.players[0].hand?.[0].cardId).toBe('red-card')
    expect(observation.players[1]).toMatchObject({ handCount: 1, hand: undefined })
    expect(observation.pieces.find(piece => piece.instanceId === 'blue-piece')?.statusTags)
      .toEqual([{ id: 'visible', type: 'visible', visible: true }])
    expect(observation.pendingTargetSelection).toBeUndefined()
    expect(observation.players[1].statusTags).toEqual([{
      id: 'public-player-tag', type: 'aura', visible: true, intensity: 2,
    }])
    expect(json).not.toMatch(/blue-secret|secret-rule|secret-code|secret-plan|secret-player|debugBattle|actionLog/)
  })

  it('enumerates stable complete move, option/target skill, zero-cost card, and end-turn candidates', () => {
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 1, y: 1, moveRange: 2 }) as any
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 3, y: 1 }) as any
    caster.skills = [{ skillId: 'choice-shot', currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({ pieces: [enemy, caster], width: 5, height: 4 }) as any
    state.players[0].actionPoints = 10
    state.skillsById['choice-shot'] = activeSkill('choice-shot', {
      steps: [
        { kind: 'option', title: 'mode', options: [{ label: 'B', value: 'b' }, { label: 'A', value: 'a' }] },
        { kind: 'target', type: 'piece', filter: 'enemy', range: 3 },
      ],
    })
    state.players[0].hand = [{
      ...JSON.parse(readFileSync(resolve(process.cwd(), 'data/cards/lucky-coin.json'), 'utf8')),
      cardId: 'lucky-coin', instanceId: 'zero-card-1', ownerPlayerId: 'player-red',
    }]
    const before = stableJson(state)

    const first = listLegalAIActions(state, 'player-red')
    const second = listLegalAIActions(state, 'player-red')

    expect(second).toEqual(first)
    expect(stableJson(state)).toBe(before)
    expect(first.at(-1)?.kind).toBe('end-turn')
    expect(first.filter(item => item.kind === 'basic-skill')).toHaveLength(2)
    expect(first.some(item => item.kind === 'card' && item.action.type === 'playCard')).toBe(true)
    const legalMoves = getLegalNormalMoveTargetsForPlayer(state, 'player-red', 'caster')
    expect(first.filter(item => item.kind === 'move')).toHaveLength(legalMoves.length)
    for (const item of first.filter(item => item.kind === 'basic-skill' || item.kind === 'card')) {
      expect(prepareAction(state, item.action), item.id).toEqual({ kind: 'ready' })
    }
    for (const item of first) {
      expect(
        simulateAITransition(state, item, { rootSeed: FIXED_SEED }).accepted,
        `${item.kind}:${stableJson(item.action)}`,
      ).toBe(true)
    }
    expect(new Set(first.map(item => item.id)).size).toBe(first.length)
  })

  it('excludes silenced basic/charge skills without hiding other legal actions or mutating query inputs', () => {
    const { caster, state } = makeSilencedActionFixture()
    const beforeState = stableJson(state)
    const beforeStateHash = hashStable(state)
    const beforeRevision = getTargetingStateRevision(state)
    const beforeRules = [...globalTriggerSystem.getRules()]
    const beforeRuleLimits = beforeRules.map(rule => stableJson(rule.limits))
    const runtime = new RuleRuntime({ rootSeed: FIXED_SEED, cursors: { 'red-106-fixture': 7 }, tick: 3 })
    const beforeRuntime = runtime.snapshot()

    let first: CandidateAction[] = []
    let second: CandidateAction[] = []
    withRuleRuntime(runtime, () => {
      first = listLegalAIActions(state, 'player-red')
      second = listLegalAIActions(state, 'player-red')
    })

    expect(second).toEqual(first)
    expect(stableJson(state)).toBe(beforeState)
    expect(hashStable(state)).toBe(beforeStateHash)
    expect(getTargetingStateRevision(state)).toBe(beforeRevision)
    expect(runtime.snapshot()).toEqual(beforeRuntime)
    expect(globalTriggerSystem.getRules()).toEqual(beforeRules)
    expect(globalTriggerSystem.getRules().map(rule => stableJson(rule.limits))).toEqual(beforeRuleLimits)

    const leakedSkills = first.filter(item => item.kind === 'basic-skill' || item.kind === 'charge-skill')
    if (leakedSkills.length > 0) {
      const blocked = simulateAITransition(state, leakedSkills[0], { rootSeed: FIXED_SEED })
      expect(blocked.accepted).toBe(true)
      expect(stableJson(blocked.trace.actionLog)).toContain('已被沉默，无法使用技能')
    }
    expect(leakedSkills).toEqual([])
    expect(first.some(item => item.kind === 'move')).toBe(true)
    expect(first.some(item => item.kind === 'card')).toBe(true)
    expect(first.at(-1)?.kind).toBe('end-turn')
    for (const item of first.filter(candidate => candidate.kind !== 'basic-skill' && candidate.kind !== 'charge-skill')) {
      const transition = simulateAITransition(state, item, { rootSeed: FIXED_SEED })
      expect(transition.accepted, `${item.id}:${stableJson(item.action)}`).toBe(true)
      expect(stableJson(transition.trace.actionLog)).not.toContain('已被沉默，无法使用技能')
    }

    caster.statusTags = []
    expect(listLegalAIActions(state, 'player-red').filter(item => (
      item.kind === 'basic-skill' || item.kind === 'charge-skill'
    )).map(item => item.action.type)).toEqual(['useBasicSkill', 'useChargeSkill'])

    caster.statusTags = [{ id: 'plain-status', type: 'plain-status' }]
    caster.rules = []
    expect(listLegalAIActions(state, 'player-red').filter(item => (
      item.kind === 'basic-skill' || item.kind === 'charge-skill'
    )).map(item => item.action.type)).toEqual(['useBasicSkill', 'useChargeSkill'])

    const hasSkill = (skillId: string) => listLegalAIActions(state, 'player-red').some(item => (
      (item.action.type === 'useBasicSkill' || item.action.type === 'useChargeSkill') &&
      item.action.skillId === skillId
    ))
    caster.statusTags = []
    caster.skills[0].currentCooldown = 1
    expect(hasSkill('silenced-basic')).toBe(false)
    expect(hasSkill('silenced-charge')).toBe(true)

    caster.skills[0].currentCooldown = 0
    state.players[0].actionPoints = 0
    expect(hasSkill('silenced-basic')).toBe(false)
    expect(hasSkill('silenced-charge')).toBe(false)

    state.players[0].actionPoints = 10
    state.players[0].chargePoints = 0
    expect(hasSkill('silenced-basic')).toBe(true)
    expect(hasSkill('silenced-charge')).toBe(false)

    state.players[0].chargePoints = 10
    caster.skills[1].usesRemaining = 0
    expect(hasSkill('silenced-basic')).toBe(true)
    expect(hasSkill('silenced-charge')).toBe(false)
  })

  it('fails closed for non-player commands and exposes the admission matrix', () => {
    expect(AI_ENVIRONMENT_CAPABILITIES.unsupportedActionTypes.map(entry => entry.type))
      .toEqual(['deploymentTimeout', 'grantChargePoints', 'surrender'])
    expect(AI_ENVIRONMENT_CAPABILITIES.supportedActionTypes).toContain('pendingTargetSelect')
    expect(AI_ENVIRONMENT_CAPABILITIES.supportedActionTypes).toContain('deployReservePiece')
    expect(AI_ENVIRONMENT_CAPABILITIES.supportedActionTypes).not.toContain('deploymentFreeMove')
    expect(AI_ENVIRONMENT_CAPABILITIES.supportedActionTypes).not.toContain('deploymentSkipFreeMove')
  })

  it('records a large-board complete-candidate performance baseline without imposing a synthetic target', () => {
    const caster = makePiece({ instanceId: 'perf-caster', ownerPlayerId: 'player-red', x: 10, y: 8 }) as any
    caster.skills = [{ skillId: 'perf-global-cell', currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({ pieces: [caster], width: 20, height: 16 }) as any
    state.skillsById['perf-global-cell'] = activeSkill('perf-global-cell', {
      steps: [{ kind: 'target', type: 'cell', filter: 'all', range: 99 }],
    })

    const started = performance.now()
    const candidates = listLegalAIActions(state, 'player-red')
    const elapsedMs = performance.now() - started
    const targetCandidates = candidates.filter(item =>
      item.action.type === 'useBasicSkill' && item.action.skillId === 'perf-global-cell',
    )

    expect(targetCandidates).toHaveLength(320)
    console.info(`[RED-84 performance] board=20x16 candidates=${candidates.length} completeTargets=${targetCandidates.length} elapsedMs=${elapsedMs.toFixed(2)}`)
  })

  it('enumerates deployment, pending option, and a real rule-produced pending target', () => {
    const red = makePiece({ instanceId: 'red-core', ownerPlayerId: 'player-red' }) as any
    red.isCore = true
    const state = makeState({ pieces: [red] }) as any
    state.deployment = {
      status: 'awaiting-locks',
      playerIds: ['player-red', 'player-blue'],
      choices: { 'player-red': { pieceId: null }, 'player-blue': { pieceId: 'secret-core' } },
      locks: { 'player-red': { locked: false }, 'player-blue': { locked: false } },
      startedAt: 1,
      deadlineAt: 45_001,
      revision: 0,
      initialPositions: { 'red-core': { x: 0, y: 0 } },
    }
    expect(listLegalAIActions(state, 'player-red').map(item => item.kind))
      .toEqual(['deployment-choice', 'deployment-choice', 'deployment-lock'])
    expect(JSON.stringify(observeBattleForAI(state, 'player-red'))).not.toContain('secret-core')

    delete state.deployment
    state.pendingOptionSelection = {
      playerId: 'player-red', title: 'choose', options: ['中', 'ä', 'z'], cancelValue: 'z',
    }
    const optionCandidates = listLegalAIActions(state, 'player-red')
    expect(optionCandidates.map(item => item.kind))
      .toEqual(['pending-option', 'pending-option', 'pending-option', 'cancel-selection'])
    expect(optionCandidates.slice(0, 3).map(item => (
      item.action.type === 'pendingOptionSelect' ? item.action.selectedOption : undefined
    ))).toEqual(['z', 'ä', '中'])
    state.pendingOptionSelection = {
      playerId: 'player-red',
      title: 'choose holy cards',
      options: Array.from({ length: 10 }, (_, index) => ({ value: `holy-${index}` })),
      selectionMode: 'multi',
      presentation: 'hand',
      minSelections: 1,
      maxSelections: 4,
      canCancel: false,
    }
    const multiCandidates = listLegalAIActions(state, 'player-red')
    const multiOptions = multiCandidates.map(item => item.action.type === 'pendingOptionSelect' ? item.action.selectedOption : undefined)
    expect(multiCandidates).toHaveLength(13)
    expect(multiOptions.every(option => Array.isArray(option))).toBe(true)
    expect(Math.max(...multiOptions.map(option => Array.isArray(option) ? option.length : 0))).toBe(4)
    expect(observeBattleForAI(state, 'player-red').pendingOptionSelection)
      .toMatchObject({ selectionMode: 'multi', presentation: 'hand', minSelections: 1, maxSelections: 4 })

    const minato = makePiece({
      instanceId: 'minato', templateId: 'blue-minato', ownerPlayerId: 'player-red', x: 1, y: 1,
    }) as any
    minato.rules = [loadRuleById('rule-minato-anchor-end-turn', true)]
    const pendingSeed = makeState({ pieces: [minato], phase: 'action' }) as any
    const advance = listLegalAIActions(pendingSeed, 'player-red').find(item => item.kind === 'end-turn')
    if (!advance) throw new Error('Expected an authoritative end-turn action for Minato')
    const enteredPending = simulateAITransition(pendingSeed, advance, { rootSeed: FIXED_SEED })
    expect(enteredPending.accepted).toBe(true)
    if (!enteredPending.accepted) throw new Error('Expected Minato end-turn rule to enter pending target state')
    expect(enteredPending.state.pendingTargetSelection?.transaction?.currentInteraction).toMatchObject({
      consumerKind: 'rule',
      consumerId: 'rule-minato-anchor-end-turn',
      eventType: 'endTurn',
    })
    expect(enteredPending.state.pendingTargetSelection?.canCancel).toBe(false)
    expect(enteredPending.state.pendingTargetSelection?.triggerContext).toBeUndefined()
    const pending = listLegalAIActions(enteredPending.state, 'player-red')
    expect(pending.some(item => item.kind === 'pending-target')).toBe(true)
    expect(pending.some(item => item.kind === 'cancel-selection')).toBe(false)
    for (const item of pending) {
      expect(
        simulateAITransition(enteredPending.state, item, { rootSeed: FIXED_SEED }).accepted,
        `${item.kind}:${stableJson(item.action)}`,
      ).toBe(true)
    }
  })

  it('projects only the active player progressive offer and enumerates stable offer-by-safe-cell actions in v1/v2', () => {
    const state = progressiveDeploymentFixture()
    const before = stableJson(state)

    const redObservation = aiEnvironmentV1.observe(state, 'player-red')
    const blueObservation = aiEnvironmentV1.observe(state, 'player-blue')
    expect(redObservation.deployment).toMatchObject({
      mode: 'progressive-reserve-v1',
      status: 'awaiting-reserve-deploy',
      revision: 7,
      activePlayerId: 'player-red',
      reserveCounts: { 'player-red': 2, 'player-blue': 1 },
      offerPieces: [
        { instanceId: 'red-reserve-a', templateId: 'template-red-reserve-a', name: 'red-reserve-a' },
        { instanceId: 'red-reserve-b', templateId: 'template-red-reserve-b', name: 'red-reserve-b' },
      ],
      legalPositions: [{ x: 6, y: 2 }, { x: 7, y: 2 }],
    })
    expect(blueObservation.deployment).toMatchObject({
      mode: 'progressive-reserve-v1',
      status: 'awaiting-reserve-deploy',
      revision: 7,
      reserveCounts: { 'player-red': 2, 'player-blue': 1 },
    })
    expect(blueObservation.deployment).not.toHaveProperty('offerPieces')
    expect(blueObservation.deployment).not.toHaveProperty('legalPositions')
    expect(blueObservation.deployment).not.toHaveProperty('freeMovePieceId')
    expect(blueObservation.deployment).not.toHaveProperty('freeMovePositions')
    expect(stableJson(blueObservation)).not.toMatch(/red-reserve-[ab]|blue-secret-reserve/)

    const first = aiEnvironmentV1.listLegalActions(state, 'player-red')
    const second = aiEnvironmentV1.listLegalActions(state, 'player-red')
    expect(second).toEqual(first)
    expect(first).toHaveLength(4)
    expect(first.every(item => item.kind === 'reserve-deployment')).toBe(true)
    expect(first.map(item => item.action)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'deployReservePiece',
        playerId: 'player-red',
        expectedDeploymentRevision: 7,
        pieceId: 'red-reserve-a',
        toX: 6,
        toY: 2,
      }),
      expect.objectContaining({
        type: 'deployReservePiece',
        playerId: 'player-red',
        expectedDeploymentRevision: 7,
        pieceId: 'red-reserve-b',
        toX: 7,
        toY: 2,
      }),
    ]))
    expect(aiEnvironmentV1.listLegalActions(state, 'player-blue')).toEqual([])
    expect(new Set(first.map(item => item.id)).size).toBe(first.length)
    expect(stableJson(state)).toBe(before)
    for (const item of first) {
      expect(aiEnvironmentV1.simulate(state, item, { rootSeed: FIXED_SEED }).accepted, item.id).toBe(true)
    }

    expect(aiEnvironmentV2.observe(state, 'player-red').deployment?.offerPieces)
      .toEqual(redObservation.deployment?.offerPieces)
    expect(aiEnvironmentV2.observe(state, 'player-blue').deployment).not.toHaveProperty('offerPieces')
    const v2 = aiEnvironmentV2.decisionSpace(state, 'player-red')
    expect(v2.kind).toBe('actions')
    if (v2.kind !== 'actions') throw new Error('Expected flat progressive action candidates')
    expect(v2.candidates.map(item => item.kind)).toEqual(first.map(item => item.kind))
    expect(v2.candidates.map(item => item.action)).toEqual(first.map(item => item.action))
  })

  it('keeps fallback authority-only, emits no action without an empty cell, and rejects stale revisions without pollution', () => {
    const fallback = progressiveDeploymentFixture({
      width: 3,
      height: 1,
      redPosition: { x: 0, y: 0 },
      bluePosition: { x: 2, y: 0 },
      legalPositions: [],
    })
    fallback.deployment.offerPieceIds = ['red-reserve-a']
    const runtime = new RuleRuntime({
      rootSeed: FIXED_SEED,
      cursors: { 'progressive-deployment/fallback/player-red': 4 },
      tick: 9,
    })
    const runtimeBefore = runtime.snapshot()
    let first: CandidateAction[] = []
    let second: CandidateAction[] = []
    withRuleRuntime(runtime, () => {
      first = listLegalAIActions(fallback, 'player-red')
      second = listLegalAIActions(fallback, 'player-red')
    })
    expect(runtime.snapshot()).toEqual(runtimeBefore)
    expect(second).toEqual(first)
    expect(fallback.deployment.legalPositions).toEqual([])
    expect(observeBattleForAI(fallback, 'player-red').deployment?.legalPositions).toEqual([])
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      kind: 'reserve-deployment',
      action: {
        type: 'deployReservePiece',
        playerId: 'player-red',
        expectedDeploymentRevision: 7,
        pieceId: 'red-reserve-a',
      },
    })
    expect(first[0].action).not.toHaveProperty('toX')
    expect(first[0].action).not.toHaveProperty('toY')
    const resolvedA = simulateAITransition(fallback, first[0], { rootSeed: FIXED_SEED })
    const resolvedB = simulateAITransition(fallback, first[0], { rootSeed: FIXED_SEED })
    expect(resolvedA.accepted).toBe(true)
    expect(resolvedB.accepted).toBe(true)
    if (!resolvedA.accepted || !resolvedB.accepted) throw new Error('Expected deterministic fallback deployment')
    expect(resolvedA.stateHash).toBe(resolvedB.stateHash)
    expect(resolvedA.state.pieces.find(piece => piece.instanceId === 'red-reserve-a'))
      .toMatchObject({ x: 1, y: 0 })

    const noEmpty = progressiveDeploymentFixture({
      width: 2,
      height: 1,
      redPosition: { x: 0, y: 0 },
      bluePosition: { x: 1, y: 0 },
      legalPositions: [],
    })
    noEmpty.deployment.offerPieceIds = ['red-reserve-a']
    expect(listLegalAIActions(noEmpty, 'player-red')).toEqual([])

    const safe = progressiveDeploymentFixture()
    const stale = listLegalAIActions(safe, 'player-red')[0]
    safe.deployment.revision += 1
    const safeBefore = stableJson(safe)
    const rejected = simulateAITransition(safe, stale, { rootSeed: FIXED_SEED })
    expect(rejected.accepted).toBe(false)
    if (rejected.accepted) throw new Error('Expected stale deployment rejection')
    expect(rejected.error.code).toBe('PROGRESSIVE_DEPLOYMENT_STALE_REVISION')
    expect(rejected.state).toBe(safe)
    expect(stableJson(safe)).toBe(safeBefore)
  })

  it('enters ordinary action enumeration immediately after deployment with no dedicated free-move interface', () => {
    const initial = progressiveDeploymentFixture()
    const apBefore = initial.players.find((player: any) => player.playerId === 'player-red')!.actionPoints
    const deployed = simulateAITransition(
      initial,
      listLegalAIActions(initial, 'player-red')[0],
      { rootSeed: FIXED_SEED },
    )
    expect(deployed.accepted).toBe(true)
    if (!deployed.accepted) throw new Error('Expected reserve deployment to succeed')
    expect(deployed.state.deployment).toMatchObject({
      mode: 'progressive-reserve-v1',
      status: 'turn-ready',
    })
    expect(deployed.state.turn.phase).toBe('action')
    expect(deployed.state.players.find(player => player.playerId === 'player-red')!.actionPoints).toBe(apBefore)

    const observation = observeBattleForAI(deployed.state, 'player-red')
    expect(observation.deployment).not.toHaveProperty('freeMovePieceId')
    expect(observation.deployment).not.toHaveProperty('freeMovePositions')
    const blueDeployment = observeBattleForAI(deployed.state, 'player-blue').deployment
    expect(blueDeployment).not.toHaveProperty('offerPieces')
    expect(blueDeployment).not.toHaveProperty('legalPositions')
    expect(blueDeployment).not.toHaveProperty('freeMovePieceId')
    expect(blueDeployment).not.toHaveProperty('freeMovePositions')

    const candidates = listLegalAIActions(deployed.state, 'player-red')
    expect(candidates.some(item => item.kind === 'move' || item.kind === 'end-turn')).toBe(true)
    expect(candidates.map(item => item.action.type)).not.toContain('deploymentFreeMove')
    expect(candidates.map(item => item.action.type)).not.toContain('deploymentSkipFreeMove')
    expect(listLegalAIActions(deployed.state, 'player-blue')).toEqual([])
  })

  it('enumerates and plans only the tagged piece normal move at zero AP', () => {
    const tagged = makePiece({
      instanceId: 'tagged-free-mover', ownerPlayerId: 'player-red', x: 1, y: 1, moveRange: 2,
      statusTags: [{
        id: 'deployment-first-move-free',
        type: 'deployment-first-move-free',
        name: '本回合首次移动免费',
        visible: true,
        grantedTurnNumber: 1,
        currentDuration: 1,
        currentUses: 1,
      }],
    }) as any
    const ordinary = makePiece({
      instanceId: 'ordinary-no-ap', ownerPlayerId: 'player-red', x: 1, y: 3, moveRange: 2,
    }) as any
    const enemy = makePiece({
      instanceId: 'enemy-anchor', ownerPlayerId: 'player-blue', x: 5, y: 1,
    }) as any
    const state = makeState({ pieces: [tagged, ordinary, enemy], width: 6, height: 5 }) as any
    state.players.find((player: any) => player.playerId === 'player-red').actionPoints = 0

    const legalMoves = listLegalAIActions(state, 'player-red')
      .filter(candidate => candidate.action.type === 'move')
    expect(legalMoves.length).toBeGreaterThan(0)
    expect(new Set(legalMoves.map(candidate => (
      candidate.action.type === 'move' ? candidate.action.pieceId : undefined
    )))).toEqual(new Set(['tagged-free-mover']))

    const generated = generateBotActions(state, 'player-red')
    expect(generated.some(action => action.type === 'move' && action.pieceId === 'tagged-free-mover')).toBe(true)
    expect(generated.some(action => action.type === 'move' && action.pieceId === 'ordinary-no-ap')).toBe(false)
    const plan = planBotActions(state, 'player-red')
    expect(plan?.kind).toBe('action')
    const draft = plan?.actions.find(action => action.type === 'move')
    expect(draft).toMatchObject({ type: 'move', pieceId: 'tagged-free-mover' })
    const action = prepareLegalBotAction(state, draft!, 'player-red')
    expect(action).toBeDefined()

    const moved = simulateAITransition(state, action!, { rootSeed: FIXED_SEED })
    expect(moved.accepted).toBe(true)
    if (!moved.accepted) throw new Error('Expected tagged AP-zero move to succeed')
    expect(moved.state.players.find(player => player.playerId === 'player-red')!.actionPoints).toBe(0)
    expect(moved.state.pieces.find(piece => piece.instanceId === 'tagged-free-mover')?.statusTags)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'deployment-first-move-free' })]))
    expect(listLegalAIActions(moved.state, 'player-red').some(candidate => candidate.action.type === 'move')).toBe(false)
  })

  it('simulates on an isolated copy, returns structured diff/trace, and replays deterministically', () => {
    const mover = makePiece({ instanceId: 'mover', ownerPlayerId: 'player-red', x: 1, y: 1, moveRange: 2 }) as any
    const state = makeState({ pieces: [mover] }) as any
    const action = listLegalAIActions(state, 'player-red').find(item =>
      item.action.type === 'move' && item.action.toX === 1 && item.action.toY === 0,
    )!
    const before = stableJson(state)
    const rulesBefore = [...globalTriggerSystem.getRules()]

    const first = simulateAITransition(state, action, { rootSeed: FIXED_SEED })
    const second = simulateAITransition(state, action, { rootSeed: FIXED_SEED })

    expect(first.accepted).toBe(true)
    expect(second.accepted).toBe(true)
    expect(second.transitionHash).toBe(first.transitionHash)
    expect(second.trace).toEqual(first.trace)
    expect(stableJson(state)).toBe(before)
    expect(globalTriggerSystem.getRules()).toEqual(rulesBefore)
    if (first.accepted) {
      expect(first.state.pieces.find(piece => piece.instanceId === 'mover')).toMatchObject({ x: 1, y: 0 })
      expect(first.trace.actionTrace).toMatchObject({ rootSeed: FIXED_SEED })
      expect(first.trace.actionTrace?.preStateHash).toMatch(/^[0-9a-f]{64}$/)
      expect(first.trace.stateChanges.some(change => change.path.endsWith('.y'))).toBe(true)
    }
  })

  it('restores nested trigger-rule runtime state after accepted and rejected simulations', () => {
    const mover = makePiece({ instanceId: 'mover', ownerPlayerId: 'player-red', x: 1, y: 1 }) as any
    const state = makeState({ pieces: [mover] }) as any
    const move = listLegalAIActions(state, 'player-red').find(item => item.kind === 'move')!
    const acceptedRule: any = {
      id: 'ai-isolation-accepted', name: 'accepted', description: 'accepted',
      trigger: { type: 'beforeMove' }, limits: { maxUses: 10, uses: 0, currentCooldown: 0 },
      effect: () => ({ success: true }),
    }
    globalTriggerSystem.addRule(acceptedRule)

    expect(simulateAITransition(state, move, { rootSeed: FIXED_SEED }).accepted).toBe(true)
    expect(globalTriggerSystem.getRules()[0]).toBe(acceptedRule)
    expect(acceptedRule.limits).toEqual({ maxUses: 10, uses: 0, currentCooldown: 0 })

    globalTriggerSystem.clearRules()
    const rejectedRule: any = {
      id: 'ai-isolation-rejected', name: 'rejected', description: 'rejected',
      trigger: { type: 'beforeMove' }, limits: { maxUses: 10, uses: 0 },
      effect: () => {
        rejectedRule.limits.uses = 9
        throw new Error('fixture rejection')
      },
    }
    globalTriggerSystem.addRule(rejectedRule)
    expect(simulateAITransition(state, move, { rootSeed: FIXED_SEED }).accepted).toBe(false)
    expect(globalTriggerSystem.getRules()[0]).toBe(rejectedRule)
    expect(rejectedRule.limits).toEqual({ maxUses: 10, uses: 0 })
  })

  it('returns a stable rejected transition and never mutates the caller state', () => {
    const state = makeState({ pieces: [makePiece({ instanceId: 'mover' })] }) as any
    const before = stableJson(state)
    const illegal = { type: 'move', playerId: 'player-red', pieceId: 'mover', toX: 99, toY: 99 } as const

    const first = simulateAITransition(state, illegal, { rootSeed: FIXED_SEED })
    const second = simulateAITransition(state, illegal, { rootSeed: FIXED_SEED })

    expect(first.accepted).toBe(false)
    expect(second.transitionHash).toBe(first.transitionHash)
    expect(first.state).toBe(state)
    expect(first.trace).toEqual({ actionLog: [], stateChanges: [] })
    expect(stableJson(state)).toBe(before)

    const missingSeed = simulateAITransition(state, illegal)
    expect(missingSeed).toMatchObject({
      accepted: false,
      error: { code: 'AI_ENV_ROOT_SEED_REQUIRED' },
    })
  })

  it('uses real summon and transformed-piece fixtures through the formal runner', () => {
    const naruto = makePiece({
      instanceId: 'naruto', templateId: 'red-naruto', ownerPlayerId: 'player-red', x: 1, y: 1,
    }) as any
    naruto.skills = [{ skillId: 'naruto-shadow-clone', currentCooldown: 0, usesRemaining: -1 }]
    const transformed = makePiece({
      instanceId: 'transformed', templateId: 'red-illidan', ownerPlayerId: 'player-red', x: 4, y: 3,
    }) as any
    transformed.skills = [{ skillId: 'illidan-metamorphosis', currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({ pieces: [naruto, transformed], width: 6, height: 5 }) as any
    transformed.statusTags = [{
      id: 'deployment-first-move-free',
      type: 'deployment-first-move-free',
      name: '本回合首次移动免费',
      visible: true,
      grantedTurnNumber: state.turn.turnNumber,
      currentDuration: 1,
      currentUses: 1,
    }]
    state.players[0].actionPoints = 20
    state.players[0].chargePoints = 20
    state.skillsById['naruto-shadow-clone'] = JSON.parse(
      readFileSync(resolve(process.cwd(), 'data/skills/naruto-shadow-clone.json'), 'utf8'),
    )
    state.skillsById['illidan-metamorphosis'] = JSON.parse(
      readFileSync(resolve(process.cwd(), 'data/skills/illidan-metamorphosis.json'), 'utf8'),
    )
    const summon = listLegalAIActions(state, 'player-red').find(item =>
      item.kind === 'basic-skill' && item.action.type === 'useBasicSkill' &&
      item.action.skillId === 'naruto-shadow-clone' && item.action.selectedOption === 'summon',
    )
    expect(summon).toBeDefined()
    const result = aiEnvironmentV1.simulate(state, summon!, { rootSeed: FIXED_SEED })
    expect(result.accepted).toBe(true)
    if (result.accepted) {
      const summonedClone = result.state.pieces.find(piece => piece.instanceId.startsWith('naruto-clone-'))
      expect(summonedClone).toBeDefined()
      expect(summonedClone?.statusTags).not.toContainEqual(expect.objectContaining({
        type: 'deployment-first-move-free',
      }))
    }
    const transform = listLegalAIActions(state, 'player-red').find(item =>
      item.kind === 'charge-skill' && item.action.type === 'useChargeSkill' &&
      item.action.skillId === 'illidan-metamorphosis',
    )
    expect(transform).toBeDefined()
    const transformedResult = aiEnvironmentV1.simulate(state, transform!, { rootSeed: FIXED_SEED })
    expect(transformedResult.accepted).toBe(true)
    if (transformedResult.accepted) {
      expect(transformedResult.state.pieces.find(piece => piece.instanceId === 'transformed')?.statusTags)
        .toContainEqual(expect.objectContaining({ type: 'demon-strike-charges' }))
      expect(transformedResult.state.pieces.find(piece => piece.instanceId === 'transformed')?.statusTags)
        .toContainEqual(expect.objectContaining({
          type: 'deployment-first-move-free',
          grantedTurnNumber: state.turn.turnNumber,
          currentUses: 1,
        }))
    }
  })

  it('matches the generated browser export for candidate order and transition hash', () => {
    const browser = loadBrowserEnvironment()
    const nodeState = makeSilencedActionFixture().state
    const browserState = JSON.parse(JSON.stringify(nodeState))
    const nodeCandidates = aiEnvironmentV1.listLegalActions(nodeState, 'player-red')
    const browserCandidates = browser.listLegalActions(browserState, 'player-red')
    expect(JSON.parse(JSON.stringify(browserCandidates))).toEqual(nodeCandidates)
    expect(hashStable(browserCandidates)).toBe(hashStable(nodeCandidates))
    expect(nodeCandidates.some(item => item.kind === 'basic-skill' || item.kind === 'charge-skill')).toBe(false)

    const selectMove = (items: CandidateAction[]) => items.find(item => item.kind === 'move')!
    const nodeResult = aiEnvironmentV1.simulate(nodeState, selectMove(nodeCandidates), { rootSeed: FIXED_SEED })
    const browserResult = browser.simulate(browserState, selectMove(browserCandidates), { rootSeed: FIXED_SEED })
    expect(browserResult.transitionHash).toBe(nodeResult.transitionHash)
  })
})

describe('AI Environment v2', () => {
  it('preserves v1 while advertising the additive v2 contract', () => {
    expect(AI_ENVIRONMENT_CAPABILITIES.protocolVersion).toBe(1)
    expect(aiEnvironmentV1.protocolVersion).toBe(1)
    expect(AI_ENVIRONMENT_V2_CAPABILITIES).toMatchObject({
      protocolVersion: 2,
      structuredPendingDecisionSpace: true,
      publicBoardEffects: true,
    })
    expect(aiEnvironmentV2.protocolVersion).toBe(2)
  })

  it('keeps multi-option decision space linear and materializes any legal non-prefix choice', () => {
    const state = makeState({}) as any
    state.targetingRevision = 7
    state.pendingOptionSelection = finalizePendingOptionSession({
      playerId: 'player-red',
      title: 'choose holy cards',
      options: Array.from({ length: 10 }, (_, index) => ({
        value: `holy-${index}`,
        label: `Holy ${index}`,
        privateDebug: `hidden-${index}`,
      })),
      selectionMode: 'multi',
      presentation: 'hand',
      minSelections: 1,
      maxSelections: 4,
      canCancel: false,
    }, state.targetingRevision)

    const snapshot = stableJson(state)
    const space = aiEnvironmentV2.decisionSpace(state, 'player-red') as AIPendingOptionDecisionSpaceV2
    expect(space.kind).toBe('pending-option')
    expect(space.options).toHaveLength(10)
    expect(space.options.map(option => option.value)).toEqual(Array.from({ length: 10 }, (_, index) => `holy-${index}`))
    const observation = aiEnvironmentV2.observe(state, 'player-red')
    expect(stableJson(space)).not.toContain('privateDebug')
    expect(stableJson(observation)).not.toContain('privateDebug')
    expect(observation.pendingOptionSelection?.options[0]).toEqual({ value: 'holy-0', label: 'Holy 0' })

    const selected = ['holy-1', 'holy-4', 'holy-9']
    const candidate = aiEnvironmentV2.materialize(state, 'player-red', {
      kind: 'pending-option',
      selectionId: space.selectionId,
      stateRevision: space.stateRevision,
      selected,
    })
    expect(candidate).toMatchObject({
      protocolVersion: 2,
      kind: 'pending-option',
      action: { type: 'pendingOptionSelect', selectedOption: selected },
    })
    expect(stableJson(state)).toBe(snapshot)

    expect(() => aiEnvironmentV2.materialize(state, 'player-red', {
      kind: 'pending-option',
      selectionId: space.selectionId,
      stateRevision: space.stateRevision,
      selected: ['holy-1', 'holy-1'],
    })).toThrow()
    expect(() => aiEnvironmentV2.materialize(state, 'player-red', {
      kind: 'pending-option',
      selectionId: space.selectionId,
      stateRevision: space.stateRevision + 1,
      selected: ['holy-1'],
    })).toThrow()
    expect(() => aiEnvironmentV2.materialize(state, 'player-red', {
      kind: 'pending-option',
      selectionId: space.selectionId,
      stateRevision: space.stateRevision,
      selected: [],
    })).toThrow()
    expect(() => aiEnvironmentV2.materialize(state, 'player-red', {
      kind: 'pending-option',
      selectionId: space.selectionId,
      stateRevision: space.stateRevision,
      selected: ['holy-0', 'holy-1', 'holy-2', 'holy-3', 'holy-4'],
    })).toThrow()
    expect(() => aiEnvironmentV2.materialize(state, 'player-red', {
      kind: 'pending-option',
      selectionId: space.selectionId,
      stateRevision: space.stateRevision,
      selected: ['unknown'],
    })).toThrow()
    expect(() => aiEnvironmentV2.materialize(state, 'player-blue', {
      kind: 'pending-option',
      selectionId: space.selectionId,
      stateRevision: space.stateRevision,
      selected: ['holy-1'],
    })).toThrow()
    expect(stableJson(state)).toBe(snapshot)
  })

  it('materializes a legal non-prefix multi-target choice through the authority validator', () => {
    const chooser = makePiece({
      instanceId: 'v2-target-chooser', ownerPlayerId: 'player-red', x: 1, y: 1,
    }) as any
    const state = makeState({ pieces: [chooser] }) as any
    state.targetingRevision = 11
    state.pendingTargetSelection = finalizePendingTargetSession(state, {
      playerId: 'player-red',
      ownerPlayerId: 'player-red',
      title: 'choose targets',
      targetType: 'cell',
      source: { type: 'pending', id: 'v2-target-fixture', pieceId: chooser.instanceId },
      range: 5,
      filter: 'all',
      min: 1,
      max: 3,
      selectionMode: 'multi',
      minSelections: 1,
      maxSelections: 3,
      canCancel: false,
      fixedCandidates: true,
      candidates: [
        { type: 'cell', x: 0, y: 0 },
        { type: 'cell', x: 1, y: 0 },
        { type: 'cell', x: 2, y: 0 },
      ],
    } as any, state.targetingRevision)

    const snapshot = stableJson(state)
    const space = aiEnvironmentV2.decisionSpace(state, 'player-red') as AIPendingTargetDecisionSpaceV2
    expect(space.kind).toBe('pending-target')
    expect(space.candidates).toHaveLength(3)
    expect(space).toMatchObject({ range: 5, filter: 'all' })
    const selected = [space.candidates[0].ref, space.candidates[2].ref]
    const candidate = aiEnvironmentV2.materialize(state, 'player-red', {
      kind: 'pending-target',
      selectionId: space.selectionId,
      stateRevision: space.stateRevision,
      selected,
    })
    expect(candidate).toMatchObject({
      protocolVersion: 2,
      kind: 'pending-target',
      action: {
        type: 'pendingTargetSelect',
        targetX: 0,
        targetY: 0,
        extraTargets: [{ x: 2, y: 0 }],
      },
    })
    expect(() => aiEnvironmentV2.materialize(state, 'player-red', {
      kind: 'pending-target',
      selectionId: space.selectionId,
      stateRevision: space.stateRevision,
      selected: [],
    })).toThrow()
    expect(() => aiEnvironmentV2.materialize(state, 'player-red', {
      kind: 'pending-target',
      selectionId: space.selectionId,
      stateRevision: space.stateRevision,
      selected: [space.candidates[0].ref, space.candidates[0].ref],
    })).toThrow()
    expect(() => aiEnvironmentV2.materialize(state, 'player-red', {
      kind: 'pending-target',
      selectionId: space.selectionId,
      stateRevision: space.stateRevision,
      selected: [{ type: 'cell', x: 99, y: 99 }],
    })).toThrow()
    expect(() => aiEnvironmentV2.materialize(state, 'player-red', {
      kind: 'pending-target',
      selectionId: space.selectionId,
      stateRevision: space.stateRevision + 1,
      selected: [space.candidates[0].ref],
    })).toThrow()
    expect(() => aiEnvironmentV2.materialize(state, 'player-blue', {
      kind: 'pending-target',
      selectionId: space.selectionId,
      stateRevision: space.stateRevision,
      selected: [space.candidates[0].ref],
    })).toThrow()
    expect(stableJson(state)).toBe(snapshot)
  })

  it('projects only whitelisted visible public board effects into observation and state keys', () => {
    const state = makeState({}) as any
    state.extensions = {
      privateDebug: { secret: 'do-not-leak' },
      tileEffects: [
        { id: 'visible', type: 'holy-zone', icon: 'sun', x: 2, y: 3 },
        { id: 'hidden', type: 'ambush', x: 4, y: 5, visible: false, privatePayload: 'secret' },
        { sourceId: 'amaterasu', tileType: 'amaterasu', icon: 'moon', x: 1, y: 2, bgColor: 'private-style' },
      ],
    }

    const observation = aiEnvironmentV2.observe(state, 'player-red')
    expect(observation.boardEffects).toHaveLength(2)
    expect(observation.boardEffects).toContainEqual(
      { id: 'visible', type: 'holy-zone', icon: 'sun', x: 2, y: 3 },
    )
    expect(observation.boardEffects).toContainEqual(
      { id: 'effect-2', type: 'amaterasu', icon: 'moon', x: 1, y: 2 },
    )
    expect(stableJson(observation)).not.toContain('privateDebug')
    expect(stableJson(observation)).not.toContain('privatePayload')
    expect(stableJson(observation)).not.toContain('private-style')

    const changed = JSON.parse(JSON.stringify(state))
    changed.extensions.tileEffects[0].type = 'changed-zone'
    const scope = { kind: 'player' as const, playerId: 'player-red' }
    expect(aiEnvironmentV2.stateKey(state, scope))
      .not.toBe(aiEnvironmentV2.stateKey(changed, scope))
  })
})

describe('AI Environment v2 real roster interactions', () => {
  it('materializes a non-prefix Muru holy-hand selection without combinatorial candidates', () => {
    const lament = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/muru-lament.json'), 'utf8'))
    const liadrin = makePiece({
      instanceId: 'v2-liadrin', templateId: 'liadrin', ownerPlayerId: 'player-red', x: 0, y: 0,
    }) as any
    liadrin.skills = [{ skillId: lament.id, currentCooldown: 0, usesRemaining: -1 }]
    const enemy = makePiece({
      instanceId: 'v2-enemy', ownerPlayerId: 'player-blue', faction: 'blue',
      x: 4, y: 0, currentHp: 40, maxHp: 40,
    }) as any
    const state = makeState({
      pieces: [liadrin, enemy], currentPlayerId: 'player-red', phase: 'action',
    }) as any
    state.skillsById[lament.id] = lament
    state.players[0].actionPoints = 6
    state.players[0].chargePoints = 6
    const holyIds = ['holy-smite', 'holy-heal', 'holy-charge']
    state.players[0].hand = Array.from({ length: 10 }, (_, index) => ({
      cardId: holyIds[index % holyIds.length],
      instanceId: `v2-holy-${index}`,
      ownerPlayerId: 'player-red',
    }))

    const actions = aiEnvironmentV2.decisionSpace(state, 'player-red')
    expect(actions.kind).toBe('actions')
    const lamentAction = actions.kind === 'actions'
      ? actions.candidates.find(item => item.action.type === 'useChargeSkill' && item.action.skillId === lament.id)
      : undefined
    expect(lamentAction).toBeDefined()

    const prompted = aiEnvironmentV2.simulate(state, lamentAction!, { rootSeed: FIXED_SEED })
    expect(prompted.accepted).toBe(true)
    if (!prompted.accepted) throw new Error('Expected Muru to enter pending option selection')
    const firstSpace = aiEnvironmentV2.decisionSpace(prompted.state, 'player-red') as AIPendingOptionDecisionSpaceV2
    const secondSpace = aiEnvironmentV2.decisionSpace(prompted.state, 'player-red') as AIPendingOptionDecisionSpaceV2
    expect(firstSpace).toEqual(secondSpace)
    expect(firstSpace.options).toHaveLength(10)
    expect(firstSpace.maxSelections).toBe(4)

    const selected = [firstSpace.options[1].value, firstSpace.options[4].value, firstSpace.options[9].value]
    const materialized = aiEnvironmentV2.materialize(prompted.state, 'player-red', {
      kind: 'pending-option',
      selectionId: firstSpace.selectionId,
      stateRevision: firstSpace.stateRevision,
      selected,
    })
    expect(materialized.id).toBe(aiEnvironmentV2.materialize(prompted.state, 'player-red', {
      kind: 'pending-option',
      selectionId: firstSpace.selectionId,
      stateRevision: firstSpace.stateRevision,
      selected,
    }).id)

    const resolvedA = aiEnvironmentV2.simulate(prompted.state, materialized, { rootSeed: FIXED_SEED })
    const resolvedB = aiEnvironmentV2.simulate(prompted.state, materialized, { rootSeed: FIXED_SEED })
    expect(resolvedA.transitionHash).toBe(resolvedB.transitionHash)
    expect(resolvedA.accepted).toBe(true)
    if (!resolvedA.accepted) throw new Error('Expected Muru pending selection to resolve')
    console.info(`[RED-128 deterministic] descriptorId=${firstSpace.id} candidateId=${materialized.id} stateHash=${resolvedA.stateHash} transitionHash=${resolvedA.transitionHash}`)
    expect(resolvedA.state.pendingOptionSelection).toBeUndefined()
    expect(resolvedA.state.players[0].hand).toHaveLength(7)

    const cancel = aiEnvironmentV2.materialize(prompted.state, 'player-red', {
      kind: 'cancel-selection',
      selectionId: firstSpace.selectionId,
      stateRevision: firstSpace.stateRevision,
    })
    const cancelled = aiEnvironmentV2.simulate(prompted.state, cancel, { rootSeed: FIXED_SEED })
    expect(cancelled.accepted).toBe(true)
    if (!cancelled.accepted) throw new Error('Expected Muru pending selection cancellation to resolve')
    expect(cancelled.state.pendingOptionSelection).toBeUndefined()
    expect(cancelled.state.players[0].hand).toHaveLength(10)
    expect(cancelled.state.players[0].actionPoints).toBe(state.players[0].actionPoints)
  })

  it('resumes Ichigo direction-to-landing execution through the v2 decision contract', () => {
    const skill = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/ichigo-black-getsuga-tensho.json'), 'utf8'))
    const ichigo = makePiece({
      instanceId: 'v2-ichigo', templateId: 'blue-ichigo', ownerPlayerId: 'player-red',
      x: 1, y: 1, attack: 6,
    }) as any
    ichigo.skills = [{ skillId: skill.id, currentCooldown: 0, usesRemaining: -1 }]
    ichigo.rules = [loadRuleById('rule-ichigo-black-getsuga-teleport', true)]
    const enemy = makePiece({
      instanceId: 'v2-ichigo-enemy', ownerPlayerId: 'player-blue', faction: 'blue',
      x: 3, y: 1, currentHp: 30, maxHp: 30,
    }) as any
    const state = makeState({
      pieces: [ichigo, enemy], width: 6, height: 4, currentPlayerId: 'player-red', phase: 'action',
    }) as any
    state.skillsById[skill.id] = skill
    state.players[0].actionPoints = 6

    const actions = aiEnvironmentV2.decisionSpace(state, 'player-red')
    const targeted = actions.kind === 'actions' ? actions.candidates.find(item => (
      item.action.type === 'useBasicSkill' &&
      item.action.skillId === skill.id &&
      item.action.targetX === 5 &&
      item.action.targetY === 1
    )) : undefined
    expect(targeted).toBeDefined()

    const prompted = aiEnvironmentV2.simulate(state, targeted!, { rootSeed: FIXED_SEED })
    expect(prompted.accepted).toBe(true)
    if (!prompted.accepted) throw new Error('Expected Ichigo hit to enter pending landing selection')
    expect(prompted.state.pieces.find(piece => piece.instanceId === enemy.instanceId)?.currentHp).toBe(30)
    const space = aiEnvironmentV2.decisionSpace(prompted.state, 'player-red') as AIPendingTargetDecisionSpaceV2
    expect(space.kind).toBe('pending-target')
    expect(space.candidates.map(candidate => candidate.ref)).toEqual(expect.arrayContaining([
      { type: 'cell', x: 2, y: 1 },
      { type: 'cell', x: 3, y: 0 },
      { type: 'cell', x: 3, y: 2 },
      { type: 'cell', x: 4, y: 1 },
    ]))
    const landingRef = space.candidates.find(candidate => candidate.ref.type === 'cell' && candidate.ref.x === 3 && candidate.ref.y === 0)!.ref
    const landing = aiEnvironmentV2.materialize(prompted.state, 'player-red', {
      kind: 'pending-target',
      selectionId: space.selectionId,
      stateRevision: space.stateRevision,
      selected: [landingRef],
    })
    const resolved = aiEnvironmentV2.simulate(prompted.state, landing, { rootSeed: FIXED_SEED })
    expect(resolved.accepted).toBe(true)
    if (!resolved.accepted) throw new Error('Expected Ichigo pending landing to resolve')
    expect(resolved.state.pendingTargetSelection).toBeUndefined()
    expect(resolved.state.pieces.find(piece => piece.instanceId === ichigo.instanceId)).toMatchObject({ x: 3, y: 0 })
    expect(resolved.state.pieces.find(piece => piece.instanceId === enemy.instanceId)?.currentHp).toBe(18)
  })
})

describe('AI Environment v2 decision-space performance', () => {
  it('keeps a 320-target multi-select descriptor linear and deterministic', () => {
    const state = makeState({ width: 20, height: 16 }) as any
    state.targetingRevision = 19
    const refs = Array.from({ length: 320 }, (_, index) => ({
      type: 'cell' as const,
      x: index % 20,
      y: Math.floor(index / 20),
    }))
    state.pendingTargetSelection = finalizePendingTargetSession(state, {
      playerId: 'player-red',
      ownerPlayerId: 'player-red',
      title: 'large target set',
      targetType: 'cell',
      selectionMode: 'multi',
      minSelections: 1,
      maxSelections: 4,
      fixedCandidates: true,
      candidates: refs,
    } as any, state.targetingRevision)

    const startedAt = performance.now()
    const first = aiEnvironmentV2.decisionSpace(state, 'player-red') as AIPendingTargetDecisionSpaceV2
    const elapsedMs = performance.now() - startedAt
    const second = aiEnvironmentV2.decisionSpace(state, 'player-red') as AIPendingTargetDecisionSpaceV2
    expect(first.candidates).toHaveLength(320)
    expect(first.candidates.map(candidate => candidate.id)).toEqual(second.candidates.map(candidate => candidate.id))
    expect(first.id).toBe(second.id)
    expect(elapsedMs).toBeLessThan(100)
    console.info(`[RED-128 performance] targets=320 descriptorAtoms=${first.candidates.length} elapsedMs=${elapsedMs.toFixed(2)} descriptorId=${first.id}`)
  })
})
