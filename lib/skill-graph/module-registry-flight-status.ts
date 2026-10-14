import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayPort,
  GameplayValueType,
} from './module-types'

/**
 * Narrow host boundaries used by the flight/status atomic migrations.
 *
 * The migration recipe owns record construction and all selection policy.  The
 * three descriptors below only retain the host operations that cannot be
 * expressed as a data-only graph: submitting a tile batch, replacing the
 * authoritative tile-effect array, and removing a status through lifecycle.
 * They intentionally do not know anything about flight ids or temporary
 * status types.
 */

const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const recordListType: GameplayValueType = { kind: 'list', element: 'record' }
const statusType: GameplayValueType = 'status'
const booleanType: GameplayValueType = 'boolean'

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}

const tileWrites = (events: readonly string[]): GameplayEffectMetadata => ({
  pure: false,
  previewSafe: false,
  writes: ['tile-effects'],
  events,
})

export const FLIGHT_STATUS_HOST_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  {
    id: 'tile.batch-records',
    version: '1',
    label: '提交地格效果记录批次',
    description: '把图中已经构造并校验的地格效果记录交给权威批次提交器。',
    inputs: [port('records', recordListType)],
    outputs: [port('success', booleanType)],
    allowedSurfaces: ACTIVE,
    effects: tileWrites(['tileEffectAdded']),
    lower: ctx => `Boolean(${flow(ctx)}.effects.tileBatchRecords(${input(ctx, 'records')}))`,
    ui: { category: 'position', authoring: 'standard' },
  },
  {
    id: 'tile.batch-records', version: '2', label: '提交地格效果记录批次',
    description: '提交已构造的地格效果记录，并保留指定的统一表现批次。',
    inputs: [port('records', recordListType)], outputs: [port('success', booleanType)],
    parameters: [{ name: 'presentationBatch', type: 'string', enum: ['direct', 'queue'], default: 'direct' }],
    allowedSurfaces: ACTIVE, effects: tileWrites(['tileEffectAdded']),
    lower: ctx => `Boolean(${flow(ctx)}.effects.tileBatchRecords(${input(ctx, 'records')},${ctx.emitLiteral(ctx.parameters.presentationBatch ?? 'direct')}))`,
    ui: { category: 'position', authoring: 'standard' },
  },
  {
    id: 'tile.replace-effects',
    version: '1',
    label: '替换地格效果记录',
    description: '以整数组提交已经由图筛选出的地格效果；宿主负责校验、复制和移除表现事件。',
    inputs: [port('effects', recordListType)],
    outputs: [port('success', booleanType)],
    allowedSurfaces: ACTIVE,
    effects: tileWrites(['tileEffectRemoved']),
    lower: ctx => `Boolean(${flow(ctx)}.effects.replaceTileEffects(${input(ctx, 'effects')}))`,
    ui: { category: 'position', authoring: 'standard' },
  },
  {
    id: 'status.remove-instance-lifecycle',
    version: '1',
    label: '按状态实例生命周期移除',
    description: '按当前执行中保留的不透明状态句柄调用宿主生命周期移除；不按标识重新匹配。',
    inputs: [port('status', statusType)],
    outputs: [port('removed', booleanType)],
    allowedSurfaces: ACTIVE,
    effects: { pure: false, previewSafe: false, writes: ['statuses', 'rules', 'events'], events: ['afterStatusRemoved'] },
    lower: ctx => `${flow(ctx)}.status.removeInstanceLifecycle(${input(ctx, 'status')})`,
    ui: { category: 'status', authoring: 'standard' },
  },
])

export const GENERIC_FLIGHT_STATUS_HOST_GAMEPLAY_MODULES = FLIGHT_STATUS_HOST_GAMEPLAY_MODULES
