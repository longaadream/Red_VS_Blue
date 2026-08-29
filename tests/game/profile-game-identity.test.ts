import { describe, expect, it } from 'vitest'

import {
  assertGameProfileCompatibleV1,
  assertPinnedProfileAvailableV1,
  GameProfileErrorV1,
  getServerGameProfileIdentityV1,
  parseGameProfileIdentityV1,
  sameGameProfileIdentityV1,
  type GameProfileErrorCodeV1,
  type GameProfileIdentityV1,
} from '@/lib/content-pipeline/runtime/profile-game-identity'

function changedHash(hash: string): string {
  return `${hash[0] === '0' ? '1' : '0'}${hash.slice(1)}`
}

function errorCode(action: () => unknown): GameProfileErrorCodeV1 {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(GameProfileErrorV1)
    return (error as GameProfileErrorV1).code
  }
  throw new Error('Expected a profile identity error')
}

describe('RED-116 resolved profile identity contract', () => {
  it('accepts and preserves the exact server identity', () => {
    const expected = getServerGameProfileIdentityV1()
    const parsed = parseGameProfileIdentityV1({ ...expected })

    expect(parsed).toEqual(expected)
    expect(assertGameProfileCompatibleV1(parsed, expected)).toEqual(expected)
    expect(sameGameProfileIdentityV1(parsed, expected)).toBe(true)
    expect(Object.isFrozen(parsed)).toBe(true)
  })

  it('distinguishes required and malformed identities', () => {
    const expected = getServerGameProfileIdentityV1()

    expect(errorCode(() => assertGameProfileCompatibleV1(undefined, expected))).toBe('PROFILE_REQUIRED')
    expect(errorCode(() => assertGameProfileCompatibleV1('invalid', expected))).toBe('PROFILE_INVALID')
    expect(errorCode(() => assertGameProfileCompatibleV1({ ...expected, extra: true }, expected))).toBe('PROFILE_INVALID')
    expect(errorCode(() => assertGameProfileCompatibleV1({
      ...expected,
      authorityContentHash: 'not-a-sha256',
    }, expected))).toBe('PROFILE_INVALID')
  })

  it('reports each hard compatibility gate with its stable error code', () => {
    const expected = getServerGameProfileIdentityV1()
    const cases: Array<{
      code: GameProfileErrorCodeV1
      actual: GameProfileIdentityV1
    }> = [
      {
        code: 'ENGINE_ABI_MISMATCH',
        actual: { ...expected, engineAbi: `${expected.engineAbi}-other` },
      },
      {
        code: 'RUNNER_REVISION_MISMATCH',
        actual: { ...expected, runnerRevision: `${expected.runnerRevision}-other` },
      },
      {
        code: 'PROFILE_HASH_MISMATCH',
        actual: {
          ...expected,
          authorityContentHash: changedHash(expected.authorityContentHash),
        },
      },
    ]

    for (const testCase of cases) {
      expect(errorCode(() => assertGameProfileCompatibleV1(testCase.actual, expected))).toBe(testCase.code)
    }
  })

  it('keeps resolvedProfileHash as provenance without making raster-only differences a hard gate', () => {
    const expected = getServerGameProfileIdentityV1()
    const actual = {
      ...expected,
      resolvedProfileHash: changedHash(expected.resolvedProfileHash),
    }

    expect(assertGameProfileCompatibleV1(actual, expected)).toEqual(actual)
    expect(assertPinnedProfileAvailableV1(actual, expected)).toEqual(actual)
    expect(sameGameProfileIdentityV1(actual, expected)).toBe(false)
  })

  it('fails closed when a pinned authority profile is unavailable', () => {
    const expected = getServerGameProfileIdentityV1()
    const pinned = {
      ...expected,
      authorityContentHash: changedHash(expected.authorityContentHash),
    }
    expect(errorCode(() => assertPinnedProfileAvailableV1(pinned, expected))).toBe('PINNED_PROFILE_UNAVAILABLE')
    expect(errorCode(() => assertPinnedProfileAvailableV1(undefined, expected))).toBe('PINNED_PROFILE_UNAVAILABLE')
  })
})
