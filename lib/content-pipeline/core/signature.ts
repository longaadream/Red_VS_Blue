import { ed25519 } from '@noble/curves/ed25519.js'

import {
  PACK_SIGNATURE_DOMAIN_V1,
  PACK_SIGNATURE_SCHEMA_VERSION_V1,
  PackSignatureEnvelopeV1Schema,
  Sha256HexV1Schema,
} from '@/lib/content-pipeline/contracts'
import type {
  PackSignatureEnvelopeV1,
  Sha256HexV1,
} from '@/lib/content-pipeline/contracts'

import {
  bytesToLowerHexV1,
  decodeLowerHexV1,
  sha256HexV1,
} from './hash'
import { snapshotOrdinaryUint8ArrayV1 } from './source'

const UTF8_ENCODER = new TextEncoder()
const SECRET_KEY_LENGTH = 32
const PUBLIC_KEY_LENGTH = 32
const SIGNATURE_LENGTH = 64

function snapshotExactBytes(
  bytes: unknown,
  length: number,
  label: string,
): Uint8Array {
  const snapshot = snapshotOrdinaryUint8ArrayV1(bytes, length)
  if (!snapshot.ok || snapshot.bytes.byteLength !== length) {
    throw new TypeError(`${label} must be exactly ${length} bytes from an ordinary Uint8Array`)
  }
  return snapshot.bytes
}

export function buildPackageSignatureMessageV1(packageHash: Sha256HexV1): Uint8Array {
  const parsedHash = Sha256HexV1Schema.parse(packageHash)
  const domain = UTF8_ENCODER.encode(PACK_SIGNATURE_DOMAIN_V1)
  const digest = decodeLowerHexV1(parsedHash, 32)
  const message = new Uint8Array(domain.length + digest.length)
  message.set(domain, 0)
  message.set(digest, domain.length)
  return message
}

export function deriveEd25519PublicKeyV1(secretKey: Uint8Array): Uint8Array {
  const privateCopy = snapshotExactBytes(
    secretKey,
    SECRET_KEY_LENGTH,
    'Ed25519 secret key',
  )
  try {
    return new Uint8Array(ed25519.getPublicKey(privateCopy))
  } finally {
    privateCopy.fill(0)
  }
}

export function derivePublisherKeyIdV1(publicKey: Uint8Array): Sha256HexV1 {
  const publicCopy = snapshotExactBytes(
    publicKey,
    PUBLIC_KEY_LENGTH,
    'Ed25519 public key',
  )
  return sha256HexV1(publicCopy)
}

export function signPackageHashV1(
  packageHash: Sha256HexV1,
  secretKey: Uint8Array,
): PackSignatureEnvelopeV1 {
  const privateCopy = snapshotExactBytes(
    secretKey,
    SECRET_KEY_LENGTH,
    'Ed25519 secret key',
  )
  try {
    const parsedHash = Sha256HexV1Schema.parse(packageHash)
    const publicKey = new Uint8Array(ed25519.getPublicKey(privateCopy))
    const signature = new Uint8Array(
      ed25519.sign(buildPackageSignatureMessageV1(parsedHash), privateCopy),
    )

    return PackSignatureEnvelopeV1Schema.parse({
      schemaVersion: PACK_SIGNATURE_SCHEMA_VERSION_V1,
      algorithm: 'Ed25519',
      keyId: derivePublisherKeyIdV1(publicKey),
      publicKey: bytesToLowerHexV1(publicKey),
      packageHash: parsedHash,
      signature: bytesToLowerHexV1(signature),
    })
  } finally {
    privateCopy.fill(0)
  }
}

export type PackageSignatureVerificationFailureReasonV1 =
  | 'envelope-invalid'
  | 'package-hash-mismatch'
  | 'key-id-mismatch'
  | 'publisher-key-id-mismatch'
  | 'signature-invalid'

export type PackageSignatureVerificationResultV1 =
  | { ok: true; keyId: Sha256HexV1 }
  | { ok: false; reason: PackageSignatureVerificationFailureReasonV1 }

export interface VerifyPackageSignatureInputV1 {
  envelope: unknown
  expectedPackageHash: Sha256HexV1
  expectedPublisherKeyId: Sha256HexV1 | null
}

export function verifyPackageSignatureV1(
  input: VerifyPackageSignatureInputV1,
): PackageSignatureVerificationResultV1 {
  if (input === null || typeof input !== 'object') {
    return { ok: false, reason: 'envelope-invalid' }
  }

  let rawEnvelope: unknown
  try {
    rawEnvelope = input.envelope
  } catch {
    return { ok: false, reason: 'envelope-invalid' }
  }

  let envelopeResult: ReturnType<typeof PackSignatureEnvelopeV1Schema.safeParse>
  try {
    envelopeResult = PackSignatureEnvelopeV1Schema.safeParse(rawEnvelope)
  } catch {
    return { ok: false, reason: 'envelope-invalid' }
  }
  if (!envelopeResult.success) return { ok: false, reason: 'envelope-invalid' }

  let expectedPackageHash: unknown
  try {
    expectedPackageHash = input.expectedPackageHash
  } catch {
    return { ok: false, reason: 'package-hash-mismatch' }
  }
  const expectedHashResult = Sha256HexV1Schema.safeParse(expectedPackageHash)
  if (
    !expectedHashResult.success
    || envelopeResult.data.packageHash !== expectedHashResult.data
  ) {
    return { ok: false, reason: 'package-hash-mismatch' }
  }

  const publicKey = decodeLowerHexV1(envelopeResult.data.publicKey, PUBLIC_KEY_LENGTH)
  const derivedKeyId = derivePublisherKeyIdV1(publicKey)
  if (envelopeResult.data.keyId !== derivedKeyId) {
    return { ok: false, reason: 'key-id-mismatch' }
  }

  let expectedPublisherKeyId: unknown
  try {
    expectedPublisherKeyId = input.expectedPublisherKeyId
  } catch {
    return { ok: false, reason: 'publisher-key-id-mismatch' }
  }
  if (expectedPublisherKeyId !== derivedKeyId) {
    return { ok: false, reason: 'publisher-key-id-mismatch' }
  }

  const signature = decodeLowerHexV1(envelopeResult.data.signature, SIGNATURE_LENGTH)
  const message = buildPackageSignatureMessageV1(expectedHashResult.data)
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false })
      ? { ok: true, keyId: derivedKeyId }
      : { ok: false, reason: 'signature-invalid' }
  } catch {
    return { ok: false, reason: 'signature-invalid' }
  }
}
