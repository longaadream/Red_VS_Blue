import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayPort,
  GameplayValueType,
} from './module-types'

/**
 * Closed facts used by the Kyoka target-rewrite rule.  The rule graph owns
 * the guards, candidate ordering, pending choice, and status cleanup; these
 * descriptors only expose the two event/status facts that are not otherwise
 * available through the author-facing module catalogue.
 */
const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const pieceType: GameplayValueType = 'piece'
const booleanType: GameplayValueType = 'boolean'
const stringType: GameplayValueType = 'string'
const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const context = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx' : 'context'
const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}
const pure = (reads: readonly string[] = []): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const define = (value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'>): GameplayModuleDescriptor => ({
  version: '1',
  allowedSurfaces: ACTIVE,
  ...value,
})

export const KYOKA_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  define({
    id: 'event.single-piece-target-action',
    label: '单棋子目标动作',
    description: '读取宿主对当前技能动作的单棋子目标判定；不通过对象路径推断目标类型。',
    inputs: [],
    outputs: [port('value', booleanType)],
    effects: pure(['event']),
    lower: ctx => `Boolean(${context(ctx)}.isSinglePieceTargetAction === true)`,
    ui: { category: 'event' },
  }),
  define({
    id: 'status.read-piece-reference',
    label: '读取状态关联棋子',
    description: '从登记状态的封闭目标棋子字段读取仍在棋盘集合中的引用；生命值由使用方判断。',
    inputs: [port('piece', pieceType), port('statusId', stringType, { nullable: true })],
    outputs: [port('reference', pieceType, { nullable: true })],
    parameters: [{ name: 'field', type: stringType, enum: ['targetPieceId'] }],
    effects: pure(['statuses', 'pieces']),
    lower: ctx => {
      const flowName = flow(ctx)
      const piece = input(ctx, 'piece')
      const statusId = input(ctx, 'statusId')
      const field = ctx.emitLiteral(ctx.parameters.field)
      return `(function(pieceId,statusId){if(statusId==null)return null;var piece=${flowName}.query.piece(pieceId),tags=(piece&&piece.statusTags)||[],tag=tags.find(function(item){return item&&item.id===statusId;}),reference=tag&&tag[${field}];return ${flowName}.query.hasPiece(reference)?${flowName}.query.piece(reference).instanceId:null;})(${piece},${statusId})`
    },
    ui: { category: 'status' },
  }),
])
