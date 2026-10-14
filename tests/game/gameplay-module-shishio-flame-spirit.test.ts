/* eslint-disable @typescript-eslint/no-explicit-any -- frozen host differential fixtures. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  applyGameplayModuleGraph,
  assertGameplayModuleDocument,
  compileGameplayModuleGraph,
  GAMEPLAY_MODULE_REGISTRY,
} from '@/lib/skill-graph/module-document'
import { executeSkillFunction } from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { recordBattlePresentation, recordedBattlePresentation } from '@/lib/game/battle-presentation-recording'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { migrateAtomicAuthorGraph } from '@/scripts/migrate-atomic-author-modules'
import { buildShishioFlameSpiritGraph, migrateSemanticShishioFlameSpirit, SHISHIO_FLAME_SPIRIT_SKILL_ID } from '@/scripts/migrate-semantic-shishio-flame-spirit'
import { makePiece as makeRawPiece, makeState } from '../helpers/minimal-state'

const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries as Record<string, any>
const production = JSON.parse(readFileSync('data/skills/shishio-flame-spirit.json', 'utf8')) as any
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function makePiece(overrides: Record<string, any> = {}): any {
  const piece = makeRawPiece(overrides) as any
  if (typeof overrides.name === 'string') piece.name = overrides.name
  if (overrides.defense !== undefined) piece.defense = overrides.defense
  return piece
}

function comparableState(battle: any): any {
  const state = clone(battle)
  delete state.skillsById
  return state
}

type Scenario = {
  kills?: number
  enemies?: Array<Record<string, any>>
  existingBurnTiles?: Array<Record<string, any>>
  width?: number
  height?: number
  source?: Record<string, any>
}

function setupScenario(scenario: Scenario = {}): { battle: any; context: any } {
  const source = makePiece({
    instanceId: 'shishio', templateId: 'shishio', ownerPlayerId: 'player-red', faction: 'red',
    name: '志志雄', x: 1, y: 1, attack: 10, currentHp: 30, maxHp: 30,
    statusTags: scenario.kills === undefined ? [] : [{ id: 'shishio-kills', type: 'shishio-kills', intensity: scenario.kills }],
    ...scenario.source,
  })
  const enemies = (scenario.enemies ?? []).map((piece, index) => makePiece({
    instanceId: `enemy-${index + 1}`, templateId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue',
    name: `敌军${index + 1}`, x: 2 + index, y: 1, attack: 3, currentHp: 40, maxHp: 40, ...piece,
  }))
  const battle: any = makeState({
    pieces: [source, ...enemies],
    width: scenario.width ?? 6,
    height: scenario.height ?? 5,
    turnNumber: 4,
    currentPlayerId: 'player-red',
  })
  if (scenario.existingBurnTiles !== undefined) battle.extensions.shishioBurnTiles = clone(scenario.existingBurnTiles)
  return {
    battle,
    context: {
      piece: source,
      battle,
      skill: null,
      target: null,
      targetPosition: null,
      targets: [],
      playerId: 'player-red',
    },
  }
}

function runSkill(semantic: boolean, scenario: Scenario = {}): any {
  const runtime = new RuleRuntime({ rootSeed: 594 })
  return withRuleRuntime(runtime, () => {
    const graph = buildShishioFlameSpiritGraph()
    const definition = semantic
      ? applyGameplayModuleGraph(fixture[`skills/${SHISHIO_FLAME_SPIRIT_SKILL_ID}`], graph)
      : fixture[`skills/${SHISHIO_FLAME_SPIRIT_SKILL_ID}`]
    const { battle, context } = setupScenario(scenario)
    battle.skillsById[SHISHIO_FLAME_SPIRIT_SKILL_ID] = definition
    const result = recordBattlePresentation(
      battle,
      () => executeSkillFunction(definition, context, battle),
      () => battle,
    )
    return {
      result: clone(result),
      state: comparableState(battle),
      presentation: clone(recordedBattlePresentation(battle) ?? []),
      runtime: runtime.snapshot(),
    }
  })
}

describe('semantic Shishio Flame Spirit migration', () => {
  function withMigrationRoot(document: any, callback: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'rvb-shishio-flame-migration-'))
    try {
      mkdirSync(join(root, 'tests/game/fixtures'), { recursive: true })
      mkdirSync(join(root, 'data/skills'), { recursive: true })
      writeFileSync(join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), JSON.stringify({ entries: fixture }))
      writeFileSync(join(root, 'data/skills', `${SHISHIO_FLAME_SPIRIT_SKILL_ID}.json`), JSON.stringify(document))
      callback(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('does not overwrite an existing author graph or its metadata', () => {
    const authored = clone(production)
    authored.unknownAuthorMetadata = { retained: true, source: 'shishio-review' }
    withMigrationRoot(authored, root => {
      expect(migrateSemanticShishioFlameSpirit(root, true)).toEqual([`skills/${SHISHIO_FLAME_SPIRIT_SKILL_ID}`])
      const persisted = JSON.parse(readFileSync(join(root, 'data/skills', `${SHISHIO_FLAME_SPIRIT_SKILL_ID}.json`), 'utf8'))
      expect(persisted.unknownAuthorMetadata).toEqual(authored.unknownAuthorMetadata)
      expect(persisted.gameplayModules).toEqual(authored.gameplayModules)
      expect(persisted.code).toBe(authored.code)
      expect(persisted.previewCode).toBe(authored.previewCode)
    })
  })

  it('rejects tampered legacy code or preview before writing any graph', () => {
    const tamperedCode = clone(fixture[`skills/${SHISHIO_FLAME_SPIRIT_SKILL_ID}`])
    tamperedCode.code += '\n// author edit'
    expect(() => withMigrationRoot(tamperedCode, root => migrateSemanticShishioFlameSpirit(root, true)))
      .toThrow(/author executable differs from frozen baseline/)

    const tamperedPreview = clone(fixture[`skills/${SHISHIO_FLAME_SPIRIT_SKILL_ID}`])
    tamperedPreview.previewCode += '\n// author preview edit'
    expect(() => withMigrationRoot(tamperedPreview, root => migrateSemanticShishioFlameSpirit(root, true)))
      .toThrow(/author executable differs from frozen baseline/)
  })

  it('registers the real graph and writes the production document', () => {
    const graph = migrateAtomicAuthorGraph(buildShishioFlameSpiritGraph())
    const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
    expect(compiled.code).toContain('function executeSkill')
    expect(compiled.code).toContain('tileBatch')
    expect(compiled.code).toContain('shishioBurnTiles')
    expect(graph).not.toHaveProperty('code')
    const document = applyGameplayModuleGraph(fixture[`skills/${SHISHIO_FLAME_SPIRIT_SKILL_ID}`], graph)
    assertGameplayModuleDocument(document)
    expect(document.contentGraph).toBeUndefined()
    expect((document.gameplayModules as any).entries.code.graph).toEqual(graph)
    expect(production.contentGraph).toBeUndefined()
    expect(production.code).toBe(compiled.code)
    expect(production.gameplayModules.entries.code.graph).toEqual(graph)
    expect(production.gameplayModules.entries.previewCode.graph).toBeDefined()
  })

  it.each([0, 1, 2])('preserves the four-cell order, multiplier, rules, state, presentation and RNG at kill tier %s', kills => {
    const scenario = { kills, enemies: [{ x: 4, y: 1 }] }
    const legacy = runSkill(false, scenario)
    const semantic = runSkill(true, scenario)
    expect(semantic).toEqual(legacy)
    expect(semantic.result).toMatchObject({ success: true })
    expect(semantic.state.extensions.shishioBurnTiles).toEqual([
      { x: 1, y: 0, sourcePieceId: 'shishio', ownerPlayerId: 'player-red' },
      { x: 1, y: 2, sourcePieceId: 'shishio', ownerPlayerId: 'player-red' },
      { x: 0, y: 1, sourcePieceId: 'shishio', ownerPlayerId: 'player-red' },
      { x: 2, y: 1, sourcePieceId: 'shishio', ownerPlayerId: 'player-red' },
    ])
    expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'enemy-1').currentHp).toBe(40 - 10 * (kills === 0 ? 1 : kills === 1 ? 1.5 : 2))
    expect(semantic.state.players[0].rules.map((rule: any) => rule.id)).toEqual(['rule-shishio-burn-move', 'rule-shishio-burn-endturn'])
  })

  it('preserves threshold semantics for fractional and negative kill intensities', () => {
    const fractional = runSkill(true, { kills: 1.5, enemies: [{ x: 4, y: 1 }] })
    const negative = runSkill(true, { kills: -1, enemies: [{ x: 4, y: 1 }] })
    expect(fractional).toEqual(runSkill(false, { kills: 1.5, enemies: [{ x: 4, y: 1 }] }))
    expect(negative).toEqual(runSkill(false, { kills: -1, enemies: [{ x: 4, y: 1 }] }))
    expect(fractional.result.message).toContain('造成 15 点真实伤害（150%）')
    expect(negative.result.message).toContain('造成 10 点真实伤害（100%）')
  })

  it('preserves duplicate filtering, map-outside cells, empty enemy branch and exact messages', () => {
    const scenario = {
      width: 2,
      height: 2,
      source: { x: 0, y: 0 },
      existingBurnTiles: [{ x: 0, y: -1, sourcePieceId: 'older', ownerPlayerId: 'player-red' }],
    }
    const legacy = runSkill(false, scenario)
    const semantic = runSkill(true, scenario)
    expect(semantic).toEqual(legacy)
    expect(semantic.result).toEqual({ success: true, message: '志志雄 发动我流·炎灵！新增3 格永久燃烧（当前共 4 格）；6格内无敌人，精神之火未命中' })
    expect(semantic.state.extensions.shishioBurnTiles).toEqual([
      { x: 0, y: -1, sourcePieceId: 'older', ownerPlayerId: 'player-red' },
      { x: 0, y: 1, sourcePieceId: 'shishio', ownerPlayerId: 'player-red' },
      { x: -1, y: 0, sourcePieceId: 'shishio', ownerPlayerId: 'player-red' },
      { x: 1, y: 0, sourcePieceId: 'shishio', ownerPlayerId: 'player-red' },
    ])
    expect(semantic.state.extensions.tileEffects).toHaveLength(3)
  })

  it('uses the authoritative random stream and keeps the source object alive through reflected damage', () => {
    const installReflection = () => {
      globalTriggerSystem.addRule({
        id: 'shishio-test-reflect', name: '测试反伤', description: '', trigger: { type: 'beforeDamageDealt' },
        effect: (battle: any, context: any) => {
          if (context.sourcePiece?.instanceId !== 'shishio') return { success: true }
          const target = context.targetPiece
          if (!target || target.currentHp <= 0) return { success: true }
          const source = context.sourcePiece
          context.damageQueue.push({
            attacker: target,
            target: source,
            damage: source.currentHp + 99,
            damageType: 'true',
            skillId: 'shishio-test-reflect',
          })
          return { success: true }
        },
      } as any)
    }
    installReflection()
    try {
      const scenario = { enemies: [{ x: 3, y: 1 }, { x: 4, y: 1 }] }
      const legacy = runSkill(false, scenario)
      const semantic = runSkill(true, scenario)
      expect(semantic).toEqual(legacy)
      expect(semantic.runtime.cursors['skill/effect']).toBe(1)
      expect(semantic.result).toMatchObject({ success: true, message: expect.stringContaining('精神之火锁定') })
    } finally {
      globalTriggerSystem.clearRules()
    }
  })
})
