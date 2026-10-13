import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import {
  applyGameplayModuleGraph,
  assertGameplayModuleDocument,
  GAMEPLAY_MODULE_COMPILER_VERSION,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  GAMEPLAY_MODULE_REGISTRY,
  type GameplayJsonValue,
  type GameplayLiteral,
  type GameplayModuleGraph,
  type GameplayModuleSurface,
  type GameplayPort,
  type GameplayRecordSchema,
  type GameplayStatement,
  type GameplayValue,
  type GameplayValueType,
} from '../lib/skill-graph/module-document'
import { SEMANTIC_MODULE_VERSION } from './migrate-semantic-modules'

/**
 * RED-252's constant batch only accepts source whose AST is a single return of
 * JSON literals.  It deliberately does not import or execute the old source.
 */
export const SEMANTIC_CONSTANT_VERSION = '1' as const

type JsonRecord = Record<string, unknown>
export type SemanticConstantField = 'code' | 'skillCode' | 'previewCode'
export type SemanticConstantSurface = Exclude<GameplayModuleSurface, 'preview'> | 'preview'

export type ConstantParseResult =
  | { readonly kind: 'constant'; readonly value: JsonRecord; readonly functionName: string }
  | { readonly kind: 'skip'; readonly reason: string }

export type SemanticConstantMigration = {
  readonly id: string
  readonly field: SemanticConstantField
  readonly surface: SemanticConstantSurface
  readonly value: JsonRecord
  readonly build: () => GameplayModuleGraph
}

export type SemanticConstantReport = {
  readonly id: string
  readonly field: SemanticConstantField
  readonly status: 'ready' | 'already-migrated' | 'skipped' | 'blocked'
  readonly surface?: SemanticConstantSurface
  readonly reason?: string
  readonly file?: string
  readonly document?: JsonRecord
}

export type SemanticConstantRun = {
  readonly migrations: readonly SemanticConstantMigration[]
  readonly reports: readonly SemanticConstantReport[]
  readonly documents: ReadonlyMap<string, JsonRecord>
}

const ACTIVE_SURFACES: readonly Exclude<GameplayModuleSurface, 'preview'>[] = [
  'skill',
  'card',
  'rule',
  'triggerSkill',
  'pending',
]

const GENERATED_LEGACY_FIELDS = new Set([
  'contentGraph',
  'contentGraphField',
  'contentGraphCompilerVersion',
  'contentGraphEntries',
])

const SOURCE_FIELDS: readonly SemanticConstantField[] = ['code', 'skillCode', 'previewCode']

/** These prefixes are reserved for the complex migration batches. */
const COMPLEX_PREFIXES = ['tails-', 'minato-', 'turalyon-', 'rafaam-'] as const

function literal(value: GameplayLiteral): GameplayValue {
  return { kind: 'literal', value }
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
  return { kind: 'call', id, module, version: SEMANTIC_MODULE_VERSION, inputs, parameters }
}

function returnValues(id: string, values: Readonly<Record<string, GameplayValue>>): GameplayStatement {
  return { kind: 'return', id, values }
}

function record(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
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

function diagnosticText(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
}

function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text
  return undefined
}

function readLiteral(node: ts.Expression): { readonly ok: true; readonly value: GameplayLiteral } | { readonly ok: false; readonly reason: string } {
  if (ts.isParenthesizedExpression(node)) return readLiteral(node.expression)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { ok: true, value: node.text }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true }
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false }
  if (node.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null }
  if (ts.isNumericLiteral(node)) {
    const value = Number(node.text)
    return Number.isFinite(value) ? { ok: true, value } : { ok: false, reason: 'numeric literal is not finite' }
  }
  if (ts.isPrefixUnaryExpression(node)
    && (node.operator === ts.SyntaxKind.PlusToken || node.operator === ts.SyntaxKind.MinusToken)
    && ts.isNumericLiteral(node.operand)) {
    const number = Number(node.operand.text)
    const value = node.operator === ts.SyntaxKind.MinusToken ? -number : number
    return Number.isFinite(value) ? { ok: true, value } : { ok: false, reason: 'numeric literal is not finite' }
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values: GameplayLiteral[] = []
    for (const [index, element] of node.elements.entries()) {
      if (ts.isSpreadElement(element)) return { ok: false, reason: `array spread at index ${index}` }
      const parsed = readLiteral(element)
      if (!parsed.ok) return { ok: false, reason: `array[${index}]: ${parsed.reason}` }
      values.push(parsed.value)
    }
    return { ok: true, value: values }
  }
  if (ts.isObjectLiteralExpression(node)) {
    const value: Record<string, GameplayJsonValue> = {}
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return { ok: false, reason: 'object contains a non-assignment property' }
      const key = propertyName(property.name)
      if (!key) return { ok: false, reason: 'object property name is not a literal name' }
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        return { ok: false, reason: `unsafe object property ${key}` }
      }
      const parsed = readLiteral(property.initializer)
      if (!parsed.ok) return { ok: false, reason: `${key}: ${parsed.reason}` }
      value[key] = parsed.value
    }
    return { ok: true, value }
  }
  return { ok: false, reason: `non-literal expression ${ts.SyntaxKind[node.kind] ?? node.kind}` }
}

function functionBody(source: string): { readonly name: string; readonly body: { readonly statements: readonly ts.Statement[] } } | { readonly reason: string } {
  const file = ts.createSourceFile('red-252-semantic-constant.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const parseDiagnostics = (file as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []
  if (parseDiagnostics.length) return { reason: `source parse failed: ${parseDiagnostics.map(diagnosticText).join('; ')}` }
  if (file.statements.length !== 1) return { reason: 'source is not a single function declaration' }
  const statement = file.statements[0]
  if (ts.isReturnStatement(statement)) return { name: '<rule-body>', body: { statements: [statement] } }
  if (!ts.isFunctionDeclaration(statement) || !statement.body) return { reason: 'source is not a function declaration with a block body' }
  return { name: statement.name?.text ?? '<anonymous>', body: statement.body }
}

/** Parse one legacy source field without evaluating it. */
export function parseConstantReturn(source: string): ConstantParseResult {
  const parsedFunction = functionBody(source)
  if ('reason' in parsedFunction) return { kind: 'skip', reason: parsedFunction.reason }
  if (parsedFunction.body.statements.length !== 1) return { kind: 'skip', reason: 'function body has more than one statement' }
  const statement = parsedFunction.body.statements[0]
  if (!ts.isReturnStatement(statement) || !statement.expression) return { kind: 'skip', reason: 'function body is not one explicit return' }
  const parsed = readLiteral(statement.expression)
  if (!parsed.ok) return { kind: 'skip', reason: `return value is not constant: ${parsed.reason}` }
  if (!record(parsed.value)) return { kind: 'skip', reason: 'return value is not an object' }
  return { kind: 'constant', value: parsed.value, functionName: parsedFunction.name }
}

function resultValue(value: JsonRecord): { readonly ok: true; readonly value: JsonRecord } | { readonly ok: false; readonly reason: string } {
  const keys = Object.keys(value)
  if (!Object.prototype.hasOwnProperty.call(value, 'success') || typeof value.success !== 'boolean') {
    return { ok: false, reason: 'constant result must contain a boolean success field' }
  }
  if (keys.some(key => !['success', 'message', 'blocked'].includes(key)) || (value.message !== undefined && typeof value.message !== 'string') || (value.blocked !== undefined && typeof value.blocked !== 'boolean')) {
    return { ok: false, reason: 'constant result accepts success, string message and boolean blocked only' }
  }
  return { ok: true, value }
}

function previewValue(value: JsonRecord): { readonly ok: true; readonly value: JsonRecord } | { readonly ok: false; readonly reason: string } {
  if (typeof value.description !== 'string') return { ok: false, reason: 'constant preview needs a string description' }
  if (!Object.prototype.hasOwnProperty.call(value, 'expectedValues')) return { ok: false, reason: 'constant preview needs expectedValues' }
  if (!record(value.expectedValues)) return { ok: false, reason: 'constant preview expectedValues must be an object' }
  return { ok: true, value }
}

function valueType(value: GameplayLiteral): { readonly type: GameplayValueType; readonly nullable?: boolean } {
  if (value === null) return { type: 'record', nullable: true }
  if (typeof value === 'string') return { type: 'string' }
  if (typeof value === 'boolean') return { type: 'boolean' }
  if (typeof value === 'number') return { type: 'number' }
  if (Array.isArray(value)) {
    if (!value.length) return { type: { kind: 'list', element: 'record' } }
    const first = valueType(value[0]).type
    const compatible = value.every(item => canonicalJson(valueType(item).type) === canonicalJson(first))
    return { type: { kind: 'list', element: compatible ? first : 'record' } }
  }
  return { type: 'record' }
}

type TypedRecordBuild = {
  readonly schemas: GameplayRecordSchema[]
  readonly statements: GameplayStatement[]
  nextRecordId: number
  nextSchemaId: number
}

type TypedRecordValue = {
  readonly value: GameplayValue
  readonly type: GameplayValueType
  readonly nullable?: boolean
}

function typedRecordSchemaId(state: TypedRecordBuild, hint: string): string {
  const suffix = state.nextSchemaId++
  return suffix === 0 ? hint : `${hint}-${suffix}`
}

function typedRecordNodeId(state: TypedRecordBuild): string {
  return `record-${state.nextRecordId++}`
}

/**
 * Convert a JSON object into graph-local records.  Literal object values are
 * intentionally never emitted: the compiler rejects opaque object literals,
 * while a record.create output carries the schema needed by record fields.
 */
function buildTypedRecord(
  value: JsonRecord,
  state: TypedRecordBuild,
  schemaId: string,
  path: string,
): GameplayValue {
  const fields: GameplayPort[] = []
  const fieldValues: Record<string, GameplayValue> = {}
  for (const [name, item] of Object.entries(value)) {
    const built = buildTypedRecordValue(item as GameplayLiteral, state, `${path}.${name}`)
    fields.push(port(name, built.type, built.nullable ? { nullable: true } : {}))
    fieldValues[name] = built.value
  }

  state.schemas.push({ id: schemaId, version: SEMANTIC_CONSTANT_VERSION, fields })
  const nodeId = typedRecordNodeId(state)
  state.statements.push({ kind: 'record.create', id: nodeId, schema: `${schemaId}@${SEMANTIC_CONSTANT_VERSION}`, fields: fieldValues })
  return output(nodeId, 'value')
}

function buildTypedRecordValue(value: GameplayLiteral, state: TypedRecordBuild, path: string): TypedRecordValue {
  if (record(value)) {
    const schemaId = typedRecordSchemaId(state, 'constant-record')
    return {
      value: buildTypedRecord(value, state, schemaId, path),
      type: { kind: 'record', schema: `${schemaId}@${SEMANTIC_CONSTANT_VERSION}` },
    }
  }
  if (Array.isArray(value) && value.some(item => record(item))) {
    throw new Error(`${path}: arrays of object literals need a collection-specific schema`)
  }
  const inferred = valueType(value)
  return {
    value: literal(value),
    type: inferred.type,
    nullable: inferred.nullable,
  }
}

function buildTypedPreviewRecordGraph(value: JsonRecord): GameplayModuleGraph {
  const state: TypedRecordBuild = { schemas: [], statements: [], nextRecordId: 0, nextSchemaId: 0 }
  const resultSchema = typedRecordSchemaId(state, 'constant-preview-result')
  const result = buildTypedRecord(value, state, resultSchema, 'preview')
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'preview',
    outputs: [port('result', { kind: 'record', schema: `${resultSchema}@${SEMANTIC_CONSTANT_VERSION}` })],
    schemas: state.schemas,
    body: [...state.statements, { kind: 'return', id: 'return', value: result }],
  }
}

/**
 * Shared result lowering for every fixed success/message source.  A result
 * without a message still goes through the public result module internally,
 * then returns only success so the legacy omitted field remains omitted.
 */
export function buildConstantResultGraph(
  value: JsonRecord,
  surface: Exclude<GameplayModuleSurface, 'preview'>,
): GameplayModuleGraph {
  const checked = resultValue(value)
  if (!checked.ok) throw new Error(checked.reason)
  const hasMessage = Object.prototype.hasOwnProperty.call(value, 'message')
  const message = hasMessage ? value.message as string : ''
  const resultCall = call('result', 'result.message', { message: literal(message) }, { success: value.success as boolean })
  const result: Record<string, GameplayValue> = { success: output('result', 'success') }
  if (hasMessage) result.message = output('result', 'message')
  if (typeof value.blocked === 'boolean') result.blocked = literal(value.blocked)
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface,
    outputs: [port('success', 'boolean'), ...(hasMessage ? [port('message', 'string')] : []), ...(typeof value.blocked === 'boolean' ? [port('blocked', 'boolean')] : [])],
    body: [resultCall, returnValues('return', result)],
  }
}

/** Build a preview graph with a shared result module or closed record schemas. */
export function buildConstantPreviewGraph(value: JsonRecord): GameplayModuleGraph {
  const checked = previewValue(value)
  if (!checked.ok) throw new Error(checked.reason)
  const previewResult = GAMEPLAY_MODULE_REGISTRY.get('preview.result', SEMANTIC_MODULE_VERSION)
  const expectedValues = value.expectedValues as JsonRecord
  const supportedInputs = previewResult?.inputs.filter(input => input.name !== 'description') ?? []
  const supportedNames = new Set(supportedInputs.map(input => input.name))
  const canUseSharedPreviewResult = Object.keys(value).every(key => key === 'description' || key === 'expectedValues')
    && Object.keys(expectedValues).every(key => supportedNames.has(key))
  const acceptsTypedExpectedValues = previewResult?.inputs.some(input => input.name === 'expectedValues' && (
    input.type === 'record' || (typeof input.type === 'object' && input.type.kind === 'record')
  )) ?? false
  if (acceptsTypedExpectedValues && previewResult) {
    const state: TypedRecordBuild = { schemas: [], statements: [], nextRecordId: 0, nextSchemaId: 0 }
    const expectedValuesSchema = typedRecordSchemaId(state, 'constant-preview-expected-values')
    const expectedValuesOutput = buildTypedRecord(expectedValues, state, expectedValuesSchema, 'preview.expectedValues')
    const inputs: Record<string, GameplayValue> = {
      description: literal(value.description as string),
      expectedValues: expectedValuesOutput,
    }
    state.statements.push(call('preview', 'preview.result', inputs))
    return {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'preview',
      outputs: [port('result', 'record')],
      schemas: state.schemas,
      body: [...state.statements, { kind: 'return', id: 'return', value: output('preview', 'result') }],
    }
  }
  if (canUseSharedPreviewResult && previewResult) {
    const inputs: Record<string, GameplayValue> = { description: literal(value.description as string) }
    for (const [name, item] of Object.entries(expectedValues)) inputs[name] = literal(item as GameplayLiteral)
    return {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'preview',
      outputs: [port('result', 'record')],
      body: [
        call('preview', 'preview.result', inputs),
        { kind: 'return', id: 'return', value: output('preview', 'result') },
      ],
    }
  }
  return buildTypedPreviewRecordGraph(value)
}

function legacyGraphForField(current: JsonRecord, field: SemanticConstantField): JsonRecord | undefined {
  if (current.contentGraphField === field && record(current.contentGraph)) return current.contentGraph
  if (record(current.contentGraphEntries)) {
    const entry = current.contentGraphEntries[field]
    if (record(entry) && record(entry.graph)) return entry.graph
  }
  return undefined
}

function surfaceFor(id: string, field: SemanticConstantField, entry: JsonRecord, current: JsonRecord): SemanticConstantSurface {
  if (field === 'previewCode') return 'preview'
  const existing = legacyGraphForField(current, field)
  if (existing && ACTIVE_SURFACES.includes(existing.surface as Exclude<GameplayModuleSurface, 'preview'>)) {
    return existing.surface as Exclude<GameplayModuleSurface, 'preview'>
  }
  const group = id.split('/')[0]
  if (group === 'cards') return 'card'
  if (group === 'rules') return 'rule'
  return entry.kind === 'passive' ? 'triggerSkill' : 'skill'
}

function generatedFields(current: JsonRecord): Set<string> {
  const fields = new Set(GENERATED_LEGACY_FIELDS)
  if (typeof current.contentGraphField === 'string') fields.add(current.contentGraphField)
  if (record(current.contentGraphEntries)) for (const key of Object.keys(current.contentGraphEntries)) fields.add(key)
  if (record(current.gameplayModules) && record(current.gameplayModules.entries)) {
    for (const key of Object.keys(current.gameplayModules.entries)) fields.add(key)
  }
  return fields
}

function assertCompatibilityFields(current: JsonRecord, baseline: JsonRecord, id: string, field: string): void {
  const generated = generatedFields(current)
  for (const key of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
    if (key === field || generated.has(key) || key === 'gameplayModules' || key === 'cluster') continue
    if (canonicalJson(current[key]) !== canonicalJson(baseline[key])) {
      throw new Error(`${id}: compatibility field changed before semantic migration: ${key}`)
    }
  }
}

function assertPreservedFields(current: JsonRecord, next: JsonRecord, id: string, field: string): void {
  const generated = generatedFields(current)
  for (const key of new Set([...Object.keys(current), ...Object.keys(next)])) {
    if (key === field || generated.has(key) || key === 'gameplayModules') continue
    if (canonicalJson(current[key]) !== canonicalJson(next[key])) {
      throw new Error(`${id}: semantic migration changed compatibility field: ${key}`)
    }
  }
}

function isComplexEntry(id: string): boolean {
  // This passive's executable is only the success marker; its rule remains a separate Cluster member.
  if (id === 'skills/rafaam-curse-ward') return false
  const name = id.split('/')[1] ?? ''
  return COMPLEX_PREFIXES.some(prefix => name.startsWith(prefix))
}

function hasGameplayModuleField(current: JsonRecord, field: SemanticConstantField): boolean {
  return record(current.gameplayModules)
    && record(current.gameplayModules.entries)
    && record(current.gameplayModules.entries[field])
}

function buildMigration(id: string, field: SemanticConstantField, value: JsonRecord, surface: SemanticConstantSurface): SemanticConstantMigration {
  return {
    id,
    field,
    surface,
    value,
    build: () => field === 'previewCode'
      ? buildConstantPreviewGraph(value)
      : buildConstantResultGraph(value, surface as Exclude<GameplayModuleSurface, 'preview'>),
  }
}

export type SemanticConstantDiscovery = {
  readonly migrations: readonly SemanticConstantMigration[]
  readonly sourceReports: readonly SemanticConstantReport[]
}

/** Discover only frozen ordinary entries with the exact constant AST shape. */
export function discoverSemanticConstantMigrations(root: string, baseline: JsonRecord): SemanticConstantDiscovery {
  if (!record(baseline.entries)) throw new Error('RED-252 baseline has no entries object')
  const migrations: SemanticConstantMigration[] = []
  const sourceReports: SemanticConstantReport[] = []
  for (const [id, entryValue] of Object.entries(baseline.entries)) {
    if (!record(entryValue)) continue
    for (const field of SOURCE_FIELDS) {
      if (typeof entryValue[field] !== 'string') continue
      const parsed = parseConstantReturn(entryValue[field])
      if (parsed.kind === 'skip') {
        sourceReports.push({ id, field, status: 'skipped', reason: parsed.reason })
        continue
      }
      const shaped = field === 'previewCode' ? previewValue(parsed.value) : resultValue(parsed.value)
      if (!shaped.ok) {
        sourceReports.push({ id, field, status: 'skipped', reason: shaped.reason })
        continue
      }
      if (isComplexEntry(id)) {
        sourceReports.push({ id, field, status: 'skipped', reason: 'reserved for the complex Tails/Minato/Turalyon/Rafaam migration batch' })
        continue
      }
      const file = path.join(root, 'data', `${id}.json`)
      if (!fs.existsSync(file)) {
        sourceReports.push({ id, field, status: 'blocked', reason: 'production file does not exist', file })
        continue
      }
      const current = readJson(file)
      const surface = surfaceFor(id, field, entryValue, current)
      const migration = buildMigration(id, field, shaped.value, surface)
      migrations.push(migration)
      sourceReports.push({
        id,
        field,
        surface,
        file,
        status: hasGameplayModuleField(current, field) ? 'already-migrated' : 'ready',
      })
    }
  }
  return { migrations, sourceReports }
}

/** Preflight all selected constant migrations and produce write-ready documents. */
export function runSemanticConstantMigrations(
  root: string,
  baseline: JsonRecord,
  selectedIds?: readonly string[],
): SemanticConstantRun {
  const discovery = discoverSemanticConstantMigrations(root, baseline)
  const baselineEntries = baseline.entries as JsonRecord
  const selected = selectedIds?.length
    ? discovery.migrations.filter(entry => selectedIds.includes(entry.id) || selectedIds.includes(`${entry.id}.${entry.field}`))
    : discovery.migrations
  if (selectedIds?.length) {
    const known = new Set(discovery.migrations.flatMap(entry => [entry.id, `${entry.id}.${entry.field}`]))
    const unknown = selectedIds.filter(id => !known.has(id))
    if (unknown.length) throw new Error(`Unknown semantic constant migration: ${unknown.join(', ')}`)
  }
  const reports = discovery.sourceReports.filter(report => {
    if (!selectedIds?.length) return true
    return selectedIds.includes(report.id) || selectedIds.includes(`${report.id}.${report.field}`)
  }).map(report => ({ ...report }))
  const documents = new Map<string, JsonRecord>()
  const blocked: SemanticConstantReport[] = []
  for (const migration of selected) {
    const file = path.join(root, 'data', `${migration.id}.json`)
    const baselineEntry = baselineEntries[migration.id]
    const current = documents.get(file) ?? readJson(file)
    try {
      if (hasGameplayModuleField(current, migration.field)) {
        assertGameplayModuleDocument(current)
        continue
      }
      if (!record(baselineEntry)) throw new Error(`${migration.id}: not in frozen ordinary-match baseline`)
      assertCompatibilityFields(current, baselineEntry, migration.id, migration.field)
      const document = applyGameplayModuleGraph(current, migration.build(), migration.field)
      assertGameplayModuleDocument(document)
      assertPreservedFields(current, document, migration.id, migration.field)
      documents.set(file, document)
      const index = reports.findIndex(report => report.id === migration.id && report.field === migration.field)
      if (index >= 0) reports[index] = { ...reports[index], status: 'ready', document }
    } catch (error) {
      const blockedReport: SemanticConstantReport = {
        id: migration.id,
        field: migration.field,
        surface: migration.surface,
        status: 'blocked',
        reason: error instanceof Error ? error.message : String(error),
        file,
      }
      blocked.push(blockedReport)
      const index = reports.findIndex(report => report.id === migration.id && report.field === migration.field)
      if (index >= 0) reports[index] = blockedReport
      else reports.push(blockedReport)
    }
  }
  return { migrations: selected, reports: [...reports, ...blocked.filter(item => !reports.some(report => report.id === item.id && report.field === item.field))], documents }
}

function cli(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const requestedIds = args.filter(argument => argument !== '--write')
  const baseline = readJson(path.join(root, 'tests', 'game', 'fixtures', 'RED-252-legacy-content.json'))
  const run = runSemanticConstantMigrations(root, baseline, requestedIds)
  const blocked = run.reports.filter(report => report.status === 'blocked')
  if (write && blocked.length) {
    throw new Error(JSON.stringify({ message: 'Semantic constant migration is blocked; no production files were written.', blocked }, null, 2))
  }
  if (write) {
    for (const [file, document] of run.documents) fs.writeFileSync(file, JSON.stringify(document, null, 2) + '\n', 'utf8')
  }
  const ready = run.reports.filter(report => report.status === 'ready')
  const already = run.reports.filter(report => report.status === 'already-migrated')
  const skipped = run.reports.filter(report => report.status === 'skipped')
  console.log(JSON.stringify({
    mode: write ? 'written' : 'dry-run',
    migrationVersion: SEMANTIC_CONSTANT_VERSION,
    compilerVersion: GAMEPLAY_MODULE_COMPILER_VERSION,
    baseSha: baseline.baseSha,
    counts: { ready: ready.length, alreadyMigrated: already.length, skipped: skipped.length, blocked: blocked.length },
    migrations: run.reports.map(({ id, field, surface, status, reason, file }) => ({ id, field, surface, status, reason, file })),
  }, null, 2))
  if (blocked.length) process.exitCode = 1
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invoked && path.resolve(fileURLToPath(import.meta.url)) === invoked) cli()

