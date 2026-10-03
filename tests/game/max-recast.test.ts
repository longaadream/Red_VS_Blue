import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runBattleAction } from '@/lib/game/battle-runner'
import { prepareAction } from '@/lib/game/targeting'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const ROOT_SEED = 18091926

function step(state: BattleState, action: BattleAction): BattleState {
  const next = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state
  next.skillsById = state.skillsById
  return next
}

function fixture(): BattleState {
  const max = makePiece({
    instanceId: 'max',
    templateId: 'max',
    name: '麦克斯',
    x: 0,
    y: 0,
    skills: [{ skillId: 'max-phase-shifter', currentCooldown: 0, usesRemaining: -1 }],
  })
  const state = makeState({ pieces: [max], width: 6, height: 5 })
  state.players[0].actionPoints = 2
  state.skillsById['max-phase-shifter'] = JSON.parse(
    readFileSync(resolve(process.cwd(), 'data/skills/max-phase-shifter.json'), 'utf8'),
  )
  return state
}

function cast(state: BattleState, targetX: number): BattleAction {
  const base: BattleAction = {
    type: 'useBasicSkill',
    playerId: 'player-red',
    pieceId: 'max',
    skillId: 'max-phase-shifter',
  }
  const prepared = prepareAction(state, base)
  if (prepared.kind !== 'needTarget') throw new Error(`Expected target selection, received ${prepared.kind}`)
  return {
    ...base,
    targetX,
    targetY: 0,
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  } as BattleAction
}

describe('Max phase shifter recast', () => {
  it('uses the Chinese action-point wording in its published description', () => {
    const definition = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/max-phase-shifter.json'), 'utf8')) as { description: string; recastActionPointCost: number }
    expect(definition.description).toContain('1行动点')
    expect(definition.description).not.toContain('1AP')
    expect(definition.recastActionPointCost).toBe(1)
    expect(readFileSync(resolve(process.cwd(), 'data/pages/pieces.html'), 'utf8')).toContain('skillData.recastActionPointCost')
    expect(readFileSync(resolve(process.cwd(), 'data/pages/battle.html'), 'utf8')).toContain('skd.recastActionPointCost')
  })

  it('observes first cast, same-turn recast, third cast, and next-turn cooldown', () => {
    let state = fixture()

    state = step(state, cast(state, 2))
    expect(state.players[0].actionPoints).toBe(2)
    expect(state.pieces[0]).toMatchObject({ x: 2, y: 0 })
    expect(state.pieces[0].skills[0].currentCooldown).toBe(0)

    state = step(state, cast(state, 4))
    expect(state.players[0].actionPoints).toBe(1)
    expect(state.pieces[0]).toMatchObject({ x: 4, y: 0 })
    expect(state.pieces[0].skills[0].currentCooldown).toBe(3)

    expect(() => cast(state, 2)).toThrow(/Expected target selection, received invalid/)
    expect(state.players[0].actionPoints).toBe(1)

    state = step(state, { type: 'endTurn', playerId: 'player-red' })
    expect(state.pieces[0].skills[0].currentCooldown).toBe(2)

    state = step(state, { type: 'beginPhase' })
    state = step(state, { type: 'endTurn', playerId: 'player-blue' })
    state = step(state, { type: 'beginPhase' })
    expect(state.pieces[0].skills[0].currentCooldown).toBe(2)
    expect(state.turn.currentPlayerId).toBe('player-red')
  })

  it('rejects the same-turn recast without spending or moving when AP is empty', () => {
    let state = fixture()
    state.players[0].actionPoints = 0

    state = step(state, cast(state, 2))
    expect(state.pieces[0]).toMatchObject({ x: 2, y: 0 })
    const beforeRecast = JSON.stringify(state)
    expect(() => step(state, cast(state, 4))).toThrow(/需要1行动点/)
    expect(JSON.stringify(state)).toBe(beforeRecast)
  })

  it('starts the normal cooldown when the recast window is unused', () => {
    let state = fixture()
    state = step(state, cast(state, 2))
    state = step(state, { type: 'endTurn', playerId: 'player-red' })
    expect(state.pieces[0].skills[0].currentCooldown).toBe(2)
  })

  it('skips an intervening wall instead of resolving a movement path', () => {
    const state = fixture()
    const wall = state.map.tiles.find(tile => tile.x === 1 && tile.y === 0)!
    wall.props = { ...wall.props, type: 'wall', walkable: false, bulletPassable: false }
    const next = step(state, cast(state, 2))
    expect(next.pieces[0]).toMatchObject({ x: 2, y: 0 })
    expect(next.map.tiles.find(tile => tile.x === 1 && tile.y === 0)?.props.type).toBe('wall')
  })

  it('grants a current-turn free move to every living ally without changing move range', () => {
    const skill = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/max-full-speed.json'), 'utf8'))
    const max = makePiece({ instanceId: 'max', templateId: 'max', x: 1, y: 1, moveRange: 5,
      skills: [{ skillId: skill.id, currentCooldown: 0, usesRemaining: -1 }] })
    const ally = makePiece({ instanceId: 'ally', x: 2, y: 2, moveRange: 3 })
    const state = makeState({ pieces: [max, ally] })
    state.skillsById[skill.id] = skill
    state.players[0].chargePoints = 2
    const next = step(state, { type: 'useChargeSkill', playerId: 'player-red', pieceId: 'max', skillId: skill.id })
    expect(next.pieces.find(piece => piece.instanceId === 'max')).toMatchObject({ moveRange: 5 })
    expect(next.pieces.find(piece => piece.instanceId === 'ally')).toMatchObject({ moveRange: 3 })
    expect(next.pieces.find(piece => piece.instanceId === 'max')?.statusTags).toContainEqual(
      expect.objectContaining({ type: 'deployment-first-move-free', stacking: 'independent', currentUses: 1 }),
    )
    expect(next.pieces.find(piece => piece.instanceId === 'ally')?.statusTags).toContainEqual(
      expect.objectContaining({ type: 'deployment-first-move-free', stacking: 'independent', currentUses: 1 }),
    )
    expect(next.pieces.find(piece => piece.instanceId === 'max')?.skills[0].currentCooldown).toBe(1)
  })
})
