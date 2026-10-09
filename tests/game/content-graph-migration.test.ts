/* eslint-disable @typescript-eslint/no-explicit-any -- legacy content is intentionally data-shaped. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  applyContentGraph,
  type ContentGraphSurface,
} from '@/electron-editor/content-graph'
import { importContentGraph } from '@/electron-editor/content-graph-import'
import {
  loadCardById,
  loadRuleById,
  loadSkillById,
  type CardDefinition,
  type SkillDefinition,
} from '@/lib/game/skills'
import { hashBattleState } from '@/lib/game/battle-runner'
import {
  finalizePendingTargetSession,
  prepareAction,
} from '@/lib/game/targeting'
import {
  safeCloneBattleState,
  type BattleAction,
  type BattleState,
} from '@/lib/game/turn'
import {
  createRuleExecutionContext,
  withRuleExecutionContext,
} from '@/lib/game/rule-runtime'
import { globalTriggerSystem, type TriggerRule } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'
import {
  assertContentGraphParity,
  executeBattleActionForContentGraphParity,
  type ContentGraphParityExecution,
  type ContentGraphParityExecutorContext,
  type ContentGraphParityOptions,
} from './helpers/content-graph-parity'

const LEGACY_FIXTURE_PATH = resolve(
  process.cwd(),
  'tests/game/fixtures/RED-252-legacy-content.json',
)
const ROOT_SEED = 0x2520_252

const ACTIVE_SKILL_IDS = [
  'light-of-the-light',
  'fireball',
  'ashbringer',
  'illidan-eye-beam',
  'ulquiorra-cero',
  'ulquiorra-black-cero',
  'ichigo-zangetsu',
  'blessed-hammer',
  'venom-claw-rend',
] as const

const LIGHT_SKILL_ID = 'light-of-the-light'
const BLINK_SKILL_ID = 'blink'
const ASHBRINGER_SKILL_ID = 'ashbringer'
const VENOM_SKILL_ID = 'venom-claw-rend'
const ILLIDAN_SKILL_ID = 'illidan-eye-beam'
const SOUL_FRAGMENT_CARD_ID = 'soul-fragment'
const REAP_RULE_ID = 'rule-reap'
const DIVINE_SHIELD_RULE_ID = 'rule-divine-shield'

type JsonRecord = Record<string, any>

type LegacyContentFixture = {
  readonly [key: string]: any
}

type MigrationArtifact = {
  readonly surface: ContentGraphSurface
  readonly legacy: JsonRecord
  readonly graph: JsonRecord
}

type ActiveMigration = {
  readonly id: string
  readonly legacy: SkillDefinition
  readonly graph: SkillDefinition
  readonly artifact: MigrationArtifact
}

type RuleMigration = {
  readonly legacyDefinition: JsonRecord
  readonly graphDefinition: JsonRecord
  readonly legacy: TriggerRule
  readonly graph: TriggerRule
  readonly artifact: MigrationArtifact
}

type CardMigration = {
  readonly legacy: CardDefinition
  readonly graph: CardDefinition
  readonly artifact: MigrationArtifact
}

let fixtureCache: LegacyContentFixture | undefined

function legacyFixture(): LegacyContentFixture {
  if (!fixtureCache) {
    if (!existsSync(LEGACY_FIXTURE_PATH)) {
      throw new Error(
        `RED-252 migration fixture is required: ${LEGACY_FIXTURE_PATH}`,
      )
    }
    fixtureCache = JSON.parse(readFileSync(LEGACY_FIXTURE_PATH, 'utf8')) as LegacyContentFixture
  }
  return fixtureCache
}

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * The fixture is intentionally data-only. Accept the two equivalent shapes
 * used by the freeze script while keeping lookup strict about the content id.
 */
function fixtureDefinition(kind: 'skills' | 'cards' | 'rules', id: string): JsonRecord {
  const root = legacyFixture()
  const entries = root.entries
  if (record(entries)) {
    const entry = entries[`${kind}/${id}`]
    if (record(entry)) return cloneJson(entry)
  }
  const candidates = [
    root,
    record(root.content) ? root.content : undefined,
    record(root.definitions) ? root.definitions : undefined,
    record(root.contents) ? root.contents : undefined,
  ].filter((value): value is JsonRecord => record(value))

  for (const candidate of candidates) {
    const bucket = candidate[kind]
    if (record(bucket) && record(bucket[id])) return cloneJson(bucket[id])
    if (Array.isArray(bucket)) {
      const match = bucket.find(entry => record(entry) && entry.id === id)
      if (record(match)) return cloneJson(match)
    }
  }

  throw new Error(`RED-252 legacy fixture is missing ${kind}:${id}`)
}

function migrateDefinition(
  legacy: JsonRecord,
  surface: ContentGraphSurface,
  field: string,
): { graph: JsonRecord; artifact: MigrationArtifact } {
  const source = legacy[field]
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error(`Legacy ${surface} definition has no ${field} source`)
  }
  const graph = importContentGraph(source, surface)
  const generated = applyContentGraph(legacy, graph, field)
  return {
    graph: generated,
    artifact: { surface, legacy, graph: generated },
  }
}

function productionDefinition(
  kind: 'skills' | 'cards' | 'rules',
  id: string,
): JsonRecord {
  const path = resolve(process.cwd(), 'data', kind, `${id}.json`)
  if (!existsSync(path)) throw new Error(`Production ${kind} definition is missing: ${path}`)
  return JSON.parse(readFileSync(path, 'utf8')) as JsonRecord
}

function assertProductionArtifact(
  legacy: JsonRecord,
  production: JsonRecord,
  surface: ContentGraphSurface,
  field: string,
): void {
  const expected = migrateDefinition(legacy, surface, field).graph
  expect(production[field], `${surface}:${String(legacy.id)} generated source`).toBe(expected[field])
  expect(production.contentGraph, `${surface}:${String(legacy.id)} content graph`).toEqual(expected.contentGraph)
  expect(production.contentGraphField, `${surface}:${String(legacy.id)} graph field`).toBe(field)
  expect(production.contentGraphCompilerVersion, `${surface}:${String(legacy.id)} compiler version`)
    .toBe(expected.contentGraphCompilerVersion)
  expect(canonicalDefinition(production)).toEqual(canonicalDefinition(legacy))
}

function activeMigration(id: string): ActiveMigration {
  const legacy = fixtureDefinition('skills', id) as SkillDefinition
  const graphDefinition = productionDefinition('skills', id)
  assertProductionArtifact(legacy, graphDefinition, 'skill', 'code')
  const graph = loadSkillById(id, true)
  if (!graph) throw new Error(`Production skill did not load: ${id}`)
  return {
    id,
    legacy,
    graph,
    artifact: { surface: 'skill', legacy, graph: graphDefinition },
  }
}

function loadRuleFromDefinition(
  definition: JsonRecord,
  loaderId: string,
): TriggerRule {
  const root = mkdtempSync(join(tmpdir(), 'rvb-red252-rule-'))
  const rulesDirectory = join(root, 'data', 'rules')
  mkdirSync(rulesDirectory, { recursive: true })
  const fileDefinition = { ...cloneJson(definition), id: loaderId }
  writeFileSync(
    join(rulesDirectory, `${loaderId}.json`),
    JSON.stringify(fileDefinition),
    'utf8',
  )

  const previousProfileRoot = process.env.RVB_PROFILE_ROOT
  process.env.RVB_PROFILE_ROOT = root
  try {
    const loaded = loadRuleById(loaderId, true, true)
    if (!loaded || typeof loaded.effect !== 'function') {
      throw new Error(`RED-252 rule fixture did not compile: ${loaderId}`)
    }
    return { ...loaded, id: String(definition.id || REAP_RULE_ID) }
  } finally {
    if (previousProfileRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousProfileRoot
    rmSync(root, { recursive: true, force: true })
  }
}

function ruleMigration(id: string): RuleMigration {
  const legacyDefinition = fixtureDefinition('rules', id)
  const graphDefinition = productionDefinition('rules', id)
  assertProductionArtifact(legacyDefinition, graphDefinition, 'rule', 'skillCode')
  const legacy = loadRuleFromDefinition(legacyDefinition, `${id}-legacy-fixture`)
  const graph = loadRuleById(id, true, true)
  if (!graph) throw new Error(`Production rule did not load: ${id}`)
  return {
    legacyDefinition,
    graphDefinition,
    legacy,
    graph,
    artifact: { surface: 'rule', legacy: legacyDefinition, graph: graphDefinition },
  }
}

function cardMigration(id: string): CardMigration {
  const legacy = fixtureDefinition('cards', id) as CardDefinition
  const graphDefinition = productionDefinition('cards', id)
  assertProductionArtifact(legacy, graphDefinition, 'card', 'code')
  const graph = loadCardById(id, true, true)
  if (!graph) throw new Error(`Production card did not load: ${id}`)
  return {
    legacy,
    graph,
    artifact: { surface: 'card', legacy, graph: graphDefinition },
  }
}

function namedPiece(overrides: Parameters<typeof makePiece>[0]): any {
  const piece = makePiece(overrides) as any
  piece.name = piece.instanceId
  return piece
}

function activeState(skill: SkillDefinition): BattleState {
  const targetIsAlly = skill.id === LIGHT_SKILL_ID
  const caster = namedPiece({
    instanceId: 'active-caster',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: 0,
    y: 0,
    attack: 10,
    currentHp: skill.id === ILLIDAN_SKILL_ID ? 95 : 80,
    maxHp: 100,
    actionPoints: 5,
    skills: [{ skillId: skill.id, currentCooldown: 0, usesRemaining: -1 }],
    statusTags: skill.id === 'ulquiorra-black-cero'
      ? [{ id: 'resurreccion', type: 'resurreccion' }]
      : [],
  })
  const target = namedPiece({
    instanceId: targetIsAlly ? 'active-ally' : 'active-enemy',
    ownerPlayerId: targetIsAlly ? 'player-red' : 'player-blue',
    faction: targetIsAlly ? 'red' : 'blue',
    x: 1,
    y: 0,
    currentHp: targetIsAlly ? 50 : 30,
    maxHp: targetIsAlly ? 100 : 30,
    attack: skill.id === 'ulquiorra-black-cero' ? 5 : 10,
  })
  const state = makeState({
    pieces: [caster, target],
    currentPlayerId: 'player-red',
    phase: 'action',
    width: 5,
    height: 4,
  })
  state.players[0].actionPoints = 5
  state.players[0].maxActionPoints = 5
  state.skillsById[skill.id] = skill
  return state
}

function blinkState(skill: SkillDefinition, blocked = false): BattleState {
  const caster = namedPiece({
    instanceId: 'blink-caster',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: 2,
    y: 2,
    currentHp: 80,
    maxHp: 100,
    actionPoints: 5,
    skills: [{ skillId: BLINK_SKILL_ID, currentCooldown: 0, usesRemaining: -1 }],
    statusTags: blocked
      ? [{ id: 'blink-blocked', type: 'movement-blocked', blocksForcedMovement: true }]
      : [],
  })
  const state = makeState({
    pieces: [caster],
    currentPlayerId: 'player-red',
    phase: 'action',
    width: 5,
    height: 5,
  })
  state.players[0].actionPoints = 5
  state.players[0].maxActionPoints = 5
  state.skillsById[skill.id] = skill
  return state
}

function activeAction(state: BattleState, skillId: string, targetPieceId?: string): BattleAction {
  const draft = {
    type: 'useBasicSkill' as const,
    playerId: 'player-red',
    pieceId: 'active-caster',
    skillId,
  }
  const preparation = prepareAction(state, draft)
  if (preparation.kind !== 'needTarget') {
    throw new Error(`Expected a target preparation for ${skillId}, got ${preparation.kind}`)
  }
  return {
    ...draft,
    targetPieceId: targetPieceId || (skillId === LIGHT_SKILL_ID ? 'active-ally' : 'active-enemy'),
    selectionId: preparation.selectionId,
    stateRevision: preparation.stateRevision,
  }
}

function gridAction(
  state: BattleState,
  skillId: string,
  targetX: number,
  targetY: number,
): BattleAction {
  const draft = {
    type: 'useBasicSkill' as const,
    playerId: 'player-red',
    pieceId: 'blink-caster',
    skillId,
  }
  const preparation = prepareAction(state, draft)
  if (preparation.kind !== 'needTarget') {
    throw new Error(`Expected a grid target preparation for ${skillId}, got ${preparation.kind}`)
  }
  return {
    ...draft,
    targetX,
    targetY,
    selectionId: preparation.selectionId,
    stateRevision: preparation.stateRevision,
  }
}

const generatedDefinitionFields = new Set(['code', 'skillCode', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries'])

function canonicalDefinition(value: unknown): unknown {
  if (!record(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !generatedDefinitionFields.has(key)))
}

function canonicalDefinitions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalDefinition)
  if (!record(value)) return value
  return Object.fromEntries(Object.entries(value).map(([id, definition]) => [id, canonicalDefinition(definition)]))
}

function projectRuntimeState(state: BattleState): BattleState {
  const projected = safeCloneBattleState(state) as any
  // Generated source and graph metadata are content fingerprints, not runtime
  // behavior. Runtime debug hashes are removed here and retained separately in
  // the sanitized trace/action-log channels below.
  if (projected.skillsById !== undefined) projected.skillsById = canonicalDefinitions(projected.skillsById)
  if (projected.customCards !== undefined) projected.customCards = canonicalDefinitions(projected.customCards)
  const debugBattle = projected.extensions?.debugBattle
  if (debugBattle) {
    delete debugBattle.authority
    delete debugBattle.actionLog
  }
  return projected
}

function sanitizeContentHashes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeContentHashes)
  if (!record(value)) return value
  const result: JsonRecord = {}
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'preStateHash' || key === 'postStateHash') continue
    result[key] = sanitizeContentHashes(nested)
  }
  return result
}

function sanitizeViewerProjection(value: unknown): unknown {
  const projection = sanitizeContentHashes(value) as JsonRecord
  if (!record(projection)) return projection
  const battleState = projection.battleState
  if (record(battleState)) {
    if (battleState.skillsById !== undefined) battleState.skillsById = canonicalDefinitions(battleState.skillsById)
    if (battleState.customCards !== undefined) battleState.customCards = canonicalDefinitions(battleState.customCards)
    const debugBattle = record(battleState.extensions)
      ? battleState.extensions.debugBattle
      : undefined
    if (record(debugBattle)) {
      delete debugBattle.authority
      delete debugBattle.actionLog
    }
  }
  return projection
}

function sanitizeExecution(execution: ContentGraphParityExecution): ContentGraphParityExecution {
  return {
    ...execution,
    trace: sanitizeContentHashes(execution.trace),
    actionLog: sanitizeContentHashes(execution.actionLog),
    viewerProjections: execution.viewerProjections
      ? Object.fromEntries(Object.entries(execution.viewerProjections).map(([key, value]) => [
          key,
          sanitizeViewerProjection(value),
        ]))
      : undefined,
  }
}

type ContentResolver = {
  readonly rules?: Readonly<Record<string, TriggerRule>>
  readonly card?: CardDefinition
}

function executeWithResolvers<TContent>(
  input: {
    readonly state: BattleState
    readonly action: BattleAction
    readonly context: ContentGraphParityExecutorContext<TContent>
  },
  resolver: ContentResolver,
): ContentGraphParityExecution {
  const execution = withRuleExecutionContext(
    createRuleExecutionContext(globalTriggerSystem, {
      ruleResolver: (_battle, ruleId) => {
        const fixtureRule = resolver.rules?.[ruleId]
        if (fixtureRule) return fixtureRule
        const fallback = loadRuleById(ruleId, true)
        return fallback
      },
      cardResolver: (_battle, cardId) => {
        if (cardId === SOUL_FRAGMENT_CARD_ID && resolver.card) return resolver.card
        return loadCardById(cardId, true)
      },
    }),
    () => executeBattleActionForContentGraphParity(input),
  )
  return sanitizeExecution(execution)
}

function parityOptions<TContent>(
  legacyContent: TContent,
  graphContent: TContent,
  legacyState: () => BattleState,
  graphState: () => BattleState,
  actions: readonly BattleAction[],
  legacyResolver: ContentResolver = {},
  graphResolver: ContentResolver = {},
): ContentGraphParityOptions<TContent, TContent> {
  return {
    seed: ROOT_SEED,
    actions,
    initialState: legacyState,
    viewers: ['player-red', 'player-blue', undefined],
    projectState: state => projectRuntimeState(state),
    projectStateHash: state => hashBattleState(projectRuntimeState(state)),
    legacy: {
      name: 'legacy-live-content',
      content: legacyContent,
      createInitialState: legacyState,
      execute: input => executeWithResolvers(input, legacyResolver),
    },
    graph: {
      name: 'compiled-content-graph',
      content: graphContent,
      createInitialState: graphState,
      execute: input => executeWithResolvers(input, graphResolver),
    },
  }
}

function expectEqualRuntimeChannels(report: Awaited<ReturnType<typeof assertContentGraphParity>>): void {
  expect(report.equal).toBe(true)
  expect(report.steps).toHaveLength(1)
  const step = report.steps[0]
  expect(step.legacy.random).toEqual(step.graph.random)
  expect(step.legacy.actionLog).toEqual(step.graph.actionLog)
  expect(step.legacy.presentationEvents).toEqual(step.graph.presentationEvents)
  expect(step.legacy.pending).toEqual(step.graph.pending)
  expect(step.legacy.viewerProjections).toEqual(step.graph.viewerProjections)
}

afterEach(() => {
  globalTriggerSystem.clearRules()
})

describe('RED-252 real content graph migration parity', () => {
  it('retains description, range, card values and definition membership in parity projections', () => {
    const original = {...makeState(), skillsById: {sample: {id:'sample', description:'原文', range:'single', code:'old'}}, customCards: {card: {id:'card', actionPointCost:1, code:'old'}}} as unknown as BattleState
    for (const mutate of [
      (state: any) => { state.skillsById.sample.description = '不同' },
      (state: any) => { state.skillsById.sample.range = 'area' },
      (state: any) => { state.customCards.card.actionPointCost = 2 },
      (state: any) => { delete state.customCards.card },
    ]) {
      const changed = cloneJson(original)
      mutate(changed)
      expect(projectRuntimeState(changed)).not.toEqual(projectRuntimeState(original))
      expect(sanitizeViewerProjection({battleState:changed})).not.toEqual(sanitizeViewerProjection({battleState:original}))
    }
  })
  it.each(ACTIVE_SKILL_IDS)('%s preserves real active-skill behavior', async skillId => {
    const migration = activeMigration(skillId)
    const legacyState = () => activeState(migration.legacy)
    const graphState = () => activeState(migration.graph)
    const action = activeAction(legacyState(), skillId)

    const report = await assertContentGraphParity(parityOptions(
      { skills: { [skillId]: migration.legacy }, artifact: migration.artifact },
      { skills: { [skillId]: migration.graph }, artifact: migration.artifact },
      legacyState,
      graphState,
      [action],
    ))
    expectEqualRuntimeChannels(report)

    const finalState = report.steps[0].legacy.state as BattleState
    const caster = finalState.pieces.find(piece => piece.instanceId === 'active-caster')!
    const target = finalState.pieces.find(piece => piece.instanceId !== 'active-caster')!
    if (skillId === LIGHT_SKILL_ID) {
      expect(target.currentHp).toBe(55)
    } else {
      expect(target.currentHp).toBeLessThan(30)
    }
    expect(caster.currentHp).toBeLessThanOrEqual(caster.maxHp)
  })

  it('preserves blink grid selection and normal displacement from the production graph artifact', async () => {
    const migration = activeMigration(BLINK_SKILL_ID)
    const legacyState = () => blinkState(migration.legacy)
    const graphState = () => blinkState(migration.graph)
    const action = gridAction(legacyState(), BLINK_SKILL_ID, 3, 2)
    const report = await assertContentGraphParity(parityOptions(
      { skills: { [BLINK_SKILL_ID]: migration.legacy }, artifact: migration.artifact },
      { skills: { [BLINK_SKILL_ID]: migration.graph }, artifact: migration.artifact },
      legacyState,
      graphState,
      [action],
    ))
    expectEqualRuntimeChannels(report)

    const finalState = report.steps[0].legacy.state as BattleState
    expect(finalState.pieces.find(piece => piece.instanceId === 'blink-caster'))
      .toMatchObject({ x: 3, y: 2 })
    expect(finalState.actions?.some(entry => entry.type === 'positionChanged')).toBe(true)
  })

  it('preserves blink target selection return and blocked displacement', async () => {
    const migration = activeMigration(BLINK_SKILL_ID)
    const stateFor = (skill: SkillDefinition) => blinkState(skill, true)
    const draft: BattleAction = {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'blink-caster',
      skillId: BLINK_SKILL_ID,
    }
    const legacyPreparation = prepareAction(stateFor(migration.legacy), draft)
    const graphPreparation = prepareAction(stateFor(migration.graph), draft)
    expect(legacyPreparation).toMatchObject({ kind: 'needTarget', targetType: 'cell' })
    expect(graphPreparation).toEqual(legacyPreparation)

    const action = gridAction(stateFor(migration.legacy), BLINK_SKILL_ID, 3, 2)
    const report = await assertContentGraphParity(parityOptions(
      { skills: { [BLINK_SKILL_ID]: migration.legacy }, artifact: migration.artifact },
      { skills: { [BLINK_SKILL_ID]: migration.graph }, artifact: migration.artifact },
      () => stateFor(migration.legacy),
      () => stateFor(migration.graph),
      [action],
    ))
    expectEqualRuntimeChannels(report)

    const finalState = report.steps[0].legacy.state as BattleState
    expect(finalState.pieces.find(piece => piece.instanceId === 'blink-caster'))
      .toMatchObject({ x: 2, y: 2 })
    expect(finalState.actions?.some(entry => entry.type === 'positionChanged')).toBe(false)
    expect(finalState.actions?.at(-1)?.payload).toMatchObject({
      message: expect.stringContaining('位移被阻挡'),
    })
  })

  it('preserves blocked damage and shield consumption for venom-claw-rend', async () => {
    const migration = activeMigration(VENOM_SKILL_ID)
    const shieldDefinition = fixtureDefinition('rules', DIVINE_SHIELD_RULE_ID)
    const shieldRule = loadRuleFromDefinition(shieldDefinition, `${DIVINE_SHIELD_RULE_ID}-fixture`)
    const stateFor = (skill: SkillDefinition) => {
      const state = activeState(skill)
      const target = state.pieces.find(piece => piece.instanceId === 'active-enemy')!
      target.statusTags = [{ id: 'divine-shield', type: 'divine-shield' }]
      target.rules = [shieldRule]
      return state
    }
    const action = activeAction(stateFor(migration.legacy), VENOM_SKILL_ID)
    const report = await assertContentGraphParity(parityOptions(
      { skills: { [VENOM_SKILL_ID]: migration.legacy }, artifact: migration.artifact },
      { skills: { [VENOM_SKILL_ID]: migration.graph }, artifact: migration.artifact },
      () => stateFor(migration.legacy),
      () => stateFor(migration.graph),
      [action],
      { rules: { [DIVINE_SHIELD_RULE_ID]: shieldRule } },
      { rules: { [DIVINE_SHIELD_RULE_ID]: shieldRule } },
    ))
    expectEqualRuntimeChannels(report)

    const finalState = report.steps[0].legacy.state as BattleState
    const target = finalState.pieces.find(piece => piece.instanceId === 'active-enemy')!
    expect(target.currentHp).toBe(30)
    expect(target.statusTags).toEqual([])
    expect(target.rules).toEqual([])
    expect(finalState.actions?.find(entry => entry.type === 'damage')?.payload).toMatchObject({
      blocked: true,
      finalDamage: 0,
      resolvedDamage: 0,
    })
  })

  it('preserves capped lifesteal when illidan-eye-beam overheals', async () => {
    const migration = activeMigration(ILLIDAN_SKILL_ID)
    const legacyState = () => activeState(migration.legacy)
    const graphState = () => activeState(migration.graph)
    const action = activeAction(legacyState(), ILLIDAN_SKILL_ID)
    const report = await assertContentGraphParity(parityOptions(
      { skills: { [ILLIDAN_SKILL_ID]: migration.legacy }, artifact: migration.artifact },
      { skills: { [ILLIDAN_SKILL_ID]: migration.graph }, artifact: migration.artifact },
      legacyState,
      graphState,
      [action],
    ))
    expectEqualRuntimeChannels(report)

    const finalState = report.steps[0].legacy.state as BattleState
    expect(finalState.pieces.find(piece => piece.instanceId === 'active-caster')?.currentHp).toBe(100)
    expect(finalState.pieces.find(piece => piece.instanceId === 'active-enemy')?.currentHp).toBe(20)
    expect(report.steps[0].legacy.presentationEvents?.find(event => (
      (event as any).kind === 'heal'
    ))).toMatchObject({ result: { amount: 5, value: 100 } })
  })

  it('preserves rule-reap queued healing through the real effect chain', async () => {
    const skillMigration = activeMigration(ASHBRINGER_SKILL_ID)
    const ruleMigration = ruleMigrationForTest()
    const stateFor = (skill: SkillDefinition, rule: TriggerRule) => {
      const state = activeState(skill)
      const caster = state.pieces.find(piece => piece.instanceId === 'active-caster')!
      caster.rules = [rule]
      caster.currentHp = 50
      return state
    }
    const action = activeAction(stateFor(skillMigration.legacy, ruleMigration.legacy), ASHBRINGER_SKILL_ID)
    const report = await assertContentGraphParity(parityOptions(
      {
        skills: { [ASHBRINGER_SKILL_ID]: skillMigration.legacy },
        rule: ruleMigration.legacy,
        artifact: { skill: skillMigration.artifact, rule: ruleMigration.artifact },
      },
      {
        skills: { [ASHBRINGER_SKILL_ID]: skillMigration.graph },
        rule: ruleMigration.graph,
        artifact: { skill: skillMigration.artifact, rule: ruleMigration.artifact },
      },
      () => stateFor(skillMigration.legacy, ruleMigration.legacy),
      () => stateFor(skillMigration.graph, ruleMigration.graph),
      [action],
      { rules: { [REAP_RULE_ID]: ruleMigration.legacy } },
      { rules: { [REAP_RULE_ID]: ruleMigration.graph } },
    ))
    expectEqualRuntimeChannels(report)

    const finalState = report.steps[0].legacy.state as BattleState
    expect(finalState.pieces.find(piece => piece.instanceId === 'active-caster')?.currentHp).toBe(55)
    expect(finalState.actions?.some(entry => entry.type === 'triggerEffect')).toBe(true)
    expect(report.steps[0].legacy.presentationEvents?.find(event => (
      (event as any).kind === 'heal'
    ))).toMatchObject({ result: { amount: 5, value: 55 } })
  })

  it('preserves soul-fragment card healing through the real card executor', async () => {
    const migration = cardMigration(SOUL_FRAGMENT_CARD_ID)
    const stateFor = () => {
      const caster = namedPiece({
        instanceId: 'card-caster', ownerPlayerId: 'player-red', faction: 'red', x: 0, y: 0,
        currentHp: 100, maxHp: 100,
      })
      const ally = namedPiece({
        instanceId: 'card-ally', ownerPlayerId: 'player-red', faction: 'red', x: 1, y: 0,
        currentHp: 5, maxHp: 10,
      })
      const state = makeState({ pieces: [caster, ally], width: 4, height: 3 })
      state.players[0].actionPoints = 2
      state.players[0].maxActionPoints = 2
      state.players[0].hand = [{
        cardId: SOUL_FRAGMENT_CARD_ID,
        instanceId: 'soul-fragment-instance',
        ownerPlayerId: 'player-red',
        actionPointCost: 0,
      }] as any
      return state
    }
    const preparation = prepareAction(stateFor(), {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'soul-fragment-instance',
    })
    if (preparation.kind !== 'needTarget') throw new Error('soul-fragment should require a target')
    const action: BattleAction = {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'soul-fragment-instance',
      targetPieceId: 'card-ally',
      selectionId: preparation.selectionId,
      stateRevision: preparation.stateRevision,
    }
    const report = await assertContentGraphParity(parityOptions(
      { card: migration.legacy, artifact: migration.artifact },
      { card: migration.graph, artifact: migration.artifact },
      stateFor,
      stateFor,
      [action],
      { card: migration.legacy },
      { card: migration.graph },
    ))
    expectEqualRuntimeChannels(report)

    const finalState = report.steps[0].legacy.state as BattleState
    expect(finalState.pieces.find(piece => piece.instanceId === 'card-ally')?.currentHp).toBe(7)
    expect(finalState.players[0].hand).toEqual([])
    expect(finalState.players[0].discardPile).toEqual([SOUL_FRAGMENT_CARD_ID])
  })

  it('preserves invalid target rejection without mutating runtime state', async () => {
    const migration = activeMigration(LIGHT_SKILL_ID)
    const stateWithEnemy = (skill: SkillDefinition) => {
      const state = activeState(skill)
      state.pieces.push(namedPiece({
        instanceId: 'invalid-enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 1, y: 1,
        currentHp: 30, maxHp: 30,
      }))
      return state
    }
    const legacyState = () => stateWithEnemy(migration.legacy)
    const graphState = () => stateWithEnemy(migration.graph)
    const action = activeAction(legacyState(), LIGHT_SKILL_ID, 'invalid-enemy')
    const report = await assertContentGraphParity(parityOptions(
      { skills: { [LIGHT_SKILL_ID]: migration.legacy }, artifact: migration.artifact },
      { skills: { [LIGHT_SKILL_ID]: migration.graph }, artifact: migration.artifact },
      legacyState,
      graphState,
      [action],
    ))
    expectEqualRuntimeChannels(report)
    expect(report.steps[0].legacy.executionError).toMatchObject({ name: 'TargetingRuleError' })
    expect(report.steps[0].legacy.pending).toEqual({ option: undefined, target: undefined })
    expect((report.steps[0].legacy.state as BattleState).pieces.map(piece => piece.currentHp))
      .toEqual([80, 50, 30])
  })

  it('infers light-of-the-light ally targeting when no target is supplied', () => {
    const migration = activeMigration(LIGHT_SKILL_ID)
    const stateFor = (skill: SkillDefinition) => {
      const state = activeState(skill)
      state.pieces.push(namedPiece({
        instanceId: 'inference-enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 1, y: 1,
        currentHp: 30, maxHp: 30,
      }))
      return state
    }
    const draft: BattleAction = {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'active-caster',
      skillId: LIGHT_SKILL_ID,
    }
    const legacy = prepareAction(stateFor(migration.legacy), draft)
    const graph = prepareAction(stateFor(migration.graph), draft)
    expect(legacy).toMatchObject({ kind: 'needTarget', targetType: 'piece', filter: 'ally' })
    expect(graph).toEqual(legacy)
  })

  it('preserves pending-target cancellation and viewer projections', async () => {
    const migration = activeMigration(LIGHT_SKILL_ID)
    const stateFor = (skill: SkillDefinition) => {
      const state = activeState(skill)
      state.pendingTargetSelection = finalizePendingTargetSession(state, {
        playerId: 'player-red',
        ownerPlayerId: 'player-red',
        source: { type: 'skill', id: LIGHT_SKILL_ID, pieceId: 'active-caster' },
        targetType: 'piece',
        filter: 'ally',
        range: 7,
        steps: [{ type: 'piece', filter: 'ally', range: 7 } as any],
        candidates: [{ type: 'piece', pieceId: 'active-ally' }],
        fixedCandidates: true,
        canCancel: true,
      }, 0)
      return state
    }
    const pendingState = stateFor(migration.legacy)
    const pending = pendingState.pendingTargetSelection!
    const action: BattleAction = {
      type: 'cancelPendingSelection',
      playerId: 'player-red',
      selectionId: pending.selectionId,
      stateRevision: pending.stateRevision,
    }
    const report = await assertContentGraphParity(parityOptions(
      { skills: { [LIGHT_SKILL_ID]: migration.legacy }, artifact: migration.artifact },
      { skills: { [LIGHT_SKILL_ID]: migration.graph }, artifact: migration.artifact },
      () => stateFor(migration.legacy),
      () => stateFor(migration.graph),
      [action],
    ))
    expectEqualRuntimeChannels(report)
    expect(report.steps[0].legacy.pending).toEqual({ option: undefined, target: undefined })
    expect((report.steps[0].legacy.state as BattleState).actions?.at(-1)).toMatchObject({
      type: 'cancelPendingSelection',
    })
  })
})

function ruleMigrationForTest(): RuleMigration {
  return ruleMigration(REAP_RULE_ID)
}
