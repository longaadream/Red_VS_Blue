import path from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  createBundledBaseProfileV1,
  getBundledBaseProfileV1,
} from '@/lib/content-pipeline/runtime/bundled-base'

describe('RED-115 Bundled Base Profile', () => {
  test('constructs one deterministic core-validated Profile from shipped v1 content', () => {
    const appRoot = path.resolve(process.cwd())
    const first = createBundledBaseProfileV1(appRoot)
    const second = createBundledBaseProfileV1(appRoot)

    expect(second.profile.resolvedProfileHash).toBe(first.profile.resolvedProfileHash)
    expect(second.profile.authorityContentHash).toBe(first.profile.authorityContentHash)
    expect(first.profile.files.some(file => file.descriptor.path === 'data/pieces/manifest.json')).toBe(true)
    expect(first.profile.files.some(file => file.descriptor.path === 'data/cards/manifest.json')).toBe(true)
    expect(first.profile.files.some(file => file.descriptor.path === 'images/ana.jpg')).toBe(false)
    expect(first.profile.files.some(file => file.descriptor.path.startsWith('data/pve/'))).toBe(false)
    expect(first.profile.capabilities).toContain('game-data')
    expect(first.profile.capabilities).toContain('trusted-executable-content')
    expect(first.readFile('data/pieces/manifest.json')).toBeInstanceOf(Uint8Array)
  })

  test('caches the exact Base view per immutable app root', () => {
    const appRoot = path.resolve(process.cwd())
    expect(getBundledBaseProfileV1(appRoot)).toBe(getBundledBaseProfileV1(appRoot))
  })
})
