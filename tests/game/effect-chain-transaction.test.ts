/* eslint-disable @typescript-eslint/no-explicit-any -- dynamic fixtures mirror authored SkillCode */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { hashBattleState, runBattleAction } from '@/lib/game/battle-runner'
import {
  EffectChainFatalError,
  createEffectChain,
  withEffectChain,
  getActiveEffectChain,
  isEffectChainFatalError,
  type EffectChain,
} from '@/lib/game/effect-batch'
import { dealDamage, type SkillDefinition } from '@/lib/game/skills'
import { RANDOM_STREAM_NAMES, getActiveRuleRuntime, type RuleRuntime } from '@/lib/game/rule-runtime'
import { DEFAULT_SKILLS } from '@/lib/game/skill-repository'
import { globalTriggerSystem } from '@/lib/game/triggers'
import type { BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const ROOT_SEED = 139_139
let previousRules: any[] = []
const fixtureSkillIds = new Set<string>()

beforeEach(() => {
  previousRules = [...globalTriggerSystem.getRules()]
  globalTriggerSystem.clearRules()
})

afterEach(() => {
  globalTriggerSystem.clearRules()
  globalTriggerSystem.addRules(previousRules)
  for (const skillId of fixtureSkillIds) {
    delete DEFAULT_SKILLS[skillId]
  }
  fixtureSkillIds.clear()
})

function addRule(
  id: string,
  type: string,
  effect: (battle: BattleState, context: any) => any,
  limits?: Record<string, number>,
): any {
  const rule = {
    id,
    name: id,
    description: '',
    trigger: { type },
    limits: limits ? { ...limits } : undefined,
    effect: (battle: BattleState, context: any) => effect(battle, context) ?? { success: true },
  }
  globalTriggerSystem.addRule(rule as any)
  return rule
}

function skillState(skillId: string, code: string, targetHp = 30): BattleState {
  const source = makePiece({
    instanceId: 'transaction-source',
    ownerPlayerId: 'player-red',
    x: 0,
    y: 0,
    currentHp: 100,
    maxHp: 100,
  }) as any
  source.name = 'Transaction Source'
  source.skills = [{ skillId, currentCooldown: 0, usesRemaining: -1 }]
  const target = makePiece({
    instanceId: 'transaction-target',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 1,
    y: 0,
    currentHp: targetHp,
    maxHp: 100,
  }) as any
  target.name = 'Transaction Target'
  const state = makeState({
    pieces: [source, target],
    currentPlayerId: 'player-red',
    phase: 'action',
    turnNumber: 7,
  }) as any
  state.players[0].actionPoints = 20
  const definition: SkillDefinition = {
    id: skillId,
    name: skillId,
    description: '',
    kind: 'active',
    type: 'normal',
    cooldownTurns: 0,
    maxCharges: 0,
    powerMultiplier: 1,
    actionPointCost: 0,
    range: 'self',
    requiresTarget: false,
    code,
  }
  state.skillsById[skillId] = definition
  DEFAULT_SKILLS[skillId] = definition
  fixtureSkillIds.add(skillId)
  return state
}

function skillAction(skillId: string, clientActionId: string, selectedOption?: unknown): any {
  return {
    type: 'useBasicSkill',
    playerId: 'player-red',
    pieceId: 'transaction-source',
    skillId,
    clientActionId,
    selectedOption,
  }
}

function hp(state: BattleState): number | undefined {
  return state.pieces.find(piece => piece.instanceId === 'transaction-target')?.currentHp
}

function batches(chain: EffectChain): string[] {
  return chain.records.filter(record => record.type === 'batch:start').map(record => record.kind)
}

function fatalForCurrentBatch(
  chain: EffectChain,
  skillId: string,
  cause: Error,
  message = 'transaction fatal probe',
): EffectChainFatalError {
  const batch = chain.currentBatch!
  return new EffectChainFatalError(
    'RVB_EFFECT_CHAIN_STATE_INVALID',
    message,
    {
      actionId: chain.actionId,
      chainId: chain.chainId,
      batchId: batch.batchId,
      parentBatchId: batch.parentBatchId,
      kind: batch.kind,
      depth: batch.depth,
      enqueueSequence: batch.enqueueSequence,
      originStage: batch.originStage,
      processed: chain.processedBatches,
      limit: chain.limits.maxBatches,
      turn: chain.turn,
      rootSeed: chain.rootSeed,
      sourceId: 'transaction-source',
      skillId,
      targetId: 'transaction-target',
      targetIds: ['transaction-target'],
      detached: false,
      budget: 'state',
    },
    cause,
  )
}

function expectRuntimeReset(runtime: RuleRuntime | undefined): void {
  expect(runtime).toBeDefined()
  const snapshot = runtime!.snapshot()
  expect(snapshot.clockCursor).toBe(0)
  expect(Object.values(snapshot.cursors).every(cursor => cursor === 0)).toBe(true)
}

describe('RED-139 authoritative EffectChain transactions', () => {
  it('uses one fresh chain per root action and shares budgets across sequential sync damage/heal', () => {
    const seen: EffectChain[] = []
    const observe = (battle: BattleState) => {
      const chain = getActiveEffectChain(battle)
      expect(chain).toBeDefined()
      seen.push(chain!)
    }
    addRule('observe-root-damage-chain', 'beforeDamageDealt', observe)
    addRule('observe-root-heal-chain', 'beforeHealDealt', observe)
    const skillId = 'transaction-shared-chain'
    const code = `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      dealDamage(source, target, 1, 'true', context.battle, 'shared-damage-1');
      healDamage(source, target, 1, context.battle, 'shared-heal-1');
      dealDamage(source, target, 1, 'true', context.battle, 'shared-damage-2');
      healDamage(source, target, 1, context.battle, 'shared-heal-2');
      return { success: true };
    }`

    const firstState = skillState(skillId, code, 80)
    const first = runBattleAction(firstState, skillAction(skillId, 'transaction-root-a'), { rootSeed: ROOT_SEED })
    const firstSeen = [...seen]
    seen.length = 0
    const secondState = skillState(skillId, code, 80)
    const second = runBattleAction(secondState, skillAction(skillId, 'transaction-root-b'), { rootSeed: ROOT_SEED })
    const secondSeen = [...seen]

    expect(firstSeen).toHaveLength(4)
    expect(secondSeen).toHaveLength(4)
    expect(new Set(firstSeen).size).toBe(1)
    expect(new Set(secondSeen).size).toBe(1)
    const firstChain = firstSeen[0]
    const secondChain = secondSeen[0]
    expect(firstChain).not.toBe(secondChain)
    expect(firstChain).toMatchObject({
      actionId: 'transaction-root-a',
      chainId: 'effect-chain:transaction-root-a',
      turn: 7,
      rootSeed: ROOT_SEED,
      detached: false,
      processedBatches: 4,
    })
    expect(secondChain).toMatchObject({
      actionId: 'transaction-root-b',
      chainId: 'effect-chain:transaction-root-b',
      processedBatches: 4,
    })
    expect(batches(firstChain)).toEqual(['damage', 'heal', 'damage', 'heal'])
    expect(firstChain.processedDispatches).toBeGreaterThan(firstChain.processedBatches)
    expect(firstChain.records.filter(record => record.type === 'enqueue').map(record => record.enqueueSequence))
      .toEqual([0, 1, 2, 3])
    expect([hp(first.state), hp(second.state)]).toEqual([80, 80])
    expect(getActiveEffectChain(firstState)).toBeUndefined()
    expect(getActiveEffectChain(first.state)).toBeUndefined()
    expect(getActiveEffectChain(secondState)).toBeUndefined()
    expect(getActiveEffectChain(second.state)).toBeUndefined()
  })

  it('preserves fatal identity, code, cause, and complete child-batch diagnostics through SkillCode', () => {
    const cause = new Error('fatal-handler-cause')
    let expectedFatal: EffectChainFatalError | undefined
    let failedScope: BattleState | undefined
    addRule('enqueue-fatal-child-heal', 'afterDamageDealt', (_battle, context) => {
      if (context.skillId !== 'fatal-root-damage') return
      context.healQueue.push({
        healer: context.sourcePiece,
        target: context.targetPiece,
        heal: 1,
        skillId: 'fatal-child-heal',
      })
    })
    addRule('throw-fatal-child-heal', 'beforeHealDealt', (battle, context) => {
      if (context.skillId !== 'fatal-child-heal') return
      const chain = getActiveEffectChain(battle)!
      failedScope = battle
      expectedFatal = fatalForCurrentBatch(chain, context.skillId, cause)
      throw expectedFatal
    })
    const skillId = 'transaction-fatal-passthrough'
    const state = skillState(skillId, `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      dealDamage(source, target, 2, 'true', context.battle, 'fatal-root-damage');
      return { success: true };
    }`)
    const beforeHash = hashBattleState(state)
    const beforeJson = JSON.stringify(state)

    let caught: unknown
    try {
      runBattleAction(state, skillAction(skillId, 'transaction-fatal-action'), { rootSeed: ROOT_SEED })
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(expectedFatal)
    expect(caught).toBeInstanceOf(EffectChainFatalError)
    expect((caught as EffectChainFatalError).code).toBe('RVB_EFFECT_CHAIN_STATE_INVALID')
    expect((caught as EffectChainFatalError).cause).toBe(cause)
    expect((caught as EffectChainFatalError).context).toMatchObject({
      actionId: 'transaction-fatal-action',
      chainId: 'effect-chain:transaction-fatal-action',
      batchId: expect.any(String),
      parentBatchId: expect.any(String),
      kind: 'heal',
      depth: 1,
      enqueueSequence: expect.any(Number),
      turn: 7,
      rootSeed: ROOT_SEED,
      sourceId: 'transaction-source',
      skillId: 'fatal-child-heal',
      targetId: 'transaction-target',
      detached: false,
    })
    expect((caught as any).determinism).toMatchObject({
      rootSeed: ROOT_SEED,
      turn: 7,
      actionId: 'transaction-fatal-action',
    })
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(JSON.stringify(state)).toBe(beforeJson)
    expect(getActiveEffectChain(failedScope!)).toBeUndefined()
  })

  it('rolls back state, runtime cursor/clock, event IDs, and rule limits for an invalid queued request', () => {
    const ghost = makePiece({
      instanceId: 'queued-ghost-target',
      ownerPlayerId: 'player-red',
      currentHp: 20,
      maxHp: 20,
    }) as any
    let attemptedRuntime: RuleRuntime | undefined
    let attemptedScope: BattleState | undefined
    const queueRule = addRule(
      'enqueue-invalid-heal',
      'afterDamageDealt',
      (battle, context) => {
        if (context.skillId !== 'invalid-queue-root') return
        attemptedScope = battle
        attemptedRuntime = getActiveRuleRuntime()
        attemptedRuntime!.nextRandom(RANDOM_STREAM_NAMES.skillEffect)
        attemptedRuntime!.clock.now()
        ;(battle.extensions as any).invalidQueueLeak = true
        context.healQueue.push({
          healer: context.sourcePiece,
          target: ghost,
          heal: 3,
          skillId: 'invalid-queued-heal',
        })
      },
      { maxUses: 10, uses: 0, cooldownTurns: 2, currentCooldown: 0 },
    )
    const skillId = 'transaction-invalid-queue'
    const state = skillState(skillId, `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      context.battle.extensions.failedRoll = Math.random();
      context.battle.extensions.failedClock = Date.now();
      dealDamage(source, target, 4, 'true', context.battle, 'invalid-queue-root');
      return { success: true };
    }`)
    const beforeHash = hashBattleState(state)
    const beforeJson = JSON.stringify(state)
    const triggerBefore = globalTriggerSystem.snapshotTransactionState()

    let caught: unknown
    try {
      runBattleAction(state, skillAction(skillId, 'transaction-invalid-queue-action'), { rootSeed: ROOT_SEED })
    } catch (error) {
      caught = error
    }

    expect(isEffectChainFatalError(caught)).toBe(true)
    expect((caught as EffectChainFatalError).context).toMatchObject({
      actionId: 'transaction-invalid-queue-action',
      chainId: 'effect-chain:transaction-invalid-queue-action',
      batchId: expect.any(String),
      parentBatchId: expect.any(String),
      kind: 'heal',
      depth: 1,
      enqueueSequence: expect.any(Number),
      turn: 7,
      rootSeed: ROOT_SEED,
      sourceId: 'transaction-source',
      skillId: 'invalid-queued-heal',
      targetId: 'queued-ghost-target',
      detached: false,
    })
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(JSON.stringify(state)).toBe(beforeJson)
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
    expect(queueRule.limits).toEqual({
      maxUses: 10,
      uses: 0,
      cooldownTurns: 2,
      currentCooldown: 0,
    })
    expectRuntimeReset(attemptedRuntime)
    expect(getActiveEffectChain(attemptedScope!)).toBeUndefined()
  })

  it('rebuilds pending attempts from root prestate and commits the typed FIFO exactly once', () => {
    const observed: Array<{ chain: EffectChain; skillId?: string }> = []
    let initialChain: EffectChain | undefined
    let initialScope: BattleState | undefined
    const queueRule = addRule(
      'pending-enqueue-fifo',
      'afterDamageDealt',
      (battle, context) => {
        if (context.skillId !== 'pending-root-damage') return { success: false }
        const chain = getActiveEffectChain(battle)
        expect(chain).toBeDefined()
        if (context.selectedOption === undefined) {
          initialChain = chain
          initialScope = battle
        }
        context.healQueue.push({
          healer: context.sourcePiece,
          target: context.targetPiece,
          heal: 2,
          skillId: 'pending-queued-heal',
        })
        context.damageQueue.push({
          attacker: context.sourcePiece,
          target: context.targetPiece,
          damage: 3,
          damageType: 'true',
          skillId: 'pending-queued-damage',
        })
        if (context.selectedOption === undefined) {
          return {
            needsOptionSelection: true,
            playerId: 'player-red',
            title: 'Continue?',
            options: [
              { label: 'Continue', value: 'continue' },
              { label: 'Fail', value: 'fail' },
            ],
            canCancel: false,
          }
        }
      },
      { maxUses: 10, uses: 0 },
    )
    const observe = (battle: BattleState, context: any) => {
      if (!String(context.skillId || '').startsWith('pending-')) return
      const chain = getActiveEffectChain(battle)
      expect(chain).toBeDefined()
      observed.push({ chain: chain!, skillId: context.skillId })
    }
    addRule('observe-pending-damage', 'beforeDamageDealt', observe)
    addRule('observe-pending-heal', 'beforeHealDealt', observe)
    const skillId = 'transaction-pending-fifo'
    const state = skillState(skillId, `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      context.battle.extensions.pendingRoll = Math.random();
      context.battle.extensions.pendingClock = Date.now();
      dealDamage(source, target, 4, 'true', context.battle, 'pending-root-damage');
      dealDamage(source, target, 1, 'true', context.battle, 'pending-after-damage');
      return { success: true };
    }`)
    const triggerBefore = globalTriggerSystem.snapshotTransactionState()

    const pendingResult = runBattleAction(
      state,
      skillAction(skillId, 'transaction-pending-root'),
      { rootSeed: ROOT_SEED },
    )
    const pending = pendingResult.state
    const initialObserved = [...observed]
    observed.length = 0

    expect(pending.pendingOptionSelection).toMatchObject({
      source: { type: 'rule', id: 'pending-enqueue-fifo' },
      title: 'Continue?',
      options: [{ value: 'continue' }, { value: 'fail' }],
    })
    expect(hp(pending)).toBe(30)
    expect((pending.extensions as any).pendingRoll).toBeUndefined()
    expect((pending.extensions as any).pendingClock).toBeUndefined()
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
    expect(queueRule.limits).toEqual({ maxUses: 10, uses: 0 })
    expect(pendingResult.trace?.randomStreams.find(stream => stream.name === RANDOM_STREAM_NAMES.skillEffect))
      .toMatchObject({ startCursor: 0, endCursor: 0 })
    expect(initialObserved.map(entry => entry.skillId)).toEqual(['pending-root-damage'])
    expect(initialChain).toBeDefined()
    expect(initialObserved[0]?.chain).toBe(initialChain)
    expect(initialChain!.records.filter(record => record.type === 'enqueue').map(record => record.enqueueSequence))
      .toEqual([0, 1, 2])
    expect(getActiveEffectChain(initialScope!)).toBeUndefined()
    expect(getActiveEffectChain(pending)).toBeUndefined()

    const session = pending.pendingOptionSelection!
    const completedResult = runBattleAction(pending, {
      type: 'pendingOptionSelect',
      playerId: 'player-red',
      selectedOption: 'continue',
      selectionId: session.selectionId,
      stateRevision: session.stateRevision,
      clientActionId: 'transaction-pending-resume',
    } as any, { rootSeed: ROOT_SEED })
    const resumedObserved = [...observed]

    expect(completedResult.state.pendingOptionSelection).toBeUndefined()
    expect(hp(completedResult.state)).toBe(24)
    expect(resumedObserved.map(entry => entry.skillId)).toEqual([
      'pending-root-damage',
      'pending-queued-heal',
      'pending-queued-damage',
      'pending-after-damage',
    ])
    expect(new Set(resumedObserved.map(entry => entry.chain)).size).toBe(1)
    const resumedChain = resumedObserved[0].chain
    expect(resumedChain).not.toBe(initialChain)
    expect(resumedChain.records.filter(record => record.type === 'enqueue').map(record => record.enqueueSequence))
      .toEqual([0, 1, 2, 3])
    expect(batches(resumedChain)).toEqual(['damage', 'heal', 'damage', 'damage'])
    expect(queueRule.limits).toEqual({ maxUses: 10, uses: 1 })
    expect((completedResult.state.extensions as any).pendingRoll).toEqual(expect.any(Number))
    expect((completedResult.state.extensions as any).pendingClock).toEqual(expect.any(Number))
    expect(completedResult.trace?.randomStreams.find(stream => stream.name === RANDOM_STREAM_NAMES.skillEffect))
      .toMatchObject({ startCursor: 0, endCursor: 1 })
    expect(getActiveEffectChain(completedResult.state)).toBeUndefined()
  })

  it('restores pending process state after failed resume and permits a deterministic retry', () => {
    const observed: Array<{ chain: EffectChain; skillId?: string }> = []
    let initialChain: EffectChain | undefined
    let failedChain: EffectChain | undefined
    let failedScope: BattleState | undefined
    const queueRule = addRule(
      'retry-enqueue-fifo',
      'afterDamageDealt',
      (battle, context) => {
        if (context.skillId !== 'retry-root-damage') return { success: false }
        const chain = getActiveEffectChain(battle)
        expect(chain).toBeDefined()
        if (context.selectedOption === undefined) initialChain = chain
        if (context.selectedOption === 'fail') {
          failedChain = chain
          failedScope = battle
        }
        context.healQueue.push({
          healer: context.sourcePiece,
          target: context.targetPiece,
          heal: 2,
          skillId: 'retry-queued-heal',
        })
        context.damageQueue.push({
          attacker: context.sourcePiece,
          target: context.targetPiece,
          damage: 3,
          damageType: 'true',
          skillId: 'retry-queued-damage',
        })
        if (context.selectedOption === undefined) {
          return {
            needsOptionSelection: true,
            playerId: 'player-red',
            title: 'Retry?',
            options: [
              { label: 'Continue', value: 'continue' },
              { label: 'Fail', value: 'fail' },
            ],
            canCancel: false,
          }
        }
        ;(battle.extensions as any).retryChoice = context.selectedOption
      },
      { maxUses: 10, uses: 0 },
    )
    const observe = (battle: BattleState, context: any) => {
      if (!String(context.skillId || '').startsWith('retry-')) return
      const chain = getActiveEffectChain(battle)
      expect(chain).toBeDefined()
      observed.push({ chain: chain!, skillId: context.skillId })
    }
    addRule('observe-retry-damage', 'beforeDamageDealt', observe)
    addRule('observe-retry-heal', 'beforeHealDealt', observe)
    const cause = new Error('pending-resume-cause')
    let expectedFatal: EffectChainFatalError | undefined
    addRule('retry-fatal', 'beforeDamageDealt', (battle, context) => {
      if (context.skillId !== 'retry-selected-failure') return
      expectedFatal = fatalForCurrentBatch(getActiveEffectChain(battle)!, context.skillId, cause)
      throw expectedFatal
    })
    const skillId = 'transaction-pending-retry'
    const code = `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      context.battle.extensions.retryRoll = Math.random();
      context.battle.extensions.retryClock = Date.now();
      dealDamage(source, target, 4, 'true', context.battle, 'retry-root-damage');
      if (context.battle.extensions.retryChoice === 'fail') {
        dealDamage(source, target, 1, 'true', context.battle, 'retry-selected-failure');
      } else {
        dealDamage(source, target, 1, 'true', context.battle, 'retry-selected-success');
      }
      return { success: true };
    }`
    const contractStart = globalTriggerSystem.snapshotTransactionState()
    const pendingResult = runBattleAction(
      skillState(skillId, code),
      skillAction(skillId, 'transaction-retry-root'),
      { rootSeed: ROOT_SEED },
    )
    const pending = pendingResult.state
    const initialObserved = [...observed]
    observed.length = 0

    expect(pending.pendingOptionSelection).toMatchObject({
      source: { type: 'rule', id: 'retry-enqueue-fifo' },
      title: 'Retry?',
      options: [{ value: 'continue' }, { value: 'fail' }],
    })
    expect(initialObserved.map(entry => entry.skillId)).toEqual(['retry-root-damage'])
    expect(initialChain).toBeDefined()
    expect(initialObserved[0]?.chain).toBe(initialChain)
    expect(initialChain!.records.filter(record => record.type === 'enqueue').map(record => record.enqueueSequence))
      .toEqual([0, 1, 2])
    expect(getActiveEffectChain(pending)).toBeUndefined()
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(contractStart)
    expect(queueRule.limits).toEqual({ maxUses: 10, uses: 0 })
    expect((pending.extensions as any).retryChoice).toBeUndefined()

    const session = pending.pendingOptionSelection!
    const beforeHash = hashBattleState(pending)
    const beforeJson = JSON.stringify(pending)
    const beforeFailure = globalTriggerSystem.snapshotTransactionState()
    let caught: unknown
    try {
      runBattleAction(pending, {
        type: 'pendingOptionSelect',
        playerId: 'player-red',
        selectedOption: 'fail',
        selectionId: session.selectionId,
        stateRevision: session.stateRevision,
        clientActionId: 'transaction-retry-failed',
      } as any, { rootSeed: ROOT_SEED })
    } catch (error) {
      caught = error
    }
    const failedObserved = [...observed]
    observed.length = 0

    expect(caught).toBe(expectedFatal)
    expect((caught as EffectChainFatalError).cause).toBe(cause)
    expect(failedObserved.map(entry => entry.skillId)).toEqual([
      'retry-root-damage',
      'retry-queued-heal',
      'retry-queued-damage',
      'retry-selected-failure',
    ])
    expect(new Set(failedObserved.map(entry => entry.chain)).size).toBe(1)
    expect(failedChain).toBeDefined()
    expect(failedObserved[0]?.chain).toBe(failedChain)
    expect(failedChain).not.toBe(initialChain)
    expect(hashBattleState(pending)).toBe(beforeHash)
    expect(JSON.stringify(pending)).toBe(beforeJson)
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(beforeFailure)
    expect(queueRule.limits).toEqual({ maxUses: 10, uses: 0 })
    expect(getActiveEffectChain(failedScope!)).toBeUndefined()

    const retry = runBattleAction(pending, {
      type: 'pendingOptionSelect',
      playerId: 'player-red',
      selectedOption: 'continue',
      selectionId: session.selectionId,
      stateRevision: session.stateRevision,
      clientActionId: 'transaction-retry-success',
    } as any, { rootSeed: ROOT_SEED }).state
    const retryObserved = [...observed]
    observed.length = 0
    const retryProbe = {
      hp: hp(retry),
      roll: (retry.extensions as any).retryRoll,
      clock: (retry.extensions as any).retryClock,
    }

    expect(retryObserved.map(entry => entry.skillId)).toEqual([
      'retry-root-damage',
      'retry-queued-heal',
      'retry-queued-damage',
      'retry-selected-success',
    ])
    expect(new Set(retryObserved.map(entry => entry.chain)).size).toBe(1)
    const retryChain = retryObserved[0].chain
    expect(retryChain).not.toBe(initialChain)
    expect(retryChain).not.toBe(failedChain)
    expect(retryChain.records.filter(record => record.type === 'enqueue').map(record => record.enqueueSequence))
      .toEqual([0, 1, 2, 3])
    expect(batches(retryChain)).toEqual(['damage', 'heal', 'damage', 'damage'])
    expect(queueRule.limits).toEqual({ maxUses: 10, uses: 1 })
    expect(getActiveEffectChain(retry)).toBeUndefined()

    globalTriggerSystem.restoreTransactionState(contractStart)
    const controlPending = runBattleAction(
      skillState(skillId, code),
      skillAction(skillId, 'transaction-retry-control-root'),
      { rootSeed: ROOT_SEED },
    ).state
    const controlSession = controlPending.pendingOptionSelection!
    const control = runBattleAction(controlPending, {
      type: 'pendingOptionSelect',
      playerId: 'player-red',
      selectedOption: 'continue',
      selectionId: controlSession.selectionId,
      stateRevision: controlSession.stateRevision,
      clientActionId: 'transaction-retry-control-resume',
    } as any, { rootSeed: ROOT_SEED }).state
    expect(retryProbe).toEqual({
      hp: 24,
      roll: (control.extensions as any).retryRoll,
      clock: (control.extensions as any).retryClock,
    })
    expect(hp(control)).toBe(24)
  })

  it('fully rolls back a cancellable post-effect target transaction and restores every process checkpoint', () => {
    const attemptedChains: EffectChain[] = []
    const attemptedRuntimes: RuleRuntime[] = []
    const attemptedScopes: BattleState[] = []
    const rollbackRule = addRule(
      'rollback-cancel-observer',
      'afterDamageDealt',
      (battle, context) => {
        if (context.skillId !== 'rollback-cancel-damage') return { success: false }
        const chain = getActiveEffectChain(battle)
        const runtime = getActiveRuleRuntime()
        expect(chain).toBeDefined()
        expect(runtime).toBeDefined()
        attemptedChains.push(chain!)
        attemptedRuntimes.push(runtime!)
        attemptedScopes.push(battle)
        runtime!.nextRandom(RANDOM_STREAM_NAMES.skillEffect)
        runtime!.nextInstanceId('rollback-cancel-probe')
        runtime!.clock.now()
        ;(battle.extensions as any).rollbackTriggerLeak = true
        context.healQueue.push({
          healer: context.sourcePiece,
          target: context.targetPiece,
          heal: 2,
          skillId: 'rollback-cancel-heal',
        })
      },
      { maxUses: 10, uses: 0, cooldownTurns: 2, currentCooldown: 0 },
    )
    const skillId = 'transaction-rollback-cancel'
    const state = skillState(skillId, `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      context.battle.extensions.rollbackRoll = Math.random();
      context.battle.extensions.rollbackClock = Date.now();
      dealDamage(source, target, 4, 'true', context.battle, 'rollback-cancel-damage');
      return {
        success: true,
        pendingTargetSelection: {
          playerId: context.piece.ownerPlayerId,
          title: 'Choose an optional rollback target',
          targetType: 'cell',
          range: 2,
          filter: 'all',
          canCancel: true,
          effectCode: "function(ctx) { ctx.battle.extensions.rollbackTargetLeak = true; return { success: true }; }"
        }
      };
    }`)
    state.skillsById[skillId].actionPointCost = 1
    state.skillsById[skillId].rollbackPendingTargetOnCancel = true
    const rollbackProjection = (value: BattleState) => {
      const projection = JSON.parse(JSON.stringify(value)) as any
      delete projection.pendingOptionSelection
      delete projection.pendingTargetSelection
      delete projection.targetingRevision
      delete projection.actions
      delete projection.skillsById
      if (projection.extensions) delete projection.extensions.debugBattle
      return projection
    }
    const stateBefore = rollbackProjection(state)
    const triggerBefore = globalTriggerSystem.snapshotTransactionState()

    const pendingResult = runBattleAction(
      state,
      skillAction(skillId, 'transaction-rollback-cancel-root'),
      { rootSeed: ROOT_SEED },
    )
    const pending = pendingResult.state

    expect(pending.pendingTargetSelection).toMatchObject({
      title: 'Choose an optional rollback target',
      canCancel: true,
      rollbackOnCancel: true,
    })
    expect(attemptedChains).toHaveLength(1)
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
    expect(rollbackRule.limits).toEqual({
      maxUses: 10,
      uses: 0,
      cooldownTurns: 2,
      currentCooldown: 0,
    })
    expect(getActiveEffectChain(attemptedScopes[0])).toBeUndefined()

    const pendingBeforeCancel = JSON.stringify(pending)
    const session = pending.pendingTargetSelection!
    const cancelledResult = runBattleAction(pending, {
      type: 'cancelPendingSelection',
      playerId: 'player-red',
      selectionId: session.selectionId,
      stateRevision: session.stateRevision,
      clientActionId: 'transaction-rollback-cancel-resume',
    } as any, { rootSeed: ROOT_SEED })
    const cancelled = cancelledResult.state

    expect(JSON.stringify(pending)).toBe(pendingBeforeCancel)
    expect(cancelled.pendingTargetSelection).toBeUndefined()
    expect(cancelled.pendingOptionSelection).toBeUndefined()
    expect(rollbackProjection(cancelled)).toEqual(stateBefore)
    expect((cancelled.actions ?? []).filter(action => action.type === 'useBasicSkill')).toHaveLength(0)
    expect((cancelled.actions ?? []).filter(action => action.type === 'cancelPendingSelection')).toHaveLength(1)
    expect(attemptedChains).toHaveLength(2)
    expect(attemptedChains[1]).not.toBe(attemptedChains[0])
    expect(attemptedRuntimes[1]).not.toBe(attemptedRuntimes[0])
    expectRuntimeReset(attemptedRuntimes[1])
    expect(attemptedRuntimes[1].snapshot().lastRandomAccess).toBeUndefined()
    expect(attemptedRuntimes[1].getLastRandomAccess()).toEqual({
      streamName: RANDOM_STREAM_NAMES.skillEffect,
      cursor: 0,
    })
    expect(attemptedChains[1].snapshot()).toMatchObject({
      state: 'idle',
      ledger: [],
      processedBatches: 0,
      processedDispatches: 0,
      nextEnqueueSequence: 0,
      nextBatchSequence: 0,
      batchStack: [],
      records: [],
    })
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
    expect(rollbackRule.limits).toEqual({
      maxUses: 10,
      uses: 0,
      cooldownTurns: 2,
      currentCooldown: 0,
    })
    expect(cancelledResult.trace?.randomStreams.find(stream => stream.name === RANDOM_STREAM_NAMES.skillEffect))
      .toMatchObject({ startCursor: 0, endCursor: 0 })
    expect(getActiveEffectChain(attemptedScopes[1])).toBeUndefined()
    expect(getActiveEffectChain(state)).toBeUndefined()
    expect(getActiveEffectChain(pending)).toBeUndefined()
    expect(getActiveEffectChain(cancelled)).toBeUndefined()
  })

  it.each([
    {
      label: 'depth',
      limits: { maxDepth: 2 },
      diagnostic: {
        code: 'RVB_EFFECT_CHAIN_DEPTH_LIMIT',
        kind: 'heal',
        depth: 3,
        processed: 3,
        limit: 2,
        budget: 'depth',
        skillId: 'budget-loop-depth-heal',
      },
      observed: ['budget-loop-depth-damage', 'budget-loop-depth-heal', 'budget-loop-depth-damage'],
    },
    {
      label: 'batches',
      limits: { maxBatches: 3 },
      diagnostic: {
        code: 'RVB_EFFECT_CHAIN_BATCH_LIMIT',
        kind: 'heal',
        depth: 3,
        processed: 4,
        limit: 3,
        budget: 'batches',
        skillId: 'budget-loop-batches-heal',
      },
      observed: ['budget-loop-batches-damage', 'budget-loop-batches-heal', 'budget-loop-batches-damage'],
    },
    {
      label: 'dispatches',
      limits: { maxDispatches: 13 },
      diagnostic: {
        code: 'RVB_EFFECT_CHAIN_DISPATCH_LIMIT',
        kind: 'damage',
        depth: 2,
        processed: 14,
        limit: 13,
        budget: 'dispatches',
        skillId: 'budget-loop-dispatches-damage',
      },
      observed: ['budget-loop-dispatches-damage', 'budget-loop-dispatches-heal'],
    },
  ])('enforces the shared $label budget through a real damage↔heal handler loop', ({
    label,
    limits,
    diagnostic,
    observed: expectedObserved,
  }) => {
    const damageSkillId = `budget-loop-${label}-damage`
    const healSkillId = `budget-loop-${label}-heal`
    const observed: string[] = []
    addRule(`budget-loop-${label}-damage-to-heal`, 'afterDamageDealt', (battle, context) => {
      if (context.skillId !== damageSkillId) return
      observed.push(context.skillId)
      const source = battle.pieces.find(piece => piece.instanceId === 'transaction-source')
      const target = battle.pieces.find(piece => piece.instanceId === 'transaction-target')
      expect(source).toBeDefined()
      expect(target).toBeDefined()
      context.healQueue.push({
        healer: source!,
        target: target!,
        heal: 1,
        skillId: healSkillId,
      })
    })
    addRule(`budget-loop-${label}-heal-to-damage`, 'afterHealDealt', (battle, context) => {
      if (context.skillId !== healSkillId) return
      observed.push(context.skillId)
      const source = battle.pieces.find(piece => piece.instanceId === 'transaction-source')
      const target = battle.pieces.find(piece => piece.instanceId === 'transaction-target')
      expect(source).toBeDefined()
      expect(target).toBeDefined()
      context.damageQueue.push({
        attacker: source!,
        target: target!,
        damage: 1,
        damageType: 'true',
        skillId: damageSkillId,
      })
    })
    const state = skillState(
      'budget-loop-fixture',
      'function executeSkill() { return { success: true }; }',
      50,
    )
    const source = state.pieces.find(piece => piece.instanceId === 'transaction-source')!
    const target = state.pieces.find(piece => piece.instanceId === 'transaction-target')!
    const effectChain = createEffectChain({
      actionId: `budget-loop-${label}-action`,
      chainId: `effect-chain:budget-loop-${label}`,
      turn: 7,
      rootSeed: ROOT_SEED,
      limits: limits as any,
    })

    let caught: unknown
    try {
      withEffectChain(state, effectChain, () => {
        dealDamage(source, target, 1, 'true', state, damageSkillId)
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EffectChainFatalError)
    expect(isEffectChainFatalError(caught)).toBe(true)
    const { code, ...expectedContext } = diagnostic
    expect((caught as EffectChainFatalError).code).toBe(code)
    expect((caught as EffectChainFatalError).context).toMatchObject({
      actionId: `budget-loop-${label}-action`,
      chainId: `effect-chain:budget-loop-${label}`,
      batchId: expect.any(String),
      parentBatchId: expect.any(String),
      turn: 7,
      rootSeed: ROOT_SEED,
      sourceId: 'transaction-source',
      targetId: 'transaction-target',
      detached: false,
      ...expectedContext,
    })
    expect(observed).toEqual(expectedObserved)
    expect(effectChain.state).toBe('idle')
    expect(effectChain.processedBatches).toBe(0)
    expect(effectChain.processedDispatches).toBe(0)
    expect(effectChain.pendingCount).toBe(1)
    expect(getActiveEffectChain(state)).toBeUndefined()
  })

  it('keeps ordinary SkillCode failures on the existing non-fatal wrapper path', () => {
    const skillId = 'transaction-ordinary-error'
    const state = skillState(skillId, `function executeSkill() {
      throw new Error('ordinary skill failure');
    }`)
    const beforeHash = hashBattleState(state)

    let caught: unknown
    try {
      runBattleAction(state, skillAction(skillId, 'transaction-ordinary-action'), { rootSeed: ROOT_SEED })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(isEffectChainFatalError(caught)).toBe(false)
    expect((caught as Error).message).toContain('\u6280\u80fd\u6267\u884c\u5931\u8d25: ordinary skill failure')
    expect((caught as any).determinism).toMatchObject({
      rootSeed: ROOT_SEED,
      turn: 7,
      actionId: 'transaction-ordinary-action',
    })
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(getActiveEffectChain(state)).toBeUndefined()
  })
})
