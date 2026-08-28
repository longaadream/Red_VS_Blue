import { runInNewContext } from 'node:vm'

import { ed25519 as nobleEd25519 } from '@noble/curves/ed25519.js'
import * as legacyEd25519 from '@noble/ed25519'
import { describe, expect, it } from 'vitest'

import type { PackSignatureEnvelopeV1 } from '@/lib/content-pipeline/contracts'
import {
  bytesToLowerHexV1,
  decodeLowerHexV1,
  sha256HexV1,
} from '@/lib/content-pipeline/core/hash'
import {
  buildPackageSignatureMessageV1,
  deriveEd25519PublicKeyV1,
  derivePublisherKeyIdV1,
  signPackageHashV1,
  verifyPackageSignatureV1,
} from '@/lib/content-pipeline/core/signature'

const TEST_SECRET_KEY = decodeLowerHexV1(
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  32,
)
const PUBLIC_KEY = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
const KEY_ID = '21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9'
const PACKAGE_HASH = 'c5f7186b749342aba2fce56d5ab4583bb25c2071b1d45c7d5562a483e8c63152'
const SIGNATURE =
  '76f61627660c6c15b9cdfcdd31696bcbcd22882dc25db028897093d1d1566d7b'
  + '7d80a1109f186cf0735e3525222cc9a16685aa226646caf94305874508b99502'
const ED25519_IDENTITY = `01${'00'.repeat(31)}`
const NON_CANONICAL_IDENTITY = `ee${'ff'.repeat(30)}7f`
const ZERO_SCALAR = '00'.repeat(32)
const ED25519_GROUP_ORDER =
  'edd3f55c1a631258d69cf7a2def9de14'
  + '00000000000000000000000000000010'

function mutateHex(hex: string): string {
  return `${hex[0] === '0' ? '1' : '0'}${hex.slice(1)}`
}

describe('Content Pipeline v1 detached Ed25519 signatures', () => {
  it('matches the public deterministic key, keyId, message, and signature vector', () => {
    const publicKey = deriveEd25519PublicKeyV1(TEST_SECRET_KEY)
    const envelope = signPackageHashV1(PACKAGE_HASH, TEST_SECRET_KEY)

    expect(bytesToLowerHexV1(publicKey)).toBe(PUBLIC_KEY)
    expect(derivePublisherKeyIdV1(publicKey)).toBe(KEY_ID)
    expect(bytesToLowerHexV1(buildPackageSignatureMessageV1(PACKAGE_HASH))).toBe(
      '5256425f5041434b5f5349474e41545552455f563100'
      + PACKAGE_HASH,
    )
    expect(envelope).toEqual({
      schemaVersion: 'rvb-pack-signature/v1',
      algorithm: 'Ed25519',
      keyId: KEY_ID,
      publicKey: PUBLIC_KEY,
      packageHash: PACKAGE_HASH,
      signature: SIGNATURE,
    })
  })

  it('verifies a valid envelope only for the expected manifest publisher and package hash', () => {
    const envelope = signPackageHashV1(PACKAGE_HASH, TEST_SECRET_KEY)

    expect(verifyPackageSignatureV1({
      envelope,
      expectedPackageHash: PACKAGE_HASH,
      expectedPublisherKeyId: KEY_ID,
    })).toEqual({ ok: true, keyId: KEY_ID })
    expect(verifyPackageSignatureV1({
      envelope,
      expectedPackageHash: '0'.repeat(64),
      expectedPublisherKeyId: KEY_ID,
    })).toEqual({ ok: false, reason: 'package-hash-mismatch' })
    expect(verifyPackageSignatureV1({
      envelope,
      expectedPackageHash: PACKAGE_HASH,
      expectedPublisherKeyId: null,
    })).toEqual({ ok: false, reason: 'publisher-key-id-mismatch' })
  })

  it.each([
    [
      'schema version',
      (value: PackSignatureEnvelopeV1) => ({
        ...value,
        schemaVersion: 'rvb-pack-signature/v2',
      }),
      'envelope-invalid',
    ],
    [
      'algorithm',
      (value: PackSignatureEnvelopeV1) => ({ ...value, algorithm: 'Ed448' }),
      'envelope-invalid',
    ],
    [
      'envelope keyId',
      (value: PackSignatureEnvelopeV1) => ({
        ...value,
        keyId: mutateHex(value.keyId),
      }),
      'key-id-mismatch',
    ],
    [
      'public key',
      (value: PackSignatureEnvelopeV1) => ({
        ...value,
        publicKey: mutateHex(value.publicKey),
      }),
      'key-id-mismatch',
    ],
    [
      'package hash',
      (value: PackSignatureEnvelopeV1) => ({
        ...value,
        packageHash: mutateHex(value.packageHash),
      }),
      'package-hash-mismatch',
    ],
    [
      'signature',
      (value: PackSignatureEnvelopeV1) => ({
        ...value,
        signature: mutateHex(value.signature),
      }),
      'signature-invalid',
    ],
  ] as const)('rejects tampering with %s', (_label, mutate, reason) => {
    const envelope = signPackageHashV1(PACKAGE_HASH, TEST_SECRET_KEY)

    expect(verifyPackageSignatureV1({
      envelope: mutate(envelope),
      expectedPackageHash: PACKAGE_HASH,
      expectedPublisherKeyId: KEY_ID,
    })).toEqual({ ok: false, reason })
  })

  it('rejects malformed envelopes before cryptographic verification', () => {
    const envelope = signPackageHashV1(PACKAGE_HASH, TEST_SECRET_KEY)

    expect(verifyPackageSignatureV1({
      envelope: { ...envelope, publicKey: envelope.publicKey.toUpperCase() },
      expectedPackageHash: PACKAGE_HASH,
      expectedPublisherKeyId: KEY_ID,
    })).toEqual({ ok: false, reason: 'envelope-invalid' })
  })

  it('does not configure or depend on the legacy shared SHA-512 hook', () => {
    expect(legacyEd25519.hashes.sha512).toBeUndefined()

    const envelope = signPackageHashV1(PACKAGE_HASH, TEST_SECRET_KEY)
    expect(envelope.signature).toBe(SIGNATURE)
    expect(legacyEd25519.hashes.sha512).toBeUndefined()

    const originalLegacySha512 = legacyEd25519.hashes.sha512
    const maliciousLegacySha512 = () => new Uint8Array(64)
    try {
      legacyEd25519.hashes.sha512 = maliciousLegacySha512

      const isolatedEnvelope = signPackageHashV1(PACKAGE_HASH, TEST_SECRET_KEY)
      expect(isolatedEnvelope.signature).toBe(SIGNATURE)
      expect(verifyPackageSignatureV1({
        envelope: isolatedEnvelope,
        expectedPackageHash: PACKAGE_HASH,
        expectedPublisherKeyId: KEY_ID,
      })).toEqual({ ok: true, keyId: KEY_ID })
      expect(legacyEd25519.hashes.sha512).toBe(maliciousLegacySha512)
    } finally {
      legacyEd25519.hashes.sha512 = originalLegacySha512
    }
  })

  it('uses strict RFC8032 verification and rejects a ZIP215 small-order forgery', () => {
    const publicKey = ED25519_IDENTITY
    const signature = `${ED25519_IDENTITY}${ZERO_SCALAR}`
    const keyId = sha256HexV1(decodeLowerHexV1(publicKey, 32))

    expect(verifyPackageSignatureV1({
      envelope: {
        schemaVersion: 'rvb-pack-signature/v1',
        algorithm: 'Ed25519',
        keyId,
        publicKey,
        packageHash: PACKAGE_HASH,
        signature,
      },
      expectedPackageHash: PACKAGE_HASH,
      expectedPublisherKeyId: keyId,
    })).toEqual({ ok: false, reason: 'signature-invalid' })
  })

  it.each([
    [
      'public key A',
      NON_CANONICAL_IDENTITY,
      `${ED25519_IDENTITY}${ZERO_SCALAR}`,
    ],
    [
      'signature point R',
      ED25519_IDENTITY,
      `${NON_CANONICAL_IDENTITY}${ZERO_SCALAR}`,
    ],
  ])('rejects a ZIP215-only non-canonical %s encoding', (
    _label,
    publicKey,
    signature,
  ) => {
    const publicKeyBytes = decodeLowerHexV1(publicKey, 32)
    const signatureBytes = decodeLowerHexV1(signature, 64)
    const message = buildPackageSignatureMessageV1(PACKAGE_HASH)
    const keyId = sha256HexV1(publicKeyBytes)

    expect(nobleEd25519.verify(
      signatureBytes,
      message,
      publicKeyBytes,
      { zip215: true },
    )).toBe(true)
    expect(verifyPackageSignatureV1({
      envelope: {
        schemaVersion: 'rvb-pack-signature/v1',
        algorithm: 'Ed25519',
        keyId,
        publicKey,
        packageHash: PACKAGE_HASH,
        signature,
      },
      expectedPackageHash: PACKAGE_HASH,
      expectedPublisherKeyId: keyId,
    })).toEqual({ ok: false, reason: 'signature-invalid' })
  })

  it('rejects a signature whose S scalar is outside the Ed25519 group order', () => {
    const signature = `${SIGNATURE.slice(0, 64)}${ED25519_GROUP_ORDER}`

    expect(verifyPackageSignatureV1({
      envelope: {
        schemaVersion: 'rvb-pack-signature/v1',
        algorithm: 'Ed25519',
        keyId: KEY_ID,
        publicKey: PUBLIC_KEY,
        packageHash: PACKAGE_HASH,
        signature,
      },
      expectedPackageHash: PACKAGE_HASH,
      expectedPublisherKeyId: KEY_ID,
    })).toEqual({ ok: false, reason: 'signature-invalid' })
  })

  it('rejects secret keys that are not exactly 32 bytes', () => {
    expect(() => deriveEd25519PublicKeyV1(new Uint8Array(31))).toThrow(/32 bytes/)
    expect(() => signPackageHashV1(PACKAGE_HASH, new Uint8Array(33))).toThrow(/32 bytes/)
  })

  it('accepts cross-realm ordinary bytes and ignores typed-array subclass traps', () => {
    const foreignSecret = runInNewContext(
      'Uint8Array.from(values)',
      { values: Array.from(TEST_SECRET_KEY) },
    ) as Uint8Array
    const hostileSecret = new Uint8Array(TEST_SECRET_KEY)
    let sliceCalls = 0
    let iteratorCalls = 0
    Object.defineProperty(hostileSecret, 'slice', {
      value() {
        sliceCalls += 1
        throw new Error('slice trap must not run')
      },
    })
    Object.defineProperty(hostileSecret, Symbol.iterator, {
      value() {
        iteratorCalls += 1
        throw new Error('iterator trap must not run')
      },
    })

    expect(bytesToLowerHexV1(foreignSecret)).toBe(bytesToLowerHexV1(TEST_SECRET_KEY))
    expect(sha256HexV1(foreignSecret)).toBe(sha256HexV1(TEST_SECRET_KEY))
    expect(bytesToLowerHexV1(deriveEd25519PublicKeyV1(foreignSecret))).toBe(PUBLIC_KEY)
    expect(signPackageHashV1(PACKAGE_HASH, foreignSecret).signature).toBe(SIGNATURE)
    expect(bytesToLowerHexV1(hostileSecret)).toBe(bytesToLowerHexV1(TEST_SECRET_KEY))
    expect(signPackageHashV1(PACKAGE_HASH, hostileSecret).signature).toBe(SIGNATURE)
    expect({ sliceCalls, iteratorCalls }).toEqual({ sliceCalls: 0, iteratorCalls: 0 })
  })

  it('rejects proxied and SharedArrayBuffer-backed byte inputs', () => {
    const proxied = new Proxy(TEST_SECRET_KEY, {})
    const shared = new Uint8Array(new SharedArrayBuffer(TEST_SECRET_KEY.byteLength))
    shared.set(TEST_SECRET_KEY)

    for (const bytes of [proxied, shared]) {
      expect(() => bytesToLowerHexV1(bytes)).toThrow(TypeError)
      expect(() => sha256HexV1(bytes)).toThrow(TypeError)
      expect(() => deriveEd25519PublicKeyV1(bytes)).toThrow(TypeError)
      expect(() => signPackageHashV1(PACKAGE_HASH, bytes)).toThrow(TypeError)
    }
  })

  it('maps hostile verification input getters to the existing failure union', () => {
    const envelope = signPackageHashV1(PACKAGE_HASH, TEST_SECRET_KEY)
    const poison = () => {
      throw new Error('sensitive getter details')
    }

    expect(verifyPackageSignatureV1({
      get envelope(): PackSignatureEnvelopeV1 {
        return poison()
      },
      expectedPackageHash: PACKAGE_HASH,
      expectedPublisherKeyId: KEY_ID,
    })).toEqual({ ok: false, reason: 'envelope-invalid' })
    expect(verifyPackageSignatureV1({
      envelope,
      get expectedPackageHash(): typeof PACKAGE_HASH {
        return poison()
      },
      expectedPublisherKeyId: KEY_ID,
    })).toEqual({ ok: false, reason: 'package-hash-mismatch' })
    expect(verifyPackageSignatureV1({
      envelope,
      expectedPackageHash: PACKAGE_HASH,
      get expectedPublisherKeyId(): typeof KEY_ID {
        return poison()
      },
    })).toEqual({ ok: false, reason: 'publisher-key-id-mismatch' })
    expect(verifyPackageSignatureV1({
      envelope: new Proxy(envelope, {
        get() {
          return poison()
        },
      }),
      expectedPackageHash: PACKAGE_HASH,
      expectedPublisherKeyId: KEY_ID,
    })).toEqual({ ok: false, reason: 'envelope-invalid' })
  })
})
