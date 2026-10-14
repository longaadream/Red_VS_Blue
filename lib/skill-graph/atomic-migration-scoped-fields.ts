import { rewriteAtomicGraph, type AtomicRecipe, type AtomicReplacement } from './atomic-graph-rewrite'
import type { GameplayCallStatement, GameplayJsonValue, GameplayModuleGraph, GameplayValue } from './module-types'

/**
 * Expand the remaining scoped field adapters into ordinary field reads,
 * arithmetic, and closed assignment modules. The historical descriptors stay
 * registered for loading old resources; this recipe is the migration boundary
 * that removes them from a new author graph.
 */
export const ATOMIC_SCOPED_FIELD_MODULES = new Set([
  'attribute.adjust-captured',
  'attribute.set-stored',
  'piece.set-stored-flag',
])
export const ATOMIC_SCOPED_FIELD_MODULE_IDS = ATOMIC_SCOPED_FIELD_MODULES

const SCOPED_FIELDS = new Set(['attack', 'defense', 'moveRange'])

function value(call: GameplayCallStatement, name: string): GameplayValue | undefined {
  const candidate = call.inputs?.[name]
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
  const record = candidate as Record<string, unknown>
  if (record.kind === 'literal') return Object.hasOwn(record, 'value') ? candidate : undefined
  if (record.kind === 'input') return typeof record.name === 'string' && record.name.length > 0 ? candidate : undefined
  if (record.kind === 'output') return typeof record.node === 'string' && record.node.length > 0 && typeof record.port === 'string' && record.port.length > 0 ? candidate : undefined
  return undefined
}

function output(node: string, port = 'value'): GameplayValue {
  return { kind: 'output', node, port }
}

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>>,
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
): GameplayCallStatement {
  return { kind: 'call', id, module, version: '1', inputs, parameters }
}

function field(call: GameplayCallStatement): string | undefined {
  const selected = call.parameters?.attribute
  return typeof selected === 'string' && SCOPED_FIELDS.has(selected) ? selected : undefined
}

function replaceCapturedAdjustment(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const source = value(node, 'source')
  const amount = value(node, 'amount')
  const selected = field(node)
  if (!source || !amount || !selected) return undefined

  const current = fresh('captured-field')
  const next = fresh('captured-next')
  const write = fresh('captured-write')
  return {
    statements: [
      call(current, 'source.field', { source }, { field: selected }),
      call(next, 'math.add', { left: output(current), right: amount }),
      call(write, 'source.write-field', { source, value: output(next) }, { field: selected, valueType: 'number' }),
    ],
    // The writer's value port is only finite/defined after the authenticated
    // setter accepted the write.  Do not infer this dependency from statement
    // order by reading the source again: invalid writer output must propagate
    // as the graph's invalid sentinel.
    outputs: { value: output(write, 'value') },
  }
}

function replaceStoredAssignment(node: GameplayCallStatement): AtomicReplacement | undefined {
  const id = value(node, 'id')
  const next = value(node, 'value')
  const selected = field(node)
  if (!id || !next || !selected) return undefined
  return {
    statements: [{
      ...node,
      module: 'piece.write-field',
      version: '2',
      inputs: { id, value: next },
      parameters: { scope: 'stored', field: selected, valueType: 'number' },
    }],
    outputs: { success: output(node.id, 'success') },
  }
}

function replaceStoredPresentationFlag(node: GameplayCallStatement): AtomicReplacement | undefined {
  if (node.version !== '1' || node.parameters?.field !== 'showFreezeEffect') return undefined
  const id = value(node, 'id')
  const flag = value(node, 'value')
  if (!id || !flag) return undefined
  return {
    statements: [{
      ...node,
      module: 'piece.write-field',
      version: '2',
      inputs: { id, value: flag },
      parameters: { scope: 'stored', field: 'showFreezeEffect', valueType: 'boolean' },
    }],
    outputs: { success: output(node.id, 'success') },
  }
}

export const atomicScopedFieldRecipe: AtomicRecipe = (node, fresh): AtomicReplacement | undefined => {
  if (node.module === 'attribute.adjust-captured') return replaceCapturedAdjustment(node, fresh)
  if (node.module === 'attribute.set-stored') return replaceStoredAssignment(node)
  if (node.module === 'piece.set-stored-flag') return replaceStoredPresentationFlag(node)
  return undefined
}

export function migrateScopedFieldModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicScopedFieldRecipe)
}

export const migrateAtomicScopedFieldGraph = migrateScopedFieldModules
