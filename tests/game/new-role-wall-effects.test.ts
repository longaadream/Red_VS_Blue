import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyBattleAction } from '@/lib/game/turn'
import { prepareAction } from '@/lib/game/targeting'
import { dealDamage, getEffectiveChargeCost, loadRuleById } from '@/lib/game/skills'
import { makePiece, makeState } from '../helpers/minimal-state'

describe('new role wall destruction', () => {
  it('Primo injury counting lowers elbow cost after every four actual damage', () => {
    const skill = JSON.parse(readFileSync('data/skills/el-primo-elbow.json', 'utf8'))
    const primo = makePiece({ instanceId: 'primo', templateId: 'el-primo', rules: [loadRuleById('rule-el-primo-injury-counter')!] })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 1 })
    const state = makeState({ pieces: [primo, enemy] })
    expect(getEffectiveChargeCost(state, primo.ownerPlayerId, skill)).toBe(2)
    dealDamage(enemy, primo, 3, 'true', state)
    expect(getEffectiveChargeCost(state, primo.ownerPlayerId, skill)).toBe(2)
    dealDamage(enemy, primo, 1, 'true', state)
    expect(getEffectiveChargeCost(state, primo.ownerPlayerId, skill)).toBe(1)
    dealDamage(enemy, primo, 4, 'true', state)
    expect(getEffectiveChargeCost(state, primo.ownerPlayerId, skill)).toBe(0)
  })

  it('Primo selects an empty landing cell and destroys adjacent walls on landing', () => {
    const skill = JSON.parse(readFileSync('data/skills/el-primo-elbow.json', 'utf8'))
    const source = makePiece({ instanceId: 'primo', templateId: 'el-primo', x: 0, y: 0, attack: 4,
      skills: [{ skillId: skill.id, currentCooldown: 0, usesRemaining: -1 }] })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 4, y: 3 })
    const state = makeState({ pieces: [source, enemy], width: 7, height: 6 })
    state.skillsById[skill.id] = skill
    state.players[0].chargePoints = 10
    const wall = state.map.tiles.find(tile => tile.x === 2 && tile.y === 3)!
    wall.props = { ...wall.props, type: 'wall', walkable: false, bulletPassable: false }
    const base = { type: 'useChargeSkill' as const, playerId: 'player-red', pieceId: source.instanceId, skillId: skill.id }
    const selection = prepareAction(state, base)
    expect(selection.kind).toBe('needTarget')
    if (selection.kind !== 'needTarget') return
    expect(selection.candidates).not.toContainEqual({ type: 'cell', x: 2, y: 3 })
    expect(selection.candidates).not.toContainEqual({ type: 'cell', x: 4, y: 3 })
    const next = applyBattleAction(state, { ...base, targetX: 3, targetY: 3,
      selectionId: selection.selectionId, stateRevision: selection.stateRevision })
    expect(next.pieces.find(piece => piece.instanceId === 'primo')).toMatchObject({ x: 3, y: 3 })
    expect(next.map.tiles.find(tile => tile.x === 2 && tile.y === 3)?.props.type).toBe('floor')
    expect(next.pieces.find(piece => piece.instanceId === 'enemy')?.currentHp).toBe(96)
  })

  it('super shell targets through walls and destroys every wall in range before damaging enemies', () => {
    const skill = JSON.parse(readFileSync('data/skills/shelly-super-shell.json', 'utf8'))
    const source = makePiece({ instanceId: 'shelly', templateId: 'shelly', x: 0, y: 1, attack: 4,
      skills: [{ skillId: skill.id, currentCooldown: 0, usesRemaining: 2 }] })
    const target = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 3, y: 1 })
    const state = makeState({ pieces: [source, target], width: 7, height: 3 })
    state.skillsById[skill.id] = skill
    state.players[0].chargePoints = 10
    for (const x of [1, 2, 4, 5]) {
      const tile = state.map.tiles.find(tile => tile.x === x && tile.y === 1)!
      tile.props = { ...tile.props, type: x === 2 ? 'cover' : 'wall', walkable: false, bulletPassable: false }
    }
    const baseAction = { type: 'useChargeSkill' as const, playerId: 'player-red', pieceId: source.instanceId, skillId: skill.id }
    const selection = prepareAction(state, baseAction)
    expect(selection.kind).toBe('needTarget')
    if (selection.kind !== 'needTarget') return
    const action = { ...baseAction, targetX: 4, targetY: 1, selectionId: selection.selectionId, stateRevision: selection.stateRevision }
    const prepared = prepareAction(state, action)
    expect(prepared.kind, JSON.stringify(prepared)).toBe('ready')
    const next = applyBattleAction(state, action)
    for (const x of [1, 2, 4]) expect(next.map.tiles.find(tile => tile.x === x && tile.y === 1)?.props)
      .toMatchObject({ type: 'floor', walkable: true, bulletPassable: true })
    expect(next.map.tiles.find(tile => tile.x === 5 && tile.y === 1)?.props.type).toBe('wall')
    expect(next.pieces.find(piece => piece.instanceId === 'enemy')?.currentHp).toBe(94)
    expect(state.map.tiles.find(tile => tile.x === 1 && tile.y === 1)?.props.type).toBe('wall')
  })

  it('bat support is a straight-line effect and is not stopped by walls', () => {
    const skill = JSON.parse(readFileSync('data/skills/mortis-bat-support.json', 'utf8'))
    const source = makePiece({ instanceId: 'mortis', templateId: 'mortis', x: 0, y: 1, currentHp: 50, maxHp: 100,
      skills: [{ skillId: skill.id, currentCooldown: 0, usesRemaining: -1 }],
      statusTags: [{ id: 'counter', type: 'mortis-damage-counter', readyCharges: 1, intensity: 1 }] })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 3, y: 1, currentHp: 20, maxHp: 20 })
    const state = makeState({ pieces: [source, enemy], width: 8, height: 3 })
    state.skillsById[skill.id] = skill
    const wall = state.map.tiles.find(tile => tile.x === 2 && tile.y === 1)!
    wall.props = { ...wall.props, type: 'wall', walkable: false, bulletPassable: false }
    const base = { type: 'useBasicSkill' as const, playerId: 'player-red', pieceId: source.instanceId, skillId: skill.id }
    const selection = prepareAction(state, base)
    expect(selection.kind).toBe('needTarget')
    if (selection.kind !== 'needTarget') return
    const next = applyBattleAction(state, { ...base, targetX: 7, targetY: 1,
      selectionId: selection.selectionId, stateRevision: selection.stateRevision })
    expect(next.pieces.find(piece => piece.instanceId === 'enemy')?.currentHp).toBe(16)
    expect(next.pieces.find(piece => piece.instanceId === 'mortis')?.currentHp).toBe(54)
    expect(skill.keywords).not.toContain('弹射物')
  })
})
