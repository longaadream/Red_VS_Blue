import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  hashStable,
  installSha256HexProvider,
  sha256Hex,
  stableJson,
} from '@/lib/game/battle-trace'
import {
  installNativeBattleSha256,
  nodeSha256Hex,
} from '@/lib/server/battle-hash'

const PROVIDER_SYMBOL = Symbol.for('rvb.battle.sha256-hex-provider/v1')

const EQUIVALENCE_INPUTS = [
  '',
  'abc',
  '红蓝',
  '🗡️',
  '\ud800',
  '\udc00',
  `prefix-${'0123456789abcdef'.repeat(1024)}-suffix`,
]

describe('battle SHA-256 provider', () => {
  it('keeps the browser-safe and Node UTF-8 digests byte-for-byte equivalent', () => {
    const browserDigests = EQUIVALENCE_INPUTS.map(value => sha256Hex(value))
    const nodeDigests = EQUIVALENCE_INPUTS.map(value => (
      createHash('sha256').update(value, 'utf8').digest('hex')
    ))

    expect(nodeDigests).toEqual(browserDigests)
    expect(EQUIVALENCE_INPUTS.map(nodeSha256Hex)).toEqual(browserDigests)
  })

  it('self-checks every required UTF-8 edge class before installation', () => {
    const requiredCases: Array<[string, (value: string) => boolean]> = [
      ['empty', value => value === ''],
      ['abc', value => value === 'abc'],
      ['Chinese', value => value === '红蓝'],
      ['emoji', value => value === '🗡️'],
      ['lone high surrogate', value => value === '\ud800'],
      ['lone low surrogate', value => value === '\udc00'],
      ['long block', value => value.length > 64],
    ]

    for (const [name, matches] of requiredCases) {
      const provider = (value: string) => (
        matches(value) ? 'invalid' : nodeSha256Hex(value)
      )
      expect(
        () => installSha256HexProvider(provider),
        `missing startup self-check case: ${name}`,
      ).toThrow(/SHA-256 provider self-check failed/)
    }
  })

  it('fails closed when provider installation is invalid', () => {
    expect(() => installSha256HexProvider(() => 'not-a-sha256-digest')).toThrow(/SHA-256 provider self-check failed/)
    expect((globalThis as Record<symbol, unknown>)[PROVIDER_SYMBOL]).toBeUndefined()
  })

  it('does not install the native provider when RVB_BATTLE_NATIVE_SHA=0', () => {
    expect(installNativeBattleSha256({ RVB_BATTLE_NATIVE_SHA: '0' })).toBe(false)
    expect((globalThis as Record<symbol, unknown>)[PROVIDER_SYMBOL]).toBeUndefined()
  })

  it('keeps the browser-safe trace module free of Node crypto imports', () => {
    const source = readFileSync(resolve(process.cwd(), 'lib/game/battle-trace.ts'), 'utf8')
    expect(source).not.toContain('node:crypto')
    expect(source).not.toContain("from 'crypto'")
  })

  it('installs once across hot reloads and fails closed on an invalid runtime digest', () => {
    let corruptRuntimeValue = false
    const first = vi.fn((value: string) => (
      corruptRuntimeValue ? 'invalid' : nodeSha256Hex(value)
    ))
    const hotReloaded = vi.fn(nodeSha256Hex)

    expect(installSha256HexProvider(first)).toBe(true)
    expect(installSha256HexProvider(hotReloaded)).toBe(false)
    expect(installNativeBattleSha256({})).toBe(false)

    const firstCallsBeforeRuntimeHash = first.mock.calls.length
    const secondCallsBeforeRuntimeHash = hotReloaded.mock.calls.length
    const runtimeValue = { stable: 'runtime-value', order: 1 }
    expect(hashStable(runtimeValue)).toBe(nodeSha256Hex(stableJson(runtimeValue)))
    expect(first).toHaveBeenCalledTimes(firstCallsBeforeRuntimeHash + 1)
    expect(hotReloaded).toHaveBeenCalledTimes(secondCallsBeforeRuntimeHash)
    expect(Object.getOwnPropertyDescriptor(globalThis, PROVIDER_SYMBOL)).toMatchObject({
      configurable: false,
      writable: false,
    })

    corruptRuntimeValue = true
    expect(() => hashStable({ runtime: 'corruption' })).toThrow(/invalid SHA-256 digest/)
  })
})
