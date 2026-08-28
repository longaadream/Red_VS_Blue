import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { sha256HexV1 } from '@/lib/content-pipeline/core/hash'
import { resolveProfileV1 } from '@/lib/content-pipeline/core/resolver'
import {
  installProfileArchiveV1,
  preflightProfileArchiveEntriesV1,
  PROFILE_ARCHIVE_LIMITS_V1,
  readProfileArchiveV1,
} from '@/lib/content-pipeline/runtime/profile-archive'
import { ProfileStoreV1 } from '@/lib/content-pipeline/runtime/profile-store'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AdmZip = require('adm-zip')
const encoder = new TextEncoder()
const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
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
  const root = mkdtempSync(path.join(tmpdir(), 'rvb-red-115-archive-'))
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

describe('RED-115 Profile archive adapter', () => {
  it('installs a valid v1 ZIP only as candidate through the core resolver', () => {
    const profileStore = store()
    const before = profileStore.readState()
    const result = installProfileArchiveV1({
      store: profileStore,
      appRoot: process.cwd(),
      archive: archive('rvb.archive', 2),
      allowLocalDevUnsigned: true,
    })
    const after = profileStore.readState()

    expect(after.stable).toEqual(before.stable)
    expect(after.candidate?.resolvedProfileHash).toBe(result.profile.resolvedProfileHash)
    expect(result.reference.kind).toBe('installed')
    expect(result.reloadMode).toBe('presentation-refresh')
  })

  it('requires external signatures and never treats legacy pack.json as v1', () => {
    expect(() => installProfileArchiveV1({
      store: store(),
      appRoot: process.cwd(),
      archive: archive('rvb.unsigned', 3),
    })).toThrow(/PACK_SIGNATURE_REQUIRED/)

    const zip = new AdmZip()
    zip.addFile('pack.json', Buffer.from('{"name":"legacy"}'))
    expect(() => readProfileArchiveV1(zip.toBuffer())).toThrow(/legacy pack\.json/)
  })

  it('rejects traversal and case-colliding ZIP entries before extraction', () => {
    const zip = new AdmZip()
    zip.addFile('manifest.json', Buffer.from('{}'))
    zip.addFile('Images/a.png', Buffer.from('a'))
    zip.addFile('images/A.png', Buffer.from('b'))
    expect(() => readProfileArchiveV1(zip.toBuffer())).toThrow(/archive collision/)
  })

  it('rejects encrypted/symlink entries and all declared archive budgets before decompression', () => {
    const entry = (entryName: string, size: number, options: { encrypted?: boolean; attr?: number } = {}) => ({
      entryName,
      isDirectory: false,
      attr: options.attr ?? 0,
      header: { size, encrypted: options.encrypted },
    })

    expect(() => preflightProfileArchiveEntriesV1([
      entry('manifest.json', 2, { encrypted: true }),
    ])).toThrow(/unsupported archive entry/)
    expect(() => preflightProfileArchiveEntriesV1([
      entry('images/link.png', 4, { attr: 0o120777 << 16 }),
    ])).toThrow(/unsupported archive entry/)
    expect(() => preflightProfileArchiveEntriesV1([
      entry('images/too-large.png', PROFILE_ARCHIVE_LIMITS_V1.maxFileBytes + 1),
    ])).toThrow(/archive file budget/)
    expect(() => preflightProfileArchiveEntriesV1(Array.from(
      { length: PROFILE_ARCHIVE_LIMITS_V1.maxEntries + 1 },
      (_, index) => entry(`images/${index}.png`, 1),
    ))).toThrow(/archive entry budget/)
    expect(() => preflightProfileArchiveEntriesV1([
      ...Array.from({ length: 8 }, (_, index) => (
        entry(`images/budget-${index}.png`, PROFILE_ARCHIVE_LIMITS_V1.maxFileBytes)
      )),
      entry('images/over-budget.png', 1),
    ])).toThrow(/archive total budget/)
    expect(() => readProfileArchiveV1(new Uint8Array(
      PROFILE_ARCHIVE_LIMITS_V1.maxArchiveBytes + 1,
    ))).toThrow(/bounded ZIP/)
  })

  it('does not change stable or candidate when content validation fails', () => {
    const profileStore = store()
    const before = profileStore.readState()
    const broken = encoder.encode('{')
    const manifest = {
      schemaVersion: 'rvb-pack/v1',
      packageId: 'rvb.invalid-json',
      version: '1.0.0',
      displayName: 'invalid JSON',
      publisher: { id: 'local.test', keyId: null },
      compatibility: { engineAbi: 'rvb-engine/v1', contentAbi: 'rvb-content/v1' },
      capabilities: ['game-data'],
      files: [{
        path: 'data/cards/broken.json',
        mediaType: 'application/json',
        size: broken.byteLength,
        sha256: sha256HexV1(broken),
      }],
      kind: 'snapshot',
    }
    const zip = new AdmZip()
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
    zip.addFile('data/cards/broken.json', Buffer.from(broken))

    expect(() => installProfileArchiveV1({
      store: profileStore,
      appRoot: process.cwd(),
      archive: zip.toBuffer(),
      allowLocalDevUnsigned: true,
    })).toThrow()
    expect(profileStore.readState().stable).toEqual(before.stable)
    expect(profileStore.readState().candidate).toBeNull()
  })

  it('reuses only an identical immutable stored package', () => {
    const profileStore = store()
    const packageArchive = archive('rvb.immutable', 4)
    const first = installProfileArchiveV1({
      store: profileStore,
      appRoot: process.cwd(),
      archive: packageArchive,
      allowLocalDevUnsigned: true,
    })
    const repeated = installProfileArchiveV1({
      store: profileStore,
      appRoot: process.cwd(),
      archive: packageArchive,
      allowLocalDevUnsigned: true,
    })
    expect(repeated.reference.resolvedProfileHash).toBe(first.reference.resolvedProfileHash)

    const packageHash = readdirSync(path.join(profileStore.rootDir, 'packages'))[0]
    writeFileSync(path.join(profileStore.rootDir, 'packages', packageHash, 'manifest.json'), '{}')
    expect(() => installProfileArchiveV1({
      store: profileStore,
      appRoot: process.cwd(),
      archive: packageArchive,
      allowLocalDevUnsigned: true,
    })).toThrow(/PROFILE_HASH_MISMATCH/)
  })

  it('reconstructs an installed parent and installs a Patch as one complete candidate', () => {
    const profileStore = store()
    const baseArchive = archive('rvb.patch-base', 5)
    const base = installProfileArchiveV1({
      store: profileStore,
      appRoot: process.cwd(),
      archive: baseArchive,
      allowLocalDevUnsigned: true,
    })
    const replacement = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 6,
    ])
    const patchManifest = {
      schemaVersion: 'rvb-pack/v1',
      packageId: 'rvb.patch-replace',
      version: '1.0.0',
      displayName: 'rvb.patch-replace',
      publisher: { id: 'local.test', keyId: null },
      compatibility: { engineAbi: 'rvb-engine/v1', contentAbi: 'rvb-content/v1' },
      capabilities: ['raster-assets'],
      files: [{
        path: 'images/patch/menu.png',
        mediaType: 'image/png',
        size: replacement.byteLength,
        sha256: sha256HexV1(replacement),
      }],
      kind: 'patch',
      parentProfileHash: base.profile.resolvedProfileHash,
      operations: [{
        op: 'replace',
        targetPath: 'images/menu.png',
        sourcePath: 'images/patch/menu.png',
        expectedHash: base.profile.files[0].descriptor.sha256,
      }],
    }
    const zip = new AdmZip()
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(patchManifest)))
    zip.addFile('images/patch/menu.png', Buffer.from(replacement))

    const patched = installProfileArchiveV1({
      store: profileStore,
      appRoot: process.cwd(),
      archive: zip.toBuffer(),
      allowLocalDevUnsigned: true,
    })

    expect(patched.profile.patches).toHaveLength(1)
    expect(patched.profile.patches[0].parentProfileHash).toBe(base.profile.resolvedProfileHash)
    expect(patched.profile.files).toHaveLength(1)
    expect(patched.profile.files[0].descriptor).toMatchObject({
      path: 'images/menu.png',
      sha256: sha256HexV1(replacement),
    })
    expect(profileStore.readState().candidate?.resolvedProfileHash)
      .toBe(patched.profile.resolvedProfileHash)
  })
})
