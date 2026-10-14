/**
 * Versioned, data-only content graph compiler.
 *
 * Content graphs deliberately describe a small control-flow language.  They do
 * not contain JavaScript snippets and this module never evaluates authored
 * content.  The generated source is consumed by the existing trusted
 * SkillCode runtime; this compiler does not add a second runtime.
 */

export const CONTENT_GRAPH_VERSION = 'rvb-content-graph/v1' as const
export const CONTENT_GRAPH_COMPILER_VERSION = 'rvb-content-graph-compiler/v1' as const
/** Compatibility names used by build/audit tooling. */
export const GRAPH_VERSION = CONTENT_GRAPH_VERSION
export const GRAPH_COMPILER_VERSION = CONTENT_GRAPH_COMPILER_VERSION

export type ContentGraphSurface =
  | 'skill'
  | 'card'
  | 'rule'
  | 'triggerSkill'
  | 'pending'
  | 'preview'

/** Undefined has a canonical expression form for JSON artifacts, but remains
 * accepted as a literal value for in-memory compiler callers. */
export type ContentGraphPrimitive = string | number | boolean | null | undefined

export type ContentGraphExpression =
  | { kind: 'literal'; value: ContentGraphPrimitive }
  | { kind: 'undefined' }
  | { kind: 'ref'; name: string }
  | { kind: 'get'; object: ContentGraphExpression; key: string }
  | { kind: 'index'; object: ContentGraphExpression; index: ContentGraphExpression }
  | { kind: 'array'; items: ContentGraphExpression[] }
  | { kind: 'object'; entries: Record<string, ContentGraphExpression> | ContentGraphObjectEntry[] }
  | { kind: 'binary'; op?: ContentGraphBinaryOperator; operator?: ContentGraphBinaryOperator; left: ContentGraphExpression; right: ContentGraphExpression }
  | { kind: 'unary'; op?: ContentGraphUnaryOperator; operator?: ContentGraphUnaryOperator; argument: ContentGraphExpression }
  | { kind: 'conditional'; test: ContentGraphExpression; consequent: ContentGraphExpression; alternate: ContentGraphExpression }
  | { kind: 'call'; callee: ContentGraphPureCall; args: ContentGraphExpression[] }
  | { kind: 'capabilityType'; capability: string }
  | { kind: 'template'; head: string; spans: ContentGraphExpression[]; tails: string[] }
  | { kind: 'boundMethod'; object: ContentGraphExpression; method: ContentGraphBoundMethod }
  | { kind: 'source'; graph: ContentGraph }
  | { kind: 'lambda'; parameters: string[]; body: ContentGraphExpression }
  | { kind: 'function'; parameters: string[]; body: ContentGraphFunctionGraph }
  | { kind: 'collection'; object: ContentGraphExpression; method: ContentGraphCollectionMethod; args: ContentGraphExpression[] }

export type ContentGraphObjectEntry = { key: string; value: ContentGraphExpression }

export type ContentGraphBinaryOperator =
  | '+' | '-' | '*' | '/' | '%' | '**'
  | '===' | '!==' | '==' | '!='
  | '<' | '<=' | '>' | '>='
  | '&&' | '||' | '??'
  | '|' | '&' | '^' | '<<' | '>>' | '>>>'

export type ContentGraphUnaryOperator = '!' | '+' | '-' | '~' | 'typeof'

export type ContentGraphPureCall =
  | 'Math.abs'
  | 'Math.ceil'
  | 'Math.floor'
  | 'Math.max'
  | 'Math.min'
  | 'Math.pow'
  | 'Math.round'
  | 'Math.sign'
  | 'Math.trunc'
  | 'Number'
  | 'Number.isFinite'
  | 'Number.isInteger'
  | 'String'
  | 'Boolean'
  | 'Array.isArray'
  | 'arePlayersAllied'
  | 'nextEnemyPlayer'
  | 'canAffectAdventureTarget'

export type ContentGraphCollectionMethod =
  | 'find' | 'filter' | 'some' | 'every' | 'map'
  | 'includes' | 'indexOf' | 'join' | 'slice' | 'concat' | 'reduce' | 'toLowerCase' | 'toUpperCase' | 'split'
  | 'startsWith' | 'trim' | 'localeCompare'

export type ContentGraphBoundMethod = ContentGraphCollectionMethod | ContentGraphInvokeMethod
  | 'push' | 'pop' | 'shift' | 'unshift' | 'splice' | 'sort' | 'reverse'

export type ContentGraphSetOperator = '=' | '+=' | '-=' | '*=' | '/='

export type ContentGraphSetTarget =
  | { kind: 'ref'; name: string }
  | { kind: 'get'; object: ContentGraphExpression; key: string }
  | { kind: 'index'; object: ContentGraphExpression; index: ContentGraphExpression }

export type ContentGraphNodeLayout = {
  /** Optional editor-only coordinates; never participate in compilation. */
  x?: number
  y?: number
}

export type ContentGraphLoopKind = 'for' | 'while'

export type ContentGraphInvokeMethod = 'forEach' | 'map' | 'filter' | 'find' | 'some' | 'every' | 'findIndex' | 'reduce'

/**
 * A callable target is deliberately narrower than a JavaScript call
 * expression.  Function values come from a validated graph function, while
 * array callbacks are restricted to the allowlisted collection methods whose
 * callback execution order is part of the graph contract.
 */
export type ContentGraphInvokeTarget =
  | { kind: 'function'; value: ContentGraphExpression }
  | { kind: 'array'; object: ContentGraphExpression; method: ContentGraphInvokeMethod }

export type ContentGraphInvokeNode = {
  id: string
  kind: 'invoke'
  target: ContentGraphInvokeTarget
  args: ContentGraphExpression[]
  result?: string
  next: string
} & ContentGraphNodeLayout

export type ContentGraphDeleteTarget =
  | { kind: 'get'; object: ContentGraphExpression; key: string }
  | { kind: 'index'; object: ContentGraphExpression; index: ContentGraphExpression }

export type ContentGraphDeleteNode = {
  id: string
  kind: 'delete'
  target: ContentGraphDeleteTarget
  result?: string
  next: string
} & ContentGraphNodeLayout

/** Materialize an independent card/pending graph with explicit JSON bindings. */
export type ContentGraphMaterializeSourceNode = {
  id: string
  kind: 'materializeSource'
  graph: ContentGraph
  bindings: Record<string, ContentGraphExpression>
  result?: string
  next: string
} & ContentGraphNodeLayout

export type ContentGraphThrowNode = {
  id: string
  kind: 'throw'
  value: ContentGraphExpression
} & ContentGraphNodeLayout

export type ContentGraphCatchClause = {
  /** Omit the parameter to model a JavaScript `catch { ... }` clause. */
  parameter?: string
  body: ContentGraphRegion
}

export type ContentGraphTryNode = {
  id: string
  kind: 'try'
  body: ContentGraphRegion
  catch?: ContentGraphCatchClause
  finally?: ContentGraphRegion
  next: string
} & ContentGraphNodeLayout

export type ContentGraphBreakNode = {
  id: string
  kind: 'break'
} & ContentGraphNodeLayout

export type ContentGraphContinueNode = {
  id: string
  kind: 'continue'
} & ContentGraphNodeLayout

export type ContentGraphRegionEndNode = {
  id: string
  kind: 'regionEnd'
} & ContentGraphNodeLayout

export type ContentGraphRegion = {
  /** The first node executed by this structured region. */
  entry: string
  /** The unique regionEnd node reached by normal fall-through. */
  end: string
  nodes: ContentGraphRegionNode[]
}

/** A function body is a structured graph, emitted inside a function scope. */
export type ContentGraphFunctionNode = ContentGraphRegionNode
export type ContentGraphFunctionGraph = {
  entry: string
  end: string
  nodes: ContentGraphFunctionNode[]
}

export type ContentGraphLoopNode = {
  id: string
  kind: 'loop'
  loop: ContentGraphLoopKind
  condition: ContentGraphExpression
  body: ContentGraphRegion
  /** A for-loop update region; while loops must omit this field. */
  update?: ContentGraphRegion
  next: string
} & ContentGraphNodeLayout

export type ContentGraphForOfLoopNode = {
  id: string
  kind: 'loop'
  loop: 'forOf'
  iterable: ContentGraphExpression
  item: string
  body: ContentGraphRegion
  next: string
} & ContentGraphNodeLayout

export type ContentGraphForInLoopNode = Omit<ContentGraphForOfLoopNode, 'loop'> & { loop: 'forIn' }
export type ContentGraphStructuredLoopNode = ContentGraphLoopNode | ContentGraphForOfLoopNode | ContentGraphForInLoopNode

export type ContentGraphRegionNode =
  | ContentGraphBindNode
  | ContentGraphCallNode
  | ContentGraphInvokeNode
  | ContentGraphDeleteNode
  | ContentGraphMaterializeSourceNode
  | ContentGraphThrowNode
  | ContentGraphTryNode
  | ContentGraphBranchNode
  | ContentGraphSetNode
  | ContentGraphStructuredLoopNode
  | ContentGraphReturnNode
  | ContentGraphBreakNode
  | ContentGraphContinueNode
  | ContentGraphRegionEndNode

export type ContentGraphNode =
  | ContentGraphBindNode
  | ContentGraphCallNode
  | ContentGraphInvokeNode
  | ContentGraphDeleteNode
  | ContentGraphMaterializeSourceNode
  | ContentGraphThrowNode
  | ContentGraphTryNode
  | ContentGraphBranchNode
  | ContentGraphSetNode
  | ContentGraphStructuredLoopNode
  | ContentGraphReturnNode

export type Expr = ContentGraphExpression
export type GraphNode = ContentGraphNode

export type ContentGraphBindNode = {
  id: string
  kind: 'bind'
  name: string
  expr?: ContentGraphExpression
  expression?: ContentGraphExpression
  value?: ContentGraphExpression
  next: string
} & ContentGraphNodeLayout

export type ContentGraphCallNode = {
  id: string
  kind: 'call'
  capability?: string
  helper?: string
  args: ContentGraphExpression[]
  result?: string
  next: string
} & ContentGraphNodeLayout

export type ContentGraphBranchNode = {
  id: string
  kind: 'branch'
  condition?: ContentGraphExpression
  test?: ContentGraphExpression
  yes: string
  no: string
} & ContentGraphNodeLayout

export type ContentGraphSetNode = {
  id: string
  kind: 'set'
  target: ContentGraphSetTarget
  operator: ContentGraphSetOperator
  value: ContentGraphExpression
  next: string
} & ContentGraphNodeLayout

export type ContentGraphReturnNode = {
  id: string
  kind: 'return'
  value?: ContentGraphExpression
  expr?: ContentGraphExpression
} & ContentGraphNodeLayout

export type ContentGraphMetadata = Record<string, unknown>

export type ContentGraph = {
  version: typeof CONTENT_GRAPH_VERSION
  surface: ContentGraphSurface
  entry: string
  nodes: ContentGraphNode[]
  /** Authoring metadata is separate from generated SkillCode. */
  metadata?: ContentGraphMetadata
}

export type CompiledContentGraph = {
  compilerVersion: typeof CONTENT_GRAPH_COMPILER_VERSION
  surface: ContentGraphSurface
  entry: string
  nodeOrder: string[]
  code: string
  /** Alias for callers that refer to generated source as source. */
  source: string
}

export type ContentGraphArtifact = Record<string, unknown> & {
  contentGraph?: ContentGraph
  contentGraphField?: string
  contentGraphCompilerVersion?: string
}

class ContentGraphCompileError extends Error {
  constructor(message: string) {
    super(`Content graph: ${message}`)
    this.name = 'ContentGraphCompileError'
  }
}

const fail = (message: string): never => { throw new ContentGraphCompileError(message) }
const own = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key)
const objectLike = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const safeIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const safeNodeIdentifier = /^[a-z][a-zA-Z0-9_-]{0,63}$/
const safePathSegment = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const unsafePathSegments = new Set(['__proto__', 'prototype', 'constructor', 'caller', 'callee', 'arguments'])
const reservedIdentifiers = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in',
  'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private', 'protected', 'public', 'return',
  'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'undefined',
])
const isSafeLocalIdentifier = (value: unknown): value is string => typeof value === 'string'
  && safeIdentifier.test(value) && !reservedIdentifiers.has(value) && !unsafePathSegments.has(value)

/** Bounds keep malformed or hostile graphs from consuming unbounded compiler resources. */
export const CONTENT_GRAPH_MAX_NODES = 1024
export const CONTENT_GRAPH_MAX_GRAPH_DEPTH = 512
export const CONTENT_GRAPH_MAX_EXPRESSION_NODES = 4096
export const CONTENT_GRAPH_MAX_EXPRESSION_DEPTH = 128

const binaryOperators = new Set<ContentGraphBinaryOperator>([
  '+', '-', '*', '/', '%', '**', '===', '!==', '==', '!=', '<', '<=', '>', '>=',
  '&&', '||', '??', '|', '&', '^', '<<', '>>', '>>>',
])
const unaryOperators = new Set<ContentGraphUnaryOperator>(['!', '+', '-', '~', 'typeof'])
const pureCalls = new Set<ContentGraphPureCall>([
  'Math.abs', 'Math.ceil', 'Math.floor', 'Math.max', 'Math.min', 'Math.pow',
  'Math.round', 'Math.sign', 'Math.trunc', 'Number', 'Number.isFinite', 'Number.isInteger', 'String', 'Boolean', 'Array.isArray',
  'arePlayersAllied', 'nextEnemyPlayer', 'canAffectAdventureTarget',
])

type PureCallSpec = {
  minArgs: number
  maxArgs: number
  resultType: ValueType
  argumentTypes?: readonly ValueType[]
}

const pureCallSpecs: Partial<Record<ContentGraphPureCall, PureCallSpec>> = {
  'Number.isFinite': { minArgs: 1, maxArgs: 1, resultType: 'boolean', argumentTypes: ['unknown'] },
  'Number.isInteger': { minArgs: 1, maxArgs: 1, resultType: 'boolean', argumentTypes: ['unknown'] },
  // These names are injected by DynamicCodeRuntime on every dynamic surface;
  // they remain pure reads over the supplied battle state.
  arePlayersAllied: { minArgs: 3, maxArgs: 3, resultType: 'boolean', argumentTypes: ['object', 'string', 'string'] },
  nextEnemyPlayer: { minArgs: 2, maxArgs: 2, resultType: 'unknown', argumentTypes: ['object', 'string'] },
  canAffectAdventureTarget: { minArgs: 3, maxArgs: 4, resultType: 'boolean', argumentTypes: ['object', 'string', 'unknown'] },
}

type ValueType = 'unknown' | 'undefined' | 'null' | 'string' | 'number' | 'boolean' | 'object' | 'array' | 'function' | 'piece' | 'cell' | 'damage' | 'heal' | 'selection'
type Definition = { nodeId: string; type: ValueType }
type ExpressionBudget = { nodes: number }

type CollectionSpec = {
  minArgs: number
  maxArgs: number
  callback?: boolean
  result: (base: ValueType) => ValueType
}

const collectionMethods: Readonly<Record<ContentGraphCollectionMethod, CollectionSpec>> = {
  find: { minArgs: 1, maxArgs: 1, callback: true, result: () => 'unknown' },
  filter: { minArgs: 1, maxArgs: 1, callback: true, result: () => 'array' },
  some: { minArgs: 1, maxArgs: 1, callback: true, result: () => 'boolean' },
  every: { minArgs: 1, maxArgs: 1, callback: true, result: () => 'boolean' },
  map: { minArgs: 1, maxArgs: 1, callback: true, result: () => 'array' },
  reduce: { minArgs: 1, maxArgs: 2, callback: true, result: () => 'unknown' },
  includes: { minArgs: 1, maxArgs: 1, result: () => 'boolean' },
  indexOf: { minArgs: 1, maxArgs: 1, result: () => 'number' },
  join: { minArgs: 0, maxArgs: 1, result: () => 'string' },
  slice: { minArgs: 0, maxArgs: 2, result: base => base === 'string' ? 'string' : 'array' },
  concat: { minArgs: 0, maxArgs: 8, result: base => base === 'string' ? 'string' : 'array' },
  toLowerCase: { minArgs: 0, maxArgs: 0, result: () => 'string' },
  toUpperCase: { minArgs: 0, maxArgs: 0, result: () => 'string' },
  split: { minArgs: 0, maxArgs: 2, result: () => 'array' },
  startsWith: { minArgs: 1, maxArgs: 2, result: () => 'boolean' },
  trim: { minArgs: 0, maxArgs: 0, result: () => 'string' },
  localeCompare: { minArgs: 1, maxArgs: 3, result: () => 'number' },
}

const boundArrayMethods = new Set<ContentGraphBoundMethod>([
  'find', 'filter', 'some', 'every', 'map', 'includes', 'indexOf', 'join', 'slice', 'concat',
  'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse',
  'forEach', 'findIndex', 'reduce',
])
const boundStringMethods = new Set<ContentGraphBoundMethod>([
  'includes', 'indexOf', 'slice', 'concat', 'toLowerCase', 'toUpperCase', 'split', 'startsWith', 'trim', 'localeCompare',
])

type CapabilitySpec = {
  surfaces: readonly ContentGraphSurface[]
  minArgs: number
  maxArgs: number
  resultType: ValueType
  emit: (args: string[]) => string
  argumentTypes?: readonly ValueType[]
}

const allSurfaces: readonly ContentGraphSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview']
const surfaceSet = new Set<ContentGraphSurface>(allSurfaces)
const flowSurfaces: readonly ContentGraphSurface[] = ['skill', 'card', 'rule', 'triggerSkill']
const legacyEffectSurfaces: readonly ContentGraphSurface[] = ['skill', 'card', 'rule', 'triggerSkill']
const dataEffectSurfaces: readonly ContentGraphSurface[] = [...legacyEffectSurfaces, 'pending']

const direct = (name: string, surfaces: readonly ContentGraphSurface[] = allSurfaces): CapabilitySpec => ({
  surfaces,
  minArgs: 0,
  maxArgs: Number.POSITIVE_INFINITY,
  resultType: 'unknown',
  emit: args => `${name}(${args.join(', ')})`,
})

/**
 * Capability names are intentionally explicit.  Adding a helper here is a
 * permission decision: it also needs an entry in the surface allow-list.
 */
const CAPABILITIES: Readonly<Record<string, CapabilitySpec>> = {
  // These use the existing host's injected deterministic Math/Date objects.
  // They are effect nodes so evaluation count and ordering remain observable.
  'Math.random': { ...direct('Math.random', dataEffectSurfaces), minArgs: 0, maxArgs: 0, resultType: 'number' },
  'Date.now': { ...direct('Date.now', dataEffectSurfaces), minArgs: 0, maxArgs: 0, resultType: 'number' },
  'collection.uniqueCount': { surfaces: dataEffectSurfaces, minArgs: 1, maxArgs: 1, resultType: 'number', emit: args => `(new globalThis.Set(${args[0]})).size` },
  'error.create': { surfaces: dataEffectSurfaces, minArgs: 0, maxArgs: 1, resultType: 'object', emit: args => `new globalThis.Error(${args.join(', ')})` },
  'Object.keys': { ...direct('Object.keys', dataEffectSurfaces), minArgs: 1, maxArgs: 1, resultType: 'array' },
  canPlaceAdventurePiece: { ...direct('canPlaceAdventurePiece', dataEffectSurfaces), minArgs: 4, maxArgs: 4, resultType: 'boolean' },
  'select.getPieceAt': { ...direct('select.getPieceAt', ['skill']), minArgs: 2, maxArgs: 2, resultType: 'unknown' },
  'ctx.flow.effects.displace': { ...direct('ctx.flow.effects.displace', ['pending']), minArgs: 1, maxArgs: 3, resultType: 'object' },
  'ctx.addStatusEffectById': { ...direct('ctx.addStatusEffectById', ['pending']), minArgs: 2, maxArgs: 2, resultType: 'unknown' },
  'ctx.addPlayerStatusEffectById': { ...direct('ctx.addPlayerStatusEffectById', ['pending']), minArgs: 2, maxArgs: 2, resultType: 'unknown' },
  'ctx.changePositions': { ...direct('ctx.changePositions', ['pending']), minArgs: 2, maxArgs: 2, resultType: 'object' },
  // Preserve JSON conversion at its original execution point. Stringification
  // may invoke toJSON, so it must not be treated as a pure expression.
  'JSON.parse': { ...direct('JSON.parse', legacyEffectSurfaces), minArgs: 1, maxArgs: 1 },
  'JSON.stringify': { ...direct('JSON.stringify', legacyEffectSurfaces), minArgs: 1, maxArgs: 1 },
  'console.log': direct('console.log', legacyEffectSurfaces),
  'console.error': direct('console.error', legacyEffectSurfaces),
  'context.forceRemoveEnemyPieceById': { ...direct('context.forceRemoveEnemyPieceById', ['skill']), minArgs: 1, maxArgs: 1, resultType: 'unknown' },
  'array.push': { surfaces: dataEffectSurfaces, minArgs: 1, maxArgs: Number.POSITIVE_INFINITY, resultType: 'number', emit: args => `(${args[0]}).push(${args.slice(1).join(', ')})` },
  'array.pop': { surfaces: dataEffectSurfaces, minArgs: 1, maxArgs: 1, resultType: 'unknown', emit: args => `(${args[0]}).pop()` },
  'array.shift': { surfaces: dataEffectSurfaces, minArgs: 1, maxArgs: 1, resultType: 'unknown', emit: args => `(${args[0]}).shift()` },
  'array.unshift': { surfaces: dataEffectSurfaces, minArgs: 1, maxArgs: Number.POSITIVE_INFINITY, resultType: 'number', emit: args => `(${args[0]}).unshift(${args.slice(1).join(', ')})` },
  'array.splice': { surfaces: dataEffectSurfaces, minArgs: 1, maxArgs: Number.POSITIVE_INFINITY, resultType: 'array', emit: args => `(${args[0]}).splice(${args.slice(1).join(', ')})` },
  'array.sort': { surfaces: dataEffectSurfaces, minArgs: 1, maxArgs: 2, resultType: 'array', emit: args => `(${args[0]}).sort(${args.slice(1).join(', ')})` },
  'array.reverse': { surfaces: dataEffectSurfaces, minArgs: 1, maxArgs: 1, resultType: 'array', emit: args => `(${args[0]}).reverse()` },
  'queue.damage': { ...direct('context.damageQueue.push', ['rule']), minArgs: 1, maxArgs: 1, resultType: 'number' },
  'queue.damageRedirect': { ...direct('context.damageRedirectQueue.push', ['rule']), minArgs: 1, maxArgs: 1, resultType: 'number' },
  'queue.presentation': { ...direct('context.presentationQueue.push', ['rule']), minArgs: 1, maxArgs: 1, resultType: 'number' },
  'queue.summon': { ...direct('context.summonQueue.push', ['rule', 'skill', 'card']), minArgs: 1, maxArgs: 1, resultType: 'number' },
  selectTarget: { ...direct('selectTarget', ['skill', 'card']), minArgs: 0, maxArgs: 1, resultType: 'selection', argumentTypes: ['object'] },
  selectOption: { ...direct('selectOption', ['skill', 'card', 'rule']), minArgs: 1, maxArgs: 1, resultType: 'selection', argumentTypes: ['object'] },
  dealDamage: { ...direct('dealDamage', legacyEffectSurfaces), minArgs: 3, maxArgs: 8, resultType: 'damage', argumentTypes: ['unknown', 'unknown', 'number'] },
  healDamage: { ...direct('healDamage', legacyEffectSurfaces), minArgs: 3, maxArgs: 5, resultType: 'heal', argumentTypes: ['unknown', 'unknown', 'number'] },
  teleport: { ...direct('teleport', ['skill', 'card']), minArgs: 0, maxArgs: 3, resultType: 'object' },
  queueHeal: {
    surfaces: ['rule'], minArgs: 1, maxArgs: 4, resultType: 'number',
    emit: args => args.length === 1 ? `context.healQueue.push(${args[0]})`
      : `context.healQueue.push({ healer: ${args[0]}, target: ${args[1]}, heal: ${args[2]}${args[3] === undefined ? '' : `, skillId: ${args[3]}`} })`,
  },
  'queue.heal': {
    surfaces: ['rule'], minArgs: 1, maxArgs: 4, resultType: 'number',
    emit: args => args.length === 1 ? `context.healQueue.push(${args[0]})`
      : `context.healQueue.push({ healer: ${args[0]}, target: ${args[1]}, heal: ${args[2]}${args[3] === undefined ? '' : `, skillId: ${args[3]}`} })`,
  },

  'flow.effects.damage': { ...direct('flow.effects.damage', flowSurfaces), minArgs: 3, maxArgs: 5, resultType: 'damage', argumentTypes: ['unknown', 'string', 'number'] },
  'flow.effects.heal': { ...direct('flow.effects.heal', flowSurfaces), minArgs: 3, maxArgs: 4, resultType: 'heal', argumentTypes: ['unknown', 'string', 'number'] },
  'flow.effects.move': { ...direct('flow.effects.move', flowSurfaces), minArgs: 1, maxArgs: 3, resultType: 'object' },
  'flow.effects.freeMove': { ...direct('flow.effects.freeMove', flowSurfaces), minArgs: 2, maxArgs: 2, resultType: 'object', argumentTypes: ['string', 'object'] },
  'flow.effects.displace': { ...direct('flow.effects.displace', flowSurfaces), minArgs: 1, maxArgs: 3, resultType: 'object' },
  'flow.effects.tileBatch': { ...direct('flow.effects.tileBatch', flowSurfaces), minArgs: 1, maxArgs: 2, resultType: 'object' },
  'flow.effects.destroyWalls': { ...direct('flow.effects.destroyWalls', flowSurfaces), minArgs: 1, maxArgs: 2, resultType: 'object' },
  'flow.status.add': { ...direct('flow.status.add', flowSurfaces), minArgs: 2, maxArgs: 3, resultType: 'unknown' },
  'flow.status.remove': { ...direct('flow.status.remove', flowSurfaces), minArgs: 2, maxArgs: 3, resultType: 'unknown' },
  'flow.rules.add': { ...direct('flow.rules.add', flowSurfaces), minArgs: 2, maxArgs: 3, resultType: 'unknown' },
  'flow.rules.remove': { ...direct('flow.rules.remove', flowSurfaces), minArgs: 2, maxArgs: 3, resultType: 'unknown' },
  'flow.resources.add': { ...direct('flow.resources.add', flowSurfaces), minArgs: 3, maxArgs: 3, resultType: 'number', argumentTypes: ['string', 'string', 'number'] },
  'flow.state.get': { ...direct('flow.state.get', flowSurfaces), minArgs: 4, maxArgs: 4, resultType: 'unknown' },
  'flow.state.set': { ...direct('flow.state.set', flowSurfaces), minArgs: 5, maxArgs: 6, resultType: 'unknown' },
  'flow.state.remove': { ...direct('flow.state.remove', flowSurfaces), minArgs: 4, maxArgs: 4, resultType: 'unknown' },
  'flow.state.cleanup': { ...direct('flow.state.cleanup', flowSurfaces), minArgs: 0, maxArgs: 0, resultType: 'unknown' },
  'flow.event.modify': { ...direct('flow.event.modify', flowSurfaces), minArgs: 2, maxArgs: 2, resultType: 'unknown' },
  'flow.event.read': { ...direct('flow.event.read', flowSurfaces), minArgs: 0, maxArgs: 0, resultType: 'object' },
  'flow.event.block': { ...direct('flow.event.block', flowSurfaces), minArgs: 0, maxArgs: 1, resultType: 'object' },
  'flow.event.emit': { ...direct('flow.event.emit', flowSurfaces), minArgs: 1, maxArgs: 2, resultType: 'unknown' },
  'flow.choice.target': { ...direct('flow.choice.target', ['skill', 'card']), minArgs: 1, maxArgs: 1, resultType: 'selection' },
  'flow.choice.option': { ...direct('flow.choice.option', ['skill', 'card', 'rule']), minArgs: 1, maxArgs: 1, resultType: 'selection' },
  'flow.choice.deferTarget': { ...direct('flow.choice.deferTarget', ['rule']), minArgs: 1, maxArgs: 1, resultType: 'object' },
  'flow.query.piece': { ...direct('flow.query.piece', flowSurfaces), minArgs: 1, maxArgs: 1, resultType: 'piece', argumentTypes: ['string'] },
  'flow.query.player': { ...direct('flow.query.player', flowSurfaces), minArgs: 1, maxArgs: 1, resultType: 'object', argumentTypes: ['string'] },
  'flow.query.pieces': { ...direct('flow.query.pieces', flowSurfaces), minArgs: 0, maxArgs: 1, resultType: 'array' },
  'flow.query.distance': { ...direct('flow.query.distance', flowSurfaces), minArgs: 2, maxArgs: 2, resultType: 'number' },
  'flow.query.random': { ...direct('flow.query.random', flowSurfaces), minArgs: 1, maxArgs: 1, resultType: 'unknown' },
  'flow.query.path': { ...direct('flow.query.path', flowSurfaces), minArgs: 2, maxArgs: 3, resultType: 'object' },
  'flow.query.normalMoveTargets': { ...direct('flow.query.normalMoveTargets', flowSurfaces), minArgs: 1, maxArgs: 1, resultType: 'array', argumentTypes: ['string'] },
  'flow.query.tracePath': { ...direct('flow.query.tracePath', flowSurfaces), minArgs: 2, maxArgs: 3, resultType: 'object' },
  'flow.query.landingCells': { ...direct('flow.query.landingCells', flowSurfaces), minArgs: 1, maxArgs: 2, resultType: 'array' },
  'flow.refs.holder': { ...direct('flow.refs.holder', flowSurfaces), minArgs: 0, maxArgs: 0, resultType: 'string' },
  'flow.refs.source': { ...direct('flow.refs.source', flowSurfaces), minArgs: 0, maxArgs: 0, resultType: 'string' },
  'flow.refs.target': { ...direct('flow.refs.target', flowSurfaces), minArgs: 0, maxArgs: 0, resultType: 'string' },
  'flow.refs.player': { ...direct('flow.refs.player', flowSurfaces), minArgs: 0, maxArgs: 0, resultType: 'string' },
  'flow.refs.eventPlayer': { ...direct('flow.refs.eventPlayer', flowSurfaces), minArgs: 0, maxArgs: 0, resultType: 'string' },
  'flow.cards.hand': { ...direct('flow.cards.hand', flowSurfaces), minArgs: 1, maxArgs: 1, resultType: 'array' },
  'flow.cards.add': { ...direct('flow.cards.add', flowSurfaces), minArgs: 2, maxArgs: 2, resultType: 'unknown' },
  'flow.cards.discard': { ...direct('flow.cards.discard', flowSurfaces), minArgs: 1, maxArgs: 1, resultType: 'unknown' },
  'flow.attributes.add': { ...direct('flow.attributes.add', flowSurfaces), minArgs: 3, maxArgs: 3, resultType: 'number' },
  'flow.attributes.percent': { ...direct('flow.attributes.percent', flowSurfaces), minArgs: 3, maxArgs: 3, resultType: 'number' },
  'flow.skills.add': { ...direct('flow.skills.add', flowSurfaces), minArgs: 2, maxArgs: 2, resultType: 'unknown' },
  'flow.skills.remove': { ...direct('flow.skills.remove', flowSurfaces), minArgs: 2, maxArgs: 2, resultType: 'unknown' },
  'flow.skills.resetCooldown': { ...direct('flow.skills.resetCooldown', flowSurfaces), minArgs: 1, maxArgs: 2, resultType: 'unknown' },
  'flow.lifecycle.summon': { ...direct('flow.lifecycle.summon', flowSurfaces), minArgs: 1, maxArgs: 1, resultType: 'unknown' },
  'flow.lifecycle.reviveAfterDeath': { ...direct('flow.lifecycle.reviveAfterDeath', ['rule', 'triggerSkill']), minArgs: 0, maxArgs: 2, resultType: 'object' },
  'flow.lifecycle.removeEnemy': { ...direct('flow.lifecycle.removeEnemy', ['skill']), minArgs: 1, maxArgs: 1, resultType: 'unknown' },

  addStatusEffectById: { ...direct('addStatusEffectById', legacyEffectSurfaces), minArgs: 2, maxArgs: 2, resultType: 'unknown' },
  removeStatusEffectById: { ...direct('removeStatusEffectById', legacyEffectSurfaces), minArgs: 2, maxArgs: 2, resultType: 'unknown' },
  addPlayerStatusEffectById: { ...direct('addPlayerStatusEffectById', legacyEffectSurfaces), minArgs: 2, maxArgs: 2, resultType: 'unknown' },
  removePlayerStatusEffectById: { ...direct('removePlayerStatusEffectById', legacyEffectSurfaces), minArgs: 2, maxArgs: 2, resultType: 'unknown' },
  addRuleById: { ...direct('addRuleById', legacyEffectSurfaces), minArgs: 2, maxArgs: 2, resultType: 'unknown' },
  removeRuleById: { ...direct('removeRuleById', legacyEffectSurfaces), minArgs: 2, maxArgs: 2, resultType: 'unknown' },
  addPlayerRuleById: { ...direct('addPlayerRuleById', legacyEffectSurfaces), minArgs: 2, maxArgs: 2, resultType: 'unknown' },
  removePlayerRuleById: { ...direct('removePlayerRuleById', legacyEffectSurfaces), minArgs: 2, maxArgs: 2, resultType: 'unknown' },
  addSkillById: { ...direct('addSkillById', legacyEffectSurfaces), minArgs: 2, maxArgs: 2, resultType: 'unknown' },
  removeSkillById: { ...direct('removeSkillById', legacyEffectSurfaces), minArgs: 2, maxArgs: 2, resultType: 'unknown' },
  addPlayerSkillById: { ...direct('addPlayerSkillById', legacyEffectSurfaces), minArgs: 2, maxArgs: 2, resultType: 'unknown' },
  removePlayerSkillById: { ...direct('removePlayerSkillById', legacyEffectSurfaces), minArgs: 2, maxArgs: 2, resultType: 'unknown' },
  addCardToHand: { ...direct('addCardToHand', legacyEffectSurfaces), minArgs: 1, maxArgs: 2, resultType: 'unknown' },
  getHand: { ...direct('getHand', ['skill', 'card', 'triggerSkill']), minArgs: 0, maxArgs: 1, resultType: 'array' },
  discardCard: { ...direct('discardCard', legacyEffectSurfaces), minArgs: 1, maxArgs: 1, resultType: 'unknown' },
  fireEvent: { ...direct('fireEvent', ['skill', 'card', 'rule', 'triggerSkill']), minArgs: 1, maxArgs: 2, resultType: 'unknown' },
  traceProjectile: { ...direct('traceProjectile', ['skill', 'card', 'triggerSkill']), minArgs: 2, maxArgs: 3, resultType: 'array' },
  calculateDistance: { ...direct('calculateDistance', ['skill', 'card', 'triggerSkill', 'preview']), minArgs: 2, maxArgs: 2, resultType: 'number' },
}

export type ContentGraphCapabilityDescriptor = {
  surfaces: readonly ContentGraphSurface[]
  minArgs: number
  maxArgs: number
  resultType: string
}

export const CONTENT_GRAPH_CAPABILITIES: Readonly<Record<string, ContentGraphCapabilityDescriptor>> = Object.freeze(
  Object.fromEntries(Object.entries(CAPABILITIES).map(([name, spec]) => [name, Object.freeze({
    surfaces: Object.freeze([...spec.surfaces]),
    minArgs: spec.minArgs,
    maxArgs: spec.maxArgs,
    resultType: spec.resultType,
  })])),
)
export const CONTENT_GRAPH_CAPABILITY_REGISTRY = CONTENT_GRAPH_CAPABILITIES

type ValidatedGraph = {
  graph: ContentGraph
  byId: Map<string, ContentGraphNode>
  ordered: ContentGraphNode[]
  incoming: Map<string, string[]>
  dominators: Map<string, Set<string>>
  definitions: Map<string, Definition>
  localNames: Set<string>
  regions: WeakMap<ContentGraphRegion, ValidatedRegion>
  /** Explicit binding inputs supplied by a materialized child graph. */
  externalBindings: ReadonlyMap<string, Definition>
  /** Child graphs are retained by node id so emission cannot inherit parent scope. */
  nestedGraphs: Map<string, ValidatedGraph>
}

type ValidatedRegion = {
  region: ContentGraphRegion
  byId: Map<string, ContentGraphRegionNode>
  ordered: ContentGraphRegionNode[]
  incoming: Map<string, string[]>
  dominators: Map<string, Set<string>>
  definitions: Map<string, Definition>
  /** Names declared in this lexical scope, including nested regions. */
  scopeNames?: Set<string>
}

type RegionValidationState = {
  seenIds: Set<string>
  localNames: Set<string>
  regions: WeakMap<ContentGraphRegion, ValidatedRegion>
  expressionBudget: ExpressionBudget
  totalNodes: { value: number }
  activeGraphs: Set<object>
  budget: GraphValidationBudget
  graphDepth: number
  nestedGraphs: Map<string, ValidatedGraph>
}

type GraphValidationBudget = Pick<RegionValidationState, 'expressionBudget' | 'totalNodes' | 'activeGraphs'>

type GraphValidationOptions = {
  externalBindings?: ReadonlyMap<string, ValueType>
  budget?: GraphValidationBudget
  graphDepth?: number
}

const surfaceRoots: Record<ContentGraphSurface, ReadonlySet<string>> = {
  skill: new Set(['context', 'battle']),
  card: new Set(['context', 'battle', 'playerId']),
  rule: new Set(['context', 'battle']),
  triggerSkill: new Set(['context', 'battle']),
  pending: new Set(['ctx']),
  preview: new Set(['piece', 'skillDef', 'currentCooldown']),
}

const internalLocalNames = new Set(['context', 'ctx', 'Math', 'Date', 'Reflect', 'globalThis', '_pc', '_step'])

function reservedForSurface(surface: ContentGraphSurface): ReadonlySet<string> {
  if (surface === 'preview') return new Set([...internalLocalNames, 'piece', 'skillDef', 'currentCooldown'])
  if (surface === 'pending') return new Set([...internalLocalNames, 'ctx'])
  return internalLocalNames
}

function graphError(nodeId: string, message: string): never {
  return fail(`${nodeId}: ${message}`)
}

function pathParts(path: string, nodeId: string): string[] {
  if (typeof path !== 'string' || path.length === 0) graphError(nodeId, '引用名称必须为非空字符串')
  const parts = path.split('.')
  if (parts.some(part => !safePathSegment.test(part) || unsafePathSegments.has(part))) graphError(nodeId, '引用包含不安全属性路径')
  return parts
}

function propertyKey(key: string, nodeId: string): void {
  if (typeof key !== 'string' || key.length === 0 || key.length > 128) graphError(nodeId, '属性 key 无效')
  if (key.split('.').some(part => unsafePathSegments.has(part))) graphError(nodeId, '属性包含不安全原型路径')
}

function expressionOf(node: ContentGraphBindNode | ContentGraphBranchNode | ContentGraphReturnNode, nodeId: string): ContentGraphExpression | undefined {
  const value = 'expr' in node ? node.expr : undefined
  const alternate = 'expression' in node ? node.expression : undefined
  const bindValue = 'value' in node && node.kind === 'bind' ? node.value : undefined
  const condition = 'condition' in node ? node.condition : undefined
  const test = 'test' in node ? node.test : undefined
  const candidates = node.kind === 'bind' ? [value, alternate, bindValue]
    : node.kind === 'branch' ? [condition, test, value]
      : [value, value === undefined ? node.expr : undefined]
  const present = candidates.filter(item => item !== undefined)
  if (present.length > 1) graphError(nodeId, '表达式字段不能重复')
  return present[0]
}

function validatePrimitive(value: unknown, nodeId: string): asserts value is ContentGraphPrimitive {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  graphError(nodeId, 'literal 只允许有限基本值')
}

function resolveScopedReference(
  name: string,
  nodeId: string,
  scope: ReadonlyMap<string, ValueType>,
  resolve: (name: string, currentNode: string) => ValueType,
): ValueType {
  const parts = pathParts(name, nodeId)
  const scoped = scope.get(parts[0])
  return scoped === undefined ? resolve(name, nodeId) : propertyType(scoped, parts.slice(1))
}

function validateIndexKey(value: ContentGraphExpression, nodeId: string): void {
  if (value.kind === 'literal' && typeof value.value === 'string') propertyKey(value.value, nodeId)
}

function validateExpression(
  value: unknown,
  graph: ContentGraph,
  nodeId: string,
  resolve: (name: string, currentNode: string) => ValueType,
  budget: ExpressionBudget,
  depth = 0,
  scope: ReadonlyMap<string, ValueType> = new Map(),
  captures: ReadonlyMap<string, Definition> = new Map(),
  state?: RegionValidationState,
): ValueType {
  if (!objectLike(value) || typeof value.kind !== 'string') graphError(nodeId, '表达式必须是结构化节点')
  if (depth > CONTENT_GRAPH_MAX_EXPRESSION_DEPTH) graphError(nodeId, '表达式嵌套深度超过预算')
  budget.nodes += 1
  if (budget.nodes > CONTENT_GRAPH_MAX_EXPRESSION_NODES) graphError(nodeId, '表达式节点数超过预算')
  switch (value.kind) {
    case 'literal':
      if (!own(value, 'value')) graphError(nodeId, 'literal 缺少 value')
      validatePrimitive(value.value, nodeId)
      return value.value === undefined ? 'undefined' : value.value === null ? 'null' : typeof value.value as ValueType
    case 'undefined':
      return 'undefined'
    case 'ref': {
      if (typeof value.name !== 'string') graphError(nodeId, 'ref.name 必须是字符串')
      return resolveScopedReference(value.name, nodeId, scope, resolve)
    }
    case 'get': {
      if (!own(value, 'object') || typeof value.key !== 'string') graphError(nodeId, 'get 需要 object 与静态 key')
      propertyKey(value.key, nodeId)
      const base = validateExpression(value.object, graph, nodeId, resolve, budget, depth + 1, scope, captures, state)
      const key = value.key
      if (key === 'length' && (base === 'array' || base === 'string')) return 'number'
      if (['x', 'y', 'currentHp', 'maxHp', 'attack', 'defense', 'moveRange', 'damage', 'actualDamage', 'heal', 'amount', 'intensity', 'stacks'].includes(key)) return 'number'
      if (['instanceId', 'templateId', 'ownerPlayerId', 'name', 'type', 'id', 'playerId', 'skillId'].includes(key)) return 'string'
      if (['statusTags', 'skills', 'pieces', 'players', 'options', 'results', 'hand'].includes(key)) return 'array'
      return base === 'null' ? 'unknown' : 'unknown'
    }
    case 'index': {
      if (!own(value, 'object') || !own(value, 'index')) graphError(nodeId, 'index 需要 object 与 index')
      const base = validateExpression(value.object, graph, nodeId, resolve, budget, depth + 1, scope, captures, state)
      const indexType = validateExpression(value.index, graph, nodeId, resolve, budget, depth + 1, scope, captures, state)
      validateIndexKey(value.index as ContentGraphExpression, nodeId)
      if (!['number', 'string', 'unknown', 'null', 'undefined'].includes(indexType)) graphError(nodeId, 'index key 必须是数字或字符串表达式')
      return base === 'string' ? 'string' : 'unknown'
    }
    case 'array':
      if (!Array.isArray(value.items)) graphError(nodeId, 'array.items 必须为数组')
      value.items.forEach(item => validateExpression(item, graph, nodeId, resolve, budget, depth + 1, scope, captures, state))
      return 'array'
    case 'object': {
      const entries = normalizeObjectEntries(value.entries, nodeId)
      entries.forEach(entry => {
        propertyKey(entry.key, nodeId)
        validateExpression(entry.value, graph, nodeId, resolve, budget, depth + 1, scope, captures, state)
      })
      return 'object'
    }
    case 'binary': {
      const operator = value.op ?? value.operator
      if (typeof operator !== 'string' || !binaryOperators.has(operator as ContentGraphBinaryOperator)) graphError(nodeId, '不支持的二元运算符')
      if (!own(value, 'left') || !own(value, 'right')) graphError(nodeId, 'binary 需要 left 与 right')
      const left = validateExpression(value.left, graph, nodeId, resolve, budget, depth + 1, scope, captures, state)
      const right = validateExpression(value.right, graph, nodeId, resolve, budget, depth + 1, scope, captures, state)
      if (['-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>'].includes(operator) && (left === 'string' || right === 'string')) graphError(nodeId, '数值运算不能使用字符串引用')
      return ['===', '!==', '==', '!=', '<', '<=', '>', '>='].includes(operator) ? 'boolean'
        : ['&&', '||', '??'].includes(operator) ? 'unknown'
          : operator === '+' && (left === 'string' || right === 'string') ? 'string' : 'number'
    }
    case 'unary': {
      const operator = value.op ?? value.operator
      if (typeof operator !== 'string' || !unaryOperators.has(operator as ContentGraphUnaryOperator)) graphError(nodeId, '不支持的一元运算符')
      if (!own(value, 'argument')) graphError(nodeId, 'unary 需要 argument')
      const argument = validateExpression(value.argument, graph, nodeId, resolve, budget, depth + 1, scope, captures, state)
      if (['+', '-', '~'].includes(operator) && argument === 'string') graphError(nodeId, '数值运算不能使用字符串引用')
      return operator === '!' ? 'boolean' : operator === 'typeof' ? 'string' : 'number'
    }
    case 'conditional':
      if (!own(value, 'test') || !own(value, 'consequent') || !own(value, 'alternate')) graphError(nodeId, 'conditional 字段不完整')
      validateExpression(value.test, graph, nodeId, resolve, budget, depth + 1, scope, captures, state)
      const consequent = validateExpression(value.consequent, graph, nodeId, resolve, budget, depth + 1, scope, captures, state)
      const alternate = validateExpression(value.alternate, graph, nodeId, resolve, budget, depth + 1, scope, captures, state)
      return consequent === alternate ? consequent : 'unknown'
    case 'call': {
      if (typeof value.callee !== 'string' || !pureCalls.has(value.callee as ContentGraphPureCall)) graphError(nodeId, '纯表达式调用不在白名单中')
      if (!Array.isArray(value.args)) graphError(nodeId, 'call.args 必须为数组')
      const pureCall = pureCallSpecs[value.callee as ContentGraphPureCall]
      if (pureCall && (value.args.length < pureCall.minArgs || value.args.length > pureCall.maxArgs)) graphError(nodeId, `纯表达式调用 ${value.callee} 参数数量无效`)
      const argumentTypes = value.args.map(arg => validateExpression(arg, graph, nodeId, resolve, budget, depth + 1, scope, captures, state))
      for (let index = 0; index < (pureCall?.argumentTypes?.length ?? 0); index += 1) {
        const expected = pureCall!.argumentTypes![index]
        const actual = argumentTypes[index]
        if (actual !== undefined && !compatibleType(expected, actual)) graphError(nodeId, `纯表达式调用 ${value.callee} 的第${index + 1}个参数类型不匹配`)
      }
      if (pureCall) return pureCall.resultType
      return value.callee === 'Array.isArray' ? 'boolean' : value.callee === 'String' ? 'string' : value.callee === 'Boolean' ? 'boolean' : 'number'
    }
    case 'capabilityType': {
      if (!isSafeLocalIdentifier(value.capability)) graphError(nodeId, 'capabilityType 只允许安全的全局单标识符')
      const capability = CAPABILITIES[value.capability]
      if (!capability || !capability.surfaces.includes(graph.surface)) graphError(nodeId, `capabilityType 不允许使用 helper: ${value.capability}`)
      return 'string'
    }
    case 'template':
      if (typeof value.head !== 'string' || !Array.isArray(value.spans) || !Array.isArray(value.tails)) graphError(nodeId, 'template 字段无效')
      if (value.tails.length !== value.spans.length + 1) graphError(nodeId, 'template 必须有 spans.length + 1 个 tails')
      if (value.tails.some(tail => typeof tail !== 'string')) graphError(nodeId, 'template.tails 必须全为字符串')
      value.spans.forEach(span => validateExpression(span, graph, nodeId, resolve, budget, depth + 1, scope, captures, state))
      return 'string'
    case 'boundMethod': {
      const method = value.method as ContentGraphBoundMethod
      if (!objectLike(value.object) || typeof value.method !== 'string'
        || (!boundArrayMethods.has(method) && !boundStringMethods.has(method))) {
        graphError(nodeId, 'boundMethod 字段或方法不支持')
      }
      const receiverType = validateExpression(value.object, graph, nodeId, resolve, budget, depth + 1, scope, captures, state)
      if (receiverType !== 'unknown' && receiverType !== 'array' && receiverType !== 'string' && receiverType !== 'null' && receiverType !== 'undefined') graphError(nodeId, 'boundMethod receiver 类型不支持')
      if (receiverType === 'array' && !boundArrayMethods.has(method)) graphError(nodeId, `boundMethod ${method} 仅支持字符串 receiver`)
      if (receiverType === 'string' && !boundStringMethods.has(method)) graphError(nodeId, `boundMethod ${method} 仅支持数组 receiver`)
      return 'function'
    }
    case 'source': {
      if (!objectLike(value.graph)) graphError(nodeId, 'source.graph 必须是结构化图')
      if (value.graph.surface !== 'card' && value.graph.surface !== 'pending') graphError(nodeId, 'source 只支持 card 或 pending graph')
      if (!state) graphError(nodeId, 'source 表达式缺少验证预算')
      validateGraph(value.graph, { budget: state!.budget, graphDepth: state!.graphDepth + 1 })
      return 'string'
    }
    case 'function':
      if (!state) graphError(nodeId, 'function 表达式缺少验证作用域')
      return validateFunctionExpression(value as Extract<ContentGraphExpression, { kind: 'function' }>, graph, nodeId, state, captures, depth)
    case 'lambda': {
      if (!Array.isArray(value.parameters) || value.parameters.length > 4) graphError(nodeId, 'lambda.parameters 数量无效')
      if (!own(value, 'body')) graphError(nodeId, 'lambda 缺少 body')
      const lambdaScope = new Map(scope)
      const parameters = new Set<string>()
      for (const parameter of value.parameters) {
        if (!isSafeLocalIdentifier(parameter) || reservedForSurface(graph.surface).has(parameter)) graphError(nodeId, 'lambda 参数名无效')
        if (parameters.has(parameter)) graphError(nodeId, `lambda 参数重复: ${parameter}`)
        parameters.add(parameter)
        lambdaScope.set(parameter, 'unknown')
      }
      validateExpression(value.body, graph, nodeId, resolve, budget, depth + 1, lambdaScope, captures, state)
      return 'function'
    }
    case 'collection': {
      if (!objectLike(value.object) || typeof value.method !== 'string' || !Array.isArray(value.args)) graphError(nodeId, 'collection 字段无效')
      if (!own(collectionMethods, value.method)) graphError(nodeId, `不支持的 collection 方法: ${String(value.method)}`)
      const spec = collectionMethods[value.method as ContentGraphCollectionMethod]
      const base = validateExpression(value.object, graph, nodeId, resolve, budget, depth + 1, scope, captures, state)
      if (value.args.length < spec.minArgs || value.args.length > spec.maxArgs) graphError(nodeId, `collection ${value.method} 参数数量无效`)
      const types = value.args.map(arg => validateExpression(arg, graph, nodeId, resolve, budget, depth + 1, scope, captures, state))
      if (spec.callback) {
        const callback = value.args[0]
        if (!objectLike(callback) || callback.kind !== 'lambda' || types[0] !== 'function') graphError(nodeId, `collection ${value.method} 需要纯 lambda`)
        const callbackParameters = (callback as { parameters: unknown[] }).parameters
        const maxCallbackParameters = value.method === 'reduce' ? 4 : 3
        if (callbackParameters.length < 1 || callbackParameters.length > maxCallbackParameters) graphError(nodeId, `collection ${value.method} lambda 参数数量无效`)
        if (base !== 'unknown' && base !== 'array') graphError(nodeId, `collection ${value.method} 仅支持数组`)
      } else if (base !== 'unknown' && base !== 'array' && base !== 'string') {
        graphError(nodeId, `collection ${value.method} 的对象类型不支持`)
      } else if (value.method === 'join' && base === 'string') {
        graphError(nodeId, 'collection join 仅支持数组')
      } else if ((value.method === 'toLowerCase' || value.method === 'toUpperCase' || value.method === 'split'
        || value.method === 'startsWith' || value.method === 'trim' || value.method === 'localeCompare')
        && base !== 'unknown' && base !== 'string') {
        graphError(nodeId, `collection ${value.method} 仅支持字符串`)
      }
      return spec.result(base)
    }
    default:
      graphError(nodeId, '不支持的表达式类型')
  }
}

/** Validate a graph-backed function in its own lexical scope. */
function validateFunctionExpression(
  value: Extract<ContentGraphExpression, { kind: 'function' }>,
  graph: ContentGraph,
  nodeId: string,
  parentState: RegionValidationState,
  captures: ReadonlyMap<string, Definition>,
  depth: number,
): ValueType {
  if (!Array.isArray(value.parameters) || value.parameters.length > 8) graphError(nodeId, 'function.parameters 数量无效')
  if (!objectLike(value.body)) graphError(nodeId, 'function.body 必须是结构化函数图')
  const parameters = new Set<string>()
  const inherited = new Map(captures)
  for (const parameter of value.parameters) {
    // Parameters are allowed to shadow an outer capture (including an entry
    // root); the body resolver will therefore see the parameter first.
    if (!isSafeLocalIdentifier(parameter) || reservedForSurface(graph.surface).has(parameter)) graphError(nodeId, 'function 参数名无效')
    if (parameters.has(parameter)) graphError(nodeId, `function 参数重复: ${parameter}`)
    parameters.add(parameter)
    inherited.set(parameter, { nodeId: `${nodeId}:parameter:${parameter}`, type: 'unknown' })
  }
  const functionState: RegionValidationState = {
    seenIds: parentState.seenIds,
    localNames: new Set(parameters),
    regions: parentState.regions,
    expressionBudget: parentState.expressionBudget,
    totalNodes: parentState.totalNodes,
    activeGraphs: parentState.activeGraphs,
    budget: parentState.budget,
    graphDepth: parentState.graphDepth,
    nestedGraphs: parentState.nestedGraphs,
  }
  validateRegion(value.body as ContentGraphRegion, graph, inherited, functionState, depth + 1, false, true)
  return 'function'
}

function validateInvokeNode(
  node: ContentGraphInvokeNode,
  graph: ContentGraph,
  resolve: (name: string, currentNode: string) => ValueType,
  state: RegionValidationState,
  captures: ReadonlyMap<string, Definition>,
): ValueType {
  const expressionType = (value: ContentGraphExpression): ValueType =>
    validateExpression(value, graph, node.id, resolve, state.expressionBudget, 0, new Map(), captures, state)
  if (node.target.kind === 'function') {
    const targetType = expressionType(node.target.value)
    if (targetType !== 'function') graphError(node.id, 'invoke function target 必须是 function 值')
    node.args.forEach(argument => expressionType(argument))
    return 'unknown'
  }
  const baseType = expressionType(node.target.object)
  if (baseType !== 'unknown' && baseType !== 'array') graphError(node.id, `invoke ${node.target.method} 仅支持数组`)
  if (node.target.method === 'reduce') {
    if (node.args.length < 1 || node.args.length > 2) graphError(node.id, 'invoke reduce 需要 callback 或 callback 与初值')
  } else if (node.args.length !== 1) graphError(node.id, `invoke ${node.target.method} 需要一个函数参数`)
  const callback = node.args[0]
  const callbackType = expressionType(callback)
  if (callbackType !== 'function') graphError(node.id, `invoke ${node.target.method} 需要 function 回调`)
  if (node.target.method === 'reduce' && node.args.length === 2) expressionType(node.args[1])
  if (node.target.method === 'forEach') return 'undefined'
  if (node.target.method === 'map' || node.target.method === 'filter') return 'array'
  if (node.target.method === 'reduce') return 'unknown'
  if (node.target.method === 'some' || node.target.method === 'every') return 'boolean'
  if (node.target.method === 'find') return 'unknown'
  return 'number'
}

function validateDeleteNode(
  node: ContentGraphDeleteNode,
  graph: ContentGraph,
  resolve: (name: string, currentNode: string) => ValueType,
  state: RegionValidationState,
  captures: ReadonlyMap<string, Definition>,
): ValueType {
  const expressionType = (value: ContentGraphExpression): ValueType =>
    validateExpression(value, graph, node.id, resolve, state.expressionBudget, 0, new Map(), captures, state)
  if (node.target.kind === 'get') {
    propertyKey(node.target.key, node.id)
    expressionType(node.target.object)
  } else {
    expressionType(node.target.object)
    const indexType = expressionType(node.target.index)
    validateIndexKey(node.target.index, node.id)
    if (!['number', 'string', 'unknown', 'null', 'undefined'].includes(indexType)) graphError(node.id, 'delete index key 必须是数字或字符串表达式')
  }
  return 'boolean'
}

function validateTryNode(
  node: ContentGraphTryNode,
  graph: ContentGraph,
  state: RegionValidationState,
  captures: ReadonlyMap<string, Definition>,
  depth: number,
  insideLoop: boolean,
): void {
  if (node.finally !== undefined && regionContainsEscapingLoopControl(node.finally)) {
    graphError(node.id, 'try.finally 不能包含作用于外层 loop 的 break/continue')
  }
  validateRegion(node.body, graph, captures, state, depth + 1, insideLoop, true)
  if (node.catch !== undefined) {
    const catchCaptures = new Map(captures)
    if (node.catch.parameter !== undefined) {
      catchCaptures.set(node.catch.parameter, { nodeId: `${node.id}:catch:${node.catch.parameter}`, type: 'unknown' })
    }
    validateRegion(node.catch.body, graph, catchCaptures, state, depth + 1, insideLoop, true)
  }
  if (node.finally !== undefined) validateRegion(node.finally, graph, captures, state, depth + 1, insideLoop, true)
}

function regionContainsEscapingLoopControl(region: ContentGraphRegion): boolean {
  for (const node of region.nodes) {
    if (node.kind === 'break' || node.kind === 'continue') return true
    if (node.kind === 'loop') continue
    if (node.kind === 'try') {
      if (regionContainsEscapingLoopControl(node.body)) return true
      if (node.catch !== undefined && regionContainsEscapingLoopControl(node.catch.body)) return true
      if (node.finally !== undefined && regionContainsEscapingLoopControl(node.finally)) return true
    }
  }
  return false
}

function normalizeObjectEntries(value: unknown, nodeId: string): ContentGraphObjectEntry[] {
  let entries: ContentGraphObjectEntry[]
  if (Array.isArray(value)) {
    entries = value.map((entry, index) => {
      if (!objectLike(entry) || typeof entry.key !== 'string' || !own(entry, 'value')) graphError(nodeId, `object.entries[${index}] 无效`)
      return { key: entry.key, value: entry.value as ContentGraphExpression }
    })
  } else if (objectLike(value)) entries = Object.keys(value).map(key => ({ key, value: value[key] as ContentGraphExpression }))
  else graphError(nodeId, 'object.entries 必须为对象或键值数组')
  if (new Set(entries.map(entry => entry.key)).size !== entries.length) graphError(nodeId, 'object.entries 不能有重复 key')
  return entries
}

function validateLoopShape(node: ContentGraphStructuredLoopNode, nodeId: string, surface: ContentGraphSurface): void {
  if (!['for', 'while', 'forOf', 'forIn'].includes(node.loop)) graphError(nodeId, 'loop 类型无效')
  if (node.loop === 'forOf' || node.loop === 'forIn') {
    if (!objectLike(node.iterable)) graphError(nodeId, 'forOf.iterable 必须是纯结构化表达式')
    if (!isSafeLocalIdentifier(node.item) || reservedForSurface(surface).has(node.item)) graphError(nodeId, 'forOf.item 无效')
    if (!objectLike(node.body)) graphError(nodeId, 'forOf.body 必须是 region')
    if (typeof node.next !== 'string') graphError(nodeId, 'forOf loop 缺少 next')
    return
  }
  if (!objectLike(node.condition)) graphError(nodeId, 'loop.condition 必须是纯结构化表达式')
  if (!objectLike(node.body)) graphError(nodeId, 'loop.body 必须是 region')
  if (node.loop === 'for' && !objectLike(node.update)) graphError(nodeId, 'for loop 必须有 update region')
  if (node.loop === 'while' && node.update !== undefined) graphError(nodeId, 'while loop 不能有 update region')
  if (typeof node.next !== 'string') graphError(nodeId, 'loop 缺少 next')
}

function validateNodeShape(candidate: unknown, surface: ContentGraphSurface, allowRegionControl: boolean): ContentGraphRegionNode {
  if (!objectLike(candidate)) fail('节点必须为对象')
  const node = candidate as unknown as ContentGraphRegionNode
  if (typeof node.id !== 'string' || !safeNodeIdentifier.test(node.id)) fail(`${String(node.id)}: 节点 ID 无效`)
  for (const coordinate of ['x', 'y'] as const) {
    if (node[coordinate] !== undefined && (typeof node[coordinate] !== 'number' || !Number.isFinite(node[coordinate]))) {
      graphError(node.id, `${coordinate} 必须是有限数字`)
    }
  }
  const allowedKinds = allowRegionControl
    ? ['bind', 'call', 'invoke', 'delete', 'materializeSource', 'throw', 'try', 'branch', 'set', 'loop', 'return', 'break', 'continue', 'regionEnd']
    : ['bind', 'call', 'invoke', 'delete', 'materializeSource', 'throw', 'try', 'branch', 'set', 'loop', 'return']
  if (typeof node.kind !== 'string' || !allowedKinds.includes(node.kind)) graphError(node.id, '不支持的节点类型')
  if (node.kind === 'bind') {
    if (!isSafeLocalIdentifier(node.name) || reservedForSurface(surface).has(node.name)) graphError(node.id, 'bind.name 无效')
    const expression = expressionOf(node, node.id)
    if (!expression) graphError(node.id, 'bind 缺少 expr')
    if (typeof node.next !== 'string') graphError(node.id, 'bind 缺少 next')
  } else if (node.kind === 'call') {
    const helper = node.capability ?? node.helper
    if (typeof helper !== 'string' || !helper.length) graphError(node.id, 'call 缺少 capability')
    if (node.capability !== undefined && node.helper !== undefined && node.capability !== node.helper) graphError(node.id, 'capability 与 helper 不一致')
    if (!own(node, 'capability') && !own(node, 'helper')) graphError(node.id, 'call 缺少 capability')
    if (Array.isArray(node.capability) || Array.isArray(node.helper)) graphError(node.id, 'capability 不能是数组')
    if (!Array.isArray(node.args)) graphError(node.id, 'call.args 必须为数组')
    if (node.result !== undefined && (!isSafeLocalIdentifier(node.result) || reservedForSurface(surface).has(node.result))) graphError(node.id, 'call.result 无效')
    if (typeof node.next !== 'string') graphError(node.id, 'call 缺少 next')
  } else if (node.kind === 'invoke') {
    if (!objectLike(node.target) || (node.target.kind !== 'function' && node.target.kind !== 'array')) graphError(node.id, 'invoke.target 类型无效')
    if (node.target.kind === 'function') {
      if (!objectLike(node.target.value)) graphError(node.id, 'invoke function target 缺少 value')
    } else {
      if (!objectLike(node.target.object)) graphError(node.id, 'invoke array target 缺少 object')
      if (!['forEach', 'map', 'filter', 'find', 'some', 'every', 'findIndex', 'reduce'].includes(node.target.method)) graphError(node.id, 'invoke array method 不支持')
    }
    if (!Array.isArray(node.args)) graphError(node.id, 'invoke.args 必须为数组')
    if (node.result !== undefined && (!isSafeLocalIdentifier(node.result) || reservedForSurface(surface).has(node.result))) graphError(node.id, 'invoke.result 无效')
    if (typeof node.next !== 'string') graphError(node.id, 'invoke 缺少 next')
  } else if (node.kind === 'delete') {
    if (!objectLike(node.target) || (node.target.kind !== 'get' && node.target.kind !== 'index')) graphError(node.id, 'delete.target 必须是 get 或 index')
    if (node.target.kind === 'get') {
      if (!objectLike(node.target.object) || typeof node.target.key !== 'string') graphError(node.id, 'delete get.target 字段无效')
    } else if (!objectLike(node.target.object) || !objectLike(node.target.index)) {
      graphError(node.id, 'delete index.target 字段无效')
    }
    if (node.result !== undefined && (!isSafeLocalIdentifier(node.result) || reservedForSurface(surface).has(node.result))) graphError(node.id, 'delete.result 无效')
    if (typeof node.next !== 'string') graphError(node.id, 'delete 缺少 next')
  } else if (node.kind === 'materializeSource') {
    if (!objectLike(node.graph)) graphError(node.id, 'materializeSource.graph 必须是结构化图')
    if (node.graph.surface !== 'card' && node.graph.surface !== 'pending') graphError(node.id, 'materializeSource 只支持 card 或 pending graph')
    if (!objectLike(node.bindings) || Array.isArray(node.bindings)) graphError(node.id, 'materializeSource.bindings 必须为对象')
    for (const name of Object.keys(node.bindings)) {
      if (!isSafeLocalIdentifier(name) || reservedForSurface(node.graph.surface).has(name)) graphError(node.id, `materializeSource binding 名称无效: ${name}`)
      if (!objectLike(node.bindings[name])) graphError(node.id, `materializeSource binding ${name} 必须是表达式`)
    }
    if (node.result !== undefined && (!isSafeLocalIdentifier(node.result) || reservedForSurface(surface).has(node.result))) graphError(node.id, 'materializeSource.result 无效')
    if (typeof node.next !== 'string') graphError(node.id, 'materializeSource 缺少 next')
  } else if (node.kind === 'throw') {
    if (!objectLike(node.value)) graphError(node.id, 'throw.value 必须是表达式')
  } else if (node.kind === 'try') {
    if (!objectLike(node.body)) graphError(node.id, 'try.body 必须是 region')
    if (node.catch === undefined && node.finally === undefined) graphError(node.id, 'try 至少需要 catch 或 finally')
    if (node.catch !== undefined) {
      if (!objectLike(node.catch) || !objectLike(node.catch.body)) graphError(node.id, 'try.catch 必须包含 body region')
      if (node.catch.parameter !== undefined && (!isSafeLocalIdentifier(node.catch.parameter) || reservedForSurface(surface).has(node.catch.parameter))) graphError(node.id, 'try.catch.parameter 无效')
    }
    if (node.finally !== undefined && !objectLike(node.finally)) graphError(node.id, 'try.finally 必须是 region')
    if (typeof node.next !== 'string') graphError(node.id, 'try 缺少 next')
  } else if (node.kind === 'branch') {
    const expression = expressionOf(node, node.id)
    if (!expression) graphError(node.id, 'branch 缺少 condition')
    if (typeof node.yes !== 'string' || typeof node.no !== 'string') graphError(node.id, 'branch 缺少 yes/no')
  } else if (node.kind === 'set') {
    if (!objectLike(node.target) || !['ref', 'get', 'index'].includes(node.target.kind)) graphError(node.id, 'set.target 类型无效')
    if (!['=', '+=', '-=', '*=', '/='].includes(node.operator)) graphError(node.id, 'set.operator 不支持')
    if (!objectLike(node.value)) graphError(node.id, 'set.value 必须是表达式')
    if (node.target.kind === 'ref') {
      if (typeof node.target.name !== 'string') graphError(node.id, 'set ref.target.name 必须是字符串')
    } else if (node.target.kind === 'get') {
      if (!objectLike(node.target.object) || typeof node.target.key !== 'string') graphError(node.id, 'set get.target 字段无效')
    } else if (!objectLike(node.target.object) || !objectLike(node.target.index)) {
      graphError(node.id, 'set index.target 字段无效')
    }
    if (typeof node.next !== 'string') graphError(node.id, 'set 缺少 next')
  } else if (node.kind === 'loop') {
    validateLoopShape(node, node.id, surface)
  } else if (node.kind === 'return') {
    if (node.value !== undefined && node.expr !== undefined) graphError(node.id, 'return 不能同时设置 value 与 expr')
    if (node.value !== undefined && !objectLike(node.value)) graphError(node.id, 'return.value 必须是表达式')
    if (node.expr !== undefined && !objectLike(node.expr)) graphError(node.id, 'return.expr 必须是表达式')
  } else if (node.kind === 'break' || node.kind === 'continue' || node.kind === 'regionEnd') {
    if (!allowRegionControl) graphError(node.id, `${node.kind} 只能出现在 loop region 中`)
    if (own(node, 'next') || own(node, 'yes') || own(node, 'no')) graphError(node.id, `${node.kind} 不能有后继边`)
  }
  if (own(node, 'code') || own(node, 'source') || typeof (node as Record<string, unknown>).expression === 'string') graphError(node.id, '禁止 raw JavaScript 表达式或 code 节点')
  return node
}

function edges(node: ContentGraphNode | ContentGraphRegionNode, nodeId: string): string[] {
  if (node.kind === 'return' || node.kind === 'throw' || node.kind === 'break' || node.kind === 'continue' || node.kind === 'regionEnd') {
    if (own(node, 'next') || own(node, 'yes') || own(node, 'no')) graphError(nodeId, `${node.kind} 不能有后继边`)
    return []
  }
  if (node.kind === 'branch') {
    if (typeof node.yes !== 'string' || typeof node.no !== 'string' || own(node, 'next')) graphError(nodeId, 'branch 必须有 yes/no 两条边')
    return [node.yes, node.no]
  }
  if (typeof node.next !== 'string' || own(node, 'yes') || own(node, 'no')) graphError(nodeId, '节点必须有唯一 next 边')
  return [node.next]
}

function visibleDefinitions(
  available: ReadonlyMap<string, Definition>,
  local: ReadonlyMap<string, Definition>,
  dominators: ReadonlyMap<string, Set<string>>,
  nodeId: string,
): Map<string, Definition> {
  const dominated = dominators.get(nodeId) ?? fail(`${nodeId}: 节点没有可达支配集合`)
  return new Map([...available].filter(([name, definition]) => !local.has(name) || dominated.has(definition.nodeId)))
}

function validateRegion(
  input: ContentGraphRegion,
  graph: ContentGraph,
  inherited: ReadonlyMap<string, Definition>,
  state: RegionValidationState,
  depth: number,
  insideLoop: boolean,
  allowUnreachableEnd = false,
): ValidatedRegion {
  if (!objectLike(input) || typeof input.entry !== 'string' || typeof input.end !== 'string' || !Array.isArray(input.nodes)) {
    fail('loop region 必须包含 entry、end 和 nodes')
  }
  if (own(input, 'code') || own(input, 'source')) fail('loop region 禁止 raw JavaScript 字段')
  if (depth > CONTENT_GRAPH_MAX_GRAPH_DEPTH) fail('loop region 嵌套深度超过预算')
  if (state.regions.has(input)) fail('loop region 不能重复引用自身')
  state.totalNodes.value += input.nodes.length
  if (state.totalNodes.value > CONTENT_GRAPH_MAX_NODES) fail('nodes 数量超过预算')
  if (!safeNodeIdentifier.test(input.entry) || !safeNodeIdentifier.test(input.end)) fail('loop region entry/end 无效')
  const region = input
  const byId = new Map<string, ContentGraphRegionNode>()
  for (const candidate of region.nodes) {
    const node = validateNodeShape(candidate, graph.surface, true)
    if (state.seenIds.has(node.id)) fail(`节点 ID 重复: ${node.id}`)
    state.seenIds.add(node.id)
    byId.set(node.id, node)
  }
  if (!byId.has(region.entry)) fail(`loop region entry 指向不存在的节点: ${region.entry}`)
  if (!byId.has(region.end)) fail(`loop region end 指向不存在的节点: ${region.end}`)
  if (byId.get(region.end)!.kind !== 'regionEnd') fail('loop region end 必须指向 regionEnd 节点')
  const regionEnds = [...byId.values()].filter(node => node.kind === 'regionEnd')
  if (regionEnds.length !== 1 || regionEnds[0].id !== region.end) fail('loop region 必须只有一个 end regionEnd')
  const incoming = new Map<string, string[]>([...byId.keys()].map(id => [id, []]))
  for (const node of byId.values()) {
    for (const next of edges(node, node.id)) {
      if (!byId.has(next)) graphError(node.id, `region 边指向不存在的节点: ${next}`)
      incoming.get(next)!.push(node.id)
    }
  }
  const ordered: ContentGraphRegionNode[] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string, graphDepth = 0) => {
    if (visiting.has(id)) fail('loop region 包含未结构化 backedge')
    if (visited.has(id)) return
    if (graphDepth > CONTENT_GRAPH_MAX_GRAPH_DEPTH) fail('loop region 深度超过预算')
    visiting.add(id)
    const node = byId.get(id)!
    for (const next of edges(node, id)) visit(next, graphDepth + 1)
    visiting.delete(id)
    visited.add(id)
    ordered.unshift(node)
  }
  visit(region.entry)
  if (visited.size !== byId.size) {
    const unreachable = [...byId.keys()].filter(id => !visited.has(id))
    if (!allowUnreachableEnd || unreachable.some(id => id !== region.end)) fail('loop region 存在未连接到 entry 的节点')
  }

  const dominators = new Map<string, Set<string>>()
  for (const node of ordered) {
    if (node.id === region.entry) dominators.set(node.id, new Set([node.id]))
    else {
      const parents = incoming.get(node.id)!.filter(parent => dominators.has(parent))
      if (!parents.length) fail(`${node.id}: region 节点没有可达前驱`)
      const common = new Set(dominators.get(parents[0])!)
      for (const parent of parents.slice(1)) for (const id of [...common]) if (!dominators.get(parent)!.has(id)) common.delete(id)
      common.add(node.id)
      dominators.set(node.id, common)
    }
  }

  const definitions = new Map<string, Definition>()
  const available = new Map(inherited)
  const resolve = (name: string, currentNode: string): ValueType => {
    const parts = pathParts(name, currentNode)
    const root = parts[0]
    const definition = available.get(root)
    if (definition) {
      if (definitions.has(root) && !dominators.get(currentNode)!.has(definition.nodeId)) {
        graphError(currentNode, `引用未在所有前置路径产生: ${name}`)
      }
      return propertyType(definition.type, parts.slice(1))
    }
    if (!surfaceRoots[graph.surface].has(root)) graphError(currentNode, `surface ${graph.surface} 不提供输入引用: ${root}`)
    if (root === 'ctx' && graph.surface !== 'pending') graphError(currentNode, 'ctx 仅可用于 pending')
    if (root === 'piece' && graph.surface === 'preview') return propertyType('piece', parts.slice(1))
    return 'unknown'
  }
  const validateSetTarget = (target: ContentGraphSetTarget, nodeId: string): ValueType => {
    if (target.kind === 'ref') {
      const parts = pathParts(target.name, nodeId)
      if (parts.length !== 1 || !isSafeLocalIdentifier(parts[0])) graphError(nodeId, 'set ref 只能指向局部变量')
      const definition = available.get(parts[0])
      if (!definition) {
        if (surfaceRoots[graph.surface].has(parts[0])) graphError(nodeId, `不能替换入口引用: ${parts[0]}`)
        graphError(nodeId, `set 引用未定义: ${target.name}`)
      }
      if (definitions.has(parts[0]) && !dominators.get(nodeId)!.has(definition.nodeId)) graphError(nodeId, `set 引用未在所有前置路径产生: ${target.name}`)
      return definition.type
    }
    if (target.kind === 'get') {
      propertyKey(target.key, nodeId)
      const targetCaptures = visibleDefinitions(available, definitions, dominators, nodeId)
      const base = validateExpression(target.object, graph, nodeId, resolve, state.expressionBudget, 0, new Map(), targetCaptures, state)
      return propertyType(base, [target.key])
    }
    const targetCaptures = visibleDefinitions(available, definitions, dominators, nodeId)
    const base = validateExpression(target.object, graph, nodeId, resolve, state.expressionBudget, 0, new Map(), targetCaptures, state)
    const indexType = validateExpression(target.index, graph, nodeId, resolve, state.expressionBudget, 0, new Map(), targetCaptures, state)
    validateIndexKey(target.index, nodeId)
    if (!['number', 'string', 'unknown', 'null', 'undefined'].includes(indexType)) graphError(nodeId, 'set index key 必须是数字或字符串表达式')
    return base === 'string' ? 'string' : 'unknown'
  }
  const addDefinition = (name: string, nodeId: string, type: ValueType): void => {
    if (available.has(name) || state.localNames.has(name)) graphError(nodeId, `局部变量重复定义: ${name}`)
    state.localNames.add(name)
    definitions.set(name, { nodeId, type })
    available.set(name, { nodeId, type })
  }
  const validated: ValidatedRegion = { region, byId, ordered, incoming, dominators, definitions }
  state.regions.set(region, validated)
  for (const node of ordered) {
    const captures = visibleDefinitions(available, definitions, dominators, node.id)
    if (node.kind === 'bind') {
      const expression = expressionOf(node, node.id)!
      const type = validateExpression(expression, graph, node.id, resolve, state.expressionBudget, 0, new Map(), captures, state)
      addDefinition(node.name, node.id, type)
    } else if (node.kind === 'call') {
      const helper = node.capability ?? node.helper!
      const spec = own(CAPABILITIES, helper) ? CAPABILITIES[helper] : undefined
      if (!spec) graphError(node.id, `不支持的 capability: ${helper}`)
      if (!spec.surfaces.includes(graph.surface)) graphError(node.id, `capability ${helper} 禁止用于 ${graph.surface}`)
      if (node.args.length < spec.minArgs || node.args.length > spec.maxArgs) graphError(node.id, `capability ${helper} 参数数量无效`)
      const types = node.args.map(arg => validateExpression(arg, graph, node.id, resolve, state.expressionBudget, 0, new Map(), captures, state))
      for (let index = 0; index < (spec.argumentTypes?.length ?? 0); index += 1) {
        const expected = spec.argumentTypes![index]
        const actual = types[index]
        if (actual && !compatibleType(expected, actual)) graphError(node.id, `capability ${helper} 的第${index + 1}个参数类型不匹配`)
      }
      if (node.result) addDefinition(node.result, node.id, spec.resultType)
    } else if (node.kind === 'invoke') {
      const resultType = validateInvokeNode(node, graph, resolve, state, captures)
      if (node.result) addDefinition(node.result, node.id, resultType)
    } else if (node.kind === 'delete') {
      const resultType = validateDeleteNode(node, graph, resolve, state, captures)
      if (node.result) addDefinition(node.result, node.id, resultType)
    } else if (node.kind === 'materializeSource') {
      const bindingTypes = new Map<string, ValueType>()
      for (const name of Object.keys(node.bindings)) {
        bindingTypes.set(name, validateExpression(node.bindings[name], graph, node.id, resolve, state.expressionBudget, 0, new Map(), captures, state))
      }
      const child = validateGraph(node.graph, {
        externalBindings: bindingTypes,
        budget: state.budget,
        graphDepth: state.graphDepth + 1,
      })
      state.nestedGraphs.set(node.id, child)
      if (node.result) addDefinition(node.result, node.id, 'string')
    } else if (node.kind === 'throw') {
      validateExpression(node.value, graph, node.id, resolve, state.expressionBudget, 0, new Map(), captures, state)
    } else if (node.kind === 'try') {
      validateTryNode(node, graph, state, captures, depth, insideLoop)
    } else if (node.kind === 'branch') {
      const conditionType = validateExpression(expressionOf(node, node.id)!, graph, node.id, resolve, state.expressionBudget, 0, new Map(), captures, state)
      if (!['boolean', 'unknown', 'null'].includes(conditionType)) graphError(node.id, 'branch condition 必须是布尔表达式')
    } else if (node.kind === 'set') {
      validateSetTarget(node.target, node.id)
      validateExpression(node.value, graph, node.id, resolve, state.expressionBudget, 0, new Map(), captures, state)
    } else if (node.kind === 'loop') {
      if (node.loop === 'forOf' || node.loop === 'forIn') {
        const iterableType = validateExpression(node.iterable, graph, node.id, resolve, state.expressionBudget, 0, new Map(), captures, state)
        if (node.loop === 'forOf' && !['array', 'string', 'unknown'].includes(iterableType)) graphError(node.id, 'forOf iterable 必须是可迭代表达式')
        if (available.has(node.item) || state.localNames.has(node.item)) graphError(node.id, `局部变量重复定义: ${node.item}`)
        const itemDefinition: Definition = { nodeId: node.id, type: 'unknown' }
        state.localNames.add(node.item)
        definitions.set(node.item, itemDefinition)
        available.set(node.item, itemDefinition)
        const inheritedForLoop = visibleDefinitions(available, definitions, dominators, node.id)
        validateRegion(node.body, graph, inheritedForLoop, state, depth + 1, true, true)
      } else {
        const conditionType = validateExpression(node.condition, graph, node.id, resolve, state.expressionBudget, 0, new Map(), captures, state)
        if (!['boolean', 'unknown', 'null'].includes(conditionType)) graphError(node.id, 'loop condition 必须是布尔表达式')
        const inheritedForLoop = visibleDefinitions(available, definitions, dominators, node.id)
        validateRegion(node.body, graph, inheritedForLoop, state, depth + 1, true, true)
        if (node.loop === 'for') validateRegion(node.update!, graph, inheritedForLoop, state, depth + 1, true, true)
      }
    } else if (node.kind === 'break' || node.kind === 'continue') {
      if (!insideLoop) graphError(node.id, `${node.kind} 不在 loop region 中`)
    } else if (node.kind === 'return') {
      const expression = node.value ?? node.expr
      if (expression !== undefined) validateExpression(expression, graph, node.id, resolve, state.expressionBudget, 0, new Map(), captures, state)
    }
  }
  validated.scopeNames = new Set(state.localNames)
  return validated
}

function validateGraph(input: unknown, options: GraphValidationOptions = {}): ValidatedGraph {
  if (!objectLike(input)) fail('图必须是对象')
  const record = input as Record<string, unknown>
  if (record.version !== CONTENT_GRAPH_VERSION) fail('版本不支持')
  if (typeof record.surface !== 'string' || !surfaceSet.has(record.surface as ContentGraphSurface)) fail('surface 不支持')
  if (typeof record.entry !== 'string' || !safeNodeIdentifier.test(record.entry)) fail('entry 无效')
  if (!Array.isArray(record.nodes) || record.nodes.length === 0) fail('nodes 必须为非空数组')
  const nodes = record.nodes as unknown[]
  const graphDepth = options.graphDepth ?? 0
  if (graphDepth > CONTENT_GRAPH_MAX_GRAPH_DEPTH) fail('图嵌套深度超过预算')
  const budget: GraphValidationBudget = options.budget ?? {
    expressionBudget: { nodes: 0 },
    totalNodes: { value: 0 },
    activeGraphs: new Set<object>(),
  }
  const graph = record as unknown as ContentGraph
  if (budget.activeGraphs.has(graph)) fail('nested source graph 不能循环引用自身')
  budget.activeGraphs.add(graph)
  if (nodes.length > CONTENT_GRAPH_MAX_NODES) fail('nodes 数量超过预算')
  budget.totalNodes.value += nodes.length
  if (budget.totalNodes.value > CONTENT_GRAPH_MAX_NODES) fail('nodes 数量超过预算')
  const byId = new Map<string, ContentGraphNode>()
  for (const candidate of nodes) {
    const node = validateNodeShape(candidate, graph.surface, false) as ContentGraphNode
    if (byId.has(node.id)) fail(`节点 ID 重复: ${node.id}`)
    byId.set(node.id, node)
  }
  if (!byId.has(graph.entry)) fail('entry 指向不存在的节点')

  const incoming = new Map<string, string[]>([...byId.keys()].map(id => [id, []]))
  for (const node of byId.values()) {
    for (const next of edges(node, node.id)) {
      if (!byId.has(next)) graphError(node.id, `边指向不存在的节点: ${next}`)
      incoming.get(next)!.push(node.id)
    }
  }
  const ordered: ContentGraphNode[] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string, depth = 0) => {
    if (visiting.has(id)) fail('图包含循环')
    if (visited.has(id)) return
    if (depth > CONTENT_GRAPH_MAX_GRAPH_DEPTH) fail('图深度超过预算')
    visiting.add(id)
    const node = byId.get(id)!
    for (const next of edges(node, id)) visit(next, depth + 1)
    visiting.delete(id)
    visited.add(id)
    ordered.unshift(node)
  }
  visit(graph.entry)
  if (visited.size !== byId.size) fail('存在未连接到 entry 的节点')

  const dominators = new Map<string, Set<string>>()
  for (const node of ordered) {
    if (node.id === graph.entry) dominators.set(node.id, new Set([node.id]))
    else {
      const parents = incoming.get(node.id)!.filter(parent => dominators.has(parent))
      if (!parents.length) fail(`${node.id}: 节点没有可达前驱`)
      const common = new Set(dominators.get(parents[0])!)
      for (const parent of parents.slice(1)) for (const id of [...common]) if (!dominators.get(parent)!.has(id)) common.delete(id)
      common.add(node.id)
      dominators.set(node.id, common)
    }
  }

  const externalBindings = new Map<string, Definition>([...(options.externalBindings ?? [])].map(([name, type]) => [name, { nodeId: `external:${name}`, type }]))
  for (const name of externalBindings.keys()) {
    if (!isSafeLocalIdentifier(name) || surfaceRoots[graph.surface].has(name) || reservedForSurface(graph.surface).has(name)) {
      fail(`external binding 名称无效: ${name}`)
    }
  }
  const definitions = new Map<string, Definition>()
  const available = new Map(externalBindings)
  const nestedGraphs = new Map<string, ValidatedGraph>()
  const regionState: RegionValidationState = {
    seenIds: new Set(byId.keys()),
    localNames: new Set<string>(),
    regions: new WeakMap<ContentGraphRegion, ValidatedRegion>(),
    expressionBudget: budget.expressionBudget,
    totalNodes: budget.totalNodes,
    activeGraphs: budget.activeGraphs,
    budget,
    graphDepth,
    nestedGraphs,
  }
  const expressionBudget = regionState.expressionBudget
  for (const node of ordered) {
    const captures = visibleDefinitions(available, definitions, dominators, node.id)
    if (node.kind === 'bind' && (available.has(node.name) || regionState.localNames.has(node.name))) graphError(node.id, `局部变量重复定义: ${node.name}`)
    if (node.kind === 'call' && node.result && (available.has(node.result) || regionState.localNames.has(node.result))) graphError(node.id, `局部变量重复定义: ${node.result}`)
    if (node.kind === 'invoke' && node.result && (available.has(node.result) || regionState.localNames.has(node.result))) graphError(node.id, `局部变量重复定义: ${node.result}`)
    if (node.kind === 'delete' && node.result && (available.has(node.result) || regionState.localNames.has(node.result))) graphError(node.id, `局部变量重复定义: ${node.result}`)
    const resolve = (name: string, currentNode: string): ValueType => {
      const parts = pathParts(name, currentNode)
      const root = parts[0]
      const surface = graph.surface
      const definition = definitions.get(root) ?? externalBindings.get(root)
      if (definition) {
        if (definitions.has(root) && (definition.nodeId === currentNode || !dominators.get(currentNode)!.has(definition.nodeId))) graphError(currentNode, `引用未在所有前置路径产生: ${name}`)
        return propertyType(definition.type, parts.slice(1))
      }
      if (!surfaceRoots[surface].has(root)) graphError(currentNode, `surface ${surface} 不提供输入引用: ${root}`)
      if (root === 'ctx' && surface !== 'pending') graphError(currentNode, 'ctx 仅可用于 pending')
      if (root === 'piece' && surface === 'preview') return propertyType('piece', parts.slice(1))
      return 'unknown'
    }
    const validateSetTarget = (target: ContentGraphSetTarget): ValueType => {
      if (target.kind === 'ref') {
        const parts = pathParts(target.name, node.id)
        if (parts.length !== 1 || !isSafeLocalIdentifier(parts[0])) graphError(node.id, 'set ref 只能指向局部变量')
        const definition = definitions.get(parts[0])
        if (!definition) {
          if (surfaceRoots[graph.surface].has(parts[0])) graphError(node.id, `不能替换入口引用: ${parts[0]}`)
          graphError(node.id, `set 引用未定义: ${parts[0]}`)
        }
        if (definition.nodeId === node.id || !dominators.get(node.id)!.has(definition.nodeId)) graphError(node.id, `set 引用未在所有前置路径产生: ${target.name}`)
        return definition.type
      }
      if (target.kind === 'get') {
        propertyKey(target.key, node.id)
        const base = validateExpression(target.object, graph, node.id, resolve, expressionBudget, 0, new Map(), captures, regionState)
        return propertyType(base, [target.key])
      }
      const base = validateExpression(target.object, graph, node.id, resolve, expressionBudget, 0, new Map(), captures, regionState)
      const indexType = validateExpression(target.index, graph, node.id, resolve, expressionBudget, 0, new Map(), captures, regionState)
      validateIndexKey(target.index, node.id)
      if (!['number', 'string', 'unknown', 'null', 'undefined'].includes(indexType)) graphError(node.id, 'set index key 必须是数字或字符串表达式')
      return base === 'string' ? 'string' : 'unknown'
    }
    if (node.kind === 'bind') {
      const expression = expressionOf(node, node.id)!
      const type = validateExpression(expression, graph, node.id, resolve, expressionBudget, 0, new Map(), captures, regionState)
      definitions.set(node.name, { nodeId: node.id, type })
      available.set(node.name, { nodeId: node.id, type })
      regionState.localNames.add(node.name)
    } else if (node.kind === 'call') {
      const helper = node.capability ?? node.helper!
      const spec = own(CAPABILITIES, helper) ? CAPABILITIES[helper] : undefined
      if (!spec) graphError(node.id, `不支持的 capability: ${helper}`)
      if (!spec.surfaces.includes(graph.surface)) graphError(node.id, `capability ${helper} 禁止用于 ${graph.surface}`)
      if (node.args.length < spec.minArgs || node.args.length > spec.maxArgs) graphError(node.id, `capability ${helper} 参数数量无效`)
      const types = node.args.map(arg => validateExpression(arg, graph, node.id, resolve, expressionBudget, 0, new Map(), captures, regionState))
      for (let index = 0; index < (spec.argumentTypes?.length ?? 0); index += 1) {
        const expected = spec.argumentTypes![index]
        const actual = types[index]
        if (actual && !compatibleType(expected, actual)) graphError(node.id, `capability ${helper} 的第${index + 1}个参数类型不匹配`)
      }
      if (node.result) {
        definitions.set(node.result, { nodeId: node.id, type: spec.resultType })
        available.set(node.result, { nodeId: node.id, type: spec.resultType })
        regionState.localNames.add(node.result)
      }
    } else if (node.kind === 'invoke') {
      const resultType = validateInvokeNode(node, graph, resolve, regionState, captures)
      if (node.result) {
        definitions.set(node.result, { nodeId: node.id, type: resultType })
        available.set(node.result, { nodeId: node.id, type: resultType })
        regionState.localNames.add(node.result)
      }
    } else if (node.kind === 'delete') {
      const resultType = validateDeleteNode(node, graph, resolve, regionState, captures)
      if (node.result) {
        definitions.set(node.result, { nodeId: node.id, type: resultType })
        available.set(node.result, { nodeId: node.id, type: resultType })
        regionState.localNames.add(node.result)
      }
    } else if (node.kind === 'materializeSource') {
      const bindingTypes = new Map<string, ValueType>()
      for (const name of Object.keys(node.bindings)) {
        const bindingType = validateExpression(node.bindings[name], graph, node.id, resolve, expressionBudget, 0, new Map(), captures, regionState)
        bindingTypes.set(name, bindingType)
      }
      const child = validateGraph(node.graph, {
        externalBindings: bindingTypes,
        budget: regionState.budget,
        graphDepth: regionState.graphDepth + 1,
      })
      nestedGraphs.set(node.id, child)
      if (node.result) {
        definitions.set(node.result, { nodeId: node.id, type: 'string' })
        available.set(node.result, { nodeId: node.id, type: 'string' })
        regionState.localNames.add(node.result)
      }
    } else if (node.kind === 'throw') {
      validateExpression(node.value, graph, node.id, resolve, expressionBudget, 0, new Map(), captures, regionState)
    } else if (node.kind === 'try') {
      validateTryNode(node, graph, regionState, captures, 0, false)
    } else if (node.kind === 'branch') {
      const conditionType = validateExpression(expressionOf(node, node.id)!, graph, node.id, resolve, expressionBudget, 0, new Map(), captures, regionState)
      if (!['boolean', 'unknown', 'null'].includes(conditionType)) graphError(node.id, 'branch condition 必须是布尔表达式')
    } else if (node.kind === 'set') {
      validateSetTarget(node.target)
      validateExpression(node.value, graph, node.id, resolve, expressionBudget, 0, new Map(), captures, regionState)
    } else if (node.kind === 'loop') {
      if (node.loop === 'forOf' || node.loop === 'forIn') {
        const iterableType = validateExpression(node.iterable, graph, node.id, resolve, expressionBudget, 0, new Map(), captures, regionState)
        if (node.loop === 'forOf' && !['array', 'string', 'unknown'].includes(iterableType)) graphError(node.id, 'forOf iterable 必须是可迭代表达式')
        if (available.has(node.item) || regionState.localNames.has(node.item)) graphError(node.id, `局部变量重复定义: ${node.item}`)
        const itemDefinition: Definition = { nodeId: node.id, type: 'unknown' }
        definitions.set(node.item, itemDefinition)
        available.set(node.item, itemDefinition)
        regionState.localNames.add(node.item)
        const inheritedForLoop = visibleDefinitions(available, definitions, dominators, node.id)
        validateRegion(node.body, graph, inheritedForLoop, regionState, 0, true, true)
      } else {
        const conditionType = validateExpression(node.condition, graph, node.id, resolve, expressionBudget, 0, new Map(), captures, regionState)
        if (!['boolean', 'unknown', 'null'].includes(conditionType)) graphError(node.id, 'loop condition 必须是布尔表达式')
        const inheritedForLoop = visibleDefinitions(available, definitions, dominators, node.id)
        validateRegion(node.body, graph, inheritedForLoop, regionState, 0, true, true)
        if (node.loop === 'for') validateRegion(node.update!, graph, inheritedForLoop, regionState, 0, true, true)
      }
    } else if (node.kind === 'return') {
      const expression = node.value ?? node.expr
      if (expression !== undefined) validateExpression(expression, graph, node.id, resolve, expressionBudget, 0, new Map(), captures, regionState)
    }
  }

  budget.activeGraphs.delete(graph)
  return { graph, byId, ordered, incoming, dominators, definitions, localNames: regionState.localNames, regions: regionState.regions, externalBindings, nestedGraphs }
}

function propertyType(base: ValueType, parts: string[]): ValueType {
  if (!parts.length) return base
  const key = parts[0]
  if (base === 'piece') {
    if (['currentHp', 'maxHp', 'attack', 'defense', 'moveRange', 'x', 'y', 'intensity', 'stacks'].includes(key)) return 'number'
    if (['instanceId', 'templateId', 'ownerPlayerId', 'name', 'type', 'id'].includes(key)) return 'string'
    if (['statusTags', 'skills'].includes(key)) return 'array'
  }
  if (base === 'cell' && ['x', 'y'].includes(key)) return 'number'
  if (base === 'damage' && ['damage', 'actualDamage', 'amount'].includes(key)) return 'number'
  if (base === 'heal' && ['heal', 'amount'].includes(key)) return 'number'
  return 'unknown'
}

function compatibleType(expected: ValueType, actual: ValueType): boolean {
  if (expected === 'unknown' || actual === 'unknown' || actual === 'null') return true
  if (expected === 'object' && ['object', 'piece', 'cell', 'damage', 'heal', 'selection'].includes(actual)) return true
  if (expected === 'array' && actual === 'array') return true
  return expected === actual
}

function jsLiteral(value: ContentGraphPrimitive): string {
  if (value === undefined) return '(void 0)'
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

function templateText(value: string): string {
  return value
    // Template literal cooking normalizes CR and CRLF line endings to LF.
    .replace(/\r\n?/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function emitTemplateExpression(value: Extract<ContentGraphExpression, { kind: 'template' }>, context?: SourceEmitContext): string {
  let source = `\`${templateText(value.head)}`
  for (let index = 0; index < value.spans.length; index += 1) {
    source += `\${${emitExpression(value.spans[index], context)}}${templateText(value.tails[index + 1])}`
  }
  return `${source}\``
}

function emitBoundMethodExpression(value: Extract<ContentGraphExpression, { kind: 'boundMethod' }>, context?: SourceEmitContext): string {
  const receiver = emitExpression(value.object, context)
  const method = jsLiteral(value.method)
  return `(function (receiver) { var capturedMethod = receiver[${method}]; return function () { return Reflect.apply(capturedMethod, receiver, arguments); }; })(${receiver})`
}

function emitStrictJsonSnapshot(expression: string): string {
  const body = [
    '(function snapshot(value, seen, g) {',
    'var type = typeof value;',
    'var encode = function (data) { var text = g.JSON.stringify(data); return text.split(g.String.fromCharCode(8232)).join("\\\\u2028").split(g.String.fromCharCode(8233)).join("\\\\u2029"); };',
    'if (value === null) return "null";',
    'if (type === "string") return encode(value);',
    'if (type === "boolean") return value ? "true" : "false";',
    'if (type === "number") { if (!g.Number.isFinite(value)) throw new g.TypeError("content graph binding must be finite JSON"); return encode(value); }',
    'if (type !== "object") throw new g.TypeError("content graph binding must be JSON data");',
    'if (seen.indexOf(value) !== -1) throw new g.TypeError("content graph binding must not contain cycles");',
    'seen.push(value);',
    'var prototype = g.Object.getPrototypeOf(value);',
    'if (g.Array.isArray(value) ? prototype !== g.Array.prototype : prototype !== g.Object.prototype) throw new g.TypeError("content graph binding must be a plain JSON object or array");',
    'for (var cursor = prototype; cursor !== null; cursor = g.Object.getPrototypeOf(cursor)) { if (g.Object.getOwnPropertyDescriptor(cursor, "toJSON")) throw new g.TypeError("content graph binding must not define toJSON"); }',
    'var ownNames = g.Object.getOwnPropertyNames(value);',
    'for (var ownIndex = 0; ownIndex < ownNames.length; ownIndex += 1) { var ownDescriptor = g.Object.getOwnPropertyDescriptor(value, ownNames[ownIndex]); if (ownNames[ownIndex] === "toJSON") throw new g.TypeError("content graph binding must not define toJSON"); if (!ownDescriptor || !("value" in ownDescriptor)) throw new g.TypeError("content graph binding must not contain getters"); }',
    'var symbols = g.Object.getOwnPropertySymbols ? g.Object.getOwnPropertySymbols(value) : [];',
    'if (symbols.length) throw new g.TypeError("content graph binding must not contain symbol properties");',
    'var parts = [];',
    'if (g.Array.isArray(value)) {',
    'var lengthDescriptor = g.Object.getOwnPropertyDescriptor(value, "length");',
    'var length = lengthDescriptor && lengthDescriptor.value;',
    'if (typeof length !== "number" || !g.Number.isFinite(length) || length < 0 || g.Math.floor(length) !== length) throw new g.TypeError("content graph binding array length is invalid");',
    'var keys = g.Object.keys(value);',
    'for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) { var key = keys[keyIndex]; var numericKey = g.Number(key); if (g.String(numericKey) !== key || numericKey < 0 || numericKey >= length || g.Math.floor(numericKey) !== numericKey) throw new g.TypeError("content graph binding array has unsupported properties"); }',
    'for (var index = 0; index < length; index += 1) { var indexDescriptor = g.Object.getOwnPropertyDescriptor(value, g.String(index)); if (!indexDescriptor || !("value" in indexDescriptor)) throw new g.TypeError("content graph binding array must not contain holes or getters"); parts.push(snapshot(indexDescriptor.value, seen, g)); }',
    'seen.pop();',
    'return "[" + parts.join(",") + "]";',
    '}',
    'var objectKeys = g.Object.keys(value);',
    'for (var objectIndex = 0; objectIndex < objectKeys.length; objectIndex += 1) { var objectKey = objectKeys[objectIndex]; var objectDescriptor = g.Object.getOwnPropertyDescriptor(value, objectKey); if (!objectDescriptor || !("value" in objectDescriptor)) throw new g.TypeError("content graph binding must not contain getters"); parts.push(encode(objectKey) + ":" + snapshot(objectDescriptor.value, seen, g)); }',
    'seen.pop();',
    'return "{" + parts.join(",") + "}";',
    '})'
  ].join(' ')
  return body + '(' + expression + ', [], globalThis)'
}

function bindingMarker(index: number): string {
  return '__rvb_content_graph_binding_' + String(index) + '__'
}

/** Keep double-quoted literal targeting declarations readable by the existing
 * static targeting scanner even when they belong to a serialized child graph.
 * JSON encoding first preserves control characters and lone surrogates. */
function sourceLiteral(source: string): string {
  return "'" + JSON.stringify(source).slice(1, -1)
    .replace(/\\"/g, '"').replace(/'/g, "\\'")
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + "'"
}

function emitSourceExpression(value: Extract<ContentGraphExpression, { kind: 'source' }>): string {
  return sourceLiteral(compileSource(validateGraph(value.graph)))
}

function emitMaterializeSource(
  node: ContentGraphMaterializeSourceNode,
  context: SourceEmitContext,
): string {
  const child = context.validated.nestedGraphs.get(node.id) ?? fail('内部 materializeSource graph 未完成验证')
  const template = compileSource(child, { bindingPlaceholders: true })
  const sourceName = generatedName(context.allocator, 'materialized_source')
  const lines = ['var ' + sourceName + ';']
  const bindingNames = Object.keys(node.bindings)
  const childNames = [...child.externalBindings.keys()]
  if (bindingNames.length !== childNames.length || bindingNames.some((name, index) => name !== childNames[index])) {
    fail('内部 materializeSource binding 顺序不一致')
  }
  const sourceParts: string[] = []
  let cursor = 0
  bindingNames.forEach((name, index) => {
    const snapshotName = generatedName(context.allocator, 'binding_snapshot')
    const snapshot = emitStrictJsonSnapshot(emitExpression(node.bindings[name], context))
    lines.push('var ' + snapshotName + ' = ' + snapshot + ';')
    const declaration = 'var ' + name + ' = ' + bindingMarker(index) + ';'
    const declarationIndex = template.indexOf(declaration, cursor)
    if (declarationIndex < 0) fail('materializeSource binding marker 缺失或顺序错误')
    sourceParts.push(sourceLiteral(template.slice(cursor, declarationIndex)))
    // Keep the snapshot as JSON text in the generated child source, but let
    // JSON.parse create the value. An object literal with an own "__proto__"
    // key would invoke the legacy prototype setter instead of preserving the
    // JSON data property.
    sourceParts.push(`${jsLiteral('var ' + name + ' = globalThis.JSON.parse(')} + globalThis.JSON.stringify(${snapshotName}) + ${jsLiteral(');')}`)
    cursor = declarationIndex + declaration.length
  })
  sourceParts.push(sourceLiteral(template.slice(cursor)))
  lines.push(sourceName + ' = ' + sourceParts.join(' + ') + ';')
  lines.push('return ' + sourceName + ';')
  return '(function () { ' + lines.join(' ') + ' })()'
}

type SourceEmitContext = {
  validated: ValidatedGraph
  allocator: SourceNameAllocator
}

function emitExpression(value: ContentGraphExpression, context?: SourceEmitContext): string {
  if (!objectLike(value) || typeof value.kind !== 'string') fail('内部表达式不是结构化节点')
  switch (value.kind) {
    case 'literal': return jsLiteral(value.value)
    case 'undefined': return '(void 0)'
    case 'ref': return value.name
    case 'get': return `(${emitExpression(value.object, context)})[${jsLiteral(value.key)}]`
    case 'index': return `(${emitExpression(value.object, context)})[${emitIndexKey(value.index, context)}]`
    case 'array': return `[${value.items.map(item => emitExpression(item, context)).join(', ')}]`
    case 'object': return `{${normalizeObjectEntries(value.entries, 'object').map(entry => `${emitObjectKey(entry.key)}: ${emitExpression(entry.value, context)}`).join(', ')}}`
    case 'binary': return `(${emitExpression(value.left, context)} ${value.op ?? value.operator} ${emitExpression(value.right, context)})`
    case 'unary': return `(${value.op ?? value.operator} ${emitExpression(value.argument, context)})`
    case 'conditional': return `(${emitExpression(value.test, context)} ? ${emitExpression(value.consequent, context)} : ${emitExpression(value.alternate, context)})`
    case 'call': return `${value.callee}(${value.args.map(arg => emitExpression(arg, context)).join(', ')})`
    case 'capabilityType': return `typeof ${value.capability}`
    case 'template': return emitTemplateExpression(value, context)
    case 'boundMethod': return emitBoundMethodExpression(value, context)
    case 'source': return emitSourceExpression(value)
    case 'function': return emitFunctionExpression(value as Extract<ContentGraphExpression, { kind: 'function' }>, context)
    case 'lambda': return `function (${value.parameters.join(', ')}) { return ${emitExpression(value.body, context)}; }`
    case 'collection': return `(${emitExpression(value.object, context)})[${jsLiteral(value.method)}](${value.args.map(arg => emitExpression(arg, context)).join(', ')})`
    default: return fail('不支持的表达式类型')
  }
}

function emitObjectKey(key: string): string {
  // The legacy static targeting reader recognizes literal option keys such as
  // `type:` and `filter:`. Identifier-shaped keys are equivalent in a JS
  // object literal and keep that reader's fail-closed extraction behavior.
  return safeIdentifier.test(key) ? key : jsLiteral(key)
}

function emitIndexKey(value: ContentGraphExpression, context?: SourceEmitContext): string {
  // Static literal keys have already passed propertyKey validation. Keep
  // them as direct bracket expressions so generated code stays compact; only
  // dynamic keys need a runtime prototype-path guard.
  if (value.kind === 'literal' || value.kind === 'undefined') return emitExpression(value, context)
  const unsafe = JSON.stringify([...unsafePathSegments].sort())
  return `(function (key) { if (typeof key === "string" && key.split(".").some(function (part) { return ${unsafe}.indexOf(part) !== -1; })) throw new Error("unsafe content graph index"); return key; })(${emitExpression(value, context)})`
}

function emitSetTarget(target: ContentGraphSetTarget, context?: SourceEmitContext): string {
  if (target.kind === 'ref') return target.name
  if (target.kind === 'get') return `(${emitExpression(target.object, context)})[${jsLiteral(target.key)}]`
  return `(${emitExpression(target.object, context)})[${emitIndexKey(target.index, context)}]`
}

function emitDeleteTarget(target: ContentGraphDeleteTarget, context?: SourceEmitContext): string {
  if (target.kind === 'get') return `(${emitExpression(target.object, context)})[${jsLiteral(target.key)}]`
  return `(${emitExpression(target.object, context)})[${emitIndexKey(target.index, context)}]`
}

function functionPrefix(surface: ContentGraphSurface): string {
  switch (surface) {
    case 'skill':
    case 'triggerSkill': return 'function executeSkill(context)'
    case 'card': return 'function executeCard(context)'
    case 'pending': return 'function(ctx)'
    case 'preview': return 'function calculatePreview(piece, skillDef, currentCooldown)'
    case 'rule': return ''
  }
  return fail(`不支持的 surface: ${surface}`)
}

type SourceNameAllocator = {
  used: Set<string>
  serial: number
}

function generatedName(allocator: SourceNameAllocator, kind: string): string {
  let name: string
  do {
    name = `__rvb_content_graph_${kind}_${allocator.serial++}`
  } while (allocator.used.has(name))
  allocator.used.add(name)
  return name
}

function emitFunctionExpression(
  value: Extract<ContentGraphExpression, { kind: 'function' }>,
  context?: SourceEmitContext,
): string {
  const compileContext = context ?? fail('内部 function 表达式缺少编译上下文')
  const body = value.body as ContentGraphRegion
  const checked = compileContext.validated.regions.get(body) ?? fail('内部 function body 未完成验证')
  const parameterNames = [...value.parameters]
  const declaredNames = [...(checked.scopeNames ?? checked.definitions.keys())]
    .filter(name => !parameterNames.includes(name))
    .sort()
  const allocator: SourceNameAllocator = {
    // Reserve the enclosing scope's names as well.  A generated region
    // variable lives inside this function, but a free capture must continue
    // to resolve to the enclosing binding rather than being shadowed by it.
    // Propagating the used set back below also prevents a nested function's
    // generated name from colliding with a later sibling allocation.
    used: new Set([...compileContext.allocator.used, ...parameterNames, ...declaredNames, '_pc', '_step']),
    serial: compileContext.allocator.serial,
  }
  const bodySource = emitRegion(compileContext.validated, body, {
    // Function bodies cannot contain a break/continue outside a nested loop;
    // nested loop emitters replace this context with their own flags.
    breakFlag: 'false',
    continueFlag: 'false',
  }, allocator)
  compileContext.allocator.serial = allocator.serial
  for (const name of allocator.used) compileContext.allocator.used.add(name)
  const declarations = declaredNames.length ? `var ${declaredNames.join(', ')}; ` : ''
  return `function (${parameterNames.join(', ')}) { ${declarations}${bodySource} }`
}

type LoopEmitContext = {
  breakFlag: string
  continueFlag: string
}

function emitInvoke(node: ContentGraphInvokeNode, context: SourceEmitContext): string {
  const args = node.args.map(argument => emitExpression(argument, context)).join(', ')
  if (node.target.kind === 'function') return `(${emitExpression(node.target.value, context)})(${args})`
  return `(${emitExpression(node.target.object, context)})[${jsLiteral(node.target.method)}](${args})`
}

function emitTry(
  validated: ValidatedGraph,
  node: ContentGraphTryNode,
  loopContext: LoopEmitContext,
  allocator: SourceNameAllocator,
): string {
  if (node.catch?.parameter !== undefined) allocator.used.add(node.catch.parameter)
  const body = emitRegion(validated, node.body, loopContext, allocator)
  let source = `try ${body}`
  if (node.catch !== undefined) {
    const catchBody = emitRegion(validated, node.catch.body, loopContext, allocator)
    source += node.catch.parameter === undefined
      ? ` catch ${catchBody}`
      : ` catch (${node.catch.parameter}) ${catchBody}`
  }
  if (node.finally !== undefined) source += ` finally ${emitRegion(validated, node.finally, loopContext, allocator)}`
  return source
}

function emitRegion(
  validated: ValidatedGraph,
  region: ContentGraphRegion,
  loopContext: LoopEmitContext,
  allocator: SourceNameAllocator,
): string {
  const checked = validated.regions.get(region)
  if (!checked) return fail('内部 region 未完成验证')
  const expressionContext: SourceEmitContext = { validated, allocator }
  const pc = generatedName(allocator, 'region_pc')
  const cases = checked.ordered.map(node => {
    let body: string
    if (node.kind === 'bind') {
      body = `${node.name} = ${emitExpression(expressionOf(node, node.id)!, expressionContext)}; ${pc} = ${jsLiteral(node.next)}; break;`
    } else if (node.kind === 'call') {
      const helper = node.capability ?? node.helper!
      const spec = CAPABILITIES[helper]
      const call = spec.emit(node.args.map(argument => emitExpression(argument, expressionContext)))
      body = `${node.result ? `${node.result} = ` : ''}${call}; ${pc} = ${jsLiteral(node.next)}; break;`
    } else if (node.kind === 'invoke') {
      const call = emitInvoke(node, expressionContext)
      body = `${node.result ? `${node.result} = ` : ''}${call}; ${pc} = ${jsLiteral(node.next)}; break;`
    } else if (node.kind === 'delete') {
      const deletion = `delete ${emitDeleteTarget(node.target, expressionContext)}`
      body = `${node.result ? `${node.result} = ` : ''}${deletion}; ${pc} = ${jsLiteral(node.next)}; break;`
    } else if (node.kind === 'materializeSource') {
      const source = emitMaterializeSource(node, expressionContext)
      body = `${node.result ? `${node.result} = ` : ''}${source}; ${pc} = ${jsLiteral(node.next)}; break;`
    } else if (node.kind === 'throw') {
      body = `throw ${emitExpression(node.value, expressionContext)};`
    } else if (node.kind === 'try') {
      body = `${emitTry(validated, node, loopContext, allocator)} ${pc} = ${jsLiteral(node.next)}; break;`
    } else if (node.kind === 'branch') {
      body = `${pc} = ${emitExpression(expressionOf(node, node.id)!, expressionContext)} ? ${jsLiteral(node.yes)} : ${jsLiteral(node.no)}; break;`
    } else if (node.kind === 'set') {
      body = `${emitSetTarget(node.target, expressionContext)} ${node.operator} ${emitExpression(node.value, expressionContext)}; ${pc} = ${jsLiteral(node.next)}; break;`
    } else if (node.kind === 'loop') {
      body = `${emitLoop(validated, node, allocator)} ${pc} = ${jsLiteral(node.next)}; break;`
    } else if (node.kind === 'return') {
      const expression = node.value ?? node.expr
      body = expression === undefined ? 'return;' : `return ${emitExpression(expression, expressionContext)};`
    } else if (node.kind === 'break') {
      body = `${loopContext.breakFlag} = true; ${pc} = ${jsLiteral(region.end)}; break;`
    } else if (node.kind === 'continue') {
      body = `${loopContext.continueFlag} = true; ${pc} = ${jsLiteral(region.end)}; break;`
    } else {
      body = `${pc} = ${jsLiteral(region.end)}; break;`
    }
    return `case ${jsLiteral(node.id)}: ${body}`
  }).join(' ')
  return `{ var ${pc} = ${jsLiteral(region.entry)}; while (${pc} !== ${jsLiteral(region.end)}) { switch (${pc}) { ${cases} default: throw new Error(${jsLiteral('invalid content graph region node')}); } } }`
}

function emitLoop(validated: ValidatedGraph, node: ContentGraphStructuredLoopNode, allocator: SourceNameAllocator): string {
  const breakFlag = generatedName(allocator, 'loop_break')
  const continueFlag = generatedName(allocator, 'loop_continue')
  const context = { breakFlag, continueFlag }
  const expressionContext: SourceEmitContext = { validated, allocator }
  if (node.loop === 'forOf' || node.loop === 'forIn') {
    const body = emitRegion(validated, node.body, context, allocator)
    return [
      `var ${breakFlag} = false, ${continueFlag} = false;`,
      `for (${node.item} ${node.loop === 'forOf' ? 'of' : 'in'} ${emitExpression(node.iterable, expressionContext)}) {`,
      `${breakFlag} = false; ${continueFlag} = false;`,
      body,
      `if (${breakFlag}) break;`,
      `if (${continueFlag}) { ${continueFlag} = false; continue; }`,
      `}`,
    ].join(' ')
  }
  const body = emitRegion(validated, node.body, context, allocator)
  const update = node.loop === 'for' ? emitRegion(validated, node.update!, context, allocator) : ''
  return [
    `var ${breakFlag} = false, ${continueFlag} = false;`,
    `while (${emitExpression(node.condition, expressionContext)}) {`,
    `${continueFlag} = false;`,
    body,
    `if (${breakFlag}) break;`,
    update,
    `if (${breakFlag}) break;`,
    `if (${continueFlag}) { ${continueFlag} = false; continue; }`,
    `}`,
  ].filter(Boolean).join(' ')
}

type SourceCompileOptions = {
  bindingPlaceholders?: boolean
}

function compileSource(validated: ValidatedGraph, options: SourceCompileOptions = {}): string {
  const { graph, ordered } = validated
  const locals = [...validated.localNames].sort()
  const externalNames = [...validated.externalBindings.keys()]
  if (externalNames.length && !options.bindingPlaceholders) fail('带 external bindings 的 graph 只能作为 materializeSource 编译')
  const localDeclarations = locals.length ? 'var ' + locals.join(', ') + '; ' : ''
  const bindingDeclarations = externalNames.map((name, index) => 'var ' + name + ' = ' + bindingMarker(index) + '; ').join('')
  const declarations = localDeclarations + bindingDeclarations
  const allocator: SourceNameAllocator = { used: new Set([...locals, ...externalNames, '_pc', '_step']), serial: 0 }
  const expressionContext: SourceEmitContext = { validated, allocator }
  const cases = ordered.map(node => {
    let body: string
    if (node.kind === 'bind') {
      body = `${node.name} = ${emitExpression(expressionOf(node, node.id)!, expressionContext)}; _pc = ${jsLiteral(node.next)}; break;`
    } else if (node.kind === 'call') {
      const helper = node.capability ?? node.helper!
      const spec = CAPABILITIES[helper]
      const call = spec.emit(node.args.map(argument => emitExpression(argument, expressionContext)))
      body = `${node.result ? `${node.result} = ` : ''}${call}; _pc = ${jsLiteral(node.next)}; break;`
    } else if (node.kind === 'invoke') {
      const call = emitInvoke(node, expressionContext)
      body = `${node.result ? `${node.result} = ` : ''}${call}; _pc = ${jsLiteral(node.next)}; break;`
    } else if (node.kind === 'delete') {
      const deletion = `delete ${emitDeleteTarget(node.target, expressionContext)}`
      body = `${node.result ? `${node.result} = ` : ''}${deletion}; _pc = ${jsLiteral(node.next)}; break;`
    } else if (node.kind === 'materializeSource') {
      const source = emitMaterializeSource(node, expressionContext)
      body = `${node.result ? `${node.result} = ` : ''}${source}; _pc = ${jsLiteral(node.next)}; break;`
    } else if (node.kind === 'throw') {
      body = `throw ${emitExpression(node.value, expressionContext)};`
    } else if (node.kind === 'try') {
      body = `${emitTry(validated, node, { breakFlag: 'false', continueFlag: 'false' }, allocator)} _pc = ${jsLiteral(node.next)}; break;`
    } else if (node.kind === 'branch') {
      body = `_pc = ${emitExpression(expressionOf(node, node.id)!, expressionContext)} ? ${jsLiteral(node.yes)} : ${jsLiteral(node.no)}; break;`
    } else if (node.kind === 'set') {
      body = `${emitSetTarget(node.target, expressionContext)} ${node.operator} ${emitExpression(node.value, expressionContext)}; _pc = ${jsLiteral(node.next)}; break;`
    } else if (node.kind === 'loop') {
      // A loop is lowered inline. Region returns therefore remain returns from
      // the generated entry function rather than returning from a wrapper.
      body = `${emitLoop(validated, node, allocator)} _pc = ${jsLiteral(node.next)}; break;`
    } else {
      const expression = node.value ?? node.expr
      body = expression === undefined ? 'return;' : `return ${emitExpression(expression, expressionContext)};`
    }
    return `case ${jsLiteral(node.id)}: ${body}`
  }).join(' ')
  const body = `${declarations}var _pc = ${jsLiteral(graph.entry)}; for (var _step = 0; _step <= ${ordered.length}; _step++) { switch (_pc) { ${cases} default: throw new Error(${jsLiteral('invalid content graph node')}); } } throw new Error(${jsLiteral('content graph execution budget exceeded')});`
  const prefix = functionPrefix(graph.surface)
  return prefix ? `${prefix} { ${body} }` : body
}

/** Compile a validated data graph into an existing SkillCode source surface. */
export function compileContentGraph(input: unknown): CompiledContentGraph {
  const validated = validateGraph(input)
  const code = compileSource(validated)
  return {
    compilerVersion: CONTENT_GRAPH_COMPILER_VERSION,
    surface: validated.graph.surface,
    entry: validated.graph.entry,
    nodeOrder: validated.ordered.map(node => node.id),
    code,
    source: code,
  }
}

const codeFields = new Set(['code', 'skillCode', 'effectCode', 'previewCode', 'triggerSkill'])
const defaultField: Record<ContentGraphSurface, string> = {
  skill: 'code', card: 'code', rule: 'skillCode', triggerSkill: 'code', pending: 'effectCode', preview: 'previewCode',
}

function assertField(surface: ContentGraphSurface, field: string): void {
  if (!codeFields.has(field)) fail(`不支持的 artifact 字段: ${field}`)
  const compatible: Record<ContentGraphSurface, readonly string[]> = {
    skill: ['code', 'skillCode'], card: ['code'], rule: ['code', 'skillCode'], triggerSkill: ['code', 'skillCode', 'triggerSkill'], pending: ['code', 'effectCode'], preview: ['code', 'previewCode'],
  }
  if (!compatible[surface].includes(field)) fail(`字段 ${field} 与 surface ${surface} 不匹配`)
}

/**
 * Explicitly attach generated code to one content field.  Description,
 * targeting, presentation and all unrelated fields are copied untouched.
 */
export function applyContentGraph(content: Record<string, unknown>, graph: ContentGraph, field?: string): Record<string, unknown> {
  if (!objectLike(content)) fail('content 必须为对象')
  if (own(content, 'skillGraph') && content.skillGraph !== undefined) fail('content 同时存在旧 skillGraph 与 contentGraph，请先解除旧图关联')
  const compiled = compileContentGraph(graph)
  const targetField = field ?? defaultField[compiled.surface]
  assertField(compiled.surface, targetField)
  return {
    ...content,
    [targetField]: compiled.code,
    contentGraph: graph,
    contentGraphField: targetField,
    contentGraphCompilerVersion: compiled.compilerVersion,
  }
}

/** Validate that the generated field still corresponds to the attached graph. */
export function assertContentGraphArtifact(content: unknown): void {
  if (!objectLike(content) || !own(content, 'contentGraph')) return
  if (own(content, 'skillGraph') && content.skillGraph !== undefined) fail('content 同时存在旧 skillGraph 与 contentGraph，请先解除旧图关联')
  const graph = content.contentGraph
  const compiled = compileContentGraph(graph)
  const field = typeof content.contentGraphField === 'string' ? content.contentGraphField : defaultField[compiled.surface]
  assertField(compiled.surface, field)
  if (content[field] !== compiled.code) fail(`artifact 字段 ${field} 与图编译结果不一致`)
  if (content.contentGraphCompilerVersion !== undefined && content.contentGraphCompilerVersion !== compiled.compilerVersion) fail('artifact compiler version 不一致')
}

export { ContentGraphCompileError }
