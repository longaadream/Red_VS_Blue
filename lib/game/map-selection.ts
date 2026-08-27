import type { BoardMap } from './map'
import * as mapRepository from './map-repository'

export const SELECTABLE_MAP_IDS = [
  'large-hole-arena',
  'open-expanse',
  'winding-pass',
  'narrow-corridors',
] as const

export type SelectableMapId = (typeof SELECTABLE_MAP_IDS)[number]

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

export function assertSelectableMapId(input: unknown): SelectableMapId {
  if (typeof input !== 'string' || input.length === 0) {
    throw new MapSelectionError('MAP_ID_REQUIRED', { receivedType: typeof input })
  }
  if (!(SELECTABLE_MAP_IDS as readonly string[]).includes(input)) {
    throw new MapSelectionError('MAP_NOT_SELECTABLE', { mapId: input })
  }

  const map = mapRepository.getMapById(input)
  const ordinaryFloorCount = map?.tiles.filter(tile => (
    tile.props.walkable === true && tile.props.type === 'floor'
  )).length ?? 0
  if (!map || ordinaryFloorCount < 16) {
    throw new MapSelectionError('MAP_NOT_DEPLOYABLE', {
      mapId: input,
      ordinaryFloorCount,
    })
  }
  return input as SelectableMapId
}

export function getSelectableMapCatalog(): BoardMap[] {
  return SELECTABLE_MAP_IDS.map(mapId => {
    assertSelectableMapId(mapId)
    return mapRepository.getMapById(mapId)!
  })
}
