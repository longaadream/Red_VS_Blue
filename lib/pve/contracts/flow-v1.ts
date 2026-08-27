import { z } from 'zod'

import {
  compareUnicodeCodePointsV1,
  ContentIdV1Schema,
} from '@/lib/content-pipeline/contracts/primitives-v1'

export const PVE_FLOW_NODE_SCHEMA_VERSION_V1 = 'rvb-pve-node/v1' as const

const flowNodeBaseV1Shape = {
  schemaVersion: z.literal(PVE_FLOW_NODE_SCHEMA_VERSION_V1),
  nodeId: ContentIdV1Schema,
}

export const PveOutcomeRouteV1Schema = z
  .object({
    outcomeId: ContentIdV1Schema,
    nextNodeId: ContentIdV1Schema,
  })
  .strict()

export const PveConditionRouteV1Schema = z
  .object({
    conditionId: ContentIdV1Schema,
    nextNodeId: ContentIdV1Schema,
  })
  .strict()

const PveOutcomeRoutesV1Schema = z
  .array(PveOutcomeRouteV1Schema)
  .min(1)
  .superRefine((routes, context) => {
    const outcomeIds = new Set<string>()
    routes.forEach((route, index) => {
      if (outcomeIds.has(route.outcomeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'outcomeId must be unique within one node',
          path: [index, 'outcomeId'],
        })
      }
      outcomeIds.add(route.outcomeId)

      if (
        index > 0
        && compareUnicodeCodePointsV1(routes[index - 1].outcomeId, route.outcomeId)
          > 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'outcomes must be ordered by outcomeId using Unicode code points',
          path: [index, 'outcomeId'],
        })
      }
    })
  })

const PveConditionRoutesV1Schema = z
  // Branch order is semantic: the first registered condition that matches wins.
  .array(PveConditionRouteV1Schema)
  .min(1)
  .superRefine((routes, context) => {
    const conditionIds = new Set<string>()
    routes.forEach((route, index) => {
      if (conditionIds.has(route.conditionId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'conditionId must be unique within one node',
          path: [index, 'conditionId'],
        })
      }
      conditionIds.add(route.conditionId)
    })
  })

export const PveStoryNodeV1Schema = z
  .object({
    ...flowNodeBaseV1Shape,
    type: z.literal('story'),
    storyId: ContentIdV1Schema,
    nextNodeId: ContentIdV1Schema,
  })
  .strict()

export const PveRosterNodeV1Schema = z
  .object({
    ...flowNodeBaseV1Shape,
    type: z.literal('roster'),
    rosterId: ContentIdV1Schema,
    nextNodeId: ContentIdV1Schema,
  })
  .strict()

export const PveBattleNodeV1Schema = z
  .object({
    ...flowNodeBaseV1Shape,
    type: z.literal('battle'),
    encounterId: ContentIdV1Schema,
    victoryNodeId: ContentIdV1Schema,
    defeatNodeId: ContentIdV1Schema,
    drawNodeId: ContentIdV1Schema,
  })
  .strict()

export const PveEventNodeV1Schema = z
  .object({
    ...flowNodeBaseV1Shape,
    type: z.literal('event'),
    eventId: ContentIdV1Schema,
    outcomes: PveOutcomeRoutesV1Schema,
  })
  .strict()

export const PveRewardNodeV1Schema = z
  .object({
    ...flowNodeBaseV1Shape,
    type: z.literal('reward'),
    rewardId: ContentIdV1Schema,
    nextNodeId: ContentIdV1Schema,
  })
  .strict()

export const PveBranchNodeV1Schema = z
  .object({
    ...flowNodeBaseV1Shape,
    type: z.literal('branch'),
    routes: PveConditionRoutesV1Schema,
    fallbackNodeId: ContentIdV1Schema,
  })
  .strict()

export const PveCheckpointNodeV1Schema = z
  .object({
    ...flowNodeBaseV1Shape,
    type: z.literal('checkpoint'),
    checkpointId: ContentIdV1Schema,
    nextNodeId: ContentIdV1Schema,
  })
  .strict()

export const PveEndNodeV1Schema = z
  .object({
    ...flowNodeBaseV1Shape,
    type: z.literal('end'),
    endingId: ContentIdV1Schema,
    outcome: z.enum(['completed', 'failed']),
  })
  .strict()

export const PveFlowNodeV1Schema = z.discriminatedUnion('type', [
  PveStoryNodeV1Schema,
  PveRosterNodeV1Schema,
  PveBattleNodeV1Schema,
  PveEventNodeV1Schema,
  PveRewardNodeV1Schema,
  PveBranchNodeV1Schema,
  PveCheckpointNodeV1Schema,
  PveEndNodeV1Schema,
])

export type PveOutcomeRouteV1 = z.infer<typeof PveOutcomeRouteV1Schema>
export type PveConditionRouteV1 = z.infer<typeof PveConditionRouteV1Schema>
export type PveStoryNodeV1 = z.infer<typeof PveStoryNodeV1Schema>
export type PveRosterNodeV1 = z.infer<typeof PveRosterNodeV1Schema>
export type PveBattleNodeV1 = z.infer<typeof PveBattleNodeV1Schema>
export type PveEventNodeV1 = z.infer<typeof PveEventNodeV1Schema>
export type PveRewardNodeV1 = z.infer<typeof PveRewardNodeV1Schema>
export type PveBranchNodeV1 = z.infer<typeof PveBranchNodeV1Schema>
export type PveCheckpointNodeV1 = z.infer<typeof PveCheckpointNodeV1Schema>
export type PveEndNodeV1 = z.infer<typeof PveEndNodeV1Schema>
export type PveFlowNodeV1 = z.infer<typeof PveFlowNodeV1Schema>
