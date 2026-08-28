import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import type {
  PackCapabilityV1,
  PackFileMediaTypeV1,
  PackManifestV1,
} from '../contracts'
import { compareUnicodeCodePointsV1 } from '../contracts'
import {
  bytesToLowerHexV1,
  computePackageHashV1,
  sha256BytesV1,
  sha256HexV1,
} from '../core/hash'
import {
  resolveProfileV1,
  type ResolvePackInputV1,
  type ResolvedSnapshotViewV1,
} from '../core/resolver'
import { deriveEd25519PublicKeyV1, derivePublisherKeyIdV1, signPackageHashV1 } from '../core/signature'
import type { ContentSourceEntryV1 } from '../core/source'

export const PROFILE_ENGINE_ABI_V1 = 'rvb-engine/v1' as const
export const PROFILE_CONTENT_ABI_V1 = 'rvb-content/v1' as const

const encoder = new TextEncoder()
const BUNDLED_ATTESTATION_LABEL = 'RVB bundled Base attestation v1; not a release signing key'

interface BundledFileV1 extends ContentSourceEntryV1 {
  readonly mediaType: PackFileMediaTypeV1
}

function walkFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(absolute))
    else if (entry.isFile()) files.push(absolute)
  }
  return files
}

function mediaTypeForExtension(extension: string): PackFileMediaTypeV1 | null {
  switch (extension.toLowerCase()) {
    case '.json': return 'application/json'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.png': return 'image/png'
    case '.webp': return 'image/webp'
    default: return null
  }
}

function bundledFiles(appRoot: string): BundledFileV1[] {
  const dataRoot = path.join(appRoot, 'data')
  // Only public/images/** participates in the content-pack namespace. Legacy
  // root-level application art remains a versioned app asset, not pack data.
  const publicRoot = path.join(appRoot, 'public', 'images')
  const files: BundledFileV1[] = []
  for (const absolute of walkFiles(dataRoot)) {
    if (path.extname(absolute).toLowerCase() !== '.json') continue
    const relative = path.relative(dataRoot, absolute).split(path.sep).join('/')
    // ADR-0018 explicitly keeps the pre-v1 browser PVE prototype outside the
    // v1 content identity. Once those files carry rvb-pve-*/v1 schemas, the
    // core validator owns their closed-set validation and they join Base.
    if (relative.startsWith('pve/')) {
      let schemaVersion: unknown
      try {
        schemaVersion = JSON.parse(readFileSync(absolute, 'utf8')).schemaVersion
      } catch {
        schemaVersion = null
      }
      if (typeof schemaVersion !== 'string' || !schemaVersion.startsWith('rvb-pve-')) {
        continue
      }
    }
    files.push({
      path: `data/${relative}`,
      mediaType: 'application/json',
      bytes: new Uint8Array(readFileSync(absolute)),
    })
  }
  if (existsSync(publicRoot)) {
    for (const absolute of walkFiles(publicRoot)) {
      const mediaType = mediaTypeForExtension(path.extname(absolute))
      if (!mediaType || mediaType === 'application/json') continue
      const relative = path.relative(publicRoot, absolute).split(path.sep).join('/')
      files.push({
        path: `images/${relative}`,
        mediaType,
        bytes: new Uint8Array(readFileSync(absolute)),
      })
    }
  }
  return files.sort((left, right) => compareUnicodeCodePointsV1(left.path, right.path))
}

function deriveCapabilities(files: readonly BundledFileV1[]): PackCapabilityV1[] {
  const capabilities = new Set<PackCapabilityV1>()
  if (files.some(file => file.path.startsWith('data/'))) capabilities.add('game-data')
  if (files.some(file => file.path.startsWith('data/pve/'))) capabilities.add('pve-content')
  if (files.some(file => file.path.startsWith('images/'))) capabilities.add('raster-assets')
  if (files.some(file => {
    if (file.mediaType !== 'application/json') return false
    const text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)
    return /"(?:code|skillCode|triggerSkill|previewCode|effectCode)"\s*:/.test(text)
  })) capabilities.add('trusted-executable-content')
  return [...capabilities].sort(compareUnicodeCodePointsV1)
}

export function createBundledBasePackInputV1(appRoot: string): ResolvePackInputV1 {
  const root = path.resolve(appRoot)
  const files = bundledFiles(root)
  const secretKey = sha256BytesV1(encoder.encode(BUNDLED_ATTESTATION_LABEL))
  try {
    const publicKey = deriveEd25519PublicKeyV1(secretKey)
    const keyId = derivePublisherKeyIdV1(publicKey)
    const manifest: PackManifestV1 = {
      schemaVersion: 'rvb-pack/v1',
      packageId: 'rvb.bundled-base',
      version: '1.0.0',
      displayName: 'Bundled Base',
      publisher: { id: 'rvb.application', keyId },
      compatibility: {
        engineAbi: PROFILE_ENGINE_ABI_V1,
        contentAbi: PROFILE_CONTENT_ABI_V1,
      },
      capabilities: deriveCapabilities(files),
      files: files.map(file => ({
        path: file.path,
        mediaType: file.mediaType,
        size: file.bytes.byteLength,
        sha256: sha256HexV1(file.bytes),
      })),
      kind: 'snapshot',
    }
    const packageHash = computePackageHashV1(manifest)
    const envelope = signPackageHashV1(packageHash, secretKey)
    if (envelope.publicKey !== bytesToLowerHexV1(publicKey)) {
      throw new Error('Bundled Base attestation key mismatch')
    }
    return {
      source: {
        manifestBytes: encoder.encode(JSON.stringify(manifest)),
        signatureBytes: encoder.encode(JSON.stringify(envelope)),
        entries: files.map(file => ({ path: file.path, bytes: file.bytes })),
      },
      policy: {
        kind: 'bundled-base',
        expectedCompatibility: manifest.compatibility,
      },
    }
  } finally {
    secretKey.fill(0)
  }
}

export function createBundledBaseProfileV1(appRoot: string): ResolvedSnapshotViewV1 {
  return resolveProfileV1({ base: createBundledBasePackInputV1(appRoot) })
}

declare global {
  var __rvbBundledBaseProfilesV1: Map<string, ResolvedSnapshotViewV1> | undefined
}

export function getBundledBaseProfileV1(appRoot: string): ResolvedSnapshotViewV1 {
  const root = path.resolve(appRoot)
  globalThis.__rvbBundledBaseProfilesV1 ??= new Map()
  const cached = globalThis.__rvbBundledBaseProfilesV1.get(root)
  if (cached) return cached
  const profile = createBundledBaseProfileV1(root)
  globalThis.__rvbBundledBaseProfilesV1.set(root, profile)
  return profile
}
