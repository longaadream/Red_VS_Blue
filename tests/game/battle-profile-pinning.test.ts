import { describe, expect, it } from 'vitest'

import {
  GameProfileErrorV1,
  getServerGameProfileIdentityV1,
  type GameProfileIdentityV1,
} from '@/lib/content-pipeline/runtime/profile-game-identity'
import {
  createServerBattleStateV1,
  SERVER_BATTLE_STORAGE_SCHEMA_V1,
  validateServerBattleStateV1,
  type ServerBattleState,
} from '@/lib/game/battle-storage'
import {
  pinBattleProfileIdentityV1,
  readSanitizedBattleActionTrace,
  readSanitizedBattleReplay,
} from '@/lib/game/battle-trace'
import { recordBattleInitialization } from '@/lib/game/battle-runner'
import { RuleRuntime } from '@/lib/game/rule-runtime'
import type { BattleState } from '@/lib/game/turn'
import { makeState } from '../helpers/minimal-state'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function changedHash(hash: string): string {
  return `${hash[0] === '0' ? '1' : '0'}${hash.slice(1)}`
}

function expectPinnedUnavailable(action: () => unknown): void {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(GameProfileErrorV1)
    expect((error as GameProfileErrorV1).code).toBe('PINNED_PROFILE_UNAVAILABLE')
    return
  }
  throw new Error('Expected PINNED_PROFILE_UNAVAILABLE')
}

function createInitializedStorage(
  profileIdentity: GameProfileIdentityV1 = getServerGameProfileIdentityV1(),
  rootSeed = 0x1160cafe,
): { state: BattleState; storage: ServerBattleState } {
  const state = makeState()
  pinBattleProfileIdentityV1(state, profileIdentity, rootSeed)
  recordBattleInitialization(
    state,
    new RuleRuntime({ rootSeed }),
    state.players.map(player => player.playerId),
  )
  return {
    state,
    storage: createServerBattleStateV1(profileIdentity, rootSeed, state),
  }
}

function debugMetadata(state: BattleState): Record<string, unknown> {
  return state.extensions?.debugBattle as Record<string, unknown>
}

describe('RED-116 battle profile pinning', () => {
  it('persists the storage schema, exact identity, root seed, trace, and replay header together', () => {
    const { state, storage } = createInitializedStorage()
    const trace = readSanitizedBattleActionTrace(state)
    const replay = readSanitizedBattleReplay(state)

    expect(storage).toMatchObject({
      type: 'server-state',
      storageSchemaVersion: SERVER_BATTLE_STORAGE_SCHEMA_V1,
      profileIdentity: getServerGameProfileIdentityV1(),
      rootSeed: 0x1160cafe,
    })
    expect(Object.keys(storage).sort()).toEqual([
      'profileIdentity',
      'rootSeed',
      'state',
      'storageSchemaVersion',
      'type',
    ])
    expect(trace).toHaveLength(1)
    expect(trace[0]).toMatchObject({
      actionId: 'system-initialize',
      profileIdentity: storage.profileIdentity,
      rootSeed: storage.rootSeed,
    })
    expect(replay).toMatchObject({
      profileIdentity: storage.profileIdentity,
      rootSeed: storage.rootSeed,
      frames: [],
    })
    expect(validateServerBattleStateV1(storage)).toEqual(storage)
  })

  it('does not infer the active profile for legacy or incomplete storage', () => {
    const { state, storage } = createInitializedStorage()

    expectPinnedUnavailable(() => validateServerBattleStateV1({
      seed: storage.rootSeed,
      state,
    }))
    expectPinnedUnavailable(() => validateServerBattleStateV1({
      type: 'server-state',
      storageSchemaVersion: SERVER_BATTLE_STORAGE_SCHEMA_V1,
      rootSeed: storage.rootSeed,
      state,
    }))
  })

  it('rejects unavailable authority content and envelope/state root-seed drift', () => {
    const { storage } = createInitializedStorage()
    const wrongProfile = clone(storage)
    const mutableWrongProfile = wrongProfile as unknown as {
      profileIdentity: { authorityContentHash: string }
    }
    mutableWrongProfile.profileIdentity.authorityContentHash = changedHash(
      mutableWrongProfile.profileIdentity.authorityContentHash,
    )
    const wrongSeed = clone(storage)
    wrongSeed.rootSeed += 1

    expectPinnedUnavailable(() => validateServerBattleStateV1(wrongProfile))
    expectPinnedUnavailable(() => validateServerBattleStateV1(wrongSeed))
  })

  it('rejects trace and replay profile tampering before returning stored state', () => {
    const { storage } = createInitializedStorage()
    const traceTampered = clone(storage)
    const traceLog = debugMetadata(traceTampered.state as BattleState).actionLog as Array<Record<string, unknown>>
    traceLog[0].rootSeed = storage.rootSeed + 1

    const replayTampered = clone(storage)
    const replay = debugMetadata(replayTampered.state as BattleState).replay as {
      profileIdentity: { resolvedProfileHash: string }
    }
    replay.profileIdentity.resolvedProfileHash = changedHash(replay.profileIdentity.resolvedProfileHash)

    expectPinnedUnavailable(() => validateServerBattleStateV1(traceTampered))
    expectPinnedUnavailable(() => validateServerBattleStateV1(replayTampered))
  })

  it('rejects missing debug evidence and tampered authority headers', () => {
    const { storage } = createInitializedStorage()
    const missingDebug = clone(storage)
    const extensions = (missingDebug.state as BattleState).extensions
    if (extensions) delete extensions.debugBattle

    const authorityTampered = clone(storage)
    const authority = debugMetadata(authorityTampered.state as BattleState).authority as { rootSeed: number }
    authority.rootSeed += 1

    expectPinnedUnavailable(() => validateServerBattleStateV1(missingDebug))
    expectPinnedUnavailable(() => validateServerBattleStateV1(authorityTampered))
  })

  it('restores an internally consistent provenance-only profile difference', () => {
    const active = getServerGameProfileIdentityV1()
    const provenanceOnly = {
      ...active,
      resolvedProfileHash: changedHash(active.resolvedProfileHash),
    }
    const { storage } = createInitializedStorage(provenanceOnly, 116)

    expect(validateServerBattleStateV1(storage)).toEqual(storage)
  })
})
