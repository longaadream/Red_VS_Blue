import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayValueType,
} from './module-types'

const SURFACES: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const pieceType: GameplayValueType = 'piece'
const stringType: GameplayValueType = 'string'
const numberType: GameplayValueType = 'number'

const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}
const writes = (domains: readonly string[]): GameplayEffectMetadata => ({ pure: false, previewSafe: false, writes: domains })
const pure = (reads: readonly string[]): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const define = (value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'> & { allowedSurfaces?: readonly GameplayModuleSurface[] }): GameplayModuleDescriptor => ({
  version: '1',
  allowedSurfaces: value.allowedSurfaces ?? SURFACES,
  ...value,
})

/**
 * Closed compatibility operations for use counters.  The old rules use a
 * `remainingUses` field when it exists and otherwise initialize it from
 * `currentUses || fallback`; these operations preserve that narrow behavior
 * without exposing a mutable status object to an author graph.
 */
export const FOLLOWUP_STATUS_RULES_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  define({
    id: 'piece.owner-id',
    label: '读取棋子所属玩家标识',
    description: '读取经验证棋子引用的所属玩家标识，用于与事件玩家文本进行精确比较。',
    inputs: [{ name: 'piece', type: pieceType }],
    outputs: [{ name: 'playerId', type: stringType }],
    effects: pure(['pieces']),
    lower: ctx => `String(${flow(ctx)}.query.piece(${input(ctx, 'piece')}).ownerPlayerId)`,
    ui: { category: 'query' },
  }),
  define({
    id: 'status.read-uses-fallback',
    label: '读取剩余次数并回退当前次数',
    description: '读取状态的 remainingUses；字段缺失时按旧兼容规则使用 currentUses 或限定回退值。',
    inputs: [
      { name: 'piece', type: pieceType },
      { name: 'statusId', type: stringType, nullable: true },
      { name: 'fallback', type: numberType },
    ],
    outputs: [{ name: 'value', type: numberType }],
    effects: pure(['statuses']),
    lower: ctx => `(function(pieceId,statusId,fallback){var piece=${flow(ctx)}.query.piece(pieceId),tag=((piece&&piece.statusTags)||[]).find(function(item){return item&&item.id===statusId;});if(!tag)return fallback;return tag.remainingUses===undefined?(tag.currentUses||fallback):Number(tag.remainingUses);})(${input(ctx, 'piece')},${input(ctx, 'statusId')},${input(ctx, 'fallback')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.set-remaining-uses',
    label: '设定状态剩余次数',
    description: '更新登记状态的 remainingUses 字段，保持旧规则的直接计数更新语义。',
    inputs: [
      { name: 'piece', type: pieceType },
      { name: 'statusId', type: stringType, nullable: true },
      { name: 'value', type: numberType },
    ],
    outputs: [{ name: 'success', type: 'boolean' }],
    effects: writes(['statuses']),
    lower: ctx => `(function(pieceId,statusId,value){if(!Number.isFinite(value))throw new Error('status.set-remaining-uses requires a finite value');var piece=${flow(ctx)}.query.piece(pieceId),tag=((piece&&piece.statusTags)||[]).find(function(item){return item&&item.id===statusId;});if(!tag)return false;tag.remainingUses=value;return true;})(${input(ctx, 'piece')},${input(ctx, 'statusId')},${input(ctx, 'value')})`,
    ui: { category: 'status' },
  }),
])
