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
  type GameplayRecordSchema,
  type GameplayStatement,
  type GameplayValue,
} from '../lib/skill-graph/module-document'

export const SEMANTIC_FLIGHT_VERSION = '1' as const
export const FLIGHT_SKILL_ID = 'skills/tails-twin-flight' as const
export const FLIGHT_RULE_ID = 'rules/rule-tails-flight-resolve' as const

type JsonRecord = Record<string, unknown>
type GraphField = 'code' | 'skillCode'

const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const port = (name: string, type: GameplayPort['type'], options: Omit<GameplayPort, 'name' | 'type'> = {}): GameplayPort => ({ name, type, ...options })

function call(id: string, module: string, inputs: Readonly<Record<string, GameplayValue>> = {}, parameters: Readonly<Record<string, GameplayLiteral>> = {}): GameplayStatement {
  return { kind: 'call', id, module, version: SEMANTIC_FLIGHT_VERSION, inputs, parameters }
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

function createRecord(id: string, schema: string, fields: Readonly<Record<string, GameplayValue>>): GameplayStatement {
  return { kind: 'record.create', id, schema, fields }
}

const ACTIVE_SURFACES: readonly GameplayModuleSurface[] = ['skill', 'card', 'rule', 'triggerSkill', 'pending']
const FLIGHT_RESERVATION_TYPE = 'tails-flight-reservation'
const FLIGHT_RULE = 'rule-tails-flight-resolve'
const IMMUNE_RULES = ['rule-tails-flight-immune', 'rule-tails-flight-immune-target'] as const
const INOPERABLE_RULES = ['rule-tails-flight-inoperable', 'rule-tails-flight-inoperable-skill'] as const

export const FLIGHT_RECORD_SCHEMAS: readonly GameplayRecordSchema[] = Object.freeze([
  {
    id: 'tails.flight-reservation', version: SEMANTIC_FLIGHT_VERSION,
    fields: [
      port('id', 'string'), port('type', 'string'), port('name', 'string'), port('turns', 'number'),
      port('ownerId', 'string'), port('allyId', 'string'), port('x', 'number'), port('y', 'number'),
      port('allyX', 'number'), port('allyY', 'number'), port('flightId', 'string'),
      port('currentDuration', 'number'), port('relatedRules', { kind: 'list', element: 'string' }),
    ],
  },
  {
    id: 'tails.flight-status', version: SEMANTIC_FLIGHT_VERSION,
    fields: [
      port('id', 'string'), port('type', 'string'), port('name', 'string'), port('flightId', 'string'),
      port('stacks', 'number'), port('currentDuration', 'number'), port('relatedRules', { kind: 'list', element: 'string' }),
    ],
  },
])

/** Shared, content-neutral one-piece delayed move. */
export const FLIGHT_MOVE_COMPOSITE: GameplayCompositeDefinition = {
  id: 'shared.flight-move-one', version: SEMANTIC_FLIGHT_VERSION,
  label: '检查并传送一名棋子',
  description: '重新检查确切落点后，经权威位置提交器独立传送一名仍有效的棋子。',
  inputs: [
    port('piece', { kind: 'nullable', value: 'piece' }),
    port('destination', 'cell'),
    port('ignoreA', { kind: 'nullable', value: 'piece' }),
    port('ignoreB', { kind: 'nullable', value: 'piece' }),
  ],
  outputs: [port('moved', 'boolean')],
  allowedSurfaces: ACTIVE_SURFACES,
  body: [
    call('legal', 'spatial.cell-landing-legal', {
      cell: input('destination'), ignoreA: input('ignoreA'), ignoreB: input('ignoreB'),
    }, { terrainPolicy: 'walkable' }),
    branch('legal-guard', output('legal', 'legal'), [
      call('move', 'effect.teleport-if-present', { piece: input('piece'), destination: input('destination') }),
      returnValues('return-moved', { moved: output('move', 'success') }),
    ], [
      returnValues('return-not-moved', { moved: literal(false) }),
    ]),
  ],
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

function pendingReturn(id: string, choiceNode: string): GameplayStatement[] {
  return [
    call(id + '-result', 'choice.as-result', { choice: output(choiceNode, 'choice') }),
    returnValue(id + '-return', output(id + '-result', 'result')),
  ]
}

function appendText(body: GameplayStatement[], id: string, left: GameplayValue, right: GameplayValue): GameplayValue {
  body.push(call(id, 'text.concat', { left, right }))
  return output(id, 'text')
}

function buildFlightId(body: GameplayStatement[]): GameplayValue {
  body.push(
    call('turn-number', 'turn.number'),
    call('source-id', 'piece.identifier', { piece: output('source', 'piece') }),
    call('ally-id', 'piece.identifier', { piece: output('ally', 'piece') }),
    call('cell-a-coordinates', 'spatial.cell-coordinates', { cell: output('cell-a', 'cell') }),
    call('cell-b-coordinates', 'spatial.cell-coordinates', { cell: output('cell-b', 'cell') }),
    call('turn-text', 'text.from-number', { value: output('turn-number', 'value') }),
    call('cell-a-x-text', 'text.from-number', { value: output('cell-a-coordinates', 'x') }),
    call('cell-a-y-text', 'text.from-number', { value: output('cell-a-coordinates', 'y') }),
    call('cell-b-x-text', 'text.from-number', { value: output('cell-b-coordinates', 'x') }),
    call('cell-b-y-text', 'text.from-number', { value: output('cell-b-coordinates', 'y') }),
  )
  let text: GameplayValue = literal('tails-flight-')
  text = appendText(body, 'flight-id-source', text, output('source-id', 'id'))
  text = appendText(body, 'flight-id-turn-separator', text, literal('-'))
  text = appendText(body, 'flight-id-turn', text, output('turn-text', 'text'))
  text = appendText(body, 'flight-id-a-x-separator', text, literal('-'))
  text = appendText(body, 'flight-id-a-x', text, output('cell-a-x-text', 'text'))
  text = appendText(body, 'flight-id-a-y-separator', text, literal('-'))
  text = appendText(body, 'flight-id-a-y', text, output('cell-a-y-text', 'text'))
  text = appendText(body, 'flight-id-b-x-separator', text, literal('-'))
  text = appendText(body, 'flight-id-b-x', text, output('cell-b-x-text', 'text'))
  text = appendText(body, 'flight-id-b-y-separator', text, literal('-'))
  return appendText(body, 'flight-id-b-y', text, output('cell-b-y-text', 'text'))
}

function statusRecord(
  body: GameplayStatement[],
  target: 'source' | 'ally',
  type: 'immune' | 'inoperable',
  flightId: GameplayValue,
  pieceId: GameplayValue,
): GameplayStatement {
  const suffix = type + '-' + target
  const statusId = appendText(body, suffix + '-id', appendText(body, suffix + '-id-base', flightId, literal('-' + type + '-')), pieceId)
  const relatedRules = type === 'immune' ? IMMUNE_RULES : INOPERABLE_RULES
  return createRecord(suffix + '-record', 'tails.flight-status', {
    id: statusId,
    type: literal(type),
    name: literal(type === 'immune' ? '免疫' : '不可操作'),
    flightId,
    stacks: literal(1),
    currentDuration: literal(2),
    relatedRules: literal([...relatedRules]),
  })
}

/** Author graph for the active skill entry. */
export function buildTailsTwinFlightGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('ally-choice', 'choice.target-piece', {}, { range: 4, filter: 'ally' }),
    call('ally-unresolved', 'choice.is-unresolved', { choice: output('ally-choice', 'choice') }),
    branch('ally-wait-or-cancel', output('ally-unresolved', 'value'), pendingReturn('ally-pending', 'ally-choice')),
    call('ally', 'choice.piece', { choice: output('ally-choice', 'choice') }),
    call('same-self', 'compare.equal-piece', { left: output('ally', 'piece'), right: output('source', 'piece') }),
  ]

  const cellFlow: GameplayStatement[] = [
    call('cell-a-choice', 'choice.target-cell', {}, { range: 7, filter: 'all' }),
    call('cell-a-unresolved', 'choice.is-unresolved', { choice: output('cell-a-choice', 'choice') }),
    branch('cell-a-wait-or-cancel', output('cell-a-unresolved', 'value'), pendingReturn('cell-a-pending', 'cell-a-choice')),
    call('cell-a', 'choice.cell', { choice: output('cell-a-choice', 'choice') }),
    call('cell-b-choice', 'choice.target-cell', {}, { range: 7, filter: 'all' }),
    call('cell-b-unresolved', 'choice.is-unresolved', { choice: output('cell-b-choice', 'choice') }),
    branch('cell-b-wait-or-cancel', output('cell-b-unresolved', 'value'), pendingReturn('cell-b-pending', 'cell-b-choice')),
    call('cell-b', 'choice.cell', { choice: output('cell-b-choice', 'choice') }),
  ]

  const validLanding: GameplayStatement[] = [
    call('landing-a', 'spatial.cell-landing-legal', { cell: output('cell-a', 'cell') }, { terrainPolicy: 'floor-or-cover' }),
    call('landing-b', 'spatial.cell-landing-legal', { cell: output('cell-b', 'cell') }, { terrainPolicy: 'floor-or-cover' }),
    call('landing-both', 'logic.and', { left: output('landing-a', 'legal'), right: output('landing-b', 'legal') }),
  ]

  const reservationAndCommit: GameplayStatement[] = [
    call('reserved-a', 'tile.has-effect', { cell: output('cell-a', 'cell') }, { effectType: FLIGHT_RESERVATION_TYPE }),
    call('reserved-b', 'tile.has-effect', { cell: output('cell-b', 'cell') }, { effectType: FLIGHT_RESERVATION_TYPE }),
    call('reserved-any', 'logic.or', { left: output('reserved-a', 'exists'), right: output('reserved-b', 'exists') }),
  ]
  const commitSuccess: GameplayStatement[] = []
  buildFlightId(commitSuccess)
  commitSuccess.push(
    call('flight-id-a-suffix', 'text.concat', { left: output('flight-id-b-y', 'text'), right: literal('-a') }),
    call('flight-id-b-suffix', 'text.concat', { left: output('flight-id-b-y', 'text'), right: literal('-b') }),
    call('add-tile-a', 'tile.add-reservation', {
      cell: output('cell-a', 'cell'), id: output('flight-id-a-suffix', 'text'), flightId: output('flight-id-b-y', 'text'),
    }, { effectType: FLIGHT_RESERVATION_TYPE }),
    call('add-tile-b', 'tile.add-reservation', {
      cell: output('cell-b', 'cell'), id: output('flight-id-b-suffix', 'text'), flightId: output('flight-id-b-y', 'text'),
    }, { effectType: FLIGHT_RESERVATION_TYPE }),
    createRecord('reservation-record', 'tails.flight-reservation', {
      id: output('flight-id-b-y', 'text'), type: literal(FLIGHT_RESERVATION_TYPE), name: literal('双尾飞行预留'), turns: literal(2),
      ownerId: output('source-id', 'id'), allyId: output('ally-id', 'id'),
      x: output('cell-a-coordinates', 'x'), y: output('cell-a-coordinates', 'y'),
      allyX: output('cell-b-coordinates', 'x'), allyY: output('cell-b-coordinates', 'y'),
      flightId: output('flight-id-b-y', 'text'), currentDuration: literal(2), relatedRules: literal([FLIGHT_RULE]),
    }),
    call('apply-reservation-record', 'status.apply-record', { target: output('source', 'piece'), record: output('reservation-record', 'value') }, { inputPolicy: 'host' }),
    call('install-reservation-rule', 'rule.apply-piece', { target: output('source', 'piece') }, { ruleId: FLIGHT_RULE }),
    statusRecord(commitSuccess, 'source', 'immune', output('flight-id-b-y', 'text'), output('source-id', 'id')),
    call('apply-source-immune', 'status.apply-record', { target: output('source', 'piece'), record: output('immune-source-record', 'value') }, { inputPolicy: 'host' }),
    statusRecord(commitSuccess, 'source', 'inoperable', output('flight-id-b-y', 'text'), output('source-id', 'id')),
    call('apply-source-inoperable', 'status.apply-record', { target: output('source', 'piece'), record: output('inoperable-source-record', 'value') }, { inputPolicy: 'host' }),
    ...['rule-tails-flight-immune', 'rule-tails-flight-immune-target', 'rule-tails-flight-inoperable', 'rule-tails-flight-inoperable-skill'].map((ruleId, index) => call('install-source-rule-' + index, 'rule.apply-piece', { target: output('source', 'piece') }, { ruleId })),
    statusRecord(commitSuccess, 'ally', 'immune', output('flight-id-b-y', 'text'), output('ally-id', 'id')),
    call('apply-ally-immune', 'status.apply-record', { target: output('ally', 'piece'), record: output('immune-ally-record', 'value') }, { inputPolicy: 'host' }),
    statusRecord(commitSuccess, 'ally', 'inoperable', output('flight-id-b-y', 'text'), output('ally-id', 'id')),
    call('apply-ally-inoperable', 'status.apply-record', { target: output('ally', 'piece'), record: output('inoperable-ally-record', 'value') }, { inputPolicy: 'host' }),
    ...['rule-tails-flight-immune', 'rule-tails-flight-immune-target', 'rule-tails-flight-inoperable', 'rule-tails-flight-inoperable-skill'].map((ruleId, index) => call('install-ally-rule-' + index, 'rule.apply-piece', { target: output('ally', 'piece') }, { ruleId })),
    ...resultAction('success', literal(true), literal('已预留双尾飞行落点')),
  )
  const commit: GameplayStatement[] = [
    ...reservationAndCommit,
    branch('reserved-guard', output('reserved-any', 'value'), failureAction('reserved', '落点已被预留'), commitSuccess),
  ]

  cellFlow.push(
    call('adjacent', 'spatial.cell-adjacent', { left: output('cell-a', 'cell'), right: output('cell-b', 'cell') }),
    branch('adjacent-guard', output('adjacent', 'value'), [
      ...validLanding,
      branch('landing-guard', output('landing-both', 'value'), commit, failureAction('landing', '落点必须是未被占据的空地或掩体')),
    ], failureAction('adjacent', '两个落点必须上下左右相邻')),
  )
  body.push(branch('same-self-guard', output('same-self', 'value'), failureAction('same-self', '双尾飞行必须选择另一名友军'), cellFlow))

  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    outputs: [port('result', 'record', { nullable: true })],
    schemas: FLIGHT_RECORD_SCHEMAS,
    body,
  }
}

function ruleMessage(id: string, success: boolean, message: string): GameplayStatement[] {
  return [
    call(id + '-result', 'result.message', { message: literal(message) }, { success }),
    returnValues(id + '-return', { success: output(id + '-result', 'success'), message: output(id + '-result', 'message') }),
  ]
}

function buildFlightRuleBody(): readonly GameplayStatement[] {
  const body: GameplayStatement[] = [
    call('holder-ref', 'ref.holder'),
    call('holder-present', 'query.has-piece', { pieceId: output('holder-ref', 'piece') }),
  ]
  const resolve: GameplayStatement[] = [
    call('flight', 'status.find-flight', { target: output('holder', 'piece') }, { statusType: FLIGHT_RESERVATION_TYPE }),
    branch('flight-found', output('flight', 'found'), [
      call('turn', 'turn.number'),
      call('same-turn', 'compare.equal', { left: output('flight', 'appliedTurn'), right: output('turn', 'value') }),
      call('duration-wait', 'compare.greater-than', { left: output('flight', 'currentDuration'), right: literal(1) }),
      call('wait', 'logic.or', { left: output('same-turn', 'value'), right: output('duration-wait', 'value') }),
      branch('wait-guard', output('wait', 'value'), ruleMessage('wait', true, '双尾飞行等待后续己方回合结束'), [
        call('ally', 'query.piece', { pieceId: output('flight', 'allyId') }),
        call('tails-cell', 'spatial.cell', { x: output('flight', 'x'), y: output('flight', 'y') }),
        call('ally-cell', 'spatial.cell', { x: output('flight', 'allyX'), y: output('flight', 'allyY') }),
        call('tails-move', FLIGHT_MOVE_COMPOSITE.id, {
          piece: output('holder', 'piece'), destination: output('tails-cell', 'cell'),
          ignoreA: output('holder', 'piece'), ignoreB: output('ally', 'piece'),
        }),
        call('ally-move', FLIGHT_MOVE_COMPOSITE.id, {
          piece: output('ally', 'piece'), destination: output('ally-cell', 'cell'),
          ignoreA: output('holder', 'piece'), ignoreB: output('ally', 'piece'),
        }),
        call('remove-holder-status', 'status.remove-by-flight', { target: output('holder', 'piece'), flightId: output('flight', 'flightId') }),
        call('remove-ally-status', 'status.remove-by-flight', { target: output('ally', 'piece'), flightId: output('flight', 'flightId') }),
        call('clear-tiles', 'tile.clear-flight-reservations', { flightId: output('flight', 'flightId') }, { effectType: FLIGHT_RESERVATION_TYPE }),
        call('remove-rule', 'rule.remove-piece', { target: output('holder', 'piece') }, { ruleId: FLIGHT_RULE }),
        branch('tails-moved', output('tails-move', 'moved'), [
          branch('ally-moved-after-tails', output('ally-move', 'moved'), ruleMessage('both-moved', true, '双尾飞行完成搬运'), ruleMessage('tails-only', true, '塔尔斯传送完成，队友落点失效')),
        ], [
          branch('ally-moved-alone', output('ally-move', 'moved'), ruleMessage('ally-only', true, '队友传送完成，塔尔斯落点失效'), ruleMessage('none-moved', true, '双尾飞行落点失效，搬运取消')),
        ]),
      ]),
    ], [
      call('remove-missing-flight-rule', 'rule.remove-piece', { target: output('holder', 'piece') }, { ruleId: FLIGHT_RULE }),
      ...ruleMessage('missing-flight', false, ''),
    ]),
  ]
  body.push(branch('holder-guard', output('holder-present', 'exists'), [
    call('holder', 'query.piece', { pieceId: output('holder-ref', 'piece') }),
    call('event-player', 'event.player'),
    call('event-player-present', 'query.has-player', { playerId: output('event-player', 'value') }),
    branch('event-player-guard', output('event-player-present', 'exists'), [
      call('event-player-valid', 'query.player', { playerId: output('event-player', 'value') }),
      call('holder-owner', 'piece.owner', { piece: output('holder', 'piece') }),
      call('owner-match', 'compare.equal-player', { left: output('holder-owner', 'player'), right: output('event-player-valid', 'player') }),
      branch('owner-guard', output('owner-match', 'value'), resolve, ruleMessage('wrong-owner', false, '')),
    ], ruleMessage('wrong-player', false, '')),
  ], ruleMessage('missing-holder', false, '')))
  return body
}

/** Author graph for the endTurn rule entry. */
export function buildTailsFlightResolveGraph(): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    outputs: [port('success', 'boolean'), port('message', 'string', { optional: true })],
    composites: [FLIGHT_MOVE_COMPOSITE],
    schemas: FLIGHT_RECORD_SCHEMAS,
    body: buildFlightRuleBody(),
  }
}

export type SemanticFlightMigration = {
  readonly id: typeof FLIGHT_SKILL_ID | typeof FLIGHT_RULE_ID
  readonly field: GraphField
  readonly surface: GameplayModuleSurface
  readonly build: () => GameplayModuleGraph
}

export const SEMANTIC_FLIGHT_MIGRATIONS: readonly SemanticFlightMigration[] = Object.freeze([
  { id: FLIGHT_SKILL_ID, field: 'code', surface: 'skill', build: buildTailsTwinFlightGraph },
  { id: FLIGHT_RULE_ID, field: 'skillCode', surface: 'rule', build: buildTailsFlightResolveGraph },
])

export const SEMANTIC_FLIGHT_MIGRATION_IDS = Object.freeze(SEMANTIC_FLIGHT_MIGRATIONS.map(entry => `${entry.id}.${entry.field}`))

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readJson(file: string): JsonRecord {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  if (!isRecord(value)) throw new Error(`${file}: expected a JSON object`)
  return value
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as JsonRecord)[key])}`).join(',')}}`
}

const GENERATED_FIELDS = new Set(['code', 'skillCode', 'previewCode', 'cluster', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules'])
const APPROVED_DESCRIPTION = '选择其他友军（4）。在自身7格内选择2个上下左右相邻的空地或掩体，分别标记为双方落点。标记格可被进入。双方获得免疫[2]与不可操作[2]。此后的第2个己方回合结束时分别传送至标记格。落点被占或无法落脚时，仅取消对应棋子的传送。结束飞行状态。'

function assertCompatibility(current: JsonRecord, baseline: JsonRecord, migration: SemanticFlightMigration): void {
  for (const key of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
    if (GENERATED_FIELDS.has(key)) continue
    if (migration.id === FLIGHT_SKILL_ID && key === 'description') {
      if (current.description !== APPROVED_DESCRIPTION && current.description !== baseline.description) throw new Error(`${migration.id}: description differs from approved flight wording`)
      continue
    }
    if (canonicalJson(current[key]) !== canonicalJson(baseline[key])) throw new Error(`${migration.id}: compatibility field changed before semantic migration: ${key}`)
  }
}

function migrateOne(root: string, baseline: JsonRecord, migration: SemanticFlightMigration): JsonRecord {
  const baselineEntry = isRecord(baseline.entries) ? baseline.entries[migration.id] : undefined
  if (!isRecord(baselineEntry)) throw new Error(`${migration.id}: missing frozen baseline entry`)
  if (typeof baselineEntry[migration.field] !== 'string') throw new Error(`${migration.id}: frozen entry has no ${migration.field}`)
  const relative = migration.id.startsWith('skills/') ? path.join('data', 'skills', migration.id.slice('skills/'.length) + '.json') : path.join('data', 'rules', migration.id.slice('rules/'.length) + '.json')
  const file = path.join(root, relative)
  if (!fs.existsSync(file)) throw new Error(`${migration.id}: production file does not exist`)
  const current = readJson(file)
  const moduleDocument = current.gameplayModules
  if (isRecord(moduleDocument) && isRecord(moduleDocument.entries) && moduleDocument.entries[migration.field]) {
    assertGameplayModuleDocument(current)
    return current
  }
  assertFrozenExecutable(current, baselineEntry, migration.field, migration.surface, migration.id)
  assertCompatibility(current, baselineEntry, migration)
  const next = applyGameplayModuleGraph(current, migration.build(), migration.field)
  assertGameplayModuleDocument(next)
  return next
}

export type SemanticFlightResult = {
  readonly id: string
  readonly field: GraphField
  readonly surface: GameplayModuleSurface
  readonly status: 'ready' | 'blocked'
  readonly error?: string
  readonly document?: JsonRecord
  readonly file?: string
}

export function runSemanticFlightMigrations(root: string, baseline: JsonRecord, selectedIds?: readonly string[]): readonly SemanticFlightResult[] {
  const selected = selectedIds?.length
    ? SEMANTIC_FLIGHT_MIGRATIONS.filter(entry => selectedIds.includes(entry.id) || selectedIds.includes(`${entry.id}.${entry.field}`))
    : SEMANTIC_FLIGHT_MIGRATIONS
  return selected.map(migration => {
    const relative = migration.id.startsWith('skills/') ? path.join('data', 'skills', migration.id.slice('skills/'.length) + '.json') : path.join('data', 'rules', migration.id.slice('rules/'.length) + '.json')
    const file = path.join(root, relative)
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
  if (requested.some(id => !SEMANTIC_FLIGHT_MIGRATION_IDS.includes(id) && !SEMANTIC_FLIGHT_MIGRATIONS.some(entry => entry.id === id))) {
    throw new Error(`Unknown semantic flight migration. Choose one of: ${SEMANTIC_FLIGHT_MIGRATION_IDS.join(', ')}`)
  }
  const baseline = readJson(path.join(root, 'tests', 'game', 'fixtures', 'RED-252-legacy-content.json'))
  const results = runSemanticFlightMigrations(root, baseline, requested)
  const blocked = results.filter(result => result.status === 'blocked')
  if (write && blocked.length) throw new Error(JSON.stringify({ message: 'Semantic flight migration is blocked; no production files were written.', blocked }, null, 2))
  if (write) for (const result of results) {
    if (!result.document || !result.file) throw new Error(`${result.id}: missing migrated document`)
    fs.writeFileSync(result.file, JSON.stringify(result.document, null, 2) + '\n', 'utf8')
  }
  console.log(JSON.stringify({ mode: write ? 'written' : 'dry-run', compilerVersion: GAMEPLAY_MODULE_COMPILER_VERSION, baseSha: baseline.baseSha, migrations: results.map(({ id, field, surface, status, error }) => ({ id, field, surface, status, error })) }, null, 2))
  if (blocked.length) process.exitCode = 1
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invoked && path.resolve(fileURLToPath(import.meta.url)) === invoked) cli()

