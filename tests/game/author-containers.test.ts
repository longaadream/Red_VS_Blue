import { describe, expect, it } from 'vitest'

import {
  authorMapCount,
  authorMapDelete,
  authorMapFromTuples,
  authorMapGet,
  authorMapHas,
  authorMapItems,
  authorMapKeys,
  authorMapSet,
  authorMapValues,
  authorMapCreate,
  authorSetAdd,
  authorSetContains,
  authorSetCount,
  authorSetDelete,
  authorSetFromTuple,
  authorSetHas,
  authorSetItems,
  authorSetCreate,
  createAuthorMap,
  createAuthorSet,
  isAuthorMap,
  isAuthorSet,
} from '../../lib/game/author-containers'

describe('author generic containers', () => {
  it('keeps map keys typed, deduplicates duplicate tuples, and preserves insertion order', () => {
    const map = authorMapFromTuples([
      [1, 'first'],
      ['1', 'text key'],
      [1, 'updated'],
      [{ b: 2, a: 1 }, 'record key'],
      [{ a: 1, b: 2 }, 'record update'],
    ])

    expect(authorMapItems(map)).toEqual([
      [1, 'updated'],
      ['1', 'text key'],
      [{ b: 2, a: 1 }, 'record update'],
    ])
    expect(authorMapKeys(map)).toEqual([1, '1', { b: 2, a: 1 }])
    expect(authorMapValues(map)).toEqual(['updated', 'text key', 'record update'])
    expect(authorMapCount(map)).toBe(3)
    expect(authorMapGet(map, 1)).toEqual({ value: 'updated', found: true })
    expect(authorMapGet(map, '1')).toEqual({ value: 'text key', found: true })
  })

  it('returns an explicit missing-map result and keeps immutable updates ordered', () => {
    const original = createAuthorMap([[1, 'one'], [2, 'two']])
    expect(authorMapGet(original, 3)).toEqual({ value: undefined, found: false })

    const updated = authorMapSet(original, 1, 'ONE')
    expect(authorMapItems(original)).toEqual([[1, 'one'], [2, 'two']])
    expect(authorMapItems(updated)).toEqual([[1, 'ONE'], [2, 'two']])

    const appended = authorMapSet(updated, 3, 'three')
    expect(authorMapKeys(appended)).toEqual([1, 2, 3])
    expect(authorMapKeys(authorMapDelete(appended, 1))).toEqual([2, 3])
  })

  it('supports the registry-facing constructors and aliases without changing typed keys', () => {
    const map = authorMapCreate([1, '1'], ['number', 'string'])
    expect(authorMapHas(map, 1)).toBe(true)
    expect(authorMapHas(map, '1')).toBe(true)
    expect(authorMapValues(map)).toEqual(['number', 'string'])

    const set = authorSetCreate([1])
    expect(authorSetHas(set, 1)).toBe(true)
    expect(authorSetItems(authorSetAdd(set, 2))).toEqual([1, 2])
  })

  it('deduplicates sets with deep JSON equality while retaining first insertion order', () => {
    const set = authorSetFromTuple([1, '1', { a: 1, b: [2] }, { b: [2], a: 1 }, 1])

    expect(authorSetItems(set)).toEqual([1, '1', { a: 1, b: [2] }])
    expect(authorSetCount(set)).toBe(3)
    expect(authorSetContains(set, 1)).toBe(true)
    expect(authorSetContains(set, '1')).toBe(true)
    expect(authorSetContains(set, { b: [2], a: 1 })).toBe(true)

    const added = authorSetAdd(set, false)
    expect(authorSetItems(set)).toEqual([1, '1', { a: 1, b: [2] }])
    expect(authorSetItems(added)).toEqual([1, '1', { a: 1, b: [2] }, false])
    expect(authorSetItems(authorSetDelete(added, '1'))).toEqual([1, { a: 1, b: [2] }, false])
  })

  it('round-trips tagged containers through JSON without changing keys or order', () => {
    const map = createAuthorMap([[1, { value: 'number-key' }], ['1', { value: 'string-key' }]])
    const set = createAuthorSet([{ id: 1 }, { id: '1' }])
    const restoredMap = JSON.parse(JSON.stringify(map)) as unknown
    const restoredSet = JSON.parse(JSON.stringify(set)) as unknown

    expect(authorMapItems(restoredMap)).toEqual(authorMapItems(map))
    expect(authorSetItems(restoredSet)).toEqual(authorSetItems(set))
  })

  it('rejects non-finite, cyclic, sparse, accessor, prototype, and oversized values', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 1 })
    const sparse = [] as unknown[]
    sparse.length = 1
    const custom = Object.create({ inherited: true }) as Record<string, unknown>
    custom.value = 1
    const nullPrototype = Object.create(null) as Record<string, unknown>
    nullPrototype.value = 1
    const dangerous: Record<string, unknown> = {}
    Object.defineProperty(dangerous, '__proto__', { enumerable: true, value: 1, writable: true, configurable: true })

    expect(() => createAuthorSet([NaN])).toThrow()
    expect(() => createAuthorSet([Infinity])).toThrow()
    expect(() => createAuthorSet([undefined])).toThrow()
    expect(() => createAuthorSet([cyclic])).toThrow()
    expect(() => createAuthorSet([accessor])).toThrow()
    expect(() => createAuthorSet([sparse])).toThrow()
    expect(() => createAuthorSet([custom])).toThrow()
    expect(() => createAuthorSet([nullPrototype])).toThrow()
    expect(() => createAuthorSet([dangerous])).toThrow()
    expect(() => createAuthorSet(Array.from({ length: 4097 }, (_, index) => index))).toThrow()
  })

  it('rejects malformed tagged containers and does not coerce map keys', () => {
    expect(() => authorMapItems({ format: 'author-map/v1', entries: [[1]] })).toThrow()
    expect(() => authorSetItems({ format: 'author-set/v1', items: [undefined] })).toThrow()
    const map = createAuthorMap([[1, 'number'], ['1', 'string']])
    expect(authorMapGet(map, 1)).toEqual({ value: 'number', found: true })
    expect(authorMapGet(map, '1')).toEqual({ value: 'string', found: true })
  })

  it('validates tagged container shape, uniqueness, and serialized limits on reads', () => {
    const customPrototype = Object.create({ inherited: true }) as Record<string, unknown>
    customPrototype.format = 'author-set/v1'
    customPrototype.items = []
    expect(isAuthorSet(customPrototype)).toBe(false)
    expect(() => authorSetItems(customPrototype)).toThrow()

    const accessorContainer: Record<string, unknown> = {}
    Object.defineProperty(accessorContainer, 'format', { enumerable: true, get: () => 'author-set/v1' })
    Object.defineProperty(accessorContainer, 'items', { enumerable: true, value: [] })
    expect(isAuthorSet(accessorContainer)).toBe(false)

    const duplicateMap = { format: 'author-map/v1', entries: [[1, 'first'], [1, 'second']] }
    expect(isAuthorMap(duplicateMap)).toBe(false)
    expect(() => authorMapItems(duplicateMap)).toThrow()

    const duplicateSet = { format: 'author-set/v1', items: [1, 1] }
    expect(isAuthorSet(duplicateSet)).toBe(false)
    expect(() => authorSetItems(duplicateSet)).toThrow()

    const oversized = {
      format: 'author-set/v1',
      items: ['x'.repeat(65536)],
    }
    expect(isAuthorSet(oversized)).toBe(false)
    expect(() => authorSetItems(oversized)).toThrow()
  })

  it('applies the serialized limit to UTF-8 bytes rather than UTF-16 code units', () => {
    const oversizedUnicode = {
      format: 'author-set/v1',
      items: ['😀'.repeat(16384)],
    }

    expect(oversizedUnicode.items[0].length).toBe(32768)
    expect(new TextEncoder().encode(JSON.stringify(oversizedUnicode)).byteLength).toBeGreaterThan(65536)
    expect(isAuthorSet(oversizedUnicode)).toBe(false)
    expect(() => authorSetItems(oversizedUnicode)).toThrow()
  })
})
