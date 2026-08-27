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
    ['envelope keyId', (value: PackSignatureEnvelopeV1) => ({ ...value, keyId: mutateHex(value.keyId) }), 'key-id-mismatch'],
    ['public key', (value: PackSignatureEnvelopeV1) => ({ ...value, publicKey: mutateHex(value.publicKey) }), 'key-id-mismatch'],
    ['signature', (value: PackSignatureEnvelopeV1) => ({ ...value, signature: mutateHex(value.signature) }), 'signature-invalid'],
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

  it('uses strict RFC8032 verification and rejects a ZIP215 small-order forgery', () => {
    const publicKey = `01${'00'.repeat(31)}`
    const signature = `01${'00'.repeat(63)}`
    const keyId = sha256HexV1(Uint8Array.from([1, ...Array(31).fill(0)]))

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

  it('rejects secret keys that are not exactly 32 bytes', () => {
    expect(() => deriveEd25519PublicKeyV1(new Uint8Array(31))).toThrow(/32 bytes/)
    expect(() => signPackageHashV1(PACKAGE_HASH, new Uint8Array(33))).toThrow(/32 bytes/)
  })
})
