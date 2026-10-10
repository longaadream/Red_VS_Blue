/* eslint-disable @typescript-eslint/no-explicit-any -- frozen content differential fixtures. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, beforeEach } from 'vitest'

import { compileGameplayModuleGraph } from '@/lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '@/lib/skill-graph/module-registry'
import { executeSkillFunction } from '@/lib/game/skills'
import { runBattleAction } from '@/lib/game/battle-runner'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { prepareAction } from '@/lib/game/targeting'
import type { BattleState } from '@/lib/game/turn'
import {
  applySemanticMovementFamilyGraph,
  buildMovementFamilyGraph,
  MOVEMENT_FAMILY_SKILL_IDS,
  runSemanticMovementFamilyMigrations,
} from '@/scripts/migrate-semantic-movement-family'
import { makePiece, makeState } from '../helpers/minimal-state'

type JsonRecord = Record<string, any>
const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')) as {
  entries: Record<string, JsonRecord>
  baseSha?: string
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }

function definition(id: (typeof MOVEMENT_FAMILY_SKILL_IDS)[number], semantic: boolean): JsonRecord {
  const frozen = fixture.entries[id]
  if (!frozen) throw new Error(`missing frozen fixture entry ${id}`)
  return semantic
    ? applySemanticMovementFamilyGraph(clone(frozen), buildMovementFamilyGraph(id))
    : clone(frozen)
}

function markForAkaza(sourceId: string): any {
  return {
    id: `akaza-damaged-by:${sourceId}`,
    type: 'akaza-damaged',
    sourceId,
    visible: false,
    remainingDuration: -1,
    currentDuration: -1,
  }
}

function movementFixture(id: string, scenario: string, semantic: boolean): { battle: BattleState; definition: JsonRecord } {
  const source = makePiece({
    instanceId: 'source', templateId: id === 'akaza-flash-step' ? 'dark-akaza' : 'red-source',
    name: id === 'akaza-flash-step' ? '猗窝座' : '施放者', ownerPlayerId: 'player-red', faction: 'red',
    x: 2, y: 2, currentHp: 20, maxHp: 20, attack: 4,
    skills: [{ skillId: id, currentCooldown: 0, usesRemaining: -1 }],
  }) as any
  const ally = makePiece({ instanceId: 'ally', templateId: 'red-ally', name: '友军', ownerPlayerId: 'player-red', faction: 'red', x: 3, y: 2 }) as any
  const enemy = makePiece({ instanceId: 'enemy', templateId: 'blue-enemy', name: '敌军', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 2 }) as any
  if (id === 'akaza-flash-step') enemy.statusTags = [markForAkaza(source.instanceId)]
  if (id === 'shadow-step-teleport') {
    source.statusTags = [{ id: 'shadow-step-tag', type: 'shadow-step', name: '暗影步', remainingDuration: 2, value: 3, intensity: 2, relatedRules: ['rule-shadow-step'] }]
  }
  if (id === 'shadow-step' && scenario === 'refresh') {
    source.statusTags = [{ id: 'shadow-step-tag', type: 'shadow-step', name: '暗影步', remainingDuration: 1, value: 1, intensity: 1, relatedRules: ['rule-shadow-step'] }]
    source.rules = [{ id: 'rule-shadow-step' }]
  }

  const battle = makeState({ pieces: [source, ally, enemy], width: 9, height: 9, currentPlayerId: 'player-red', phase: 'action' }) as any
  if (id === 'shadow-step-teleport' && scenario === 'wrong-player') battle.turn.currentPlayerId = 'player-blue'
  const skill = definition(`skills/${id}` as (typeof MOVEMENT_FAMILY_SKILL_IDS)[number], semantic)
  battle.skillsById[id] = skill
  battle.players[0].actionPoints = 5

  let targetPosition: { x: number; y: number } | null = null
  let target: any = null
  let targets: Array<{ info: any; pos: { x: number; y: number } | null }> = []
  if (id === 'shadow-step') {
    targetPosition = scenario === 'normal' || scenario === 'refresh' ? { x: 3, y: 2 } : scenario === 'invalid' ? { x: 20, y: 20 } : { x: 4, y: 2 }
    targets = [{ info: null, pos: targetPosition }]
  } else if (id === 'shadow-step-teleport') {
    targetPosition = null
    if (scenario === 'invalid') battle.map.tiles.find((tile: any) => tile.x === 3 && tile.y === 2)!.props.walkable = false
  } else if (id === 'obito-ally-teleport') {
    target = scenario === 'invalid' ? enemy : ally
    targetPosition = scenario === 'normal' ? { x: 3, y: 3 } : { x: 4, y: 2 }
    targets = [{ info: target, pos: null }, { info: null, pos: targetPosition }]
  } else if (id === 'obito-space-time') {
    target = scenario === 'invalid' ? ally : enemy
    targets = [{ info: target, pos: null }]
  } else if (id === 'akaza-flash-step') {
    target = enemy
    targetPosition = scenario === 'normal' ? { x: 5, y: 2 } : scenario === 'invalid' ? { x: 6, y: 4 } : scenario === 'unchanged' ? { x: 2, y: 2 } : { x: 5, y: 2 }
    targets = [{ info: target, pos: null }, { info: null, pos: targetPosition }]
  }

  if (scenario === 'blocked' && ['shadow-step-teleport', 'obito-ally-teleport', 'akaza-flash-step'].includes(id)) {
    globalTriggerSystem.addRule({
      id: `movement-family-block-${id}`, name: '测试阻挡', description: '',
      trigger: { type: 'beforePiecePositionChange' },
      effect: () => ({ success: true, blocked: true, message: '测试阻挡' }),
    } as any)
  }
  if (scenario === 'invalid' && id === 'akaza-flash-step') {
    target.statusTags = []
  }

  const context: any = {
    piece: source,
    skill,
    battle,
    target,
    targetPosition,
    targets,
    playerId: id === 'shadow-step-teleport' && scenario === 'wrong-player' ? 'player-blue' : 'player-red',
  }
  ;(battle as any).__movementContext = context
  return { battle, definition: skill }
}

function runDirect(id: string, semantic: boolean, scenario: string) {
  const { battle, definition: skill } = movementFixture(id, scenario, semantic)
  const context = (battle as any).__movementContext
  try {
    const result = executeSkillFunction(skill as any, context, battle)
    return { result, state: snapshot(battle) }
  } finally {
    globalTriggerSystem.clearRules()
  }
}

function snapshot(battle: BattleState): JsonRecord {
  const normalizeStatus = (tag: any) => ({
    id: typeof tag.id === 'string' && tag.id.startsWith('shadow-step-') ? 'shadow-step-id' : tag.id,
    type: tag.type, sourceId: tag.sourceId, value: tag.value, intensity: tag.intensity,
    remainingDuration: tag.remainingDuration, currentDuration: tag.currentDuration,
  })
  return {
    pieces: battle.pieces.map((piece: any) => ({
      instanceId: piece.instanceId, x: piece.x, y: piece.y, currentHp: piece.currentHp, attack: piece.attack,
      statusTags: (piece.statusTags ?? []).map(normalizeStatus),
    })).sort((a, b) => a.instanceId.localeCompare(b.instanceId)),
    tileEffects: (battle.extensions?.tileEffects ?? []).map((effect: any) => ({ ...effect })).sort((a: any, b: any) => String(a.sourceId).localeCompare(String(b.sourceId))),
    removedPieces: clone(battle.extensions?.removedPieces ?? []),
    actions: (battle.actions ?? []).map((action: any) => ({ type: action.type, payload: action.payload })),
  }
}

describe('RED-252 movement-family semantic module graphs', () => {
  beforeEach(() => globalTriggerSystem.clearRules())

  it('compiles all five graphs from reusable descriptors', () => {
    for (const id of MOVEMENT_FAMILY_SKILL_IDS) {
      const graph = buildMovementFamilyGraph(id)
      expect(() => compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)).not.toThrow()
      const json = JSON.stringify(graph)
      expect(json).not.toMatch(/naruto|shadow-step-teleport|obito-space-time|akaza-flash-step/)
    }
  })

  it('preserves frozen targeting, previews, descriptions, and cluster metadata', () => {
    for (const id of MOVEMENT_FAMILY_SKILL_IDS) {
      const legacy = fixture.entries[id]
      const migrated = definition(id, true)
      expect(migrated.targeting).toEqual(legacy.targeting)
      expect(migrated.previewCode).toEqual(legacy.previewCode)
      expect(migrated.description).toEqual(legacy.description)
      expect(migrated.cluster).toEqual(legacy.cluster)
      expect(migrated.gameplayModules?.entries?.code?.compilerVersion).toBe('rvb-gameplay-module-compiler/v1')
    }
  })

  it('dry-runs all production-shaped migrations without writing files', () => {
    const root = process.cwd()
    const results = runSemanticMovementFamilyMigrations(root, fixture)
    expect(results).toHaveLength(5)
    expect(results.every(result => result.status === 'ready')).toBe(true)
  })

  for (const id of MOVEMENT_FAMILY_SKILL_IDS) {
    const short = id.slice('skills/'.length)
    const scenarios = short === 'shadow-step'
      ? ['normal', 'refresh', 'blocked', 'invalid']
      : short === 'shadow-step-teleport'
        ? ['normal', 'blocked', 'invalid', 'wrong-player']
        : short === 'obito-ally-teleport'
          ? ['normal', 'blocked', 'invalid']
          : short === 'obito-space-time'
            ? ['normal', 'invalid']
            : ['normal', 'blocked', 'invalid', 'unchanged']
    for (const scenario of scenarios) {
      it(`${short} ${scenario} matches frozen execution`, () => {
        const legacy = runDirect(short, false, scenario)
        const semantic = runDirect(short, true, scenario)
        expect(semantic).toEqual(legacy)
      })
    }
  }

  it('removes an Obito enemy through the real action host', () => {
    const source = makePiece({
      instanceId: 'obito', templateId: 'red-obito', name: '带土', ownerPlayerId: 'player-red', faction: 'red',
      x: 1, y: 1, skills: [{ skillId: 'obito-space-time', currentCooldown: 0, usesRemaining: 1 }],
    }) as any
    const enemy = makePiece({ instanceId: 'enemy', templateId: 'blue-enemy', name: '敌军', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 4 }) as any
    const state = makeState({ pieces: [source, enemy], width: 9, height: 9, currentPlayerId: 'player-red' }) as any
    const skill = definition('skills/obito-space-time', true)
    state.skillsById['obito-space-time'] = skill
    state.players[0].actionPoints = 5
    state.players[0].chargePoints = 3
    const baseAction = {
      type: 'useChargeSkill', playerId: 'player-red', pieceId: 'obito', skillId: 'obito-space-time',
    } as any
    const prepared = prepareAction(state, baseAction)
    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') throw new Error(`expected target selection, got ${prepared.kind}`)
    const first = runBattleAction(state, {
      ...baseAction,
      targetPieceId: 'enemy',
      selectionId: prepared.selectionId,
      stateRevision: prepared.stateRevision,
    } as any, { rootSeed: 252 })
    expect(first.state.pieces.some((piece: any) => piece.instanceId === 'enemy')).toBe(false)
    expect(first.state.extensions?.removedPieces).toContainEqual(expect.objectContaining({ instanceId: 'enemy', removedBySkillId: 'obito-space-time' }))
  })

  it('uses the frozen executable as the migration provenance boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-red252-movement-provenance-'))
    const file = join(root, 'data', 'skills', 'shadow-step.json')
    try {
      mkdirSync(join(root, 'data', 'skills'), { recursive: true })
      const current = clone(fixture.entries['skills/shadow-step'])
      current.code = `${current.code}\n// author edit`
      writeFileSync(file, JSON.stringify(current), 'utf8')
      const result = runSemanticMovementFamilyMigrations(root, fixture, ['skills/shadow-step'])[0]
      expect(result.status).toBe('blocked')
      expect(result.error).toMatch(/author executable differs from frozen baseline|generated code does not match/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('blocks a valid but unrelated module graph from overriding the migration input', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-red252-movement-graph-provenance-'))
    const file = join(root, 'data', 'skills', 'shadow-step.json')
    try {
      mkdirSync(join(root, 'data', 'skills'), { recursive: true })
      const alternate = clone(buildMovementFamilyGraph('skills/shadow-step')) as any
      // Changing the declared output port leaves a structurally valid graph
      // and generated document, while making its provenance differ from the
      // migration builder's frozen graph.
      alternate.outputs[0].name = 'alternate-result'
      const current = applySemanticMovementFamilyGraph(clone(fixture.entries['skills/shadow-step']), alternate)
      writeFileSync(file, JSON.stringify(current), 'utf8')
      const result = runSemanticMovementFamilyMigrations(root, fixture, ['skills/shadow-step'])[0]
      expect(result.status).toBe('blocked')
      expect(result.error).toMatch(/existing gameplay module graph differs from the frozen migration graph/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
