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

