import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

import { describe, expect, test } from 'vitest'

import {
  createBundledBaseProfileV1,
  createBundledBasePackInputV1,
  getBundledBaseProfileV1,
} from '@/lib/content-pipeline/runtime/bundled-base'

describe('RED-115 Bundled Base Profile', () => {
  test('account presence and changes never affect game identity or pack contents', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-base-accounts-'))
    try {
      fs.cpSync(path.resolve('data'), path.join(root, 'data'), { recursive: true })
      if (fs.existsSync(path.resolve('public/images'))) {
        fs.cpSync(path.resolve('public/images'), path.join(root, 'public/images'), { recursive: true })
      }
      const accounts = path.join(root, 'data/users.json')
      fs.rmSync(accounts, { force: true })
      const without = createBundledBaseProfileV1(root).profile
      for (const content of ['{"users":[]}', '{"users":[{"id":"test","password":"fixture-only"}]}']) {
        fs.writeFileSync(accounts, content)
        const withAccounts = createBundledBaseProfileV1(root).profile
        expect(withAccounts.resolvedProfileHash).toBe(without.resolvedProfileHash)
        expect(withAccounts.authorityContentHash).toBe(without.authorityContentHash)
        const { source } = createBundledBasePackInputV1(root)
        expect(source.entries.some(file => file.path === 'data/users.json')).toBe(false)
        const manifest = JSON.parse(new TextDecoder().decode(source.manifestBytes))
        expect(manifest.files.some((file: { path: string }) => file.path === 'data/users.json')).toBe(false)
      }
      const piecePath = path.join(root, 'data/pieces/ana.json')
      const piece = JSON.parse(fs.readFileSync(piecePath, 'utf8'))
      piece.stats.maxHp += 1
      fs.writeFileSync(piecePath, JSON.stringify(piece))
      const changed = createBundledBaseProfileV1(root).profile
      expect(changed.resolvedProfileHash).not.toBe(without.resolvedProfileHash)
      expect(changed.authorityContentHash).not.toBe(without.authorityContentHash)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('constructs one deterministic core-validated Profile from shipped v1 content', () => {
    const appRoot = path.resolve(process.cwd())
    const first = createBundledBaseProfileV1(appRoot)
    const second = createBundledBaseProfileV1(appRoot)

    expect(second.profile.resolvedProfileHash).toBe(first.profile.resolvedProfileHash)
    expect(second.profile.authorityContentHash).toBe(first.profile.authorityContentHash)
    expect(first.profile.files.some(file => file.descriptor.path === 'data/pieces/manifest.json')).toBe(true)
    expect(first.profile.files.some(file => file.descriptor.path === 'data/cards/manifest.json')).toBe(true)
    expect(first.profile.files.some(file => file.descriptor.path === 'images/ana.jpg')).toBe(false)
    expect(first.profile.files.some(file => file.descriptor.path.startsWith('data/pve/'))).toBe(true)
    expect(first.profile.capabilities).toContain('game-data')
    expect(first.profile.capabilities).toContain('pve-content')
    expect(first.profile.capabilities).toContain('trusted-executable-content')
    expect(first.readFile('data/pieces/manifest.json')).toBeInstanceOf(Uint8Array)
  })

  test('caches the exact Base view per immutable app root', () => {
    const appRoot = path.resolve(process.cwd())
    expect(getBundledBaseProfileV1(appRoot)).toBe(getBundledBaseProfileV1(appRoot))
  })
})
