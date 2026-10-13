import type { GameplayModuleDescriptor, GameplayNativeLoweringContext, GameplayRecordSchema, GameplayValueType } from './module-types'
import { AUTHOR_PIECE_INSTANCE_SCHEMA_ID, AUTHOR_SUMMON_RECORD_SCHEMAS } from '../game/author-summon-schema'
import { authorValueSchemas } from '../game/author-extension'

const surfaces = ['skill', 'card', 'rule', 'triggerSkill', 'pending'] as const
const flow = (ctx: GameplayNativeLoweringContext) => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
function declaration(ctx: GameplayNativeLoweringContext): string {
  const reference = String(ctx.parameters.schema)
  const schema = ctx.recordSchemas?.find(item => item.id === reference || item.id + '@' + item.version === reference)
  if (!schema) throw new Error('extension：请选择已声明的记录类型')
  const schemas: GameplayRecordSchema[] = []
  const visitType = (type: GameplayValueType): void => {
    if (typeof type === 'string') return
    if (type.kind === 'list' || type.kind === 'set') return visitType(type.element)
    if (type.kind === 'map') { visitType(type.key); visitType(type.value); return }
    if (type.kind === 'nullable') return visitType(type.value)
    const dependency = ctx.recordSchemas?.find(item => item.id === type.schema || item.id + '@' + item.version === type.schema)
    if (dependency) visit(dependency)
  }
  const visit = (item: GameplayRecordSchema): void => {
    if (schemas.some(previous => previous.id === item.id && previous.version === item.version)) return
    schemas.push(item); item.fields.forEach(field => visitType(field.type))
  }
  visit(schema)
  schemas.sort((a, b) => (a.id + '@' + a.version).localeCompare(b.id + '@' + b.version))
  return JSON.stringify({ schema, schemas, keyField: ctx.parameters.keyField })
}
const parameters = [
  { name: 'namespace', type: 'string' as const, label: '扩展分组', default: 'content', optional: true },
  { name: 'name', type: 'string' as const, label: '变量名称' },
  { name: 'schema', type: 'string' as const, label: '记录类型' },
  { name: 'keyField', type: 'string' as const, label: '映射键字段' },
]

export const AUTHOR_STATE_MODULES: readonly GameplayModuleDescriptor[] = [
  {
    id: 'status.query-instances', version: '1', label: '查询状态实例',
    description: '按状态类型查询目标棋子上的状态实例；可指定来源实例筛选。返回的元组保持状态顺序，空结果为零项。',
    inputs: [{ name: 'piece', type: 'piece', label: '棋子' }, { name: 'source', type: 'piece', label: '来源', optional: true }],
    outputs: [{ name: 'statuses', type: { kind: 'list', element: 'status' }, label: '状态实例元组' }],
    parameters: [{ name: 'statusType', type: 'string', label: '状态类型' }],
    allowedSurfaces: surfaces, effects: { pure: false, previewSafe: false, reads: ['statuses'], writes: ['execution-context'] },
    ui: { category: 'status-rule', authoring: 'standard' },
    lower: ctx => `${flow(ctx)}.status.queryInstances(${ctx.inputs.piece},${ctx.emitLiteral(ctx.parameters.statusType)}${ctx.inputs.source === undefined ? '' : ',' + ctx.inputs.source})`,
  },
  {
    id: 'status.remove-instance', version: '1', label: '移除状态实例',
    description: '移除当前执行中选定的那个状态实例，不按名称或类型重新匹配，不触发移除事件；失效引用使语句无效。',
    inputs: [{ name: 'status', type: 'status', label: '状态实例' }], outputs: [{ name: 'removed', type: 'boolean', label: '已移除' }],
    allowedSurfaces: surfaces, effects: { pure: false, previewSafe: false, writes: ['statuses'] },
    ui: { category: 'status-rule', authoring: 'standard' }, lower: ctx => `${flow(ctx)}.status.removeInstance(${ctx.inputs.status})`,
  },
  ...(['player', 'piece', 'battle'] as const).flatMap(scope => (['declare', 'read', 'write'] as const).map(operation => ({
    id: 'extension.' + operation + '-' + scope, version: '1',
    label: { declare: '声明', read: '读取', write: '写入' }[operation] + { player: '玩家', piece: '棋子', battle: '全局' }[scope] + '扩展变量',
    description: operation === 'declare' ? '首次声明使用初始值；相同类型的已有变量保留原值。' : '可从当前上下文选择，也可自定义变量和字段路径。缺失或类型不符时语句无效，独立后续继续，不自动创建数据。元组路径下标从 1 开始。',
    inputs: [
      ...(scope === 'battle' ? [] : [{ name: 'owner', type: scope, label: '对象' }]),
      ...(operation === 'read' ? [] : [{ name: 'value', type: 'record' as const, label: operation === 'declare' ? '初始值' : '值' }]),
    ],
    outputs: [{ name: 'value', type: 'record' as const, label: '值' }],
    outputValueTypeBindings: { value: { parameter: 'valueType' } },
    ...(operation === 'read' ? {} : { inputValueTypeBindings: { value: { parameter: 'valueType' } } }),
    parameters: [
      { name: 'namespace', type: 'string' as const, label: '扩展分组', default: 'content', optional: true },
      { name: 'name', type: 'string' as const, label: '变量名称' },
      ...(operation === 'declare' ? [] : [{ name: 'path', type: 'string' as const, label: '字段路径', default: '', optional: true }]),
      { name: 'valueType', type: 'string' as const, label: '值类型', default: 'number' },
    ],
    allowedSurfaces: surfaces,
    effects: { pure: operation === 'read', previewSafe: false, reads: ['extensions'], ...(operation === 'read' ? {} : { writes: ['extensions'] }) },
    ui: { category: 'data', authoring: 'standard' as const },
    lower: (ctx: GameplayNativeLoweringContext) => {
      const raw = String(ctx.parameters.valueType)
      const type = raw.trimStart().startsWith('{') ? JSON.parse(raw) : raw
      const method = { declare: 'declareValue', read: 'readValue', write: 'writeValue' }[operation]
      const args = [JSON.stringify(scope), scope === 'battle' ? '"battle"' : ctx.inputs.owner,
        ctx.emitLiteral(ctx.parameters.namespace), ctx.emitLiteral(ctx.parameters.name),
        ...(operation === 'declare' ? [] : [ctx.emitLiteral(ctx.parameters.path)]),
        JSON.stringify(type), JSON.stringify(authorValueSchemas(type, ctx.recordSchemas ?? [])),
        ...(operation === 'read' ? [] : [ctx.inputs.value])]
      // A user record may itself have a `value` field. Always provide the
      // named output envelope so the compiler unwraps only our outer layer.
      return `({value:${flow(ctx)}.extension.${method}(${args.join(',')})})`
    },
  }))),
  ...(['player', 'piece', 'battle'] as const).map(scope => ({
    id: 'extension.read-optional-' + scope, version: '1',
    label: '读取可选' + { player: '玩家', piece: '棋子', battle: '全局' }[scope] + '扩展变量',
    description: '读取已有扩展变量；变量缺失返回空值且不会声明或写入存储，已有值仍按字段路径和类型校验。',
    inputs: scope === 'battle' ? [] : [{ name: 'owner', type: scope, label: '对象' }],
    outputs: [{ name: 'value', type: 'record' as const, nullable: true, label: '值' }],
    outputValueTypeBindings: { value: { parameter: 'valueType' } },
    parameters: [
      { name: 'namespace', type: 'string' as const, label: '扩展分组', default: 'content', optional: true },
      { name: 'name', type: 'string' as const, label: '变量名称' },
      { name: 'path', type: 'string' as const, label: '字段路径', default: '', optional: true },
      { name: 'valueType', type: 'string' as const, label: '值类型', default: 'number' },
    ],
    allowedSurfaces: surfaces,
    effects: { pure: true, previewSafe: false, reads: ['extensions'] },
    // Compatibility-only adapter: it is available to migrated graphs but is
    // intentionally hidden from the normal authoring module menu.
    ui: { category: 'data', authoring: 'compatibility' as const },
    lower: (ctx: GameplayNativeLoweringContext) => {
      const raw = String(ctx.parameters.valueType)
      const type = raw.trimStart().startsWith('{') ? JSON.parse(raw) : raw
      const args = [JSON.stringify(scope), scope === 'battle' ? '"battle"' : ctx.inputs.owner,
        ctx.emitLiteral(ctx.parameters.namespace), ctx.emitLiteral(ctx.parameters.name),
        ctx.emitLiteral(ctx.parameters.path), JSON.stringify(type), JSON.stringify(authorValueSchemas(type, ctx.recordSchemas ?? []))]
      return `({value:${flow(ctx)}.extension.readValueOrNull(${args.join(',')})})`
    },
  })),
  ...(['declare', 'items', 'put', 'remove'] as const).map(operation => {
    const readsItems = operation === 'declare' || operation === 'items'
    const method = { declare: 'declareMap', items: 'mapItems', put: 'mapPut', remove: 'mapRemove' }[operation]
    return {
      id: 'extension.map-' + operation, version: '1',
      label: { declare: '声明玩家扩展映射', items: '读取扩展映射记录', put: '写入扩展映射项', remove: '删除扩展映射项' }[operation],
      description: operation === 'declare' ? '首次创建空映射；再次声明相同类型保留已有数据。键字段可以保存棋子等实体引用。' : '操作已经声明的玩家 extension 映射；同一键写入只替换对应记录，其他实例保持独立。',
      inputs: [
        { name: 'player', type: 'player' as const, label: '所属玩家' },
        ...(!readsItems ? [{ name: 'item', type: 'record' as const, label: '记录' }] : []),
      ],
      outputs: readsItems ? [{ name: 'items', type: { kind: 'list' as const, element: 'record' as const }, label: '记录元组' }] : [{ name: 'success', type: 'boolean' as const, label: '完成' }],
      ...(readsItems ? { outputSchemaBindings: { items: { parameter: 'schema', list: true } } } : { inputSchemaBindings: { item: { parameter: 'schema' } } }),
      parameters,
      allowedSurfaces: surfaces,
      effects: { pure: operation === 'items', previewSafe: false, reads: ['extensions'], ...(operation === 'items' ? {} : { writes: ['extensions'] }) },
      ui: { category: 'data', authoring: 'standard' as const },
      lower: (ctx: GameplayNativeLoweringContext) => `${flow(ctx)}.extension.${method}(${ctx.inputs.player},${ctx.emitLiteral(ctx.parameters.namespace)},${ctx.emitLiteral(ctx.parameters.name)},${declaration(ctx)}${readsItems ? '' : ',' + ctx.inputs.item})`,
    }
  }),
  {
    id: 'instance.copy-piece', version: '1', label: '复制棋子实例',
    description: '复制棋子可恢复信息，保留外部实体引用身份；副本可以存入 extension。',
    inputs: [{ name: 'piece', type: 'piece', label: '棋子' }], outputs: [{ name: 'snapshot', type: 'record', label: '实例副本' }],
    recordSchemas: AUTHOR_SUMMON_RECORD_SCHEMAS,
    outputSchemaBindings: { snapshot: { parameter: 'snapshotType' } },
    parameters: [{ name: 'snapshotType', type: 'string', default: AUTHOR_PIECE_INSTANCE_SCHEMA_ID, label: '副本类型' }],
    allowedSurfaces: surfaces, effects: { pure: true, previewSafe: false, reads: ['pieces', 'extensions', 'rules'] },
    ui: { category: 'data', authoring: 'standard' }, lower: ctx => `${flow(ctx)}.instances.copy(${ctx.inputs.piece})`,
  },
  {
    id: 'instance.apply-piece', version: '1', label: '应用棋子实例信息',
    description: '恢复目标棋子信息，保留场上身份和位置；位置通过位移模块单独处理，不产生普通治疗或状态增删触发。',
    inputs: [{ name: 'piece', type: 'piece', label: '目标棋子' }, { name: 'snapshot', type: 'record', label: '实例副本' }],
    outputs: [{ name: 'success', type: 'boolean', label: '完成' }],
    allowedSurfaces: surfaces, effects: { pure: false, previewSafe: false, writes: ['pieces', 'extensions', 'rules'] },
    ui: { category: 'data', authoring: 'standard' }, lower: ctx => `${flow(ctx)}.instances.apply(${ctx.inputs.piece},${ctx.inputs.snapshot})`,
  },
]

/** v1 remains byte-stable; v2 can address pre-existing global extension fields. */
const ROOT_AUTHOR_STATE_BASE_MODULES = AUTHOR_STATE_MODULES
  .filter(module => ['extension.declare-battle', 'extension.read-battle', 'extension.read-optional-battle', 'extension.write-battle'].includes(module.id))

function lowerRootAuthorState(module: GameplayModuleDescriptor, ctx: GameplayNativeLoweringContext, withSuccess: boolean): string {
  const operation = module.id.split('.')[1].replace(/-battle$/, '') as 'declare' | 'read' | 'read-optional' | 'write'
  const raw = String(ctx.parameters.valueType)
  const type = raw.trimStart().startsWith('{') ? JSON.parse(raw) : raw
  const method = { declare: 'declareValue', read: 'readValue', 'read-optional': 'readValueOrNull', write: 'writeValue' }[operation]
  const reading = operation === 'read' || operation === 'read-optional'
  const args = ['"battle"', '"battle"', ctx.emitLiteral(ctx.parameters.namespace), ctx.emitLiteral(ctx.parameters.name),
    ...(operation === 'declare' ? [] : [ctx.inputs.path ?? ctx.emitLiteral(ctx.parameters.path)]),
    JSON.stringify(type), JSON.stringify(authorValueSchemas(type, ctx.recordSchemas ?? [])),
    ...(!reading ? [ctx.inputs.value] : [])]
  const call = `${flow(ctx)}.${ctx.parameters.namespace === '' ? 'extensionRoot' : 'extension'}.${method}(${args.join(',')})`
  return withSuccess ? `({value:${call},success:true})` : `({value:${call}})`
}

export const ROOT_AUTHOR_STATE_MODULES: readonly GameplayModuleDescriptor[] = ROOT_AUTHOR_STATE_BASE_MODULES.map(module => ({
  ...module, version: '2',
  inputs: [...module.inputs, ...(module.id === 'extension.declare-battle' ? [] : [{ name: 'path', type: { kind: 'list' as const, element: 'string' as const }, optional: true, label: '字段路径' }])],
  lower: ctx => lowerRootAuthorState(module, ctx, false),
}))

/** v3 adds an explicit operation-success port without changing v1/v2 output. */
export const ROOT_AUTHOR_STATE_SUCCESS_MODULES: readonly GameplayModuleDescriptor[] = ROOT_AUTHOR_STATE_MODULES
  .filter(module => ['extension.declare-battle', 'extension.write-battle'].includes(module.id))
  .map(module => ({
    ...module,
    version: '3',
    outputs: [...module.outputs, { name: 'success', type: 'boolean' as const, label: '完成' }],
    lower: (ctx: GameplayNativeLoweringContext) => lowerRootAuthorState(module, ctx, true),
  }))

/** Generic root deletion used by compatibility migrations and author graphs. */
export const ROOT_AUTHOR_STATE_REMOVE_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([{
  id: 'extension.remove-battle', version: '1', label: '删除全局扩展变量',
  description: '删除一个已声明的扩展根字段；字段不存在时返回失败，不以空记录替代缺失字段。',
  inputs: [],
  outputs: [{ name: 'success', type: 'boolean' as const, label: '完成' }],
  parameters: [
    { name: 'namespace', type: 'string' as const, label: '扩展分组', default: '', optional: true },
    { name: 'name', type: 'string' as const, label: '变量名称' },
    { name: 'valueType', type: 'string' as const, label: '值类型', default: 'record' },
  ],
  allowedSurfaces: surfaces,
  effects: { pure: false, previewSafe: false, writes: ['extensions'] },
  ui: { category: 'data', authoring: 'standard' as const },
  lower: (ctx: GameplayNativeLoweringContext) => {
    const raw = String(ctx.parameters.valueType ?? 'record')
    const type = raw.trimStart().startsWith('{') ? JSON.parse(raw) : raw
    const schemas = authorValueSchemas(type, ctx.recordSchemas ?? [])
    const target = String(ctx.parameters.namespace ?? '') === '' ? 'extensionRoot' : 'extension'
    const args = ['"battle"', '"battle"', ctx.emitLiteral(ctx.parameters.namespace ?? ''), ctx.emitLiteral(ctx.parameters.name), JSON.stringify(type), JSON.stringify(schemas)]
    return `({success:${flow(ctx)}.${target}.removeValue(${args.join(',')})})`
  },
}])
