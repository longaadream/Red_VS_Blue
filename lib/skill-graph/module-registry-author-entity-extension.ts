import { authorValueSchemas } from '../game/author-extension'
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
 * Direct extension access for one concrete runtime entity. The entity input is
 * an opaque host reference (skill/status/rule/card/Cluster/tile-effect); the
 * author graph never receives a mutable object or an arbitrary host path.
 */

const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const ENTITY_KINDS = ['skill', 'status', 'rule', 'card', 'cluster', 'tile-effect'] as const
const recordType: GameplayValueType = 'record'
const stringType: GameplayValueType = 'string'
// Runtime entity handles are opaque records to the graph type checker. The
// host validates the concrete kind and instance identity at execution time.
const entityType: GameplayValueType = 'record'
const kindType: GameplayValueType = 'string'

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const parameter = (name: string, type: GameplayValueType, options: Omit<GameplayParameter, 'name' | 'type'> = {}): GameplayParameter => ({ name, type, ...options })
const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}
const typeParameter = (ctx: GameplayNativeLoweringContext): GameplayValueType => {
  const raw = String(ctx.parameters.valueType ?? 'number')
  return raw.trimStart().startsWith('{') ? JSON.parse(raw) as GameplayValueType : raw as GameplayValueType
}
const commonParameters = [
  parameter('entityKind', kindType, { enum: [...ENTITY_KINDS] }),
  parameter('namespace', stringType, { default: 'content', optional: true }),
  parameter('name', stringType),
  parameter('valueType', stringType, { default: 'number' }),
]
const readParameters = [...commonParameters.slice(0, 3), parameter('path', stringType, { default: '', optional: true }), commonParameters[3]]
const pureRead: GameplayEffectMetadata = { pure: true, previewSafe: false, reads: ['entity-extensions'] }
const entityInput = port('entity', entityType, { label: '实体实例' })

function declarationSchemas(ctx: GameplayNativeLoweringContext, type: GameplayValueType): string {
  return JSON.stringify(authorValueSchemas(type, ctx.recordSchemas ?? []))
}

const declare: GameplayModuleDescriptor = {
  id: 'extension.declare-instance', version: '1', label: '声明实体实例扩展变量',
  description: '在具体技能、状态、规则、手牌、能力组或地格效果实例上声明扩展变量；旧实例首次声明时保留原值。',
  inputs: [entityInput, port('value', recordType, { label: '初始值' })],
  outputs: [port('value', recordType, { label: '值' })],
  outputValueTypeBindings: { value: { parameter: 'valueType' } },
  inputValueTypeBindings: { value: { parameter: 'valueType' } },
  parameters: commonParameters,
  allowedSurfaces: ACTIVE,
  effects: { pure: false, previewSafe: false, reads: ['entity-extensions'], writes: ['entity-extensions'] },
  ui: { category: 'data', authoring: 'standard' },
  lower: ctx => `({value:${flow(ctx)}.entityExtension.declare(${ctx.emitLiteral(ctx.parameters.entityKind)},${input(ctx, 'entity')},${ctx.emitLiteral(ctx.parameters.namespace ?? 'content')},${ctx.emitLiteral(ctx.parameters.name)},${JSON.stringify(typeParameter(ctx))},${declarationSchemas(ctx, typeParameter(ctx))},${input(ctx, 'value')})})`,
}

const read: GameplayModuleDescriptor = {
  id: 'extension.read-instance', version: '1', label: '读取实体实例扩展变量',
  description: '读取具体实体实例上已声明的扩展字段；实例失效、字段缺失或声明类型变化会使语句失效。',
  inputs: [entityInput],
  outputs: [port('value', recordType, { label: '值' })],
  outputValueTypeBindings: { value: { parameter: 'valueType' } },
  parameters: readParameters,
  allowedSurfaces: ACTIVE,
  effects: pureRead,
  ui: { category: 'data', authoring: 'standard' },
  lower: ctx => `({value:${flow(ctx)}.entityExtension.read(${ctx.emitLiteral(ctx.parameters.entityKind)},${input(ctx, 'entity')},${ctx.emitLiteral(ctx.parameters.namespace ?? 'content')},${ctx.emitLiteral(ctx.parameters.name)},${ctx.emitLiteral(ctx.parameters.path ?? '')},${JSON.stringify(typeParameter(ctx))},${declarationSchemas(ctx, typeParameter(ctx))})})`,
}

const write: GameplayModuleDescriptor = {
  id: 'extension.write-instance', version: '1', label: '写入实体实例扩展变量',
  description: '原子写入具体实体实例上已声明的扩展字段，保留实体对象身份和其他扩展字段。',
  inputs: [entityInput, port('value', recordType, { label: '值' })],
  outputs: [port('value', recordType, { label: '值' })],
  outputValueTypeBindings: { value: { parameter: 'valueType' } },
  inputValueTypeBindings: { value: { parameter: 'valueType' } },
  parameters: readParameters,
  allowedSurfaces: ACTIVE,
  effects: { pure: false, previewSafe: false, reads: ['entity-extensions'], writes: ['entity-extensions'] },
  ui: { category: 'data', authoring: 'standard' },
  lower: ctx => `({value:${flow(ctx)}.entityExtension.write(${ctx.emitLiteral(ctx.parameters.entityKind)},${input(ctx, 'entity')},${ctx.emitLiteral(ctx.parameters.namespace ?? 'content')},${ctx.emitLiteral(ctx.parameters.name)},${ctx.emitLiteral(ctx.parameters.path ?? '')},${JSON.stringify(typeParameter(ctx))},${declarationSchemas(ctx, typeParameter(ctx))},${input(ctx, 'value')})})`,
}

export const AUTHOR_ENTITY_EXTENSION_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([declare, read, write])
