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
    const applied = applyBattlePublicPatch(before, patch)

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

  it('fails closed when a patch value has no JSON representation', () => {
    expect(() => createBattlePublicPatch({}, { effect: () => true }))
      .toThrow(BattlePublicPatchError)
  })
  it('rejects unsafe or malformed patch paths', () => {
    expect(() => applyBattlePublicPatch({}, [{ op: 'set', path: ['__proto__', 'polluted'], value: true }]))
      .toThrow(/unsafe patch path/i)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })
})
