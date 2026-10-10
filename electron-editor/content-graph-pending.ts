/**
 * Extract and attach the small executable graphs used by pending target
 * selections.
 *
 * Pending effects are authored in two forms in the legacy content: an
 * `effectCode` string and a local function followed by `.toString()`.  This
 * module only turns a candidate into a graph after the candidate has passed
 * the normal AST importer.  A rejected candidate is reported to the caller;
 * no raw source node is used as a migration fallback.
 */

import ts from 'typescript'
import {
  CONTENT_GRAPH_CAPABILITIES,
  compileContentGraph,
  type ContentGraph,
  type ContentGraphExpression,
  type ContentGraphFunctionGraph,
} from './content-graph'
import { importContentGraph } from './content-graph-import'

export type PendingSourceKind = 'effectCode-string' | 'local-function-toString' | 'unsupported'

export type PendingGraphCandidate = {
  id: string
  sourceKind: PendingSourceKind
  source: string
  expressionText: string
  functionName?: string
  parameterAliases: string[]
  /** Source range of the effectCode initializer in the containing source. */
  start: number
  end: number
  /** Human-readable AST path, useful when a source has more than one field. */
  path: string
  /** A local function declaration may be removed from the temporary parent source. */
  removeStart?: number
  removeEnd?: number
  error?: string
}

export type PendingSourcePair = {
  candidate: PendingGraphCandidate
  legacy: string
  graph: ContentGraph
  compiled: string
}

export type PendingGraphBuild = {
  candidate: PendingGraphCandidate
  /** Source passed to importContentGraph after only parameter alias binding is normalized. */
  normalizedSource: string
  graph: ContentGraph
  /** Replacement expression for the parent graph. */
  replacement: Extract<ContentGraphExpression, { kind: 'source' }>
  /** Source pairs discovered inside this pending function. */
  nestedSourcePairs?: PendingSourcePair[]
}

export type PendingGraphFailure = {
  candidate: PendingGraphCandidate
  error: string
}

export type PendingGraphExtraction = {
  candidates: PendingGraphCandidate[]
  builds: PendingGraphBuild[]
  failures: PendingGraphFailure[]
}

export type PendingContentGraphBuild = {
  graph: ContentGraph
  /** Original source passed by the caller. */
  source: string
  /** Temporary source used only for AST import; it contains unique placeholders. */
  transformedSource: string
  sourcePairs: PendingSourcePair[]
  pending: PendingGraphExtraction
}

type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction

type ParsedFunction = {
  tree: ts.SourceFile
  node: FunctionLike
  /** Prefix length used to parse an anonymous function as a parenthesized expression. */
  sourceOffset: number
  checker: ts.TypeChecker
}

const expressionKinds = new Set([
  'literal', 'undefined', 'ref', 'get', 'index', 'array', 'object', 'binary', 'unary',
  'conditional', 'call', 'capabilityType', 'template', 'boundMethod', 'source', 'lambda',
  'function', 'collection',
])

const nodeKinds = new Set([
  'bind', 'call', 'invoke', 'delete', 'materializeSource', 'throw', 'try', 'branch', 'set',
  'loop', 'return', 'break', 'continue', 'regionEnd',
])

/** Names which are runtime globals, rather than lexical captures from a parent function. */
const builtinNames = new Set([
  'Array', 'Boolean', 'Date', 'Error', 'Infinity', 'JSON', 'Map', 'Math', 'NaN', 'Number',
  'Object', 'Reflect', 'RegExp', 'Set', 'String', 'Symbol', 'arePlayersAllied',
  'canAffectAdventureTarget', 'console', 'globalThis', 'nextEnemyPlayer', 'undefined',
])

const capabilityRoots = new Set<string>([
  ...Object.keys(CONTENT_GRAPH_CAPABILITIES)
    .map(name => name.split('.')[0])
    .filter(name => !['battle', 'context', 'ctx', 'flow'].includes(name)),
  ...Object.keys(CONTENT_GRAPH_CAPABILITIES)
    .filter(name => !['battle', 'context', 'ctx', 'flow'].includes(name)),
])

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null
)

const unwrap = (node: ts.Node): ts.Node => {
  let current = node
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
  return undefined
}

function isIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false
  if (ts.isParameter(parent) && parent.name === node) return false
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return false
  if (ts.isFunctionExpression(parent) && parent.name === node) return false
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false
  if (ts.isMethodDeclaration(parent) && parent.name === node) return false
  if (ts.isMethodSignature(parent) && parent.name === node) return false
  if (ts.isPropertySignature(parent) && parent.name === node) return false
  if (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) return false
  return true
}

function functionOwner(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent
  return current ?? node.getSourceFile()
}

function createChecker(sourceFile: ts.SourceFile): ts.TypeChecker {
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noLib: true,
    noResolve: true,
    types: [],
    target: ts.ScriptTarget.Latest,
  }
  const host = ts.createCompilerHost(options, true)
  const expected = sourceFile.fileName.replace(/\\/g, '/')
  host.getSourceFile = fileName => (
    fileName.replace(/\\/g, '/') === expected
      ? sourceFile
      : undefined
  )
  host.fileExists = fileName => fileName.replace(/\\/g, '/') === expected
  host.readFile = fileName => fileName.replace(/\\/g, '/') === expected ? sourceFile.text : undefined
  host.directoryExists = () => false
  host.getDirectories = () => []
  return ts.createProgram([sourceFile.fileName], options, host).getTypeChecker()
}

function parseFunctionSource(source: string, fileName = 'pending-source.js'): ParsedFunction {
  const sourceOffset = 1
  const wrapped = `(${source})`
  const tree = ts.createSourceFile(fileName, wrapped, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const diagnostics = (tree as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []
  if (diagnostics.length) throw new Error('pending effectCode 语法无效: ' + ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n'))
  const statement = tree.statements[0]
  const expression = statement && ts.isExpressionStatement(statement) ? unwrap(statement.expression) : undefined
  if (!expression || (!ts.isFunctionExpression(expression) && !ts.isFunctionDeclaration(expression) && !ts.isArrowFunction(expression))) {
    throw new Error('pending effectCode 必须是函数表达式')
  }
  const node = expression as FunctionLike
  if (!node.body || !ts.isBlock(node.body)) throw new Error('pending effectCode 必须有块函数体')
  if (node.parameters.some(parameter => !ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken)) {
    throw new Error('pending effectCode 参数必须是简单标识符')
  }
  return { tree, node, sourceOffset, checker: createChecker(tree) }
}

function parameterAliases(parsed: ParsedFunction): string[] {
  return parsed.node.parameters.map(parameter => (parameter.name as ts.Identifier).text)
}

function isWithin(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === ancestor) return true
  }
  return false
}

function assertNoCapturedOuterBindings(parsed: ParsedFunction): void {
  const root = parsed.node
  const checker = parsed.checker
  let capture: string | undefined
  const visit = (node: ts.Node): void => {
    if (capture || !ts.isIdentifier(node) || !isIdentifierReference(node)) {
      if (!capture) ts.forEachChild(node, visit)
      return
    }
    const symbol = checker.getSymbolAtLocation(node)
    const declarations = symbol?.declarations ?? []
    // A declaration inside the extracted function, including a nested helper,
    // is part of the graph's own lexical scope.  A declaration outside it is
    // an outer capture and must remain legacy source.
    if (declarations.some(declaration => isWithin(declaration, root))) return
    if (builtinNames.has(node.text) || capabilityRoots.has(node.text)) return
    capture = node.text
  }
  ts.forEachChild(root, visit)
  if (capture) throw new Error(`pending effectCode 捕获外层变量: ${capture}`)
}

type ParameterAliasRecord = { original: string; normalized: 'ctx' }

function expressionRoot(node: ts.Expression): ts.Identifier | undefined {
  let current: ts.Expression = unwrap(node) as ts.Expression
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression
  }
  return ts.isIdentifier(current) ? current : undefined
}

function expressionPath(node: ts.Expression): string[] {
  const parts: string[] = []
  let current: ts.Expression = unwrap(node) as ts.Expression
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text)
    current = current.expression
  }
  if (ts.isIdentifier(current)) parts.unshift(current.text)
  return parts
}

function usesPendingCapabilityAlias(functionNode: FunctionLike, parameter: ts.Identifier, checker: ts.TypeChecker): boolean {
  const parameterSymbol = checker.getSymbolAtLocation(parameter)
  if (!parameterSymbol) return false
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isPropertyAccessExpression(node)) {
      const root = expressionRoot(node)
      const path = expressionPath(node)
      if (root && checker.getSymbolAtLocation(root) === parameterSymbol
        && (path[1] === 'flow' || ['addStatusEffectById', 'addPlayerStatusEffectById', 'changePositions'].includes(path[1] ?? ''))) {
        found = true
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  if (functionNode.body) ts.forEachChild(functionNode.body, visit)
  return found
}

/**
 * The pending surface has one canonical root (`ctx`) in the current graph
 * schema. Nested callbacks may retain an author alias such as `finalCtx`; for
 * temporary importing, canonicalize only aliases that are used as capability
 * receivers, while recording the original names in graph metadata.
 */
function normalizePendingParameterBindings(source: string, parsed: ParsedFunction): {
  source: string
  nestedAliases: ParameterAliasRecord[]
} {
  const replacements: Array<{ start: number; end: number }> = []
  const nestedAliases: ParameterAliasRecord[] = []
  const addRename = (functionNode: FunctionLike, parameter: ts.Identifier): void => {
    const symbol = parsed.checker.getSymbolAtLocation(parameter)
    if (!symbol) throw new Error(`无法解析 pending 参数绑定: ${parameter.text}`)
    const collect = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && isIdentifierReference(node)
        && parsed.checker.getSymbolAtLocation(node) === symbol) {
        replacements.push({ start: node.getStart(parsed.tree) - parsed.sourceOffset, end: node.end - parsed.sourceOffset })
      }
      ts.forEachChild(node, collect)
    }
    replacements.push({ start: parameter.getStart(parsed.tree) - parsed.sourceOffset, end: parameter.end - parsed.sourceOffset })
    collect(functionNode)
  }

  const rootParameter = parsed.node.parameters[0]?.name
  if (rootParameter && ts.isIdentifier(rootParameter) && rootParameter.text !== 'ctx') addRename(parsed.node, rootParameter)

  const visit = (node: ts.Node): void => {
    if (node !== parsed.node && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) {
      for (const parameter of node.parameters) {
        const parameterName = parameter.name
        if (ts.isIdentifier(parameterName) && parameterName.text !== 'ctx'
          && usesPendingCapabilityAlias(node, parameterName, parsed.checker)) {
          addRename(node, parameterName)
          nestedAliases.push({ original: parameterName.text, normalized: 'ctx' })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(parsed.node, visit)

  let normalized = source
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    normalized = normalized.slice(0, replacement.start) + 'ctx' + normalized.slice(replacement.end)
  }
  return { source: normalized, nestedAliases }
}

function candidateFromSource(
  id: string,
  sourceKind: PendingSourceKind,
  source: string,
  expressionText: string,
  start: number,
  end: number,
  path: string,
  functionName?: string,
): PendingGraphCandidate {
  try {
    const parsed = parseFunctionSource(source)
    return {
      id,
      sourceKind,
      source,
      expressionText,
      functionName,
      parameterAliases: parameterAliases(parsed),
      start,
      end,
      path,
    }
  } catch (error) {
    return {
      id,
      sourceKind,
      source,
      expressionText,
      functionName,
      parameterAliases: [],
      start,
      end,
      path,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function localFunctionDeclarations(tree: ts.SourceFile): FunctionLike[] {
  const declarations: FunctionLike[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) declarations.push(node)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return declarations
}

function resolveLocalFunction(tree: ts.SourceFile, initializer: ts.CallExpression): FunctionLike | undefined {
  const property = unwrap(initializer.expression)
  if (!ts.isPropertyAccessExpression(property) || property.name.text !== 'toString' || initializer.arguments.length !== 0) return undefined
  const receiver = unwrap(property.expression)
  if (ts.isFunctionExpression(receiver) || ts.isArrowFunction(receiver) || ts.isFunctionDeclaration(receiver)) return receiver
  if (!ts.isIdentifier(receiver)) return undefined
  const owner = functionOwner(initializer)
  // A variable-bound function may be uninitialised at the legacy evaluation
  // site (`var` yields undefined and `const`/`let` are in the TDZ).  Resolving
  // it from a later initializer would therefore change the old runtime.  Only
  // direct function declarations are safe here: their binding is hoisted and
  // their symbol identity can be checked independently of source order.
  if (!(ts.isFunctionDeclaration(owner) || ts.isFunctionExpression(owner) || ts.isArrowFunction(owner)) || !owner.body) return undefined
  const checker = createChecker(tree)
  const receiverSymbol = checker.getSymbolAtLocation(receiver)
  if (!receiverSymbol) return undefined
  const matches = localFunctionDeclarations(tree).filter(candidate => {
    if (!ts.isFunctionDeclaration(candidate) || functionOwner(candidate) !== owner) return false
    if (candidate.parent !== owner.body || !candidate.name) return false
    return checker.getSymbolAtLocation(candidate.name) === receiverSymbol
  })
  return matches.sort((a, b) => b.getStart(tree) - a.getStart(tree))[0]
}

function functionBindingIdentifier(node: FunctionLike): ts.Identifier | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) return node.name
  let current: ts.Node | undefined = node.parent
  while (current && !ts.isSourceFile(current)) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name
    current = current.parent
  }
  return undefined
}

function localFunctionRemovalRange(node: FunctionLike, tree: ts.SourceFile): { start: number; end: number } | undefined {
  if (ts.isFunctionDeclaration(node)) return { start: node.getStart(tree), end: node.end }
  let current: ts.Node | undefined = node.parent
  while (current && !ts.isSourceFile(current)) {
    if (ts.isVariableDeclaration(current)) {
      const list = current.parent
      const statement = list.parent
      if (!ts.isVariableDeclarationList(list) || !ts.isVariableStatement(statement) || list.declarations.length !== 1) return undefined
      return { start: statement.getStart(tree), end: statement.end }
    }
    current = current.parent
  }
  return undefined
}

function hasOnlyOneExternalFunctionReference(node: FunctionLike, tree: ts.SourceFile): boolean {
  const binding = functionBindingIdentifier(node)
  if (!binding) return false
  const checker = createChecker(tree)
  const symbol = checker.getSymbolAtLocation(binding)
  if (!symbol) return false
  let externalReferences = 0
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child) && isIdentifierReference(child)
      && checker.getSymbolAtLocation(child) === symbol && !isWithin(child, node)) externalReferences += 1
    ts.forEachChild(child, visit)
  }
  visit(tree)
  return externalReferences === 1
}

/** Find every legacy effectCode source in one content field. */
export function findPendingGraphCandidates(source: string, fileName = 'content.js'): PendingGraphCandidate[] {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const candidates: PendingGraphCandidate[] = []
  let serial = 0
  const childPath = (parent: ts.Node, child: ts.Node, path: string): string => {
    if (ts.isFunctionDeclaration(child) || ts.isFunctionExpression(child) || ts.isArrowFunction(child)) {
      const name = ts.isFunctionDeclaration(child) || ts.isFunctionExpression(child) ? child.name?.text : undefined
      return `${path}/function:${name ?? 'anonymous'}`
    }
    if (ts.isPropertyAssignment(parent) && parent.initializer === child) {
      const key = propertyName(parent.name)
      return key ? `${path}.${key}` : path
    }
    if (ts.isArrayLiteralExpression(parent)) {
      const index = parent.elements.findIndex(element => element === child)
      return index >= 0 ? `${path}[${index}]` : path
    }
    return path
  }
  const visit = (node: ts.Node, path: string): void => {
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'effectCode') {
      const initializer = unwrap(node.initializer)
      const id = `effectCode-${serial++}`
      const candidatePath = `${path}.effectCode`
      if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
        candidates.push(candidateFromSource(
          id,
          'effectCode-string',
          initializer.text,
          initializer.getText(tree),
          initializer.getStart(tree),
          initializer.end,
          candidatePath,
        ))
      } else if (ts.isCallExpression(initializer)) {
        const local = resolveLocalFunction(tree, initializer)
        if (local) {
          const candidate = candidateFromSource(
            id,
            'local-function-toString',
            local.getText(tree),
            initializer.getText(tree),
            initializer.getStart(tree),
            initializer.end,
            candidatePath,
            ts.isFunctionDeclaration(local) || ts.isFunctionExpression(local) ? local.name?.text : undefined,
          )
          const removal = localFunctionRemovalRange(local, tree)
          if (removal && !hasOnlyOneExternalFunctionReference(local, tree)) {
            candidate.error = '本地 pending 函数存在额外外部引用，拒绝从父图临时源删除'
          } else if (removal) {
            candidate.removeStart = removal.start
            candidate.removeEnd = removal.end
          }
          candidates.push(candidate)
        } else {
          candidates.push({
            id,
            sourceKind: 'unsupported',
            source: initializer.getText(tree),
            expressionText: initializer.getText(tree),
            parameterAliases: [],
            start: initializer.getStart(tree),
            end: initializer.end,
            path: candidatePath,
            error: 'effectCode 必须是字符串或同一词法作用域内的本地函数.toString()',
          })
        }
      } else {
        candidates.push({
          id,
          sourceKind: 'unsupported',
          source: initializer.getText(tree),
          expressionText: initializer.getText(tree),
          parameterAliases: [],
          start: initializer.getStart(tree),
          end: initializer.end,
          path: candidatePath,
          error: 'effectCode 必须是字符串或同一词法作用域内的本地函数.toString()',
        })
      }
    }
    ts.forEachChild(node, child => visit(child, childPath(node, child, path)))
  }
  visit(tree, '$')
  return candidates
}

function rejectArbitrarySourceGraph(value: unknown, seen = new Set<object>()): void {
  if (!isObject(value) || seen.has(value)) return
  seen.add(value)
  if (typeof value.kind === 'string') {
    if (value.kind === 'source' && !isObject(value.graph)) throw new Error('typed source 节点缺少结构化 graph')
    if (value.kind.endsWith('Node') || value.kind === 'graph') return
    if (value.kind !== undefined && !expressionKinds.has(value.kind) && !nodeKinds.has(value.kind)) {
      // Metadata can contain arbitrary application values, but graph nodes and
      // expressions must be from the typed registry.
      if ('id' in value || 'nodes' in value || 'entry' in value) throw new Error(`pending graph 节点类型不受支持: ${value.kind}`)
    }
  }
  for (const child of Object.values(value)) rejectArbitrarySourceGraph(child, seen)
}

function sourceGraphFunctionExpression(build: PendingGraphBuild): Extract<ContentGraphExpression, { kind: 'function' }> {
  const aliases = build.candidate.parameterAliases
  const parameter = aliases[0] ?? 'ctx'
  const rename = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rename)
    if (!isObject(value)) return value
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      if (key === 'name' && value.kind === 'ref' && child === 'ctx') result[key] = parameter
      else result[key] = rename(child)
    }
    return result
  }
  const endNode = build.graph.nodes.find(node => (node as unknown as { kind?: string }).kind === 'regionEnd') as unknown as { id?: string } | undefined
  const body = rename({ entry: build.graph.entry, end: endNode?.id ?? build.graph.entry, nodes: build.graph.nodes }) as ContentGraphFunctionGraph
  return { kind: 'function', parameters: [parameter], body }
}

function canonicalGraphValue(value: unknown, ids = new Map<string, string>(), serial = { value: 0 }): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalGraphValue(item, ids, serial))
  if (!isObject(value)) return value
  // Region references can appear before the node array. Seed every id first so
  // importer serials do not affect structural matching.
  if (Array.isArray(value.nodes)) {
    for (const node of value.nodes) {
      if (isObject(node) && typeof node.id === 'string' && !ids.has(node.id)) ids.set(node.id, `n${serial.value++}`)
    }
  }
  if (typeof value.id === 'string' && !ids.has(value.id)) ids.set(value.id, `n${serial.value++}`)
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === 'end' && Array.isArray(value.nodes)) continue
    if (key === 'nodes' && Array.isArray(child)) {
      result[key] = child
        .filter(node => !(isObject(node) && node.kind === 'regionEnd'))
        .map(node => canonicalGraphValue(node, ids, serial))
      continue
    }
    if ((key === 'id' || key === 'next' || key === 'entry' || key === 'yes' || key === 'no') && typeof child === 'string') {
      result[key] = ids.get(child) ?? child
    } else result[key] = canonicalGraphValue(child, ids, serial)
  }
  return result
}

function sameFunctionExpression(left: Extract<ContentGraphExpression, { kind: 'function' }>, right: Extract<ContentGraphExpression, { kind: 'function' }>): boolean {
  return JSON.stringify(canonicalGraphValue(left)) === JSON.stringify(canonicalGraphValue(right))
}

type PendingBuildState = {
  activeSources: Set<string>
}

function sourcePair(candidate: PendingGraphCandidate, graph: ContentGraph): PendingSourcePair {
  return { candidate, legacy: candidate.source, graph, compiled: compileContentGraph(graph).code }
}

function uniqueSourcePairs(pairs: PendingSourcePair[]): PendingSourcePair[] {
  const seen = new Set<string>()
  return pairs.filter(pair => {
    const key = `${pair.candidate.source}\u0000${pair.candidate.functionName ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function applySourceEdits(source: string, edits: Array<{ start: number; end: number; text: string }>): string {
  const ordered = [...edits].sort((left, right) => right.start - left.start || right.end - left.end)
  let result = source
  let lowerBound = source.length
  for (const edit of ordered) {
    if (edit.end > lowerBound) throw new Error('pending 临时源编辑范围重叠')
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
    lowerBound = edit.start
  }
  return result
}

function buildPendingParentSource(
  source: string,
  candidates: readonly PendingGraphCandidate[],
  builds: readonly PendingGraphBuild[],
): { source: string; builds: PendingGraphBuild[] } {
  const ranges = candidates
    .filter(candidate => candidate.removeStart !== undefined && candidate.removeEnd !== undefined)
    .map(candidate => ({ start: candidate.removeStart!, end: candidate.removeEnd! }))
    .sort((left, right) => left.start - right.start || right.end - left.end)
  const outerRanges = ranges.filter((range, index) => !ranges.some((parent, parentIndex) => (
    parentIndex !== index && parent.start <= range.start && parent.end >= range.end
  )))
  const placeholderBuilds: PendingGraphBuild[] = []
  const edits: Array<{ start: number; end: number; text: string }> = []
  for (const [index, build] of builds.entries()) {
    const candidate = build.candidate
    const removed = outerRanges.some(range => candidate.start >= range.start && candidate.end <= range.end)
    if (removed) continue
    const placeholder = `__rvb_pending_graph_placeholder_${index}__`
    edits.push({ start: candidate.start, end: candidate.end, text: JSON.stringify(placeholder) })
    placeholderBuilds.push({
      ...build,
      candidate: { ...candidate, source: placeholder },
    })
  }
  for (const range of outerRanges) edits.push({ start: range.start, end: range.end, text: '' })
  return { source: applySourceEdits(source, edits), builds: placeholderBuilds }
}

function buildPendingSubgraphInternal(candidate: PendingGraphCandidate, state: PendingBuildState): PendingGraphBuild {
  const resolved = candidate
  if (resolved.error) throw new Error(resolved.error)
  if (resolved.sourceKind === 'unsupported') throw new Error(resolved.error ?? '不支持的 pending effectCode')
  if (state.activeSources.has(resolved.source)) throw new Error('pending effectCode 存在循环引用')
  state.activeSources.add(resolved.source)
  try {
    const nestedCandidates = findPendingGraphCandidates(resolved.source, 'pending-nested.js')
    let graph: ContentGraph
    let normalizedSource: string
    let nestedSourcePairs: PendingSourcePair[] | undefined
    if (nestedCandidates.length > 0) {
      const nested = buildContentGraphWithPendingInternal(resolved.source, 'pending', 'pending-nested.js', state)
      graph = nested.graph
      normalizedSource = nested.transformedSource
      nestedSourcePairs = nested.sourcePairs
    } else {
      const parsed = parseFunctionSource(resolved.source)
      assertNoCapturedOuterBindings(parsed)
      const aliases = parameterAliases(parsed)
      const normalizedBindings = normalizePendingParameterBindings(resolved.source, parsed)
      normalizedSource = normalizedBindings.source
      graph = importContentGraph(normalizedSource, 'pending')
      compileContentGraph(graph)
      rejectArbitrarySourceGraph(graph)
      graph = {
        ...graph,
        metadata: {
          ...(graph.metadata ?? {}),
          pendingParameterAliases: aliases,
          pendingSourceKind: resolved.sourceKind,
          ...(normalizedBindings.nestedAliases.length > 0
            ? { pendingNestedParameterAliases: normalizedBindings.nestedAliases }
            : {}),
          ...(resolved.functionName ? { pendingFunctionName: resolved.functionName } : {}),
        },
      }
    }
    // Nested-source graphs are already independent graphs, but still receive
    // the same metadata contract as a leaf graph.
    if (!graph.metadata?.pendingParameterAliases) {
      const parsed = parseFunctionSource(resolved.source)
      graph = {
        ...graph,
        metadata: {
          ...(graph.metadata ?? {}),
          pendingParameterAliases: parameterAliases(parsed),
          pendingSourceKind: resolved.sourceKind,
          ...(resolved.functionName ? { pendingFunctionName: resolved.functionName } : {}),
        },
      }
    }
    compileContentGraph(graph)
    rejectArbitrarySourceGraph(graph)
    return {
      candidate: resolved,
      normalizedSource,
      graph,
      replacement: { kind: 'source', graph },
      ...(nestedSourcePairs ? { nestedSourcePairs } : {}),
    }
  } finally {
    state.activeSources.delete(resolved.source)
  }
}

/** Build one independent pending graph; unsupported syntax is a hard failure. */
export function buildPendingSubgraph(candidate: PendingGraphCandidate | string): PendingGraphBuild {
  const resolved = typeof candidate === 'string'
    ? candidateFromSource('pending-source', 'effectCode-string', candidate, candidate, 0, candidate.length, '$.effectCode')
    : candidate
  return buildPendingSubgraphInternal(resolved, { activeSources: new Set() })
}

function buildContentGraphWithPendingInternal(
  source: string,
  surface: 'skill' | 'card' | 'rule' | 'triggerSkill' | 'pending' | 'preview',
  fileName: string,
  state: PendingBuildState,
): PendingContentGraphBuild {
  const candidates = findPendingGraphCandidates(source, fileName)
  const builds: PendingGraphBuild[] = []
  const failures: PendingGraphFailure[] = []
  for (const candidate of candidates) {
    try {
      builds.push(buildPendingSubgraphInternal(candidate, state))
    } catch (error) {
      failures.push({ candidate, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const pending: PendingGraphExtraction = { candidates, builds, failures }
  if (failures.length > 0) {
    throw new Error(failures.map(failure => `${failure.candidate.id}: ${failure.error}`).join('; '))
  }
  const prepared = buildPendingParentSource(source, candidates, builds)
  const parentGraph = importContentGraph(prepared.source, surface)
  const graph = replacePendingGraphExpressions(parentGraph, prepared.builds)
  const pairs: PendingSourcePair[] = []
  for (const build of builds) {
    const active = prepared.builds.some(item => item.candidate.id === build.candidate.id)
    if (active) pairs.push(sourcePair(build.candidate, build.graph))
    if (build.nestedSourcePairs) pairs.push(...build.nestedSourcePairs)
  }
  return {
    graph,
    source,
    transformedSource: prepared.source,
    sourcePairs: uniqueSourcePairs(pairs),
    pending,
  }
}

/** Import a parent content field after extracting every nested pending graph. */
export function buildContentGraphWithPending(
  source: string,
  surface: 'skill' | 'card' | 'rule' | 'triggerSkill' | 'pending' | 'preview',
  fileName = 'content.js',
): PendingContentGraphBuild {
  return buildContentGraphWithPendingInternal(source, surface, fileName, { activeSources: new Set() })
}

/** Extract every pending candidate, retaining explicit failures for legacy callers. */
export function extractPendingSubgraphs(source: string, fileName = 'content.js'): PendingGraphExtraction {
  const candidates = findPendingGraphCandidates(source, fileName)
  const builds: PendingGraphBuild[] = []
  const failures: PendingGraphFailure[] = []
  for (const candidate of candidates) {
    try {
      builds.push(buildPendingSubgraph(candidate))
    } catch (error) {
      failures.push({ candidate, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { candidates, builds, failures }
}

function mapPendingGraphValue(value: unknown, build: PendingGraphBuild, matches: { count: number }): unknown {
  if (Array.isArray(value)) return value.map(item => mapPendingGraphValue(item, build, matches))
  if (!isObject(value)) return value
  if (value.kind === 'literal' && value.value === build.candidate.source) {
    matches.count += 1
    return build.replacement
  }
  if (value.kind === 'function') {
    const expected = sourceGraphFunctionExpression(build)
    if (sameFunctionExpression(value as Extract<ContentGraphExpression, { kind: 'function' }>, expected)) {
      matches.count += 1
      return build.replacement
    }
  }
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) result[key] = mapPendingGraphValue(child, build, matches)
  return result
}

/**
 * Replace exactly one matching parent expression for each successfully built
 * candidate.  Ambiguous matches are rejected so a repeated literal can never
 * silently migrate the wrong pending field.
 */
export function replacePendingGraphExpressions(
  parentGraph: ContentGraph,
  buildsOrExtraction: readonly PendingGraphBuild[] | PendingGraphExtraction,
): ContentGraph {
  const builds: readonly PendingGraphBuild[] = Array.isArray(buildsOrExtraction)
    ? buildsOrExtraction
    : (buildsOrExtraction as PendingGraphExtraction).builds
  let result: unknown = parentGraph
  for (const build of builds) {
    const matches = { count: 0 }
    result = mapPendingGraphValue(result, build, matches)
    if (matches.count !== 1) {
      throw new Error(`pending 候选 ${build.candidate.id} 的父图匹配数为 ${matches.count}，拒绝替换`)
    }
  }
  return result as ContentGraph
}

// Names used by migration tooling and tests; keep the implementation in one
// place so a caller can choose the descriptive or short form.
export const extractPendingGraphs = extractPendingSubgraphs
export const buildPendingGraph = buildPendingSubgraph
export const replacePendingExpressions = replacePendingGraphExpressions
