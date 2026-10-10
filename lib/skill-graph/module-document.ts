import { compileGameplayModuleGraph, GAMEPLAY_MODULE_COMPILER_VERSION } from './module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from './module-registry'

export * from './module-types'
export * from './module-compiler'
export * from './module-registry'

export const GAMEPLAY_MODULE_DOCUMENT_VERSION = 'rvb-gameplay-module-document/v1' as const
type Document = Record<string, unknown>
type Entry = { graph: unknown; compilerVersion: string }
type Artifact = { version: typeof GAMEPLAY_MODULE_DOCUMENT_VERSION; entries: Record<string, Entry> }
const record = (value: unknown): value is Document => !!value && typeof value === 'object' && !Array.isArray(value)
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const defaults: Record<string, string> = { skill: 'code', card: 'code', rule: 'skillCode', triggerSkill: 'code', pending: 'effectCode', preview: 'previewCode' }
const fields: Record<string, readonly string[]> = {
  skill: ['code', 'skillCode'], card: ['code'], rule: ['code', 'skillCode'],
  triggerSkill: ['code', 'skillCode', 'triggerSkill'], pending: ['code', 'effectCode'], preview: ['code', 'previewCode'],
}
function fail(message: string): never { throw new Error(`Gameplay module document: ${message}`) }
function primaryField(content: Document): string {
  if (!record(content.contentGraph)) return ''
  return typeof content.contentGraphField === 'string' ? content.contentGraphField : defaults[String(content.contentGraph.surface)] ?? ''
}
function artifact(content: Document): Artifact | undefined {
  if (!own(content, 'gameplayModules')) return undefined
  const value = content.gameplayModules
  if (!record(value) || value.version !== GAMEPLAY_MODULE_DOCUMENT_VERSION || !record(value.entries)) fail('invalid gameplayModules version or entries')
  if (Object.keys(value).some(key => key !== 'version' && key !== 'entries')) fail('unknown gameplayModules metadata')
  if (!Object.keys(value.entries).length) fail('gameplayModules needs at least one entry')
  return value as Artifact
}

/** Validate every generated entry before saving or admitting a definition. */
export function assertGameplayModuleDocument(input: unknown): void {
  if (!record(input)) fail('content must be an object')
  const modules = artifact(input)
  if (!modules) return
  if (input.skillGraph !== undefined) fail('legacy skillGraph cannot coexist with gameplay modules')
  for (const [field, entry] of Object.entries(modules.entries)) {
    if (!record(entry) || Object.keys(entry).some(key => key !== 'graph' && key !== 'compilerVersion')) fail(`invalid entry ${field}`)
    if (entry.compilerVersion !== GAMEPLAY_MODULE_COMPILER_VERSION) fail(`unsupported compiler version for ${field}`)
    const compiled = compileGameplayModuleGraph(entry.graph, GAMEPLAY_MODULE_REGISTRY)
    if (!fields[compiled.surface]?.includes(field)) fail(`field ${field} is incompatible with ${compiled.surface}`)
    if (primaryField(input) === field || (record(input.contentGraphEntries) && own(input.contentGraphEntries, field))) fail(`multiple authoring sources for ${field}`)
    if (input[field] !== compiled.code) fail(`generated ${field} does not match its module graph`)
  }
}

/** The persisted owner cannot be removed to unlock arbitrary source editing. */
export function assertGameplayModuleTransition(previous: unknown, next: unknown): void {
  assertGameplayModuleDocument(next)
  if (!record(previous) || !own(previous, 'gameplayModules')) return
  const before = artifact(previous)!
  const after = record(next) ? artifact(next) : undefined
  for (const field of Object.keys(before.entries)) {
    if (!after || !own(after.entries, field)) fail(`cannot detach module-owned field ${field}`)
  }
}

export function getGameplayModuleGraph(input: unknown, field: string): unknown {
  if (!record(input) || !record(input.gameplayModules) || !record(input.gameplayModules.entries)) return null
  const entry = input.gameplayModules.entries[field]
  return record(entry) ? entry.graph ?? null : null
}

/** Replace just this entry, permitting repair of an invalid in-memory draft. */
export function applyGameplayModuleGraph(input: Document, graph: unknown, field?: string): Document {
  if (!record(input)) fail('content must be an object')
  const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
  const target = field ?? defaults[compiled.surface]
  if (!fields[compiled.surface]?.includes(target)) fail(`field ${target} is incompatible with ${compiled.surface}`)
  if (input.skillGraph !== undefined) fail('legacy skillGraph must be explicitly migrated first')
  const prior = artifact(input)
  const next: Document = { ...input }
  const additional: Document = record(input.contentGraphEntries) ? { ...input.contentGraphEntries } : {}
  if (primaryField(input) === target) {
    delete next.contentGraph
    delete next.contentGraphField
    delete next.contentGraphCompilerVersion
    const first = Object.keys(additional).sort()[0]
    if (first) {
      const entry = additional[first]
      if (!record(entry)) fail(`invalid legacy graph entry ${first}`)
      next.contentGraph = entry.graph
      next.contentGraphField = first
      next.contentGraphCompilerVersion = entry.compilerVersion
      delete additional[first]
    }
  } else {
    delete additional[target]
  }
  if (Object.keys(additional).length) next.contentGraphEntries = additional
  else delete next.contentGraphEntries
  next[target] = compiled.code
  // Snapshot JSON-safe authoring data; retaining mutable caller objects would
  // let an editor change graph semantics after its generated source was checked.
  next.gameplayModules = {
    version: GAMEPLAY_MODULE_DOCUMENT_VERSION,
    entries: { ...prior?.entries, [target]: { graph: JSON.parse(JSON.stringify(graph)), compilerVersion: GAMEPLAY_MODULE_COMPILER_VERSION } },
  }
  assertGameplayModuleDocument(next)
  return next
}
