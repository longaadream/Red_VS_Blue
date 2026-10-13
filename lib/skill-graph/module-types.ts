/**
 * Author-facing semantic gameplay modules.
 *
 * This file is deliberately data-only.  A graph can refer to named inputs and
 * outputs, registered module calls, and structured control flow, but it never
 * carries JavaScript source, arbitrary host-object paths, or callable values.
 * Custom extension paths remain validated data within their named store. Trusted native
 * lowering lives on the registry descriptor and is only invoked by the
 * compiler.
 */

export const GAMEPLAY_MODULE_GRAPH_VERSION = 'rvb-gameplay-modules/v1' as const
/** The v1 emitter is retained for validating and replaying existing artifacts. */
export const GAMEPLAY_MODULE_COMPILER_V1_VERSION = 'rvb-gameplay-module-compiler/v1' as const
/** New documents use the fault-isolating v2 emitter. */
export const GAMEPLAY_MODULE_COMPILER_V2_VERSION = 'rvb-gameplay-module-compiler/v2' as const
export const GAMEPLAY_MODULE_COMPILER_V3_VERSION = 'rvb-gameplay-module-compiler/v3' as const
export const GAMEPLAY_MODULE_COMPILER_VERSION = GAMEPLAY_MODULE_COMPILER_V3_VERSION
export type GameplayModuleCompilerVersion = typeof GAMEPLAY_MODULE_COMPILER_V1_VERSION | typeof GAMEPLAY_MODULE_COMPILER_V2_VERSION | typeof GAMEPLAY_MODULE_COMPILER_V3_VERSION

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
  | { readonly kind: 'set'; readonly element: GameplayValueType }
  | { readonly kind: 'map'; readonly key: GameplayValueType; readonly value: GameplayValueType }
  | { readonly kind: 'nullable'; readonly value: GameplayValueType }
  /** A record whose shape is declared by the containing graph schema table. */
  | { readonly kind: 'record'; readonly schema: string }

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
  readonly recordSchemas?: readonly GameplayRecordSchema[]
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
  /** Trusted generic output bindings; author content cannot override them. */
  readonly outputTypeBindings?: Readonly<Record<string, {
    readonly input: string
    readonly projection: 'same' | 'element' | 'singleton'
  }>>
  /** Closed author-declared record schemas, selected by a string parameter. */
  readonly outputSchemaBindings?: Readonly<Record<string, { readonly parameter: string; readonly list?: boolean }>>
  readonly inputSchemaBindings?: Readonly<Record<string, { readonly parameter: string; readonly list?: boolean }>>
  /** Closed value type chosen by the type editor; never a script or arbitrary runtime type. */
  readonly outputValueTypeBindings?: Readonly<Record<string, { readonly parameter: string }>>
  readonly inputValueTypeBindings?: Readonly<Record<string, { readonly parameter: string; readonly nullable?: boolean }>>
  /**
   * Trusted closed field selectors.  A literal parameter selects one of the
   * registered value types; authors cannot provide a runtime property path or
   * alter this table from a graph.
   */
  readonly outputParameterTypeBindings?: Readonly<Record<string, {
    readonly parameter: string
    readonly types: Readonly<Record<string, GameplayValueType>>
  }>>
  readonly parameters?: readonly GameplayParameter[]
  /**
   * Native query inputs that inspect reference validity themselves.  This is
   * trusted registry metadata; author graphs and composites cannot declare it.
   */
  readonly inspectReferences?: readonly string[]
  /**
   * Native inputs that require a currently present, living piece.  This is
   * trusted registry metadata; author graphs and composites cannot declare it.
   */
  readonly livingReferences?: readonly string[]
  readonly allowedSurfaces: readonly GameplayModuleSurface[]
  readonly effects: GameplayEffectMetadata
  readonly ui?: {
    readonly description?: string
    readonly category?: string
    readonly icon?: string
    /** Compatibility adapters load old resources internally; never offer them for new authoring. */
    readonly authoring?: 'standard' | 'compatibility'
    /** Derive a hidden type parameter from a trusted closed field selector. */
    readonly parameterTypeBindings?: Readonly<Record<string, {
      readonly parameter: string
      readonly types: Readonly<Record<string, GameplayValueType>>
    }>>
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
  /** Group matching visual facts without changing effect order. No escaping return or pending choice is allowed in this scope. */
  readonly presentation?: 'statusAdded' | 'statusRemoved' | 'tileEffectAdded' | 'tileEffectRemoved'
  readonly body: readonly GameplayStatement[]
  readonly layout?: Readonly<Record<string, GameplayJsonValue>>
}

/**
 * A closed, data-only condition subprocess for a bounded while statement.
 * Values from the surrounding graph must be passed explicitly through
 * `inputs`; the subprocess returns its boolean through a scalar return.
 */
export type GameplayWhileCondition = {
  readonly inputs?: Readonly<Record<string, GameplayValue>>
  readonly body: readonly GameplayStatement[]
}

/**
 * A bounded native while loop.  The condition is re-evaluated before every
 * iteration and may only call pure/query modules.  `index` is an optional
 * body input name; the loop output `{ node: id, port: "index" }` is always
 * available to body statements.
 */
export type GameplayWhileStatement = {
  readonly kind: 'while'
  readonly id: string
  readonly condition: GameplayWhileCondition
  readonly index?: string
  readonly budget: number
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

/** A graph-local typed record schema.  Field names and types are closed. */
export type GameplayRecordSchema = {
  readonly id: string
  readonly version: string
  readonly fields: readonly GameplayPort[]
}

export type GameplayStructuredRecordSchema = GameplayRecordSchema

export type GameplayRecordCreateStatement = {
  readonly kind: 'record.create'
  readonly id: string
  readonly schema: string
  readonly fields?: Readonly<Record<string, GameplayValue>>
}

export type GameplayRecordGetStatement = {
  readonly kind: 'record.get'
  readonly id: string
  readonly record: GameplayValue
  readonly field: string
}

export type GameplayRecordWithStatement = {
  readonly kind: 'record.with'
  readonly id: string
  readonly record: GameplayValue
  readonly fields?: Readonly<Record<string, GameplayValue>>
}

export type GameplayCollectionMethod = 'map' | 'filter' | 'reduce' | 'find'

/**
 * A bounded, data-only collection subprocess.  `inputs` are the only values
 * captured from the surrounding graph; item/index/accumulator are local
 * inputs whose names default to the corresponding canonical names.
 */
export type GameplayCollectionStatement = {
  readonly kind: 'collection'
  readonly id: string
  readonly method: GameplayCollectionMethod
  readonly items: GameplayValue
  readonly inputs?: Readonly<Record<string, GameplayValue>>
  readonly item?: string
  readonly index?: string
  readonly accumulator?: string
  readonly initial?: GameplayValue
  readonly body: readonly GameplayStatement[]
}

/** Alternate discriminators are accepted by the parser and normalize to the
 * single collection statement above. */
export type GameplayCollectionMapStatement = Omit<GameplayCollectionStatement, 'kind' | 'method' | 'accumulator' | 'initial'> & {
  readonly kind: 'collection.map'
}
export type GameplayCollectionFilterStatement = Omit<GameplayCollectionStatement, 'kind' | 'method' | 'accumulator' | 'initial'> & {
  readonly kind: 'collection.filter'
}
export type GameplayCollectionFindStatement = Omit<GameplayCollectionStatement, 'kind' | 'method' | 'accumulator' | 'initial'> & {
  readonly kind: 'collection.find'
}
export type GameplayCollectionReduceStatement = Omit<GameplayCollectionStatement, 'kind' | 'method'> & {
  readonly kind: 'collection.reduce'
}

export type GameplayPendingHostBindingName =
  | 'payload'
  | 'selectedTargets'
  | 'targetCell'
  | 'targetPiece'
  | 'sourcePiece'
  | 'player'

export type GameplayPendingHostBindings = Readonly<Partial<Record<GameplayPendingHostBindingName, GameplayValueType | GameplayPort>>>

/** The typed fields retained by the legacy pending target-selection envelope. */
export type GameplayDeferChoiceStatement = {
  readonly kind: 'defer-choice'
  readonly id: string
  readonly graph: string
  /** Typed continuation payload.  The compiler never accepts raw source here. */
  readonly payload: GameplayValue
  readonly player?: GameplayValue
  readonly title?: GameplayValue
  readonly targetType?: GameplayValue
  /** Optional host target protocol constraints retained in the pending envelope. */
  readonly range?: GameplayValue
  readonly filter?: GameplayValue
  readonly candidates?: GameplayValue
  readonly selectionMode?: GameplayValue
  readonly min?: GameplayValue
  readonly max?: GameplayValue
  readonly minSelections?: GameplayValue
  readonly maxSelections?: GameplayValue
  readonly canCancel?: GameplayValue
  readonly resumeOnCancel?: GameplayValue
  readonly message?: GameplayValue
}

/** A pending graph owned by its parent graph and addressable by graph id. */
export type GameplayContinuationDefinition = {
  readonly id: string
  readonly version: string
  readonly graph: GameplayModuleGraph
  readonly payloadType?: GameplayValueType
  /** Runtime JSON alias accepted by the compiler for payloadType. */
  readonly payload?: GameplayValueType
}

export type GameplayStatement =
  | GameplayCallStatement
  | GameplayIfStatement
  | GameplayForeachStatement
  | GameplayWhileStatement
  | GameplayRecordCreateStatement
  | GameplayRecordGetStatement
  | GameplayRecordWithStatement
  | GameplayCollectionStatement
  | GameplayCollectionMapStatement
  | GameplayCollectionFilterStatement
  | GameplayCollectionFindStatement
  | GameplayCollectionReduceStatement
  | GameplayDeferChoiceStatement
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
  readonly schemas?: readonly GameplayRecordSchema[]
  readonly hostBindings?: GameplayPendingHostBindings
  readonly continuations?: readonly GameplayContinuationDefinition[]
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
  readonly compilerVersion: GameplayModuleCompilerVersion
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
  /** Maximum number of iterations a structured collection may execute. */
  readonly maxCollectionIterations?: number
  /** Maximum explicit budget accepted by a structured while statement. */
  readonly maxWhileIterations?: number
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
    schemas: [],
    continuations: [],
  }
}
