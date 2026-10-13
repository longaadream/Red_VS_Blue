import { rewriteAtomicGraph, type AtomicRecipe, type AtomicReplacement } from './atomic-graph-rewrite'
import type {
  GameplayCallStatement,
  GameplayJsonValue,
  GameplayModuleGraph,
  GameplayRecordCreateStatement,
  GameplayRecordGetStatement,
  GameplayStatement,
  GameplayValue,
} from './module-types'

/**
 * Migrate the historical Mangekyo action-record call to the generic typed
 * structured-log boundary.  The compatibility call is recognized by its
 * `action` input; already-authored generic calls use `type`/`payload` inputs
 * and therefore remain untouched.
 */
export const ATOMIC_STRUCTURED_ACTION_LOG_MODULES = new Set(['followup.action.append'])
export const ATOMIC_STRUCTURED_ACTION_LOG_MODULE_IDS = ATOMIC_STRUCTURED_ACTION_LOG_MODULES

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
): GameplayCallStatement {
  return { kind: 'call', id, module, version: module === 'followup.action.append' ? '2' : '1', inputs, parameters }
}

type RewriteScope = {
  getDefinition(id: string): GameplayStatement | undefined
}

function recordCreateFor(value: GameplayValue | undefined, scope: RewriteScope | undefined): GameplayRecordCreateStatement | undefined {
  if (!value || value.kind !== 'output') return undefined
  const statement = scope?.getDefinition(value.node)
  return statement?.kind === 'record.create' ? statement : undefined
}

function payloadSchemaForAction(action: GameplayValue, scope: RewriteScope | undefined): string | undefined {
  const actionDefinition = recordCreateFor(action, scope)
  const payload = actionDefinition?.fields?.payload
  const payloadDefinition = recordCreateFor(payload, scope)
  return payloadDefinition?.schema
}

function recordGet(id: string, record: GameplayValue, field: string): GameplayRecordGetStatement {
  return { kind: 'record.get', id, record, field }
}

function replaceStructuredActionLog(
  node: GameplayCallStatement,
  fresh: (suffix: string) => string,
  scope: RewriteScope | undefined,
): AtomicReplacement | undefined {
  const action = node.inputs?.action
  if (!action) return undefined
  const payloadSchema = payloadSchemaForAction(action, scope)
  if (!payloadSchema) return undefined

  const type = fresh('action-type')
  const playerId = fresh('action-player')
  const turn = fresh('action-turn')
  const payload = fresh('action-payload')
  return {
    statements: [
      recordGet(type, action, 'type'),
      recordGet(playerId, action, 'playerId'),
      recordGet(turn, action, 'turn'),
      recordGet(payload, action, 'payload'),
      call(node.id, 'followup.action.append', {
        type: output(type),
        playerId: output(playerId),
        turn: output(turn),
        payload: output(payload),
      }, { payloadSchema }),
    ],
    outputs: { success: output(node.id, 'success') },
  }
}

export const atomicStructuredActionLogRecipe: AtomicRecipe = (node, fresh, scope) => (
  node.module !== 'followup.action.append' || (node.version ?? '1') !== '1'
    ? undefined
    : Object.hasOwn(node.inputs ?? {}, 'action')
      ? replaceStructuredActionLog(node, fresh, scope)
      // A short-lived branch previously emitted the generic shape as v1.
      // Upgrade that shape in place so drafts can still be repaired without
      // changing the historical v1 action-record lowering.
      : Object.hasOwn(node.inputs ?? {}, 'type') && Object.hasOwn(node.inputs ?? {}, 'payload')
        ? { statements: [{ ...node, version: '2' }] }
        : undefined
)

export function migrateStructuredActionLogModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicStructuredActionLogRecipe)
}

export const migrateAtomicStructuredActionLogGraph = migrateStructuredActionLogModules
