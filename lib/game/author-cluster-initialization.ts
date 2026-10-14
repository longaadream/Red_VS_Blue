import type { AuthorClusterDefinition } from './author-clusters'

/** Persisted author Cluster envelope used by skill and rule definitions. */
export const AUTHOR_CLUSTER_DEFINITION_VERSION = 'rvb-skill-cluster/v1' as const

export type AuthorClusterInitializationRootKind = 'skill' | 'rule'

export type AuthorClusterInitializationDiagnosticCode =
  | 'invalid-piece-members'
  | 'invalid-cluster-metadata'
  | 'invalid-cluster-link'
  | 'unsupported-cluster-link'
  | 'uninstalled-cluster-link'

export interface AuthorClusterInitializationDiagnostic {
  readonly code: AuthorClusterInitializationDiagnosticCode
  readonly rootKind?: AuthorClusterInitializationRootKind
  readonly rootId?: string
  readonly memberKind?: AuthorClusterInitializationRootKind
  readonly memberId?: string
  readonly path?: string
  readonly message: string
}

/** The only piece fields used by the planner; PieceInstance and templates fit this shape. */
export interface AuthorClusterInitializationPiece {
  readonly skills?: readonly unknown[]
  readonly rules?: readonly unknown[]
}

/** Raw loaded definitions. The planner reads only their persisted Cluster envelope. */
export interface AuthorClusterInitializationCatalog {
  readonly skills?: Readonly<Record<string, unknown>>
  readonly rules?: Readonly<Record<string, unknown>>
}

export interface AuthorClusterInitializationPlan {
  /** Complete skill abilities plus unassigned rule abilities, in piece order. */
  readonly definitions: readonly AuthorClusterDefinition[]
  /** Conservative diagnostics for links intentionally excluded from adoption. */
  readonly diagnostics: readonly AuthorClusterInitializationDiagnostic[]
}

type JsonRecord = Record<string, unknown>
type LinkRelation = 'owned' | 'shared' | 'related'
type LinkCollection = 'skills' | 'rules' | 'pieces' | 'cards'
type InitializationLink = {
  readonly collection: LinkCollection
  readonly id: string
  readonly relation: LinkRelation
}

const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)
const isRecord = (value: unknown): value is JsonRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
)

function diagnostic(
  code: AuthorClusterInitializationDiagnosticCode,
  message: string,
  context: Partial<AuthorClusterInitializationDiagnostic> = {},
): AuthorClusterInitializationDiagnostic {
  return { code, message, ...context }
}

function memberId(value: unknown, kind: AuthorClusterInitializationRootKind): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (!isRecord(value)) return undefined
  const key = kind === 'skill' ? 'skillId' : 'id'
  return typeof value[key] === 'string' && value[key].length > 0 ? value[key] : undefined
}

function directMemberIds(
  values: readonly unknown[] | undefined,
  kind: AuthorClusterInitializationRootKind,
  diagnostics: AuthorClusterInitializationDiagnostic[],
): string[] {
  if (values === undefined) return []
  if (!Array.isArray(values)) {
    diagnostics.push(diagnostic('invalid-piece-members', `Piece ${kind} members must be an array`, { memberKind: kind }))
    return []
  }
  const ids: string[] = []
  const seen = new Set<string>()
  values.forEach((value, index) => {
    const id = memberId(value, kind)
    if (!id) {
      diagnostics.push(diagnostic('invalid-piece-members', `Piece ${kind} member at index ${index} has no ID`, {
        memberKind: kind,
        path: `${kind}[${index}]`,
      }))
      return
    }
    if (!seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  })
  return ids
}

function sourceEntry(
  catalog: AuthorClusterInitializationCatalog,
  kind: AuthorClusterInitializationRootKind,
  id: string,
): JsonRecord | undefined {
  const entries = kind === 'skill' ? catalog.skills : catalog.rules
  if (!entries || !isRecord(entries) || !own(entries, id)) return undefined
  const entry = entries[id]
  return isRecord(entry) ? entry : undefined
}

function explicitLinks(
  entry: JsonRecord | undefined,
  rootKind: AuthorClusterInitializationRootKind,
  rootId: string,
  diagnostics: AuthorClusterInitializationDiagnostic[],
): InitializationLink[] {
  if (!entry || !own(entry, 'cluster')) return []
  const cluster = entry.cluster
  const metadataPath = `${rootKind === 'skill' ? 'skills' : 'rules'}.${rootId}.cluster`
  if (!isRecord(cluster)
    || cluster.version !== AUTHOR_CLUSTER_DEFINITION_VERSION
    || cluster.id !== `${rootKind === 'skill' ? 'skills' : 'rules'}:${rootId}`) {
    diagnostics.push(diagnostic('invalid-cluster-metadata', `Ignoring invalid Cluster metadata for ${rootKind} ${rootId}`, {
      rootKind,
      rootId,
      path: metadataPath,
    }))
    return []
  }
  if (!own(cluster, 'links')) return []
  if (!Array.isArray(cluster.links)) {
    diagnostics.push(diagnostic('invalid-cluster-metadata', `Cluster links for ${rootKind} ${rootId} must be an array`, {
      rootKind,
      rootId,
      path: `${metadataPath}.links`,
    }))
    return []
  }

  const links: InitializationLink[] = []
  cluster.links.forEach((candidate, index) => {
    const path = `${metadataPath}.links[${index}]`
    if (!isRecord(candidate)
      || (candidate.collection !== 'skills' && candidate.collection !== 'rules' && candidate.collection !== 'pieces' && candidate.collection !== 'cards')
      || typeof candidate.id !== 'string'
      || candidate.id.length === 0
      || (candidate.relation !== 'owned' && candidate.relation !== 'shared' && candidate.relation !== 'related')) {
      diagnostics.push(diagnostic('invalid-cluster-link', `Ignoring invalid Cluster link for ${rootKind} ${rootId}`, {
        rootKind,
        rootId,
        path,
      }))
      return
    }
    links.push({
      collection: candidate.collection,
      id: candidate.id,
      relation: candidate.relation,
    })
  })
  return links
}

function appendLinkedMember(
  links: readonly InitializationLink[],
  installedSkills: ReadonlySet<string>,
  installedRules: ReadonlySet<string>,
  rootKind: AuthorClusterInitializationRootKind,
  rootId: string,
  skills: string[],
  rules: string[],
  diagnostics: AuthorClusterInitializationDiagnostic[],
): void {
  links.forEach(link => {
    const pathContext = { rootKind, rootId, memberId: link.id }
    // A related link is an authoring reference, not ownership. Treating it as
    // an adopted member would make remove() erase a member the root never
    // owned, so only explicit owned/shared bundles are runtime members.
    if (link.relation === 'related') {
      diagnostics.push(diagnostic('unsupported-cluster-link', `Skipping non-owning related link ${link.collection}:${link.id}`, pathContext))
      return
    }
    if (link.collection !== 'skills' && link.collection !== 'rules') {
      diagnostics.push(diagnostic('unsupported-cluster-link', `Skipping non-skill/rule link ${link.collection}:${link.id}`, pathContext))
      return
    }
    const installed = link.collection === 'skills' ? installedSkills.has(link.id) : installedRules.has(link.id)
    if (!installed) {
      diagnostics.push(diagnostic('uninstalled-cluster-link', `Skipping ${link.collection}:${link.id}; it is not directly installed on this piece`, pathContext))
      return
    }
    const output = link.collection === 'skills' ? skills : rules
    if (!output.includes(link.id)) output.push(link.id)
  })
}

function rootDefinition(
  rootKind: AuthorClusterInitializationRootKind,
  rootId: string,
  installedSkills: ReadonlySet<string>,
  installedRules: ReadonlySet<string>,
  catalog: AuthorClusterInitializationCatalog,
  diagnostics: AuthorClusterInitializationDiagnostic[],
): AuthorClusterDefinition {
  const skills = rootKind === 'skill' ? [rootId] : []
  const rules = rootKind === 'rule' ? [rootId] : []
  appendLinkedMember(
    explicitLinks(sourceEntry(catalog, rootKind, rootId), rootKind, rootId, diagnostics),
    installedSkills,
    installedRules,
    rootKind,
    rootId,
    skills,
    rules,
    diagnostics,
  )
  return {
    id: `${rootKind === 'skill' ? 'skills' : 'rules'}:${rootId}`,
    skills,
    rules,
  }
}

/**
 * Plan the static runtime groups for a piece without installing anything.
 *
 * Every direct skill gets a root. A directly installed rule gets a separate
 * root only when no skill group owns it. Explicit Cluster links
 * may bundle another skill/rule only when that member is already present on
 * the same piece. No dependency traversal, graph expansion, or host callback
 * occurs here; callers pass each returned definition to AuthorClusterRuntime.adopt.
 */
export function planAuthorClusterInitialization(
  piece: AuthorClusterInitializationPiece,
  catalog: AuthorClusterInitializationCatalog = {},
): AuthorClusterInitializationPlan {
  const diagnostics: AuthorClusterInitializationDiagnostic[] = []
  const installedSkills = directMemberIds(piece?.skills, 'skill', diagnostics)
  const installedRules = directMemberIds(piece?.rules, 'rule', diagnostics)
  const skillSet = new Set(installedSkills)
  const ruleSet = new Set(installedRules)
  const definitions: AuthorClusterDefinition[] = []

  for (const id of installedSkills) definitions.push(rootDefinition('skill', id, skillSet, ruleSet, catalog, diagnostics))
  const groupedRules = new Set(definitions.flatMap(definition => definition.rules))
  for (const id of installedRules) {
    if (!groupedRules.has(id)) definitions.push(rootDefinition('rule', id, skillSet, ruleSet, catalog, diagnostics))
  }

  return { definitions, diagnostics }
}
