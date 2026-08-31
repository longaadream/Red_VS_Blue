import { z } from 'zod'

import {
  ContentIdV1Schema,
  JsonPrimitiveV1Schema,
} from '@/lib/content-pipeline/contracts/primitives-v1'
import { PveRunV1Schema, type PveRunV1 } from '@/lib/pve/contracts'

export type PveRegistryReferenceKindV1 =
  | 'map'
  | 'objective'
  | 'roster'
  | 'ai-profile'
  | 'effect'
  | 'reward-table'
  | 'condition'

export type PveRuntimeRegistryErrorCodeV1 =
  | 'PVE_REGISTRY_INVALID'
  | 'PVE_REGISTRY_DUPLICATE_ID'
  | 'PVE_REGISTRY_REFERENCE_MISSING'
  | 'PVE_REGISTRY_EFFECT_FAILED'
  | 'PVE_REGISTRY_CONDITION_FAILED'

export class PveRuntimeRegistryErrorV1 extends Error {
  constructor(
    readonly code: PveRuntimeRegistryErrorCodeV1,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'PveRuntimeRegistryErrorV1'
  }
}

export interface PveRegisteredRosterV1 {
  readonly rosterId: string
  readonly pieceIds: readonly string[]
  readonly initialDeck?: readonly string[]
}

export interface PveRegisteredRewardTableV1 {
  readonly rewardTableId: string
  readonly subjectIds: readonly string[]
}

export interface PveRegisteredEffectContextV1 {
  readonly kind: 'event' | 'reward' | 'relic'
  readonly sourceNodeId: string
  readonly subjectId: string
}

export interface PveRunStatePatchV1 {
  readonly party?: readonly string[]
  readonly deck?: readonly string[]
  readonly relics?: readonly string[]
  readonly flags?: Readonly<Record<string, null | boolean | number | string>>
}

export interface PveRegisteredEffectV1 {
  readonly effectId: string
  readonly apply: (
    run: Readonly<PveRunV1>,
    context: Readonly<PveRegisteredEffectContextV1>,
  ) => PveRunStatePatchV1
}

export interface PveRegisteredConditionV1 {
  readonly conditionId: string
  readonly evaluate: (run: Readonly<PveRunV1>) => boolean
}

export interface PveRuntimeRegistryInputV1 {
  readonly maps?: readonly string[]
  readonly objectives?: readonly string[]
  readonly rosters?: readonly PveRegisteredRosterV1[]
  readonly aiProfiles?: readonly string[]
  readonly effects?: readonly PveRegisteredEffectV1[]
  readonly rewardTables?: readonly PveRegisteredRewardTableV1[]
  readonly conditions?: readonly PveRegisteredConditionV1[]
}

export interface PveRuntimeRegistryV1 {
  readonly maps: readonly string[]
  readonly objectives: readonly string[]
  readonly aiProfiles: readonly string[]
  requireMap(mapId: string): void
  requireObjective(objectiveId: string): void
  requireRoster(rosterId: string): Readonly<PveRegisteredRosterV1>
  requireAiProfile(aiProfileId: string): void
  requireEffect(effectId: string): void
  requireRewardTable(
    rewardTableId: string,
  ): Readonly<PveRegisteredRewardTableV1>
  requireCondition(conditionId: string): void
  applyEffect(
    effectId: string,
    run: Readonly<PveRunV1>,
    context: Readonly<PveRegisteredEffectContextV1>,
  ): Readonly<PveRunStatePatchV1>
  evaluateCondition(conditionId: string, run: Readonly<PveRunV1>): boolean
}

const PveRunStatePatchV1Schema = z
  .object({
    party: z.array(ContentIdV1Schema).optional(),
    deck: z.array(ContentIdV1Schema).optional(),
    relics: z.array(ContentIdV1Schema).optional(),
    flags: z.record(ContentIdV1Schema, JsonPrimitiveV1Schema).optional(),
  })
  .strict()

function failInvalid(message: string): never {
  throw new PveRuntimeRegistryErrorV1('PVE_REGISTRY_INVALID', message)
}

function assertExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    failInvalid('Registry entry must be an object')
  }
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  if (
    required.some(key => !Object.prototype.hasOwnProperty.call(value, key))
    || keys.some(key => !allowed.has(key))
  ) {
    failInvalid('Registry entry has unexpected or missing fields')
  }
}

function parseId(value: unknown, label: string): string {
  const result = ContentIdV1Schema.safeParse(value)
  if (!result.success) failInvalid(label + ' must be a canonical content ID')
  return result.data
}

function parseIds(values: unknown, label: string): readonly string[] {
  if (!Array.isArray(values)) failInvalid(label + ' must be an array')
  const ids = values.map((value, index) =>
    parseId(value, label + '[' + String(index) + ']'))
  return Object.freeze(ids)
}

function parseUniqueIds(values: unknown, label: string): readonly string[] {
  const ids = parseIds(values, label)
  if (new Set(ids).size !== ids.length) {
    failInvalid(label + ' must not contain duplicate IDs')
  }
  return ids
}

function indexIds(
  values: unknown,
  kind: PveRegistryReferenceKindV1,
): ReadonlyMap<string, true> {
  const ids = parseUniqueIds(values ?? [], kind)
  return new Map(ids.map(id => [id, true] as const))
}

function addUnique<T>(
  target: Map<string, T>,
  id: string,
  value: T,
  kind: PveRegistryReferenceKindV1,
): void {
  if (target.has(id)) {
    throw new PveRuntimeRegistryErrorV1(
      'PVE_REGISTRY_DUPLICATE_ID',
      'Duplicate ' + kind + ' registry ID: ' + id,
      { kind, id },
    )
  }
  target.set(id, value)
}

function missing(kind: PveRegistryReferenceKindV1, id: string): never {
  throw new PveRuntimeRegistryErrorV1(
    'PVE_REGISTRY_REFERENCE_MISSING',
    'Missing registered ' + kind + ' ID: ' + id,
    { kind, id },
  )
}

function cloneFrozenRun(run: Readonly<PveRunV1>): Readonly<PveRunV1> {
  return deepFreeze(PveRunV1Schema.parse(structuredClone(run)))
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value
  }
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child)
  }
  return value
}

/**
 * Build a closed, code-owned registry. Inputs are copied once and the returned
 * object deliberately has no mutation or late-registration surface.
 */
export function createPveRuntimeRegistryV1(
  input: PveRuntimeRegistryInputV1,
): Readonly<PveRuntimeRegistryV1> {
  assertExactKeys(input as unknown, [], [
    'maps',
    'objectives',
    'rosters',
    'aiProfiles',
    'effects',
    'rewardTables',
    'conditions',
  ])

  const mapIndex = indexIds(input.maps ?? [], 'map')
  const objectiveIndex = indexIds(input.objectives ?? [], 'objective')
  const aiProfileIndex = indexIds(input.aiProfiles ?? [], 'ai-profile')
  const rosters = new Map<string, Readonly<PveRegisteredRosterV1>>()
  const effects = new Map<string, PveRegisteredEffectV1['apply']>()
  const rewardTables =
    new Map<string, Readonly<PveRegisteredRewardTableV1>>()
  const conditions = new Map<string, PveRegisteredConditionV1['evaluate']>()

  if (!Array.isArray(input.rosters ?? [])) failInvalid('rosters must be an array')
  for (const entry of input.rosters ?? []) {
    assertExactKeys(entry, ['rosterId', 'pieceIds'], ['initialDeck'])
    const rosterId = parseId(entry.rosterId, 'rosterId')
    const roster = Object.freeze({
      rosterId,
      pieceIds: parseUniqueIds(entry.pieceIds, rosterId + '.pieceIds'),
      ...(entry.initialDeck === undefined
        ? {}
        : {
            initialDeck: parseIds(
              entry.initialDeck,
              rosterId + '.initialDeck',
            ),
          }),
    })
    addUnique(rosters, rosterId, roster, 'roster')
  }

  if (!Array.isArray(input.effects ?? [])) failInvalid('effects must be an array')
  for (const entry of input.effects ?? []) {
    assertExactKeys(entry, ['effectId', 'apply'])
    const effectId = parseId(entry.effectId, 'effectId')
    if (typeof entry.apply !== 'function') {
      failInvalid(effectId + '.apply must be a function')
    }
    addUnique(effects, effectId, entry.apply, 'effect')
  }

  if (!Array.isArray(input.rewardTables ?? [])) {
    failInvalid('rewardTables must be an array')
  }
  for (const entry of input.rewardTables ?? []) {
    assertExactKeys(entry, ['rewardTableId', 'subjectIds'])
    const rewardTableId = parseId(entry.rewardTableId, 'rewardTableId')
    const rewardTable = Object.freeze({
      rewardTableId,
      subjectIds: parseUniqueIds(
        entry.subjectIds,
        rewardTableId + '.subjectIds',
      ),
    })
    addUnique(rewardTables, rewardTableId, rewardTable, 'reward-table')
  }

  if (!Array.isArray(input.conditions ?? [])) {
    failInvalid('conditions must be an array')
  }
  for (const entry of input.conditions ?? []) {
    assertExactKeys(entry, ['conditionId', 'evaluate'])
    const conditionId = parseId(entry.conditionId, 'conditionId')
    if (typeof entry.evaluate !== 'function') {
      failInvalid(conditionId + '.evaluate must be a function')
    }
    addUnique(conditions, conditionId, entry.evaluate, 'condition')
  }

  const requireSimple = (
    index: ReadonlyMap<string, true>,
    kind: PveRegistryReferenceKindV1,
    id: string,
  ): void => {
    if (!index.has(id)) missing(kind, id)
  }

  const registry: PveRuntimeRegistryV1 = {
    maps: Object.freeze([...mapIndex.keys()]),
    objectives: Object.freeze([...objectiveIndex.keys()]),
    aiProfiles: Object.freeze([...aiProfileIndex.keys()]),
    requireMap(mapId) {
      requireSimple(mapIndex, 'map', mapId)
    },
    requireObjective(objectiveId) {
      requireSimple(objectiveIndex, 'objective', objectiveId)
    },
    requireRoster(rosterId) {
      return rosters.get(rosterId) ?? missing('roster', rosterId)
    },
    requireAiProfile(aiProfileId) {
      requireSimple(aiProfileIndex, 'ai-profile', aiProfileId)
    },
    requireEffect(effectId) {
      if (!effects.has(effectId)) missing('effect', effectId)
    },
    requireRewardTable(rewardTableId) {
      return rewardTables.get(rewardTableId)
        ?? missing('reward-table', rewardTableId)
    },
    requireCondition(conditionId) {
      if (!conditions.has(conditionId)) missing('condition', conditionId)
    },
    applyEffect(effectId, run, context) {
      const apply = effects.get(effectId) ?? missing('effect', effectId)
      try {
        const patch = PveRunStatePatchV1Schema.parse(
          apply(cloneFrozenRun(run), Object.freeze({ ...context })),
        )
        return deepFreeze(patch)
      } catch (error) {
        if (error instanceof PveRuntimeRegistryErrorV1) throw error
        throw new PveRuntimeRegistryErrorV1(
          'PVE_REGISTRY_EFFECT_FAILED',
          'Registered effect failed: ' + effectId,
          { effectId },
        )
      }
    },
    evaluateCondition(conditionId, run) {
      const evaluate =
        conditions.get(conditionId) ?? missing('condition', conditionId)
      try {
        const result = evaluate(cloneFrozenRun(run))
        if (typeof result !== 'boolean') {
          throw new Error('Condition must return boolean')
        }
        return result
      } catch (error) {
        if (error instanceof PveRuntimeRegistryErrorV1) throw error
        throw new PveRuntimeRegistryErrorV1(
          'PVE_REGISTRY_CONDITION_FAILED',
          'Registered condition failed: ' + conditionId,
          { conditionId },
        )
      }
    },
  }

  return Object.freeze(registry)
}
