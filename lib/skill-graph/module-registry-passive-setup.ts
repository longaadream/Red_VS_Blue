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
 * Small host adapters used by passive setup skills.
 *
 * These descriptors deliberately expose only closed operations: player lookup
 * is case-insensitive because the legacy trigger boundary was, snapshots strip
 * executable rule effects, board removal only accepts an opaque piece ID, and
 * the two storage keys are fixed by the summon capability contract.
 */
const SURFACES: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const playerType: GameplayValueType = 'player'
const pieceType: GameplayValueType = 'piece'
const stringType: GameplayValueType = 'string'
const booleanType: GameplayValueType = 'boolean'
const recordType: GameplayValueType = 'record'

const port = (name: string, type: GameplayValueType, options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })
const parameter = (name: string, type: GameplayValueType, options: Omit<GameplayParameter, 'name' | 'type'> = {}): GameplayParameter => ({ name, type, ...options })
const flow = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const battle = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
const input = (ctx: GameplayNativeLoweringContext, name: string): string => {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}
const literal = (ctx: GameplayNativeLoweringContext, name: string, fallback?: string): string => {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'string') throw new Error(`module ${ctx.moduleId}: parameter ${name} must be text`)
  return ctx.emitLiteral(value)
}
const pure = (reads: readonly string[] = []): GameplayEffectMetadata => ({ pure: true, previewSafe: false, reads })
const writes = (domains: readonly string[]): GameplayEffectMetadata => ({ pure: false, previewSafe: false, writes: domains })
const define = (value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'> & { version?: string; allowedSurfaces?: readonly GameplayModuleSurface[] }): GameplayModuleDescriptor => ({
  version: value.version ?? '1',
  allowedSurfaces: value.allowedSurfaces ?? SURFACES,
  ...value,
})

const STORAGE_KEY = 'kiljaedanPiece' as const
const OWNER_STORAGE_KEY = 'kiljaedanPiecesByPlayerId' as const

export const PASSIVE_SETUP_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  define({
    id: 'ref.player-id-text',
    label: '读取原始玩家标识文本',
    description: '读取触发边界提供的玩家标识文本，不在读取阶段做大小写或存在性校验，交由后续闭合查询处理。',
    inputs: [],
    outputs: [port('text', stringType, { nullable: true })],
    effects: pure(['context']),
    lower: ctx => `(typeof ${ctx.surface === 'pending' ? 'ctx' : 'context'}.playerId === "undefined" ? null : ${ctx.surface === 'pending' ? 'ctx' : 'context'}.playerId)`,
    ui: { category: 'context' },
  }),
  define({
    id: 'query.player-case-insensitive',
    label: '不区分大小写查询玩家',
    description: '按触发边界保留的玩家标识查询当前对局玩家，兼容旧技能的大小写不敏感匹配。',
    inputs: [port('playerId', stringType, { nullable: true })],
    outputs: [port('player', playerType, { nullable: true }), port('error', stringType)],
    effects: pure(['players']),
    lower: ctx => {
      const query = flow(ctx)
      return `(function(id){try{if(id===null){var missing;missing.toLowerCase();}var needle=id.toLowerCase(),ids=${query}.query.players()||[];for(var index=0;index<ids.length;index+=1){if(String(ids[index]).toLowerCase()===needle)return {player:ids[index],error:""};}return {player:null,error:""};}catch(error){return {player:null,error:"Error: "+(error&&error.message)};}})(${input(ctx, 'playerId')})`
    },
    ui: { category: 'query' },
  }),
  define({
    id: 'query.player-by-id-text',
    label: '按玩家标识文本查询玩家',
    description: '按原始玩家标识文本做精确权威查询；文本未对应现存玩家时返回空引用。',
    inputs: [port('playerId', stringType, { nullable: true })],
    outputs: [port('player', playerType, { nullable: true })],
    effects: pure(['players']),
    lower: ctx => {
      const query = flow(ctx)
      return `(function(id){if(id==null||!${query}.query.hasPlayer(id))return null;return ${query}.query.player(id).playerId;})(${input(ctx, 'playerId')})`
    },
    ui: { category: 'query' },
  }),
  define({
    id: 'player.display-name',
    label: '读取玩家显示名',
    description: '读取已验证玩家名称，并在名称为空时回退到玩家标识。',
    inputs: [port('player', playerType, { nullable: true })],
    outputs: [port('text', stringType)],
    effects: pure(['players']),
    lower: ctx => {
      const query = flow(ctx)
      const player = input(ctx, 'player')
      return `(function(id){if(id==null||!${query}.query.hasPlayer(id))return '';var value=${query}.query.player(id);return String(value&&value.name||id);})(${player})`
    },
    ui: { category: 'query' },
  }),
  define({
    id: 'piece.snapshot-serializable',
    label: '保留棋子数据快照',
    description: '复制当前棋子可持久化数据，并从每条规则中去除可执行 effect；不会把运行时函数带入储存召唤。',
    inputs: [port('piece', pieceType)],
    outputs: [port('record', recordType)],
    parameters: [parameter('policy', stringType, { enum: ['strip-rule-effects'], default: 'strip-rule-effects' })],
    effects: pure(['pieces']),
    lower: ctx => {
      if (ctx.parameters.policy !== undefined && ctx.parameters.policy !== 'strip-rule-effects') throw new Error(`module ${ctx.moduleId}: invalid snapshot policy`)
      const query = flow(ctx)
      return `(function(id){var piece=${query}.query.piece(id),copy={},key,sourceRules=Array.isArray(piece.rules)?piece.rules:[],stripped=[];for(key in piece){if(key!=='rules')copy[key]=piece[key];}for(var index=0;index<sourceRules.length;index+=1){var rule=sourceRules[index],ruleCopy={};if(rule&&typeof rule==='object'){for(key in rule){if(key!=='effect')ruleCopy[key]=rule[key];}}stripped.push(ruleCopy);}copy.rules=stripped;try{return JSON.parse(JSON.stringify(copy));}catch(error){return {instanceId:piece.instanceId,templateId:piece.templateId,ownerPlayerId:piece.ownerPlayerId,name:piece.name,faction:piece.faction,isCore:piece.isCore};}})(${input(ctx, 'piece')})`
    },
    ui: { category: 'state' },
  }),
  define({
    id: 'piece.owner-id-text',
    label: '读取棋子原始归属标识',
    description: '读取棋子所属玩家的原始标识文本；缺少归属时保留空值供后续边界拒绝。',
    inputs: [port('piece', pieceType)],
    outputs: [port('playerId', stringType, { nullable: true })],
    effects: pure(['pieces']),
    lower: ctx => {
      const query = flow(ctx)
      return `(function(id){var piece=${query}.query.piece(id);return piece&&piece.ownerPlayerId!=null?String(piece.ownerPlayerId):null;})(${input(ctx, 'piece')})`
    },
    ui: { category: 'query' },
  }),
  define({
    id: 'piece.detach-active',
    label: '从当前棋盘移除棋子',
    description: '通过宿主生命周期按不透明实例标识从当前棋盘集合中移除棋子；不伪造死亡事件或额外表现。旧 data-owned 内容可显式选择兼容离场策略。',
    inputs: [port('piece', pieceType)],
    outputs: [port('success', booleanType)],
    parameters: [
      parameter('flowStatePolicy', stringType, { enum: ['cleanup', 'preserve'], default: 'cleanup' }),
      // Compatibility-only graphs from the original descriptor version own
      // their detached copy in a content extension.  This parameter is kept
      // optional and unlabelled so it is not an authoring control; the
      // descriptor-version fallback below preserves those old graphs while
      // allowing a future graph to opt into the authoritative path.
      parameter('detachMode', stringType, { enum: ['author', 'data-owned'], optional: true }),
    ],
    effects: writes(['pieces']),
    lower: ctx => {
      const policy = literal(ctx, 'flowStatePolicy', 'cleanup')
      if (ctx.parameters.flowStatePolicy !== undefined && !['cleanup', 'preserve'].includes(ctx.parameters.flowStatePolicy as string)) throw new Error(`module ${ctx.moduleId}: invalid flowStatePolicy`)
      const defaultMode = ctx.moduleVersion === '1' ? 'data-owned' : 'author'
      const mode = literal(ctx, 'detachMode', defaultMode)
      if (ctx.parameters.detachMode !== undefined && !['author', 'data-owned'].includes(ctx.parameters.detachMode as string)) throw new Error(`module ${ctx.moduleId}: invalid detachMode`)
      return `${flow(ctx)}.lifecycle.detachActive(${input(ctx, 'piece')}, ${policy}, ${mode})`
    },
    ui: { category: 'lifecycle', authoring: 'compatibility' },
  }),
  define({
    id: 'piece.detach-active',
    version: '2',
    label: '安全移除当前棋子',
    description: '按作者生命周期从当前棋盘移除棋子，并由宿主保留可验证的离场实例；不伪造死亡事件或额外表现。可选择清理或保留本次执行的棋子状态。',
    inputs: [port('piece', pieceType)],
    outputs: [port('success', booleanType)],
    parameters: [
      parameter('flowStatePolicy', stringType, { enum: ['cleanup', 'preserve'], default: 'cleanup', label: '状态处理' }),
    ],
    effects: writes(['pieces']),
    lower: ctx => {
      const policy = literal(ctx, 'flowStatePolicy', 'cleanup')
      if (ctx.parameters.flowStatePolicy !== undefined && !['cleanup', 'preserve'].includes(ctx.parameters.flowStatePolicy as string)) throw new Error(`module ${ctx.moduleId}: invalid flowStatePolicy`)
      return `${flow(ctx)}.lifecycle.detachActive(${input(ctx, 'piece')}, ${policy}, "author")`
    },
    ui: { category: 'lifecycle', authoring: 'standard' },
  }),
  define({
    id: 'extension.store-piece',
    label: '登记储存棋子',
    description: '将已复制的棋子登记到固定的全局和按玩家存储槽，供声明式唯一召唤读取。',
    inputs: [port('owner', stringType, { nullable: true }), port('piece', recordType)],
    outputs: [port('success', booleanType)],
    parameters: [
      parameter('storageKey', stringType, { enum: [STORAGE_KEY], default: STORAGE_KEY }),
      parameter('ownerScopedStorageKey', stringType, { enum: [OWNER_STORAGE_KEY], default: OWNER_STORAGE_KEY }),
    ],
    effects: writes(['extensions']),
    lower: ctx => {
      const state = battle(ctx)
      const storageKey = literal(ctx, 'storageKey', STORAGE_KEY)
      const ownerStorageKey = literal(ctx, 'ownerScopedStorageKey', OWNER_STORAGE_KEY)
      if (ctx.parameters.storageKey !== undefined && ctx.parameters.storageKey !== STORAGE_KEY) throw new Error(`module ${ctx.moduleId}: invalid storageKey`)
      if (ctx.parameters.ownerScopedStorageKey !== undefined && ctx.parameters.ownerScopedStorageKey !== OWNER_STORAGE_KEY) throw new Error(`module ${ctx.moduleId}: invalid ownerScopedStorageKey`)
      return `(function(owner,piece){if(typeof owner!=='string'||!piece||typeof piece!=='object')return false;var ownerKey=String(owner).trim().toLowerCase();if(!ownerKey||ownerKey==='__proto__'||ownerKey==='constructor'||ownerKey==='prototype')return false;${state}.extensions=${state}.extensions||{};var scoped=${state}.extensions[${ownerStorageKey}];if(!scoped||typeof scoped!=='object'||Array.isArray(scoped))scoped={};scoped[ownerKey]=piece;${state}.extensions[${ownerStorageKey}]=scoped;if(${state}.extensions[${storageKey}]==null)${state}.extensions[${storageKey}]=piece;return true;})(${input(ctx, 'owner')},${input(ctx, 'piece')})`
    },
    ui: { category: 'state' },
  }),
  define({
    id: 'card.hand-add-controlled',
    label: '受控加入手牌',
    description: '调用现有手牌生命周期，并把宿主异常转换为带错误文本的受控结果，供图中的分支继续返回。',
    inputs: [port('player', playerType)],
    outputs: [port('success', booleanType), port('error', stringType)],
    parameters: [parameter('cardId', stringType)],
    effects: writes(['hand', 'events']),
    lower: ctx => {
      const query = flow(ctx)
      return `(function(playerId,cardId){try{return {success:Boolean(${query}.cards.add(playerId,cardId)),error:""};}catch(error){return {success:false,error:"Error: "+(error&&error.message)};}})(${input(ctx, 'player')},${literal(ctx, 'cardId')})`
    },
    ui: { category: 'card' },
  }),
  define({
    id: 'card.hand-add-player-id-text',
    label: '按玩家标识文本加入手牌',
    description: '把原始玩家标识文本交给现有手牌生命周期；不存在或为空时沿用加入失败结果。',
    inputs: [port('playerId', stringType, { nullable: true })],
    outputs: [port('success', booleanType)],
    parameters: [parameter('cardId', stringType)],
    effects: writes(['hand', 'events']),
    lower: ctx => {
      const query = flow(ctx)
      return `(${input(ctx, 'playerId')} == null ? false : ${query}.cards.add(${input(ctx, 'playerId')}, ${literal(ctx, 'cardId')}))`
    },
    ui: { category: 'card' },
  }),
])

export const passiveSetupGameplayModuleDescriptors = PASSIVE_SETUP_GAMEPLAY_MODULES
