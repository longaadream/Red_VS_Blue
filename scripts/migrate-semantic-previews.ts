import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import {
  GAMEPLAY_MODULE_COMPILER_VERSION,
  GAMEPLAY_MODULE_DOCUMENT_VERSION,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  compileGameplayModuleGraph,
  type GameplayLiteral,
  type GameplayModuleDescriptor,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayPort,
  type GameplayRecordSchema,
  type GameplayStatement,
  type GameplayValue,
  type GameplayValueType,
} from '../lib/skill-graph/module-document'
import { GAMEPLAY_MODULE_REGISTRY } from '../lib/skill-graph/module-registry'
import { PREVIEW_VALUE_GAMEPLAY_MODULES } from '../lib/skill-graph/module-registry-preview-values'
import { assertFrozenExecutable } from './semantic-migration-source'

export const SEMANTIC_PREVIEW_VERSION = '1' as const
export const SEMANTIC_PREVIEW_FIELD = 'previewCode' as const

type JsonRecord = Record<string, unknown>
type PrimitiveType = 'number' | 'string' | 'boolean'
type PreviewType = PrimitiveType | { readonly kind: 'list'; readonly element: PrimitiveType }

type PreviewExpression = {
  readonly value: GameplayValue
  readonly type: PreviewType
  readonly statusAlias?: boolean
}

export type SemanticPreviewParseResult =
  | { readonly kind: 'preview'; readonly functionName: string; readonly graph: GameplayModuleGraph }
  | { readonly kind: 'skip'; readonly reason: string }

export type SemanticPreviewMigration = {
  readonly id: string
  readonly field: typeof SEMANTIC_PREVIEW_FIELD
  readonly surface: 'preview'
  readonly source: string
  readonly build: () => GameplayModuleGraph
}

export type SemanticPreviewReport = {
  readonly id: string
  readonly field: typeof SEMANTIC_PREVIEW_FIELD
  readonly surface?: 'preview'
  readonly status: 'ready' | 'already-migrated' | 'skipped' | 'blocked'
  readonly reason?: string
  readonly file?: string
  readonly document?: JsonRecord
}

export type SemanticPreviewRun = {
  readonly migrations: readonly SemanticPreviewMigration[]
  readonly reports: readonly SemanticPreviewReport[]
  readonly documents: ReadonlyMap<string, JsonRecord>
  readonly coverage: {
    readonly ordinaryCandidates: number
    readonly ready: number
    readonly alreadyMigrated: number
    readonly skipped: number
    readonly blocked: number
  }
}

const GENERATED_FIELDS = new Set([
  'code',
  'skillCode',
  'triggerSkill',
  'effectCode',
  'previewCode',
  'gameplayModules',
  'contentGraph',
  'contentGraphField',
  'contentGraphCompilerVersion',
  'contentGraphEntries',
])

const PROTECTED_PREFIXES = [
  'minato-',
  'turalyon-',
  'tails-armor-',
  'tails-mechanical-',
] as const

const PROTECTED_IDS = new Set(['skills/rafaam-curse-amplify'])

function record(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as JsonRecord)[key])}`).join(',')}}`
}

function readJson(file: string): JsonRecord {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  if (!record(value)) throw new Error(`${file}: expected a JSON object`)
  return value
}

function literal(value: GameplayLiteral): GameplayValue {
  return { kind: 'literal', value }
}

function input(name: string): GameplayValue {
  return { kind: 'input', name }
}

function output(node: string, port: string): GameplayValue {
  return { kind: 'output', node, port }
}

function port(name: string, type: GameplayPort['type'], options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort {
  return { name, type, ...options }
}

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayLiteral>> = {},
): GameplayStatement {
  return { kind: 'call', id, module, version: SEMANTIC_PREVIEW_VERSION, inputs, parameters }
}

function diagnosticText(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
}

function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
  return undefined
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

function stringOrNumberLiteral(node: ts.Expression): GameplayLiteral | undefined {
  const value = unwrap(node)
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text
  if (ts.isNumericLiteral(value)) {
    const number = Number(value.text)
    return Number.isFinite(number) ? number : undefined
  }
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false
  if (value.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isPrefixUnaryExpression(value)
    && (value.operator === ts.SyntaxKind.PlusToken || value.operator === ts.SyntaxKind.MinusToken)
    && ts.isNumericLiteral(value.operand)) {
    const number = Number(value.operand.text)
    if (!Number.isFinite(number)) return undefined
    return value.operator === ts.SyntaxKind.MinusToken ? -number : number
  }
  return undefined
}

function isLiteralZero(node: ts.Expression): boolean {
  return stringOrNumberLiteral(node) === 0
}

function typeName(type: PreviewType): string {
  return typeof type === 'string' ? type : `list<${type.element}>`
}

function gameplayType(type: PreviewType): GameplayValueType {
  return type
}

function typeMatches(actual: PreviewType, expected: PreviewType): boolean {
  return canonicalJson(actual) === canonicalJson(expected)
}

function moduleDescriptor(
  value: Omit<GameplayModuleDescriptor, 'version' | 'allowedSurfaces'>,
): GameplayModuleDescriptor {
  return { version: SEMANTIC_PREVIEW_VERSION, allowedSurfaces: ['preview'], ...value }
}

const LOCAL_MATH_FALLBACKS: readonly GameplayModuleDescriptor[] = [
  moduleDescriptor({
    id: 'math.min', label: '取较小值',
    inputs: [port('left', 'number'), port('right', 'number')], outputs: [port('value', 'number')],
    effects: { pure: true, previewSafe: true },
    lower: context => `Math.min(${context.inputs.left}, ${context.inputs.right})`,
    ui: { category: 'math' },
  }),
  moduleDescriptor({
    id: 'math.max', label: '取较大值',
    inputs: [port('left', 'number'), port('right', 'number')], outputs: [port('value', 'number')],
    effects: { pure: true, previewSafe: true },
    lower: context => `Math.max(${context.inputs.left}, ${context.inputs.right})`,
    ui: { category: 'math' },
  }),
]

/** Registry used by this migration before the parent wires preview values into the shared catalogue. */
export const SEMANTIC_PREVIEW_GAMEPLAY_REGISTRY: GameplayModuleRegistry = (() => {
  const descriptors = [
    ...GAMEPLAY_MODULE_REGISTRY.descriptors,
    ...PREVIEW_VALUE_GAMEPLAY_MODULES,
  ]
  const byId = new Map<string, GameplayModuleDescriptor>()
  for (const descriptor of descriptors) byId.set(descriptor.id, descriptor)
  for (const descriptor of LOCAL_MATH_FALLBACKS) if (!byId.has(descriptor.id)) byId.set(descriptor.id, descriptor)
  return Object.freeze({
    descriptors: Object.freeze([...byId.values()]),
    get: (id: string, version?: string) => {
      const descriptor = byId.get(id)
      return descriptor && (version === undefined || descriptor.version === version) ? descriptor : undefined
    },
    resolve: (id: string, version?: string) => {
      const descriptor = byId.get(id)
      return descriptor && (version === undefined || descriptor.version === version) ? descriptor : undefined
    },
  })
})()

class PreviewGraphBuilder {
  readonly body: GameplayStatement[] = []
  readonly inputs = new Map<string, GameplayPort['type']>()
  readonly locals = new Map<string, PreviewExpression>()
  private sequence = 0

  nodeId(prefix: string): string {
    return `${prefix}-${this.sequence++}`
  }

  root(name: string, type: GameplayPort['type']): PreviewExpression {
    this.inputs.set(name, type)
    return { value: input(name), type: type as PreviewType }
  }

  addCall(
    prefix: string,
    module: string,
    inputs: Readonly<Record<string, GameplayValue>>,
    parameters: Readonly<Record<string, GameplayLiteral>>,
    type: PreviewType,
    portName = 'value',
  ): PreviewExpression {
    const id = this.nodeId(prefix)
    this.body.push(call(id, module, inputs, parameters))
    return { value: output(id, portName), type }
  }

  propertyRoot(node: ts.Expression): { readonly root: 'piece' | 'skillDef'; readonly property: string } | undefined {
    const value = unwrap(node)
    if (!ts.isPropertyAccessExpression(value) && !ts.isElementAccessExpression(value)) return undefined
    const property = ts.isPropertyAccessExpression(value)
      ? value.name.text
      : value.argumentExpression && stringOrNumberLiteral(value.argumentExpression)
    if (typeof property !== 'string') return undefined
    const receiver = ts.isPropertyAccessExpression(value) ? value.expression : value.expression
    if (!ts.isIdentifier(receiver) || (receiver.text !== 'piece' && receiver.text !== 'skillDef')) return undefined
    return { root: receiver.text, property }
  }

  isPieceProperty(node: ts.Expression, property?: string): boolean {
    const current = this.propertyRoot(node)
    return !!current && current.root === 'piece' && (property === undefined || current.property === property)
  }

  isSkillProperty(node: ts.Expression, property?: string): boolean {
    const current = this.propertyRoot(node)
    return !!current && current.root === 'skillDef' && (property === undefined || current.property === property)
  }

  compilePieceProperty(property: string): PreviewExpression {
    const allowed = ['attack', 'defense', 'moveRange', 'currentHp', 'maxHp'] as const
    if (!allowed.includes(property as (typeof allowed)[number])) throw new Error(`piece.${property} is not a registered preview attribute`)
    return this.addCall('piece-number', 'preview.piece-number', { piece: this.root('piece', 'piece').value }, { attribute: property }, 'number')
  }

  compileSkillProperty(property: string): PreviewExpression {
    if (property === 'description') {
      return this.addCall('skill-text', 'preview.skill-text', { skill: this.root('skillDef', 'content').value }, { attribute: property }, 'string')
    }
    const allowed = ['powerMultiplier', 'actionPointCost', 'chargeCost', 'cooldown'] as const
    if (!allowed.includes(property as (typeof allowed)[number])) throw new Error(`skillDef.${property} is not a registered preview attribute`)
    return this.addCall('skill-number', 'preview.skill-number', { skill: this.root('skillDef', 'content').value }, { attribute: property }, 'number')
  }

  /**
   * Legacy preview arithmetic deliberately propagates a missing numeric field
   * as NaN.  The ordinary value readers preserve an absent property as
   * undefined for direct result fields, but compiler input guards reject that
   * value when it is connected to arithmetic.  These closed-enum readers
   * perform the coercion at the edge of an arithmetic expression.
   */
  compileNumericOperand(node: ts.Expression): PreviewExpression {
    const property = this.propertyRoot(node)
    if (property?.root === 'piece') {
      const allowed = ['attack', 'defense', 'moveRange', 'currentHp', 'maxHp'] as const
      if (!allowed.includes(property.property as (typeof allowed)[number])) throw new Error(`piece.${property.property} is not a registered preview attribute`)
      return this.addCall('piece-number-nan', 'preview.piece-number-nan', { piece: this.root('piece', 'piece').value }, { attribute: property.property }, 'number')
    }
    if (property?.root === 'skillDef') {
      const allowed = ['powerMultiplier', 'actionPointCost', 'chargeCost', 'cooldown'] as const
      if (!allowed.includes(property.property as (typeof allowed)[number])) throw new Error(`skillDef.${property.property} is not a registered preview attribute`)
      return this.addCall('skill-number-nan', 'preview.skill-number-nan', { skill: this.root('skillDef', 'content').value }, { attribute: property.property }, 'number')
    }
    return this.compile(node)
  }

  compileStatusLookup(node: ts.Expression): PreviewExpression | undefined {
    const value = unwrap(node)
    if (!ts.isBinaryExpression(value) || value.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) return undefined
    if (!this.isPieceProperty(value.left, 'statusTags')) return undefined
    const find = unwrap(value.right)
    if (!ts.isCallExpression(find) || find.arguments.length !== 1 || !ts.isPropertyAccessExpression(find.expression) || find.expression.name.text !== 'find') return undefined
    if (!this.isPieceProperty(find.expression.expression, 'statusTags')) return undefined
    const callback = find.arguments[0]
    if (!ts.isFunctionExpression(callback) || callback.parameters.length !== 1 || !callback.body) return undefined
    const parameter = callback.parameters[0].name
    if (!ts.isIdentifier(parameter) || callback.body.statements.length !== 1 || !ts.isReturnStatement(callback.body.statements[0]) || !callback.body.statements[0].expression) return undefined
    const condition = unwrap(callback.body.statements[0].expression)
    if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return undefined
    if (!ts.isPropertyAccessExpression(condition.left) || !ts.isIdentifier(condition.left.expression) || condition.left.expression.text !== parameter.text || condition.left.name.text !== 'type') return undefined
    const statusType = stringOrNumberLiteral(condition.right)
    if (typeof statusType !== 'string') return undefined
    return this.addCall('status-number', 'preview.piece-status-number', { piece: this.root('piece', 'piece').value }, { statusType, attribute: 'intensity' }, 'number')
  }

  compile(node: ts.Expression): PreviewExpression {
    const value = unwrap(node)
    const status = this.compileStatusLookup(value)
    if (status) return { ...status, statusAlias: true }

    const literalValue = stringOrNumberLiteral(value)
    if (literalValue !== undefined) {
      if (literalValue === null) return { value: literal(null), type: 'boolean' }
      return { value: literal(literalValue), type: typeof literalValue as PrimitiveType }
    }
    if (ts.isIdentifier(value)) {
      const local = this.locals.get(value.text)
      if (local) return local
      if (value.text === 'piece') return this.root('piece', 'piece')
      if (value.text === 'skillDef') return this.root('skillDef', 'content')
      if (value.text === 'currentCooldown') return this.root('currentCooldown', 'number')
      throw new Error(`unknown identifier ${value.text}`)
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const rootProperty = this.propertyRoot(value)
      if (rootProperty) {
        if (rootProperty.root === 'piece') return this.compilePieceProperty(rootProperty.property)
        return this.compileSkillProperty(rootProperty.property)
      }
      if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression)) {
        const local = this.locals.get(value.expression.text)
        if (local?.statusAlias && value.name.text === 'intensity') return local
      }
      throw new Error('property access is not a registered preview value')
    }
    if (ts.isPrefixUnaryExpression(value)) {
      if (value.operator === ts.SyntaxKind.PlusToken) return this.compile(value.operand)
      if (value.operator === ts.SyntaxKind.MinusToken) {
        const operand = this.compileNumericOperand(value.operand)
        if (operand.type !== 'number') throw new Error(`unary minus expects number, got ${typeName(operand.type)}`)
        return this.addCall('negate', 'math.multiply', { left: operand.value, right: literal(-1) }, {}, 'number')
      }
      throw new Error(`unsupported unary operator ${ts.SyntaxKind[value.operator]}`)
    }
    if (ts.isBinaryExpression(value)) return this.compileBinary(value)
    if (ts.isConditionalExpression(value)) {
      if (ts.isIdentifier(unwrap(value.condition))) {
        const local = this.locals.get(unwrap(value.condition).getText())
        if (local?.statusAlias && isStatusIntensityDefault(value.whenTrue, value.whenFalse, unwrap(value.condition).getText(), this.locals)) return local
      }
      const condition = this.compile(value.condition)
      const whenTrue = this.compile(value.whenTrue)
      const whenFalse = this.compile(value.whenFalse)
      if (condition.type !== 'boolean' || whenTrue.type !== 'number' || whenFalse.type !== 'number') throw new Error('conditional preview expression must be boolean -> number')
      return this.addCall('select', 'logic.select-number', { condition: condition.value, whenTrue: whenTrue.value, whenFalse: whenFalse.value }, {}, 'number')
    }
    if (ts.isCallExpression(value)) return this.compileCall(value)
    if (ts.isArrayLiteralExpression(value)) return this.compileArray(value)
    throw new Error(`unsupported preview expression ${ts.SyntaxKind[value.kind] ?? value.kind}`)
  }

  compileBinary(node: ts.BinaryExpression): PreviewExpression {
    const operator = node.operatorToken.kind
    if (operator === ts.SyntaxKind.BarBarToken && this.isPieceProperty(node.left) && isLiteralZero(node.right)) {
      const property = this.propertyRoot(node.left)?.property
      if (!property) throw new Error('missing piece attribute')
      const allowed = ['attack', 'defense', 'moveRange', 'currentHp', 'maxHp'] as const
      if (!allowed.includes(property as (typeof allowed)[number])) throw new Error(`piece.${property} is not a registered preview attribute`)
      return this.addCall('piece-number-zero', 'preview.piece-number-or-zero', { piece: this.root('piece', 'piece').value }, { attribute: property }, 'number')
    }
    if (operator === ts.SyntaxKind.BarBarToken) {
      if (ts.isIdentifier(unwrap(node.left))) {
        const local = this.locals.get(unwrap(node.left).getText())
        if (local?.statusAlias && isLiteralZero(node.right)) return local
      }
      throw new Error('only a registered numeric default is allowed for ||')
    }
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) throw new Error('only the registered status lookup may use &&')

    const left = this.compileNumericOperand(node.left)
    const right = this.compileNumericOperand(node.right)
    const tokenMap: Readonly<Record<number, { readonly module: string; readonly output: PreviewType }>> = {
      [ts.SyntaxKind.PlusToken]: { module: 'math.add', output: 'number' },
      [ts.SyntaxKind.MinusToken]: { module: 'math.subtract', output: 'number' },
      [ts.SyntaxKind.AsteriskToken]: { module: 'math.multiply', output: 'number' },
      [ts.SyntaxKind.SlashToken]: { module: 'math.divide', output: 'number' },
      [ts.SyntaxKind.PercentToken]: { module: 'math.modulo', output: 'number' },
      [ts.SyntaxKind.AsteriskAsteriskToken]: { module: 'math.power', output: 'number' },
      [ts.SyntaxKind.EqualsEqualsEqualsToken]: { module: 'compare.equal', output: 'boolean' },
      [ts.SyntaxKind.ExclamationEqualsEqualsToken]: { module: 'compare.not-equal', output: 'boolean' },
      [ts.SyntaxKind.LessThanToken]: { module: 'compare.less-than', output: 'boolean' },
      [ts.SyntaxKind.LessThanEqualsToken]: { module: 'compare.less-or-equal', output: 'boolean' },
      [ts.SyntaxKind.GreaterThanToken]: { module: 'compare.greater-than', output: 'boolean' },
      [ts.SyntaxKind.GreaterThanEqualsToken]: { module: 'compare.greater-or-equal', output: 'boolean' },
    }
    const selected = tokenMap[operator]
    if (!selected) throw new Error(`unsupported binary operator ${ts.SyntaxKind[operator] ?? operator}`)
    if (selected.output === 'number' && (left.type !== 'number' || right.type !== 'number')) throw new Error(`${selected.module} expects numbers`)
    if (selected.output === 'boolean' && (left.type !== 'number' || right.type !== 'number')) throw new Error(`${selected.module} expects numeric comparisons`)
    return this.addCall('binary', selected.module, { left: left.value, right: right.value }, {}, selected.output)
  }

  compileCall(node: ts.CallExpression): PreviewExpression {
    if (!ts.isPropertyAccessExpression(node.expression) || !ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== 'Math') throw new Error('only Math.floor, Math.max, and Math.min are allowed in preview expressions')
    const method = node.expression.name.text
    if (!['floor', 'max', 'min'].includes(method)) throw new Error(`Math.${method} is not a registered preview operation`)
    const values = node.arguments.map(argument => this.compileNumericOperand(argument))
    if (method === 'floor') {
      if (values.length !== 1 || values[0].type !== 'number') throw new Error('Math.floor expects one number')
      return this.addCall('floor', 'math.floor', { value: values[0].value }, {}, 'number')
    }
    if (values.length !== 2 || values.some(value => value.type !== 'number')) throw new Error(`Math.${method} expects two numbers`)
    return this.addCall(method, `math.${method}`, { left: values[0].value, right: values[1].value }, {}, 'number')
  }

  compileArray(node: ts.ArrayLiteralExpression): PreviewExpression {
    const values = node.elements.map(element => {
      if (ts.isSpreadElement(element)) throw new Error('array spread is not allowed in preview expressions')
      return this.compile(element)
    })
    if (!values.length) return { value: literal([]), type: { kind: 'list', element: 'number' } }
    const elementType = values[0].type
    if (typeof elementType !== 'string' || values.some(value => !typeMatches(value.type, elementType))) throw new Error('preview arrays must contain one primitive type')
    if (values.every(value => value.value.kind === 'literal')) {
      return { value: literal(values.map(value => (value.value as { kind: 'literal'; value: GameplayLiteral }).value) as GameplayLiteral[]), type: { kind: 'list', element: elementType } }
    }
    if (elementType !== 'number') throw new Error('dynamic preview arrays must contain numbers')
    const names = values.map((_, index) => `value${index}`)
    const body: GameplayStatement[] = []
    let selected: GameplayValue = input(names[values.length - 1])
    for (let index = values.length - 2; index >= 0; index -= 1) {
      const equalId = `array-index-${index}`
      body.push(call(equalId, 'compare.equal', { left: input('index'), right: literal(index) }))
      const selectId = `array-select-${index}`
      body.push(call(selectId, 'logic.select-number', {
        condition: output(equalId, 'value'),
        whenTrue: input(names[index]),
        whenFalse: selected,
      }))
      selected = output(selectId, 'value')
    }
    if (values.length === 1) selected = input(names[0])
    const id = this.nodeId('array')
    this.body.push({
      kind: 'collection', id, method: 'map', items: literal(values.map((_, index) => index)), inputs: Object.fromEntries(values.map((value, index) => [names[index], value.value])), body: [
        ...body,
        { kind: 'return', id: 'array-return', value: selected },
      ],
    })
    return { value: output(id, 'value'), type: { kind: 'list', element: 'number' } }
  }
}

function maxHpFallback(node: ts.Expression): number | undefined {
  const value = unwrap(node)
  if (!ts.isBinaryExpression(value) || value.operatorToken.kind !== ts.SyntaxKind.BarBarToken) return undefined
  const fallback = stringOrNumberLiteral(value.right)
  if (typeof fallback !== 'number' || !Number.isFinite(fallback)) return undefined
  const right = unwrap(value.left)
  if (!ts.isBinaryExpression(right) || right.operatorToken.kind !== ts.SyntaxKind.BarBarToken) return undefined
  const left = unwrap(right.left)
  if (!ts.isPropertyAccessExpression(left) || !ts.isIdentifier(left.expression) || left.expression.text !== 'piece' || left.name.text !== 'maxHp') return undefined
  const nested = unwrap(right.right)
  if (!(ts.isBinaryExpression(nested) && nested.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    && ts.isPropertyAccessExpression(nested.left)
    && ts.isIdentifier(nested.left.expression) && nested.left.expression.text === 'piece' && nested.left.name.text === 'stats'
    && ts.isPropertyAccessExpression(nested.right)
    && ts.isPropertyAccessExpression(nested.right.expression)
    && ts.isIdentifier(nested.right.expression.expression) && nested.right.expression.expression.text === 'piece'
    && nested.right.expression.name.text === 'stats' && nested.right.name.text === 'maxHp')) return undefined
  return fallback
}

function isStatusIntensityDefault(
  whenTrue: ts.Expression,
  whenFalse: ts.Expression,
  alias: string,
  locals: ReadonlyMap<string, PreviewExpression>,
): boolean {
  if (!isLiteralZero(whenFalse)) return false
  const value = unwrap(whenTrue)
  if (!ts.isBinaryExpression(value) || value.operatorToken.kind !== ts.SyntaxKind.BarBarToken || !isLiteralZero(value.right)) return false
  const left = unwrap(value.left)
  if (!ts.isPropertyAccessExpression(left) || !ts.isIdentifier(left.expression) || left.expression.text !== alias || left.name.text !== 'intensity') return false
  return locals.get(alias)?.statusAlias === true
}

function parseFunction(source: string): { readonly file: ts.SourceFile; readonly declaration: ts.FunctionDeclaration } | { readonly reason: string } {
  const file = ts.createSourceFile('red-252-semantic-preview.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const parseDiagnostics = (file as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []
  if (parseDiagnostics.length) return { reason: `source parse failed: ${parseDiagnostics.map(diagnosticText).join('; ')}` }
  if (file.statements.length !== 1 || !ts.isFunctionDeclaration(file.statements[0]) || !file.statements[0].body) return { reason: 'source is not one function declaration' }
  const declaration = file.statements[0]
  if (!declaration.name || declaration.name.text !== 'calculatePreview') return { reason: 'function must be named calculatePreview' }
  return { file, declaration }
}

function buildGraph(source: string): { readonly functionName: string; readonly graph: GameplayModuleGraph } {
  const parsed = parseFunction(source)
  if ('reason' in parsed) throw new Error(parsed.reason)
  const builder = new PreviewGraphBuilder()
  const statements = parsed.declaration.body!.statements
  const returnStatements = statements.filter(statement => ts.isReturnStatement(statement))
  if (returnStatements.length !== 1 || !ts.isReturnStatement(statements[statements.length - 1]) || !returnStatements[0].expression) throw new Error('preview function must contain declarations followed by one return')
  for (const statement of statements.slice(0, -1)) {
    if (!ts.isVariableStatement(statement)) throw new Error(`unsupported preview statement ${ts.SyntaxKind[statement.kind] ?? statement.kind}`)
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) throw new Error('preview declarations must assign named values')
      if (builder.locals.has(declaration.name.text)) throw new Error(`duplicate preview declaration ${declaration.name.text}`)
      const fallback = maxHpFallback(declaration.initializer)
      if (fallback !== undefined) {
        builder.locals.set(declaration.name.text, builder.addCall('max-hp', 'preview.piece-max-hp', { piece: builder.root('piece', 'piece').value }, { fallback }, 'number'))
      } else {
        builder.locals.set(declaration.name.text, builder.compile(declaration.initializer))
      }
    }
  }

  const returned = unwrap(returnStatements[0].expression)
  if (!ts.isObjectLiteralExpression(returned)) throw new Error('preview return must be an object literal')
  const resultProperties = new Map<string, ts.Expression>()
  for (const property of returned.properties) {
    if (!ts.isPropertyAssignment(property)) throw new Error('preview result cannot contain shorthand or spread properties')
    const name = propertyName(property.name)
    if (!name) throw new Error('preview result property names must be static')
    resultProperties.set(name, property.initializer)
  }
  if (!resultProperties.has('description') || !resultProperties.has('expectedValues') || resultProperties.size !== 2) throw new Error('preview result must contain description and expectedValues only')
  const description = builder.compile(resultProperties.get('description')!)
  if (description.type !== 'string') throw new Error('preview description must be text')
  const expectedObject = unwrap(resultProperties.get('expectedValues')!)
  if (!ts.isObjectLiteralExpression(expectedObject)) throw new Error('preview expectedValues must be an object literal')
  const expectedValues: Record<string, PreviewExpression> = {}
  for (const property of expectedObject.properties) {
    if (!ts.isPropertyAssignment(property)) throw new Error('preview expectedValues cannot contain shorthand or spread properties')
    const name = propertyName(property.name)
    if (!name || expectedValues[name]) throw new Error('preview expectedValues property names must be unique static names')
    expectedValues[name] = builder.compile(property.initializer)
  }

  const expectedSchemaId = 'preview-expected-values'
  const resultSchemaId = 'preview-result'
  const expectedFields: GameplayPort[] = Object.entries(expectedValues).map(([name, value]) => port(name, gameplayType(value.type)))
  const resultFields: GameplayPort[] = [
    port('description', 'string'),
    port('expectedValues', { kind: 'record', schema: `${expectedSchemaId}@${SEMANTIC_PREVIEW_VERSION}` }),
  ]
  const expectedNode = builder.nodeId('expected-values')
  builder.body.push({
    kind: 'record.create', id: expectedNode, schema: `${expectedSchemaId}@${SEMANTIC_PREVIEW_VERSION}`,
    fields: Object.fromEntries(Object.entries(expectedValues).map(([name, value]) => [name, value.value])),
  })
  const resultNode = builder.nodeId('preview-result')
  builder.body.push({
    kind: 'record.create', id: resultNode, schema: `${resultSchemaId}@${SEMANTIC_PREVIEW_VERSION}`,
    fields: { description: description.value, expectedValues: output(expectedNode, 'value') },
  })
  const inputs = [...builder.inputs.entries()].map(([name, type]) => port(name, type))
  const schemas: readonly GameplayRecordSchema[] = [
    { id: expectedSchemaId, version: SEMANTIC_PREVIEW_VERSION, fields: expectedFields },
    { id: resultSchemaId, version: SEMANTIC_PREVIEW_VERSION, fields: resultFields },
  ]
  return {
    functionName: parsed.declaration.name!.text,
    graph: {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'preview',
      ...(inputs.length ? { inputs } : {}),
      outputs: [port('result', { kind: 'record', schema: `${resultSchemaId}@${SEMANTIC_PREVIEW_VERSION}` })],
      schemas,
      body: [...builder.body, { kind: 'return', id: 'return', value: output(resultNode, 'value') }],
    },
  }
}

/** Parse a constrained legacy preview without executing its source. */
export function parseSemanticPreview(source: string): SemanticPreviewParseResult {
  try {
    const result = buildGraph(source)
    return { kind: 'preview', functionName: result.functionName, graph: result.graph }
  } catch (error) {
    return { kind: 'skip', reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Build a preview graph, throwing for a source outside the strict whitelist. */
export function buildSemanticPreviewGraph(source: string): GameplayModuleGraph {
  const parsed = parseSemanticPreview(source)
  if (parsed.kind === 'skip') throw new Error(parsed.reason)
  return parsed.graph
}

function hasPreviewGraph(document: JsonRecord): boolean {
  return record(document.gameplayModules)
    && record(document.gameplayModules.entries)
    && record(document.gameplayModules.entries.previewCode)
    && record(document.gameplayModules.entries.previewCode.graph)
}

function protectedId(id: string): boolean {
  const name = id.startsWith('skills/') ? id.slice('skills/'.length) : id
  return PROTECTED_IDS.has(id) || PROTECTED_PREFIXES.some(prefix => name.startsWith(prefix))
}

function assertCompatibilityFields(current: JsonRecord, baseline: JsonRecord, id: string): void {
  for (const key of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
    if (GENERATED_FIELDS.has(key) || key === 'cluster') continue
    if (canonicalJson(current[key]) !== canonicalJson(baseline[key])) throw new Error(`${id}: compatibility field changed before preview migration: ${key}`)
  }
}

function assertPreservedFields(current: JsonRecord, next: JsonRecord, id: string): void {
  for (const key of new Set([...Object.keys(current), ...Object.keys(next)])) {
    if (key === 'previewCode' || key === 'gameplayModules') continue
    if (canonicalJson(current[key]) !== canonicalJson(next[key])) throw new Error(`${id}: preview migration changed compatibility field: ${key}`)
  }
  const currentModules = record(current.gameplayModules) ? current.gameplayModules : undefined
  const nextModules = record(next.gameplayModules) ? next.gameplayModules : undefined
  for (const key of new Set([
    ...Object.keys(currentModules ?? {}),
    ...Object.keys(nextModules ?? {}),
  ])) {
    if (key === 'version' || key === 'entries') continue
    if (canonicalJson(currentModules?.[key]) !== canonicalJson(nextModules?.[key])) throw new Error(`${id}: preview migration changed gameplayModules.${key}`)
  }
  const currentEntries = currentModules && record(currentModules.entries) ? currentModules.entries : undefined
  const nextEntries = nextModules && record(nextModules.entries) ? nextModules.entries : undefined
  for (const key of new Set([
    ...Object.keys(currentEntries ?? {}),
    ...Object.keys(nextEntries ?? {}),
  ])) {
    if (key === 'previewCode') continue
    if (canonicalJson(currentEntries?.[key]) !== canonicalJson(nextEntries?.[key])) throw new Error(`${id}: preview migration changed gameplayModules.entries.${key}`)
  }
}

function applyPreviewGraph(current: JsonRecord, graph: GameplayModuleGraph, compiledCode: string): JsonRecord {
  const next = { ...current }
  const previousModules = record(next.gameplayModules) ? next.gameplayModules : {}
  const previousEntries = record(previousModules.entries) ? previousModules.entries : {}
  next.previewCode = compiledCode
  next.gameplayModules = {
    ...(previousModules.textBindings === undefined ? {} : { textBindings: previousModules.textBindings }),
    version: GAMEPLAY_MODULE_DOCUMENT_VERSION,
    entries: {
      ...previousEntries,
      previewCode: { graph: JSON.parse(JSON.stringify(graph)), compilerVersion: GAMEPLAY_MODULE_COMPILER_VERSION },
    },
  }
  return next
}

function buildMigration(id: string, source: string): SemanticPreviewMigration {
  return { id, field: SEMANTIC_PREVIEW_FIELD, surface: 'preview', source, build: () => buildSemanticPreviewGraph(source) }
}

export type SemanticPreviewDiscovery = {
  readonly migrations: readonly SemanticPreviewMigration[]
  readonly reports: readonly SemanticPreviewReport[]
}

/** Discover ordinary preview sources and report protected/unsupported entries explicitly. */
export function discoverSemanticPreviewMigrations(root: string, baseline: JsonRecord): SemanticPreviewDiscovery {
  if (!record(baseline.entries)) throw new Error('RED-252 baseline has no entries object')
  const migrations: SemanticPreviewMigration[] = []
  const reports: SemanticPreviewReport[] = []
  for (const [id, entryValue] of Object.entries(baseline.entries)) {
    if (!id.startsWith('skills/') || !record(entryValue) || typeof entryValue.previewCode !== 'string') continue
    const file = path.join(root, 'data', `${id}.json`)
    if (protectedId(id)) {
      reports.push({ id, field: SEMANTIC_PREVIEW_FIELD, surface: 'preview', status: 'skipped', reason: 'reserved for the protected Minato/Turalyon/Tails/Rafaam migration batch', file })
      continue
    }
    if (!fs.existsSync(file)) {
      reports.push({ id, field: SEMANTIC_PREVIEW_FIELD, status: 'blocked', reason: 'production file does not exist', file })
      continue
    }
    const current = readJson(file)
    // Existing authored graphs are authoritative on rerun, even when the
    // frozen legacy source predates a different migration batch.
    if (hasPreviewGraph(current)) {
      reports.push({ id, field: SEMANTIC_PREVIEW_FIELD, surface: 'preview', status: 'already-migrated', file })
      continue
    }
    const parsed = parseSemanticPreview(entryValue.previewCode)
    if (parsed.kind === 'skip') {
      reports.push({ id, field: SEMANTIC_PREVIEW_FIELD, surface: 'preview', status: 'skipped', reason: parsed.reason, file })
      continue
    }
    const migration = buildMigration(id, entryValue.previewCode)
    migrations.push(migration)
    reports.push({ id, field: SEMANTIC_PREVIEW_FIELD, surface: 'preview', status: hasPreviewGraph(current) ? 'already-migrated' : 'ready', file })
  }
  return { migrations, reports }
}

function updateReport(reports: SemanticPreviewReport[], id: string, next: Partial<SemanticPreviewReport>): void {
  const index = reports.findIndex(report => report.id === id && report.field === SEMANTIC_PREVIEW_FIELD)
  if (index >= 0) reports[index] = { ...reports[index], ...next }
  else reports.push({ id, field: SEMANTIC_PREVIEW_FIELD, ...next } as SemanticPreviewReport)
}

/** Preflight every selected write; no production file is written if one candidate blocks. */
export function runSemanticPreviewMigrations(
  root: string,
  baseline: JsonRecord,
  selectedIds?: readonly string[],
): SemanticPreviewRun {
  const discovery = discoverSemanticPreviewMigrations(root, baseline)
  const selected = selectedIds?.length
    ? discovery.migrations.filter(entry => selectedIds.includes(entry.id) || selectedIds.includes(`${entry.id}.${entry.field}`))
    : discovery.migrations
  if (selectedIds?.length) {
    const known = new Set(discovery.migrations.flatMap(entry => [entry.id, `${entry.id}.${entry.field}`]))
    const requestedProtected = selectedIds.filter(id => PROTECTED_IDS.has(id) || id.startsWith('skills/minato-') || id.startsWith('skills/turalyon-') || id.startsWith('skills/tails-'))
    const unknown = selectedIds.filter(id => !known.has(id) && !requestedProtected.includes(id))
    if (unknown.length) throw new Error(`Unknown semantic preview migration: ${unknown.join(', ')}`)
  }
  const reports = discovery.reports.filter(report => {
    if (!selectedIds?.length) return true
    return selectedIds.includes(report.id) || selectedIds.includes(`${report.id}.${report.field}`)
  }).map(report => ({ ...report }))
  const documents = new Map<string, JsonRecord>()
  for (const migration of selected) {
    const file = path.join(root, 'data', `${migration.id}.json`)
    const baselineEntry = (baseline.entries as JsonRecord)[migration.id]
    const current = documents.get(file) ?? readJson(file)
    if (hasPreviewGraph(current)) continue
    try {
      if (!record(baselineEntry)) throw new Error(`${migration.id}: not in frozen ordinary-match baseline`)
      assertFrozenExecutable(current, baselineEntry, SEMANTIC_PREVIEW_FIELD, 'preview', migration.id)
      assertCompatibilityFields(current, baselineEntry, migration.id)
      const graph = migration.build()
      const compiled = compileGameplayModuleGraph(graph, SEMANTIC_PREVIEW_GAMEPLAY_REGISTRY)
      const document = applyPreviewGraph(current, graph, compiled.code)
      assertPreservedFields(current, document, migration.id)
      documents.set(file, document)
      updateReport(reports, migration.id, { status: 'ready', document })
    } catch (error) {
      updateReport(reports, migration.id, { status: 'blocked', reason: error instanceof Error ? error.message : String(error), file })
    }
  }
  const counts = {
    ordinaryCandidates: selected.length,
    ready: reports.filter(report => report.status === 'ready').length,
    alreadyMigrated: reports.filter(report => report.status === 'already-migrated').length,
    skipped: reports.filter(report => report.status === 'skipped').length,
    blocked: reports.filter(report => report.status === 'blocked').length,
  }
  return { migrations: selected, reports, documents, coverage: counts }
}

function cli(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const selected = args.filter(argument => argument !== '--write')
  const baseline = readJson(path.join(root, 'tests', 'game', 'fixtures', 'RED-252-legacy-content.json'))
  const run = runSemanticPreviewMigrations(root, baseline, selected)
  const blocked = run.reports.filter(report => report.status === 'blocked')
  if (write && blocked.length) throw new Error(JSON.stringify({ message: 'Semantic preview migration is blocked; no production files were written.', blocked }, null, 2))
  if (write) {
    for (const [file, document] of run.documents) fs.writeFileSync(file, JSON.stringify(document, null, 2) + '\n', 'utf8')
  }
  console.log(JSON.stringify({
    mode: write ? 'written' : 'dry-run',
    migrationVersion: SEMANTIC_PREVIEW_VERSION,
    compilerVersion: GAMEPLAY_MODULE_COMPILER_VERSION,
    baseSha: baseline.baseSha,
    counts: { ...run.coverage, written: write ? run.documents.size : 0 },
    migrations: run.reports.map(({ id, field, surface, status, reason, file }) => ({ id, field, surface, status, reason, file })),
  }, null, 2))
  if (blocked.length) process.exitCode = 1
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invoked && path.resolve(fileURLToPath(import.meta.url)) === invoked) cli()

