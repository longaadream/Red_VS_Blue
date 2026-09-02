import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import {
  BATTLE_AUTHORITY_BUILD_ID,
  BATTLE_AUTHORITY_PROTOCOL_VERSION,
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

  it('appends and removes array tails without replacing the existing battle log', () => {
    const existingActions = Array.from({ length: 150 }, (_, index) => ({
      id: `action-${index}`,
      message: `battle log ${index}`,
    }))
    const before = { actions: existingActions, turn: 12 }
    const appendedAction = { id: 'action-150', message: 'one new battle log entry' }
    const afterAppend = { actions: [...existingActions, appendedAction], turn: 12 }

    const appendPatch = createBattlePublicPatch(before, afterAppend)

    expect(appendPatch).toEqual([
      { op: 'set', path: ['actions', 150], value: appendedAction },
    ])
    expect(JSON.stringify(appendPatch).length).toBeLessThan(200)
    const appended = applyBattlePublicPatch(before, appendPatch)
    expect(appended).toEqual(afterAppend)
    expect(hashPublicBattleState(appended)).toBe(hashPublicBattleState(afterAppend))

    const afterRemove = {
      actions: existingActions.slice(0, 148).map((action, index) => (
        index === 0 ? { ...action, message: 'corrected first entry' } : action
      )),
      turn: 12,
    }
    const removePatch = createBattlePublicPatch(before, afterRemove)

    expect(removePatch).toContainEqual({
      op: 'set',
      path: ['actions', 0, 'message'],
      value: 'corrected first entry',
    })
    expect(removePatch.slice(-2)).toEqual([
      { op: 'remove', path: ['actions', 149] },
      { op: 'remove', path: ['actions', 148] },
    ])
    expect(applyBattlePublicPatch(before, removePatch)).toEqual(afterRemove)
  })

  it('keeps legacy whole-array set patches compatible while rejecting sparse appends', () => {
    expect(applyBattlePublicPatch(
      { actions: [{ id: 'old' }] },
      [{ op: 'set', path: ['actions'], value: [{ id: 'new' }] }],
    )).toEqual({ actions: [{ id: 'new' }] })
    expect(() => applyBattlePublicPatch(
      { actions: [{ id: 'old' }] },
      [{ op: 'set', path: ['actions', 2], value: { id: 'sparse' } }],
    )).toThrow(/array index is invalid/i)
  })

  it('ships a browser bundle that applies append patches with hash validation', () => {
    const desktopBundlePath = resolve(process.cwd(), 'data/pages/js/game-engine.js')
    const desktopBundle = readFileSync(desktopBundlePath)

    const context: Record<string, unknown> = {
      Buffer,
      clearTimeout,
      console: { error: () => undefined, log: () => undefined, warn: () => undefined },
      process,
      require: createRequire(import.meta.url),
      setTimeout,
      TextDecoder,
      TextEncoder,
    }
    runInNewContext(desktopBundle.toString('utf8'), context, { filename: desktopBundlePath })
    const browserEngine = context.GameEngine as {
      applyBattlePublicPatch: typeof applyBattlePublicPatch
    }
    expect(browserEngine.applyBattlePublicPatch).toBeTypeOf('function')
    const before = { actions: [{ id: 'existing' }], turn: 1 }
    const after = { actions: [{ id: 'existing' }, { id: 'appended' }], turn: 1 }
    const envelope: BattlePublicPatchEnvelope = {
      protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
      authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
      roomId: 'bundle-patch-room',
      fromVersion: 7,
      toVersion: 8,
      prePublicHash: hashPublicBattleState(before),
      postPublicHash: hashPublicBattleState(after),
      patch: createBattlePublicPatch(before, after),
    }

    context.beforeJson = JSON.stringify(before)
    context.envelopeJson = JSON.stringify(envelope)
    runInNewContext(
      'bundlePatchResult = GameEngine.applyBattlePublicPatch(JSON.parse(beforeJson), JSON.parse(envelopeJson), { authorityVersion: 7 })',
      context,
    )
    const applied = context.bundlePatchResult
    expect(JSON.parse(JSON.stringify(applied))).toEqual(after)
    context.envelopeJson = JSON.stringify({ ...envelope, postPublicHash: 'tampered' })
    expect(() => runInNewContext(
      'GameEngine.applyBattlePublicPatch(JSON.parse(beforeJson), JSON.parse(envelopeJson), { authorityVersion: 7 })',
      context,
    )).toThrow(/post-public hash/i)
  })

  it('fails closed on version gaps or pre/post hash mismatches', () => {
    const before = { value: 1, nested: { stable: true } }
    const after = { value: 2, nested: { stable: true } }
    const patch = createBattlePublicPatch(before, after)
    const envelope: BattlePublicPatchEnvelope = {
      protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
      authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
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
    expect(() => applyBattlePublicPatch(before, {
      ...envelope,
      authorityBuildId: 'old-build' as typeof BATTLE_AUTHORITY_BUILD_ID,
    }, { authorityVersion: 4 })).toThrow(/build/i)
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
