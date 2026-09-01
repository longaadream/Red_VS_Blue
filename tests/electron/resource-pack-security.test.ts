import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  listActiveResourcePackFiles,
  readDesktopProfileState,
  recoverUncertainProfileCommit,
  resolveActiveResourcePackRoot,
  type DesktopProfileReference,
} from '../../electron-client/resource-pack-store'

const roots: string[] = []

function temporaryPackRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-red-115-electron-store-'))
  roots.push(root)
  return root
}

function reference(kind: 'bundled-base' | 'installed', marker: string): DesktopProfileReference {
  return {
    schemaVersion: 'rvb-profile-reference/v1',
    kind,
    resolvedProfileHash: marker.repeat(64),
    authorityContentHash: marker.repeat(64),
    compatibility: { engineAbi: 'rvb-engine/v1', contentAbi: 'rvb-content/v1' },
    capabilities: ['game-data', 'raster-assets'],
    packageId: `rvb.${marker}`,
    version: '1.0.0',
    installedAt: '2026-08-28T00:00:00.000Z',
  }
}

function writeState(
  root: string,
  stable: DesktopProfileReference,
  candidate: DesktopProfileReference | null = null,
): void {
  fs.writeFileSync(path.join(root, 'active.json'), JSON.stringify({
    schemaVersion: 'rvb-profile-state/v1',
    revision: 1,
    stable,
    candidate,
    previousStable: null,
    activation: null,
    lastFailure: null,
  }))
}

function materializeProfile(root: string, profile: DesktopProfileReference): string {
  const profileRoot = path.join(root, 'profiles', profile.resolvedProfileHash)
  fs.mkdirSync(path.join(profileRoot, '.rvb'), { recursive: true })
  fs.mkdirSync(path.join(profileRoot, 'data', 'cards'), { recursive: true })
  fs.mkdirSync(path.join(profileRoot, 'images'), { recursive: true })
  fs.mkdirSync(path.join(profileRoot, 'js'), { recursive: true })
  fs.writeFileSync(path.join(profileRoot, '.rvb', 'profile.json'), '{}')
  fs.writeFileSync(path.join(profileRoot, 'data', 'cards', 'test.json'), '{"id":"test"}')
  fs.writeFileSync(path.join(profileRoot, 'images', 'test.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  fs.writeFileSync(path.join(profileRoot, 'images', 'vector.svg'), '<svg/>')
  fs.writeFileSync(path.join(profileRoot, 'js', 'runtime.js'), 'alert(1)')
  fs.writeFileSync(path.join(profileRoot, 'index.html'), '<script>alert(1)</script>')
  return profileRoot
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Electron Profile store security boundary', () => {
  test('standalone commit recovery requires a healthy ungated post-restart identity', async () => {
    const target = 'e'.repeat(64)
    const observe = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        state: { stable: { resolvedProfileHash: target } },
        server: {
          healthy: true,
          activationId: null,
          profile: { resolvedProfileHash: target },
        },
      })
    const restart = vi.fn().mockResolvedValue(undefined)

    await expect(recoverUncertainProfileCommit(target, observe, restart))
      .resolves.toMatchObject({ state: { stable: { resolvedProfileHash: target } } })
    expect(restart).toHaveBeenCalledOnce()
  })

  test('candidate never becomes active until stable is atomically committed', () => {
    const root = temporaryPackRoot()
    const base = reference('bundled-base', 'a')
    const candidate = reference('installed', 'b')
    materializeProfile(root, candidate)
    writeState(root, base, candidate)

    expect(resolveActiveResourcePackRoot(root)).toBeNull()
    expect(readDesktopProfileState(root)?.candidate?.resolvedProfileHash)
      .toBe(candidate.resolvedProfileHash)

    writeState(root, candidate)
    expect(resolveActiveResourcePackRoot(root))
      .toBe(path.join(root, 'profiles', candidate.resolvedProfileHash))
  })

  test('exposes only v1 data JSON and safe raster files from a complete stable snapshot', () => {
    const root = temporaryPackRoot()
    const stable = reference('installed', 'c')
    materializeProfile(root, stable)
    writeState(root, stable)

    expect(listActiveResourcePackFiles(root)).toEqual([
      '/data/cards/test.json',
      '/images/test.png',
    ])
  })

  test('fails closed for an incomplete installed snapshot', () => {
    const root = temporaryPackRoot()
    const stable = reference('installed', 'd')
    writeState(root, stable)

    expect(() => resolveActiveResourcePackRoot(root)).toThrow(/PROFILE_SNAPSHOT_INCOMPLETE/)
  })

  test('legacy and malformed pointers are never interpreted as active v1 content', () => {
    const root = temporaryPackRoot()
    fs.writeFileSync(path.join(root, 'active.json'), JSON.stringify({ version: 'legacy' }))

    expect(readDesktopProfileState(root)).toBeNull()
    expect(resolveActiveResourcePackRoot(root)).toBeNull()
  })

  test('client resolves the committed identity from its atomic stable pointer', () => {
    const root = temporaryPackRoot()
    const stable = reference('installed', 'e')
    const profileRoot = materializeProfile(root, stable)
    writeState(root, stable)

    expect(readDesktopProfileState(root)?.stable.resolvedProfileHash)
      .toBe(stable.resolvedProfileHash)
    expect(resolveActiveResourcePackRoot(root)).toBe(profileRoot)
  })
})
