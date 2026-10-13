/* eslint-disable @typescript-eslint/no-explicit-any -- real-host projectile differential fixtures. */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { executeSkillFunction } from '@/lib/game/skills'
import { recordBattlePresentation, recordedBattlePresentation, recordedProjectilePaths } from '@/lib/game/battle-presentation-recording'
import { compileGameplayModuleGraph } from '@/lib/skill-graph/module-compiler'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { GAMEPLAY_MODULE_REGISTRY } from '@/lib/skill-graph/module-registry'
import { buildProjectileSkillGraph, PROJECTILE_SKILL_IDS } from '@/scripts/migrate-semantic-projectile-skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

const frozen = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries as Record<string, any>
const productionHandCannon = JSON.parse(readFileSync('data/skills/hand-cannon.json', 'utf8')) as any
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

function findModuleCall(value: unknown, moduleId: string): any {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findModuleCall(item, moduleId)
      if (match) return match
    }
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.kind === 'call' && record.module === moduleId) return record
  for (const child of Object.values(record)) {
    const match = findModuleCall(child, moduleId)
    if (match) return match
  }
  return undefined
}

function sourceDefinition(id: string): any {
  return clone(id === 'hand-cannon' ? productionHandCannon : frozen[`skills/${id}`])
}

function namedPiece(overrides: Parameters<typeof makePiece>[0]): any {
  const piece = makePiece(overrides) as any
  piece.name = overrides?.name ?? overrides?.instanceId ?? piece.instanceId
  return piece
}

function setTerrain(state: any, x: number, type: 'floor' | 'wall' | 'cover', bulletPassable: boolean): void {
  const tile = state.map.tiles.find((candidate: any) => candidate.x === x && candidate.y === 0)
  tile.props = { ...tile.props, type, walkable: type === 'floor' || type === 'cover', bulletPassable }
}

type Scenario = {
  pieces: any[]
  graveyard?: any[]
  width?: number
  height?: number
  currentPlayerId?: string
  targetPosition?: { x: number; y: number } | null
  target?: any
  playerContextId?: string
  playerStatusTags?: any[]
  hand?: any[]
  trigger?: any
  actions?: any[]
  removeSourceAfterDamage?: boolean
  blockedAt?: number
  extensions?: Record<string, any>
}

function scenarioFor(id: string, removeSourceAfterDamage = false): Scenario {
  const caster = namedPiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 0, y: 0, attack: 10, name: '施法者' })
  if (id === 'pulse-pistol') {
    const trigger = namedPiece({ instanceId: 'trigger', ownerPlayerId: 'player-blue', x: 4, y: 4, name: '触发敌人' })
    const enemyA = namedPiece({ instanceId: 'enemy-a', ownerPlayerId: 'player-blue', x: 1, y: 0, name: '敌人甲' })
    const enemyB = namedPiece({ instanceId: 'enemy-b', ownerPlayerId: 'player-blue', x: 2, y: 1, name: '敌人乙' })
    caster.x = 0
    caster.y = 0
    return { pieces: [caster, trigger, enemyA, enemyB], width: 6, trigger }
  }
  if (id === 'colt-piercing') {
    const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2, y: 0, currentHp: 6, name: '敌人' })
    return { pieces: [caster, enemy], width: 8, targetPosition: { x: 6, y: 0 } }
  }
  if (id === 'colt-revolver') {
    caster.statusTags = [{ id: 'colt-zone-caster', type: 'colt-zone', stacks: 1, intensity: 1 }]
    return { pieces: [caster], width: 6, targetPosition: { x: 5, y: 0 } }
  }
  if (id === 'shelly-super-shell') {
    const enemyA = namedPiece({ instanceId: 'enemy-a', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 12, name: '敌人甲' })
    const enemyB = namedPiece({ instanceId: 'enemy-b', ownerPlayerId: 'player-blue', x: 2, y: 0, currentHp: 40, name: '敌人乙' })
    return { pieces: [caster, enemyA, enemyB], width: 8, targetPosition: { x: 4, y: 0 }, removeSourceAfterDamage }
  }
  if (id === 'hand-cannon') {
    const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 3, name: '敌人' })
    return { pieces: [caster, enemy], width: 4, target: enemy, targetPosition: { x: 1, y: 0 } }
  }
  if (id === 'shadow-bolt') {
    caster.faction = 'red'
    const enemyA = namedPiece({ instanceId: 'enemy-a', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 0, currentHp: 30, name: '敌人甲' })
    const enemyB = namedPiece({ instanceId: 'enemy-b', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 0, currentHp: 30, name: '敌人乙' })
    return {
      pieces: [caster, enemyA, enemyB], width: 8, targetPosition: { x: 6, y: 0 },
      hand: [
        { cardId: 'soul-fragment', instanceId: 'fragment-a' },
        { cardId: 'other-card', instanceId: 'other-card' },
        { cardId: 'soul-fragment', instanceId: 'fragment-b' },
      ],
    }
  }
  if (id === 'shadow-chaos-spear') {
    caster.faction = 'red'
    caster.moveRange = 3
    const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 0, currentHp: 20, moveRange: 4, name: '敌人' })
    return { pieces: [caster, enemy], width: 6, target: enemy, targetPosition: { x: 2, y: 0 } }
  }
  if (id === 'sasuke-chidori') {
    caster.faction = 'red'
    const ally = namedPiece({ instanceId: 'ally', ownerPlayerId: 'player-red', faction: 'red', x: 1, y: 0, currentHp: 20, name: '友军' })
    const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 0, currentHp: 20, name: '敌人' })
    return { pieces: [caster, ally, enemy], width: 8, targetPosition: { x: 4, y: 0 } }
  }
  if (id === 'naruto-rasengan') {
    caster.faction = 'red'
    const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 1, y: 0, currentHp: 30, name: '敌人' })
    return { pieces: [caster, enemy], width: 4, target: enemy, targetPosition: { x: 1, y: 0 } }
  }
  if (id === 'aizen-black-coffin') {
    caster.faction = 'red'
    const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 0, currentHp: 30, name: '敌人' })
    return { pieces: [caster, enemy], width: 6, target: enemy, targetPosition: { x: 2, y: 0 } }
  }
  if (id === 'ulquiorra-cero') {
    const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2, y: 0, currentHp: 30, name: '敌人' })
    return { pieces: [caster, enemy], width: 6, target: enemy, targetPosition: { x: 2, y: 0 } }
  }
  if (id === 'akaza-disorder') {
    const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 30, name: '敌人' })
    return { pieces: [caster, enemy], width: 4, target: enemy, targetPosition: { x: 1, y: 0 } }
  }
  if (id === 'akaza-annihilation') {
    const enemyA = namedPiece({ instanceId: 'enemy-a', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 30, name: '敌人甲' })
    const enemyB = namedPiece({ instanceId: 'enemy-b', ownerPlayerId: 'player-blue', x: 2, y: 0, currentHp: 30, name: '敌人乙' })
    const enemyC = namedPiece({ instanceId: 'enemy-c', ownerPlayerId: 'player-blue', x: 4, y: 0, currentHp: 30, name: '敌人丙' })
    return { pieces: [caster, enemyA, enemyB, enemyC], width: 8, targetPosition: { x: 4, y: 0 } }
  }
  if (id === 'blizzard') {
    return { pieces: [caster], width: 8, targetPosition: { x: 2, y: 0 } }
  }
  if (id === 'blizzard-damage') {
    const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2, y: 0, currentHp: 20, name: '敌人' })
    return {
      pieces: [caster, enemy], width: 8, currentPlayerId: 'player-blue', playerContextId: 'player-red',
      playerStatusTags: [{ id: 'blizzard-test', type: 'blizzard', centerX: 2, centerY: 0, damage: 5 }],
    }
  }
  if (id === 'mortis-bat-support') {
    caster.currentHp = 50
    caster.skills = [{ skillId: 'mortis-bat-support', currentCooldown: 0 }]
    caster.statusTags = [{ id: 'mortis-counter', type: 'mortis-damage-counter', readyCharges: 1, intensity: 1 }]
    const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2, y: 0, currentHp: 20, name: '敌人' })
    return { pieces: [caster, enemy], width: 8, targetPosition: { x: 4, y: 0 } }
  }
  if (id === 'biotic-grenade') {
    const ally = namedPiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 1, y: 0, currentHp: 5, maxHp: 10, name: '友军' })
    const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2, y: 0, currentHp: 9, maxHp: 10, name: '敌人' })
    return { pieces: [caster, ally, enemy], width: 6, height: 2, targetPosition: { x: 1, y: 0 } }
  }
  if (id === 'earthshatter') {
    const enemyA = namedPiece({ instanceId: 'enemy-a', ownerPlayerId: 'player-blue', x: 3, y: 0, currentHp: 30, name: '敌人甲' })
    const enemyB = namedPiece({ instanceId: 'enemy-b', ownerPlayerId: 'player-blue', x: 5, y: 0, currentHp: 30, name: '敌人乙' })
    return { pieces: [caster, enemyA, enemyB], width: 8, height: 1, targetPosition: { x: 4, y: 0 } }
  }
  if (id === 'muzan-blood-whip') {
    caster.x = 3
    caster.y = 3
    const enemyRight = namedPiece({ instanceId: 'enemy-right', ownerPlayerId: 'player-blue', x: 4, y: 3, currentHp: 30, name: '右侧敌人' })
    const enemyLeft = namedPiece({ instanceId: 'enemy-left', ownerPlayerId: 'player-blue', x: 2, y: 3, currentHp: 30, name: '左侧敌人' })
    const enemyDown = namedPiece({ instanceId: 'enemy-down', ownerPlayerId: 'player-blue', x: 3, y: 4, currentHp: 30, name: '下方敌人' })
    const enemyUp = namedPiece({ instanceId: 'enemy-up', ownerPlayerId: 'player-blue', x: 3, y: 2, currentHp: 30, name: '上方敌人' })
    return { pieces: [caster, enemyRight, enemyLeft, enemyDown, enemyUp], width: 8, height: 7, targetPosition: null }
  }
  if (id === 'sasuke-indra-arrow') {
    return { pieces: [caster], width: 8, height: 1, targetPosition: { x: 5, y: 0 } }
  }
  if (id === 'hashirama-edo-wood-spike') {
    const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2, y: 0, currentHp: 30, name: '敌人' })
    return { pieces: [caster, enemy], width: 6, height: 1, target: enemy, targetPosition: { x: 2, y: 0 } }
  }
  if (id === 'hashirama-edo-wood-dragon') {
    caster.currentHp = 70
    caster.maxHp = 100
    caster.defense = 2
    const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2, y: 0, attack: 9, currentHp: 20, maxHp: 40, name: '敌人' })
    enemy.defense = 5
    return { pieces: [caster, enemy], width: 6, height: 1, target: enemy, targetPosition: { x: 2, y: 0 } }
  }
  if (id === 'max-speed-shot') {
    const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 3, name: '敌人' })
    caster.skills = [{ skillId: 'max-speed-shot', currentCooldown: 9 }]
    return { pieces: [caster, enemy], width: 6, targetPosition: { x: 4, y: 0 } }
  }
  if (id === 'grimmjow-panther-claw') {
    const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 20, name: '敌人' })
    return { pieces: [caster, enemy], width: 6, target: enemy, targetPosition: { x: 1, y: 0 } }
  }
  if (id === 'shelly-shotgun') {
    const ally = namedPiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 1, y: 0, name: '友军' })
    const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2, y: 0, currentHp: 20, name: '敌人' })
    return { pieces: [caster, ally, enemy], width: 6, targetPosition: { x: 4, y: 0 } }
  }
  const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: id === 'hellfire-shotgun' ? 1 : 20, name: '敌人' })
  return { pieces: [caster, enemy], width: 6, targetPosition: { x: 5, y: 0 } }
}

function run(id: typeof PROJECTILE_SKILL_IDS[number], semantic: boolean, scenario: Scenario, targetPositionOverride?: { x: number; y: number } | null) {
  globalTriggerSystem.clearRules()
  const currentScenario = clone(scenario)
  if (currentScenario.removeSourceAfterDamage) {
    globalTriggerSystem.addRule({
      id: 'projectile-remove-source-after-damage', name: '伤害后移除来源', description: '', trigger: { type: 'afterDamageDealt' },
      effect: battle => { battle.pieces = battle.pieces.filter(piece => piece.instanceId !== 'caster'); return { success: true } },
    })
  }
  try {
    const original = sourceDefinition(id)
    const skill = semantic ? applyGameplayModuleGraph(original, buildProjectileSkillGraph(id)) : original
    const state = makeState({ pieces: currentScenario.pieces, width: currentScenario.width ?? 6, height: currentScenario.height ?? 1, currentPlayerId: currentScenario.currentPlayerId as any }) as any
    state.graveyard = clone(currentScenario.graveyard ?? [])
    state.actions = clone(currentScenario.actions ?? [])
    state.extensions = clone(currentScenario.extensions ?? {})
    for (let x = 0; x < state.map.width; x += 1) setTerrain(state, x, 'floor', true)
    if (id === 'colt-piercing' || id === 'shelly-super-shell') setTerrain(state, 1, 'wall', false)
    if (currentScenario.blockedAt !== undefined) setTerrain(state, currentScenario.blockedAt, 'wall', false)
    state.skillsById[id] = skill
    const caster = state.pieces.find((piece: any) => piece.instanceId === 'caster')
    let contextPlayer: any = null
    if (currentScenario.hand) {
      const owner = state.players.find((player: any) => player.playerId === caster.ownerPlayerId)
      if (owner) owner.hand = clone(currentScenario.hand)
    }
    if (currentScenario.playerContextId) {
      const player = state.players.find((candidate: any) => candidate.playerId === currentScenario.playerContextId)
      if (player) {
        player.statusTags = clone(currentScenario.playerStatusTags ?? [])
        contextPlayer = player
      }
    }
    const target = currentScenario.target ? state.pieces.find((piece: any) => piece.instanceId === currentScenario.target.instanceId) : null
    const context: any = {
      // executeSkillFunction still needs a valid host piece for its execution
      // envelope. A delayed player-owned effect may outlive its caster, so use
      // any remaining piece only as the host envelope; the graph resolves its
      // damage source from context.player and never from this piece.
      piece: caster ?? state.pieces[0],
      target,
      targetPosition: targetPositionOverride === undefined ? (currentScenario.targetPosition ?? null) : targetPositionOverride,
      targets: target ? [{ info: target, pos: { x: target.x, y: target.y } }] : [],
      battle: state,
      skill,
      ...(contextPlayer ? { player: contextPlayer } : {}),
    }
    let flowEntry: any
    if (id === 'pulse-pistol') {
      context.rulePiece = caster
      context.sourcePiece = state.pieces.find((piece: any) => piece.instanceId === currentScenario.trigger?.instanceId)
      flowEntry = { context, surface: 'triggerSkill' }
    }
    const result = recordBattlePresentation(
      state,
      () => withRuleRuntime(new RuleRuntime({ rootSeed: 32, tick: 1 }), () => executeSkillFunction(skill, context, state, flowEntry)),
      () => state,
      { observeProjectilePaths: true },
    )
    const snapshot = clone(state)
    delete snapshot.skillsById
    return {
      result: clone(result),
      state: snapshot,
      presentation: clone(recordedBattlePresentation(state) ?? []),
      paths: clone(recordedProjectilePaths(state) ?? []),
    }
  } finally {
    globalTriggerSystem.clearRules()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-02T03:04:05.006Z'))
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  globalTriggerSystem.clearRules()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('projectile semantic graphs', () => {
  function comparableBlizzardRun(id: 'blizzard' | 'blizzard-damage', value: any): any {
    const snapshot = clone(value)
    const stripOwner = (entry: any): void => {
      if (!entry || typeof entry !== 'object') return
      if (Array.isArray(entry)) { entry.forEach(stripOwner); return }
      if (entry.type === 'blizzard') delete entry.ownerPlayerId
      if (entry.tileType === 'blizzard') delete entry.ownerPlayerId
      Object.values(entry).forEach(stripOwner)
    }
    stripOwner(snapshot)
    if (id === 'blizzard-damage') {
      // The approved player-source migration intentionally changes the damage
      // provenance and player-facing source wording.
      delete snapshot.result?.message
      delete snapshot.state?.actions
      delete snapshot.presentation
    }
    return snapshot
  }

  it('closes projectile extension storage destinations and rejects dangerous keys', () => {
    const cases = [
      { skillId: 'sasuke-indra-arrow', moduleId: 'tile.add-persistent-markers', storageKey: 'amaterasuCells' },
      { skillId: 'sasuke-indra-arrow', moduleId: 'extension.set-owner-if-empty', storageKey: 'amaterasuOwnerPlayerId' },
      { skillId: 'colt-revolver', moduleId: 'projectile.zone-set', storageKey: 'coltZones' },
      { skillId: 'colt-bullet-storm', moduleId: 'projectile.zone-set', storageKey: 'coltZones' },
    ] as const

    for (const item of cases) {
      const graph = buildProjectileSkillGraph(item.skillId)
      const call = findModuleCall(graph, item.moduleId)
      expect(call).toBeDefined()
      expect(call.parameters.storageKey).toBe(item.storageKey)
      expect(() => compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)).not.toThrow()

      for (const invalidStorageKey of ['ownerPlayerId', '__proto__', 'constructor']) {
        const invalidGraph = clone(graph) as any
        const invalidCall = findModuleCall(invalidGraph, item.moduleId)
        expect(invalidCall).toBeDefined()
        invalidCall.parameters.storageKey = invalidStorageKey
        expect(() => compileGameplayModuleGraph(invalidGraph, GAMEPLAY_MODULE_REGISTRY)).toThrow(/outside its enum/)
      }
    }
  })

  it.each(PROJECTILE_SKILL_IDS)('compiles and owns the generated executable for %s', id => {
    const next = applyGameplayModuleGraph(sourceDefinition(id), buildProjectileSkillGraph(id)) as any
    expect(next.gameplayModules.entries.code.graph.surface).toBe(id === 'pulse-pistol' ? 'triggerSkill' : 'skill')
    expect(next.gameplayModules.entries.code.graph.body.some((statement: any) => typeof statement.module === 'string' && (statement.module.startsWith('projectile.') || statement.module.startsWith('query.') || statement.module.startsWith('effect.')))).toBe(true)
    const legacyCode = frozen[`skills/${id}`]?.code
    if (typeof legacyCode === 'string') expect(next.code).not.toBe(legacyCode)
  })

  it.each(PROJECTILE_SKILL_IDS)('preserves real-host result and state for %s', id => {
    const scenario = scenarioFor(id)
    const expected = run(id, false, scenario)
    const actual = run(id, true, scenario)
    if (id === 'blizzard' || id === 'blizzard-damage') {
      expect(comparableBlizzardRun(id, actual)).toEqual(comparableBlizzardRun(id, expected))
      return
    }
    expect(actual.result).toEqual(expected.result)
    expect(actual.state).toEqual(expected.state)
    expect(actual.presentation).toEqual(expected.presentation)
  })

  it('preserves pending target selection before any projectile effect', () => {
    const scenario = scenarioFor('sleep-dart')
    expect(run('sleep-dart', true, scenario, null)).toEqual(run('sleep-dart', false, scenario, null))
  })

  it('preserves pending selection for each newly migrated target protocol', () => {
    for (const id of ['shadow-bolt', 'shadow-chaos-spear', 'sasuke-chidori', 'naruto-rasengan', 'aizen-black-coffin', 'biotic-grenade', 'earthshatter', 'sasuke-indra-arrow', 'hashirama-edo-wood-spike', 'hashirama-edo-wood-dragon'] as const) {
      const scenario = scenarioFor(id)
      delete scenario.target
      const expected = run(id, false, scenario, null)
      const actual = run(id, true, scenario, null)
      expect(actual).toEqual(expected)
      expect(actual.result).toMatchObject({ needsTargetSelection: true })
      expect(actual.state.actions).toEqual([])
    }
  })

  it('keeps the five new skills on their real effect paths', () => {
    const bolt = run('shadow-bolt', true, scenarioFor('shadow-bolt'))
    expect(bolt.result).toMatchObject({ success: true })
    expect(bolt.state.players[0].hand).toEqual([{ cardId: 'other-card', instanceId: 'other-card' }])
    expect(bolt.state.players[0].discardPile).toEqual(['soul-fragment', 'soul-fragment'])
    expect(bolt.state.pieces.find((piece: any) => piece.instanceId === 'enemy-a').currentHp).toBe(18)
    expect(bolt.state.pieces.find((piece: any) => piece.instanceId === 'enemy-b').currentHp).toBe(18)

    const spear = run('shadow-chaos-spear', true, scenarioFor('shadow-chaos-spear'))
    expect(spear.result).toMatchObject({ success: true })
    expect(spear.state.pieces.find((piece: any) => piece.instanceId === 'caster').moveRange).toBe(5)
    expect(spear.state.pieces.find((piece: any) => piece.instanceId === 'enemy').moveRange).toBe(2)
    expect(spear.state.pieces.find((piece: any) => piece.instanceId === 'caster').statusTags).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'chaos-spear-theft' })]))

    const chidori = run('sasuke-chidori', true, scenarioFor('sasuke-chidori'))
    expect(chidori.result).toMatchObject({ success: true })
    expect(chidori.state.pieces.find((piece: any) => piece.instanceId === 'caster')).toMatchObject({ x: 4, y: 0 })
    expect(chidori.state.pieces.find((piece: any) => piece.instanceId === 'enemy').currentHp).toBe(10)
    expect(chidori.state.pieces.find((piece: any) => piece.instanceId === 'enemy').statusTags).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'chidori-immobile' })]))

    const rasengan = run('naruto-rasengan', true, scenarioFor('naruto-rasengan'))
    expect(rasengan.result).toMatchObject({ success: true })
    expect(rasengan.state.pieces.find((piece: any) => piece.instanceId === 'enemy').currentHp).toBe(10)
    expect(rasengan.state.pieces.find((piece: any) => piece.instanceId === 'enemy').statusTags).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'silenced' })]))

    const coffin = run('aizen-black-coffin', true, scenarioFor('aizen-black-coffin'))
    expect(coffin.result).toMatchObject({ success: true })
    expect(coffin.state.pieces.find((piece: any) => piece.instanceId === 'enemy').currentHp).toBe(15)
    expect(coffin.state.pieces.find((piece: any) => piece.instanceId === 'enemy').statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'aizen-black-coffin', delayedDamage: 15 }),
      expect.objectContaining({ type: 'root' }),
    ]))
  })

  it('preserves blizzard pending range and missing player context', () => {
    expect(run('blizzard', true, scenarioFor('blizzard'), null)).toEqual(run('blizzard', false, scenarioFor('blizzard'), null))
    const scenario = scenarioFor('blizzard-damage'); delete scenario.playerContextId
    expect(run('blizzard-damage', true, scenario)).toEqual(run('blizzard-damage', false, scenario))
  })

  it('stores the creating player on Blizzard status and tile records', () => {
    const result = run('blizzard', true, scenarioFor('blizzard'))
    expect(result.state.players[0].statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'blizzard', ownerPlayerId: 'player-red' }),
    ]))
    expect(result.state.extensions.tileEffects).toHaveLength(49)
    expect(result.state.extensions.tileEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ tileType: 'blizzard', ownerPlayerId: 'player-red' }),
    ]))
  })

  it.each(['alive', 'graveyard', 'removed', 'changed-owner'] as const)('settles Blizzard from its player source when caster is %s', mode => {
    const scenario = scenarioFor('blizzard-damage')
    const caster = scenario.pieces.find(piece => piece.instanceId === 'caster')
    if (mode === 'graveyard') {
      caster.currentHp = 0
      scenario.graveyard = [clone(caster)]
    } else if (mode === 'removed') {
      scenario.pieces = scenario.pieces.filter(piece => piece.instanceId !== 'caster')
    } else if (mode === 'changed-owner') {
      caster.ownerPlayerId = 'player-blue'
    }
    const actual = run('blizzard-damage', true, scenario)
    expect(actual.result).toMatchObject({ success: true })
    expect(actual.state.pieces.find((piece: any) => piece.instanceId === 'enemy')?.currentHp).toBe(15)
    expect(actual.state.pieces.find((piece: any) => piece.instanceId === 'enemy')?.statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'freeze', currentDuration: 1 }),
    ]))
    const damage = actual.state.actions.find((action: any) => action.type === 'damage')
    expect(damage?.payload).toMatchObject({
      sourceId: 'player-red',
      damageSource: { kind: 'player', sourceId: 'player-red', playerId: 'player-red' },
    })
  })
  for (const lethal of [false, true]) it(`cleans blizzard markers and retains target names after damage, lethal=${lethal}`, () => {
    const scenario = scenarioFor('blizzard-damage')
    scenario.extensions = { tileEffects: [{ x: 0, y: 0, sourceId: 'blizzard-test' }, { x: 1, y: 0, sourceId: 'unrelated' }] }
    if (lethal) scenario.pieces.filter(piece => piece.ownerPlayerId === 'player-blue').forEach(piece => { piece.currentHp = 1 })
    const actual = run('blizzard-damage', true, scenario)
    expect(comparableBlizzardRun('blizzard-damage', actual)).toEqual(comparableBlizzardRun('blizzard-damage', run('blizzard-damage', false, scenario)))
    expect(actual.state.extensions.tileEffects).toEqual([{ x: 1, y: 0, sourceId: 'unrelated' }])
    expect(actual.result.success).toBe(true)
  })

  it('keeps the projectile family follow-up, area and status paths', () => {
    const disorder = scenarioFor('akaza-disorder')
    disorder.pieces.find(piece => piece.instanceId === 'enemy').statusTags = [{
      id: 'akaza-damaged-marker', type: 'akaza-damaged', sourceId: 'caster', lastDamageTurn: 1,
    }]
    const expectedDisorder = run('akaza-disorder', false, disorder)
    const actualDisorder = run('akaza-disorder', true, disorder)
    expect(actualDisorder).toEqual(expectedDisorder)
    expect(actualDisorder.state.pieces.find((piece: any) => piece.instanceId === 'enemy').currentHp).toBe(15)
    expect(actualDisorder.result.message).toContain('（追击）')

    const annihilation = run('akaza-annihilation', true, scenarioFor('akaza-annihilation'))
    expect(annihilation.result).toMatchObject({ success: true })
    expect(annihilation.result.message).toContain('命中3名敌军')
    expect(annihilation.state.pieces.find((piece: any) => piece.instanceId === 'enemy-a').currentHp).toBe(18)
    expect(annihilation.state.pieces.find((piece: any) => piece.instanceId === 'enemy-b').currentHp).toBe(20)
    expect(annihilation.state.pieces.find((piece: any) => piece.instanceId === 'enemy-c').currentHp).toBe(25)

    const blizzard = run('blizzard', true, scenarioFor('blizzard'))
    expect(blizzard.result).toMatchObject({ success: true })
    expect(blizzard.state.players[0].statusTags).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'blizzard', centerX: 2, centerY: 0, damage: 15 })]))
    expect(blizzard.state.extensions.tileEffects).toHaveLength(49)
    expect(blizzard.presentation).toEqual(expect.arrayContaining([expect.objectContaining({ result: expect.objectContaining({ presentation: 'expand' }) })]))

    const blizzardDamage = run('blizzard-damage', true, scenarioFor('blizzard-damage'))
    expect(blizzardDamage.result).toMatchObject({ success: true, showUIEffects: true })
    expect(blizzardDamage.state.pieces.find((piece: any) => piece.instanceId === 'enemy').currentHp).toBe(15)
    expect(blizzardDamage.state.pieces.find((piece: any) => piece.instanceId === 'enemy').statusTags).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'freeze', currentDuration: 1 })]))
    expect(blizzardDamage.state.players[0].statusTags).toEqual([])

    const mortis = run('mortis-bat-support', true, scenarioFor('mortis-bat-support'))
    expect(mortis.result).toMatchObject({ success: true })
    expect(mortis.state.pieces.find((piece: any) => piece.instanceId === 'enemy').currentHp).toBe(16)
    expect(mortis.state.pieces.find((piece: any) => piece.instanceId === 'caster').currentHp).toBe(54)
    expect(mortis.state.pieces.find((piece: any) => piece.instanceId === 'caster').skills).toEqual([])
  })

  it('keeps the six ranged and area migrations on their real effect paths', () => {
    const biotic = run('biotic-grenade', true, scenarioFor('biotic-grenade'))
    expect(biotic.result).toMatchObject({ success: true })
    expect(biotic.state.pieces.find((piece: any) => piece.instanceId === 'ally').currentHp).toBe(9)
    expect(biotic.state.pieces.find((piece: any) => piece.instanceId === 'enemy').currentHp).toBe(8)
    expect(biotic.state.pieces.find((piece: any) => piece.instanceId === 'enemy').statusTags).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'anti-heal', currentDuration: 1 })]))
    expect(biotic.state.pieces.find((piece: any) => piece.instanceId === 'enemy').skills).toEqual(expect.arrayContaining([expect.objectContaining({ skillId: 'anti-heal-block' })]))

    const enemyOnly = scenarioFor('biotic-grenade')
    enemyOnly.pieces = enemyOnly.pieces.filter(piece => piece.instanceId !== 'ally')
    const expectedEnemyOnly = run('biotic-grenade', false, enemyOnly)
    const actualEnemyOnly = run('biotic-grenade', true, enemyOnly)
    expect(actualEnemyOnly).toEqual(expectedEnemyOnly)
    expect(actualEnemyOnly.result.message).toContain('生物手雷生效：敌人受到')
    expect(actualEnemyOnly.result.message).not.toContain('生物手雷生效：；')

    const earthshatter = run('earthshatter', true, scenarioFor('earthshatter'))
    expect(earthshatter.result).toMatchObject({ success: true })
    expect(earthshatter.state.pieces.find((piece: any) => piece.instanceId === 'caster')).toMatchObject({ x: 4, y: 0 })
    expect(earthshatter.state.pieces.find((piece: any) => piece.instanceId === 'enemy-a').currentHp).toBe(10)
    expect(earthshatter.state.pieces.find((piece: any) => piece.instanceId === 'enemy-b').currentHp).toBe(10)

    const muzan = run('muzan-blood-whip', true, scenarioFor('muzan-blood-whip'))
    expect(muzan.result).toMatchObject({ success: true })
    expect(muzan.result.message).toContain('命中4名敌人')
    for (const id of ['enemy-right', 'enemy-left', 'enemy-down', 'enemy-up']) {
      expect(muzan.state.pieces.find((piece: any) => piece.instanceId === id).currentHp).toBe(20)
    }

    const indraScenario = scenarioFor('sasuke-indra-arrow')
    const indra = run('sasuke-indra-arrow', true, indraScenario)
    expect(indra.result).toMatchObject({ success: true })
    expect(indra.state.extensions.tileEffects).toHaveLength(7)
    expect(indra.state.extensions.amaterasuCells).toHaveLength(7)
    expect(indra.state.players[0].rules).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'rule-sasuke-amaterasu-move' })]))
    const covered = clone(indraScenario)
    const coveredCells = Array.from({ length: 7 }, (_, index) => ({ x: index + 1, y: 0 }))
    covered.extensions = {
      tileEffects: coveredCells.map(cell => ({ ...cell, sourceId: 'amaterasu', tileType: 'amaterasu', icon: '🌑', iconPosition: 'bottom-right' })),
      amaterasuCells: coveredCells.map(cell => ({ ...cell, sourcePieceId: 'caster', ownerPlayerId: 'player-red' })),
    }
    const coveredResult = run('sasuke-indra-arrow', true, covered)
    expect(coveredResult).toEqual(run('sasuke-indra-arrow', false, covered))
    expect(coveredResult.result.message).toContain('完整覆盖')

    const spike = run('hashirama-edo-wood-spike', true, scenarioFor('hashirama-edo-wood-spike'))
    expect(spike.result).toMatchObject({ success: true })
    expect(spike.state.pieces.find((piece: any) => piece.instanceId === 'enemy').currentHp).toBe(20)
    expect(spike.state.pieces.find((piece: any) => piece.instanceId === 'enemy').statusTags).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'silenced', remainingDuration: 1 })]))

    const dragon = run('hashirama-edo-wood-dragon', true, scenarioFor('hashirama-edo-wood-dragon'))
    expect(dragon.result).toMatchObject({ success: true })
    expect(dragon.state.pieces.find((piece: any) => piece.instanceId === 'caster')).toMatchObject({ attack: 14, defense: 4, maxHp: 110, currentHp: 80 })
    expect(dragon.state.pieces.find((piece: any) => piece.instanceId === 'enemy')).toMatchObject({ attack: 5, defense: 3, maxHp: 30, currentHp: 15 })
  })

  it('preserves Chidori blocked destination and kill cutoffs', () => {
    const blocked = scenarioFor('sasuke-chidori')
    blocked.blockedAt = 4
    expect(run('sasuke-chidori', true, blocked)).toEqual(run('sasuke-chidori', false, blocked))
    expect(run('sasuke-chidori', true, blocked).result).toMatchObject({ success: false })

    const rasenganKill = scenarioFor('naruto-rasengan')
    rasenganKill.pieces.find(piece => piece.instanceId === 'enemy').currentHp = 1
    const expectedRasenganKill = run('naruto-rasengan', false, rasenganKill)
    const actualRasenganKill = run('naruto-rasengan', true, rasenganKill)
    expect(actualRasenganKill).toEqual(expectedRasenganKill)
    expect(actualRasenganKill.state.pieces.some((piece: any) => piece.instanceId === 'enemy')).toBe(false)

    const coffinKill = scenarioFor('aizen-black-coffin')
    coffinKill.pieces.find(piece => piece.instanceId === 'enemy').currentHp = 15
    const expectedCoffinKill = run('aizen-black-coffin', false, coffinKill)
    const actualCoffinKill = run('aizen-black-coffin', true, coffinKill)
    expect(actualCoffinKill).toEqual(expectedCoffinKill)
    expect(actualCoffinKill.state.pieces.some((piece: any) => piece.instanceId === 'enemy')).toBe(false)
  })

  it('preserves max-speed-shot recast bookkeeping and kill cutoff', () => {
    const scenario = scenarioFor('max-speed-shot')
    scenario.actions = [{ type: 'useBasicSkill', turn: 1, payload: { pieceId: 'caster', skillId: 'max-speed-shot', interrupted: false } }]
    const expected = run('max-speed-shot', false, scenario)
    const actual = run('max-speed-shot', true, scenario)
    expect(actual.result).toEqual(expected.result)
    expect(actual.state).toEqual(expected.state)
    expect(actual.presentation).toEqual(expected.presentation)
    expect(actual.paths).toHaveLength(1)
    expect(actual.result.message).toContain('进行3次射击')
    expect(actual.state.pieces.some((piece: any) => piece.instanceId === 'enemy')).toBe(false)
    expect(actual.state.pieces.find((piece: any) => piece.instanceId === 'caster').skills[0].currentCooldown).toBe(1)
  })

  it('preserves projectile terrain blocking for new line skills', () => {
    for (const id of ['max-speed-shot', 'blackwidow-lethal-strike', 'ichigo-getsuga-tensho'] as const) {
      const scenario = scenarioFor(id)
      scenario.blockedAt = 1
      const expected = run(id, false, scenario)
      const actual = run(id, true, scenario)
      expect(actual.result).toEqual(expected.result)
      expect(actual.state).toEqual(expected.state)
      expect(actual.presentation).toEqual(expected.presentation)
      expect(actual.paths).toHaveLength(1)
    }
  })

  it('preserves repeated-hit source departure semantics', () => {
    for (const id of ['max-speed-shot', 'grimmjow-panther-claw'] as const) {
      const scenario = scenarioFor(id, true)
      const expected = run(id, false, scenario)
      const actual = run(id, true, scenario)
      expect(actual.result).toEqual(expected.result)
      expect(actual.state).toEqual(expected.state)
      expect(actual.presentation).toEqual(expected.presentation)
    }
  })

  it('preserves Shadow Bolt source departure across later line targets', () => {
    const scenario = scenarioFor('shadow-bolt', true)
    const expected = run('shadow-bolt', false, scenario)
    const actual = run('shadow-bolt', true, scenario)
    expect(actual).toEqual(expected)
  })

  it('keeps path facts ordered while hellfire kills the first target', () => {
    const actual = run('hellfire-shotgun', true, scenarioFor('hellfire-shotgun'))
    expect(actual.result.success).toBe(true)
    expect(actual.state.pieces.some((piece: any) => piece.instanceId === 'enemy')).toBe(false)
    expect(actual.paths).toHaveLength(1)
    expect(actual.paths[0].facts.map((fact: any) => fact.type)).toEqual(['cell', 'piece'])
  })

  it('preserves terrain blocking before a later target', () => {
    const caster = namedPiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 0, y: 0, attack: 10, name: '施法者' })
    const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2, y: 0, currentHp: 20, name: '敌人' })
    const scenario: Scenario = { pieces: [caster, enemy], width: 6, targetPosition: { x: 5, y: 0 }, blockedAt: 1 }
    const actual = run('hellfire-shotgun', true, scenario)
    const expected = run('hellfire-shotgun', false, scenario)
    expect(actual.result).toEqual(expected.result)
    expect(actual.state).toEqual(expected.state)
    expect(actual.presentation).toEqual(expected.presentation)
    expect(actual.paths[0].facts.map((fact: any) => fact.type)).toEqual(['cell', 'terrain'])
  })

  it('continues super-shell cells after the source leaves the battle', () => {
    const scenario = scenarioFor('shelly-super-shell', true)
    const actual = run('shelly-super-shell', true, scenario)
    expect(actual.result.success).toBe(true)
    expect(actual.state.pieces.some((piece: any) => piece.instanceId === 'enemy-a')).toBe(false)
    expect(actual.state.pieces.find((piece: any) => piece.instanceId === 'enemy-b').currentHp).toBeLessThan(40)
    expect(actual.state.pieces.some((piece: any) => piece.instanceId === 'caster')).toBe(false)
  })
})
