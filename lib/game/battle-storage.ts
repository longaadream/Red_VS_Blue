import {
  assertPinnedProfileAvailableV1,
  GameProfileErrorV1,
  getServerGameProfileIdentityV1,
  type GameProfileIdentityV1,
} from '../content-pipeline/runtime/profile-game-identity'
import {
  assertBattleTraceProfilePinV1,
  assertBattleProfilePinV1,
} from './battle-trace'
import { loadAllSkillsById } from './skills'
import type { BattleState } from './turn'

export const SERVER_BATTLE_STORAGE_SCHEMA_V1 = 'rvb-server-battle-state/v1' as const

export interface ServerBattleState {
  type: 'server-state'
  storageSchemaVersion: typeof SERVER_BATTLE_STORAGE_SCHEMA_V1
  profileIdentity: GameProfileIdentityV1
  rootSeed: number
  state: unknown
}

export function createServerBattleStateV1(
  profileIdentity: GameProfileIdentityV1,
  rootSeed: number,
  state: BattleState,
): ServerBattleState {
  return validateServerBattleStateV1({
    type: 'server-state',
    storageSchemaVersion: SERVER_BATTLE_STORAGE_SCHEMA_V1,
    profileIdentity,
    rootSeed,
    state,
  })
}

export function validateServerBattleStateV1(value: unknown): ServerBattleState {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Battle storage envelope must be an object')
    }
    const storage = value as Record<string, unknown>
    if (
      Object.keys(storage).sort().join(',')
        !== 'profileIdentity,rootSeed,state,storageSchemaVersion,type'
      || storage.type !== 'server-state'
      || storage.storageSchemaVersion !== SERVER_BATTLE_STORAGE_SCHEMA_V1
      || !Number.isSafeInteger(storage.rootSeed)
      || Number(storage.rootSeed) < 0
      || Number(storage.rootSeed) > 0xffff_ffff
      || !storage.state
      || typeof storage.state !== 'object'
      || Array.isArray(storage.state)
    ) {
      throw new Error('Battle storage envelope is missing its pinned profile or root seed')
    }
    const profileIdentity = assertPinnedProfileAvailableV1(storage.profileIdentity)
    const rootSeed = Number(storage.rootSeed) >>> 0
    assertBattleProfilePinV1(storage.state as BattleState, profileIdentity, rootSeed)
    assertBattleTraceProfilePinV1(storage.state as BattleState)
    return {
      type: 'server-state',
      storageSchemaVersion: SERVER_BATTLE_STORAGE_SCHEMA_V1,
      profileIdentity,
      rootSeed,
      state: storage.state,
    }
  } catch (error) {
    if (error instanceof GameProfileErrorV1 && error.code === 'PINNED_PROFILE_UNAVAILABLE') {
      throw error
    }
    throw new GameProfileErrorV1(
      'PINNED_PROFILE_UNAVAILABLE',
      'The stored battle has no usable pinned profile identity',
      { active: getServerGameProfileIdentityV1() },
    )
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getBattleStorage(room: any): ServerBattleState | null {
  const battleState = room?.battleState as unknown
  if (!battleState) return null
  return validateServerBattleStateV1(battleState)
}

export function withServerSkills(state: unknown): unknown {
  if (!state || typeof state !== 'object') return state
  const currentState = state as Record<string, unknown>
  const embeddedSkills = currentState.skillsById && typeof currentState.skillsById === 'object'
    ? currentState.skillsById as Record<string, unknown>
    : {}
  return {
    ...currentState,
    skillsById: {
      ...loadAllSkillsById(),
      ...embeddedSkills,
    },
  }
}

export function withoutServerSkills(state: unknown): unknown {
  if (!state || typeof state !== 'object') return state
  const rest = { ...(state as Record<string, unknown>) }
  delete rest.skillsById
  return rest
}
