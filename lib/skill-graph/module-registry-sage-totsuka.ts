import type {
  GameplayEffectMetadata,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayPort,
} from './module-types'

const ACTIVE_SURFACES: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const pieceType = 'piece' as const
const playerType = 'player' as const
const numberType = 'number' as const
const booleanType = 'boolean' as const
const stringType = 'string' as const
const cellType = 'cell' as const

const port = (name: string, type: GameplayPort['type'], options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const read = (domains: readonly string[]): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads: domains })
const write = (domains: readonly string[], events: readonly string[] = []): GameplayEffectMetadata => ({ pure: false, previewSafe: false, writes: domains, events })
const define = (value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'>): GameplayModuleDescriptor => ({ version: '1', allowedSurfaces: ACTIVE_SURFACES, ...value })
const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const battle = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}

const DESCRIPTORS: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'spatial.cell-unoccupied-except',
    label: '检查忽略指定棋子的空地格',
    description: '读取存活棋子占位并忽略一个已验证棋子实例；只返回占位事实，不修改棋盘。',
    inputs: [port('cell', cellType), port('ignore', pieceType, { nullable: true, optional: true })],
    outputs: [port('unoccupied', booleanType)],
    effects: read(['position', 'pieces']),
    lower: ctx => {
      const cell = input(ctx, 'cell')
      const ignored = ctx.inputs.ignore ?? 'null'
      const state = battle(ctx)
      return `(function(cell, ignoredId) { if (!cell) return false; return !((${state}.pieces || []).some(function(piece) { return piece && Number(piece.currentHp || 0) > 0 && piece.x === cell.x && piece.y === cell.y && String(piece.instanceId) !== String(ignoredId); })); })(${cell}, ${ignored})`
    },
    ui: { category: 'position' },
  }),
  define({
    id: 'skill.reset-cooldowns',
    label: '重置技能冷却',
    description: '将棋子技能列表中除指定技能外的冷却归零；只写入技能运行时冷却字段。',
    inputs: [port('piece', pieceType)],
    outputs: [port('success', booleanType), port('present', booleanType)],
    parameters: [{ name: 'excludeSkillId', type: stringType, optional: true }],
    effects: write(['skills']),
    lower: ctx => {
      const piece = input(ctx, 'piece')
      const excluded = Object.prototype.hasOwnProperty.call(ctx.parameters, 'excludeSkillId')
        ? ctx.emitLiteral(ctx.parameters.excludeSkillId)
        : 'null'
      const runtime = flow(ctx)
      return `(function(pieceId, excludedId) { var piece = ${runtime}.query.piece(pieceId); var skills = piece && piece.skills; if (!Array.isArray(skills)) return { success: false, present: false }; skills.forEach(function(skillState) { if ((excludedId == null || skillState.skillId !== excludedId) && skillState.currentCooldown > 0) skillState.currentCooldown = 0; }); return { success: true, present: true }; })(${piece}, ${excluded})`
    },
    ui: { category: 'skill' },
  }),
  define({
    id: 'skill.adjust-active-cooldowns-at-least',
    label: '设置主动技能最低冷却',
    description: '把棋子技能列表中定义缺失或 kind 为 active 的技能冷却至少设为指定回合；不改被动技能，也不暴露任意技能字段。',
    inputs: [port('piece', pieceType), port('amount', numberType)],
    outputs: [port('success', booleanType), port('present', booleanType)],
    effects: write(['skills']),
    lower: ctx => {
      const piece = input(ctx, 'piece')
      const amount = input(ctx, 'amount')
      const state = battle(ctx)
      const runtime = flow(ctx)
      return `(function(pieceId, minimum) { var piece = ${runtime}.query.piece(pieceId); var skills = piece && piece.skills; if (!Array.isArray(skills)) return { success: false, present: false }; skills.forEach(function(skillState) { var definition = ${state}.skillsById && Object.prototype.hasOwnProperty.call(${state}.skillsById, skillState.skillId) ? ${state}.skillsById[skillState.skillId] : undefined; if (!definition || definition.kind === "active") skillState.currentCooldown = Math.max(Number(skillState.currentCooldown || 0), minimum); }); return { success: true, present: true }; })(${piece}, ${amount})`
    },
    ui: { category: 'skill' },
  }),
  define({
    id: 'card.bind-latest-unbound',
    label: '绑定最新未绑定手牌',
    description: '从指定玩家手牌末端向前查找指定卡牌的未绑定实例，并以棋子 instanceId 建立绑定；不会写入其他卡牌路径。',
    inputs: [port('player', playerType), port('piece', pieceType)],
    outputs: [port('success', booleanType)],
    parameters: [{ name: 'cardId', type: stringType }],
    effects: write(['hand']),
    lower: ctx => {
      const player = input(ctx, 'player')
      const piece = input(ctx, 'piece')
      const cardId = ctx.emitLiteral(ctx.parameters.cardId)
      return `(function(playerId, pieceId, wantedCardId) { var hand = ${flow(ctx)}.cards.hand(playerId); if (!Array.isArray(hand)) return false; for (var index = hand.length - 1; index >= 0; index -= 1) { var card = hand[index]; if (card && card.cardId === wantedCardId && !card.boundPieceInstanceId) { card.boundPieceInstanceId = pieceId; return true; } } return false; })(${player}, ${piece}, ${cardId})`
    },
    ui: { category: 'card' },
  }),
]

export const SAGE_TOTSUKA_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze(DESCRIPTORS)
export const sageTotsukaGameplayModuleDescriptors = SAGE_TOTSUKA_GAMEPLAY_MODULES
