import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import {
  PackManifestV1Schema,
  PackPatchOperationsV1Schema,
  PackPayloadPathV1Schema,
  compareUnicodeCodePointsV1,
  type JsonValueV1,
  type PackCapabilityV1,
  type PackFileMediaTypeV1,
  type PackManifestV1,
} from '../contracts'
import { canonicalJsonBytesV1 } from '../core/canonical-json'
import { deriveFileCapabilitiesV1, sortCapabilitiesV1 } from '../core/capabilities'
import { computePackageHashV1, sha256HexV1 } from '../core/hash'
import { hasExecutableContentV1, parseStrictJsonBytesV1 } from '../core/json-safety'
import type { ContentPackSourceV1 } from '../core/source'
import {
  validatePackSourceV1,
  type ContentValidationPolicyV1,
  type ValidatedPackV1,
} from '../core/validator'
import type { ResolvedSnapshotViewV1 } from '../core/resolver'
import { readProfileArchiveV1 } from '../runtime/profile-archive'
import { PROFILE_CONTENT_ABI_V1, PROFILE_ENGINE_ABI_V1 } from '../runtime/bundled-base'
import type {
  BuildContentOperationV1,
  ContentToolingChannelV1,
} from './contracts'
import { ContentToolingRefusalErrorV1 } from './contracts'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AdmZip = require('adm-zip')

const EXPECTED_COMPATIBILITY_V1 = Object.freeze({
  engineAbi: PROFILE_ENGINE_ABI_V1,
  contentAbi: PROFILE_CONTENT_ABI_V1,
})

interface ToolingFileV1 {
  readonly path: string
  readonly mediaType: PackFileMediaTypeV1
  readonly bytes: Uint8Array
  readonly jsonValue?: JsonValueV1
  readonly hasExecutableContent: boolean
}

function mediaType(relativePath: string): PackFileMediaTypeV1 {
  const extension = path.extname(relativePath).toLowerCase()
  if (extension === '.json') return 'application/json'
  if (extension === '.png') return 'image/png'
  if (extension === '.svg') return 'image/svg+xml'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  throw new ContentToolingRefusalErrorV1(
    'PACK_PATH_INVALID',
    'source',
    `Unsupported payload path: ${relativePath}`,
  )
}

function walkSource(root: string, directory = root): ToolingFileV1[] {
  const result: ToolingFileV1[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink()) {
      throw new ContentToolingRefusalErrorV1(
        'PACK_PATH_INVALID',
        'source',
        'Symbolic links are not accepted as package input.',
      )
    }
    if (entry.isDirectory()) {
      result.push(...walkSource(root, absolute))
      continue
    }
    if (!entry.isFile()) continue
    const relative = path.relative(root, absolute).split(path.sep).join('/')
    const parsedPath = PackPayloadPathV1Schema.safeParse(relative)
    if (!parsedPath.success) {
      throw new ContentToolingRefusalErrorV1(
        'PACK_PATH_INVALID',
        'source',
        `Unsupported payload path: ${relative}`,
      )
    }
    const bytes = new Uint8Array(readFileSync(absolute))
    const type = mediaType(relative)
    let jsonValue: JsonValueV1 | undefined
    let hasExecutableContent = false
    if (type === 'application/json') {
      jsonValue = parseStrictJsonBytesV1(bytes)
      hasExecutableContent = hasExecutableContentV1(jsonValue)
    }
    result.push({
      path: parsedPath.data,
      mediaType: type,
      bytes,
      jsonValue,
      hasExecutableContent,
    })
  }
  return result.sort((left, right) => compareUnicodeCodePointsV1(left.path, right.path))
}

function deriveCapabilities(files: readonly ToolingFileV1[]): readonly PackCapabilityV1[] {
  const capabilities = new Set<PackCapabilityV1>()
  for (const file of files) {
    for (const capability of deriveFileCapabilitiesV1(file)) capabilities.add(capability)
  }
  return sortCapabilitiesV1(capabilities)
}

export function contentPolicyForChannelV1(
  channel: ContentToolingChannelV1,
): ContentValidationPolicyV1 {
  if (channel === 'local-dev') {
    return {
      kind: 'local-dev',
      expectedCompatibility: EXPECTED_COMPATIBILITY_V1,
      allowUnsigned: true,
    }
  }
  return { kind: 'external', expectedCompatibility: EXPECTED_COMPATIBILITY_V1 }
}

export function buildPackSourceV1(request: BuildContentOperationV1): ContentPackSourceV1 {
  const sourceRoot = path.resolve(request.sourceDir)
  const sourceStat = lstatSync(sourceRoot)
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new ContentToolingRefusalErrorV1(
      'PACK_PATH_INVALID',
      'source',
      'Package source must be an ordinary directory.',
    )
  }
  const files = walkSource(sourceRoot)
  const common = {
    schemaVersion: 'rvb-pack/v1' as const,
    packageId: request.packageId,
    version: request.version,
    displayName: request.displayName,
    ...(request.description ? { description: request.description } : {}),
    publisher: { id: request.publisherId, keyId: null },
    compatibility: EXPECTED_COMPATIBILITY_V1,
    capabilities: request.capabilities ?? deriveCapabilities(files),
    files: files.map(file => ({
      path: file.path,
      mediaType: file.mediaType,
      size: file.bytes.byteLength,
      sha256: sha256HexV1(file.bytes),
    })),
  }
  const manifest = request.mode === 'snapshot'
    ? PackManifestV1Schema.parse({ ...common, kind: 'snapshot' })
    : PackManifestV1Schema.parse({
      ...common,
      kind: 'patch',
      parentProfileHash: request.parentProfileHash,
      operations: PackPatchOperationsV1Schema.parse(request.operations),
    })
  return {
    manifestBytes: canonicalJsonBytesV1(manifest),
    signatureBytes: null,
    entries: files.map(file => ({ path: file.path, bytes: file.bytes })),
  }
}

export function readArchiveFileV1(archivePath: string): ContentPackSourceV1 {
  return readProfileArchiveV1(new Uint8Array(readFileSync(path.resolve(archivePath))))
}

export function parseArchiveManifestV1(source: ContentPackSourceV1): PackManifestV1 {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(source.manifestBytes)
  return PackManifestV1Schema.parse(JSON.parse(text))
}

export function writeArchiveFileV1(
  archivePath: string,
  source: ContentPackSourceV1,
  compressionLevel = 6,
): void {
  if (!Number.isInteger(compressionLevel) || compressionLevel < 0 || compressionLevel > 9) {
    throw new ContentToolingRefusalErrorV1(
      'TOOLING_INVALID_ARGUMENT',
      'source',
      'Compression level must be an integer from 0 through 9.',
      2,
    )
  }
  const destination = path.resolve(archivePath)
  mkdirSync(path.dirname(destination), { recursive: true })
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  )
  try {
    const zip = new AdmZip()
    zip.addFile('manifest.json', Buffer.from(source.manifestBytes))
    if (source.signatureBytes) zip.addFile('signature.json', Buffer.from(source.signatureBytes))
    for (const entry of [...source.entries].sort((left, right) =>
      compareUnicodeCodePointsV1(left.path, right.path))) {
      zip.addFile(entry.path, Buffer.from(entry.bytes))
    }
    if (compressionLevel === 0) {
      for (const entry of zip.getEntries()) entry.header.method = 0
    }
    zip.writeZip(temporary)
    rmSync(destination, { force: true })
    renameSync(temporary, destination)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function validateArchiveSourceV1(
  source: ContentPackSourceV1,
  channel: ContentToolingChannelV1,
  context?: Readonly<{ parent: ResolvedSnapshotViewV1 }>,
): ValidatedPackV1 {
  return validatePackSourceV1(
    source,
    contentPolicyForChannelV1(channel),
    context,
  )
}

export function packageHashOfSourceV1(source: ContentPackSourceV1): string {
  return computePackageHashV1(parseArchiveManifestV1(source))
}
