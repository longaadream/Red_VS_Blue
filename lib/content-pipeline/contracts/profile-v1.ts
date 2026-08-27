import { z } from 'zod'

import {
  PackCapabilitiesV1Schema,
  PackCompatibilityV1Schema,
  PackFileDescriptorV1Schema,
  PackPayloadPathV1Schema,
} from './pack-v1'
import {
  compareUnicodeCodePointsV1,
  ContentIdV1Schema,
  SemVerV1Schema,
  Sha256HexV1Schema,
} from './primitives-v1'

export const RESOLVED_PROFILE_SCHEMA_VERSION_V1 = 'rvb-profile/v1' as const

// This is the byte-for-byte UTF-8 domain separator consumed by the stage-2
// canonical hash implementation.
export const PROFILE_IDENTITY_DOMAIN_V1 = 'RVB_PROFILE_IDENTITY_V1\0' as const

export const ResolvedPackageCoordinateV1Schema = z.object({
  packageId: ContentIdV1Schema,
  version: SemVerV1Schema,
  packageHash: Sha256HexV1Schema,
}).strict()

export type ResolvedPackageCoordinateV1 = z.infer<typeof ResolvedPackageCoordinateV1Schema>

export const ResolvedPatchCoordinateV1Schema = ResolvedPackageCoordinateV1Schema.extend({
  parentProfileHash: Sha256HexV1Schema,
}).strict()

export type ResolvedPatchCoordinateV1 = z.infer<typeof ResolvedPatchCoordinateV1Schema>

export const ResolvedPatchChainV1Schema = z.array(ResolvedPatchCoordinateV1Schema)
  .max(256)
  .superRefine((patches, context) => {
    const seen = new Set<string>()
    for (let index = 0; index < patches.length; index += 1) {
      const packageHash = patches[index].packageHash
      if (seen.has(packageHash)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate patch packageHash: ${packageHash}`,
          path: [index, 'packageHash'],
        })
      }
      seen.add(packageHash)
    }
  })

export type ResolvedPatchChainV1 = z.infer<typeof ResolvedPatchChainV1Schema>

export const ResolvedFileProvenanceV1Schema = z.object({
  packageHash: Sha256HexV1Schema,
  operation: z.enum(['snapshot', 'add', 'replace']),
  sourcePath: PackPayloadPathV1Schema,
}).strict()

export type ResolvedFileProvenanceV1 = z.infer<typeof ResolvedFileProvenanceV1Schema>

export const ResolvedFileV1Schema = z.object({
  descriptor: PackFileDescriptorV1Schema,
  provenance: ResolvedFileProvenanceV1Schema,
}).strict()

export type ResolvedFileV1 = z.infer<typeof ResolvedFileV1Schema>

export const ResolvedFileInventoryV1Schema = z.array(ResolvedFileV1Schema)
  .max(2048)
  .superRefine((files, context) => {
    for (let index = 1; index < files.length; index += 1) {
      const previous = files[index - 1].descriptor.path
      const current = files[index].descriptor.path
      if (previous === current) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate resolved file path: ${current}`,
          path: [index, 'descriptor', 'path'],
        })
      } else if (compareUnicodeCodePointsV1(previous, current) > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Resolved files must be in ascending Unicode code point path order',
          path: [index, 'descriptor', 'path'],
        })
      }
    }
  })

export type ResolvedFileInventoryV1 = z.infer<typeof ResolvedFileInventoryV1Schema>

const ResolvedProfileIdentityV1Shape = {
  schemaVersion: z.literal(RESOLVED_PROFILE_SCHEMA_VERSION_V1),
  compatibility: PackCompatibilityV1Schema,
  capabilities: PackCapabilitiesV1Schema,
  base: ResolvedPackageCoordinateV1Schema,
  // Patch order is semantic chain order. Unlike set-like fields, it is not
  // lexically sorted by this document schema.
  patches: ResolvedPatchChainV1Schema,
  files: ResolvedFileInventoryV1Schema,
}

export const ResolvedProfileIdentityV1Schema = z.object({
  ...ResolvedProfileIdentityV1Shape,
}).strict()

export type ResolvedProfileIdentityV1 = z.infer<typeof ResolvedProfileIdentityV1Schema>

export const ResolvedProfileV1Schema = z.object({
  ...ResolvedProfileIdentityV1Shape,
  // Excluded from ResolvedProfileIdentityV1Schema to avoid a self-hash cycle.
  resolvedProfileHash: Sha256HexV1Schema,
}).strict()

export type ResolvedProfileV1 = z.infer<typeof ResolvedProfileV1Schema>
