import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import {
  BATTLE_STATE_HASH_CHUNK_SIZE,
  buildBattleStateHashIndex,
  createBattleStateHashPatch,
  updateBattleStateHashIndex,
} from '@/lib/game/battle-state-hash'
import { hashBattleState, hashStable } from '@/lib/game/battle-trace'
import type { BattleState } from '@/lib/game/turn'

function makeState(actionCount: number) {
  return {
    turn: { turnNumber: 7, currentPlayerId: 'red', phase: 'action' },
    pieces: Array.from({ length: 40 }, (_, index) => ({
      id: `piece-${index}`,
      hp: 10 + index,
      position: { x: index % 10, y: Math.floor(index / 10) },
    })),
    actions: Array.from({ length: actionCount }, (_, index) => ({
      id: `action-${index}`,
      message: `log-${index}`,
    })),
    pending: null,
  }
}

function expectIncrementalMatchesFull(before: unknown, after: unknown) {
  const previous = buildBattleStateHashIndex(before, hashStable)
  const patch = createBattleStateHashPatch(before, after)
  const incremental = updateBattleStateHashIndex(previous, after, patch, hashStable)
  const full = buildBattleStateHashIndex(after, hashStable)
  expect(incremental.index).toEqual(full)
  return incremental.stats
}

describe('battle state chunked hash v1', () => {
  it('keeps the frozen Unicode vector identical in Node, desktop and Android bundles', () => {
    const vector = {
      actions: [{ id: 'a-1', message: '红蓝🗡️' }],
      pieces: [{ id: 'p-1', hp: 7 }],
      turn: { turnNumber: 3, currentPlayerId: 'red' },
      unicode: '诅咒结界',
    }
    const expected = '43e0cab5cf9528f8e7a58020310d4eda7229c5f7520507cb617daa8497589768'
    expect(hashBattleState(vector as unknown as BattleState)).toBe(expected)

    for (const bundlePath of [
      resolve(process.cwd(), 'data/pages/js/game-engine.js'),
      resolve(process.cwd(), 'android-client/www/js/game-engine.js'),
    ]) {
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
      runInNewContext(readFileSync(bundlePath, 'utf8'), context, { filename: bundlePath })
      const engine = context.GameEngine as { hashBattleState: typeof hashBattleState }
      expect(JSON.parse(JSON.stringify(engine.hashBattleState(vector as unknown as BattleState))))
        .toBe(expected)
    }
  })

  it('matches a full rebuild for nested edits, tail append/remove, cross-block edits and root replacement', () => {
    const before = makeState(BATTLE_STATE_HASH_CHUNK_SIZE * 3 + 5)

    const nested = structuredClone(before)
    nested.pieces[3].position.x = 9
    expect(expectIncrementalMatchesFull(before, nested)).toMatchObject({
      fullRebuild: false,
      touchedFieldCount: 1,
      touchedChunkCount: 1,
    })

    const appended = structuredClone(before)
    appended.actions.push({ id: 'action-appended', message: 'tail' })
    expect(expectIncrementalMatchesFull(before, appended)).toMatchObject({
      fullRebuild: false,
      touchedFieldCount: 1,
      touchedChunkCount: 1,
    })

    const removed = structuredClone(before)
    removed.actions.pop()
    expect(expectIncrementalMatchesFull(before, removed)).toMatchObject({
      fullRebuild: false,
      touchedFieldCount: 1,
      touchedChunkCount: 1,
    })

    const crossBlock = structuredClone(before)
    crossBlock.actions[BATTLE_STATE_HASH_CHUNK_SIZE - 1].message = 'left-edge'
    crossBlock.actions[BATTLE_STATE_HASH_CHUNK_SIZE].message = 'right-edge'
    expect(expectIncrementalMatchesFull(before, crossBlock)).toMatchObject({
      fullRebuild: false,
      touchedFieldCount: 1,
      touchedChunkCount: 2,
    })

    const rootReplacement = { replacement: true, actions: [] }
    const rootResult = updateBattleStateHashIndex(
      buildBattleStateHashIndex(before, hashStable),
      rootReplacement,
      [{ op: 'set', path: [], value: rootReplacement }],
      hashStable,
    )
    expect(rootResult.index).toEqual(buildBattleStateHashIndex(rootReplacement, hashStable))
    expect(rootResult.stats).toMatchObject({
      fullRebuild: true,
    })
  })

  it.each([100, 500, 1_000])('re-hashes only one actions chunk for a %i-entry tail append', actionCount => {
    const before = makeState(actionCount)
    const after = structuredClone(before)
    after.actions.push({ id: `action-${actionCount}`, message: 'one new event' })

    const stats = expectIncrementalMatchesFull(before, after)
    expect(stats).toEqual({
      fullRebuild: false,
      touchedFieldCount: 1,
      touchedChunkCount: 1,
    })
  })

  it('ignores runtime callbacks exactly like stable JSON while retaining gameplay edits', () => {
    const before = makeState(3) as ReturnType<typeof makeState> & {
      runtimeRule: { id: string; effect: () => string; value: number }
    }
    before.runtimeRule = { id: 'rule-1', effect: () => 'before', value: 1 }
    const after = {
      ...before,
      runtimeRule: { ...before.runtimeRule, effect: () => 'after', value: 2 },
    }

    const patch = createBattleStateHashPatch(before, after)
    expect(patch).toEqual([{ op: 'set', path: ['runtimeRule', 'value'], value: undefined }])
    const incremental = updateBattleStateHashIndex(
      buildBattleStateHashIndex(before, hashStable),
      after,
      patch,
      hashStable,
    )
    expect(incremental.index).toEqual(buildBattleStateHashIndex(after, hashStable))
  })
})
