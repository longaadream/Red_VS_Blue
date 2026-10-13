import type { AtomicRecipe, AtomicReplacement } from './atomic-graph-rewrite'
import type {
  GameplayCallStatement,
  GameplayLiteral,
  GameplayModuleGraph,
  GameplayStatement,
  GameplayValue,
  GameplayValueType,
} from './module-types'

/**
 * Compatibility calls for execution-local counters and text lists are only
 * storage conveniences.  Keep the migration as a graph rewrite so the
 * author-facing catalogue does not need to retain another set of aliases.
 *
 * The two families have different ownership semantics:
 *
 * - `local.*` aliases own an execution-scoped handle.  They become a typed
 *   `local.declare`/`local.read`/`local.write` sequence.
 * - `collection.text-list-*` aliases are graph-local mutable accumulators in
 *   the legacy host.  They are lowered by `migrateAtomicTextListGraph` to an
 *   execution-local handle; a per-call recipe cannot preserve the shared
 *   create output across loop iterations.
 */
export const ATOMIC_LOCAL_ALIAS_MODULES = new Set([
  'local.counter-create',
  'local.counter-add',
  'local.counter-read',
  'local.string-list-create',
  'local.string-list-append',
  'local.string-list-read',
  'collection.text-list-create',
  'collection.text-list-add',
])

/** The text-list aliases are retired by the graph-level pass below. */
export const ATOMIC_TEXT_LIST_ALIAS_MODULES = new Set([
  'collection.text-list-create',
  'collection.text-list-add',
])

const numberType = 'number'
const stringListType: GameplayValueType = { kind: 'list', element: 'string' }
const stringListTypeParameter = JSON.stringify(stringListType)

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })

function input(node: GameplayCallStatement, name: string): GameplayValue | undefined {
  const value = node.inputs?.[name]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.kind === 'input') return typeof record.name === 'string' && record.name.length > 0 ? value : undefined
  if (record.kind === 'output') return typeof record.node === 'string' && typeof record.port === 'string' ? value : undefined
  if (record.kind === 'literal') return Object.prototype.hasOwnProperty.call(record, 'value') ? value : undefined
  return undefined
}

function callLike(
  original: GameplayCallStatement,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>>,
  parameters?: Readonly<Record<string, GameplayLiteral>>,
): GameplayCallStatement {
  const next: Record<string, unknown> = { ...original, module, version: '1', inputs }
  if (parameters === undefined) delete next.parameters
  else next.parameters = parameters
  return next as GameplayCallStatement
}

function generatedCall(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>>,
  parameters?: Readonly<Record<string, GameplayLiteral>>,
): GameplayCallStatement {
  return {
    kind: 'call', id, module, version: '1', inputs,
    ...(parameters === undefined ? {} : { parameters }),
  }
}

const numberParameters = { valueType: numberType } as const
const stringListParameters = { valueType: stringListTypeParameter } as const

function migrateCounterCreate(node: GameplayCallStatement): AtomicReplacement | undefined {
  const initial = input(node, 'initial')
  if (!initial) return undefined
  return {
    statements: [callLike(node, 'local.declare', { initial }, numberParameters)],
    outputs: { counter: output(node.id, 'handle') },
  }
}

function migrateCounterRead(node: GameplayCallStatement): AtomicReplacement | undefined {
  const counter = input(node, 'counter')
  if (!counter) return undefined
  return {
    statements: [callLike(node, 'local.read', { handle: counter }, numberParameters)],
    outputs: { value: output(node.id, 'value') },
  }
}

function migrateCounterAdd(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const counter = input(node, 'counter')
  const amount = input(node, 'amount')
  if (!counter || !amount) return undefined
  const current = fresh('counter-read')
  const next = fresh('counter-add')
  const write = fresh('counter-write')
  return {
    statements: [
      generatedCall(current, 'local.read', { handle: counter }, numberParameters),
      generatedCall(next, 'math.add', { left: output(current, 'value'), right: amount }),
      generatedCall(write, 'local.write', { handle: counter, value: output(next, 'value') }, numberParameters),
      callLike(node, 'local.read', { handle: counter }, numberParameters),
    ],
    outputs: { value: output(node.id, 'value') },
  }
}

function migrateStringListCreate(node: GameplayCallStatement): AtomicReplacement | undefined {
  const items = input(node, 'items')
  if (!items) return undefined
  return {
    statements: [callLike(node, 'local.declare', { initial: items }, stringListParameters)],
    outputs: { list: output(node.id, 'handle') },
  }
}

function migrateStringListRead(node: GameplayCallStatement): AtomicReplacement | undefined {
  const list = input(node, 'list')
  if (!list) return undefined
  return {
    statements: [callLike(node, 'local.read', { handle: list }, stringListParameters)],
    outputs: { items: output(node.id, 'value') },
  }
}

function migrateStringListAppend(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const list = input(node, 'list')
  const value = input(node, 'value')
  if (!list || !value) return undefined
  const current = fresh('string-list-read')
  const one = fresh('string-list-item')
  const next = fresh('string-list-append')
  return {
    statements: [
      generatedCall(current, 'local.read', { handle: list }, stringListParameters),
      generatedCall(one, 'collection.singleton', { value }, { valueType: 'string' }),
      generatedCall(next, 'collection.concat', { left: output(current, 'value'), right: output(one, 'items') }, stringListParameters),
      callLike(node, 'local.write', { handle: list, value: output(next, 'items') }, stringListParameters),
    ],
    outputs: { success: output(node.id, 'success') },
  }
}

/** Lower the six handle aliases owned by this per-call migration unit. */
export const atomicLocalAliasRecipe: AtomicRecipe = (node, fresh): AtomicReplacement | undefined => {
  switch (node.module) {
    case 'local.counter-create': return migrateCounterCreate(node)
    case 'local.counter-add': return migrateCounterAdd(node, fresh)
    case 'local.counter-read': return migrateCounterRead(node)
    case 'local.string-list-create': return migrateStringListCreate(node)
    case 'local.string-list-append': return migrateStringListAppend(node, fresh)
    case 'local.string-list-read': return migrateStringListRead(node)
    default: return undefined
  }
}

type TextListScope = {
  readonly handles: Map<string, GameplayValue>
  readonly outputs: Map<string, Readonly<Record<string, GameplayValue>>>
}

type TextListRewriteContext = {
  readonly usedIds: Set<string>
}

type MaterializedValue = {
  readonly value: GameplayValue
  readonly statements: readonly GameplayStatement[]
}

function collectTextListIds(value: unknown, ids: Set<string>): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach(item => collectTextListIds(item, ids))
    return
  }
  const record = value as Record<string, unknown>
  if (typeof record.id === 'string') ids.add(record.id)
  Object.values(record).forEach(item => collectTextListIds(item, ids))
}

function freshTextListId(context: TextListRewriteContext, base: string): string {
  let id = base
  let suffix = 2
  while (context.usedIds.has(id)) id = `${base}-${suffix++}`
  context.usedIds.add(id)
  return id
}

function cloneTextListScope(scope: TextListScope): TextListScope {
  return { handles: new Map(scope.handles), outputs: new Map(scope.outputs) }
}

function emptyTextListScope(): TextListScope {
  return { handles: new Map(), outputs: new Map() }
}

function textListHandle(value: GameplayValue, scope: TextListScope): GameplayValue | undefined {
  if (value.kind !== 'output' || value.port !== 'items') return undefined
  return scope.handles.get(value.node)
}

function materializeTextListValue(
  value: GameplayValue,
  scope: TextListScope,
  context: TextListRewriteContext,
  ownerId: string,
): MaterializedValue {
  if (value.kind !== 'output') return { value, statements: [] }

  if (value.port === 'items') {
    const handle = scope.handles.get(value.node)
    if (handle) {
      const read = freshTextListId(context, `${ownerId}--text-list-read`)
      return {
        value: output(read, 'value'),
        statements: [generatedCall(read, 'local.read', { handle }, stringListParameters)],
      }
    }
  }

  const replacement = scope.outputs.get(value.node)?.[value.port]
  return replacement ? { value: replacement, statements: [] } : { value, statements: [] }
}

function materializeTextListValues(
  values: Readonly<Record<string, GameplayValue>> | undefined,
  scope: TextListScope,
  context: TextListRewriteContext,
  ownerId: string,
): { readonly values: Readonly<Record<string, GameplayValue>> | undefined; readonly statements: readonly GameplayStatement[] } {
  if (!values) return { values, statements: [] }
  const statements: GameplayStatement[] = []
  const next: Record<string, GameplayValue> = {}
  for (const [name, value] of Object.entries(values)) {
    const materialized = materializeTextListValue(value, scope, context, `${ownerId}--${name}`)
    statements.push(...materialized.statements)
    next[name] = materialized.value
  }
  return { values: next, statements }
}

function rewriteTextListCall(
  node: GameplayCallStatement,
  scope: TextListScope,
  context: TextListRewriteContext,
): readonly GameplayStatement[] | undefined {
  if (node.module === 'collection.text-list-create') {
    if (node.inputs && Object.keys(node.inputs).length > 0) {
      throw new Error(`text-list create ${node.id} does not accept inputs`)
    }
    const declare = freshTextListId(context, `${node.id}--text-list-declare`)
    scope.handles.set(node.id, output(declare, 'handle'))
    scope.outputs.delete(node.id)
    return [generatedCall(declare, 'local.declare', { initial: literal([]) }, stringListParameters)]
  }

  if (node.module !== 'collection.text-list-add') return undefined
  const items = input(node, 'items')
  const value = input(node, 'value')
  if (!items || !value) throw new Error(`text-list add ${node.id} requires items and value inputs`)
  const handle = textListHandle(items, scope)
  if (!handle) throw new Error(`text-list add ${node.id} requires a create-backed items reference`)

  const current = materializeTextListValue(items, scope, context, `${node.id}--current`)
  const item = materializeTextListValue(value, scope, context, `${node.id}--value`)
  const singleton = freshTextListId(context, `${node.id}--text-list-item`)
  const appended = freshTextListId(context, `${node.id}--text-list-append`)
  const write = freshTextListId(context, `${node.id}--text-list-write`)
  const read = freshTextListId(context, `${node.id}--text-list-read-after-write`)
  const count = freshTextListId(context, `${node.id}--text-list-count`)
  scope.handles.set(node.id, handle)
  scope.outputs.set(node.id, { count: output(count, 'value') })
  return [
    ...current.statements,
    ...item.statements,
    generatedCall(singleton, 'collection.singleton', { value: item.value }, { valueType: 'string' }),
    generatedCall(appended, 'collection.concat', { left: current.value, right: output(singleton, 'items') }, stringListParameters),
    generatedCall(write, 'local.write', { handle, value: output(appended, 'items') }, stringListParameters),
    generatedCall(read, 'local.read', { handle }, stringListParameters),
    generatedCall(count, 'collection.length', { items: output(read, 'value') }),
  ]
}

function containsTextListAlias(statements: readonly GameplayStatement[]): boolean {
  return statements.some(statement => {
    if (statement.kind === 'call') return ATOMIC_TEXT_LIST_ALIAS_MODULES.has(statement.module)
    if (statement.kind === 'if') return containsTextListAlias(statement.then) || containsTextListAlias(statement.else ?? [])
    if (statement.kind === 'foreach' || statement.kind === 'collection' || statement.kind === 'collection.map' || statement.kind === 'collection.filter' || statement.kind === 'collection.find' || statement.kind === 'collection.reduce') return containsTextListAlias(statement.body)
    if (statement.kind === 'while') return containsTextListAlias(statement.condition.body) || containsTextListAlias(statement.body)
    return false
  })
}

function rewriteTextListBody(
  statements: readonly GameplayStatement[],
  scope: TextListScope,
  context: TextListRewriteContext,
): GameplayStatement[] {
  const result: GameplayStatement[] = []
  for (const original of statements) {
    if (original.kind === 'call') {
      const replacement = rewriteTextListCall(original, scope, context)
      if (replacement) {
        result.push(...replacement)
        continue
      }
      const materialized = materializeTextListValues(original.inputs, scope, context, original.id)
      result.push(...materialized.statements, { ...original, ...(materialized.values ? { inputs: materialized.values } : {}) })
      continue
    }

    if (original.kind === 'if') {
      const condition = materializeTextListValue(original.condition, scope, context, `${original.id}--condition`)
      const thenScope = cloneTextListScope(scope)
      const elseScope = cloneTextListScope(scope)
      result.push(
        ...condition.statements,
        {
          ...original,
          condition: condition.value,
          then: rewriteTextListBody(original.then, thenScope, context),
          ...(original.else ? { else: rewriteTextListBody(original.else, elseScope, context) } : {}),
        },
      )
      continue
    }

    if (original.kind === 'foreach') {
      const items = materializeTextListValue(original.items, scope, context, `${original.id}--items`)
      result.push(
        ...items.statements,
        { ...original, items: items.value, body: rewriteTextListBody(original.body, cloneTextListScope(scope), context) },
      )
      continue
    }

    if (original.kind === 'while') {
      for (const value of Object.values(original.condition.inputs ?? {})) {
        if (textListHandle(value, scope)) throw new Error(`text-list value cannot be captured by while condition ${original.id}`)
      }
      if (containsTextListAlias(original.condition.body)) throw new Error(`text-list alias cannot run inside while condition ${original.id}`)
      const conditionInputs = materializeTextListValues(original.condition.inputs, scope, context, `${original.id}--condition-input`)
      const body = rewriteTextListBody(original.body, cloneTextListScope(scope), context)
      const conditionBody = rewriteTextListBody(original.condition.body, cloneTextListScope(scope), context)
      result.push(
        ...conditionInputs.statements,
        {
          ...original,
          condition: { ...original.condition, ...(conditionInputs.values ? { inputs: conditionInputs.values } : {}), body: conditionBody },
          body,
        },
      )
      continue
    }

    if (original.kind === 'collection' || original.kind === 'collection.map' || original.kind === 'collection.filter' || original.kind === 'collection.find' || original.kind === 'collection.reduce') {
      if (containsTextListAlias(original.body)) throw new Error(`text-list alias cannot run inside collection body ${original.id}`)
      const items = materializeTextListValue(original.items, scope, context, `${original.id}--items`)
      const inputs = materializeTextListValues(original.inputs, scope, context, `${original.id}--input`)
      const initial = 'initial' in original && original.initial !== undefined
        ? materializeTextListValue(original.initial, scope, context, `${original.id}--initial`)
        : undefined
      result.push(
        ...items.statements,
        ...inputs.statements,
        ...(initial?.statements ?? []),
        {
          ...original,
          items: items.value,
          ...(inputs.values ? { inputs: inputs.values } : {}),
          ...(initial ? { initial: initial.value } : {}),
          body: rewriteTextListBody(original.body, cloneTextListScope(scope), context),
        } as GameplayStatement,
      )
      continue
    }

    if (original.kind === 'record.create') {
      const fields = materializeTextListValues(original.fields, scope, context, original.id)
      result.push(...fields.statements, { ...original, ...(fields.values ? { fields: fields.values } : {}) })
      continue
    }

    if (original.kind === 'record.get') {
      const record = materializeTextListValue(original.record, scope, context, original.id)
      result.push(...record.statements, { ...original, record: record.value })
      continue
    }

    if (original.kind === 'record.with') {
      const record = materializeTextListValue(original.record, scope, context, `${original.id}--record`)
      const fields = materializeTextListValues(original.fields, scope, context, `${original.id}--field`)
      result.push(...record.statements, ...fields.statements, { ...original, record: record.value, ...(fields.values ? { fields: fields.values } : {}) })
      continue
    }

    if (original.kind === 'defer-choice') {
      const fields = ['payload', 'player', 'title', 'targetType', 'range', 'filter', 'candidates', 'selectionMode', 'min', 'max', 'minSelections', 'maxSelections', 'canCancel', 'resumeOnCancel', 'message'] as const
      let node: GameplayStatement = original
      const generated: GameplayStatement[] = []
      for (const field of fields) {
        const value = original[field]
        if (value === undefined) continue
        const materialized = materializeTextListValue(value, scope, context, `${original.id}--${field}`)
        generated.push(...materialized.statements)
        node = { ...node, [field]: materialized.value }
      }
      result.push(...generated, node)
      continue
    }

    if (original.kind === 'return') {
      const values = materializeTextListValues(original.values, scope, context, original.id)
      const value = original.value === undefined ? undefined : materializeTextListValue(original.value, scope, context, `${original.id}--value`)
      result.push(...values.statements, ...(value?.statements ?? []), {
        ...original,
        ...(values.values ? { values: values.values } : {}),
        ...(value ? { value: value.value } : {}),
      })
      continue
    }

    result.push(original)
  }
  return result
}

function migrateTextListGraphWithContext(graph: GameplayModuleGraph, context: TextListRewriteContext): GameplayModuleGraph {
  const rewrite = (body: readonly GameplayStatement[]): readonly GameplayStatement[] => rewriteTextListBody(body, emptyTextListScope(), context)
  return {
    ...graph,
    body: rewrite(graph.body),
    ...(graph.composites ? { composites: graph.composites.map(composite => ({ ...composite, body: rewrite(composite.body) })) } : {}),
    ...(graph.continuations ? { continuations: graph.continuations.map(continuation => ({ ...continuation, graph: migrateTextListGraphWithContext(continuation.graph, context) })) } : {}),
  }
}

/**
 * Lower legacy text-list mutation at graph scope.  The create node owns one
 * execution-local handle; every later read emits a fresh local.read so branch
 * and loop writes are visible at the actual read site.  This pass must run
 * before the per-call six-alias recipe.
 */
export function migrateAtomicTextListGraph(graph: GameplayModuleGraph): GameplayModuleGraph {
  const usedIds = new Set<string>()
  collectTextListIds(graph, usedIds)
  return migrateTextListGraphWithContext(graph, { usedIds })
}
