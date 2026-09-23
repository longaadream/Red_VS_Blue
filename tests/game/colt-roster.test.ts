import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { applyBattleAction } from '@/lib/game/turn'
import { projectBattlePresentationEvents } from '@/lib/game/battle-presentation-events'
import { recordBattlePresentation } from '@/lib/game/battle-presentation-recording'
import { loadRuleById, type SkillDefinition } from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

type ColtSkillDefinition = SkillDefinition & { effectTags: string[] }

function loadSkill(id: string): ColtSkillDefinition {
  return JSON.parse(readFileSync(resolve(process.cwd(), `data/skills/${id}.json`), 'utf8')) as ColtSkillDefinition
}

function selectedCellAction(
  state: ReturnType<typeof makeState>,
  skillId: string,
  type: 'useBasicSkill' | 'useChargeSkill',
  x: number,
  y: number,
) {
  const base = { type, playerId: 'player-red', pieceId: 'colt', skillId } as const
  const prepared = prepareAction(state, base)
  if (prepared.kind !== 'needTarget') throw new Error(`Expected target selection, received ${prepared.kind}`)
  return {
    ...base,
    targetX: x,
    targetY: y,
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  } as const
}

function coltState(skillIds: string[], enemyPositions: Array<{ instanceId: string; x: number; y: number }>) {
  const colt = makePiece({
    instanceId: 'colt',
    templateId: 'colt',
    ownerPlayerId: 'player-red',
    x: 1,
    y: 1,
    attack: 6,
    skills: skillIds.map(skillId => ({ skillId, currentCooldown: 0, usesRemaining: -1 })),
  })
  const enemies = enemyPositions.map(enemy => makePiece({
    ...enemy,
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    currentHp: 20,
    maxHp: 20,
  }))
  const state = makeState({ pieces: [colt, ...enemies], width: 10, height: 8 })
  for (const skillId of skillIds) state.skillsById[skillId] = loadSkill(skillId)
  return { state, colt, enemies }
}

describe('Colt skill targeting contract', () => {
  it.each(['colt-revolver', 'colt-bullet-storm', 'colt-piercing'])('%s declares its grid direction target', (skillId) => {
    const colt = makePiece({
      instanceId: 'colt',
      templateId: 'colt',
      ownerPlayerId: 'player-red',
      x: 1,
      y: 1,
      skills: [{ skillId, currentCooldown: 0, usesRemaining: -1 }],
    })
    const state = makeState({ pieces: [colt], width: 10, height: 8 })
    state.skillsById[skillId] = loadSkill(skillId)
    if (skillId === 'colt-bullet-storm') state.players[0].chargePoints = 2

    const prepared = prepareAction(state, {
      type: skillId === 'colt-bullet-storm' ? 'useChargeSkill' : 'useBasicSkill',
      playerId: 'player-red',
      pieceId: colt.instanceId,
      skillId,
    })

    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    expect(prepared.targetType).toBe('cell')
    expect(prepared.range).toBe(6)
    expect(prepared.candidates).toContainEqual({ type: 'cell', x: 7, y: 1 })
    expect(prepared.candidates).not.toContainEqual({ type: 'cell', x: 1, y: 1 })
    expect(prepared.candidates).not.toContainEqual({ type: 'cell', x: 2, y: 2 })
  })

  it('declares Colt cooldown and wall-breaking metadata', () => {
    const revolver = loadSkill('colt-revolver')
    const piercing = loadSkill('colt-piercing')
    const storm = loadSkill('colt-bullet-storm')

    expect(revolver.cooldownTurns).toBe(3)
    expect(piercing.description).not.toContain('弹射物')
    expect(piercing.keywords).toEqual(['破墙'])
    expect(piercing.effectTags).toEqual(['伤害', '破墙'])
    expect(storm.keywords).toEqual(['破墙'])
    expect(storm.effectTags).toEqual(['伤害', '破墙'])
    expect(storm.description).toContain('破墙')
  })

  it('executes piercing silver bullet through the real action pipeline', () => {
    const { state } = coltState(['colt-piercing'], [{ instanceId: 'enemy', x: 3, y: 1 }])
    const wall = state.map.tiles.find(tile => tile.x === 2 && tile.y === 1)!
    wall.props = { ...wall.props, type: 'wall', walkable: false, bulletPassable: false }

    const next = applyBattleAction(state, selectedCellAction(state, 'colt-piercing', 'useBasicSkill', 5, 1))

    expect(next.pieces.find(piece => piece.instanceId === 'enemy')?.currentHp).toBe(16)
    expect(next.map.tiles.find(tile => tile.x === 2 && tile.y === 1)?.props).toMatchObject({
      type: 'floor', walkable: true, bulletPassable: true,
    })
  })

  it('hits the nearest enemy even when a farther enemy precedes it in the roster', () => {
    const { state, colt } = coltState(['colt-revolver'], [
      { instanceId: 'far', x: 5, y: 1 }, { instanceId: 'near', x: 3, y: 1 },
    ])
    colt.rules = [loadRuleById('rule-colt-zone-endturn')!]
    const cast = applyBattleAction(state, selectedCellAction(state, 'colt-revolver', 'useBasicSkill', 4, 1))
    const action = { type: 'endTurn', playerId: 'player-red' } as const
    const next = recordBattlePresentation(cast, () => applyBattleAction(cast, action), result => result)
    expect(next.pieces.find(piece => piece.instanceId === 'near')?.currentHp).toBe(14)
    expect(next.pieces.find(piece => piece.instanceId === 'far')?.currentHp).toBe(20)
    expect(projectBattlePresentationEvents({ actionId: 'colt-revolver-zone', command: action,
      beforeState: cast, afterState: next }).find(event => event.kind === 'damage'))
      .toMatchObject({ skillId: 'colt-revolver', sourcePieceId: colt.instanceId })
  })

  it('keeps Revolver fire blocked by walls', () => {
    const { state, colt } = coltState(['colt-revolver'], [{ instanceId: 'enemy', x: 3, y: 1 }])
    colt.rules = [loadRuleById('rule-colt-zone-endturn')!]
    const cast = applyBattleAction(state, selectedCellAction(state, 'colt-revolver', 'useBasicSkill', 5, 1))
    const wall = cast.map.tiles.find(tile => tile.x === 2 && tile.y === 1)!
    wall.props = { ...wall.props, type: 'wall', walkable: false, bulletPassable: false }

    const next = applyBattleAction(cast, { type: 'endTurn', playerId: 'player-red' })

    expect(next.pieces.find(piece => piece.instanceId === 'enemy')?.currentHp).toBe(20)
    expect(next.map.tiles.find(tile => tile.x === 2 && tile.y === 1)?.props).toMatchObject({
      type: 'wall', walkable: false, bulletPassable: false,
    })
  })

  it('Bullet Storm destroys line walls, hits every enemy, and records its originating skill', () => {
    const { state, colt, enemies } = coltState(['colt-bullet-storm'], [
      { instanceId: 'enemy-a', x: 3, y: 1 }, { instanceId: 'enemy-b', x: 5, y: 1 },
    ])
    state.players[0].chargePoints = 2
    colt.rules = [loadRuleById('rule-colt-zone-endturn')!]
    const cast = applyBattleAction(state, selectedCellAction(state, 'colt-bullet-storm', 'useChargeSkill', 7, 1))
    for (const x of [2, 4]) {
      const wall = cast.map.tiles.find(tile => tile.x === x && tile.y === 1)!
      wall.props = { ...wall.props, type: x === 4 ? 'cover' : 'wall', walkable: false, bulletPassable: false }
    }
    const action = { type: 'endTurn', playerId: 'player-red' } as const
    const next = recordBattlePresentation(cast, () => applyBattleAction(cast, action), result => result)
    const damageEvents = projectBattlePresentationEvents({ actionId: 'colt-bullet-storm-zone', command: action,
      beforeState: cast, afterState: next }).filter(event => event.kind === 'damage')

    expect(enemies.map(enemy => next.pieces.find(piece => piece.instanceId === enemy.instanceId)?.currentHp))
      .toEqual([14, 14])
    for (const x of [2, 4]) expect(next.map.tiles.find(tile => tile.x === x && tile.y === 1)?.props)
      .toMatchObject({ type: 'floor', walkable: true, bulletPassable: true })
    expect(damageEvents).toHaveLength(2)
    expect(damageEvents.every(event => event.skillId === 'colt-bullet-storm')).toBe(true)
  })

  it('does not settle another Colt’s zone through a second rule holder', () => {
    const { state, colt } = coltState(['colt-revolver'], [{ instanceId: 'enemy', x: 3, y: 1 }])
    colt.rules = [loadRuleById('rule-colt-zone-endturn')!]
    state.pieces.push(asPieceInstance(makePiece({ instanceId: 'other-colt', ownerPlayerId: 'player-blue', x: 8, y: 6,
      rules: [loadRuleById('rule-colt-zone-endturn')!] })))
    const cast = applyBattleAction(state, selectedCellAction(state, 'colt-revolver', 'useBasicSkill', 4, 1))
    const next = applyBattleAction(cast, { type: 'endTurn', playerId: 'player-red' })
    expect(next.pieces.find(piece => piece.instanceId === 'enemy')?.currentHp).toBe(14)
    expect(next.extensions?.coltZones?.colt).toMatchObject({ turns: 1 })
  })

  it('replaces the previous zone and follows the caster to the end-turn line', () => {
    const { state, colt, enemies } = coltState(
      ['colt-revolver', 'colt-bullet-storm'],
      [{ instanceId: 'enemy-a', x: 3, y: 2 }, { instanceId: 'enemy-b', x: 4, y: 2 }],
    )
    state.players[0].chargePoints = 2
    colt.rules = [loadRuleById('rule-colt-zone-endturn')!]

    const afterRevolver = applyBattleAction(
      state,
      selectedCellAction(state, 'colt-revolver', 'useBasicSkill', 4, 1),
    )
    expect(afterRevolver.extensions?.coltZones?.colt).toMatchObject({ kind: 'revolver', dx: 1, dy: 0, turns: 2 })
    expect(afterRevolver.pieces.find(piece => piece.instanceId === colt.instanceId)?.statusTags)
      .toContainEqual(expect.objectContaining({ type: 'colt-zone', name: '左轮射击区域', stacks: 2 }))

    afterRevolver.players[0].actionPoints = 2
    afterRevolver.players[0].chargePoints = 2
    const afterStorm = applyBattleAction(
      afterRevolver,
      selectedCellAction(afterRevolver, 'colt-bullet-storm', 'useChargeSkill', 4, 1),
    )
    expect(afterStorm.extensions?.coltZones?.colt).toMatchObject({ kind: 'storm', dx: 1, dy: 0, turns: 3 })
    expect(afterStorm.pieces.find(piece => piece.instanceId === colt.instanceId)?.statusTags)
      .toEqual([expect.objectContaining({ type: 'colt-zone', name: '子弹风暴区域', stacks: 3 })])

    afterStorm.players[0].actionPoints = 1
    const afterMove = applyBattleAction(afterStorm, {
      type: 'move', playerId: 'player-red', pieceId: colt.instanceId, toX: 1, toY: 2,
    })
    const afterEndTurn = applyBattleAction(afterMove, { type: 'endTurn', playerId: 'player-red' })

    expect(afterEndTurn.pieces.find(piece => piece.instanceId === enemies[0].instanceId)?.currentHp).toBe(14)
    expect(afterEndTurn.pieces.find(piece => piece.instanceId === enemies[1].instanceId)?.currentHp).toBe(14)
    expect(afterEndTurn.extensions?.coltZones?.colt).toMatchObject({ kind: 'storm', turns: 2 })
    expect(afterEndTurn.pieces.find(piece => piece.instanceId === colt.instanceId)?.statusTags)
      .toContainEqual(expect.objectContaining({ type: 'colt-zone', name: '子弹风暴区域', stacks: 2 }))
  })
})
