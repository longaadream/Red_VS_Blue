import { describe, expect, it } from 'vitest'

import {
  getNormalMovePath,
  getNormalMoveRejection,
} from '@/lib/game/spatial'
import { makeMap, makePiece } from '../helpers/minimal-state'

const key = ({ x, y }: { x: number; y: number }) => `${x},${y}`

describe('normal movement paths', () => {
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
