import type {
  GameplayEffectMetadata,
  GameplayLiteral,
  GameplayModuleDescriptor,
  GameplayModuleSurface,
  GameplayNativeLoweringContext,
  GameplayParameter,
  GameplayPort,
  GameplayValueType,
} from './module-types'

const AUTHOR_CODE_BLOCK_MODULE_ID = 'code-block.invoke' as const
const AUTHOR_CODE_BLOCK_MODULE_VERSION = '1' as const
const AUTHOR_CODE_BLOCK_SURFACES: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const AUTHOR_CODE_BLOCK_RECORD: GameplayValueType = 'record'
const AUTHOR_CODE_BLOCK_STRING: GameplayValueType = 'string'
const AUTHOR_CODE_BLOCK_EFFECTS: GameplayEffectMetadata = Object.freeze({
  pure: false,
  previewSafe: false,
  pending: true,
  writes: ['execution-context'],
})

const port = (
  name: string,
  type: GameplayValueType,
  options: Omit<GameplayPort, 'name' | 'type'> = {},
): GameplayPort => ({ name, type, ...options })

const parameter = (
  name: string,
  options: Omit<GameplayParameter, 'name' | 'type'> = {},
): GameplayParameter => ({ name, type: AUTHOR_CODE_BLOCK_STRING, ...options })

function input(ctx: GameplayNativeLoweringContext, name: string): string {
  const value = ctx.inputs[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`module ${ctx.moduleId}: missing input ${name}`)
  return value
}

function resultTypeLiteral(ctx: GameplayNativeLoweringContext): string {
  const raw = ctx.parameters.resultType
  if (raw === undefined) throw new Error(`module ${ctx.moduleId}: missing result type`)
  let type: GameplayLiteral = raw
  if (typeof raw === 'string' && raw.trimStart().startsWith('{')) {
    try {
      type = JSON.parse(raw) as GameplayLiteral
    } catch {
      throw new Error(`module ${ctx.moduleId}: result type is not valid JSON`)
    }
  }
  return ctx.emitLiteral({
    type,
    schemas: ctx.recordSchemas ?? [],
  } as unknown as GameplayLiteral)
}

function lowerAuthorCodeBlockInvocation(ctx: GameplayNativeLoweringContext): string {
  const block = input(ctx, 'block')
  const args = input(ctx, 'args')
  const expected = resultTypeLiteral(ctx)
  if (ctx.surface === 'pending') {
    // Resumed ordinary pending graphs do not necessarily have the ephemeral
    // nested adapter hook. Fall back to the host facade while preserving the
    // shared-budget path when a block is already executing.
    return `(typeof ctx.__authorCodeBlockInvoke === "function" ? ctx.__authorCodeBlockInvoke(${block},${args},${expected}) : ctx.flow.codeBlocks.invoke(${block},${args},${expected}))`
  }
  return `flow.codeBlocks.invoke(${block},${args},${expected})`
}

/**
 * Generic author code block invocation.  The graph carries ordinary typed
 * records until the nominal code block type is introduced; the three closed
 * type parameters keep the input and result record shapes checked by the
 * existing module compiler.
 */
export const AUTHOR_CODE_BLOCK_GAMEPLAY_MODULE: GameplayModuleDescriptor = Object.freeze({
  id: AUTHOR_CODE_BLOCK_MODULE_ID,
  version: AUTHOR_CODE_BLOCK_MODULE_VERSION,
  label: '执行代码块',
  description: '绑定显式参数并执行一个结构化、数据定义的代码块。',
  inputs: [
    port('block', AUTHOR_CODE_BLOCK_RECORD, { label: '代码块' }),
    port('args', AUTHOR_CODE_BLOCK_RECORD, { label: '参数' }),
  ],
  outputs: [port('result', AUTHOR_CODE_BLOCK_RECORD, { label: '返回值' })],
  inputValueTypeBindings: {
    block: { parameter: 'blockType' },
    args: { parameter: 'argsType' },
  },
  outputValueTypeBindings: { result: { parameter: 'resultType' } },
  parameters: [
    parameter('blockType', { label: '代码块类型', default: AUTHOR_CODE_BLOCK_RECORD }),
    parameter('argsType', { label: '参数类型', default: AUTHOR_CODE_BLOCK_RECORD }),
    parameter('resultType', { label: '返回类型', default: AUTHOR_CODE_BLOCK_RECORD }),
  ],
  allowedSurfaces: AUTHOR_CODE_BLOCK_SURFACES,
  effects: AUTHOR_CODE_BLOCK_EFFECTS,
  ui: { category: 'control', authoring: 'standard' as const },
  lower: lowerAuthorCodeBlockInvocation,
})

export const AUTHOR_CODE_BLOCK_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  AUTHOR_CODE_BLOCK_GAMEPLAY_MODULE,
])

/** Aliases keep the descriptor discoverable beside the other registry groups. */
export const CODE_BLOCK_GAMEPLAY_MODULES = AUTHOR_CODE_BLOCK_GAMEPLAY_MODULES
export const authorCodeBlockGameplayModuleDescriptors = AUTHOR_CODE_BLOCK_GAMEPLAY_MODULES
