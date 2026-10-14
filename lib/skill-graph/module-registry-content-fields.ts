import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayParameter,
  GameplayPort,
  GameplayValueType,
} from './module-types'

const ACTIVE: readonly GameplayModuleSurface[] = ['rule', 'card']
const recordType: GameplayValueType = 'record'
const stringType: GameplayValueType = 'string'
const booleanType: GameplayValueType = 'boolean'

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

const effects: GameplayEffectMetadata = { pure: true, previewSafe: false, reads: ['content'] }

function battle(ctx: GameplayNativeLoweringContext): string {
  return ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
}

/**
 * Closed content containers used by structural migrations.  This exposes the
 * custom-card definition map as one immutable graph record; callers still
 * select a card and a definition field through data.read-key, so no arbitrary
 * host path is admitted here.
 */
export const CONTENT_FIELD_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([{
  id: 'content.field', version: '1', label: '读取内容字段',
  description: '读取受信动态内容容器中的封闭记录；当前仅开放动态卡牌定义表。',
  inputs: [],
  outputs: [port('value', recordType, { nullable: true }), port('defined', booleanType)],
  parameters: [parameter('field', stringType, { enum: ['customCards'] })],
  allowedSurfaces: ACTIVE,
  effects,
  lower: ctx => {
    if (ctx.parameters.field !== 'customCards') throw new Error(`module ${ctx.moduleId}: unsupported field`)
    const state = battle(ctx)
    return `(function(battle){if(battle===__gameplayInvalid)return __gameplayInvalid;var value=battle&&battle.customCards;if(value===undefined)return {value:null,defined:false};if(value===null)return {value:null,defined:true};if(typeof value!=="object"||Array.isArray(value))return __gameplayInvalid;return {value:value,defined:true};})(${state})`
  },
  ui: { category: 'content', authoring: 'standard' },
}])

export const GENERIC_CONTENT_FIELD_GAMEPLAY_MODULES = CONTENT_FIELD_GAMEPLAY_MODULES
