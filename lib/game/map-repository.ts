import { createMapFromAscii, type AsciiMapConfig, type BoardMap } from './map'
import arenaJson from '../../data/maps/arena-8x6.json'
import mediumLavaTempleJson from '../../data/maps/medium-lava-temple.json'
import largeElementalArenaJson from '../../data/maps/large-elemental-arena.json'
import largeBattlefieldJson from '../../data/maps/large-battlefield.json'
import largeElementalTempleJson from '../../data/maps/large-elemental-temple.json'

const allMapConfigs: AsciiMapConfig[] = [
  arenaJson as AsciiMapConfig,
  mediumLavaTempleJson as AsciiMapConfig,
  largeElementalArenaJson as AsciiMapConfig,
  largeBattlefieldJson as AsciiMapConfig,
  largeElementalTempleJson as AsciiMapConfig,
]

let mapsCache: Record<string, BoardMap> = {}
let loaded = false

function ensureLoaded() {
  if (loaded) return
  loaded = true
  for (const config of allMapConfigs) {
    try {
      const map = createMapFromAscii(config)
      mapsCache[map.id] = map
    } catch (e) {
      console.error('[map-repository] Failed to create map:', config.id, e)
    }
  }
}

export async function loadMaps() {
  ensureLoaded()
}

export function getAllMaps(): BoardMap[] {
  ensureLoaded()
  return Object.values(mapsCache)
}

export function getMapById(id: string): BoardMap | undefined {
  ensureLoaded()
  return mapsCache[id]
}

export function mapExists(id: string): boolean {
  ensureLoaded()
  return id in mapsCache
}

export function clearMapsCache() {
  mapsCache = {}
  loaded = false
}
