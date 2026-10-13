import type {
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayPort,
  GameplayParameter,
} from './module-types'

const ACTIVE: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const port = (name: string, type: GameplayPort['type'], options: Partial<GameplayPort> = {}): GameplayPort => ({ name, type, ...options })
const parameter = (name: string, type: GameplayParameter['type'], options: Partial<GameplayParameter> = {}): GameplayParameter => ({ name, type, ...options })

const runtime = (ctx: GameplayNativeLoweringContext): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'

/**
 * Reusable content fact for effects which are bound to a named piece template.
 * The template id is data on the descriptor call; the graph never embeds a
 * host object path or a character-specific native operation.
 */
export const HOLY_SUPPORT_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  {
    id: 'status.replace-related-rules', version: '1', label: '替换状态关联规则',
    description: '替换首个匹配状态的关联规则列表；规则的安装和移除由独立模块处理。',
    inputs: [port('piece', 'piece'), port('rules', { kind: 'list', element: 'string' })],
    outputs: [port('changed', 'boolean')], parameters: [parameter('statusId', 'string'), parameter('statusType', 'string')],
    allowedSurfaces: ACTIVE, effects: { pure: false, previewSafe: false, reads: ['statuses'], writes: ['statuses'] },
    lower: ctx => `(function(pieceId, rules) { var piece = ${runtime(ctx)}.query.piece(pieceId); var status = (piece.statusTags || []).find(function(tag) { return tag.id === ${ctx.emitLiteral(ctx.parameters.statusId)} && tag.type === ${ctx.emitLiteral(ctx.parameters.statusType)}; }); if (!status) return false; status.relatedRules = rules.slice(); return true; })(${ctx.inputs.piece}, ${ctx.inputs.rules})`,
    ui: { category: 'status' },
  },
  {
    id: 'value.coalesce-record', version: '1', label: '选取首个有效记录',
    inputs: [port('first', 'record', { nullable: true }), port('fallback', 'record', { nullable: true })],
    outputs: [port('value', 'record', { nullable: true })], allowedSurfaces: ACTIVE,
    effects: { pure: true, previewSafe: false },
    lower: ctx => `(${ctx.inputs.first} == null ? ${ctx.inputs.fallback} : ${ctx.inputs.first})`,
    ui: { category: 'value' },
  },
  {
    id: 'piece.matches-template',
    version: '1',
    label: '棋子模板匹配',
    description: '判断已验证棋子引用是否属于指定内容模板。',
    inputs: [port('piece', 'piece', { nullable: true })],
    outputs: [port('value', 'boolean')],
    parameters: [parameter('templateId', 'string')],
    allowedSurfaces: ACTIVE,
    effects: { pure: true, previewSafe: false, reads: ['pieces'] },
    lower: ctx => `(${ctx.inputs.piece} == null ? false : ${runtime(ctx)}.query.piece(${ctx.inputs.piece}).templateId === ${ctx.emitLiteral(ctx.parameters.templateId)})`,
    ui: { category: 'query' },
  },
])

