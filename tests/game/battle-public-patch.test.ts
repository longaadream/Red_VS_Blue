import { describe, expect, it } from 'vitest'

import {
  BattlePublicPatchError,
  applyBattlePublicPatch,
  createBattlePublicPatch,
  hashPublicBattleState,
  type BattlePublicPatchEnvelope,
} from '@/lib/game/battle-public-patch'

describe('RED-109 public battle patches', () => {
  it('round-trips deterministic nested changes and removals without mutating the source', () => {
    const before = {
      turn: { turnNumber: 1, phase: 'action', currentPlayerId: 'red' },
      pieces: [{ id: 'one', hp: 10 }, { id: 'two', hp: 8 }],
      pending: { kind: 'target', candidates: [{ type: 'cell', x: 1, y: 2 }] },
      obsolete: true,
    }
    const after = {
      turn: { turnNumber: 1, phase: 'end', currentPlayerId: 'red' },
      pieces: [{ id: 'one', hp: 7 }, { id: 'two', hp: 8 }],
      pending: { kind: 'option', candidates: ['yes', 'no'] },
    }
    const frozenBefore = structuredClone(before)

    const patch = createBattlePublicPatch(before, after)
    const serializedPatch = JSON.parse(JSON.stringify(patch))
    const applied = applyBattlePublicPatch(before, serializedPatch)

    expect(applied).toEqual(after)
    expect(before).toEqual(frozenBefore)
    expect(patch).toEqual(createBattlePublicPatch(before, after))
    expect(JSON.stringify(patch)).not.toContain('"two"')
  })

  it('fails closed on version gaps or pre/post hash mismatches', () => {
    const before = { value: 1, nested: { stable: true } }
    const after = { value: 2, nested: { stable: true } }
    const patch = createBattlePublicPatch(before, after)
    const envelope: BattlePublicPatchEnvelope = {
      protocolVersion: 2,
      roomId: 'room-a',
      fromVersion: 4,
      toVersion: 5,
      prePublicHash: hashPublicBattleState(before),
      postPublicHash: hashPublicBattleState(after),
      patch,
    }

    expect(applyBattlePublicPatch(before, envelope, { authorityVersion: 4 })).toEqual(after)
    expect(() => applyBattlePublicPatch(before, envelope, { authorityVersion: 3 }))
      .toThrow(BattlePublicPatchError)
    expect(() => applyBattlePublicPatch({ value: 9 }, envelope, { authorityVersion: 4 }))
      .toThrow(/pre-public hash/i)
    expect(() => applyBattlePublicPatch(before, { ...envelope, postPublicHash: 'bad' }, { authorityVersion: 4 }))
      .toThrow(/post-public hash/i)
  })

  it('fails closed for every non-JSON patch value, including nested and array values', () => {
    const nonCanonicalArray = [1, 2] as unknown[] & Record<string, unknown>
    nonCanonicalArray['01'] = { effect: () => true }
    const symbolArray = [1]
    Object.defineProperty(symbolArray, Symbol('hidden'), { value: () => true, enumerable: true })
    const hiddenObject = {}
    Object.defineProperty(hiddenObject, 'hidden', { value: undefined, enumerable: false })
    const symbolObject = {}
    Object.defineProperty(symbolObject, Symbol('hidden'), { value: () => true, enumerable: true })
    const accessorObject = {}
    Object.defineProperty(accessorObject, 'unstable', { enumerable: true, get: () => 1 })
    const invalidPatches = [
      () => createBattlePublicPatch({ value: 1 }, undefined),
      () => createBattlePublicPatch({}, { effect: () => true }),
      () => createBattlePublicPatch([], [{ effect: () => true }]),
      () => createBattlePublicPatch([], [{ value: undefined }]),
      () => createBattlePublicPatch({ value: 1 }, { value: Number.NaN }),
      () => createBattlePublicPatch({ value: 1 }, { value: BigInt(1) }),
      () => createBattlePublicPatch({}, { value: Symbol('non-json') }),
      () => createBattlePublicPatch([1, 2], nonCanonicalArray),
      () => createBattlePublicPatch([1], symbolArray),
      () => createBattlePublicPatch({}, hiddenObject),
      () => createBattlePublicPatch({}, symbolObject),
      () => createBattlePublicPatch({}, accessorObject),
      () => createBattlePublicPatch(hiddenObject, {}),
    ]

    for (const createInvalidPatch of invalidPatches) {
      expect(createInvalidPatch).toThrow(BattlePublicPatchError)
    }
  })
  it('rejects unsafe or malformed patch paths', () => {
    expect(() => applyBattlePublicPatch({}, [{ op: 'set', path: ['__proto__', 'polluted'], value: true }]))
      .toThrow(/unsafe patch path/i)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })
})
