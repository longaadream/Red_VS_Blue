import { z } from 'zod'

import { PackJsonPayloadPathV1Schema } from '@/lib/content-pipeline/contracts/pack-v1'
import {
  compareUnicodeCodePointsV1,
  ContentIdV1Schema,
  SemVerV1Schema,
} from '@/lib/content-pipeline/contracts/primitives-v1'

export const PVE_CONTENT_MANIFEST_SCHEMA_VERSION_V1 =
  'rvb-pve-content-manifest/v1' as const
export const PVE_CAMPAIGN_SCHEMA_VERSION_V1 = 'rvb-pve-campaign/v1' as const
export const PVE_CHAPTER_SCHEMA_VERSION_V1 = 'rvb-pve-chapter/v1' as const
export const PVE_ENCOUNTER_SCHEMA_VERSION_V1 = 'rvb-pve-encounter/v1' as const
export const PVE_EVENT_SCHEMA_VERSION_V1 = 'rvb-pve-event/v1' as const
export const PVE_REWARD_SCHEMA_VERSION_V1 = 'rvb-pve-reward/v1' as const
export const PVE_RELIC_SCHEMA_VERSION_V1 = 'rvb-pve-relic/v1' as const
export const PVE_ENEMY_SETUP_SCHEMA_VERSION_V1 =
  'rvb-pve-enemy-setup/v1' as const

// PVE JSON documents share the exact same payload-path contract as pack files.
export const PveJsonDocumentPathV1Schema = PackJsonPayloadPathV1Schema

export const PveContentKindV1Schema = z.enum([
  'campaign',
  'chapter',
  'encounter',
  'event',
  'reward',
  'relic',
  'enemy',
])

export const PveContentDescriptorV1Schema = z
  .object({
    kind: PveContentKindV1Schema,
    contentId: ContentIdV1Schema,
    path: PveJsonDocumentPathV1Schema,
  })
  .strict()

export const PveContentManifestV1Schema = z
  .object({
    schemaVersion: z.literal(PVE_CONTENT_MANIFEST_SCHEMA_VERSION_V1),
    manifestId: ContentIdV1Schema,
    documents: z.array(PveContentDescriptorV1Schema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const documentKeys = new Set<string>()
    const paths = new Set<string>()

    manifest.documents.forEach((document, index) => {
      const documentKey = `${document.kind}:${document.contentId}`
      if (documentKeys.has(documentKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'PVE content kind and contentId must be unique',
          path: ['documents', index, 'contentId'],
        })
      }
      documentKeys.add(documentKey)

      if (paths.has(document.path)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'PVE content path must be unique',
          path: ['documents', index, 'path'],
        })
      }
      paths.add(document.path)

      if (index > 0) {
        const previous = manifest.documents[index - 1]
        const kindOrder = compareUnicodeCodePointsV1(previous.kind, document.kind)
        const contentIdOrder = compareUnicodeCodePointsV1(
          previous.contentId,
          document.contentId,
        )
        if (kindOrder > 0 || (kindOrder === 0 && contentIdOrder > 0)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'PVE content documents must be ordered by kind then contentId using Unicode code points',
            path: ['documents', index],
          })
        }
      }
    })
  })

export const PveCampaignNodeDescriptorV1Schema = z
  .object({
    nodeId: ContentIdV1Schema,
    path: PveJsonDocumentPathV1Schema,
  })
  .strict()

export const PveCampaignV1Schema = z
  .object({
    schemaVersion: z.literal(PVE_CAMPAIGN_SCHEMA_VERSION_V1),
    campaignId: ContentIdV1Schema,
    version: SemVerV1Schema,
    entryNodeId: ContentIdV1Schema,
    nodes: z.array(PveCampaignNodeDescriptorV1Schema).min(1),
  })
  .strict()
  .superRefine((campaign, context) => {
    const nodeIds = new Set<string>()
    const paths = new Set<string>()

    campaign.nodes.forEach((node, index) => {
      if (nodeIds.has(node.nodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Campaign nodeId must be unique within one manifest',
          path: ['nodes', index, 'nodeId'],
        })
      }
      nodeIds.add(node.nodeId)

      if (paths.has(node.path)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Campaign node path must be unique within one manifest',
          path: ['nodes', index, 'path'],
        })
      }
      paths.add(node.path)

      if (
        index > 0
        && compareUnicodeCodePointsV1(campaign.nodes[index - 1].nodeId, node.nodeId)
          > 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Campaign nodes must be ordered by nodeId using Unicode code points',
          path: ['nodes', index, 'nodeId'],
        })
      }
    })

    if (!nodeIds.has(campaign.entryNodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Campaign entryNodeId must name a node descriptor in this manifest',
        path: ['entryNodeId'],
      })
    }
  })

export const PveChapterV1Schema = z
  .object({
    schemaVersion: z.literal(PVE_CHAPTER_SCHEMA_VERSION_V1),
    chapterId: ContentIdV1Schema,
    titleTextId: ContentIdV1Schema,
    descriptionTextId: ContentIdV1Schema,
    campaignId: ContentIdV1Schema,
  })
  .strict()

export const PveEncounterV1Schema = z
  .object({
    schemaVersion: z.literal(PVE_ENCOUNTER_SCHEMA_VERSION_V1),
    encounterId: ContentIdV1Schema,
    mapId: ContentIdV1Schema,
    enemySetupId: ContentIdV1Schema,
    objectiveId: ContentIdV1Schema,
  })
  .strict()

export const PveEventChoiceV1Schema = z
  .object({
    choiceId: ContentIdV1Schema,
    labelTextId: ContentIdV1Schema,
    effectId: ContentIdV1Schema,
    outcomeId: ContentIdV1Schema,
  })
  .strict()

export const PveEventV1Schema = z
  .object({
    schemaVersion: z.literal(PVE_EVENT_SCHEMA_VERSION_V1),
    eventId: ContentIdV1Schema,
    narrativeId: ContentIdV1Schema,
    // Choice order is presentation order and is therefore semantically significant.
    choices: z.array(PveEventChoiceV1Schema).min(1),
  })
  .strict()
  .superRefine((event, context) => {
    const choiceIds = new Set<string>()
    event.choices.forEach((choice, index) => {
      if (choiceIds.has(choice.choiceId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'choiceId must be unique within one event',
          path: ['choices', index, 'choiceId'],
        })
      }
      choiceIds.add(choice.choiceId)
    })
  })

export const PveRewardV1Schema = z
  .object({
    schemaVersion: z.literal(PVE_REWARD_SCHEMA_VERSION_V1),
    rewardId: ContentIdV1Schema,
    rewardTableId: ContentIdV1Schema,
    grantEffectId: ContentIdV1Schema,
  })
  .strict()

const PveEffectIdsV1Schema = z
  // Effect order is execution order and is therefore semantically significant.
  .array(ContentIdV1Schema)
  .min(1)
  .superRefine((effectIds, context) => {
    const seen = new Set<string>()
    effectIds.forEach((effectId, index) => {
      if (seen.has(effectId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'effectIds must not contain duplicate IDs',
          path: [index],
        })
      }
      seen.add(effectId)
    })
  })

export const PveRelicV1Schema = z
  .object({
    schemaVersion: z.literal(PVE_RELIC_SCHEMA_VERSION_V1),
    relicId: ContentIdV1Schema,
    rarityId: ContentIdV1Schema,
    nameTextId: ContentIdV1Schema,
    descriptionTextId: ContentIdV1Schema,
    effectIds: PveEffectIdsV1Schema,
  })
  .strict()

export const PveEnemySetupV1Schema = z
  .object({
    schemaVersion: z.literal(PVE_ENEMY_SETUP_SCHEMA_VERSION_V1),
    enemySetupId: ContentIdV1Schema,
    rosterId: ContentIdV1Schema,
    aiProfileId: ContentIdV1Schema,
  })
  .strict()

export type PveJsonDocumentPathV1 = z.infer<
  typeof PveJsonDocumentPathV1Schema
>
export type PveContentKindV1 = z.infer<typeof PveContentKindV1Schema>
export type PveContentDescriptorV1 = z.infer<
  typeof PveContentDescriptorV1Schema
>
export type PveContentManifestV1 = z.infer<typeof PveContentManifestV1Schema>
export type PveCampaignNodeDescriptorV1 = z.infer<
  typeof PveCampaignNodeDescriptorV1Schema
>
export type PveCampaignV1 = z.infer<typeof PveCampaignV1Schema>
export type PveChapterV1 = z.infer<typeof PveChapterV1Schema>
export type PveEncounterV1 = z.infer<typeof PveEncounterV1Schema>
export type PveEventChoiceV1 = z.infer<typeof PveEventChoiceV1Schema>
export type PveEventV1 = z.infer<typeof PveEventV1Schema>
export type PveRewardV1 = z.infer<typeof PveRewardV1Schema>
export type PveRelicV1 = z.infer<typeof PveRelicV1Schema>
export type PveEnemySetupV1 = z.infer<typeof PveEnemySetupV1Schema>
