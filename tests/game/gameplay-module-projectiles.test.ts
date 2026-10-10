/* eslint-disable @typescript-eslint/no-explicit-any -- real-host projectile differential fixtures. */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { executeSkillFunction } from '@/lib/game/skills'
import { recordBattlePresentation, recordedBattlePresentation, recordedProjectilePaths } from '@/lib/game/battle-presentation-recording'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { buildProjectileSkillGraph, PROJECTILE_SKILL_IDS } from '@/scripts/migrate-semantic-projectile-skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

const frozen = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries as Record<string, any>
const productionHandCannon = JSON.parse(readFileSync('data/skills/hand-cannon.json', 'utf8')) as any
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

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
  width?: number
  targetPosition?: { x: number; y: number } | null
  target?: any
  hand?: any[]
  trigger?: any
  actions?: any[]
  removeSourceAfterDamage?: boolean
  blockedAt?: number
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
    const state = makeState({ pieces: currentScenario.pieces, width: currentScenario.width ?? 6, height: 1 }) as any
    state.actions = clone(currentScenario.actions ?? [])
    for (let x = 0; x < state.map.width; x += 1) setTerrain(state, x, 'floor', true)
    if (id === 'colt-piercing' || id === 'shelly-super-shell') setTerrain(state, 1, 'wall', false)
    if (currentScenario.blockedAt !== undefined) setTerrain(state, currentScenario.blockedAt, 'wall', false)
    state.skillsById[id] = skill
    const caster = state.pieces.find((piece: any) => piece.instanceId === 'caster')
    if (currentScenario.hand) {
      const owner = state.players.find((player: any) => player.playerId === caster.ownerPlayerId)
      if (owner) owner.hand = clone(currentScenario.hand)
    }
    const target = currentScenario.target ? state.pieces.find((piece: any) => piece.instanceId === currentScenario.target.instanceId) : null
    const context: any = {
      piece: caster,
      target,
      targetPosition: targetPositionOverride === undefined ? (currentScenario.targetPosition ?? null) : targetPositionOverride,
      targets: target ? [{ info: target, pos: { x: target.x, y: target.y } }] : [],
      battle: state,
      skill,
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
    expect(actual.result).toEqual(expected.result)
    expect(actual.state).toEqual(expected.state)
    expect(actual.presentation).toEqual(expected.presentation)
  })

  it('preserves pending target selection before any projectile effect', () => {
    const scenario = scenarioFor('sleep-dart')
    expect(run('sleep-dart', true, scenario, null)).toEqual(run('sleep-dart', false, scenario, null))
  })

  it('preserves pending selection for each newly migrated target protocol', () => {
    for (const id of ['shadow-bolt', 'shadow-chaos-spear', 'sasuke-chidori', 'naruto-rasengan', 'aizen-black-coffin'] as const) {
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
