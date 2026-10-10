import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  GAMEPLAY_MODULE_COMPILER_VERSION,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  assertGameplayModuleDocument,
  type GameplayLiteral,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayModuleSurface,
  type GameplayPort,
  type GameplayStatement,
  type GameplayValue,
} from '../lib/skill-graph/module-document'
import { compileGameplayModuleGraph } from '../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../lib/skill-graph/module-registry'
import { SUMMON_GAMEPLAY_MODULES } from '../lib/skill-graph/module-registry-summon-primitives'

export const SEMANTIC_SHADOW_CLONE_VERSION = '1' as const
export const SHADOW_CLONE_SKILL_ID = 'skills/naruto-shadow-clone' as const
export const SHADOW_CLONE_DIED_RULE_ID = 'rules/rule-naruto-clone-died' as const
export const SHADOW_CLONE_IMMOBILE_RULE_ID = 'rules/rule-naruto-clone-immobile' as const
export const SHADOW_CLONE_ONE_HIT_RULE_ID = 'rules/rule-naruto-clone-one-hit' as const

type JsonRecord = Record<string, unknown>
type GraphField = 'code' | 'skillCode'

const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })
const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const port = (name: string, type: GameplayPort['type'], options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })

function call(id: string, module: string, inputs: Readonly<Record<string, GameplayValue>> = {}, parameters: Readonly<Record<string, GameplayLiteral>> = {}): GameplayStatement {
  return { kind: 'call', id, module, version: SEMANTIC_SHADOW_CLONE_VERSION, inputs, parameters }
}

function branch(id: string, condition: GameplayValue, then: readonly GameplayStatement[], otherwise: readonly GameplayStatement[] = []): GameplayStatement {
  return { kind: 'if', id, condition, then, else: otherwise }
}

function returnValue(id: string, value: GameplayValue): GameplayStatement {
  return { kind: 'return', id, value }
}

function returnValues(id: string, values: Readonly<Record<string, GameplayValue>>): GameplayStatement {
  return { kind: 'return', id, values }
}

function resultAction(id: string, success: GameplayValue, message: GameplayValue): GameplayStatement[] {
  return [
    call(id + '-result', 'result.action', { success, message }),
    returnValue(id + '-return', output(id + '-result', 'result')),
  ]
}

function failureAction(id: string, message: string): GameplayStatement[] {
  return resultAction(id, literal(false), literal(message))
}

function cancelledAction(id: string, message: string): GameplayStatement[] {
  return resultAction(id, literal(true), literal(message))
}

function pendingReturn(id: string, choiceNode: string): GameplayStatement[] {
  return [
    call(id + '-result', 'choice.as-result', { choice: output(choiceNode, 'choice') }),
    returnValue(id + '-return', output(id + '-result', 'result')),
  ]
}

function ruleMessage(id: string, success: boolean, message: GameplayValue): GameplayStatement[] {
  return [
    call(id + '-result', 'result.message', { message }, { success }),
    returnValues(id + '-return', {
      success: output(id + '-result', 'success'),
      message: output(id + '-result', 'message'),
    }),
  ]
}

function ruleEmpty(id: string): GameplayStatement[] {
  return ruleMessage(id, false, literal(''))
}

/**
 * A registry local to this migration script. The production registry is wired
 * only after the parent approves the descriptor set, while migration tests
 * still need to compile and inspect the complete graph now.
 */
export const SHADOW_CLONE_GAMEPLAY_REGISTRY: GameplayModuleRegistry = (() => {
  const descriptors = [...GAMEPLAY_MODULE_REGISTRY.descriptors, ...SUMMON_GAMEPLAY_MODULES]
  const byId = new Map<string, (typeof descriptors)[number]>()
  for (const descriptor of descriptors) byId.set(descriptor.id, descriptor)
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

/** Active skill graph: option first, then range-five cell, then summon/teleport. */
export function buildNarutoShadowCloneGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') }),
  ]

  const sourceBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('source-name', 'attribute.text', { piece: output('source', 'piece') }, { attribute: 'name' }),
    call('mode-choice', 'choice.option-pair', {}, {
      title: '选择影分身方式',
      firstLabel: '在目标格召唤分身', firstValue: 'summon',
      secondLabel: '传送至目标格，原地留下分身', secondValue: 'teleport',
    }),
    call('mode-unresolved', 'choice.is-unresolved', { choice: output('mode-choice', 'choice') }),
    branch('mode-wait-or-cancel', output('mode-unresolved', 'value'), pendingReturn('mode-pending', 'mode-choice')),
    call('mode', 'choice.option-value', { choice: output('mode-choice', 'choice') }),
    call('target-choice', 'choice.target-cell', {}, { range: 5, filter: 'all' }),
    call('target-unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
    branch('target-wait-or-cancel', output('target-unresolved', 'value'), pendingReturn('target-pending', 'target-choice')),
    call('target', 'choice.cell', { choice: output('target-choice', 'choice') }),
    // This snapshot dominates both branches and is evaluated before any move.
    call('original-position', 'spatial.piece-position', { piece: output('source', 'piece') }),
    call('distance', 'spatial.cell-distance', { from: output('original-position', 'cell'), to: output('target', 'cell') }),
    call('out-of-range', 'compare.greater-than', { left: output('distance', 'distance'), right: literal(5) }),
    branch('range-guard', output('out-of-range', 'value'), failureAction('range', '影分身之术只能选择5格内的位置'), [
      call('walkable', 'spatial.cell-walkable', { cell: output('target', 'cell') }),
      branch('walkable-guard', output('walkable', 'walkable'), [
        call('is-summon', 'compare.equal-string', { left: output('mode', 'value'), right: literal('summon') }),
        branch('mode-branch', output('is-summon', 'value'), [
          call('summon-landing', 'spatial.cell-landing-legal', {
            cell: output('target', 'cell'), ignoreA: literal(null), ignoreB: literal(null),
          }, { terrainPolicy: 'walkable' }),
          branch('summon-landing-guard', output('summon-landing', 'legal'), [
            call('queue-summon', 'lifecycle.queue-summon', {
              source: output('source', 'piece'), destination: output('target', 'cell'), variant: output('mode', 'value'),
            }),
            call('summon-message', 'text.concat', { left: output('source-name', 'text'), right: literal('使用了影分身之术') }),
            ...resultAction('summon-success', literal(true), output('summon-message', 'text')),
          ], failureAction('summon-occupied', '目标格已被占用')),
        ], [
          call('teleport-landing', 'spatial.cell-landing-legal', {
            cell: output('target', 'cell'), ignoreA: output('source', 'piece'), ignoreB: literal(null),
          }, { terrainPolicy: 'walkable' }),
          branch('teleport-landing-guard', output('teleport-landing', 'legal'), [
            call('teleport', 'effect.teleport', { piece: output('source', 'piece'), destination: output('target', 'cell') }, { kind: 'teleport' }),
            branch('teleport-commit', output('teleport', 'success'), [
              call('queue-teleport-summon', 'lifecycle.queue-summon', {
                source: output('source', 'piece'), destination: output('original-position', 'cell'), variant: output('mode', 'value'),
              }),
              call('teleport-message', 'text.concat', { left: output('source-name', 'text'), right: literal('使用了影分身之术') }),
              ...resultAction('teleport-success', literal(true), output('teleport-message', 'text')),
            ], cancelledAction('teleport-blocked', '传送被阻挡，影分身之术取消')),
          ], failureAction('teleport-occupied', '目标格已被占用')),
        ]),
      ], failureAction('not-walkable', '目标格不可行走')),
    ]),
  ]

  body.push(branch('source-guard', output('source-present', 'exists'), sourceBody, failureAction('missing-source', '')))
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    outputs: [port('result', 'record', { nullable: true })],
    body,
  }
}

/** onPieceDied rule: keep the existing no-charge message behavior. */
export function buildNarutoCloneDiedGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('holder-ref', 'ref.holder'),
    call('holder-present', 'query.has-piece', { pieceId: output('holder-ref', 'piece') }),
  ]
  const sourceBody: GameplayStatement[] = [
    call('holder', 'query.piece', { pieceId: output('holder-ref', 'piece') }),
    call('source-ref', 'ref.source'),
    call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') }),
  ]
  const sameBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('same-holder', 'compare.equal-piece', { left: output('source', 'piece'), right: output('holder', 'piece') }),
  ]
  const matchedBody: GameplayStatement[] = [
    call('attacker-ref', 'ref.target'),
    call('attacker-present', 'query.has-piece', { pieceId: output('attacker-ref', 'piece') }),
  ]
  const attackerBody: GameplayStatement[] = [
    call('attacker', 'query.piece', { pieceId: output('attacker-ref', 'piece') }),
    call('attacker-name', 'attribute.text', { piece: output('attacker', 'piece') }, { attribute: 'name' }),
    call('attacker-message', 'text.concat', { left: output('attacker-name', 'text'), right: literal('击杀了影分身（无充能）') }),
    ...ruleMessage('attacker', true, output('attacker-message', 'text')),
  ]
  const noAttackerBody: GameplayStatement[] = [
    call('clone-name', 'attribute.text', { piece: output('holder', 'piece') }, { attribute: 'name' }),
    call('clone-message', 'text.concat', { left: output('clone-name', 'text'), right: literal('消散') }),
    ...ruleMessage('clone', true, output('clone-message', 'text')),
  ]
  matchedBody.push(branch('attacker-guard', output('attacker-present', 'exists'), attackerBody, noAttackerBody))
  sameBody.push(branch('same-guard', output('same-holder', 'value'), matchedBody, ruleEmpty('wrong-holder')))
  sourceBody.push(branch('source-guard', output('source-present', 'exists'), sameBody, ruleEmpty('missing-source')))
  body.push(branch('holder-guard', output('holder-present', 'exists'), sourceBody, ruleEmpty('missing-holder')))
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    outputs: [port('success', 'boolean'), port('message', 'string')],
    body,
  }
}

/** beforeMove rule: block living clones and self-remove if the tag is gone. */
export function buildNarutoCloneImmobileGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('holder-ref', 'ref.holder'),
    call('holder-present', 'query.has-piece', { pieceId: output('holder-ref', 'piece') }),
  ]
  const holderBody: GameplayStatement[] = [
    call('holder', 'query.piece', { pieceId: output('holder-ref', 'piece') }),
    call('alive', 'piece.alive', { piece: output('holder', 'piece') }),
    call('event-ref', 'ref.event-piece'),
    call('event-present', 'query.has-piece', { pieceId: output('event-ref', 'piece') }),
  ]
  const eventBody: GameplayStatement[] = [
    call('event-piece', 'query.piece', { pieceId: output('event-ref', 'piece') }),
    call('same-piece', 'compare.equal-piece', { left: output('event-piece', 'piece'), right: output('holder', 'piece') }),
  ]
  const sameBody: GameplayStatement[] = [
    call('has-tag', 'status.has-piece', { piece: output('holder', 'piece') }, { statusType: 'naruto-clone' }),
    branch('tag-guard', output('has-tag', 'value'), [
      call('block', 'event.block', { message: literal('影分身无法移动') }),
      returnValues('blocked-return', {
        success: output('block', 'success'), blocked: output('block', 'blocked'), message: output('block', 'message'),
      }),
    ], [
      call('remove-rule', 'rule.remove-piece', { target: output('holder', 'piece') }, { ruleId: 'rule-naruto-clone-immobile' }),
      ...ruleEmpty('missing-tag'),
    ]),
  ]
  eventBody.push(branch('same-guard', output('same-piece', 'value'), sameBody, ruleEmpty('wrong-event-piece')))
  holderBody.push(branch('event-guard', output('event-present', 'exists'), eventBody, ruleEmpty('missing-event-piece')))
  body.push(branch('holder-guard', output('holder-present', 'exists'), [
    ...holderBody.slice(0, 2),
    branch('alive-branch', output('alive', 'alive'), holderBody.slice(2), ruleEmpty('dead-holder')),
  ], ruleEmpty('missing-holder')))
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    outputs: [port('success', 'boolean'), port('blocked', 'boolean', { optional: true }), port('message', 'string')],
    body,
  }
}

/** afterDamageTaken rule: zero HP, then let the current DeathBatch finish. */
export function buildNarutoCloneOneHitGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('holder-ref', 'ref.holder'),
    call('holder-present', 'query.has-piece', { pieceId: output('holder-ref', 'piece') }),
  ]
  const sourceBody: GameplayStatement[] = [
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('same-holder', 'compare.equal-piece', { left: output('source', 'piece'), right: output('holder', 'piece') }),
  ]
  const damageBody: GameplayStatement[] = [
    call('zero-health', 'lifecycle.zero-health', { target: output('holder', 'piece') }),
    call('clone-name', 'attribute.text', { piece: output('holder', 'piece') }, { attribute: 'name' }),
    call('message', 'text.concat', { left: output('clone-name', 'text'), right: literal('（影分身）受到伤害，立即消散') }),
    ...ruleMessage('damaged', true, output('message', 'text')),
  ]
  const damageFlow: GameplayStatement[] = [
    call('damage', 'event.damage'),
    call('damage-or-zero', 'value.number-or-zero', { value: output('damage', 'value') }),
    call('has-damage', 'compare.greater-than', { left: output('damage-or-zero', 'value'), right: literal(0) }),
    branch('damage-guard', output('has-damage', 'value'), damageBody, ruleEmpty('zero-damage')),
  ]
  sourceBody.push(branch('same-guard', output('same-holder', 'value'), damageFlow, ruleEmpty('wrong-source')))
  const sourceGuard: GameplayStatement = branch('source-guard', output('source-present', 'exists'), [
    ...sourceBody,
  ], ruleEmpty('missing-source'))
  const holderBody: GameplayStatement[] = [
    call('holder', 'query.piece', { pieceId: output('holder-ref', 'piece') }),
    call('source-ref', 'ref.source'),
    call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') }),
    sourceGuard,
  ]
  // The source-present guard is evaluated before reading event damage.
  body.push(branch('holder-guard', output('holder-present', 'exists'), holderBody, ruleEmpty('missing-holder')))
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    outputs: [port('success', 'boolean'), port('message', 'string')],
    body,
  }
}

// Explicit aliases keep the migration API readable to callers that refer to
// the skill/rule entries rather than the game-facing content names.
export const buildShadowCloneSkillGraph = buildNarutoShadowCloneGraph
export const buildShadowCloneDiedRuleGraph = buildNarutoCloneDiedGraph
export const buildShadowCloneImmobileRuleGraph = buildNarutoCloneImmobileGraph
export const buildShadowCloneOneHitRuleGraph = buildNarutoCloneOneHitGraph

export type SemanticShadowCloneMigration = {
  readonly id: typeof SHADOW_CLONE_SKILL_ID | typeof SHADOW_CLONE_DIED_RULE_ID | typeof SHADOW_CLONE_IMMOBILE_RULE_ID | typeof SHADOW_CLONE_ONE_HIT_RULE_ID
  readonly field: GraphField
  readonly surface: GameplayModuleSurface
  readonly build: () => GameplayModuleGraph
}

export const SEMANTIC_SHADOW_CLONE_MIGRATIONS: readonly SemanticShadowCloneMigration[] = Object.freeze([
  { id: SHADOW_CLONE_SKILL_ID, field: 'code', surface: 'skill', build: buildNarutoShadowCloneGraph },
  { id: SHADOW_CLONE_DIED_RULE_ID, field: 'skillCode', surface: 'rule', build: buildNarutoCloneDiedGraph },
  { id: SHADOW_CLONE_IMMOBILE_RULE_ID, field: 'skillCode', surface: 'rule', build: buildNarutoCloneImmobileGraph },
  { id: SHADOW_CLONE_ONE_HIT_RULE_ID, field: 'skillCode', surface: 'rule', build: buildNarutoCloneOneHitGraph },
])

export const SEMANTIC_SHADOW_CLONE_MIGRATION_IDS = Object.freeze(SEMANTIC_SHADOW_CLONE_MIGRATIONS.map(entry => `${entry.id}.${entry.field}`))

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as JsonRecord)[key])}`).join(',')}}`
}

const GENERATED_FIELDS = new Set([
  'code', 'skillCode', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster',
])

function assertCompatibility(current: JsonRecord, baseline: JsonRecord, migration: SemanticShadowCloneMigration): void {
  for (const key of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
    if (GENERATED_FIELDS.has(key)) continue
    if (canonicalJson(current[key]) !== canonicalJson(baseline[key])) throw new Error(`${migration.id}: compatibility field changed before semantic migration: ${key}`)
  }
}

function primaryField(content: JsonRecord): string {
  if (!isRecord(content.contentGraph)) return ''
  return typeof content.contentGraphField === 'string' ? content.contentGraphField : ''
}

function applyShadowCloneGameplayModuleGraph(inputDocument: JsonRecord, graph: GameplayModuleGraph, field?: GraphField): JsonRecord {
  const compiled = compileGameplayModuleGraph(graph, SHADOW_CLONE_GAMEPLAY_REGISTRY)
  const target = field ?? (compiled.surface === 'rule' ? 'skillCode' : 'code')
  if (!['code', 'skillCode'].includes(target)) throw new Error(`unsupported semantic shadow-clone field ${target}`)
  const prior = isRecord(inputDocument.gameplayModules) && isRecord(inputDocument.gameplayModules.entries)
    ? inputDocument.gameplayModules as { version?: unknown; entries: Record<string, unknown>; textBindings?: unknown }
    : undefined
  const next: JsonRecord = { ...inputDocument }
  const additional: JsonRecord = isRecord(inputDocument.contentGraphEntries) ? { ...inputDocument.contentGraphEntries } : {}
  if (primaryField(inputDocument) === target) {
    delete next.contentGraph
    delete next.contentGraphField
    delete next.contentGraphCompilerVersion
    const first = Object.keys(additional).sort()[0]
    if (first) {
      const entry = additional[first]
      if (!isRecord(entry)) throw new Error(`invalid legacy graph entry ${first}`)
      next.contentGraph = entry.graph
      next.contentGraphField = first
      next.contentGraphCompilerVersion = entry.compilerVersion
      delete additional[first]
    }
  } else {
    delete additional[target]
  }
  if (Object.keys(additional).length) next.contentGraphEntries = additional
  else delete next.contentGraphEntries
  next[target] = compiled.code
  next.gameplayModules = {
    ...(prior?.textBindings === undefined ? {} : { textBindings: prior.textBindings }),
    version: 'rvb-gameplay-module-document/v1',
    entries: {
      ...(prior?.entries ?? {}),
      [target]: { graph: JSON.parse(JSON.stringify(graph)), compilerVersion: GAMEPLAY_MODULE_COMPILER_VERSION },
    },
  }
  return next
}

export function applySemanticShadowCloneGraph(inputDocument: JsonRecord, graph: GameplayModuleGraph, field?: GraphField): JsonRecord {
  return applyShadowCloneGameplayModuleGraph(inputDocument, graph, field)
}

function readJson(file: string): JsonRecord {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  if (!isRecord(value)) throw new Error(`${file}: expected a JSON object`)
  return value
}

function relativeFile(id: string): string {
  return id.startsWith('skills/')
    ? path.join('data', 'skills', id.slice('skills/'.length) + '.json')
    : path.join('data', 'rules', id.slice('rules/'.length) + '.json')
}

function migrateOne(root: string, baseline: JsonRecord, migration: SemanticShadowCloneMigration): JsonRecord {
  const baselineEntry = isRecord(baseline.entries) ? baseline.entries[migration.id] : undefined
  if (!isRecord(baselineEntry)) throw new Error(`${migration.id}: missing frozen baseline entry`)
  if (typeof baselineEntry[migration.field] !== 'string') throw new Error(`${migration.id}: frozen entry has no ${migration.field}`)
  const file = path.join(root, relativeFile(migration.id))
  if (!fs.existsSync(file)) throw new Error(`${migration.id}: production file does not exist`)
  const current = readJson(file)
  assertCompatibility(current, baselineEntry, migration)
  // A module-owned entry is authoritative after the first migration. Validate
  // its generated fields before preserving it so a later rerun cannot silently
  // overwrite an author edit or accept stale generated source.
  if (current.gameplayModules !== undefined) {
    const modules = isRecord(current.gameplayModules)
      && isRecord(current.gameplayModules.entries)
      ? current.gameplayModules.entries
      : undefined
    const owned = modules?.[migration.field]
    if (isRecord(owned)) {
      const expected = migration.build()
      // A graph emitted by this migration may need one repair when a trusted
      // descriptor changes its generated source. Author-modified graphs take
      // the validation path below and are preserved byte-for-byte.
      if (canonicalJson(owned.graph) === canonicalJson(expected)) {
        return applyShadowCloneGameplayModuleGraph(current, expected, migration.field)
      }
      assertGameplayModuleDocument(current)
      return current
    }
    assertGameplayModuleDocument(current)
  }
  return applyShadowCloneGameplayModuleGraph(current, migration.build(), migration.field)
}

export type SemanticShadowCloneResult = {
  readonly id: string
  readonly field: GraphField
  readonly surface: GameplayModuleSurface
  readonly status: 'ready' | 'blocked'
  readonly error?: string
  readonly document?: JsonRecord
  readonly file?: string
}

export function runSemanticShadowCloneMigrations(root: string, baseline: JsonRecord, selectedIds?: readonly string[]): readonly SemanticShadowCloneResult[] {
  const selected = selectedIds?.length
    ? SEMANTIC_SHADOW_CLONE_MIGRATIONS.filter(entry => selectedIds.includes(entry.id) || selectedIds.includes(`${entry.id}.${entry.field}`))
    : SEMANTIC_SHADOW_CLONE_MIGRATIONS
  return selected.map(migration => {
    const file = path.join(root, relativeFile(migration.id))
    try {
      return { id: migration.id, field: migration.field, surface: migration.surface, status: 'ready', document: migrateOne(root, baseline, migration), file }
    } catch (error) {
      return { id: migration.id, field: migration.field, surface: migration.surface, status: 'blocked', error: error instanceof Error ? error.message : String(error), file }
    }
  })
}

function cli(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const requested = args.filter(argument => argument !== '--write')
  if (requested.some(id => !SEMANTIC_SHADOW_CLONE_MIGRATION_IDS.includes(id) && !SEMANTIC_SHADOW_CLONE_MIGRATIONS.some(entry => entry.id === id))) {
    throw new Error(`Unknown semantic shadow-clone migration. Choose one of: ${SEMANTIC_SHADOW_CLONE_MIGRATION_IDS.join(', ')}`)
  }
  const baseline = readJson(path.join(root, 'tests', 'game', 'fixtures', 'RED-252-legacy-content.json'))
  const results = runSemanticShadowCloneMigrations(root, baseline, requested)
  const blocked = results.filter(result => result.status === 'blocked')
  if (write && blocked.length) throw new Error(JSON.stringify({ message: 'Semantic shadow-clone migration is blocked; no production files were written.', blocked }, null, 2))
  if (write) for (const result of results) {
    if (!result.document || !result.file) throw new Error(`${result.id}: missing migrated document`)
    fs.writeFileSync(result.file, JSON.stringify(result.document, null, 2) + '\n', 'utf8')
  }
  console.log(JSON.stringify({ mode: write ? 'written' : 'dry-run', compilerVersion: GAMEPLAY_MODULE_COMPILER_VERSION, baseSha: baseline.baseSha, migrations: results.map(({ id, field, surface, status, error }) => ({ id, field, surface, status, error })) }, null, 2))
  if (blocked.length) process.exitCode = 1
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invoked && path.resolve(fileURLToPath(import.meta.url)) === invoked) cli()

