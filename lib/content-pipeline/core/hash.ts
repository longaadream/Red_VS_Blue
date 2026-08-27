import { sha256 } from '@noble/hashes/sha2.js'

import {
  AUTHORITY_CONTENT_IDENTITY_DOMAIN_V1,
  AUTHORITY_CONTENT_SCHEMA_VERSION_V1,
  AuthorityContentIdentityV1Schema,
  PACK_IDENTITY_DOMAIN_V1,
  PROFILE_IDENTITY_DOMAIN_V1,
  PackIdentityV1Schema,
  ResolvedProfileIdentityV1Schema,
} from '@/lib/content-pipeline/contracts'
import type {
  AuthorityContentCapabilityV1,
  AuthorityContentIdentityV1,
  PackManifestV1,
  ResolvedProfileIdentityV1,
  Sha256HexV1,
} from '@/lib/content-pipeline/contracts'

import { canonicalJsonBytesV1 } from './canonical-json'

const UTF8_ENCODER = new TextEncoder()
const LOWER_HEX_PATTERN = /^[0-9a-f]+$/
const HEX_DIGITS = '0123456789abcdef'
const AUTHORITY_CAPABILITIES = new Set<AuthorityContentCapabilityV1>([
  'game-data',
  'pve-content',
  'trusted-executable-content',
])

function assertBytes(value: Uint8Array): void {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError('Expected Uint8Array bytes')
  }
}

export function bytesToLowerHexV1(bytes: Uint8Array): string {
  assertBytes(bytes)
  let result = ''
  for (const byte of bytes) {
    result += HEX_DIGITS[byte >>> 4] + HEX_DIGITS[byte & 0x0f]
  }
  return result
}

export function decodeLowerHexV1(hex: string, expectedByteLength?: number): Uint8Array {
  if (
    typeof hex !== 'string'
    || hex.length % 2 !== 0
    || (hex.length > 0 && !LOWER_HEX_PATTERN.test(hex))
  ) {
    throw new TypeError('Hex input must contain an even number of lowercase hexadecimal characters')
  }
  if (expectedByteLength !== undefined && hex.length !== expectedByteLength * 2) {
    throw new TypeError(`Hex input must encode exactly ${expectedByteLength} bytes`)
  }

  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

export function sha256BytesV1(bytes: Uint8Array): Uint8Array {
  assertBytes(bytes)
  return new Uint8Array(sha256(bytes))
}

export function sha256HexV1(bytes: Uint8Array): Sha256HexV1 {
  return bytesToLowerHexV1(sha256BytesV1(bytes))
}

function hashCanonicalIdentityV1(domain: string, identity: unknown): Sha256HexV1 {
  const domainBytes = UTF8_ENCODER.encode(domain)
  const canonicalBytes = canonicalJsonBytesV1(identity)
  const message = new Uint8Array(domainBytes.length + canonicalBytes.length)
  message.set(domainBytes, 0)
  message.set(canonicalBytes, domainBytes.length)
  return sha256HexV1(message)
}

export function computePackageHashV1(manifest: PackManifestV1): Sha256HexV1 {
  const identity = PackIdentityV1Schema.parse(manifest)
  return hashCanonicalIdentityV1(PACK_IDENTITY_DOMAIN_V1, identity)
}

export function computeResolvedProfileHashV1(
  identity: ResolvedProfileIdentityV1,
): Sha256HexV1 {
  const parsedIdentity = ResolvedProfileIdentityV1Schema.parse(identity)
  return hashCanonicalIdentityV1(PROFILE_IDENTITY_DOMAIN_V1, parsedIdentity)
}

export function projectAuthorityContentIdentityV1(
  identity: ResolvedProfileIdentityV1,
): AuthorityContentIdentityV1 {
  const parsedIdentity = ResolvedProfileIdentityV1Schema.parse(identity)
  const projection: AuthorityContentIdentityV1 = {
    schemaVersion: AUTHORITY_CONTENT_SCHEMA_VERSION_V1,
    compatibility: {
      engineAbi: parsedIdentity.compatibility.engineAbi,
      contentAbi: parsedIdentity.compatibility.contentAbi,
    },
    capabilities: parsedIdentity.capabilities.filter(
      (capability): capability is AuthorityContentCapabilityV1 =>
        AUTHORITY_CAPABILITIES.has(capability as AuthorityContentCapabilityV1),
    ),
    files: parsedIdentity.files
      .filter(file => file.descriptor.mediaType === 'application/json')
      .map(file => ({
        path: file.descriptor.path,
        mediaType: 'application/json' as const,
        size: file.descriptor.size,
        sha256: file.descriptor.sha256,
      })),
  }

  return AuthorityContentIdentityV1Schema.parse(projection)
}

export function computeAuthorityContentHashV1(
  identity: AuthorityContentIdentityV1,
): Sha256HexV1 {
  const parsedIdentity = AuthorityContentIdentityV1Schema.parse(identity)
  return hashCanonicalIdentityV1(AUTHORITY_CONTENT_IDENTITY_DOMAIN_V1, parsedIdentity)
}

export interface ResolvedProfileIdentitiesV1 {
  authorityContentIdentity: AuthorityContentIdentityV1
  resolvedProfileHash: Sha256HexV1
  authorityContentHash: Sha256HexV1
}

export function computeResolvedProfileIdentitiesV1(
  identity: ResolvedProfileIdentityV1,
): ResolvedProfileIdentitiesV1 {
  const parsedIdentity = ResolvedProfileIdentityV1Schema.parse(identity)
  const authorityContentIdentity = projectAuthorityContentIdentityV1(parsedIdentity)

  return {
    authorityContentIdentity,
    resolvedProfileHash: computeResolvedProfileHashV1(parsedIdentity),
    authorityContentHash: computeAuthorityContentHashV1(authorityContentIdentity),
  }
}
