import type {
  GameplayCallStatement,
  GameplayCompositeDefinition,
  GameplayJsonValue,
  GameplayModuleGraph,
  GameplayRecordCreateStatement,
  GameplayRecordGetStatement,
  GameplayRecordSchema,
  GameplayStatement,
  GameplayValue,
  GameplayValueType,
} from './module-types'
import { rewriteAtomicGraph, type AtomicRecipe, type AtomicReplacement } from './atomic-graph-rewrite'

/**
 * The last authoring-only helpers are deliberately kept in one migration
 * package.  They are graph-local compatibility constructs: the resulting
 * documents contain only ordinary field writes and the generic statements
 * already understood by the editor.
 */
export const ATOMIC_REMAINING_AUTHORING_MODULES = new Set([
  'attribute.set-momentum',
  'shared.flight-move-one',
  'shared.half-damage',
  'shared.result-message',
  'shared.status-event-guard',
])

const TARGET_COMPOSITES = new Set([
  'shared.flight-move-one@1',
  'shared.half-damage@1',
  'shared.result-message@1',
  'shared.status-event-guard@1',
])

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const typeParameter = (type: GameplayValueType): GameplayJsonValue => typeof type === 'string' ? type : JSON.stringify(type)

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
  version = '1',
): GameplayCallStatement {
  return { kind: 'call', id, module, version, inputs, parameters }
}

function key(id: string, version: string): string {
  return `${id}@${version}`
}

function momentumRecipe(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  if (node.module !== 'attribute.set-momentum') return undefined
  const piece = node.inputs?.piece
  const value = node.inputs?.value
  if (!piece || !value) return undefined

  // The write is intentionally generic. The follow-up read observes the
  // canonical piece.momentum field after the write, so the migration never
  // creates a second extension-owned momentum value.
  const write = fresh('write-momentum')
  const read = fresh('read-momentum')
  return {
    statements: [
      call(write, 'piece.write-field', { piece, value }, { field: 'momentum', valueType: 'number' }),
      call(read, 'piece.field', { piece }, { field: 'momentum' }),
    ],
    outputs: { value: output(read, 'value') },
  }
}

type InlineState = {
  readonly composites: ReadonlyMap<string, GameplayCompositeDefinition>
  readonly usedIds: Set<string>
  readonly schemaIds: Set<string>
  readonly schemas: GameplayRecordSchema[]
}

type Bindings = Map<string, Readonly<Record<string, GameplayValue>>>

function collectIds(value: unknown, used: Set<string>): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach(item => collectIds(item, used))
    return
  }
  const record = value as Record<string, unknown>
  if (typeof record.id === 'string') used.add(record.id)
  Object.values(record).forEach(item => collectIds(item, used))
}

function freshId(state: InlineState, base: string): string {
  let result = base
  let index = 2
  while (state.usedIds.has(result)) result = `${base}-${index++}`
  state.usedIds.add(result)
  return result
}

function freshSchemaId(state: InlineState, callId: string): string {
  const stem = `atomic-inline-${callId.replace(/[^a-zA-Z0-9_-]+/g, '-')}`
  let result = stem
  let index = 2
  while (state.schemaIds.has(result)) result = `${stem}-${index++}`
  state.schemaIds.add(result)
  return result
}

function substituteValue(
  value: GameplayValue,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  renamed = new Map<string, string>(),
  bindings?: Bindings,
): GameplayValue {
  if (value.kind === 'literal') return value
  if (value.kind === 'input') return inputs[value.name] ?? value
  const bound = bindings?.get(value.node)?.[value.port]
  if (bound) return bound
  return { ...value, node: renamed.get(value.node) ?? value.node }
}

function substituteValues(
  values: Readonly<Record<string, GameplayValue>> | undefined,
  inputs: Readonly<Record<string, GameplayValue>>,
  renamed: Map<string, string>,
  bindings?: Bindings,
): Readonly<Record<string, GameplayValue>> {
  return Object.fromEntries(Object.entries(values ?? {}).map(([name, value]) => [name, substituteValue(value, inputs, renamed, bindings)]))
}

function renameValueMap(
  values: Readonly<Record<string, GameplayValue>> | undefined,
  bindings: Bindings,
): Readonly<Record<string, GameplayValue>> {
  return Object.fromEntries(Object.entries(values ?? {}).map(([name, value]) => [name, substituteValue(value, {}, new Map(), bindings)]))
}

function substituteStatement(statement: GameplayStatement, bindings: Bindings): GameplayStatement {
  switch (statement.kind) {
    case 'call':
      return { ...statement, inputs: renameValueMap(statement.inputs, bindings) }
    case 'if':
      return { ...statement, condition: substituteValue(statement.condition, {}, new Map(), bindings) }
    case 'foreach':
      return { ...statement, items: substituteValue(statement.items, {}, new Map(), bindings) }
    case 'while':
      return {
        ...statement,
        condition: { ...statement.condition, inputs: renameValueMap(statement.condition.inputs, bindings) },
      }
    case 'record.create':
      return { ...statement, fields: renameValueMap(statement.fields, bindings) }
    case 'record.get':
      return { ...statement, record: substituteValue(statement.record, {}, new Map(), bindings) }
    case 'record.with':
      return {
        ...statement,
        record: substituteValue(statement.record, {}, new Map(), bindings),
        fields: renameValueMap(statement.fields, bindings),
      }
    case 'collection':
    case 'collection.map':
    case 'collection.filter':
    case 'collection.find':
    case 'collection.reduce':
      {
        const initial = 'initial' in statement ? statement.initial : undefined
      return {
        ...statement,
        items: substituteValue(statement.items, {}, new Map(), bindings),
        inputs: renameValueMap(statement.inputs, bindings),
        ...(initial === undefined ? {} : { initial: substituteValue(initial, {}, new Map(), bindings) }),
      }
      }
    case 'defer-choice': {
      const result = { ...statement }
      for (const field of ['payload', 'player', 'title', 'targetType', 'range', 'filter', 'candidates', 'selectionMode', 'min', 'max', 'minSelections', 'maxSelections', 'canCancel', 'resumeOnCancel', 'message'] as const) {
        if (result[field] !== undefined) result[field] = substituteValue(result[field], {}, new Map(), bindings) as never
      }
      return result
    }
    case 'return':
      return {
        ...statement,
        ...(statement.values ? { values: renameValueMap(statement.values, bindings) } : {}),
        ...(statement.value ? { value: substituteValue(statement.value, {}, new Map(), bindings) } : {}),
      }
  }
}

function compositeSchema(state: InlineState, composite: GameplayCompositeDefinition, callId: string): { id: string; type: GameplayValueType } {
  const id = freshSchemaId(state, callId)
  state.schemas.push({
    id,
    version: '1',
    fields: composite.outputs.map(port => ({ ...port })),
  })
  return { id, type: { kind: 'record', schema: id } }
}

function cloneCompositeStatement(
  statement: GameplayStatement,
  inputBindings: Readonly<Record<string, GameplayValue>>,
  renamed: Map<string, string>,
): GameplayStatement {
  const id = renamed.get(statement.id) ?? statement.id
  switch (statement.kind) {
    case 'call':
      return { ...statement, id, inputs: substituteValues(statement.inputs, inputBindings, renamed) }
    case 'if':
      return {
        ...statement,
        id,
        condition: substituteValue(statement.condition, inputBindings, renamed),
        then: statement.then.map(child => cloneCompositeStatement(child, inputBindings, renamed)),
        ...(statement.else ? { else: statement.else.map(child => cloneCompositeStatement(child, inputBindings, renamed)) } : {}),
      }
    case 'foreach':
      return {
        ...statement,
        id,
        items: substituteValue(statement.items, inputBindings, renamed),
        body: statement.body.map(child => cloneCompositeStatement(child, inputBindings, renamed)),
      }
    case 'while':
      return {
        ...statement,
        id,
        condition: {
          ...statement.condition,
          inputs: substituteValues(statement.condition.inputs, inputBindings, renamed),
          body: statement.condition.body.map(child => cloneCompositeStatement(child, inputBindings, renamed)),
        },
        body: statement.body.map(child => cloneCompositeStatement(child, inputBindings, renamed)),
      }
    case 'record.create':
      return { ...statement, id, fields: substituteValues(statement.fields, inputBindings, renamed) } as GameplayRecordCreateStatement
    case 'record.get':
      return { ...statement, id, record: substituteValue(statement.record, inputBindings, renamed) } as GameplayRecordGetStatement
    case 'record.with':
      return {
        ...statement,
        id,
        record: substituteValue(statement.record, inputBindings, renamed),
        fields: substituteValues(statement.fields, inputBindings, renamed),
      }
    case 'collection':
    case 'collection.map':
    case 'collection.filter':
    case 'collection.find':
    case 'collection.reduce':
      {
      const initial = 'initial' in statement ? statement.initial : undefined
      return {
        ...statement,
        id,
        items: substituteValue(statement.items, inputBindings, renamed),
        inputs: substituteValues(statement.inputs, inputBindings, renamed),
        ...(initial === undefined ? {} : { initial: substituteValue(initial, inputBindings, renamed) }),
        body: statement.body.map(child => cloneCompositeStatement(child, inputBindings, renamed)),
      }
      }
    case 'defer-choice': {
      const result = { ...statement, id }
      for (const field of ['payload', 'player', 'title', 'targetType', 'range', 'filter', 'candidates', 'selectionMode', 'min', 'max', 'minSelections', 'maxSelections', 'canCancel', 'resumeOnCancel', 'message'] as const) {
        if (result[field] !== undefined) result[field] = substituteValue(result[field], inputBindings, renamed) as never
      }
      return result
    }
    case 'return':
      return {
        ...statement,
        id,
        ...(statement.values ? { values: substituteValues(statement.values, inputBindings, renamed) } : {}),
        ...(statement.value ? { value: substituteValue(statement.value, inputBindings, renamed) } : {}),
      }
  }
}

function returnFields(statement: Extract<GameplayStatement, { kind: 'return' }>, composite: GameplayCompositeDefinition): Readonly<Record<string, GameplayValue>> {
  if (statement.values) return statement.values
  const first = composite.outputs[0]
  if (!first || !statement.value) throw new Error(`${composite.id}@${composite.version}: scalar return has no output port`)
  return { [first.name]: statement.value }
}

/**
 * Returns whether a sequence contains a return for the enclosing composite.
 * Collection bodies are deliberately excluded: their returns produce
 * collection elements and do not terminate the composite invocation.
 */
function containsCompositeReturn(statements: readonly GameplayStatement[]): boolean {
  return statements.some(statement => {
    if (statement.kind === 'return') return true
    if (statement.kind === 'if') return containsCompositeReturn(statement.then) || Boolean(statement.else && containsCompositeReturn(statement.else))
    if (statement.kind === 'foreach' || statement.kind === 'while') return containsCompositeReturn(statement.body)
    return false
  })
}

/**
 * A direct inline is only safe when every composite return is the final
 * statement of its branch.  Unsupported early returns are rejected before
 * any graph is written; otherwise a nested return could escape into the
 * caller's graph.
 */
function hasEarlyCompositeReturn(statements: readonly GameplayStatement[]): boolean {
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index]
    if (index < statements.length - 1 && containsCompositeReturn([statement])) return true
    if (statement.kind === 'if') {
      if (hasEarlyCompositeReturn(statement.then) || Boolean(statement.else && hasEarlyCompositeReturn(statement.else))) return true
    } else if (statement.kind === 'foreach' || statement.kind === 'while') {
      if (hasEarlyCompositeReturn(statement.body)) return true
    }
  }
  return false
}

/** Composite returns inside execution loops are not safe to capture through
 * a graph-local record; reject them rather than letting them escape. */
function containsLoopCompositeReturn(statements: readonly GameplayStatement[]): boolean {
  return statements.some(statement => {
    if (statement.kind === 'foreach' || statement.kind === 'while') return containsCompositeReturn(statement.body) || containsLoopCompositeReturn(statement.body)
    if (statement.kind === 'if') return containsLoopCompositeReturn(statement.then) || Boolean(statement.else && containsLoopCompositeReturn(statement.else))
    return false
  })
}

function inlineComposite(
  state: InlineState,
  node: GameplayCallStatement,
  composite: GameplayCompositeDefinition,
  processBody: (statements: readonly GameplayStatement[], bindings: Bindings, inCollection: boolean) => GameplayStatement[],
): { readonly statements: readonly GameplayStatement[]; readonly outputs: Readonly<Record<string, GameplayValue>> } {
  const inputBindings = node.inputs ?? {}
  const renamed = new Map<string, string>()
  const collectBodyIds = (statements: readonly GameplayStatement[]): void => statements.forEach(statement => {
    renamed.set(statement.id, freshId(state, `${node.id}--${statement.id}`))
    if (statement.kind === 'if') {
      collectBodyIds(statement.then)
      if (statement.else) collectBodyIds(statement.else)
    } else if (statement.kind === 'foreach' || statement.kind === 'collection' || statement.kind === 'collection.map' || statement.kind === 'collection.filter' || statement.kind === 'collection.find' || statement.kind === 'collection.reduce') collectBodyIds(statement.body)
    else if (statement.kind === 'while') { collectBodyIds(statement.condition.body); collectBodyIds(statement.body) }
  })
  collectBodyIds(composite.body)

  const cloned = composite.body.map(statement => cloneCompositeStatement(statement, inputBindings, renamed))
  const terminal = cloned.at(-1)
  const hasEarlyReturn = hasEarlyCompositeReturn(cloned)
  const hasLoopReturn = containsLoopCompositeReturn(cloned)
  if (hasEarlyReturn || hasLoopReturn) {
    throw new Error(`${composite.id}@${composite.version}: return must terminate its branch`)
  }
  if (terminal?.kind === 'return') {
    const direct = cloned.slice(0, -1)
    const values = returnFields(terminal, composite)
    return { statements: processBody(direct, new Map(), false), outputs: values }
  }

  const resultSchema = compositeSchema(state, composite, node.id)
  const handle = freshId(state, `${node.id}--result-handle`)
  const read = freshId(state, `${node.id}--result-read`)
  const resultType = typeParameter(resultSchema.type)
  const body: GameplayStatement[] = []

  body.push(call(handle, 'local.declare', {}, { valueType: resultType }))
  const writeReturns = (statements: readonly GameplayStatement[]): GameplayStatement[] => {
    const result: GameplayStatement[] = []
    for (let index = 0; index < statements.length; index += 1) {
      const statement = statements[index]
      if (statement.kind === 'return') {
        if (index !== statements.length - 1) throw new Error(`${composite.id}@${composite.version}: return must terminate its branch`)
        const fields = returnFields(statement, composite)
        const record = freshId(state, `${node.id}--${statement.id}-record`)
        const write = freshId(state, `${node.id}--${statement.id}-write`)
        result.push({ kind: 'record.create', id: record, schema: resultSchema.id, fields })
        result.push(call(write, 'local.write', { handle: output(handle, 'handle'), value: output(record, 'value') }, { valueType: resultType }))
        continue
      }
      if (statement.kind === 'if') {
        result.push({
          ...statement,
          then: writeReturns(statement.then),
          ...(statement.else ? { else: writeReturns(statement.else) } : {}),
        })
        continue
      }
      if (statement.kind === 'foreach') {
        result.push({ ...statement })
        continue
      }
      if (statement.kind === 'collection' || statement.kind === 'collection.map' || statement.kind === 'collection.filter' || statement.kind === 'collection.find' || statement.kind === 'collection.reduce') {
        result.push({ ...statement })
        continue
      }
      if (statement.kind === 'while') {
        result.push({ ...statement, condition: { ...statement.condition, body: statement.condition.body }, body: statement.body })
        continue
      }
      result.push(statement)
    }
    return result
  }

  // `return` statements in collection bodies are collection element returns,
  // not composite returns. Preserve them verbatim; all other returns capture
  // the composite result record in the execution-local handle.
  const captured = writeReturns(cloned)
  body.push(...processBody(captured, new Map(), false))
  body.push(call(read, 'local.read', { handle: output(handle, 'handle') }, { valueType: resultType }))

  const outputs: Record<string, GameplayValue> = {}
  for (const port of composite.outputs) {
    const get = freshId(state, `${node.id}--result-${port.name}`)
    body.push({ kind: 'record.get', id: get, record: output(read, 'value'), field: port.name })
    outputs[port.name] = output(get, 'value')
  }
  return { statements: body, outputs }
}

function inlineSequence(state: InlineState, statements: readonly GameplayStatement[], inherited: Bindings, inCollection: boolean): GameplayStatement[] {
  const bindings = new Map(inherited)
  const result: GameplayStatement[] = []
  const process = (nested: readonly GameplayStatement[], scope: Bindings, nestedCollection: boolean): GameplayStatement[] => inlineSequence(state, nested, scope, nestedCollection)
  for (const original of statements) {
    let node = substituteStatement(original, bindings)
    if (original.kind === 'if') {
      node = {
        ...node,
        then: process(original.then, new Map(bindings), inCollection),
        ...(original.else ? { else: process(original.else, new Map(bindings), inCollection) } : {}),
      } as GameplayStatement
    } else if (original.kind === 'foreach') {
      node = { ...node, body: process(original.body, new Map(), true) } as GameplayStatement
    } else if (original.kind === 'while') {
      node = {
        ...node,
        condition: { ...original.condition, body: process(original.condition.body, new Map(), true) },
        body: process(original.body, new Map(), true),
      } as GameplayStatement
    } else if (original.kind === 'collection' || original.kind === 'collection.map' || original.kind === 'collection.filter' || original.kind === 'collection.find' || original.kind === 'collection.reduce') {
      node = { ...node, body: process(original.body, new Map(), true) } as GameplayStatement
    }
    bindings.delete(original.id)
    if (node.kind === 'call') {
      const composite = state.composites.get(key(node.module, node.version))
      if (composite && TARGET_COMPOSITES.has(key(node.module, node.version))) {
        const replacement = inlineComposite(state, node, composite, process)
        result.push(...replacement.statements)
        bindings.set(original.id, replacement.outputs)
        continue
      }
    }
    result.push(node)
  }
  return result
}

function inlineRemainingComposites(graph: GameplayModuleGraph): GameplayModuleGraph {
  const composites = new Map((graph.composites ?? []).map(composite => [key(composite.id, composite.version), composite]))
  if (!graph.composites?.some(composite => TARGET_COMPOSITES.has(key(composite.id, composite.version)))) return graph
  const usedIds = new Set<string>()
  collectIds(graph, usedIds)
  const schemaIds = new Set((graph.schemas ?? []).map(schema => schema.id))
  const schemas = [...(graph.schemas ?? [])]
  const state: InlineState = { composites, usedIds, schemaIds, schemas }
  const body = inlineSequence(state, graph.body, new Map(), false)
  const remaining = (graph.composites ?? []).filter(composite => !TARGET_COMPOSITES.has(key(composite.id, composite.version)))
    .map(composite => ({ ...composite, body: inlineSequence(state, composite.body, new Map(), false) }))
  return {
    ...graph,
    body,
    ...(remaining.length ? { composites: remaining } : { composites: [] }),
    schemas,
  }
}

/** Recipe for replacing the last role-specific momentum writer. */
export const atomicRemainingAuthoringRecipe: AtomicRecipe = momentumRecipe

/** Migrate the remaining author-only aliases and graph-local composites. */
export function migrateRemainingAuthoringModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return inlineRemainingComposites(rewriteAtomicGraph(graph, atomicRemainingAuthoringRecipe))
}

export const migrateAtomicRemainingAuthoringGraph = migrateRemainingAuthoringModules
