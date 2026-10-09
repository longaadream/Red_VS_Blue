/**
 * Document-level content graph artifacts.
 *
 * `contentGraph` remains the compatibility representation for the primary
 * executable field. Additional executable fields use `contentGraphEntries` so
 * each field can carry and validate its own graph without replacing the
 * primary artifact.
 */

import {
  CONTENT_GRAPH_COMPILER_VERSION,
  applyContentGraph as coreApplyContentGraph,
  assertContentGraphArtifact as coreAssertContentGraphArtifact,
  compileContentGraph,
  type ContentGraph,
} from './content-graph'

// Keep this module a drop-in document-level entry point for callers that
// already import the compiler registry from content-graph.ts.
export * from './content-graph'

export type ContentGraphEntry = {
  graph: ContentGraph
  compilerVersion: typeof CONTENT_GRAPH_COMPILER_VERSION
  [key: string]: unknown
}

export type ContentGraphEntries = Record<string, ContentGraphEntry>

export type ContentGraphDocument = Record<string, unknown> & {
  contentGraphEntries?: ContentGraphEntries
}

const defaultField: Record<ContentGraph['surface'], string> = {
  skill: 'code',
  card: 'code',
  rule: 'skillCode',
  triggerSkill: 'code',
  pending: 'effectCode',
  preview: 'previewCode',
}

const own = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key)
// Keep this compatible with compiler assertions invoked across a VM/module
// boundary, where Object.prototype belongs to a different realm.
const objectLike = (value: unknown): value is Record<string, unknown> => typeof value === 'object'
  && value !== null && !Array.isArray(value)

function fail(message: string): never {
  throw new Error(`Content graph document: ${message}`)
}

function assertDocumentObject(content: unknown): asserts content is ContentGraphDocument {
  if (!objectLike(content)) fail('content 必须为对象')
}

function hasGraphDocumentArtifact(content: Record<string, unknown>): boolean {
  return own(content, 'contentGraph') || own(content, 'contentGraphEntries')
}

function assertNoLegacySkillGraph(content: Record<string, unknown>): void {
  if (hasGraphDocumentArtifact(content) && own(content, 'skillGraph') && content.skillGraph !== undefined) {
    fail('content 同时存在旧 skillGraph 与 contentGraph，请先解除旧图关联')
  }
}

function assertEntriesObject(content: ContentGraphDocument): ContentGraphEntries | null {
  if (!own(content, 'contentGraphEntries')) return null
  if (!objectLike(content.contentGraphEntries)) fail('contentGraphEntries 必须为对象')
  return content.contentGraphEntries as ContentGraphEntries
}

function primaryField(content: ContentGraphDocument): string {
  if (!own(content, 'contentGraph')) return ''
  const graph = content.contentGraph
  const compiled = compileContentGraph(graph)
  if (typeof content.contentGraphField === 'string' && content.contentGraphField.length > 0) return content.contentGraphField
  return defaultField[compiled.surface]
}

function assertExtraEntry(content: ContentGraphDocument, field: string, entry: unknown): void {
  if (!objectLike(entry)) fail(`contentGraphEntries.${field} 必须为对象`)
  if (!own(entry, 'graph')) fail(`contentGraphEntries.${field}.graph 缺失`)
  if (entry.compilerVersion !== CONTENT_GRAPH_COMPILER_VERSION) {
    fail(`contentGraphEntries.${field}.compilerVersion 必须为 ${CONTENT_GRAPH_COMPILER_VERSION}`)
  }

  // Reuse the canonical compiler and artifact assertion for each additional
  // field. The temporary artifact is only an assertion view; the caller's
  // primary contentGraph remains untouched.
  const candidate = {
    ...content,
    contentGraph: entry.graph,
    contentGraphField: field,
    contentGraphCompilerVersion: entry.compilerVersion,
  }
  coreAssertContentGraphArtifact(candidate)
}

/**
 * Validate the primary compatibility artifact and every additional field
 * artifact. Unknown content and entry extension fields are intentionally
 * ignored and remain round-trippable through applyContentGraphField.
 */
export function assertContentGraphDocument(content: unknown): void {
  assertDocumentObject(content)
  assertNoLegacySkillGraph(content)
  const entries = assertEntriesObject(content)

  if (own(content, 'contentGraph')) {
    coreAssertContentGraphArtifact(content)
  }
  if (!entries) return
  if (!own(content, 'contentGraph')) fail('contentGraphEntries requires a primary contentGraph artifact')

  const mainField = own(content, 'contentGraph') ? primaryField(content) : ''
  for (const field of Object.keys(entries)) {
    if (field === mainField) fail(`主 contentGraph 字段 ${field} 不得重复出现在 contentGraphEntries`)
    assertExtraEntry(content, field, entries[field])
  }
}

/**
 * Compile one graph into one content field.
 *
 * The first field on a document uses the compatibility `contentGraph` shape.
 * Once a primary graph exists, other fields are stored independently under
 * `contentGraphEntries`. Reapplying the primary field updates the compatibility
 * artifact while preserving all additional entries.
 */
export function applyContentGraphField(
  content: Record<string, unknown>,
  graph: ContentGraph,
  field?: string,
): ContentGraphDocument {
  assertDocumentObject(content)
  assertNoLegacySkillGraph(content)
  if (hasGraphDocumentArtifact(content)) assertContentGraphDocument(content)

  const compiled = compileContentGraph(graph)
  const targetField = field ?? defaultField[compiled.surface]
  const entries = own(content, 'contentGraphEntries')
    ? (assertEntriesObject(content) as ContentGraphEntries)
    : null
  const hasPrimary = own(content, 'contentGraph')

  if (!hasPrimary) {
    if (entries && own(entries, targetField)) {
      fail(`主 contentGraph 字段 ${targetField} 不得重复出现在 contentGraphEntries`)
    }
    const next = coreApplyContentGraph(content, graph, targetField) as ContentGraphDocument
    assertContentGraphDocument(next)
    return next
  }

  const currentPrimaryField = primaryField(content)
  if (targetField === currentPrimaryField) {
    if (entries && own(entries, targetField)) {
      fail(`主 contentGraph 字段 ${targetField} 不得重复出现在 contentGraphEntries`)
    }
    const next = coreApplyContentGraph(content, graph, targetField) as ContentGraphDocument
    assertContentGraphDocument(next)
    return next
  }

  // `applyContentGraph` is the canonical field/surface validator. Apply it to
  // a scratch view, then copy only the generated field and compiler metadata
  // into the independent entry representation.
  const scratch = coreApplyContentGraph({ [targetField]: content[targetField] }, graph, targetField)
  const nextEntries: ContentGraphEntries = {
    ...(entries ?? {}),
    [targetField]: {
      ...(entries?.[targetField] ?? {}),
      graph,
      compilerVersion: compiled.compilerVersion,
    },
  }
  const next: ContentGraphDocument = {
    ...content,
    [targetField]: scratch[targetField],
    contentGraphEntries: nextEntries,
  }
  assertContentGraphDocument(next)
  return next
}

// Document callers can switch imports without changing the long-standing API
// names. The core compiler functions remain available through the explicit
// exports above and are used internally under aliases.
export const applyContentGraph = applyContentGraphField
export const assertContentGraphArtifact = assertContentGraphDocument
