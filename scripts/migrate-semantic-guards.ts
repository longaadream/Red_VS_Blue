import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'

import {
  applyGameplayModuleGraph,
  assertGameplayModuleDocument,
  GAMEPLAY_MODULE_COMPILER_VERSION,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayCompositeDefinition,
  type GameplayLiteral,
  type GameplayModuleGraph,
  type GameplayModuleSurface,
  type GameplayPort,
  type GameplayStatement,
  type GameplayValue,
} from '../lib/skill-graph/module-document'

export const SEMANTIC_GUARD_VERSION = '1' as const
export const STATUS_GUARD_COMPOSITE_ID = 'shared.status-event-guard' as const

type JsonRecord = Record<string, unknown>
type GuardReference = 'event-piece' | 'source' | 'target'

export type SemanticGuardConfig = {
  readonly id: string
  readonly ruleId: string
  readonly reference: GuardReference
  readonly statusType: string
  readonly messageSuffix: string
  readonly requiresAlive: boolean
}

export type SemanticGuardMigration = SemanticGuardConfig & {
  readonly field: 'skillCode'
  readonly surface: 'rule'
  readonly build: () => GameplayModuleGraph
}

export type SemanticGuardReport = {
  readonly id: string
  readonly field: 'skillCode'
  readonly surface: 'rule'
  readonly status: 'ready' | 'already-migrated' | 'blocked'
  readonly reason?: string
  readonly file?: string
  readonly document?: JsonRecord
}

export type SemanticGuardRun = {
  readonly migrations: readonly SemanticGuardMigration[]
  readonly reports: readonly SemanticGuardReport[]
  readonly documents: ReadonlyMap<string, JsonRecord>
}

const ACTIVE_SURFACES: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const GENERATED_FIELDS = new Set([
  'contentGraph',
  'contentGraphField',
  'contentGraphCompilerVersion',
  'contentGraphEntries',
])

const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })

function port(name: string, type: GameplayPort['type'], options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort {
  return { name, type, ...options }
}

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayLiteral>> = {},
): GameplayStatement {
  return { kind: 'call', id, module, version: SEMANTIC_GUARD_VERSION, inputs, parameters }
}

function branch(
  id: string,
  condition: GameplayValue,
  then: readonly GameplayStatement[],
  otherwise: readonly GameplayStatement[] = [],
): GameplayStatement {
  return { kind: 'if', id, condition, then, else: otherwise }
}

function returnValues(id: string, values: Readonly<Record<string, GameplayValue>>): GameplayStatement {
  return { kind: 'return', id, values }
}

const guardOutputs = [
  port('success', 'boolean'),
  port('blocked', 'boolean', { optional: true }),
  port('message', 'string'),
] as const

const failure = (id: string): GameplayStatement[] => [
  returnValues(id, { success: literal(false), message: literal('') }),
]

function referenceModule(reference: GuardReference): string {
  if (reference === 'source') return 'ref.source'
  if (reference === 'target') return 'ref.target'
  return 'ref.event-piece'
}

/**
 * Build the one reusable guard composition. Configuration is data used to
 * bind fixed status/rule/message parameters; the execution remains a graph of
 * registered atoms and never embeds rule-specific source code.
 */
export function buildStatusGuardComposite(config: SemanticGuardConfig): GameplayCompositeDefinition {
  const statusBranch: GameplayStatement[] = [
    call('holder-name', 'attribute.text', { piece: output('holder', 'piece') }, { attribute: 'name' }),
    call('message', 'text.concat', {
      left: output('holder-name', 'text'),
      right: literal(config.messageSuffix),
    }),
    call('block', 'event.block', { message: output('message', 'text') }),
    returnValues('return-blocked', {
      success: output('block', 'success'),
      blocked: output('block', 'blocked'),
      message: output('block', 'message'),
    }),
  ]
  const missingStatusBranch: GameplayStatement[] = [
    call('remove-rule', 'rule.remove-piece', { target: output('holder', 'piece') }, { ruleId: config.ruleId }),
    ...failure('return-inactive'),
  ]
  const statusCheck: GameplayStatement[] = [
    call('has-status', 'status.has-piece', { piece: output('holder', 'piece') }, { statusType: config.statusType }),
    branch('status-guard', output('has-status', 'value'), statusBranch, missingStatusBranch),
  ]

  const activeCheck: GameplayStatement[] = config.requiresAlive
    ? [
      call('current-hp', 'attribute.read', { piece: output('holder', 'piece') }, { attribute: 'currentHp' }),
      call('alive', 'compare.greater-than', { left: output('current-hp', 'value'), right: literal(0) }),
      branch('alive-guard', output('alive', 'value'), statusCheck, failure('return-dead')),
    ]
    : statusCheck

  const subjectCheck: GameplayStatement[] = [
    call('subject', 'query.piece', { pieceId: input('subject') }),
    call('same-holder', 'compare.equal-piece', {
      left: output('holder', 'piece'),
      right: output('subject', 'piece'),
    }),
    branch('subject-identity-guard', output('same-holder', 'value'), activeCheck, failure('return-wrong-subject')),
  ]

  return {
    id: STATUS_GUARD_COMPOSITE_ID,
    version: SEMANTIC_GUARD_VERSION,
    label: '状态事件拦截守卫',
    description: '验证持有者和事件主体，检查状态并阻挡事件；状态失效时移除关联规则。',
    inputs: [
      port('holder', 'piece', { nullable: true }),
      port('subject', 'piece', { nullable: true }),
    ],
    outputs: guardOutputs,
    allowedSurfaces: ACTIVE_SURFACES,
    body: [
      call('holder-exists', 'query.has-piece', { pieceId: input('holder') }),
      branch('holder-guard', output('holder-exists', 'exists'), [
        call('holder', 'query.piece', { pieceId: input('holder') }),
        call('subject-exists', 'query.has-piece', { pieceId: input('subject') }),
        branch('subject-exists-guard', output('subject-exists', 'exists'), subjectCheck, failure('return-missing-subject')),
      ], failure('return-missing-holder')),
    ],
  }
}

export function buildSemanticGuardGraph(config: SemanticGuardConfig): GameplayModuleGraph {
  const subject = call('subject-ref', referenceModule(config.reference))
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    outputs: guardOutputs,
    composites: [buildStatusGuardComposite(config)],
    body: [
      call('holder-ref', 'ref.holder'),
      subject,
      call('guard', STATUS_GUARD_COMPOSITE_ID, {
        holder: output('holder-ref', 'piece'),
        subject: output('subject-ref', 'piece'),
      }),
      branch('result-shape', output('guard', 'blocked'), [
        returnValues('return-blocked', {
          success: output('guard', 'success'),
          blocked: output('guard', 'blocked'),
          message: output('guard', 'message'),
        }),
      ], [
        returnValues('return-unblocked', {
          success: output('guard', 'success'),
          message: output('guard', 'message'),
        }),
      ]),
    ],
  }
}

export const SEMANTIC_GUARD_CONFIGS: readonly SemanticGuardConfig[] = Object.freeze([
  {
    id: 'rules/rule-silenced-block',
    ruleId: 'rule-silenced-block',
    reference: 'source',
    statusType: 'silenced',
    messageSuffix: ' 已被沉默，无法使用技能',
    requiresAlive: true,
  },
  {
    id: 'rules/rule-naruto-sage-block-skill',
    ruleId: 'rule-naruto-sage-block-skill',
    reference: 'event-piece',
    statusType: 'sage-mode',
    messageSuffix: '正在打坐，无法使用技能',
    requiresAlive: true,
  },
  {
    id: 'rules/rule-naruto-sage-immobile',
    ruleId: 'rule-naruto-sage-immobile',
    reference: 'event-piece',
    statusType: 'sage-mode',
    messageSuffix: '正在打坐，无法移动',
    requiresAlive: true,
  },
  {
    id: 'rules/rule-tails-flight-immune',
    ruleId: 'rule-tails-flight-immune',
    reference: 'event-piece',
    statusType: 'immune',
    messageSuffix: '处于免疫状态',
    requiresAlive: false,
  },
  {
    id: 'rules/rule-tails-flight-immune-target',
    ruleId: 'rule-tails-flight-immune-target',
    reference: 'target',
    statusType: 'immune',
    messageSuffix: '处于免疫状态，不能被选择',
    requiresAlive: false,
  },
  {
    id: 'rules/rule-tails-flight-inoperable',
    ruleId: 'rule-tails-flight-inoperable',
    reference: 'source',
    statusType: 'inoperable',
    messageSuffix: '不可操作',
    requiresAlive: false,
  },
  {
    id: 'rules/rule-tails-flight-inoperable-skill',
    ruleId: 'rule-tails-flight-inoperable-skill',
    reference: 'source',
    statusType: 'inoperable',
    messageSuffix: '不可操作',
    requiresAlive: false,
  },
  {
    id: 'rules/rule-chidori-immobile',
    ruleId: 'rule-chidori-immobile',
    reference: 'event-piece',
    statusType: 'chidori-immobile',
    messageSuffix: '被千鸟贯穿，本回合无法移动',
    requiresAlive: true,
  },
  {
    id: 'rules/rule-venom-corrosion-immobile',
    ruleId: 'rule-venom-corrosion-immobile',
    reference: 'event-piece',
    statusType: 'venom-corrosion-immobile',
    messageSuffix: '受到腐蚀，本回合无法移动',
    requiresAlive: true,
  },
])

export const SEMANTIC_GUARD_MIGRATIONS: readonly SemanticGuardMigration[] = Object.freeze(
  SEMANTIC_GUARD_CONFIGS.map(config => ({ ...config, field: 'skillCode' as const, surface: 'rule' as const, build: () => buildSemanticGuardGraph(config) })),
)

export const SEMANTIC_GUARD_MIGRATION_IDS = Object.freeze(
  SEMANTIC_GUARD_MIGRATIONS.map(entry => `${entry.id}.${entry.field}`),
)

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as JsonRecord)[key])}`).join(',')}}`
}

function readJson(file: string): JsonRecord {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  if (!isRecord(value)) throw new Error(`${file}: expected a JSON object`)
  return value
}

function generatedFields(current: JsonRecord): Set<string> {
  const fields = new Set(GENERATED_FIELDS)
  if (typeof current.contentGraphField === 'string') fields.add(current.contentGraphField)
  if (isRecord(current.contentGraphEntries)) for (const key of Object.keys(current.contentGraphEntries)) fields.add(key)
  if (isRecord(current.gameplayModules) && isRecord(current.gameplayModules.entries)) {
    for (const key of Object.keys(current.gameplayModules.entries)) fields.add(key)
  }
  return fields
}

function assertCompatibilityFields(current: JsonRecord, baseline: JsonRecord, id: string): void {
  const generated = generatedFields(current)
  for (const key of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
    if (generated.has(key) || key === 'gameplayModules') continue
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
      throw new Error(`${id}: semantic guard migration changed compatibility field: ${key}`)
    }
  }
}

function hasGameplayModuleField(current: JsonRecord, field: string): boolean {
  return isRecord(current.gameplayModules)
    && isRecord(current.gameplayModules.entries)
    && isRecord(current.gameplayModules.entries[field])
}

/**
 * The six rules are selected from the frozen ordinary-match fixture.  Current
 * skillCode may already be an older generated content graph; the migration
 * replaces that generated field while retaining all compatibility fields.
 */
function migrateOne(root: string, baseline: JsonRecord, entry: SemanticGuardMigration): JsonRecord {
  if (!isRecord(baseline.entries)) throw new Error('RED-252 baseline has no entries object')
  const baselineEntry = baseline.entries[entry.id]
  if (!isRecord(baselineEntry)) throw new Error(`${entry.id}: not in frozen ordinary-match baseline`)
  if (typeof baselineEntry[entry.field] !== 'string') throw new Error(`${entry.id}: frozen entry has no ${entry.field}`)
  const file = path.join(root, 'data', `${entry.id}.json`)
  if (!fs.existsSync(file)) throw new Error(`${entry.id}: production file does not exist`)
  const current = readJson(file)
  if (typeof current[entry.field] !== 'string') throw new Error(`${entry.id}: production entry has no ${entry.field}`)
  assertCompatibilityFields(current, baselineEntry, entry.id)
  assertFrozenExecutable(current, baselineEntry, entry.field, entry.surface, entry.id)
  const document = applyGameplayModuleGraph(current, entry.build(), entry.field)
  assertGameplayModuleDocument(document)
  assertPreservedFields(current, document, entry.id, entry.field)
  return document
}

function selectEntries(selectedIds: readonly string[] | undefined): readonly SemanticGuardMigration[] {
  if (!selectedIds?.length) return SEMANTIC_GUARD_MIGRATIONS
  const entries = SEMANTIC_GUARD_MIGRATIONS.filter(entry => selectedIds.includes(entry.id) || selectedIds.includes(`${entry.id}.${entry.field}`))
  const known = new Set(SEMANTIC_GUARD_MIGRATION_IDS.flatMap(id => [id, id.slice(0, id.lastIndexOf('.'))]))
  const unknown = selectedIds.filter(id => !known.has(id))
  if (unknown.length) throw new Error(`Unknown semantic guard migration: ${unknown.join(', ')}`)
  return entries
}

/** Preflight selected guard migrations without touching production data. */
export function runSemanticGuardMigrations(
  root: string,
  baseline: JsonRecord,
  selectedIds?: readonly string[],
): SemanticGuardRun {
  const selected = selectEntries(selectedIds)
  const reports: SemanticGuardReport[] = []
  const documents = new Map<string, JsonRecord>()
  for (const entry of selected) {
    const file = path.join(root, 'data', `${entry.id}.json`)
    try {
      const current = readJson(file)
      if (hasGameplayModuleField(current, entry.field)) {
        assertGameplayModuleDocument(current)
        reports.push({ id: entry.id, field: entry.field, surface: entry.surface, status: 'already-migrated', file })
        continue
      }
      const document = migrateOne(root, baseline, entry)
      documents.set(file, document)
      reports.push({ id: entry.id, field: entry.field, surface: entry.surface, status: 'ready', file, document })
    } catch (error) {
      reports.push({
        id: entry.id,
        field: entry.field,
        surface: entry.surface,
        status: 'blocked',
        reason: error instanceof Error ? error.message : String(error),
        file,
      })
    }
  }
  return { migrations: selected, reports, documents }
}

function cli(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const selectedIds = args.filter(argument => argument !== '--write')
  const baseline = readJson(path.join(root, 'tests', 'game', 'fixtures', 'RED-252-legacy-content.json'))
  const run = runSemanticGuardMigrations(root, baseline, selectedIds)
  const blocked = run.reports.filter(report => report.status === 'blocked')
  if (write && blocked.length) {
    throw new Error(JSON.stringify({ message: 'Semantic guard migration is blocked; no production files were written.', blocked }, null, 2))
  }
  if (write) {
    for (const [file, document] of run.documents) fs.writeFileSync(file, JSON.stringify(document, null, 2) + '\n', 'utf8')
  }
  const counts = {
    ready: run.reports.filter(report => report.status === 'ready').length,
    alreadyMigrated: run.reports.filter(report => report.status === 'already-migrated').length,
    blocked: blocked.length,
  }
  console.log(JSON.stringify({
    mode: write ? 'written' : 'dry-run',
    compilerVersion: GAMEPLAY_MODULE_COMPILER_VERSION,
    baseSha: baseline.baseSha,
    counts,
    migrations: run.reports.map(({ id, field, surface, status, reason, file }) => ({ id, field, surface, status, reason, file })),
  }, null, 2))
  if (blocked.length) process.exitCode = 1
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invoked && path.resolve(fileURLToPath(import.meta.url)) === invoked) cli()
