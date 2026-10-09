import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

export const SEMANTIC_MODULE_VERSION = '1' as const

type JsonRecord = Record<string, unknown>
type GraphField = 'code' | 'skillCode'

export type SemanticMigration = {
  readonly id: string
  readonly field: GraphField
  readonly surface: GameplayModuleSurface
  readonly build: () => GameplayModuleGraph
  /** Missing catalog atoms keep this recipe in verification-only status. */
  readonly missingAtoms?: readonly string[]
}

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
  return { kind: 'call', id, module, version: SEMANTIC_MODULE_VERSION, inputs, parameters }
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

const successMessageOutputs = [
  port('success', 'boolean'),
  port('message', 'string', { optional: true }),
] as const

const ACTIVE_SURFACES: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']

/**
 * This composite is deliberately generic.  It is called by multiple content
 * entries; no content ID is hidden in the lowering.  Keeping the same
 * definition in each graph lets the compiler expand and validate the same
 * author-facing composition independently.
 */
export const RESULT_MESSAGE_COMPOSITE: GameplayCompositeDefinition = {
  id: 'shared.result-message',
  version: SEMANTIC_MODULE_VERSION,
  label: '成功消息',
  description: '将一段已计算文本转换为统一的成功消息结果。',
  inputs: [port('message', 'string')],
  outputs: [port('success', 'boolean'), port('message', 'string')],
  allowedSurfaces: ACTIVE_SURFACES,
  body: [
    call('result-message', 'result.message', { message: input('message') }),
    returnValues('return-result-message', {
      success: output('result-message', 'success'),
      message: output('result-message', 'message'),
    }),
  ],
}

/**
 * This is a content-neutral numerical composition: multiply damage by 0.5 and
 * floor it. The rule caller owns the event guards and queue effect, including
 * the content-specific skill identifier. Keeping those concerns outside the
 * shared composite means the same formula can be reused by other rules.
 */
export const HALF_DAMAGE_COMPOSITE: GameplayCompositeDefinition = {
  id: 'shared.half-damage',
  version: SEMANTIC_MODULE_VERSION,
  label: '伤害一半',
  description: '按当前事件伤害向下取整的一半，供规则效果继续处理。',
  inputs: [port('damage', 'number')],
  outputs: [port('amount', 'number')],
  allowedSurfaces: ACTIVE_SURFACES,
  body: [
    call('half', 'math.multiply', { left: input('damage'), right: literal(0.5) }),
    call('amount', 'math.floor', { value: output('half', 'value') }),
    returnValues('return', { amount: output('amount', 'value') }),
  ],
}

/**
 * The graph for the passive Reap skill is intentionally small: the legacy
 * entry is a real triggerSkill surface and its entire observable behavior is
 * the existing success/message result.
 */
export function buildReapSkillGraph(): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'triggerSkill',
    outputs: successMessageOutputs,
    composites: [RESULT_MESSAGE_COMPOSITE],
    body: [
      call('message', RESULT_MESSAGE_COMPOSITE.id, { message: literal('收割被动技能已激活') }),
      returnValues('return', {
        success: output('message', 'success'),
        message: output('message', 'message'),
      }),
    ],
  }
}

/** A second real triggerSkill entry proves the composite is shared by content. */
export function buildHidanUndyingSkillGraph(): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'triggerSkill',
    outputs: successMessageOutputs,
    composites: [RESULT_MESSAGE_COMPOSITE],
    body: [
      call('message', RESULT_MESSAGE_COMPOSITE.id, { message: literal('') }),
      returnValues('return', {
        success: output('message', 'success'),
        message: output('message', 'message'),
      }),
    ],
  }
}

/** A fixed-message card remains useful as a card-surface host parity sample. */
export function buildRafaamSampleCardGraph(): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'card',
    outputs: successMessageOutputs,
    composites: [RESULT_MESSAGE_COMPOSITE],
    body: [
      call('message', RESULT_MESSAGE_COMPOSITE.id, { message: literal('诅咒卡（?）') }),
      returnValues('return', {
        success: output('message', 'success'),
        message: output('message', 'message'),
      }),
    ],
  }
}

/**
 * Lucky Coin retains the old order: resolve and validate the player, add one
 * action point, read the resulting value, then format the original message.
 * Number-to-text conversion is a registered pure atom, rather than an
 * author-level template. The missing-player branch remains an explicit result.
 */
export function buildLuckyCoinGraph(): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'card',
    outputs: successMessageOutputs,
    composites: [RESULT_MESSAGE_COMPOSITE],
    body: [
      call('player-ref', 'ref.player'),
      call('player-exists', 'query.has-player', {
        playerId: output('player-ref', 'player'),
      }),
      branch('player-guard', output('player-exists', 'exists'), [
        call('player', 'query.player', {
          playerId: output('player-ref', 'player'),
        }),
        call('updated-action-points', 'resource.adjust', {
          player: output('player', 'player'),
          amount: literal(1),
        }, { resource: 'actionPoints' }),
        call('number-text', 'text.from-number', {
          value: output('updated-action-points', 'value'),
        }),
        call('message-prefix', 'text.concat', {
          left: literal('幸运币：获得1点行动力（当前：'),
          right: output('number-text', 'text'),
        }),
        call('message', 'text.concat', {
          left: output('message-prefix', 'text'),
          right: literal('）'),
        }),
        call('result', RESULT_MESSAGE_COMPOSITE.id, { message: output('message', 'text') }),
        returnValues('return-success', {
          success: output('result', 'success'),
          message: output('result', 'message'),
        }),
      ], [
        call('missing-player', 'result.message', { message: literal('找不到玩家') }, { success: false }),
        returnValues('return-missing-player', {
          success: output('missing-player', 'success'),
          message: output('missing-player', 'message'),
        }),
      ]),
    ],
  }
}

/**
 * Reap's rule entry keeps every rejection branch explicit.  The event reader
 * and nullable value resolver are deliberately named atoms so the graph does
 * not smuggle `context.damage`, object paths, or JavaScript conditionals into
 * content.  The success path queues healing and then reuses the shared result
 * composition.
 */
export function buildRuleReapGraph(): GameplayModuleGraph {
  const failure = (id: string): GameplayStatement => returnValues(id, { success: literal(false) })
  const noDamageAtDamageGuard: GameplayStatement[] = [failure('return-no-damage-at-damage-guard')]
  const noDamageAtHealGuard: GameplayStatement[] = [failure('return-no-damage-at-heal-guard')]
  const noHolder: GameplayStatement[] = [failure('return-no-holder')]

  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    outputs: successMessageOutputs,
    composites: [RESULT_MESSAGE_COMPOSITE, HALF_DAMAGE_COMPOSITE],
    body: [
      call('source-ref', 'ref.source'),
      call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
      call('holder-ref', 'ref.holder'),
      call('holder', 'query.piece', { pieceId: output('holder-ref', 'piece') }),
      call('same-holder', 'compare.equal-piece', {
        left: output('source', 'piece'),
        right: output('holder', 'piece'),
      }),
      branch('holder-guard', output('same-holder', 'value'), [
        call('damage', 'event.damage'),
        call('damage-value', 'value.number-or-zero', { value: output('damage', 'value') }),
        call('positive-damage', 'compare.greater-than', {
          left: output('damage-value', 'value'),
          right: literal(0),
        }),
        branch('damage-guard', output('positive-damage', 'value'), [
          call('heal-amount', HALF_DAMAGE_COMPOSITE.id, {
            damage: output('damage-value', 'value'),
          }),
          call('positive-heal', 'compare.greater-than', {
            left: output('heal-amount', 'amount'),
            right: literal(0),
          }),
          branch('heal-guard', output('positive-heal', 'value'), [
            call('queue-heal', 'effect.queue-heal', {
              healer: output('holder', 'piece'),
              target: output('holder', 'piece'),
              amount: output('heal-amount', 'amount'),
            }, { skillId: 'reap' }),
            call('name', 'attribute.text', {
              piece: output('holder', 'piece'),
            }, { attribute: 'name' }),
            call('message-text', 'text.concat', {
              left: output('name', 'text'),
              right: literal('触发了收割'),
            }),
            call('result', RESULT_MESSAGE_COMPOSITE.id, { message: output('message-text', 'text') }),
            returnValues('return-success', {
              success: output('result', 'success'),
              message: output('result', 'message'),
            }),
          ], noDamageAtHealGuard),
        ], noDamageAtDamageGuard),
      ], noHolder),
    ],
  }
}

export const TAILS_MISSING_ATOMS = Object.freeze([
  'choice.require-piece',
  'choice.require-cell',
  'query.cells-adjacent',
  'query.cell-landing-legal',
  'record.create-flight',
  'record.expired',
  'record.cell',
  'record.piece',
  'query.piece-alive',
  'state.set-record',
  'state.get-record',
  'state.remove-record',
  'effect.tile-reservation',
  'effect.tile-reservation-clear',
  'status.custom-record-fields',
  'status.remove-by-record-reference',
  'effect.teleport-group',
  'result.record-with-message',
])

export const SEMANTIC_MIGRATIONS: readonly SemanticMigration[] = Object.freeze([
  { id: 'skills/reap', field: 'code', surface: 'triggerSkill', build: buildReapSkillGraph },
  { id: 'skills/hidan-undying', field: 'code', surface: 'triggerSkill', build: buildHidanUndyingSkillGraph },
  { id: 'cards/rafaam-curse-sample', field: 'code', surface: 'card', build: buildRafaamSampleCardGraph },
  { id: 'cards/lucky-coin', field: 'code', surface: 'card', build: buildLuckyCoinGraph },
  { id: 'rules/rule-reap', field: 'skillCode', surface: 'rule', build: buildRuleReapGraph },
])

/** Tails remains explicitly reported until generic atoms close this gap. */
export const SEMANTIC_REVIEW_GAPS = Object.freeze([
  { id: 'skills/tails-twin-flight', field: 'code' as const, surface: 'skill' as const, missingAtoms: TAILS_MISSING_ATOMS },
  { id: 'rules/rule-tails-flight-resolve', field: 'skillCode' as const, surface: 'rule' as const, missingAtoms: TAILS_MISSING_ATOMS },
])

export const SEMANTIC_MIGRATION_IDS = Object.freeze(SEMANTIC_MIGRATIONS.map(entry => `${entry.id}.${entry.field}`))

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as JsonRecord)[key])}`).join(',')}}`
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readJson(file: string): JsonRecord {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  if (!isRecord(value)) throw new Error(`${file}: expected a JSON object`)
  return value
}

const GENERATED_LEGACY_FIELDS = new Set([
  'contentGraph',
  'contentGraphField',
  'contentGraphCompilerVersion',
  'contentGraphEntries',
])

function assertCompatibilityFields(current: JsonRecord, baseline: JsonRecord, id: string, field: string): void {
  for (const key of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
    if (key === field || GENERATED_LEGACY_FIELDS.has(key) || key === 'gameplayModules') continue
    if (canonicalJson(current[key]) !== canonicalJson(baseline[key])) {
      throw new Error(`${id}: compatibility field changed before semantic migration: ${key}`)
    }
  }
}

function migrateOne(root: string, baseline: JsonRecord, entry: SemanticMigration): JsonRecord {
  const fixtureEntry = isRecord(baseline.entries) ? baseline.entries[entry.id] : undefined
  if (!isRecord(fixtureEntry)) throw new Error(`${entry.id}: not in frozen ordinary-match baseline`)
  if (typeof fixtureEntry[entry.field] !== 'string') throw new Error(`${entry.id}: frozen entry has no ${entry.field}`)
  const file = path.join(root, 'data', `${entry.id}.json`)
  if (!fs.existsSync(file)) throw new Error(`${entry.id}: production file does not exist`)
  const current = readJson(file)
  assertCompatibilityFields(current, fixtureEntry, entry.id, entry.field)
  const graph = entry.build()
  const document = applyGameplayModuleGraph(current, graph, entry.field)
  assertGameplayModuleDocument(document)
  return document
}

export type SemanticMigrationResult = {
  readonly id: string
  readonly field: GraphField
  readonly surface: GameplayModuleSurface
  readonly status: 'ready' | 'blocked'
  readonly dependencies?: readonly string[]
  readonly missingAtoms?: readonly string[]
  readonly error?: string
  readonly document?: JsonRecord
  readonly file?: string
}

function run(root: string, entries: readonly SemanticMigration[], baseline: JsonRecord): SemanticMigrationResult[] {
  return entries.map(entry => {
    const file = path.join(root, 'data', `${entry.id}.json`)
    try {
      const document = migrateOne(root, baseline, entry)
      return { id: entry.id, field: entry.field, surface: entry.surface, status: 'ready', document, file }
    } catch (error) {
      return {
        id: entry.id,
        field: entry.field,
        surface: entry.surface,
        status: 'blocked',
        missingAtoms: entry.missingAtoms,
        error: error instanceof Error ? error.message : String(error),
        file,
      }
    }
  })
}

function cli(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const requestedIds = args.filter(argument => argument !== '--write')
  const entries = requestedIds.length
    ? SEMANTIC_MIGRATIONS.filter(entry => requestedIds.includes(entry.id) || requestedIds.includes(`${entry.id}.${entry.field}`))
    : SEMANTIC_MIGRATIONS
  if (!entries.length) throw new Error(`Unknown semantic migration. Choose one of: ${SEMANTIC_MIGRATION_IDS.join(', ')}`)
  if (requestedIds.some(id => !SEMANTIC_MIGRATIONS.some(entry => entry.id === id || `${entry.id}.${entry.field}` === id))) {
    throw new Error(`Unknown semantic migration. Choose one of: ${SEMANTIC_MIGRATION_IDS.join(', ')}`)
  }
  const baseline = readJson(path.join(root, 'tests', 'game', 'fixtures', 'RED-252-legacy-content.json'))
  const results = run(root, entries, baseline)
  const blocked = results.filter(result => result.status === 'blocked')
  if (write && blocked.length) {
    throw new Error(JSON.stringify({ message: 'Semantic migration is blocked; no production files were written.', blocked }, null, 2))
  }
  if (write) {
    for (const result of results) {
      if (!result.document || !result.file) throw new Error(`${result.id}: missing migrated document`)
      fs.writeFileSync(result.file, JSON.stringify(result.document, null, 2) + '\n', 'utf8')
    }
  }
  console.log(JSON.stringify({
    mode: write ? 'written' : 'dry-run',
    compilerVersion: GAMEPLAY_MODULE_COMPILER_VERSION,
    baseSha: baseline.baseSha,
    notice: 'Only --write updates production data; blocked recipes remain verification-only.',
    migrations: results.map(({ id, field, surface, status, missingAtoms, error }) => ({ id, field, surface, status, missingAtoms, error })),
  }, null, 2))
  // A dry run is also a validation command: callers must not mistake a
  // report containing blocked recipes for a successful migration audit.
  if (blocked.length) process.exitCode = 1
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invoked && path.resolve(fileURLToPath(import.meta.url)) === invoked) cli()
