/* eslint-disable @typescript-eslint/no-explicit-any -- frozen JSON content is intentionally data-shaped. */
import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { applyContentGraph, assertContentGraphArtifact } from '@/electron-editor/content-graph-document'
import {
  buildContentGraphWithPending,
  type PendingContentGraphBuild,
} from '@/electron-editor/content-graph-pending'
import {
  hashBattleState,
  runBattleActionIsolated,
} from '@/lib/game/battle-runner'
import { globalTriggerSystem } from '@/lib/game/triggers'
import {
  safeCloneBattleState,
  type BattleAction,
  type BattleState,
} from '@/lib/game/turn'
import type { SkillDefinition } from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import { makePiece, makeState } from '../helpers/minimal-state'
import {
  assertContentGraphParity,
  executeBattleActionForContentGraphParity,
  type ContentGraphParityExecution,
  type ContentGraphParityExecutorContext,
} from './helpers/content-graph-parity'

const ROOT_SEED = 0x2520_252
const LEGACY_FIXTURE_PATH = 'tests/game/fixtures/RED-252-legacy-content.json'

type ContentRecord = Record<string, any>
type PendingFixture = {
  legacy: ContentRecord
  graph: ContentRecord
  build: PendingContentGraphBuild
}

const frozen = JSON.parse(readFileSync(LEGACY_FIXTURE_PATH, 'utf8')) as {
  entries: Record<string, ContentRecord>
}
const fixtureCache = new Map<string, PendingFixture>()
const priorRules = [...globalTriggerSystem.getRules()]

beforeEach(() => globalTriggerSystem.clearRules())
afterEach(() => {
  globalTriggerSystem.clearRules()
  globalTriggerSystem.addRules(priorRules)
})

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function pendingFixture(id: 'minato-spiral-barrage' | 'turalyon-grand-crusade'): PendingFixture {
  const cached = fixtureCache.get(id)
  if (cached) return cached

  const legacy = cloneJson(frozen.entries[`skills/${id}`])
  if (typeof legacy.code !== 'string' || legacy.code.length === 0) {
    throw new Error(`Frozen RED-252 fixture has no code for ${id}`)
  }
  const build = buildContentGraphWithPending(legacy.code, 'skill', `${id}.js`)
  const expected = applyContentGraph(legacy, build.graph, 'code')
  const graph = JSON.parse(readFileSync(`data/skills/${id}.json`, 'utf8')) as ContentRecord
  assertContentGraphArtifact(graph)
  expect(graph.code).toBe(expected.code)
  expect(graph.contentGraph).toEqual(expected.contentGraph)
  const fixture = { legacy, graph, build }
  fixtureCache.set(id, fixture)
  return fixture
}

function installSkill(state: BattleState, definition: ContentRecord): BattleState {
  const next = safeCloneBattleState(state)
  next.skillsById = {
    ...(next.skillsById || {}),
    [String(definition.id)]: definition as unknown as SkillDefinition,
  }
  return next
}

function projectRuntimeState(state: BattleState): BattleState {
  const projected = safeCloneBattleState(state) as any
  // The runner deliberately removes server-side skill definitions from the
  // returned state. Keep this projection explicit so the parity assertion
  // compares gameplay state rather than generated source fingerprints.
  delete projected.skillsById
  const debugBattle = projected.extensions?.debugBattle
  if (debugBattle) {
    delete debugBattle.authority
    delete debugBattle.actionLog
  }
  return projected
}

function assertRuntimeChannelsEqual(report: Awaited<ReturnType<typeof assertContentGraphParity>>): void {
  expect(report.equal).toBe(true)
  expect(report.steps.every(step => step.differences.length === 0)).toBe(true)
  for (const step of report.steps) {
    expect(step.legacy.state).toEqual(step.graph.state)
    expect(step.legacy.stateHash).toBe(step.graph.stateHash)
    expect(step.legacy.outcome).toEqual(step.graph.outcome)
    expect(step.legacy.trace).toEqual(step.graph.trace)
    expect(step.legacy.random).toEqual(step.graph.random)
    expect(step.legacy.actionLog).toEqual(step.graph.actionLog)
    expect(step.legacy.presentationEvents).toEqual(step.graph.presentationEvents)
    expect(step.legacy.pending).toEqual(step.graph.pending)
    expect(step.legacy.viewerProjections).toEqual(step.graph.viewerProjections)
  }
}

type VariantMutator = (state: BattleState, actionIndex: number) => void

function executeVariant<TContent extends ContentRecord>(
  input: {
    readonly state: BattleState
    readonly action: BattleAction
    readonly context: ContentGraphParityExecutorContext<TContent>
  },
  definition: TContent,
  options: {
    readonly jsonRestoreAt?: number
    readonly mutate?: VariantMutator
  } = {},
): ContentGraphParityExecution {
  let state = safeCloneBattleState(input.state)
  if (options.jsonRestoreAt === input.context.actionIndex) {
    state = JSON.parse(JSON.stringify(state)) as BattleState
  }
  options.mutate?.(state, input.context.actionIndex)
  state = installSkill(state, definition)
  return executeBattleActionForContentGraphParity(
    { ...input, state },
    { runBattleAction: runBattleActionIsolated },
  )
}

function turalyonState(definition: ContentRecord): BattleState {
  const turalyon = makePiece({
    instanceId: 'turalyon',
    templateId: 'turalyon',
    ownerPlayerId: 'player-red',
    x: 0,
    y: 0,
  }) as any
  turalyon.name = '图拉扬'
  turalyon.isCore = true
  turalyon.skills = [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 }]

  const ally = makePiece({
    instanceId: 'ally',
    ownerPlayerId: 'player-red',
    x: 1,
    y: 0,
  }) as any
  ally.name = '友方核心'
  ally.isCore = true

  const state = makeState({
    pieces: [turalyon, ally],
    currentPlayerId: 'player-red',
    phase: 'action',
    width: 8,
    height: 8,
    turnNumber: 1,
  })
  state.skillsById[definition.id] = definition as unknown as SkillDefinition
  state.players[0].actionPoints = 4
  state.players[0].maxActionPoints = 4
  state.players[0].chargePoints = 1
  return state
}

type TuralyonPlan = {
  initial: BattleState
  root: Extract<BattleAction, { type: 'useChargeSkill' }>
  firstSelect: Extract<BattleAction, { type: 'pendingTargetSelect' }>
  resolve: Extract<BattleAction, { type: 'pendingTargetSelect' }>
  cancelFirst: Extract<BattleAction, { type: 'cancelPendingSelection' }>
  cancelSecond: Extract<BattleAction, { type: 'cancelPendingSelection' }>
  destination: { x: number; y: number }
}

function previewAction(
  state: BattleState,
  definition: ContentRecord,
  action: BattleAction,
): BattleState {
  return runBattleActionIsolated(
    installSkill(state, definition),
    action,
    { rootSeed: ROOT_SEED },
  ).state
}

function turalyonPlan(definition: ContentRecord): TuralyonPlan {
  const initial = turalyonState(definition)
  const root: TuralyonPlan['root'] = {
    type: 'useChargeSkill',
    playerId: 'player-red',
    pieceId: 'turalyon',
    skillId: definition.id,
  }
  const first = previewAction(initial, definition, root)
  const firstPending = first.pendingTargetSelection
  if (!firstPending?.selectionId || firstPending.stateRevision === undefined) {
    throw new Error('Turalyon preview did not create its first pending selection')
  }

  const firstSelect: TuralyonPlan['firstSelect'] = {
    type: 'pendingTargetSelect',
    playerId: 'player-red',
    targetPieceId: 'turalyon',
    extraTargets: [{ pieceId: 'ally' }],
    selectionId: firstPending.selectionId,
    stateRevision: firstPending.stateRevision,
  }
  const second = previewAction(first, definition, firstSelect)
  const secondPending = second.pendingTargetSelection
  const destination = secondPending?.candidates?.find(
    candidate => candidate.type === 'cell',
  )
  if (!secondPending?.selectionId || secondPending.stateRevision === undefined || !destination || destination.type !== 'cell') {
    throw new Error('Turalyon preview did not create its second pending selection')
  }

  const resolve: TuralyonPlan['resolve'] = {
    type: 'pendingTargetSelect',
    playerId: 'player-red',
    targetX: destination.x,
    targetY: destination.y,
    selectionId: secondPending.selectionId,
    stateRevision: secondPending.stateRevision,
  }
  const cancelFirst: TuralyonPlan['cancelFirst'] = {
    type: 'cancelPendingSelection',
    playerId: 'player-red',
    selectionId: firstPending.selectionId,
    stateRevision: firstPending.stateRevision,
  }
  const cancelSecond: TuralyonPlan['cancelSecond'] = {
    type: 'cancelPendingSelection',
    playerId: 'player-red',
    selectionId: secondPending.selectionId,
    stateRevision: secondPending.stateRevision,
  }
  return { initial, root, firstSelect, resolve, cancelFirst, cancelSecond, destination }
}

function minatoState(definition: ContentRecord): BattleState {
  const minato = makePiece({
    instanceId: 'minato',
    templateId: 'blue-minato',
    ownerPlayerId: 'player-red',
    x: 0,
    y: 0,
    attack: 5,
  }) as any
  minato.name = '波风水门'
  minato.skills = [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 }]

  const enemy = makePiece({
    instanceId: 'enemy',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 2,
    y: 1,
    currentHp: 5,
    maxHp: 5,
  }) as any
  enemy.name = '敌军'

  const state = makeState({
    pieces: [minato, enemy],
    currentPlayerId: 'player-red',
    phase: 'action',
    width: 6,
    height: 5,
    turnNumber: 1,
  })
  state.skillsById[definition.id] = definition as unknown as SkillDefinition
  state.players[0].actionPoints = 5
  state.players[0].maxActionPoints = 5
  state.players[0].chargePoints = 1
  state.extensions!.minatoAnchors = [{
    x: 1,
    y: 1,
    sourceId: 'minato',
    ownerPlayerId: 'player-red',
    createdAt: 1,
  }]
  state.extensions!.tileEffects = [{
    x: 1,
    y: 1,
    sourceId: 'minato',
    tileType: 'flying-raijin-anchor',
  }]
  return state
}

type MinatoPlan = {
  initial: BattleState
  root: BattleAction
  continue: BattleAction
}

function minatoPlan(definition: ContentRecord): MinatoPlan {
  const initial = minatoState(definition)
  const draft: BattleAction = {
    type: 'useChargeSkill',
    playerId: 'player-red',
    pieceId: 'minato',
    skillId: definition.id,
  }
  const preparation = prepareAction(initial, draft)
  if (preparation.kind !== 'needTarget' || preparation.selectionId === undefined || preparation.stateRevision === undefined) {
    throw new Error('Minato preview did not create its anchor target preparation')
  }
  const root: BattleAction = {
    ...draft,
    targetX: 1,
    targetY: 1,
    selectionId: preparation.selectionId,
    stateRevision: preparation.stateRevision,
  }
  const first = previewAction(initial, definition, root)
  const pending = first.pendingTargetSelection
  const continuation = pending?.candidates?.find(candidate => (
    candidate.type === 'cell' && candidate.x === 3 && candidate.y === 3
  )) ?? pending?.candidates?.find(candidate => candidate.type === 'cell')
  if (!pending?.selectionId || pending.stateRevision === undefined || !continuation || continuation.type !== 'cell') {
    throw new Error('Minato preview did not create its post-kill anchor selection')
  }
  const continueAction: BattleAction = {
    type: 'pendingTargetSelect',
    playerId: 'player-red',
    targetX: continuation.x,
    targetY: continuation.y,
    selectionId: pending.selectionId,
    stateRevision: pending.stateRevision,
  }
  return { initial, root, continue: continueAction }
}

function parityOptions<TContent extends ContentRecord>(input: {
  legacy: TContent
  graph: TContent
  initialState: () => BattleState
  actions: readonly BattleAction[]
  jsonRestoreAt?: number
  mutate?: VariantMutator
}) {
  const execute = (definition: TContent) => (
    inputValue: {
      readonly state: BattleState
      readonly action: BattleAction
      readonly context: ContentGraphParityExecutorContext<TContent>
    },
  ) => executeVariant(inputValue, definition, {
    jsonRestoreAt: input.jsonRestoreAt,
    mutate: input.mutate,
  })
  return {
    seed: ROOT_SEED,
    actions: input.actions,
    initialState: input.initialState,
    viewers: ['player-red', 'player-blue', undefined] as const,
    projectState: (state: BattleState) => projectRuntimeState(state),
    projectStateHash: (state: BattleState) => hashBattleState(projectRuntimeState(state)),
    legacy: {
      name: 'frozen-legacy-pending-content',
      content: input.legacy,
      createInitialState: input.initialState,
      execute: execute(input.legacy),
    },
    graph: {
      name: 'compiled-pending-content-graph',
      content: input.graph,
      createInitialState: input.initialState,
      execute: execute(input.graph),
    },
  }
}

function assertPendingArtifact(fixture: PendingFixture, id: string): void {
  expect(fixture.build.pending.failures, `${id} pending extraction`).toEqual([])
  expect(fixture.build.sourcePairs.length, `${id} source pairs`).toBeGreaterThan(0)
  expect(fixture.graph.code, `${id} generated parent code`).toEqual(expect.any(String))
  expect(fixture.graph.code.length, `${id} generated parent code`).toBeGreaterThan(0)
  expect(fixture.graph.contentGraph).toEqual(fixture.build.graph)
  expect(fixture.graph.contentGraphField).toBe('code')
  expect(fixture.graph.description).toBe(fixture.legacy.description)

  for (const pair of fixture.build.sourcePairs) {
    expect(pair.legacy).toBe(pair.candidate.source)
    expect(pair.legacy.length).toBeGreaterThan(0)
    expect(pair.compiled).toContain('function(ctx)')
    expect(pair.graph.surface).toBe('pending')
    expect(fixture.graph.code).not.toContain(pair.legacy)
  }
  // The parent code and pending effectCode remain executable fields. The
  // artifact assertion must never be satisfied by deleting them.
  expect(fixture.graph.code).toContain('effectCode')
  expect(fixture.graph.code).not.toBe(fixture.legacy.code)
}

function restoreLegacyTuralyonPendingState(
  plan: TuralyonPlan,
  definition: ContentRecord,
  effectCode: string,
): BattleState {
  let state = previewAction(plan.initial, definition, plan.root)
  state = previewAction(state, definition, plan.firstSelect)
  const pending = state.pendingTargetSelection
  if (!pending) throw new Error('Expected Turalyon second-stage pending state before legacy restore')
  const selectedIds = [
    plan.firstSelect.targetPieceId,
    ...(plan.firstSelect.extraTargets || []).map(target => target.pieceId),
  ].filter((pieceId): pieceId is string => typeof pieceId === 'string')
  const legacyPending = {
    ...pending,
    effectCode,
    payload: {
      sourcePieceId: plan.root.pieceId,
      selectedIds,
    },
  }
  delete legacyPending.transaction
  const restored = cloneJson({ ...state, pendingTargetSelection: legacyPending })
  const player = restored.players.find(candidate => candidate.playerId === 'player-red')
  const piece = restored.pieces.find(candidate => candidate.instanceId === 'turalyon')
  if (!player || !piece) throw new Error('Turalyon legacy pending fixture lost its source player or piece')
  player.actionPoints -= Number(definition.actionPointCost || 0)
  player.chargePoints -= Number(definition.chargeCost || 0)
  const skill = piece.skills?.find(candidate => candidate.skillId === definition.id)
  if (skill) skill.currentCooldown = Number(definition.cooldownTurns || 0)
  expect(restored.pendingTargetSelection?.effectCode).toBe(effectCode)
  expect(restored.pendingTargetSelection?.transaction).toBeUndefined()
  return restored
}

function assertLegacyPendingStateEqual(
  legacy: BattleState,
  graph: BattleState,
  legacyEffectCode: string,
  graphEffectCode: string,
): void {
  expect(legacy.pendingTargetSelection?.effectCode).toBe(legacyEffectCode)
  expect(graph.pendingTargetSelection?.effectCode).toBe(graphEffectCode)
  expect(legacy.pendingTargetSelection?.candidates).toEqual(graph.pendingTargetSelection?.candidates)
  expect(projectLegacyPendingState(legacy)).toEqual(projectLegacyPendingState(graph))
  expect(hashBattleState(projectLegacyPendingState(legacy))).toBe(
    hashBattleState(projectLegacyPendingState(graph)),
  )
}

function projectLegacyPendingState(state: BattleState): BattleState {
  const projected = projectRuntimeState(state) as any
  if (typeof projected.pendingTargetSelection?.effectCode === 'string') {
    projected.pendingTargetSelection.effectCode = '[serialized-pending-effectCode]'
  }
  return projected
}

function normalizeCurrentPendingTrace(value: unknown, expectedHash: string): unknown {
  const trace = value as ContentRecord
  expect(trace.preStateHash).toBe(expectedHash)
  return { ...trace, preStateHash: '[verified-serialized-pending-preStateHash]' }
}

function normalizeCurrentPendingLog(value: unknown, actionId: string, expectedHash: string): unknown {
  const log = value as ContentRecord
  expect(log.authority.filter((trace: ContentRecord) => trace.actionId === actionId)).toHaveLength(1)
  return { ...log, authority: log.authority.map((trace: ContentRecord) => trace.actionId === actionId
    ? normalizeCurrentPendingTrace(trace, expectedHash)
    : trace) }
}

function executeLegacyPendingVariant<TContent extends ContentRecord>(
  state: BattleState,
  definition: TContent,
  action: BattleAction,
  variantName: string,
): {
  state: BattleState
  execution?: ContentGraphParityExecution
  error?: Error
} {
  const before = installSkill(state, definition)
  try {
    const execution = executeBattleActionForContentGraphParity(
      {
        state: before,
        action,
        context: {
          variantName,
          content: definition,
          seed: ROOT_SEED,
          actionIndex: 2,
          action,
          beforeState: before,
          viewers: ['player-red', 'player-blue', undefined],
        },
      },
      { runBattleAction: runBattleActionIsolated },
    )
    return { state: before, execution }
  } catch (error) {
    return {
      state: before,
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}

function assertLegacyPendingExecutionEqual(
  legacy: ContentGraphParityExecution,
  graph: ContentGraphParityExecution,
  legacyBefore: BattleState,
  graphBefore: BattleState,
): void {
  expect(projectLegacyPendingState(legacy.state)).toEqual(projectLegacyPendingState(graph.state))
  expect(legacy.stateHash).toBe(graph.stateHash)
  expect(legacy.outcome).toEqual(graph.outcome)
  const legacyHash = hashBattleState(legacyBefore)
  const graphHash = hashBattleState(graphBefore)
  expect(normalizeCurrentPendingTrace(legacy.trace, legacyHash)).toEqual(normalizeCurrentPendingTrace(graph.trace, graphHash))
  expect(legacy.random).toEqual(graph.random)
  expect(normalizeCurrentPendingLog(legacy.actionLog, (legacy.trace as ContentRecord).actionId, legacyHash))
    .toEqual(normalizeCurrentPendingLog(graph.actionLog, (graph.trace as ContentRecord).actionId, graphHash))
  expect(legacy.presentationEvents).toEqual(graph.presentationEvents)
  expect(legacy.pending).toEqual(graph.pending)
  expect(legacy.viewerProjections).toEqual(graph.viewerProjections)
}

describe('RED-252 pending content graph integration parity', () => {
  it('rejects a forged current pre-state hash and preserves historical and payload hashes', () => {
    const trace = { actionId: 'current', preStateHash: 'expected', payload: { preStateHash: 'payload-hash' } }
    expect(() => normalizeCurrentPendingTrace({ ...trace, preStateHash: 'forged' }, 'expected')).toThrow()
    const historical = { actionId: 'past', preStateHash: 'history-hash' }
    const normalized = normalizeCurrentPendingLog({ authority: [historical, trace], actions: [{ preStateHash: 'action-data' }] }, 'current', 'expected') as ContentRecord
    expect(normalized.authority[0]).toEqual(historical)
    expect(normalized.authority[1].payload).toEqual(trace.payload)
    expect(normalized.actions).toEqual([{ preStateHash: 'action-data' }])
  })

  it('preserves typed source pairs and completes Turalyon two-stage selection', async () => {
    const fixture = pendingFixture('turalyon-grand-crusade')
    assertPendingArtifact(fixture, 'turalyon-grand-crusade')
    expect(fixture.build.sourcePairs.map(pair => pair.candidate.functionName)).toEqual([
      'chooseGathering',
      'completeGathering',
    ])

    const plan = turalyonPlan(fixture.legacy)
    const report = await assertContentGraphParity(parityOptions({
      legacy: fixture.legacy,
      graph: fixture.graph,
      initialState: () => turalyonState(fixture.legacy),
      actions: [plan.root, plan.firstSelect, plan.resolve],
    }))
    assertRuntimeChannelsEqual(report)

    const finalState = report.steps.at(-1)!.legacy.state as BattleState
    expect(finalState.pendingTargetSelection).toBeUndefined()
    expect(finalState.players[0]).toMatchObject({ actionPoints: 0, chargePoints: 0 })
    expect(finalState.pieces.find(piece => piece.instanceId === 'ally')).toMatchObject({
      x: plan.destination.x,
      y: plan.destination.y,
    })
    expect(finalState.pieces.find(piece => piece.instanceId === 'turalyon')).toMatchObject({ x: 1, y: 0 })
    expect(finalState.pieces.find(piece => piece.instanceId === 'turalyon')?.statusTags)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'divine-shield' })]))
    expect(finalState.pieces.find(piece => piece.instanceId === 'ally')?.statusTags)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'divine-shield' })]))
  })

  it('preserves cancellation rollback at both Turalyon stages', async () => {
    const fixture = pendingFixture('turalyon-grand-crusade')
    const plan = turalyonPlan(fixture.legacy)
    const cases: Array<{ name: string; actions: BattleAction[] }> = [
      { name: 'first-stage', actions: [plan.root, plan.cancelFirst] },
      { name: 'second-stage', actions: [plan.root, plan.firstSelect, plan.cancelSecond] },
    ]

    for (const scenario of cases) {
      const report = await assertContentGraphParity(parityOptions({
        legacy: fixture.legacy,
        graph: fixture.graph,
        initialState: () => turalyonState(fixture.legacy),
        actions: scenario.actions,
      }))
      assertRuntimeChannelsEqual(report)
      const finalState = report.steps.at(-1)!.legacy.state as BattleState
      expect(finalState.pendingTargetSelection, scenario.name).toBeUndefined()
      expect(finalState.players[0], scenario.name).toMatchObject({ actionPoints: 4, chargePoints: 1 })
      expect(finalState.pieces.find(piece => piece.instanceId === 'turalyon'), scenario.name)
        .toMatchObject({ x: 0, y: 0 })
      expect(finalState.pieces.find(piece => piece.instanceId === 'ally'), scenario.name)
        .toMatchObject({ x: 1, y: 0 })
    }
  })

  it('restores a legacy effectCode pending session from exact source pairs', () => {
    const fixture = pendingFixture('turalyon-grand-crusade')
    const plan = turalyonPlan(fixture.legacy)
    const childPair = fixture.build.sourcePairs[1]
    if (!childPair) throw new Error('Turalyon is missing its completeGathering source pair')
    expect(childPair.candidate.functionName).toBe('completeGathering')
    expect(childPair.legacy).toContain('function completeGathering')
    expect(childPair.compiled).toContain('function(ctx)')
    expect(childPair.compiled).not.toBe(childPair.legacy)

    const legacyState = restoreLegacyTuralyonPendingState(plan, fixture.legacy, childPair.legacy)
    const graphState = restoreLegacyTuralyonPendingState(plan, fixture.graph, childPair.compiled)
    assertLegacyPendingStateEqual(legacyState, graphState, childPair.legacy, childPair.compiled)

    const legacy = executeLegacyPendingVariant(legacyState, fixture.legacy, plan.resolve, 'legacy')
    const graph = executeLegacyPendingVariant(graphState, fixture.graph, plan.resolve, 'graph')
    if (!legacy.execution || !graph.execution) throw new Error('Expected legacy pending resolution to succeed')
    assertLegacyPendingExecutionEqual(legacy.execution, graph.execution, legacyState, graphState)

    const finalState = legacy.execution.state
    expect(finalState.pendingTargetSelection).toBeUndefined()
    expect(finalState.players[0]).toMatchObject({ actionPoints: 0, chargePoints: 0 })
    expect(finalState.pieces.find(piece => piece.instanceId === 'ally')).toMatchObject({
      x: plan.destination.x,
      y: plan.destination.y,
    })
  })

  it('rejects an invalid target atomically in a restored legacy effectCode session', () => {
    const fixture = pendingFixture('turalyon-grand-crusade')
    const plan = turalyonPlan(fixture.legacy)
    const childPair = fixture.build.sourcePairs[1]
    if (!childPair) throw new Error('Turalyon is missing its completeGathering source pair')
    const invalidResolve: TuralyonPlan['resolve'] = {
      ...plan.resolve,
      targetX: -1,
      targetY: -1,
    }
    const legacyState = restoreLegacyTuralyonPendingState(plan, fixture.legacy, childPair.legacy)
    const graphState = restoreLegacyTuralyonPendingState(plan, fixture.graph, childPair.compiled)
    const legacy = executeLegacyPendingVariant(legacyState, fixture.legacy, invalidResolve, 'legacy')
    const graph = executeLegacyPendingVariant(graphState, fixture.graph, invalidResolve, 'graph')
    if (!legacy.error || !graph.error) throw new Error('Expected invalid legacy pending target to be rejected')
    expect(legacy.error).toMatchObject({ name: 'TargetingRuleError' })
    expect(graph.error).toMatchObject({ name: 'TargetingRuleError' })
    expect(legacy.error.message).toBe(graph.error.message)
    assertLegacyPendingStateEqual(legacy.state, graph.state, childPair.legacy, childPair.compiled)
    expect(legacy.state.pendingTargetSelection?.effectCode).toBe(childPair.legacy)
    expect(graph.state.pendingTargetSelection?.effectCode).toBe(childPair.compiled)
    expect(legacy.state.pendingTargetSelection?.transaction).toBeUndefined()
    expect(graph.state.pendingTargetSelection?.transaction).toBeUndefined()
  })

  it('replays a serialized Turalyon pending transaction without changing parity', async () => {
    const fixture = pendingFixture('turalyon-grand-crusade')
    const plan = turalyonPlan(fixture.legacy)
    const report = await assertContentGraphParity(parityOptions({
      legacy: fixture.legacy,
      graph: fixture.graph,
      initialState: () => turalyonState(fixture.legacy),
      actions: [plan.root, plan.firstSelect, plan.resolve],
      jsonRestoreAt: 1,
    }))
    assertRuntimeChannelsEqual(report)
    expect((report.steps[1].legacy.pending as any).target.transaction).toEqual(
      (report.steps[1].graph.pending as any).target.transaction,
    )
    expect((report.steps.at(-1)!.legacy.state as BattleState).pendingTargetSelection).toBeUndefined()
  })

  it.each([
    {
      name: 'wrong player',
      mutate: undefined,
      action: (plan: TuralyonPlan): BattleAction => ({
        ...plan.firstSelect,
        playerId: 'player-blue',
      }),
      expectedCode: 'TARGET_SELECTION_PLAYER_MISMATCH',
    },
    {
      name: 'expired credentials',
      mutate: undefined,
      action: (plan: TuralyonPlan): BattleAction => ({
        ...plan.firstSelect,
        stateRevision: (plan.firstSelect.stateRevision as number) - 1,
      }),
      expectedCode: 'TARGET_SELECTION_STALE',
    },
  ])('rejects Turalyon $name atomically', async scenario => {
    const fixture = pendingFixture('turalyon-grand-crusade')
    const plan = turalyonPlan(fixture.legacy)
    const action = scenario.action(plan)
    const report = await assertContentGraphParity(parityOptions({
      legacy: fixture.legacy,
      graph: fixture.graph,
      initialState: () => turalyonState(fixture.legacy),
      actions: [plan.root, action],
      mutate: scenario.mutate,
    }))
    assertRuntimeChannelsEqual(report)
    expect(report.steps[1].legacy.executionError).toMatchObject({ name: 'TargetingRuleError' })
    expect((report.steps[1].legacy.executionError as any).message).toContain(scenario.expectedCode === 'TARGET_SELECTION_STALE' ? 'stale' : 'another player')
    expect(report.steps[1].legacy.pending).toEqual(report.steps[0].legacy.pending)
  })

  it('rejects a repeated Turalyon resolution after the transaction completed', async () => {
    const fixture = pendingFixture('turalyon-grand-crusade')
    const plan = turalyonPlan(fixture.legacy)
    const report = await assertContentGraphParity(parityOptions({
      legacy: fixture.legacy,
      graph: fixture.graph,
      initialState: () => turalyonState(fixture.legacy),
      actions: [plan.root, plan.firstSelect, plan.resolve, plan.resolve],
    }))
    assertRuntimeChannelsEqual(report)
    expect(report.steps[3].legacy.executionError).toMatchObject({ name: 'TargetingRuleError' })
    expect((report.steps[3].legacy.executionError as any).message).toMatch(/already resolved|not found/i)
    expect(report.steps[3].legacy.state).toEqual(report.steps[2].legacy.state)
  })

  it.each([
    {
      name: 'source',
      mutate: (state: BattleState, actionIndex: number) => {
        if (actionIndex !== 1) return
        state.pieces.find(piece => piece.instanceId === 'turalyon')!.currentHp = 0
      },
    },
    {
      name: 'selected target',
      mutate: (state: BattleState, actionIndex: number) => {
        if (actionIndex !== 1) return
        state.pieces.find(piece => piece.instanceId === 'ally')!.currentHp = 0
      },
    },
  ])('rejects Turalyon when its pending $name is invalid', async scenario => {
    const fixture = pendingFixture('turalyon-grand-crusade')
    const plan = turalyonPlan(fixture.legacy)
    const report = await assertContentGraphParity(parityOptions({
      legacy: fixture.legacy,
      graph: fixture.graph,
      initialState: () => turalyonState(fixture.legacy),
      actions: [plan.root, plan.firstSelect],
      mutate: scenario.mutate,
    }))
    assertRuntimeChannelsEqual(report)
    expect(report.steps[1].legacy.executionError).toBeDefined()
    expect(report.steps[1].legacy.pending).toEqual(report.steps[0].legacy.pending)
  })

  it('continues Minato after a kill and persists the new anchor through JSON restore', async () => {
    const fixture = pendingFixture('minato-spiral-barrage')
    assertPendingArtifact(fixture, 'minato-spiral-barrage')
    expect(fixture.build.sourcePairs).toHaveLength(1)
    const plan = minatoPlan(fixture.legacy)
    const report = await assertContentGraphParity(parityOptions({
      legacy: fixture.legacy,
      graph: fixture.graph,
      initialState: () => minatoState(fixture.legacy),
      actions: [plan.root, plan.continue],
      jsonRestoreAt: 1,
    }))
    assertRuntimeChannelsEqual(report)

    const finalState = report.steps.at(-1)!.legacy.state as BattleState
    expect(finalState.pendingTargetSelection).toBeUndefined()
    expect(finalState.extensions?.minatoAnchors).toEqual(expect.arrayContaining([
      expect.objectContaining({ x: 3, y: 3, sourceId: 'minato' }),
    ]))
    expect(finalState.pieces.find(piece => piece.instanceId === 'enemy')?.currentHp ?? 0).toBe(0)
    expect(finalState.actions?.some(action => action.type === 'damage')).toBe(true)
    expect(finalState.actions?.some(action => action.type === 'triggerEffect')).toBe(true)
  })
})
