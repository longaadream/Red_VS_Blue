import type {
  GameplayEffectMetadata,
  GameplayJsonValue,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayParameter,
  GameplayPort,
  GameplayRecordSchema,
  GameplayValueType,
} from './module-types'

/**
 * Generic structured action logging for authored follow-up rules.
 *
 * The public shape keeps the action type and typed payload as separate author
 * inputs.  The host receives a trusted graph schema alongside the payload so
 * runtime validation can reject missing or unknown fields before appending a
 * log entry.  The descriptor intentionally does not accept an arbitrary
 * action record: that would make it possible to smuggle authority fields into
 * the action stream.
 */

const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const stringType: GameplayValueType = 'string'
const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const playerType: GameplayValueType = 'player'
const recordType: GameplayValueType = 'record'

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const parameter = (name: string, type: GameplayValueType, options: Omit<GameplayParameter, 'name' | 'type'> = {}): GameplayParameter => ({ name, type, ...options })
const writes = (domains: readonly string[]): GameplayEffectMetadata => ({ pure: false, previewSafe: false, writes: domains })
const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}

function schemaFor(ctx: GameplayNativeLoweringContext): GameplayRecordSchema {
  const reference = ctx.parameters.payloadSchema
  if (typeof reference !== 'string' || reference.length === 0) throw new Error(`module ${ctx.moduleId}: payloadSchema is required`)
  const schema = (ctx.recordSchemas ?? []).find(candidate => (
    `${candidate.id}@${candidate.version}` === reference || candidate.id === reference
  ))
  if (!schema) throw new Error(`module ${ctx.moduleId}: unknown payload schema ${reference}`)
  return schema
}

function schemaLiteral(schema: GameplayRecordSchema): GameplayJsonValue {
  // Record schemas are host-owned metadata.  Clone through JSON before
  // embedding to keep the lowering boundary limited to author JSON values.
  return JSON.parse(JSON.stringify(schema)) as GameplayJsonValue
}

export const STRUCTURED_ACTION_LOG_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([{
  id: 'followup.action.append',
  // Keep the historical v1 action-record adapter available.  Typed
  // structured logging is an additive v2 authoring boundary so existing
  // v1 graphs and their generated-code proofs remain valid.
  version: '2',
  label: '追加结构化日志',
  description: '在一句作者语句中填写日志类型与已声明记录载荷；宿主严格校验字段和类型，只能追加，不会覆盖权威伤害动作。',
  inputs: [
    port('type', stringType, { label: '日志类型' }),
    port('playerId', playerType, { label: '归属玩家' }),
    port('turn', numberType, { label: '回合' }),
    port('payload', recordType, { label: '类型化载荷' }),
  ],
  inputSchemaBindings: { payload: { parameter: 'payloadSchema' } },
  parameters: [parameter('payloadSchema', stringType, { label: '载荷记录类型' })],
  outputs: [port('success', booleanType)],
  allowedSurfaces: ACTIVE,
  effects: writes(['actions']),
  lower: ctx => `${flow(ctx)}.log.appendStructured({type:${input(ctx, 'type')},playerId:${input(ctx, 'playerId')},turn:${input(ctx, 'turn')},payload:${input(ctx, 'payload')}},${ctx.emitLiteral(schemaLiteral(schemaFor(ctx)))})`,
  ui: { category: 'log', authoring: 'standard' },
}])

export const FOLLOWUP_STRUCTURED_LOG_GAMEPLAY_MODULES = STRUCTURED_ACTION_LOG_GAMEPLAY_MODULES
