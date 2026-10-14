import type { AtomicRecipe, AtomicReplacement } from './atomic-graph-rewrite'
import { rewriteAtomicGraph } from './atomic-graph-rewrite'
import { authorValueSchemas } from '../game/author-extension'
import type {
  GameplayCallStatement,
  GameplayEffectMetadata,
  GameplayJsonValue,
  GameplayModuleDescriptor,
  GameplayModuleGraph,
  GameplayNativeLoweringContext,
  GameplayModuleSurface,
  GameplayStatement,
  GameplayValue,
  GameplayValueType,
} from './module-types'

/**
 * The old Ichigo adapter stored a plain record keyed by the source piece id.
 * The graph migration keeps that layout, but moves all reads and writes
 * through the regular typed root-extension and record expressions.
 */
export const ICHIGO_EXTENSION_KEY = 'ichigoBlackGetsugaTeleportByCaster'

const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const stringType: GameplayValueType = 'string'
const pieceType: GameplayValueType = 'piece'
const cellType: GameplayValueType = 'cell'
const recordType: GameplayValueType = 'record'
const recordListType: GameplayValueType = { kind: 'list', element: recordType }
const cellListType: GameplayValueType = { kind: 'list', element: cellType }
const nullableNumberType: GameplayValueType = { kind: 'nullable', value: numberType }
const nullablePieceType: GameplayValueType = { kind: 'nullable', value: pieceType }
const nullableRecordType: GameplayValueType = { kind: 'nullable', value: recordType }
const nullableRecordListType: GameplayValueType = { kind: 'nullable', value: recordListType }

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
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

function readKey(
  id: string,
  record: GameplayValue,
  key: string | GameplayValue,
  valueType: GameplayValueType,
): GameplayCallStatement {
  const inputs: Record<string, GameplayValue> = { record }
  const parameters: Record<string, GameplayJsonValue> = { valueType: typeParameter(valueType) }
  if (typeof key === 'string') parameters.key = key
  else inputs.key = key
  return call(id, 'data.read-key', inputs, parameters)
}

function coalesce(
  id: string,
  value: GameplayValue,
  defaultValue: GameplayValue,
  valueType: GameplayValueType,
): GameplayCallStatement {
  return call(id, 'value.coalesce', { value, defaultValue }, { valueType: typeParameter(valueType) })
}

function compare(
  id: string,
  left: GameplayValue,
  right: GameplayValue,
  valueType: GameplayValueType,
  operator: '==' | '!=' = '==',
): GameplayCallStatement {
  return call(id, 'compare.values', { left, right }, { valueType: typeParameter(valueType), operator })
}

function and(id: string, left: GameplayValue, right: GameplayValue): GameplayCallStatement {
  return call(id, 'logic.and', { left, right })
}

function valueTypeCall(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>>,
  valueType: GameplayValueType,
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
): GameplayCallStatement {
  return call(id, module, inputs, { ...parameters, valueType: typeParameter(valueType) })
}

function coordinateValidity(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  record: GameplayValue,
  prefix: string,
): { x: GameplayValue; y: GameplayValue; valid: GameplayValue } {
  const x = fresh(prefix + '-x')
  const y = fresh(prefix + '-y')
  const xFloor = fresh(prefix + '-x-floor')
  const yFloor = fresh(prefix + '-y-floor')
  const xInteger = fresh(prefix + '-x-integer')
  const yInteger = fresh(prefix + '-y-integer')
  const xPresent = fresh(prefix + '-x-present')
  const yPresent = fresh(prefix + '-y-present')
  const xValue = fresh(prefix + '-x-value')
  const yValue = fresh(prefix + '-y-value')
  const xValid = fresh(prefix + '-x-valid')
  const yValid = fresh(prefix + '-y-valid')
  const valid = fresh(prefix + '-valid')
  statements.push(
    readKey(x, record, 'x', nullableNumberType),
    readKey(y, record, 'y', nullableNumberType),
    compare(xPresent, output(x), literal(null), nullableNumberType, '!='),
    compare(yPresent, output(y), literal(null), nullableNumberType, '!='),
    coalesce(xValue, output(x), literal(0), numberType),
    coalesce(yValue, output(y), literal(0), numberType),
    call(xFloor, 'math.floor', { value: output(xValue) }),
    call(yFloor, 'math.floor', { value: output(yValue) }),
    compare(xInteger, output(xValue), output(xFloor), numberType),
    compare(yInteger, output(yValue), output(yFloor), numberType),
    and(xValid, output(xPresent), output(xInteger)),
    and(yValid, output(yPresent), output(yInteger)),
    and(valid, output(xValid), output(yValid)),
  )
  return { x: output(xValue), y: output(yValue), valid: output(valid) }
}

function normalizedStoredCells(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  cells: GameplayValue,
): GameplayValue {
  const filtered = fresh('valid-cells')
  const filteredBody: GameplayStatement[] = []
  const coordinates = fresh('input-coordinates')
  const xFloor = fresh('input-x-floor')
  const yFloor = fresh('input-y-floor')
  const xInteger = fresh('input-x-integer')
  const yInteger = fresh('input-y-integer')
  const valid = fresh('input-cell-valid')
  filteredBody.push(
    call(coordinates, 'spatial.cell-coordinates', { cell: input('cell') }),
    call(xFloor, 'math.floor', { value: output(coordinates, 'x') }),
    call(yFloor, 'math.floor', { value: output(coordinates, 'y') }),
    compare(xInteger, output(coordinates, 'x'), output(xFloor), numberType),
    compare(yInteger, output(coordinates, 'y'), output(yFloor), numberType),
    and(valid, output(xInteger), output(yInteger)),
    { kind: 'return', id: fresh('valid-cell-return'), value: output(valid) },
  )
  statements.push({ kind: 'collection', id: filtered, method: 'filter', items: cells, item: 'cell', body: filteredBody })

  const normalized = fresh('normalized-cells')
  const mapBody: GameplayStatement[] = []
  const coordinatesInMap = fresh('normalized-coordinates')
  const empty = fresh('normalized-record-empty')
  const withType = fresh('normalized-record-type')
  const withX = fresh('normalized-record-x')
  const withY = fresh('normalized-record-y')
  mapBody.push(
    call(coordinatesInMap, 'spatial.cell-coordinates', { cell: input('cell') }),
    call(empty, 'record.empty'),
    valueTypeCall(withType, 'record.set-field', { record: output(empty, 'record'), value: literal('cell') }, stringType, { field: 'type' }),
    // The stored shape intentionally retains the old `type: "cell"` marker.
    valueTypeCall(withX, 'record.set-field', { record: output(withType, 'record'), value: output(coordinatesInMap, 'x') }, numberType, { field: 'x' }),
    valueTypeCall(withY, 'record.set-field', { record: output(withX, 'record'), value: output(coordinatesInMap, 'y') }, numberType, { field: 'y' }),
    { kind: 'return', id: fresh('normalized-cell-return'), value: output(withY, 'record') },
  )
  statements.push({ kind: 'collection', id: normalized, method: 'map', items: output(filtered), item: 'cell', body: mapBody })
  return output(normalized)
}

function normalizedReadCells(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  records: GameplayValue,
): GameplayValue {
  const filtered = fresh('valid-records')
  const filterBody: GameplayStatement[] = []
  const validity = coordinateValidity(filterBody, fresh, input('record'), 'stored')
  filterBody.push({ kind: 'return', id: fresh('stored-record-valid-return'), value: validity.valid })
  statements.push({ kind: 'collection', id: filtered, method: 'filter', items: records, item: 'record', body: filterBody })

  const cells = fresh('read-cells')
  const mapBody: GameplayStatement[] = []
  const coordinates = coordinateValidity(mapBody, fresh, input('record'), 'read')
  const cell = fresh('read-cell')
  mapBody.push(
    call(cell, 'spatial.cell', { x: coordinates.x, y: coordinates.y }),
    { kind: 'return', id: fresh('read-cell-return'), value: output(cell, 'cell') },
  )
  statements.push({ kind: 'collection', id: cells, method: 'map', items: output(filtered), item: 'record', body: mapBody })
  return output(cells)
}

function rootRaw(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
): { extensions: GameplayValue; raw: GameplayValue; defined: GameplayValue } {
  const extensions = fresh('battle-extensions')
  const raw = fresh('ichigo-store-raw')
  statements.push(
    call(extensions, 'battle.extensions'),
    readKey(raw, output(extensions, 'record'), ICHIGO_EXTENSION_KEY, nullableRecordType),
  )
  return { extensions: output(extensions, 'record'), raw: output(raw), defined: output(raw, 'defined') }
}

function ownerKey(
  statements: GameplayStatement[],
  fresh: (suffix: string) => string,
  owner: GameplayValue,
): { id: string; value: GameplayValue } {
  const id = fresh('owner-key')
  statements.push(valueTypeCall(id, 'text.from-value', { value: owner }, pieceType))
  return { id, value: output(id, 'text') }
}

function migrateRead(callNode: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement {
  const result = fresh('read-result')
  const empty = fresh('empty-record')
  const statements: GameplayStatement[] = [
    call(result, 'local.declare', { initial: literal([]) }, { valueType: typeParameter(cellListType) }),
    call(empty, 'record.empty'),
  ]
  const root = rootRaw(statements, fresh)
  const rootValue = fresh('store-value')
  const key = ownerKey(statements, fresh, callNode.inputs!.owner)
  const ownerRecords = fresh('owner-records-raw')
  const records = fresh('owner-records')
  statements.push(
    coalesce(rootValue, root.raw, output(empty, 'record'), recordType),
    readKey(ownerRecords, output(rootValue), key.value, nullableRecordListType),
    coalesce(records, output(ownerRecords), literal([]), recordListType),
  )
  const cells = normalizedReadCells(statements, fresh, output(records))
  statements.push(call(fresh('read-result-write'), 'local.write', { handle: output(result, 'handle'), value: cells }, { valueType: typeParameter(cellListType) }))
  const done = fresh('read-done')
  statements.push(call(done, 'local.read', { handle: output(result, 'handle') }, { valueType: typeParameter(cellListType) }))
  return { statements, outputs: { cells: output(done, 'value') } }
}

function migrateSet(callNode: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement {
  const result = fresh('set-result')
  const ownerPresent = fresh('owner-present')
  const statements: GameplayStatement[] = [
    call(result, 'local.declare', { initial: literal(false) }, { valueType: booleanType }),
    compare(ownerPresent, callNode.inputs!.owner, literal(null), nullablePieceType, '!='),
  ]
  const branch: GameplayStatement[] = []
  const empty = fresh('empty-record')
  const declare = fresh('declare-store')
  const root = fresh('declared-store')
  const key = ownerKey(branch, fresh, callNode.inputs!.owner)
  branch.push(
    call(empty, 'record.empty'),
    call(declare, 'extension.declare-battle', { value: output(empty, 'record') }, { namespace: '', name: ICHIGO_EXTENSION_KEY, valueType: recordType }, '3'),
    call(root, 'extension.read-battle', {}, { namespace: '', name: ICHIGO_EXTENSION_KEY, valueType: recordType }, '2'),
  )
  const normalized = normalizedStoredCells(branch, fresh, callNode.inputs!.cells)
  const updated = fresh('updated-store')
  const write = fresh('write-store')
  branch.push(
    call(updated, 'record.set-key', { record: output(root), key: key.value, value: normalized }, { valueType: typeParameter(recordListType) }),
    call(write, 'extension.write-battle', { value: output(updated, 'record') }, { namespace: '', name: ICHIGO_EXTENSION_KEY, valueType: recordType }, '3'),
    call(fresh('set-result-write'), 'local.write', { handle: output(result, 'handle'), value: output(write, 'success') }, { valueType: booleanType }),
  )
  statements.push({ kind: 'if', id: fresh('set-owner-branch'), condition: output(ownerPresent), then: branch })
  const done = fresh('set-done')
  statements.push(call(done, 'local.read', { handle: output(result, 'handle') }, { valueType: booleanType }))
  return { statements, outputs: { success: output(done, 'value') } }
}

function migrateClear(callNode: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement {
  const result = fresh('clear-result')
  const ownerPresent = fresh('owner-present')
  const statements: GameplayStatement[] = [
    call(result, 'local.declare', { initial: literal(false) }, { valueType: booleanType }),
    compare(ownerPresent, callNode.inputs!.owner, literal(null), nullablePieceType, '!='),
  ]
  const ownerBranch: GameplayStatement[] = []
  const empty = fresh('empty-record')
  const root = rootRaw(ownerBranch, fresh)
  const storeValue = fresh('clear-store')
  const key = ownerKey(ownerBranch, fresh, callNode.inputs!.owner)
  const ownerValue = fresh('clear-owner-value')
  ownerBranch.push(
    call(empty, 'record.empty'),
    coalesce(storeValue, root.raw, output(empty, 'record'), recordType),
    readKey(ownerValue, output(storeValue), key.value, nullableRecordListType),
  )
  const removeBranch: GameplayStatement[] = []
  const remaining = fresh('remaining-store')
  const write = fresh('clear-write')
  removeBranch.push(
    call(remaining, 'data.omit-key', { record: output(storeValue), key: key.value }),
    call(write, 'extension.write-battle', { value: output(remaining, 'value') }, { namespace: '', name: ICHIGO_EXTENSION_KEY, valueType: recordType }, '3'),
    call(fresh('clear-result-write'), 'local.write', { handle: output(result, 'handle'), value: output(write, 'success') }, { valueType: booleanType }),
  )
  ownerBranch.push({ kind: 'if', id: fresh('clear-owner-branch'), condition: output(ownerValue, 'defined'), then: removeBranch })
  statements.push({ kind: 'if', id: fresh('clear-present-branch'), condition: output(ownerPresent), then: ownerBranch })
  const done = fresh('clear-done')
  statements.push(call(done, 'local.read', { handle: output(result, 'handle') }, { valueType: booleanType }))
  return { statements, outputs: { success: output(done, 'value') } }
}

function migrateRemoveEmpty(callNode: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement {
  const result = fresh('remove-result')
  const emptyRecord = fresh('empty-record')
  const statements: GameplayStatement[] = [
    call(result, 'local.declare', { initial: literal(false) }, { valueType: booleanType }),
    call(emptyRecord, 'record.empty'),
  ]
  const root = rootRaw(statements, fresh)
  const store = fresh('remove-store')
  const nonNull = fresh('remove-store-present')
  const emptyStore = fresh('remove-store-empty')
  const removable = fresh('remove-store-removable')
  statements.push(
    coalesce(store, root.raw, output(emptyRecord, 'record'), recordType),
    compare(nonNull, root.raw, literal(null), nullableRecordType, '!='),
    call(emptyStore, 'record.is-empty', { record: output(store) }),
    and(removable, root.defined, output(nonNull)),
    and(fresh('remove-empty-and-present'), output(removable), output(emptyStore)),
  )
  const condition = output(statements[statements.length - 1].kind === 'call' ? (statements[statements.length - 1] as GameplayCallStatement).id : removable)
  const branch: GameplayStatement[] = []
  const remove = fresh('remove-empty-delete')
  branch.push(
    call(remove, 'extension.remove-battle', {}, { namespace: '', name: ICHIGO_EXTENSION_KEY, valueType: recordType }, '1'),
    call(fresh('remove-empty-result-delete'), 'local.write', { handle: output(result, 'handle'), value: output(remove, 'success') }, { valueType: booleanType }),
  )
  statements.push({ kind: 'if', id: fresh('remove-empty-branch'), condition, then: branch })
  const done = fresh('remove-done')
  statements.push(call(done, 'local.read', { handle: output(result, 'handle') }, { valueType: booleanType }))
  return { statements, outputs: { success: output(done, 'value') } }
}

export const ATOMIC_ICHIGO_EXTENSION_MODULES = new Set([
  'extension.read-piece-cells',
  'extension.set-piece-cells',
  'extension.clear-piece-cells',
  'extension.remove-empty-piece-store',
])

/** Generic descriptors required by the migration; the parent registry owns registration. */
export const ICHIGO_EXTENSION_MIGRATION_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  {
    id: 'record.set-key', version: '1', label: '按键设置记录字段',
    description: '复制记录并按运行时安全键写入值；不修改输入记录。',
    inputs: [
      { name: 'record', type: recordType, label: '记录' },
      { name: 'key', type: stringType, label: '字段' },
      { name: 'value', type: recordType, label: '值' },
    ],
    outputs: [{ name: 'record', type: recordType, label: '新记录' }],
    inputValueTypeBindings: { value: { parameter: 'valueType' } },
    parameters: [{ name: 'valueType', type: stringType, default: typeParameter(recordListType) }],
    allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview'] as readonly GameplayModuleSurface[],
    effects: { pure: true, previewSafe: true } as GameplayEffectMetadata,
    lower: ctx => {
      const record = ctx.inputs.record
      const key = ctx.inputs.key
      const value = ctx.inputs.value
      return `(function(record,key,value){var unsafe=function(name){return name==="__proto__"||name==="prototype"||name==="constructor";};var clone=function(item,seen,depth){if(item===__gameplayInvalid||item===undefined||depth>40)return __gameplayInvalid;if(item===null||typeof item!=="object"){if(typeof item==="number"&&!Number.isFinite(item))return __gameplayInvalid;if(typeof item==="function"||typeof item==="symbol"||typeof item==="bigint")return __gameplayInvalid;return item;}if(seen.indexOf(item)>=0)return __gameplayInvalid;var keys=Reflect.ownKeys(item),result=Array.isArray(item)?[]:{};if(Array.isArray(item)){var prototype=Object.getPrototypeOf(item);if(prototype!==Array.prototype)return __gameplayInvalid;var length=Object.getOwnPropertyDescriptor(item,"length");if(!length||length.enumerable||!Number.isSafeInteger(length.value)||length.value<0)return __gameplayInvalid;for(var index=0;index<length.value;index+=1){var descriptor=Object.getOwnPropertyDescriptor(item,String(index));if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return __gameplayInvalid;var copied=clone(descriptor.value,seen.concat([item]),depth+1);if(copied===__gameplayInvalid)return __gameplayInvalid;result.push(copied);}if(keys.length!==length.value+1)return __gameplayInvalid;return result;}var prototype=Object.getPrototypeOf(item);if(prototype!==null&&Object.getPrototypeOf(prototype)!==null)return __gameplayInvalid;for(var keyIndex=0;keyIndex<keys.length;keyIndex+=1){var name=keys[keyIndex];if(typeof name!=="string"||unsafe(name))return __gameplayInvalid;var descriptor=Object.getOwnPropertyDescriptor(item,name);if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return __gameplayInvalid;var copied=clone(descriptor.value,seen.concat([item]),depth+1);if(copied===__gameplayInvalid)return __gameplayInvalid;Object.defineProperty(result,name,{value:copied,writable:true,enumerable:true,configurable:true});}return result;};if(record===__gameplayInvalid||value===__gameplayInvalid||typeof key!=="string"||!key||unsafe(key))return __gameplayInvalid;var next=clone(record,[],0),child=clone(value,[],0);if(next===__gameplayInvalid||child===__gameplayInvalid)return __gameplayInvalid;Object.defineProperty(next,key,{value:child,writable:true,enumerable:true,configurable:true});return {record:next};})(${record},${key},${value})`
    },
    ui: { category: 'data', authoring: 'standard' },
  },
  {
    id: 'record.is-empty', version: '1', label: '记录为空',
    description: '判断一个普通记录是否没有自有字段。',
    inputs: [{ name: 'record', type: recordType, label: '记录' }],
    outputs: [{ name: 'value', type: booleanType, label: '是否为空' }],
    allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview'] as readonly GameplayModuleSurface[],
    effects: { pure: true, previewSafe: true } as GameplayEffectMetadata,
    lower: ctx => `(function(record){if(record===__gameplayInvalid||record===null||typeof record!=="object"||Array.isArray(record))return __gameplayInvalid;return Object.keys(record).length===0;})(${ctx.inputs.record})`,
    ui: { category: 'data', authoring: 'standard' },
  },
  {
    id: 'extension.remove-battle', version: '1', label: '删除全局扩展变量',
    description: '删除一个已声明的全局扩展根字段；字段不存在时返回失败，不以空记录替代缺失字段。',
    inputs: [],
    outputs: [{ name: 'success', type: booleanType, label: '完成' }],
    parameters: [
      { name: 'namespace', type: stringType, default: '' },
      { name: 'name', type: stringType },
      { name: 'valueType', type: stringType, default: recordType },
    ],
    allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview'] as readonly GameplayModuleSurface[],
    effects: { pure: false, previewSafe: false, writes: ['extensions'] } as GameplayEffectMetadata,
    lower: (ctx: GameplayNativeLoweringContext) => {
      const raw = String(ctx.parameters.valueType ?? recordType)
      const type = raw.trimStart().startsWith('{') ? JSON.parse(raw) : raw
      const runtime = ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
      const schemas = authorValueSchemas(type, ctx.recordSchemas ?? [])
      const callExpression = `${runtime}.extensionRoot.removeValue("battle","battle",${JSON.stringify(ctx.parameters.namespace ?? '')},${JSON.stringify(ctx.parameters.name)},${JSON.stringify(type)},${JSON.stringify(schemas)})`
      return `({value:${callExpression},success:true})`
    },
    ui: { category: 'state', authoring: 'standard' },
  },
])

export const atomicIchigoExtensionRecipe: AtomicRecipe = (node, fresh): AtomicReplacement | undefined => {
  if (!ATOMIC_ICHIGO_EXTENSION_MODULES.has(node.module)) return undefined
  if (node.parameters?.key !== ICHIGO_EXTENSION_KEY) return undefined
  if (node.module === 'extension.read-piece-cells') return migrateRead(node, fresh)
  if (node.module === 'extension.set-piece-cells') return migrateSet(node, fresh)
  if (node.module === 'extension.clear-piece-cells') return migrateClear(node, fresh)
  return migrateRemoveEmpty(node, fresh)
}

export function migrateIchigoExtensionModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicIchigoExtensionRecipe)
}

export const migrateIchigoExtensionGraph = migrateIchigoExtensionModules
