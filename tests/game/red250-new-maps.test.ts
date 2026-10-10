import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMapFromAscii, type AsciiMapConfig } from '@/lib/game/map'
import { assertSelectableMapId } from '@/lib/game/map-selection'

const ids = ['twin-bridges', 'crossroads-plaza', 'island-courtyard', 'broad-ring']
function load(id: string) {
  const config = JSON.parse(readFileSync(resolve('data/maps', `${id}.json`), 'utf8')) as AsciiMapConfig
  return createMapFromAscii(config)
}
function walkable(id: string) {
  return new Set(load(id).tiles.filter(t => t.props.walkable).map(t => `${t.x},${t.y}`))
}
function components(cells: Set<string>) {
  const remaining = new Set(cells), groups: Set<string>[] = []
  while (remaining.size) {
    const start = remaining.values().next().value!
    const group = new Set<string>(), queue = [start]
    remaining.delete(start)
    while (queue.length) {
      const cell = queue.pop()!
      group.add(cell)
      const [x, y] = cell.split(',').map(Number)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = `${x + dx},${y + dy}`
        if (remaining.delete(next)) queue.push(next)
      }
    }
    groups.push(group)
  }
  return groups
}

describe('RED-250 new selectable maps', () => {
  it.each(ids)('%s is neutral, deployable and fully connected', id => {
    const map = load(id)
    expect(assertSelectableMapId(id)).toBe(id)
    expect(map).toMatchObject({id, width:20, height:16})
    expect(map.tiles.filter(t => t.props.type === 'floor' && t.props.walkable).length).toBeGreaterThanOrEqual(64)
    expect(map.tiles.every(t => ['floor','wall','cover','hole'].includes(t.props.type))).toBe(true)
    expect(components(walkable(id))).toHaveLength(1)
  })
  it('connects two halves through exactly two single-cell-wide bridges', () => {
    const cells = walkable('twin-bridges')
    const bridgeCells = [...cells].filter(c => [9,10].includes(Number(c.split(',')[0])))
    expect(bridgeCells.sort()).toEqual(['10,11','10,4','9,11','9,4'])
    for (const y of [4,11]) {
      const oneBridge = new Set(cells)
      oneBridge.delete(`9,${y}`); oneBridge.delete(`10,${y}`)
      expect(components(oneBridge)).toHaveLength(1)
    }
    const noBridges = new Set(cells)
    bridgeCells.forEach(c => noBridges.delete(c))
    const halves = components(noBridges)
    expect(halves).toHaveLength(2)
    expect(halves.map(c => c.size).sort()).toEqual([112,112])
  })
  it.each(ids.slice(1))('%s has no single-cell bottleneck', id => {
    const cells = walkable(id)
    for (const cell of cells) {
      const removed = new Set(cells)
      removed.delete(cell)
      expect(components(removed), `removing ${cell}`).toHaveLength(1)
    }
  })
})
