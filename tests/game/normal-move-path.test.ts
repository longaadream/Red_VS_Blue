import { describe, expect, it } from 'vitest'

import {
  getLegalNormalMoveTargets,
  getNormalMoveContinuationTargets,
  getNormalMovePreviewContinuationTargets,
  getNormalMovePath,
  getNormalMoveRejection,
} from '@/lib/game/spatial'
import { makeMap, makePiece } from '../helpers/minimal-state'

const key = ({ x, y }: { x: number; y: number }) => `${x},${y}`

describe('normal movement paths', () => {
  it('uses predicted movement restrictions and excludes previously walked cells', () => {
    const mover = makePiece({ instanceId: 'mover', x: 2, y: 2, moveRange: 4 })
    const state = { map: makeMap(5, 5), pieces: [mover] }
    const visited = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }]
    const before = JSON.stringify(state)
    const targets = getNormalMovePreviewContinuationTargets(state, mover, 2, visited)
    expect(targets.map(key)).toContain('3,2')
    expect(targets.map(key)).not.toContain('2,1')
    expect(targets.map(key)).not.toContain('4,3')
    expect(JSON.stringify(state)).toBe(before)
    const rooted = { ...mover, statusTags: [{ type: 'root', remainingDuration: 1 }] }
    expect(getNormalMovePreviewContinuationTargets({ ...state, pieces: [rooted] }, rooted, 2, visited)).toEqual([])
  })
  it('treats an empty prefix as the original move origin', () => {
    const mover = makePiece({ instanceId: 'mover', x: 1, y: 1, moveRange: 3 })
    const state = { map: makeMap(5, 4), pieces: [mover] }

    expect(getNormalMoveContinuationTargets(state, mover, [])).toEqual(getLegalNormalMoveTargets(state, mover))
  })

  it('finds a deterministic cardinal route around an occupied cell', () => {
    const mover = makePiece({ instanceId: 'mover', x: 0, y: 0, moveRange: 4 })
    const blocker = makePiece({ instanceId: 'blocker', x: 1, y: 0 })
    const state = { map: makeMap(5, 4), pieces: [mover, blocker] }

    expect(getNormalMovePath(state, mover, { x: 2, y: 0 })?.map(key)).toEqual([
      '0,1', '1,1', '2,1', '2,0',
    ])
  })

  it('honors ordered waypoints while keeping the route within moveRange', () => {
    const mover = makePiece({ instanceId: 'mover', x: 0, y: 0, moveRange: 5 })
    const state = { map: makeMap(5, 4), pieces: [mover] }

    expect(getNormalMovePath(state, mover, { x: 2, y: 2 }, [{ x: 2, y: 0 }])?.map(key)).toEqual([
      '1,0', '2,0', '2,1', '2,2',
    ])
  })

  it('backtracks through alternate segment routes when a greedy waypoint path dead-ends', () => {
    const mover = makePiece({ instanceId: 'mover', x: 0, y: 0, moveRange: 4 })
    const blocker = makePiece({ instanceId: 'blocker', x: 2, y: 1 })
    const state = { map: makeMap(3, 2), pieces: [mover, blocker] }

    expect(getNormalMovePath(state, mover, { x: 2, y: 0 }, [{ x: 1, y: 1 }])?.map(key)).toEqual([
      '0,1', '1,1', '1,0', '2,0',
    ])
  })

  it('does not enumerate normal routes for rooted or imprisoned pieces', () => {
    const mover = makePiece({ instanceId: 'mover', x: 0, y: 0, statusTags: [{ id: 'root', type: 'root' }] })
    const state = { map: makeMap(3, 2), pieces: [mover] }

    expect(getNormalMovePath(state, mover, { x: 1, y: 1 })).toBeNull()
    expect(getNormalMoveRejection(state, mover, { x: 1, y: 1 })).toMatchObject({ code: 'movement-restricted' })
  })

  it('bounds ordered-waypoint search even when moveRange is edited to a huge value', () => {
    const mover = makePiece({ instanceId: 'mover', x: 0, y: 0, moveRange: Number.MAX_SAFE_INTEGER })
    const map = makeMap(3, 3)
    map.tiles = map.tiles.map(tile => tile.x === 1 && tile.y === 0 || tile.x === 0 && tile.y === 1
      ? { ...tile, props: { ...tile.props, walkable: false } }
      : tile)
    const state = { map, pieces: [mover] }

    expect(getNormalMovePath(state, mover, { x: 2, y: 2 }, [{ x: 1, y: 1 }])).toBeNull()
  })

  it('shrinks the original move range after a valid prefix', () => {
    const mover = makePiece({ instanceId: 'mover', x: 0, y: 0, moveRange: 3 })
    const state = { map: makeMap(6, 2), pieces: [mover] }

    expect(getNormalMoveContinuationTargets(state, mover, [{ x: 1, y: 0 }]).map(key)).toEqual([
      '2,0', '1,1', '3,0', '2,1', '0,1',
    ])
    expect(getNormalMoveContinuationTargets(state, mover, [{ x: 1, y: 0 }])).not.toContainEqual({ x: 4, y: 0 })
  })

  it('uses the remaining budget for a long detour instead of endpoint distance', () => {
    const mover = makePiece({ instanceId: 'mover', x: 0, y: 1, moveRange: 5 })
    const map = makeMap(5, 3)
    map.tiles = map.tiles.map(tile => tile.x === 2 && tile.y === 1
      ? { ...tile, props: { ...tile.props, walkable: false } }
      : tile)
    const state = { map, pieces: [mover] }

    const targets = getNormalMoveContinuationTargets(state, mover, [{ x: 1, y: 1 }])
    expect(targets.map(key)).toContain('3,1')
    expect(targets.map(key)).not.toContain('4,1')
  })

  it('does not revisit the origin or any earlier prefix cell', () => {
    const mover = makePiece({ instanceId: 'mover', x: 0, y: 0, moveRange: 4 })
    const state = { map: makeMap(4, 3), pieces: [mover] }

    const targets = getNormalMoveContinuationTargets(state, mover, [{ x: 1, y: 0 }, { x: 1, y: 1 }])
    expect(targets.map(key)).not.toContain('0,0')
    expect(targets.map(key)).not.toContain('1,0')
    expect(targets.map(key)).not.toContain('1,1')
  })

  it('rejects blockers, rooted pieces, and invalid prefixes', () => {
    const blocker = makePiece({ instanceId: 'blocker', x: 2, y: 0 })
    const mover = makePiece({ instanceId: 'mover', x: 0, y: 0, moveRange: 3 })
    const state = { map: makeMap(5, 2), pieces: [mover, blocker] }

    expect(getNormalMoveContinuationTargets(state, mover, [{ x: 1, y: 0 }]).map(key)).not.toContain('3,0')
    expect(getNormalMoveContinuationTargets(state, mover, [{ x: 2, y: 0 }])).toEqual([])
    expect(getNormalMoveContinuationTargets(state, mover, [{ x: 1, y: 1 }])).toEqual([])
    expect(getNormalMoveContinuationTargets(state, {
      ...mover,
      statusTags: [{ type: 'root' }],
    }, [])).toEqual([])
  })

  it('does not mutate the state or prefix input', () => {
    const mover = makePiece({ instanceId: 'mover', x: 0, y: 0, moveRange: 3 })
    const state = { map: makeMap(4, 3), pieces: [mover] }
    const path = [{ x: 1, y: 0 }]
    const stateBefore = JSON.stringify(state)
    const pathBefore = JSON.stringify(path)

    expect(getNormalMoveContinuationTargets(state, mover, path)).toEqual(expect.any(Array))
    expect(JSON.stringify(state)).toBe(stateBefore)
    expect(JSON.stringify(path)).toBe(pathBefore)
  })

  it.each([
    ['malformed', { x: 2, y: 0 }, 3, [{ x: 1, y: 0 }, { x: 1.5, y: 0 }], 'malformed-path'],
    ['nonadjacent', { x: 2, y: 0 }, 3, [{ x: 2, y: 0 }], 'nonadjacent-path'],
    ['repeated', { x: 2, y: 0 }, 3, [{ x: 1, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }], 'repeated-path'],
    ['out-of-range', { x: 3, y: 0 }, 2, [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }], 'out-of-range'],
  ] as const)('rejects a %s explicit route without mutating state', (_label, target, moveRange, path, code) => {
    const mover = makePiece({ instanceId: 'mover', x: 0, y: 0, moveRange })
    const state = { map: makeMap(5, 4), pieces: [mover] }
    const before = JSON.stringify(state)

    expect(getNormalMoveRejection(state, mover, target, path as unknown as readonly { x: number; y: number }[])).toMatchObject({ code })
    expect(JSON.stringify(state)).toBe(before)
  })
})
