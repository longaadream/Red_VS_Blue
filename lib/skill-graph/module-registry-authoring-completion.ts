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
 * Small authoring facts needed by the last ordinary legacy entries.
 *
 * These adapters deliberately expose only closed facts.  The authoring graph
 * still owns all branching, messages, status records, and effect ordering;
 * the adapters only bridge data already owned by the battle host.
 */
const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const stringType: GameplayValueType = 'string'
const booleanType: GameplayValueType = 'boolean'
const numberType: GameplayValueType = 'number'
const pieceType: GameplayValueType = 'piece'
const pieceListType: GameplayValueType = { kind: 'list', element: pieceType }

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const parameter = (name: string, type: GameplayValueType, options: Omit<GameplayParameter, 'name' | 'type'> = {}): GameplayParameter => ({ name, type, ...options })
const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const battle = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}
const read = (domains: readonly string[]): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads: domains })
const define = (value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'>): GameplayModuleDescriptor => ({
  version: '1',
  allowedSurfaces: ACTIVE,
  ...value,
})

export const AUTHORING_COMPLETION_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  define({
    id: 'query.living-template-faction',
    label: '按阵营查询存活模板棋子',
    description: '按模板、目标棋子阵营和存活条件返回首个棋子 ID，保持战场顺序。',
    inputs: [port('target', pieceType, { nullable: true })],
    outputs: [port('piece', pieceType, { nullable: true })],
    parameters: [parameter('templateId', stringType)],
    effects: read(['pieces']),
    lower: ctx => {
      const target = input(ctx, 'target')
      const state = battle(ctx)
      const query = flow(ctx)
      const templateId = ctx.emitLiteral(ctx.parameters.templateId)
      return `(function(targetId,templateId){if(targetId==null||!${query}.query.hasPiece(targetId))return null;var target=${query}.query.piece(targetId),pieces=${state}.pieces||[];for(var index=0;index<pieces.length;index+=1){var piece=pieces[index];if(piece&&piece.templateId===templateId&&Number(piece.currentHp||0)>0&&piece.faction===target.faction)return piece.instanceId;}return null;})(${target},${templateId})`
    },
    ui: { category: 'query' },
  }),
  define({
    id: 'query.enemies-on-cardinal-segment',
    label: '查询正交线段敌人',
    description: '按来源棋子到目标棋子的正交线段读取存活敌人，并按来源距离稳定排序。',
    inputs: [port('source', pieceType), port('target', pieceType)],
    outputs: [
      port('pieces', pieceListType),
      port('valid', booleanType),
      port('sameCell', booleanType),
      port('distance', numberType),
    ],
    effects: read(['pieces', 'players', 'position']),
    lower: ctx => {
      const source = input(ctx, 'source')
      const target = input(ctx, 'target')
      const query = flow(ctx)
      return `(function(sourceId,targetId){if(sourceId==null||targetId==null||!${query}.query.hasPiece(sourceId)||!${query}.query.hasPiece(targetId))return {pieces:[],valid:false,sameCell:false,distance:0};var source=${query}.query.piece(sourceId),target=${query}.query.piece(targetId),dx=target.x-source.x,dy=target.y-source.y,sameCell=dx===0&&dy===0,valid=(dx===0)!==(dy===0),distance=Math.max(Math.abs(dx),Math.abs(dy));if(!valid)return {pieces:[],valid:false,sameCell:sameCell,distance:distance};var directionX=dx===0?0:(dx>0?1:-1),directionY=dy===0?0:(dy>0?1:-1),ids=${query}.query.pieces({originId:sourceId,relation:"enemy",includeDead:false})||[];ids=ids.filter(function(id){var piece=${query}.query.piece(id);return piece&&((directionX!==0&&piece.y===source.y&&(piece.x-source.x)*directionX>0&&Math.abs(piece.x-source.x)<=Math.abs(dx))||(directionX===0&&piece.x===source.x&&(piece.y-source.y)*directionY>0&&Math.abs(piece.y-source.y)<=Math.abs(dy)));});ids.sort(function(left,right){var a=${query}.query.piece(left),b=${query}.query.piece(right);return (Math.abs(a.x-source.x)+Math.abs(a.y-source.y))-(Math.abs(b.x-source.x)+Math.abs(b.y-source.y));});return {pieces:ids,valid:valid,sameCell:sameCell,distance:distance};})(${source},${target})`
    },
    ui: { category: 'query' },
  }),
])

export const authoringCompletionGameplayModuleDescriptors = AUTHORING_COMPLETION_GAMEPLAY_MODULES
