import type { GameplayModuleDescriptor } from './module-types'

/** Data transformations return new records; authoritative storage is committed separately. */
export const RECORD_VALUE_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = [{
  id: 'data.omit-key', version: '1', label: '删除记录中的字段',
  description: '返回删除指定字段后的记录副本；不修改原记录，键按完整文本处理。',
  inputs: [{ name: 'record', type: 'record', label: '记录' }, { name: 'key', type: 'string', label: '字段' }],
  outputs: [{ name: 'value', type: 'record', label: '新记录' }],
  allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview'],
  effects: { pure: true, previewSafe: true }, ui: { category: 'data', authoring: 'standard' },
  lower: ctx => `(function(record,key){if(!record||typeof record!=="object"||Array.isArray(record)||typeof key!=="string"||!key||["__proto__","prototype","constructor"].includes(key))throw new Error("data.omit-key: invalid record or key");var seen=new Set(),budget=10000;var copy=function(value,depth){if(--budget<0||depth>40)throw new Error("data.omit-key: value budget exceeded");if(value===null||typeof value==="string"||typeof value==="boolean"||(typeof value==="number"&&Number.isFinite(value)))return value;if(typeof value!=="object"||seen.has(value))throw new Error("data.omit-key: invalid JSON value");seen.add(value);var result=Array.isArray(value)?[]:{};Object.keys(value).forEach(function(name){if(depth===0&&name===key)return;if(["__proto__","prototype","constructor"].includes(name))throw new Error("data.omit-key: unsafe field");var descriptor=Object.getOwnPropertyDescriptor(value,name);if(!descriptor||!("value" in descriptor))throw new Error("data.omit-key: accessor field");result[name]=copy(descriptor.value,depth+1);});seen.delete(value);return result;};return {value:copy(record,0)};})(${ctx.inputs.record},${ctx.inputs.key})`,
}, {
  id: 'record.set-key', version: '1', label: '按键设置记录字段',
  description: '复制记录并按运行时安全键写入值；不修改输入记录。',
  inputs: [
    { name: 'record', type: 'record', label: '记录' },
    { name: 'key', type: 'string', label: '字段' },
    { name: 'value', type: 'record', label: '值' },
  ],
  outputs: [{ name: 'record', type: 'record', label: '新记录' }],
  inputValueTypeBindings: { value: { parameter: 'valueType' } },
  parameters: [{ name: 'valueType', type: 'string', default: JSON.stringify({ kind: 'list', element: 'record' }) }],
  allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview'],
  effects: { pure: true, previewSafe: true },
  lower: ctx => {
    const record = ctx.inputs.record
    const key = ctx.inputs.key
    const value = ctx.inputs.value
    return `(function(record,key,value){var unsafe=function(name){return name==="__proto__"||name==="prototype"||name==="constructor";};var clone=function(item,seen,depth){if(item===__gameplayInvalid||item===undefined||depth>40)return __gameplayInvalid;if(item===null||typeof item!=="object"){if(typeof item==="number"&&!Number.isFinite(item))return __gameplayInvalid;if(typeof item==="function"||typeof item==="symbol"||typeof item==="bigint")return __gameplayInvalid;return item;}if(seen.indexOf(item)>=0)return __gameplayInvalid;var keys=Reflect.ownKeys(item),result=Array.isArray(item)?[]:{};if(Array.isArray(item)){var prototype=Object.getPrototypeOf(item);if(prototype!==Array.prototype)return __gameplayInvalid;var length=Object.getOwnPropertyDescriptor(item,"length");if(!length||length.enumerable||!Number.isSafeInteger(length.value)||length.value<0)return __gameplayInvalid;for(var index=0;index<length.value;index+=1){var descriptor=Object.getOwnPropertyDescriptor(item,String(index));if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return __gameplayInvalid;var copied=clone(descriptor.value,seen.concat([item]),depth+1);if(copied===__gameplayInvalid)return __gameplayInvalid;result.push(copied);}if(keys.length!==length.value+1)return __gameplayInvalid;return result;}var prototype=Object.getPrototypeOf(item);if(prototype!==null&&Object.getPrototypeOf(prototype)!==null)return __gameplayInvalid;for(var keyIndex=0;keyIndex<keys.length;keyIndex+=1){var name=keys[keyIndex];if(typeof name!=="string"||unsafe(name))return __gameplayInvalid;var descriptor=Object.getOwnPropertyDescriptor(item,name);if(!descriptor||!descriptor.enumerable||!("value" in descriptor))return __gameplayInvalid;var copied=clone(descriptor.value,seen.concat([item]),depth+1);if(copied===__gameplayInvalid)return __gameplayInvalid;Object.defineProperty(result,name,{value:copied,writable:true,enumerable:true,configurable:true});}return result;};if(record===__gameplayInvalid||value===__gameplayInvalid||typeof key!=="string"||!key||unsafe(key))return __gameplayInvalid;var next=clone(record,[],0),child=clone(value,[],0);if(next===__gameplayInvalid||child===__gameplayInvalid)return __gameplayInvalid;Object.defineProperty(next,key,{value:child,writable:true,enumerable:true,configurable:true});return {record:next};})(${record},${key},${value})`
  },
  ui: { category: 'data', authoring: 'standard' },
}, {
  id: 'record.is-empty', version: '1', label: '记录为空',
  description: '判断一个普通记录是否没有自有字段。',
  inputs: [{ name: 'record', type: 'record', label: '记录' }],
  outputs: [{ name: 'value', type: 'boolean', label: '是否为空' }],
  allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview'],
  effects: { pure: true, previewSafe: true },
  lower: ctx => `(function(record){if(record===__gameplayInvalid||record===null||typeof record!=="object"||Array.isArray(record))return __gameplayInvalid;return Object.keys(record).length===0;})(${ctx.inputs.record})`,
  ui: { category: 'data', authoring: 'standard' },
}]
