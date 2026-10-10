/**
 * Author-facing skill Cluster aggregation.
 *
 * A Cluster is a read-only view over existing content definitions.  It does
 * not register, schedule, or execute a skill, status, or rule.  In
 * particular, seeing one rule in more than one Cluster must not result in a
 * second rule instance at runtime.
 *
 * The implementation intentionally only follows declared fields and a small
 * allow-list of legacy graph calls.  It never searches source strings or
 * guesses ownership from IDs or display names.
 */

import { compileGameplayModuleGraph } from './module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from './module-registry'

export const SKILL_CLUSTER_DEFINITION_VERSION = 'rvb-skill-cluster/v1' as const
export const SKILL_CLUSTER_VERSION = SKILL_CLUSTER_DEFINITION_VERSION
const GAMEPLAY_MODULE_DOCUMENT_VERSION = 'rvb-gameplay-module-document/v1'
const GAMEPLAY_MODULE_GRAPH_VERSION = 'rvb-gameplay-modules/v1'
const GAMEPLAY_MODULE_COMPILER_VERSION = 'rvb-gameplay-module-compiler/v1'

type JsonRecord = Record<string, unknown>

export type SkillClusterCollection = 'skills' | 'pieces'
export type SkillClusterMemberKind =
  | 'skill'
  | 'piece'
  | 'rule'
  | 'status'
  | 'card'
  | 'continuation'
  | 'presentation'
export type SkillClusterKind = 'active' | 'passive'
export type SkillClusterMemberRole = 'root' | 'dependency' | 'related'
export type SkillClusterLinkRelation = 'owned' | 'shared' | 'related'
export type SkillClusterEvidence =
  | 'explicit'
  | 'inline'
  | 'semantic'
  | 'declarative'
  | 'compatibility'
  | 'generated'

/** A caller-provided root.  `field` is a safe dot path into that definition. */
export type SkillClusterRoot = {
  readonly collection: SkillClusterCollection
  readonly id: string
  readonly field?: string
}

/** The input catalog is deliberately structural so this module stays browser-safe. */
export type SkillClusterCatalogInput = {
  readonly skills: Readonly<Record<string, JsonRecord>>
  readonly rules: Readonly<Record<string, JsonRecord>>
  readonly pieces: Readonly<Record<string, JsonRecord>>
  readonly cards?: Readonly<Record<string, JsonRecord>>
}

export type SkillClusterReferenceLocation = {
  readonly collection: 'skills' | 'pieces' | 'rules' | 'cards' | 'statuses'
  readonly id: string
  readonly field: string
  readonly path: string
}

export type SkillClusterMember = {
  readonly kind: SkillClusterMemberKind
  readonly id: string
  readonly role: SkillClusterMemberRole
  /** Present only for an explicit author link; it is never inferred. */
  readonly relation?: SkillClusterLinkRelation
  /** All locations that explicitly or compatibly expose this member. */
  readonly provenance: readonly SkillClusterReferenceLocation[]
  /** Alias for the first location for simple editor consumers. */
  readonly source?: SkillClusterReferenceLocation
  /** Compatibility/generated status evidence is intentionally not editable. */
  readonly evidence: SkillClusterEvidence
  readonly editable: boolean
  /** Cloned JSON data; editing it never mutates the source catalog. */
  readonly definition: Readonly<JsonRecord>
  /** Makes the runtime ownership boundary explicit to consumers. */
  readonly execution: 'reference-only'
}

export type SkillClusterMembers = {
  readonly skills: readonly SkillClusterMember[]
  readonly pieces: readonly SkillClusterMember[]
  readonly rules: readonly SkillClusterMember[]
  readonly statuses: readonly SkillClusterMember[]
  /** Alias matching the source field vocabulary. */
  readonly statusTags: readonly SkillClusterMember[]
  readonly cards: readonly SkillClusterMember[]
  readonly continuations: readonly SkillClusterMember[]
  readonly presentations: readonly SkillClusterMember[]
  readonly all: readonly SkillClusterMember[]
}

export type SkillClusterCoverageStatus = 'complete' | 'partial' | 'missing'

export type SkillClusterCoverage = {
  readonly status: SkillClusterCoverageStatus
  readonly total: number
  readonly covered: number
  readonly complete: number
  readonly partial: number
  readonly missing: number
  readonly generated: number
  readonly editable: number
}

export type SkillClusterDiagnosticSeverity = 'error' | 'warning' | 'info'
export type SkillClusterDiagnosticCode =
  | 'invalid-catalog'
  | 'missing-root'
  | 'invalid-root'
  | 'unsafe-field-path'
  | 'missing-field'
  | 'key-mismatch'
  | 'duplicate-id'
  | 'missing-reference'
  | 'invalid-reference'
  | 'ambiguous-reference'
  | 'cycle'
  | 'conflicting-member'
  | 'legacy-source'
  | 'unknown-metadata'
  | 'invalid-definition'

export type SkillClusterDiagnostic = {
  readonly code: SkillClusterDiagnosticCode
  readonly severity: SkillClusterDiagnosticSeverity
  readonly message: string
  readonly path?: string
  readonly source?: SkillClusterReferenceLocation
  readonly reference?: string
}

export type SkillClusterDefinition = {
  readonly version: typeof SKILL_CLUSTER_DEFINITION_VERSION
  /** Root ID is kept stable for editor URLs and persisted references. */
  readonly id: string
  /** Collection-qualified ID avoids collisions between a skill and a piece. */
  readonly clusterId: string
  readonly kind: SkillClusterKind
  readonly root: SkillClusterRoot
  readonly members: SkillClusterMembers
  readonly diagnostics: readonly SkillClusterDiagnostic[]
  readonly coverage: {
    readonly semantic: SkillClusterCoverage
    readonly compatibility: SkillClusterCoverage
    readonly declarative: SkillClusterCoverage
  }
  readonly semanticCoverage: SkillClusterCoverage
  readonly compatibilityCoverage: SkillClusterCoverage
  readonly declarativeCoverage: SkillClusterCoverage
  readonly execution: 'reference-only'
  /** Optional editor metadata is copied through without interpretation. */
  readonly metadata?: Readonly<JsonRecord>
}

export type SkillClusterMappingOverride = {
  /** Exact skill ID.  No name or prefix matching is performed. */
  readonly skillId: string
  /** Exact piece ID whose declared rules are being verified by the caller. */
  readonly pieceId: string
  /** If omitted, all rules declared by the piece are attached. */
  readonly ruleIds?: readonly string[]
  /** Alias accepted for authoring clients that call this field `rules`. */
  readonly rules?: readonly string[]
}

/** Explicit authoring link stored on a skill definition. */
export type SkillClusterLink = {
  readonly collection: 'skills' | 'pieces' | 'rules' | 'cards'
  readonly id: string
  readonly relation: SkillClusterLinkRelation
  readonly source?: string
}

export type SkillClusterBuildOptions = {
  readonly mappingOverrides?:
    | readonly SkillClusterMappingOverride[]
    | Readonly<Record<string, SkillClusterMappingOverride | readonly SkillClusterMappingOverride[]>>
  /** Alias for consumers that keep mappings in a keyed authoring table. */
  readonly skillRuleMappings?: Readonly<Record<string, readonly SkillClusterMappingOverride[]>>
  readonly metadata?: Readonly<JsonRecord>
}

export type SkillClusterCatalogResult = {
  readonly version: typeof SKILL_CLUSTER_DEFINITION_VERSION
  readonly clusters: readonly SkillClusterDefinition[]
  /** Alias useful to callers that use the persisted-definition vocabulary. */
  readonly definitions: readonly SkillClusterDefinition[]
  readonly diagnostics: readonly SkillClusterDiagnostic[]
}

const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)
const record = (value: unknown): value is JsonRecord => !!value && typeof value === 'object' && !Array.isArray(value)
const collections = ['skills', 'pieces', 'rules', 'cards'] as const
type CatalogCollection = (typeof collections)[number]

function cloneJson(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return seen.get(value)
  if (Array.isArray(value)) {
    const output: unknown[] = []
    seen.set(value, output)
    for (const item of value) output.push(cloneJson(item, seen))
    return output
  }
  const output: JsonRecord = {}
  seen.set(value, output)
  for (const key of Object.keys(value)) {
    // Define properties explicitly so a JSON object with a __proto__ key
    // cannot alter the prototype of the returned snapshot.
    Object.defineProperty(output, key, {
      value: cloneJson((value as JsonRecord)[key], seen),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return output
}

function cloneRecord(value: unknown): JsonRecord {
  const cloned = cloneJson(value)
  return (record(cloned) ? cloned : {}) as JsonRecord
}

function pathSegments(path: string): string[] | undefined {
  if (typeof path !== 'string' || !path.length || path.length > 240) return undefined
  const segments = path.split('.')
  if (segments.some(segment =>
    !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)
    || segment === '__proto__'
    || segment === 'prototype'
    || segment === 'constructor')) return undefined
  return segments
}

function readPath(value: unknown, path: string): { found: boolean; value?: unknown } {
  const segments = pathSegments(path)
  if (!segments) return { found: false }
  let current: unknown = value
  for (const segment of segments) {
    if (!record(current) && !Array.isArray(current)) return { found: false }
    if (!own(current as object, segment)) return { found: false }
    current = (current as JsonRecord)[segment]
  }
  return { found: true, value: current }
}

function diagnostic(
  code: SkillClusterDiagnosticCode,
  message: string,
  path?: string,
  source?: SkillClusterReferenceLocation,
  reference?: string,
  severity: SkillClusterDiagnosticSeverity = code === 'cycle' || code === 'legacy-source' ? 'warning' : 'error',
): SkillClusterDiagnostic {
  return { code, severity, message, ...(path ? { path } : {}), ...(source ? { source } : {}), ...(reference ? { reference } : {}) }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asStringList(value: unknown): string[] {
  if (typeof value === 'string') return value.length ? [value] : []
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

function memberBucket(kind: SkillClusterMemberKind): keyof Omit<SkillClusterMembers, 'all'> {
  if (kind === 'skill') return 'skills'
  if (kind === 'piece') return 'pieces'
  if (kind === 'rule') return 'rules'
  if (kind === 'status') return 'statuses'
  if (kind === 'card') return 'cards'
  if (kind === 'continuation') return 'continuations'
  return 'presentations'
}

function catalogCollection(catalog: SkillClusterCatalogInput, collection: CatalogCollection): Readonly<Record<string, JsonRecord>> | undefined {
  const value = catalog?.[collection]
  return record(value) ? value as Readonly<Record<string, JsonRecord>> : undefined
}

type IndexedCatalog = {
  readonly entries: Readonly<Record<string, JsonRecord>>
  readonly byId: ReadonlyMap<string, string>
  readonly diagnostics: readonly SkillClusterDiagnostic[]
}

function indexCollection(catalog: SkillClusterCatalogInput, collection: CatalogCollection): IndexedCatalog {
  const entries = catalogCollection(catalog, collection)
  if (!entries) {
    if (collection === 'cards' && catalog.cards === undefined) return { entries: {}, byId: new Map(), diagnostics: [] }
    return {
      entries: {},
      byId: new Map(),
      diagnostics: [diagnostic('invalid-catalog', `catalog.${collection} must be a record`, `catalog.${collection}`)],
    }
  }
  const byId = new Map<string, string>()
  const diagnostics: SkillClusterDiagnostic[] = []
  for (const [key, value] of Object.entries(entries)) {
    if (!record(value)) {
      diagnostics.push(diagnostic('invalid-catalog', `${collection}.${key} must be a record`, `catalog.${collection}.${key}`))
      continue
    }
    const declaredId = asString(value.id)
    const id = declaredId ?? key
    if (declaredId && declaredId !== key) {
      diagnostics.push(diagnostic(
        'key-mismatch',
        `${collection}.${key} declares id "${declaredId}"`,
        `catalog.${collection}.${key}.id`,
        undefined,
        declaredId,
      ))
    }
    const prior = byId.get(id)
    if (prior && prior !== key) {
      diagnostics.push(diagnostic(
        'duplicate-id',
        `${collection} contains duplicate id "${id}" at ${prior} and ${key}`,
        `catalog.${collection}`,
        undefined,
        id,
      ))
    } else {
      byId.set(id, key)
    }
  }
  return { entries, byId, diagnostics }
}

function makeLocation(collection: SkillClusterReferenceLocation['collection'], id: string, field: string, path: string): SkillClusterReferenceLocation {
  return { collection, id, field, path }
}

function memberKey(kind: SkillClusterMemberKind, id: string, scope?: SkillClusterReferenceLocation): string {
  // Rule/skill dependencies are global definitions and are deduplicated by
  // ID.  A status is an inline/effect definition: two owners may intentionally
  // use the same status ID/type with different parameters, so its owner is
  // part of the aggregation key.
  if (kind === 'status' && scope) return `${kind}:${id}:${scope.collection}:${scope.id}`
  return `${kind}:${id}`
}

type MutableMember = {
  kind: SkillClusterMemberKind
  id: string
  role: SkillClusterMemberRole
  relation?: SkillClusterLinkRelation
  provenance: SkillClusterReferenceLocation[]
  evidence: SkillClusterEvidence
  editable: boolean
  definition: JsonRecord
}

function evidenceRank(evidence: SkillClusterEvidence): number {
  if (evidence === 'semantic') return 5
  if (evidence === 'explicit') return 4
  if (evidence === 'inline' || evidence === 'declarative') return 3
  if (evidence === 'compatibility') return 2
  return 1
}

function createMembers(): Map<string, MutableMember> {
  return new Map()
}

function addMember(
  members: Map<string, MutableMember>,
  diagnostics: SkillClusterDiagnostic[],
  input: Omit<MutableMember, 'provenance'> & { provenance: SkillClusterReferenceLocation | readonly SkillClusterReferenceLocation[] },
): MutableMember {
  const provenance = Array.isArray(input.provenance) ? [...input.provenance] : [input.provenance]
  const key = memberKey(input.kind, input.id, provenance[0])
  const existing = members.get(key)
  if (!existing) {
    const next: MutableMember = {
      kind: input.kind,
      id: input.id,
      role: input.role,
      ...(input.relation ? { relation: input.relation } : {}),
      provenance,
      evidence: input.evidence,
      editable: input.editable,
      definition: cloneRecord(input.definition),
    }
    members.set(key, next)
    return next
  }
  for (const location of provenance) {
    if (!existing.provenance.some(item =>
      item.collection === location.collection
      && item.id === location.id
      && item.field === location.field
      && item.path === location.path)) existing.provenance.push(location)
  }
  if (existing.role !== 'root' && input.role === 'root') existing.role = 'root'
  if (!existing.relation && input.relation) existing.relation = input.relation
  const nextEvidence = evidenceRank(input.evidence) > evidenceRank(existing.evidence) ? input.evidence : existing.evidence
  const nextEditable = existing.editable || input.editable
  if (existing.definition.id !== undefined && input.definition.id !== undefined && existing.definition.id !== input.definition.id) {
    diagnostics.push(diagnostic('conflicting-member', `conflicting definitions for ${input.kind} "${input.id}"`, undefined, provenance[0]))
  }
  existing.evidence = nextEvidence
  existing.editable = nextEditable && nextEvidence !== 'generated' && nextEvidence !== 'compatibility'
  return existing
}

function literalString(value: unknown): string | undefined {
  if (!record(value) || value.kind !== 'literal') return undefined
  return asString(value.value)
}

function graphObject(value: unknown): JsonRecord | undefined {
  if (!record(value) || value.kind !== 'object' || !Array.isArray(value.entries)) return undefined
  const output: JsonRecord = {}
  for (const entry of value.entries) {
    if (!record(entry) || typeof entry.key !== 'string') continue
    const literal = record(entry.value) && entry.value.kind === 'literal' ? entry.value.value : undefined
    output[entry.key] = literal === undefined ? cloneJson(entry.value) : cloneJson(literal)
  }
  return output
}

type LegacyEvidence = {
  readonly rules: readonly { id: string; path: string }[]
  readonly statuses: readonly { id: string; definition: JsonRecord; path: string; relatedRules: readonly string[] }[]
}

function collectLegacyGraphEvidence(value: unknown, path = 'contentGraph'): LegacyEvidence {
  const rules: { id: string; path: string }[] = []
  const statuses: { id: string; definition: JsonRecord; path: string; relatedRules: readonly string[] }[] = []
  const visit = (node: unknown, nodePath: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${nodePath}[${index}]`))
      return
    }
    if (!record(node)) return
    if (node.kind === 'call') {
      const capability = asString(node.capability)
      const moduleId = asString(node.module)
      const name = capability ?? moduleId
      if (name === 'addRuleById' || name === 'rule.apply-piece' || name === 'rule.apply-player') {
        const args = Array.isArray(node.args) ? node.args : []
        const id = literalString(args[1]) ?? literalString(args[0])
        const parameterId = record(node.parameters) ? asString(node.parameters.ruleId) : undefined
        if (id ?? parameterId) rules.push({ id: (id ?? parameterId)!, path: `${nodePath}.args` })
      }
      if (name === 'addStatusEffectById' || name === 'status.apply-piece' || name === 'status.apply-player') {
        const args = Array.isArray(node.args) ? node.args : []
        const object = args.map(graphObject).find((item): item is JsonRecord => !!item)
        const parameters = record(node.parameters) ? node.parameters : undefined
        const definition = object ?? (parameters ? cloneRecord(parameters) : {})
        const id = asString(definition.id)
          ?? asString(definition.type)
          ?? (parameters ? asString(parameters.statusId) : undefined)
        const type = asString(definition.type) ?? (parameters ? asString(parameters.statusType) : undefined)
        if (id || type) {
          const relatedRules = asStringList(definition.relatedRules)
          statuses.push({
            id: id ?? type!,
            definition: { ...definition, ...(type && !definition.type ? { type } : {}) },
            path: nodePath,
            relatedRules,
          })
        }
      }
      // `queue.summon` is intentionally not interpreted: summon templates are
      // author data, while arbitrary object literals are not stable ownership.
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'code' || key === 'skillCode' || key === 'effectCode' || key === 'source') continue
      if (key === 'kind' || key === 'capability' || key === 'module' || key === 'parameters' || key === 'args') {
        // args and parameters are inspected above but still recurse for nested
        // status/rule calls inside them.
      }
      visit(child, `${nodePath}.${key}`)
    }
  }
  visit(value, path)
  return { rules, statuses }
}

function collectSemanticGraphEvidence(value: unknown, path: string): LegacyEvidence {
  const rules: { id: string; path: string }[] = []
  const statuses: { id: string; definition: JsonRecord; path: string; relatedRules: readonly string[] }[] = []
  const inspectGraph = (graph: JsonRecord, graphPath: string): void => {
    const composites = new Map<string, { value: JsonRecord; path: string }>()
    if (Array.isArray(graph.composites)) graph.composites.forEach((entry, index) => {
      if (record(entry)) composites.set(`${entry.id}@${entry.version}`, { value: entry, path: `${graphPath}.composites[${index}]` })
    })
    const usedContinuations = new Set<string>()
    const inspectBody = (body: unknown, bodyPath: string, stack = new Set<string>()): void => {
      const base = collectLegacyGraphEvidence(body, bodyPath)
      rules.push(...base.rules); statuses.push(...base.statuses)
      const records = new Map<string, JsonRecord>()
      const calls: Array<{ node: JsonRecord; path: string }> = []
      const walk = (node: unknown, nodePath: string): void => {
        if (Array.isArray(node)) { node.forEach((child, index) => walk(child, `${nodePath}[${index}]`)); return }
        if (!record(node)) return
        if (node.kind === 'record.create' && typeof node.id === 'string' && record(node.fields)) records.set(node.id, node.fields)
        if (node.kind === 'call') calls.push({ node, path: nodePath })
        if (node.kind === 'defer-choice' && typeof node.graph === 'string') usedContinuations.add(node.graph)
        for (const [key, child] of Object.entries(node)) walk(child, `${nodePath}.${key}`)
      }
      walk(body, bodyPath)
      for (const call of calls) {
        const compositeKey = `${call.node.module}@${call.node.version}`
        const composite = composites.get(compositeKey)
        if (composite && !stack.has(compositeKey)) {
          const inputs = record(call.node.inputs) ? call.node.inputs : {}
          const bindLiterals = (value: unknown): unknown => {
            if (Array.isArray(value)) return value.map(bindLiterals)
            if (!record(value)) return value
            if (value.kind === 'input' && typeof value.name === 'string') {
              const bound = inputs[value.name]
              if (record(bound) && bound.kind === 'literal') return cloneJson(bound)
            }
            return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, bindLiterals(child)]))
          }
          inspectBody(bindLiterals(composite.value.body), `${composite.path}.body`, new Set([...stack, compositeKey]))
        }
        if (!['status.apply-record', 'status.apply-player-record'].includes(String(call.node.module))) continue
        const input = record(call.node.inputs) ? call.node.inputs.record : undefined
        if (!record(input) || input.kind !== 'output' || input.port !== 'value' || typeof input.node !== 'string') continue
        const fields = records.get(input.node)
        if (!fields) continue
        const definition: JsonRecord = {}
        for (const [key, field] of Object.entries(fields)) if (record(field) && field.kind === 'literal') definition[key] = cloneJson(field.value)
        const id = asString(definition.id) ?? asString(definition.type)
        if (!id) continue
        statuses.push({ id, definition, path: call.path, relatedRules: asStringList(definition.relatedRules) })
      }
    }
    inspectBody(graph.body, `${graphPath}.body`)
    if (Array.isArray(graph.continuations)) graph.continuations.forEach((continuation, index) => {
      if (record(continuation) && typeof continuation.id === 'string' && (usedContinuations.has(continuation.id) || usedContinuations.has(`${continuation.id}@${continuation.version}`)) && record(continuation.graph)) inspectGraph(continuation.graph, `${graphPath}.continuations[${index}].graph`)
    })
  }
  if (record(value) && record(value.entries)) for (const [field, entry] of Object.entries(value.entries)) {
    if (record(entry) && record(entry.graph) && field !== 'previewCode') inspectGraph(entry.graph, `${path}.entries.${field}.graph`)
  }
  return { rules, statuses }
}

function explicitRuleValues(value: unknown, basePath: string): Array<{ id: string; path: string }> {
  const output: Array<{ id: string; path: string }> = []
  const add = (candidate: unknown, path: string) => asStringList(candidate).forEach(id => output.push({ id, path }))
  if (record(value)) {
    for (const field of ['relatedRules', 'rules', 'playerRules']) {
      if (own(value, field)) add(value[field], `${basePath}.${field}`)
    }
    if (record(value.statusTag)) {
      add(value.statusTag.rule, `${basePath}.statusTag.rule`)
      add(value.statusTag.relatedRules, `${basePath}.statusTag.relatedRules`)
    }
    if (record(value.summonCapability)) {
      add(value.summonCapability.rules, `${basePath}.summonCapability.rules`)
      if (record(value.summonCapability.status)) add(value.summonCapability.status.relatedRules, `${basePath}.summonCapability.status.relatedRules`)
      if (record(value.summonCapability.fallback)) add(value.summonCapability.fallback.rules, `${basePath}.summonCapability.fallback.rules`)
    }
  }
  return output
}

function explicitClusterLinks(value: unknown, basePath: string): Array<{ link: SkillClusterLink; path: string }> {
  if (!record(value)) return []
  const cluster = record(value.cluster) ? value.cluster : undefined
  const linksValue = cluster && Array.isArray(cluster.links)
    ? cluster.links
    : Array.isArray(value.clusterLinks) ? value.clusterLinks : []
  const output: Array<{ link: SkillClusterLink; path: string }> = []
  linksValue.forEach((candidate: unknown, index: number) => {
    if (!record(candidate)) return
    const collection = candidate.collection
    const id = asString(candidate.id)
    const relation = candidate.relation
    if ((collection !== 'skills' && collection !== 'pieces' && collection !== 'rules' && collection !== 'cards') || !id || (relation !== 'owned' && relation !== 'shared' && relation !== 'related')) return
    output.push({
      link: {
        collection,
        id,
        relation,
        ...(typeof candidate.source === 'string' ? { source: candidate.source } : {}),
      },
      path: `${basePath}.${cluster && Array.isArray(cluster.links) ? 'cluster.links' : 'clusterLinks'}[${index}]`,
    })
  })
  return output
}

function persistedClusterDiagnostics(
  value: unknown,
  expectedId: string,
  path: string,
): SkillClusterDiagnostic[] {
  if (value === undefined) return []
  if (!record(value)) return [diagnostic('invalid-definition', 'persisted cluster metadata must be an object', path)]
  const output: SkillClusterDiagnostic[] = []
  if (value.version !== SKILL_CLUSTER_DEFINITION_VERSION) output.push(diagnostic('invalid-definition', 'unsupported persisted cluster version', `${path}.version`))
  if (value.id !== expectedId) output.push(diagnostic('invalid-definition', `persisted cluster id must be "${expectedId}"`, `${path}.id`))
  if (!Array.isArray(value.links)) {
    output.push(diagnostic('invalid-reference', 'persisted cluster links must be an array', `${path}.links`))
    return output
  }
  value.links.forEach((candidate: unknown, index: number) => {
    const linkPath = `${path}.links[${index}]`
    if (!record(candidate)) {
      output.push(diagnostic('invalid-reference', 'Cluster link must be an object', linkPath))
      return
    }
    if (candidate.collection !== 'skills' && candidate.collection !== 'pieces' && candidate.collection !== 'rules' && candidate.collection !== 'cards') output.push(diagnostic('invalid-reference', 'Cluster link has an invalid collection', `${linkPath}.collection`))
    if (!asString(candidate.id)) output.push(diagnostic('invalid-reference', 'Cluster link needs an id', `${linkPath}.id`))
    if (candidate.relation !== 'owned' && candidate.relation !== 'shared' && candidate.relation !== 'related') output.push(diagnostic('invalid-reference', 'Cluster link has an invalid relation', `${linkPath}.relation`))
    if (candidate.source !== undefined && typeof candidate.source !== 'string') output.push(diagnostic('invalid-reference', 'Cluster link source must be text', `${linkPath}.source`))
  })
  return output
}

function explicitSkillValues(value: unknown, basePath: string): Array<{ id: string; path: string }> {
  const output: Array<{ id: string; path: string }> = []
  if (!record(value)) return output
  if (record(value.effect) && value.effect.type === 'triggerSkill' && asString(value.effect.skillId)) {
    output.push({ id: value.effect.skillId as string, path: `${basePath}.effect.skillId` })
  }
  for (const field of ['skills', 'skillIds']) {
    if (own(value, field)) {
      const raw = value[field]
      if (Array.isArray(raw)) raw.forEach((entry, index) => {
        const id = typeof entry === 'string' ? entry : record(entry) ? asString(entry.skillId) : undefined
        if (id) output.push({ id, path: `${basePath}.${field}[${index}]` })
      })
    }
  }
  const summonCapability = record(value.summonCapability) ? value.summonCapability : undefined
  const fallback = summonCapability && record(summonCapability.fallback) ? summonCapability.fallback : undefined
  if (fallback) {
    if (Array.isArray(fallback.skills)) fallback.skills.forEach((entry: unknown, index: number) => {
      const id = typeof entry === 'string' ? entry : record(entry) ? asString(entry.skillId) : undefined
      if (id) output.push({ id, path: `${basePath}.summonCapability.fallback.skills[${index}]` })
    })
  }
  return output
}

function explicitCardValues(value: unknown, basePath: string): Array<{ id: string; path: string }> {
  if (!record(value)) return []
  const output: Array<{ id: string; path: string }> = []
  for (const field of ['relatedCards', 'cardIds']) {
    if (!own(value, field)) continue
    asStringList(value[field]).forEach(id => output.push({ id, path: `${basePath}.${field}` }))
  }
  return output
}

/**
 * A gameplayModules object is semantic evidence only when it owns a valid
 * runtime entry for the definition.  A preview-only entry deliberately does
 * not establish semantic coverage for a skill's executable behavior.
 */
function hasValidatedSemanticRuntime(value: JsonRecord, collection: 'skills' | 'rules'): boolean {
  const document = value.gameplayModules
  if (!record(document) || document.version !== GAMEPLAY_MODULE_DOCUMENT_VERSION || !record(document.entries)) return false
  const runtimeFields = (collection === 'rules' ? ['skillCode', 'code'] : ['code', 'skillCode']).filter(field => typeof value[field] === 'string' && value[field] !== '')
  if (!runtimeFields.length) return false
  const fields = [...runtimeFields, ...['previewCode', 'effectCode'].filter(field => typeof value[field] === 'string' && value[field] !== '')]
  for (const field of fields) {
    const entry = document.entries[field]
    if (!record(entry) || entry.compilerVersion !== GAMEPLAY_MODULE_COMPILER_VERSION || !record(entry.graph)) return false
    const graph = entry.graph
    if (graph.version !== GAMEPLAY_MODULE_GRAPH_VERSION || !Array.isArray(graph.body)) return false
    // Unsaved drafts have not passed admission. Never advertise completeness
    // from a version label alone, stale generated source, or an unknown node.
    try {
      const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
      if (compiled.code !== value[field]) return false
      if (field === 'previewCode' ? compiled.surface !== 'preview' : field === 'effectCode' ? compiled.surface !== 'pending' : collection === 'rules' ? compiled.surface !== 'rule' : !['skill', 'triggerSkill'].includes(compiled.surface)) return false
    } catch {
      // Invalid authoring drafts remain editable and explicitly uncovered;
      // the normal document validator reports the detailed compiler error.
      return false
    }
  }
  return true
}

function inlineStatuses(value: unknown, basePath: string): Array<{ definition: JsonRecord; path: string; evidence: SkillClusterEvidence }> {
  if (!record(value)) return []
  const output: Array<{ definition: JsonRecord; path: string; evidence: SkillClusterEvidence }> = []
  if (record(value.statusTag)) output.push({ definition: cloneRecord(value.statusTag), path: `${basePath}.statusTag`, evidence: 'inline' })
  const summonCapability = record(value.summonCapability) ? value.summonCapability : undefined
  if (summonCapability && record(summonCapability.status)) output.push({ definition: cloneRecord(summonCapability.status), path: `${basePath}.summonCapability.status`, evidence: 'inline' })
  if (own(value, 'initialStatusTags')) {
    const tags = Array.isArray(value.initialStatusTags) ? value.initialStatusTags : [value.initialStatusTags]
    tags.forEach((tag, index) => {
      if (record(tag)) output.push({ definition: cloneRecord(tag), path: `${basePath}.initialStatusTags${Array.isArray(value.initialStatusTags) ? `[${index}]` : ''}`, evidence: 'inline' })
    })
  }
  return output
}

function memberId(definition: JsonRecord, path: string, diagnostics: SkillClusterDiagnostic[]): string | undefined {
  const id = asString(definition.id) ?? asString(definition.type)
  if (!id) diagnostics.push(diagnostic('invalid-reference', 'status evidence requires an id or type', path))
  return id
}

function statusMember(
  members: Map<string, MutableMember>,
  diagnostics: SkillClusterDiagnostic[],
  status: { definition: JsonRecord; path: string; evidence: SkillClusterEvidence },
  sourceCollection: 'skills' | 'pieces' | 'rules',
  sourceId: string,
  sourceField: string,
  role: SkillClusterMemberRole,
  editable: boolean,
): void {
  const id = memberId(status.definition, status.path, diagnostics)
  if (!id) return
  addMember(members, diagnostics, {
    kind: 'status',
    id,
    role,
    provenance: makeLocation(sourceCollection, sourceId, sourceField, status.path),
    evidence: status.evidence,
    editable: editable && status.evidence !== 'generated' && status.evidence !== 'compatibility',
    definition: status.definition,
  })
}

function mapOverrides(options: SkillClusterBuildOptions | undefined, skillId: string): SkillClusterMappingOverride[] {
  const output: SkillClusterMappingOverride[] = []
  const mappingOverrides = options?.mappingOverrides
  if (Array.isArray(mappingOverrides)) {
    for (const item of mappingOverrides) if (item.skillId === skillId) output.push(item)
  } else if (mappingOverrides && record(mappingOverrides)) {
    const entries = mappingOverrides[skillId]
    const values = Array.isArray(entries) ? entries : entries ? [entries] : []
    for (const item of values) output.push(item.skillId === skillId ? item : { ...item, skillId })
  }
  for (const item of options?.skillRuleMappings?.[skillId] ?? []) {
    if (item.skillId === skillId) output.push(item)
    else output.push({ ...item, skillId })
  }
  return output
}

function coverageFor(
  members: readonly SkillClusterMember[],
  source: 'semantic' | 'compatibility' | 'declarative',
  rootCovered: boolean,
  hasErrors: boolean,
): SkillClusterCoverage {
  const eligible = members.filter(member => {
    if (source === 'semantic') return member.evidence === 'semantic'
    if (source === 'compatibility') return member.evidence === 'compatibility' || member.evidence === 'generated'
    return member.evidence === 'explicit' || member.evidence === 'inline' || member.evidence === 'declarative'
  })
  const generated = members.filter(member => member.evidence === 'generated').length
  const editable = members.filter(member => member.editable).length
  const total = members.length
  const complete = eligible.length
  const partial = source === 'compatibility' ? generated : Math.max(0, eligible.length - (rootCovered ? eligible.length : 0))
  const missing = Math.max(0, total - eligible.length)
  const status: SkillClusterCoverageStatus = !rootCovered && !eligible.length
    ? 'missing'
    : rootCovered && !hasErrors && (total === 0 || eligible.length === total)
      ? 'complete'
      : 'partial'
  return { status, total, covered: eligible.length, complete, partial, missing, generated, editable }
}

function validateCatalogShape(catalog: SkillClusterCatalogInput): { indexes: Record<CatalogCollection, IndexedCatalog>; diagnostics: SkillClusterDiagnostic[] } {
  const diagnostics: SkillClusterDiagnostic[] = []
  const indexes = {} as Record<CatalogCollection, IndexedCatalog>
  for (const collection of collections) {
    indexes[collection] = indexCollection(catalog, collection)
    diagnostics.push(...indexes[collection].diagnostics)
  }
  return { indexes, diagnostics }
}

function buildDefinition(
  catalog: SkillClusterCatalogInput,
  root: SkillClusterRoot,
  options: SkillClusterBuildOptions | undefined,
): SkillClusterDefinition {
  const shape = validateCatalogShape(catalog)
  const diagnostics: SkillClusterDiagnostic[] = [...shape.diagnostics]
  const rootField = root?.field
  if (!root || (root.collection !== 'skills' && root.collection !== 'pieces') || !asString(root.id)) {
    diagnostics.push(diagnostic('invalid-root', 'Cluster root must contain collection and id'))
  }
  if (rootField !== undefined && !pathSegments(rootField)) diagnostics.push(diagnostic('unsafe-field-path', 'Cluster root field must be a safe dot path', 'root.field'))
  const normalizedRoot: SkillClusterRoot = {
    collection: root?.collection === 'pieces' ? 'pieces' : 'skills',
    id: asString(root?.id) ?? '',
    ...(rootField !== undefined ? { field: rootField } : {}),
  }
  const rootCollection = normalizedRoot.collection
  const rootIndex = shape.indexes[rootCollection]
  const rootKey = rootIndex?.byId.get(normalizedRoot.id)
  const rootEntry = rootKey ? rootIndex.entries[rootKey] : undefined
  if (!rootEntry) diagnostics.push(diagnostic('missing-root', `missing ${rootCollection} root "${normalizedRoot.id}"`, 'root.id', undefined, normalizedRoot.id))
  if (rootCollection === 'skills' && rootEntry && rootEntry.kind !== 'active' && rootEntry.kind !== 'passive') {
    diagnostics.push(diagnostic('invalid-definition', `skill "${normalizedRoot.id}" must declare kind active or passive`, `skills.${rootKey ?? normalizedRoot.id}.kind`))
  }

  const members = createMembers()
  const active = rootCollection === 'skills' && rootEntry?.kind === 'active'
  const kind: SkillClusterKind = rootCollection === 'pieces' ? 'passive' : active ? 'active' : 'passive'
  let semanticRoot = false
  let compatibilityRoot = false
  let declarativeRoot = !!rootEntry
  const visiting = new Set<string>()
  const visited = new Set<string>()

  const addDefinitionMember = (
    memberKind: SkillClusterMemberKind,
    id: string,
    role: SkillClusterMemberRole,
    sourceCollection: 'skills' | 'pieces' | 'rules' | 'cards',
    sourceId: string,
    sourceField: string,
    path: string,
    definition: JsonRecord,
    evidence: SkillClusterEvidence,
    editable: boolean,
    relation?: SkillClusterLinkRelation,
  ): MutableMember => {
    // The first source points at the referenced definition so editor
    // navigation opens the member itself.  The second location retains the
    // declaration that established the relationship.
    const target = makeLocation(sourceCollection, sourceId, sourceField, `${sourceCollection}.${sourceId}`)
    const origin = makeLocation(sourceCollection, sourceId, sourceField, path)
    const provenance = target.path === origin.path ? target : [target, origin]
    return addMember(members, diagnostics, {
      kind: memberKind,
      id,
      role,
      provenance,
      evidence,
      editable,
      ...(relation ? { relation } : {}),
      definition,
    })
  }

  const addRule = (ruleId: string, source: SkillClusterReferenceLocation, role: SkillClusterMemberRole, evidence: SkillClusterEvidence, editable: boolean, relation?: SkillClusterLinkRelation): void => {
    const index = shape.indexes.rules
    const key = index.byId.get(ruleId)
    const definition = key ? index.entries[key] : undefined
    if (!definition || !key) {
      diagnostics.push(diagnostic('missing-reference', `missing rule "${ruleId}"`, source.path, source, ruleId))
      return
    }
    const resolvedKey = key
    diagnostics.push(...persistedClusterDiagnostics(definition.cluster, `rules:${ruleId}`, `rules.${resolvedKey}.cluster`))
    const existing = addDefinitionMember('rule', ruleId, role, 'rules', resolvedKey, 'rule', source.path, definition, evidence, editable, relation)
    // A rule can explicitly refer to another rule or status.  The visit guard
    // is keyed by kind so shared dependencies and cycles are both safe.
    const keyForVisit = memberKey('rule', ruleId)
    if (visiting.has(keyForVisit)) {
      diagnostics.push(diagnostic('cycle', `cycle while resolving rule "${ruleId}"`, source.path, source, ruleId))
      return
    }
    if (visited.has(keyForVisit)) return
    visiting.add(keyForVisit)
    const fieldPathRoot = `rules.${resolvedKey}`
    for (const ref of explicitSkillValues(definition, fieldPathRoot)) addSkill(ref.id, makeLocation('rules', resolvedKey, 'rule', ref.path), 'dependency', 'explicit', true)
    for (const ref of explicitRuleValues(definition, fieldPathRoot)) {
      addRule(ref.id, makeLocation('rules', resolvedKey, 'rule', ref.path), 'dependency', 'explicit', true)
    }
    for (const status of inlineStatuses(definition, fieldPathRoot)) {
      statusMember(members, diagnostics, status, 'rules', resolvedKey, 'rule', 'dependency', true)
      const related = asStringList(status.definition.relatedRules)
      related.forEach(id => addRule(id, makeLocation('rules', resolvedKey, 'rule', status.path), 'dependency', 'explicit', true))
    }
    if (hasValidatedSemanticRuntime(definition, 'rules')) {
      const modules = collectSemanticGraphEvidence(definition.gameplayModules, `${fieldPathRoot}.gameplayModules`)
      for (const ref of modules.rules) addRule(ref.id, makeLocation('rules', resolvedKey, 'rule', ref.path), 'dependency', 'semantic', true)
      for (const status of modules.statuses) {
        statusMember(members, diagnostics, { definition: status.definition, path: status.path, evidence: 'semantic' }, 'rules', resolvedKey, 'rule', 'dependency', false)
        status.relatedRules.forEach(id => addRule(id, makeLocation('rules', resolvedKey, 'rule', status.path), 'dependency', 'semantic', true))
      }
    }
    const legacy = collectLegacyGraphEvidence(definition.contentGraph, `${fieldPathRoot}.contentGraph`)
    if (legacy.rules.length || legacy.statuses.length || definition.skillCode) compatibilityRoot = true
    for (const ref of legacy.rules) addRule(ref.id, makeLocation('rules', resolvedKey, 'rule', ref.path), 'related', 'generated', false)
    for (const status of legacy.statuses) {
      statusMember(members, diagnostics, { definition: status.definition, path: status.path, evidence: 'generated' }, 'rules', resolvedKey, 'rule', 'related', false)
      status.relatedRules.forEach(id => addRule(id, makeLocation('rules', resolvedKey, 'rule', status.path), 'related', 'generated', false))
    }
    visited.add(keyForVisit)
    visiting.delete(keyForVisit)
    void existing
  }

  const addSkill = (skillId: string, source: SkillClusterReferenceLocation, role: SkillClusterMemberRole, evidence: SkillClusterEvidence, editable: boolean, relation?: SkillClusterLinkRelation): void => {
    const index = shape.indexes.skills
    const key = index.byId.get(skillId)
    const definition = key ? index.entries[key] : undefined
    if (!definition || !key) {
      diagnostics.push(diagnostic('missing-reference', `missing skill "${skillId}"`, source.path, source, skillId))
      return
    }
    const resolvedKey = key
    diagnostics.push(...persistedClusterDiagnostics(definition.cluster, `skills:${skillId}`, `skills.${resolvedKey}.cluster`))
    addDefinitionMember('skill', skillId, role, 'skills', resolvedKey, 'skill', source.path, definition, evidence, editable, relation)
    const keyForVisit = memberKey('skill', skillId)
    if (visiting.has(keyForVisit)) {
      diagnostics.push(diagnostic('cycle', `cycle while resolving skill "${skillId}"`, source.path, source, skillId))
      return
    }
    if (visited.has(keyForVisit)) return
    visiting.add(keyForVisit)
    const fieldPathRoot = `skills.${resolvedKey}`
    const semantic = hasValidatedSemanticRuntime(definition, 'skills')
    if (semantic) semanticRoot = true
    if (typeof definition.code === 'string' || typeof definition.skillCode === 'string' || record(definition.contentGraph)) compatibilityRoot = true
    for (const ref of explicitRuleValues(definition, fieldPathRoot)) {
      addRule(ref.id, makeLocation('skills', resolvedKey, 'skill', ref.path), 'dependency', 'explicit', true)
    }
    for (const { link, path } of explicitClusterLinks(definition, fieldPathRoot)) {
      const location = makeLocation('skills', resolvedKey, 'skill', link.source ? `${path}.source:${link.source}` : path)
      const role: SkillClusterMemberRole = link.relation === 'related' ? 'related' : 'dependency'
      if (link.collection === 'rules') addRule(link.id, location, role, 'explicit', true, link.relation)
      else if (link.collection === 'skills') addSkill(link.id, location, role, 'explicit', true, link.relation)
      else if (link.collection === 'pieces') addPiece(link.id, location, role, 'explicit', true, link.relation)
      else {
        const cardKey = shape.indexes.cards.byId.get(link.id)
        if (!cardKey) diagnostics.push(diagnostic('missing-reference', `missing card "${link.id}"`, path, location, link.id))
        else addDefinitionMember('card', link.id, role, 'cards', cardKey, 'card', path, shape.indexes.cards.entries[cardKey], 'explicit', true, link.relation)
      }
    }
    for (const status of inlineStatuses(definition, fieldPathRoot)) {
      statusMember(members, diagnostics, status, 'skills', resolvedKey, 'skill', 'dependency', true)
      asStringList(status.definition.relatedRules).forEach(id => addRule(id, makeLocation('skills', resolvedKey, 'skill', status.path), 'dependency', 'explicit', true))
    }
    for (const ref of explicitSkillValues(definition, fieldPathRoot)) addSkill(ref.id, makeLocation('skills', resolvedKey, 'skill', ref.path), 'dependency', 'explicit', true)
    for (const ref of explicitCardValues(definition, fieldPathRoot)) {
      const cardIndex = shape.indexes.cards
      const cardKey = cardIndex.byId.get(ref.id)
      if (!cardKey) diagnostics.push(diagnostic('missing-reference', `missing card "${ref.id}"`, ref.path, makeLocation('skills', resolvedKey, 'skill', ref.path), ref.id))
      else addDefinitionMember('card', ref.id, 'dependency', 'cards', cardKey, 'card', ref.path, cardIndex.entries[cardKey], 'explicit', true)
    }
    if (hasValidatedSemanticRuntime(definition, 'skills')) {
      const modules = collectSemanticGraphEvidence(definition.gameplayModules, `${fieldPathRoot}.gameplayModules`)
      for (const ref of modules.rules) addRule(ref.id, makeLocation('skills', resolvedKey, 'skill', ref.path), 'dependency', 'semantic', true)
      for (const status of modules.statuses) {
        statusMember(members, diagnostics, { definition: status.definition, path: status.path, evidence: 'semantic' }, 'skills', resolvedKey, 'skill', 'dependency', false)
        status.relatedRules.forEach(id => addRule(id, makeLocation('skills', resolvedKey, 'skill', status.path), 'dependency', 'semantic', true))
      }
    }
    const legacy = collectLegacyGraphEvidence(definition.contentGraph, `${fieldPathRoot}.contentGraph`)
    if (legacy.rules.length || legacy.statuses.length) compatibilityRoot = true
    for (const ref of legacy.rules) addRule(ref.id, makeLocation('skills', resolvedKey, 'skill', ref.path), 'related', 'generated', false)
    for (const status of legacy.statuses) {
      statusMember(members, diagnostics, { definition: status.definition, path: status.path, evidence: 'generated' }, 'skills', resolvedKey, 'skill', 'related', false)
      status.relatedRules.forEach(id => addRule(id, makeLocation('skills', resolvedKey, 'skill', status.path), 'related', 'generated', false))
    }
    visited.add(keyForVisit)
    visiting.delete(keyForVisit)
  }

  const addPiece = (pieceId: string, source: SkillClusterReferenceLocation, role: SkillClusterMemberRole, evidence: SkillClusterEvidence, editable: boolean, relation?: SkillClusterLinkRelation): void => {
    const index = shape.indexes.pieces
    const key = index.byId.get(pieceId)
    const definition = key ? index.entries[key] : undefined
    if (!definition || !key) {
      diagnostics.push(diagnostic('missing-reference', `missing piece "${pieceId}"`, source.path, source, pieceId))
      return
    }
    const resolvedKey = key
    diagnostics.push(...persistedClusterDiagnostics(definition.cluster, `pieces:${pieceId}`, `pieces.${resolvedKey}.cluster`))
    addDefinitionMember('piece', pieceId, role, 'pieces', resolvedKey, 'piece', source.path, definition, evidence, editable, relation)
    const keyForVisit = memberKey('piece', pieceId)
    if (visiting.has(keyForVisit)) {
      diagnostics.push(diagnostic('cycle', `cycle while resolving piece "${pieceId}"`, source.path, source, pieceId))
      return
    }
    if (visited.has(keyForVisit)) return
    visiting.add(keyForVisit)
    const fieldPathRoot = `pieces.${resolvedKey}`
    if (typeof definition.rules === 'string' || Array.isArray(definition.rules) || definition.playerRules !== undefined || definition.initialStatusTags !== undefined) declarativeRoot = true
    for (const ref of explicitRuleValues(definition, fieldPathRoot)) addRule(ref.id, makeLocation('pieces', resolvedKey, 'piece', ref.path), 'dependency', 'explicit', true)
    for (const { link, path } of explicitClusterLinks(definition, fieldPathRoot)) {
      const location = makeLocation('pieces', resolvedKey, 'piece', link.source ? `${path}.source:${link.source}` : path)
      const linkedRole: SkillClusterMemberRole = link.relation === 'related' ? 'related' : 'dependency'
      if (link.collection === 'rules') addRule(link.id, location, linkedRole, 'explicit', true, link.relation)
      else if (link.collection === 'skills') addSkill(link.id, location, linkedRole, 'explicit', true, link.relation)
      else if (link.collection === 'pieces') addPiece(link.id, location, linkedRole, 'explicit', true, link.relation)
      else {
        const cardKey = shape.indexes.cards.byId.get(link.id)
        if (!cardKey) diagnostics.push(diagnostic('missing-reference', `missing card "${link.id}"`, path, location, link.id))
        else addDefinitionMember('card', link.id, linkedRole, 'cards', cardKey, 'card', path, shape.indexes.cards.entries[cardKey], 'explicit', true, link.relation)
      }
    }
    for (const status of inlineStatuses(definition, fieldPathRoot)) {
      statusMember(members, diagnostics, status, 'pieces', resolvedKey, 'piece', 'dependency', true)
      asStringList(status.definition.relatedRules).forEach(id => addRule(id, makeLocation('pieces', resolvedKey, 'piece', status.path), 'dependency', 'explicit', true))
    }
    for (const ref of explicitSkillValues(definition, fieldPathRoot)) addSkill(ref.id, makeLocation('pieces', resolvedKey, 'piece', ref.path), 'related', 'explicit', true)
    for (const ref of explicitCardValues(definition, fieldPathRoot)) {
      const cardIndex = shape.indexes.cards
      const cardKey = cardIndex.byId.get(ref.id)
      if (!cardKey) diagnostics.push(diagnostic('missing-reference', `missing card "${ref.id}"`, ref.path, makeLocation('pieces', resolvedKey, 'piece', ref.path), ref.id))
      else addDefinitionMember('card', ref.id, 'dependency', 'cards', cardKey, 'card', ref.path, cardIndex.entries[cardKey], 'explicit', true)
    }
    visited.add(keyForVisit)
    visiting.delete(keyForVisit)
  }

  if (rootEntry) {
    const rootLocation = makeLocation(rootCollection, rootKey ?? normalizedRoot.id, rootCollection === 'skills' ? 'skill' : 'piece', rootField ? `root.${rootField}` : 'root')
    if (rootCollection === 'skills') addSkill(normalizedRoot.id, rootLocation, 'root', hasValidatedSemanticRuntime(rootEntry, 'skills') ? 'semantic' : 'declarative', true)
    else addPiece(normalizedRoot.id, rootLocation, 'root', 'declarative', true)
    if (rootField) {
      const selected = readPath(rootEntry, rootField)
      if (!selected.found) diagnostics.push(diagnostic('missing-field', `missing root field "${rootField}"`, `root.field`))
    }
  }

  if (rootCollection === 'skills') {
    for (const override of mapOverrides(options, normalizedRoot.id)) {
      const pieceKey = shape.indexes.pieces.byId.get(override.pieceId)
      if (!pieceKey) {
        diagnostics.push(diagnostic('missing-reference', `mapping override references missing piece "${override.pieceId}"`, 'options.mappingOverrides', undefined, override.pieceId))
        continue
      }
      addDefinitionMember('piece', override.pieceId, 'related', 'pieces', pieceKey, 'piece', `options.mappingOverrides.${override.skillId}.${override.pieceId}`, shape.indexes.pieces.entries[pieceKey], 'explicit', false)
      const piece = shape.indexes.pieces.entries[pieceKey]
      const declared = asStringList(piece.rules)
      const requested = override.ruleIds ?? override.rules
      const ids = requested ? [...requested] : declared
      for (const id of ids) addRule(id, makeLocation('pieces', pieceKey, 'piece', `options.mappingOverrides.${override.skillId}.${override.pieceId}.ruleIds`), 'related', 'explicit', false)
      if (requested) {
        const declaredSet = new Set(declared)
        for (const id of requested) if (!declaredSet.has(id)) diagnostics.push(diagnostic('invalid-reference', `mapping override rule "${id}" is not declared by piece "${override.pieceId}"`, 'options.mappingOverrides', undefined, id))
      }
    }
  }

  const allMembers: SkillClusterMember[] = [...members.values()].map(item => ({
    kind: item.kind,
    id: item.id,
    role: item.role,
    ...(item.relation ? { relation: item.relation } : {}),
    provenance: item.provenance.map(location => ({ ...location })),
    ...(item.provenance[0] ? { source: { ...item.provenance[0] } } : {}),
    evidence: item.evidence,
    editable: item.editable && item.evidence !== 'compatibility' && item.evidence !== 'generated',
    definition: cloneRecord(item.definition),
    execution: 'reference-only' as const,
  }))
  const buckets = {} as { -readonly [K in keyof Omit<SkillClusterMembers, 'all' | 'statusTags'>]: SkillClusterMember[] }
  for (const bucket of ['skills', 'pieces', 'rules', 'statuses', 'cards', 'continuations', 'presentations'] as const) buckets[bucket] = allMembers.filter(item => memberBucket(item.kind) === bucket)
  const grouped: SkillClusterMembers = { ...buckets, statusTags: buckets.statuses, all: allMembers }
  const hasErrors = diagnostics.some(item => item.severity === 'error')
  const semantic = coverageFor(allMembers, 'semantic', semanticRoot, hasErrors)
  const compatibility = coverageFor(allMembers, 'compatibility', compatibilityRoot, hasErrors)
  const declarative = coverageFor(allMembers, 'declarative', declarativeRoot, hasErrors)
  const metadata = options?.metadata === undefined ? undefined : cloneRecord(options.metadata)
  return {
    version: SKILL_CLUSTER_DEFINITION_VERSION,
    id: normalizedRoot.id,
    clusterId: `${normalizedRoot.collection}:${normalizedRoot.id}`,
    kind,
    root: normalizedRoot,
    members: grouped,
    diagnostics,
    coverage: { semantic, compatibility, declarative },
    semanticCoverage: semantic,
    compatibilityCoverage: compatibility,
    declarativeCoverage: declarative,
    execution: 'reference-only',
    ...(metadata ? { metadata } : {}),
  }
}

/** Build one immutable-by-convention Cluster view without changing the catalog. */
export function buildSkillCluster(
  catalog: SkillClusterCatalogInput,
  root: SkillClusterRoot,
  options?: SkillClusterBuildOptions,
): SkillClusterDefinition {
  return buildDefinition(catalog, root, options)
}

/** Build skill and independent piece-rule passive roots from the same catalog. */
export function buildSkillClusterCatalog(
  catalog: SkillClusterCatalogInput,
  options?: SkillClusterBuildOptions,
): SkillClusterCatalogResult {
  const shape = validateCatalogShape(catalog)
  const roots: SkillClusterRoot[] = []
  for (const id of Object.keys(shape.indexes.skills.entries)) roots.push({ collection: 'skills', id })
  for (const id of Object.keys(shape.indexes.pieces.entries)) roots.push({ collection: 'pieces', id })
  const clusters = roots.map(root => buildDefinition(catalog, root, options))
  const diagnostics = [...shape.diagnostics, ...clusters.flatMap(cluster => cluster.diagnostics.filter(item => item.code !== 'key-mismatch' && item.code !== 'duplicate-id' && item.code !== 'invalid-catalog'))]
  return { version: SKILL_CLUSTER_DEFINITION_VERSION, clusters, definitions: clusters, diagnostics }
}

/**
 * Validate a persisted/view definition while preserving unknown metadata.
 * This checks the stable envelope only; it never strips fields or mutates the
 * supplied value.
 */
export function validateSkillClusterDefinition(value: unknown): readonly SkillClusterDiagnostic[] {
  const diagnostics: SkillClusterDiagnostic[] = []
  if (!record(value)) return [diagnostic('invalid-definition', 'Cluster definition must be an object')]
  if (value.version !== SKILL_CLUSTER_DEFINITION_VERSION) diagnostics.push(diagnostic('invalid-definition', 'unsupported Cluster definition version', 'version'))
  if (!asString(value.id) || !asString(value.clusterId)) diagnostics.push(diagnostic('invalid-definition', 'Cluster definition needs id and clusterId', 'id'))
  if (!record(value.root) || (value.root.collection !== 'skills' && value.root.collection !== 'pieces') || !asString(value.root.id)) diagnostics.push(diagnostic('invalid-definition', 'Cluster definition has an invalid root', 'root'))
  else if (value.root.field !== undefined && !pathSegments(value.root.field as string)) diagnostics.push(diagnostic('unsafe-field-path', 'Cluster root field must be a safe dot path', 'root.field'))
  if (!record(value.members)) diagnostics.push(diagnostic('invalid-definition', 'Cluster definition needs members', 'members'))
  if (!record(value.coverage)) diagnostics.push(diagnostic('invalid-definition', 'Cluster definition needs coverage', 'coverage'))
  // Unknown keys, including metadata, are deliberately accepted and left in
  // place so an editor round-trip cannot silently erase future fields.
  return diagnostics
}

/** Validate the small persisted `entry.cluster` envelope used by content data. */
export function validateSkillClusterMetadata(value: unknown, root?: SkillClusterRoot): readonly SkillClusterDiagnostic[] {
  const expectedId = root ? `${root.collection}:${root.id}` : record(value) && typeof value.id === 'string' ? value.id : ''
  return persistedClusterDiagnostics(value, expectedId, 'cluster')
}

/**
 * Validate metadata at a content save/admission boundary.  This intentionally
 * does not resolve links against a catalog; missing targets are reported by
 * the read-only builder so a draft can still be opened for repair.
 */
export function assertSkillClusterMetadata(content: unknown): void {
  if (!record(content) || content.cluster === undefined) return
  const contentId = asString(content.id)
  if (!contentId) throw new Error('Skill cluster metadata: content needs an id')
  const metadata = content.cluster
  const clusterId = record(metadata) ? asString(metadata.id) : undefined
  const expected = clusterId && /^(skills|pieces):[^:]+$/.test(clusterId)
    ? clusterId.split(':', 2)[0] as SkillClusterCollection
    : undefined
  if (!expected || clusterId !== `${expected}:${contentId}`) throw new Error(`Skill cluster metadata: id must be skills:${contentId} or pieces:${contentId}`)
  const diagnostics = persistedClusterDiagnostics(metadata, clusterId, 'cluster')
  const error = diagnostics.find(item => item.severity === 'error')
  if (error) throw new Error(`Skill cluster metadata: ${error.message}${error.path ? ` (${error.path})` : ''}`)
}

/** Copy a definition for an editor draft without dropping unknown metadata. */
export function cloneSkillClusterDefinition(value: SkillClusterDefinition): SkillClusterDefinition {
  return cloneJson(value) as SkillClusterDefinition
}

export default buildSkillCluster
