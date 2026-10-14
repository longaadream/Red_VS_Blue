import type { GameplayModuleDescriptor, GameplayModuleSurface } from './module-types'

const surfaces: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview']
const pure = { pure: true, previewSafe: true } as const
const items = { kind: 'list', element: 'any' } as const
const ui = { category: 'calculation', authoring: 'standard' } as const

/** Common author operations. These return values; mutations require explicit assignment. */
export const AUTHOR_COLLECTION_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = [
  ...(['contains', 'index-of'] as const).map(operation => ({
    id: `collection.${operation}`, version: '1', label: operation === 'contains' ? '包含' : '首项序号',
    inputs: [{ name: 'items', type: { kind: 'list' as const, element: 'number' as const }, label: '容器' }, { name: 'value', type: 'number' as const, label: '查找值' }],
    parameters: [{ name: 'valueType', type: 'string' as const, label: '元素类型' }, { name: 'itemsType', type: 'string' as const, label: '容器类型' }],
    inputValueTypeBindings: { value: { parameter: 'valueType' }, items: { parameter: 'itemsType' } },
    outputs: [{ name: 'value', type: operation === 'contains' ? 'boolean' as const : 'number' as const }],
    allowedSurfaces: surfaces, effects: pure, ui,
    lower: (ctx: Parameters<GameplayModuleDescriptor['lower']>[0]) => {
      const element = String(ctx.parameters.valueType).startsWith('{') ? JSON.parse(String(ctx.parameters.valueType)) : ctx.parameters.valueType
      const container = JSON.parse(String(ctx.parameters.itemsType))
      if (container.kind !== 'list' || JSON.stringify(container.element) !== JSON.stringify(element)) throw new Error('查找值必须与容器元素类型一致')
      return `(function(items,value){if(!Array.isArray(items))throw new Error("容器类型不正确");var index=items.findIndex(function(item){return item===value||(Number.isNaN(item)&&Number.isNaN(value));});return ${operation === 'contains' ? 'index>=0' : 'index+1'};})(${ctx.inputs.items},${ctx.inputs.value})`
    },
  })),
  {
    id: 'collection.slice', version: '1', label: '截取元组',
    description: '从序号1开始，包含起始项，数量可省略；返回新元组。',
    inputs: [{ name: 'items', type: items, label: '容器' }, { name: 'start', type: 'number', label: '起始序号' }, { name: 'count', type: 'number', label: '数量', optional: true }],
    outputs: [{ name: 'items', type: items }], outputTypeBindings: { items: { input: 'items', projection: 'same' } },
    allowedSurfaces: surfaces, effects: pure, ui,
    lower: ctx => `(function(items,start,count){if(!Array.isArray(items)||!Number.isFinite(start)||start<1||count!==undefined&&(!Number.isFinite(count)||count<0))throw new Error("截取元组参数不合法");var index=Math.floor(start)-1;return items.slice(index,count===undefined?undefined:index+Math.floor(count));})(${ctx.inputs.items},${ctx.inputs.start},${ctx.inputs.count ?? 'undefined'})`,
  },
  {
    id: 'map.has-key', version: '1', label: '包含键',
    inputs: [{ name: 'map', type: 'record', label: '映射' }, { name: 'key', type: 'string', label: '键' }], outputs: [{ name: 'value', type: 'boolean' }],
    allowedSurfaces: surfaces, effects: pure, ui,
    lower: ctx => `Object.prototype.hasOwnProperty.call(${ctx.inputs.map},${ctx.inputs.key})`,
  },
  {
    id: 'map.keys', version: '1', label: '键列表',
    inputs: [{ name: 'map', type: 'record', label: '映射' }], outputs: [{ name: 'items', type: { kind: 'list', element: 'string' } }],
    allowedSurfaces: surfaces, effects: pure, ui, lower: ctx => `Object.keys(${ctx.inputs.map})`,
  },
  {
    id: 'map.values', version: '1', label: '值列表',
    inputs: [{ name: 'map', type: 'record', label: '映射' }], outputs: [{ name: 'items', type: items }],
    outputValueTypeBindings: { items: { parameter: 'valueType' } }, parameters: [{ name: 'valueType', type: 'string', label: '值元组类型' }],
    allowedSurfaces: surfaces, effects: pure, ui, lower: ctx => `Object.values(${ctx.inputs.map})`,
  },
  {
    id: 'spatial.relative-cells', version: '1', label: '相对地格范围',
    description: '将每个相对坐标加到中心坐标，按输入顺序返回地图内地格；地图外坐标不产生地格。',
    inputs: [{ name: 'center', type: 'cell', label: '中心地格' }, { name: 'offsets', type: { kind: 'list', element: 'cell' }, label: '相对坐标' }],
    outputs: [{ name: 'cells', type: { kind: 'list', element: 'cell' } }],
    allowedSurfaces: surfaces, effects: { ...pure, reads: ['map'] }, ui: { category: 'board', authoring: 'standard' },
    lower: ctx => `(function(center,offsets){var tiles=${ctx.surface === 'pending' ? 'ctx.battle' : 'battle'}.map.tiles;return offsets.map(function(offset){return {x:center.x+offset.x,y:center.y+offset.y};}).filter(function(cell){return tiles.some(function(tile){return tile.x===cell.x&&tile.y===cell.y;});});})(${ctx.inputs.center},${ctx.inputs.offsets})`,
  },
]
