import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayParameter,
  GameplayPort,
  GameplayValueType,
} from './module-types'

const SURFACES: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const PURE: GameplayEffectMetadata = { pure: true, previewSafe: true }
const recordType: GameplayValueType = 'record'
const booleanType: GameplayValueType = 'boolean'
const stringType: GameplayValueType = 'string'
const pieceType: GameplayValueType = 'piece'
const playerType: GameplayValueType = 'player'
const nullableStringType: GameplayValueType = { kind: 'nullable', value: stringType }
const recordListType: GameplayValueType = { kind: 'list', element: recordType }

const port = (
  name: string,
  type: GameplayValueType,
  options: Omit<GameplayPort, 'name' | 'type'> = {},
): GameplayPort => ({ name, type, ...options })

const parameter = (
  name: string,
  type: GameplayValueType,
  options: Omit<GameplayParameter, 'name' | 'type'> = {},
): GameplayParameter => ({ name, type, ...options })

const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}

const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const battle = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.battle' : 'battle'

/**
 * Generic immutable record construction used by graph migrations.  The
 * source record is copied field-for-field so extension records authored by
 * older content retain fields that this graph does not know about.
 */
const setFieldLowering = (ctx: GameplayNativeLoweringContext): string => {
  const field = ctx.parameters.field
  if (typeof field !== 'string' || field.length === 0 || ['__proto__', 'prototype', 'constructor'].includes(field)) {
    throw new Error(`module ${ctx.moduleId}: field must be a safe record key`)
  }
  // Read own data descriptors instead of property access.  Author records can
  // arrive from an extension root, where an accessor, symbol, non-enumerable
  // property, or inherited prototype must never become executable content.
  // Clone the complete value before adding the field so a later host mutation
  // cannot alter the source record.  The explicit envelope is required when
  // the record itself owns a `record` field; the compiler then unwraps the
  // declared output port unambiguously.
  return `(function(record,key,value){var unsafe=function(name){return name==="__proto__"||name==="prototype"||name==="constructor";};var hasOwn=Object.prototype.hasOwnProperty;var maxDepth=40,maxNodes=16384;var clone=function(item,seen,depth,budget){if(item===__gameplayInvalid)return __gameplayInvalid;if(item===undefined)return __gameplayInvalid;if(item===null||typeof item!=="object"){if(typeof item==="number"&&!Number.isFinite(item))return __gameplayInvalid;if(typeof item==="function"||typeof item==="symbol"||typeof item==="bigint")return __gameplayInvalid;return item;}if(depth>maxDepth||budget.count>=maxNodes||seen.indexOf(item)>=0)return __gameplayInvalid;budget.count+=1;var nextSeen=seen.concat([item]);if(Array.isArray(item)){var lengthDescriptor=Object.getOwnPropertyDescriptor(item,"length");if(!lengthDescriptor||!hasOwn.call(lengthDescriptor,"value")||lengthDescriptor.enumerable||!Number.isSafeInteger(lengthDescriptor.value)||lengthDescriptor.value<0)return __gameplayInvalid;var length=lengthDescriptor.value,keys=Reflect.ownKeys(item),count=0;for(var keyIndex=0;keyIndex<keys.length;keyIndex+=1){var arrayKey=keys[keyIndex];if(typeof arrayKey!=="string")return __gameplayInvalid;if(arrayKey==="length")continue;if(!/^(0|[1-9][0-9]*)$/.test(arrayKey)||Number(arrayKey)>=length)return __gameplayInvalid;var arrayDescriptor=Object.getOwnPropertyDescriptor(item,arrayKey);if(!arrayDescriptor||!hasOwn.call(arrayDescriptor,"value")||!arrayDescriptor.enumerable)return __gameplayInvalid;count+=1;}if(count!==length)return __gameplayInvalid;var array=[];for(var index=0;index<length;index+=1){var itemDescriptor=Object.getOwnPropertyDescriptor(item,String(index));if(!itemDescriptor||!hasOwn.call(itemDescriptor,"value"))return __gameplayInvalid;var arrayValue=clone(itemDescriptor.value,nextSeen,depth+1,budget);if(arrayValue===__gameplayInvalid)return __gameplayInvalid;array.push(arrayValue);}return array;}var prototype=Object.getPrototypeOf(item);if(prototype!==null){var parent=Object.getPrototypeOf(prototype);var constructor=Object.getOwnPropertyDescriptor(prototype,"constructor");var constructorName=constructor&&hasOwn.call(constructor,"value")&&typeof constructor.value==="function"?Object.getOwnPropertyDescriptor(constructor.value,"name"):null;if(parent!==null||!constructor||!hasOwn.call(constructor,"value")||typeof constructor.value!=="function"||!constructorName||!hasOwn.call(constructorName,"value")||constructorName.value!=="Object")return __gameplayInvalid;}var names=Object.keys(item),ownKeys=Reflect.ownKeys(item);if(ownKeys.length!==names.length)return __gameplayInvalid;var result={};for(var nameIndex=0;nameIndex<names.length;nameIndex+=1){var name=names[nameIndex];if(unsafe(name))return __gameplayInvalid;var descriptor=Object.getOwnPropertyDescriptor(item,name);if(!descriptor||!hasOwn.call(descriptor,"value")||!descriptor.enumerable)return __gameplayInvalid;var child=clone(descriptor.value,nextSeen,depth+1,budget);if(child===__gameplayInvalid)return __gameplayInvalid;Object.defineProperty(result,name,{value:child,writable:true,enumerable:true,configurable:true});}return result;};if(record===__gameplayInvalid||value===__gameplayInvalid)return __gameplayInvalid;if(record===null||typeof record!=="object"||Array.isArray(record))return __gameplayInvalid;var budget={count:0},result=clone(record,[],0,budget),nextValue=clone(value,[],0,budget);if(result===__gameplayInvalid||nextValue===__gameplayInvalid)return __gameplayInvalid;if(unsafe(key))return __gameplayInvalid;Object.defineProperty(result,key,{value:nextValue,writable:true,enumerable:true,configurable:true});return {record:result};})(${input(ctx, 'record')},${ctx.emitLiteral(field)},${input(ctx, 'value')})`
}

/**
 * Resolve an opaque piece reference against both active pieces and the
 * historical graveyard.  A missing reference is an invalid dependency and
 * therefore skips the graph tail; a found piece still exposes nullable owner
 * metadata without manufacturing a fallback entity.
 */
const resolvePieceLowering = (ctx: GameplayNativeLoweringContext): string => {
  const state = battle(ctx)
  return `(function(value,pieces,graveyard){if(value===__gameplayInvalid)return __gameplayInvalid;var id=value&&typeof value==="object"?value.instanceId:value;if(typeof id!=="string")return __gameplayInvalid;var source=((Array.isArray(pieces)?pieces:[]).concat(Array.isArray(graveyard)?graveyard:[])).find(function(item){return item&&item.instanceId===id;});if(!source)return __gameplayInvalid;return {id:id,ownerPlayerId:typeof source.ownerPlayerId==="string"?source.ownerPlayerId:null};})(${input(ctx, 'piece')},${state}.pieces,${state}.graveyard)`
}

/**
 * A single atomic write boundary for the legacy marker pair.  The runtime
 * validates both candidates before assigning either root field.  Invalid
 * references are isolated by the surrounding graph branch; this boundary
 * only accepts the two already-computed candidates.
 */
const commitRootWithTilesLowering = (ctx: GameplayNativeLoweringContext): string =>
  `(${flow(ctx)}.extensionRoot.commitRootWithTiles(${ctx.emitLiteral(ctx.parameters.storageKey)},${input(ctx, 'root')},${input(ctx, 'tiles')}))`

const definitions: readonly GameplayModuleDescriptor[] = [
  {
    id: 'record.empty', version: '1', label: '创建空记录',
    description: '创建一个新的空记录，供通用字段构造原语逐项填充。',
    inputs: [], outputs: [port('record', recordType)], allowedSurfaces: SURFACES, effects: PURE,
    lower: () => '({})', ui: { category: 'data', authoring: 'standard' },
  },
  {
    id: 'record.set-field', version: '1', label: '设置记录字段',
    description: '复制记录并设置一个安全的直接字段；未知字段保持原样。',
    inputs: [port('record', recordType), port('value', recordType)],
    outputs: [port('record', recordType)],
    inputValueTypeBindings: { value: { parameter: 'valueType' } },
    parameters: [parameter('field', stringType), parameter('valueType', stringType, { default: 'record' })],
    allowedSurfaces: SURFACES, effects: PURE, lower: setFieldLowering,
    ui: { category: 'data', authoring: 'standard' },
  },
  {
    id: 'piece.resolve-including-graveyard', version: '1', label: '解析棋子及历史来源',
    description: '按稳定棋子标识从场上或墓地读取来源归属；保留未找到时的原始标识。',
    inputs: [port('piece', pieceType, { nullable: true })],
    outputs: [port('id', nullableStringType), port('ownerPlayerId', { kind: 'nullable', value: playerType })],
    // Historical sources may no longer be present in the live query surface;
    // the lowering resolves active pieces and graveyard entries itself.
    inspectReferences: ['piece'],
    allowedSurfaces: SURFACES, effects: { pure: true, previewSafe: true, reads: ['pieces'] },
    lower: resolvePieceLowering, ui: { category: 'query', authoring: 'standard' },
  },
  {
    id: 'extension.commit-root-with-tiles', version: '1', label: '原子提交扩展和地格表现',
    description: '在校验扩展记录和地格表现记录后同时替换两个全局数组；候选必须先由图中的有效引用分支计算。',
    inputs: [
      port('root', recordListType), port('tiles', recordListType),
    ],
    outputs: [port('success', booleanType)],
    parameters: [parameter('storageKey', stringType)],
    allowedSurfaces: SURFACES,
    effects: { pure: false, previewSafe: false, reads: ['extensions'], writes: ['extensions', 'tile-effects'] },
    lower: commitRootWithTilesLowering,
    ui: { category: 'effect', authoring: 'standard' },
  },
  {
    id: 'extension.commit-root-with-tiles', version: '2', label: '原子提交扩展和地格表现',
    description: '校验后整体提交扩展记录与地格效果，保留地格增删的表现批次和发生顺序。',
    inputs: [port('root', recordListType), port('tiles', recordListType)],
    outputs: [port('success', booleanType)],
    parameters: [parameter('storageKey', stringType), parameter('presentationBatch', stringType, {
      enum: ['direct', 'tileEffectRemoved', 'tileEffectAdded'], default: 'direct',
    })],
    allowedSurfaces: SURFACES,
    effects: { pure: false, previewSafe: false, reads: ['extensions'], writes: ['extensions', 'tile-effects'] },
    lower: ctx => `(${flow(ctx)}.extensionRoot.commitRootWithTiles(${ctx.emitLiteral(ctx.parameters.storageKey)},${input(ctx, 'root')},${input(ctx, 'tiles')},${ctx.emitLiteral(ctx.parameters.presentationBatch ?? 'direct')}))`,
    ui: { category: 'effect', authoring: 'standard' },
  },
]

export const ATOMIC_COMMIT_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze(definitions)
export const GENERIC_ATOMIC_COMMIT_GAMEPLAY_MODULES = ATOMIC_COMMIT_GAMEPLAY_MODULES
