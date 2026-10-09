import { describe, expect, it, vi } from 'vitest'

import * as mapRepository from '@/lib/game/map-repository'
import {
  MapSelectionError,
  SELECTABLE_MAP_IDS,
  assertSelectableMapId,
  assertRankedMapId,
  getRankedMapCatalog,
  getRankedMapPoolState,
  getSelectableMapCatalog,
} from '@/lib/game/map-selection'

describe('RED-119 authoritative map selection', () => {
  it('exposes the selectable maps in one stable order', () => {
    expect(SELECTABLE_MAP_IDS).toEqual([
      'large-hole-arena',
      'open-expanse',
      'winding-pass',
      'narrow-corridors',
      'twin-bridges', 'crossroads-plaza', 'island-courtyard', 'broad-ring',
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

  it('discovers every loaded map while keeping new maps disabled by default', () => {
    const state = getRankedMapPoolState([...SELECTABLE_MAP_IDS])
    expect(state.catalog.map(map => map.id)).toEqual([
      'adventure-act-1-v1',
      'adventure-act-2-v1',
      'adventure-act-3-v1',
      'large-hole-arena',
      'narrow-corridors',
      'open-expanse',
      'twin-fronts',
      'winding-pass',
    ])
    expect(state.catalog.filter(map => map.eligible).map(map => map.id)).toEqual([...SELECTABLE_MAP_IDS].sort())
    expect(state.enabledIds).toEqual([...SELECTABLE_MAP_IDS])
    expect(state.blocked).toBe(false)
    expect(state.catalog.find(map => map.id === 'twin-fronts')).toMatchObject({ eligible: false })
    expect(getRankedMapCatalog()).toEqual(state.catalog)
  })

  it('blocks admissions when a saved pool contains a removed map without trimming the selection', () => {
    const state = getRankedMapPoolState([...SELECTABLE_MAP_IDS, 'removed-resource-map'])
    expect(state).toMatchObject({ blocked: true, invalidIds: ['removed-resource-map'] })
    expect(state.enabledIds).toEqual([...SELECTABLE_MAP_IDS])
  })

  it('accepts a newly loaded valid 1v1 map through the ranked boundary', () => {
    const source = getRankedMapCatalog().find(map => map.id === 'open-expanse')!
    const map = mapRepository.getMapById('open-expanse')!
    const winding = mapRepository.getMapById('winding-pass')!
    const loaded = vi.spyOn(mapRepository, 'getAllLoadedMaps').mockReturnValue([
      map,
      winding,
      { ...map, id: 'resource-pack-map', name: '资源包地图' },
    ])
    try {
      expect(assertRankedMapId('resource-pack-map')).toBe('resource-pack-map')
      const state = getRankedMapPoolState(['resource-pack-map', 'open-expanse', 'winding-pass'])
      expect(state).toMatchObject({ blocked: false, enabledIds: ['resource-pack-map', 'open-expanse', 'winding-pass'] })
      expect(state.catalog.find(entry => entry.id === 'resource-pack-map')).toMatchObject({
        name: '资源包地图',
        eligible: true,
      })
    } finally {
      loaded.mockRestore()
    }
    expect(source.eligible).toBe(true)
  })
})
