import { describe, expect, it } from 'vitest'

import {
  finalizePendingTargetSession,
  prepareAction,
} from '@/lib/game/targeting'
import { makePiece, makeState, makeTile } from '../helpers/minimal-state'

function targetedSkill(id: string, targeting: Record<string, unknown>) {
  return {
    id,
    name: id,
    description: '',
    kind: 'active' as const,
    type: 'normal' as const,
    cooldownTurns: 0,
    maxCharges: 0,
    powerMultiplier: 1,
    actionPointCost: 1,
    range: 'single' as const,
    requiresTarget: true,
    code: '',
    targeting,
  }
}

function skillAction(skillId: string) {
  return {
    type: 'useBasicSkill' as const,
    playerId: 'player-red',
    pieceId: 'caster',
    skillId,
  }
}

describe('authoritative target range overlays', () => {
  it('reports the full Manhattan geometry separately from legal piece candidates', () => {
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 2, y: 2 })
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 3, y: 2 })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 4, y: 2 })
    caster.skills = [{ skillId: 'range-shot', currentCooldown: 0, usesRemaining: -1 }] as never
    const state = makeState({ pieces: [caster, ally, enemy], width: 5, height: 5 })
    state.map.tiles = state.map.tiles.map(tile => (
      tile.x === 2 && tile.y === 3 ? makeTile(2, 3, false) : tile
    )) as never
    state.skillsById['range-shot'] = targetedSkill('range-shot', {
      steps: [{ kind: 'target', type: 'piece', filter: 'enemy', range: 2 }],
    }) as never

    const prepared = prepareAction(state, skillAction('range-shot'))

    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    expect(prepared.candidates).toEqual([{ type: 'piece', pieceId: 'enemy' }])
    expect(prepared.rangeCells).toHaveLength(13)
    expect(prepared.rangeCells).toEqual(expect.arrayContaining([
      { x: 2, y: 2 }, // source cell is part of the piece range overlay
      { x: 3, y: 2 }, // occupied ally remains visible in the geometry
      { x: 2, y: 3 }, // blocked terrain remains visible in the geometry
      { x: 4, y: 2 }, // legal enemy target shares the same overlay
    ]))
  })

  it('applies cardinal direction, minimum range, and source-cell exclusion only to geometry', () => {
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 2, y: 2 })
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 3, y: 2 })
    caster.skills = [{ skillId: 'line-blink', currentCooldown: 0, usesRemaining: -1 }] as never
    const state = makeState({ pieces: [caster, ally], width: 5, height: 5 })
    state.map.tiles = state.map.tiles.map(tile => (
      tile.x === 4 && tile.y === 2 ? makeTile(4, 2, false) : tile
    )) as never
    state.skillsById['line-blink'] = targetedSkill('line-blink', {
      steps: [{
        kind: 'target', type: 'cell', filter: 'all', range: 2, minRange: 2,
        sameRowOrColumn: true, excludeSourceCell: true,
        requireWalkable: true, requireUnoccupied: true,
      }],
    }) as never

    const prepared = prepareAction(state, skillAction('line-blink'))

    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    expect(prepared.rangeCells).toEqual([
      { x: 2, y: 0 },
      { x: 0, y: 2 },
      { x: 4, y: 2 },
      { x: 2, y: 4 },
    ])
    // Cell validation intentionally continues to ignore minRange, so the
    // adjacent free cell remains a legal candidate while absent from rangeCells.
    expect(prepared.candidates).toEqual([
      { type: 'cell', x: 2, y: 0 },
      { type: 'cell', x: 2, y: 1 },
      { type: 'cell', x: 0, y: 2 },
      { type: 'cell', x: 1, y: 2 },
      { type: 'cell', x: 2, y: 3 },
      { type: 'cell', x: 2, y: 4 },
    ])
  })

  it('clips Chebyshev geometry to the map edge', () => {
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 0, y: 0 })
    caster.skills = [{ skillId: 'edge-blink', currentCooldown: 0, usesRemaining: -1 }] as never
    const state = makeState({ pieces: [caster], width: 3, height: 3 })
    state.skillsById['edge-blink'] = targetedSkill('edge-blink', {
      steps: [{ kind: 'target', type: 'cell', filter: 'all', range: 1, distanceMetric: 'chebyshev' }],
    }) as never

    const prepared = prepareAction(state, skillAction('edge-blink'))

    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    expect(prepared.rangeCells).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ])
  })

  it('uses the selected target as the authoritative origin for an origin-indexed step', () => {
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 0, y: 0 })
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 3, y: 3 })
    caster.skills = [{ skillId: 'ally-origin', currentCooldown: 0, usesRemaining: -1 }] as never
    const state = makeState({ pieces: [caster, ally], width: 6, height: 6 })
    state.skillsById['ally-origin'] = targetedSkill('ally-origin', {
      steps: [
        { kind: 'target', type: 'piece', filter: 'ally' },
        { kind: 'target', type: 'cell', filter: 'all', range: 1, originSelectedTargetIndex: 0 },
      ],
    }) as never
    const action = skillAction('ally-origin')
    const first = prepareAction(state, action)
    expect(first.kind).toBe('needTarget')
    if (first.kind !== 'needTarget') return
    expect(first.rangeCells).toBeUndefined()

    const second = prepareAction(state, {
      ...action,
      targetPieceId: 'ally',
      selectionId: first.selectionId,
      stateRevision: first.stateRevision,
    })

    expect(second.kind).toBe('needTarget')
    if (second.kind !== 'needTarget') return
    expect(second.rangeCells).toEqual([
      { x: 3, y: 2 },
      { x: 2, y: 3 },
      { x: 3, y: 3 },
      { x: 4, y: 3 },
      { x: 3, y: 4 },
    ])
    expect(second.rangeCells).not.toContainEqual({ x: 0, y: 0 })
  })

  it('reuses secondary distanceFromSelectedTarget geometry for pending sessions', () => {
    const origin = makePiece({ instanceId: 'origin', ownerPlayerId: 'player-red', x: 2, y: 2 })
    const state = makeState({ pieces: [origin], width: 5, height: 5 })
    const finalized = finalizePendingTargetSession(state, {
      playerId: 'player-red',
      targetType: 'cell',
      filter: 'all',
      steps: [{
        type: 'cell',
        filter: 'all',
        distanceFromSelectedTarget: { index: 0, range: 1, minRange: 1 },
      }],
      selectedTargets: [{ type: 'piece', pieceId: 'origin' }],
    }, 4)

    expect(finalized.rangeCells).toEqual([
      { x: 2, y: 1 },
      { x: 1, y: 2 },
      { x: 3, y: 2 },
      { x: 2, y: 3 },
    ])
    expect(finalized.candidates).toEqual(finalized.rangeCells?.map(cell => ({ type: 'cell' as const, ...cell })))
    expect(finalized.selectionId).toBeDefined()
    expect(finalized.stateRevision).toBe(4)
  })

  it('omits the overlay when a finite range has no positioned source or when range is unbounded', () => {
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 1, y: 1 })
    caster.skills = [{ skillId: 'unbounded', currentCooldown: 0, usesRemaining: -1 }] as never
    const state = makeState({ pieces: [caster], width: 4, height: 4 })
    state.skillsById['unbounded'] = targetedSkill('unbounded', {
      steps: [{ kind: 'target', type: 'piece', filter: 'enemy' }],
    }) as never
    const unbounded = prepareAction(state, skillAction('unbounded'))
    expect(unbounded.kind).toBe('needTarget')
    if (unbounded.kind !== 'needTarget') return
    expect(unbounded.rangeCells).toBeUndefined()

    ;(caster as unknown as { x?: number }).x = undefined
    state.skillsById['unbounded'] = targetedSkill('unbounded', {
      steps: [{ kind: 'target', type: 'piece', filter: 'enemy', range: 2 }],
    }) as never
    const unpositioned = prepareAction(state, skillAction('unbounded'))
    expect(unpositioned.kind).toBe('needTarget')
    if (unpositioned.kind !== 'needTarget') return
    expect(unpositioned.rangeCells).toBeUndefined()

    const pendingWithoutSource = finalizePendingTargetSession(state, {
      playerId: 'player-red', targetType: 'cell', range: 2, filter: 'all',
    }, 0)
    expect(pendingWithoutSource.rangeCells).toBeUndefined()
  })
})
