import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { vi, describe, expect, it, afterAll, afterEach, beforeAll, beforeEach } from 'vitest'

import { sha256HexV1 } from '@/lib/content-pipeline/core/hash'
import { resolveProfileV1 } from '@/lib/content-pipeline/core/resolver'
import type { ProfileStoreV1 as ProfileStoreV1Type } from '@/lib/content-pipeline/runtime/profile-store'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AdmZip = require('adm-zip')
const encoder = new TextEncoder()
const roots: string[] = []

const renameControl = vi.hoisted(() => ({
  originalRenameSync: null as ((oldPath: unknown, newPath: unknown) => void) | null,
  faults: [] as NodeJS.ErrnoException[],
  packageAttempts: 0,
  packageWaits: 0,
  profileFaults: [] as NodeJS.ErrnoException[],
  profileAttempts: 0,
  profileWaits: 0,
  useActualRename: false,
  heldRenameError: null as unknown,
  onPackageRename: null as ((oldPath: string, newPath: string) => void) | null,
  onPackageFailure: null as ((oldPath: string, newPath: string) => void) | null,
  onWait: null as (() => void) | null,
}))

let installProfileArchiveV1: typeof import('@/lib/content-pipeline/runtime/profile-archive').installProfileArchiveV1
let ProfileStoreV1: typeof import('@/lib/content-pipeline/runtime/profile-store').ProfileStoreV1

beforeAll(async () => {
  vi.doMock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>()
    const nativeRename = actual.renameSync
    renameControl.originalRenameSync = (oldPath, newPath) => {
      nativeRename(oldPath as Parameters<typeof actual.renameSync>[0], newPath as Parameters<typeof actual.renameSync>[1])
    }
    return {
      ...actual,
      renameSync: (...args: Parameters<typeof actual.renameSync>): ReturnType<typeof actual.renameSync> => {
        const [oldPath, newPath] = args
        const oldText = String(oldPath)
        const newText = String(newPath)
        const packageRename = path.basename(path.dirname(oldText)) === 'packages'
          && path.basename(oldText).startsWith('.')
          && path.basename(oldText).includes('.tmp-')
          && path.basename(path.dirname(newText)) === 'packages'
          && !path.basename(newText).startsWith('.')
        if (packageRename) {
          renameControl.packageAttempts += 1
          renameControl.onPackageRename?.(oldText, newText)
          if (renameControl.useActualRename) {
            try {
              return nativeRename(...args)
            } catch (error) {
              renameControl.heldRenameError = error
              throw error
            }
          }

          const failure = renameControl.faults.shift()
          if (failure) {
            renameControl.onPackageFailure?.(oldText, newText)
            throw failure
          }
          return nativeRename(...args)
        }

        const profileRename = path.basename(path.dirname(oldText)) === 'profiles'
          && path.basename(oldText).startsWith('.')
          && path.basename(oldText).includes('.tmp-')
          && path.basename(path.dirname(newText)) === 'profiles'
          && !path.basename(newText).startsWith('.')
        if (profileRename) {
          renameControl.profileAttempts += 1
          const profileFailure = renameControl.profileFaults.shift()
          if (profileFailure) throw profileFailure
        }
        return nativeRename(...args)
      },
    }
  })
  const archiveModule = await import('@/lib/content-pipeline/runtime/profile-archive')
  installProfileArchiveV1 = archiveModule.installProfileArchiveV1
  const storeModule = await import('@/lib/content-pipeline/runtime/profile-store')
  ProfileStoreV1 = storeModule.ProfileStoreV1
})

afterAll(() => {
  vi.doUnmock('node:fs')
  vi.resetModules()
})

function source(packageId: string, marker: number) {
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker,
  ])
  const manifest = {
    schemaVersion: 'rvb-pack/v1',
    packageId,
    version: '1.0.0',
    displayName: packageId,
    publisher: { id: 'local.test', keyId: null },
    compatibility: { engineAbi: 'rvb-engine/v1', contentAbi: 'rvb-content/v1' },
    capabilities: ['raster-assets'],
    files: [{
      path: 'images/menu.png',
      mediaType: 'image/png',
      size: bytes.byteLength,
      sha256: sha256HexV1(bytes),
    }],
    kind: 'snapshot',
  }
  return {
    manifest,
    bytes,
    contentSource: {
      manifestBytes: encoder.encode(JSON.stringify(manifest)),
      signatureBytes: null,
      entries: [{ path: 'images/menu.png', bytes }],
    },
  } as const
}

function archive(packageId: string, marker: number): Buffer {
  const fixture = source(packageId, marker)
  const zip = new AdmZip()
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(fixture.manifest)))
  zip.addFile('images/menu.png', Buffer.from(fixture.bytes))
  return zip.toBuffer()
}

function store() {
  const root = mkdtempSync(path.join(tmpdir(), 'rvb-red-252-archive-'))
  roots.push(root)
  const baseSource = source('rvb.test-base', 1)
  const base = resolveProfileV1({
    base: {
      source: baseSource.contentSource,
      policy: {
        kind: 'local-dev',
        expectedCompatibility: baseSource.manifest.compatibility,
        allowUnsigned: true,
      },
    },
  })
  return new ProfileStoreV1({ rootDir: root, bundledBase: base })
}

function fsError(code: string): NodeJS.ErrnoException {
  const error = new Error(`simulated ${code}`) as NodeJS.ErrnoException
  error.code = code
  return error
}

let waitSpy: ReturnType<typeof vi.spyOn> | null = null

beforeEach(() => {
  renameControl.faults = []
  renameControl.packageAttempts = 0
  renameControl.packageWaits = 0
  renameControl.profileFaults = []
  renameControl.profileAttempts = 0
  renameControl.profileWaits = 0
  renameControl.useActualRename = false
  renameControl.heldRenameError = null
  renameControl.onPackageRename = null
  renameControl.onPackageFailure = null
  renameControl.onWait = null
  waitSpy = vi.spyOn(Atomics, 'wait').mockImplementation(() => {
    // The package and profile commits share Atomics.wait; classify after the
    // first profile attempt so package scanner retries cannot inflate profile assertions.
    if (renameControl.profileAttempts > 0) renameControl.profileWaits += 1
    else renameControl.packageWaits += 1
    renameControl.onWait?.()
    return 'timed-out'
  })
})

afterEach(() => {
  waitSpy?.mockRestore()
  waitSpy = null
  renameControl.faults = []
  renameControl.packageAttempts = 0
  renameControl.packageWaits = 0
  renameControl.profileFaults = []
  renameControl.profileAttempts = 0
  renameControl.profileWaits = 0
  renameControl.useActualRename = false
  renameControl.heldRenameError = null
  renameControl.onPackageRename = null
  renameControl.onPackageFailure = null
  renameControl.onWait = null
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function installInto(profileStore: ProfileStoreV1Type, packageId: string, marker: number) {
  return installProfileArchiveV1({
    store: profileStore,
    appRoot: process.cwd(),
    archive: archive(packageId, marker),
    allowLocalDevUnsigned: true,
  })
}

function install(packageId: string, marker: number) {
  return installInto(store(), packageId, marker)
}

describe('RED-252 Profile archive package-directory rename', () => {
  it.skipIf(process.platform !== 'win32').each(['EPERM', 'EACCES'] as const)(
    'retries %s up to four total attempts and preserves the first transient error after exhaustion',
    code => {
      const first = fsError(code)
      renameControl.faults = [first, fsError(code), fsError(code), fsError(code)]
      const profileStore = store()

      let thrown: unknown
      try {
        installInto(profileStore, `rvb.rename.exhaust.${code.toLowerCase()}`, 2)
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBe(first)
      expect(renameControl.packageAttempts).toBe(4)
      expect(renameControl.packageWaits).toBe(3)
      expect(waitSpy?.mock.calls.every((call: readonly unknown[]) => call[3] === 100)).toBe(true)
      expect(readdirSync(path.join(profileStore.rootDir, 'packages'))).toEqual([])
    },
  )

  it.skipIf(process.platform !== 'win32')(
    'throws a later permanent rename error immediately after a transient failure',
    () => {
      const transient = fsError('EPERM')
      const permanent = fsError('ENOENT')
      renameControl.faults = [transient, permanent]

      let thrown: unknown
      try {
        install('rvb.rename.permanent', 3)
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBe(permanent)
      expect(renameControl.packageAttempts).toBe(2)
      expect(renameControl.packageWaits).toBe(1)
    },
  )

  it.skipIf(process.platform !== 'win32')(
    'rejects and preserves a destination that appears after a transient failure',
    () => {
      renameControl.faults = [fsError('EPERM')]
      let destination: string | null = null
      renameControl.onPackageFailure = (oldPath, newPath) => {
        destination = newPath
        renameControl.originalRenameSync?.(oldPath, newPath)
        writeFileSync(path.join(newPath, 'payload', 'images', 'menu.png'), Buffer.from([0]))
      }

      let thrown: unknown
      try {
        install('rvb.rename.destination-race', 4)
      } catch (error) {
        thrown = error
      }

      expect(String(thrown)).toMatch(/PROFILE_HASH_MISMATCH/)
      expect(destination).not.toBeNull()
      expect(readFileSync(path.join(destination!, 'payload', 'images', 'menu.png')))
        .toEqual(Buffer.from([0]))
      expect(renameControl.packageAttempts).toBe(1)
      expect(renameControl.packageWaits).toBe(0)
    },
  )

  it.skipIf(process.platform !== 'win32')(
    'cleans a failed profile commit without changing candidate or lock state',
    () => {
      const first = fsError('EPERM')
      renameControl.profileFaults = [first, fsError('EPERM'), fsError('EPERM'), fsError('EPERM')]
      const profileStore = store()
      const before = profileStore.readState()

      let thrown: unknown
      try {
        installInto(profileStore, 'rvb.rename.profile-exhausted', 5)
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBe(first)
      expect(renameControl.packageAttempts).toBeGreaterThanOrEqual(1)
      expect(renameControl.profileAttempts).toBe(4)
      expect(renameControl.profileWaits).toBe(3)
      expect(waitSpy?.mock.calls.every((call: readonly unknown[]) => call[3] === 100)).toBe(true)
      const after = profileStore.readState()
      expect(after.stable).toEqual(before.stable)
      expect(after.candidate).toBeNull()
      expect(existsSync(profileStore.lockPath)).toBe(false)
      expect(readdirSync(path.join(profileStore.rootDir, 'profiles'))).toEqual([])
    },
  )

  it.skipIf(process.platform !== 'win32')(
    'recovers a profile commit after transient EPERM/EACCES failures',
    () => {
      renameControl.profileFaults = [fsError('EPERM'), fsError('EACCES')]
      const profileStore = store()

      const result = installInto(profileStore, 'rvb.rename.profile-retry', 6)

      expect(result.reference.kind).toBe('installed')
      expect(renameControl.packageAttempts).toBe(1)
      expect(renameControl.profileAttempts).toBe(3)
      expect(renameControl.profileWaits).toBe(2)
      expect(waitSpy?.mock.calls.every((call: readonly unknown[]) => call[3] === 100)).toBe(true)
      expect(profileStore.readState().candidate?.resolvedProfileHash)
        .toBe(result.profile.resolvedProfileHash)
    },
  )

  it.skipIf(process.platform !== 'win32')(
    'releases a real held temporary-package handle once before retrying',
    () => {
      renameControl.useActualRename = true
      let handle: number | null = null
      let closed = false
      renameControl.onPackageRename = oldPath => {
        if (handle === null) handle = openSync(path.join(oldPath, 'manifest.json'), 'r')
      }
      renameControl.onWait = () => {
        if (handle === null) throw new Error('rename retry waited without a held handle')
        if (!closed) {
          closeSync(handle)
          closed = true
        }
      }

      try {
        const result = install('rvb.rename.held-handle', 5)
        expect(result.reference.kind).toBe('installed')
        expect(renameControl.heldRenameError).toMatchObject({
          code: expect.stringMatching(/^(EPERM|EACCES)$/),
        })
        expect(renameControl.packageAttempts).toBe(2)
        expect(renameControl.packageWaits).toBe(1)
        expect(closed).toBe(true)
      } finally {
        if (handle !== null && !closed) closeSync(handle)
      }
    },
  )
})
