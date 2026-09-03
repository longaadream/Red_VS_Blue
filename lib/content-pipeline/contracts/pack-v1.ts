import { z } from 'zod'

import {
  AbiVersionV1Schema,
  compareUnicodeCodePointsV1,
  ContentIdV1Schema,
  PosixRelativePathV1Schema,
  SemVerV1Schema,
  Sha256HexV1Schema,
  UnicodeScalarStringV1Schema,
} from './primitives-v1'

export const PACK_MANIFEST_SCHEMA_VERSION_V1 = 'rvb-pack/v1' as const
export const PACK_SIGNATURE_SCHEMA_VERSION_V1 = 'rvb-pack-signature/v1' as const

// These are byte-for-byte UTF-8 domain separators. Hashing and signing are
// intentionally implemented by the stage-2 consumer, not by this contract.
export const PACK_IDENTITY_DOMAIN_V1 = 'RVB_PACK_IDENTITY_V1\0' as const
export const PACK_SIGNATURE_DOMAIN_V1 = 'RVB_PACK_SIGNATURE_V1\0' as const

const DisplayNameV1Schema = UnicodeScalarStringV1Schema.pipe(
  z.string()
    .min(1)
    .max(100)
    .refine(value => value.trim() === value, 'Display name must not have surrounding whitespace'),
)

export const PackCapabilityV1Schema = z.enum([
  'game-data',
  'pve-content',
  'raster-assets',
  'trusted-executable-content',
])

export type PackCapabilityV1 = z.infer<typeof PackCapabilityV1Schema>

export const PackCapabilitiesV1Schema = z.array(PackCapabilityV1Schema)
  .max(PackCapabilityV1Schema.options.length)
  .superRefine((capabilities, context) => {
    for (let index = 1; index < capabilities.length; index += 1) {
      const previous = capabilities[index - 1]
      const current = capabilities[index]
      if (previous === current) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate capability: ${current}`,
          path: [index],
        })
      } else if (compareUnicodeCodePointsV1(previous, current) > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Capabilities must be in ascending Unicode code point order',
          path: [index],
        })
      }
    }
  })

export type PackCapabilitiesV1 = z.infer<typeof PackCapabilitiesV1Schema>

export const PackPublisherV1Schema = z.object({
  id: ContentIdV1Schema,
  keyId: Sha256HexV1Schema.nullable(),
}).strict()

export type PackPublisherV1 = z.infer<typeof PackPublisherV1Schema>

export const PackCompatibilityV1Schema = z.object({
  engineAbi: AbiVersionV1Schema,
  contentAbi: AbiVersionV1Schema,
}).strict()

export type PackCompatibilityV1 = z.infer<typeof PackCompatibilityV1Schema>

export const PackFileMediaTypeV1Schema = z.enum([
  'application/json',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
])

export type PackFileMediaTypeV1 = z.infer<typeof PackFileMediaTypeV1Schema>

export const PackJsonPayloadPathV1Schema = PosixRelativePathV1Schema.refine(
  path => /^data\/(?:[^/]+\/)*[^/]+\.json$/.test(path),
  'JSON payload path must match data/**/*.json',
)

export type PackJsonPayloadPathV1 = z.infer<typeof PackJsonPayloadPathV1Schema>

function expectedMediaType(path: string): PackFileMediaTypeV1 | null {
  if (PackJsonPayloadPathV1Schema.safeParse(path).success) return 'application/json'
  if (/^images\/(?:[^/]+\/)*[^/]+\.(?:jpg|jpeg)$/.test(path)) return 'image/jpeg'
  if (/^images\/(?:[^/]+\/)*[^/]+\.png$/.test(path)) return 'image/png'
  if (/^images\/(?:[^/]+\/)*[^/]+\.svg$/.test(path)) return 'image/svg+xml'
  if (/^images\/(?:[^/]+\/)*[^/]+\.webp$/.test(path)) return 'image/webp'
  return null
}

export const PackPayloadPathV1Schema = PosixRelativePathV1Schema.superRefine((path, context) => {
  if (expectedMediaType(path) === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Payload path must be data/**/*.json or images/**/*.{jpg,jpeg,png,svg,webp}',
    })
  }
})

export type PackPayloadPathV1 = z.infer<typeof PackPayloadPathV1Schema>

export const PackFileDescriptorV1Schema = z.object({
  path: PackPayloadPathV1Schema,
  mediaType: PackFileMediaTypeV1Schema,
  size: z.number().int().positive().safe(),
  sha256: Sha256HexV1Schema,
}).strict().superRefine((file, context) => {
  const expected = expectedMediaType(file.path)
  if (expected !== null && file.mediaType !== expected) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `mediaType must be ${expected} for ${file.path}`,
      path: ['mediaType'],
    })
  }
})

export type PackFileDescriptorV1 = z.infer<typeof PackFileDescriptorV1Schema>

export const PackFileInventoryV1Schema = z.array(PackFileDescriptorV1Schema)
  .max(2048)
  .superRefine((files, context) => {
    for (let index = 1; index < files.length; index += 1) {
      const previous = files[index - 1].path
      const current = files[index].path
      if (previous === current) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate file path: ${current}`,
          path: [index, 'path'],
        })
      } else if (compareUnicodeCodePointsV1(previous, current) > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Files must be in ascending Unicode code point path order',
          path: [index, 'path'],
        })
      }
    }
  })

export type PackFileInventoryV1 = z.infer<typeof PackFileInventoryV1Schema>

export const PackPatchAddOperationV1Schema = z.object({
  op: z.literal('add'),
  targetPath: PackPayloadPathV1Schema,
  sourcePath: PackPayloadPathV1Schema,
}).strict()

export const PackPatchReplaceOperationV1Schema = z.object({
  op: z.literal('replace'),
  targetPath: PackPayloadPathV1Schema,
  sourcePath: PackPayloadPathV1Schema,
  expectedHash: Sha256HexV1Schema,
}).strict()

export const PackPatchRemoveOperationV1Schema = z.object({
  op: z.literal('remove'),
  targetPath: PackPayloadPathV1Schema,
  expectedHash: Sha256HexV1Schema,
}).strict()

export const PackPatchOperationV1Schema = z.discriminatedUnion('op', [
  PackPatchAddOperationV1Schema,
  PackPatchReplaceOperationV1Schema,
  PackPatchRemoveOperationV1Schema,
])

export type PackPatchOperationV1 = z.infer<typeof PackPatchOperationV1Schema>

export const PackPatchOperationsV1Schema = z.array(PackPatchOperationV1Schema)
  .min(1)
  .max(2048)
  .superRefine((operations, context) => {
    for (let index = 1; index < operations.length; index += 1) {
      const previous = operations[index - 1].targetPath
      const current = operations[index].targetPath
      if (previous === current) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate patch target: ${current}`,
          path: [index, 'targetPath'],
        })
      } else if (compareUnicodeCodePointsV1(previous, current) > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Patch operations must be in ascending Unicode code point targetPath order',
          path: [index, 'targetPath'],
        })
      }
    }
  })

export type PackPatchOperationsV1 = z.infer<typeof PackPatchOperationsV1Schema>

const PackManifestCommonV1Shape = {
  schemaVersion: z.literal(PACK_MANIFEST_SCHEMA_VERSION_V1),
  packageId: ContentIdV1Schema,
  version: SemVerV1Schema,
  displayName: DisplayNameV1Schema,
  description: UnicodeScalarStringV1Schema.pipe(z.string().max(1000)).optional(),
  publisher: PackPublisherV1Schema,
  compatibility: PackCompatibilityV1Schema,
  capabilities: PackCapabilitiesV1Schema,
  files: PackFileInventoryV1Schema,
}

export const SnapshotPackManifestV1Schema = z.object({
  ...PackManifestCommonV1Shape,
  kind: z.literal('snapshot'),
}).strict()

export type SnapshotPackManifestV1 = z.infer<typeof SnapshotPackManifestV1Schema>

export const PatchPackManifestV1Schema = z.object({
  ...PackManifestCommonV1Shape,
  kind: z.literal('patch'),
  parentProfileHash: Sha256HexV1Schema,
  operations: PackPatchOperationsV1Schema,
}).strict()

export type PatchPackManifestV1 = z.infer<typeof PatchPackManifestV1Schema>

export const PackManifestV1Schema = z.discriminatedUnion('kind', [
  SnapshotPackManifestV1Schema,
  PatchPackManifestV1Schema,
])

export type PackManifestV1 = z.infer<typeof PackManifestV1Schema>

// v1 hashes the entire strict parsed manifest. The alias makes that identity
// projection explicit without performing canonicalization or hashing here.
export const PackIdentityV1Schema = PackManifestV1Schema
export type PackIdentityV1 = PackManifestV1

export const Ed25519PublicKeyHexV1Schema = z.string()
  .regex(/^[0-9a-f]{64}$/, 'Ed25519 public key must be 32 bytes encoded as lowercase hex')

export type Ed25519PublicKeyHexV1 = z.infer<typeof Ed25519PublicKeyHexV1Schema>

export const Ed25519SignatureHexV1Schema = z.string()
  .regex(/^[0-9a-f]{128}$/, 'Ed25519 signature must be 64 bytes encoded as lowercase hex')

export type Ed25519SignatureHexV1 = z.infer<typeof Ed25519SignatureHexV1Schema>

export const PackSignatureEnvelopeV1Schema = z.object({
  schemaVersion: z.literal(PACK_SIGNATURE_SCHEMA_VERSION_V1),
  algorithm: z.literal('Ed25519'),
  keyId: Sha256HexV1Schema,
  publicKey: Ed25519PublicKeyHexV1Schema,
  packageHash: Sha256HexV1Schema,
  signature: Ed25519SignatureHexV1Schema,
}).strict()

export type PackSignatureEnvelopeV1 = z.infer<typeof PackSignatureEnvelopeV1Schema>
