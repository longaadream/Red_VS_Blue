/* eslint-disable @typescript-eslint/no-explicit-any -- real host differential fixtures. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, compileGameplayModuleGraph, GAMEPLAY_MODULE_REGISTRY } from '@/lib/skill-graph/module-document'
import { executeSkillFunction } from '@/lib/game/skills'
import { recordBattlePresentation, recordedBattlePresentation } from '@/lib/game/battle-presentation-recording'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { buildVelenSkillGraph, VELEN_SKILL_IDS } from '@/scripts/migrate-semantic-velen-skills'
import { makePiece as makeRawPiece, makeState } from '../helpers/minimal-state'

const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries as Record<string, any>
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

function makePiece(overrides: Record<string, any> = {}): any {
  const piece = makeRawPiece(overrides) as any
  if (typeof overrides.name === 'string') piece.name = overrides.name
  if (overrides.defense !== undefined) piece.defense = overrides.defense
  return piece
}

function card(instanceId: string, cardId: string, overrides: Record<string, any> = {}): any {
  return { instanceId, cardId, ...overrides }
}

function comparableState(battle: any): any {
  const state = clone(battle)
  delete state.skillsById
  return state
}

function runSkill(id: typeof VELEN_SKILL_IDS[number], semantic: boolean, setup: () => { battle: any; context: any }): any {
  const runtime = new RuleRuntime({ rootSeed: 594 })
  return withRuleRuntime(runtime, () => {
    const definition = semantic ? applyGameplayModuleGraph(fixture['skills/' + id], buildVelenSkillGraph(id)) : fixture['skills/' + id]
    const { battle, context } = setup()
    battle.skillsById[id] = definition
    const result = recordBattlePresentation(battle, () => executeSkillFunction(definition, context, battle), () => battle)
    return { result: clone(result), state: comparableState(battle), presentation: recordedBattlePresentation(battle), runtime: runtime.snapshot() }
  })
}

function contextFor(source: any, battle: any, options: { target?: any; selectedOption?: any; setOption?: boolean } = {}): any {
  const context: any = {
    piece: source,
    battle,
    skill: null,
    target: options.target ?? null,
    targetPosition: null,
    targets: options.target ? [{ info: options.target, pos: null }] : [],
  }
  if (options.setOption) context.selectedOption = options.selectedOption
  return context
}

function setupWithHand(cards: any[], options: { target?: any; selectedOption?: any; setOption?: boolean } = {}) {
  const source = makePiece({ instanceId: 'velen', templateId: 'velen', ownerPlayerId: 'player-red', name: '维伦', x: 1, y: 1, currentHp: 20, maxHp: 20 })
  const target = options.target
  const battle: any = makeState({ pieces: [source, ...(target ? [target] : [])], turnNumber: 4 })
  battle.players[0].hand = cards
  return { battle, context: contextFor(source, battle, options) }
}

describe('semantic Velen skill migrations', () => {
  it('registers all three skills as typed gameplay documents', () => {
    for (const id of VELEN_SKILL_IDS) {
      const graph = buildVelenSkillGraph(id)
      const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
      expect(compiled.code).toContain('function executeSkill')
      const document = applyGameplayModuleGraph(fixture['skills/' + id], graph)
      assertGameplayModuleDocument(document)
      expect(document.contentGraph).toBeUndefined()
      expect((document.gameplayModules as any).entries.code.graph).toEqual(graph)
    }
  })

  it('preserves Fate Shelter target selection, duplicate and invalid target branches', () => {
    const target = makePiece({ instanceId: 'ally', templateId: 'ally', ownerPlayerId: 'player-red', name: '友军', currentHp: 10, maxHp: 20 })
    const success = runSkill('velen-fate-shelter', false, () => setupWithHand([], { target }))
    const semantic = runSkill('velen-fate-shelter', true, () => setupWithHand([], { target: makePiece({ instanceId: 'ally', templateId: 'ally', ownerPlayerId: 'player-red', name: '友军', currentHp: 10, maxHp: 20 }) }))
    expect(semantic).toEqual(success)
    expect(semantic.result).toEqual({ success: true, message: '维伦为友军预见了命运庇护' })
    expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'ally').statusTags).toEqual([expect.objectContaining({
      id: 'velen-fate-shelter-velen-ally', type: 'velen-fate-shelter', intensity: 8, sourceId: 'velen', createdTurnNumber: 4,
    })])

    const duplicateSetup = () => setupWithHand([], {
      target: makePiece({ instanceId: 'ally', templateId: 'ally', ownerPlayerId: 'player-red', name: '友军', currentHp: 10, statusTags: [{ id: 'existing', type: 'velen-fate-shelter' }] }),
    })
    const duplicate = runSkill('velen-fate-shelter', true, duplicateSetup)
    expect(duplicate).toEqual(runSkill('velen-fate-shelter', false, duplicateSetup))
    expect(duplicate.result).toEqual({ success: false, message: '目标已经获得命运庇护' })

    const deadSetup = () => setupWithHand([], { target: makePiece({ instanceId: 'dead', ownerPlayerId: 'player-red', currentHp: 0 }) })
    const dead = runSkill('velen-fate-shelter', true, deadSetup)
    expect(dead).toEqual(runSkill('velen-fate-shelter', false, deadSetup))
    expect(dead.result).toEqual({ success: false, message: '命运庇护只能选择存活友方' })
  })

  it('preserves Fate Shelter pending target presentation and rejected enemy target', () => {
    const pendingSetup = () => setupWithHand([])
    const pending = runSkill('velen-fate-shelter', true, pendingSetup)
    expect(pending).toEqual(runSkill('velen-fate-shelter', false, pendingSetup))
    expect(pending.result).toMatchObject({ success: false, needsTargetSelection: true, targetType: 'piece', filter: 'ally', range: 99 })

    const enemySetup = () => setupWithHand([], { target: makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', currentHp: 10 }) })
    const enemy = runSkill('velen-fate-shelter', true, enemySetup)
    expect(enemy).toEqual(runSkill('velen-fate-shelter', false, enemySetup))
    expect(enemy.result).toMatchObject({ success: false, needsTargetSelection: true, filter: 'ally' })
  })

  it('preserves Holy Prophecy card filtering, labels, pending and invalid references', () => {
    const cards = [
      card('smite', 'holy-smite'),
      card('already-predicted', 'holy-heal', { contentState: { velenHolyProphecy: { sourcePieceId: 'other', createdTurnNumber: 1 } } }),
      card('already-enhanced', 'holy-charge', { contentState: { velenHolyProphecyEnhanced: true } }),
      card('other', 'fireball'),
    ]
    const selectedSetup = () => setupWithHand(clone(cards), { selectedOption: 'smite', setOption: true })
    const expected = runSkill('velen-holy-prophecy', false, selectedSetup)
    const actual = runSkill('velen-holy-prophecy', true, selectedSetup)
    expect(actual).toEqual(expected)
    expect(actual.result).toEqual({ success: true, message: '维伦留下了圣光预言' })
    expect(actual.state.players[0].hand[0].contentState).toEqual({ velenHolyProphecy: { sourcePieceId: 'velen', createdTurnNumber: 4 } })

    const pendingSetup = () => setupWithHand(clone(cards))
    const pending = runSkill('velen-holy-prophecy', true, pendingSetup)
    expect(pending).toEqual(runSkill('velen-holy-prophecy', false, pendingSetup))
    expect(pending.result).toMatchObject({ success: false, needsOptionSelection: true, presentation: 'hand', selectionMode: 'single', minSelections: 1, maxSelections: 1 })
    expect(pending.result.options).toEqual([{ label: '圣光惩击', value: 'smite' }])

    const noCardsSetup = () => setupWithHand([card('enhanced', 'holy-smite', { contentState: { velenHolyProphecyEnhanced: true } })])
    const noCards = runSkill('velen-holy-prophecy', true, noCardsSetup)
    expect(noCards).toEqual(runSkill('velen-holy-prophecy', false, noCardsSetup))
    expect(noCards.result).toEqual({ success: false, message: '没有可预言的圣光手牌' })

    const staleSetup = () => setupWithHand(clone(cards), { selectedOption: 'missing-card', setOption: true })
    const stale = runSkill('velen-holy-prophecy', true, staleSetup)
    expect(stale).toEqual(runSkill('velen-holy-prophecy', false, staleSetup))
    expect(stale.result).toEqual({ success: false, message: '选择的手牌已无法被预言' })

    const wrappedSetup = () => setupWithHand(clone(cards), { selectedOption: { value: 'smite' }, setOption: true })
    const wrapped = runSkill('velen-holy-prophecy', true, wrappedSetup)
    expect(wrapped).toEqual(runSkill('velen-holy-prophecy', false, wrappedSetup))
    expect(wrapped.result).toEqual({ success: false, message: '选择的手牌已无法被预言' })
    expect(wrapped.state.players[0].hand).toEqual(cards)

    const noOwnerSetup = () => {
      const setup = setupWithHand(clone(cards), { selectedOption: 'smite', setOption: true })
      setup.context.piece.ownerPlayerId = 'missing-player'
      return setup
    }
    const noOwner = runSkill('velen-holy-prophecy', true, noOwnerSetup)
    expect(noOwner).toEqual(runSkill('velen-holy-prophecy', false, noOwnerSetup))
    expect(noOwner.result).toEqual({ success: false, message: '未找到玩家' })

    const cancelledSetup = () => setupWithHand(clone(cards), { selectedOption: null, setOption: true })
    const cancelled = runSkill('velen-holy-prophecy', true, cancelledSetup)
    expect(cancelled).toEqual(runSkill('velen-holy-prophecy', false, cancelledSetup))
    expect(cancelled.result).toBeNull()
  })

  it('preserves Thousand Futures multi-selection, enhancement branches and strict validation', () => {
    const cards = [card('smite', 'holy-smite'), card('heal', 'holy-heal'), card('charge', 'holy-charge'), card('enhanced', 'holy-smite', { contentState: { velenHolyProphecyEnhanced: true } })]
    const selectedSetup = () => setupWithHand(clone(cards), { selectedOption: ['smite', 'heal', 'charge'], setOption: true })
    const expected = runSkill('velen-thousand-futures-ultimate', false, selectedSetup)
    const actual = runSkill('velen-thousand-futures-ultimate', true, selectedSetup)
    expect(actual).toEqual(expected)
    expect(actual.result).toEqual({ success: true, message: '维伦从3种圣光的可能中选定了未来' })
    expect(actual.state.players[0].hand.slice(0, 3).map((item: any) => item.contentState)).toEqual([
      { velenHolyProphecyEnhanced: true }, { velenHolyProphecyEnhanced: true }, { velenHolyProphecyEnhanced: true },
    ])
    expect(actual.state.players[0].hand[0].effectModifiers).toEqual([{ effect: 'damage', operation: 'multiply', value: 1.5 }])
    expect(actual.state.players[0].hand[1].effectModifiers).toEqual([{ effect: 'heal', operation: 'multiply', value: 1.5 }])
    expect(actual.state.players[0].hand[2].effectModifiers).toEqual([{ effect: 'statusIntensity', operation: 'multiply', value: 1.5, statusType: 'damage-buff' }])
    expect(actual.state.players[0].hand[0].presentation).toEqual(expect.objectContaining({ variant: 'enhanced', badge: '预言强化' }))

    const pendingSetup = () => setupWithHand(clone(cards))
    const pending = runSkill('velen-thousand-futures-ultimate', true, pendingSetup)
    expect(pending).toEqual(runSkill('velen-thousand-futures-ultimate', false, pendingSetup))
    expect(pending.result).toMatchObject({ success: false, needsOptionSelection: true, presentation: 'hand', selectionMode: 'multi', minSelections: 1, maxSelections: 3 })

    const duplicateSetup = () => setupWithHand(clone(cards), { selectedOption: ['smite', 'smite'], setOption: true })
    const duplicate = runSkill('velen-thousand-futures-ultimate', true, duplicateSetup)
    expect(duplicate).toEqual(runSkill('velen-thousand-futures-ultimate', false, duplicateSetup))
    expect(duplicate.result).toEqual({ success: false, message: '不能重复选择同一张手牌' })

    const invalidShapeSetup = () => setupWithHand(clone(cards), { selectedOption: 'smite', setOption: true })
    const invalidShape = runSkill('velen-thousand-futures-ultimate', true, invalidShapeSetup)
    expect(invalidShape).toEqual(runSkill('velen-thousand-futures-ultimate', false, invalidShapeSetup))
    expect(invalidShape.result).toEqual({ success: false, message: '万千未来选择无效' })

    for (const [selectedOption, expectedMessage] of [
      [[{ value: 'smite' }], '选择的手牌已无法强化'],
      [[1], '选择的手牌已无法强化'],
      [['smite', 1], '选择的手牌已无法强化'],
      [[], '万千未来选择无效'],
      [{ value: ['smite'] }, '万千未来选择无效'],
    ] as const) {
      const invalidOptionSetup = () => setupWithHand(clone(cards), { selectedOption, setOption: true })
      const invalidOption = runSkill('velen-thousand-futures-ultimate', true, invalidOptionSetup)
      expect(invalidOption, JSON.stringify(selectedOption)).toEqual(runSkill('velen-thousand-futures-ultimate', false, invalidOptionSetup))
      expect(invalidOption.result, JSON.stringify(selectedOption)).toEqual({ success: false, message: expectedMessage })
      expect(invalidOption.state.players[0].hand, JSON.stringify(selectedOption)).toEqual(cards)
    }

    const staleSetup = () => setupWithHand(clone(cards), { selectedOption: ['smite', 'missing'], setOption: true })
    const stale = runSkill('velen-thousand-futures-ultimate', true, staleSetup)
    expect(stale).toEqual(runSkill('velen-thousand-futures-ultimate', false, staleSetup))
    expect(stale.result).toEqual({ success: false, message: '选择的手牌已无法强化' })

    const noOwnerSetup = () => {
      const setup = setupWithHand(clone(cards), { selectedOption: ['smite'], setOption: true })
      setup.context.piece.ownerPlayerId = 'missing-player'
      return setup
    }
    const noOwner = runSkill('velen-thousand-futures-ultimate', true, noOwnerSetup)
    expect(noOwner).toEqual(runSkill('velen-thousand-futures-ultimate', false, noOwnerSetup))
    expect(noOwner.result).toEqual({ success: false, message: '未找到玩家' })

    const cancelledSetup = () => setupWithHand(clone(cards), { selectedOption: null, setOption: true })
    const cancelled = runSkill('velen-thousand-futures-ultimate', true, cancelledSetup)
    expect(cancelled).toEqual(runSkill('velen-thousand-futures-ultimate', false, cancelledSetup))
    expect(cancelled.result).toBeNull()
  })
})
