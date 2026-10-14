import type { GameplayModuleDescriptor, GameplayValueType } from './module-types'

const decode = (value: unknown): GameplayValueType => typeof value === 'string' && value.startsWith('{') ? JSON.parse(value) : value as GameplayValueType
/** Compare semantic value types without depending on object key insertion order. */
const same = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'string' || typeof b === 'string') return a === b
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const left = a as Exclude<GameplayValueType, string>
  const right = b as Exclude<GameplayValueType, string>
  if (left.kind !== right.kind) return false
  if (left.kind === 'list') return right.kind === 'list' && same(left.element, right.element)
  if (left.kind === 'set') return right.kind === 'set' && same(left.element, right.element)
  if (left.kind === 'map') return right.kind === 'map' && same(left.key, right.key) && same(left.value, right.value)
  if (left.kind === 'nullable') return right.kind === 'nullable' && same(left.value, right.value)
  return right.kind === 'record' && left.kind === 'record' && left.schema === right.schema
}
const list = (element: GameplayValueType): GameplayValueType => ({ kind: 'list', element })
type Operation = { id: string; label: string; method: string; inputs: readonly [string, string, string][]; output: string | GameplayValueType }
const operations: readonly Operation[] = [
  { id: 'map.create', label: '创建映射', method: 'authorMapCreate', inputs: [['keys','键元组','keysType'],['values','值元组','valuesType']], output: 'containerType' },
  { id: 'map.has-key', label: '包含键', method: 'authorMapHas', inputs: [['map','映射','containerType'],['key','键','keyType']], output: 'boolean' },
  { id: 'map.get', label: '读取映射值', method: 'authorMapGet', inputs: [['map','映射','containerType'],['key','键','keyType']], output: 'valueType' },
  { id: 'map.set', label: '更新映射', method: 'authorMapSet', inputs: [['map','映射','containerType'],['key','键','keyType'],['value','值','valueType']], output: 'containerType' },
  { id: 'map.delete', label: '移除映射项', method: 'authorMapDelete', inputs: [['map','映射','containerType'],['key','键','keyType']], output: 'containerType' },
  { id: 'map.keys', label: '键元组', method: 'authorMapKeys', inputs: [['map','映射','containerType']], output: 'keysType' },
  { id: 'map.values', label: '值元组', method: 'authorMapValues', inputs: [['map','映射','containerType']], output: 'valuesType' },
  { id: 'map.count', label: '映射数量', method: 'authorMapCount', inputs: [['map','映射','containerType']], output: 'number' },
  { id: 'set.create', label: '创建集合', method: 'createAuthorSet', inputs: [['items','元组','itemsType']], output: 'containerType' },
  { id: 'set.contains', label: '集合包含', method: 'authorSetHas', inputs: [['set','集合','containerType'],['value','值','valueType']], output: 'boolean' },
  { id: 'set.add', label: '加入集合', method: 'authorSetAdd', inputs: [['set','集合','containerType'],['value','值','valueType']], output: 'containerType' },
  { id: 'set.delete', label: '移出集合', method: 'authorSetDelete', inputs: [['set','集合','containerType'],['value','值','valueType']], output: 'containerType' },
  { id: 'set.items', label: '集合转元组', method: 'authorSetItems', inputs: [['set','集合','containerType']], output: 'itemsType' },
  { id: 'set.count', label: '集合数量', method: 'authorSetCount', inputs: [['set','集合','containerType']], output: 'number' },
]

export const AUTHOR_CONTAINER_MODULES: readonly GameplayModuleDescriptor[] = operations.map(operation => {
  const map = operation.id.startsWith('map.')
  const defaults: Record<string, GameplayValueType> = map
    ? { containerType: { kind:'map', key:'string', value:'number' }, keyType:'string', valueType:'number', keysType:list('string'), valuesType:list('number') }
    : { containerType: { kind:'set', element:'number' }, valueType:'number', itemsType:list('number') }
  const boundOutput = typeof operation.output === 'string' && operation.output in defaults ? operation.output : undefined
  return {
    id: operation.id, version: map && ['map.has-key','map.keys','map.values'].includes(operation.id) ? '2' : '1', label: operation.label,
    description: '返回新容器；原变量不会被隐式修改。映射保留键的类型，集合去重，元组保留顺序与重复项。',
    inputs: operation.inputs.map(([name,label,type]) => ({name,label,type:defaults[type]})),
    inputValueTypeBindings: Object.fromEntries(operation.inputs.map(([name,,parameter]) => [name,{parameter}])),
    outputs: [{name:'value',label:'结果',type:boundOutput ? defaults[boundOutput] : operation.output as GameplayValueType}],
    ...(boundOutput ? {outputValueTypeBindings:{value:{parameter:boundOutput}}} : {}),
    parameters: Object.entries(defaults).map(([name,type]) => ({name,type:'string' as const,label:'推导类型',default:typeof type === 'string' ? type : JSON.stringify(type)})),
    allowedSurfaces: ['skill','card','rule','triggerSkill','pending'], effects:{pure:true,previewSafe:false}, ui:{category:'calculation',authoring:'standard'},
    lower: ctx => {
      const container = decode(ctx.parameters.containerType)
      if (typeof container !== 'object' || container.kind !== (map ? 'map' : 'set')) throw new Error('容器类型不正确')
      const expected: Record<string,GameplayValueType> = container.kind === 'map'
        ? {keyType:container.key,valueType:container.value,keysType:list(container.key),valuesType:list(container.value)}
        : container.kind === 'set' ? {valueType:container.element,itemsType:list(container.element)} : {}
      for (const [name,type] of Object.entries(expected)) if (!same(type,decode(ctx.parameters[name]))) throw new Error('容器参数类型不一致')
      const expression = `${ctx.surface === 'pending' ? 'ctx.flow' : 'flow'}.containers.${operation.method}(${operation.inputs.map(([name]) => ctx.inputs[name]).join(',')})`
      return operation.id === 'map.get' ? `(function(result){if(!result.found)throw new Error("映射中不存在此键");return result.value;})(${expression})` : expression
    },
  }
})
