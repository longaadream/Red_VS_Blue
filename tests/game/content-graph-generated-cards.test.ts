/* eslint-disable @typescript-eslint/no-explicit-any -- generated-content parity harness intentionally models legacy JSON. */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  compileContentGraph,
  CONTENT_GRAPH_VERSION,
  type ContentGraph,
} from '@/electron-editor/content-graph-document'
import {
  executeCardFunction,
  executeSkillFunction,
  loadRuleById,
  type CardDefinition,
  type SkillDefinition,
} from '@/lib/game/skills'
import {
  createRuleExecutionContext,
  RuleRuntime,
  withRuleExecutionContext,
  withRuleRuntime,
} from '@/lib/game/rule-runtime'
import { TriggerSystem } from '@/lib/game/triggers'
import { recordBattlePresentation, recordedBattlePresentation } from '@/lib/game/battle-presentation-recording'
import { makePiece, makeState } from '@/tests/helpers/minimal-state'
import {
  buildGeneratedContentMigration,
  buildGeneratedContentMigrations,
} from '@/scripts/migrate-generated-content-graphs'
import {
  canonicalizeGeneratedCards,
  type GeneratedSourcePair,
} from '@/tests/game/helpers/content-graph-generated-sources'

type JsonRecord = Record<string, any>

const fixture = JSON.parse(
  readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8'),
) as { entries: Record<string, JsonRecord> }

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function migration(id: string) {
  const legacy = fixture.entries[id]
  return buildGeneratedContentMigration(id, { legacy, current: legacy, root: process.cwd() })
}

function executeExpression<T>(code: string, names: string[], values: unknown[]): T {
  return new Function(...names, `return (${code})`)(...values) as T
}

function executeBody<T>(code: string, names: string[], values: unknown[]): T {
  return new Function(...names, code)(...values) as T
}

function deterministicDate(value = 1_700_000_000_000) {
  return { now: () => value }
}

function makeArmorHarness(choice: string[]) {
  const events: JsonRecord[] = []
  const battle: JsonRecord = { customCards: {}, players: [{ playerId: 'player-red', hand: [] }] }
  const piece = { instanceId: 'tails', ownerPlayerId: 'player-red', name: 'Tails' }
  const selectOption = (options: unknown) => {
    events.push({ type: 'selectOption', options: cloneJson(options) })
    return [...choice]
  }
  const addCardToHand = (cardId: string, playerId: string) => {
    events.push({ type: 'addCardToHand', cardId, playerId })
    const player = battle.players.find((candidate: JsonRecord) => candidate.playerId === playerId)
    player.hand.push({ cardId, instanceId: `${cardId}-instance`, name: battle.customCards[cardId].name })
    return true
  }
  return { events, battle, piece, context: { piece, battle }, selectOption, addCardToHand }
}

function armorCardUse(source: string) {
  const events: JsonRecord[] = []
  const target: JsonRecord = { instanceId: 'ally', statusTags: [], attack: 1, defense: 1 }
  const selectTarget = (options: unknown) => {
    events.push({ type: 'selectTarget', options: cloneJson(options) })
    return target
  }
  const addRuleById = (pieceId: string, ruleId: string) => {
    events.push({ type: 'addRuleById', pieceId, ruleId })
    return true
  }
  const executeCard = executeExpression<(context: unknown) => unknown>(
    source,
    ['selectTarget', 'addRuleById', 'Date'],
    [selectTarget, addRuleById, deterministicDate(1_700_000_000_001)],
  )
  const result = executeCard({})
  return { result, target, events }
}

function makeCurseHarness() {
  const events: JsonRecord[] = []
  const piece: JsonRecord = {
    instanceId: 'rafaam', ownerPlayerId: 'player-red', name: '拉法姆', attack: 2,
    statusTags: [], currentHp: 15, maxHp: 15,
  }
  const opponent: JsonRecord = { playerId: 'player-blue', hand: [] }
  const battle: JsonRecord = {
    turn: { currentPlayerId: 'player-red', turnNumber: 3 },
    players: [{ playerId: 'player-red', hand: [] }, opponent],
    pieces: [piece],
    graveyard: [],
    customCards: {},
  }
  const context = { rulePiece: piece, piece, damage: 5 }
  const nextEnemyPlayer = (_battle: unknown, playerId: string) => playerId === 'player-red' ? 'player-blue' : 'player-red'
  const addStatusEffectById = (pieceId: string, status: JsonRecord) => {
    events.push({ type: 'addStatusEffectById', pieceId, status: cloneJson(status) })
    piece.statusTags.push(status)
    return true
  }
  const addCardToHand = (cardId: string, playerId: string) => {
    events.push({ type: 'addCardToHand', cardId, playerId })
    const player = battle.players.find((candidate: JsonRecord) => candidate.playerId === playerId)
    player.hand.push({ cardId, instanceId: `${cardId}-instance`, name: battle.customCards[cardId].name })
    return true
  }
  return { events, piece, battle, context, nextEnemyPlayer, addStatusEffectById, addCardToHand }
}

function useCurseCard(source: string, battle: JsonRecord, cardId: string, omitSource = false) {
  const events: JsonRecord[] = []
  const target: JsonRecord = { instanceId: 'blue-target', ownerPlayerId: 'player-blue', name: '蓝方目标', currentHp: 20, maxHp: 20 }
  const sourcePiece = battle.pieces[0]
  battle.pieces = omitSource ? [target] : [sourcePiece, target]
  battle.turn.currentPlayerId = 'player-blue'
  const dealDamage = (
    attacker: JsonRecord,
    hit: JsonRecord,
    amount: number,
    damageType: string,
    battleState: JsonRecord,
    skillId: string,
    skipBeforeTrigger: boolean,
  ) => {
    events.push({
      type: 'dealDamage',
      source: attacker?.instanceId,
      target: hit.instanceId,
      amount,
      damageType,
      battleTurn: battleState?.turn?.turnNumber,
      skillId,
      skipBeforeTrigger,
    })
    hit.currentHp -= amount
    return { damage: amount }
  }
  const math = Object.create(Math) as JsonRecord
  math.random = () => {
    events.push({ type: 'random', value: 0 })
    return 0
  }
  const executeCard = executeExpression<(context: unknown) => unknown>(
    source,
    ['dealDamage', 'Math', 'battle', 'playerId'],
    [dealDamage, math, battle, 'player-blue'],
  )
  const result = executeCard({ type: 'endTurn', card: { id: cardId } })
  return { result, target, events }
}

function compileBoundCardSource(child: ContentGraph, selected: string[]): string {
  const materializer: ContentGraph = {
    version: CONTENT_GRAPH_VERSION,
    surface: 'skill',
    entry: 'materialize',
    nodes: [
      {
        id: 'materialize',
        kind: 'materializeSource',
        graph: child,
        bindings: {
          selected: {
            kind: 'array',
            items: selected.map(value => ({ kind: 'literal', value })),
          },
        },
        result: 'source',
        next: 'done',
      },
      { id: 'done', kind: 'return', value: { kind: 'ref', name: 'source' } },
    ],
  }
  const execute = new Function(`return (${compileContentGraph(materializer).code})`)() as () => string
  return execute()
}

type SnapshotContext = { readonly seen: WeakMap<object, number>; nextId: number }

function snapshotValue(value: unknown, context: SnapshotContext = { seen: new WeakMap(), nextId: 0 }): unknown {
  if (typeof value === 'function') return { functionSource: String(value) }
  if (value === null || typeof value !== 'object') return value
  const object = value as object
  const existing = context.seen.get(object)
  if (existing !== undefined) return { reference: existing }
  const id = context.nextId++
  context.seen.set(object, id)
  if (Array.isArray(value)) return { id, array: value.map(item => snapshotValue(item, context)) }
  const result: JsonRecord = { id }
  for (const [key, nested] of Object.entries(value)) result[key] = snapshotValue(nested, context)
  return result
}

type HostExecution = {
  readonly result: unknown
  readonly error?: unknown
  readonly battle: JsonRecord
  readonly random: unknown
  readonly presentation: unknown
}

function hostState(casterId: string, casterOwner: 'player-red' | 'player-blue' = 'player-red') {
  const enemyOwner = casterOwner === 'player-red' ? 'player-blue' : 'player-red'
  const caster = makePiece({
    instanceId: casterId,
    ownerPlayerId: casterOwner,
    faction: casterOwner === 'player-red' ? 'red' : 'blue',
    x: 2,
    y: 2,
    currentHp: 12,
    maxHp: 12,
    attack: 6,
  }) as JsonRecord
  caster.name = casterId
  const ally = makePiece({
    instanceId: `${casterId}-ally`,
    ownerPlayerId: casterOwner,
    faction: casterOwner === 'player-red' ? 'red' : 'blue',
    x: 2,
    y: 3,
    currentHp: 8,
    maxHp: 12,
    attack: 3,
  }) as JsonRecord
  ally.name = `${casterId}-ally`
  const enemy = makePiece({
    instanceId: `${casterId}-enemy`,
    ownerPlayerId: enemyOwner,
    faction: enemyOwner === 'player-red' ? 'red' : 'blue',
    x: 4,
    y: 2,
    currentHp: 12,
    maxHp: 12,
    attack: 3,
  }) as JsonRecord
  enemy.name = `${casterId}-enemy`
  const battle = makeState({
    pieces: [caster, ally, enemy] as any,
    currentPlayerId: casterOwner,
    turnNumber: 3,
    width: 7,
    height: 7,
  }) as JsonRecord
  battle.players.find((player: JsonRecord) => player.playerId === casterOwner).actionPoints = 10
  return { battle, caster, ally, enemy }
}

function runHostSkill(definition: SkillDefinition, selected: string[], seed = 0x252, initial?:Pick<ReturnType<typeof hostState>,'battle'|'caster'>): HostExecution {
  const state = initial ?? hostState('tails-host')
  const context: JsonRecord = {
    piece: state.caster,
    target: null,
    targetPosition: null,
    targets: [],
    battle: state.battle,
    skill: definition,
    selectedOption: [...selected],
  }
  const runtime = new RuleRuntime({ rootSeed: seed })
  const triggerSystem = new TriggerSystem()
  let result: unknown
  let error: unknown
  try {
    withRuleExecutionContext(
      createRuleExecutionContext(triggerSystem),
      () => withRuleRuntime(runtime, () => {
        result = recordBattlePresentation(
          state.battle as any,
          () => executeSkillFunction(definition, context as any, state.battle as any),
          () => state.battle as any,
        )
      }),
    )
  } catch (cause) {
    error = cause instanceof Error ? { name: cause.name, message: cause.message } : cause
  }
  return {
    result,
    error,
    battle: state.battle,
    random: runtime.snapshot(),
    presentation: recordedBattlePresentation(state.battle as any),
  }
}

function runHostCard(
  card: JsonRecord,
  battle: JsonRecord,
  playerId: 'player-red' | 'player-blue',
  targetId: string,
  seed = 0x252,
  triggerType?: 'endTurn',
): HostExecution {
  if (triggerType) battle.turn.currentPlayerId = playerId
  const player = battle.players.find((candidate: JsonRecord) => candidate.playerId === playerId)
  const cardInstance = player.hand.find((candidate: JsonRecord) => candidate.cardId === card.id)
  if (!cardInstance) throw new Error(`host card ${card.id} missing hand instance`)
  const target = battle.pieces.find((candidate: JsonRecord) => candidate.instanceId === targetId)
  const runtime = new RuleRuntime({ rootSeed: seed })
  const triggerSystem = new TriggerSystem()
  let result: unknown
  let error: unknown
  try {
    withRuleExecutionContext(
      createRuleExecutionContext(triggerSystem),
      () => withRuleRuntime(runtime, () => {
        result = recordBattlePresentation(
          battle as any,
          () => executeCardFunction(
            card as CardDefinition,
            playerId,
            battle as any,
            triggerType ? {type:triggerType,playerId} : undefined,
            target as any,
            undefined,
            undefined,
            [],
            cardInstance,
          ),
          () => battle as any,
        )
      }),
    )
  } catch (cause) {
    error = cause instanceof Error ? { name: cause.name, message: cause.message } : cause
  }
  return {
    result,
    error,
    battle,
    random: runtime.snapshot(),
    presentation: recordedBattlePresentation(battle as any),
  }
}

function comparableHostPair(
  legacy: HostExecution,
  generated: HostExecution,
  pairs: readonly GeneratedSourcePair[],
) {
  const cards = canonicalizeGeneratedCards(legacy.battle.customCards ?? {}, generated.battle.customCards ?? {}, pairs)
  const normalize = (execution: HostExecution, customCards: Record<string, JsonRecord>) => snapshotValue({
    result: execution.result,
    error: execution.error,
    battle: { ...execution.battle, customCards },
    actionLog: execution.battle.actions,
    debugLog: execution.battle.extensions?.debugBattle?.actionLog,
    random: execution.random,
    presentation: execution.presentation,
  })
  return {
    legacy: normalize(legacy, cards.legacy),
    generated: normalize(generated, cards.generated),
  }
}

function runHostRafaamRule(definition: JsonRecord, id: string, seed = 0x252): HostExecution {
  const profileRoot = mkdtempSync(join(tmpdir(), 'rvb-red252-generated-host-'))
  const rulesDirectory = join(profileRoot, 'data', 'rules')
  mkdirSync(rulesDirectory, { recursive: true })
  writeFileSync(join(rulesDirectory, `${id}.json`), JSON.stringify(definition), 'utf8')
  const previousProfileRoot = process.env.RVB_PROFILE_ROOT
  process.env.RVB_PROFILE_ROOT = profileRoot
  try {
    const { battle, caster, enemy } = hostState('rafaam-host')
    caster.name = '拉法姆'
    battle.players[0].hand = []
    battle.players[1].hand = []
    const runtime = new RuleRuntime({ rootSeed: seed })
    const triggerSystem = new TriggerSystem()
    const rule = loadRuleById(id, true, true)
    if (!rule) throw new Error(`host rule ${id} did not load`)
    const context: JsonRecord = {
      type: 'beforeDamageTaken',
      sourcePiece: caster,
      targetPiece: caster,
      rulePiece: caster,
      piece: caster,
      playerId: caster.ownerPlayerId,
      damage: 5,
      battle,
    }
    let result: unknown
    let error: unknown
    try {
      withRuleExecutionContext(
        createRuleExecutionContext(triggerSystem),
        () => withRuleRuntime(runtime, () => {
          result = recordBattlePresentation(
            battle as any,
            () => rule.effect(battle as any, context),
            () => battle as any,
          )
        }),
      )
    } catch (cause) {
      error = cause instanceof Error ? { name: cause.name, message: cause.message } : cause
    }
    // Keep the target alive and visible to the generated card's later host run.
    battle.pieces = battle.pieces.filter((piece: JsonRecord) => piece.currentHp > 0)
    void enemy
    return {
      result,
      error,
      battle,
      random: runtime.snapshot(),
      presentation: recordedBattlePresentation(battle as any),
    }
  } finally {
    if (previousProfileRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousProfileRoot
    rmSync(profileRoot, { recursive: true, force: true })
  }
}

describe('RED-252 generated card content graphs', () => {
  it('preflights exactly the three generated families and exposes independent graph sources', () => {
    const migrations = buildGeneratedContentMigrations()
    expect(migrations.map(change => change.id)).toEqual([
      'rules/rule-rafaam-curse-ward',
      'skills/rafaam-curse-amplify',
      'skills/tails-armor-assembly',
    ])
    expect(migrations[0].families[0]).toMatchObject({ kind: 'rafaam-curse', bindingNames: [] })
    expect(migrations[1].families).toHaveLength(0)
    expect(migrations[2].families[0]).toMatchObject({
      kind: 'tails-armor',
      bindingNames: ['selected'],
      generatedIds: [
        'armor-attack-defense', 'armor-attack-heal', 'armor-attack-speed',
        'armor-defense-heal', 'armor-defense-speed', 'armor-heal-speed',
      ],
    })

    const curse = migrations[0].graph.nodes.find(node => node.id === 'n3')
    const armor = migrations[2].graph.nodes.find(node => node.id === 'n5')
    expect(curse?.kind).toBe('set')
    expect(armor?.kind).toBe('set')
    if (curse?.kind === 'set' && curse.value.kind === 'object') {
      const code = Array.isArray(curse.value.entries)
        ? curse.value.entries.find(entry => entry.key === 'code')?.value
        : curse.value.entries.code
      expect(code?.kind).toBe('source')
    }
    if (armor?.kind === 'set' && armor.value.kind === 'object') {
      const code = Array.isArray(armor.value.entries)
        ? armor.value.entries.find(entry => entry.key === 'code')?.value
        : armor.value.entries.code
      expect(code?.kind).toBe('ref')
      expect(migrations[2].graph.nodes.some(node => node.kind === 'materializeSource')).toBe(true)
    }
  })

  it('preserves Rafaam ward creation, generated curse use, and amplifier copy behavior', () => {
    const legacy = fixture.entries['rules/rule-rafaam-curse-ward']
    const ward = migration('rules/rule-rafaam-curse-ward')
    const date = deterministicDate(1_700_000_000_000)
    const oldHarness = makeCurseHarness()
    const newHarness = makeCurseHarness()
    const oldResult = executeBody(legacy.skillCode, [
      'context', 'battle', 'nextEnemyPlayer', 'addStatusEffectById', 'addCardToHand', 'Date',
    ], [oldHarness.context, oldHarness.battle, oldHarness.nextEnemyPlayer, oldHarness.addStatusEffectById, oldHarness.addCardToHand, date])
    const newResult = executeBody(String(ward.document.skillCode), [
      'context', 'battle', 'nextEnemyPlayer', 'addStatusEffectById', 'addCardToHand', 'Date',
    ], [newHarness.context, newHarness.battle, newHarness.nextEnemyPlayer, newHarness.addStatusEffectById, newHarness.addCardToHand, date])
    expect(newResult).toEqual(oldResult)
    expect(newHarness.events).toEqual(oldHarness.events)

    const cardId = Object.keys(oldHarness.battle.customCards)[0]
    const oldCard = oldHarness.battle.customCards[cardId]
    const newCard = newHarness.battle.customCards[cardId]
    const rafaamChildSource = compileContentGraph(ward.families[0].graph).code
    expect(newCard.code).toBe(rafaamChildSource)
    const rafaamPairs: GeneratedSourcePair[] = [{
      cardId,
      legacySource: oldCard.code,
      generatedSource: rafaamChildSource,
    }]
    const canonicalWardCards = canonicalizeGeneratedCards(
      oldHarness.battle.customCards,
      newHarness.battle.customCards,
      rafaamPairs,
    )
    expect(canonicalWardCards.generated).toEqual(canonicalWardCards.legacy)

    const oldUse = useCurseCard(oldCard.code, oldHarness.battle, cardId)
    const newUse = useCurseCard(newCard.code, newHarness.battle, cardId)
    expect(newUse.result).toEqual(oldUse.result)
    expect(newUse.target).toEqual(oldUse.target)
    expect(newUse.events).toEqual(oldUse.events)

    const oldFallbackHarness = makeCurseHarness()
    const newFallbackHarness = makeCurseHarness()
    oldFallbackHarness.battle.customCards[cardId] = cloneJson(oldCard)
    newFallbackHarness.battle.customCards[cardId] = cloneJson(newCard)
    const oldFallback = useCurseCard(oldCard.code, oldFallbackHarness.battle, cardId, true)
    const newFallback = useCurseCard(newCard.code, newFallbackHarness.battle, cardId, true)
    expect(newFallback.result).toEqual(oldFallback.result)
    expect(newFallback.target).toEqual(oldFallback.target)
    expect(newFallback.events).toEqual(oldFallback.events)
    expect(newFallback.events.find(event => event.type === 'dealDamage')).toMatchObject({ source: 'blue-target', target: 'blue-target' })

    const amplify = migration('skills/rafaam-curse-amplify')
    const amplifierLegacy = fixture.entries['skills/rafaam-curse-amplify']
    const makeAmplifyState = (card: JsonRecord) => {
      const battle: JsonRecord = {
        customCards: {
          [cardId]: cloneJson(card),
        },
        players: [{ playerId: 'player-red', hand: [] }, {
          playerId: 'player-blue',
          hand: [{ cardId, instanceId: 'curse-instance', name: card.name }],
        }],
      }
      const events: JsonRecord[] = []
      const addCardToHand = (copyId: string, playerId: string) => {
        events.push({ type: 'addCardToHand', copyId, playerId })
        battle.players[1].hand.push({ cardId: copyId, instanceId: `${copyId}-instance`, name: battle.customCards[copyId].name })
        return true
      }
      return { battle, events, context: { piece: { name: '拉法姆', ownerPlayerId: 'player-red' } }, addCardToHand }
    }
    const oldAmplify = makeAmplifyState(oldCard)
    const newAmplify = makeAmplifyState(newCard)
    const amplifyArgs = () => [
      'context', 'battle', 'nextEnemyPlayer', 'addCardToHand', 'Date',
    ] as const
    const amplifyValues = (state: ReturnType<typeof makeAmplifyState>) => [
      state.context, state.battle, (_battle: unknown, playerId: string) => playerId === 'player-red' ? 'player-blue' : 'player-red', state.addCardToHand, date,
    ]
    const oldAmplifyExecute = executeExpression<(context: unknown) => unknown>('(' + amplifierLegacy.code + ')', [...amplifyArgs()], amplifyValues(oldAmplify))
    const newAmplifyExecute = executeExpression<(context: unknown) => unknown>('(' + String(amplify.document.code) + ')', [...amplifyArgs()], amplifyValues(newAmplify))
    const oldAmplifyResult = oldAmplifyExecute(oldAmplify.context)
    const newAmplifyResult = newAmplifyExecute(newAmplify.context)
    expect(newAmplifyResult).toEqual(oldAmplifyResult)
    expect(newAmplify.events).toEqual(oldAmplify.events)
    const amplifierPairs = Object.keys(oldAmplify.battle.customCards).map(copyId => ({
      cardId: copyId,
      legacySource: oldCard.code,
      generatedSource: rafaamChildSource,
    }))
    const canonicalAmplifierCards = canonicalizeGeneratedCards(
      oldAmplify.battle.customCards,
      newAmplify.battle.customCards,
      amplifierPairs,
    )
    expect(canonicalAmplifierCards.generated).toEqual(canonicalAmplifierCards.legacy)
    expect(newAmplify.battle.players).toEqual(oldAmplify.battle.players)

    const copiedId = newAmplify.events.find(event => typeof event.copyId === 'string')?.copyId as string
    const corruptedCopies = cloneJson(newAmplify.battle.customCards)
    corruptedCopies[copiedId].code += '\n// changed during copying'
    expect(() => canonicalizeGeneratedCards(oldAmplify.battle.customCards,corruptedCopies,amplifierPairs)).toThrow('source pair mismatch')
    const oldCopiedBattle = makeCurseHarness()
    const newCopiedBattle = makeCurseHarness()
    oldCopiedBattle.battle.customCards[copiedId] = cloneJson(oldAmplify.battle.customCards[copiedId])
    newCopiedBattle.battle.customCards[copiedId] = cloneJson(newAmplify.battle.customCards[copiedId])
    const oldCopiedUse = useCurseCard(oldCopiedBattle.battle.customCards[copiedId].code, oldCopiedBattle.battle, copiedId)
    const newCopiedUse = useCurseCard(newCopiedBattle.battle.customCards[copiedId].code, newCopiedBattle.battle, copiedId)
    expect(newCopiedUse.result).toEqual(oldCopiedUse.result)
    expect(newCopiedUse.target).toEqual(oldCopiedUse.target)
    expect(newCopiedUse.events).toEqual(oldCopiedUse.events)
  })

  it.each([
    ['attack', 'defense'], ['attack', 'heal'], ['attack', 'speed'],
    ['defense', 'heal'], ['defense', 'speed'], ['heal', 'speed'],
  ])('preserves Tails armor creation and use for %s + %s', (...choice) => {
    const selected = choice as string[]
    const legacy = fixture.entries['skills/tails-armor-assembly']
    const armor = migration('skills/tails-armor-assembly')
    const oldHarness = makeArmorHarness(selected)
    const newHarness = makeArmorHarness(selected)
    const oldExecute = executeExpression<(context: unknown) => unknown>('(' + legacy.code + ')', [
      'selectOption', 'addCardToHand',
    ], [oldHarness.selectOption, oldHarness.addCardToHand])
    const newExecute = executeExpression<(context: unknown) => unknown>('(' + String(armor.document.code) + ')', [
      'selectOption', 'addCardToHand',
    ], [newHarness.selectOption, newHarness.addCardToHand])
    expect(newExecute(newHarness.context)).toEqual(oldExecute(oldHarness.context))
    expect(newHarness.events).toEqual(oldHarness.events)

    const cardId = `armor-${selected.slice().sort().join('-')}`
    const oldCard = oldHarness.battle.customCards[cardId]
    const newCard = newHarness.battle.customCards[cardId]
    expect(oldCard).toBeDefined()
    expect(newCard).toBeDefined()
    const sortedSelected = selected.slice().sort()
    const tailsChildSource = compileBoundCardSource(armor.families[0].graph, sortedSelected)
    expect(newCard.code).toBe(tailsChildSource)
    const tailsPairs: GeneratedSourcePair[] = [{
      cardId,
      legacySource: oldCard.code,
      generatedSource: tailsChildSource,
    }]
    const canonicalTailsCards = canonicalizeGeneratedCards(
      oldHarness.battle.customCards,
      newHarness.battle.customCards,
      tailsPairs,
    )
    expect(canonicalTailsCards.generated).toEqual(canonicalTailsCards.legacy)
    expect(newCard.code).toContain('globalThis.JSON.parse')
    const oldUse = armorCardUse(oldCard.code)
    const newUse = armorCardUse(newCard.code)
    expect(newUse.result).toEqual(oldUse.result)
    expect(newUse.target).toEqual(oldUse.target)
    expect(newUse.events).toEqual(oldUse.events)
  })

  it('passes generated Rafaam and all six Tails families through the real execution hosts', () => {
    const ward = migration('rules/rule-rafaam-curse-ward')
    const legacyRule = fixture.entries['rules/rule-rafaam-curse-ward']
    const generatedRule = { ...cloneJson(legacyRule), skillCode: ward.document.skillCode }
    const oldRuleRun = runHostRafaamRule(legacyRule, 'rule-rafaam-curse-ward')
    const newRuleRun = runHostRafaamRule(generatedRule, 'rule-rafaam-curse-ward')
    const oldRuleCardId = Object.keys(oldRuleRun.battle.customCards ?? {})[0]
    const newRuleCardId = Object.keys(newRuleRun.battle.customCards ?? {})[0]
    expect(newRuleCardId).toBe(oldRuleCardId)
    const rafaamSource = compileContentGraph(ward.families[0].graph).code
    const rafaamPair: GeneratedSourcePair = {
      cardId: oldRuleCardId,
      legacySource: oldRuleRun.battle.customCards[oldRuleCardId].code,
      generatedSource: rafaamSource,
    }
    expect(comparableHostPair(oldRuleRun, newRuleRun, [rafaamPair]).generated)
      .toEqual(comparableHostPair(oldRuleRun, newRuleRun, [rafaamPair]).legacy)

    const oldRuleCardRun = runHostCard(
      oldRuleRun.battle.customCards[oldRuleCardId],
      oldRuleRun.battle,
      'player-blue',
      'rafaam-host-enemy',
      0x252, 'endTurn',
    )
    const newRuleCardRun = runHostCard(
      newRuleRun.battle.customCards[newRuleCardId],
      newRuleRun.battle,
      'player-blue',
      'rafaam-host-enemy',
      0x252, 'endTurn',
    )
    expect(oldRuleCardRun.error).toBeUndefined()
    expect(newRuleCardRun.error).toBeUndefined()
    expect(newRuleCardRun.result).toMatchObject({success:true,keepInHand:true})
    expect(newRuleCardRun.battle.pieces.find((piece:JsonRecord)=>piece.instanceId==='rafaam-host-enemy').currentHp).toBeLessThan(12)
    expect(comparableHostPair(oldRuleCardRun, newRuleCardRun, [rafaamPair]).generated)
      .toEqual(comparableHostPair(oldRuleCardRun, newRuleCardRun, [rafaamPair]).legacy)

    const oldMissingSource = cloneJson(oldRuleRun.battle)
    const newMissingSource = cloneJson(newRuleRun.battle)
    for (const state of [oldMissingSource,newMissingSource]) {
      state.pieces = state.pieces.filter((piece:JsonRecord)=>piece.instanceId !== 'rafaam-host')
      state.graveyard = []
    }
    const oldFallback = runHostCard(oldMissingSource.customCards[oldRuleCardId],oldMissingSource,'player-blue','rafaam-host-enemy',0x252,'endTurn')
    const newFallback = runHostCard(newMissingSource.customCards[newRuleCardId],newMissingSource,'player-blue','rafaam-host-enemy',0x252,'endTurn')
    expect(newFallback.error).toBeUndefined()
    expect(newFallback.result).toMatchObject({success:true,keepInHand:true})
    expect(comparableHostPair(oldFallback,newFallback,[rafaamPair]).generated).toEqual(comparableHostPair(oldFallback,newFallback,[rafaamPair]).legacy)

    const amplify = migration('skills/rafaam-curse-amplify')
    const legacyAmplifier = fixture.entries['skills/rafaam-curse-amplify'] as unknown as SkillDefinition
    const compiledAmplifier = {...cloneJson(legacyAmplifier),code:String(amplify.document.code)} as SkillDefinition
    const oldAmplifyState = cloneJson(oldRuleRun.battle)
    const newAmplifyState = cloneJson(newRuleRun.battle)
    const oldAmplify = runHostSkill(legacyAmplifier,[],0x252,{battle:oldAmplifyState,caster:oldAmplifyState.pieces.find((piece:JsonRecord)=>piece.instanceId==='rafaam-host')})
    const newAmplify = runHostSkill(compiledAmplifier,[],0x252,{battle:newAmplifyState,caster:newAmplifyState.pieces.find((piece:JsonRecord)=>piece.instanceId==='rafaam-host')})
    expect(newAmplify.error).toBeUndefined()
    expect(newAmplify.result).toMatchObject({success:true})
    const copiedIds = Object.keys(newAmplify.battle.customCards).filter(id=>id !== newRuleCardId)
    expect(copiedIds).toHaveLength(1)
    const copyPairs = [oldRuleCardId,...copiedIds].map(cardId=>({...rafaamPair,cardId}))
    expect(comparableHostPair(oldAmplify,newAmplify,copyPairs).generated).toEqual(comparableHostPair(oldAmplify,newAmplify,copyPairs).legacy)
    const copiedId = copiedIds[0]
    const oldCopiedUse = runHostCard(oldAmplify.battle.customCards[copiedId],oldAmplify.battle,'player-blue','rafaam-host-enemy',0x252,'endTurn')
    const newCopiedUse = runHostCard(newAmplify.battle.customCards[copiedId],newAmplify.battle,'player-blue','rafaam-host-enemy',0x252,'endTurn')
    expect(newCopiedUse.error).toBeUndefined()
    expect(newCopiedUse.result).toMatchObject({success:true,keepInHand:true})
    expect(comparableHostPair(oldCopiedUse,newCopiedUse,copyPairs).generated).toEqual(comparableHostPair(oldCopiedUse,newCopiedUse,copyPairs).legacy)

    const armor = migration('skills/tails-armor-assembly')
    const legacySkill = fixture.entries['skills/tails-armor-assembly'] as unknown as SkillDefinition
    const generatedSkill = { ...cloneJson(legacySkill), code: String(armor.document.code) } as SkillDefinition
    const selections = [
      ['attack', 'defense'], ['attack', 'heal'], ['attack', 'speed'],
      ['defense', 'heal'], ['defense', 'speed'], ['heal', 'speed'],
    ]
    for (const selected of selections) {
      const oldSkillRun = runHostSkill(legacySkill, selected)
      const newSkillRun = runHostSkill(generatedSkill, selected)
      const oldCardId = oldSkillRun.battle.players[0].hand.find((card: JsonRecord) => card.cardId?.startsWith('armor-'))?.cardId
      const newCardId = newSkillRun.battle.players[0].hand.find((card: JsonRecord) => card.cardId?.startsWith('armor-'))?.cardId
      expect(newCardId).toBe(oldCardId)
      const tailsSource = compileBoundCardSource(armor.families[0].graph, selected)
      const tailsPair: GeneratedSourcePair = {
        cardId: oldCardId,
        legacySource: oldSkillRun.battle.customCards[oldCardId].code,
        generatedSource: tailsSource,
      }
      const skillComparison = comparableHostPair(oldSkillRun, newSkillRun, [tailsPair])
      expect(skillComparison.generated).toEqual(skillComparison.legacy)

      const oldCardRun = runHostCard(oldSkillRun.battle.customCards[oldCardId], oldSkillRun.battle, 'player-red', 'tails-host-ally')
      const newCardRun = runHostCard(newSkillRun.battle.customCards[newCardId], newSkillRun.battle, 'player-red', 'tails-host-ally')
      const cardComparison = comparableHostPair(oldCardRun, newCardRun, [tailsPair])
      expect(oldCardRun.error).toBeUndefined()
      expect(newCardRun.error).toBeUndefined()
      expect(newCardRun.result).toMatchObject({success:true})
      expect(cardComparison.generated).toEqual(cardComparison.legacy)
    }
  })

  it('rejects unpaired source, binding, payload, and damage changes', () => {
    const ward = migration('rules/rule-rafaam-curse-ward')
    const legacy = fixture.entries['rules/rule-rafaam-curse-ward']
    const oldHarness = makeCurseHarness()
    const newHarness = makeCurseHarness()
    executeBody(legacy.skillCode, [
      'context', 'battle', 'nextEnemyPlayer', 'addStatusEffectById', 'addCardToHand', 'Date',
    ], [oldHarness.context, oldHarness.battle, oldHarness.nextEnemyPlayer, oldHarness.addStatusEffectById, oldHarness.addCardToHand, deterministicDate()])
    executeBody(String(ward.document.skillCode), [
      'context', 'battle', 'nextEnemyPlayer', 'addStatusEffectById', 'addCardToHand', 'Date',
    ], [newHarness.context, newHarness.battle, newHarness.nextEnemyPlayer, newHarness.addStatusEffectById, newHarness.addCardToHand, deterministicDate()])
    const cardId = Object.keys(oldHarness.battle.customCards)[0]
    const oldCards = oldHarness.battle.customCards
    const newCards = newHarness.battle.customCards
    const generatedSource = compileContentGraph(ward.families[0].graph).code
    const pair: GeneratedSourcePair = { cardId, legacySource: oldCards[cardId].code, generatedSource }

    const tamperedSource = cloneJson(newCards)
    tamperedSource[cardId].code += '\n// payload changed'
    expect(() => canonicalizeGeneratedCards(oldCards, tamperedSource, [pair])).toThrow('source pair mismatch')

    const tamperedBinding = cloneJson(newCards)
    tamperedBinding[cardId].code = compileContentGraph(ward.families[0].graph).code.replace('curse-end-turn', 'different-payload')
    expect(() => canonicalizeGeneratedCards(oldCards, tamperedBinding, [pair])).toThrow('source pair mismatch')

    const armor = migration('skills/tails-armor-assembly')
    const armorOld = makeArmorHarness(['attack', 'defense'])
    const armorNew = makeArmorHarness(['attack', 'defense'])
    const armorLegacyExecute = executeExpression<(context: unknown) => unknown>('(' + String(fixture.entries['skills/tails-armor-assembly'].code) + ')', [
      'selectOption', 'addCardToHand',
    ], [armorOld.selectOption, armorOld.addCardToHand])
    const armorGeneratedExecute = executeExpression<(context: unknown) => unknown>('(' + String(armor.document.code) + ')', [
      'selectOption', 'addCardToHand',
    ], [armorNew.selectOption, armorNew.addCardToHand])
    armorLegacyExecute(armorOld.context)
    armorGeneratedExecute(armorNew.context)
    const armorCardId = 'armor-attack-defense'
    const wrongBindingPair: GeneratedSourcePair = {
      cardId: armorCardId,
      legacySource: armorOld.battle.customCards[armorCardId].code,
      generatedSource: compileBoundCardSource(armor.families[0].graph, ['attack', 'speed']),
    }
    expect(() => canonicalizeGeneratedCards(
      armorOld.battle.customCards,
      armorNew.battle.customCards,
      [wrongBindingPair],
    )).toThrow('source pair mismatch')

    const changedDamageBattle = makeCurseHarness()
    changedDamageBattle.battle.customCards[cardId] = cloneJson(newCards[cardId])
    changedDamageBattle.battle.customCards[cardId].damageAmount += 1
    const changedDamage = useCurseCard(changedDamageBattle.battle.customCards[cardId].code, changedDamageBattle.battle, cardId)
    const unchangedDamageBattle = makeCurseHarness()
    unchangedDamageBattle.battle.customCards[cardId] = cloneJson(newCards[cardId])
    const unchangedDamage = useCurseCard(newCards[cardId].code, unchangedDamageBattle.battle, cardId)
    expect(changedDamage.target.currentHp).not.toBe(unchangedDamage.target.currentHp)

    const approved = ward.document
    const userEdited = cloneJson(approved)
    userEdited.skillCode = "return { success: false, message: 'user change' }"
    expect(() => buildGeneratedContentMigration('rules/rule-rafaam-curse-ward', {
      legacy,
      current: userEdited,
      root: process.cwd(),
    })).toThrow('recognized frozen')
  })
})
