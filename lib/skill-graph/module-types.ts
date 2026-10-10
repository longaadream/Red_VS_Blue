/**
 * Author-facing semantic gameplay modules.
 *
 * This file is deliberately data-only.  A graph can refer to named inputs and
 * outputs, registered module calls, and structured control flow, but it never
 * carries JavaScript source, object paths, or callable values.  Trusted native
 * lowering lives on the registry descriptor and is only invoked by the
 * compiler.
 */

export const GAMEPLAY_MODULE_GRAPH_VERSION = 'rvb-gameplay-modules/v1' as const
export const GAMEPLAY_MODULE_COMPILER_VERSION = 'rvb-gameplay-module-compiler/v1' as const

/** Compatibility aliases used by callers that call this format simply a graph. */
export const GAMEPLAY_GRAPH_VERSION = GAMEPLAY_MODULE_GRAPH_VERSION
export const MODULE_GRAPH_VERSION = GAMEPLAY_MODULE_GRAPH_VERSION

export type GameplayModuleSurface =
  | 'skill'
  | 'card'
  | 'rule'
  | 'triggerSkill'
  | 'pending'
  | 'preview'

/** JSON values are the only values that may be embedded in author content. */
export type GameplayJsonPrimitive = string | number | boolean | null
export type GameplayJsonValue =
  | GameplayJsonPrimitive
  | readonly GameplayJsonValue[]
  | { readonly [key: string]: GameplayJsonValue }
export type GameplayLiteral = GameplayJsonValue

/**
 * Semantic port types.  Entity values are opaque references to the host.  A
 * list retains its element type so a foreach body can be checked without
 * exposing the underlying game object.
 */
export type GameplayValueTypeName =
  | 'number'
  | 'boolean'
  | 'string'
  | 'piece'
  | 'player'
  | 'cell'
  | 'path'
  | 'card'
  | 'content'
  | 'status'
  | 'event'
  | 'choice'
  | 'record'
  | 'null'
  /** Internal bottom type used for an empty list literal; author ports reject it. */
  | 'never'
  | 'unknown'
  | 'any'

export type GameplayValueType =
  | GameplayValueTypeName
  | { readonly kind: 'list'; readonly element: GameplayValueType }
  | { readonly kind: 'nullable'; readonly value: GameplayValueType }

/** Short aliases make descriptor declarations readable in content catalogs. */
export type ModuleValueType = GameplayValueType
export type ModuleValueTypeName = GameplayValueTypeName

export type GameplayPort = {
  readonly name: string
  readonly type: GameplayValueType
  readonly optional?: boolean
  readonly nullable?: boolean
  readonly label?: string
  readonly description?: string
}

export type GameplayModulePort = GameplayPort

export type GameplayParameter = GameplayPort & {
  readonly default?: GameplayLiteral
  readonly enum?: readonly GameplayLiteral[]
  readonly minimum?: number
  readonly maximum?: number
}

export type GameplayModuleParameter = GameplayParameter

/** Effect metadata is descriptive and is also used for preview permission checks. */
export type GameplayEffectMetadata = {
  /** True only when the module is safe to execute from the preview surface. */
  readonly previewSafe?: boolean
  /** Pure modules have no state, event, random, or pending effects. */
  readonly pure?: boolean
  /** Stable host domains written by this module, e.g. `damage` or `status`. */
  readonly writes?: readonly string[]
  /** Stable host domains read by this module. */
  readonly reads?: readonly string[]
  /** Whether the module consumes the authoritative random stream. */
  readonly random?: boolean
  /** Whether the module can suspend into a pending choice. */
  readonly pending?: boolean
  /** Host events emitted by this module. */
  readonly events?: readonly string[]
  /** Human-readable effect summary for editor and diagnostics. */
  readonly description?: string
}

export type GameplayModuleEffects = GameplayEffectMetadata

/** A literal or a reference to a graph input or a prior node output. */
export type GameplayValue =
  | { readonly kind: 'literal'; readonly value: GameplayLiteral }
  | { readonly kind: 'input'; readonly name: string }
  | { readonly kind: 'output'; readonly node: string; readonly port: string }

export type GameplayValueRef = GameplayValue
export type GameplayModuleValue = GameplayValue

/**
 * The trusted registry adapter receives already validated, serialized source
 * expressions.  The author graph cannot provide this function or its result.
 */
export type GameplayNativeLoweringContext = {
  readonly surface: GameplayModuleSurface
  readonly callId: string
  readonly moduleId: string
  readonly moduleVersion: string
  readonly inputs: Readonly<Record<string, string>>
  readonly parameters: Readonly<Record<string, GameplayLiteral>>
  readonly outputPorts: readonly GameplayPort[]
  readonly emitLiteral: (value: GameplayLiteral) => string
}

export type GameplayNativeLoweringResult =
  | string
  | {
      /** JavaScript expression returning the module result record. */
      readonly expression: string
      readonly dependencies?: readonly string[]
    }
  | {
      /** Trusted statements.  `result` names the result expression if needed. */
      readonly statements: string
      readonly result?: string
      readonly dependencies?: readonly string[]
    }

export type GameplayNativeLowering = (
  context: GameplayNativeLoweringContext,
) => GameplayNativeLoweringResult

export type GameplayModuleLowering = GameplayNativeLowering

/** A registry descriptor is trusted host code plus editor-readable metadata. */
export type GameplayModuleDescriptor = {
  readonly id: string
  readonly version: string
  readonly label: string
  readonly description?: string
  readonly uiDescription?: string
  readonly inputs: readonly GameplayPort[]
  readonly outputs: readonly GameplayPort[]
  readonly parameters?: readonly GameplayParameter[]
  /**
   * Native query inputs that inspect reference validity themselves.  This is
   * trusted registry metadata; author graphs and composites cannot declare it.
   */
  readonly inspectReferences?: readonly string[]
  readonly allowedSurfaces: readonly GameplayModuleSurface[]
  readonly effects: GameplayEffectMetadata
  readonly ui?: {
    readonly description?: string
    readonly category?: string
    readonly icon?: string
  }
  /** Trusted adapter owned by the host registry, never supplied by authors. */
  readonly lower: GameplayNativeLowering
}

export type RegisteredGameplayModule = GameplayModuleDescriptor
export type GameplayNativeModuleDescriptor = GameplayModuleDescriptor

/**
 * The compiler accepts a structural registry to avoid importing the catalog.
 * A catalog may expose `get`, `resolve`, a descriptor map, or a descriptor
 * list.  At least one lookup form must be present at runtime.
 */
export type GameplayModuleRegistry =
  | ReadonlyMap<string, GameplayModuleDescriptor | readonly GameplayModuleDescriptor[]>
  | {
      readonly get?: (
        id: string,
        version?: string,
      ) => GameplayModuleDescriptor | readonly GameplayModuleDescriptor[] | undefined
      readonly resolve?: (
        id: string,
        version?: string,
      ) => GameplayModuleDescriptor | readonly GameplayModuleDescriptor[] | undefined
      readonly descriptors?: readonly GameplayModuleDescriptor[]
  }

export type ModuleRegistry = GameplayModuleRegistry

export type GameplayCallStatement = {
  readonly kind: 'call'
  readonly id: string
  readonly module: string
  readonly version: string
  readonly inputs?: Readonly<Record<string, GameplayValue>>
  readonly parameters?: Readonly<Record<string, GameplayLiteral>>
  readonly layout?: Readonly<Record<string, GameplayJsonValue>>
}

export type GameplayIfStatement = {
  readonly kind: 'if'
  readonly id: string
  readonly condition: GameplayValue
  readonly then: readonly GameplayStatement[]
  readonly else?: readonly GameplayStatement[]
  readonly layout?: Readonly<Record<string, GameplayJsonValue>>
}

export type GameplayForeachStatement = {
  readonly kind: 'foreach'
  readonly id: string
  readonly items: GameplayValue
  /** The loop item is available in the body as output `{ node: id, port: "item" }`. */
  readonly item?: string
  /** The loop index is available in the body as output `{ node: id, port: "index" }`. */
  readonly index?: string
  readonly body: readonly GameplayStatement[]
  readonly layout?: Readonly<Record<string, GameplayJsonValue>>
}

export type GameplayReturnStatement = {
  readonly kind: 'return'
  readonly id: string
  /** Values are keyed by the graph's declared output names. */
  readonly values?: Readonly<Record<string, GameplayValue>>
  /** A scalar return is useful for graphs with no named output ports. */
  readonly value?: GameplayValue
  readonly layout?: Readonly<Record<string, GameplayJsonValue>>
}

export type GameplayStatement =
  | GameplayCallStatement
  | GameplayIfStatement
  | GameplayForeachStatement
  | GameplayReturnStatement

export type GameplayModuleStatement = GameplayStatement

export type GameplayCompositeDefinition = {
  readonly id: string
  readonly version: string
  readonly label?: string
  readonly description?: string
  readonly inputs: readonly GameplayPort[]
  readonly outputs: readonly GameplayPort[]
  readonly parameters?: readonly GameplayParameter[]
  readonly allowedSurfaces?: readonly GameplayModuleSurface[]
  readonly body: readonly GameplayStatement[]
  readonly layout?: Readonly<Record<string, GameplayJsonValue>>
}

export type GameplayCompositeModule = GameplayCompositeDefinition

export type GameplayModuleGraph = {
  readonly version: typeof GAMEPLAY_MODULE_GRAPH_VERSION
  readonly surface: GameplayModuleSurface
  readonly inputs?: readonly GameplayPort[]
  /** Root inputs are static bindings or one of the fixed preview host inputs. */
  readonly inputBindings?: Readonly<Record<string, GameplayLiteral>>
  readonly outputs?: readonly GameplayPort[]
  readonly body: readonly GameplayStatement[]
  readonly composites?: readonly GameplayCompositeDefinition[]
  readonly layout?: Readonly<Record<string, GameplayJsonValue>>
}

export type GameplayGraph = GameplayModuleGraph

export type GameplayModuleDependency = {
  readonly id: string
  readonly version: string
  readonly kind: 'native' | 'composite'
}

export type GameplayExpandedCall = GameplayModuleDependency & {
  readonly callId: string
  readonly depth: number
}

export type GameplayExpandedModuleGraph = {
  readonly surface: GameplayModuleSurface
  readonly calls: readonly GameplayExpandedCall[]
}

export type GameplayModuleCompileResult = {
  readonly compilerVersion: typeof GAMEPLAY_MODULE_COMPILER_VERSION
  readonly graphVersion: typeof GAMEPLAY_MODULE_GRAPH_VERSION
  readonly surface: GameplayModuleSurface
  readonly code: string
  readonly source: string
  readonly dependencies: readonly GameplayModuleDependency[]
  readonly expanded: GameplayExpandedModuleGraph
  readonly diagnostics: readonly string[]
}

export type CompiledGameplayModule = GameplayModuleCompileResult

export type GameplayModuleCompilerOptions = {
  readonly maxCompositeDepth?: number
  readonly maxExpandedStatements?: number
  readonly maxExpandedCalls?: number
  readonly maxLiteralBytes?: number
}

export type ModuleCompilerOptions = GameplayModuleCompilerOptions

export class GameplayModuleCompileError extends Error {
  readonly path?: string
  readonly code: string

  constructor(message: string, path?: string, code = 'GAMEPLAY_MODULE_INVALID') {
    super(path ? `${message} (${path})` : message)
    this.name = 'GameplayModuleCompileError'
    this.path = path
    this.code = code
  }
}

/** Minimal starter used by editors and tests. */
export function createGameplayModuleGraph(surface: GameplayModuleSurface): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface,
    inputs: [],
    inputBindings: {},
    outputs: [],
    body: [],
    composites: [],
  }
}
