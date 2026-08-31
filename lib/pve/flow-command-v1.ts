import { z } from 'zod'

import {
  ContentIdV1Schema,
  JsonValueV1Schema,
  Sha256HexV1Schema,
} from '@/lib/content-pipeline/contracts/primitives-v1'
import { PveActiveBattleReferenceV1Schema } from '@/lib/pve/contracts'

export const PVE_FLOW_COMMAND_SCHEMA_VERSION_V1 =
  'rvb-pve-command/v1' as const

const RevisionV1Schema = z.number().int().safe().nonnegative()
const commandBaseV1Shape = {
  schemaVersion: z.literal(PVE_FLOW_COMMAND_SCHEMA_VERSION_V1),
  runId: ContentIdV1Schema,
  commandId: ContentIdV1Schema,
  expectedRevision: RevisionV1Schema,
}

const forbiddenClientBattleKeys = new Set([
  'winner',
  'winnerPlayerId',
  'result',
  'terminalResult',
])

function containsForbiddenClientBattleKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsForbiddenClientBattleKey)
  }
  if (value === null || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) =>
    forbiddenClientBattleKeys.has(key)
    || containsForbiddenClientBattleKey(child))
}

export const PveClientBattleActionV1Schema = JsonValueV1Schema
  .refine(
    value => value !== null && typeof value === 'object' && !Array.isArray(value),
    'Battle action must be a JSON object',
  )
  .superRefine((value, context) => {
    if (containsForbiddenClientBattleKey(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Client battle commands cannot submit winner, result, or terminalResult',
      })
    }
  })

export const PveRosterSelectCommandV1Schema = z
  .object({
    ...commandBaseV1Shape,
    type: z.literal('roster-select'),
  })
  .strict()

export const PveStoryContinueCommandV1Schema = z
  .object({
    ...commandBaseV1Shape,
    type: z.literal('story-continue'),
  })
  .strict()

export const PveEventChooseCommandV1Schema = z
  .object({
    ...commandBaseV1Shape,
    type: z.literal('event-choose'),
    choiceId: ContentIdV1Schema,
  })
  .strict()

export const PveRewardClaimCommandV1Schema = z
  .object({
    ...commandBaseV1Shape,
    type: z.literal('reward-claim'),
    subjectId: ContentIdV1Schema,
  })
  .strict()

export const PveBattleStartCommandV1Schema = z
  .object({
    ...commandBaseV1Shape,
    type: z.literal('battle-start'),
  })
  .strict()

export const PveBattleActionCommandV1Schema = z
  .object({
    ...commandBaseV1Shape,
    type: z.literal('battle-action'),
    action: PveClientBattleActionV1Schema,
  })
  .strict()

export const PveClientFlowCommandV1Schema = z.discriminatedUnion('type', [
  PveRosterSelectCommandV1Schema,
  PveStoryContinueCommandV1Schema,
  PveEventChooseCommandV1Schema,
  PveRewardClaimCommandV1Schema,
  PveBattleStartCommandV1Schema,
  PveBattleActionCommandV1Schema,
])

/**
 * Authority-only handoff after the formal battle adapter has created and
 * hashed the initial BattleState. API routes must never parse clients with
 * this schema.
 */
export const PveBattleStartedCommandV1Schema = z
  .object({
    ...commandBaseV1Shape,
    type: z.literal('battle-started'),
    activeBattle: PveActiveBattleReferenceV1Schema,
  })
  .strict()

/** Authority-only state-hash advance after one formal Battle action. */
export const PveBattleUpdatedCommandV1Schema = z
  .object({
    ...commandBaseV1Shape,
    type: z.literal('battle-updated'),
    activeBattle: PveActiveBattleReferenceV1Schema,
  })
  .strict()

/**
 * Authority-only terminal fact derived from BattleState.terminalResult.
 * It deliberately carries no winner/result/terminalResult object.
 */
export const PveBattleSettleCommandV1Schema = z
  .object({
    ...commandBaseV1Shape,
    type: z.literal('battle-settle'),
    battleId: ContentIdV1Schema,
    stateHash: Sha256HexV1Schema,
    outcome: z.enum(['victory', 'defeat', 'draw']),
    resultHash: Sha256HexV1Schema,
  })
  .strict()

export const PveAuthorityFlowCommandV1Schema = z.discriminatedUnion('type', [
  PveBattleStartedCommandV1Schema,
  PveBattleUpdatedCommandV1Schema,
  PveBattleSettleCommandV1Schema,
])

export const PveFlowCommandV1Schema = z.union([
  PveClientFlowCommandV1Schema,
  PveAuthorityFlowCommandV1Schema,
])

export type PveClientBattleActionV1 = z.infer<
  typeof PveClientBattleActionV1Schema
>
export type PveRosterSelectCommandV1 = z.infer<
  typeof PveRosterSelectCommandV1Schema
>
export type PveStoryContinueCommandV1 = z.infer<
  typeof PveStoryContinueCommandV1Schema
>
export type PveEventChooseCommandV1 = z.infer<
  typeof PveEventChooseCommandV1Schema
>
export type PveRewardClaimCommandV1 = z.infer<
  typeof PveRewardClaimCommandV1Schema
>
export type PveBattleStartCommandV1 = z.infer<
  typeof PveBattleStartCommandV1Schema
>
export type PveBattleActionCommandV1 = z.infer<
  typeof PveBattleActionCommandV1Schema
>
export type PveClientFlowCommandV1 = z.infer<
  typeof PveClientFlowCommandV1Schema
>
export type PveBattleStartedCommandV1 = z.infer<
  typeof PveBattleStartedCommandV1Schema
>
export type PveBattleUpdatedCommandV1 = z.infer<
  typeof PveBattleUpdatedCommandV1Schema
>
export type PveBattleSettleCommandV1 = z.infer<
  typeof PveBattleSettleCommandV1Schema
>
export type PveAuthorityFlowCommandV1 = z.infer<
  typeof PveAuthorityFlowCommandV1Schema
>
export type PveFlowCommandV1 = z.infer<typeof PveFlowCommandV1Schema>
