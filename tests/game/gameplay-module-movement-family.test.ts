/* eslint-disable @typescript-eslint/no-explicit-any -- frozen content differential fixtures. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, beforeEach, vi } from 'vitest'

import { compileGameplayModuleGraph, GAMEPLAY_MODULE_COMPILER_VERSION } from '@/lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '@/lib/skill-graph/module-registry'
import { dealDamage, executeSkillFunction } from '@/lib/game/skills'
import { runBattleAction } from '@/lib/game/battle-runner'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { recordBattlePresentation, recordedBattlePresentation } from '@/lib/game/battle-presentation-recording'
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
const VENOM_MOVEMENT_IDS = new Set(['venom-host-transfer', 'venom-symbiote-drag'])
const EXTENDED_MOVEMENT_IDS = new Set([
  'sonic-spin-dash', 'sonic-homing-attack', 'shadow-ride-sweep',
  'illidan-blade-dash', 'mortis-shovel-charge', 'el-primo-elbow',
  'edgar-pogo-jump', 'max-phase-shifter', 'alfonso-kick', 'alfonso-water-dash', 'rocket-punch', 'muzan-demon-body',
])
const BLOCKED_MOVEMENT_IDS = new Set([
  'sonic-spin-dash', 'sonic-homing-attack', 'shadow-ride-sweep',
  'illidan-blade-dash', 'mortis-shovel-charge', 'el-primo-elbow',
  'edgar-pogo-jump', 'max-phase-shifter', 'alfonso-water-dash', 'rocket-punch', 'muzan-demon-body',
])
const SOURCE_DEATH_MOVEMENT_IDS = new Set([
  'sonic-spin-dash', 'sonic-homing-attack', 'illidan-blade-dash',
  'mortis-shovel-charge', 'el-primo-elbow',
  'edgar-pogo-jump', 'max-phase-shifter', 'alfonso-water-dash', 'rocket-punch',
])
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
  const ally = makePiece({ instanceId: 'ally', templateId: 'red-ally', name: '友军', ownerPlayerId: 'player-red', faction: 'red', x: (EXTENDED_MOVEMENT_IDS.has(id) || VENOM_MOVEMENT_IDS.has(id)) ? 1 : 3, y: (EXTENDED_MOVEMENT_IDS.has(id) || VENOM_MOVEMENT_IDS.has(id)) ? 1 : 2 }) as any
  const muzanPathEnemy = makePiece({ instanceId: 'muzan-path-enemy', templateId: 'blue-muzan-path-enemy', name: '路径敌军', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 2, currentHp: 20, maxHp: 20 }) as any
  const enemy = makePiece({ instanceId: 'enemy', templateId: 'blue-enemy', name: '敌军', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 2 }) as any
  const bounceEnemy = makePiece({ instanceId: 'bounce-enemy', templateId: 'blue-bounce-enemy', name: '弹跳敌军', ownerPlayerId: 'player-blue', faction: 'blue', x: 6, y: 2, currentHp: 20 }) as any
  const rewrittenEnemy = makePiece({ instanceId: 'rewritten-enemy', templateId: 'blue-rewritten-enemy', name: '改写敌军', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 3, currentHp: 20 }) as any
  source.name = '施放者'
  ally.name = '友军'
  enemy.name = '敌军'
  if (scenario === 'death' && EXTENDED_MOVEMENT_IDS.has(id)) enemy.currentHp = 1
  if (id === 'muzan-demon-body' && scenario === 'death') enemy.currentHp = 1
  if (scenario === 'source-death' && SOURCE_DEATH_MOVEMENT_IDS.has(id)) enemy.currentHp = 20
  if (scenario === 'miss' && id === 'alfonso-kick') enemy.currentHp = 0
  if (id === 'venom-symbiote-drag' && scenario === 'empty') enemy.currentHp = 0
  if (id === 'venom-symbiote-drag' && ['ally', 'landing-blocked'].includes(scenario)) {
    ally.x = 3
    ally.y = 2
  }
  if (id === 'sonic-homing-attack' && scenario === 'invalid') {
    enemy.x = 4
    enemy.y = 3
  }
  if (id === 'sonic-homing-attack' && scenario === 'rewritten-diagonal') {
    enemy.x = 4
    enemy.y = 3
  }
  if (id === 'sonic-homing-attack' && scenario === 'source-landing') {
    enemy.x = 3
    enemy.y = 2
  }
  if (id === 'akaza-flash-step') enemy.statusTags = [markForAkaza(source.instanceId)]
  if (id === 'shadow-step-teleport') {
    source.statusTags = [{ id: 'shadow-step-tag', type: 'shadow-step', name: '暗影步', remainingDuration: 2, value: 3, intensity: 2, relatedRules: ['rule-shadow-step'] }]
  }
  if (id === 'shadow-step' && scenario === 'refresh') {
    source.statusTags = [{ id: 'shadow-step-tag', type: 'shadow-step', name: '暗影步', remainingDuration: 1, value: 1, intensity: 1, relatedRules: ['rule-shadow-step'] }]
    source.rules = [{ id: 'rule-shadow-step' }]
  }
  if (id === 'max-phase-shifter' && scenario === 'recast') {
    source.statusTags = [{
      id: 'max-phase-recast-source', type: 'max-phase-recast', name: '相位偏移器·再次释放', visible: false,
      turnNumber: 1, currentDuration: 1, currentUses: 1, relatedRules: ['rule-max-phase-recast-expire'],
    }]
    source.rules = [{ id: 'rule-max-phase-recast-expire' }]
    source.skills[0].currentCooldown = 0
  }

  const pieces = [source, ally, ...(id === 'muzan-demon-body' ? [muzanPathEnemy] : []), enemy,
    ...(id === 'alfonso-water-dash' && scenario === 'bounce-chain' ? [bounceEnemy] : []),
    ...(id === 'sonic-homing-attack' && scenario === 'host-rewritten-diagonal' ? [rewrittenEnemy] : []),
  ]
  if (scenario === 'bounce-limit' || scenario === 'bounce-limit-no-landing') {
    // Dense candidates remain after the tenth bounce; no-landing candidates must count too.
    for (let y = 0; y < 7; y++) for (let x = 3; x < 8; x++) {
      if (pieces.some(piece => piece.x === x && piece.y === y)) continue
      pieces.push(makePiece({ instanceId: `dense-${x}-${y}`, templateId: 'blue-dense', name: '密集敌军',
        ownerPlayerId: 'player-blue', faction: 'blue', x, y, currentHp: 100, maxHp: 100 }) as any)
    }
  }
  const battle = makeState({ pieces, width: 9, height: 9, currentPlayerId: 'player-red', phase: 'action' }) as any
  if (scenario === 'bounce-limit-no-landing') for (const tile of battle.map.tiles) tile.props.walkable = false

  if (id === 'venom-symbiote-drag' && scenario === 'terrain') {
    const tile = battle.map.tiles.find((entry: any) => entry.x === 3 && entry.y === 2)
    if (tile) { tile.props.type = 'wall'; tile.props.walkable = false; tile.props.bulletPassable = false }
  }

  if (id === 'sonic-homing-attack' && scenario === 'source-landing') {
    for (const cell of [[3, 1], [4, 2], [3, 3]]) {
      const tile = battle.map.tiles.find((entry: any) => entry.x === cell[0] && entry.y === cell[1])
      if (tile) tile.props.walkable = false
    }
  }
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
  } else if (id === 'sonic-homing-attack') {
    target = enemy
    targets = [{ info: target, pos: null }]
  } else if (id === 'muzan-demon-body') {
    targetPosition = scenario === 'invalid' ? { x: 4, y: 3 } : { x: 5, y: 2 }
    targets = [{ info: null, pos: targetPosition }]
  } else if (id === 'venom-host-transfer') {
    target = ['self', 'mirror'].includes(scenario) ? source : scenario === 'ally' ? ally : enemy
    targets = [{ info: target, pos: null }]
  } else if (id === 'venom-symbiote-drag') {
    targetPosition = scenario === 'invalid' ? { x: 6, y: 4 }
      : scenario === 'empty' ? { x: 6, y: 2 }
        : scenario === 'zero' ? { x: 2, y: 2 }
          : { x: 6, y: 2 }
    targets = [{ info: null, pos: targetPosition }]
  } else if (EXTENDED_MOVEMENT_IDS.has(id)) {
    if (id === 'max-phase-shifter') targetPosition = scenario === 'invalid' ? { x: 3, y: 3 } : { x: 3, y: 2 }
    else targetPosition = scenario === 'invalid' ? { x: 5, y: 4 } : { x: 5, y: 2 }
    targets = [{ info: null, pos: targetPosition }]
  }
  if (id === 'edgar-pogo-jump' && scenario === 'invalid') {
    const tile = battle.map.tiles.find((entry: any) => entry.x === targetPosition?.x && entry.y === targetPosition?.y)
    if (tile) tile.props.walkable = false
  }

  if (scenario === 'blocked' && ['shadow-step-teleport', 'obito-ally-teleport', 'akaza-flash-step', ...BLOCKED_MOVEMENT_IDS, ...VENOM_MOVEMENT_IDS].includes(id)) {
    globalTriggerSystem.addRule({
      id: `movement-family-block-${id}`, name: '测试阻挡', description: '',
      trigger: { type: 'beforePiecePositionChange' },
      effect: (battle: any, context: any) => {
        if (context.sourcePiece?.instanceId === 'source' || (id === 'venom-symbiote-drag' && context.sourcePiece?.instanceId === 'enemy')) {
          battle.extensions ??= {}
          const probe = battle.extensions.movementFamilyProbe ?? { blockedTriggerCount: 0 }
          probe.blockedTriggerCount = Number(probe.blockedTriggerCount ?? 0) + 1
          battle.extensions.movementFamilyProbe = probe
        }
        return { success: true, blocked: true, message: '测试阻挡' }
      },
    } as any)
  }
  if (['rewritten-diagonal', 'host-rewritten-diagonal'].includes(scenario) && id === 'sonic-homing-attack') {
    globalTriggerSystem.addRule({
      id: 'movement-family-rewrite-sonic-homing', name: '测试目标改写', description: '',
      trigger: { type: 'beforeSkillUse' },
      effect: (_battle: any, context: any) => context.skillId === id
        ? { success: true, targetReplacementPieceId: scenario === 'host-rewritten-diagonal' ? 'rewritten-enemy' : 'enemy' }
        : { success: true },
    } as any)
  }
  if (scenario === 'source-death' && SOURCE_DEATH_MOVEMENT_IDS.has(id)) {
    globalTriggerSystem.addRule({
      id: `movement-family-source-death-${id}`, name: '测试位移途中施法者死亡', description: '',
      trigger: { type: 'beforePiecePositionChange' },
      effect: (battle: any, context: any) => {
        if (context.sourcePiece?.instanceId !== 'source') return { success: true }
        const source = context.sourcePiece
        const killer = battle.pieces.find((piece: any) => piece.instanceId === 'enemy')
        if (!killer || source.currentHp <= 0) return { success: true }
        const damage = dealDamage(killer, source, source.currentHp + 99, 'true', battle, `movement-family-source-death-${id}`)
        battle.extensions ??= {}
        battle.extensions.movementFamilyProbe = {
          ...(battle.extensions.movementFamilyProbe ?? {}),
          sourceDeathTrigger: context.type,
          lethalDamage: damage.damage,
        }
        return { success: true, message: '位移前置反应使施法者死亡' }
      },
    } as any)
  }
  if (id === 'venom-host-transfer' && ['source-death', 'target-death'].includes(scenario)) {
    globalTriggerSystem.addRule({
      id: `movement-family-venom-${scenario}`,
      name: '测试宿主转移后死亡',
      description: '',
      trigger: { type: 'afterPiecePositionChange' },
      effect: (battle: any, context: any) => {
        if (context.sourcePiece?.instanceId !== 'source') return { success: true }
        const victimId = scenario === 'source-death' ? 'source' : 'enemy'
        const victim = battle.pieces.find((piece: any) => piece.instanceId === victimId)
        const attackerId = scenario === 'source-death' ? 'enemy' : 'source'
        const attacker = battle.pieces.find((piece: any) => piece.instanceId === attackerId)
        if (!victim || !attacker || victim.currentHp <= 0 || attacker.currentHp <= 0) return { success: true }
        const damage = dealDamage(attacker, victim, victim.currentHp + 99, 'true', battle, `movement-family-venom-${scenario}`)
        battle.extensions ??= {}
        battle.extensions.movementFamilyProbe = {
          ...(battle.extensions.movementFamilyProbe ?? {}),
          venomDeathTrigger: context.type,
          venomDeathVictim: victimId,
          venomDeathDamage: damage.damage,
        }
        return { success: true, message: `宿主转移后${victimId}死亡` }
      },
    } as any)
  }
  if (id === 'muzan-demon-body' && scenario === 'source-death') {
    globalTriggerSystem.addRule({
      id: 'movement-family-muzan-reflection', name: '测试无惨反伤', description: '',
      trigger: { type: 'afterDamageDealt' },
      effect: (battle: any, context: any) => {
        if (context.skillId !== id || context.sourcePiece?.instanceId !== 'source' || context.targetPiece?.instanceId !== 'muzan-path-enemy') return { success: true }
        battle.extensions ??= {}
        const prior = battle.extensions.movementFamilyProbe ?? {}
        if (prior.muzanReflectionTriggered) return { success: true }
        const source = context.sourcePiece
        const target = context.targetPiece
        battle.extensions.movementFamilyProbe = { ...prior, muzanReflectionTriggered: true }
        const reflectionDamage = source.currentHp + 99
        context.damageQueue.push({ attacker: target, target: source, damage: reflectionDamage, damageType: 'true', skillId: 'movement-family-muzan-reflection' })
        battle.extensions.movementFamilyProbe = {
          ...(battle.extensions.movementFamilyProbe ?? {}),
          muzanReflectionDamage: reflectionDamage,
        }
        return { success: true, message: '路径反伤使无惨死亡' }
      },
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
    ruleRewrittenPrimaryTargetPieceId: id === 'sonic-homing-attack' && scenario === 'rewritten-diagonal' ? 'enemy'
      : id === 'venom-host-transfer' && scenario === 'mirror' ? 'source' : undefined,
  }
  ;(battle as any).__movementContext = context
  return { battle, definition: skill }
}

function runDirect(id: string, semantic: boolean, scenario: string) {
  const { battle, definition: skill } = movementFixture(id, scenario, semantic)
  const context = (battle as any).__movementContext
  const runtime = new RuleRuntime({ rootSeed: 594 })
  try {
    return withRuleRuntime(runtime, () => {
      const result = recordBattlePresentation(
        battle,
        () => executeSkillFunction(skill as any, context, battle),
        () => battle,
      )
      return {
        result,
        state: snapshot(battle),
        runtime: runtime.snapshot(),
        presentation: clone(recordedBattlePresentation(battle) ?? []),
      }
    })
  } finally {
    globalTriggerSystem.clearRules()
  }
}

function snapshot(battle: BattleState): JsonRecord {
  delete (battle as any).__movementContext
  const state = JSON.parse(JSON.stringify(battle)) as JsonRecord
  delete state.skillsById
  return state
}

function runRealHost(id: string, semantic: boolean, scenario: string) {
  const { battle } = movementFixture(id, scenario, semantic)
  if (['el-primo-elbow', 'edgar-pogo-jump', 'alfonso-water-dash'].includes(id)) battle.players[0].chargePoints = 3
  const baseAction: any = {
    type: ['el-primo-elbow', 'edgar-pogo-jump', 'alfonso-water-dash'].includes(id) ? 'useChargeSkill' : 'useBasicSkill',
    playerId: 'player-red', pieceId: 'source', skillId: id,
  }
  const selected = prepareAction(battle, baseAction)
  if (selected.kind !== 'needTarget') throw new Error(`${id}/${scenario}: expected target selection, got ${selected.kind}`)
  delete (battle as any).__movementContext
  const action = ['sonic-homing-attack', 'venom-host-transfer'].includes(id)
    ? { ...baseAction, targetPieceId: 'enemy' }
    : { ...baseAction, targetX: id === 'max-phase-shifter' ? 3 : id === 'venom-symbiote-drag' ? 6 : 5, targetY: 2 }
  const expectedReject = id === 'sonic-spin-dash' && scenario === 'blocked'
  try {
    const result = recordBattlePresentation(
      battle,
      () => runBattleAction(battle, {
        ...action,
        selectionId: selected.selectionId,
        stateRevision: selected.stateRevision,
      } as any, { rootSeed: 594 }),
      outcome => outcome.state,
    )
    if (expectedReject) throw new Error(`${id}/${scenario}: expected the host action to reject`)
    const actionLog = result.state.actions ?? []
    const skillAction = actionLog.find(entry => entry.type === action.type && entry.payload?.skillId === id)
    const movementActions = actionLog.filter(entry => entry.type === 'positionChanged')
    const damageActions = actionLog.filter(entry => entry.type === 'damage' && entry.payload?.skillId === id)
    return {
      state: snapshot(result.state),
      stateHash: result.stateHash,
      actionHash: result.actionHash,
      trace: result.trace,
      presentation: clone(recordedBattlePresentation(result.state) ?? []),
      skillAction: skillAction ? { type: skillAction.type, payload: skillAction.payload } : undefined,
      movementActions: movementActions.map(entry => ({ type: entry.type, payload: entry.payload })),
      damageActions: damageActions.map(entry => ({ type: entry.type, payload: entry.payload })),
      rejected: false,
    }
  } catch (error) {
    if (!expectedReject) throw error
    return {
      error: error instanceof Error ? error.message : String(error),
      state: snapshot(battle),
      presentation: [],
      rejected: true,
    }
  } finally {
    globalTriggerSystem.clearRules()
  }
}

describe('RED-252 movement-family semantic module graphs', () => {
  beforeEach(() => globalTriggerSystem.clearRules())

  it('compiles all nineteen graphs from reusable descriptors', () => {
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
      expect(migrated.gameplayModules?.entries?.code?.compilerVersion).toBe(GAMEPLAY_MODULE_COMPILER_VERSION)
    }
  })

  it('dry-runs all production-shaped migrations without writing files', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-red252-movement-dry-run-'))
    try {
      mkdirSync(join(root, 'data', 'skills'), { recursive: true })
      for (const id of MOVEMENT_FAMILY_SKILL_IDS) {
        const short = id.slice('skills/'.length)
        writeFileSync(join(root, 'data', 'skills', `${short}.json`), JSON.stringify(clone(fixture.entries[id])), 'utf8')
      }
      const results = runSemanticMovementFamilyMigrations(root, fixture)
      expect(results).toHaveLength(19)
      expect(results.every(result => result.status === 'ready')).toBe(true)
      expect(readFileSync(join(root, 'data', 'skills', 'sonic-spin-dash.json'), 'utf8')).toEqual(expect.not.stringContaining('rvb-gameplay-module-document'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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
              : short === 'max-phase-shifter'
                ? ['normal', 'recast', 'blocked', 'death', 'source-death', 'invalid']
              : short === 'alfonso-water-dash'
                ? ['normal', 'blocked', 'death', 'source-death', 'invalid', 'bounce-chain', 'bounce-limit', 'bounce-limit-no-landing']
              : short === 'muzan-demon-body'
                ? ['normal', 'blocked', 'death', 'source-death', 'invalid']
              : short === 'venom-host-transfer'
                ? ['normal', 'blocked', 'self', 'mirror', 'invalid', 'ally', 'source-death', 'target-death']
              : short === 'venom-symbiote-drag'
                ? ['normal', 'blocked', 'invalid', 'ally', 'terrain', 'empty', 'landing-blocked', 'zero']
      : short === 'alfonso-kick'
        ? ['normal', 'death', 'miss']
        : EXTENDED_MOVEMENT_IDS.has(short)
              ? (short === 'sonic-homing-attack'
                ? ['normal', 'blocked', 'death', 'invalid', 'rewritten-diagonal', 'source-landing']
                : [...['normal', 'blocked', 'death', 'invalid'], ...(SOURCE_DEATH_MOVEMENT_IDS.has(short) ? ['source-death'] : [])])
              : ['normal', 'blocked', 'invalid', 'unchanged']
    for (const scenario of scenarios) {
      it(`${short} ${scenario} matches frozen execution`, () => {
        const legacy = runDirect(short, false, scenario)
        const semantic = runDirect(short, true, scenario)
        expect(semantic).toEqual(legacy)
      })
    }
  }

  for (const scenario of ['bounce-limit', 'bounce-limit-no-landing']) {
    it(`water dash ${scenario} finishes ten bounces in a real transaction`, () => {
      const legacy = runRealHost('alfonso-water-dash', false, scenario)
      const semantic = runRealHost('alfonso-water-dash', true, scenario)
      expect(semantic).toEqual(legacy)
      expect(semantic.rejected).toBe(false)
      expect(semantic.skillAction).toBeDefined()
    })
  }

  for (const id of EXTENDED_MOVEMENT_IDS) for (const scenario of (id === 'alfonso-kick' ? ['normal', 'death'] : ['normal', 'blocked', 'death'])) {
    it(`${id} ${scenario} matches through the real action host at seed 594`, () => {
      const semantic = runRealHost(id, true, scenario)
      const legacy = runRealHost(id, false, scenario)
      expect(semantic).toEqual(legacy)
      if (scenario === 'blocked' && id === 'sonic-spin-dash') {
        expect(semantic.rejected).toBe(true)
        expect(semantic.error).toMatch(/位移被阻挡/)
      } else {
        expect(semantic.rejected).not.toBe(true)
      }
      if (scenario === 'normal') {
        expect(semantic.skillAction).toMatchObject({ type: ['el-primo-elbow', 'edgar-pogo-jump', 'alfonso-water-dash'].includes(id) ? 'useChargeSkill' : 'useBasicSkill', payload: { skillId: id } })
        if (id === 'alfonso-kick') {
          expect(semantic.movementActions ?? []).toHaveLength(0)
        } else {
          expect(semantic.movementActions ?? []).toEqual(expect.arrayContaining([
            expect.objectContaining({ payload: expect.objectContaining({ pieceId: 'source' }) }),
          ]))
          expect((semantic.movementActions ?? []).some((entry: any) => entry.payload.fromX !== entry.payload.toX || entry.payload.fromY !== entry.payload.toY)).toBe(true)
        }
        if (id !== 'max-phase-shifter') expect((semantic.damageActions ?? []).some((entry: any) => Number(entry.payload.finalDamage) > 0)).toBe(true)
        expect(semantic.presentation.length).toBeGreaterThan(0)
      } else if (scenario === 'blocked' && id !== 'sonic-spin-dash') {
        expect(semantic.state.extensions?.movementFamilyProbe?.blockedTriggerCount).toBeGreaterThan(0)
        expect(semantic.movementActions ?? []).toHaveLength(0)
      }
    })
  }

  for (const id of BLOCKED_MOVEMENT_IDS) {
    it(`${id} blocked movement records the trigger and commits no displacement`, () => {
      const legacy = runDirect(id, false, 'blocked')
      const semantic = runDirect(id, true, 'blocked')
      expect(semantic).toEqual(legacy)
      expect(semantic.state.extensions?.movementFamilyProbe?.blockedTriggerCount).toBeGreaterThan(0)
      expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'source')).toMatchObject({ x: 2, y: 2 })
      expect(semantic.state.actions?.some((action: any) => action.type === 'positionChanged' && action.payload?.pieceId === 'source')).toBe(false)
    })
  }

  it('allows a rewritten diagonal homing target while rejecting an ordinary diagonal target', () => {
    const ordinary = runDirect('sonic-homing-attack', true, 'invalid')
    expect(ordinary.result).toEqual({ success: false, message: '请选择正方向内的敌人' })
    expect(ordinary.state.actions?.some((action: any) => action.type === 'damage' && action.payload?.skillId === 'sonic-homing-attack')).toBe(false)

    const rewritten = runDirect('sonic-homing-attack', true, 'rewritten-diagonal')
    expect(rewritten.result).toMatchObject({ success: true })
    expect(rewritten.state.pieces.find((piece: any) => piece.instanceId === 'source')).not.toMatchObject({ x: 2, y: 2 })
    expect(rewritten.state.actions?.some((action: any) => action.type === 'damage'
      && action.payload?.skillId === 'sonic-homing-attack' && Number(action.payload?.finalDamage) > 0)).toBe(true)
  })

  it('executes water-dash bounce selection as a graph loop with multiple live enemies', () => {
    const legacy = runDirect('alfonso-water-dash', false, 'bounce-chain')
    const semantic = runDirect('alfonso-water-dash', true, 'bounce-chain')
    expect(semantic).toEqual(legacy)
    expect(semantic.result).toEqual({ success: true, message: '施放者惊鸿掠水，共命中2名敌人' })
    const damageActions = semantic.state.actions?.filter((action: any) => action.type === 'damage' && action.payload?.skillId === 'alfonso-water-dash') ?? []
    expect(damageActions).toHaveLength(2)
    expect(new Set(damageActions.map((action: any) => action.payload?.targetId))).toEqual(new Set(['enemy', 'bounce-enemy']))
    expect(semantic.runtime.cursors['skill/effect']).toBeGreaterThanOrEqual(2)
  })

  it('carries the rewritten diagonal homing target through the real action host', () => {
    const semantic = runRealHost('sonic-homing-attack', true, 'host-rewritten-diagonal')
    const legacy = runRealHost('sonic-homing-attack', false, 'host-rewritten-diagonal')
    expect(semantic).toEqual(legacy)
    expect(semantic.rejected).not.toBe(true)
    expect(semantic.skillAction).toMatchObject({ type: 'useBasicSkill', payload: { skillId: 'sonic-homing-attack' } })
    expect((semantic.movementActions ?? []).some((entry: any) => entry.payload.fromX !== entry.payload.toX || entry.payload.fromY !== entry.payload.toY)).toBe(true)
    expect((semantic.damageActions ?? []).some((entry: any) => Number(entry.payload.finalDamage) > 0)).toBe(true)
    expect(semantic.presentation.length).toBeGreaterThan(0)
  })

  it('preserves the legacy strict projectile error while isolating v2 diagonal alfonso kick input', () => {
    expect(() => runDirect('alfonso-kick', false, 'invalid')).toThrow('Projectile direction must be one cardinal unit vector')
    const diagnostics: any[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: any[]) => {
      if (args[0] === '[gameplay-module-diagnostic]') diagnostics.push(args[1])
    })
    const semantic = runDirect('alfonso-kick', true, 'invalid')
    consoleError.mockRestore()
    expect(semantic.result).toEqual({ success: false, message: '请选择正方向' })
    expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'source')).toMatchObject({ x: 2, y: 2, currentHp: 20 })
    expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'enemy')?.currentHp).toBe(100)
    expect(semantic.state.actions).toEqual([])
    expect(semantic.presentation).toEqual([])
    expect(diagnostics).toEqual([
      expect.objectContaining({
        statementId: 'trace',
        moduleId: 'projectile.trace-strict',
        message: 'Projectile direction must be one cardinal unit vector',
        errorName: 'RangeError',
        surface: 'skill',
        contentId: 'alfonso-kick',
        actorPlayerId: 'player-red',
        turn: 1,
        phase: 'action',
        rootSeed: 594,
      }),
    ])
  })

  for (const id of VENOM_MOVEMENT_IDS) for (const scenario of ['normal', 'blocked']) {
    it(`${id} ${scenario} matches through the real action host with presentation`, () => {
      const semantic = runRealHost(id, true, scenario)
      const legacy = runRealHost(id, false, scenario)
      expect(semantic).toEqual(legacy)
      expect(semantic.rejected).toBe(false)
      if (scenario === 'normal') {
        expect(semantic.presentation.length).toBeGreaterThan(0)
        expect(semantic.skillAction).toMatchObject({ type: 'useBasicSkill', payload: { skillId: id } })
        expect((semantic.movementActions ?? []).some((entry: any) => entry.payload?.fromX !== entry.payload?.toX || entry.payload?.fromY !== entry.payload?.toY)).toBe(true)
        if (id === 'venom-host-transfer') {
          expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'source')).toMatchObject({ x: 4, y: 2 })
          expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'enemy')).toMatchObject({ x: 2, y: 2 })
        } else {
          expect((semantic.movementActions ?? []).some((entry: any) => entry.payload?.pieceId === 'enemy')).toBe(true)
          expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'enemy')?.statusTags).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'root', sourceId: 'source' })]))
        }
      } else {
        expect(semantic.state.extensions?.movementFamilyProbe?.blockedTriggerCount).toBeGreaterThan(0)
        expect(semantic.movementActions).toHaveLength(0)
      }
    })
  }

  for (const scenario of ['source-death', 'target-death']) {
    it(`venom-host-transfer ${scenario} preserves the full post-swap lifecycle`, () => {
      const legacy = runDirect('venom-host-transfer', false, scenario)
      const semantic = runDirect('venom-host-transfer', true, scenario)
      expect(semantic).toEqual(legacy)
      expect(semantic.result).toMatchObject({ success: true })
      expect(semantic.result.message).toContain('发动宿主转移')
      expect(semantic.state.extensions?.movementFamilyProbe).toMatchObject({
        venomDeathTrigger: 'afterPiecePositionChange',
        venomDeathVictim: scenario === 'source-death' ? 'source' : 'enemy',
      })
      expect(semantic.presentation.length).toBeGreaterThan(0)
      const victimId = scenario === 'source-death' ? 'source' : 'enemy'
      expect(semantic.state.graveyard?.some((piece: any) => piece.instanceId === victimId && piece.currentHp === 0)).toBe(true)
      if (scenario === 'source-death') {
        expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'enemy')?.statusTags).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: 'root', sourceId: 'source' })]),
        )
      } else {
        expect(semantic.state.graveyard?.find((piece: any) => piece.instanceId === 'enemy')?.statusTags ?? []).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ type: 'root', sourceId: 'source' })]),
        )
      }
    })
  }

  for (const id of SOURCE_DEATH_MOVEMENT_IDS) {
    it(`${id} stops after a real beforePiecePositionChange source death`, () => {
      const legacy = runDirect(id, false, 'source-death')
      const semantic = runDirect(id, true, 'source-death')
      expect(semantic).toEqual(legacy)
      expect(semantic.state.pieces.some((piece: any) => piece.instanceId === 'source')).toBe(false)
      expect(semantic.state.graveyard?.some((piece: any) => piece.instanceId === 'source' && piece.currentHp === 0)).toBe(true)
      expect(semantic.state.extensions?.movementFamilyProbe).toMatchObject({ sourceDeathTrigger: 'beforePiecePositionChange' })
      expect(semantic.state.extensions?.movementFamilyProbe?.lethalDamage).toBeGreaterThan(0)
      expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'enemy')?.currentHp).toBe(id === 'alfonso-water-dash' ? 12 : 20)
      expect(semantic.state.actions?.filter((action: any) => action.type === 'damage' && action.payload?.skillId === id)).toHaveLength(id === 'alfonso-water-dash' ? 1 : 0)
      expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'enemy')?.statusTags ?? []).toHaveLength(0)
      expect(semantic.presentation).toEqual(legacy.presentation)
    })
  }

  it('muzan demon body keeps actual path order, continues after source reflection death, and skips reduction', () => {
    const legacy = runDirect('muzan-demon-body', false, 'source-death')
    const semantic = runDirect('muzan-demon-body', true, 'source-death')
    expect(semantic).toEqual(legacy)
    const damageActions = semantic.state.actions?.filter((action: any) => action.type === 'damage' && action.payload?.skillId === 'muzan-demon-body') ?? []
    expect(damageActions.map((action: any) => action.payload?.targetId)).toEqual(['muzan-path-enemy', 'enemy'])
    expect(semantic.state.pieces.some((piece: any) => piece.instanceId === 'source')).toBe(false)
    expect(semantic.state.graveyard?.some((piece: any) => piece.instanceId === 'source' && piece.currentHp === 0)).toBe(true)
    expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'enemy')?.currentHp).toBe(97)
    expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'muzan-path-enemy')?.currentHp).toBe(17)
    expect(semantic.state.graveyard?.find((piece: any) => piece.instanceId === 'source')?.statusTags ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'muzan-damage-reduction' })]))
    expect(semantic.state.extensions?.movementFamilyProbe).toMatchObject({ muzanReflectionTriggered: true, muzanReflectionDamage: 119 })
    expect(semantic.presentation.length).toBeGreaterThan(0)
  })

  it('muzan demon body preserves source-death continuation through the real action host', () => {
    const semantic = runRealHost('muzan-demon-body', true, 'source-death')
    const legacy = runRealHost('muzan-demon-body', false, 'source-death')
    expect(semantic).toEqual(legacy)
    expect(semantic.rejected).toBe(false)
    expect(semantic.skillAction).toMatchObject({ type: 'useBasicSkill', payload: { skillId: 'muzan-demon-body' } })
    expect(semantic.movementActions ?? []).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ pieceId: 'source' }) }),
    ]))
    expect((semantic.movementActions ?? []).some((entry: any) => entry.payload.fromX !== entry.payload.toX || entry.payload.fromY !== entry.payload.toY)).toBe(true)
    expect(semantic.damageActions?.map((entry: any) => entry.payload?.targetId)).toEqual(['muzan-path-enemy', 'enemy'])
    expect(semantic.state.pieces.some((piece: any) => piece.instanceId === 'source')).toBe(false)
    expect(semantic.state.graveyard?.some((piece: any) => piece.instanceId === 'source' && piece.currentHp === 0)).toBe(true)
    expect(semantic.state.graveyard?.find((piece: any) => piece.instanceId === 'source')?.statusTags ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'muzan-damage-reduction' })]))
    expect(semantic.presentation.length).toBeGreaterThan(0)
  })

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
