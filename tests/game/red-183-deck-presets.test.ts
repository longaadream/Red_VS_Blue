import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

type PresetApi = {
  parse(raw: string | null): { version: number; presets: Array<Record<string, unknown>> }
  serialize(store: unknown): string
  upsert(store: unknown, preset: unknown): { version: number; presets: Array<Record<string, unknown>> }
  remove(store: unknown, id: string): { version: number; presets: Array<Record<string, unknown>> }
  isValidSelection(pieceIds: string[], alignment: string | null, pieces: Array<Record<string, unknown>>): boolean
}

function loadApi(): PresetApi {
  const window: Record<string, unknown> = {}
  const source = readFileSync(resolve(process.cwd(), 'data/pages/js/deck-presets.js'), 'utf8')
  new Script(source, { filename: 'deck-presets.js' }).runInContext(createContext({ window, globalThis: window, Object, JSON, Set, Number }))
  return window.RvBDeckPresets as PresetApi
}

function preset(overrides: Record<string, unknown> = {}) {
  return {
    id: 'deck-a', name: '突击队', alignment: 'good',
    pieceIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'],
    updatedAt: 100, ...overrides,
  }
}

describe('RED-183 versioned deck preset persistence', () => {
  it('round-trips create, edit, and delete without changing the schema version', () => {
    const api = loadApi()
    let store = api.upsert(api.parse(null), preset())
    expect(JSON.parse(api.serialize(store))).toEqual({ version: 1, presets: [preset()] })
    store = api.upsert(store, preset({ name: '突击队·改', updatedAt: 200 }))
    expect(store.presets).toHaveLength(1)
    expect(store.presets[0]).toMatchObject({ id: 'deck-a', name: '突击队·改', updatedAt: 200 })
    expect(api.remove(store, 'deck-a')).toMatchObject({ version: 1, presets: [] })
  })

  it('falls back safely for legacy, future, malformed, and unreadable stores', () => {
    const api = loadApi()
    for (const raw of [
      JSON.stringify({ presets: [preset()] }),
      JSON.stringify({ version: 2, presets: [preset()] }),
      JSON.stringify({ version: 1, presets: 'invalid' }),
      '{broken-json',
    ]) expect(api.parse(raw)).toMatchObject({ version: 1, presets: [] })
  })

  it('rejects presets that are not exactly eight unique same-alignment entries', () => {
    const api = loadApi()
    const raw = JSON.stringify({ version: 1, presets: [
      preset(),
      preset({ id: 'short', pieceIds: ['p1'] }),
      preset({ id: 'duplicate', pieceIds: ['p1', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] }),
      preset({ id: 'neutral', alignment: 'neutral' }),
    ] })
    expect(api.parse(raw).presets.map(entry => entry.id)).toEqual(['deck-a'])
    expect(() => api.upsert(api.parse(null), preset({ pieceIds: ['p1'] }))).toThrow('Invalid deck preset')
    const pieces = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'].map(id => ({ id, faction: 'good' }))
    expect(api.isValidSelection(preset().pieceIds as string[], 'good', pieces)).toBe(true)
    expect(api.isValidSelection(preset().pieceIds as string[], null, pieces)).toBe(false)
    expect(api.isValidSelection(preset().pieceIds as string[], 'good', pieces.map((piece, index) => (
      index === 7 ? { ...piece, faction: 'evil' } : piece
    )))).toBe(false)
  })
})
