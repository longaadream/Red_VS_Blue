/* eslint-disable @typescript-eslint/no-explicit-any -- the host parity fixture models legacy JSON content. */
import {
  copyFileSync,
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
  buildGeneratedCardDefinitions,
  buildRafaamCurseAmplifyGraph,
  buildSonicFreeMoveRuleGraph,
  buildTailsArmorAssemblyGraph,
  buildTailsArmorCardGraph,
  buildTailsArmorRecoveryRuleGraph,
  buildTailsMechanicalSupportGraph,
  GENERATED_ARMOR_CARD_IDS,
  GENERATED_CONTENT_GAMEPLAY_REGISTRY,
  preflightGeneratedContent,
} from '@/scripts/migrate-semantic-generated-content'
import { CONTENT_GENERATION_GAMEPLAY_MODULES } from '@/lib/skill-graph/module-registry-content-generation'
import { compileGameplayModuleGraph } from '@/lib/skill-graph/module-compiler'
import { executeCardFunction, executeSkillFunction, type CardDefinition, type SkillDefinition } from '@/lib/game/skills'
import { clearRuleCache, loadRuleById } from '@/lib/game/skills'
import { RuleRuntime, createRuleExecutionContext, withRuleExecutionContext, withRuleRuntime } from '@/lib/game/rule-runtime'
import { recordBattlePresentation, recordedBattlePresentation } from '@/lib/game/battle-presentation-recording'
import { TriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '@/tests/helpers/minimal-state'

type JsonRecord = Record<string, any>

const DYNAMIC_CURSE_CODE = 'function executeCard(context) { if (context.type !== "endTurn") return { success: true, message: "弃置了诅咒" }; if (battle.turn.currentPlayerId !== playerId) return { success: false }; var allies = battle.pieces.filter(function(piece) { return piece.ownerPlayerId === playerId && piece.currentHp > 0; }); if (!allies.length) return { success: true, message: "诅咒结算时没有存活的友军目标" }; var target = allies[Math.floor(Math.random() * allies.length)]; var cardData = battle.customCards && battle.customCards[context.card.id]; var damage = cardData && cardData.damageAmount !== undefined ? cardData.damageAmount : 0; var source = battle.pieces.concat(battle.graveyard || []).find(function(piece) { return piece.instanceId === cardData.sourcePieceId; }) || target; var result = dealDamage(source, target, damage, "true", battle, "curse-end-turn", true); return { success: true, keepInHand: true, message: "诅咒对" + target.name + "造成了" + result.damage + "点伤害" }; }'

const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')) as { entries: Record<string, JsonRecord> }

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalize(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\d{10,}/g, '<clock>')
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]))
  return value
}

function graphStatements(graph: any): any[] {
  const output: any[] = []
  const visit = (statements: any[]) => {
    for (const statement of statements ?? []) {
      output.push(statement)
      if (statement.kind === 'if') {
        visit(statement.then)
        visit(statement.else)
      } else if (statement.kind === 'foreach' || statement.kind === 'collection') visit(statement.body)
    }
  }
  visit(graph.body)
  for (const composite of graph.composites ?? []) visit(composite.body)
  return output
}

function temporaryMigrationRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rvb-red252-semantic-content-'))
  mkdirSync(join(root, 'data', 'skills'), { recursive: true })
  mkdirSync(join(root, 'data', 'rules'), { recursive: true })
  mkdirSync(join(root, 'data', 'cards'), { recursive: true })
  mkdirSync(join(root, 'tests', 'game', 'fixtures'), { recursive: true })
  copyFileSync('tests/game/fixtures/RED-252-legacy-content.json', join(root, 'tests', 'game', 'fixtures', 'RED-252-legacy-content.json'))
  for (const id of ['tails-armor-assembly', 'tails-mechanical-support', 'rafaam-curse-amplify']) {
    const current = {
      ...clone(fixture.entries[`skills/${id}`]),
      cluster: { version: 'rvb-skill-cluster/v1', id: `skills:${id}`, links: [] },
      unknownAuthorMetadata: { retained: true, id },
    }
    writeFileSync(join(root, 'data', 'skills', `${id}.json`), JSON.stringify(current, null, 2) + '\n')
  }
  for (const id of ['rule-sonic-free-move', 'rule-tails-armor-recovery']) {
    const current = {
      ...clone(fixture.entries[`rules/${id}`]),
      unknownAuthorMetadata: { retained: true, id },
    }
    writeFileSync(join(root, 'data', 'rules', `${id}.json`), JSON.stringify(current, null, 2) + '\n')
  }
  return root
}

function hostState(id = 'host-tails') {
  const owner = id.includes('blue') ? 'player-blue' : 'player-red'
  const enemyOwner = owner === 'player-red' ? 'player-blue' : 'player-red'
  const caster = makePiece({ instanceId: id, ownerPlayerId: owner, faction: owner === 'player-red' ? 'red' : 'blue', x: 2, y: 2, currentHp: 12, maxHp: 12, attack: 6 }) as any
  caster.name = id
  const ally = makePiece({ instanceId: `${id}-ally`, ownerPlayerId: owner, faction: owner === 'player-red' ? 'red' : 'blue', x: 2, y: 3, currentHp: 8, maxHp: 12, attack: 3 }) as any
  ally.name = `${id}-ally`
  const enemy = makePiece({ instanceId: `${id}-enemy`, ownerPlayerId: enemyOwner, faction: enemyOwner === 'player-red' ? 'red' : 'blue', x: 4, y: 2, currentHp: 12, maxHp: 12, attack: 3 }) as any
  enemy.name = `${id}-enemy`
  const battle = makeState({ pieces: [caster, ally, enemy], currentPlayerId: owner, turnNumber: 3, width: 7, height: 7 }) as any
  battle.customCards = {}
  battle.players.find((player: any) => player.playerId === owner).actionPoints = 10
  return { battle, caster, ally, enemy, owner, enemyOwner }
}

type HostRun = { result?: unknown; error?: unknown; battle: JsonRecord; random: unknown; presentation: unknown }

function runSkill(definition: SkillDefinition, selectedOption: unknown, target?: any, seed = 0x252, setup?: (state: ReturnType<typeof hostState>) => void): HostRun {
  const state = hostState(definition.id === 'rafaam-curse-amplify' ? 'host-rafaam' : 'host-tails')
  setup?.(state)
  const selectedTarget = target ?? (definition.id === 'tails-mechanical-support' ? state.ally : null)
  const context: any = {
    piece: state.caster,
    target: selectedTarget,
    targetPosition: null,
    targets: selectedTarget ? [{ info: selectedTarget, pos: null }] : [],
    battle: state.battle,
    skill: definition,
    selectedOption,
  }
  const runtime = new RuleRuntime({ rootSeed: seed })
  const triggerSystem = new TriggerSystem()
  let result: unknown
  let error: unknown
  try {
    withRuleExecutionContext(createRuleExecutionContext(triggerSystem), () => withRuleRuntime(runtime, () => {
      result = recordBattlePresentation(state.battle, () => executeSkillFunction(definition, context, state.battle), () => state.battle)
    }))
  } catch (cause) {
    error = cause instanceof Error ? { name: cause.name, message: cause.message } : cause
  }
  return { result, error, battle: state.battle, random: runtime.snapshot(), presentation: recordedBattlePresentation(state.battle) }
}

function runCard(card: CardDefinition, state: ReturnType<typeof hostState>, target: any, seed = 0x252, trigger?: { playerId: string; type: 'endTurn' }): HostRun {
  const playerId = trigger?.playerId ?? state.owner
  const player = state.battle.players.find((item: any) => item.playerId === playerId)
  const cardInstance = player.hand.find((item: any) => item.cardId === card.id) ?? { cardId: card.id, instanceId: `${card.id}-instance`, name: card.name }
  if (!player.hand.includes(cardInstance)) player.hand.push(cardInstance)
  if (trigger) state.battle.turn.currentPlayerId = trigger.playerId
  const runtime = new RuleRuntime({ rootSeed: seed })
  const triggerSystem = new TriggerSystem()
  let result: unknown
  let error: unknown
  try {
    withRuleExecutionContext(createRuleExecutionContext(triggerSystem), () => withRuleRuntime(runtime, () => {
      result = recordBattlePresentation(state.battle, () => executeCardFunction(card, playerId, state.battle, trigger ? { type: trigger.type, playerId: trigger.playerId } : undefined, target, undefined, undefined, [], cardInstance), () => state.battle)
    }))
  } catch (cause) {
    error = cause instanceof Error ? { name: cause.name, message: cause.message } : cause
  }
  return { result, error, battle: state.battle, random: runtime.snapshot(), presentation: recordedBattlePresentation(state.battle) }
}

function runRule(definition: JsonRecord, id: string, type: 'beginTurn' | 'endTurn', seed = 0x252, setup?: (state: ReturnType<typeof hostState>) => void): HostRun {
  const root = mkdtempSync(join(tmpdir(), 'rvb-red252-generated-rule-'))
  mkdirSync(join(root, 'data', 'rules'), { recursive: true })
  writeFileSync(join(root, 'data', 'rules', `${id}.json`), JSON.stringify({ ...clone(definition), id }))
  const previousRoot = process.env.RVB_PROFILE_ROOT
  process.env.RVB_PROFILE_ROOT = root
  clearRuleCache()
  const state = hostState('host-rule')
  setup?.(state)
  const runtime = new RuleRuntime({ rootSeed: seed })
  const triggerSystem = new TriggerSystem()
  const context: any = {
    type,
    rulePiece: state.caster,
    piece: state.caster,
    playerId: state.owner,
    triggerPlayerId: state.owner,
    battle: state.battle,
  }
  let result: unknown
  let error: unknown
  try {
    const rule = loadRuleById(id, true, true)
    if (!rule) throw new Error(`missing generated rule ${id}`)
    result = recordBattlePresentation(state.battle, () => withRuleExecutionContext(createRuleExecutionContext(triggerSystem), () => withRuleRuntime(runtime, () => rule.effect(state.battle, context))), () => state.battle)
  } catch (cause) {
    error = cause instanceof Error ? { name: cause.name, message: cause.message } : cause
  } finally {
    clearRuleCache()
    if (previousRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
  return { result, error, battle: state.battle, random: runtime.snapshot(), presentation: recordedBattlePresentation(state.battle) }
}

describe('RED-252 generated-content semantic modules', () => {
  it('registers reusable content primitives and compiles real semantic graphs', () => {
    const ids = CONTENT_GENERATION_GAMEPLAY_MODULES.map(module => module.id)
    expect(ids).toEqual(expect.arrayContaining([
      'choice.multi-string', 'list.all-in', 'content.enemy-player', 'content.filter-hand', 'content.copy-card',
      'content.materialize-template', 'card.hand-add-ref', 'attribute.set-current-hp', 'piece.momentum', 'status.count-all', 'status.append-record', 'status.remove-choice', 'status.refresh-temporary',
    ]))
    expect(ids.some(id => id.includes('tails') || id.includes('rafaam'))).toBe(false)
    const graphs = [buildTailsArmorAssemblyGraph(), buildTailsMechanicalSupportGraph(), buildRafaamCurseAmplifyGraph(), buildSonicFreeMoveRuleGraph(), buildTailsArmorRecoveryRuleGraph(), ...GENERATED_ARMOR_CARD_IDS.map(id => buildTailsArmorCardGraph(id.slice('armor-'.length).split('-')))]
    for (const graph of graphs) {
      const compiled = compileGameplayModuleGraph(graph, GENERATED_CONTENT_GAMEPLAY_REGISTRY)
      expect(compiled.code.length).toBeGreaterThan(0)
      expect(JSON.stringify(graph)).not.toContain('function execute')
      for (const statement of graphStatements(graph)) {
        expect(statement).not.toHaveProperty('source')
        if (statement.kind === 'call') expect(statement.module).not.toMatch(/^(tails|rafaam|armor)\./)
      }
    }
  })

  it('preflights all writes, preserves Cluster and unknown metadata, and keeps authored graphs on rerun', () => {
    const root = temporaryMigrationRoot()
    try {
      const first = preflightGeneratedContent(root)
      expect(first.skills.map(item => item.id)).toEqual([
        'skills/tails-armor-assembly', 'skills/tails-mechanical-support', 'skills/rafaam-curse-amplify',
      ])
      expect(first.skills.every(item => item.changed)).toBe(true)
      expect(first.rules.map(item => item.id)).toEqual([
        'rules/rule-sonic-free-move', 'rules/rule-tails-armor-recovery',
      ])
      expect(first.rules.every(item => item.changed)).toBe(true)
      expect(first.cards).toHaveLength(6)
      expect(first.skills[0].document.cluster).toMatchObject({ version: 'rvb-skill-cluster/v1' })
      expect(first.skills[0].document.unknownAuthorMetadata).toEqual({ retained: true, id: 'tails-armor-assembly' })
      expect(first.skills[2].document.previewCode).toContain('function calculatePreview')
      expect(first.skills[2].document.gameplayModules.entries.previewCode).toBeDefined()

      for (const item of first.skills) writeFileSync(join(root, item.file), JSON.stringify(item.document, null, 2) + '\n')
      for (const item of first.rules) writeFileSync(join(root, item.file), JSON.stringify(item.document, null, 2) + '\n')
      for (const item of first.cards) writeFileSync(join(root, item.file), JSON.stringify(item.document, null, 2) + '\n')
      const authoredCardPath = join(root, 'data', 'cards', 'armor-attack-defense.json')
      const authoredCard = JSON.parse(readFileSync(authoredCardPath, 'utf8')) as JsonRecord
      authoredCard.unknownAuthorMetadata = { retained: true }
      writeFileSync(authoredCardPath, JSON.stringify(authoredCard, null, 2) + '\n')
      const second = preflightGeneratedContent(root)
      expect(second.skills.every(item => !item.changed)).toBe(true)
      expect(second.rules.every(item => !item.changed)).toBe(true)
      expect(second.skills[2].document.cluster).toMatchObject({ id: 'skills:rafaam-curse-amplify' })
      expect(second.skills[2].document.unknownAuthorMetadata).toEqual({ retained: true, id: 'rafaam-curse-amplify' })
      expect(second.cards.find(item => item.file.endsWith('armor-attack-defense.json'))?.document.unknownAuthorMetadata).toEqual({ retained: true })

      const rafaamPath = join(root, 'data', 'skills', 'rafaam-curse-amplify.json')
      const authored = JSON.parse(readFileSync(rafaamPath, 'utf8')) as JsonRecord
      const authoredModules = authored.gameplayModules as JsonRecord
      const authoredEntries = authoredModules.entries as Record<string, JsonRecord>
      const authoredPreview = clone(authoredEntries.previewCode.graph)
      const authoredDescription = (authoredPreview.body as any[]).find(statement => statement.kind === 'record.create' && statement.id === 'preview-result-1')
      authoredDescription.fields.description.value = '自定义预览描述'
      authored.previewCode = compileGameplayModuleGraph(authoredPreview, GENERATED_CONTENT_GAMEPLAY_REGISTRY).code
      authoredEntries.previewCode = { graph: authoredPreview, compilerVersion: authoredEntries.previewCode.compilerVersion }
      writeFileSync(rafaamPath, JSON.stringify(authored, null, 2) + '\n')
      const third = preflightGeneratedContent(root)
      expect(third.skills[2].changed).toBe(false)
      expect((third.skills[2].document.gameplayModules.entries.previewCode.graph as any).body[1].fields.description.value).toBe('自定义预览描述')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps seeded host execution parity for armor, mechanical support, and Rafaam copies', () => {
    const armorGraph = buildTailsArmorAssemblyGraph()
    const armorCode = compileGameplayModuleGraph(armorGraph, GENERATED_CONTENT_GAMEPLAY_REGISTRY).code
    const armorLegacy = fixture.entries['skills/tails-armor-assembly'] as SkillDefinition
    const armorGenerated = { ...clone(armorLegacy), code: armorCode } as SkillDefinition
    const armorOld = runSkill(armorLegacy, ['attack', 'defense'])
    const armorNew = runSkill(armorGenerated, ['attack', 'defense'], undefined, 0x252, state => {
      state.battle.customCards = Object.fromEntries(buildGeneratedCardDefinitions().map(card => [card.id, clone(card)]))
    })
    expect(armorNew.error).toBeUndefined()
    expect(armorNew.result).toEqual(armorOld.result)
    expect(normalize({ hand: armorNew.battle.players[0].hand, actions: armorNew.battle.actions, presentation: armorNew.presentation, random: armorNew.random }))
      .toEqual(normalize({ hand: armorOld.battle.players[0].hand, actions: armorOld.battle.actions, presentation: armorOld.presentation, random: armorOld.random }))

    const armorId = 'armor-attack-defense'
    const cardDefinition = buildGeneratedCardDefinitions().find(item => item.id === armorId) as unknown as CardDefinition
    const oldCard = armorOld.battle.customCards?.[armorId] as CardDefinition
    expect(oldCard).toBeDefined()
    const oldCardState = hostState('host-tails')
    oldCardState.battle.customCards = { [armorId]: clone(oldCard) }
    const newCardState = hostState('host-tails')
    newCardState.battle.customCards = { [armorId]: clone(cardDefinition) }
    const oldCardRun = runCard(oldCard, oldCardState, oldCardState.ally)
    const newCardRun = runCard(cardDefinition, newCardState, newCardState.ally)
    expect(newCardRun.error).toBeUndefined()
    expect(normalize({ result: newCardRun.result, target: newCardState.ally, actions: newCardRun.battle.actions, presentation: newCardRun.presentation, random: newCardRun.random }))
      .toEqual(normalize({ result: oldCardRun.result, target: oldCardState.ally, actions: oldCardRun.battle.actions, presentation: oldCardRun.presentation, random: oldCardRun.random }))

    const supportLegacy = fixture.entries['skills/tails-mechanical-support'] as SkillDefinition
    const supportGraph = buildTailsMechanicalSupportGraph()
    const supportGenerated = { ...clone(supportLegacy), code: compileGameplayModuleGraph(supportGraph, GENERATED_CONTENT_GAMEPLAY_REGISTRY).code } as SkillDefinition
    const supportOld = runSkill(supportLegacy, 'none', undefined, 0x252, state => { state.caster.momentum = 8 })
    const supportNew = runSkill(supportGenerated, 'none', undefined, 0x252, state => { state.caster.momentum = 8 })
    expect(supportNew.error).toBeUndefined()
    expect(supportNew.result).toEqual(supportOld.result)
    expect(normalize({ ally: supportNew.battle.pieces[1], actions: supportNew.battle.actions, presentation: supportNew.presentation, random: supportNew.random }))
      .toEqual(normalize({ ally: supportOld.battle.pieces[1], actions: supportOld.battle.actions, presentation: supportOld.presentation, random: supportOld.random }))

    const supportWithStatusSetup = (state: ReturnType<typeof hostState>) => {
      state.caster.momentum = 8
      state.ally.statusTags = [{ id: 'support-removable', type: 'test-status', name: '测试效果', stacks: 1 }] as any
    }
    const supportWithStatusOld = runSkill(supportLegacy, '0', undefined, 0x252, supportWithStatusSetup)
    const supportWithStatusNew = runSkill(supportGenerated, '0', undefined, 0x252, supportWithStatusSetup)
    expect(supportWithStatusNew.error).toBeUndefined()
    expect(normalize({ ally: supportWithStatusNew.battle.pieces[1], actions: supportWithStatusNew.battle.actions, presentation: supportWithStatusNew.presentation, random: supportWithStatusNew.random }))
      .toEqual(normalize({ ally: supportWithStatusOld.battle.pieces[1], actions: supportWithStatusOld.battle.actions, presentation: supportWithStatusOld.presentation, random: supportWithStatusOld.random }))

    const amplifyLegacy = fixture.entries['skills/rafaam-curse-amplify'] as SkillDefinition
    const amplifyGenerated = { ...clone(amplifyLegacy), code: compileGameplayModuleGraph(buildRafaamCurseAmplifyGraph(), GENERATED_CONTENT_GAMEPLAY_REGISTRY).code } as SkillDefinition
    const setupCurse = (state: ReturnType<typeof hostState>) => {
      const curse = {
        id: 'rafaam-curse-dynamic', cardId: 'rafaam-curse-dynamic', name: '诅咒(5)', type: 'reactive', trigger: { type: 'endTurn' },
        damageAmount: 5, sourcePieceId: state.caster.instanceId, code: DYNAMIC_CURSE_CODE, unknownField: { kept: true },
      }
      state.battle.customCards[curse.id] = curse
      const opponent = state.battle.players.find((player: any) => player.playerId === state.enemyOwner)
      opponent.hand = [{ cardId: curse.id, instanceId: 'curse-instance', name: curse.name }]
    }
    const amplifyOld = runSkill(amplifyLegacy, undefined, undefined, 0x252, setupCurse)
    const amplifyNew = runSkill(amplifyGenerated, undefined, undefined, 0x252, setupCurse)
    expect(amplifyNew.error).toBeUndefined()
    expect(amplifyNew.result).toEqual(amplifyOld.result)
    expect(normalize({ hand: amplifyNew.battle.players[1].hand, customCards: amplifyNew.battle.customCards, actions: amplifyNew.battle.actions, presentation: amplifyNew.presentation, random: amplifyNew.random }))
      .toEqual(normalize({ hand: amplifyOld.battle.players[1].hand, customCards: amplifyOld.battle.customCards, actions: amplifyOld.battle.actions, presentation: amplifyOld.presentation, random: amplifyOld.random }))

    const oldCopyId = amplifyOld.battle.players[1].hand.find((card: any) => card.cardId !== 'rafaam-curse-dynamic')?.cardId
    const newCopyId = amplifyNew.battle.players[1].hand.find((card: any) => card.cardId !== 'rafaam-curse-dynamic')?.cardId
    expect(oldCopyId).toBeDefined()
    expect(newCopyId).toBeDefined()
    const oldTriggerState = hostState('host-rafaam')
    oldTriggerState.battle = clone(amplifyOld.battle)
    oldTriggerState.caster = oldTriggerState.battle.pieces.find((piece: any) => piece.instanceId === 'host-rafaam')
    oldTriggerState.ally = oldTriggerState.battle.pieces.find((piece: any) => piece.instanceId === 'host-rafaam-ally')
    oldTriggerState.enemy = oldTriggerState.battle.pieces.find((piece: any) => piece.instanceId === 'host-rafaam-enemy')
    const newTriggerState = hostState('host-rafaam')
    newTriggerState.battle = clone(amplifyNew.battle)
    newTriggerState.caster = newTriggerState.battle.pieces.find((piece: any) => piece.instanceId === 'host-rafaam')
    newTriggerState.ally = newTriggerState.battle.pieces.find((piece: any) => piece.instanceId === 'host-rafaam-ally')
    newTriggerState.enemy = newTriggerState.battle.pieces.find((piece: any) => piece.instanceId === 'host-rafaam-enemy')
    const oldTrigger = runCard(oldTriggerState.battle.customCards[oldCopyId], oldTriggerState, oldTriggerState.enemy, 0x252, { playerId: oldTriggerState.enemyOwner, type: 'endTurn' })
    const newTrigger = runCard(newTriggerState.battle.customCards[newCopyId], newTriggerState, newTriggerState.enemy, 0x252, { playerId: newTriggerState.enemyOwner, type: 'endTurn' })
    expect(newTrigger.error).toBeUndefined()
    expect(normalize({ result: newTrigger.result, pieces: newTrigger.battle.pieces, actions: newTrigger.battle.actions, presentation: newTrigger.presentation, random: newTrigger.random }))
      .toEqual(normalize({ result: oldTrigger.result, pieces: oldTrigger.battle.pieces, actions: oldTrigger.battle.actions, presentation: oldTrigger.presentation, random: oldTrigger.random }))
  })

  it('keeps seeded rule execution parity including presentation logs', () => {
    const sonicLegacy = fixture.entries['rules/rule-sonic-free-move']
    const sonicGenerated = { ...clone(sonicLegacy), skillCode: compileGameplayModuleGraph(buildSonicFreeMoveRuleGraph(), GENERATED_CONTENT_GAMEPLAY_REGISTRY).code }
    const sonicOld = runRule(sonicLegacy, 'rule-sonic-free-move', 'beginTurn')
    const sonicNew = runRule(sonicGenerated, 'rule-sonic-free-move', 'beginTurn')
    expect(sonicNew.error).toBeUndefined()
    expect(normalize({ result: sonicNew.result, caster: sonicNew.battle.pieces[0], actions: sonicNew.battle.actions, presentation: sonicNew.presentation, random: sonicNew.random }))
      .toEqual(normalize({ result: sonicOld.result, caster: sonicOld.battle.pieces[0], actions: sonicOld.battle.actions, presentation: sonicOld.presentation, random: sonicOld.random }))

    const recoveryLegacy = fixture.entries['rules/rule-tails-armor-recovery']
    const recoveryGenerated = { ...clone(recoveryLegacy), skillCode: compileGameplayModuleGraph(buildTailsArmorRecoveryRuleGraph(), GENERATED_CONTENT_GAMEPLAY_REGISTRY).code }
    const recoverySetup = (state: ReturnType<typeof hostState>) => {
      state.caster.currentHp = 3
      state.caster.statusTags = [
        { id: 'periodic-heal-1', type: 'periodic-heal', name: '恢复模块', stacks: 1 },
        { id: 'periodic-heal-2', type: 'periodic-heal', name: '恢复模块', stacks: 1 },
      ] as any
    }
    const recoveryOld = runRule(recoveryLegacy, 'rule-tails-armor-recovery', 'endTurn', 0x252, recoverySetup)
    const recoveryNew = runRule(recoveryGenerated, 'rule-tails-armor-recovery', 'endTurn', 0x252, recoverySetup)
    expect(recoveryNew.error).toBeUndefined()
    expect(normalize({ result: recoveryNew.result, caster: recoveryNew.battle.pieces[0], actions: recoveryNew.battle.actions, presentation: recoveryNew.presentation, random: recoveryNew.random }))
      .toEqual(normalize({ result: recoveryOld.result, caster: recoveryOld.battle.pieces[0], actions: recoveryOld.battle.actions, presentation: recoveryOld.presentation, random: recoveryOld.random }))
  })
})

