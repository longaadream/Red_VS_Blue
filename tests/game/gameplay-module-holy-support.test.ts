/* eslint-disable @typescript-eslint/no-explicit-any -- frozen host differential fixtures. */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, compileGameplayModuleGraph, GAMEPLAY_MODULE_REGISTRY } from '@/lib/skill-graph/module-document'
import { buildHolySupportGraph, HOLY_SUPPORT_SKILL_IDS } from '@/scripts/migrate-semantic-holy-support'
import { executeSkillFunction } from '@/lib/game/skills'
import { makePiece as makeRawPiece, makeState } from '../helpers/minimal-state'

const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries as Record<string, any>
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const makePiece = (overrides: Record<string, any> = {}): any => {
  const piece = makeRawPiece(overrides) as any
  if (typeof overrides.name === 'string') piece.name = overrides.name
  return piece
}

function comparableState(battle: any) {
  const state = clone(battle)
  delete state.skillsById
  state.pieces = state.pieces.map((piece: any) => ({
    instanceId: piece.instanceId,
    templateId: piece.templateId,
    ownerPlayerId: piece.ownerPlayerId,
    currentHp: piece.currentHp,
    attack: piece.attack,
    defense: piece.defense,
    moveRange: piece.moveRange,
    x: piece.x,
    y: piece.y,
    statusTags: piece.statusTags,
    rules: (piece.rules || []).map((rule: any) => typeof rule === 'string' ? rule : rule.id),
  }))
  state.players = state.players.map((player: any) => ({
    playerId: player.playerId,
    hand: (player.hand || []).map((card: any) => ({ cardId: card.cardId, ownerPlayerId: card.ownerPlayerId, name: card.name })),
    discardPile: player.discardPile,
    statusEffects: player.statusEffects,
    rules: (player.rules || []).map((rule: any) => typeof rule === 'string' ? rule : rule.id),
  }))
  state.actions = (state.actions || []).map((action: any) => {
    const next = clone(action)
    if (next.payload && typeof next.payload === 'object') {
      delete next.payload.cardInstanceId
      delete next.payload.instanceId
    }
    return next
  })
  return state
}

function runSkill(definition: any, options: { source?: any; target?: any; pieces?: any[] } = {}) {
  const source = options.source ?? makePiece({ instanceId: 'source', templateId: 'anduin', name: '施法者', ownerPlayerId: 'player-red', x: 1, y: 1 })
  const target = options.target
  const pieces = options.pieces ?? [source, ...(target ? [target] : [])]
  const battle: any = makeState({ pieces })
  battle.skillsById[definition.id] = definition
  const result = executeSkillFunction(definition, {
    piece: source,
    battle,
    skill: definition,
    target: target ?? null,
    targetPosition: null,
    targets: target ? [{ info: target, pos: null }] : [],
  } as any, battle)
  return { result: clone(result), state: comparableState(battle) }
}

function runTriggered(definition: any, overrides: Record<string, unknown> = {}) {
  const source = (overrides.sourcePiece ?? overrides.piece ?? makePiece({ instanceId: 'event-source', templateId: 'ally', name: '失盾友军', ownerPlayerId: 'player-red', x: 2, y: 1 })) as any
  const rulePiece = makePiece({ instanceId: 'liadrin', templateId: 'liadrin', name: '莉亚德琳', ownerPlayerId: 'player-red', x: 1, y: 1 })
  const battle: any = makeState({ pieces: [source, rulePiece] })
  battle.skillsById[definition.id] = definition
  const context: any = {
    type: 'afterStatusRemoved',
    piece: source,
    sourcePiece: source,
    rulePiece,
    statusId: 'divine-shield',
    statusType: 'divine-shield',
    playerId: source.ownerPlayerId,
    ruleOwnerPlayerId: rulePiece.ownerPlayerId,
    ruleId: 'rule-blood-echo',
    skill: definition,
    ...overrides,
  }
  const result = executeSkillFunction(definition, context, battle, { context, surface: 'triggerSkill' })
  return { result: clone(result), state: comparableState(battle) }
}

describe('semantic holy support migrations', () => {
  it('registers typed graphs without legacy executable wrappers', () => {
    for (const id of HOLY_SUPPORT_SKILL_IDS) {
      const graph = buildHolySupportGraph(id)
      const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
      expect(compiled.code).toContain('function executeSkill')
      expect(graph).not.toHaveProperty('code')
      const source = fixture['skills/' + id]
      const document = applyGameplayModuleGraph(source, graph)
      assertGameplayModuleDocument(document)
      expect(document.contentGraph).toBeUndefined()
      const modules = document.gameplayModules as { entries: Record<string, { graph: unknown }> }
      expect(modules.entries.code.graph).toEqual(graph)
    }
  })

  it('preserves Light Extraction pending, failure, and success behavior', () => {
    const source = fixture['skills/light-extraction']
    const semantic = applyGameplayModuleGraph(source, buildHolySupportGraph('light-extraction'))
    const target = makePiece({
      instanceId: 'shielded',
      templateId: 'ally',
      name: '圣盾友军',
      ownerPlayerId: 'player-red',
      x: 3,
      y: 1,
      statusTags: [{ id: 'divine-shield', type: 'divine-shield', currentDuration: -1, currentUses: 1, relatedRules: ['rule-divine-shield'] }],
      rules: [{ id: 'rule-divine-shield' }],
    })
    const noShield = makePiece({ instanceId: 'unshielded', templateId: 'ally', name: '无盾友军', ownerPlayerId: 'player-red', x: 3, y: 1 })
    expect(runSkill(semantic, { target: null, pieces: [makePiece({ instanceId: 'source', templateId: 'anduin', name: '施法者', x: 1, y: 1 }), target] })).toEqual(runSkill(source, { target: null, pieces: [makePiece({ instanceId: 'source', templateId: 'anduin', name: '施法者', x: 1, y: 1 }), target] }))
    expect(runSkill(semantic, { target: noShield, pieces: [makePiece({ instanceId: 'source', templateId: 'anduin', name: '施法者', x: 1, y: 1 }), noShield] })).toEqual(runSkill(source, { target: noShield, pieces: [makePiece({ instanceId: 'source', templateId: 'anduin', name: '施法者', x: 1, y: 1 }), noShield] }))
    const semanticTarget = clone(target)
    const legacyTarget = clone(target)
    const semanticSuccess = runSkill(semantic, { target: semanticTarget, pieces: [makePiece({ instanceId: 'source', templateId: 'anduin', name: '施法者', x: 1, y: 1 }), semanticTarget] })
    const legacySuccess = runSkill(source, { target: legacyTarget, pieces: [makePiece({ instanceId: 'source', templateId: 'anduin', name: '施法者', x: 1, y: 1 }), legacyTarget] })
    expect(semanticSuccess).toEqual(legacySuccess)
    expect(semanticSuccess.result.message).toBe('施法者汲取了圣盾友军的圣盾，生成圣光惩戒和圣光治疗')
  })

  it('preserves Divine Blessing intensity, status payload, rules, and message', () => {
    const source = fixture['skills/divine-blessing']
    const semantic = applyGameplayModuleGraph(source, buildHolySupportGraph('divine-blessing'))
    const makeRoster = () => {
      const caster = makePiece({ instanceId: 'source', templateId: 'anduin', name: '施法者', ownerPlayerId: 'player-red', x: 1, y: 1, statusTags: [{ id: 'shield-source', type: 'divine-shield' }] })
      const ally = makePiece({ instanceId: 'ally', templateId: 'ally', name: '友军', ownerPlayerId: 'player-red', x: 2, y: 1, statusTags: [{ id: 'shield-ally', type: 'divine-shield' }] })
      const enemy = makePiece({ instanceId: 'enemy', templateId: 'enemy', name: '敌军', ownerPlayerId: 'player-blue', x: 3, y: 1, statusTags: [{ id: 'shield-enemy', type: 'divine-shield' }] })
      return [caster, ally, enemy]
    }
    const semanticResult = runSkill(semantic, { source: makeRoster()[0], pieces: makeRoster() })
    const legacyResult = runSkill(source, { source: makeRoster()[0], pieces: makeRoster() })
    expect(semanticResult).toEqual(legacyResult)
    expect(semanticResult.result.message).toBe('施法者为所有友方棋子赐福，下一次伤害增加5点（圣盾×3）')
    expect(semanticResult.state.pieces.find((piece: any) => piece.instanceId === 'ally').statusTags).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'damage-buff', intensity: 5, currentUses: 1 })]))
    expect(semanticResult.state.pieces.find((piece: any) => piece.instanceId === 'enemy').statusTags).toEqual([{ id: 'shield-enemy', type: 'divine-shield' }])
  })

  it('preserves Blood Echo trigger guards and card generation', () => {
    const source = fixture['skills/blood-echo-trigger']
    const semantic = applyGameplayModuleGraph(source, buildHolySupportGraph('blood-echo-trigger'))
    expect(runTriggered(semantic)).toEqual(runTriggered(source))
    expect(runTriggered(semantic).result).toMatchObject({ success: true, message: '血色回响生成了1张圣光充能' })
    expect(runTriggered(semantic, { statusId: 'other-status', statusType: 'other-status' })).toEqual(runTriggered(source, { statusId: 'other-status', statusType: 'other-status' }))
    const enemySource = makePiece({ instanceId: 'enemy-source', templateId: 'enemy', name: '敌方', ownerPlayerId: 'player-blue', x: 2, y: 1 })
    expect(runTriggered(semantic, { piece: enemySource, sourcePiece: enemySource, statusId: 'divine-shield', statusType: 'divine-shield', playerId: 'player-blue' })).toEqual(runTriggered(source, { piece: enemySource, sourcePiece: enemySource, statusId: 'divine-shield', statusType: 'divine-shield', playerId: 'player-blue' }))
  })
})

afterEach(() => vi.restoreAllMocks())

