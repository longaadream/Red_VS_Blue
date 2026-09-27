import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { createMapFromAscii, type AsciiMapConfig, type BoardMap, type Tile } from '@/lib/game/map'
import { clearMapsCache, getMapById, loadMaps } from '@/lib/game/map-repository'

const mapsDirectory = resolve(process.cwd(), 'data', 'maps')
const definitions = [
  { id: 'sparse-center', filename: 'sparse-center.json', name: '疏落中场', layoutHash: 'b9fb315902c3b36eb7751a2b077decbe80a30b35b852e4910b27d95baa87b685' },
  { id: 'broken-waterway', filename: 'broken-waterway.json', name: '断续水道', layoutHash: '8467df74b58ff4f9921dcda79e631de5c7829344fd00879d4ce577ba3b300ad2' },
  { id: 'four-corner-flanks', filename: 'four-corner-flanks.json', name: '四角迂回', layoutHash: '6466da8ade875bbcf5a4795f8bab9f07cc9c9dd18d33f3dd12795e14e2ead630' },
  { id: 'staggered-outposts', filename: 'staggered-outposts.json', name: '错位散点', layoutHash: '50c6b3088d330ea6e6cde14fdf263cf31ffce8ad002cc3cad18267dfd5c4c805' },
] as const

function loadConfig(filename: string): AsciiMapConfig {
  return JSON.parse(readFileSync(resolve(mapsDirectory, filename), 'utf8')) as AsciiMapConfig
}

function tileAt(map: BoardMap, x: number, y: number): Tile {
  const tile = map.tiles.find(candidate => candidate.x === x && candidate.y === y)
  if (!tile) throw new Error(`Missing tile (${x},${y}) in ${map.id}`)
  return tile
}

function walkableComponent(map: BoardMap): Set<string> {
  const walkable = new Set(
    map.tiles
      .filter(tile => tile.props.walkable)
      .map(tile => `${tile.x},${tile.y}`),
  )
  const first = walkable.values().next().value as string | undefined
  const visited = new Set<string>()
  if (!first) return visited
  const queue = [first]
  for (let index = 0; index < queue.length; index += 1) {
    const key = queue[index]!
    if (visited.has(key)) continue
    visited.add(key)
    const [x, y] = key.split(',').map(Number)
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const neighbor = `${x + dx},${y + dy}`
      if (walkable.has(neighbor) && !visited.has(neighbor)) queue.push(neighbor)
    }
  }
  return visited
}

function layoutHash(layout: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify(layout))
    .digest('hex')
}

beforeEach(() => clearMapsCache())

describe('RED-218 V4 map catalog', () => {
  it('keeps each formal map at its approved source layout hash and shared open-expanse legend', () => {
    const sharedLegend = loadConfig('open-expanse.json').legend
    const manifest = JSON.parse(readFileSync(resolve(mapsDirectory, 'manifest.json'), 'utf8')) as string[]

    expect(manifest).toEqual(expect.arrayContaining(definitions.map(definition => definition.id)))
    for (const definition of definitions) {
      const raw = JSON.parse(readFileSync(resolve(mapsDirectory, definition.filename), 'utf8')) as Record<string, unknown>
      const config = raw as unknown as AsciiMapConfig

      expect(config.id).toBe(definition.id)
      expect(config.name).toBe(definition.name)
      expect(layoutHash(config.layout)).toBe(definition.layoutHash)
      expect(config.legend).toEqual(sharedLegend)
      expect(raw).not.toHaveProperty('previewOnly')
      expect(raw).not.toHaveProperty('width')
      expect(raw).not.toHaveProperty('height')
    }
  })

  it.each(definitions)('loads $id as a 20x16 map with valid board geometry', async definition => {
    await loadMaps()
    const config = loadConfig(definition.filename)
    const map = createMapFromAscii(config)
    const loaded = getMapById(definition.id)

    expect(loaded).toEqual(map)
    expect(loaded).toMatchObject({ id: definition.id, name: definition.name, width: 20, height: 16 })
    expect(map.tiles).toHaveLength(320)

    for (let x = 0; x < map.width; x += 1) {
      expect(tileAt(map, x, 0).props).toMatchObject({ type: 'wall', walkable: false, bulletPassable: false })
      expect(tileAt(map, x, map.height - 1).props).toMatchObject({ type: 'wall', walkable: false, bulletPassable: false })
    }
    for (let y = 0; y < map.height; y += 1) {
      expect(tileAt(map, 0, y).props).toMatchObject({ type: 'wall', walkable: false, bulletPassable: false })
      expect(tileAt(map, map.width - 1, y).props).toMatchObject({ type: 'wall', walkable: false, bulletPassable: false })
    }

    for (const tile of map.tiles) {
      const opposite = tileAt(map, map.width - 1 - tile.x, map.height - 1 - tile.y)
      expect(tile.props).toEqual(opposite.props)
    }

    const walkable = map.tiles.filter(tile => tile.props.walkable)
    expect(walkableComponent(map).size).toBe(walkable.length)
    const ordinaryFloorCount = walkable.filter(tile => tile.props.type === 'floor').length
    expect(ordinaryFloorCount).toBeGreaterThanOrEqual(16)
  })

  it('pins the four approved source preview layout hashes', () => {
    expect(definitions.map(definition => layoutHash(loadConfig(definition.filename).layout))).toEqual([
      'b9fb315902c3b36eb7751a2b077decbe80a30b35b852e4910b27d95baa87b685',
      '8467df74b58ff4f9921dcda79e631de5c7829344fd00879d4ce577ba3b300ad2',
      '6466da8ade875bbcf5a4795f8bab9f07cc9c9dd18d33f3dd12795e14e2ead630',
      '50c6b3088d330ea6e6cde14fdf263cf31ffce8ad002cc3cad18267dfd5c4c805',
    ])
  })
})
