import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayParameter,
  GameplayPort,
  GameplayValueType,
} from './module-types'

/**
 * Generic runtime boundaries used by the ability-write migration.
 *
 * A skill instance is deliberately represented by an execution-local record
 * handle.  The record is not a skill id: its host-owned identity includes the
 * position in the owning piece's skill array, so two entries with the same
 * definition id remain independently addressable.  Reads use the closed
 * field selector below and writes go through the host setter; author graphs
 * never receive a mutable skill object or an arbitrary property path.
 */

const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const pieceType: GameplayValueType = 'piece'
const recordType: GameplayValueType = 'record'
const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const stringType: GameplayValueType = 'string'
const nullableStringType: GameplayValueType = { kind: 'nullable', value: stringType }
const nullableNumberType: GameplayValueType = { kind: 'nullable', value: numberType }
const instanceListType: GameplayValueType = { kind: 'list', element: recordType }
const statusType: GameplayValueType = 'status'
const statusListType: GameplayValueType = { kind: 'list', element: statusType }
const stringListType: GameplayValueType = { kind: 'list', element: stringType }
const valueTypeParameter = (type: GameplayValueType): string => typeof type === 'string' ? type : JSON.stringify(type)

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const parameter = (name: string, type: GameplayValueType, options: Omit<GameplayParameter, 'name' | 'type'> = {}): GameplayParameter => ({ name, type, ...options })
const pureRead = (reads: readonly string[]): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}
const selectedField = (ctx: GameplayNativeLoweringContext): string => {
  const value = ctx.parameters.field
  if (typeof value !== 'string') throw new Error(`module ${ctx.moduleId}: field must be text`)
  return value
}
const define = (value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'>): GameplayModuleDescriptor => ({
  version: '1', allowedSurfaces: ACTIVE, ...value,
})

const SKILL_INSTANCE_FIELDS: Readonly<Record<string, GameplayValueType>> = Object.freeze({
  skillId: nullableStringType,
  kind: nullableStringType,
  currentCooldown: nullableNumberType,
  definitionExists: booleanType,
})

const STATUS_INSTANCE_FIELDS: Readonly<Record<string, GameplayValueType>> = Object.freeze({
  name: nullableStringType,
  id: nullableStringType,
  type: nullableStringType,
  sourceId: nullableStringType,
  flightId: nullableStringType,
  remainingTurns: nullableNumberType,
  grantedTurnNumber: nullableNumberType,
  createdTurnNumber: nullableNumberType,
  turnNumber: nullableNumberType,
})

const STATUS_WRITE_FIELD_TYPES: Readonly<Record<string, GameplayValueType>> = Object.freeze({
  relatedRules: stringListType,
  type: stringType,
  sourceId: stringType,
  name: stringType,
  stacking: stringType,
  visible: booleanType,
  expiresAfterTurn: nullableNumberType,
  currentDuration: numberType,
  remainingDuration: numberType,
  currentUses: numberType,
  remainingUses: numberType,
  lastDamageTurn: numberType,
  stacks: numberType,
  intensity: numberType,
  hitCount: numberType,
  readyCharges: numberType,
  remainingTurns: numberType,
  grantedTurnNumber: numberType,
  createdTurnNumber: numberType,
  turnNumber: numberType,
  value: numberType,
})

/** Generic per-instance skill/status write support for atomic graph recipes. */
export const GENERIC_ABILITY_WRITE_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  define({
    id: 'skill.instances',
    label: '读取技能实例',
    description: '按棋子技能运行时顺序返回执行期间有效的技能实例句柄；相同技能定义的不同实例保持独立。',
    inputs: [port('piece', pieceType)],
    outputs: [port('instances', instanceListType), port('present', booleanType)],
    livingReferences: ['piece'],
    effects: { pure: false, previewSafe: false, reads: ['skills'], writes: ['execution-context'] },
    lower: ctx => `${flow(ctx)}.skills.instances(${input(ctx, 'piece')})`,
    ui: { category: 'skill', authoring: 'standard' },
  }),
  define({
    id: 'skill.instance-field',
    label: '读取技能实例字段',
    description: '从同一执行期间保留的技能实例句柄读取登记字段；不按技能定义标识重新寻找实例。',
    inputs: [port('instance', recordType)],
    outputs: [port('value', 'unknown', { nullable: true }), port('defined', booleanType)],
    parameters: [parameter('field', stringType, { enum: Object.keys(SKILL_INSTANCE_FIELDS) })],
    outputParameterTypeBindings: { value: { parameter: 'field', types: SKILL_INSTANCE_FIELDS } },
    effects: pureRead(['execution-context', 'skills']),
    lower: ctx => `${flow(ctx)}.skills.field(${input(ctx, 'instance')}, ${ctx.emitLiteral(selectedField(ctx))})`,
    ui: { category: 'field', authoring: 'standard' },
  }),
  define({
    id: 'status.instances',
    label: '读取全部状态实例',
    description: '按棋子状态数组顺序返回当前执行期间有效的状态实例句柄；重复类型和无标识记录保持独立。',
    inputs: [port('piece', pieceType)],
    outputs: [port('statuses', statusListType), port('present', booleanType)],
    livingReferences: ['piece'],
    effects: { pure: false, previewSafe: false, reads: ['statuses'], writes: ['execution-context'] },
    lower: ctx => `${flow(ctx)}.status.instances(${input(ctx, 'piece')})`,
    ui: { category: 'status', authoring: 'standard' },
  }),
  {
    id: 'status.instances', version: '2', allowedSurfaces: ACTIVE,
    label: '读取全部状态实例',
    description: '读取棋子或玩家的状态，保留每个实例的独立身份和排列顺序。',
    inputs: [port('owner', pieceType, { label: '所属对象' })],
    parameters: [parameter('ownerType', stringType, { label: '所属类型', enum: ['piece', 'player'], default: 'piece' })],
    inputValueTypeBindings: { owner: { parameter: 'ownerType' } },
    outputs: [port('statuses', statusListType), port('present', booleanType)],
    effects: { pure: false, previewSafe: false, reads: ['statuses'], writes: ['execution-context'] },
    lower: ctx => `${flow(ctx)}.status.instances(${input(ctx, 'owner')}, ${ctx.emitLiteral(ctx.parameters.ownerType ?? 'piece')})`,
    ui: { category: 'status', authoring: 'standard' },
  },
  define({
    id: 'status.instances-by-id',
    label: '按标识读取全部状态实例',
    description: '按不透明棋子标识读取战场或墓地中的状态实例；重复类型、无标识记录和已离场棋子保持独立。',
    inputs: [port('target', stringType)],
    outputs: [port('statuses', statusListType), port('present', booleanType)],
    effects: { pure: false, previewSafe: false, reads: ['statuses', 'pieces'], writes: ['execution-context'] },
    lower: ctx => `${flow(ctx)}.status.instancesById(${input(ctx, 'target')})`,
    ui: { category: 'status', authoring: 'standard' },
  }),
  define({
    id: 'status.instance-field',
    label: '读取状态实例字段',
    description: '从当前执行期间保留的状态实例句柄读取登记字段，不按标识重新匹配。',
    inputs: [port('status', statusType)],
    outputs: [port('value', 'unknown', { nullable: true }), port('defined', booleanType)],
    parameters: [parameter('field', stringType, { enum: Object.keys(STATUS_INSTANCE_FIELDS) })],
    outputParameterTypeBindings: { value: { parameter: 'field', types: STATUS_INSTANCE_FIELDS } },
    effects: pureRead(['execution-context', 'statuses']),
    lower: ctx => `(function(handle,field){var record=${flow(ctx)}.status.fields(handle),value=record[field];return {value:value===undefined?null:value,defined:value!==undefined};})(${input(ctx, 'status')},${ctx.emitLiteral(selectedField(ctx))})`,
    ui: { category: 'field', authoring: 'standard' },
  }),
  define({
    id: 'status.write-field', label: '状态字段赋值',
    description: '修改已选状态实例的封闭可写字段；字段与值类型由受信登记表绑定，规则的安装与移除使用规则语句。',
    inputs: [port('status', statusType, { nullable: true, label: '状态' }), port('value', recordType, { label: '值' })],
    inputValueTypeBindings: { value: { parameter: 'valueType' } },
    outputs: [port('success', booleanType)],
    parameters: [
      parameter('field', stringType, { enum: Object.keys(STATUS_WRITE_FIELD_TYPES), label: '字段' }),
      parameter('valueType', stringType, {
        enum: [...new Set(Object.values(STATUS_WRITE_FIELD_TYPES).map(valueTypeParameter))],
        default: valueTypeParameter(stringListType),
        label: '值类型',
      }),
    ],
    effects: { pure: false, previewSafe: false, reads: ['execution-context'], writes: ['statuses'] },
    lower: ctx => {
      const selected = selectedField(ctx)
      const expectedType = STATUS_WRITE_FIELD_TYPES[selected]
      const suppliedType = ctx.parameters.valueType ?? (expectedType ? valueTypeParameter(expectedType) : undefined)
      if (!expectedType || suppliedType !== valueTypeParameter(expectedType)) {
        throw new Error(`module ${ctx.moduleId}: ${selected} requires ${expectedType ? valueTypeParameter(expectedType) : 'a supported value type'}`)
      }
      return `${flow(ctx)}.status.writeField(${input(ctx, 'status')}, ${ctx.emitLiteral(selected)}, ${input(ctx, 'value')})`
    },
    ui: {
      category: 'field', authoring: 'standard',
      parameterTypeBindings: { valueType: { parameter: 'field', types: STATUS_WRITE_FIELD_TYPES } },
    },
  }),
  define({
    id: 'skill.set-instance-cooldown',
    label: '设定技能实例冷却',
    description: '通过技能宿主写入已选实例的冷却值；不会按技能定义标识更新其他同名实例。',
    inputs: [port('instance', recordType), port('value', numberType)],
    outputs: [port('success', booleanType)],
    effects: { pure: false, previewSafe: false, reads: ['execution-context'], writes: ['skills'] },
    lower: ctx => `${flow(ctx)}.skills.setInstanceCooldown(${input(ctx, 'instance')}, ${input(ctx, 'value')})`,
    ui: { category: 'skill', authoring: 'standard' },
  }),
])

export const ABILITY_WRITE_GAMEPLAY_MODULES = GENERIC_ABILITY_WRITE_GAMEPLAY_MODULES
export const genericAbilityWriteGameplayModuleDescriptors = GENERIC_ABILITY_WRITE_GAMEPLAY_MODULES
