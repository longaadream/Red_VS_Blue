import { describe, expect, it } from 'vitest'

import { hashPublicBattleState } from '@/lib/game/battle-public-patch'
import { toPublicBattleState } from '@/lib/game/deployment'
import { hashBattleState } from '@/lib/game/battle-trace'
import {
  assertBattleAuthorityRestoreCheckpoint,
  buildBattleAuthorityTransition,
  createBattleAuthorityGenesisHash,
  hashBattleAuthorityTransition,
  replayBattleAuthorityTransitions,
  type BattleAuthorityTransitionRecord,
} from '@/lib/game/battle-transition'
import type { ServerBattleState } from '@/lib/game/battle-storage'
import { createTestServerBattleState } from './profile-test-identity'
import type { BattleAction, BattleState } from '@/lib/game/turn'

describe('RED-109 battle authority recovery', () => {
  it('replays and verifies an ordered transition hash chain from a checkpoint', () => {
    const roomId = 'recovery-room'
    const checkpoint = storageAt(0)
    const versionOne = storageAt(1)
    const versionTwo = storageAt(2)
    const first = transition(roomId, 0, checkpoint, versionOne)
    const second = transition(roomId, 1, versionOne, versionTwo, first.transitionHash)

    const restored = replayBattleAuthorityTransitions({
      ...checkpointInput(roomId, checkpoint),
      targetVersion: 2,
      targetTransitionHash: second.transitionHash,
      transitions: [first, second],
    })

    expect(restored).toEqual(versionTwo)
  })

  it('rejects a corrupted checkpoint before applying any transition', () => {
    const roomId = 'checkpoint-hash-room'
    const checkpoint = storageAt(0)
    const input = checkpointInput(roomId, checkpoint)

    expect(() => replayBattleAuthorityTransitions({
      ...input,
      checkpointStateHash: 'corrupted',
      targetVersion: 0,
      targetTransitionHash: input.checkpointTransitionHash,
      transitions: [],
    })).toThrow('checkpoint hash mismatch')
  })

  it('rejects a checkpoint whose public projection hash is corrupted', () => {
    const roomId = 'checkpoint-public-hash-room'
    const checkpoint = storageAt(0)
    const input = checkpointInput(roomId, checkpoint)

    expect(() => replayBattleAuthorityTransitions({
      ...input,
      checkpointPublicHash: 'corrupted',
      targetVersion: 0,
      targetTransitionHash: input.checkpointTransitionHash,
      transitions: [],
    })).toThrow('checkpoint public hash mismatch')
  })
  it('rejects a missing transition instead of silently accepting a partial restore', () => {
    const roomId = 'gap-room'
    const checkpoint = storageAt(0)
    const versionTwo = storageAt(2)
    const second = transition(roomId, 1, storageAt(1), versionTwo, 'a'.repeat(64))

    expect(() => replayBattleAuthorityTransitions({
      ...checkpointInput(roomId, checkpoint),
      targetVersion: 2,
      targetTransitionHash: second.transitionHash,
      transitions: [second],
    })).toThrow('transition gap')
  })

  it('rejects a transition whose pre-state hash does not match the current state', () => {
    const roomId = 'pre-hash-room'
    const checkpoint = storageAt(0)
    const first = transition(roomId, 0, checkpoint, storageAt(1))

    expect(() => replayBattleAuthorityTransitions({
      ...checkpointInput(roomId, checkpoint),
      targetVersion: 1,
      targetTransitionHash: first.transitionHash,
      transitions: [{ ...first, preStateHash: 'corrupted' }],
    })).toThrow('pre-state hash mismatch')
  })

  it('rejects a transition whose previous chain hash is corrupted', () => {
    const roomId = 'chain-room'
    const checkpoint = storageAt(0)
    const first = transition(roomId, 0, checkpoint, storageAt(1))

    expect(() => replayBattleAuthorityTransitions({
      ...checkpointInput(roomId, checkpoint),
      targetVersion: 1,
      targetTransitionHash: first.transitionHash,
      transitions: [{ ...first, previousTransitionHash: 'b'.repeat(64) }],
    })).toThrow('transition chain mismatch')
  })

  it('rejects a transition whose accepted command action hash is corrupted', () => {
    const roomId = 'action-hash-room'
    const checkpoint = storageAt(0)
    const first = transition(roomId, 0, checkpoint, storageAt(1))

    expect(() => replayBattleAuthorityTransitions({
      ...checkpointInput(roomId, checkpoint),
      targetVersion: 1,
      targetTransitionHash: first.transitionHash,
      transitions: [{
        ...first,
        commands: [{ type: 'beginPhase', clientActionId: 'tampered' } as BattleAction],
      }],
    })).toThrow('action hash mismatch')
  })

  it('rejects a corrupted transition whose resulting state hash does not match', () => {
    const roomId = 'post-hash-room'
    const checkpoint = storageAt(0)
    const first = transition(roomId, 0, checkpoint, storageAt(1))
    const corrupted = {
      ...first,
      postStateHash: hashBattleState(storageAt(2).state as BattleState),
    }
    corrupted.transitionHash = hashBattleAuthorityTransition(corrupted)

    expect(() => replayBattleAuthorityTransitions({
      ...checkpointInput(roomId, checkpoint),
      targetVersion: 1,
      targetTransitionHash: corrupted.transitionHash,
      transitions: [corrupted],
    })).toThrow('transition state hash mismatch')
  })

  it('rejects a transition whose applied public patch does not reach its post-public hash', () => {
    const roomId = 'post-public-hash-room'
    const checkpoint = storageAt(0)
    const first = transition(roomId, 0, checkpoint, storageAt(1))
    const corrupted = {
      ...first,
      postPublicHash: hashPublicBattleState(storageAt(2).state as BattleState),
    }
    corrupted.transitionHash = hashBattleAuthorityTransition(corrupted)

    expect(() => replayBattleAuthorityTransitions({
      ...checkpointInput(roomId, checkpoint),
      targetVersion: 1,
      targetTransitionHash: corrupted.transitionHash,
      transitions: [corrupted],
    })).toThrow('transition public hash mismatch')
  })
  it('allows a legacy version-zero room without a checkpoint, but fails closed after v2 commits', () => {
    expect(assertBattleAuthorityRestoreCheckpoint('legacy-room', 0, undefined)).toBeUndefined()
    expect(() => assertBattleAuthorityRestoreCheckpoint('broken-room', 2, undefined))
      .toThrow('checkpoint missing')
  })
})

function checkpointInput(roomId: string, storage: ServerBattleState) {
  const checkpointStateHash = hashBattleState(storage.state as BattleState)
  const checkpointPublicHash = hashPublicBattleState(toPublicBattleState(storage.state as BattleState))
  return {
    roomId,
    checkpointStorage: storage,
    checkpointVersion: 0,
    checkpointStateHash,
    checkpointPublicHash,
    checkpointTransitionHash: createBattleAuthorityGenesisHash({
      roomId,
      stateHash: checkpointStateHash,
      publicHash: checkpointPublicHash,
    }),
  }
}

function storageAt(revision: number): ServerBattleState {
  return createTestServerBattleState({
    pieces: [],
    players: [],
    turn: { turnNumber: 1, phase: 'action', currentPlayerId: 'player-red' },
    authorityTestRevision: revision,
  })
}

function transition(
  roomId: string,
  fromVersion: number,
  previous: ServerBattleState,
  next: ServerBattleState,
  previousTransitionHash?: string,
): BattleAuthorityTransitionRecord {
  const clientActionId = `recovery-${fromVersion + 1}`
  const command = { type: 'beginPhase', clientActionId } as BattleAction
  return buildBattleAuthorityTransition({
    roomId,
    fromVersion,
    clientActionId,
    playerId: 'player-red',
    command,
    previousStorage: previous,
    nextStorage: next,
    previousPublicState: toPublicBattleState(previous.state as BattleState),
    nextPublicState: toPublicBattleState(next.state as BattleState),
    preStateHash: hashBattleState(previous.state as BattleState),
    postStateHash: hashBattleState(next.state as BattleState),
    previousTransitionHash,
    now: fromVersion,
  })
}
