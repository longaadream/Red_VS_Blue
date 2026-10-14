import type { GameplayModuleDescriptor, GameplayModuleSurface } from './module-types'

const surfaces: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview']
const collection = { kind: 'list', element: 'any' } as const
const pure = { pure: true, previewSafe: true } as const

/** Element types are inferred from the supplied collection, never from a content parameter. */
export const COLLECTION_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = [
  {
    id: 'collection.reverse', version: '1', label: '反转元组顺序',
    inputs: [{ name: 'items', type: collection, label: '元组' }], outputs: [{ name: 'items', type: collection, label: '倒序结果' }],
    outputTypeBindings: { items: { input: 'items', projection: 'same' } },
    allowedSurfaces: surfaces, effects: pure, ui: { category: 'collection', authoring: 'standard' },
    lower: ctx => `${ctx.inputs.items}.slice().reverse()`,
  },
  {
    id: 'collection.concat', version: '1', label: '拼接元组',
    description: '把两个同类型元组按顺序拼接为新元组，保留重复项，不改变原值。',
    inputs: [{ name: 'left', type: collection, label: '前半部分' }, { name: 'right', type: collection, label: '后半部分' }],
    outputs: [{ name: 'items', type: collection, label: '拼接结果' }],
    parameters: [{ name: 'valueType', type: 'string', default: JSON.stringify({ kind: 'list', element: 'string' }), label: '元组类型' }],
    inputValueTypeBindings: { left: { parameter: 'valueType' }, right: { parameter: 'valueType' } },
    outputValueTypeBindings: { items: { parameter: 'valueType' } },
    allowedSurfaces: surfaces, effects: pure, ui: { category: 'collection', authoring: 'standard' },
    lower: ctx => `(function(left,right){if(!Array.isArray(left)||!Array.isArray(right))throw new Error("collection.concat requires two tuples");return left.concat(right);})(${ctx.inputs.left},${ctx.inputs.right})`,
  },
  {
    id: 'collection.random', version: '1', label: '随机选取集合项',
    description: '使用对局种子从集合选择一项；空集合返回空值且不消耗随机数。',
    inputs: [{ name: 'items', type: collection, label: '集合' }],
    outputs: [{ name: 'value', type: 'any', nullable: true, label: '选中的项' }],
    outputTypeBindings: { value: { input: 'items', projection: 'element' } },
    allowedSurfaces: surfaces.filter(surface => surface !== 'preview'),
    effects: { pure: true, previewSafe: false, random: true, reads: ['random'] },
    ui: { category: 'collection', authoring: 'standard' },
    lower: ctx => `({value:${ctx.surface === 'pending' ? 'ctx.flow' : 'flow'}.query.random(${ctx.inputs.items})})`,
  },
  {
    id: 'collection.sort', version: '2', label: '排序集合',
    description: '按逐项排序依据返回新集合；支持数值、文本编码顺序和本地化文本顺序，同值保持原顺序。',
    inputs: [{ name: 'items', type: collection, label: '集合' }, { name: 'keys', type: collection, label: '每项的排序依据' }],
    outputs: [{ name: 'items', type: collection, label: '排序结果' }],
    outputTypeBindings: { items: { input: 'items', projection: 'same' } },
    parameters: [
      { name: 'order', type: 'string', enum: ['ascending', 'descending'], default: 'ascending', label: '顺序' },
      { name: 'comparison', type: 'string', enum: ['numeric', 'text', 'locale'], default: 'numeric', label: '比较方式' },
    ],
    allowedSurfaces: surfaces, effects: pure, ui: { category: 'collection', authoring: 'standard' },
    lower: ctx => {
      const numeric = ctx.parameters.comparison === 'numeric'
      const compare = numeric ? 'left.key-right.key' : ctx.parameters.comparison === 'locale' ? 'left.key.localeCompare(right.key)' : '(left.key<right.key?-1:left.key>right.key?1:0)'
      return `(function(items,keys){if(!Array.isArray(items)||!Array.isArray(keys)||items.length!==keys.length)throw new Error("collection.sort requires one key per item");var entries=items.map(function(item,index){var key=keys[index];if(${numeric ? '!Number.isFinite(key)' : 'typeof key!=="string"'})throw new Error("collection.sort key type mismatch");return {item:item,key:key,index:index};});entries.sort(function(left,right){return (${ctx.parameters.order === 'descending' ? '-1' : '1'})*(${compare})||left.index-right.index;});return entries.map(function(entry){return entry.item;});})(${ctx.inputs.items},${ctx.inputs.keys})`
    },
  },
  {
    id: 'collection.length', version: '1', label: '获取集合长度',
    description: '返回集合元素数量，空集合返回0，不改变输入集合。',
    inputs: [{ name: 'items', type: collection, label: '集合' }],
    outputs: [{ name: 'value', type: 'number', label: '数量' }],
    allowedSurfaces: surfaces, effects: pure, ui: { category: 'collection' },
    lower: ctx => `(function(items) { if (!Array.isArray(items)) throw new Error("collection.length requires a collection"); return items.length; })(${ctx.inputs.items})`,
  },
  {
    id: 'collection.at', version: '1', label: '获取集合项',
    description: '位置1为第一项；空集合或越界返回无效值，只跳过依赖该值的语句。',
    inputs: [{ name: 'items', type: collection, label: '集合' }, { name: 'position', type: 'number', label: '位置（从1开始）' }],
    outputs: [{ name: 'value', type: 'any', label: '集合项' }],
    outputTypeBindings: { value: { input: 'items', projection: 'element' } },
    allowedSurfaces: surfaces, effects: pure, ui: { category: 'collection' },
    lower: ctx => `(function(items, position) { if (!Array.isArray(items)) throw new Error("collection.at requires a collection"); if (!Number.isFinite(position)) throw new Error("collection.at requires a finite position"); var index = Math.floor(position) - 1; return index < 0 || index >= items.length ? __gameplayInvalid : items[index]; })(${ctx.inputs.items}, ${ctx.inputs.position})`,
  },
  {
    id: 'collection.sort', version: '1', label: '排序集合',
    description: '依据逐项对应的数值排序键返回新集合，同值保留原顺序。排序键可由集合映射读取属性生成。',
    inputs: [{ name: 'items', type: collection, label: '集合' }, { name: 'keys', type: { kind: 'list', element: 'number' }, label: '每项的排序依据' }],
    outputs: [{ name: 'items', type: collection, label: '排序结果' }],
    outputTypeBindings: { items: { input: 'items', projection: 'same' } },
    parameters: [{ name: 'order', type: 'string', enum: ['ascending', 'descending'], default: 'ascending', label: '顺序' }],
    allowedSurfaces: surfaces, effects: pure, ui: { category: 'collection' },
    lower: ctx => `(function(items, keys) { if (!Array.isArray(items) || !Array.isArray(keys) || items.length !== keys.length) throw new Error("collection.sort requires one key per item"); var keyed = items.map(function(item, index) { if (!Number.isFinite(keys[index])) throw new Error("collection.sort requires finite numeric keys"); return { item: item, key: keys[index], index: index }; }); keyed.sort(function(left, right) { return ${ctx.parameters.order === 'descending' ? 'right.key - left.key' : 'left.key - right.key'} || left.index - right.index; }); return keyed.map(function(entry) { return entry.item; }); })(${ctx.inputs.items}, ${ctx.inputs.keys})`,
  },
]
