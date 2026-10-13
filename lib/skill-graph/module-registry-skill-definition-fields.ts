import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayParameter,
  GameplayPort,
  GameplayValueType,
} from './module-types'

const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const booleanType: GameplayValueType = 'boolean'
const stringType: GameplayValueType = 'string'
const nullableStringType: GameplayValueType = { kind: 'nullable', value: stringType }
const PURE: GameplayEffectMetadata = { pure: true, previewSafe: false, reads: ['skills'] }

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

function battle(ctx: GameplayNativeLoweringContext): string {
  return ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
}

/**
 * Read a closed scalar from a definition selected by its opaque skill id.
 * The host map and both selected properties are inspected through data
 * descriptors so author graphs cannot invoke accessors or expose a mutable
 * definition object.  The only currently published field is the boolean
 * momentum marker; more fields can be added additively with their own types.
 */
export const SKILL_DEFINITION_FIELD_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([{
  id: 'skill.definition-field', version: '1', label: '读取技能定义字段',
  description: '按技能标识读取登记的封闭技能定义字段；缺失和空值返回可空值。',
  inputs: [port('skillId', nullableStringType)],
  outputs: [port('value', booleanType, { nullable: true })],
  parameters: [parameter('field', stringType, { enum: ['momentumGainOnUse'] })],
  allowedSurfaces: ACTIVE,
  effects: PURE,
  lower: ctx => {
    if (ctx.parameters.field !== 'momentumGainOnUse') throw new Error(`module ${ctx.moduleId}: unsupported field`)
    const state = battle(ctx)
    const skillId = input(ctx, 'skillId')
    const key = ctx.emitLiteral('momentumGainOnUse')
    return `(function(battle,skillId,key){if(battle===__gameplayInvalid)return __gameplayInvalid;var definitions=battle&&battle.skillsById;if(skillId==null||definitions==null)return {value:null};if(typeof skillId!=="string"||typeof definitions!=="object"||Array.isArray(definitions))return __gameplayInvalid;var definitionDescriptor=Object.getOwnPropertyDescriptor(definitions,skillId);if(!definitionDescriptor)return {value:null};if(!Object.prototype.hasOwnProperty.call(definitionDescriptor,"value"))return __gameplayInvalid;var definition=definitionDescriptor.value;if(definition===undefined)return {value:null};if(definition===null||typeof definition!=="object"||Array.isArray(definition))return {value:null};var fieldDescriptor=Object.getOwnPropertyDescriptor(definition,key);if(!fieldDescriptor)return {value:null};if(!Object.prototype.hasOwnProperty.call(fieldDescriptor,"value"))return __gameplayInvalid;var value=fieldDescriptor.value;if(value===undefined||value===null)return {value:null};if(typeof value!=="boolean")return __gameplayInvalid;return {value:value};})(${state},${skillId},${key})`
  },
  ui: { category: 'field', authoring: 'standard' },
}])

export const GENERIC_SKILL_DEFINITION_FIELD_GAMEPLAY_MODULES = SKILL_DEFINITION_FIELD_GAMEPLAY_MODULES
