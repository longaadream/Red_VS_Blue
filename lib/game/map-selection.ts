import type { BoardMap } from './map'
import * as mapRepository from './map-repository'
import { isContentAvailable } from './content-availability'

export const SELECTABLE_MAP_IDS = [
  'large-hole-arena',
  'open-expanse',
  'winding-pass',
  'narrow-corridors',
  'twin-bridges',
  'crossroads-plaza',
  'island-courtyard',
  'broad-ring',
] as const

export type SelectableMapId = (typeof SELECTABLE_MAP_IDS)[number]
export const TEAM_MAP_IDS = ['twin-fronts'] as const
export type TeamMapId = (typeof TEAM_MAP_IDS)[number]

export type RankedMapCatalogEntry = {
  id: string
  name: string
  eligible: boolean
  reason?: string
}

export type RankedMapPoolState = {
  catalog: RankedMapCatalogEntry[]
  enabledIds: string[]
  invalidIds: string[]
  blocked: boolean
  reason?: string
}

const RANKED_MIN_MAPS = 3
const RANKED_MIN_ORDINARY_FLOOR_TILES = 16

function rankedMapEligibility(map: BoardMap): RankedMapCatalogEntry {
  if (typeof map.id !== 'string' || !map.id) {
    return { id: String(map.id ?? ''), name: String(map.name ?? ''), eligible: false, reason: 'invalid-schema' }
  }
  if (typeof map.name !== 'string' || !map.name) {
    return { id: map.id, name: map.name ? String(map.name) : map.id, eligible: false, reason: 'invalid-schema' }
  }
  if ((TEAM_MAP_IDS as readonly string[]).includes(map.id)) {
    return { id: map.id, name: map.name, eligible: false, reason: 'reserved-for-2v2' }
  }
  if (!isContentAvailable(map, 'pvp')) {
    return { id: map.id, name: map.name, eligible: false, reason: 'not-available-for-pvp' }
  }
  if (!Array.isArray(map.tiles)) {
    return { id: map.id, name: map.name, eligible: false, reason: 'invalid-schema' }
  }
  const ordinaryFloorCount = map.tiles.filter(tile => (
    tile.props.walkable === true && tile.props.type === 'floor'
  )).length
  if (ordinaryFloorCount < RANKED_MIN_ORDINARY_FLOOR_TILES) {
    return { id: map.id, name: map.name, eligible: false, reason: 'fewer-than-16-deployment-cells' }
  }
  return { id: map.id, name: map.name, eligible: true }
}

/**
 * Describe every map loaded from the active resource profile.  The result is
 * deliberately broader than getSelectableMapCatalog: the ranked administrator
 * must show discovered maps even when they are not valid 1v1 content.
 */
export function getRankedMapCatalog(): RankedMapCatalogEntry[] {
  return mapRepository.getAllLoadedMaps()
    .map(rankedMapEligibility)
    .sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * Summarize a persisted ranked selection without changing it.  Unknown or
 * ineligible IDs stay in invalidIds so an administrator can repair the pool;
 * newly discovered maps never become enabled implicitly.
 */
export function getRankedMapPoolState(saved: unknown): RankedMapPoolState {
  const catalog = getRankedMapCatalog()
  const byId = new Map(catalog.map(entry => [entry.id, entry]))
  const enabledIds: string[] = []
  const invalidIds: string[] = []
  const seen = new Set<string>()
  let malformed = !Array.isArray(saved)
  let duplicate = false

  if (Array.isArray(saved)) {
    for (const value of saved) {
      if (typeof value !== 'string' || !value) {
        malformed = true
        continue
      }
      if (seen.has(value)) {
        duplicate = true
        invalidIds.push(value)
        continue
      }
      seen.add(value)
      const entry = byId.get(value)
      if (!entry || !entry.eligible) {
        invalidIds.push(value)
        continue
      }
      enabledIds.push(value)
    }
  }

  let reason: string | undefined
  if (malformed) reason = 'ranked-map-pool-format-invalid'
  else if (duplicate) reason = 'ranked-map-pool-contains-duplicate-map'
  else if (invalidIds.length) reason = 'ranked-map-pool-contains-unavailable-map'
  else if (enabledIds.length < RANKED_MIN_MAPS) reason = 'ranked-map-pool-requires-at-least-3-maps'

  return {
    catalog,
    enabledIds,
    invalidIds,
    blocked: Boolean(reason),
    ...(reason ? { reason } : {}),
  }
}

/** Validate one dynamic map ID for a 1v1 ranked pregame. */
export function assertRankedMapId(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new MapSelectionError('MAP_ID_REQUIRED', { receivedType: typeof input })
  }
  const entry = getRankedMapCatalog().find(candidate => candidate.id === input)
  if (!entry) throw new MapSelectionError('MAP_NOT_SELECTABLE', { mapId: input })
  if (!entry.eligible) {
    throw new MapSelectionError('MAP_NOT_DEPLOYABLE', { mapId: input, reason: entry.reason })
  }
  return input
}

export type MapSelectionErrorCode =
  | 'MAP_ID_REQUIRED'
  | 'MAP_NOT_SELECTABLE'
  | 'MAP_NOT_DEPLOYABLE'

const ERROR_MESSAGES: Record<MapSelectionErrorCode, string> = {
  MAP_ID_REQUIRED: 'A map ID is required',
  MAP_NOT_SELECTABLE: 'The requested map is not selectable',
  MAP_NOT_DEPLOYABLE: 'The requested map is unavailable or does not contain sixteen ordinary floor tiles',
}

export class MapSelectionError extends Error {
  readonly code: MapSelectionErrorCode
  readonly context: Record<string, unknown>

  constructor(code: MapSelectionErrorCode, context: Record<string, unknown> = {}) {
    super(ERROR_MESSAGES[code])
    this.name = 'MapSelectionError'
    this.code = code
    this.context = context
  }
}

export interface MapSelectionErrorPayload {
  code: MapSelectionErrorCode
  message: string
  context: Record<string, unknown>
}

export function getMapSelectionErrorPayload(error: unknown): MapSelectionErrorPayload | undefined {
  if (!(error instanceof MapSelectionError)) return undefined
  return { code: error.code, message: error.message, context: error.context }
}

export function isMapSelectionError(error: unknown): error is MapSelectionError {
  return error instanceof MapSelectionError
}

export function assertSelectableMapId(input: unknown, mode: '1v1' | '2v2' = '1v1'): SelectableMapId | TeamMapId {
  if (typeof input !== 'string' || input.length === 0) {
    throw new MapSelectionError('MAP_ID_REQUIRED', { receivedType: typeof input })
  }
  if (!((mode === '2v2' ? TEAM_MAP_IDS : SELECTABLE_MAP_IDS) as readonly string[]).includes(input)) {
    throw new MapSelectionError('MAP_NOT_SELECTABLE', { mapId: input })
  }

  const map = mapRepository.getMapById(input)
  const ordinaryFloorCount = map?.tiles.filter(tile => (
    tile.props.walkable === true && tile.props.type === 'floor'
  )).length ?? 0
  if (!map || !isContentAvailable(map,'pvp') || ordinaryFloorCount < (mode === '2v2' ? 32 : RANKED_MIN_ORDINARY_FLOOR_TILES)) {
    throw new MapSelectionError('MAP_NOT_DEPLOYABLE', {
      mapId: input,
      ordinaryFloorCount,
    })
  }
  return input as SelectableMapId | TeamMapId
}

export function getSelectableMapCatalog(mode: '1v1' | '2v2' = '1v1'): BoardMap[] {
  return (mode === '2v2' ? TEAM_MAP_IDS : SELECTABLE_MAP_IDS).map(mapId => {
    assertSelectableMapId(mapId, mode)
    return mapRepository.getMapById(mapId)!
  })
}
