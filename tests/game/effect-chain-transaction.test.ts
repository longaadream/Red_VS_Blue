/* eslint-disable @typescript-eslint/no-explicit-any -- dynamic fixtures mirror authored SkillCode */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { hashBattleState, runBattleAction } from '@/lib/game/battle-runner'
import {
  EffectChainFatalError,
  createEffectChain,
  createDamageQueueWriter,
  createInternalDeathQueueWriter,
  withEffectChain,
  getActiveEffectChain,
  isEffectChainFatalError,
  type EffectChain,
} from '@/lib/game/effect-batch'
import {
  clearCardCache,
  clearRuleCache,
  clearSkillDefinitionCache,
  dealDamage,
  healDamage,
  loadRuleById,
  type SkillDefinition,
} from '@/lib/game/skills'
import {
  RANDOM_STREAM_NAMES,
  RuleRuntime,
  createRuleExecutionContext,
  getActiveRuleRuntime,
  withRuleRuntime,
} from '@/lib/game/rule-runtime'
import { DEFAULT_SKILLS } from '@/lib/game/skill-repository'
import { TriggerSystem, globalTriggerSystem } from '@/lib/game/triggers'
import { applyBattleAction, type BattleState } from '@/lib/game/turn'
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
  const definition = skillDefinition(skillId, code)
  state.skillsById[skillId] = definition
  DEFAULT_SKILLS[skillId] = definition
  fixtureSkillIds.add(skillId)
  return state
}

function skillDefinition(
  skillId: string,
  code: string,
  overrides: Partial<SkillDefinition> = {},
): SkillDefinition {
  return {
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
    ...overrides,
    id: skillId,
    code,
  }
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

function withTemporaryProfile<T>(
  files: Partial<Record<'rules' | 'skills' | 'cards', Record<string, string | object>>>,
  execute: () => T,
): T {
  const root = mkdtempSync(join(tmpdir(), 'rvb-red139-definitions-'))
  const dataRoot = join(root, 'data')
  for (const kind of ['rules', 'skills', 'cards'] as const) {
    const directory = join(dataRoot, kind)
    mkdirSync(directory, { recursive: true })
    for (const [id, value] of Object.entries(files[kind] || {})) {
      writeFileSync(
        join(directory, `${id}.json`),
        typeof value === 'string' ? value : JSON.stringify(value),
        'utf8',
      )
    }
  }
  const previousProfileRoot = process.env.RVB_PROFILE_ROOT
  process.env.RVB_PROFILE_ROOT = root
  clearRuleCache()
  clearCardCache()
  clearSkillDefinitionCache()
  try {
    return execute()
  } finally {
    clearRuleCache()
    clearCardCache()
    clearSkillDefinitionCache()
    if (previousProfileRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousProfileRoot
    rmSync(root, { recursive: true, force: true })
  }
}

function withTemporarySkill<T>(
  skillId: string,
  code: string,
  execute: () => T,
  overrides: Partial<SkillDefinition> = {},
): T {
  return withTemporaryProfile({
    skills: { [skillId]: skillDefinition(skillId, code, overrides) },
  }, execute)
}

function addDefinitionRuntimeProbe(id: string): {
  readonly rule: any
  readonly runtime: () => RuleRuntime | undefined
} {
  let attemptedRuntime: RuleRuntime | undefined
  const rule = addRule(
    `definition-runtime-probe-${id}`,
    'beforeSkillUse',
    battle => {
      attemptedRuntime = getActiveRuleRuntime()
      attemptedRuntime!.nextRandom(RANDOM_STREAM_NAMES.skillEffect)
      attemptedRuntime!.clock.now()
      ;(battle.extensions as any).definitionProbeLeak = id
    },
    { maxUses: 10, uses: 0, cooldownTurns: 2, currentCooldown: 0 },
  )
  return { rule, runtime: () => attemptedRuntime }
}

function definitionFailureState(skillId: string): BattleState {
  return skillState(skillId, definitionFailureCode(skillId))
}

function definitionFailureCode(skillId: string): string {
  return `function executeSkill(context) {
    var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
    var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
    dealDamage(source, target, 4, 'true', context.battle, '${skillId}-damage');
    return { success: true };
  }`
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

  it('keeps a JSON wire-state deterministic across independent room contexts', () => {
    const skillId = 'transaction-colyseus-json-roundtrip'
    const code = `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      dealDamage(source, target, 5, 'true', context.battle, 'colyseus-json-damage');
      healDamage(source, target, 2, context.battle, 'colyseus-json-heal');
      return { success: true };
    }`
    withTemporarySkill(skillId, code, () => {
      const state = skillState(skillId, code, 40)
      const wireState = JSON.parse(JSON.stringify(state)) as BattleState
      const action = skillAction(skillId, 'transaction-colyseus-json-action')
      const firstContext = createRuleExecutionContext(new TriggerSystem())
      const secondContext = createRuleExecutionContext(new TriggerSystem())

      expect(hashBattleState(wireState)).toBe(hashBattleState(state))
      const first = runBattleAction(state, action, {
        rootSeed: ROOT_SEED,
        ruleExecutionContext: firstContext,
      })
      const second = runBattleAction(wireState, action, {
        rootSeed: ROOT_SEED,
        ruleExecutionContext: secondContext,
      })
      const persisted = JSON.parse(JSON.stringify(first.state)) as BattleState

      expect(first.stateHash).toBe(second.stateHash)
      expect(first.trace).toEqual(second.trace)
      expect(first.state).toEqual(second.state)
      expect(hashBattleState(persisted)).toBe(hashBattleState(first.state))
      expect(persisted).toEqual(first.state)
      expect(hp(first.state)).toBe(37)
      const nextAction = skillAction(skillId, 'transaction-colyseus-json-action-2')
      const continuedInMemory = runBattleAction(first.state, nextAction, {
        rootSeed: ROOT_SEED,
        ruleExecutionContext: createRuleExecutionContext(new TriggerSystem()),
      })
      const continuedFromPersistence = runBattleAction(persisted, nextAction, {
        rootSeed: ROOT_SEED,
        ruleExecutionContext: createRuleExecutionContext(new TriggerSystem()),
      })
      expect(continuedFromPersistence.stateHash).toBe(continuedInMemory.stateHash)
      expect(continuedFromPersistence.trace).toEqual(continuedInMemory.trace)
      expect(continuedFromPersistence.state).toEqual(continuedInMemory.state)
      expect(hp(continuedFromPersistence.state)).toBe(34)
      expect(getActiveEffectChain(state)).toBeUndefined()
      expect(getActiveEffectChain(wireState)).toBeUndefined()
      expect(getActiveEffectChain(first.state)).toBeUndefined()
      expect(getActiveEffectChain(second.state)).toBeUndefined()
      expect(getActiveEffectChain(persisted)).toBeUndefined()
      expect(getActiveEffectChain(continuedInMemory.state)).toBeUndefined()
      expect(getActiveEffectChain(continuedFromPersistence.state)).toBeUndefined()
    })
  })

  it.each([
    { label: 'direct', transport: (state: BattleState) => state },
    { label: 'structuredClone', transport: (state: BattleState) => structuredClone(state) },
    { label: 'JSON', transport: (state: BattleState) => JSON.parse(JSON.stringify(state)) as BattleState },
  ])('preserves rule descriptor counters across two actions through $label transport', ({ label, transport }) => {
    const skillId = `transaction-rule-hydration-${label}`
    const ruleId = `rule-red139-hydration-${label}`
    const code = `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      dealDamage(source, target, 2, 'true', context.battle, 'hydration-root-damage');
      return { success: true };
    }`
    withTemporaryProfile({
      skills: { [skillId]: skillDefinition(skillId, code) },
      rules: {
        [ruleId]: {
          id: ruleId,
          name: 'Hydration counter probe',
          description: '',
          trigger: { type: 'afterDamageDealt' },
          limits: {
            maxUses: 5,
            uses: 0,
            cooldownTurns: 2,
            currentCooldown: 0,
            duration: 3,
            remainingDuration: 3,
          },
          skillCode: `battle.extensions.hydrationRuleFires =
            (battle.extensions.hydrationRuleFires || 0) + 1;
            return { success: true };`,
        },
      },
    }, () => {
      const state = skillState(skillId, code)
      const source = state.pieces.find(piece => piece.instanceId === 'transaction-source') as any
      const descriptor = loadRuleById(ruleId, true)
      expect(descriptor).toBeDefined()
      descriptor!.limits = {
        ...descriptor!.limits,
        maxUses: 5,
        uses: 0,
        cooldownTurns: 2,
        currentCooldown: 0,
        remainingDuration: 3,
      }
      source.rules = [descriptor]

      const first = runBattleAction(
        state,
        skillAction(skillId, `transaction-rule-hydration-${label}-1`),
        {
          rootSeed: ROOT_SEED,
          ruleExecutionContext: createRuleExecutionContext(new TriggerSystem()),
        },
      )
      const firstDescriptor = (first.state.pieces.find(piece =>
        piece.instanceId === 'transaction-source') as any).rules[0]
      expect(firstDescriptor.limits).toEqual({
        maxUses: 5,
        uses: 1,
        cooldownTurns: 2,
        currentCooldown: 2,
        duration: 3,
        remainingDuration: 3,
      })
      expect((first.state.extensions as any).hydrationRuleFires).toBe(1)
      expect(typeof firstDescriptor.effect).not.toBe('function')

      const secondInput = transport(first.state)
      const second = runBattleAction(
        secondInput,
        skillAction(skillId, `transaction-rule-hydration-${label}-2`),
        {
          rootSeed: ROOT_SEED,
          ruleExecutionContext: createRuleExecutionContext(new TriggerSystem()),
        },
      )
      const secondDescriptor = (second.state.pieces.find(piece =>
        piece.instanceId === 'transaction-source') as any).rules[0]
      expect(secondDescriptor.limits).toEqual(firstDescriptor.limits)
      expect((second.state.extensions as any).hydrationRuleFires).toBe(1)
      expect(hp(second.state)).toBe(26)
      expect(getActiveEffectChain(state)).toBeUndefined()
      expect(getActiveEffectChain(first.state)).toBeUndefined()
      expect(getActiveEffectChain(secondInput)).toBeUndefined()
      expect(getActiveEffectChain(second.state)).toBeUndefined()
    })
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

  it('isolates fatal and successful EffectChain transactions across room rule contexts', () => {
    const skillId = 'transaction-room-context-isolation'
    const actionId = 'transaction-room-shared-action'
    const rootDamageSkillId = 'room-context-root-damage'
    const childHealSkillId = 'room-context-child-heal'
    const code = `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      dealDamage(source, target, 2, 'true', context.battle, '${rootDamageSkillId}');
      return { success: true };
    }`
    const roomASeed = ROOT_SEED + 1
    const roomBSeed = ROOT_SEED + 2
    const globalObserved: string[] = []
    const globalProbe = addRule(
      'transaction-room-global-probe',
      'afterDamageDealt',
      (_battle, context) => {
        if (context.skillId === rootDamageSkillId) globalObserved.push(context.effectBatchId)
      },
      { maxUses: 10, uses: 0 },
    )
    const globalRulesBefore = [...globalTriggerSystem.getRules()]
    const globalSnapshotBefore = globalTriggerSystem.snapshotTransactionState()

    type RoomObservation = {
      batchIds: string[]
      chains: EffectChain[]
      scopes: BattleState[]
      runtime?: RuleRuntime
      fatal?: EffectChainFatalError
    }
    const installRoomRules = (
      triggerSystem: TriggerSystem,
      observation: RoomObservation,
      fatal: boolean,
    ) => {
      const enqueueRule = {
        id: 'transaction-room-enqueue-heal',
        name: 'transaction-room-enqueue-heal',
        description: '',
        trigger: { type: 'afterDamageDealt' },
        limits: { maxUses: 10, uses: 0 },
        effect: (battle: BattleState, context: any) => {
          if (context.skillId !== rootDamageSkillId) return { success: true }
          observation.batchIds.push(String(context.effectBatchId))
          observation.chains.push(getActiveEffectChain(battle)!)
          observation.scopes.push(battle)
          observation.runtime = observation.runtime ?? getActiveRuleRuntime()
          observation.runtime!.nextRandom(RANDOM_STREAM_NAMES.skillEffect)
          ;(battle.extensions as any).roomEffectTransaction = 'committed'
          context.healQueue.push({
            healer: context.sourcePiece,
            target: context.targetPiece,
            heal: 1,
            skillId: childHealSkillId,
          })
          return { success: true }
        },
      }
      const healRule = {
        id: 'transaction-room-observe-heal',
        name: 'transaction-room-observe-heal',
        description: '',
        trigger: { type: 'beforeHealDealt' },
        limits: { maxUses: 10, uses: 0 },
        effect: (battle: BattleState, context: any) => {
          if (context.skillId !== childHealSkillId) return { success: true }
          observation.batchIds.push(String(context.effectBatchId))
          observation.chains.push(getActiveEffectChain(battle)!)
          observation.scopes.push(battle)
          observation.runtime = observation.runtime ?? getActiveRuleRuntime()
          if (fatal) {
            const cause = new Error('room A child heal fatal')
            observation.fatal = fatalForCurrentBatch(
              getActiveEffectChain(battle)!,
              childHealSkillId,
              cause,
              cause.message,
            )
            throw observation.fatal
          }
          return { success: true }
        },
      }
      triggerSystem.addRules([enqueueRule, healRule] as any[])
      return { enqueueRule, healRule }
    }

    const roomATriggerSystem = new TriggerSystem()
    const roomAContext = createRuleExecutionContext(roomATriggerSystem)
    const roomAObservation: RoomObservation = { batchIds: [], chains: [], scopes: [] }
    const roomARules = installRoomRules(roomATriggerSystem, roomAObservation, true)
    const roomARuleReferences = [...roomATriggerSystem.getRules()]
    const roomASnapshotBefore = roomATriggerSystem.snapshotTransactionState()
    const roomAState = skillState(skillId, code)
    const roomAHashBefore = hashBattleState(roomAState)
    const roomAJsonBefore = JSON.stringify(roomAState)

    let roomAFailure: unknown
    try {
      runBattleAction(
        roomAState,
        skillAction(skillId, actionId),
        { rootSeed: roomASeed, ruleExecutionContext: roomAContext },
      )
    } catch (error) {
      roomAFailure = error
    }

    expect(roomAFailure).toBe(roomAObservation.fatal)
    expect(isEffectChainFatalError(roomAFailure)).toBe(true)
    expect((roomAFailure as EffectChainFatalError).context).toMatchObject({
      actionId,
      chainId: `effect-chain:${actionId}`,
      kind: 'heal',
      parentBatchId: roomAObservation.batchIds[0],
      batchId: roomAObservation.batchIds[1],
      rootSeed: roomASeed,
      skillId: childHealSkillId,
      detached: false,
    })
    expect(hashBattleState(roomAState)).toBe(roomAHashBefore)
    expect(JSON.stringify(roomAState)).toBe(roomAJsonBefore)
    expect(roomATriggerSystem.snapshotTransactionState()).toEqual(roomASnapshotBefore)
    expect(roomATriggerSystem.getRules()).toEqual(roomARuleReferences)
    expect(roomATriggerSystem.getRules()[0]).toBe(roomARuleReferences[0])
    expect(roomATriggerSystem.getRules()[1]).toBe(roomARuleReferences[1])
    expect(roomARules.enqueueRule.limits).toEqual({ maxUses: 10, uses: 0 })
    expect(roomARules.healRule.limits).toEqual({ maxUses: 10, uses: 0 })
    expectRuntimeReset(roomAObservation.runtime)
    expect(roomAObservation.runtime?.snapshot().lastRandomAccess).toBeUndefined()
    expect(roomAObservation.batchIds).toHaveLength(2)
    expect(new Set(roomAObservation.chains).size).toBe(1)
    expect(new Set(roomAObservation.scopes).size).toBe(1)
    expect(roomAObservation.scopes.every(scope => getActiveEffectChain(scope) === undefined)).toBe(true)
    expect(getActiveEffectChain(roomAState)).toBeUndefined()
    expect(getActiveRuleRuntime()).toBeUndefined()

    const roomBTriggerSystem = new TriggerSystem()
    const roomBContext = createRuleExecutionContext(roomBTriggerSystem)
    const roomBObservation: RoomObservation = { batchIds: [], chains: [], scopes: [] }
    const roomBRules = installRoomRules(roomBTriggerSystem, roomBObservation, false)
    const roomBSnapshotBefore = roomBTriggerSystem.snapshotTransactionState()
    const roomBState = skillState(skillId, code)
    const roomBHashBefore = hashBattleState(roomBState)
    expect(roomBHashBefore).toBe(roomAHashBefore)

    const roomBResult = runBattleAction(
      roomBState,
      skillAction(skillId, actionId),
      { rootSeed: roomBSeed, ruleExecutionContext: roomBContext },
    )
    const roomBSnapshotAfter = roomBTriggerSystem.snapshotTransactionState()
    const roomBRuntimeSnapshot = roomBObservation.runtime!.snapshot()

    expect(roomBResult.trace?.actionId).toBe(actionId)
    expect(roomBResult.stateHash).not.toBe(roomBHashBefore)
    expect(hp(roomBResult.state)).toBe(29)
    expect((roomBResult.state.extensions as any).roomEffectTransaction).toBe('committed')
    expect(roomBSnapshotAfter.nextRootEventId).toBeGreaterThan(roomBSnapshotBefore.nextRootEventId)
    expect(roomBRules.enqueueRule.limits).toEqual({ maxUses: 10, uses: 1 })
    expect(roomBRules.healRule.limits).toEqual({ maxUses: 10, uses: 1 })
    expect(roomBRuntimeSnapshot.cursors).toMatchObject({
      'instance-id/damage-batch': 1,
      'instance-id/heal-batch': 1,
      [RANDOM_STREAM_NAMES.skillEffect]: 1,
    })
    expect(roomBResult.trace?.randomStreams).toEqual(expect.arrayContaining([
      { name: 'instance-id/damage-batch', startCursor: 0, endCursor: 1 },
      { name: 'instance-id/heal-batch', startCursor: 0, endCursor: 1 },
      { name: RANDOM_STREAM_NAMES.skillEffect, startCursor: 0, endCursor: 1 },
    ]))
    expect(roomBObservation.batchIds).toHaveLength(2)
    expect(roomBObservation.batchIds).not.toEqual(roomAObservation.batchIds)
    expect(new Set(roomBObservation.chains).size).toBe(1)
    expect(roomBObservation.scopes.every(scope => getActiveEffectChain(scope) === undefined)).toBe(true)
    expect(getActiveEffectChain(roomBResult.state)).toBeUndefined()

    const roomACompiledCache = [...roomAContext.cache.values()][0] as {
      dynamicCodeRuntime: { stats(): { compiled: number } }
    }
    const roomBCompiledCache = [...roomBContext.cache.values()][0] as {
      dynamicCodeRuntime: { stats(): { compiled: number } }
    }
    expect(roomAContext.cache.size).toBe(1)
    expect(roomBContext.cache.size).toBe(1)
    expect(roomACompiledCache).not.toBe(roomBCompiledCache)
    expect(roomACompiledCache.dynamicCodeRuntime.stats().compiled).toBe(1)
    expect(roomBCompiledCache.dynamicCodeRuntime.stats().compiled).toBe(1)

    const controlTriggerSystem = new TriggerSystem()
    const controlContext = createRuleExecutionContext(controlTriggerSystem)
    const controlObservation: RoomObservation = { batchIds: [], chains: [], scopes: [] }
    installRoomRules(controlTriggerSystem, controlObservation, false)
    const controlState = skillState(skillId, code)
    expect(hashBattleState(controlState)).toBe(roomBHashBefore)
    const controlResult = runBattleAction(
      controlState,
      skillAction(skillId, actionId),
      { rootSeed: roomBSeed, ruleExecutionContext: controlContext },
    )

    expect(controlResult.stateHash).toBe(roomBResult.stateHash)
    expect(hashBattleState(controlResult.state)).toBe(hashBattleState(roomBResult.state))
    expect(controlResult.trace).toEqual(roomBResult.trace)
    expect(controlObservation.batchIds).toEqual(roomBObservation.batchIds)
    expect(controlObservation.runtime?.snapshot()).toEqual(roomBRuntimeSnapshot)
    const controlSnapshot = controlTriggerSystem.snapshotTransactionState()
    expect({
      nextRootEventId: controlSnapshot.nextRootEventId,
      ruleIds: controlSnapshot.rules.map(rule => rule.id),
      ruleLimits: controlSnapshot.ruleLimits,
    }).toEqual({
      nextRootEventId: roomBSnapshotAfter.nextRootEventId,
      ruleIds: roomBSnapshotAfter.rules.map(rule => rule.id),
      ruleLimits: roomBSnapshotAfter.ruleLimits,
    })
    expect([...controlContext.cache.values()][0]).not.toBe(roomBCompiledCache)
    expect(globalObserved).toEqual([])
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(globalSnapshotBefore)
    expect(globalTriggerSystem.getRules()).toEqual(globalRulesBefore)
    expect(globalProbe.limits).toEqual({ maxUses: 10, uses: 0 })
    expect(getActiveRuleRuntime()).toBeUndefined()
  })

  it('restores expired TriggerSystem membership, order, identity, and limits after a later beginPhase fatal', () => {
    const triggerSystem = new TriggerSystem()
    const executionContext = createRuleExecutionContext(triggerSystem)
    const expiringRule = {
      id: 'transaction-expiring-rule',
      name: 'transaction-expiring-rule',
      description: '',
      trigger: { type: 'not-a-runtime-event' },
      limits: { duration: 1, remainingDuration: 1, uses: 0 },
      effect: () => ({ success: true }),
    }
    const fatalRule = {
      id: 'transaction-after-expiry-fatal',
      name: 'transaction-after-expiry-fatal',
      description: '',
      trigger: { type: 'whenever' },
      limits: { maxUses: 3, uses: 0, currentCooldown: 0 },
      effect: (battle: BattleState) => {
        const source = battle.pieces.find(piece => piece.instanceId === 'transaction-source')!
        const target = battle.pieces.find(piece => piece.instanceId === 'transaction-target')!
        dealDamage(source, target, Number.NaN, 'true', battle, 'trigger-membership-rollback')
        return { success: true }
      },
    }
    triggerSystem.addRules([expiringRule, fatalRule] as any[])
    const ruleReferences = [...triggerSystem.getRules()]
    const triggerBefore = triggerSystem.snapshotTransactionState()
    const state = skillState('transaction-trigger-membership', 'function executeSkill() { return { success: true }; }')
    state.turn.phase = 'start'
    const beforeHash = hashBattleState(state)
    const beforeJson = JSON.stringify(state)

    expect(() => runBattleAction(
      state,
      { type: 'beginPhase', clientActionId: 'transaction-trigger-membership' } as any,
      { rootSeed: ROOT_SEED, ruleExecutionContext: executionContext },
    )).toThrow(EffectChainFatalError)

    expect(hashBattleState(state)).toBe(beforeHash)
    expect(JSON.stringify(state)).toBe(beforeJson)
    expect(triggerSystem.getRules()).toEqual(ruleReferences)
    expect(triggerSystem.getRules()[0]).toBe(expiringRule)
    expect(triggerSystem.getRules()[1]).toBe(fatalRule)
    expect(expiringRule.limits).toEqual({ duration: 1, remainingDuration: 1, uses: 0 })
    expect(fatalRule.limits).toEqual({ maxUses: 3, uses: 0, currentCooldown: 0 })
    expect(triggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
  })

  it.each([
    {
      name: 'damage target NaN HP', kind: 'damage', mutate: 'target.currentHp = 0 / 0;',
      invoke: "dealDamage(source, target, 1, 'true', context.battle, 'invalid-target-damage');",
      message: 'not an active living piece',
    },
    {
      name: 'damage target infinite HP', kind: 'damage', mutate: 'target.currentHp = 1 / 0;',
      invoke: "dealDamage(source, target, 1, 'true', context.battle, 'invalid-target-damage');",
      message: 'not an active living piece',
    },
    {
      name: 'heal target NaN HP', kind: 'heal', mutate: 'target.currentHp = 0 / 0;',
      invoke: "healDamage(source, target, 1, context.battle, 'invalid-target-heal');",
      message: 'not an active living piece',
    },
    {
      name: 'heal target infinite HP', kind: 'heal', mutate: 'target.currentHp = 1 / 0;',
      invoke: "healDamage(source, target, 1, context.battle, 'invalid-target-heal');",
      message: 'not an active living piece',
    },
    {
      name: 'heal target NaN maxHp', kind: 'heal', mutate: 'target.maxHp = 0 / 0;',
      invoke: "healDamage(source, target, 1, context.battle, 'invalid-target-heal');",
      message: 'finite positive maxHp',
    },
    {
      name: 'heal target infinite maxHp', kind: 'heal', mutate: 'target.maxHp = 1 / 0;',
      invoke: "healDamage(source, target, 1, context.battle, 'invalid-target-heal');",
      message: 'finite positive maxHp',
    },
  ])('rejects $name in an attached root and restores state, TriggerSystem, and RuleRuntime', ({
    name,
    kind,
    mutate,
    invoke,
    message,
  }) => {
    const suffix = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
    const skillId = 'transaction-invalid-target-' + suffix
    const state = skillState(skillId, `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      context.battle.extensions.invalidTargetRoll = Math.random();
      context.battle.extensions.invalidTargetClock = Date.now();
      ${mutate}
      ${invoke}
      return { success: true };
    }`)
    const actionId = 'transaction-invalid-target-' + kind + '-' + suffix
    const beforeHash = hashBattleState(state)
    const beforeJson = JSON.stringify(state)
    let attemptedRuntime: RuleRuntime | undefined
    let attemptedScope: BattleState | undefined
    const probeRule = addRule(
      'invalid-target-probe-' + suffix,
      'beforeSkillUse',
      (battle, context) => {
        if (context.skillId !== skillId) return { success: false }
        attemptedRuntime = getActiveRuleRuntime()
        attemptedScope = battle
        if (!attemptedRuntime) throw new Error('missing deterministic runtime')
        attemptedRuntime.nextRandom(RANDOM_STREAM_NAMES.skillEffect)
        attemptedRuntime.nextInstanceId('invalid-target-probe')
        attemptedRuntime.clock.now()
        ;(battle.extensions as any).invalidTargetRuleLeak = true
      },
      { maxUses: 3, uses: 0, cooldownTurns: 2, currentCooldown: 0 },
    )
    const triggerBefore = globalTriggerSystem.snapshotTransactionState()
    let caught: unknown

    try {
      runBattleAction(state, skillAction(skillId, actionId), { rootSeed: ROOT_SEED })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EffectChainFatalError)
    expect(caught).toMatchObject({
      code: 'RVB_EFFECT_CHAIN_STATE_INVALID',
      context: expect.objectContaining({
        actionId,
        chainId: 'effect-chain:' + actionId,
        kind,
        sourceId: 'transaction-source',
        targetId: 'transaction-target',
        detached: false,
      }),
    })
    expect((caught as EffectChainFatalError).cause).toMatchObject({
      message: expect.stringContaining(message),
    })
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(JSON.stringify(state)).toBe(beforeJson)
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
    expect(probeRule.limits).toEqual({
      maxUses: 3, uses: 0, cooldownTurns: 2, currentCooldown: 0,
    })
    expectRuntimeReset(attemptedRuntime)
    expect(getActiveEffectChain(attemptedScope!)).toBeUndefined()
  })

  it.each([
    {
      name: 'removed candidate',
      message: 'membership changed',
      mutate: (battle: BattleState, context: any) => {
        const index = battle.pieces.indexOf(context.sourcePiece)
        battle.pieces.splice(index, 1)
      },
    },
    {
      name: 'same-id replacement',
      message: 'membership changed',
      mutate: (battle: BattleState, context: any) => {
        const index = battle.pieces.indexOf(context.sourcePiece)
        battle.pieces[index] = { ...context.sourcePiece }
      },
    },
    {
      name: 'same-id duplicate',
      message: 'membership changed',
      mutate: (battle: BattleState, context: any) => {
        battle.pieces.push({ ...context.sourcePiece })
      },
    },
    {
      name: 'early graveyard insertion',
      message: 'entered graveyard before finalization',
      mutate: (battle: BattleState, context: any) => {
        battle.graveyard.push(context.sourcePiece)
      },
    },
    {
      name: 'NaN candidate HP',
      message: 'HP became invalid',
      mutate: (_battle: BattleState, context: any) => {
        context.sourcePiece.currentHp = Number.NaN
      },
    },
    {
      name: 'candidate HP above frozen maxHp',
      message: 'HP became invalid',
      mutate: (_battle: BattleState, context: any) => {
        context.sourcePiece.currentHp = context.sourcePiece.maxHp + 1
      },
    },
    {
      name: 'NaN candidate maxHp',
      message: 'maxHp changed',
      mutate: (_battle: BattleState, context: any) => {
        context.sourcePiece.maxHp = Number.NaN
      },
    },
    {
      name: 'infinite candidate maxHp',
      message: 'maxHp changed',
      mutate: (_battle: BattleState, context: any) => {
        context.sourcePiece.maxHp = Number.POSITIVE_INFINITY
      },
    },
    {
      name: 'candidate maxHp drift',
      message: 'maxHp changed',
      mutate: (_battle: BattleState, context: any) => {
        context.sourcePiece.maxHp += 1
      },
    },
    {
      name: 'candidate owner drift',
      message: 'candidate owner changed',
      mutate: (_battle: BattleState, context: any) => {
        context.sourcePiece.ownerPlayerId = 'player-red'
      },
    },
    {
      name: 'candidate ID drift',
      message: 'membership changed',
      mutate: (_battle: BattleState, context: any) => {
        context.sourcePiece.instanceId = 'transaction-target-mutated'
      },
    },
    {
      name: 'source owner drift',
      message: 'source identity changed',
      mutate: (_battle: BattleState, context: any) => {
        context.targetPiece.ownerPlayerId = 'player-blue'
      },
    },
    {
      name: 'source ID drift',
      message: 'source identity changed',
      mutate: (_battle: BattleState, context: any) => {
        context.targetPiece.instanceId = 'transaction-source-mutated'
      },
    },
  ])('rejects Death Freeze corruption from $name and rolls back every root checkpoint', ({
    name,
    message,
    mutate,
  }) => {
    const skillId = 'transaction-death-freeze-' + name
    const state = skillState(skillId, "function executeSkill(context) { var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; }); var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; }); dealDamage(source, target, 1, 'true', context.battle, 'death-freeze-root'); return { success: true }; }", 1)
    const beforeHash = hashBattleState(state)
    const beforeJson = JSON.stringify(state)
    let attemptedRuntime: RuleRuntime | undefined
    let attemptedScope: BattleState | undefined
    let chargeEvents = 0
    const mutationRule = addRule(
      'death-freeze-mutation-' + name,
      'onPieceDied',
      (battle, context) => {
        attemptedRuntime = getActiveRuleRuntime()
        attemptedScope = battle
        if (!attemptedRuntime) throw new Error('missing deterministic runtime')
        attemptedRuntime.nextRandom(RANDOM_STREAM_NAMES.skillEffect)
        attemptedRuntime.nextInstanceId('death-freeze-probe')
        attemptedRuntime.clock.now()
        mutate(battle, context)
      },
      { maxUses: 3, uses: 0, cooldownTurns: 2, currentCooldown: 0 },
    )
    addRule('death-freeze-charge-observer-' + name, 'afterChargeGained', () => {
      chargeEvents += 1
    })
    const triggerBefore = globalTriggerSystem.snapshotTransactionState()
    let caught: unknown

    try {
      runBattleAction(
        state,
        skillAction(skillId, 'transaction-death-freeze-' + name),
        { rootSeed: ROOT_SEED },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EffectChainFatalError)
    expect(caught).toMatchObject({
      code: 'RVB_EFFECT_CHAIN_BATCH_REJECTED',
      context: {
        actionId: 'transaction-death-freeze-' + name,
        chainId: 'effect-chain:transaction-death-freeze-' + name,
        batchId: expect.any(String),
        parentBatchId: expect.any(String),
        kind: 'death',
        depth: 1,
        originStage: 'damage:death',
        sourceId: 'transaction-source',
        skillId: 'death-freeze-root',
        targetId: 'transaction-target',
      },
    })
    expect((caught as Error).message).toContain(message)
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(JSON.stringify(state)).toBe(beforeJson)
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
    expect(mutationRule.limits).toEqual({
      maxUses: 3,
      uses: 0,
      cooldownTurns: 2,
      currentCooldown: 0,
    })
    expect(chargeEvents).toBe(0)
    expectRuntimeReset(attemptedRuntime)
    expect(getActiveEffectChain(attemptedScope!)).toBeUndefined()
  })

  it.each([
    {
      name: 'finalized ID drift',
      message: 'finalized candidate identity changed',
      mutate: (battle: BattleState) => {
        battle.graveyard.find(piece => piece.instanceId === 'transaction-target')!.instanceId = 'mutated-finalized-id'
      },
    },
    {
      name: 'finalized owner drift',
      message: 'finalized candidate identity changed',
      mutate: (battle: BattleState) => {
        battle.graveyard.find(piece => piece.instanceId === 'transaction-target')!.ownerPlayerId = 'player-red'
      },
    },
    {
      name: 'finalized HP revival',
      message: 'finalized candidate death classification changed',
      mutate: (battle: BattleState) => {
        battle.graveyard.find(piece => piece.instanceId === 'transaction-target')!.currentHp = 1
      },
    },
    {
      name: 'finalized NaN maxHp',
      message: 'finalized candidate maxHp changed',
      mutate: (battle: BattleState) => {
        battle.graveyard.find(piece => piece.instanceId === 'transaction-target')!.maxHp = Number.NaN
      },
    },
    {
      name: 'finalized infinite maxHp',
      message: 'finalized candidate maxHp changed',
      mutate: (battle: BattleState) => {
        battle.graveyard.find(piece => piece.instanceId === 'transaction-target')!.maxHp = Number.POSITIVE_INFINITY
      },
    },
    {
      name: 'finalized maxHp drift',
      message: 'finalized candidate maxHp changed',
      mutate: (battle: BattleState) => {
        battle.graveyard.find(piece => piece.instanceId === 'transaction-target')!.maxHp += 1
      },
    },
    {
      name: 'finalized move back to board',
      message: 'finalized candidate membership changed',
      mutate: (battle: BattleState) => {
        const index = battle.graveyard.findIndex(piece => piece.instanceId === 'transaction-target')
        battle.pieces.push(...battle.graveyard.splice(index, 1))
      },
    },
    {
      name: 'finalized graveyard duplicate',
      message: 'finalized candidate membership changed',
      mutate: (battle: BattleState) => {
        const piece = battle.graveyard.find(entry => entry.instanceId === 'transaction-target')!
        battle.graveyard.push({ ...piece })
      },
    },
    {
      name: 'finalized board duplicate',
      message: 'finalized candidate membership changed',
      mutate: (battle: BattleState) => {
        const piece = battle.graveyard.find(entry => entry.instanceId === 'transaction-target')!
        battle.pieces.push({ ...piece })
      },
    },
    {
      name: 'revived ID drift',
      message: 'revived candidate identity changed',
      mutate: (battle: BattleState) => {
        battle.pieces.find(piece => piece.instanceId === 'transaction-revived')!.instanceId = 'mutated-revived-id'
      },
    },
    {
      name: 'revived owner drift',
      message: 'revived candidate identity changed',
      mutate: (battle: BattleState) => {
        battle.pieces.find(piece => piece.instanceId === 'transaction-revived')!.ownerPlayerId = 'player-red'
      },
    },
    {
      name: 'revived HP death',
      message: 'revived candidate revival classification changed',
      mutate: (battle: BattleState) => {
        battle.pieces.find(piece => piece.instanceId === 'transaction-revived')!.currentHp = 0
      },
    },
    {
      name: 'revived HP above frozen maxHp',
      message: 'revived candidate revival classification changed',
      mutate: (battle: BattleState) => {
        const piece = battle.pieces.find(entry => entry.instanceId === 'transaction-revived')!
        piece.currentHp = piece.maxHp + 1
      },
    },
    {
      name: 'revived NaN maxHp',
      message: 'revived candidate maxHp changed',
      mutate: (battle: BattleState) => {
        battle.pieces.find(piece => piece.instanceId === 'transaction-revived')!.maxHp = Number.NaN
      },
    },
    {
      name: 'revived infinite maxHp',
      message: 'revived candidate maxHp changed',
      mutate: (battle: BattleState) => {
        battle.pieces.find(piece => piece.instanceId === 'transaction-revived')!.maxHp = Number.POSITIVE_INFINITY
      },
    },
    {
      name: 'revived maxHp drift',
      message: 'revived candidate maxHp changed',
      mutate: (battle: BattleState) => {
        battle.pieces.find(piece => piece.instanceId === 'transaction-revived')!.maxHp += 1
      },
    },
    {
      name: 'revived move to graveyard',
      message: 'revived candidate membership changed',
      mutate: (battle: BattleState) => {
        const index = battle.pieces.findIndex(piece => piece.instanceId === 'transaction-revived')
        battle.graveyard.push(...battle.pieces.splice(index, 1))
      },
    },
    {
      name: 'revived same-ID replacement',
      message: 'revived candidate membership changed',
      mutate: (battle: BattleState) => {
        const index = battle.pieces.findIndex(piece => piece.instanceId === 'transaction-revived')
        battle.pieces[index] = { ...battle.pieces[index] }
      },
    },
    {
      name: 'revived board duplicate',
      message: 'revived candidate membership changed',
      mutate: (battle: BattleState) => {
        const piece = battle.pieces.find(entry => entry.instanceId === 'transaction-revived')!
        battle.pieces.push({ ...piece })
      },
    },
    {
      name: 'revived graveyard duplicate',
      message: 'revived candidate membership changed',
      mutate: (battle: BattleState) => {
        const piece = battle.pieces.find(entry => entry.instanceId === 'transaction-revived')!
        battle.graveyard.push({ ...piece })
      },
    },
  ])('rejects post-finalization corruption from $name and rolls back the root action', ({
    name,
    message,
    mutate,
  }) => {
    const fixtureKey = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
    const skillId = 'transaction-death-post-finalization-' + fixtureKey
    const state = skillState(skillId, `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var finalized = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      var revived = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-revived'; });
      dealDamage(source, [finalized, revived], 1, 'true', context.battle, 'death-post-finalization-root');
      return { success: true };
    }`, 1)
    state.pieces.find(piece => piece.instanceId === 'transaction-target')!.isCore = true
    const revivedPiece = makePiece({
      instanceId: 'transaction-revived',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 0,
      currentHp: 1,
      maxHp: 10,
    }) as any
    revivedPiece.name = 'Transaction Revived'
    state.pieces.push(revivedPiece)
    const beforeHash = hashBattleState(state)
    const beforeJson = JSON.stringify(state)
    const reviveEvents: string[] = []
    const observedChargePoints: number[] = []
    let attemptedRuntime: RuleRuntime | undefined
    let attemptedScope: BattleState | undefined
    addRule('death-post-finalization-revive-' + fixtureKey, 'onPieceDied', (_battle, context) => {
      if (context.sourcePiece.instanceId !== 'transaction-revived') return { success: false }
      context.sourcePiece.currentHp = 5
      reviveEvents.push(context.sourcePiece.instanceId)
      return { success: true }
    })
    const mutationRule = addRule(
      'death-post-finalization-mutation-' + fixtureKey,
      'afterChargeCrystalDropped',
      (battle) => {
        attemptedRuntime = getActiveRuleRuntime()
        attemptedScope = battle
        if (!attemptedRuntime) throw new Error('missing deterministic runtime')
        attemptedRuntime.nextRandom(RANDOM_STREAM_NAMES.skillEffect)
        attemptedRuntime.nextInstanceId('death-post-finalization-probe')
        attemptedRuntime.clock.now()
        observedChargePoints.push(
          battle.players.find(player => player.playerId === 'player-red')?.chargePoints ?? -1,
        )
        mutate(battle)
      },
      { maxUses: 3, uses: 0, cooldownTurns: 2, currentCooldown: 0 },
    )
    const triggerBefore = globalTriggerSystem.snapshotTransactionState()
    const actionId = 'transaction-death-post-finalization-' + fixtureKey
    let caught: unknown

    try {
      runBattleAction(state, skillAction(skillId, actionId), { rootSeed: ROOT_SEED })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EffectChainFatalError)
    expect(caught).toMatchObject({
      code: 'RVB_EFFECT_CHAIN_BATCH_REJECTED',
      context: {
        actionId,
        chainId: 'effect-chain:' + actionId,
        batchId: expect.any(String),
        parentBatchId: expect.any(String),
        kind: 'death',
        depth: 1,
        originStage: 'damage:death',
        sourceId: 'transaction-source',
        skillId: 'death-post-finalization-root',
        targetId: 'transaction-revived',
        targetIds: ['transaction-revived', 'transaction-target'],
      },
    })
    expect((caught as Error).message).toContain(message)
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(JSON.stringify(state)).toBe(beforeJson)
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
    expect(mutationRule.limits).toEqual({
      maxUses: 3,
      uses: 0,
      cooldownTurns: 2,
      currentCooldown: 0,
    })
    expect(reviveEvents).toEqual(['transaction-revived'])
    expect(observedChargePoints).toEqual([0])
    expectRuntimeReset(attemptedRuntime)
    expect(attemptedRuntime?.snapshot().lastRandomAccess).toBeUndefined()
    expect(getActiveEffectChain(attemptedScope!)).toBeUndefined()
  })

  it('keeps an explicit empty killerPlayerId instead of falling back to attacker ownership', () => {
    const skillId = 'transaction-empty-killer-player'
    const state = skillState(skillId, "function executeSkill(context) { var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; }); var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; }); dealDamage(source, target, 1, 'true', context.battle, 'empty-killer-root', false, ''); return { success: true }; }", 1)

    const result = runBattleAction(
      state,
      skillAction(skillId, 'transaction-empty-killer-player'),
      { rootSeed: ROOT_SEED },
    )

    expect(result.state.pieces.some(piece => piece.instanceId === 'transaction-target')).toBe(false)
    expect(result.state.graveyard.map(piece => piece.instanceId)).toContain('transaction-target')
    expect(result.state.players.find(player => player.playerId === 'player-red')?.chargePoints).toBe(0)
  })


  it('keeps authoritative batch IDs unique across actions and peer cursor sequences identical', () => {
    const skillId = 'transaction-batch-id-cursor'
    const code = `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      dealDamage(source, target, 2, 'true', context.battle, 'batch-id-cursor-root');
      return { success: true };
    }`
    withTemporarySkill(skillId, code, () => {
      const authorityState = skillState(skillId, code, 50)
      const peerState = structuredClone(authorityState)
      const observedIds: string[] = []
      addRule('observe-batch-id-cursor', 'afterDamageDealt', (_battle, context) => {
        if (context.skillId === 'batch-id-cursor-root') observedIds.push(context.effectBatchId)
      })
      const runTwo = (initial: BattleState) => {
        const first = runBattleAction(
          initial,
          skillAction(skillId, 'transaction-batch-id-action-1'),
          { rootSeed: ROOT_SEED },
        )
        const second = runBattleAction(
          first.state,
          skillAction(skillId, 'transaction-batch-id-action-2'),
          { rootSeed: ROOT_SEED },
        )
        return { first, second }
      }

      const authority = runTwo(authorityState)
      const peer = runTwo(peerState)
      const firstId = observedIds[0]
      const secondId = observedIds[1]

      expect(observedIds).toEqual([firstId, secondId, firstId, secondId])
      expect(firstId).not.toBe(secondId)
      expect(authority.first.stateHash).toBe(peer.first.stateHash)
      expect(authority.second.stateHash).toBe(peer.second.stateHash)
      expect(authority.first.trace?.randomStreams.find(stream => stream.name === 'instance-id/damage-batch'))
        .toMatchObject({ startCursor: 0, endCursor: 1 })
      expect(authority.second.trace?.randomStreams.find(stream => stream.name === 'instance-id/damage-batch'))
        .toMatchObject({ startCursor: 1, endCursor: 2 })
      expect(peer.first.trace?.randomStreams.find(stream => stream.name === 'instance-id/damage-batch'))
        .toMatchObject({ startCursor: 0, endCursor: 1 })
      expect(peer.second.trace?.randomStreams.find(stream => stream.name === 'instance-id/damage-batch'))
        .toMatchObject({ startCursor: 1, endCursor: 2 })
    })
  })

  it('keeps legacy fallback batch IDs independent from an ambient RuleRuntime', () => {
    const skillId = 'transaction-ambient-runtime-guard'
    const code = `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      dealDamage(source, target, 1, 'true', context.battle, 'ambient-runtime-root');
      return { success: true };
    }`
    const baselineState = skillState(skillId, code)
    const ambientState = structuredClone(baselineState)
    const observedIds: string[] = []
    addRule('observe-ambient-runtime-batch-id', 'afterDamageDealt', (_battle, context) => {
      if (context.skillId === 'ambient-runtime-root') observedIds.push(context.effectBatchId)
    })

    const baseline = runBattleAction(
      baselineState,
      skillAction(skillId, 'transaction-ambient-runtime-action'),
    )
    const ambientRuntime = new RuleRuntime({ rootSeed: 0x5151, tick: 9 })
    const beforeAmbient = ambientRuntime.snapshot()
    const ambient = withRuleRuntime(ambientRuntime, () => runBattleAction(
      ambientState,
      skillAction(skillId, 'transaction-ambient-runtime-action'),
    ))

    expect(observedIds).toEqual(['damage-batch-0-0', 'damage-batch-0-0'])
    expect(ambient.stateHash).toBe(baseline.stateHash)
    expect(ambient.trace?.randomStreams).toEqual([])
    expect(ambientRuntime.snapshot()).toEqual(beforeAmbient)
  })

  it.each(['damage', 'heal'] as const)(
    'rejects an attached %s facade reentry even when its target array is empty',
    kind => {
      const skillId = `transaction-empty-${kind}-reentry`
      const state = skillState(skillId, `function executeSkill(context) {
        var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
        var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
        dealDamage(source, target, 2, 'true', context.battle, 'empty-reentry-root');
        return { success: true };
      }`)
      let attempted = false
      addRule(`empty-${kind}-reentry-rule`, 'afterDamageDealt', (battle, context) => {
        if (context.skillId !== 'empty-reentry-root' || attempted) return
        attempted = true
        if (kind === 'damage') {
          dealDamage(context.sourcePiece, [], 1, 'true', battle, 'empty-damage-reentry')
        } else {
          healDamage(context.sourcePiece, [], 1, battle, 'empty-heal-reentry')
        }
      })
      const beforeHash = hashBattleState(state)
      const beforeJson = JSON.stringify(state)

      let caught: unknown
      try {
        runBattleAction(
          state,
          skillAction(skillId, `transaction-empty-${kind}-action`),
          { rootSeed: ROOT_SEED },
        )
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(EffectChainFatalError)
      expect((caught as EffectChainFatalError).code).toBe('RVB_EFFECT_CHAIN_REENTRANT')
      expect((caught as EffectChainFatalError).context).toMatchObject({
        kind,
        targetIds: [],
        detached: false,
      })
      expect(hashBattleState(state)).toBe(beforeHash)
      expect(JSON.stringify(state)).toBe(beforeJson)
    },
  )

  it.each(['structured-fake-fatal', 'hostile-proxy'] as const)(
    'restores a queue-writer mapper checkpoint before latching a %s getter failure',
    thrownKind => {
      const actionId = `writer-mapper-${thrownKind}-action`
      const chain = createEffectChain({
        actionId,
        chainId: `effect-chain:writer-mapper-${thrownKind}`,
        turn: 7,
        rootSeed: ROOT_SEED,
      })
      const source = makePiece({
        instanceId: `writer-mapper-${thrownKind}-source`,
        ownerPlayerId: 'player-red',
      }) as any
      const target = makePiece({
        instanceId: `writer-mapper-${thrownKind}-target`,
        ownerPlayerId: 'player-blue',
        faction: 'blue',
      }) as any
      const structuredFakeFatal = {
        name: 'EffectChainFatalError',
        code: 'RVB_EFFECT_CHAIN_STATE_INVALID',
        context: {
          actionId,
          chainId: chain.chainId,
          kind: 'damage',
          depth: 0,
          processed: 0,
          limit: chain.limits.maxBatches,
          turn: 7,
          rootSeed: ROOT_SEED,
          detached: false,
          budget: 'state',
        },
      }
      const hostileTrap = new Error('hostile writer getter trap')
      const hostileProxy = new Proxy(Object.create(null), {
        get: () => { throw hostileTrap },
        getPrototypeOf: () => { throw hostileTrap },
        ownKeys: () => { throw hostileTrap },
      })
      const thrown = thrownKind === 'structured-fake-fatal'
        ? structuredFakeFatal
        : hostileProxy
      const writer = createDamageQueueWriter(chain)
      const validInput = {
        attacker: source,
        target,
        damage: 1,
        damageType: 'true' as const,
        skillId: `writer-mapper-${thrownKind}-recursive`,
      }
      let recursivePushes = 0
      const hostileInput: Record<string, unknown> = {
        target,
        damage: 2,
        damageType: 'true',
        skillId: `writer-mapper-${thrownKind}-outer`,
      }
      Object.defineProperty(hostileInput, 'attacker', {
        enumerable: true,
        get: () => {
          recursivePushes += 1
          writer.push(validInput)
          throw thrown
        },
      })
      const checkpoint = chain.snapshot()

      let caught: unknown
      try {
        writer.push(hostileInput as any)
      } catch (error) {
        caught = error
      }

      expect(recursivePushes).toBe(1)
      expect(isEffectChainFatalError(caught)).toBe(true)
      if (thrownKind === 'structured-fake-fatal') {
        expect(caught).toBe(structuredFakeFatal)
      } else {
        expect(caught).toBeInstanceOf(EffectChainFatalError)
        expect((caught as EffectChainFatalError).cause).toBe(hostileProxy)
      }
      expect(chain.pendingCount).toBe(0)
      expect(chain.records).toEqual([])
      expect(chain.snapshot()).toEqual(checkpoint)

      let latched: unknown
      try {
        chain.assertHealthy()
      } catch (error) {
        latched = error
      }
      expect(latched).toBe(caught)
    },
  )

  it.each(['damage', 'heal'] as const)(
    'latches a hostile %s facade target getter before enqueue even when SkillCode catches it',
    kind => {
      const skillId = `transaction-hostile-${kind}-facade`
      const facadeCall = kind === 'damage'
        ? "dealDamage(source, hostileTarget, 3, 'true', context.battle, 'hostile-damage-facade');"
        : "healDamage(source, hostileTarget, 3, context.battle, 'hostile-heal-facade');"
      const code = `function executeSkill(context) {
        var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
        var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
        var hostileTarget = new Proxy(target, {
          get: function(object, key) {
            if (key === 'instanceId') {
              context.battle.extensions.hostileFacadeGetter =
                (context.battle.extensions.hostileFacadeGetter || 0) + 1;
              throw new Error('hostile ${kind} facade target getter');
            }
            return object[key];
          }
        });
        try { ${facadeCall} } catch (error) {
          context.battle.extensions.hostileFacadeCatch = true;
        }
        context.battle.extensions.hostileFacadeAfter = true;
        return { success: true };
      }`

      withTemporarySkill(skillId, code, () => {
        const state = skillState(skillId, code)
        const actionId = `transaction-hostile-${kind}-facade-action`
        const beforeHash = hashBattleState(state)
        const beforeJson = JSON.stringify(state)
        const triggerBefore = globalTriggerSystem.snapshotTransactionState()

        let caught: unknown
        try {
          runBattleAction(state, skillAction(skillId, actionId), { rootSeed: ROOT_SEED })
        } catch (error) {
          caught = error
        }

        expect(caught).toBeInstanceOf(EffectChainFatalError)
        expect((caught as EffectChainFatalError).code).toBe('RVB_EFFECT_CHAIN_STATE_INVALID')
        expect((caught as EffectChainFatalError).context).toMatchObject({
          actionId,
          chainId: `effect-chain:${actionId}`,
          kind,
          detached: false,
        })
        expect((caught as EffectChainFatalError).cause).toBeInstanceOf(Error)
        expect(((caught as EffectChainFatalError).cause as Error).message)
          .toContain(`hostile ${kind} facade target getter`)
        expect(hashBattleState(state)).toBe(beforeHash)
        expect(JSON.stringify(state)).toBe(beforeJson)
        expect((state.extensions as any).hostileFacadeGetter).toBeUndefined()
        expect((state.extensions as any).hostileFacadeCatch).toBeUndefined()
        expect((state.extensions as any).hostileFacadeAfter).toBeUndefined()
        expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
        expect(getActiveEffectChain(state)).toBeUndefined()
      })
    },
  )

  it.each(['damage', 'heal'] as const)(
    'latches a hostile CardCode %s modifier before enqueue and rolls back payment',
    kind => {
      const cardId = `transaction-hostile-card-${kind}`
      const cardInstanceId = `${cardId}-instance`
      const effectId = `${cardId}-effect`
      const facadeCall = kind === 'damage'
        ? `dealDamage(source, target, hostileValue, 'true', context.battle, '${effectId}');`
        : `healDamage(source, target, hostileValue, context.battle, '${effectId}');`
      const code = `function executeCard(context) {
        var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
        var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
        var hostileValue = new Proxy({}, {
          get: function(object, key) {
            if (key === 'valueOf') return function() {
              context.battle.extensions.hostileCardModifierGetter =
                (context.battle.extensions.hostileCardModifierGetter || 0) + 1;
              throw new Error('hostile CardCode ${kind} modifier');
            };
            return object[key];
          }
        });
        try { ${facadeCall} } catch (error) {
          context.battle.extensions.hostileCardModifierCatch = true;
        }
        context.battle.extensions.hostileCardModifierAfter = true;
        return { success: true };
      }`
      withTemporaryProfile({
        cards: {
          [cardId]: {
            id: cardId,
            name: cardId,
            description: '',
            keywords: [],
            type: 'active',
            actionPointCost: 2,
            code,
            targeting: { steps: [] },
          },
        },
      }, () => {
        const source = makePiece({
          instanceId: 'transaction-source',
          ownerPlayerId: 'player-red',
          x: 0,
          y: 0,
          currentHp: 100,
          maxHp: 100,
        }) as any
        const target = makePiece({
          instanceId: 'transaction-target',
          ownerPlayerId: 'player-blue',
          faction: 'blue',
          x: 1,
          y: 0,
          currentHp: 30,
          maxHp: 100,
        }) as any
        const state = makeState({
          pieces: [source, target],
          currentPlayerId: 'player-red',
          phase: 'action',
          turnNumber: 7,
        }) as any
        state.players[0].actionPoints = 20
        state.players[0].hand = [{
          cardId,
          instanceId: cardInstanceId,
          ownerPlayerId: 'player-red',
          actionPointCost: 2,
        }]
        const actionId = `${cardId}-action`
        const beforeHash = hashBattleState(state)
        const beforeJson = JSON.stringify(state)

        let caught: unknown
        try {
          runBattleAction(state, {
            type: 'playCard',
            playerId: 'player-red',
            cardInstanceId,
            clientActionId: actionId,
          } as any, { rootSeed: ROOT_SEED })
        } catch (error) {
          caught = error
        }

        expect(caught).toBeInstanceOf(EffectChainFatalError)
        expect((caught as EffectChainFatalError).code).toBe('RVB_EFFECT_CHAIN_STATE_INVALID')
        expect((caught as EffectChainFatalError).context).toMatchObject({
          actionId,
          chainId: `effect-chain:${actionId}`,
          kind,
          sourceId: cardInstanceId,
          skillId: effectId,
          targetId: 'transaction-target',
          targetIds: ['transaction-target'],
          detached: false,
        })
        expect((caught as EffectChainFatalError).cause).toBeInstanceOf(Error)
        expect(((caught as EffectChainFatalError).cause as Error).message)
          .toContain(`hostile CardCode ${kind} modifier`)
        expect(hashBattleState(state)).toBe(beforeHash)
        expect(JSON.stringify(state)).toBe(beforeJson)
        expect(state.players[0].actionPoints).toBe(20)
        expect(state.players[0].hand).toHaveLength(1)
        expect(state.players[0].discardPile ?? []).toEqual([])
        expect((state.extensions as any).hostileCardModifierGetter).toBeUndefined()
        expect((state.extensions as any).hostileCardModifierCatch).toBeUndefined()
        expect((state.extensions as any).hostileCardModifierAfter).toBeUndefined()
        expect(getActiveEffectChain(state)).toBeUndefined()
      })
    },
  )

  it('classifies a hostile thrown CardCode Proxy as one latched fatal and rolls back payment', () => {
    const cardId = 'transaction-hostile-thrown-card-proxy'
    const cardInstanceId = `${cardId}-instance`
    const actionId = `${cardId}-action`
    const code = `function executeCard(context) {
      context.battle.extensions.hostileThrownCardLeak = true;
      throw new Proxy({}, {
        get: function() { throw new Error('hostile thrown card get trap'); },
        getPrototypeOf: function() { throw new Error('hostile thrown card prototype trap'); }
      });
    }`

    withTemporaryProfile({
      cards: {
        [cardId]: {
          id: cardId,
          name: cardId,
          description: '',
          keywords: [],
          type: 'active',
          actionPointCost: 2,
          code,
          targeting: { steps: [] },
        },
      },
    }, () => {
      const source = makePiece({
        instanceId: 'transaction-source',
        ownerPlayerId: 'player-red',
        x: 0,
        y: 0,
        currentHp: 100,
        maxHp: 100,
      }) as any
      const state = makeState({
        pieces: [source],
        currentPlayerId: 'player-red',
        phase: 'action',
        turnNumber: 7,
      }) as any
      state.players[0].actionPoints = 20
      state.players[0].hand = [{
        cardId,
        instanceId: cardInstanceId,
        ownerPlayerId: 'player-red',
        actionPointCost: 2,
      }]
      let observedChain: EffectChain | undefined
      addRule('observe-hostile-thrown-card-chain', 'beforeCardPlay', battle => {
        observedChain = getActiveEffectChain(battle)
      })
      const beforeHash = hashBattleState(state)
      const beforeJson = JSON.stringify(state)

      let caught: unknown
      try {
        runBattleAction(state, {
          type: 'playCard',
          playerId: 'player-red',
          cardInstanceId,
          clientActionId: actionId,
        } as any, { rootSeed: ROOT_SEED })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(EffectChainFatalError)
      expect((caught as EffectChainFatalError).code).toBe('RVB_EFFECT_CHAIN_STATE_INVALID')
      expect((caught as EffectChainFatalError).context).toMatchObject({
        actionId,
        chainId: `effect-chain:${actionId}`,
        kind: null,
        skillId: cardId,
        detached: false,
      })
      expect((caught as EffectChainFatalError).cause).toBeDefined()
      expect(observedChain).toBeDefined()
      let latched: unknown
      try {
        observedChain!.assertHealthy()
      } catch (error) {
        latched = error
      }
      expect(latched).toBe(caught)
      expect(hashBattleState(state)).toBe(beforeHash)
      expect(JSON.stringify(state)).toBe(beforeJson)
      expect(state.players[0]).toMatchObject({ actionPoints: 20 })
      expect(state.players[0].hand).toHaveLength(1)
      expect(state.players[0].discardPile ?? []).toEqual([])
      expect((state.extensions as any).hostileThrownCardLeak).toBeUndefined()
      expect(getActiveEffectChain(state)).toBeUndefined()
    })
  })

  it('classifies a hostile thrown Rule SkillCode Proxy as fatal and rolls back the root action', () => {
    const ruleId = 'transaction-hostile-thrown-rule-proxy'
    const skillId = 'transaction-hostile-rule-proxy-root'
    const actionId = `${ruleId}-action`
    const rootCode = `function executeSkill() { return { success: true }; }`
    withTemporaryProfile({
      rules: {
        [ruleId]: {
          id: ruleId,
          name: ruleId,
          description: '',
          trigger: { type: 'beforeSkillUse' },
          skillCode: `throw new Proxy({}, {
            get: function() { throw new Error('hostile thrown rule get trap'); },
            getPrototypeOf: function() { throw new Error('hostile thrown rule prototype trap'); }
          });`,
        },
      },
      skills: { [skillId]: skillDefinition(skillId, rootCode) },
    }, () => {
      const state = skillState(skillId, rootCode)
      state.pieces[0].rules = [{ id: ruleId }] as any
      const beforeHash = hashBattleState(state)
      const beforeJson = JSON.stringify(state)

      let caught: unknown
      try {
        runBattleAction(state, skillAction(skillId, actionId), { rootSeed: ROOT_SEED })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(EffectChainFatalError)
      expect((caught as EffectChainFatalError).code).toBe('RVB_EFFECT_CHAIN_STATE_INVALID')
      expect((caught as EffectChainFatalError).context).toMatchObject({
        actionId,
        chainId: `effect-chain:${actionId}`,
        kind: null,
        sourceId: 'transaction-source',
        skillId: ruleId,
        detached: false,
      })
      expect((caught as EffectChainFatalError).cause).toBeDefined()
      expect(hashBattleState(state)).toBe(beforeHash)
      expect(JSON.stringify(state)).toBe(beforeJson)
      expect(getActiveEffectChain(state)).toBeUndefined()
    })
  })

  it.each(['damage', 'heal'] as const)(
    'latches CardCode %s after authored code replaces the authoritative card instance',
    kind => {
      const cardId = `transaction-replaced-card-instance-${kind}`
      const cardInstanceId = `${cardId}-instance`
      const effectId = `${cardId}-effect`
      const facadeCall = kind === 'damage'
        ? `dealDamage(source, target, 3, 'true', context.battle, '${effectId}');`
        : `healDamage(source, target, 3, context.battle, '${effectId}');`
      const code = `function executeCard(context) {
        var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
        var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
        context.cardInstance = new Proxy(context.cardInstance, {
          get: function() {
            context.battle.extensions.replacedCardInstanceGetter = true;
            throw new Error('hostile replaced card instance getter');
          }
        });
        try { ${facadeCall} } catch (error) {
          context.battle.extensions.replacedCardInstanceCatch = true;
        }
        context.battle.extensions.replacedCardInstanceAfter = true;
        return { success: true };
      }`
      withTemporaryProfile({
        cards: {
          [cardId]: {
            id: cardId,
            name: cardId,
            description: '',
            keywords: [],
            type: 'active',
            actionPointCost: 2,
            code,
            targeting: { steps: [] },
          },
        },
      }, () => {
        const source = makePiece({
          instanceId: 'transaction-source',
          ownerPlayerId: 'player-red',
          x: 0,
          y: 0,
          currentHp: 100,
          maxHp: 100,
        }) as any
        const target = makePiece({
          instanceId: 'transaction-target',
          ownerPlayerId: 'player-blue',
          faction: 'blue',
          x: 1,
          y: 0,
          currentHp: 30,
          maxHp: 100,
        }) as any
        const state = makeState({
          pieces: [source, target],
          currentPlayerId: 'player-red',
          phase: 'action',
          turnNumber: 7,
        }) as any
        state.players[0].actionPoints = 20
        state.players[0].hand = [{
          cardId,
          instanceId: cardInstanceId,
          ownerPlayerId: 'player-red',
          actionPointCost: 2,
        }]
        const actionId = `${cardId}-action`
        const beforeHash = hashBattleState(state)
        const beforeJson = JSON.stringify(state)

        let caught: unknown
        try {
          runBattleAction(state, {
            type: 'playCard',
            playerId: 'player-red',
            cardInstanceId,
            clientActionId: actionId,
          } as any, { rootSeed: ROOT_SEED })
        } catch (error) {
          caught = error
        }

        expect(caught).toBeInstanceOf(EffectChainFatalError)
        expect((caught as EffectChainFatalError).code).toBe('RVB_EFFECT_CHAIN_STATE_INVALID')
        expect((caught as EffectChainFatalError).context).toMatchObject({
          actionId,
          chainId: `effect-chain:${actionId}`,
          kind,
          sourceId: cardInstanceId,
          skillId: effectId,
          targetId: undefined,
          detached: false,
        })
        expect((caught as EffectChainFatalError).cause).toBeInstanceOf(Error)
        expect(((caught as EffectChainFatalError).cause as Error).message)
          .toContain('replaced its authoritative card instance')
        expect(hashBattleState(state)).toBe(beforeHash)
        expect(JSON.stringify(state)).toBe(beforeJson)
        expect(state.players[0].actionPoints).toBe(20)
        expect(state.players[0].hand).toHaveLength(1)
        expect(state.players[0].discardPile ?? []).toEqual([])
        expect((state.extensions as any).replacedCardInstanceGetter).toBeUndefined()
        expect((state.extensions as any).replacedCardInstanceCatch).toBeUndefined()
        expect((state.extensions as any).replacedCardInstanceAfter).toBeUndefined()
        expect(getActiveEffectChain(state)).toBeUndefined()
      })
    },
  )

  it('rethrows a SkillCode handler fatal even when the script catches it and returns success', () => {
    const skillId = 'transaction-swallowed-skill-fatal'
    const state = skillState(skillId, `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      try {
        dealDamage(source, [target, target], 1, 'true', context.battle, 'swallowed-skill-duplicate');
      } catch (error) {}
      context.battle.extensions.swallowedSkillFatalLeak = true;
      return { success: true };
    }`)
    const beforeHash = hashBattleState(state)
    const beforeJson = JSON.stringify(state)
    const triggerBefore = globalTriggerSystem.snapshotTransactionState()

    let caught: unknown
    try {
      runBattleAction(
        state,
        skillAction(skillId, 'transaction-swallowed-skill-action'),
        { rootSeed: ROOT_SEED },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EffectChainFatalError)
    expect((caught as EffectChainFatalError).context).toMatchObject({
      kind: 'damage',
      skillId: 'swallowed-skill-duplicate',
      detached: false,
    })
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(JSON.stringify(state)).toBe(beforeJson)
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
  })

  it('rethrows the first latched fatal when authored SkillCode catches it and throws a mask', () => {
    const skillId = 'transaction-masked-skill-fatal'
    const actionId = 'transaction-masked-skill-fatal-action'
    const state = skillState(skillId, `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      try {
        dealDamage(source, [target, target], 1, 'true', context.battle, 'masked-skill-duplicate');
      } catch (error) {
        throw new Proxy({}, {
          get: function() { throw new Error('authored fatal mask get trap'); },
          getPrototypeOf: function() { throw new Error('authored fatal mask prototype trap'); }
        });
      }
      return { success: true };
    }`)
    let observedChain: EffectChain | undefined
    addRule('observe-masked-fatal-chain', 'beforeSkillUse', battle => {
      observedChain = getActiveEffectChain(battle)
    })
    const beforeHash = hashBattleState(state)
    const beforeJson = JSON.stringify(state)
    const triggerBefore = globalTriggerSystem.snapshotTransactionState()

    let caught: unknown
    try {
      runBattleAction(state, skillAction(skillId, actionId), { rootSeed: ROOT_SEED })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EffectChainFatalError)
    expect((caught as EffectChainFatalError).context).toMatchObject({
      actionId,
      chainId: `effect-chain:${actionId}`,
      kind: 'damage',
      skillId: 'masked-skill-duplicate',
      detached: false,
    })
    expect(observedChain).toBeDefined()
    let latched: unknown
    try {
      observedChain!.assertHealthy()
    } catch (error) {
      latched = error
    }
    expect(latched).toBe(caught)
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(JSON.stringify(state)).toBe(beforeJson)
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
    expect(getActiveEffectChain(state)).toBeUndefined()
  })

  it('latches an idle fireEvent hostile Proxy even when root SkillCode catches the thrown value', () => {
    const trapError = new Error('hostile idle fireEvent trap')
    const hostile = new Proxy(Object.create(null), {
      get: () => { throw trapError },
      getPrototypeOf: () => { throw trapError },
      ownKeys: () => { throw trapError },
    })
    let attemptedRuntime: RuleRuntime | undefined
    let attemptedScope: BattleState | undefined
    const throwingRule = addRule(
      'transaction-hostile-idle-fire-event-rule',
      'red139HostileIdleFireEvent',
      battle => {
        attemptedRuntime = getActiveRuleRuntime()
        attemptedScope = battle
        attemptedRuntime!.nextRandom(RANDOM_STREAM_NAMES.skillEffect)
        attemptedRuntime!.clock.now()
        ;(battle.extensions as any).hostileIdleRuleLeak = true
        if (!battle.actions) battle.actions = []
        battle.actions.push({
          type: 'triggerEffect',
          playerId: 'player-red',
          turn: battle.turn.turnNumber,
          payload: { message: 'hostile idle log leak' },
        } as any)
        throw hostile
      },
      { maxUses: 10, uses: 0, cooldownTurns: 2, currentCooldown: 0 },
    )
    const skillId = 'transaction-hostile-idle-fire-event'
    const code = `function executeSkill(context) {
      try {
        fireEvent('red139HostileIdleFireEvent', {
          sourcePiece: context.piece,
          playerId: context.piece.ownerPlayerId
        });
      } catch (error) {}
      context.battle.extensions.hostileIdleAuthoredCatchLeak = true;
      return { success: true };
    }`
    withTemporarySkill(skillId, code, () => {
      const state = skillState(skillId, code)
      const actionId = 'transaction-hostile-idle-fire-event-action'
      const beforeHash = hashBattleState(state)
      const beforeJson = JSON.stringify(state)
      const beforeActions = JSON.stringify(state.actions ?? [])
      const triggerBefore = globalTriggerSystem.snapshotTransactionState()

      let caught: unknown
      try {
        runBattleAction(state, skillAction(skillId, actionId), { rootSeed: ROOT_SEED })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(EffectChainFatalError)
      expect(isEffectChainFatalError(caught)).toBe(true)
      expect((caught as EffectChainFatalError).context).toMatchObject({
        actionId,
        chainId: `effect-chain:${actionId}`,
        kind: null,
        detached: false,
      })
      expect((caught as EffectChainFatalError).cause).toBeInstanceOf(Error)
      expect(((caught as EffectChainFatalError).cause as any).triggerContext).toMatchObject({
        eventType: 'red139HostileIdleFireEvent',
        consumerKind: 'rule',
        consumerId: 'transaction-hostile-idle-fire-event-rule',
      })
      expect(hashBattleState(state)).toBe(beforeHash)
      expect(JSON.stringify(state)).toBe(beforeJson)
      expect(JSON.stringify(state.actions ?? [])).toBe(beforeActions)
      expect((state.extensions as any).hostileIdleRuleLeak).toBeUndefined()
      expect((state.extensions as any).hostileIdleAuthoredCatchLeak).toBeUndefined()
      expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
      expect(throwingRule.limits).toEqual({
        maxUses: 10,
        uses: 0,
        cooldownTurns: 2,
        currentCooldown: 0,
      })
      expectRuntimeReset(attemptedRuntime)
      expect(getActiveEffectChain(attemptedScope!)).toBeUndefined()
      expect(getActiveEffectChain(state)).toBeUndefined()
    })
  })

  it('latches a hostile fireEvent child-context spread before dispatch when SkillCode catches it', () => {
    const skillId = 'transaction-hostile-fire-event-spread'
    const code = `function executeSkill(context) {
      var hostileContext = new Proxy({}, {
        ownKeys: function() {
          context.battle.extensions.hostileFireEventOwnKeys =
            (context.battle.extensions.hostileFireEventOwnKeys || 0) + 1;
          throw new Error('hostile fireEvent childContext ownKeys');
        }
      });
      try { fireEvent('red139HostileSpread', hostileContext); } catch (error) {
        context.battle.extensions.hostileFireEventCatch = true;
      }
      context.battle.extensions.hostileFireEventAfter = true;
      return { success: true };
    }`
    withTemporarySkill(skillId, code, () => {
      const state = skillState(skillId, code)
      const actionId = 'transaction-hostile-fire-event-spread-action'
      const beforeHash = hashBattleState(state)
      const beforeJson = JSON.stringify(state)
      const triggerBefore = globalTriggerSystem.snapshotTransactionState()

      let caught: unknown
      try {
        runBattleAction(state, skillAction(skillId, actionId), { rootSeed: ROOT_SEED })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(EffectChainFatalError)
      expect((caught as EffectChainFatalError).code).toBe('RVB_EFFECT_CHAIN_STATE_INVALID')
      expect((caught as EffectChainFatalError).context).toMatchObject({
        actionId,
        chainId: `effect-chain:${actionId}`,
        kind: null,
        detached: false,
      })
      expect((caught as EffectChainFatalError).cause).toBeInstanceOf(Error)
      expect(((caught as EffectChainFatalError).cause as Error).message)
        .toContain('hostile fireEvent childContext ownKeys')
      expect(hashBattleState(state)).toBe(beforeHash)
      expect(JSON.stringify(state)).toBe(beforeJson)
      expect((state.extensions as any).hostileFireEventOwnKeys).toBeUndefined()
      expect((state.extensions as any).hostileFireEventCatch).toBeUndefined()
      expect((state.extensions as any).hostileFireEventAfter).toBeUndefined()
      expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
      expect(getActiveEffectChain(state)).toBeUndefined()
    })
  })

  it('wraps and latches a legacy trigger fatal marker even when SkillCode catches it', () => {
    const marker = { fatal: true, reason: 'legacy-red139-fatal-marker' }
    const markerRule = addRule(
      'transaction-legacy-fatal-marker-rule',
      'red139LegacyFatalMarker',
      () => { throw marker },
      { maxUses: 10, uses: 0 },
    )
    const skillId = 'transaction-legacy-fatal-marker'
    const code = `function executeSkill(context) {
      try { fireEvent('red139LegacyFatalMarker', { sourcePiece: context.piece }); } catch (error) {
        context.battle.extensions.legacyFatalCatch = true;
      }
      context.battle.extensions.legacyFatalAfter = true;
      return { success: true };
    }`
    withTemporarySkill(skillId, code, () => {
      const state = skillState(skillId, code)
      const actionId = 'transaction-legacy-fatal-marker-action'
      const beforeHash = hashBattleState(state)
      const beforeJson = JSON.stringify(state)

      let caught: unknown
      try {
        runBattleAction(state, skillAction(skillId, actionId), { rootSeed: ROOT_SEED })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(EffectChainFatalError)
      expect((caught as EffectChainFatalError).code).toBe('RVB_EFFECT_CHAIN_STATE_INVALID')
      expect((caught as EffectChainFatalError).cause).toBe(marker)
      expect((caught as EffectChainFatalError).context).toMatchObject({
        actionId,
        chainId: `effect-chain:${actionId}`,
        sourceId: 'transaction-legacy-fatal-marker-rule',
        skillId: 'transaction-legacy-fatal-marker-rule',
        detached: false,
      })
      expect(hashBattleState(state)).toBe(beforeHash)
      expect(JSON.stringify(state)).toBe(beforeJson)
      expect((state.extensions as any).legacyFatalCatch).toBeUndefined()
      expect((state.extensions as any).legacyFatalAfter).toBeUndefined()
      expect(markerRule.limits).toEqual({ maxUses: 10, uses: 0 })
      expect(getActiveEffectChain(state)).toBeUndefined()
    })
  })

  it('strictly validates a direct attached skill definition before targeting with source diagnostics', () => {
    const skillId = 'transaction-direct-attached-definition'
    const code = 'function executeSkill() { return { success: true }; }'
    withTemporarySkill(skillId, code, () => {
      const state = skillState(skillId, code)
      state.skillsById[skillId] = { ...state.skillsById[skillId], id: 'wrong-skill-id' }
      const actionId = 'transaction-direct-attached-definition-action'
      const chain = createEffectChain({
        actionId,
        chainId: `effect-chain:${actionId}`,
        turn: state.turn.turnNumber,
        rootSeed: ROOT_SEED,
      })
      const beforeJson = JSON.stringify(state)

      let caught: unknown
      try {
        withEffectChain(state, chain, () => applyBattleAction(state, skillAction(skillId, actionId)))
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(EffectChainFatalError)
      expect((caught as EffectChainFatalError).context).toMatchObject({
        actionId,
        chainId: `effect-chain:${actionId}`,
        sourceId: 'transaction-source',
        skillId,
        detached: false,
      })
      expect(JSON.stringify(state)).toBe(beforeJson)
      expect(() => chain.assertHealthy()).toThrow(caught)
      expect(getActiveEffectChain(state)).toBeUndefined()
    })
  })

  it('strictly validates a direct attached custom-card definition from the owning hand', () => {
    const cardId = 'transaction-direct-attached-invalid-card'
    const cardInstanceId = `${cardId}-instance`
    const state = skillState(
      'transaction-direct-attached-card-placeholder',
      'function executeSkill() { return { success: true }; }',
    ) as any
    state.players[0].hand = [{
      cardId,
      instanceId: cardInstanceId,
      ownerPlayerId: 'player-red',
      actionPointCost: 0,
    }]
    state.customCards = {
      [cardId]: {
        id: 'wrong-custom-card-id',
        name: cardId,
        description: '',
        type: 'active',
        code: 'function executeCard() { return { success: true }; }',
      },
    }
    const actionId = 'transaction-direct-attached-invalid-card-action'
    const chain = createEffectChain({
      actionId,
      chainId: `effect-chain:${actionId}`,
      turn: state.turn.turnNumber,
      rootSeed: ROOT_SEED,
    })
    const beforeJson = JSON.stringify(state)

    let caught: unknown
    try {
      withEffectChain(state, chain, () => applyBattleAction(state, {
        type: 'playCard',
        playerId: 'player-red',
        cardInstanceId,
        clientActionId: actionId,
      } as any))
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EffectChainFatalError)
    expect((caught as EffectChainFatalError).context).toMatchObject({
      actionId,
      chainId: `effect-chain:${actionId}`,
      sourceId: cardInstanceId,
      skillId: cardId,
      detached: false,
    })
    expect(JSON.stringify(state)).toBe(beforeJson)
    expect(() => chain.assertHealthy()).toThrow(caught)
    expect(getActiveEffectChain(state)).toBeUndefined()
  })

  it('keeps an invalid direct attached action as ACTION_INVALID before definition loading', () => {
    const skillId = 'transaction-direct-attached-invalid-source'
    const state = skillState(skillId, 'function executeSkill() { return { success: true }; }')
    state.skillsById[skillId] = { ...state.skillsById[skillId], id: 'wrong-skill-id' }
    const actionId = 'transaction-direct-attached-invalid-source-action'
    const chain = createEffectChain({
      actionId,
      chainId: `effect-chain:${actionId}`,
      turn: state.turn.turnNumber,
      rootSeed: ROOT_SEED,
    })

    let caught: unknown
    try {
      withEffectChain(state, chain, () => applyBattleAction(state, {
        ...skillAction(skillId, actionId),
        pieceId: 'missing-source-piece',
      }))
    } catch (error) {
      caught = error
    }

    expect(caught).not.toBeInstanceOf(EffectChainFatalError)
    expect(caught).toMatchObject({ code: 'ACTION_INVALID' })
    expect(() => chain.assertHealthy()).not.toThrow()
    expect(getActiveEffectChain(state)).toBeUndefined()
  })

  it('rethrows an ordinary lifecycle error after SkillCode catches the facade failure', () => {
    let attemptedRuntime: RuleRuntime | undefined
    let attemptedScope: BattleState | undefined
    const throwingRule = addRule(
      'transaction-ordinary-lifecycle-rule',
      'afterDamageDealt',
      (battle, context) => {
        if (context.skillId !== 'swallowed-ordinary-rule-root') return
        attemptedRuntime = getActiveRuleRuntime()
        attemptedScope = battle
        attemptedRuntime!.nextRandom(RANDOM_STREAM_NAMES.skillEffect)
        ;(battle.extensions as any).ordinaryRuleLeak = true
        throw new Error('ordinary lifecycle failure')
      },
      { maxUses: 10, uses: 0 },
    )
    const skillId = 'transaction-swallowed-ordinary-rule'
    const state = skillState(skillId, `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      try {
        dealDamage(source, target, 2, 'true', context.battle, 'swallowed-ordinary-rule-root');
      } catch (error) {}
      context.battle.extensions.swallowedOrdinaryRuleLeak = true;
      return { success: true };
    }`)
    const beforeHash = hashBattleState(state)
    const beforeJson = JSON.stringify(state)
    const triggerBefore = globalTriggerSystem.snapshotTransactionState()

    let caught: unknown
    try {
      runBattleAction(
        state,
        skillAction(skillId, 'transaction-swallowed-ordinary-rule-action'),
        { rootSeed: ROOT_SEED },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EffectChainFatalError)
    expect((caught as EffectChainFatalError).code).toBe('RVB_EFFECT_CHAIN_BATCH_REJECTED')
    expect((caught as EffectChainFatalError).cause).toBeInstanceOf(Error)
    expect(((caught as EffectChainFatalError).cause as Error).message)
      .toContain('ordinary lifecycle failure')
    expect((caught as EffectChainFatalError).context).toMatchObject({
      kind: 'damage',
      skillId: 'swallowed-ordinary-rule-root',
      sourceId: 'transaction-source',
      targetId: 'transaction-target',
      detached: false,
    })
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(JSON.stringify(state)).toBe(beforeJson)
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
    expect(throwingRule.limits).toEqual({ maxUses: 10, uses: 0 })
    expectRuntimeReset(attemptedRuntime)
    expect(getActiveEffectChain(attemptedScope!)).toBeUndefined()
  })


  it('fails a real authored Rule skillCode closed instead of returning a soft failure', () => {
    const skillId = 'transaction-authored-rule-ordinary-error'
    const state = skillState(skillId, `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      try {
        dealDamage(source, target, 2, 'true', context.battle, 'authored-rule-ordinary-root');
      } catch (error) {}
      context.battle.extensions.authoredRuleOrdinaryLeak = true;
      return { success: true };
    }`)
    const target = state.pieces.find(piece => piece.instanceId === 'transaction-target') as any
    const authoredRule = loadRuleById('rule-watcher-rage-taken', true)
    expect(authoredRule).toBeDefined()
    if (!authoredRule) return
    target.rules = [authoredRule]
    target.statusTags = { invalidSerializedShape: true }
    const beforeHash = hashBattleState(state)
    const beforeJson = JSON.stringify(state)
    const triggerBefore = globalTriggerSystem.snapshotTransactionState()

    let caught: unknown
    try {
      runBattleAction(
        state,
        skillAction(skillId, 'transaction-authored-rule-ordinary-action'),
        { rootSeed: ROOT_SEED },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EffectChainFatalError)
    expect((caught as EffectChainFatalError).code).toBe('RVB_EFFECT_CHAIN_BATCH_REJECTED')
    expect((caught as EffectChainFatalError).cause).toBeInstanceOf(Error)
    expect((caught as EffectChainFatalError).context).toMatchObject({
      kind: 'damage',
      skillId: 'rule-watcher-rage-taken',
      sourceId: 'transaction-target',
      targetId: 'transaction-source',
      detached: false,
    })
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(JSON.stringify(state)).toBe(beforeJson)
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
  })
  it('rethrows an ordinary reactive CardCode error after root SkillCode catches it', () => {
    let attemptedRuntime: RuleRuntime | undefined
    const probeRule = addRule(
      'transaction-ordinary-card-runtime-probe',
      'afterDamageDealt',
      (battle, context) => {
        if (context.skillId !== 'swallowed-ordinary-card-root') return
        attemptedRuntime = getActiveRuleRuntime()
        attemptedRuntime!.nextRandom(RANDOM_STREAM_NAMES.skillEffect)
        ;(battle.extensions as any).ordinaryCardProbeLeak = true
      },
      { maxUses: 10, uses: 0 },
    )
    const skillId = 'transaction-swallowed-ordinary-card'
    const state = skillState(skillId, `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      try {
        dealDamage(source, target, 2, 'true', context.battle, 'swallowed-ordinary-card-root');
      } catch (error) {}
      context.battle.extensions.swallowedOrdinaryCardLeak = true;
      return { success: true };
    }`)
    state.players[0].hand = [{
      cardId: 'transaction-ordinary-card',
      instanceId: 'transaction-ordinary-card-1',
      ownerPlayerId: 'player-red',
    }] as any
    ;(state as any).customCards = {
      'transaction-ordinary-card': {
        id: 'transaction-ordinary-card',
        name: 'Ordinary CardCode failure probe',
        description: '',
        type: 'reactive',
        actionPointCost: 0,
        trigger: { type: 'afterDamageDealt' },
        code: `function executeCard(context) {
          context.battle.extensions.ordinaryCardCodeLeak = true;
          throw new Error('ordinary reactive CardCode failure');
        }`,
      },
    }
    const beforeHash = hashBattleState(state)
    const beforeJson = JSON.stringify(state)
    const triggerBefore = globalTriggerSystem.snapshotTransactionState()

    let caught: unknown
    try {
      runBattleAction(
        state,
        skillAction(skillId, 'transaction-swallowed-ordinary-card-action'),
        { rootSeed: ROOT_SEED },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EffectChainFatalError)
    expect((caught as EffectChainFatalError).code).toBe('RVB_EFFECT_CHAIN_BATCH_REJECTED')
    expect((caught as EffectChainFatalError).cause).toBeInstanceOf(Error)
    expect(((caught as EffectChainFatalError).cause as Error).message)
      .toContain('ordinary reactive CardCode failure')
    expect((caught as EffectChainFatalError).context).toMatchObject({
      kind: 'damage',
      skillId: 'transaction-ordinary-card',
      sourceId: 'transaction-source',
      targetId: 'transaction-target',
      detached: false,
    })
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(JSON.stringify(state)).toBe(beforeJson)
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
    expect(probeRule.limits).toEqual({ maxUses: 10, uses: 0 })
    expectRuntimeReset(attemptedRuntime)
  })

  it('rethrows a reactive CardCode reentry fatal even when the card catches it and returns success', () => {
    const skillId = 'transaction-swallowed-card-fatal'
    const state = skillState(skillId, `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      dealDamage(source, target, 2, 'true', context.battle, 'swallowed-card-root');
      return { success: true };
    }`)
    state.players[0].hand = [{
      cardId: 'transaction-swallowed-card',
      instanceId: 'transaction-swallowed-card-1',
      ownerPlayerId: 'player-red',
    }] as any
    ;(state as any).customCards = {
      'transaction-swallowed-card': {
        id: 'transaction-swallowed-card',
        name: 'Swallowed fatal probe',
        description: '',
        type: 'reactive',
        actionPointCost: 0,
        trigger: { type: 'afterDamageDealt' },
        code: `function executeCard(context) {
          try {
            dealDamage(context.sourcePiece, [context.targetPiece], 1, 'true', context.battle, 'swallowed-card-reentry');
          } catch (error) {}
          context.battle.extensions.swallowedCardFatalLeak = true;
          return { success: true };
        }`,
      },
    }
    const beforeHash = hashBattleState(state)
    const beforeJson = JSON.stringify(state)
    const triggerBefore = globalTriggerSystem.snapshotTransactionState()

    let caught: unknown
    try {
      runBattleAction(
        state,
        skillAction(skillId, 'transaction-swallowed-card-action'),
        { rootSeed: ROOT_SEED },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EffectChainFatalError)
    expect((caught as EffectChainFatalError).code).toBe('RVB_EFFECT_CHAIN_REENTRANT')
    expect((caught as EffectChainFatalError).context).toMatchObject({
      kind: 'damage',
      skillId: 'swallowed-card-reentry',
      detached: false,
    })
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(JSON.stringify(state)).toBe(beforeJson)
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
  })
  it('makes reactive CardCode direct damage reentry fatal and rolls back the root action', () => {
    const skillId = 'transaction-reactive-direct-damage'
    const state = skillState(skillId, `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      dealDamage(source, target, 2, 'true', context.battle, 'reactive-root-damage');
      return { success: true };
    }`)
    state.players[0].hand = [{
      cardId: 'transaction-reactive-card',
      instanceId: 'transaction-reactive-card-1',
      ownerPlayerId: 'player-red',
    }] as any
    ;(state as any).customCards = {
      'transaction-reactive-card': {
        id: 'transaction-reactive-card',
        name: 'Reactive direct damage probe',
        description: '',
        type: 'reactive',
        actionPointCost: 0,
        trigger: { type: 'afterDamageDealt' },
        code: `function executeCard(context) {
          context.battle.extensions.reactiveDirectDamageLeak = true;
          try {
            dealDamage(context.sourcePiece, context.targetPiece, 1, 'true', context.battle, 'reactive-direct-damage');
          } catch (error) {
            error.needsTargetSelection = true;
            throw error;
          }
          return { success: true };
        }`,
      },
    }
    const beforeHash = hashBattleState(state)
    const beforeJson = JSON.stringify(state)

    let caught: unknown
    try {
      runBattleAction(state, skillAction(skillId, 'transaction-reactive-action'), { rootSeed: ROOT_SEED })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EffectChainFatalError)
    expect((caught as EffectChainFatalError).code).toBe('RVB_EFFECT_CHAIN_REENTRANT')
    expect((caught as EffectChainFatalError).context).toMatchObject({
      actionId: 'transaction-reactive-action',
      chainId: 'effect-chain:transaction-reactive-action',
      batchId: expect.any(String),
      kind: 'damage',
      depth: 0,
      turn: 7,
      rootSeed: ROOT_SEED,
      sourceId: 'transaction-source',
      skillId: 'reactive-direct-damage',
      targetIds: ['transaction-target'],
      detached: false,
      budget: 'state',
    })
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(JSON.stringify(state)).toBe(beforeJson)
  })

  it('rejects an invalid queued DeathBatch and rolls back the root transaction', () => {
    let attemptedRuntime: RuleRuntime | undefined
    let attemptedScope: BattleState | undefined
    const invalidDeathRule = addRule(
      'enqueue-invalid-death',
      'afterDamageDealt',
      (battle, context) => {
        if (context.skillId !== 'invalid-death-root') return
        attemptedScope = battle
        attemptedRuntime = getActiveRuleRuntime()
        attemptedRuntime!.nextRandom(RANDOM_STREAM_NAMES.skillEffect)
        ;(battle.extensions as any).invalidDeathLeak = true
        createInternalDeathQueueWriter(getActiveEffectChain(battle)!).push({
          candidates: [{
            piece: context.targetPiece,
            attacker: context.sourcePiece,
            skillId: 'invalid-death-child',
          }],
        })
      },
      { maxUses: 10, uses: 0 },
    )
    const skillId = 'transaction-invalid-death'
    const state = skillState(skillId, `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      dealDamage(source, target, 2, 'true', context.battle, 'invalid-death-root');
      return { success: true };
    }`)
    const beforeHash = hashBattleState(state)
    const beforeJson = JSON.stringify(state)
    const triggerBefore = globalTriggerSystem.snapshotTransactionState()

    let caught: unknown
    try {
      runBattleAction(state, skillAction(skillId, 'transaction-invalid-death-action'), { rootSeed: ROOT_SEED })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EffectChainFatalError)
    expect((caught as EffectChainFatalError).code).toBe('RVB_EFFECT_CHAIN_BATCH_REJECTED')
    expect((caught as EffectChainFatalError).context).toMatchObject({
      actionId: 'transaction-invalid-death-action',
      chainId: 'effect-chain:transaction-invalid-death-action',
      batchId: expect.any(String),
      parentBatchId: expect.any(String),
      kind: 'death',
      depth: 1,
      turn: 7,
      rootSeed: ROOT_SEED,
      sourceId: 'transaction-source',
      skillId: 'invalid-death-child',
      targetId: 'transaction-target',
      targetIds: ['transaction-target'],
      detached: false,
    })
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(JSON.stringify(state)).toBe(beforeJson)
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
    expect(invalidDeathRule.limits).toEqual({ maxUses: 10, uses: 0 })
    expectRuntimeReset(attemptedRuntime)
    expect(getActiveEffectChain(attemptedScope!)).toBeUndefined()
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

  it('fails closed when an attached rule consumer cannot load its definition', () => {
    const skillId = 'definition-missing-rule-root'
    const state = definitionFailureState(skillId)
    const probe = addDefinitionRuntimeProbe('missing-rule')
    const missingRule = {
      id: 'rule-red139-missing-definition',
      name: 'Missing definition',
      description: '',
      trigger: { type: 'afterDamageDealt' },
      limits: { maxUses: 10, uses: 0 },
    } as any
    globalTriggerSystem.addRule(missingRule)
    const beforeHash = hashBattleState(state)
    const beforeJson = JSON.stringify(state)
    const triggerBefore = globalTriggerSystem.snapshotTransactionState()

    let caught: unknown
    try {
      runBattleAction(state, skillAction(skillId, 'definition-missing-rule-action'), { rootSeed: ROOT_SEED })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EffectChainFatalError)
    expect((caught as EffectChainFatalError)).toMatchObject({
      code: 'RVB_EFFECT_CHAIN_BATCH_REJECTED',
      context: expect.objectContaining({
        actionId: 'definition-missing-rule-action',
        chainId: 'effect-chain:definition-missing-rule-action',
        kind: 'damage',
        skillId: 'rule-red139-missing-definition',
        detached: false,
      }),
      cause: expect.objectContaining({
        message: expect.stringContaining('Rule file not found'),
      }),
    })
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(JSON.stringify(state)).toBe(beforeJson)
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
    expect(probe.rule.limits).toEqual({ maxUses: 10, uses: 0, cooldownTurns: 2, currentCooldown: 0 })
    expect(missingRule.limits).toEqual({ maxUses: 10, uses: 0 })
    expectRuntimeReset(probe.runtime())
    expect(getActiveEffectChain(state)).toBeUndefined()
  })

  it.each([
    {
      label: 'parsed-empty',
      ruleId: 'rule-red139-parsed-empty-definition',
      definition: {},
    },
    {
      label: 'unsupported-effect',
      ruleId: 'rule-red139-unsupported-effect-definition',
      definition: {
        id: 'rule-red139-unsupported-effect-definition',
        name: 'Unsupported effect definition',
        description: '',
        trigger: { type: 'afterDamageDealt' },
        effect: { type: 'red139UnsupportedEffect' },
      },
    },
  ])('keeps a $label rule soft for detached damage but rejects it in a later attached chain', ({
    label,
    ruleId,
    definition,
  }) => {
    withTemporaryProfile({ rules: { [ruleId]: definition } }, () => {
      // A soft/detached lookup must not turn parsed-but-invalid JSON into an
      // executable cached stub. The attached action below intentionally loads
      // the same id afterwards to prove the soft attempt cannot poison cache.
      expect(loadRuleById(ruleId, true)).toBeNull()

      const detachedSource = makePiece({
        instanceId: `detached-${label}-source`,
        ownerPlayerId: 'player-red',
      }) as any
      const detachedTarget = makePiece({
        instanceId: `detached-${label}-target`,
        ownerPlayerId: 'player-blue',
        faction: 'blue',
        currentHp: 30,
        maxHp: 30,
      }) as any
      const detachedState = makeState({ pieces: [detachedSource, detachedTarget] }) as any
      globalTriggerSystem.addRule({
        id: ruleId,
        name: ruleId,
        description: '',
        trigger: { type: 'afterDamageDealt' },
      } as any)

      const detachedResult = dealDamage(
        detachedSource,
        detachedTarget,
        4,
        'true',
        detachedState,
        `detached-${label}-damage`,
      )

      expect(detachedResult).toMatchObject({ success: true, damage: 4, targetHp: 26 })
      expect(detachedTarget.currentHp).toBe(26)
      expect(getActiveEffectChain(detachedState)).toBeUndefined()

      globalTriggerSystem.clearRules()
      const skillId = `definition-${label}-rule-root`
      const state = definitionFailureState(skillId)
      const probe = addDefinitionRuntimeProbe(`${label}-rule`)
      const invalidRule = {
        id: ruleId,
        name: ruleId,
        description: '',
        trigger: { type: 'afterDamageDealt' },
        limits: { maxUses: 10, uses: 0 },
      } as any
      globalTriggerSystem.addRule(invalidRule)
      const actionId = `definition-${label}-rule-action`
      const beforeHash = hashBattleState(state)
      const beforeJson = JSON.stringify(state)
      const triggerBefore = globalTriggerSystem.snapshotTransactionState()

      let caught: unknown
      try {
        runBattleAction(state, skillAction(skillId, actionId), { rootSeed: ROOT_SEED })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(EffectChainFatalError)
      expect((caught as EffectChainFatalError).context).toMatchObject({
        actionId,
        chainId: `effect-chain:${actionId}`,
        kind: 'damage',
        skillId: ruleId,
        detached: false,
      })
      expect((caught as EffectChainFatalError).cause).toBeInstanceOf(Error)
      expect(hashBattleState(state)).toBe(beforeHash)
      expect(JSON.stringify(state)).toBe(beforeJson)
      expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
      expect(probe.rule.limits).toEqual({ maxUses: 10, uses: 0, cooldownTurns: 2, currentCooldown: 0 })
      expect(invalidRule.limits).toEqual({ maxUses: 10, uses: 0 })
      expectRuntimeReset(probe.runtime())
      expect(getActiveEffectChain(state)).toBeUndefined()
    })
  })

  it.each([
    {
      label: 'missing',
      ruleId: 'rule-red139-root-helper-missing',
      rules: {} as Record<string, object>,
    },
    {
      label: 'parsed-invalid',
      ruleId: 'rule-red139-root-helper-parsed-invalid',
      rules: { 'rule-red139-root-helper-parsed-invalid': {} } as Record<string, object>,
    },
  ])('rolls back when root SkillCode ignores addRuleById for a $label definition', ({
    label,
    ruleId,
    rules,
  }) => {
    withTemporaryProfile({ rules }, () => {
      const skillId = `definition-root-add-rule-${label}`
      const state = skillState(skillId, `function executeSkill(context) {
        context.battle.extensions.rootAddRuleBefore = '${label}';
        addRuleById('transaction-source', '${ruleId}');
        context.battle.extensions.rootAddRuleAfter = '${label}';
        return { success: true };
      }`)
      const probe = addDefinitionRuntimeProbe(`root-add-rule-${label}`)
      const actionId = `definition-root-add-rule-${label}-action`
      const beforeHash = hashBattleState(state)
      const beforeJson = JSON.stringify(state)
      const triggerBefore = globalTriggerSystem.snapshotTransactionState()

      let caught: unknown
      try {
        runBattleAction(state, skillAction(skillId, actionId), { rootSeed: ROOT_SEED })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(EffectChainFatalError)
      expect((caught as EffectChainFatalError).context).toMatchObject({
        actionId,
        chainId: `effect-chain:${actionId}`,
        skillId: ruleId,
        detached: false,
      })
      expect((caught as EffectChainFatalError).cause).toBeInstanceOf(Error)
      expect(hashBattleState(state)).toBe(beforeHash)
      expect(JSON.stringify(state)).toBe(beforeJson)
      expect((state.extensions as any).rootAddRuleBefore).toBeUndefined()
      expect((state.extensions as any).rootAddRuleAfter).toBeUndefined()
      expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
      expect(probe.rule.limits).toEqual({ maxUses: 10, uses: 0, cooldownTurns: 2, currentCooldown: 0 })
      expectRuntimeReset(probe.runtime())
      expect(getActiveEffectChain(state)).toBeUndefined()
    })
  })

  it('rolls back when root SkillCode ignores addSkillById for a missing definition', () => {
    withTemporaryProfile({}, () => {
      const missingSkillId = 'red139-root-helper-missing-skill'
      const skillId = 'definition-root-add-skill-missing'
      const state = skillState(skillId, `function executeSkill(context) {
        context.battle.extensions.rootAddSkillBefore = true;
        addSkillById('transaction-source', '${missingSkillId}');
        context.battle.extensions.rootAddSkillAfter = true;
        return { success: true };
      }`)
      const probe = addDefinitionRuntimeProbe('root-add-skill-missing')
      const actionId = 'definition-root-add-skill-missing-action'
      const beforeHash = hashBattleState(state)
      const beforeJson = JSON.stringify(state)
      const triggerBefore = globalTriggerSystem.snapshotTransactionState()

      let caught: unknown
      try {
        runBattleAction(state, skillAction(skillId, actionId), { rootSeed: ROOT_SEED })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(EffectChainFatalError)
      expect((caught as EffectChainFatalError).context).toMatchObject({
        actionId,
        chainId: `effect-chain:${actionId}`,
        skillId: missingSkillId,
        detached: false,
      })
      expect((caught as EffectChainFatalError).cause).toBeInstanceOf(Error)
      expect(hashBattleState(state)).toBe(beforeHash)
      expect(JSON.stringify(state)).toBe(beforeJson)
      expect((state.extensions as any).rootAddSkillBefore).toBeUndefined()
      expect((state.extensions as any).rootAddSkillAfter).toBeUndefined()
      expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
      expect(probe.rule.limits).toEqual({ maxUses: 10, uses: 0, cooldownTurns: 2, currentCooldown: 0 })
      expectRuntimeReset(probe.runtime())
      expect(getActiveEffectChain(state)).toBeUndefined()
    })
  })

  it('fails closed when an attached reactive-card definition cannot be parsed', () => {
    withTemporaryProfile({
      cards: { 'red139-malformed-reactive': '{"id":' },
    }, () => {
      const skillId = 'definition-malformed-card-root'
      const state = definitionFailureState(skillId) as any
      state.players[0].hand = [{
        cardId: 'red139-malformed-reactive',
        instanceId: 'red139-malformed-reactive-instance',
        ownerPlayerId: 'player-red',
        actionPointCost: 0,
      }]
      const probe = addDefinitionRuntimeProbe('malformed-card')
      const beforeHash = hashBattleState(state)
      const beforeJson = JSON.stringify(state)
      const triggerBefore = globalTriggerSystem.snapshotTransactionState()

      let caught: unknown
      try {
        runBattleAction(state, skillAction(skillId, 'definition-malformed-card-action'), { rootSeed: ROOT_SEED })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(EffectChainFatalError)
      expect((caught as EffectChainFatalError)).toMatchObject({
        code: 'RVB_EFFECT_CHAIN_STATE_INVALID',
        context: expect.objectContaining({
          actionId: 'definition-malformed-card-action',
          chainId: 'effect-chain:definition-malformed-card-action',
          kind: null,
          depth: null,
          sourceId: 'red139-malformed-reactive-instance',
          skillId: 'red139-malformed-reactive',
          detached: false,
        }),
      })
      expect((caught as EffectChainFatalError).cause).toBeInstanceOf(Error)
      expect(hashBattleState(state)).toBe(beforeHash)
      expect(JSON.stringify(state)).toBe(beforeJson)
      expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
      expect(probe.rule.limits).toEqual({ maxUses: 10, uses: 0, cooldownTurns: 2, currentCooldown: 0 })
      expect(probe.runtime()).toBeUndefined()
      expect(getActiveEffectChain(state)).toBeUndefined()
    })
  })

  it('fails closed when an attached triggerSkill rule cannot load its skill definition', () => {
    withTemporaryProfile({
      rules: {
        'rule-red139-missing-trigger-skill': {
          id: 'rule-red139-missing-trigger-skill',
          name: 'Missing trigger skill',
          description: '',
          trigger: { type: 'afterDamageDealt' },
          effect: { type: 'triggerSkill', skillId: 'red139-missing-trigger-skill' },
        },
      },
    }, () => {
      const loadedRule = loadRuleById('rule-red139-missing-trigger-skill', true)
      expect(loadedRule).toBeDefined()
      globalTriggerSystem.addRule(loadedRule!)
      const skillId = 'definition-missing-trigger-skill-root'
      const state = definitionFailureState(skillId)
      const probe = addDefinitionRuntimeProbe('missing-trigger-skill')
      const beforeHash = hashBattleState(state)
      const beforeJson = JSON.stringify(state)
      const triggerBefore = globalTriggerSystem.snapshotTransactionState()

      let caught: unknown
      try {
        runBattleAction(state, skillAction(skillId, 'definition-missing-trigger-skill-action'), { rootSeed: ROOT_SEED })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(EffectChainFatalError)
      expect((caught as EffectChainFatalError)).toMatchObject({
        code: 'RVB_EFFECT_CHAIN_BATCH_REJECTED',
        context: expect.objectContaining({
          actionId: 'definition-missing-trigger-skill-action',
          chainId: 'effect-chain:definition-missing-trigger-skill-action',
          kind: 'damage',
          skillId: 'red139-missing-trigger-skill',
          detached: false,
        }),
        cause: expect.objectContaining({
          message: expect.stringContaining('red139-missing-trigger-skill'),
        }),
      })
      expect(hashBattleState(state)).toBe(beforeHash)
      expect(JSON.stringify(state)).toBe(beforeJson)
      expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
      expect(probe.rule.limits).toEqual({ maxUses: 10, uses: 0, cooldownTurns: 2, currentCooldown: 0 })
      expectRuntimeReset(probe.runtime())
      expect(getActiveEffectChain(state)).toBeUndefined()
    })
  })

  it('fails closed when triggerSkill loads code-bearing JSON whose id does not match the requested skill', () => {
    const ruleId = 'rule-red139-trigger-skill-wrong-id'
    const requestedSkillId = 'red139-trigger-skill-requested-id'
    const wrongSkillId = 'red139-trigger-skill-wrong-id'
    withTemporaryProfile({
      rules: {
        [ruleId]: {
          id: ruleId,
          name: 'Wrong id trigger skill',
          description: '',
          trigger: { type: 'afterDamageDealt' },
          effect: { type: 'triggerSkill', skillId: requestedSkillId },
        },
      },
      skills: {
        [requestedSkillId]: {
          id: wrongSkillId,
          name: 'Wrong id but executable',
          description: '',
          kind: 'passive',
          type: 'normal',
          cooldownTurns: 0,
          maxCharges: 0,
          powerMultiplier: 1,
          actionPointCost: 0,
          range: 'self',
          requiresTarget: false,
          code: `function executeSkill(context) {
            context.battle.extensions.wrongIdTriggerSkillExecuted = true;
            return { success: true };
          }`,
        },
      },
    }, () => {
      const loadedRule = loadRuleById(ruleId, true)
      expect(loadedRule).toBeDefined()
      globalTriggerSystem.addRule(loadedRule!)
      const skillId = 'definition-trigger-skill-wrong-id-root'
      const state = definitionFailureState(skillId)
      const probe = addDefinitionRuntimeProbe('trigger-skill-wrong-id')
      const actionId = 'definition-trigger-skill-wrong-id-action'
      const beforeHash = hashBattleState(state)
      const beforeJson = JSON.stringify(state)
      const triggerBefore = globalTriggerSystem.snapshotTransactionState()

      let caught: unknown
      try {
        runBattleAction(state, skillAction(skillId, actionId), { rootSeed: ROOT_SEED })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(EffectChainFatalError)
      expect((caught as EffectChainFatalError).context).toMatchObject({
        actionId,
        chainId: `effect-chain:${actionId}`,
        kind: 'damage',
        skillId: requestedSkillId,
        detached: false,
      })
      expect((caught as EffectChainFatalError).cause).toBeInstanceOf(Error)
      expect(hashBattleState(state)).toBe(beforeHash)
      expect(JSON.stringify(state)).toBe(beforeJson)
      expect((state.extensions as any).wrongIdTriggerSkillExecuted).toBeUndefined()
      expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
      expect(probe.rule.limits).toEqual({ maxUses: 10, uses: 0, cooldownTurns: 2, currentCooldown: 0 })
      expectRuntimeReset(probe.runtime())
      expect(getActiveEffectChain(state)).toBeUndefined()
    })
  })

  it('fails closed when an attached Rule SkillCode definition cannot compile', () => {
    withTemporaryProfile({
      rules: {
        'rule-red139-invalid-skill-code': {
          id: 'rule-red139-invalid-skill-code',
          name: 'Invalid Rule SkillCode',
          description: '',
          trigger: { type: 'afterDamageDealt' },
          skillCode: 'if (',
        },
      },
    }, () => {
      const loadedRule = loadRuleById('rule-red139-invalid-skill-code', true)
      expect(loadedRule).toBeDefined()
      globalTriggerSystem.addRule(loadedRule!)
      const skillId = 'definition-invalid-rule-code-root'
      const state = definitionFailureState(skillId)
      const probe = addDefinitionRuntimeProbe('invalid-rule-code')
      const beforeHash = hashBattleState(state)
      const beforeJson = JSON.stringify(state)
      const triggerBefore = globalTriggerSystem.snapshotTransactionState()

      let caught: unknown
      try {
        runBattleAction(state, skillAction(skillId, 'definition-invalid-rule-code-action'), { rootSeed: ROOT_SEED })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(EffectChainFatalError)
      expect((caught as EffectChainFatalError)).toMatchObject({
        code: 'RVB_EFFECT_CHAIN_BATCH_REJECTED',
        context: expect.objectContaining({
          actionId: 'definition-invalid-rule-code-action',
          chainId: 'effect-chain:definition-invalid-rule-code-action',
          kind: 'damage',
          skillId: 'rule-red139-invalid-skill-code',
          detached: false,
        }),
      })
      expect((caught as EffectChainFatalError).cause).toBeInstanceOf(Error)
      expect(hashBattleState(state)).toBe(beforeHash)
      expect(JSON.stringify(state)).toBe(beforeJson)
      expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
      expect(probe.rule.limits).toEqual({ maxUses: 10, uses: 0, cooldownTurns: 2, currentCooldown: 0 })
      expectRuntimeReset(probe.runtime())
      expect(getActiveEffectChain(state)).toBeUndefined()
    })
  })

  it('preserves nullable definition compatibility for a detached EffectChain', () => {
    withTemporaryProfile({
      cards: { 'red139-detached-malformed-card': '{"id":' },
      rules: {
        'rule-red139-detached-trigger-skill': {
          id: 'rule-red139-detached-trigger-skill',
          name: 'Detached missing trigger skill',
          description: '',
          trigger: { type: 'afterDamageDealt' },
          effect: { type: 'triggerSkill', skillId: 'red139-detached-missing-skill' },
        },
      },
    }, () => {
      const source = makePiece({ instanceId: 'detached-definition-source', ownerPlayerId: 'player-red' }) as any
      const target = makePiece({
        instanceId: 'detached-definition-target',
        ownerPlayerId: 'player-blue',
        faction: 'blue',
        currentHp: 30,
        maxHp: 30,
      }) as any
      const state = makeState({ pieces: [source, target] }) as any
      state.players[0].hand = [{
        cardId: 'red139-detached-malformed-card',
        instanceId: 'red139-detached-malformed-card-instance',
        ownerPlayerId: 'player-red',
        actionPointCost: 0,
      }]
      const missingRule = {
        id: 'rule-red139-detached-missing-definition',
        name: 'Detached missing definition',
        description: '',
        trigger: { type: 'afterDamageDealt' },
      } as any
      const triggerSkillRule = loadRuleById('rule-red139-detached-trigger-skill', true)
      expect(triggerSkillRule).toBeDefined()
      globalTriggerSystem.addRules([missingRule, triggerSkillRule!] as any)

      const result = dealDamage(source, target, 4, 'true', state, 'detached-definition-root')

      expect(result).toMatchObject({ success: true, damage: 4, targetHp: 26 })
      expect(target.currentHp).toBe(26)
      expect(getActiveEffectChain(state)).toBeUndefined()
    })
  })

  it.each([
    {
      label: 'missing',
      ruleId: 'rule-red139-related-only-missing',
      rules: {} as Record<string, object>,
    },
    {
      label: 'parsed-invalid',
      ruleId: 'rule-red139-related-only-parsed-invalid',
      rules: { 'rule-red139-related-only-parsed-invalid': {} } as Record<string, object>,
    },
  ])('rejects a JSON-roundtripped root action when relatedRules is the only reference to a $label rule', ({
    label,
    ruleId,
    rules,
  }) => {
    withTemporaryProfile({ rules }, () => {
      const skillId = `definition-related-only-${label}-root`
      const liveState = skillState(skillId, `function executeSkill(context) {
        context.battle.extensions.relatedOnlyRootExecuted = '${label}';
        return { success: true };
      }`) as any
      const source = liveState.pieces.find((piece: any) => piece.instanceId === 'transaction-source')
      source.rules = []
      source.statusTags = [{
        id: `red139-related-only-${label}-status`,
        name: 'Related-only definition probe',
        type: 'red139-related-only-definition-probe',
        remainingDuration: 2,
        relatedRules: [ruleId],
      }]
      const state = JSON.parse(JSON.stringify(liveState)) as BattleState
      const roundTrippedSource = state.pieces.find(piece => piece.instanceId === 'transaction-source') as any
      expect(roundTrippedSource.rules).toEqual([])
      expect(roundTrippedSource.statusTags[0].relatedRules).toEqual([ruleId])

      const actionId = `definition-related-only-${label}-action`
      const beforeHash = hashBattleState(state)
      const beforeJson = JSON.stringify(state)
      const triggerBefore = globalTriggerSystem.snapshotTransactionState()

      let caught: unknown
      try {
        runBattleAction(state, skillAction(skillId, actionId), { rootSeed: ROOT_SEED })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(EffectChainFatalError)
      expect((caught as EffectChainFatalError).context).toMatchObject({
        actionId,
        chainId: `effect-chain:${actionId}`,
        sourceId: 'transaction-source',
        skillId: ruleId,
        detached: false,
      })
      expect((caught as EffectChainFatalError).cause).toBeInstanceOf(Error)
      expect(hashBattleState(state)).toBe(beforeHash)
      expect(JSON.stringify(state)).toBe(beforeJson)
      expect((state.extensions as any).relatedOnlyRootExecuted).toBeUndefined()
      expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
      expect(getActiveEffectChain(state)).toBeUndefined()
    })
  })

  it('does not let authored SkillCode swallow a nested pending signal', () => {
    const pendingRule = addRule(
      'pending-caught-by-skill-code',
      'afterDamageDealt',
      (battle, context) => {
        if (context.skillId !== 'pending-caught-root-damage') return
        ;(battle.extensions as any).pendingConsumerAttempts =
          ((battle.extensions as any).pendingConsumerAttempts || 0) + 1
        if (context.selectedOption === undefined) {
          return {
            needsOptionSelection: true,
            playerId: 'player-red',
            title: 'Continue caught pending?',
            options: [{ label: 'Continue', value: 'continue' }],
            canCancel: false,
          }
        }
        ;(battle.extensions as any).pendingConsumerCommits =
          ((battle.extensions as any).pendingConsumerCommits || 0) + 1
      },
      { maxUses: 10, uses: 0 },
    )
    const skillId = 'transaction-catch-pending'
    const code = `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      try {
        dealDamage(source, target, 4, 'true', context.battle, 'pending-caught-root-damage');
      } catch (error) {
        context.battle.extensions.authoredCatchRan = (context.battle.extensions.authoredCatchRan || 0) + 1;
      }
      context.battle.extensions.afterAuthoredCatch = (context.battle.extensions.afterAuthoredCatch || 0) + 1;
      return { success: true };
    }`
    withTemporarySkill(skillId, code, () => {
    const state = skillState(skillId, code)
    const beforeHash = hashBattleState(state)
    const triggerBefore = globalTriggerSystem.snapshotTransactionState()

    const pendingResult = runBattleAction(
      state,
      skillAction(skillId, 'transaction-catch-pending-root'),
      { rootSeed: ROOT_SEED },
    )
    const pending = pendingResult.state

    expect(pending.pendingOptionSelection).toMatchObject({
      source: { type: 'rule', id: 'pending-caught-by-skill-code' },
      title: 'Continue caught pending?',
    })
    expect(hp(pending)).toBe(30)
    expect((pending.extensions as any).authoredCatchRan).toBeUndefined()
    expect((pending.extensions as any).afterAuthoredCatch).toBeUndefined()
    expect((pending.extensions as any).pendingConsumerAttempts).toBeUndefined()
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
    expect(pendingRule.limits).toEqual({ maxUses: 10, uses: 0 })
    expect(getActiveEffectChain(state)).toBeUndefined()
    expect(getActiveEffectChain(pending)).toBeUndefined()

    const session = pending.pendingOptionSelection!
    const completed = runBattleAction(pending, {
      type: 'pendingOptionSelect',
      playerId: 'player-red',
      selectedOption: 'continue',
      selectionId: session.selectionId,
      stateRevision: session.stateRevision,
      clientActionId: 'transaction-catch-pending-resume',
    } as any, { rootSeed: ROOT_SEED }).state

    expect(completed.pendingOptionSelection).toBeUndefined()
    expect(hp(completed)).toBe(26)
    expect((completed.extensions as any).authoredCatchRan).toBeUndefined()
    expect((completed.extensions as any).afterAuthoredCatch).toBe(1)
    expect((completed.extensions as any).pendingConsumerAttempts).toBe(1)
    expect((completed.extensions as any).pendingConsumerCommits).toBe(1)
    expect(pendingRule.limits).toEqual({ maxUses: 10, uses: 1 })
    expect((completed.actions ?? []).filter(action => action.type === 'damage')).toHaveLength(1)
    expect((completed.actions ?? []).filter(action => action.type === 'useBasicSkill')).toHaveLength(1)
    expect(getActiveEffectChain(completed)).toBeUndefined()
    })
  })

  it('converts the first latched pending when authored SkillCode throws a hostile mask', () => {
    const pendingRule = addRule(
      'pending-masked-by-skill-code',
      'afterDamageDealt',
      (battle, context) => {
        if (context.skillId !== 'pending-masked-root-damage') return
        ;(battle.extensions as any).pendingMaskAttempts =
          ((battle.extensions as any).pendingMaskAttempts || 0) + 1
        if (context.selectedOption === undefined) {
          return {
            needsOptionSelection: true,
            playerId: 'player-red',
            title: 'Continue masked pending?',
            options: [{ label: 'Continue', value: 'continue' }],
            canCancel: false,
          }
        }
        ;(battle.extensions as any).pendingMaskCommits =
          ((battle.extensions as any).pendingMaskCommits || 0) + 1
      },
      { maxUses: 10, uses: 0 },
    )
    const skillId = 'transaction-mask-pending'
    const code = `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      try {
        dealDamage(source, target, 4, 'true', context.battle, 'pending-masked-root-damage');
      } catch (error) {
        throw new Proxy({}, {
          get: function() { throw new Error('authored pending mask get trap'); },
          getPrototypeOf: function() { throw new Error('authored pending mask prototype trap'); }
        });
      }
      return { success: true };
    }`
    withTemporarySkill(skillId, code, () => {
      const state = skillState(skillId, code)
      const beforeHash = hashBattleState(state)
      const triggerBefore = globalTriggerSystem.snapshotTransactionState()

      const pending = runBattleAction(
        state,
        skillAction(skillId, 'transaction-mask-pending-root'),
        { rootSeed: ROOT_SEED },
      ).state

      expect(pending.pendingOptionSelection).toMatchObject({
        source: { type: 'rule', id: 'pending-masked-by-skill-code' },
        title: 'Continue masked pending?',
      })
      expect(hp(pending)).toBe(30)
      expect((pending.extensions as any).pendingMaskAttempts).toBeUndefined()
      expect(hashBattleState(state)).toBe(beforeHash)
      expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
      expect(pendingRule.limits).toEqual({ maxUses: 10, uses: 0 })
      expect(getActiveEffectChain(pending)).toBeUndefined()

      const session = pending.pendingOptionSelection!
      const completed = runBattleAction(pending, {
        type: 'pendingOptionSelect',
        playerId: 'player-red',
        selectedOption: 'continue',
        selectionId: session.selectionId,
        stateRevision: session.stateRevision,
        clientActionId: 'transaction-mask-pending-resume',
      } as any, { rootSeed: ROOT_SEED }).state

      expect(completed.pendingOptionSelection).toBeUndefined()
      expect(hp(completed)).toBe(26)
      expect((completed.extensions as any).pendingMaskAttempts).toBe(1)
      expect((completed.extensions as any).pendingMaskCommits).toBe(1)
      expect(pendingRule.limits).toEqual({ maxUses: 10, uses: 1 })
      expect((completed.actions ?? []).filter(action => action.type === 'damage')).toHaveLength(1)
      expect((completed.actions ?? []).filter(action => action.type === 'useBasicSkill')).toHaveLength(1)
      expect(getActiveEffectChain(completed)).toBeUndefined()
    })
  })

  it('preserves the first fatal when a JSON legacy pending consumer throws a later mask', () => {
    const ruleId = 'transaction-legacy-pending-fatal-mask-rule'
    const rootDamageId = 'transaction-legacy-pending-root-damage'
    const nestedDamageId = 'transaction-legacy-pending-nested-duplicate'
    let observedChain: EffectChain | undefined
    let observedScope: BattleState | undefined
    const pendingRule = addRule(
      ruleId,
      'afterDamageDealt',
      (battle, context) => {
        if (context.skillId !== rootDamageId) return
        if (context.selectedOption === undefined) {
          return {
            needsOptionSelection: true,
            playerId: 'player-red',
            title: 'Continue legacy pending fatal probe?',
            options: [{ label: 'Continue', value: 'continue' }],
            canCancel: false,
          }
        }
        observedChain = getActiveEffectChain(battle)
        observedScope = battle
        const source = battle.pieces.find(piece => piece.instanceId === 'transaction-source')!
        const target = battle.pieces.find(piece => piece.instanceId === 'transaction-target')!
        try {
          dealDamage(source, [target, target], 1, 'true', battle, nestedDamageId)
        } catch {
          throw new Error('legacy authored mask after fatal')
        }
      },
      { maxUses: 10, uses: 0 },
    )
    const skillId = 'transaction-legacy-pending-fatal-mask'
    const code = `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      dealDamage(source, target, 4, 'true', context.battle, '${rootDamageId}');
      return { success: true };
    }`
    withTemporarySkill(skillId, code, () => {
      const state = skillState(skillId, code)
      const pending = runBattleAction(
        state,
        skillAction(skillId, 'transaction-legacy-pending-create'),
        { rootSeed: ROOT_SEED },
      ).state
      expect(pending.pendingOptionSelection?.transaction).toBeDefined()

      const legacy = JSON.parse(JSON.stringify(pending)) as BattleState
      const session = legacy.pendingOptionSelection!
      delete (session as any).transaction
      ;(session as any).triggerContext = {
        type: 'afterDamageDealt',
        skillId: rootDamageId,
        pendingRuleId: ruleId,
      }
      const beforeJson = JSON.stringify(legacy)
      const beforeHash = hashBattleState(legacy)
      const triggerBefore = globalTriggerSystem.snapshotTransactionState()
      const actionId = 'transaction-legacy-pending-resume'

      let caught: unknown
      try {
        runBattleAction(legacy, {
          type: 'pendingOptionSelect',
          playerId: 'player-red',
          selectedOption: 'continue',
          selectionId: session.selectionId,
          stateRevision: session.stateRevision,
          clientActionId: actionId,
        } as any, { rootSeed: ROOT_SEED })
      } catch (error) {
        caught = error
      }

      let latched: unknown
      try {
        observedChain!.assertHealthy()
      } catch (error) {
        latched = error
      }
      expect(caught).toBeInstanceOf(EffectChainFatalError)
      expect(caught).toBe(latched)
      expect((caught as EffectChainFatalError).code).toBe('RVB_EFFECT_CHAIN_STATE_INVALID')
      expect((caught as EffectChainFatalError).context).toMatchObject({
        actionId,
        chainId: `effect-chain:${actionId}`,
        skillId: nestedDamageId,
        targetIds: ['transaction-target', 'transaction-target'],
      })
      expect(observedChain).toBeDefined()
      expect(hashBattleState(legacy)).toBe(beforeHash)
      expect(JSON.stringify(legacy)).toBe(beforeJson)
      expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
      expect(pendingRule.limits).toEqual({ maxUses: 10, uses: 0 })
      expect(getActiveEffectChain(observedScope!)).toBeUndefined()
      expect(getActiveEffectChain(legacy)).toBeUndefined()
    })
  })

  it('does not let authored Rule SkillCode swallow a nested fireEvent pending signal', () => {
    const skillId = 'transaction-rule-catch-pending'
    withTemporaryProfile({
      skills: {
        [skillId]: skillDefinition(skillId, definitionFailureCode(skillId)),
      },
      rules: {
        'rule-red139-catch-nested-pending': {
          id: 'rule-red139-catch-nested-pending',
          name: 'Catch nested pending',
          description: '',
          trigger: { type: 'afterDamageDealt' },
          skillCode: "try { fireEvent('red139NestedPending', { sourcePiece: context.sourcePiece, playerId: 'player-red' }); } catch (error) { battle.extensions.ruleCatchLeak = (battle.extensions.ruleCatchLeak || 0) + 1; } battle.extensions.ruleAfterCatch = (battle.extensions.ruleAfterCatch || 0) + 1; return { success: true };",
        },
      },
    }, () => {
      const innerRule = addRule(
        'red139-nested-pending-choice',
        'red139NestedPending',
        (_battle, context) => {
          if (context.selectedOption === undefined) {
            return {
              needsOptionSelection: true,
              playerId: 'player-red',
              title: 'Continue nested RuleCode pending?',
              options: [{ label: 'Continue', value: 'continue' }],
              canCancel: false,
            }
          }
          return { success: true }
        },
        { maxUses: 10, uses: 0 },
      )
      const outerRule = loadRuleById('rule-red139-catch-nested-pending', true)
      expect(outerRule).toBeDefined()
      globalTriggerSystem.addRule(outerRule!)
      const state = definitionFailureState(skillId)
      const beforeHash = hashBattleState(state)
      const triggerBefore = globalTriggerSystem.snapshotTransactionState()

      const pending = runBattleAction(
        state,
        skillAction(skillId, 'transaction-rule-catch-pending-root'),
        { rootSeed: ROOT_SEED },
      ).state

      expect(pending.pendingOptionSelection).toMatchObject({
        source: { type: 'rule', id: 'red139-nested-pending-choice' },
        title: 'Continue nested RuleCode pending?',
      })
      expect(hp(pending)).toBe(30)
      expect((pending.extensions as any).ruleCatchLeak).toBeUndefined()
      expect((pending.extensions as any).ruleAfterCatch).toBeUndefined()
      expect(hashBattleState(state)).toBe(beforeHash)
      expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
      expect(innerRule.limits).toEqual({ maxUses: 10, uses: 0 })

      const session = pending.pendingOptionSelection!
      const completed = runBattleAction(pending, {
        type: 'pendingOptionSelect',
        playerId: 'player-red',
        selectedOption: 'continue',
        selectionId: session.selectionId,
        stateRevision: session.stateRevision,
        clientActionId: 'transaction-rule-catch-pending-resume',
      } as any, { rootSeed: ROOT_SEED }).state

      expect(completed.pendingOptionSelection).toBeUndefined()
      expect(hp(completed)).toBe(26)
      expect((completed.extensions as any).ruleCatchLeak).toBeUndefined()
      expect((completed.extensions as any).ruleAfterCatch).toBe(1)
      expect(innerRule.limits).toEqual({ maxUses: 10, uses: 1 })
      expect((completed.actions ?? []).filter(action => action.type === 'damage')).toHaveLength(1)
      expect((completed.actions ?? []).filter(action => action.type === 'useBasicSkill')).toHaveLength(1)
      expect(getActiveEffectChain(completed)).toBeUndefined()
    })
  })

  it('keeps a nested Rule SkillCode pending ahead of a later wrapper fatal', () => {
    const skillId = 'transaction-rule-mask-after-pending'
    const outerRuleId = 'rule-red139-mask-after-nested-pending'
    const innerRuleId = 'red139-mask-after-pending-choice'
    withTemporaryProfile({
      skills: {
        [skillId]: skillDefinition(skillId, definitionFailureCode(skillId)),
      },
      rules: {
        [outerRuleId]: {
          id: outerRuleId,
          name: 'Mask after nested pending',
          description: '',
          trigger: { type: 'afterDamageDealt' },
          skillCode: "try { fireEvent('red139NestedPendingMask', { sourcePiece: context.sourcePiece, playerId: 'player-red' }); } catch (error) { throw new Error('rule mask after pending'); } battle.extensions.ruleMaskAfterPending = (battle.extensions.ruleMaskAfterPending || 0) + 1; return { success: true };",
        },
      },
    }, () => {
      const innerRule = addRule(
        innerRuleId,
        'red139NestedPendingMask',
        (_battle, context) => {
          if (context.selectedOption === undefined) {
            return {
              needsOptionSelection: true,
              playerId: 'player-red',
              title: 'Continue masked RuleCode pending?',
              options: [{ label: 'Continue', value: 'continue' }],
              canCancel: false,
            }
          }
          return { success: true }
        },
        { maxUses: 10, uses: 0 },
      )
      const outerRule = loadRuleById(outerRuleId, true)
      expect(outerRule).toBeDefined()
      globalTriggerSystem.addRule(outerRule!)
      const state = definitionFailureState(skillId)
      const beforeJson = JSON.stringify(state)
      const beforeHash = hashBattleState(state)
      const triggerBefore = globalTriggerSystem.snapshotTransactionState()

      const pending = runBattleAction(
        state,
        skillAction(skillId, 'transaction-rule-mask-after-pending-root'),
        { rootSeed: ROOT_SEED },
      ).state

      expect(pending.pendingOptionSelection).toMatchObject({
        source: { type: 'rule', id: innerRuleId },
        title: 'Continue masked RuleCode pending?',
      })
      expect(hp(pending)).toBe(30)
      expect((pending.extensions as any).ruleMaskAfterPending).toBeUndefined()
      expect(JSON.stringify(state)).toBe(beforeJson)
      expect(hashBattleState(state)).toBe(beforeHash)
      expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
      expect(innerRule.limits).toEqual({ maxUses: 10, uses: 0 })
      expect(getActiveEffectChain(state)).toBeUndefined()
      expect(getActiveEffectChain(pending)).toBeUndefined()

      const session = pending.pendingOptionSelection!
      const completed = runBattleAction(pending, {
        type: 'pendingOptionSelect',
        playerId: 'player-red',
        selectedOption: 'continue',
        selectionId: session.selectionId,
        stateRevision: session.stateRevision,
        clientActionId: 'transaction-rule-mask-after-pending-resume',
      } as any, { rootSeed: ROOT_SEED }).state

      expect(completed.pendingOptionSelection).toBeUndefined()
      expect(hp(completed)).toBe(26)
      expect((completed.extensions as any).ruleMaskAfterPending).toBe(1)
      expect(innerRule.limits).toEqual({ maxUses: 10, uses: 1 })
      expect((completed.actions ?? []).filter(action => action.type === 'damage')).toHaveLength(1)
      expect((completed.actions ?? []).filter(action => action.type === 'useBasicSkill')).toHaveLength(1)
      expect(getActiveEffectChain(completed)).toBeUndefined()
    })
  })

  it('keeps a nested CardCode pending ahead of a later wrapper fatal', () => {
    const cardId = 'transaction-card-mask-after-pending'
    const cardInstanceId = `${cardId}-instance`
    const innerRuleId = 'red139-card-mask-after-pending-choice'
    const rootDamageId = 'transaction-card-mask-after-pending-damage'
    const code = `function executeCard(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      try {
        dealDamage(source, target, 4, 'true', context.battle, '${rootDamageId}');
      } catch (error) {
        throw new Error('card mask after pending');
      }
      context.battle.extensions.cardMaskAfterPending =
        (context.battle.extensions.cardMaskAfterPending || 0) + 1;
      return { success: true };
    }`
    withTemporaryProfile({
      cards: {
        [cardId]: {
          id: cardId,
          name: cardId,
          description: '',
          keywords: [],
          type: 'active',
          actionPointCost: 2,
          code,
          targeting: { steps: [] },
        },
      },
    }, () => {
      const innerRule = addRule(
        innerRuleId,
        'afterDamageDealt',
        (_battle, context) => {
          if (context.skillId !== rootDamageId) return
          if (context.selectedOption === undefined) {
            return {
              needsOptionSelection: true,
              playerId: 'player-red',
              title: 'Continue masked CardCode pending?',
              options: [{ label: 'Continue', value: 'continue' }],
              canCancel: false,
            }
          }
          return { success: true }
        },
        { maxUses: 10, uses: 0 },
      )
      const source = makePiece({
        instanceId: 'transaction-source',
        ownerPlayerId: 'player-red',
        x: 0,
        y: 0,
        currentHp: 100,
        maxHp: 100,
      }) as any
      const target = makePiece({
        instanceId: 'transaction-target',
        ownerPlayerId: 'player-blue',
        faction: 'blue',
        x: 1,
        y: 0,
        currentHp: 30,
        maxHp: 100,
      }) as any
      const state = makeState({
        pieces: [source, target],
        currentPlayerId: 'player-red',
        phase: 'action',
        turnNumber: 7,
      }) as any
      state.players[0].actionPoints = 20
      state.players[0].hand = [{
        cardId,
        instanceId: cardInstanceId,
        ownerPlayerId: 'player-red',
        actionPointCost: 2,
      }]
      const beforeJson = JSON.stringify(state)
      const beforeHash = hashBattleState(state)
      const triggerBefore = globalTriggerSystem.snapshotTransactionState()

      const pending = runBattleAction(state, {
        type: 'playCard',
        playerId: 'player-red',
        cardInstanceId,
        clientActionId: 'transaction-card-mask-after-pending-root',
      } as any, { rootSeed: ROOT_SEED }).state

      expect(pending.pendingOptionSelection).toMatchObject({
        source: { type: 'rule', id: innerRuleId },
        title: 'Continue masked CardCode pending?',
      })
      expect(hp(pending)).toBe(30)
      expect(pending.players[0].actionPoints).toBe(20)
      expect(pending.players[0].hand).toHaveLength(1)
      expect(pending.players[0].discardPile ?? []).toEqual([])
      expect((pending.extensions as any).cardMaskAfterPending).toBeUndefined()
      expect(JSON.stringify(state)).toBe(beforeJson)
      expect(hashBattleState(state)).toBe(beforeHash)
      expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
      expect(innerRule.limits).toEqual({ maxUses: 10, uses: 0 })

      const session = pending.pendingOptionSelection!
      const completed = runBattleAction(pending, {
        type: 'pendingOptionSelect',
        playerId: 'player-red',
        selectedOption: 'continue',
        selectionId: session.selectionId,
        stateRevision: session.stateRevision,
        clientActionId: 'transaction-card-mask-after-pending-resume',
      } as any, { rootSeed: ROOT_SEED }).state

      expect(completed.pendingOptionSelection).toBeUndefined()
      expect(hp(completed)).toBe(26)
      expect(completed.players[0].actionPoints).toBe(18)
      expect(completed.players[0].hand).toHaveLength(0)
      expect(completed.players[0].discardPile).toEqual([cardId])
      expect((completed.extensions as any).cardMaskAfterPending).toBe(1)
      expect(innerRule.limits).toEqual({ maxUses: 10, uses: 1 })
      expect((completed.actions ?? []).filter(action => action.type === 'damage')).toHaveLength(1)
      expect((completed.actions ?? []).filter(action => action.type === 'playCard')).toHaveLength(1)
      expect(getActiveEffectChain(completed)).toBeUndefined()
    })
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
    const code = `function executeSkill(context) {
      var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-source'; });
      var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'transaction-target'; });
      context.battle.extensions.pendingRoll = Math.random();
      context.battle.extensions.pendingClock = Date.now();
      dealDamage(source, target, 4, 'true', context.battle, 'pending-root-damage');
      dealDamage(source, target, 1, 'true', context.battle, 'pending-after-damage');
      return { success: true };
    }`
    withTemporarySkill(skillId, code, () => {
    const state = skillState(skillId, code)
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
    withTemporarySkill(skillId, code, () => {
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
    const code = `function executeSkill(context) {
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
    }`
    withTemporarySkill(skillId, code, () => {
    const state = skillState(skillId, code)
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
    }, { actionPointCost: 1, rollbackPendingTargetOnCancel: true })
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
