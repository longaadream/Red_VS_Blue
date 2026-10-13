import { getGameplayModule } from './module-registry'
import { renderGameplayModuleText, type GameplayTextBinding, type GameplayTextBindings, type GameplayTextSource } from './module-text'

/** Persisted only after an explicit graph edit has proven the old declaration. */
export const GAMEPLAY_TARGET_BINDING_VERSION = 'rvb-gameplay-target-binding/v1' as const
/** Draft-only warning key; non-enumerable and never persisted in content. */
export const GAMEPLAY_TARGET_BINDING_WARNINGS = '__gameplayTargetBindingWarnings' as const

export type GameplayTargetBindingTarget = {
  readonly node: string
  readonly stepIndex: number
  readonly targetIndex: number
  readonly type: 'piece' | 'cell'
}

export type GameplayTargetBindings = {
  readonly version: typeof GAMEPLAY_TARGET_BINDING_VERSION
  readonly entry: string
  readonly targets: readonly GameplayTargetBindingTarget[]
}

export type GameplayTargetBindingSync = {
  readonly targeting?: Record<string, unknown>
  readonly targetBindings?: GameplayTargetBindings
  readonly textBindings?: GameplayTextBindings
  readonly renderedText?: Record<string, string>
  readonly previewGraph?: unknown
  readonly warnings: readonly string[]
  readonly diagnostics: readonly string[]
}

export class GameplayTargetBindingError extends Error {
  readonly code = 'GAMEPLAY_TARGET_BINDING'

  constructor(message: string) {
    super(`Gameplay target binding: ${message}`)
    this.name = 'GameplayTargetBindingError'
  }
}

type JsonRecord = Record<string, unknown>
type InteractionKind = 'option' | 'target'
type TargetType = 'piece' | 'cell'
type Interaction = {
  readonly kind: InteractionKind
  readonly type?: TargetType
  readonly node: string
  readonly statement: JsonRecord
}
type StaticStep = { readonly kind: InteractionKind; readonly type?: TargetType; readonly raw: JsonRecord; readonly index: number }

const object = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const BOUND_ENTRY_FIELDS = new Set(['code', 'skillCode', 'triggerSkill'])

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function targetType(value: unknown): TargetType | undefined {
  if (value === 'piece') return 'piece'
  if (value === 'cell' || value === 'grid') return 'cell'
  return undefined
}

function targetModule(module: unknown): TargetType | undefined {
  if (module === 'author.choice.target-piece') return 'piece'
  if (module === 'author.choice.target-cell') return 'cell'
  return undefined
}

function interactionModule(module: unknown): InteractionKind | undefined {
  if (module === 'author.choice.option') return 'option'
  return targetModule(module) ? 'target' : undefined
}

function purePrelude(kind: unknown): boolean {
  return kind === 'record.create' || kind === 'record.get' || kind === 'record.with' || kind === 'collection'
}

function nestedStatements(body: unknown, result: JsonRecord[] = []): JsonRecord[] {
  for (const item of Array.isArray(body) ? body : []) {
    if (!object(item)) continue
    result.push(item)
    nestedStatements(item.then, result)
    nestedStatements(item.else, result)
    nestedStatements(item.body, result)
    nestedStatements(object(item.condition) ? item.condition.body : undefined, result)
  }
  return result
}

/**
 * Read the unconditional selection prefix without trying to interpret a
 * branch or an effect.  Option calls are intentionally included: the old
 * targeting declaration must retain an option prefix before its target.
 */
function interactions(graph: unknown): { values: Interaction[]; diagnostic?: string } {
  if (!object(graph) || graph.version !== 'rvb-gameplay-modules/v1' || !Array.isArray(graph.body)) return { values: [] }
  const values: Interaction[] = []
  const seen = new Set<string>()
  const allIds = new Map<string, number>()
  for (const statement of nestedStatements(graph.body)) {
    if (typeof statement.id === 'string') allIds.set(statement.id, (allIds.get(statement.id) || 0) + 1)
  }
  for (const statement of graph.body) {
    if (!object(statement)) break
    if (statement.kind !== 'call') {
      if (purePrelude(statement.kind)) continue
      break
    }
    const moduleId = statement.module
    const kind = interactionModule(moduleId)
    if (kind) {
      if (typeof statement.id !== 'string' || !statement.id || seen.has(statement.id)) {
        return { values, diagnostic: '目标选择图包含缺失或重复的节点标识。' }
      }
      if (allIds.get(statement.id) !== 1) return { values, diagnostic: '目标选择节点标识在图中不唯一，未猜测绑定。' }
      seen.add(statement.id)
      values.push({ kind, ...(kind === 'target' ? { type: targetModule(moduleId) } : {}), node: statement.id, statement })
      continue
    }
    const descriptor = typeof moduleId === 'string' ? getGameplayModule(moduleId, typeof statement.version === 'string' ? statement.version : undefined) : undefined
    if (!descriptor || descriptor.effects.pending || descriptor.effects.pure !== true) break
  }
  return { values }
}

function staticSteps(document: JsonRecord): { values: StaticStep[]; diagnostic?: string } {
  const targeting = document.targeting
  if (!object(targeting) || !Array.isArray(targeting.steps)) return { values: [] }
  const values: StaticStep[] = []
  for (let index = 0; index < targeting.steps.length; index += 1) {
    const raw = targeting.steps[index]
    if (!object(raw)) return { values, diagnostic: 'targeting.steps 包含无效的目标声明。' }
    if (raw.kind === 'option') {
      if (!Array.isArray(raw.options) || raw.options.length === 0) return { values, diagnostic: '选项前缀缺少有效选项，无法建立图绑定。' }
      values.push({ kind: 'option', raw, index })
      continue
    }
    if (raw.kind !== 'target') return { values, diagnostic: 'targeting.steps 含有图绑定无法安全提升的步骤。' }
    const type = targetType(raw.type)
    if (!type) return { values, diagnostic: 'targeting.steps 含有未知目标类型，无法建立图绑定。' }
    values.push({ kind: 'target', type, raw, index })
  }
  return { values }
}

function parameters(statement: JsonRecord): JsonRecord {
  return object(statement.parameters) ? statement.parameters : {}
}

function numericParameter(statement: JsonRecord, name: string, fallback: number): number | undefined {
  const value = own(parameters(statement), name) ? parameters(statement)[name] : fallback
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function enumParameter(statement: JsonRecord, name: string, fallback: 'enemy' | 'ally' | 'all'): 'enemy' | 'ally' | 'all' | undefined {
  const value = own(parameters(statement), name) ? parameters(statement)[name] : fallback
  return value === 'enemy' || value === 'ally' || value === 'all' ? value : undefined
}

function booleanParameter(statement: JsonRecord, name: string): boolean | undefined {
  const value = parameters(statement)[name]
  return value === undefined ? undefined : typeof value === 'boolean' ? value : undefined
}

function booleanParameterWithDefault(statement: JsonRecord, name: string, fallback: boolean): boolean | undefined {
  const values = parameters(statement)
  if (!own(values, name)) return fallback
  return booleanParameter(statement, name)
}

function targetSignature(interaction: Interaction): unknown {
  if (interaction.kind !== 'target') return { kind: interaction.kind }
  const statement = interaction.statement
  const type = interaction.type
  return {
    kind: interaction.kind,
    type,
    range: numericParameter(statement, 'range', 5),
    filter: enumParameter(statement, 'filter', type === 'cell' ? 'all' : 'enemy'),
    ...(type === 'cell' ? {
      requireWalkable: booleanParameterWithDefault(statement, 'requireWalkable', true),
      requireUnoccupied: booleanParameterWithDefault(statement, 'requireUnoccupied', true),
    } : {}),
  }
}

function targetParametersEqual(before: Interaction, after: Interaction): boolean {
  return JSON.stringify(targetSignature(before)) === JSON.stringify(targetSignature(after))
}

function declaredTargetSignature(step: StaticStep): unknown {
  if (step.kind !== 'target' || !step.type) return { kind: step.kind }
  const raw = step.raw
  return {
    kind: step.kind,
    type: step.type,
    range: typeof raw.range === 'number' && Number.isFinite(raw.range) && raw.range >= 0 ? raw.range : 5,
    filter: raw.filter === 'enemy' || raw.filter === 'ally' || raw.filter === 'all'
      ? raw.filter
      : step.type === 'cell' ? 'all' : 'enemy',
    ...(step.type === 'cell' ? {
      requireWalkable: typeof raw.requireWalkable === 'boolean' ? raw.requireWalkable : true,
      requireUnoccupied: typeof raw.requireUnoccupied === 'boolean' ? raw.requireUnoccupied : true,
    } : {}),
  }
}

function matchesInteractions(before: Interaction[], after: Interaction[], declared: StaticStep[]): string | undefined {
  if (before.length !== after.length || after.length !== declared.length) return '图选择序列与现有 targeting.steps 数量不一致，无法安全建立绑定。'
  for (let index = 0; index < after.length; index += 1) {
    const current = after[index]
    const prior = before[index]
    const expected = declared[index]
    if (current.kind !== expected.kind || prior.kind !== current.kind) return '图选择前缀与现有 targeting.steps 顺序不一致，未覆盖原声明。'
    if (current.kind === 'target' && (current.type !== expected.type || prior.type !== current.type)) return '图目标类型与现有 targeting.steps 不一致，未覆盖原声明。'
    if (current.kind === 'target' && JSON.stringify(targetSignature(prior)) !== JSON.stringify(declaredTargetSignature(expected))) {
      return '图中原目标约束与现有 targeting.steps 不一致，未猜测替代声明。'
    }
  }
  return undefined
}

function existingBinding(value: unknown): GameplayTargetBindings | undefined {
  if (!object(value) || value.version !== GAMEPLAY_TARGET_BINDING_VERSION || typeof value.entry !== 'string' || !Array.isArray(value.targets)
    || !BOUND_ENTRY_FIELDS.has(value.entry) || Object.keys(value).some(key => !['version', 'entry', 'targets'].includes(key))) return undefined
  const targets: GameplayTargetBindingTarget[] = []
  const nodes = new Set<string>(), steps = new Set<number>(), indexes = new Set<number>()
  for (const raw of value.targets) {
    if (!object(raw) || typeof raw.node !== 'string' || raw.node.length === 0 || raw.node.length > 128 || typeof raw.stepIndex !== 'number' || typeof raw.targetIndex !== 'number'
      || !Number.isInteger(raw.stepIndex) || raw.stepIndex < 0 || !Number.isInteger(raw.targetIndex) || raw.targetIndex < 0 || !targetType(raw.type)) return undefined
    const stepIndex = raw.stepIndex
    const targetIndex = raw.targetIndex
    if (nodes.has(raw.node) || steps.has(stepIndex) || indexes.has(targetIndex)) return undefined
    nodes.add(raw.node); steps.add(stepIndex); indexes.add(targetIndex)
    targets.push({ node: raw.node, stepIndex, targetIndex, type: targetType(raw.type)! })
  }
  return { version: GAMEPLAY_TARGET_BINDING_VERSION, entry: value.entry, targets }
}

function validateExistingBinding(binding: GameplayTargetBindings | undefined, entry: string, before: Interaction[], declared: StaticStep[]): string | undefined {
  if (!binding) return undefined
  if (binding.entry !== entry) return '现有目标绑定指向了不同流程入口。'
  if (binding.targets.length !== before.filter(item => item.kind === 'target').length) return '现有目标绑定与图中的目标数量不一致。'
  const targets = before.filter(item => item.kind === 'target')
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const item = binding.targets[targetIndex]
    const interactionIndex = before.indexOf(targets[targetIndex])
    if (!item || item.node !== targets[targetIndex].node || item.targetIndex !== targetIndex
      || item.stepIndex !== declared[interactionIndex]?.index || item.type !== targets[targetIndex].type) {
      return '现有目标绑定与流程图节点身份不一致。'
    }
  }
  return undefined
}

function updateTargeting(document: JsonRecord, declared: StaticStep[], after: Interaction[]): Record<string, unknown> {
  const current = object(document.targeting) ? clone(document.targeting) : {}
  const steps = Array.isArray(current.steps) ? clone(current.steps) as unknown[] : []
  for (let interactionIndex = 0; interactionIndex < after.length; interactionIndex += 1) {
    const interaction = after[interactionIndex]
    const staticStep = declared[interactionIndex]
    if (interaction.kind !== 'target' || !staticStep || !object(steps[staticStep.index])) continue
    const next = steps[staticStep.index] as JsonRecord
    const statement = interaction.statement
    const range = numericParameter(statement, 'range', 5)
    const filter = enumParameter(statement, 'filter', interaction.type === 'cell' ? 'all' : 'enemy')
    if (range !== undefined) next.range = range
    if (filter !== undefined) next.filter = filter
    if (interaction.type === 'cell') {
      // The graph and the legacy declaration share a true default.  Keep the
      // declaration canonical by omitting a field when the graph resolves to
      // that default, including the false -> omitted edit transition.
      const walkable = booleanParameterWithDefault(statement, 'requireWalkable', true)
      const unoccupied = booleanParameterWithDefault(statement, 'requireUnoccupied', true)
      if (walkable === true) delete next.requireWalkable
      else if (walkable === false) next.requireWalkable = false
      if (unoccupied === true) delete next.requireUnoccupied
      else if (unoccupied === false) next.requireUnoccupied = false
    }
  }
  current.steps = steps
  return current
}

function sourceFor(entry: string, node: string): GameplayTextSource {
  return { entry, node, parameter: 'range' }
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function uniqueNumberToken(text: string, value: number): { start: number; end: number } | undefined {
  const token = Number.isInteger(value) ? String(value) : String(value)
  const pattern = new RegExp(`(^|[^0-9.])(${escaped(token)})(?![0-9.])`, 'g')
  const matches: Array<{ start: number; end: number }> = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) matches.push({ start: match.index + match[1].length, end: match.index + match[0].length })
  return matches.length === 1 ? matches[0] : undefined
}

function replaceRangeToken(text: string, oldRange: number, replacement: number | string): string | undefined {
  const token = uniqueNumberToken(text, oldRange)
  if (!token) return undefined
  return text.slice(0, token.start) + String(replacement) + text.slice(token.end)
}

function bindingSource(value: unknown): value is GameplayTextSource {
  if (!object(value) || typeof value.entry !== 'string') return false
  if (own(value, 'node')) {
    return typeof value.node === 'string'
      && ((typeof value.parameter === 'string' && !own(value, 'input')) || (typeof value.input === 'string' && !own(value, 'parameter')))
  }
  return typeof value.input === 'string' && !own(value, 'parameter')
}

function nodeBindingSource(value: GameplayTextSource): value is Extract<GameplayTextSource, { readonly node: string }> {
  return 'node' in value && typeof value.node === 'string'
}

function rebaseTextBindings(bindings: GameplayTextBindings | undefined, entry: string, before: Interaction[], after: Interaction[]): GameplayTextBindings | undefined {
  if (!bindings) return undefined
  const mapping = new Map<string, string>()
  for (let index = 0; index < Math.min(before.length, after.length); index += 1) {
    if (before[index].kind === after[index].kind && before[index].type === after[index].type) mapping.set(before[index].node, after[index].node)
  }
  const next: Record<string, GameplayTextBinding> = {}
  for (const [field, raw] of Object.entries(bindings)) {
    if (!object(raw) || typeof raw.template !== 'string' || !object(raw.values)) continue
    const values: Record<string, GameplayTextSource> = {}
    for (const [token, source] of Object.entries(raw.values)) {
      if (!bindingSource(source)) continue
      values[token] = nodeBindingSource(source) && source.entry === entry && mapping.has(source.node)
        ? { ...source, node: mapping.get(source.node)! }
        : clone(source)
    }
    next[field] = { template: raw.template, values }
  }
  return next as GameplayTextBindings
}

function autoTextBindings(
  document: JsonRecord,
  entry: string,
  before: Interaction[],
  after: Interaction[],
): { bindings?: GameplayTextBindings; warning?: string } {
  const targetsBefore = before.filter(item => item.kind === 'target')
  const targetsAfter = after.filter(item => item.kind === 'target')
  const hasAuthorText = typeof document.targetText === 'string' || typeof document.description === 'string'
  if (targetsBefore.length !== 1 || targetsAfter.length !== 1) return hasAuthorText
    ? { warning: '多个目标无法从单一范围文案自动绑定，已保留自定义文案。' }
    : {}
  const beforeTarget = targetsBefore[0]
  const afterTarget = targetsAfter[0]
  const oldRange = numericParameter(beforeTarget.statement, 'range', 5)
  const newRange = numericParameter(afterTarget.statement, 'range', 5)
  const oldTargetText = typeof document.targetText === 'string' ? document.targetText : undefined
  const oldDescription = typeof document.description === 'string' ? document.description : undefined
  const beforeSignature = targetSignature(beforeTarget) as JsonRecord
  const afterSignature = targetSignature(afterTarget) as JsonRecord
  const beforeNonRange = { ...beforeSignature }
  const afterNonRange = { ...afterSignature }
  delete beforeNonRange.range
  delete afterNonRange.range
  const constraintChanged = JSON.stringify(beforeNonRange) !== JSON.stringify(afterNonRange)
  const constraintWarning = constraintChanged && hasAuthorText
    ? '目标筛选或地格约束已变化，未自动改写自定义文案。'
    : undefined
  if (oldRange === undefined || newRange === undefined || oldRange === newRange) {
    return constraintWarning ? { warning: constraintWarning } : {}
  }
  if (!oldTargetText) return oldDescription
    ? { warning: constraintWarning ? `${constraintWarning} 目标范围已改变，但缺少 targetText，已保留自定义文案。` : '目标范围已改变，但缺少 targetText，已保留自定义文案。' }
    : {}
  const targetText = replaceRangeToken(oldTargetText, oldRange, newRange)
  if (!targetText) return { warning: constraintWarning ? `${constraintWarning} targetText 中的旧范围不是唯一数字 token，已保留自定义文案。` : 'targetText 中的旧范围不是唯一数字 token，已保留自定义文案。' }
  const values: GameplayTextSource = sourceFor(entry, afterTarget.node)
  const targetTextTemplate = replaceRangeToken(oldTargetText, oldRange, '{{range}}')
  if (!targetTextTemplate) return { warning: constraintWarning ? `${constraintWarning} targetText 中的旧范围不是唯一数字 token，已保留自定义文案。` : 'targetText 中的旧范围不是唯一数字 token，已保留自定义文案。' }
  const bindings: GameplayTextBindings = {
    targetText: { template: targetTextTemplate, values: { range: values } },
  }
  if (oldDescription !== undefined) {
    const first = oldDescription.indexOf(oldTargetText)
    const last = oldDescription.lastIndexOf(oldTargetText)
    const targetToken = uniqueNumberToken(oldTargetText, oldRange)
    if (first >= 0 && first === last && targetToken) {
      const offset = first + targetToken.start
      const descriptionTemplate = oldDescription.slice(0, offset) + '{{range}}' + oldDescription.slice(offset + (targetToken.end - targetToken.start))
      bindings.description = { template: descriptionTemplate, values: { range: values } }
    } else {
      return { warning: constraintWarning ? `${constraintWarning} description 未唯一包含 targetText，已保留自定义文案且不自动替换。` : 'description 未唯一包含 targetText，已保留自定义文案且不自动替换。' }
    }
  }
  return constraintWarning ? { bindings, warning: constraintWarning } : { bindings }
}

function previewDescriptionGraph(document: JsonRecord, oldDescription: string, nextDescription: string): unknown {
  const modules = object(document.gameplayModules) && object(document.gameplayModules.entries) ? document.gameplayModules : undefined
  const entry = modules && object(modules.entries) ? modules.entries.previewCode : undefined
  if (!object(entry) || !object(entry.graph) || !Array.isArray(entry.graph.body)) return undefined
  const graph = clone(entry.graph) as JsonRecord
  const matches = (graph.body as unknown[]).filter((statement: unknown) => object(statement) && statement.kind === 'call' && statement.module === 'preview.result') as JsonRecord[]
  if (matches.length !== 1) return undefined
  const input = matches[0].inputs
  if (!object(input) || !object(input.description) || input.description.kind !== 'literal' || input.description.value !== oldDescription) return undefined
  matches[0].inputs = { ...input, description: { kind: 'literal', value: nextDescription } }
  return graph
}

function hasTargetChange(before: Interaction[], after: Interaction[]): boolean {
  return before.length !== after.length || before.some((item, index) => !after[index]
    || item.node !== after[index].node || !targetParametersEqual(item, after[index]))
}

/**
 * Match an edited graph to the old declaration and return safe document
 * patches.  This function never invents a target declaration from an
 * arbitrary record: a static option/target prefix and one-to-one graph
 * sequence are required before any field is changed.
 */
export function synchronizeGameplayTargetBinding(
  document: unknown,
  previousGraph: unknown,
  nextGraph: unknown,
  entry: string,
): GameplayTargetBindingSync {
  if (!object(document)) return { warnings: [], diagnostics: ['内容不是可绑定的记录。'] }
  const beforeResult = interactions(previousGraph)
  const afterResult = interactions(nextGraph)
  const declaredResult = staticSteps(document)
  const before = beforeResult.values
  const after = afterResult.values
  if (!after.length && !before.length) return { warnings: [], diagnostics: [] }
  const diagnostics: string[] = []
  const warnings: string[] = []
  if (beforeResult.diagnostic) diagnostics.push(beforeResult.diagnostic)
  if (afterResult.diagnostic) diagnostics.push(afterResult.diagnostic)
  if (declaredResult.diagnostic) diagnostics.push(declaredResult.diagnostic)
  if (diagnostics.length) return { warnings, diagnostics }
  const declaration = declaredResult.values
  // A graph without a legacy/static targeting declaration is owned by the
  // graph-backed targeting host.  Leave it untouched here instead of trying
  // to infer an option map or target record from arbitrary expressions.
  if (!declaration.length) return { warnings, diagnostics: [] }
  const modules = object(document.gameplayModules) ? document.gameplayModules : undefined
  if (modules && own(modules, 'targetBindings') && modules.targetBindings !== undefined && !existingBinding(modules.targetBindings)) {
    return { warnings, diagnostics: ['targetBindings 元数据无效，未猜测替代节点。'] }
  }
  const persisted = existingBinding(modules?.targetBindings)
  // Untouched legacy documents may predate the stricter graph/declaration
  // comparison.  Without persisted binding metadata there is no edit to
  // reconcile, so preserve them byte-for-byte and avoid inventing a repair
  // diagnostic.  A persisted binding still goes through all identity checks.
  const targetChanged = hasTargetChange(before, after)
  if (!targetChanged && !persisted) return { warnings, diagnostics: [] }
  const matchDiagnostic = matchesInteractions(before, after, declaration)
  if (matchDiagnostic) return { warnings, diagnostics: [matchDiagnostic] }
  const persistedDiagnostic = validateExistingBinding(persisted, entry, before, declaration)
  if (persistedDiagnostic) return { warnings, diagnostics: [persistedDiagnostic] }
  if (!BOUND_ENTRY_FIELDS.has(entry)) return { warnings, diagnostics: ['目标绑定只能指向受支持的运行时流程入口。'] }

  const targeting = updateTargeting(document, declaration, after)
  const targetSteps = after.map((item, interactionIndex) => item.kind === 'target'
    ? { node: item.node, stepIndex: declaration[interactionIndex].index, targetIndex: after.slice(0, interactionIndex).filter(previous => previous.kind === 'target').length, type: item.type! }
    : null).filter((item): item is GameplayTargetBindingTarget => item !== null)
  const targetBindings: GameplayTargetBindings = { version: GAMEPLAY_TARGET_BINDING_VERSION, entry, targets: targetSteps }

  let textBindings = rebaseTextBindings(modules?.textBindings as GameplayTextBindings | undefined, entry, before, after)
  let renderedText: Record<string, string> | undefined
  let previewGraph: unknown
  if (targetChanged) {
    if (!textBindings) {
      const generated = autoTextBindings(document, entry, before, after)
      if (generated.warning) warnings.push(generated.warning)
      textBindings = generated.bindings
    }
    if (textBindings) {
      const entries = object(modules?.entries) ? clone(modules.entries) as Record<string, unknown> : {}
      const current = entries[entry]
      if (object(current)) entries[entry] = { ...current, graph: clone(nextGraph) }
      try {
        renderedText = renderGameplayModuleText(entries, textBindings)
      } catch (error) {
        diagnostics.push(error instanceof Error ? error.message : String(error))
      }
      const oldDescription = typeof document.description === 'string' ? document.description : undefined
      const nextDescription = renderedText?.description
      if (oldDescription !== undefined && nextDescription !== undefined && oldDescription !== nextDescription) {
        previewGraph = previewDescriptionGraph(document, oldDescription, nextDescription)
      }
    }
  }
  return { targeting, targetBindings, ...(textBindings ? { textBindings } : {}), ...(renderedText ? { renderedText } : {}), ...(previewGraph ? { previewGraph } : {}), warnings, diagnostics }
}

/** Validate persisted binding identity and its declaration without migrating old documents. */
export function assertGameplayTargetBindingDocument(input: unknown): void {
  if (!object(input) || !object(input.gameplayModules)) return
  const modules = input.gameplayModules
  if (!own(modules, 'targetBindings') || modules.targetBindings === undefined) return
  const binding = existingBinding(modules.targetBindings)
  if (!binding) throw new Error('Gameplay target binding: invalid targetBindings metadata')
  if (!object(modules.entries)) throw new Error('Gameplay target binding: missing bound graph entry')
  const boundEntry = modules.entries[binding.entry]
  if (!object(boundEntry)) throw new Error('Gameplay target binding: missing bound graph entry')
  const graph = boundEntry.graph
  const current = interactions(graph)
  if (current.diagnostic) throw new Error(`Gameplay target binding: ${current.diagnostic}`)
  const targets = current.values.filter(item => item.kind === 'target')
  const targeting = object(input.targeting) && Array.isArray(input.targeting.steps) ? input.targeting.steps : []
  if (targets.length !== binding.targets.length) throw new Error('Gameplay target binding: target node count does not match metadata')
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]
    const metadata = binding.targets[index]
    if (target.node !== metadata.node || target.type !== metadata.type) throw new Error('Gameplay target binding: target node identity does not match metadata')
    const step = targeting[metadata.stepIndex]
    if (!object(step) || step.kind !== 'target' || targetType(step.type) !== target.type) throw new Error('Gameplay target binding: target step is missing or has the wrong type')
    const range = numericParameter(target.statement, 'range', 5)
    const filter = enumParameter(target.statement, 'filter', target.type === 'cell' ? 'all' : 'enemy')
    if (step.range !== range || step.filter !== filter) throw new Error('Gameplay target binding: targeting declaration is stale')
    if (target.type === 'cell') {
      const walkable = booleanParameterWithDefault(target.statement, 'requireWalkable', true)
      const unoccupied = booleanParameterWithDefault(target.statement, 'requireUnoccupied', true)
      const declaredWalkable = typeof step.requireWalkable === 'boolean' ? step.requireWalkable : true
      const declaredUnoccupied = typeof step.requireUnoccupied === 'boolean' ? step.requireUnoccupied : true
      if (walkable !== undefined && declaredWalkable !== walkable) throw new Error('Gameplay target binding: walkability declaration is stale')
      if (unoccupied !== undefined && declaredUnoccupied !== unoccupied) throw new Error('Gameplay target binding: occupancy declaration is stale')
    }
  }
}
