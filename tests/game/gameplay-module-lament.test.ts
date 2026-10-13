/* eslint-disable @typescript-eslint/no-explicit-any -- real host differential fixtures. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyGameplayModuleGraph,
  assertGameplayModuleDocument,
  compileGameplayModuleGraph,
  GAMEPLAY_MODULE_REGISTRY,
} from '@/lib/skill-graph/module-document'
import { executeSkillFunction } from '@/lib/game/skills'
import { recordBattlePresentation, recordedBattlePresentation } from '@/lib/game/battle-presentation-recording'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { migrateAtomicAuthorGraph } from '@/scripts/migrate-atomic-author-modules'
import { buildMuruLamentGraph, LAMENT_SKILL_ID, migrateSemanticLament } from '@/scripts/migrate-semantic-lament'
import { makePiece as makeRawPiece, makeState } from '../helpers/minimal-state'

const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries as Record<string, any>
const production = JSON.parse(readFileSync('data/skills/muru-lament.json', 'utf8')) as any
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

function withMigrationRoot(document: any, run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'rvb-lament-migration-'))
  try {
    mkdirSync(join(root, 'tests/game/fixtures'), { recursive: true })
    mkdirSync(join(root, 'data/skills'), { recursive: true })
    writeFileSync(join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), JSON.stringify({ entries: fixture }))
    writeFileSync(join(root, 'data/skills/muru-lament.json'), JSON.stringify(document))
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

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

function contextFor(source: any, battle: any, options: { selectedOption?: any; setOption?: boolean } = {}): any {
  const context: any = {
    piece: source,
    battle,
    skill: null,
    target: null,
    targetPosition: null,
    targets: [],
  }
  if (options.setOption) context.selectedOption = options.selectedOption
  return context
}

function setupWithCards(cards: any[], options: { selectedOption?: any; setOption?: boolean; extraPieces?: any[] } = {}) {
  const source = makePiece({
    instanceId: 'muru', templateId: 'muru', ownerPlayerId: 'player-red', name: '穆鲁',
    x: 1, y: 1, currentHp: 20, maxHp: 20,
    skills: [{ skillId: 'light-extraction', currentCooldown: 2, usesRemaining: -1 }],
  })
  const ally = makePiece({ instanceId: 'ally', templateId: 'ally', ownerPlayerId: 'player-red', name: '友军', x: 2, y: 1, currentHp: 8, maxHp: 20 })
  const enemy = makePiece({ instanceId: 'enemy', templateId: 'enemy', ownerPlayerId: 'player-blue', name: '敌军', x: 3, y: 1, currentHp: 10, maxHp: 10 })
  const battle: any = makeState({ pieces: [source, ally, enemy, ...(options.extraPieces ?? [])], turnNumber: 4 })
  battle.players[0].hand = clone(cards)
  return { battle, context: contextFor(source, battle, options) }
}

function runSkill(semantic: boolean, setup: () => { battle: any; context: any }): any {
  const runtime = new RuleRuntime({ rootSeed: 594 })
  return withRuleRuntime(runtime, () => {
    const graph = buildMuruLamentGraph()
    const definition = semantic ? applyGameplayModuleGraph(fixture[`skills/${LAMENT_SKILL_ID}`], graph) : fixture[`skills/${LAMENT_SKILL_ID}`]
    const { battle, context } = setup()
    battle.skillsById[LAMENT_SKILL_ID] = definition
    const result = recordBattlePresentation(battle, () => executeSkillFunction(definition, context, battle), () => battle)
    return {
      result: clone(result),
      state: comparableState(battle),
      presentation: recordedBattlePresentation(battle),
      runtime: runtime.snapshot(),
    }
  })
}

describe('semantic Muru Lament migration', () => {
  it('registers the real graph and writes the production document', () => {
    const graph = migrateAtomicAuthorGraph(buildMuruLamentGraph())
    const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
    expect(compiled.code).toContain('function executeSkill')
    const document = applyGameplayModuleGraph(fixture[`skills/${LAMENT_SKILL_ID}`], graph)
    assertGameplayModuleDocument(document)
    expect(document.contentGraph).toBeUndefined()
    expect((document.gameplayModules as any).entries.code.graph).toEqual(graph)
    expect(production.contentGraph).toBeUndefined()
    expect(production.code).toBe(compiled.code)
    expect(production.gameplayModules.entries.code.graph).toEqual(graph)
  })

  it('preserves one-card damage, healing, discard and exact presentation', () => {
    const cards = [card('smite', 'holy-smite', { name: '圣光惩击' }), card('other', 'fireball')]
    const setup = () => setupWithCards(cards, { selectedOption: ['smite'], setOption: true })
    const legacy = runSkill(false, setup)
    const semantic = runSkill(true, setup)
    expect(semantic).toEqual(legacy)
    expect(semantic.result).toEqual({ success: true, message: '穆鲁发动穆鲁的挽歌，丢弃1张圣光手牌，造成2点伤害并恢复2点生命' })
    expect(semantic.state.players[0].hand.map((item: any) => item.instanceId)).toEqual(['other'])
    expect(semantic.state.players[0].discardPile).toEqual(['holy-smite'])
    expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'enemy').currentHp).toBe(8)
    expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'ally').currentHp).toBe(10)
    expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'muru').skills[0].currentCooldown).toBe(2)
  })

  it('preserves repeated per-card batches and three-card shield/reset behavior', () => {
    const cards = [
      card('smite', 'holy-smite'), card('heal', 'holy-heal'), card('charge', 'holy-charge'), card('extra', 'holy-smite'),
    ]
    const setup = () => setupWithCards(cards, {
      selectedOption: ['smite', 'heal', 'charge'], setOption: true,
      extraPieces: [
        makePiece({ instanceId: 'already-shielded', ownerPlayerId: 'player-red', x: 2, y: 2, currentHp: 10, maxHp: 10, statusTags: [{ id: 'divine-shield', type: 'divine-shield', name: '圣盾' }] }),
        makePiece({ instanceId: 'dead-ally', ownerPlayerId: 'player-red', x: 2, y: 3, currentHp: 0, maxHp: 10 }),
        makePiece({ instanceId: 'dead-enemy', ownerPlayerId: 'player-blue', x: 3, y: 3, currentHp: 0, maxHp: 10 }),
      ],
    })
    const legacy = runSkill(false, setup)
    const semantic = runSkill(true, setup)
    expect(semantic).toEqual(legacy)
    expect(semantic.result).toEqual({ success: true, message: '穆鲁发动穆鲁的挽歌，丢弃3张圣光手牌，造成6点伤害并恢复6点生命' })
    const pieces = semantic.state.pieces
    expect(pieces.find((piece: any) => piece.instanceId === 'ally').statusTags).toEqual([expect.objectContaining({ id: 'divine-shield', type: 'divine-shield' })])
    expect(pieces.find((piece: any) => piece.instanceId === 'already-shielded').statusTags).toEqual([expect.objectContaining({ id: 'divine-shield', type: 'divine-shield' })])
    expect(pieces.find((piece: any) => piece.instanceId === 'dead-ally').statusTags).toEqual([])
    expect(pieces.find((piece: any) => piece.instanceId === 'muru').skills[0].currentCooldown).toBe(0)
  })

  it('preserves pending, cancel and dynamic labels/max selection', () => {
    const cards = [card('smite', 'holy-smite', { name: '圣光惩击' }), card('heal', 'holy-heal'), card('charge', 'holy-charge'), card('extra', 'holy-smite')]
    const pending = runSkill(true, () => setupWithCards(cards))
    expect(pending).toEqual(runSkill(false, () => setupWithCards(cards)))
    expect(pending.result).toMatchObject({
      success: false, needsOptionSelection: true, title: '穆鲁的挽歌：选择要丢弃的圣光手牌',
      presentation: 'hand', selectionMode: 'multi', minSelections: 1, maxSelections: 4, canCancel: true,
    })
    expect(pending.result.options).toEqual([
      { label: '圣光惩击', value: 'smite' },
      { label: 'holy-heal', value: 'heal' },
      { label: 'holy-charge', value: 'charge' },
      { label: 'holy-smite', value: 'extra' },
    ])

    const shortPending = runSkill(true, () => setupWithCards(cards.slice(0, 2)))
    expect(shortPending.result.maxSelections).toBe(2)
    const cancelled = runSkill(true, () => setupWithCards(cards, { selectedOption: null, setOption: true }))
    expect(cancelled).toEqual(runSkill(false, () => setupWithCards(cards, { selectedOption: null, setOption: true })))
    expect(cancelled.result).toBeNull()
    expect(cancelled.state.players[0].hand).toEqual(cards)
  })

  it('preserves strict invalid, duplicate, stale, no-card and missing-player branches', () => {
    const cards = [card('smite', 'holy-smite'), card('heal', 'holy-heal'), card('charge', 'holy-charge')]
    const cases: Array<[any, string]> = [
      ['smite', '穆鲁的挽歌选择无效'],
      [[], '穆鲁的挽歌选择无效'],
      [['smite', 'smite'], '不能重复选择同一张手牌'],
      [[1, 1], '不能重复选择同一张手牌'],
      [[1], '选择的圣光手牌已失效'],
      [['smite', 1], '选择的圣光手牌已失效'],
      [['missing'], '选择的圣光手牌已失效'],
      [['smite', 'heal', 'charge', 'smite', 'heal'], '穆鲁的挽歌选择无效'],
    ]
    for (const [selectedOption, message] of cases) {
      const setup = () => setupWithCards(cards, { selectedOption, setOption: true })
      const legacy = runSkill(false, setup)
      const semantic = runSkill(true, setup)
      expect(semantic, JSON.stringify(selectedOption)).toEqual(legacy)
      expect(semantic.result, JSON.stringify(selectedOption)).toEqual({ success: false, message })
      expect(semantic.state.players[0].hand, JSON.stringify(selectedOption)).toEqual(cards)
    }

    const noCards = runSkill(true, () => setupWithCards([]))
    expect(noCards).toEqual(runSkill(false, () => setupWithCards([])))
    expect(noCards.result).toEqual({ success: false, message: '没有圣光手牌' })

    const missingPlayer = runSkill(true, () => {
      const setup = setupWithCards(cards, { selectedOption: ['smite'], setOption: true })
      setup.context.piece.ownerPlayerId = 'missing-player'
      return setup
    })
    expect(missingPlayer).toEqual(runSkill(false, () => {
      const setup = setupWithCards(cards, { selectedOption: ['smite'], setOption: true })
      setup.context.piece.ownerPlayerId = 'missing-player'
      return setup
    }))
    expect(missingPlayer.result).toEqual({ success: false, message: '未找到玩家' })
  })

  it('keeps dead targets out of later per-card batches', () => {
    const cards = [card('smite', 'holy-smite'), card('heal', 'holy-heal')]
    const setup = () => setupWithCards(cards, {
      selectedOption: ['smite', 'heal'], setOption: true,
      extraPieces: [makePiece({ instanceId: 'fragile-enemy', ownerPlayerId: 'player-blue', x: 4, y: 1, currentHp: 2, maxHp: 2 })],
    })
    const legacy = runSkill(false, setup)
    const semantic = runSkill(true, setup)
    expect(semantic).toEqual(legacy)
    expect(semantic.result).toEqual({ success: true, message: '穆鲁发动穆鲁的挽歌，丢弃2张圣光手牌，造成6点伤害并恢复4点生命' })
    expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'fragile-enemy')).toBeUndefined()
  })

  it('retains a valid author graph even when it differs from the migration builder', () => {
    const customGraph: any = clone(buildMuruLamentGraph())
    customGraph.body[0].layout = { authorNote: 'keep this graph' }
    const customDocument = applyGameplayModuleGraph(fixture[`skills/${LAMENT_SKILL_ID}`], customGraph)
    withMigrationRoot(customDocument, root => {
      expect(migrateSemanticLament(root, true)).toEqual([`skills/${LAMENT_SKILL_ID}`])
      const saved = JSON.parse(readFileSync(join(root, 'data/skills/muru-lament.json'), 'utf8'))
      expect(saved.gameplayModules.entries.code.graph).toEqual(customGraph)
      expect(saved.code).toBe(customDocument.code)
    })
  })

  it('rejects tampered executable text even when forged graph metadata is present', () => {
    const tampered = clone(fixture[`skills/${LAMENT_SKILL_ID}`])
    tampered.code += '\n// forged migration artifact'
    tampered.contentGraph = { version: 'rvb-content-graph/v1', surface: 'skill', body: [] }
    tampered.contentGraphField = 'code'
    tampered.contentGraphCompilerVersion = 'rvb-content-graph-compiler/v1'
    withMigrationRoot(tampered, root => {
      expect(() => migrateSemanticLament(root)).toThrow(/author executable differs from frozen baseline/)
    })
  })
})
