import type { GameplayModuleDescriptor, GameplayNativeLoweringContext, GameplayRecordSchema, GameplayValueType } from './module-types'
import { authorValueSchemas } from '../game/author-extension'
const flow = (ctx: GameplayNativeLoweringContext) => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const valueType = (ctx: GameplayNativeLoweringContext): { type: string; schemas: string } => {
  const raw = ctx.parameters.valueType
  if (typeof raw !== 'string') throw new Error(`module ${ctx.moduleId}: valueType is required`)
  const type = raw.trimStart().startsWith('{') ? JSON.parse(raw) as GameplayValueType : raw as GameplayValueType
  const schemas = authorValueSchemas(type, (ctx.recordSchemas ?? []) as readonly GameplayRecordSchema[])
  return { type: JSON.stringify(type), schemas: JSON.stringify(schemas) }
}
const activeSurfaces = ['skill', 'card', 'rule', 'triggerSkill', 'pending'] as const
const localParameters = [{ name: 'valueType', type: 'string' as const, label: '值类型', default: 'number' }]
export const NAMED_LOCAL_GAMEPLAY_MODULE: GameplayModuleDescriptor = {
  id: 'local.declare', version: '2', label: '新建变量',
  description: '新建指定类型的局部变量；表达式直接引用变量名，赋值后读取最新值。',
  allowedSurfaces: activeSurfaces, inputs: [{ name: 'initial', type: 'record', label: '初始值', optional: true }],
  outputs: [{ name: 'handle', type: 'record', label: '变量' }],
  inputValueTypeBindings: { initial: { parameter: 'valueType' } },
  parameters: [...localParameters, { name: 'name', type: 'string', label: '变量名', default: 'value' }],
  effects: { pure: false, previewSafe: false, writes: ['execution-context'] },
  lower: ctx => {
    if (typeof ctx.parameters.name !== 'string' || !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(ctx.parameters.name)) throw new Error('变量名须以文字或下划线开头')
    const selected = valueType(ctx)
    return `${flow(ctx)}.execution.declare(${selected.type},${selected.schemas}${ctx.inputs.initial === undefined ? '' : ',' + ctx.inputs.initial})`
  }, ui: { category: 'flow', authoring: 'standard' },
}
export const EXECUTION_LOCAL_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = [
  NAMED_LOCAL_GAMEPLAY_MODULE,
  {
    id: 'local.declare', version: '1', label: '声明本次执行局部变量',
    description: '创建只属于当前图执行的类型化局部变量；句柄不能伪造、保存或跨执行复用。',
    allowedSurfaces: activeSurfaces, inputs: [{ name: 'initial', type: 'record', optional: true }],
    outputs: [{ name: 'handle', type: 'record' }, { name: 'success', type: 'boolean' }],
    inputValueTypeBindings: { initial: { parameter: 'valueType' } }, parameters: localParameters,
    effects: { pure: false, previewSafe: false, writes: ['execution-context'] },
    lower: ctx => {
      const selected = valueType(ctx)
      const initial = ctx.inputs.initial === undefined ? '' : `,${ctx.inputs.initial}`
      return `(${flow(ctx)}.execution.declare(${selected.type},${selected.schemas}${initial}))`
    },
    ui: { category: 'flow', authoring: 'standard' },
  },
  {
    id: 'local.read', version: '1', label: '读取本次执行局部变量',
    description: '按声明时的封闭类型读取当前执行局部变量，并返回实际读取成功标记。',
    allowedSurfaces: activeSurfaces, inputs: [{ name: 'handle', type: 'record' }],
    outputs: [{ name: 'value', type: 'record' }, { name: 'success', type: 'boolean' }],
    outputValueTypeBindings: { value: { parameter: 'valueType' } }, parameters: localParameters,
    effects: { pure: true, previewSafe: false, reads: ['execution-context'] },
    lower: ctx => {
      const selected = valueType(ctx)
      return `(${flow(ctx)}.execution.read(${ctx.inputs.handle},${selected.type},${selected.schemas}))`
    },
    ui: { category: 'flow', authoring: 'standard' },
  },
  {
    id: 'local.write', version: '1', label: '写入本次执行局部变量',
    description: '按声明时的封闭类型更新当前执行局部变量；验证失败时保留旧值。',
    allowedSurfaces: activeSurfaces, inputs: [{ name: 'handle', type: 'record' }, { name: 'value', type: 'record' }],
    outputs: [{ name: 'success', type: 'boolean' }],
    inputValueTypeBindings: { value: { parameter: 'valueType' } }, parameters: localParameters,
    effects: { pure: false, previewSafe: false, writes: ['execution-context'] },
    lower: ctx => {
      const selected = valueType(ctx)
      return `(${flow(ctx)}.execution.write(${ctx.inputs.handle},${selected.type},${selected.schemas},${ctx.inputs.value}))`
    },
    ui: { category: 'flow', authoring: 'standard' },
  },
  {
    id: 'source.captured-no-kill-charge', version: '1', label: '读取来源击杀充能豁免',
    allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'], inputs: [{ name: 'source', type: 'record' }], outputs: [{ name: 'value', type: 'boolean' }],
    effects: { pure: true, previewSafe: false, reads: ['execution-context', 'pieces'] },
    lower: ctx => `${flow(ctx)}.effects.capturedNoKillCharge(${ctx.inputs.source})`, ui: { category: 'query' },
  },
  {
    id: 'source.captured-max-hp', version: '1', label: '读取来源生命上限及基础值回退',
    allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'], inputs: [{ name: 'source', type: 'record' }, { name: 'fallback', type: 'number' }], outputs: [{ name: 'value', type: 'number' }],
    effects: { pure: true, previewSafe: false, reads: ['execution-context', 'pieces'] },
    lower: ctx => `${flow(ctx)}.effects.capturedMaxHp(${ctx.inputs.source}, ${ctx.inputs.fallback})`, ui: { category: 'query' },
  },
  {
    id: 'rule.remove-captured', version: '1', label: '移除已保留来源的规则',
    allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'],
    inputs: [{ name: 'source', type: 'record' }], outputs: [{ name: 'success', type: 'boolean' }],
    parameters: [{ name: 'ruleId', type: 'string' }], effects: { pure: false, previewSafe: false, writes: ['rules'] },
    lower: ctx => `${flow(ctx)}.effects.removeCapturedRule(${ctx.inputs.source}, ${ctx.emitLiteral(ctx.parameters.ruleId)})`, ui: { category: 'rule' },
  },
  {
    id: 'effect.queue-damage-captured', version: '1', label: '将已保留来源伤害加入队列',
    allowedSurfaces: ['rule'],
    inputs: [{ name: 'source', type: 'record' }, { name: 'target', type: 'record' }, { name: 'amount', type: 'number' }], outputs: [{ name: 'success', type: 'boolean' }],
    parameters: [{ name: 'damageType', type: 'string', enum: ['physical', 'magical', 'true'] }, { name: 'skillId', type: 'string' }],
    effects: { pure: false, previewSafe: false, writes: ['damage-queue'], events: ['beforeDamageDealt', 'afterDamageDealt'] },
    lower: ctx => `${flow(ctx)}.effects.queueDamageCaptured(${ctx.inputs.source}, ${ctx.inputs.target}, ${ctx.inputs.amount}, ${ctx.emitLiteral(ctx.parameters.damageType)}, ${ctx.emitLiteral(ctx.parameters.skillId)})`, ui: { category: 'effect' },
  },
  {
    id: 'source.captured-piece-reference', version: '1', label: '已保留来源的棋子引用',
    allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'],
    inputs: [{ name: 'source', type: 'record' }], outputs: [{ name: 'piece', type: 'piece' }],
    effects: { pure: true, previewSafe: false, reads: ['execution-context'] },
    lower: ctx => `${flow(ctx)}.effects.capturedIdentifier(${ctx.inputs.source})`, ui: { category: 'query' },
  },
  {
    id: 'source.captured-identifier', version: '1', label: '读取已保留来源标识',
    allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'],
    inputs: [{ name: 'source', type: 'record' }], outputs: [{ name: 'value', type: 'string' }],
    effects: { pure: true, previewSafe: false, reads: ['execution-context'] },
    lower: ctx => `${flow(ctx)}.effects.capturedIdentifier(${ctx.inputs.source})`, ui: { category: 'query' },
  },
  {
    id: 'source.captured-has-status', version: '1', label: '已保留来源是否具有状态',
    allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'],
    inputs: [{ name: 'source', type: 'record' }], outputs: [{ name: 'value', type: 'boolean' }],
    parameters: [{ name: 'statusType', type: 'string' }],
    effects: { pure: true, previewSafe: false, reads: ['execution-context', 'statuses'] },
    lower: ctx => `${flow(ctx)}.effects.capturedHasStatus(${ctx.inputs.source}, ${ctx.emitLiteral(ctx.parameters.statusType)})`, ui: { category: 'query' },
  },
  {
    id: 'log.trigger-effect', version: '1', label: '记录规则触发消息',
    allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'],
    inputs: [{ name: 'player', type: 'player' }, { name: 'message', type: 'string' }], outputs: [{ name: 'success', type: 'boolean' }],
    effects: { pure: false, previewSafe: false, writes: ['actions'] },
    lower: ctx => `${flow(ctx)}.log.triggerEffect(${ctx.inputs.player}, ${ctx.inputs.message})`, ui: { category: 'log' },
  },
  {
    id: 'source.captured-number', version: '1', label: '读取已保留来源数值',
    allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'],
    inputs: [{ name: 'source', type: 'record' }], outputs: [{ name: 'value', type: 'number' }],
    parameters: [{ name: 'field', type: 'string', enum: ['attack', 'defense', 'moveRange', 'currentHp', 'maxHp'] }],
    effects: { pure: true, previewSafe: false, reads: ['execution-context', 'pieces'] },
    lower: ctx => `${flow(ctx)}.effects.capturedNumber(${ctx.inputs.source}, ${ctx.emitLiteral(ctx.parameters.field)})`, ui: { category: 'query' },
  },
  {
    id: 'effect.result-number', version: '1', label: '读取权威效果结果数值',
    allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'],
    inputs: [{ name: 'result', type: 'record' }], outputs: [{ name: 'value', type: 'number' }],
    parameters: [{ name: 'field', type: 'string', enum: ['damage', 'heal', 'totalDamage', 'totalHeal'] }],
    effects: { pure: true, previewSafe: false },
    lower: ctx => `Number((${ctx.inputs.result} && ${ctx.inputs.result}[${ctx.emitLiteral(ctx.parameters.field)}]) || 0)`, ui: { category: 'query' },
  },
  {
    id: 'local.counter-create', version: '1', label: '创建本次执行计数器',
    description: '仅当前图执行有效的局部累计值，不写入对局，不可保存或跨续接使用。',
    allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'],
    inputs: [{ name: 'initial', type: 'number' }], outputs: [{ name: 'counter', type: 'record' }],
    effects: { pure: false, previewSafe: false, writes: ['execution-context'] },
    lower: ctx => `${flow(ctx)}.execution.counter(${ctx.inputs.initial})`, ui: { category: 'flow' },
  },
  {
    id: 'local.counter-add', version: '1', label: '累加本次执行计数',
    allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'],
    inputs: [{ name: 'counter', type: 'record' }, { name: 'amount', type: 'number' }], outputs: [{ name: 'value', type: 'number' }],
    effects: { pure: false, previewSafe: false, writes: ['execution-context'] },
    lower: ctx => `${flow(ctx)}.execution.addCounter(${ctx.inputs.counter}, ${ctx.inputs.amount})`, ui: { category: 'flow' },
  },
  {
    id: 'local.counter-read', version: '1', label: '读取本次执行计数',
    allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'],
    inputs: [{ name: 'counter', type: 'record' }], outputs: [{ name: 'value', type: 'number' }],
    effects: { pure: true, previewSafe: false, reads: ['execution-context'] },
    lower: ctx => `${flow(ctx)}.execution.readCounter(${ctx.inputs.counter})`, ui: { category: 'flow' },
  },
]
