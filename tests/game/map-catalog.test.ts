import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadJsonFilesServer } from '@/lib/game/file-loader'
import { createMapFromAscii, type AsciiMapConfig, type TileType } from '@/lib/game/map'
import { clearMapsCache, getAllMaps, loadMaps } from '@/lib/game/map-repository'

const mapsDirectory = resolve(process.cwd(), 'data/maps')
const newMaps = [
  { filename: 'open-expanse', id: 'open-expanse' },
  { filename: 'winding-pass', id: 'winding-pass' },
  { filename: 'narrow-corridors', id: 'narrow-corridors' },
] as const

const allowedTileTypes = new Set<TileType>([
  'floor',
  'wall',
  'cover',
  'hole',
])
const forbiddenTileTypes = new Set<TileType>(['lava', 'spring', 'chargepad'])
const forbiddenEffectFields = ['damagePerTurn', 'healPerTurn', 'chargePerTurn'] as const
const neutralTileSemantics = {
  floor: { walkable: true, bulletPassable: true },
  wall: { walkable: false, bulletPassable: false },
  cover: { walkable: true, bulletPassable: false },
  hole: { walkable: false, bulletPassable: true },
} as const
const directions = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const

const loadMapJson = (filename: string) => readFileSync(
  resolve(mapsDirectory, `${filename}.json`),
  'utf8',
)

const loadConfig = (filename: string) => JSON.parse(loadMapJson(filename)) as AsciiMapConfig

const sha256 = (filename: string) => createHash('sha256')
  .update(readFileSync(resolve(mapsDirectory, filename)))
  .digest('hex')

const coordinateKey = (x: number, y: number) => `${x},${y}`
const semanticGrid = (config: AsciiMapConfig) => {
  const map = createMapFromAscii(config)
  const grid = Array.from(
    { length: map.height },
    () => Array.from({ length: map.width }, () => ''),
  )
  for (const tile of map.tiles) {
    grid[tile.y][tile.x] = JSON.stringify([
      tile.props.type,
      tile.props.walkable,
      tile.props.bulletPassable,
    ])
  }
  return grid
}

const analyzeMap = (config: AsciiMapConfig) => {
  const map = createMapFromAscii(config)
  const semantics = semanticGrid(config)
  const walkable = new Map(
    map.tiles
      .filter(tile => tile.props.walkable === true)
      .map(tile => [coordinateKey(tile.x, tile.y), tile] as const),
  )
  const neighbors = (key: string) => {
    const tile = walkable.get(key)
    if (!tile) return []
    return directions.flatMap(([dx, dy]) => {
      const neighbor = walkable.get(coordinateKey(tile.x + dx, tile.y + dy))
      return neighbor ? [neighbor] : []
    })
  }

  const start = walkable.values().next().value
  const visited = new Set<string>()
  const queue = start ? [start] : []
  for (let index = 0; index < queue.length; index += 1) {
    const tile = queue[index]
    const key = coordinateKey(tile.x, tile.y)
    if (visited.has(key)) continue
    visited.add(key)
    for (const neighbor of neighbors(key)) {
      const neighborKey = coordinateKey(neighbor.x, neighbor.y)
      if (!visited.has(neighborKey)) queue.push(neighbor)
    }
  }

  const longestStraightRun = () => {
    let longest = 0
    for (let y = 0; y < map.height; y += 1) {
      let streak = 0
      for (let x = 0; x < map.width; x += 1) {
        streak = walkable.has(coordinateKey(x, y)) ? streak + 1 : 0
        longest = Math.max(longest, streak)
      }
    }
    for (let x = 0; x < map.width; x += 1) {
      let streak = 0
      for (let y = 0; y < map.height; y += 1) {
        streak = walkable.has(coordinateKey(x, y)) ? streak + 1 : 0
        longest = Math.max(longest, streak)
      }
    }
    return longest
  }

  const discovery = new Map<string, number>()
  const low = new Map<string, number>()
  const parents = new Map<string, string>()
  const articulationPoints = new Set<string>()
  let time = 0

  const visit = (key: string) => {
    time += 1
    discovery.set(key, time)
    low.set(key, time)
    let childCount = 0

    for (const neighbor of neighbors(key)) {
      const neighborKey = coordinateKey(neighbor.x, neighbor.y)
      if (!discovery.has(neighborKey)) {
        childCount += 1
        parents.set(neighborKey, key)
        visit(neighborKey)
        low.set(key, Math.min(low.get(key)!, low.get(neighborKey)!))

        if (!parents.has(key) && childCount > 1) articulationPoints.add(key)
        if (parents.has(key) && low.get(neighborKey)! >= discovery.get(key)!) {
          articulationPoints.add(key)
        }
      } else if (parents.get(key) !== neighborKey) {
        low.set(key, Math.min(low.get(key)!, discovery.get(neighborKey)!))
      }
    }
  }

  for (const key of walkable.keys()) {
    if (!discovery.has(key)) visit(key)
  }

  let lowDegreeCount = 0
  let cornerCount = 0
  for (const [key] of walkable) {
    const adjacent = neighbors(key)
    if (adjacent.length <= 2) lowDegreeCount += 1
    if (
      adjacent.length === 2
      && adjacent[0].x !== adjacent[1].x
      && adjacent[0].y !== adjacent[1].y
    ) {
      cornerCount += 1
    }
  }

  const left = map.tiles.filter(tile => tile.props.walkable === true && tile.x < map.width / 2).length
  const right = walkable.size - left
  const top = map.tiles.filter(tile => tile.props.walkable === true && tile.y < map.height / 2).length
  const bottom = walkable.size - top
  const isRotationallySymmetric = semantics.every((row, y) => (
    row.every((signature, x) => signature === semantics[map.height - y - 1][map.width - x - 1])
  ))
  const isHorizontallySymmetric = semantics.every((row, y) => (
    row.every((signature, x) => signature === semantics[map.height - y - 1][x])
  ))
  const isVerticallySymmetric = semantics.every(row => (
    row.every((signature, x) => signature === row[map.width - x - 1])
  ))

  return {
    articulationCount: articulationPoints.size,
    bottom,
    cornerCount,
    floorCount: map.tiles.filter(
      tile => tile.props.walkable === true && tile.props.type === 'floor',
    ).length,
    isHorizontallySymmetric,
    isRotationallySymmetric,
    isVerticallySymmetric,
    left,
    longestStraightRun: longestStraightRun(),
    lowDegreeRatio: lowDegreeCount / walkable.size,
    reachableCount: visited.size,
    right,
    top,
    walkableCount: walkable.size,
    walkableRatio: walkable.size / map.tiles.length,
  }
}

describe('RED-112 map catalog', () => {
  it('keeps the two existing maps unchanged and catalogs exactly five map files', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(mapsDirectory, 'manifest.json'), 'utf8'),
    ) as string[]
    const mapFiles = readdirSync(mapsDirectory)
      .filter(filename => filename.endsWith('.json') && filename !== 'manifest.json')
      .map(filename => filename.replace(/\.json$/, ''))
      .sort()

    expect(manifest).toEqual([
      'large-battlefield',
      'large-trap-arena',
      ...newMaps.map(map => map.filename),
    ])
    expect([...manifest].sort()).toEqual(mapFiles)
    expect(sha256('large-battlefield.json')).toBe(
      '0c133649595b10345d274fda19a8418e2dddea96739f950605b20de66c0f1a0b',
    )
    expect(sha256('large-trap-arena.json')).toBe(
      '0d942d7660dc52bb67209a15aa863c6ca574a48f61d0bf3d1a3146b2b0d63cdc',
    )
  })

  it.each(newMaps)('$id is a valid, irregular, balanced and connected 20 x 16 map', definition => {
    const config = loadConfig(definition.filename)
    const map = createMapFromAscii(config)
    const metrics = analyzeMap(config)
    const legendCharacters = new Set(config.legend.map(entry => entry.char))
    const coordinates = new Set(map.tiles.map(tile => `${tile.x},${tile.y}`))

    expect(config.id).toBe(definition.id)
    expect(config.layout).toHaveLength(16)
    expect(config.layout.every(row => Array.from(row).length === 20)).toBe(true)
    expect(config.layout.every(row => Array.from(row).every(char => legendCharacters.has(char)))).toBe(true)
    expect(map).toMatchObject({ id: definition.id, width: 20, height: 16 })
    expect(map.tiles).toHaveLength(320)
    expect(coordinates.size).toBe(320)
    expect(metrics.floorCount).toBeGreaterThanOrEqual(64)
    expect(metrics.reachableCount).toBe(metrics.walkableCount)
    expect(Math.abs(metrics.left - metrics.right) / metrics.walkableCount).toBeLessThanOrEqual(0.15)
    expect(Math.abs(metrics.top - metrics.bottom) / metrics.walkableCount).toBeLessThanOrEqual(0.15)
    expect(metrics.isRotationallySymmetric).toBe(false)
    expect(metrics.isHorizontallySymmetric).toBe(false)
    expect(metrics.isVerticallySymmetric).toBe(false)
  })

  it('separates open, winding and narrow route profiles with measurable geometry', () => {
    const open = analyzeMap(loadConfig('open-expanse'))
    const winding = analyzeMap(loadConfig('winding-pass'))
    const narrow = analyzeMap(loadConfig('narrow-corridors'))

    expect(open.walkableRatio).toBeGreaterThanOrEqual(0.72)
    expect(open.longestStraightRun).toBeGreaterThanOrEqual(12)
    expect(open.articulationCount).toBeLessThanOrEqual(2)

    expect(winding.walkableRatio).toBeGreaterThanOrEqual(0.50)
    expect(winding.walkableRatio).toBeLessThanOrEqual(0.68)
    expect(winding.cornerCount).toBeGreaterThanOrEqual(12)

    expect(narrow.walkableRatio).toBeGreaterThanOrEqual(0.30)
    expect(narrow.walkableRatio).toBeLessThanOrEqual(0.55)
    expect(narrow.lowDegreeRatio).toBeGreaterThanOrEqual(0.50)
    expect(narrow.articulationCount).toBeGreaterThanOrEqual(8)

    expect(open.walkableRatio).toBeGreaterThan(winding.walkableRatio)
    expect(winding.walkableRatio).toBeGreaterThan(narrow.walkableRatio)
  })

  it('uses distinct layouts and only the approved neutral terrain semantics', () => {
    const configs = newMaps.map(definition => loadConfig(definition.filename))
    const layoutSignatures = new Set(configs.map(config => (
      semanticGrid(config).map(row => row.join('|')).join('\n')
    )))

    expect(layoutSignatures.size).toBe(newMaps.length)

    for (const definition of newMaps) {
      const rawJson = loadMapJson(definition.filename)
      const config = loadConfig(definition.filename)
      const map = createMapFromAscii(config)

      expect(config.legend.every(entry => allowedTileTypes.has(entry.type))).toBe(true)
      expect(new Set(config.legend.map(entry => entry.char)).size).toBe(config.legend.length)
      expect(config.legend.every(entry => Array.from(entry.char).length === 1)).toBe(true)

      for (const token of [...forbiddenTileTypes, ...forbiddenEffectFields]) {
        expect(rawJson).not.toContain(`"${token}"`)
      }

      for (const entry of config.legend) {
        expect(typeof entry.walkable).toBe('boolean')
        expect(typeof entry.bulletPassable).toBe('boolean')
        const expected = neutralTileSemantics[entry.type as keyof typeof neutralTileSemantics]
        if (!expected) throw new Error(`Unexpected tile type: ${entry.type}`)
        expect(entry).toMatchObject(expected)
      }

      for (const tile of map.tiles) {
        expect(typeof tile.props.walkable).toBe('boolean')
        expect(typeof tile.props.bulletPassable).toBe('boolean')
        const expected = neutralTileSemantics[tile.props.type as keyof typeof neutralTileSemantics]
        if (!expected) throw new Error(`Unexpected parsed tile type: ${tile.props.type}`)
        expect(tile.props).toMatchObject(expected)
      }
    }
  })

  it('is discovered by both existing server loading paths without production changes', async () => {
    clearMapsCache()
    await loadMaps()

    const repositoryIds = new Set(getAllMaps().map(map => map.id))
    const apiIds = new Set(Object.keys(loadJsonFilesServer<AsciiMapConfig>('data/maps')))

    for (const definition of newMaps) {
      expect(repositoryIds.has(definition.id)).toBe(true)
      expect(apiIds.has(definition.id)).toBe(true)
    }
    expect(repositoryIds.size).toBe(5)
    expect(apiIds.size).toBe(5)
  })

  it('keeps the existing lobby selector pinned to the authoritative Demo map', () => {
    const lobby = readFileSync(resolve(process.cwd(), 'data/pages/lobby.html'), 'utf8')
    const loadMapsBlock = lobby.match(/async function loadMaps\(\) \{[\s\S]*?\n    \}/)?.[0]
    const createRoomBlock = lobby.match(/async function doCreateRoom\(\) \{[\s\S]*?\n    \}/)?.[0]

    expect(lobby).toContain("const DEMO_MAP_ID = 'large-hole-arena'")
    expect(lobby).toContain("const DEMO_MAP_FILENAME = 'large-trap-arena'")
    expect(lobby).toContain('<select id="mapSelect"><option value="large-hole-arena">大型洞穴</option></select>')
    expect(loadMapsBlock).toContain("fetchLocalJson('./data/maps/' + DEMO_MAP_FILENAME + '.json')")
    expect(loadMapsBlock).not.toContain('manifest.json')
    expect(createRoomBlock).toContain('const mapId = DEMO_MAP_ID')
    expect(createRoomBlock).not.toContain("document.getElementById('mapSelect').value")
  })
})
