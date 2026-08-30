import type { ProfileReferenceV1 } from './profile-store'
import { getRuntimeProfileReferenceV1 } from './profile-runtime'

export const GAME_PROFILE_IDENTITY_SCHEMA_V1 = 'rvb-game-profile-identity/v1' as const
export const BATTLE_RUNNER_REVISION_V1 = 'rvb-battle-runner/v1' as const

const SHA256_HEX = /^[a-f0-9]{64}$/
const IDENTITY_KEYS = [
  'schemaVersion',
  'engineAbi',
  'runnerRevision',
  'resolvedProfileHash',
  'authorityContentHash',
] as const

export interface GameProfileIdentityV1 {
  readonly schemaVersion: typeof GAME_PROFILE_IDENTITY_SCHEMA_V1
  readonly engineAbi: string
  readonly runnerRevision: string
  readonly resolvedProfileHash: string
  readonly authorityContentHash: string
}

export type GameProfileErrorCodeV1 =
  | 'PROFILE_REQUIRED'
  | 'PROFILE_INVALID'
  | 'ENGINE_ABI_MISMATCH'
  | 'RUNNER_REVISION_MISMATCH'
  | 'PROFILE_HASH_MISMATCH'
  | 'PINNED_PROFILE_UNAVAILABLE'

export class GameProfileErrorV1 extends Error {
  readonly status = 409

  constructor(
    readonly code: GameProfileErrorCodeV1,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'GameProfileErrorV1'
  }
}

export function createGameProfileIdentityV1(
  reference: Pick<ProfileReferenceV1, 'resolvedProfileHash' | 'authorityContentHash' | 'compatibility'>,
): GameProfileIdentityV1 {
  return Object.freeze({
    schemaVersion: GAME_PROFILE_IDENTITY_SCHEMA_V1,
    engineAbi: reference.compatibility.engineAbi,
    runnerRevision: BATTLE_RUNNER_REVISION_V1,
    resolvedProfileHash: reference.resolvedProfileHash,
    authorityContentHash: reference.authorityContentHash,
  })
}

export function getServerGameProfileIdentityV1(): GameProfileIdentityV1 {
  return createGameProfileIdentityV1(getRuntimeProfileReferenceV1())
}

export function parseGameProfileIdentityV1(value: unknown): GameProfileIdentityV1 {
  if (value === undefined || value === null || value === '') {
    throw new GameProfileErrorV1('PROFILE_REQUIRED', 'A resolved game profile identity is required')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidProfile('Profile identity must be an object')
  }
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate).sort()
  const expectedKeys = [...IDENTITY_KEYS].sort()
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw invalidProfile('Profile identity has unexpected or missing fields')
  }
  if (candidate.schemaVersion !== GAME_PROFILE_IDENTITY_SCHEMA_V1) {
    throw invalidProfile('Profile identity schema is unsupported')
  }
  if (typeof candidate.engineAbi !== 'string' || !candidate.engineAbi.trim()) {
    throw invalidProfile('Profile engine ABI is invalid')
  }
  if (typeof candidate.runnerRevision !== 'string' || !candidate.runnerRevision.trim()) {
    throw invalidProfile('Profile runner revision is invalid')
  }
  if (typeof candidate.resolvedProfileHash !== 'string' || !SHA256_HEX.test(candidate.resolvedProfileHash)) {
    throw invalidProfile('Resolved profile hash is invalid')
  }
  if (typeof candidate.authorityContentHash !== 'string' || !SHA256_HEX.test(candidate.authorityContentHash)) {
    throw invalidProfile('Authority content hash is invalid')
  }
  return Object.freeze({
    schemaVersion: GAME_PROFILE_IDENTITY_SCHEMA_V1,
    engineAbi: candidate.engineAbi,
    runnerRevision: candidate.runnerRevision,
    resolvedProfileHash: candidate.resolvedProfileHash,
    authorityContentHash: candidate.authorityContentHash,
  })
}

export function assertGameProfileCompatibleV1(
  actualValue: unknown,
  expected: GameProfileIdentityV1 = getServerGameProfileIdentityV1(),
): GameProfileIdentityV1 {
  const actual = parseGameProfileIdentityV1(actualValue)
  const context = { expected, actual }
  if (actual.engineAbi !== expected.engineAbi) {
    throw new GameProfileErrorV1(
      'ENGINE_ABI_MISMATCH',
      'The client and server use different engine ABIs',
      context,
    )
  }
  if (actual.runnerRevision !== expected.runnerRevision) {
    throw new GameProfileErrorV1(
      'RUNNER_REVISION_MISMATCH',
      'The client and server use different battle runner revisions',
      context,
    )
  }
  if (actual.authorityContentHash !== expected.authorityContentHash) {
    throw new GameProfileErrorV1(
      'PROFILE_HASH_MISMATCH',
      'The client and server use different authoritative game content',
      context,
    )
  }
  return actual
}

export function assertPinnedProfileAvailableV1(
  pinnedValue: unknown,
  active: GameProfileIdentityV1 = getServerGameProfileIdentityV1(),
): GameProfileIdentityV1 {
  let pinned: GameProfileIdentityV1
  try {
    pinned = parseGameProfileIdentityV1(pinnedValue)
    assertGameProfileCompatibleV1(pinned, active)
  } catch {
    const actual = publicGameProfileIdentityV1(pinnedValue)
    throw new GameProfileErrorV1(
      'PINNED_PROFILE_UNAVAILABLE',
      'The battle pinned profile is not available in the active authority runtime',
      { active, ...(actual ? { pinned: actual } : {}) },
    )
  }
  return pinned
}

export function sameGameProfileIdentityV1(
  left: GameProfileIdentityV1,
  right: GameProfileIdentityV1,
): boolean {
  return IDENTITY_KEYS.every(key => left[key] === right[key])
}

export function publicGameProfileIdentityV1(value: unknown): GameProfileIdentityV1 | undefined {
  try {
    return parseGameProfileIdentityV1(value)
  } catch {
    return undefined
  }
}

export function getGameProfileErrorPayloadV1(error: unknown): {
  code: GameProfileErrorCodeV1
  message: string
  context: Readonly<Record<string, unknown>>
  status: number
} | undefined {
  if (!(error instanceof GameProfileErrorV1)) return undefined
  return {
    code: error.code,
    message: error.message,
    context: error.context,
    status: error.status,
  }
}

function invalidProfile(message: string): GameProfileErrorV1 {
  return new GameProfileErrorV1('PROFILE_INVALID', message)
}
