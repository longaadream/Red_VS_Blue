import type { BoardMap } from './map'
import * as mapRepository from './map-repository'
import { isContentAvailable } from './content-availability'

export const SELECTABLE_MAP_IDS = [
  'large-hole-arena',
  'open-expanse',
  'winding-pass',
  'narrow-corridors',
] as const

export type SelectableMapId = (typeof SELECTABLE_MAP_IDS)[number]
export const TEAM_MAP_IDS = ['twin-fronts'] as const
export type TeamMapId = (typeof TEAM_MAP_IDS)[number]

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
  if (!map || !isContentAvailable(map,'pvp') || ordinaryFloorCount < (mode === '2v2' ? 32 : 16)) {
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
