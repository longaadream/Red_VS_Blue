import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applyBattleAction } from '@/lib/game/turn'
import { loadRuleById } from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import { makePiece, makeState } from '../helpers/minimal-state'

const definition = JSON.parse(
  readFileSync(resolve(process.cwd(), 'data/skills/shadow-ride-sweep.json'), 'utf8'),
)

function prepareShadow(momentum: number, pieces: ReturnType<typeof makePiece>[]) {
  const shadow = makePiece({
    instanceId: 'shadow',
    templateId: 'shadow',
    ownerPlayerId: 'player-red',
    x: 1,
    y: 5,
    attack: 5,
    skills: [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 }],
  })
  shadow.momentum = momentum
  shadow.statusTags = [{ type: 'momentum-core', stacks: momentum, skillIds: [definition.id] }]
  shadow.rules = [loadRuleById('rule-momentum-consume')!]
  const state = makeState({ pieces: [shadow, ...pieces], width: 7, height: 8 })
  state.skillsById[definition.id] = definition
  state.players[0].actionPoints = 10
  return { shadow, state }
}

function resolveSideFire(state: ReturnType<typeof makeState>, targetY = 4) {
  const prepared = prepareAction(state, {
    type: 'useBasicSkill', playerId: 'player-red', pieceId: 'shadow', skillId: definition.id,
  })
  if (prepared.kind !== 'needTarget') throw new Error('骑射横扫未请求冲刺终点')

  const selectingSide = applyBattleAction(state, {
    type: 'useBasicSkill', playerId: 'player-red', pieceId: 'shadow', skillId: definition.id,
    targetX: 4, targetY: 5, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision,
  })
  const pending = selectingSide.pendingTargetSelection
  if (!pending) throw new Error('骑射横扫未请求侧射地格')

  return {
    selectingSide,
    pending,
    result: applyBattleAction(selectingSide, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetX: 4, targetY,
      selectionId: pending.selectionId, stateRevision: pending.stateRevision,
    }),
  }
}

describe('RED-218 Shadow ride sweep regressions', () => {
  it('fires from every dash cell to the board edge and hits a cover occupant before cover blocks', () => {
    expect(definition.description).toContain('可穿过友军和敌军棋子')
    const coverEnemy = makePiece({
      instanceId: 'cover-enemy', ownerPlayerId: 'player-blue', x: 3, y: 2, currentHp: 20, maxHp: 20,
    })
    const behindCover = makePiece({
      instanceId: 'behind-cover', ownerPlayerId: 'player-blue', x: 3, y: 1, currentHp: 20, maxHp: 20,
    })
    const beyondFour = makePiece({
      instanceId: 'beyond-four', ownerPlayerId: 'player-blue', x: 2, y: 0, currentHp: 20, maxHp: 20,
    })
    const finalDashCellRay = makePiece({
      instanceId: 'final-dash-cell-ray', ownerPlayerId: 'player-blue', x: 4, y: 0, currentHp: 20, maxHp: 20,
    })
    const ally = makePiece({
      instanceId: 'ally', ownerPlayerId: 'player-red', x: 2, y: 3, currentHp: 20, maxHp: 20,
    })
    const { state } = prepareShadow(5, [coverEnemy, behindCover, beyondFour, finalDashCellRay, ally])
    const cover = state.map.tiles.find(tile => tile.x === 3 && tile.y === 2)!
    cover.props = { ...cover.props, type: 'cover', walkable: true, bulletPassable: false }

    const { result } = resolveSideFire(state)

    expect(result.pieces.find(piece => piece.instanceId === 'cover-enemy')?.currentHp).toBe(15)
    expect(result.pieces.find(piece => piece.instanceId === 'behind-cover')?.currentHp).toBe(20)
    expect(result.pieces.find(piece => piece.instanceId === 'beyond-four')?.currentHp).toBe(15)
    expect(result.pieces.find(piece => piece.instanceId === 'final-dash-cell-ray')?.currentHp).toBe(15)
    expect(result.pieces.find(piece => piece.instanceId === 'ally')?.currentHp).toBe(20)
  })

  it.each([
    [5, 5],
    [7, 7],
  ])('uses the cast momentum for side damage and resumes the pending action once at momentum %i', (momentum, expectedDamage) => {
    const pathEnemy = makePiece({
      instanceId: 'path-enemy', ownerPlayerId: 'player-blue', x: 3, y: 5, currentHp: 20, maxHp: 20,
    })
    const sideEnemy = makePiece({
      instanceId: 'side-enemy', ownerPlayerId: 'player-blue', x: 2, y: 4, currentHp: 20, maxHp: 20,
    })
    const { state } = prepareShadow(momentum, [pathEnemy, sideEnemy])
    const resolved = resolveSideFire(state)

    expect(resolved.selectingSide.pieces.find(piece => piece.instanceId === 'path-enemy')?.currentHp).toBe(20)
    expect(resolved.selectingSide.pieces.find(piece => piece.instanceId === 'side-enemy')?.currentHp).toBe(20)
    expect(resolved.result.pendingTargetSelection).toBeUndefined()
    expect(resolved.result.pieces.find(piece => piece.instanceId === 'path-enemy')?.currentHp).toBe(20 - expectedDamage)
    expect(resolved.result.pieces.find(piece => piece.instanceId === 'side-enemy')?.currentHp).toBe(20 - expectedDamage)
    const nextShadow = resolved.result.pieces.find(piece => piece.instanceId === 'shadow')
    expect((nextShadow as { momentum?: number } | undefined)?.momentum).toBe(3)
  })
})
