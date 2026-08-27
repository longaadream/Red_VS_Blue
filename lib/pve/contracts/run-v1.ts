import { z } from 'zod'

import {
  ContentIdV1Schema,
  JsonPrimitiveV1Schema,
  Sha256HexV1Schema,
} from '@/lib/content-pipeline/contracts/primitives-v1'

export const PVE_RUN_SCHEMA_VERSION_V1 = 'rvb-pve-run/v1' as const
export const PVE_CHECKPOINT_SCHEMA_VERSION_V1 = 'rvb-pve-checkpoint/v1' as const
export const PVE_RECEIPT_SCHEMA_VERSION_V1 = 'rvb-pve-receipt/v1' as const
export const PVE_ACTIVE_BATTLE_SCHEMA_VERSION_V1 = 'rvb-pve-active-battle/v1' as const

const Uint32V1Schema = z.number().int().min(0).max(0xffff_ffff)
const RevisionV1Schema = z.number().int().safe().nonnegative()
const PveFlagsV1Schema = z.record(ContentIdV1Schema, JsonPrimitiveV1Schema)

export const PveActiveBattleReferenceV1Schema = z
  .object({
    schemaVersion: z.literal(PVE_ACTIVE_BATTLE_SCHEMA_VERSION_V1),
    battleId: ContentIdV1Schema,
    sourceNodeId: ContentIdV1Schema,
    encounterId: ContentIdV1Schema,
    stateHash: Sha256HexV1Schema,
  })
  .strict()

function uniqueContentIds(fieldName: string) {
  return z.array(ContentIdV1Schema).superRefine((ids, context) => {
    const seen = new Set<string>()
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${fieldName} must not contain duplicate IDs`,
          path: [index],
        })
      }
      seen.add(id)
    })
  })
}

const pveRunStateV1Shape = {
  currentNodeId: ContentIdV1Schema,
  party: uniqueContentIds('party'),
  deck: z.array(ContentIdV1Schema),
  relics: uniqueContentIds('relics'),
  flags: PveFlagsV1Schema,
  activeBattle: PveActiveBattleReferenceV1Schema.nullable(),
}

export const PveCheckpointV1Schema = z
  .object({
    schemaVersion: z.literal(PVE_CHECKPOINT_SCHEMA_VERSION_V1),
    checkpointId: ContentIdV1Schema,
    revision: RevisionV1Schema,
    ...pveRunStateV1Shape,
    // This is the exact receipt prefix covered by receiptsHash at revision.
    receiptCount: RevisionV1Schema,
    receiptsHash: Sha256HexV1Schema,
    stateHash: Sha256HexV1Schema,
  })
  .strict()

export const PveReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(PVE_RECEIPT_SCHEMA_VERSION_V1),
    commandId: ContentIdV1Schema,
    kind: z.enum(['effect', 'reward', 'battle-settlement']),
    sourceNodeId: ContentIdV1Schema,
    subjectId: ContentIdV1Schema,
    fromRevision: RevisionV1Schema,
    toRevision: RevisionV1Schema,
    resultHash: Sha256HexV1Schema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.toRevision !== receipt.fromRevision + 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Receipt must advance exactly one revision',
        path: ['toRevision'],
      })
    }
  })

export const PveRunV1Schema = z
  .object({
    schemaVersion: z.literal(PVE_RUN_SCHEMA_VERSION_V1),
    runId: ContentIdV1Schema,
    resolvedProfileHash: Sha256HexV1Schema,
    campaignId: ContentIdV1Schema,
    campaignPackageHash: Sha256HexV1Schema,
    rootSeed: Uint32V1Schema,
    revision: RevisionV1Schema,
    ...pveRunStateV1Shape,
    checkpoint: PveCheckpointV1Schema,
    receipts: z.array(PveReceiptV1Schema),
  })
  .strict()
  .superRefine((run, context) => {
    const commandIds = new Set<string>()

    run.receipts.forEach((receipt, index) => {
      if (commandIds.has(receipt.commandId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Receipt commandId must be unique within one run',
          path: ['receipts', index, 'commandId'],
        })
      }
      commandIds.add(receipt.commandId)

      if (index > 0 && run.receipts[index - 1].toRevision > receipt.fromRevision) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Receipts must be strictly ordered and must not overlap',
          path: ['receipts', index, 'fromRevision'],
        })
      }

      if (receipt.toRevision > run.revision) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Receipt revision cannot be newer than the run',
          path: ['receipts', index, 'toRevision'],
        })
      }
    })

    if (run.checkpoint.revision > run.revision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Checkpoint revision cannot be newer than the run',
        path: ['checkpoint', 'revision'],
      })
    }

    let expectedReceiptCount = 0
    for (const receipt of run.receipts) {
      if (receipt.toRevision > run.checkpoint.revision) break
      expectedReceiptCount += 1
    }

    if (run.checkpoint.receiptCount !== expectedReceiptCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Checkpoint receiptCount must equal the ordered receipt prefix at its revision',
        path: ['checkpoint', 'receiptCount'],
      })
    }
  })

export type PveCheckpointV1 = z.infer<typeof PveCheckpointV1Schema>
export type PveReceiptV1 = z.infer<typeof PveReceiptV1Schema>
export type PveRunV1 = z.infer<typeof PveRunV1Schema>
export type PveActiveBattleReferenceV1 = z.infer<
  typeof PveActiveBattleReferenceV1Schema
>
