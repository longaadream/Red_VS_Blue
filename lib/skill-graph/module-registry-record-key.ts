import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayParameter,
  GameplayPort,
  GameplayValueType,
} from './module-types'

const SURFACES: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview']
const PURE: GameplayEffectMetadata = { pure: true, previewSafe: true, reads: ['records'] }
const recordType: GameplayValueType = 'record'
const stringType: GameplayValueType = 'string'
const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const pieceType: GameplayValueType = 'piece'
const playerType: GameplayValueType = 'player'
const cellType: GameplayValueType = 'cell'
const choiceType: GameplayValueType = 'choice'

const scalarTypes: readonly GameplayValueType[] = [
  stringType, numberType, booleanType, pieceType, playerType, cellType, choiceType, recordType,
]
const listTypes: readonly GameplayValueType[] = scalarTypes.map(element => ({ kind: 'list', element }))
const nullableTypes: readonly GameplayValueType[] = [...scalarTypes, ...listTypes].map(value => ({ kind: 'nullable', value }))
const supportedTypes: readonly GameplayValueType[] = [...scalarTypes, ...listTypes, ...nullableTypes]
const valueTypeBindings: Readonly<Record<string, GameplayValueType>> = Object.freeze(
  Object.fromEntries(supportedTypes.map(value => [typeof value === 'string' ? value : JSON.stringify(value), value])),
)
const valueTypeEnum: readonly string[] = Object.keys(valueTypeBindings)

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

function input(ctx: GameplayNativeLoweringContext, name: string): string {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}

function keyParameter(ctx: GameplayNativeLoweringContext): string {
  const key = ctx.parameters.key
  if (typeof key !== 'string' || key.length === 0 || ['__proto__', 'prototype', 'constructor'].includes(key)) {
    throw new Error(`module ${ctx.moduleId}: key must be a safe direct record key`)
  }
  return ctx.emitLiteral(key)
}

function hasInput(ctx: GameplayNativeLoweringContext, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ctx.inputs, name)
}

function selectedType(ctx: GameplayNativeLoweringContext): GameplayValueType {
  const selected = ctx.parameters.valueType
  if (typeof selected !== 'string') throw new Error(`module ${ctx.moduleId}: valueType is required`)
  const value = valueTypeBindings[selected]
  if (!value) throw new Error(`module ${ctx.moduleId}: unsupported valueType`)
  return value
}

function lowerReadKey(ctx: GameplayNativeLoweringContext): string {
  const record = input(ctx, 'record')
  const type = JSON.stringify(selectedType(ctx))
  const dynamicKey = hasInput(ctx, 'key')
  const key = dynamicKey ? input(ctx, 'key') : keyParameter(ctx)
  // The reader only accepts one direct, safe key. Values are checked against
  // the closed graph type and copied recursively before they leave the host
  // record, so later graph operations cannot mutate authoritative state.
  const keyGuard = dynamicKey ? 'if(typeof key!=="string"||key.length===0||key==="__proto__"||key==="prototype"||key==="constructor")return __gameplayInvalid;' : ''
  return `(function(record,key,type){try{var maxDepth=64,maxNodes=16384,hasOwn=Object.prototype.hasOwnProperty;if(record===__gameplayInvalid)return __gameplayInvalid;${keyGuard}if(record==null)return {value:null,defined:false};var plain=function(value){if(value===null||typeof value!=="object")return false;var prototype;try{prototype=Object.getPrototypeOf(value);}catch(error){return false;}if(prototype===null)return true;var parent;try{parent=Object.getPrototypeOf(prototype);}catch(error){return false;}if(parent!==null)return false;var constructor=Object.getOwnPropertyDescriptor(prototype,"constructor");if(!constructor||!hasOwn.call(constructor,"value")||typeof constructor.value!=="function")return false;var name=Object.getOwnPropertyDescriptor(constructor.value,"name");return !!name&&hasOwn.call(name,"value")&&name.value==="Object";};if(!plain(record))return __gameplayInvalid;var descriptor=Object.getOwnPropertyDescriptor(record,key);if(!descriptor)return {value:null,defined:false};if(!hasOwn.call(descriptor,"value"))return __gameplayInvalid;if(descriptor.value===undefined)return {value:null,defined:false};var value=descriptor.value;if(value===null)return {value:null,defined:true};var seen=[],budget={count:0},enter=function(value,depth){if(depth>maxDepth||budget.count>=maxNodes||seen.indexOf(value)>=0)return false;budget.count+=1;seen.push(value);return true;},leave=function(){seen.pop();};var descriptorIsData=function(value,name){var item=Object.getOwnPropertyDescriptor(value,name);return !!item&&hasOwn.call(item,"value")&&item.enumerable;};var validRecord=function(value,depth){if(value===null)return true;var kind=typeof value;if(kind==="string"||kind==="boolean")return true;if(kind==="number")return Number.isFinite(value);if(kind!=="object")return false;if(Array.isArray(value)){if(!enter(value,depth))return false;var lengthDescriptor=Object.getOwnPropertyDescriptor(value,"length"),length=lengthDescriptor&&hasOwn.call(lengthDescriptor,"value")?lengthDescriptor.value:-1,indexCount=0,arrayValid=!!lengthDescriptor&&Number.isSafeInteger(length)&&length>=0;var keys=arrayValid?Reflect.ownKeys(value):[];for(var keyIndex=0;arrayValid&&keyIndex<keys.length;keyIndex+=1){var arrayKey=keys[keyIndex];if(typeof arrayKey!=="string"){arrayValid=false;break;}if(arrayKey==="length"){if(lengthDescriptor.enumerable){arrayValid=false;break;}continue;}if(!/^(0|[1-9][0-9]*)$/.test(arrayKey)||Number(arrayKey)>=length||!descriptorIsData(value,arrayKey)){arrayValid=false;break;}indexCount+=1;}if(indexCount!==length)arrayValid=false;if(arrayValid){for(var index=0;index<length;index+=1){var itemDescriptor=Object.getOwnPropertyDescriptor(value,String(index));if(!itemDescriptor||!hasOwn.call(itemDescriptor,"value")||!validRecord(itemDescriptor.value,depth+1)){arrayValid=false;break;}}}leave();return arrayValid;}if(!plain(value)||!enter(value,depth))return false;var recordValid=true,names=Object.keys(value),ownKeys=Reflect.ownKeys(value);if(ownKeys.length!==names.length)recordValid=false;for(var nameIndex=0;recordValid&&nameIndex<names.length;nameIndex+=1){var name=names[nameIndex];if(name==="__proto__"||name==="prototype"||name==="constructor"||!descriptorIsData(value,name)){recordValid=false;break;}var nameDescriptor=Object.getOwnPropertyDescriptor(value,name);if(!nameDescriptor||!validRecord(nameDescriptor.value,depth+1)){recordValid=false;break;}}leave();return recordValid;};var valid=function(value,expected,depth){if(expected&&typeof expected==="object"){if(expected.kind==="nullable")return value===null||valid(value,expected.value,depth);if(expected.kind==="list"){if(!Array.isArray(value)||!enter(value,depth))return false;var listValid=true,lengthDescriptor=Object.getOwnPropertyDescriptor(value,"length"),length=lengthDescriptor&&hasOwn.call(lengthDescriptor,"value")?lengthDescriptor.value:-1,keys=lengthDescriptor?Reflect.ownKeys(value):[],indexCount=0;if(!lengthDescriptor||lengthDescriptor.enumerable||!Number.isSafeInteger(length)||length<0){listValid=false;}for(var keyIndex=0;listValid&&keyIndex<keys.length;keyIndex+=1){var listKey=keys[keyIndex];if(typeof listKey!=="string"){listValid=false;break;}if(listKey==="length")continue;if(!/^(0|[1-9][0-9]*)$/.test(listKey)||Number(listKey)>=length||!descriptorIsData(value,listKey)){listValid=false;break;}indexCount+=1;}if(indexCount!==length)listValid=false;for(var index=0;listValid&&index<length;index+=1){var itemDescriptor=Object.getOwnPropertyDescriptor(value,String(index));if(!itemDescriptor||!hasOwn.call(itemDescriptor,"value")||!valid(itemDescriptor.value,expected.element,depth+1))listValid=false;}leave(value);return listValid;}if(expected.kind==="record")return value!==null&&plain(value)&&validRecord(value,depth);return false;}if(value===null)return false;if(expected==="string"||expected==="piece"||expected==="player")return typeof value==="string";if(expected==="number")return typeof value==="number"&&Number.isFinite(value);if(expected==="boolean")return typeof value==="boolean";if(expected==="cell"){if(!plain(value))return false;var xDescriptor=Object.getOwnPropertyDescriptor(value,"x"),yDescriptor=Object.getOwnPropertyDescriptor(value,"y");return !!xDescriptor&&hasOwn.call(xDescriptor,"value")&&!!yDescriptor&&hasOwn.call(yDescriptor,"value")&&Number.isInteger(xDescriptor.value)&&Number.isInteger(yDescriptor.value)&&validRecord(value,depth);}if(expected==="choice")return plain(value)&&validRecord(value,depth);if(expected==="record")return plain(value)&&validRecord(value,depth);return false;};if(!valid(value,type,0))return __gameplayInvalid;var copySeen=[],copy=function(value,depth){if(value===null||typeof value!=="object")return value;if(depth>maxDepth||copySeen.indexOf(value)>=0)return __gameplayInvalid;copySeen.push(value);var result;if(Array.isArray(value)){result=[];var lengthDescriptor=Object.getOwnPropertyDescriptor(value,"length");if(!lengthDescriptor||!hasOwn.call(lengthDescriptor,"value"))return __gameplayInvalid;for(var index=0;index<lengthDescriptor.value;index+=1){var itemDescriptor=Object.getOwnPropertyDescriptor(value,String(index));if(!itemDescriptor||!hasOwn.call(itemDescriptor,"value"))return __gameplayInvalid;var item=copy(itemDescriptor.value,depth+1);if(item===__gameplayInvalid)return __gameplayInvalid;result[index]=item;}}else{if(!plain(value))return __gameplayInvalid;result={};var names=Object.keys(value);for(var nameIndex=0;nameIndex<names.length;nameIndex+=1){var name=names[nameIndex];var nameDescriptor=Object.getOwnPropertyDescriptor(value,name);if(!nameDescriptor||!hasOwn.call(nameDescriptor,"value"))return __gameplayInvalid;var copied=copy(nameDescriptor.value,depth+1);if(copied===__gameplayInvalid)return __gameplayInvalid;Object.defineProperty(result,name,{value:copied,enumerable:true,configurable:true,writable:true});}}copySeen.pop();return result;};var copied=copy(value,0);if(copied===__gameplayInvalid)return __gameplayInvalid;return {value:copied,defined:true};}catch(error){return __gameplayInvalid;}})(${record},${key},${type})`
}

export const RECORD_KEY_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([{
  id: 'data.read-key', version: '1', label: '按键读取记录字段',
  description: '从记录读取一个安全的直接键，并按封闭值类型返回不可变快照；缺失返回可空值。',
  inputs: [port('record', recordType, { nullable: true }), port('key', stringType, { optional: true, label: '动态键' })],
  outputs: [port('value', 'unknown', { nullable: true }), port('defined', booleanType)],
  parameters: [
    parameter('key', stringType, { optional: true, default: '' }),
    parameter('valueType', stringType, { enum: valueTypeEnum, default: JSON.stringify({ kind: 'nullable', value: stringType }) }),
  ],
  outputParameterTypeBindings: { value: { parameter: 'valueType', types: valueTypeBindings } },
  allowedSurfaces: SURFACES,
  effects: PURE,
  lower: lowerReadKey,
  ui: { category: 'field', authoring: 'standard' },
}])

export const DATA_READ_KEY_GAMEPLAY_MODULES = RECORD_KEY_GAMEPLAY_MODULES
export const GENERIC_RECORD_KEY_GAMEPLAY_MODULES = RECORD_KEY_GAMEPLAY_MODULES
