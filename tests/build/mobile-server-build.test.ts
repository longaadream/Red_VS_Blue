import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Android authority shims', () => {
  it('routes crypto to a functional browser shim and exposes imported fs symbols', () => {
    const build = readFileSync('scripts/build-mobile-server.js', 'utf8')
    const fs = readFileSync('mobile-server/fs-shim.ts', 'utf8')
    const crypto = readFileSync('mobile-server/crypto-shim.ts', 'utf8')
    expect(build).toContain("filter: /^(?:node:)?crypto$/")
    expect(build).toContain("'/crypto-shim.ts'")
    expect(fs).toContain('export function linkSync')
    expect(fs).toContain('export function renameSync')
    expect(crypto).toContain("sha256(input)")
    expect(crypto).toContain('export function randomInt')
  })
})
