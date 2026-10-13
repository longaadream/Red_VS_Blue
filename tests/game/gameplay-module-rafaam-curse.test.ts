/* eslint-disable @typescript-eslint/no-explicit-any -- frozen content parity harness. */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

import {
  applyGameplayModuleGraph,
  assertGameplayModuleDocument,
  compileGameplayModuleGraph,
  GAMEPLAY_MODULE_REGISTRY,
} from '@/lib/skill-graph/module-document'
import { compileContentGraph } from '@/electron-editor/content-graph'
import { importContentGraph } from '@/electron-editor/content-graph-import'
import { clearRuleCache, executeCardFunction, loadRuleById } from '@/lib/game/skills'
import { RuleRuntime, createRuleExecutionContext, withRuleExecutionContext, withRuleRuntime } from '@/lib/game/rule-runtime'
import { recordBattlePresentation, recordedBattlePresentation } from '@/lib/game/battle-presentation-recording'
import { TriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '@/tests/helpers/minimal-state'
import { buildRafaamCurseCardGraph as buildLegacyRafaamCurseCardGraph } from '@/scripts/migrate-generated-content-graphs'
import { migrateAtomicAuthorGraph } from '@/scripts/migrate-atomic-author-modules'
import { migrateSemanticModules } from '@/scripts/migrate-semantic-modules'
import {
  buildRafaamCurseCardGraph,
  buildRafaamCurseEndTurnGraph,
  buildRafaamCurseWardGraph,
  migrateSemanticRafaamCurse,
  RAFAAM_CURSE_END_TURN_RULE_ID,
  RAFAAM_CURSE_WARD_RULE_ID,
} from '@/scripts/migrate-semantic-rafaam-curse'

type JsonRecord = Record<string, any>
const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T
const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries as Record<string, JsonRecord>
function findFrozenCardSources(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(findFrozenCardSources)
  const record = value as JsonRecord
  const own = record.key === 'code' && record.value?.kind === 'literal' && typeof record.value.value === 'string'
    ? [record.value.value]
    : []
  return [...own, ...Object.values(record).flatMap(findFrozenCardSources)]
}
const frozenWardGraph = importContentGraph(fixture[`rules/${RAFAAM_CURSE_WARD_RULE_ID}`].skillCode, 'rule')
const frozenCardSources = findFrozenCardSources(frozenWardGraph)
if (frozenCardSources.length !== 1) throw new Error('Expected one frozen Rafaam generated-card source')
const persistedCurseTemplate = JSON.parse(readFileSync('data/cards/rafaam-curse-sample.json', 'utf8')) as JsonRecord
const independentlyCompiledCurseTemplate = compileGameplayModuleGraph(
  persistedCurseTemplate.gameplayModules.entries.code.graph,
  GAMEPLAY_MODULE_REGISTRY,
).code
type CardTemplateMode = 'legacy' | 'canonical'

/**
 * The migration parity harness must exercise the two real loader paths.  The
 * legacy generated card contains only the raw executable produced by the old
 * content graph; the canonical path carries the verified gameplay module
 * document and its compiled executable.  Keeping these records separate is
 * important because the canonical materializer intentionally preserves more
 * template metadata than the legacy Rafaam helper did.
 */
function cardTemplate(mode: CardTemplateMode): JsonRecord {
  const template = clone(persistedCurseTemplate)
  if (mode === 'legacy') {
    template.code = compileContentGraph(buildLegacyRafaamCurseCardGraph()).code
    delete template.gameplayModules
    return template
  }
  return applyGameplayModuleGraph(template, migrateAtomicAuthorGraph(template.gameplayModules.entries.code.graph))
}

/**
 * Source attribution is the one approved difference between the legacy
 * piece-derived damage and the migrated captured-player damage.  Restrict
 * normalization to the typed damageSource record.  Every other action and
 * presentation field, including ordering, remains an exact parity check.
 */
function normalizeApprovedSourceFields(value: unknown, parentKey?: string, damageActionPayload = false): unknown {
  if (Array.isArray(value)) return value.map(item => normalizeApprovedSourceFields(item, parentKey, damageActionPayload))
  if (!value || typeof value !== 'object') return value
  const record = value as JsonRecord
  const presentationSource = typeof record.kind === 'string'
    && ['damage', 'heal', 'death', 'block', 'passive'].includes(record.kind)
  const isDamageAction = record.type === 'damage'
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [
    key,
    ((parentKey === 'damageSource' && (key === 'kind' || key === 'sourceId' || key === 'playerId'))
      || (parentKey === 'payload' && damageActionPayload && (key === 'sourceId' || key === 'playerId'))
      || (presentationSource && (key === 'sourcePieceId' || key === 'actorPlayerId')))
      ? '<approved-source-field>'
      : normalizeApprovedSourceFields(item, key, isDamageAction || damageActionPayload),
  ]))
}

function expectPresentationParity(generated: any, legacy: any): void {
  expect(normalizeApprovedSourceFields(generated.presentation)).toEqual(normalizeApprovedSourceFields(legacy.presentation))
}

function expectActionParity(generated: any, legacy: any): void {
  expect(normalizeApprovedSourceFields(generated.state.actions)).toEqual(normalizeApprovedSourceFields(legacy.state.actions))
}

const VERIFIED_GENERATED_CARD_SOURCES = new Set([
  frozenCardSources[0],
  compileContentGraph(buildLegacyRafaamCurseCardGraph()).code,
  compileGameplayModuleGraph(buildRafaamCurseCardGraph(), GAMEPLAY_MODULE_REGISTRY).code,
  // Generated cards may be independently compiled from the canonicalized
  // author graph rather than sharing the ward migration's in-memory graph.
  compileGameplayModuleGraph(migrateAtomicAuthorGraph(buildRafaamCurseCardGraph()), GAMEPLAY_MODULE_REGISTRY).code,
  independentlyCompiledCurseTemplate,
])

function migrationRoot(documents?: Record<string, JsonRecord>): string {
  const root = mkdtempSync(join(tmpdir(), 'rvb-red252-rafaam-'))
  mkdirSync(join(root, 'tests/game/fixtures'), { recursive: true })
  mkdirSync(join(root, 'data/rules'), { recursive: true })
  copyFileSync('tests/game/fixtures/RED-252-legacy-content.json', join(root, 'tests/game/fixtures/RED-252-legacy-content.json'))
  for (const id of [RAFAAM_CURSE_END_TURN_RULE_ID, RAFAAM_CURSE_WARD_RULE_ID]) {
    const source = documents?.[id] ?? fixture[`rules/${id}`]
    writeFileSync(join(root, 'data/rules', `${id}.json`), JSON.stringify(source, null, 2) + '\n')
  }
  return root
}

function hostState(): any {
  const caster = makePiece({ instanceId: 'rafaam', templateId: 'rafaam', name: '拉法姆', ownerPlayerId: 'player-red', faction: 'red', x: 1, y: 1, currentHp: 20, maxHp: 20, attack: 8 }) as any
  const ally = makePiece({ instanceId: 'rafaam-ally', templateId: 'ally', name: '友方棋子', ownerPlayerId: 'player-red', faction: 'red', x: 2, y: 1, currentHp: 12, maxHp: 12, attack: 2 }) as any
  const enemy = makePiece({ instanceId: 'rafaam-enemy', templateId: 'enemy', name: '敌方棋子', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 1, currentHp: 20, maxHp: 20, attack: 2 }) as any
  // Runtime pieces have a display name. Keep this parity fixture valid so the
  // assertion compares real messages rather than JavaScript's "undefined".
  caster.name = '拉法姆'; ally.name = '友方棋子'; enemy.name = '敌方棋子'
  const battle = makeState({ pieces: [caster, ally, enemy], currentPlayerId: 'player-red', turnNumber: 4, width: 7, height: 5 }) as any
  battle.customCards = {}
  const player = battle.players.find((item: any) => item.playerId === 'player-red')
  const opponent = battle.players.find((item: any) => item.playerId === 'player-blue')
  player.hand = [{ cardId: 'rafaam-curse-dynamic', instanceId: 'curse-instance', name: '诅咒(5)' }]
  opponent.hand = []
  battle.customCards['rafaam-curse-dynamic'] = {
    id: 'rafaam-curse-dynamic', cardId: 'rafaam-curse-dynamic', name: '诅咒(5)', damageAmount: 5,
    sourcePieceId: caster.instanceId, extension: { sourcePlayerId: 'player-red' }, type: 'reactive', trigger: { type: 'endTurn' },
  }
  return { battle, caster, ally, enemy }
}

function runRule(
  definition: JsonRecord,
  id: string,
  setup?: (state: any) => void,
  followUp?: (state: any) => unknown,
  options: {
    templateMode: CardTemplateMode
    installObserver?: (triggerSystem: TriggerSystem, state: any, observations: any[]) => void
  } = { templateMode: 'canonical' },
): any {
  const root = mkdtempSync(join(tmpdir(), 'rvb-red252-rafaam-rule-'))
  mkdirSync(join(root, 'data/rules'), { recursive: true })
  mkdirSync(join(root, 'data/cards'), { recursive: true })
  writeFileSync(join(root, 'data/cards/rafaam-curse-sample.json'), JSON.stringify(cardTemplate(options.templateMode)))
  writeFileSync(join(root, 'data/rules', `${id}.json`), JSON.stringify({ ...clone(definition), id }))
  const previousRoot = process.env.RVB_PROFILE_ROOT
  process.env.RVB_PROFILE_ROOT = root
  clearRuleCache()
  const state = hostState()
  setup?.(state)
  const runtime = new RuleRuntime({ rootSeed: 594 })
  const triggerSystem = new TriggerSystem()
  const observations: any[] = []
  options.installObserver?.(triggerSystem, state, observations)
  const context = { type: 'endTurn', rulePiece: state.caster, piece: state.caster, playerId: 'player-red', triggerPlayerId: 'player-red', battle: state.battle }
  let result: unknown
  let followUpResult: unknown
  let error: unknown
  try {
    const rule = loadRuleById(id, true, true)
    if (!rule) throw new Error(`missing Rafaam rule ${id}`)
    result = recordBattlePresentation(state.battle, () => withRuleExecutionContext(createRuleExecutionContext(triggerSystem), () => withRuleRuntime(runtime, () => {
      const primaryResult = rule.effect(state.battle, context)
      followUpResult = followUp?.(state)
      return primaryResult
    })), () => state.battle)
  } catch (cause) {
    error = cause
  } finally {
    clearRuleCache()
    if (previousRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
  return { result: clone(result), followUpResult: clone(followUpResult), error: error instanceof Error ? error.message : error, state: clone(state.battle), random: runtime.snapshot(), observations: clone(observations), presentation: clone(recordedBattlePresentation(state.battle) ?? []) }
}

function playLastGeneratedCurse(state: any): unknown {
  const opponent = state.battle.players.find((player: any) => player.playerId === 'player-blue')
  const cardInstance = opponent?.hand?.at(-1)
  if (!cardInstance) throw new Error('ward did not add a generated curse card')
  const card = state.battle.customCards?.[cardInstance.cardId]
  if (!card) throw new Error(`generated curse definition ${cardInstance.cardId} is missing`)
  state.battle.turn.currentPlayerId = 'player-blue'
  return executeCardFunction(
    card,
    'player-blue',
    state.battle,
    { type: 'endTurn', playerId: 'player-blue', battle: state.battle },
    undefined,
    undefined,
    undefined,
    [],
    cardInstance,
  )
}

function normalizeGeneratedCurseCode(state: any): any {
  const snapshot = clone(state)
  for (const card of Object.values(snapshot.customCards ?? {}) as any[]) {
    if (typeof card?.id === 'string' && card.id.startsWith('rafaam-curse-') && typeof card.code === 'string') {
      if (!VERIFIED_GENERATED_CARD_SOURCES.has(card.code)) throw new Error(`unverified generated curse executable: ${card.id}`)
      card.code = 'RED-252:verified-rafaam-child-source'
    }
  }
  return snapshot
}

describe('semantic Rafaam curse migration', () => {
  it('registers generic closed primitives and compiles all three graphs without native Rafaam nodes', () => {
    const graphs = [
      migrateAtomicAuthorGraph(buildRafaamCurseEndTurnGraph()),
      migrateAtomicAuthorGraph(buildRafaamCurseWardGraph()),
      migrateAtomicAuthorGraph(buildRafaamCurseCardGraph()),
    ]
    const compiled = graphs.map(graph => compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY))
    expect(compiled.every(item => item.code.length > 0)).toBe(true)
    expect(JSON.stringify(graphs)).not.toContain('function execute')
    expect(JSON.stringify(graphs)).not.toMatch(/dealDamage|addStatusEffectById|addCardToHand/)
    expect(GAMEPLAY_MODULE_REGISTRY.descriptors.map(item => item.id)).toEqual(expect.arrayContaining([
      'content.card-number', 'content.materialize-curse-template', 'card.current-id', 'card.current-type',
      'effect.card-damage', 'effect.damage-with-killer-typed', 'result.card-action',
    ]))
  })

  it('preflights both rule writes, preserves metadata, and refuses tampered executable input', () => {
    const authoredEnd = { ...clone(fixture[`rules/${RAFAAM_CURSE_END_TURN_RULE_ID}`]), unknownAuthorMetadata: { retained: true } }
    const root = migrationRoot({ [RAFAAM_CURSE_END_TURN_RULE_ID]: authoredEnd })
    try {
      expect(migrateSemanticRafaamCurse(root, true)).toEqual([RAFAAM_CURSE_END_TURN_RULE_ID, RAFAAM_CURSE_WARD_RULE_ID])
      const persistedEnd = JSON.parse(readFileSync(join(root, 'data/rules', `${RAFAAM_CURSE_END_TURN_RULE_ID}.json`), 'utf8'))
      const persistedWard = JSON.parse(readFileSync(join(root, 'data/rules', `${RAFAAM_CURSE_WARD_RULE_ID}.json`), 'utf8'))
      assertGameplayModuleDocument(persistedEnd)
      assertGameplayModuleDocument(persistedWard)
      expect(persistedEnd.unknownAuthorMetadata).toEqual({ retained: true })
      expect(persistedEnd.contentGraph).toBeUndefined()
      expect(persistedWard.contentGraph).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }

    const tampered = clone(fixture[`rules/${RAFAAM_CURSE_END_TURN_RULE_ID}`])
    tampered.skillCode += '\n// author edit'
    const tamperedRoot = migrationRoot({ [RAFAAM_CURSE_END_TURN_RULE_ID]: tampered })
    try {
      expect(() => migrateSemanticRafaamCurse(tamperedRoot, true)).toThrow(/author executable differs from frozen baseline/)
      const persisted = JSON.parse(readFileSync(join(tamperedRoot, 'data/rules', `${RAFAAM_CURSE_WARD_RULE_ID}.json`), 'utf8'))
      expect(persisted.gameplayModules).toBeUndefined()
    } finally {
      rmSync(tamperedRoot, { recursive: true, force: true })
    }
  })

  it('preserves an authored Rafaam sample graph when the generic migration recipe is rerun', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-red252-rafaam-semantic-recipe-'))
    mkdirSync(join(root, 'tests/game/fixtures'), { recursive: true })
    mkdirSync(join(root, 'data/cards'), { recursive: true })
    copyFileSync('tests/game/fixtures/RED-252-legacy-content.json', join(root, 'tests/game/fixtures/RED-252-legacy-content.json'))
    const source = JSON.parse(readFileSync('data/cards/rafaam-curse-sample.json', 'utf8')) as JsonRecord
    writeFileSync(join(root, 'data/cards/rafaam-curse-sample.json'), JSON.stringify(source, null, 2) + '\n')
    try {
      const run = migrateSemanticModules(root, true, ['cards/rafaam-curse-sample.code'])
      expect(run.reports).toEqual([expect.objectContaining({ id: 'cards/rafaam-curse-sample', status: 'already-migrated' })])
      expect(JSON.parse(readFileSync(join(root, 'data/cards/rafaam-curse-sample.json'), 'utf8'))).toEqual(source)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves seeded end-turn hand order, damage, message and RNG with captured player attribution', () => {
    const semantic = applyGameplayModuleGraph(fixture[`rules/${RAFAAM_CURSE_END_TURN_RULE_ID}`], migrateAtomicAuthorGraph(buildRafaamCurseEndTurnGraph()), 'skillCode')
    const legacy = runRule(fixture[`rules/${RAFAAM_CURSE_END_TURN_RULE_ID}`], RAFAAM_CURSE_END_TURN_RULE_ID, undefined, undefined, { templateMode: 'legacy' })
    const generated = runRule(semantic, RAFAAM_CURSE_END_TURN_RULE_ID, undefined, undefined, { templateMode: 'canonical' })
    expect(generated.error).toBeUndefined()
    expect(generated.result).toEqual(legacy.result)
    expect(generated.state.pieces).toEqual(legacy.state.pieces)
    expect(generated.state.players).toEqual(legacy.state.players)
    expect(generated.state.actions.filter((action: any) => action.type === 'damage').at(-1)?.payload).toMatchObject({ damageSource: { kind: 'player', sourceId: 'player-red', playerId: 'player-red' } })
    expect(generated.random).toEqual(legacy.random)
    expectActionParity(generated, legacy)
    expectPresentationParity(generated, legacy)
  })

  it('keeps lethal end-turn settlement and observes the captured player attribution', () => {
    const semantic = applyGameplayModuleGraph(fixture[`rules/${RAFAAM_CURSE_END_TURN_RULE_ID}`], migrateAtomicAuthorGraph(buildRafaamCurseEndTurnGraph()), 'skillCode')
    const installObserver = (triggerSystem: TriggerSystem, _state: any, observations: any[]) => {
      triggerSystem.addRule({
        id: 'red252-rafaam-before-damage-observer',
        name: 'RED-252 damage observer',
        description: 'test-only source attribution observer',
        trigger: { type: 'beforeDamageTaken' },
        effect: (_battle, context) => {
          observations.push({
            kind: 'damage',
            targetId: context.targetPiece?.instanceId ?? context.piece?.instanceId,
            damageSource: clone(context.damageSource),
          })
          return { success: true }
        },
      })
      triggerSystem.addRule({
        id: 'red252-rafaam-death-observer',
        name: 'RED-252 death observer',
        description: 'test-only committed death observer',
        trigger: { type: 'onPieceDied' },
        effect: (_battle, context) => {
          observations.push({
            kind: 'death',
            pieceId: context.piece?.instanceId,
            sourcePieceId: context.sourcePiece?.instanceId,
            targetPieceId: context.targetPiece?.instanceId,
          })
          return { success: true }
        },
      })
    }
    const makeLethal = (state: any) => {
      state.caster.currentHp = 1
      state.ally.currentHp = 1
    }
    const legacy = runRule(
      fixture[`rules/${RAFAAM_CURSE_END_TURN_RULE_ID}`],
      RAFAAM_CURSE_END_TURN_RULE_ID,
      makeLethal,
      undefined,
      { templateMode: 'legacy', installObserver },
    )
    const generated = runRule(
      semantic,
      RAFAAM_CURSE_END_TURN_RULE_ID,
      makeLethal,
      undefined,
      { templateMode: 'canonical', installObserver },
    )

    expect(legacy.error).toBeUndefined()
    expect(generated.error).toBeUndefined()
    expect(generated.state.pieces).toEqual(legacy.state.pieces)
    expect(generated.state.players).toEqual(legacy.state.players)
    expect(generated.state.graveyard).toEqual(legacy.state.graveyard)
    expect(generated.random).toEqual(legacy.random)
    expectActionParity(generated, legacy)
    expectPresentationParity(generated, legacy)

    const generatedDamageObservation = generated.observations.find((entry: any) => entry.kind === 'damage')
    expect(generatedDamageObservation).toMatchObject({
      damageSource: { kind: 'player', sourceId: 'player-red', playerId: 'player-red' },
    })
    expect(generated.observations.filter((entry: any) => entry.kind === 'death')).toHaveLength(1)
    const generatedDamage = generated.state.actions.filter((action: any) => action.type === 'damage').at(-1)?.payload
    expect(generatedDamage).toMatchObject({
      damageSource: { kind: 'player', sourceId: 'player-red', playerId: 'player-red' },
      rawDamage: 5,
      resolvedDamage: 5,
      finalDamage: 1,
      killed: true,
    })
  })

  it('preserves ward result and keeps the dynamic-card graph available for generated-card execution', () => {
    const semantic = applyGameplayModuleGraph(fixture[`rules/${RAFAAM_CURSE_WARD_RULE_ID}`], migrateAtomicAuthorGraph(buildRafaamCurseWardGraph()), 'skillCode')
    const legacy = runRule(fixture[`rules/${RAFAAM_CURSE_WARD_RULE_ID}`], RAFAAM_CURSE_WARD_RULE_ID, state => { state.caster.attack = 8 }, undefined, { templateMode: 'legacy' })
    const generated = runRule(semantic, RAFAAM_CURSE_WARD_RULE_ID, state => { state.caster.attack = 8 }, undefined, { templateMode: 'canonical' })
    expect(generated.error).toBeUndefined()
    expect(generated.result).toEqual(legacy.result)
    expect(generated.state.pieces[0].statusTags).toEqual(legacy.state.pieces[0].statusTags)
    expect(generated.state.players[1].hand).toEqual(legacy.state.players[1].hand)
    const cardGraph = migrateAtomicAuthorGraph(buildRafaamCurseCardGraph())
    const cardCode = compileGameplayModuleGraph(cardGraph, GAMEPLAY_MODULE_REGISTRY).code
    expect(cardCode).not.toContain('cardDamage')
    expect(cardCode).toContain('sourcePlayerId')
    expect(cardCode).toContain('keepInHand:true')
    expect(JSON.stringify(cardGraph)).not.toContain('effect.card-damage')
  })

  it('preserves generated curse outcomes and RNG while using the approved captured player source', () => {
    const semantic = applyGameplayModuleGraph(fixture[`rules/${RAFAAM_CURSE_WARD_RULE_ID}`], migrateAtomicAuthorGraph(buildRafaamCurseWardGraph()), 'skillCode')
    const legacy = runRule(fixture[`rules/${RAFAAM_CURSE_WARD_RULE_ID}`], RAFAAM_CURSE_WARD_RULE_ID, state => { state.caster.attack = 8 }, playLastGeneratedCurse, { templateMode: 'legacy' })
    const generated = runRule(semantic, RAFAAM_CURSE_WARD_RULE_ID, state => { state.caster.attack = 8 }, playLastGeneratedCurse, { templateMode: 'canonical' })
    expect(generated.error).toBeUndefined()
    expect(generated.followUpResult).toEqual(legacy.followUpResult)
    const generatedCardId = generated.state.players[1].hand.at(-1)?.cardId
    const generatedCard = generated.state.customCards[generatedCardId]
    expect(generatedCard).toMatchObject({
      id: generatedCardId,
      name: '诅咒(4)',
      description: '可消耗1点行动点弃置；若未弃置，回合结束时使1个随机友军受到4点伤害。',
      type: persistedCurseTemplate.type,
      trigger: { type: 'endTurn' },
      damageAmount: 4,
      extension: { sourcePlayerId: 'player-red' },
      icon: persistedCurseTemplate.icon,
      actionPointCost: persistedCurseTemplate.actionPointCost,
    })
    for (const key of ['code', 'gameplayModules', 'type', 'icon', 'actionPointCost']) {
      expect(generatedCard[key], `generated card should preserve template metadata ${key}`).toEqual(persistedCurseTemplate[key])
    }
    for (const key of ['isSample', 'image', 'effectTags', 'targetText', 'keywords']) {
      expect(generatedCard[key], `generated card should omit sample metadata ${key}`).toBeUndefined()
    }
    assertGameplayModuleDocument(generatedCard)
    expect(normalizeGeneratedCurseCode(generated.state).customCards[generatedCardId].code).toBe('RED-252:verified-rafaam-child-source')
    expect(generated.state.pieces).toEqual(legacy.state.pieces)
    expect(generated.state.players).toEqual(legacy.state.players)
    expect(generated.state.actions.filter((action: any) => action.type === 'damage').at(-1)?.payload).toMatchObject({
      damageSource: { kind: 'player', sourceId: 'player-red', playerId: 'player-red' }, resolvedDamage: 4,
    })
    expect(generated.random).toEqual(legacy.random)
    expectActionParity(generated, legacy)
    expectPresentationParity(generated, legacy)
  })

  it('keeps the card graph on the normal card execution path once materialized', () => {
    const state = hostState()
    const cardGraph = migrateAtomicAuthorGraph(buildRafaamCurseCardGraph())
    const compiled = compileGameplayModuleGraph(cardGraph, GAMEPLAY_MODULE_REGISTRY)
    const card: any = { ...state.battle.customCards['rafaam-curse-dynamic'], code: compiled.code, gameplayModules: { version: 'rvb-gameplay-module-document/v1', entries: { code: { graph: cardGraph, compilerVersion: compiled.compilerVersion } } } }
    const runtime = new RuleRuntime({ rootSeed: 594 })
    const context: any = { type: 'endTurn', playerId: 'player-red', battle: state.battle, card: { id: card.id }, cardInstanceId: 'curse-instance' }
    const result = withRuleRuntime(runtime, () => recordBattlePresentation(state.battle, () => executeCardFunction(card, 'player-red', state.battle, { type: 'endTurn', playerId: 'player-red' }, state.ally, undefined, undefined, [], { cardId: card.id, instanceId: 'curse-instance', name: card.name }), () => state.battle))
    expect(result).toMatchObject({ success: true, keepInHand: true })
    expect(state.caster.currentHp < 20 || state.ally.currentHp < 12).toBe(true)
    expect(context).toBeDefined()
  })

  it('recognizes zero-value generated cards and omits the legacy wrong-turn message', () => {
    const state = hostState()
    const cardGraph = buildRafaamCurseCardGraph()
    const cardCode = compileGameplayModuleGraph(cardGraph, GAMEPLAY_MODULE_REGISTRY).code
    const cardId = 'rafaam-curse-zero'
    const card: any = {
      id: cardId,
      cardId,
      name: '诅咒(0)',
      type: 'reactive',
      trigger: { type: 'endTurn' },
      damageAmount: 0,
      sourcePieceId: 'rafaam',
      code: cardCode,
    }
    const cardInstance = { cardId, instanceId: 'zero-curse-instance', name: card.name }
    state.battle.customCards[cardId] = card
    state.battle.players[0].hand = [cardInstance]
    const runtime = new RuleRuntime({ rootSeed: 594 })
    const discarded = withRuleRuntime(runtime, () => executeCardFunction(card, 'player-red', state.battle, { type: 'play', playerId: 'player-red', battle: state.battle }, undefined, undefined, undefined, [], cardInstance))
    expect(discarded).toEqual({ success: true, message: '弃置了诅咒' })
    state.battle.turn.currentPlayerId = 'player-blue'
    const wrongTurn = withRuleRuntime(runtime, () => executeCardFunction(card, 'player-red', state.battle, { type: 'endTurn', playerId: 'player-red', battle: state.battle }, undefined, undefined, undefined, [], cardInstance))
    expect(wrongTurn).toEqual({ success: false })
  })
})
