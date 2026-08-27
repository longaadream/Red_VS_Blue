import { describe, expect, it, vi } from 'vitest'

import * as mapRepository from '@/lib/game/map-repository'
import {
  MapSelectionError,
  SELECTABLE_MAP_IDS,
  assertSelectableMapId,
  getSelectableMapCatalog,
} from '@/lib/game/map-selection'

describe('RED-119 authoritative map selection', () => {
  it('exposes the four selectable maps in one stable order', () => {
    expect(SELECTABLE_MAP_IDS).toEqual([
      'large-hole-arena',
      'open-expanse',
      'winding-pass',
      'narrow-corridors',
    ])
    expect(getSelectableMapCatalog().map(map => map.id)).toEqual(SELECTABLE_MAP_IDS)
  })

  it.each(SELECTABLE_MAP_IDS)('accepts loaded deployable map %s without rewriting its ID', mapId => {
    expect(assertSelectableMapId(mapId)).toBe(mapId)
  })

  it.each([undefined, null, ''])('rejects a missing map ID with MAP_ID_REQUIRED', input => {
    expect(() => assertSelectableMapId(input)).toThrowError(expect.objectContaining({
      code: 'MAP_ID_REQUIRED',
    }))
  })

  it.each([
    'large-battlefield',
    'large-trap-arena',
    'large-trap-arena.json',
    '../large-hole-arena',
    '..\\large-hole-arena',
    '/large-hole-arena',
    'Large-Hole-Arena',
    ' large-hole-arena ',
    ' ',
  ])('rejects non-canonical or retired map ID %j with MAP_NOT_SELECTABLE', input => {
    expect(() => assertSelectableMapId(input)).toThrowError(expect.objectContaining({
      code: 'MAP_NOT_SELECTABLE',
    }))
  })

  it('rejects an allowlisted map that is missing from the loaded repository', () => {
    vi.spyOn(mapRepository, 'getMapById').mockReturnValueOnce(undefined)

    expect(() => assertSelectableMapId('large-hole-arena')).toThrowError(expect.objectContaining({
      code: 'MAP_NOT_DEPLOYABLE',
    }))
  })

  it('rejects an allowlisted map with fewer than sixteen ordinary floor tiles', () => {
    vi.spyOn(mapRepository, 'getMapById').mockReturnValueOnce({
      id: 'large-hole-arena',
      name: 'Too small',
      width: 15,
      height: 1,
      rules: [],
      tiles: Array.from({ length: 15 }, (_, x) => ({
        id: `floor-${x}`,
        x,
        y: 0,
        props: { type: 'floor', walkable: true, bulletPassable: true },
      })),
    })

    expect(() => assertSelectableMapId('large-hole-arena')).toThrowError(expect.objectContaining({
      code: 'MAP_NOT_DEPLOYABLE',
    }))
  })

  it('provides a stable error type for transport serialization', () => {
    try {
      assertSelectableMapId('large-battlefield')
      throw new Error('Expected map selection to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(MapSelectionError)
      expect(error).toMatchObject({
        name: 'MapSelectionError',
        code: 'MAP_NOT_SELECTABLE',
      })
    }
  })
})
