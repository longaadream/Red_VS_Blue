/**
 * Author-facing projection of one ordinary piece's complete abilities.
 *
 * A piece is a container for several abilities; it is deliberately not a
 * single ability group.  Each direct skill gets one group, while a direct
 * rule is kept with the first skill cluster that explicitly exposes it.  A
 * rule that no skill exposes remains an independent passive group so the
 * authoring surface does not hide an unresolved relationship.
 *
 * This is a read-only projection.  It never changes runtime registration,
 * planner ownership, or the persisted piece definition.
 */

import {
  buildSkillCluster,
  SKILL_CLUSTER_DEFINITION_VERSION,
  type SkillClusterCatalogInput,
  type SkillClusterDefinition,
  type SkillClusterDiagnostic,
  type SkillClusterRoot,
} from './module-cluster'

export const PIECE_ABILITY_GROUPS_PROJECTION_VERSION = 'rvb-piece-ability-groups/v1' as const

type JsonRecord = Record<string, unknown>

export type PieceAbilityGroupsPiece = string | SkillClusterRoot | Readonly<JsonRecord>

export type PieceAbilityGroup = {
  readonly id: string
  readonly kind: 'skill' | 'rule'
  readonly root: SkillClusterRoot
  readonly cluster: SkillClusterDefinition
  /** Convenience alias for consumers rendering the group without unwrapping cluster. */
  readonly members: SkillClusterDefinition['members']
  /** The direct skill represented by this group. Empty for a rule group. */
  readonly directSkillIds: readonly string[]
  /** Direct rules covered by this skill, or the single rule for a rule group. */
  readonly directRuleIds: readonly string[]
  /** True only for a direct rule with no skill-cluster coverage. */
  readonly unassigned: boolean
  /** Exact declarations on the piece that contributed the direct roots. */
  readonly sources: readonly PieceAbilityGroupSource[]
  readonly execution: 'reference-only'
}

export type PieceAbilityGroupSource = {
  readonly collection: 'skills' | 'rules' | 'playerRules'
  readonly index: number
  readonly id: string
  readonly path: string
}

export type PieceAbilityGroupsProjection = {
  readonly version: typeof PIECE_ABILITY_GROUPS_PROJECTION_VERSION
  readonly pieceId: string
  readonly groups: readonly PieceAbilityGroup[]
  readonly directSkillIds: readonly string[]
  readonly directRuleIds: readonly string[]
  readonly unassignedRuleIds: readonly string[]
  readonly diagnostics: readonly SkillClusterDiagnostic[]
  readonly excluded?: {
    readonly reason: 'pve-only'
    readonly path: string
    readonly value: unknown
  }
  readonly execution: 'reference-only'
}

const record = (value: unknown): value is JsonRecord => !!value && typeof value === 'object' && !Array.isArray(value)

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>()
  return values.filter(value => {
    if (!value || seen.has(value)) return false
    seen.add(value)
    return true
  })
}

function idFrom(value: unknown, keys: readonly string[]): string | undefined {
  if (typeof value === 'string' && value) return value
  if (!record(value)) return undefined
  for (const key of keys) if (typeof value[key] === 'string' && value[key]) return value[key] as string
  return undefined
}

function entriesFrom(value: unknown, keys: readonly string[]): string[] {
  if (!Array.isArray(value)) return idFrom(value, keys) ? [idFrom(value, keys)!] : []
  return value.map(item => idFrom(item, keys)).filter((id): id is string => Boolean(id))
}

function pieceIsPve(id: string, definition: JsonRecord): { path: string; value: unknown } | undefined {
  const modes = record(definition.availability) && Array.isArray(definition.availability.modes)
    ? definition.availability.modes
    : undefined
  if (id.startsWith('pve-')) return { path: 'id', value: id }
  if (modes && modes.length > 0 && modes.every(mode => mode === 'pve')) return { path: 'availability.modes', value: modes }
  return undefined
}

function directlyOwnedRuleIds(definition: unknown, skillId: string): Set<string> {
  if (!record(definition) || !record(definition.cluster)) return new Set()
  const cluster = definition.cluster
  if (cluster.version !== SKILL_CLUSTER_DEFINITION_VERSION
    || cluster.id !== `skills:${skillId}` || !Array.isArray(cluster.links)) return new Set()
  return new Set(cluster.links.filter(link => record(link)
    && link.collection === 'rules' && typeof link.id === 'string' && link.id
    && (link.relation === 'owned' || link.relation === 'shared'))
    .map(link => (link as JsonRecord).id as string))
}

function normalizePieceInput(
  catalog: SkillClusterCatalogInput,
  input: PieceAbilityGroupsPiece,
): { id: string; definition: JsonRecord; catalog: SkillClusterCatalogInput } | undefined {
  if (typeof input === 'string') {
    const definition = catalog.pieces?.[input]
    return definition ? { id: input, definition, catalog } : undefined
  }
  if (record(input) && typeof input.collection === 'string' && typeof input.id === 'string') {
    const id = input.id
    const definition = catalog.pieces?.[id]
    return definition ? { id, definition, catalog } : undefined
  }
  if (!record(input) || typeof input.id !== 'string' || !input.id) return undefined
  const id = input.id
  const existing = catalog.pieces?.[id]
  // A plain object is a piece draft when the editor passes it alongside the
  // persisted catalog. Prefer that draft so unsaved skill/rule membership is
  // visible immediately in the authoring overview.
  if (existing) return { id, definition: input, catalog }
  // Supporting a draft object keeps the editor projection usable before a
  // newly-created piece has been inserted into the collection index.
  return {
    id,
    definition: input,
    catalog: { ...catalog, pieces: { ...(catalog.pieces || {}), [id]: input } },
  }
}

function diagnostic(message: string, path: string, reference?: string): SkillClusterDiagnostic {
  return {
    code: 'missing-root',
    severity: 'error',
    message,
    path,
    ...(reference ? { reference } : {}),
  }
}

/** Build complete author-facing groups for one ordinary piece. */
export function buildPieceAbilityGroups(
  catalog: SkillClusterCatalogInput,
  input: PieceAbilityGroupsPiece,
): PieceAbilityGroupsProjection {
  const resolved = normalizePieceInput(catalog, input)
  if (!resolved) {
    const id = typeof input === 'string' ? input : record(input) && typeof input.id === 'string' ? input.id : ''
    return {
      version: PIECE_ABILITY_GROUPS_PROJECTION_VERSION,
      pieceId: id,
      groups: [],
      directSkillIds: [],
      directRuleIds: [],
      unassignedRuleIds: [],
      diagnostics: [diagnostic(`missing pieces root "${id}"`, 'pieces.id', id)],
      execution: 'reference-only',
    }
  }

  const { id, definition, catalog: resolvedCatalog } = resolved
  const excluded = pieceIsPve(id, definition)
  if (excluded) {
    return {
      version: PIECE_ABILITY_GROUPS_PROJECTION_VERSION,
      pieceId: id,
      groups: [],
      directSkillIds: [],
      directRuleIds: [],
      unassignedRuleIds: [],
      diagnostics: [],
      excluded: { reason: 'pve-only', ...excluded },
      execution: 'reference-only',
    }
  }

  const rawSkills = [
    ...entriesFrom(definition.skills, ['skillId', 'id']),
    ...entriesFrom(definition.skillIds, ['skillId', 'id']),
  ]
  const directSkillIds = unique(rawSkills)
  const skillSources = new Map<string, PieceAbilityGroupSource>()
  ;[
    ['skills', definition.skills],
    ['skillIds', definition.skillIds],
  ].forEach(([field, value]) => {
    if (!Array.isArray(value)) return
    value.forEach((item, index) => {
      const skillId = idFrom(item, ['skillId', 'id'])
      if (skillId && !skillSources.has(skillId)) skillSources.set(skillId, { collection: 'skills', index, id: skillId, path: `pieces.${id}.${field}[${index}]` })
    })
  })

  // `rules` and `playerRules` are piece-declared rules on their respective hosts. Related rules
  // declared by a skill are intentionally resolved by buildSkillCluster and
  // are not promoted to standalone piece groups here.
  const rawRules = [
    ...entriesFrom(definition.rules, ['ruleId', 'id']),
    ...entriesFrom(definition.playerRules, ['ruleId', 'id']),
  ]
  const directRuleIds = unique(rawRules)
  const ruleSources = new Map<string, PieceAbilityGroupSource>()
  for (const [field, value] of [['rules', definition.rules], ['playerRules', definition.playerRules] as const]) {
    if (!Array.isArray(value)) continue
    value.forEach((item, index) => {
      const ruleId = idFrom(item, ['ruleId', 'id'])
      if (ruleId && !ruleSources.has(ruleId)) ruleSources.set(ruleId, {
        collection: field === 'playerRules' ? 'playerRules' : 'rules',
        index,
        id: ruleId,
        path: `pieces.${id}.${field}[${index}]`,
      })
    })
  }

  const groups: PieceAbilityGroup[] = []
  const diagnostics: SkillClusterDiagnostic[] = []
  const coveredRules = new Set<string>()
  for (const skillId of directSkillIds) {
    const root: SkillClusterRoot = { collection: 'skills', id: skillId }
    const cluster = buildSkillCluster(resolvedCatalog, root)
    diagnostics.push(...cluster.diagnostics)
    // Expanded dependencies remain useful for navigation, but ownership is
    // declared by this root. A related skill's owned rule is not owned here.
    const exposedRuleIds = directlyOwnedRuleIds(resolvedCatalog.skills?.[skillId], skillId)
    const covered = directRuleIds.filter(ruleId => exposedRuleIds.has(ruleId))
    covered.forEach(ruleId => coveredRules.add(ruleId))
    const source = skillSources.get(skillId)
    groups.push({
      id: `skills:${skillId}`,
      kind: 'skill',
      root,
      cluster,
      members: cluster.members,
      directSkillIds: [skillId],
      directRuleIds: covered,
      unassigned: false,
      sources: source ? [source, ...covered.map(ruleId => ruleSources.get(ruleId)).filter((item): item is PieceAbilityGroupSource => Boolean(item))] : covered.map(ruleId => ruleSources.get(ruleId)).filter((item): item is PieceAbilityGroupSource => Boolean(item)),
      execution: 'reference-only',
    })
  }

  const unassignedRuleIds = directRuleIds.filter(ruleId => !coveredRules.has(ruleId))
  for (const ruleId of unassignedRuleIds) {
    const root: SkillClusterRoot = { collection: 'rules', id: ruleId }
    const cluster = buildSkillCluster(resolvedCatalog, root)
    diagnostics.push(...cluster.diagnostics)
    const source = ruleSources.get(ruleId)
    groups.push({
      id: `rules:${ruleId}`,
      kind: 'rule',
      root,
      cluster,
      members: cluster.members,
      directSkillIds: [],
      directRuleIds: [ruleId],
      unassigned: true,
      sources: source ? [source] : [],
      execution: 'reference-only',
    })
  }

  return {
    version: PIECE_ABILITY_GROUPS_PROJECTION_VERSION,
    pieceId: id,
    groups,
    directSkillIds,
    directRuleIds,
    unassignedRuleIds,
    diagnostics,
    execution: 'reference-only',
  }
}

/** Alias for callers that describe the operation as a projection. */
export const projectPieceAbilityGroups = buildPieceAbilityGroups
