import { describe, expect, it } from 'vitest'

import { createBattlePublicPatch } from '@/lib/game/battle-public-patch'
import { hashBattleState } from '@/lib/game/battle-trace'
import { replayBattleAuthorityTransitions } from '@/lib/game/battle-transition'
import type { ServerBattleState } from '@/lib/game/battle-storage'
import type { BattleState } from '@/lib/game/turn'

describe('RED-109 battle authority recovery', () => {
  it('replays an ordered transition chain from a checkpoint to the requested version', () => {
    const checkpoint = storageAt(0)
    const versionOne = storageAt(1)
    const versionTwo = storageAt(2)

    const restored = replayBattleAuthorityTransitions({
      roomId: 'recovery-room',
      checkpointStorage: checkpoint,
      checkpointVersion: 0,
      checkpointStateHash: hashBattleState(checkpoint.state as BattleState),
      targetVersion: 2,
      transitions: [
        transition(0, checkpoint, versionOne),
        transition(1, versionOne, versionTwo),
      ],
    })

    expect(restored).toEqual(versionTwo)
  })

  it('rejects a corrupted checkpoint before applying any transition', () => {
    const checkpoint = storageAt(0)

    expect(() => replayBattleAuthorityTransitions({
      roomId: 'checkpoint-hash-room',
      checkpointStorage: checkpoint,
      checkpointVersion: 0,
      checkpointStateHash: 'corrupted',
      targetVersion: 0,
      transitions: [],
    })).toThrow('checkpoint hash mismatch')
  })

  it('rejects a missing transition instead of silently accepting a partial restore', () => {
    const checkpoint = storageAt(0)
    const versionTwo = storageAt(2)

    expect(() => replayBattleAuthorityTransitions({
      roomId: 'gap-room',
      checkpointStorage: checkpoint,
      checkpointVersion: 0,
      checkpointStateHash: hashBattleState(checkpoint.state as BattleState),
      targetVersion: 2,
      transitions: [{
        ...transition(1, storageAt(1), versionTwo),
        fromVersion: 1,
        toVersion: 2,
      }],
    })).toThrow('transition gap')
  })

  it('rejects a corrupted transition whose resulting state hash does not match', () => {
    const checkpoint = storageAt(0)
    const versionOne = storageAt(1)

    expect(() => replayBattleAuthorityTransitions({
      roomId: 'hash-room',
      checkpointStorage: checkpoint,
      checkpointVersion: 0,
      checkpointStateHash: hashBattleState(checkpoint.state as BattleState),
      targetVersion: 1,
      transitions: [{
        ...transition(0, checkpoint, versionOne),
        postStateHash: 'corrupted',
      }],
    })).toThrow('hash mismatch')
  })
})

function storageAt(revision: number): ServerBattleState {
  return {
    type: 'server-state',
    seed: 109,
    state: {
      pieces: [],
      players: [],
      turn: { turnNumber: 1, phase: 'action', currentPlayerId: 'player-red' },
      authorityTestRevision: revision,
    },
  }
}

function transition(
  fromVersion: number,
  previous: ServerBattleState,
  next: ServerBattleState,
) {
  return {
    fromVersion,
    toVersion: fromVersion + 1,
    internalPatch: createBattlePublicPatch(previous, next),
    postStateHash: hashBattleState(next.state as BattleState),
  }
}
