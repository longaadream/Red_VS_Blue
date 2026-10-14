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
 * Author-facing access to the concrete skill instance executing the current
 * skill.  The value returned by `ref.current-skill` is an opaque, execution
 * local handle.  It is deliberately not a skill definition or a record that
 * authors can construct themselves.
 */

const CURRENT_SKILL_SURFACES: readonly GameplayModuleSurface[] = ['skill', 'pending']
const ACTIVE_SURFACES: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']

const recordType: GameplayValueType = 'record'
const numberType: GameplayValueType = 'number'
const stringType: GameplayValueType = 'string'
const pieceType: GameplayValueType = 'piece'
const booleanType: GameplayValueType = 'boolean'

const CURRENT_SKILL_FIELDS: Readonly<Record<string, GameplayValueType>> = Object.freeze({
  currentCooldown: numberType,
  usesRemaining: numberType,
  skillId: stringType,
  level: numberType,
  owner: pieceType,
  // The multiplier is part of the verified Skill definition selected by the
  // concrete instance.  It is deliberately read-only here: authors may
  // change runtime cooldown/count/level, but cannot mutate content metadata.
  powerMultiplier: numberType,
})

const WRITABLE_CURRENT_SKILL_FIELDS: readonly string[] = ['currentCooldown', 'usesRemaining', 'level']

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

const writeLowering = (ctx: GameplayNativeLoweringContext): string => {
  const instance = input(ctx, 'instance')
  const value = input(ctx, 'value')
  const field = selectedField(ctx)
  if (field === 'currentCooldown') return `${flow(ctx)}.skills.setInstanceCooldown(${instance}, ${value})`
  return `${flow(ctx)}.skills.setInstanceField(${instance}, ${ctx.emitLiteral(field)}, ${value})`
}

const pureRead: GameplayEffectMetadata = {
  pure: true,
  previewSafe: false,
  reads: ['execution-context', 'skills'],
}

const currentSkill: GameplayModuleDescriptor = {
  id: 'ref.current-skill',
  version: '1',
  label: '当前技能实例',
  description: '取得当前正在执行的实际技能实例；不存在有效实例时由运行时使语句失效。',
  inputs: [],
  outputs: [port('instance', recordType, { label: '技能实例' })],
  allowedSurfaces: CURRENT_SKILL_SURFACES,
  effects: pureRead,
  ui: { category: 'reference', authoring: 'standard' },
  lower: ctx => `${flow(ctx)}.skills.current()`,
}

const skillInstanceField: GameplayModuleDescriptor = {
  id: 'author.skill-instance.field',
  version: '1',
  label: '读取技能实例字段',
  description: '读取实际技能实例的登记字段；不把技能定义或任意记录当作实例。',
  inputs: [port('instance', recordType, { label: '技能实例' })],
  outputs: [port('value', 'unknown'), port('defined', booleanType)],
  parameters: [parameter('field', stringType, { enum: Object.keys(CURRENT_SKILL_FIELDS) })],
  outputParameterTypeBindings: {
    value: { parameter: 'field', types: CURRENT_SKILL_FIELDS },
  },
  effects: pureRead,
  allowedSurfaces: ACTIVE_SURFACES,
  ui: { category: 'field', authoring: 'standard' },
  lower: ctx => {
    const read = `${flow(ctx)}.skills.field(${input(ctx, 'instance')}, ${ctx.emitLiteral(selectedField(ctx))})`
    return `(function(result){if(!result||result.defined!==true||result.value===undefined||result.value===null)throw new Error("当前技能实例字段不可用");return result;})(${read})`
  },
}

const skillInstanceWrite: GameplayModuleDescriptor = {
  id: 'author.skill-instance.write',
  version: '1',
  label: '写入技能实例字段',
  description: '写入实际技能实例允许修改的运行字段；冷却沿用现有宿主入口，不替换技能标识或定义引用。',
  inputs: [port('instance', recordType, { label: '技能实例' }), port('value', numberType, { label: '数值' })],
  outputs: [port('success', booleanType, { label: '写入成功' })],
  parameters: [parameter('field', stringType, { enum: WRITABLE_CURRENT_SKILL_FIELDS })],
  allowedSurfaces: ACTIVE_SURFACES,
  effects: {
    pure: false,
    previewSafe: false,
    reads: ['execution-context'],
    writes: ['skills'],
  },
  ui: { category: 'skill', authoring: 'standard' },
  lower: writeLowering,
}

export const AUTHOR_SKILL_INSTANCE_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  currentSkill,
  skillInstanceField,
  skillInstanceWrite,
])
