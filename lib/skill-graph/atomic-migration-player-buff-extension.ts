import { rewriteAtomicGraph, type AtomicRecipe, type AtomicReplacement } from './atomic-graph-rewrite'
import type {
  GameplayCallStatement,
  GameplayJsonValue,
  GameplayModuleGraph,
  GameplayStatement,
  GameplayValue,
  GameplayValueType,
} from './module-types'

/**
 * The first Elune implementation stored its records in player.buffs.  Keep
 * that storage authoritative while exposing it through the generic author
 * extension API.  The namespace is deliberately explicit so a future author
 * variable cannot accidentally alias the legacy projection.
 */
export const LEGACY_PLAYER_BUFF_NAMESPACE = 'legacy-player-buffs'

/** Compatibility IDs retired by this migration. */
export const ATOMIC_PLAYER_BUFF_MODULES = new Set([
  'player.set-buff-record',
  'player.buff-record',
  'player.write-buff-uses',
  'player.consume-buff',
])
export const ATOMIC_PLAYER_BUFF_MODULE_IDS = ATOMIC_PLAYER_BUFF_MODULES

const recordType: GameplayValueType = 'record'
const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const nullableNumberType: GameplayValueType = { kind: 'nullable', value: numberType }

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const typeParameter = (type: GameplayValueType): GameplayJsonValue => (
  typeof type === 'string' ? type : JSON.stringify(type)
)

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
  version = '1',
): GameplayCallStatement {
  return { kind: 'call', id, module, version, inputs, parameters }
}

function requiredInput(node: GameplayCallStatement, name: string): GameplayValue | undefined {
  const value = node.inputs?.[name]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.kind === 'literal') return Object.prototype.hasOwnProperty.call(record, 'value') ? value : undefined
  if (record.kind === 'input') return typeof record.name === 'string' && record.name.length > 0 ? value : undefined
  return record.kind === 'output' && typeof record.node === 'string' && record.node.length > 0
    && typeof record.port === 'string' && record.port.length > 0 ? value : undefined
}

function extensionParameters(name: string, path?: string): Record<string, GameplayJsonValue> {
  return {
    namespace: LEGACY_PLAYER_BUFF_NAMESPACE,
    name,
    ...(path === undefined ? {} : { path }),
    valueType: typeParameter(recordType),
  }
}

function readKey(
  id: string,
  record: GameplayValue,
  key: string,
  valueType: GameplayValueType,
): GameplayCallStatement {
  return call(id, 'data.read-key', { record }, {
    key,
    valueType: typeParameter(valueType),
  })
}

function recordSet(
  id: string,
  record: GameplayValue,
  key: string,
  value: GameplayValue,
): GameplayCallStatement {
  return call(id, 'record.set-key', {
    record,
    key: literal(key),
    value,
  }, { valueType: typeParameter(numberType) })
}

/**
 * Read a nullable legacy snapshot and apply the buff defaults only to this
 * invocation's calculations.  The old player.buff-record reader returned
 * null for a missing entry; declaring an extension value here would leak the
 * calculation default into a later pure read in the same execution.
 */
function localBuffRecord(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  player: GameplayValue,
  buffId: string,
): GameplayValue {
  const empty = fresh('buff-default')
  const withUses = fresh('buff-default-uses')
  const withMultiplier = fresh('buff-default-multiplier')
  const read = fresh('buff-read-optional')
  const effective = fresh('buff-effective')
  statements.push(
    call(read, 'extension.read-optional-player', { owner: player }, extensionParameters(buffId, '')),
    call(empty, 'record.empty'),
    recordSet(withUses, output(empty, 'record'), 'uses', literal(0)),
    recordSet(withMultiplier, output(withUses, 'record'), 'multiplier', literal(1)),
    call(effective, 'value.coalesce', {
      value: output(read),
      defaultValue: output(withMultiplier, 'record'),
    }, { valueType: typeParameter(recordType) }),
  )
  return output(effective, 'value')
}

/**
 * The legacy reader was pure and returned a nullable record.  Keep that
 * boundary intact when it is expanded into the generic extension API: a
 * missing buff must not declare an execution-local default, because doing so
 * turns a read inside collection.map into an effectful write-like operation.
 */
function readBuffRecord(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const player = requiredInput(node, 'player')
  const buffId = node.parameters?.buffId
  if (!player || typeof buffId !== 'string' || buffId.length === 0) return undefined
  const read = fresh('buff-read-optional')
  return {
    statements: [call(read, 'extension.read-optional-player', { owner: player }, extensionParameters(buffId, ''))],
    outputs: { record: output(read, 'value') },
  }
}

function declareAndWriteRecord(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  player: GameplayValue,
  buffId: string,
  record: GameplayValue,
): GameplayValue {
  const declared = fresh('buff-declare')
  const write = fresh('buff-write')
  const success = fresh('buff-write-success')
  statements.push(
    call(declared, 'extension.declare-player', { owner: player, value: record }, extensionParameters(buffId)),
    call(write, 'extension.write-player', { owner: player, value: record }, extensionParameters(buffId, '')),
    call(success, 'value.to-boolean', { value: output(write, 'value') }, { valueType: typeParameter(recordType) }),
  )
  return output(success)
}

type ExistingWrite = {
  readonly success: GameplayValue
}

/**
 * Update only a valid, positive uses counter.  The local result is important:
 * the extension writer has a record output rather than a boolean success
 * port, and a false predicate must leave the legacy record untouched.
 */
function writeExistingUses(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  player: GameplayValue,
  buffId: string,
  record: GameplayValue,
  currentUses: GameplayValue,
  nextUses: GameplayValue,
): ExistingWrite {
  const positive = fresh('buff-has-uses')
  const result = fresh('buff-write-result')
  const updated = fresh('buff-updated-record')
  const write = fresh('buff-write')
  const saved = fresh('buff-write-saved')
  const read = fresh('buff-write-result-read')
  statements.push(
    call(positive, 'compare.greater-than', { left: currentUses, right: literal(0) }),
    call(result, 'local.declare', { initial: literal(false) }, { valueType: typeParameter(booleanType) }),
    {
      // Numeric validity belongs to the authoritative legacy namespace write
      // boundary. This local guard intentionally retains only the old
      // uses>0 business rule; it must not become a second numeric validator.
      kind: 'if', id: fresh('buff-write-if'), condition: output(positive),
      then: [
        recordSet(updated, record, 'uses', nextUses),
        call(write, 'extension.write-player', { owner: player, value: output(updated, 'record') }, extensionParameters(buffId, '')),
        call(saved, 'value.to-boolean', { value: output(write, 'value') }, { valueType: typeParameter(recordType) }),
        call(fresh('buff-save-result'), 'local.write', {
          handle: output(result, 'handle'), value: output(saved),
        }, { valueType: typeParameter(booleanType) }),
      ],
    },
    call(read, 'local.read', { handle: output(result, 'handle') }, { valueType: typeParameter(booleanType) }),
  )
  return { success: output(read, 'value') }
}

function setBuffRecord(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const player = requiredInput(node, 'player')
  const record = requiredInput(node, 'record')
  const buffId = node.parameters?.buffId
  if (!player || !record || typeof buffId !== 'string' || buffId.length === 0) return undefined
  const statements: GameplayStatement[] = []
  const success = declareAndWriteRecord(statements, fresh, player, buffId, record)
  return { statements, outputs: { success } }
}

function writeBuffUses(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const player = requiredInput(node, 'player')
  const uses = requiredInput(node, 'uses')
  const buffId = node.parameters?.buffId
  if (!player || !uses || typeof buffId !== 'string' || buffId.length === 0) return undefined
  const statements: GameplayStatement[] = []
  const record = localBuffRecord(statements, fresh, player, buffId)
  const current = fresh('buff-current-uses')
  const normalized = fresh('buff-normalized-uses')
  statements.push(
    readKey(current, record, 'uses', nullableNumberType),
    call(normalized, 'value.coalesce', { value: output(current), defaultValue: literal(0) }, { valueType: typeParameter(numberType) }),
  )
  const result = writeExistingUses(statements, fresh, player, buffId, record, output(normalized), uses)
  return { statements, outputs: { success: result.success } }
}

function consumeBuff(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const player = requiredInput(node, 'player')
  const buffId = node.parameters?.buffId
  if (!player || typeof buffId !== 'string' || buffId.length === 0) return undefined
  const statements: GameplayStatement[] = []
  const record = localBuffRecord(statements, fresh, player, buffId)
  const current = fresh('buff-current-uses')
  const normalized = fresh('buff-normalized-uses')
  const next = fresh('buff-next-uses')
  const multiplier = fresh('buff-multiplier')
  const selectedMultiplier = fresh('buff-selected-multiplier')
  statements.push(
    readKey(current, record, 'uses', nullableNumberType),
    call(normalized, 'value.coalesce', { value: output(current), defaultValue: literal(0) }, { valueType: typeParameter(numberType) }),
    call(next, 'math.subtract', { left: output(normalized), right: literal(1) }),
  )
  const result = writeExistingUses(statements, fresh, player, buffId, record, output(normalized), output(next))
  statements.push(
    readKey(multiplier, record, 'multiplier', nullableNumberType),
    call(selectedMultiplier, 'value.coalesce', { value: output(multiplier), defaultValue: literal(1) }, { valueType: typeParameter(numberType) }),
    call(node.id, 'logic.select', {
      condition: result.success,
      whenTrue: output(selectedMultiplier),
      whenFalse: literal(1),
    }, { valueType: typeParameter(numberType) }, '2'),
  )
  return {
    statements,
    outputs: { applied: result.success, multiplier: output(node.id) },
  }
}

/** Recipe for replacing the role-specific player buff wrappers. */
export const atomicPlayerBuffExtensionRecipe: AtomicRecipe = (node, fresh) => {
  switch (node.module) {
    case 'player.set-buff-record': return setBuffRecord(node, fresh)
    case 'player.buff-record': return readBuffRecord(node, fresh)
    case 'player.write-buff-uses': return writeBuffUses(node, fresh)
    case 'player.consume-buff': return consumeBuff(node, fresh)
    default: return undefined
  }
}

export function migratePlayerBuffExtensionModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicPlayerBuffExtensionRecipe)
}

export const migrateAtomicPlayerBuffExtensionGraph = migratePlayerBuffExtensionModules
