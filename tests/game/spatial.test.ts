import { describe, expect, it } from 'vitest'

import {
  allocateSkillFormation,
  getLegalNormalMoveTargets,
  getLegalSkillLandingCells,
  getLivingOccupantAt,
  getManhattanArea,
  getOrthogonalLineCells,
  getSquareArea,
  manhattanDistance,
  resolveExactSkillLanding,
  resolveOrderedSkillLanding,
} from '@/lib/game/spatial'
import { makeMap, makePiece, makeTile } from '../helpers/minimal-state'

const key = ({ x, y }: { x: number; y: number }) => `${x},${y}`

describe('spatial distance and area tools', () => {
  it('曼哈顿距离在小坐标域满足对称、同点为零和三角不等式', () => {
    const points = []
    for (let x = -2; x <= 2; x++) {
      for (let y = -2; y <= 2; y++) points.push({ x, y })
    }

    for (const a of points) {
      expect(manhattanDistance(a, a)).toBe(0)
      for (const b of points) {
        expect(manhattanDistance(a, b)).toBe(manhattanDistance(b, a))
        for (const c of points) {
          expect(manhattanDistance(a, c)).toBeLessThanOrEqual(
            manhattanDistance(a, b) + manhattanDistance(b, c),
          )
        }
      }
    }
  })

  it('默认曼哈顿范围排除超距斜角，3×3 方形范围明确包含斜角', () => {
    const center = { x: 2, y: 2 }
    const bounds = { width: 5, height: 5 }
    const manhattan = new Set(getManhattanArea(center, 1, bounds).map(key))
    const square = new Set(getSquareArea(center, 1, bounds).map(key))

    expect(manhattan.size).toBe(5)
    expect(manhattan.has('3,3')).toBe(false)
    expect(square.size).toBe(9)
    expect(square.has('3,3')).toBe(true)
  })

  it('曼哈顿与方形区域对多个半径保持各自的距离和面积属性', () => {
    const center = { x: 0, y: 0 }
    for (let radius = 0; radius <= 4; radius++) {
      const manhattan = getManhattanArea(center, radius)
      const square = getSquareArea(center, radius)

      expect(manhattan).toHaveLength(1 + 2 * radius * (radius + 1))
      expect(manhattan.every(cell => manhattanDistance(center, cell) <= radius)).toBe(true)
      expect(square).toHaveLength((radius * 2 + 1) ** 2)
      expect(square.every(cell => Math.max(Math.abs(cell.x), Math.abs(cell.y)) <= radius)).toBe(true)
    }
  })

  it('直线格序列排除起点、包含终点，并拒绝斜线', () => {
    expect(getOrthogonalLineCells({ x: 0, y: 1 }, { x: 3, y: 1 })).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ])
    expect(getOrthogonalLineCells({ x: 3, y: 1 }, { x: 0, y: 1 })).toEqual([
      { x: 2, y: 1 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ])
    expect(getOrthogonalLineCells({ x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull()
  })

  it('直线格序列长度等于曼哈顿距离且相邻格始终相差一步', () => {
    const from = { x: 2, y: 2 }
    for (const direction of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]) {
      for (let distance = 1; distance <= 5; distance++) {
        const target = { x: from.x + direction.x * distance, y: from.y + direction.y * distance }
        const line = getOrthogonalLineCells(from, target)

        expect(line).toHaveLength(distance)
        expect(line?.at(-1)).toEqual(target)
        expect(line?.every((cell, index) => manhattanDistance(index === 0 ? from : line[index - 1], cell) === 1)).toBe(true)
      }
    }
  })
})

describe('occupancy and normal movement tools', () => {
  it('占位查询只返回棋盘上的存活棋子，召唤物与普通棋子语义相同', () => {
    const dead = makePiece({ instanceId: 'dead', x: 1, y: 0, currentHp: 0 })
    const summon = makePiece({ instanceId: 'summon', templateId: 'summoned-unit', x: 2, y: 0 })

    expect(getLivingOccupantAt([dead, summon], { x: 1, y: 0 })).toBeUndefined()
    expect(getLivingOccupantAt([dead, summon], { x: 2, y: 0 })?.instanceId).toBe('summon')
  })

  it.each([
    ['斜线', { x: 1, y: 1 }, []],
    ['超距', { x: 4, y: 0 }, []],
    ['路径棋子阻挡', { x: 3, y: 0 }, [makePiece({ instanceId: 'blocker', x: 1, y: 0 })]],
  ])('%s目标不在普通移动合法集合中', (_label, target, blockers) => {
    const mover = makePiece({ instanceId: 'mover', x: 0, y: 0, moveRange: 3 })
    const state = { map: makeMap(6, 5), pieces: [mover, ...blockers] }
    const legal = new Set(getLegalNormalMoveTargets(state, mover).map(key))

    expect(legal.has(key(target))).toBe(false)
  })

  it('不可行走地形截断路径，可行走掩体格可进入和停留', () => {
    const mover = makePiece({ instanceId: 'mover', x: 0, y: 0, moveRange: 4 })
    const map = makeMap(6, 5)
    map.tiles = map.tiles.map(tile => {
      if (tile.x === 1 && tile.y === 0) {
        return { ...makeTile(1, 0, true), props: { ...makeTile(1, 0, true).props, type: 'cover' } }
      }
      if (tile.x === 2 && tile.y === 0) {
        return { ...makeTile(2, 0, false), props: { ...makeTile(2, 0, false).props, type: 'hole' } }
      }
      return tile
    })

    const legal = new Set(getLegalNormalMoveTargets({ map, pieces: [mover] }, mover).map(key))
    expect(legal.has('1,0')).toBe(true)
    expect(legal.has('2,0')).toBe(false)
    expect(legal.has('3,0')).toBe(false)
  })
})

describe('RED-174 shared skill landing tools', () => {
  it('exact landing cancels for occupied, reserved, or unwalkable cells', () => {
    const occupant = makePiece({ instanceId: 'occupant', x: 1, y: 1 })
    const map = makeMap(4, 3)
    map.tiles = map.tiles.map(tile => tile.x === 3 && tile.y === 1 ? makeTile(3, 1, false) : tile)
    const state = { map, pieces: [occupant] }

    expect(resolveExactSkillLanding(state, { x: 1, y: 1 })).toBeUndefined()
    expect(resolveExactSkillLanding(state, { x: 2, y: 1 }, { reservedCells: [{ x: 2, y: 1 }] })).toBeUndefined()
    expect(resolveExactSkillLanding(state, { x: 3, y: 1 })).toBeUndefined()
    expect(resolveExactSkillLanding(state, { x: 0, y: 2 })).toEqual({ x: 0, y: 2 })
  })

  it('nearby landing preserves candidate priority while skipping illegal and duplicate cells', () => {
    const occupant = makePiece({ instanceId: 'occupant', x: 1, y: 0 })
    const state = { map: makeMap(4, 3), pieces: [occupant] }
    const candidates = [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]

    expect(getLegalSkillLandingCells(state, candidates, { reservedCells: [{ x: 2, y: 0 }] }))
      .toEqual([{ x: 3, y: 0 }])
    expect(resolveOrderedSkillLanding(state, candidates, { reservedCells: [{ x: 2, y: 0 }] }))
      .toEqual({ x: 3, y: 0 })
  })

  it('formation treats every mover as vacating its old cell and commits only a complete allocation', () => {
    const first = makePiece({ instanceId: 'first', x: 0, y: 0 })
    const second = makePiece({ instanceId: 'second', x: 1, y: 0 })
    const blocker = makePiece({ instanceId: 'blocker', x: 2, y: 0 })
    const state = { map: makeMap(4, 2), pieces: [first, second, blocker] }
    const candidates = [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]

    expect(allocateSkillFormation(state, ['first', 'second'], candidates)).toEqual([
      { x: 1, y: 0 },
      { x: 3, y: 0 },
    ])
    expect(allocateSkillFormation(state, ['first', 'second'], candidates, {
      reservedCells: [{ x: 3, y: 0 }],
    })).toBeUndefined()
  })
})
