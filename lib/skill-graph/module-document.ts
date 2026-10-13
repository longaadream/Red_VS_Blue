import { compileGameplayModuleGraph, compileGameplayModuleGraphV1, compileGameplayModuleGraphV2, GAMEPLAY_MODULE_COMPILER_V1_VERSION, GAMEPLAY_MODULE_COMPILER_V2_VERSION, GAMEPLAY_MODULE_COMPILER_VERSION } from './module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from './module-registry'
import { renderGameplayModuleText, type GameplayTextBindings } from './module-text'
import { assertGameplayTargetBindingDocument, GAMEPLAY_TARGET_BINDING_WARNINGS, GameplayTargetBindingError, synchronizeGameplayTargetBinding, type GameplayTargetBindings } from './author-target-binding'
import { parseDeclaredSummonCapability } from '../game/declared-summon-capability'

export * from './module-types'
export * from './module-compiler'
export * from './module-registry'
export * from './module-text'
export * from './module-cluster'
export * from './author-expression'
export * from './author-expression-graph'
export * from './author-expression-completion'
export * from './author-target-binding'

export const GAMEPLAY_MODULE_DOCUMENT_VERSION = 'rvb-gameplay-module-document/v1' as const
type Document = Record<string, unknown>
type Entry = { graph: unknown; compilerVersion: string }
type Artifact = { version: typeof GAMEPLAY_MODULE_DOCUMENT_VERSION; entries: Record<string, Entry>; textBindings?: GameplayTextBindings; targetBindings?: GameplayTargetBindings }
const record = (value: unknown): value is Document => !!value && typeof value === 'object' && !Array.isArray(value)
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const defaults: Record<string, string> = { skill: 'code', card: 'code', rule: 'skillCode', triggerSkill: 'code', pending: 'effectCode', preview: 'previewCode' }
const fields: Record<string, readonly string[]> = {
  skill: ['code', 'skillCode'], card: ['code'], rule: ['code', 'skillCode'],
  triggerSkill: ['code', 'skillCode', 'triggerSkill'], pending: ['code', 'effectCode'], preview: ['code', 'previewCode'],
}
function fail(message: string): never { throw new Error(`Gameplay module document: ${message}`) }
function assertDeclaredSummonCapability(content: Document): void {
  if (!own(content, 'summonCapability') || content.summonCapability === undefined) return
  try {
    parseDeclaredSummonCapability(content.summonCapability)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fail(`invalid summonCapability: ${message}`)
  }
}
function primaryField(content: Document): string {
  if (!record(content.contentGraph)) return ''
  return typeof content.contentGraphField === 'string' ? content.contentGraphField : defaults[String(content.contentGraph.surface)] ?? ''
}
function artifact(content: Document): Artifact | undefined {
  if (!own(content, 'gameplayModules')) return undefined
  const value = content.gameplayModules
  if (!record(value) || value.version !== GAMEPLAY_MODULE_DOCUMENT_VERSION || !record(value.entries)) fail('invalid gameplayModules version or entries')
  if (Object.keys(value).some(key => !['version', 'entries', 'textBindings', 'targetBindings'].includes(key))) fail('unknown gameplayModules metadata')
  if (!Object.keys(value.entries).length) fail('gameplayModules needs at least one entry')
  return value as Artifact
}
function compilerForVersion(version: string): typeof compileGameplayModuleGraph | undefined {
  if (version === GAMEPLAY_MODULE_COMPILER_V1_VERSION) return compileGameplayModuleGraphV1
  if (version === GAMEPLAY_MODULE_COMPILER_V2_VERSION) return compileGameplayModuleGraphV2
  if (version === GAMEPLAY_MODULE_COMPILER_VERSION) return compileGameplayModuleGraph
  return undefined
}

function attachGameplayTargetBindingWarnings(document: Document, warnings: readonly string[]): void {
  if (!warnings.length) return
  Object.defineProperty(document, GAMEPLAY_TARGET_BINDING_WARNINGS, {
    configurable: true,
    enumerable: false,
    value: [...warnings],
    writable: false,
  })
}

/** Validate every generated entry before saving or admitting a definition. */
export function assertGameplayModuleDocument(input: unknown): void {
  if (!record(input)) fail('content must be an object')
  assertDeclaredSummonCapability(input)
  const modules = artifact(input)
  if (!modules) return
  if (input.skillGraph !== undefined) fail('legacy skillGraph cannot coexist with gameplay modules')
  for (const [field, entry] of Object.entries(modules.entries)) {
    if (!record(entry) || Object.keys(entry).some(key => key !== 'graph' && key !== 'compilerVersion')) fail(`invalid entry ${field}`)
    const compile = compilerForVersion(entry.compilerVersion)
    if (!compile) fail(`unsupported compiler version for ${field}`)
    const compiled = compile(entry.graph, GAMEPLAY_MODULE_REGISTRY)
    if (!fields[compiled.surface]?.includes(field)) fail(`field ${field} is incompatible with ${compiled.surface}`)
    if (primaryField(input) === field || (record(input.contentGraphEntries) && own(input.contentGraphEntries, field))) fail(`multiple authoring sources for ${field}`)
    if (input[field] !== compiled.code) fail(`generated ${field} does not match its module graph`)
  }
  if (modules.textBindings !== undefined) {
    for (const [field, text] of Object.entries(renderGameplayModuleText(modules.entries, modules.textBindings))) {
      if (input[field] !== text) fail(`generated ${field} does not match its text binding`)
    }
  }
  assertGameplayTargetBindingDocument(input)
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
    ...(prior?.textBindings === undefined ? {} : { textBindings: prior.textBindings }),
    ...(prior?.targetBindings === undefined ? {} : { targetBindings: prior.targetBindings }),
    version: GAMEPLAY_MODULE_DOCUMENT_VERSION,
    entries: { ...prior?.entries, [target]: { graph: JSON.parse(JSON.stringify(graph)), compilerVersion: GAMEPLAY_MODULE_COMPILER_VERSION } },
  }
  const updated = next.gameplayModules as Artifact
  const previousGraph = prior?.entries[target]?.graph
  const targetPatch = synchronizeGameplayTargetBinding(next, previousGraph, graph, target)
  if (targetPatch.diagnostics.length) throw new GameplayTargetBindingError(targetPatch.diagnostics.join('；'))
  attachGameplayTargetBindingWarnings(next, targetPatch.warnings)
  if (targetPatch.targeting !== undefined) next.targeting = targetPatch.targeting
  if (targetPatch.targetBindings !== undefined) updated.targetBindings = targetPatch.targetBindings
  if (targetPatch.textBindings !== undefined) updated.textBindings = targetPatch.textBindings
  if (targetPatch.renderedText !== undefined) Object.assign(next, targetPatch.renderedText)
  if (updated.textBindings !== undefined && targetPatch.renderedText === undefined) Object.assign(next, renderGameplayModuleText(updated.entries, updated.textBindings))
  if (targetPatch.previewGraph !== undefined) {
    const previewEntry = updated.entries.previewCode
    if (!previewEntry) fail('target binding preview entry is missing')
    const compilePreview = compilerForVersion(previewEntry.compilerVersion) ?? compileGameplayModuleGraph
    const previewCompiled = compilePreview(targetPatch.previewGraph, GAMEPLAY_MODULE_REGISTRY)
    updated.entries.previewCode = {
      ...previewEntry,
      graph: JSON.parse(JSON.stringify(targetPatch.previewGraph)),
      compilerVersion: previewEntry.compilerVersion,
    }
    next.previewCode = previewCompiled.code
  }
  assertGameplayModuleDocument(next)
  return next
}

/** Bind original wording to the same typed inputs used by execution and UI. */
export function applyGameplayModuleTextBindings(input: Document, bindings: GameplayTextBindings): Document {
  const modules = artifact(input)
  if (!modules) fail('text bindings require a module document')
  // A draft may contain stale bindings from an earlier graph. Validate all
  // graph/code ownership first, then render and validate the replacement.
  const validationModules = { ...modules }
  delete validationModules.textBindings
  assertGameplayModuleDocument({ ...input, gameplayModules: validationModules })
  const snapshot = JSON.parse(JSON.stringify(bindings)) as GameplayTextBindings
  const next = { ...input, ...renderGameplayModuleText(modules.entries, snapshot), gameplayModules: { ...modules, textBindings: snapshot } }
  assertGameplayModuleDocument(next)
  return next
}
