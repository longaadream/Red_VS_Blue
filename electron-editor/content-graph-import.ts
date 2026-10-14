import ts from 'typescript'
import { createContentGraphBindings } from './content-graph-bindings'
import {
  CONTENT_GRAPH_VERSION, CONTENT_GRAPH_CAPABILITIES, compileContentGraph,
  type ContentGraph, type ContentGraphExpression as Expr, type ContentGraphNode,
  type ContentGraphSurface, type ContentGraphBinaryOperator, type ContentGraphUnaryOperator,
  type ContentGraphPureCall,
  type ContentGraphCollectionMethod,
  type ContentGraphBoundMethod,
  type ContentGraphRegion, type ContentGraphRegionNode,
  type ContentGraphFunctionGraph, type ContentGraphInvokeNode,
} from './content-graph'

/** A deliberately partial importer. Unsupported syntax is a migration gap, never a code node. */
export function importContentGraph(source: string, surface: ContentGraphSurface): ContentGraph {
  if (source.length > 200_000) throw new Error('内容图导入：源代码超过预算')
  const wrapped = surface === 'pending'
  const tree = ts.createSourceFile('content.js', wrapped ? `(${source})` : source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const diagnostics = (tree as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
  if (diagnostics.length) throw new Error('内容图导入：' + ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n'))
  let nodes: ContentGraphRegionNode[] = []
  let loopDepth = 0
  let serial = 0
  const id = () => `n${serial++}`
  const bindings = createContentGraphBindings(tree)
  const pure = new Set(['Math.abs', 'Math.ceil', 'Math.floor', 'Math.max', 'Math.min', 'Math.pow', 'Math.round', 'Math.sign', 'Math.trunc', 'Number', 'Number.isFinite', 'Number.isInteger', 'String', 'Boolean', 'Array.isArray', 'arePlayersAllied', 'nextEnemyPlayer', 'canAffectAdventureTarget'])
  let omittedParameters: string[] = []
  const collections = new Set(['find', 'filter', 'some', 'every', 'map', 'reduce', 'includes', 'indexOf', 'join', 'slice', 'concat', 'toLowerCase', 'toUpperCase', 'split', 'startsWith', 'trim', 'localeCompare'])
  const mutators = new Set(['push','pop','shift','unshift','splice','sort','reverse'])
  const sourceNames = new Set<string>()
  const generatedNames = new Set<string>()
  let generatedNameSerial = 0
  function collectSourceNames(node: ts.Node): void {
    if (ts.isIdentifier(node)) sourceNames.add(node.text)
    ts.forEachChild(node, collectSourceNames)
  }
  collectSourceNames(tree)
  function isFunctionNode(node: ts.Node): node is ts.FunctionLikeDeclaration {
    return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
  }
  function isLocallyBound(identifier: ts.Identifier): boolean {
    return bindings.isLocal(identifier)
  }
  function identifierName(identifier: ts.Identifier): string {
    return bindings.name(identifier)
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
    if (ts.isPropertySignature(parent) && parent.name === node) return false
    if (ts.isMethodSignature(parent) && parent.name === node) return false
    if (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) return false
    return true
  }
  function assertNoRepeatedCaptures(node: ts.FunctionLikeDeclaration): void {
    const visit = (child: ts.Node): void => {
      if (ts.isIdentifier(child) && isIdentifierReference(child) && bindings.lexical(child)?.repeatedCapture) {
        unsupported(child, '循环块级变量被闭包捕获')
      }
      ts.forEachChild(child, visit)
    }
    if (node.body) visit(node.body)
  }
  function freshLocal(prefix: string): string {
    let name: string
    do name = `__rvb_import_${prefix}_${generatedNameSerial++}`
    while (sourceNames.has(name) || generatedNames.has(name))
    generatedNames.add(name)
    return name
  }
  function isGlobalBoolean(node: ts.Expression): node is ts.Identifier {
    return ts.isIdentifier(node) && node.text === 'Boolean' && !isLocallyBound(node)
  }
  function booleanLambda(): Expr {
    return {kind:'lambda',parameters:['value'],body:{kind:'call',callee:'Boolean',args:[{kind:'ref',name:'value'}]}}
  }
  function collectionArgumentExpression(method: string, index: number, node: ts.Expression): Expr | undefined {
    return index === 0 && ['find','filter','some','every','map','reduce'].includes(method) && isGlobalBoolean(node)
      ? booleanLambda()
      : undefined
  }
  function pureCall(node: ts.CallExpression): boolean {
    if (ts.isPropertyAccessExpression(node.expression) && collections.has(node.expression.name.text)) {
      if (['find','filter','some','every','map','reduce'].includes(node.expression.name.text)) {
        const callback = node.arguments[0]
        return !!callback && (isGlobalBoolean(callback) || ((ts.isFunctionExpression(callback) || ts.isArrowFunction(callback)) && expression(callback).kind === 'lambda'))
      }
      return true
    }
    if (ts.isIdentifier(node.expression)) return !isLocallyBound(node.expression) && pure.has(node.expression.text)
    if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
      return !isLocallyBound(node.expression.expression) && pure.has(node.expression.expression.text+'.'+node.expression.name.text)
    }
    return false
  }
  const unsupported = (node: ts.Node, reason?: string): never => {
    const position = tree.getLineAndCharacterOfPosition(node.getStart(tree))
    throw new Error(`内容图导入：第${position.line + 1}行不支持 ${reason || ts.SyntaxKind[node.kind]}；保留原内容，未迁移`)
  }
  function propertyName(node: ts.PropertyName): string {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
    return unsupported(node, '动态对象键')
  }
  function callName(node: ts.Expression): string {
    if (ts.isIdentifier(node)) return identifierName(node)
    if (ts.isPropertyAccessExpression(node)) return callName(node.expression) + '.' + node.name.text
    return unsupported(node, '动态函数调用')
  }
  function capabilityType(node: ts.Expression): Expr | undefined {
    const operand = ts.isParenthesizedExpression(node) ? node.expression : node
    if (ts.isIdentifier(operand) && CONTENT_GRAPH_CAPABILITIES[operand.text] && !isLocallyBound(operand)) {
      return {kind:'capabilityType',capability:operand.text}
    }
    return undefined
  }
  function uniqueCountArgument(node: ts.Expression): ts.Expression | undefined {
    if (!ts.isPropertyAccessExpression(node) || node.questionDotToken || node.name.text !== 'size') return undefined
    const created = node.expression
    if (!ts.isNewExpression(created) || !ts.isIdentifier(created.expression) || created.expression.text !== 'Set') return undefined
    if (isLocallyBound(created.expression)) return unsupported(created.expression, '局部变量不得遮蔽 Set')
    if (!created.arguments || created.arguments.length !== 1) return unsupported(created, 'new Set 必须只有一个参数')
    return created.arguments[0]
  }
  function errorConstructor(node: ts.Expression): ts.NewExpression | undefined {
    if (!ts.isNewExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'Error') return undefined
    if (isLocallyBound(node.expression)) return unsupported(node.expression, '局部变量不得遮蔽 Error')
    if (node.arguments && node.arguments.length > 1) return unsupported(node, 'new Error 最多接受一个参数')
    return node
  }
  function expression(node: ts.Expression): Expr {
    if (ts.isParenthesizedExpression(node)) return expression(node.expression)
    if (ts.isIdentifier(node)) {
      if (node.text === 'undefined') {
        if (isLocallyBound(node)) return unsupported(node, '局部变量不得命名 undefined')
        return { kind: 'undefined' }
      }
      return { kind: 'ref', name: identifierName(node) }
    }
    if (ts.isNumericLiteral(node)) return { kind: 'literal', value: Number(node.text) }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { kind: 'literal', value: node.text }
    if (ts.isTemplateExpression(node)) return {
      kind: 'template',
      head: node.head.text,
      spans: node.templateSpans.map(span => expression(span.expression)),
      // `head` carries the first literal; compiler emission consumes tails
      // starting at index 1 to keep the schema's spans + 1 shape.
      tails: ['', ...node.templateSpans.map(span => span.literal.text)],
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'literal', value: node.kind === ts.SyntaxKind.TrueKeyword }
    if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: 'literal', value: null }
    if (errorConstructor(node)) return unsupported(node, 'new Error 必须通过 capability 求值')
    if (uniqueCountArgument(node)) return unsupported(node, 'new Set(...).size 必须通过 capability 求值')
    if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) return { kind: 'get', object: expression(node.expression), key: node.name.text }
    if (ts.isElementAccessExpression(node) && !node.questionDotToken) return { kind: 'index', object: expression(node.expression), index: expression(node.argumentExpression) }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      if (node.modifiers?.length || node.asteriskToken || (ts.isFunctionExpression(node) && node.name)) return unsupported(node, '有修饰符或命名的回调')
      assertNoRepeatedCaptures(node)
      const parameters = node.parameters.map(parameter => {
        if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken) return unsupported(parameter, '回调参数')
        if (parameter.name.text === 'undefined') return unsupported(parameter, '局部变量不得命名 undefined')
        return identifierName(parameter.name)
      })
      let body: ts.Expression | undefined
      if (ts.isBlock(node.body)) {
        if (node.body.statements.length === 1 && ts.isReturnStatement(node.body.statements[0])) body = node.body.statements[0].expression
      } else body = node.body
      if (body) {
        try { return { kind: 'lambda', parameters, body: expression(body) } }
        catch (error) { if (!(error instanceof Error) || !error.message.includes('表达式中的非纯调用')) throw error }
      }
      return {kind:'function',parameters,body:functionBody(node.body)}
    }
    if (ts.isObjectLiteralExpression(node)) return {
      kind: 'object', entries: node.properties.map(property => {
        if (ts.isPropertyAssignment(property)) return { key: propertyName(property.name), value: expression(property.initializer) }
        if (ts.isShorthandPropertyAssignment(property) && !property.objectAssignmentInitializer) return { key: property.name.text, value: expression(property.name) }
        return unsupported(property)
      }),
    }
    if (ts.isArrayLiteralExpression(node)) return { kind: 'array', items: node.elements.map(item => expression(item)) }
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return unsupported(node, '赋值表达式')
      return { kind: 'binary', op: node.operatorToken.getText(tree) as ContentGraphBinaryOperator, left: expression(node.left), right: expression(node.right) }
    }
    if (ts.isPrefixUnaryExpression(node)) {
      if ([ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) return unsupported(node, '自增或自减')
      return { kind: 'unary', op: ts.tokenToString(node.operator) as ContentGraphUnaryOperator, argument: expression(node.operand) }
    }
    if (ts.isTypeOfExpression(node)) {
      const helperType = capabilityType(node.expression)
      return helperType || { kind: 'unary', op: 'typeof', argument: expression(node.expression) }
    }
    if (ts.isConditionalExpression(node)) return { kind: 'conditional', test: expression(node.condition), consequent: expression(node.whenTrue), alternate: expression(node.whenFalse) }
    if (ts.isCallExpression(node) && !node.questionDotToken) {
      if (ts.isPropertyAccessExpression(node.expression) && collections.has(node.expression.name.text)) {
        const method = node.expression.name.text
        if (!pureCall(node)) return unsupported(node, '表达式中的非纯调用 '+method)
        return {
          kind: 'collection',
          object: expression(node.expression.expression),
          method: method as ContentGraphCollectionMethod,
          args: node.arguments.map((argument, index) => collectionArgumentExpression(method, index, argument) ?? expression(argument)),
        }
      }
      const name = callName(node.expression)
      if (!pure.has(name)) return unsupported(node, '表达式中的非纯调用 ' + name)
      return { kind: 'call', callee: name as ContentGraphPureCall, args: node.arguments.map(argument => expression(argument)) }
    }
    return unsupported(node)
  }
  function lowerArguments(
    argumentsList: readonly ts.Expression[],
    next: string,
    assign: (index: number, value: Expr) => void,
    preserve?: (index: number, node: ts.Expression) => boolean,
    convert?: (index: number, node: ts.Expression) => Expr | undefined,
  ): string {
    let entry = next
    let laterEffect = false
    for (let index = argumentsList.length - 1; index >= 0; index--) {
      const argument = argumentsList[index]
      if (preserve?.(index, argument)) {
        assign(index, convert?.(index, argument) ?? expression(argument))
        continue
      }
      const after = entry
      const capture = hasEffectfulEvaluation(argument) || (laterEffect && hasDynamicRead(argument))
      if (!capture) {
        assign(index, convert?.(index, argument) ?? expression(argument))
        continue
      }
      entry = captured(argument, value => {
          assign(index, value)
          return after
        })
      laterEffect ||= hasEffectfulEvaluation(argument)
    }
    return entry
  }

  function hasEffectfulEvaluation(node: ts.Expression): boolean {
    if (ts.isParenthesizedExpression(node)) return hasEffectfulEvaluation(node.expression)
    if (errorConstructor(node)) return true
    if (uniqueCountArgument(node)) return true
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return hasEffectfulEvaluation(node.expression) || (ts.isElementAccessExpression(node) && hasEffectfulEvaluation(node.argumentExpression))
    }
    if (ts.isPrefixUnaryExpression(node)) return hasEffectfulEvaluation(node.operand)
    if (ts.isTypeOfExpression(node)) return hasEffectfulEvaluation(node.expression)
    if (ts.isConditionalExpression(node)) return [node.condition,node.whenTrue,node.whenFalse].some(hasEffectfulEvaluation)
    if (ts.isBinaryExpression(node)) return hasEffectfulEvaluation(node.left) || hasEffectfulEvaluation(node.right)
    if (ts.isTemplateExpression(node)) return node.templateSpans.some(span => hasEffectfulEvaluation(span.expression))
    if (ts.isObjectLiteralExpression(node)) return node.properties.some(property => ts.isPropertyAssignment(property)
      ? hasEffectfulEvaluation(property.initializer)
      : ts.isShorthandPropertyAssignment(property) && !!property.objectAssignmentInitializer
        && hasEffectfulEvaluation(property.objectAssignmentInitializer))
    if (ts.isArrayLiteralExpression(node)) return node.elements.some(element => !!element && hasEffectfulEvaluation(element))
    if (ts.isCallExpression(node) && !node.questionDotToken) {
      try {
        if (!pureCall(node)) return true
      } catch { return true }
      return hasEffectfulEvaluation(node.expression) || node.arguments.some(hasEffectfulEvaluation)
    }
    return false
  }

  function hasDynamicRead(node: ts.Expression): boolean {
    if (ts.isParenthesizedExpression(node)) return hasDynamicRead(node.expression)
    if (ts.isIdentifier(node)) return node.text !== 'undefined' || isLocallyBound(node)
    if (ts.isPropertyAccessExpression(node)) return true
    if (ts.isElementAccessExpression(node)) return true
    if (ts.isPrefixUnaryExpression(node)) return hasDynamicRead(node.operand)
    if (ts.isTypeOfExpression(node)) return hasDynamicRead(node.expression)
    if (ts.isConditionalExpression(node)) return [node.condition,node.whenTrue,node.whenFalse].some(hasDynamicRead)
    if (ts.isBinaryExpression(node)) return hasDynamicRead(node.left) || hasDynamicRead(node.right)
    if (ts.isTemplateExpression(node)) return node.templateSpans.some(span => hasDynamicRead(span.expression))
    if (ts.isObjectLiteralExpression(node)) return node.properties.some(property => ts.isPropertyAssignment(property)
      ? hasDynamicRead(property.initializer)
      : ts.isShorthandPropertyAssignment(property)
        && (property.objectAssignmentInitializer ? hasDynamicRead(property.objectAssignmentInitializer) : hasDynamicRead(property.name)))
    if (ts.isArrayLiteralExpression(node)) return node.elements.some(element => !!element && hasDynamicRead(element))
    if (ts.isCallExpression(node)) return hasDynamicRead(node.expression) || node.arguments.some(hasDynamicRead)
    return false
  }

  function setLocal(name: string, value: Expr, next: string): string {
    const current = id()
    nodes.push({ id: current, kind: 'set', target: { kind: 'ref', name }, operator: '=', value, next })
    return current
  }

  /** Read a member and bind its receiver before evaluating any arguments. */
  function invokeBoundMember(
    node: ts.CallExpression,
    method: ContentGraphBoundMethod,
    next: string,
    result?: string,
    preserveCallback = false,
  ): string {
    if (!ts.isPropertyAccessExpression(node.expression)) return unsupported(node, '成员调用')
    const current = id()
    const target: ContentGraphInvokeNode['target'] = {kind:'function',value:{kind:'undefined'}}
    const args: Expr[] = new Array(node.arguments.length)
    nodes.push({id:current,kind:'invoke',target,args,...(result ? {result}:{}),next})
    let entry = lowerArguments(node.arguments, current, (index, value) => { args[index] = value },
      preserveCallback ? (index) => index === 0 : undefined,
      preserveCallback ? (index, argument) => collectionArgumentExpression(method, index, argument) : undefined)
    const methodName = freshLocal('bound_method')
    const after = entry
    entry = evaluated(node.expression.expression, object => {
      target.value = {kind:'ref',name:methodName}
      const bind = id()
      nodes.push({id:bind,kind:'bind',name:methodName,expr:{kind:'boundMethod',object,method},next:after})
      return bind
    })
    return entry
  }

  function capability(node: ts.CallExpression, next: string, result?: string): string {
    const callable = ts.isParenthesizedExpression(node.expression) ? node.expression.expression : node.expression
    if (ts.isPropertyAccessExpression(callable) && ['forEach','map','filter','find','some','every','findIndex','reduce'].includes(callable.name.text)) {
      return invokeBoundMember(node, callable.name.text as ContentGraphBoundMethod, next, result, true)
    }
    if (ts.isFunctionExpression(callable) || ts.isArrowFunction(callable)
      || (ts.isIdentifier(callable) && isLocallyBound(callable))) {
      const current = id()
      const target: ContentGraphInvokeNode['target'] = {kind:'function' as const,value:{kind:'undefined' as const}}
      const args: Expr[] = new Array(node.arguments.length)
      const invoke: ContentGraphInvokeNode = {id:current,kind:'invoke',target,args,...(result ? {result}:{}),next}
      nodes.push(invoke)
      let entry = lowerArguments(node.arguments, current, (index, value) => { args[index] = value })
      const after = entry
      entry = captured(callable, value => {
        target.value = value
        return after
      })
      return entry
    }
    let name: string
    let argumentNodes: ts.Expression[]
    const queueAliases:Record<string,string> = {'context.healQueue.push':'queue.heal','context.damageQueue.push':'queue.damage','context.damageRedirectQueue.push':'queue.damageRedirect','context.presentationQueue.push':'queue.presentation','context.summonQueue.push':'queue.summon'}
    if (ts.isPropertyAccessExpression(node.expression) && mutators.has(node.expression.name.text)) {
      const method = node.expression.name.text as ContentGraphBoundMethod
      const preserveReceiverAndMethod = hasEffectfulEvaluation(node.expression.expression) || node.arguments.some(hasEffectfulEvaluation)
      if (preserveReceiverAndMethod) {
        const current = id()
        const target: ContentGraphInvokeNode['target'] = {kind:'function',value:{kind:'undefined'}}
        const args: Expr[] = new Array(node.arguments.length)
        nodes.push({id:current,kind:'invoke',target,args,...(result ? {result}:{}),next})
        let entry = lowerArguments(node.arguments, current, (index, value) => { args[index] = value })
        const methodName = freshLocal('bound_method')
        const after = entry
        entry = evaluated(node.expression.expression, object => {
          target.value = {kind:'ref',name:methodName}
          const bind = id()
          nodes.push({id:bind,kind:'bind',name:methodName,expr:{kind:'boundMethod',object,method},next:after})
          return bind
        })
        return entry
      }
      // Legacy push accepts zero or many records. Semantic enqueue helpers
      // take one record (queue.heal also has an authored tuple overload), so
      // only the single-record form may use that shorthand.
      const alias = node.arguments.length === 1 && !node.arguments.some(hasEffectfulEvaluation)
        ? queueAliases[node.expression.getText(tree)]
        : undefined
      name = alias ?? `array.${node.expression.name.text}`
      argumentNodes = [...(alias ? [] : [node.expression.expression]), ...node.arguments]
    } else {
      name = callName(node.expression)
      argumentNodes = [...node.arguments]
    }
    const current = id()
    const args: Expr[] = new Array(argumentNodes.length)
    nodes.push({ id: current, kind: 'call', capability: name, args, ...(result ? { result } : {}), next })
    return lowerArguments(argumentNodes, current, (index, value) => { args[index] = value })
  }
  function captured(node: ts.Expression, consume: (value: Expr) => string): string {
    return evaluated(node, value => {
      const current = id()
      const name = freshLocal('operand')
      const next = consume({kind:'ref',name})
      nodes.push({id:current,kind:'bind',name,expr:value,next})
      return current
    })
  }

  function evaluatedBranch(
    test: ts.Expression,
    consequent: ts.Expression,
    alternate: ts.Expression,
    consume: (value: Expr) => string,
  ): string {
    const name = freshLocal('value')
    const after = consume({kind:'ref',name})
    const yes = evaluated(consequent, value => setLocal(name, value, after))
    const no = evaluated(alternate, value => setLocal(name, value, after))
    const branchId = id()
    const branch: Extract<ContentGraphRegionNode, {kind:'branch'}> = {
      id: branchId,
      kind: 'branch',
      condition: {kind:'undefined'},
      yes,
      no,
    }
    nodes.push(branch)
    const branchEntry = captured(test, value => {
      branch.condition = {kind:'unary',op:'!',argument:{kind:'unary',op:'!',argument:value}}
      return branchId
    })
    const initial = id()
    nodes.push({id:initial,kind:'bind',name,next:branchEntry,expr:{kind:'undefined'}})
    return initial
  }

  function evaluatedLogical(node: ts.BinaryExpression, consume: (value: Expr) => string): string {
    const operator = node.operatorToken.getText(tree) as '&&' | '||' | '??'
    const name = freshLocal('value')
    const after = consume({kind:'ref',name})
    const right = evaluated(node.right, value => setLocal(name, value, after))
    const branchId = id()
    const leftName = freshLocal('left')
    const left = {kind:'ref' as const,name:leftName}
    const leftPath = setLocal(name, left, after)
    const condition: Expr = operator === '??'
      ? {kind:'binary',op:'&&',left:{kind:'binary',op:'!==',left,right:{kind:'literal',value:null}},right:{kind:'binary',op:'!==',left,right:{kind:'undefined'}}}
      : {kind:'unary',op:'!',argument:{kind:'unary',op:'!',argument:left}}
    nodes.push({id:branchId,kind:'branch',condition,yes:operator === '||' || operator === '??' ? leftPath : right,no:operator === '&&' ? leftPath : right})
    const branchEntry = captured(node.left, value => {
      left.name = value.kind === 'ref' ? value.name : leftName
      if (value.kind !== 'ref') {
        const bindId = id()
        nodes.push({id:bindId,kind:'bind',name:leftName,expr:value,next:branchId})
        return bindId
      }
      return branchId
    })
    const initial = id()
    nodes.push({id:initial,kind:'bind',name,next:branchEntry,expr:{kind:'undefined'}})
    return initial
  }

  // Lower effectful operands through graph nodes while preserving JavaScript's
  // left-to-right and conditional evaluation order. Assignment targets stay on
  // the existing expression path so their reference timing is unchanged.
  function evaluated(node: ts.Expression, consume: (value: Expr) => string): string {
    if (!hasEffectfulEvaluation(node)) return consume(expression(node))
    if (ts.isParenthesizedExpression(node)) return evaluated(node.expression, consume)
    const error = errorConstructor(node)
    if (error) {
      const result = freshLocal('effect')
      const after = consume({kind:'ref',name:result})
      const args: Expr[] = new Array(error.arguments?.length ?? 0)
      const current = id()
      nodes.push({id:current,kind:'call',capability:'error.create',args,result,next:after})
      return lowerArguments(error.arguments ? [...error.arguments] : [], current, (index, value) => { args[index] = value })
    }
    const uniqueCount = uniqueCountArgument(node)
    if (uniqueCount) {
      const result = freshLocal('effect')
      const after = consume({kind:'ref',name:result})
      const current = id()
      const args: Expr[] = new Array(1)
      nodes.push({id:current,kind:'call',capability:'collection.uniqueCount',args,result,next:after})
      return lowerArguments([uniqueCount], current, (index, value) => { args[index] = value })
    }
    if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) {
      return evaluated(node.expression, object => consume({ kind: 'get', object, key: node.name.text }))
    }
    if (ts.isElementAccessExpression(node) && !node.questionDotToken) {
      const evaluateBase = hasEffectfulEvaluation(node.argumentExpression) ? captured : evaluated
      return evaluateBase(node.expression, object => evaluated(node.argumentExpression, index => consume({ kind: 'index', object, index })))
    }
    if (ts.isPrefixUnaryExpression(node) && ![ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
      return evaluated(node.operand, argument => consume({ kind: 'unary', op: ts.tokenToString(node.operator) as ContentGraphUnaryOperator, argument }))
    }
    if (ts.isTypeOfExpression(node)) {
      const helperType = capabilityType(node.expression)
      if (helperType) return consume(helperType)
      return evaluated(node.expression, argument => consume({kind:'unary',op:'typeof',argument}))
    }
    if (ts.isConditionalExpression(node)) {
      return evaluatedBranch(node.condition, node.whenTrue, node.whenFalse, consume)
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.getText(tree)
      if (operator === '&&' || operator === '||' || operator === '??') return evaluatedLogical(node, consume)
      if (node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        return consume(expression(node))
      }
      return captured(node.left, left => evaluated(node.right, right => consume({kind:'binary',op:operator as ContentGraphBinaryOperator,left,right})))
    }
    if (ts.isTemplateExpression(node)) {
      const value: Extract<Expr,{kind:'template'}> = {
        kind:'template',
        head:node.head.text,
        spans:node.templateSpans.map(() => ({kind:'undefined'})),
        tails:['', ...node.templateSpans.map(span => span.literal.text)],
      }
      let entry = consume(value)
      for (let index = node.templateSpans.length - 1; index >= 0; index--) {
        const after = entry
        entry = captured(node.templateSpans[index].expression, span => {
          value.spans[index] = span
          return after
        })
      }
      return entry
    }
    if (ts.isObjectLiteralExpression(node)) {
      const properties = node.properties.map(property => {
        if (ts.isPropertyAssignment(property)) return {key: propertyName(property.name), node: property.initializer}
        if (ts.isShorthandPropertyAssignment(property) && !property.objectAssignmentInitializer) return {key: property.name.text, node: property.name}
        return unsupported(property)
      })
      const entries = properties.map(property => ({key:property.key,value:{kind:'undefined'} as Expr}))
      let entry = consume({kind:'object',entries})
      for (let index = properties.length - 1; index >= 0; index--) {
        const after = entry
        entry = captured(properties[index].node, value => {
          entries[index].value = value
          return after
        })
      }
      return entry
    }
    if (ts.isArrayLiteralExpression(node)) {
      const items: Expr[] = node.elements.map(() => ({kind:'undefined'}))
      let entry = consume({kind:'array',items})
      for (let index = node.elements.length - 1; index >= 0; index--) {
        const item = node.elements[index] as unknown as ts.Expression
        const after = entry
        entry = captured(item, value => {
          items[index] = value
          return after
        })
      }
      return entry
    }
    if (ts.isCallExpression(node) && !node.questionDotToken) {
      if (!pureCall(node)) {
        const name = freshLocal('effect')
        const next = consume({ kind: 'ref', name })
        return capability(node, next, name)
      }
      if (ts.isPropertyAccessExpression(node.expression) && collections.has(node.expression.name.text)) {
        const method = node.expression.name.text as ContentGraphCollectionMethod
        const needsBoundMethod = hasEffectfulEvaluation(node.expression.expression) || node.arguments.some(hasEffectfulEvaluation)
        if (needsBoundMethod) {
          const result = freshLocal('effect')
          const after = consume({kind:'ref',name:result})
          return invokeBoundMember(node, method, after, result,
            ['find','filter','some','every','map','reduce'].includes(method))
        }
        const value: Extract<Expr,{kind:'collection'}> = {kind:'collection',object:{kind:'undefined'},method,args:new Array(node.arguments.length)}
        let entry = consume(value)
        entry = lowerArguments(node.arguments, entry, (index, argument) => { value.args[index] = argument },
          (index) => index === 0 && ['find','filter','some','every','map','reduce'].includes(method),
          (index, argument) => collectionArgumentExpression(method, index, argument))
        const after = entry
        entry = captured(node.expression.expression, object => { value.object = object; return after })
        return entry
      }
      const value: Extract<Expr,{kind:'call'}> = {kind:'call',callee:callName(node.expression) as ContentGraphPureCall,args:new Array(node.arguments.length)}
      const entry = lowerArguments(node.arguments, consume(value), (index, argument) => { value.args[index] = argument })
      return entry
    }
    return consume(expression(node))
  }
  function sequence(statements: readonly ts.Statement[], next: string): string {
    let entry = next
    for (let index = statements.length - 1; index >= 0; index--) entry = statement(statements[index], entry)
    return entry
  }
  function region(build: (end: string) => string): ContentGraphRegion {
    const parentNodes = nodes
    nodes = []
    loopDepth++
    try {
      const end = id()
      nodes.push({id:end,kind:'regionEnd'})
      const entry = build(end)
      const reachable = reachableNodes(entry, nodes)
      if (!reachable.some(node => node.id === end)) reachable.push({id:end,kind:'regionEnd'})
      return {entry,end,nodes:reachable}
    } finally { nodes = parentNodes; loopDepth-- }
  }
  function varDeclarations(body: ts.Node): ts.VariableDeclaration[] {
    const declarations: ts.VariableDeclaration[] = []
    const visit = (node: ts.Node): void => {
      if (node !== body && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) return
      if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && !(node.parent.flags & ts.NodeFlags.BlockScoped)) {
        declarations.push(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(body)
    return declarations
  }
  function assertVarDeclarationsPreserved(body: ts.Node, regionNodes: readonly ContentGraphRegionNode[]): void {
    const represented = new Set<string>()
    const collect = (region: readonly ContentGraphRegionNode[]): void => {
      for (const node of region) {
        if (node.kind === 'bind') represented.add(node.name)
        if ((node.kind === 'call' || node.kind === 'invoke' || node.kind === 'delete') && node.result) represented.add(node.result)
        if (node.kind === 'loop') {
          if ('item' in node && typeof node.item === 'string') represented.add(node.item)
          collect(node.body.nodes)
          if (node.loop === 'for' && node.update) collect(node.update.nodes)
        } else if (node.kind === 'try') {
          collect(node.body.nodes)
          if (node.catch) collect(node.catch.body.nodes)
          if (node.finally) collect(node.finally.nodes)
        }
      }
    }
    collect(regionNodes)
    for (const declaration of varDeclarations(body)) {
      if (!ts.isIdentifier(declaration.name) || !represented.has(declaration.name.text)) {
        unsupported(declaration, '无法保留 var 提升作用域')
      }
    }
  }
  function isUnconditionalVarDeclaration(declaration: ts.VariableDeclaration): boolean {
    const list = declaration.parent
    const statement = list.parent
    if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.BlockScoped) || !ts.isVariableStatement(statement)) return false
    const scope = statement.parent
    return ts.isSourceFile(scope) || (ts.isBlock(scope) && isFunctionNode(scope.parent) && scope.parent.body === scope)
  }
  function functionBody(body:ts.ConciseBody):ContentGraphFunctionGraph {
    const parentNodes = nodes
    const parentDepth = loopDepth
    nodes = []
    loopDepth = 0
    try {
      const end = id()
      nodes.push({id:end,kind:'regionEnd'})
      const entry = ts.isBlock(body) ? sequence(body.statements,end) : evaluated(body,value => {
        const current = id()
        nodes.push({id:current,kind:'return',value})
        return current
      })
      const reachable = reachableNodes(entry,nodes)
      if (!reachable.some(node => node.id === end)) reachable.push({id:end,kind:'regionEnd'})
      assertVarDeclarationsPreserved(body, reachable)
      return {entry,end,nodes:reachable}
    } finally { nodes = parentNodes; loopDepth = parentDepth }
  }
  function declarations(list: ts.VariableDeclarationList, next: string): string {
    let entry = next
    for (const declaration of [...list.declarations].reverse()) {
      if (!ts.isIdentifier(declaration.name)) return unsupported(declaration, '解构变量')
      if (declaration.name.text === 'undefined') return unsupported(declaration, '局部变量不得命名 undefined')
      if (!declaration.initializer) {
        if (!isUnconditionalVarDeclaration(declaration)) return unsupported(declaration, '非无条件 var 声明缺少初始化')
        const current = id()
        nodes.push({id:current,kind:'bind',name:identifierName(declaration.name),expr:{kind:'undefined'},next:entry})
        entry = current
        continue
      }
      const initializer = declaration.initializer
      if (ts.isCallExpression(initializer) && !pureCall(initializer)) entry = capability(initializer, entry, identifierName(declaration.name))
      else {
        const next = entry
        const name = identifierName(declaration.name)
        entry = evaluated(initializer, value => {
          const current = id()
          nodes.push({ id: current, kind: 'bind', name, expr: value, next })
          return current
        })
      }
    }
    return entry
  }
  function evaluatedReference(node: ts.Expression, consume: (target: Extract<Expr,{kind:'ref'|'get'|'index'}>) => string): string {
    if (ts.isParenthesizedExpression(node)) return evaluatedReference(node.expression, consume)
    if (ts.isIdentifier(node)) return consume({kind:'ref',name:identifierName(node)})
    if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) {
      return captured(node.expression, object => consume({kind:'get',object,key:node.name.text}))
    }
    if (ts.isElementAccessExpression(node) && !node.questionDotToken && node.argumentExpression) {
      return captured(node.expression, object => captured(node.argumentExpression!, index => consume({kind:'index',object,index})))
    }
    return unsupported(node, '自增或自减目标')
  }
  function expressionStatement(value: ts.Expression, next: string): string {
    if (ts.isDeleteExpression(value)) {
      if (ts.isIdentifier(value.expression)) return unsupported(value, '不能 delete 局部引用')
      return evaluatedReference(value.expression, target => {
        if (target.kind === 'ref') return unsupported(value, '不能 delete 局部引用')
        const current = id()
        nodes.push({id:current,kind:'delete',target:target.kind === 'get'
          ? {kind:'get',object:target.object,key:target.key}
          : {kind:'index',object:target.object,index:target.index},next})
        return current
      })
    }
    if (ts.isCallExpression(value)) return capability(value, next)
    if ((ts.isPrefixUnaryExpression(value) || ts.isPostfixUnaryExpression(value)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(value.operator)) {
      return evaluatedReference(value.operand, target => {
        const operator = value.operator === ts.SyntaxKind.PlusPlusToken ? '+' : '-'
        if (target.kind === 'ref') {
          const current = id()
          nodes.push({id:current,kind:'set',target,operator:'=',value:{kind:'binary',op:operator,left:{kind:'unary',op:'+',argument:target},right:{kind:'literal',value:1}},next})
          return current
        }
        const oldName = freshLocal('increment_old')
        const set = id()
        nodes.push({id:set,kind:'set',target,operator:'=',value:{kind:'binary',op:operator,left:{kind:'unary',op:'+',argument:{kind:'ref',name:oldName}},right:{kind:'literal',value:1}},next})
        const bind = id()
        nodes.push({id:bind,kind:'bind',name:oldName,expr:target,next:set})
        return bind
      })
    }
    if (ts.isBinaryExpression(value)) {
      const operator = value.operatorToken.getText(tree)
      if (!['=', '+=', '-=', '*=', '/='].includes(operator)) return unsupported(value, '赋值操作符')
      const target = expression(value.left)
      if (target.kind !== 'ref' && target.kind !== 'get' && target.kind !== 'index') return unsupported(value.left, '赋值目标')
      return evaluated(value.right, right => {
        const current = id()
        nodes.push({ id: current, kind: 'set', target, operator: operator as '=' | '+=' | '-=' | '*=' | '/=', value: right, next })
        return current
      })
    }
    return unsupported(value)
  }
  function statement(node: ts.Statement, next: string): string {
    if (ts.isBlock(node)) return sequence(node.statements, next)
    if (ts.isEmptyStatement(node)) return next
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      if (!loopDepth || node.label) return unsupported(node, '循环外或带标签跳转')
      const current = id()
      nodes.push({id:current,kind:ts.isBreakStatement(node) ? 'break' : 'continue'})
      return current
    }
    if (ts.isForOfStatement(node)) {
      if (node.awaitModifier) return unsupported(node, 'for-await-of')
      if (!ts.isVariableDeclarationList(node.initializer) || node.initializer.declarations.length !== 1) return unsupported(node.initializer, 'for-of 必须使用单个变量声明')
      const declaration = node.initializer.declarations[0]
      if (!ts.isIdentifier(declaration.name) || declaration.initializer) return unsupported(declaration, 'for-of 变量声明')
      if (declaration.name.text === 'undefined') return unsupported(declaration, '局部变量不得命名 undefined')
      const body = region(end => statement(node.statement, end))
      const current = id()
      const loop: Extract<ContentGraphRegionNode,{kind:'loop'}> = {
        id:current,
        kind:'loop',
        loop:'forOf',
        iterable:{kind:'undefined'},
        item:identifierName(declaration.name),
        body,
        next,
      }
      nodes.push(loop)
      return evaluated(node.expression, iterable => {
        loop.iterable = iterable
        return current
      })
    }
    if (ts.isForInStatement(node)) {
      if (!ts.isVariableDeclarationList(node.initializer) || node.initializer.declarations.length !== 1) return unsupported(node.initializer, 'for-in 必须使用单个变量声明')
      const declaration = node.initializer.declarations[0]
      if (!ts.isIdentifier(declaration.name) || declaration.initializer) return unsupported(declaration, 'for-in 变量声明')
      if (declaration.name.text === 'undefined') return unsupported(declaration, '局部变量不得命名 undefined')
      const body = region(end => statement(node.statement, end))
      const current = id()
      const loop: Extract<ContentGraphRegionNode,{kind:'loop'}> = {
        id:current,
        kind:'loop',
        loop:'forIn',
        iterable:{kind:'undefined'},
        item:identifierName(declaration.name),
        body,
        next,
      }
      nodes.push(loop)
      return evaluated(node.expression, iterable => {
        loop.iterable = iterable
        return current
      })
    }
    if (ts.isForStatement(node) || ts.isWhileStatement(node)) {
      const isFor = ts.isForStatement(node)
      const body = region(end => statement(node.statement, end))
      const update = isFor ? region(end => node.incrementor ? expressionStatement(node.incrementor, end) : end) : undefined
      const condition = isFor ? node.condition : node.expression
      const current = id()
      nodes.push({id:current,kind:'loop',loop:isFor ? 'for':'while',condition:condition ? {kind:'unary',op:'!',argument:{kind:'unary',op:'!',argument:expression(condition)}}:{kind:'literal',value:true},body,...(update ? {update}:{}),next})
      if (isFor && node.initializer) return ts.isVariableDeclarationList(node.initializer) ? declarations(node.initializer,current) : expressionStatement(node.initializer,current)
      return current
    }
    if (ts.isThrowStatement(node)) {
      if (!node.expression) return unsupported(node, 'throw 必须有表达式')
      return evaluated(node.expression, value => {
        const current = id()
        nodes.push({id:current,kind:'throw',value})
        return current
      })
    }
    if (ts.isTryStatement(node)) {
      const body = region(end => statement(node.tryBlock, end))
      let catchClause: Extract<ContentGraphRegionNode,{kind:'try'}>['catch']
      if (node.catchClause) {
        const declaration = node.catchClause.variableDeclaration
        let parameter: string | undefined
        if (declaration) {
          if (!ts.isIdentifier(declaration.name) || declaration.initializer || declaration.type) return unsupported(declaration, 'catch 参数')
          if (declaration.name.text === 'undefined') return unsupported(declaration, '局部变量不得命名 undefined')
          parameter = identifierName(declaration.name)
        }
        catchClause = { ...(parameter === undefined ? {} : {parameter}), body:region(end => statement(node.catchClause!.block, end)) }
      }
      const finallyRegion = node.finallyBlock ? region(end => statement(node.finallyBlock!, end)) : undefined
      const current = id()
      nodes.push({id:current,kind:'try',body,...(catchClause ? {catch:catchClause} : {}),...(finallyRegion ? {finally:finallyRegion} : {}),next})
      return current
    }
    if (ts.isReturnStatement(node)) {
      const finish = (value?: Expr) => {
        const current = id()
        nodes.push({ id: current, kind: 'return', ...(value ? { value } : {}) })
        return current
      }
      return node.expression ? evaluated(node.expression, finish) : finish()
    }
    if (ts.isIfStatement(node)) {
      const yes = statement(node.thenStatement, next)
      const no = node.elseStatement ? statement(node.elseStatement, next) : next
      return evaluated(node.expression, condition => {
        const current = id()
        nodes.push({ id: current, kind: 'branch', condition: {kind:'unary',op:'!',argument:{kind:'unary',op:'!',argument:condition}}, yes, no })
        return current
      })
    }
    if (ts.isFunctionDeclaration(node)) {
      if (!node.name || !node.body) return unsupported(node, '函数声明')
      assertNoRepeatedCaptures(node)
      const parameters = node.parameters.map(parameter => {
        if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken) return unsupported(parameter, '函数声明参数')
        return identifierName(parameter.name)
      })
      const current = id()
      nodes.push({
        id: current,
        kind: 'bind',
        name: identifierName(node.name),
        expr: {kind:'function', parameters, body:functionBody(node.body)},
        next,
      })
      return current
    }
    if (ts.isVariableStatement(node)) {
      return declarations(node.declarationList,next)
    }
    if (ts.isExpressionStatement(node)) return expressionStatement(node.expression,next)
    return unsupported(node)
  }
  let statements: readonly ts.Statement[] = tree.statements
  let entryBody: ts.Node = tree
  let entryFunction: ts.FunctionLikeDeclaration | undefined
  if (surface !== 'rule') {
    if (tree.statements.length !== 1) throw new Error('内容图导入：必须只有一个入口函数')
    let entry: ts.Node = tree.statements[0]
    if (wrapped && ts.isExpressionStatement(entry) && ts.isParenthesizedExpression(entry.expression)) entry = entry.expression.expression
    if ((!ts.isFunctionDeclaration(entry) && !ts.isFunctionExpression(entry)) || !entry.body) return unsupported(entry, '入口函数')
    entryFunction = entry
    const expected = surface === 'card' ? 'executeCard' : surface === 'preview' ? 'calculatePreview' : surface === 'pending' ? undefined : 'executeSkill'
    if (expected && entry.name?.text !== expected) return unsupported(entry, '入口函数名')
    const parameters = surface === 'pending' ? ['ctx'] : surface === 'preview' ? ['piece', 'skillDef', 'currentCooldown'] : ['context']
    if (entry.modifiers?.length || entry.asteriskToken || entry.parameters.some((parameter, index) =>
      !ts.isIdentifier(parameter.name) || parameter.name.text !== parameters[index] || parameter.initializer || parameter.dotDotDotToken)) return unsupported(entry, '入口函数参数或修饰符')
    omittedParameters = parameters.slice(entry.parameters.length)
    statements = entry.body.statements
    entryBody = entry.body
  }
  // A DAG binding is function-local. Reject syntax whose scope or optional
  // evaluation cannot yet be represented instead of flattening its semantics.
  function directFunctionOwner(node: ts.FunctionDeclaration): ts.FunctionLikeDeclaration | ts.SourceFile | undefined {
    if (surface === 'rule' && node.parent === tree) return tree
    const block = node.parent
    if (!ts.isBlock(block) || !isFunctionNode(block.parent) || block.parent.body !== block) return undefined
    return block.parent
  }
  function validateFunctionDeclaration(node: ts.FunctionDeclaration): void {
    if (entryFunction === node) return
    const owner = directFunctionOwner(node)
    if (!owner || !node.name || node.modifiers?.length || node.asteriskToken) return unsupported(node, '函数声明必须位于函数体顶层')
    const ownerBody = ts.isSourceFile(owner) ? owner : owner.body
    if (!ownerBody) return unsupported(node, '函数声明缺少函数体')
    if (node.parameters.some(parameter => !ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken || parameter.name.text === 'undefined')) {
      return unsupported(node, '函数声明参数')
    }
    const name = node.name.text
    if (isFunctionNode(owner)) for (const parameter of owner.parameters) {
      if (ts.isIdentifier(parameter.name) && parameter.name.text === name) return unsupported(node, '函数声明名称被参数遮蔽')
    }
    const visitDeclarations = (child: ts.Node): void => {
      if (child !== ownerBody && isFunctionNode(child)) return
      if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.name.text === name) {
        return unsupported(child, '函数声明名称重复')
      }
      if (ts.isFunctionDeclaration(child) && child !== node && child.name?.text === name) {
        return unsupported(child, '函数声明名称重复')
      }
      ts.forEachChild(child, visitDeclarations)
    }
    visitDeclarations(ownerBody)
    const visitReferences = (child: ts.Node): void => {
      if (ts.isIdentifier(child) && child !== node.name && child.text === name && isIdentifierReference(child)) {
        let current: ts.Node | undefined = child.parent
        let insideDeclaration = false
        while (current && current !== owner) {
          if (current === node.body) {
            insideDeclaration = true
            break
          }
          current = current.parent
        }
        if (insideDeclaration) return unsupported(child, '函数声明不得递归引用')
        if (child.getStart(tree) < node.getStart(tree)) return unsupported(child, '函数声明必须先于首次引用')
      }
      ts.forEachChild(child, visitReferences)
    }
    visitReferences(ownerBody)
  }
  function checkSyntax(node: ts.Node): void {
    if ((ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && node.questionDotToken) unsupported(node, '可选链')
    if (ts.isFunctionDeclaration(node)) validateFunctionDeclaration(node)
    ts.forEachChild(node, checkSyntax)
  }
  checkSyntax(tree)
  function isBeforeLexicalInitialization(node: ts.Identifier, declaration: ts.VariableDeclaration): boolean {
    if (node.getStart(tree) < declaration.getStart(tree)) return true
    const initializer = declaration.initializer
    return !!initializer && node.getStart(tree) >= initializer.getStart(tree) && node.getStart(tree) < initializer.end
  }
  function checkConstantWrites(node: ts.Node): void {
    if (ts.isIdentifier(node) && isIdentifierReference(node)) {
      const lexical = bindings.lexical(node)
      if (lexical && isBeforeLexicalInitialization(node, lexical.declaration)) unsupported(node, '词法变量初始化前引用')
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left) && bindings.lexical(node.left)?.constant) unsupported(node, 'const 重新赋值')
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) && ts.isIdentifier(node.operand) && bindings.lexical(node.operand)?.constant) unsupported(node, 'const 自增或自减')
    ts.forEachChild(node, checkConstantWrites)
  }
  checkConstantWrites(tree)
  const fallthrough = id()
  nodes.push({ id: fallthrough, kind: 'return' })
  const entry = sequence(statements, fallthrough)
  // Discard only unreachable synthetic continuations; never turn unsupported code into a placeholder.
  function reachableNodes(entryId:string, regionNodes:ContentGraphRegionNode[]):ContentGraphRegionNode[] {
  const byId = new Map(regionNodes.map(node => [node.id, node]))
  const reachable = new Set<string>()
  function visit(nodeId: string) {
    if (reachable.has(nodeId)) return
    reachable.add(nodeId)
    const node = byId.get(nodeId)!
    if (node.kind === 'branch') { visit(node.yes); visit(node.no) }
    else if ('next' in node) visit(node.next)
  }
  visit(entryId)
  return regionNodes.filter(node => reachable.has(node.id))
  }
  const graph: ContentGraph = { version: CONTENT_GRAPH_VERSION, surface, entry, nodes: reachableNodes(entry,nodes) as ContentGraphNode[] }
  function checkOmittedInput(value: unknown): void {
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (record.kind === 'ref' && typeof record.name === 'string' && omittedParameters.includes(record.name.split('.')[0])) {
      throw new Error('内容图导入：不得引用原入口未声明的参数 ' + record.name)
    }
    for (const nested of Object.values(record)) checkOmittedInput(nested)
  }
  checkOmittedInput(graph)
  assertVarDeclarationsPreserved(entryBody, graph.nodes)
  compileContentGraph(graph)
  return graph
}
