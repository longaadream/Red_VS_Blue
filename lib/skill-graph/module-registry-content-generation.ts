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
 * Generic author-facing primitives for generated content.
 *
 * The modules in this file deliberately stop at a small host boundary.  A
 * graph can choose and bind a definition, filter an existing hand, or clone
 * a definition, but it cannot provide a JavaScript callback, an object path,
 * or an executable source string.  The host owns template validation,
 * lifecycle events, and preservation of fields unknown to the graph.
 */

export const CONTENT_GENERATION_MODULE_VERSION = '1' as const

type Surface = GameplayModuleSurface

const ACTIVE_SURFACES: readonly Surface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const PURE_SURFACES: readonly Surface[] = [...ACTIVE_SURFACES, 'preview']

const booleanType: GameplayValueType = 'boolean'
const numberType: GameplayValueType = 'number'
const playerType: GameplayValueType = 'player'
const pieceType: GameplayValueType = 'piece'
const stringType: GameplayValueType = 'string'
const choiceType: GameplayValueType = 'choice'
const stringListType: GameplayValueType = { kind: 'list', element: stringType }

const port = (
  name: string,
  type: GameplayValueType,
  options: Omit<GameplayPort, 'name' | 'type'> = {},
): GameplayPort => ({ name, type, ...options })

const parameter = (
  name: string,
  type: GameplayValueType,
  options: Omit<GameplayParameter, 'name' | 'type'> = {},
): GameplayParameter => ({ name, type, ...options })

const pure = (reads: readonly string[] = []): GameplayEffectMetadata => ({
  pure: true,
  previewSafe: true,
  reads,
})

const writes = (
  domains: readonly string[],
  events: readonly string[] = [],
): GameplayEffectMetadata => ({
  pure: false,
  previewSafe: false,
  writes: domains,
  events,
})

const define = (
  value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'> & { readonly allowedSurfaces?: readonly Surface[] },
): GameplayModuleDescriptor => ({
  version: CONTENT_GENERATION_MODULE_VERSION,
  allowedSurfaces: value.allowedSurfaces ?? ACTIVE_SURFACES,
  ...value,
})

function flow(ctx: GameplayNativeLoweringContext): string {
  return ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
}

function input(ctx: GameplayNativeLoweringContext, name: string): string {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}

function stringLiteral(ctx: GameplayNativeLoweringContext, name: string, fallback?: string): string {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'string') throw new Error(`module ${ctx.moduleId}: parameter ${name} must be text`)
  return ctx.emitLiteral(value)
}

function numberLiteral(ctx: GameplayNativeLoweringContext, name: string, fallback?: number): string {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`module ${ctx.moduleId}: parameter ${name} must be finite`)
  return ctx.emitLiteral(value)
}

function booleanLiteral(ctx: GameplayNativeLoweringContext, name: string, fallback?: boolean): string {
  const value = Object.prototype.hasOwnProperty.call(ctx.parameters, name) ? ctx.parameters[name] : fallback
  if (typeof value !== 'boolean') throw new Error(`module ${ctx.moduleId}: parameter ${name} must be boolean`)
  return ctx.emitLiteral(value)
}

function stringListLiteral(ctx: GameplayNativeLoweringContext, name: string): string {
  const value = ctx.parameters[name]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`module ${ctx.moduleId}: parameter ${name} must be a string list`)
  }
  return ctx.emitLiteral(value)
}

const CHOICE_AND_LIST_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'choice.multi-string',
    label: '多选文本选项',
    description: '使用固定文本选项进入现有多选协议；候选、数量、取消和恢复仍由权威选择宿主处理。',
    inputs: [],
    outputs: [port('choice', choiceType)],
    parameters: [
      parameter('title', stringType, { optional: true }),
      parameter('options', stringListType),
      parameter('labels', stringListType, { optional: true }),
      parameter('minSelections', numberType, { default: 1, minimum: 1 }),
      parameter('maxSelections', numberType, { default: 1, minimum: 1 }),
      parameter('canCancel', booleanType, { default: false }),
    ],
    allowedSurfaces: ['skill', 'card', 'pending'],
    effects: writes(['pending'], ['pendingOptionSelection']),
    lower: ctx => {
      const options = stringListLiteral(ctx, 'options')
      const labels = Object.prototype.hasOwnProperty.call(ctx.parameters, 'labels')
        ? stringListLiteral(ctx, 'labels')
        : undefined
      const title = Object.prototype.hasOwnProperty.call(ctx.parameters, 'title')
        ? `, title: ${stringLiteral(ctx, 'title')}`
        : ''
      const optionLabels = labels
        ? `${options}.map(function(value, index) { return {label: ${labels}[index] === undefined ? value : ${labels}[index], value: value}; })`
        : `${options}.map(function(value) { return {label: value, value: value}; })`
      return `${flow(ctx)}.choice.option({options: ${optionLabels}, selectionMode: "multi", minSelections: ${numberLiteral(ctx, 'minSelections', 1)}, maxSelections: ${numberLiteral(ctx, 'maxSelections', 1)}, canCancel: ${booleanLiteral(ctx, 'canCancel', false)}${title}})`
    },
    ui: { category: 'choice' },
  }),
  define({
    id: 'choice.as-string-list',
    label: '读取多选文本',
    description: '将已完成的多选结果解析为文本集合；挂起结果由前置选择分支保留。',
    inputs: [port('choice', choiceType, { nullable: true, optional: true })],
    outputs: [port('values', stringListType)],
    allowedSurfaces: PURE_SURFACES,
    effects: pure(['choice']),
    lower: ctx => {
      const value = input(ctx, 'choice')
      return `(function(value) { var selected = Array.isArray(value) ? value : (value && Array.isArray(value.value) ? value.value : []); return selected.map(function(item) { return String(item && typeof item === "object" && item.value !== undefined ? item.value : item); }); })(${value})`
    },
    ui: { category: 'choice' },
  }),
  define({
    id: 'choice.status-tags',
    label: '选择棋子状态',
    description: '把目标棋子的状态列表交给权威单选协议；选项包含稳定序号和不移除入口。',
    inputs: [port('target', pieceType)],
    outputs: [port('choice', choiceType)],
    parameters: [parameter('title', stringType, { optional: true })],
    allowedSurfaces: ['skill', 'card', 'pending'],
    effects: writes(['pending'], ['pendingOptionSelection']),
    lower: ctx => {
      const title = Object.prototype.hasOwnProperty.call(ctx.parameters, 'title')
        ? `, ${stringLiteral(ctx, 'title')}`
        : ''
      return `${flow(ctx)}.choice.statusTags(${input(ctx, 'target')}${title})`
    },
    ui: { category: 'choice' },
  }),
  define({
    id: 'list.count',
    label: '集合数量',
    description: '读取有序集合的数量。',
    inputs: [port('items', stringListType)],
    outputs: [port('count', numberType)],
    allowedSurfaces: PURE_SURFACES,
    effects: pure(),
    lower: ctx => `Array.isArray(${input(ctx, 'items')}) ? ${input(ctx, 'items')}.length : 0`,
    ui: { category: 'collection' },
  }),
  define({
    id: 'list.has-duplicate',
    label: '集合有重复项',
    description: '按稳定文本值判断集合中是否出现重复项。',
    inputs: [port('items', stringListType)],
    outputs: [port('duplicate', booleanType)],
    allowedSurfaces: PURE_SURFACES,
    effects: pure(),
    lower: ctx => `(function(items) { return Array.isArray(items) && new Set(items).size !== items.length; })(${input(ctx, 'items')})`,
    ui: { category: 'collection' },
  }),
  define({
    id: 'list.all-in',
    label: '集合值域校验',
    description: '判断集合中的每个文本值是否属于登记的允许值集合。',
    inputs: [port('items', stringListType)],
    outputs: [port('valid', booleanType)],
    parameters: [parameter('allowed', stringListType)],
    allowedSurfaces: PURE_SURFACES,
    effects: pure(),
    lower: ctx => `(function(items, allowed) { return Array.isArray(items) && items.every(function(item) { return allowed.indexOf(item) !== -1; }); })(${input(ctx, 'items')}, ${stringListLiteral(ctx, 'allowed')})`,
    ui: { category: 'collection' },
  }),
  define({
    id: 'list.sort-string',
    label: '文本稳定排序',
    description: '复制并按 JavaScript 字符串顺序排序，不改变来源集合。',
    inputs: [port('items', stringListType)],
    outputs: [port('sorted', stringListType)],
    allowedSurfaces: PURE_SURFACES,
    effects: pure(),
    lower: ctx => `(Array.isArray(${input(ctx, 'items')}) ? ${input(ctx, 'items')}.slice().sort() : [])`,
    ui: { category: 'collection' },
  }),
  define({
    id: 'list.join',
    label: '集合拼接',
    description: '按原集合顺序拼接文本值。',
    inputs: [port('items', stringListType)],
    outputs: [port('text', stringType)],
    parameters: [parameter('separator', stringType, { default: ',' })],
    allowedSurfaces: PURE_SURFACES,
    effects: pure(),
    lower: ctx => `(Array.isArray(${input(ctx, 'items')}) ? ${input(ctx, 'items')}.join(${stringLiteral(ctx, 'separator', ',')}) : "")`,
    ui: { category: 'collection' },
  }),
  define({
    id: 'value.select-number',
    label: '按条件选择数字',
    description: '在两个已计算数字之间按布尔条件选择一个值。',
    inputs: [port('condition', booleanType), port('whenTrue', numberType), port('whenFalse', numberType)],
    outputs: [port('value', numberType)],
    allowedSurfaces: PURE_SURFACES,
    effects: pure(),
    lower: ctx => `(${input(ctx, 'condition')} ? ${input(ctx, 'whenTrue')} : ${input(ctx, 'whenFalse')})`,
    ui: { category: 'logic' },
  }),
  define({
    id: 'text.optional-fragment',
    label: '条件文本片段',
    description: '条件成立时拼接一个固定前缀、值和后缀，否则返回空文本。',
    inputs: [port('condition', booleanType), port('value', stringType)],
    outputs: [port('text', stringType)],
    parameters: [parameter('prefix', stringType, { default: '' }), parameter('suffix', stringType, { default: '' })],
    allowedSurfaces: PURE_SURFACES,
    effects: pure(),
    lower: ctx => `(${input(ctx, 'condition')} ? (${stringLiteral(ctx, 'prefix', '')} + ${input(ctx, 'value')} + ${stringLiteral(ctx, 'suffix', '')}) : "")`,
    ui: { category: 'text' },
  }),
]

const CONTENT_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'content.enemy-player',
    label: '查找敌方玩家',
    description: '按当前对局的既有玩家顺序解析一名敌方玩家，不暴露玩家集合给作者图。',
    inputs: [port('player', playerType, { nullable: true, optional: true })],
    outputs: [port('enemy', playerType, { nullable: true })],
    allowedSurfaces: ACTIVE_SURFACES,
    effects: pure(['players']),
    lower: ctx => `${flow(ctx)}.content.enemyPlayer(${input(ctx, 'player')})`,
    ui: { category: 'content' },
  }),
  define({
    id: 'content.filter-hand',
    label: '按名称或 ID 筛选手牌',
    description: '按固定的名称片段或卡牌 ID 前缀筛选指定玩家手牌；保留手牌顺序并报告手牌是否存在。',
    inputs: [port('player', playerType, { nullable: true, optional: true })],
    outputs: [port('cards', stringListType), port('hasHand', booleanType)],
    parameters: [parameter('nameContains', stringType, { optional: true }), parameter('cardIdPrefix', stringType, { optional: true })],
    allowedSurfaces: ACTIVE_SURFACES,
    effects: pure(['hand', 'content']),
    lower: ctx => {
      const nameContains = Object.prototype.hasOwnProperty.call(ctx.parameters, 'nameContains') ? stringLiteral(ctx, 'nameContains') : 'null'
      const cardIdPrefix = Object.prototype.hasOwnProperty.call(ctx.parameters, 'cardIdPrefix') ? stringLiteral(ctx, 'cardIdPrefix') : 'null'
      return `${flow(ctx)}.content.filterHand(${input(ctx, 'player')}, {nameContains: ${nameContains}, cardIdPrefix: ${cardIdPrefix}})`
    },
    ui: { category: 'content' },
  }),
  define({
    id: 'content.copy-card',
    label: '复制卡牌定义',
    description: '复制已存在的动态卡牌定义；静态卡牌或缺少动态定义时沿用来源 ID。未知字段与模块图保持原样。',
    inputs: [port('sourceId', stringType), port('index', numberType)],
    outputs: [port('cardId', stringType), port('copied', booleanType)],
    parameters: [parameter('idPrefix', stringType, { default: 'content-copy-' })],
    allowedSurfaces: ACTIVE_SURFACES,
    effects: writes(['content', 'hand'], ['contentCardCopied']),
    lower: ctx => `${flow(ctx)}.content.copyCard(${input(ctx, 'sourceId')}, ${stringLiteral(ctx, 'idPrefix', 'content-copy-')}, ${input(ctx, 'index')})`,
    ui: { category: 'content' },
  }),
  define({
    id: 'content.materialize-template',
    label: '实例化卡牌模板',
    description: '按受信模板和结构化绑定创建动态卡牌定义；生成字段来自模板图，不接受源码文本。',
    inputs: [
      port('templateId', stringType),
      port('cardId', stringType),
      port('name', stringType),
      port('description', stringType),
      port('owner', playerType, { nullable: true, optional: true }),
    ],
    outputs: [port('cardId', stringType), port('success', booleanType)],
    parameters: [parameter('kind', stringType, { enum: ['card'], default: 'card' })],
    allowedSurfaces: ACTIVE_SURFACES,
    effects: writes(['content'], ['contentCardMaterialized']),
    lower: ctx => `${flow(ctx)}.content.materializeTemplate({kind: ${stringLiteral(ctx, 'kind', 'card')}, templateId: ${input(ctx, 'templateId')}, cardId: ${input(ctx, 'cardId')}, name: ${input(ctx, 'name')}, description: ${input(ctx, 'description')}, owner: ${ctx.inputs.owner ?? 'null'}})`,
    ui: { category: 'content' },
  }),
  define({
    id: 'card.hand-add-ref',
    label: '加入动态卡牌手牌',
    description: '使用已生成的卡牌定义 ID 沿用既有手牌容量、实例化和事件流程。',
    inputs: [port('player', playerType), port('cardId', stringType)],
    outputs: [port('success', booleanType)],
    allowedSurfaces: ACTIVE_SURFACES,
    effects: writes(['hand', 'events'], ['cardAdded']),
    lower: ctx => `${flow(ctx)}.cards.add(${input(ctx, 'player')}, ${input(ctx, 'cardId')})`,
    ui: { category: 'card' },
  }),
]

const PIECE_AND_STATUS_PRIMITIVES: readonly GameplayModuleDescriptor[] = [
  define({
    id: 'attribute.set-current-hp',
    label: '设定当前生命',
    description: '通过宿主的无事件生命写入口设定当前生命值；用于回合规则的直接恢复语义，不触发治疗事件。',
    inputs: [port('piece', pieceType), port('value', numberType)],
    outputs: [port('value', numberType)],
    allowedSurfaces: ACTIVE_SURFACES,
    effects: writes(['attributes'], []),
    lower: ctx => `${flow(ctx)}.attributes.setCurrentHp(${input(ctx, 'piece')}, ${input(ctx, 'value')})`,
    ui: { category: 'effect' },
  }),
  define({
    id: 'piece.momentum',
    label: '读取动量',
    description: '读取棋子登记的动量数值；缺省值沿用旧内容的零值规则。',
    inputs: [port('piece', pieceType)],
    outputs: [port('value', numberType)],
    allowedSurfaces: PURE_SURFACES,
    effects: pure(['pieces']),
    lower: ctx => `Number(${flow(ctx)}.query.piece(${input(ctx, 'piece')}).momentum || 0)`,
    ui: { category: 'query' },
  }),
  define({
    id: 'status.count-all',
    label: '读取状态数量',
    description: '读取目标棋子的当前状态数量，用于决定是否进入状态选择协议。',
    inputs: [port('target', pieceType)],
    outputs: [port('count', numberType)],
    allowedSurfaces: PURE_SURFACES,
    effects: pure(['status']),
    lower: ctx => `${flow(ctx)}.status.count(${input(ctx, 'target')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.make-id',
    label: '生成状态标识',
    description: '让权威状态宿主生成一个可回放的唯一状态标识；作者图只提供稳定前缀。',
    inputs: [port('target', pieceType)],
    outputs: [port('id', stringType)],
    parameters: [parameter('prefix', stringType)],
    allowedSurfaces: ACTIVE_SURFACES,
    effects: writes(['status'], ['statusIdAllocated']),
    lower: ctx => `${flow(ctx)}.status.generatedId(${input(ctx, 'target')}, ${stringLiteral(ctx, 'prefix')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.append-record',
    label: '兼容性直写棋子状态',
    description: '按旧内容的直接 statusTags.push 语义追加结构化状态；不触发生命周期事件，不推断来源，也不自动安装规则。',
    inputs: [port('target', pieceType), port('record', 'record')],
    outputs: [port('success', booleanType)],
    allowedSurfaces: ACTIVE_SURFACES,
    effects: writes(['status'], []),
    lower: ctx => `${flow(ctx)}.status.appendRaw(${input(ctx, 'target')}, ${input(ctx, 'record')})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.remove-choice',
    label: '按选择移除状态',
    description: '验证并按旧内容的直接 statusTags.splice 语义移除一个状态；取消选项不改变状态，也不触发生命周期事件。',
    inputs: [port('target', pieceType), port('choice', choiceType, { nullable: true, optional: true })],
    outputs: [port('valid', booleanType), port('removed', booleanType), port('name', stringType)],
    allowedSurfaces: ACTIVE_SURFACES,
    effects: writes(['status'], []),
    lower: ctx => `${flow(ctx)}.status.removeChoice(${input(ctx, 'target')}, ${ctx.inputs.choice ?? 'null'})`,
    ui: { category: 'status' },
  }),
  define({
    id: 'status.refresh-temporary',
    label: '刷新临时状态',
    description: '按状态类型查找或创建状态，并把当前回合、持续时间和使用次数交给状态宿主更新。',
    inputs: [port('target', pieceType), port('turn', numberType)],
    outputs: [port('success', booleanType)],
    parameters: [
      parameter('statusType', stringType),
      parameter('name', stringType),
      parameter('idPrefix', stringType),
      parameter('duration', numberType, { default: 1 }),
      parameter('uses', numberType, { default: 1 }),
      parameter('visible', booleanType, { default: true }),
    ],
    allowedSurfaces: ACTIVE_SURFACES,
    // These two legacy records were written directly and therefore must not
    // acquire lifecycle events or inferred rule/source metadata when refreshed.
    effects: writes(['status'], []),
    lower: ctx => `${flow(ctx)}.status.refreshTemporary(${input(ctx, 'target')}, {type: ${stringLiteral(ctx, 'statusType')}, name: ${stringLiteral(ctx, 'name')}, idPrefix: ${stringLiteral(ctx, 'idPrefix')}, turn: ${input(ctx, 'turn')}, duration: ${numberLiteral(ctx, 'duration', 1)}, uses: ${numberLiteral(ctx, 'uses', 1)}, visible: ${booleanLiteral(ctx, 'visible', true)}})`,
    ui: { category: 'status' },
  }),
]

/** Descriptor set imported by the production registry after review. */
export const CONTENT_GENERATION_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  ...CHOICE_AND_LIST_PRIMITIVES,
  ...CONTENT_PRIMITIVES,
  ...PIECE_AND_STATUS_PRIMITIVES,
])

export const CONTENT_GAMEPLAY_MODULES = CONTENT_GENERATION_GAMEPLAY_MODULES

export const contentGenerationGameplayModuleDescriptors = CONTENT_GENERATION_GAMEPLAY_MODULES

