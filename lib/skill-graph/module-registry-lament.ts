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
 * Generic hand and target adapters used by Muru's Lament.
 *
 * The graph supplies the bounded card definitions and target relation.  These
 * descriptors only expose stable hand identifiers and the existing target
 * policy; they do not contain a skill-specific execution branch.
 */

const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const CHOICE_SURFACES: readonly GameplayModuleSurface[] = ['skill', 'card', 'pending']
const PURE: readonly GameplayModuleSurface[] = [...ACTIVE, 'preview']
const playerType: GameplayValueType = 'player'
const pieceType: GameplayValueType = 'piece'
const choiceType: GameplayValueType = 'choice'
const numberType: GameplayValueType = 'number'
const booleanType: GameplayValueType = 'boolean'
const stringType: GameplayValueType = 'string'
const stringListType: GameplayValueType = { kind: 'list', element: stringType }
const pieceListType: GameplayValueType = { kind: 'list', element: pieceType }

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const parameter = (name: string, type: GameplayValueType, options: Omit<GameplayParameter, 'name' | 'type'> = {}): GameplayParameter => ({ name, type, ...options })
const define = (value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'> & { allowedSurfaces?: readonly GameplayModuleSurface[] }): GameplayModuleDescriptor => ({
  version: '1', allowedSurfaces: value.allowedSurfaces ?? ACTIVE, ...value,
})
const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}
const literal = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.parameters[name]
  if (value === undefined) throw new Error(`module ${ctx.moduleId}: missing parameter ${name}`)
  return ctx.emitLiteral(value as never)
}
const pure = (reads: readonly string[] = []): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const writes = (domains: readonly string[], events: readonly string[] = []): GameplayEffectMetadata => ({ pure: false, previewSafe: false, writes: domains, events })

export const LAMENT_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  define({
    id: 'card.hand-instances-by-definition-ids',
    label: '按定义集合查询手牌实例',
    description: '按当前手牌顺序返回属于登记定义集合的稳定实例标识；卡牌定义集合由作者图显式提供。',
    inputs: [port('player', playerType)],
    outputs: [port('cards', stringListType)],
    parameters: [parameter('cardIds', stringListType)],
    effects: pure(['hand', 'players']),
    allowedSurfaces: ACTIVE,
    lower: ctx => `(function(playerId,cardIds){var hand=${flow(ctx)}.cards.hand(playerId);return(Array.isArray(hand)?hand:[]).filter(function(card){return card&&Array.isArray(cardIds)&&cardIds.indexOf(card.cardId)!==-1;}).map(function(card){return card.instanceId;});})(${input(ctx, 'player')},${literal(ctx, 'cardIds')})`,
    ui: { category: 'card' },
  }),
  define({
    id: 'choice.hand-cards-bounded',
    label: '按动态上限选择手牌',
    description: '将稳定手牌实例和标签交给现有多选协议，最大选择数由图计算并由宿主恢复。',
    inputs: [port('player', playerType), port('cards', stringListType), port('labels', stringListType), port('maxSelections', numberType)],
    outputs: [port('choice', choiceType, { nullable: true, optional: true })],
    parameters: [
      parameter('title', stringType),
      parameter('selectionMode', stringType, { enum: ['single', 'multi'] }),
      parameter('minSelections', numberType, { minimum: 1 }),
      parameter('canCancel', booleanType, { default: false }),
    ],
    effects: writes(['pending'], ['pendingOptionSelection']),
    allowedSurfaces: CHOICE_SURFACES,
    lower: ctx => `${flow(ctx)}.choice.option({title:${literal(ctx, 'title')},options:(${input(ctx, 'cards')}).map(function(value,index){return{label:${input(ctx, 'labels')}[index]===undefined?value:${input(ctx, 'labels')}[index],value:value};}),selectionMode:${literal(ctx, 'selectionMode')},presentation:"hand",minSelections:${literal(ctx, 'minSelections')},maxSelections:${input(ctx, 'maxSelections')},canCancel:${literal(ctx, 'canCancel')}})`,
    ui: { category: 'choice' },
  }),
  define({
    id: 'choice.array-length',
    label: '读取选项数组长度',
    description: '读取原始多选数组长度，不解包对象或将其他值转换为集合。',
    inputs: [port('choice', choiceType, { nullable: true, optional: true })],
    outputs: [port('count', numberType)],
    effects: { pure: true, previewSafe: true, reads: ['choice'] },
    allowedSurfaces: PURE,
    lower: ctx => `Array.isArray(${input(ctx, 'choice')})?${input(ctx, 'choice')}.length:0`,
    ui: { category: 'choice' },
  }),
  define({
    id: 'choice.array-has-duplicate',
    label: '检查原始数组重复项',
    description: '按原始 JavaScript 数组值检查重复项，保留宿主对非文本选项的重复校验语义。',
    inputs: [port('choice', choiceType, { nullable: true, optional: true })],
    outputs: [port('duplicate', booleanType)],
    effects: { pure: true, previewSafe: true, reads: ['choice'] },
    allowedSurfaces: PURE,
    lower: ctx => `(function(value){return Array.isArray(value)&&new Set(value).size!==value.length;})(${input(ctx, 'choice')})`,
    ui: { category: 'choice' },
  }),
  define({
    id: 'query.affectable-pieces-from-source',
    label: '按来源查询可影响棋子',
    description: '按玩家关系、存活条件和来源感知的冒险边界读取可影响目标，保留宿主顺序。',
    inputs: [port('owner', playerType), port('source', pieceType)],
    outputs: [port('pieces', pieceListType)],
    parameters: [parameter('relation', stringType, { enum: ['ally', 'enemy'] })],
    effects: pure(['pieces', 'target-policy', 'players']),
    lower: ctx => {
      const relation = literal(ctx, 'relation')
      const runtime = flow(ctx)
      const battle = ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
      return `(function(ownerId,sourceId){if(ownerId==null||sourceId==null||!${runtime}.query.hasPiece(sourceId))return[];var source=${runtime}.query.piece(sourceId);return ${runtime}.query.pieces({ownerId:ownerId,relation:${relation},includeDead:false}).filter(function(id){var piece=${runtime}.query.piece(id);return piece&&canAffectAdventureTarget(${battle},ownerId,piece,source);});})(${input(ctx, 'owner')},${input(ctx, 'source')})`
    },
    ui: { category: 'query' },
  }),
])
