import ts from 'typescript'

export type ContentGraphLexicalBinding = {
  name: string
  declaration: ts.VariableDeclaration
  constant: boolean
  /** A per-iteration binding captured by a nested function needs a lexical
   * execution region, not merely an alpha-renamed function-local variable. */
  repeatedCapture: boolean
}

/** Resolve author identifiers by JavaScript binding identity. No source is
 * executed or printed, and property names are never renamed. The graph importer
 * can lower block locals to unique names without conflating a callback parameter
 * with a same-spelled outer const. Unsupported lifetime semantics remain explicit.
 */
export function createContentGraphBindings(source: ts.SourceFile) {
  const options: ts.CompilerOptions = {allowJs:true, checkJs:true, noLib:true, noResolve:true, types:[], target:ts.ScriptTarget.Latest}
  const host = ts.createCompilerHost(options, true)
  const matchesSource = (fileName:string) => {
    const normalized = fileName.replace(/\\/g, '/')
    const expected = source.fileName.replace(/\\/g, '/')
    return normalized === expected || normalized.endsWith('/' + expected)
  }
  host.getSourceFile = fileName => matchesSource(fileName) ? source : undefined
  host.fileExists = matchesSource
  host.readFile = fileName => matchesSource(fileName) ? source.text : undefined
  host.directoryExists = () => false
  host.getDirectories = () => []
  const checker = ts.createProgram([source.fileName], options, host).getTypeChecker()
  const used = new Set<string>()
  const lexical = new Map<ts.Symbol, ContentGraphLexicalBinding>()
  const functionOwner = (node:ts.Node):ts.Node => {
    let current = node.parent
    while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent
    return current ?? source
  }
  const symbolOf = (node:ts.Identifier) => ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
    ? checker.getShorthandAssignmentValueSymbol(node.parent)
    : checker.getSymbolAtLocation(node)
  const scanNames = (node:ts.Node):void => {
    if (ts.isIdentifier(node)) used.add(node.text)
    ts.forEachChild(node, scanNames)
  }
  scanNames(source)
  let serial = 0
  const scanBindings = (node:ts.Node):void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ts.isVariableDeclarationList(node.parent)
      && node.parent.flags & ts.NodeFlags.BlockScoped) {
      const symbol = symbolOf(node.name)
      if (symbol && !lexical.has(symbol)) {
        let name:string
        do { name = `__rvb_lexical_${serial++}_${node.name.text}` } while (used.has(name))
        used.add(name)
        lexical.set(symbol, {name,declaration:node,constant:!!(node.parent.flags & ts.NodeFlags.Const),repeatedCapture:false})
      }
    }
    ts.forEachChild(node, scanBindings)
  }
  scanBindings(source)
  const scanCaptures = (node:ts.Node):void => {
    if (ts.isIdentifier(node)) {
      const symbol = symbolOf(node)
      const binding = symbol && lexical.get(symbol)
      if (binding && functionOwner(node) !== functionOwner(binding.declaration)) {
        const owner = functionOwner(binding.declaration)
        for (let ancestor:ts.Node | undefined = binding.declaration.parent; ancestor && ancestor !== owner; ancestor = ancestor.parent) {
          if (ts.isForStatement(ancestor) || ts.isForOfStatement(ancestor) || ts.isForInStatement(ancestor)
            || ts.isWhileStatement(ancestor) || ts.isDoStatement(ancestor)) binding.repeatedCapture = true
        }
      }
    }
    ts.forEachChild(node, scanCaptures)
  }
  scanCaptures(source)
  return {
    name(node:ts.Identifier):string { const symbol = symbolOf(node); return (symbol && lexical.get(symbol)?.name) || node.text },
    lexical(node:ts.Identifier):ContentGraphLexicalBinding | undefined { const symbol = symbolOf(node); return symbol ? lexical.get(symbol) : undefined },
    isLocal(node:ts.Identifier):boolean { return !!symbolOf(node)?.declarations?.some(declaration => declaration.getSourceFile() === source) },
    bindings: [...lexical.values()],
  }
}
