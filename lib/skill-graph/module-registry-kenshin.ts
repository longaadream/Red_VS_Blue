import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayPort,
  GameplayValueType,
} from './module-types'

/**
 * Position facts used by Kenshin's three active skills.
 *
 * The graphs own target validation, ordering, messages, and effects.  These
 * descriptors only provide reusable cardinal-cell generation and a bounded
 * random selection operation; they never select a legal landing cell or
 * mutate a piece themselves.
 */

const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const pieceType: GameplayValueType = 'piece'
const cellType: GameplayValueType = 'cell'
const cellListType: GameplayValueType = { kind: 'list', element: cellType }

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}
const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const pure = (reads: readonly string[] = []): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const define = (value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'> & { allowedSurfaces?: readonly GameplayModuleSurface[] }): GameplayModuleDescriptor => ({
  version: '1',
  allowedSurfaces: value.allowedSurfaces ?? ACTIVE,
  ...value,
})

export const KENSHIN_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  define({
    id: 'spatial.cardinal-cells',
    label: '生成正交相邻地格',
    description: '按上、右、下、左的冻结顺序生成目标棋子的四个正交相邻地格；合法性由作者图逐格判断。',
    inputs: [port('target', pieceType)],
    outputs: [port('cells', cellListType)],
    effects: pure(['position']),
    lower: ctx => {
      const target = input(ctx, 'target')
      return `(function(targetId){var target=${flow(ctx)}.query.piece(targetId);if(!target||!Number.isFinite(target.x)||!Number.isFinite(target.y))return [];var offsets=[[0,-1],[1,0],[0,1],[-1,0]];return offsets.map(function(offset){return {x:target.x+offset[0],y:target.y+offset[1]};});})(${target})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'spatial.shuffle-cardinal-cells',
    label: '随机打乱正交相邻地格',
    description: '对目标的四个正交相邻地格执行完整 Fisher–Yates 洗牌；固定消耗三次权威随机源，合法落点筛选由作者图完成。',
    inputs: [port('target', pieceType)],
    outputs: [port('cells', cellListType)],
    effects: { pure: true, previewSafe: false, reads: ['position', 'random'], random: true },
    lower: ctx => {
      const target = input(ctx, 'target')
      const random = flow(ctx)
      return `(function(targetId){var target=${random}.query.piece(targetId);if(!target||!Number.isFinite(target.x)||!Number.isFinite(target.y))return [];var offsets=[[0,-1],[1,0],[0,1],[-1,0]],order=[0,1,2,3],indices=[0,1,2,3];for(var d=3;d>0;d-=1){var pick=${random}.query.random(indices.slice(0,d+1));var j=Number(pick);var temp=order[d];order[d]=order[j];order[j]=temp;}return order.map(function(index){var offset=offsets[index];return {x:target.x+offset[0],y:target.y+offset[1]};});})(${target})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'query.random-cell',
    label: '确定性随机地格',
    description: '通过权威随机源从作者已筛选的地格集合中选择一格；空集合不消耗随机数并返回空引用。',
    inputs: [port('items', cellListType)],
    outputs: [port('cell', cellType, { nullable: true })],
    effects: { ...pure(['random']), random: true },
    lower: ctx => `${flow(ctx)}.query.random(${input(ctx, 'items')})`,
    ui: { category: 'query' },
  }),
])
