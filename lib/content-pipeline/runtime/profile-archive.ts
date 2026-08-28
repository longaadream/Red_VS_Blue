import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import {
  PackManifestV1Schema,
  type PackManifestV1,
} from '../contracts'
import { computePackageHashV1 } from '../core/hash'
import {
  resolveProfileV1,
  type ResolvePackInputV1,
  type ResolvedSnapshotViewV1,
} from '../core/resolver'
import type { ContentPackSourceV1 } from '../core/source'
import type { ContentValidationPolicyV1 } from '../core/validator'
import {
  createBundledBasePackInputV1,
  getBundledBaseProfileV1,
  PROFILE_CONTENT_ABI_V1,
  PROFILE_ENGINE_ABI_V1,
} from './bundled-base'
import {
  classifyProfileReloadV1,
  PROFILE_RESOLUTION_FILE_V1,
  ProfileStoreErrorV1,
  ProfileStoreV1,
  type ProfileReferenceV1,
  type ProfileReloadModeV1,
  type ProfileResolutionPackageV1,
  type ProfileResolutionRecordV1,
} from './profile-store'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AdmZip = require('adm-zip')

export const PROFILE_ARCHIVE_LIMITS_V1 = Object.freeze({
  maxArchiveBytes: 32 * 1024 * 1024,
  maxEntries: 2_048,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
})

export interface ProfileArchiveEntryV1 {
  readonly entryName: string
  readonly isDirectory: boolean
  readonly attr?: number
  readonly header: Readonly<{ size: number; encrypted?: boolean }>
  readonly getData?: () => Buffer
}

interface CheckedEntryV1 {
  readonly entry: ProfileArchiveEntryV1
  readonly path: string
}

interface StoredPackageMetadataV1 {
  readonly schemaVersion: 'rvb-stored-package/v1'
  readonly packageHash: string
  readonly policy: ProfileResolutionPackageV1['policy']
}

export interface InstallProfileArchiveOptionsV1 {
  readonly store: ProfileStoreV1
  readonly appRoot: string
  readonly archive: Uint8Array
  readonly allowLocalDevUnsigned?: boolean
}

export interface InstalledProfileArchiveV1 {
  readonly reference: ProfileReferenceV1
  readonly profile: ResolvedSnapshotViewV1['profile']
  readonly reloadMode: ProfileReloadModeV1
}

function normalizeEntryPath(raw: string): string {
  if (
    !raw
    || raw.includes('\0')
    || raw.includes('\\')
    || raw.startsWith('/')
    || /^[a-zA-Z]:\//.test(raw)
  ) throw new ProfileStoreErrorV1('PROFILE_STATE_INVALID', `archive path ${JSON.stringify(raw)}`)
  const withoutSlash = raw.replace(/\/+$/, '')
  const segments = withoutSlash.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new ProfileStoreErrorV1('PROFILE_STATE_INVALID', `archive path ${JSON.stringify(raw)}`)
  }
  return segments.join('/')
}

function isSymbolicLink(entry: ProfileArchiveEntryV1): boolean {
  const mode = ((entry.attr ?? 0) >>> 16) & 0xffff
  return (mode & 0xf000) === 0xa000
}

function isUnsupportedUnixType(entry: ProfileArchiveEntryV1): boolean {
  const mode = ((entry.attr ?? 0) >>> 16) & 0xffff
  const type = mode & 0xf000
  return type !== 0 && type !== 0x4000 && type !== 0x8000
}

export function preflightProfileArchiveEntriesV1(
  entries: readonly ProfileArchiveEntryV1[],
): CheckedEntryV1[] {
  if (entries.length > PROFILE_ARCHIVE_LIMITS_V1.maxEntries) {
    throw new ProfileStoreErrorV1('PROFILE_STATE_INVALID', 'archive entry budget')
  }
  const seen = new Set<string>()
  const checked: CheckedEntryV1[] = []
  let total = 0
  for (const entry of entries) {
    const entryPath = normalizeEntryPath(entry.entryName)
    const collisionKey = entryPath.toLocaleLowerCase('en-US')
    if (seen.has(collisionKey)) {
      throw new ProfileStoreErrorV1('PROFILE_STATE_INVALID', `archive collision ${entryPath}`)
    }
    seen.add(collisionKey)
    if (entry.header.encrypted || isSymbolicLink(entry) || isUnsupportedUnixType(entry)) {
      throw new ProfileStoreErrorV1('PROFILE_STATE_INVALID', `unsupported archive entry ${entryPath}`)
    }
    const size = entry.header.size
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new ProfileStoreErrorV1('PROFILE_STATE_INVALID', `archive size ${entryPath}`)
    }
    if (!entry.isDirectory && size > PROFILE_ARCHIVE_LIMITS_V1.maxFileBytes) {
      throw new ProfileStoreErrorV1('PROFILE_STATE_INVALID', `archive file budget ${entryPath}`)
    }
    total += size
    if (total > PROFILE_ARCHIVE_LIMITS_V1.maxTotalBytes) {
      throw new ProfileStoreErrorV1('PROFILE_STATE_INVALID', 'archive total budget')
    }
    checked.push({ entry, path: entryPath })
  }
  return checked
}

function entryBytes(entry: CheckedEntryV1): Uint8Array {
  if (!entry.entry.getData) {
    throw new ProfileStoreErrorV1('PROFILE_STATE_INVALID', `unreadable ${entry.path}`)
  }
  const bytes = new Uint8Array(entry.entry.getData())
  if (
    bytes.byteLength !== entry.entry.header.size
    || bytes.byteLength > PROFILE_ARCHIVE_LIMITS_V1.maxFileBytes
  ) throw new ProfileStoreErrorV1('PROFILE_STATE_INVALID', `size mismatch ${entry.path}`)
  return bytes
}

export function readProfileArchiveV1(archive: Uint8Array): ContentPackSourceV1 {
  if (
    !(archive instanceof Uint8Array)
    || archive.byteLength === 0
    || archive.byteLength > PROFILE_ARCHIVE_LIMITS_V1.maxArchiveBytes
    || archive[0] !== 0x50
    || archive[1] !== 0x4b
  ) throw new ProfileStoreErrorV1('PROFILE_STATE_INVALID', 'archive is not a bounded ZIP')
  const zip = new AdmZip(Buffer.from(archive))
  const checked = preflightProfileArchiveEntriesV1(zip.getEntries() as ProfileArchiveEntryV1[])
  const files = checked.filter(entry => !entry.entry.isDirectory)
  const manifests = files.filter(entry => entry.path === 'manifest.json')
  const signatures = files.filter(entry => entry.path === 'signature.json')
  if (files.some(entry => entry.path === 'pack.json')) {
    throw new ProfileStoreErrorV1('PROFILE_STATE_INVALID', 'legacy pack.json is not a v1 Profile')
  }
  if (manifests.length !== 1 || signatures.length > 1) {
    throw new ProfileStoreErrorV1('PROFILE_STATE_INVALID', 'manifest/signature envelope count')
  }
  return {
    manifestBytes: entryBytes(manifests[0]),
    signatureBytes: signatures.length === 0 ? null : entryBytes(signatures[0]),
    entries: files
      .filter(entry => entry.path !== 'manifest.json' && entry.path !== 'signature.json')
      .map(entry => ({ path: entry.path, bytes: entryBytes(entry) })),
  }
}

function policyFor(allowLocalDevUnsigned: boolean): ContentValidationPolicyV1 {
  const expectedCompatibility = {
    engineAbi: PROFILE_ENGINE_ABI_V1,
    contentAbi: PROFILE_CONTENT_ABI_V1,
  }
  if (allowLocalDevUnsigned) {
    return { kind: 'local-dev', expectedCompatibility, allowUnsigned: true }
  }
  return { kind: 'external', expectedCompatibility }
}

function packageRoot(store: ProfileStoreV1, packageHash: string): string {
  return path.join(store.rootDir, 'packages', packageHash)
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index])
}

function assertStoredPackage(
  destination: string,
  packageHash: string,
  source: ContentPackSourceV1,
  policy: ProfileResolutionPackageV1['policy'],
): void {
  let metadata: StoredPackageMetadataV1
  try {
    metadata = JSON.parse(readFileSync(path.join(destination, 'package.json'), 'utf8'))
  } catch {
    throw new ProfileStoreErrorV1('PROFILE_SNAPSHOT_INCOMPLETE', packageHash)
  }
  if (
    metadata.schemaVersion !== 'rvb-stored-package/v1'
    || metadata.packageHash !== packageHash
    || metadata.policy !== policy
  ) throw new ProfileStoreErrorV1('PROFILE_HASH_MISMATCH', packageHash)
  const storedManifest = new Uint8Array(readFileSync(path.join(destination, 'manifest.json')))
  if (!equalBytes(storedManifest, source.manifestBytes)) {
    throw new ProfileStoreErrorV1('PROFILE_HASH_MISMATCH', `${packageHash}/manifest.json`)
  }
  const signaturePath = path.join(destination, 'signature.json')
  const storedSignature = existsSync(signaturePath)
    ? new Uint8Array(readFileSync(signaturePath))
    : null
  if (
    (storedSignature === null) !== (source.signatureBytes === null)
    || (storedSignature && source.signatureBytes && !equalBytes(storedSignature, source.signatureBytes))
  ) throw new ProfileStoreErrorV1('PROFILE_HASH_MISMATCH', `${packageHash}/signature.json`)
  const expectedEntries = [...source.entries]
    .sort((left, right) => left.path.localeCompare(right.path, 'en-US'))
  const storedEntries = walkPayload(path.join(destination, 'payload'))
    .sort((left, right) => left.path.localeCompare(right.path, 'en-US'))
  if (expectedEntries.length !== storedEntries.length) {
    throw new ProfileStoreErrorV1('PROFILE_HASH_MISMATCH', `${packageHash}/payload`)
  }
  for (let index = 0; index < expectedEntries.length; index += 1) {
    if (
      expectedEntries[index].path !== storedEntries[index].path
      || !equalBytes(expectedEntries[index].bytes, storedEntries[index].bytes)
    ) throw new ProfileStoreErrorV1('PROFILE_HASH_MISMATCH', `${packageHash}/${expectedEntries[index].path}`)
  }
}

function persistPackage(
  store: ProfileStoreV1,
  packageHash: string,
  source: ContentPackSourceV1,
  policy: ProfileResolutionPackageV1['policy'],
): void {
  const destination = packageRoot(store, packageHash)
  if (existsSync(destination)) {
    assertStoredPackage(destination, packageHash, source, policy)
    return
  }
  const packagesDir = path.dirname(destination)
  const temporary = path.join(packagesDir, `.${packageHash}.tmp-${randomUUID()}`)
  try {
    mkdirSync(path.join(temporary, 'payload'), { recursive: true })
    writeFileSync(path.join(temporary, 'manifest.json'), source.manifestBytes, { flag: 'wx' })
    if (source.signatureBytes) {
      writeFileSync(path.join(temporary, 'signature.json'), source.signatureBytes, { flag: 'wx' })
    }
    for (const entry of source.entries) {
      const absolute = path.resolve(temporary, 'payload', ...entry.path.split('/'))
      const payloadRoot = path.join(temporary, 'payload')
      if (!absolute.startsWith(`${payloadRoot}${path.sep}`)) {
        throw new ProfileStoreErrorV1('PROFILE_STATE_INVALID', entry.path)
      }
      mkdirSync(path.dirname(absolute), { recursive: true })
      writeFileSync(absolute, entry.bytes, { flag: 'wx' })
    }
    const metadata: StoredPackageMetadataV1 = {
      schemaVersion: 'rvb-stored-package/v1',
      packageHash,
      policy,
    }
    writeFileSync(
      path.join(temporary, 'package.json'),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    )
    mkdirSync(packagesDir, { recursive: true })
    renameSync(temporary, destination)
  } catch (error) {
    if (existsSync(destination)) {
      assertStoredPackage(destination, packageHash, source, policy)
      return
    }
    throw error
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

function walkPayload(root: string, directory = root): Array<{ path: string; bytes: Uint8Array }> {
  const entries: Array<{ path: string; bytes: Uint8Array }> = []
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name)
    if (item.isDirectory()) entries.push(...walkPayload(root, absolute))
    else if (item.isFile()) {
      entries.push({
        path: path.relative(root, absolute).split(path.sep).join('/'),
        bytes: new Uint8Array(readFileSync(absolute)),
      })
    }
  }
  return entries
}

function loadPackage(store: ProfileStoreV1, coordinate: ProfileResolutionPackageV1): ResolvePackInputV1 {
  if (coordinate.policy === 'bundled-base') {
    throw new ProfileStoreErrorV1('PROFILE_STATE_INVALID', 'bundled Base is reconstructed separately')
  }
  const root = packageRoot(store, coordinate.packageHash)
  let metadata: StoredPackageMetadataV1
  try {
    metadata = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  } catch {
    throw new ProfileStoreErrorV1('PROFILE_SNAPSHOT_INCOMPLETE', coordinate.packageHash)
  }
  if (
    metadata.schemaVersion !== 'rvb-stored-package/v1'
    || metadata.packageHash !== coordinate.packageHash
    || metadata.policy !== coordinate.policy
  ) throw new ProfileStoreErrorV1('PROFILE_HASH_MISMATCH', coordinate.packageHash)
  const signaturePath = path.join(root, 'signature.json')
  return {
    source: {
      manifestBytes: new Uint8Array(readFileSync(path.join(root, 'manifest.json'))),
      signatureBytes: existsSync(signaturePath)
        ? new Uint8Array(readFileSync(signaturePath))
        : null,
      entries: walkPayload(path.join(root, 'payload')),
    },
    policy: coordinate.policy === 'local-dev'
      ? {
        kind: 'local-dev',
        expectedCompatibility: {
          engineAbi: PROFILE_ENGINE_ABI_V1,
          contentAbi: PROFILE_CONTENT_ABI_V1,
        },
        allowUnsigned: true,
      }
      : {
        kind: 'external',
        expectedCompatibility: {
          engineAbi: PROFILE_ENGINE_ABI_V1,
          contentAbi: PROFILE_CONTENT_ABI_V1,
        },
      },
  }
}

function readParentResolution(store: ProfileStoreV1, parentHash: string): ProfileResolutionRecordV1 {
  try {
    const value = JSON.parse(readFileSync(path.join(
      store.rootDir,
      'profiles',
      parentHash,
      PROFILE_RESOLUTION_FILE_V1,
    ), 'utf8')) as ProfileResolutionRecordV1
    if (
      value.schemaVersion !== 'rvb-profile-resolution/v1'
      || !value.base
      || !Array.isArray(value.patches)
    ) throw new Error('invalid resolution')
    return value
  } catch {
    throw new ProfileStoreErrorV1('PROFILE_SNAPSHOT_INCOMPLETE', `parent ${parentHash}`)
  }
}

function inputsFromResolution(
  store: ProfileStoreV1,
  appRoot: string,
  resolution: ProfileResolutionRecordV1,
): { base: ResolvePackInputV1; patches: ResolvePackInputV1[] } {
  const base = resolution.base.policy === 'bundled-base'
    ? createBundledBasePackInputV1(appRoot)
    : loadPackage(store, resolution.base)
  return {
    base,
    patches: resolution.patches.map(coordinate => loadPackage(store, coordinate)),
  }
}

export function installProfileArchiveV1(
  options: InstallProfileArchiveOptionsV1,
): InstalledProfileArchiveV1 {
  const source = readProfileArchiveV1(options.archive)
  let manifest: PackManifestV1
  try {
    manifest = PackManifestV1Schema.parse(JSON.parse(new TextDecoder(
      'utf-8',
      { fatal: true },
    ).decode(source.manifestBytes)))
  } catch (error) {
    throw new ProfileStoreErrorV1(
      'PROFILE_STATE_INVALID',
      error instanceof Error ? error.message : String(error),
    )
  }
  const policy = policyFor(options.allowLocalDevUnsigned === true)
  const packageHash = computePackageHashV1(manifest)
  const coordinate: ProfileResolutionPackageV1 = {
    packageHash,
    policy: policy.kind,
  }
  let view: ResolvedSnapshotViewV1
  let resolution: ProfileResolutionRecordV1
  if (manifest.kind === 'snapshot') {
    view = resolveProfileV1({ base: { source, policy } })
    resolution = {
      schemaVersion: 'rvb-profile-resolution/v1',
      base: coordinate,
      patches: [],
    }
  } else {
    const bundled = getBundledBaseProfileV1(options.appRoot)
    const parentResolution = manifest.parentProfileHash === bundled.profile.resolvedProfileHash
      ? {
        schemaVersion: 'rvb-profile-resolution/v1' as const,
        base: {
          packageHash: bundled.profile.base.packageHash,
          policy: 'bundled-base' as const,
        },
        patches: [],
      }
      : readParentResolution(options.store, manifest.parentProfileHash)
    const inputs = inputsFromResolution(options.store, options.appRoot, parentResolution)
    const parent = resolveProfileV1(inputs)
    if (parent.profile.resolvedProfileHash !== manifest.parentProfileHash) {
      throw new ProfileStoreErrorV1('PROFILE_HASH_MISMATCH', manifest.parentProfileHash)
    }
    view = resolveProfileV1({
      base: inputs.base,
      patches: [...inputs.patches, { source, policy }],
    })
    resolution = {
      schemaVersion: 'rvb-profile-resolution/v1',
      base: parentResolution.base,
      patches: [...parentResolution.patches, coordinate],
    }
  }

  persistPackage(options.store, packageHash, source, policy.kind)
  const current = options.store.readState()
  const reference = options.store.installCandidate(view, resolution)
  return {
    reference,
    profile: view.profile,
    reloadMode: classifyProfileReloadV1(current.stable, reference),
  }
}
