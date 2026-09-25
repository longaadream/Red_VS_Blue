/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-authored skill scripts are exercised through the real skill runner. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { applyBattleAction } from '@/lib/game/turn'
import { dealDamage, executeSkillFunction, healDamage, loadRuleById } from '@/lib/game/skills'
import type { BattleState } from '@/lib/game/turn'
import type { SkillDefinition } from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { prepareAction } from '@/lib/game/targeting'
import { makePiece, makeState } from '../helpers/minimal-state'

const DATA_ROOT = join(process.cwd(), 'data')

function loadSkill(id: string): SkillDefinition {
  return JSON.parse(readFileSync(join(DATA_ROOT, 'skills', `${id}.json`), 'utf8')) as SkillDefinition
}

function akazaState(skillIds: string[], enemyPositions: Array<{ instanceId: string; x: number; y: number; currentHp?: number }> = []) {
  const akaza = makePiece({
    instanceId: 'akaza',
    templateId: 'dark-akaza',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: 1,
    y: 2,
    currentHp: 16,
    maxHp: 16,
    attack: 4,
    moveRange: 5,
    rules: [loadRuleById('rule-akaza-damage-mark', true)!],
    skills: skillIds.map(skillId => ({ skillId, currentCooldown: 0, usesRemaining: -1 })),
  })
  const enemies = enemyPositions.map(enemy => makePiece({
    ...enemy,
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    currentHp: enemy.currentHp ?? 20,
    maxHp: 20,
  }))
  const state = makeState({ pieces: [akaza, ...enemies], width: 12, height: 8 }) as any
  for (const skillId of skillIds) state.skillsById[skillId] = loadSkill(skillId)
  return { state: state as BattleState, akaza, enemies }
}

function executeSkill(
  skill: SkillDefinition,
  state: BattleState,
  target: { pieceId?: string; x?: number; y?: number } = {},
) {
  const caster = state.pieces.find(piece => piece.instanceId === 'akaza')!
  const targetPiece = target.pieceId
    ? state.pieces.find(piece => piece.instanceId === target.pieceId) ?? null
    : null
  const targetPosition = targetPiece
    ? { x: targetPiece.x!, y: targetPiece.y! }
    : target.x !== undefined && target.y !== undefined
      ? { x: target.x, y: target.y }
      : null

  return executeSkillFunction(skill, {
    piece: caster,
    target: targetPiece,
    targetPosition,
    targets: [{ info: targetPiece, pos: targetPosition }],
    battle: state,
    playerId: caster.ownerPlayerId,
    skill: {
      id: skill.id,
      name: skill.name,
      type: skill.type,
      powerMultiplier: skill.powerMultiplier,
    },
  } as any, state)
}

function selectedAction(
  state: BattleState,
  skillId: string,
  target: { pieceId?: string; x?: number; y?: number },
) {
  const base = { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'akaza', skillId }
  const prepared = prepareAction(state, base as any)
  if (prepared.kind !== 'needTarget') throw new Error(`Expected target selection, received ${prepared.kind}`)
  return {
    ...base,
    ...(target.pieceId ? { targetPieceId: target.pieceId } : { targetX: target.x, targetY: target.y }),
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  } as any
}

beforeEach(() => globalTriggerSystem.clearRules())

describe('Akaza attack skill data', () => {
  it('declares both attacks without UI keywords and with the approved costs', () => {
    const disorder = loadSkill('akaza-disorder') as any
    const annihilation = loadSkill('akaza-annihilation') as any

    expect(disorder).toMatchObject({
      name: '破坏杀·乱式', keywords: [], actionPointCost: 1, cooldownTurns: 1,
      targetType: 'piece', filter: 'enemy', range: 'single',
    })
    expect(disorder.targeting.steps[0]).toMatchObject({ type: 'piece', filter: 'enemy', range: 1 })
    expect(annihilation).toMatchObject({
      name: '破坏杀·灭式', keywords: [], actionPointCost: 2, cooldownTurns: 2,
      targetType: 'grid', range: 'single',
    })
    expect(annihilation.targeting.steps[0]).toMatchObject({
      type: 'grid', filter: 'all', range: 4, sameRowOrColumn: true, excludeSourceCell: true,
    })
  })
})

describe('破坏杀·乱式', () => {
  it('uses 1x on the first hit and 1.5x after this source damaged the same target this turn', () => {
    const skill = loadSkill('akaza-disorder')
    const { state, enemies } = akazaState(['akaza-disorder'], [{ instanceId: 'target', x: 2, y: 2, currentHp: 20 }])

    expect(executeSkill(skill, state, { pieceId: 'target' }).success).toBe(true)
    expect(enemies[0].currentHp).toBe(16)
    expect(executeSkill(skill, state, { pieceId: 'target' }).success).toBe(true)
    expect(enemies[0].currentHp).toBe(10)
  })

  it('does not treat a blocked or zero-damage action as a previous hit', () => {
    const skill = loadSkill('akaza-disorder')
    const { state, akaza, enemies } = akazaState(['akaza-disorder'], [{ instanceId: 'target', x: 2, y: 2, currentHp: 20 }])
    ;(enemies[0] as any).shield = 4

    const blocked = dealDamage(akaza as any, enemies[0] as any, 4, 'physical', state, 'previous-zero')
    expect(blocked.damage).toBe(0)
    expect(state.actions?.some(action => action.type === 'damage' && action.payload?.finalDamage > 0)).toBe(false)

    expect(executeSkill(skill, state, { pieceId: 'target' }).success).toBe(true)
    expect(enemies[0].currentHp).toBe(16)
  })

  it('only counts a matching source and target in the current turn', () => {
    const skill = loadSkill('akaza-disorder')
    const { state, akaza, enemies } = akazaState(['akaza-disorder'], [
      { instanceId: 'target', x: 2, y: 2, currentHp: 20 },
      { instanceId: 'other', x: 1, y: 3, currentHp: 20 },
    ])
    dealDamage(akaza as any, enemies[0] as any, 4, 'physical', state, 'previous-turn')
    state.turn.turnNumber = 2
    expect(executeSkill(skill, state, { pieceId: 'target' }).success).toBe(true)
    expect(enemies[0].currentHp).toBe(12)

    state.turn.turnNumber = 3
    dealDamage(akaza as any, enemies[1] as any, 4, 'physical', state, 'other-target')
    expect(executeSkill(skill, state, { pieceId: 'target' }).success).toBe(true)
    expect(enemies[0].currentHp).toBe(8)
  })

  it('stacks the prior-hit multiplier with full-health fighting spirit for 9 damage', () => {
    const skill = loadSkill('akaza-disorder')
    const { state, akaza, enemies } = akazaState(['akaza-disorder'], [{ instanceId: 'target', x: 2, y: 2, currentHp: 20 }])
    akaza.rules = [
      loadRuleById('rule-akaza-fighting-spirit', true)!,
      loadRuleById('rule-akaza-damage-mark', true)!,
    ]

    dealDamage(akaza as any, enemies[0] as any, 1, 'physical', state, 'setup-hit')
    expect(enemies[0].currentHp).toBe(19)
    expect(healDamage(akaza as any, enemies[0] as any, 1, state, 'setup-heal').heal).toBe(1)
    expect(enemies[0].currentHp).toBe(20)

    expect(executeSkill(skill, state, { pieceId: 'target' }).success).toBe(true)
    expect(enemies[0].currentHp).toBe(11)
  })

  it('spends 1 AP and applies its 1-turn cooldown through the action runner', () => {
    const { state } = akazaState(['akaza-disorder'], [{ instanceId: 'target', x: 2, y: 2 }])
    state.players[0].actionPoints = 2

    const next = applyBattleAction(state, selectedAction(state, 'akaza-disorder', { pieceId: 'target' }))
    expect(next.players[0].actionPoints).toBe(1)
    expect(next.pieces.find(piece => piece.instanceId === 'akaza')?.skills[0]).toMatchObject({ currentCooldown: 1 })
  })
})

describe('破坏杀·灭式', () => {
  it('hits every enemy in the chosen cardinal line with distance multipliers and excludes diagonals, allies, and the opposite direction', () => {
    const skill = loadSkill('akaza-annihilation')
    const { state, enemies } = akazaState(['akaza-annihilation'], [
      { instanceId: 'near', x: 2, y: 2 },
      { instanceId: 'middle', x: 3, y: 2 },
      { instanceId: 'far', x: 4, y: 2 },
      { instanceId: 'last', x: 5, y: 2 },
      { instanceId: 'diagonal', x: 2, y: 3 },
      { instanceId: 'opposite', x: 0, y: 2 },
    ])
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', faction: 'red', x: 3, y: 2, currentHp: 20, maxHp: 20 }) as any
    state.pieces.push(ally)
    state.map.tiles = state.map.tiles.map(tile => tile.x === 4 && tile.y === 2
      ? { ...tile, props: { ...tile.props, type: 'wall', walkable: false } }
      : tile)

    expect(executeSkill(skill, state, { x: 5, y: 2 }).success).toBe(true)
    expect(enemies.map(enemy => enemy.currentHp)).toEqual([15, 16, 18, 18, 20, 20])
    expect(ally.currentHp).toBe(20)
  })

  it('continues its fixed target order after the first target reflects lethal damage to Akaza', () => {
    const skill = loadSkill('akaza-annihilation')
    const { state, akaza, enemies } = akazaState(['akaza-annihilation'], [
      { instanceId: 'reflector', x: 2, y: 2, currentHp: 20 },
      { instanceId: 'second', x: 3, y: 2, currentHp: 20 },
    ])
    akaza.currentHp = 4
    const reflector = enemies[0] as any
    reflector.statusTags = [{ id: 'kamui-shield', type: 'kamui-shield', intensity: 1 }]
    reflector.rules = [loadRuleById('rule-obito-kamui-block', true)!]

    expect(executeSkill(skill, state, { x: 5, y: 2 }).success).toBe(true)
    expect(akaza.currentHp).toBe(0)
    expect(enemies[0].currentHp).toBe(20)
    expect(enemies[1].currentHp).toBe(16)
    expect(state.actions?.filter(action => action.type === 'damage').map(action => action.payload?.targetId))
      .toEqual(['reflector', 'akaza', 'second'])
  })

  it('spends 2 AP and applies its 2-turn cooldown through the action runner', () => {
    const { state } = akazaState(['akaza-annihilation'], [{ instanceId: 'target', x: 2, y: 2 }])
    state.players[0].actionPoints = 3

    const next = applyBattleAction(state, selectedAction(state, 'akaza-annihilation', { x: 5, y: 2 }))
    expect(next.players[0].actionPoints).toBe(1)
    expect(next.pieces.find(piece => piece.instanceId === 'akaza')?.skills[0]).toMatchObject({ currentCooldown: 2 })
  })

  it('rejects a diagonal direction before changing HP or resources', () => {
    const skill = loadSkill('akaza-annihilation')
    const { state, enemies } = akazaState(['akaza-annihilation'], [{ instanceId: 'target', x: 2, y: 3 }])
    const before = JSON.stringify(state)

    expect(executeSkill(skill, state, { x: 2, y: 3 }).success).toBe(false)
    expect(enemies[0].currentHp).toBe(20)
    expect(JSON.stringify(state)).toBe(before)
  })
})
