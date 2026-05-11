import { createMapFromAscii, type AsciiMapConfig, type BoardMap } from './map'
import fs from 'fs'
import path from 'path'
import { getDataRoot } from '../app-paths'

const MAPS_DIR = path.join(getDataRoot(), 'maps')

let mapsCache: Record<string, BoardMap> = {}
let loaded = false

function ensureLoaded() {
  if (loaded) return
  loaded = true

  if (!fs.existsSync(MAPS_DIR)) {
    console.warn('[map-repository] Maps directory not found:', MAPS_DIR)
    return
  }

  const files = fs.readdirSync(MAPS_DIR).filter(f => f.endsWith('.json'))
  for (const file of files) {
    try {
      const filePath = path.join(MAPS_DIR, file)
      const content = fs.readFileSync(filePath, 'utf-8')
      const config = JSON.parse(content) as AsciiMapConfig
      const map = createMapFromAscii(config)
      mapsCache[map.id] = map
    } catch (e) {
      console.error('[map-repository] Failed to load map:', file, e)
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
