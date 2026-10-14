import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { assertFrozenExecutable } from './semantic-migration-source'
import { compileContentGraph, CONTENT_GRAPH_COMPILER_VERSION, CONTENT_GRAPH_VERSION } from '../electron-editor/content-graph'
import {
  applyGameplayModuleGraph,
  assertGameplayModuleDocument,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayJsonValue,
  type GameplayModuleGraph,
  type GameplayRecordSchema,
  type GameplayStatement,
  type GameplayValue,
} from '../lib/skill-graph/module-document'

export const RAFAAM_CURSE_END_TURN_RULE_ID = 'rule-rafaam-curse-end-turn' as const
export const RAFAAM_CURSE_WARD_RULE_ID = 'rule-rafaam-curse-ward' as const

const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const call = (
  id: string,
  module: string,
  inputs: Record<string, GameplayValue> = {},
  parameters: Record<string, GameplayJsonValue> = {},
): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const returnResult = (id: string, value: GameplayValue): GameplayStatement => ({ kind: 'return', id, value })
const actionResult = (id: string, success: boolean, message: GameplayValue): GameplayStatement[] => [
  call(`${id}-result`, 'result.action', { success: literal(success), message }),
  returnResult(`${id}-return`, output(`${id}-result`, 'result')),
]
const cardResult = (id: string, success: boolean, message?: GameplayValue, keepInHand = false): GameplayStatement[] => [
  call(`${id}-result`, 'result.card-action', { success: literal(success), ...(message === undefined ? {} : { message }) }, { keepInHand }),
  returnResult(`${id}-return`, output(`${id}-result`, 'result')),
]
type MutableIfStatement = { kind: 'if'; id: string; condition: GameplayValue; then: GameplayStatement[]; else?: GameplayStatement[] }
const branch = (id: string, condition: GameplayValue, then: GameplayStatement[], otherwise: GameplayStatement[] = []): MutableIfStatement => ({ kind: 'if', id, condition, then, else: otherwise })
const recordCreate = (id: string, schema: string, fields: Record<string, GameplayValue>): GameplayStatement => ({ kind: 'record.create', id, schema, fields })

const CURSE_STATUS_SCHEMA: GameplayRecordSchema = {
  id: 'rafaam-curse-ward-used',
  version: '1',
  fields: [
    { name: 'id', type: 'string' },
    { name: 'type', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'remainingDuration', type: 'number' },
    { name: 'currentDuration', type: 'number' },
    { name: 'expiresAtTurnEnd', type: 'number' },
  ],
}

/**
 * Preserve the player-rule behavior byte-for-byte at the semantic boundary:
 * the rule is checked at the triggering player's turn, removes itself when
 * no curse remains, and resolves each curse in hand order with one seeded
 * random friendly target per card.
 */
export function buildRafaamCurseEndTurnGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('event-player', 'ref.event-player'),
    call('player-present', 'query.has-player', { playerId: output('event-player', 'player') }),
  ]
  const playerGuard = branch('player-guard', output('player-present', 'exists'), [], actionResult('missing-player', false, literal('')))
  body.push(playerGuard)
  const active = playerGuard.then
  active.push(
    call('player', 'query.player', { playerId: output('event-player', 'player') }),
    call('current-player', 'turn.current-player'),
    call('own-turn', 'compare.player-reference', { left: output('player', 'player'), right: output('current-player', 'player') }),
  )
  const turnGuard = branch('turn-guard', output('own-turn', 'value'), [], actionResult('wrong-turn', false, literal('')))
  active.push(turnGuard)
  const turnBody = turnGuard.then
  turnBody.push(
    call('hand', 'content.filter-hand', { player: output('player', 'player') }, { nameContains: '诅咒', cardIdPrefix: 'rafaam-curse' }),
    call('curse-count', 'list.count', { items: output('hand', 'cards') }),
    call('has-curses', 'compare.greater-than', { left: output('curse-count', 'count'), right: literal(0) }),
  )
  const curseGuard = branch('curse-guard', output('has-curses', 'value'), [], [
    call('remove-rule', 'rule.remove-player', { target: output('player', 'player') }, { ruleId: RAFAAM_CURSE_END_TURN_RULE_ID }),
    ...actionResult('no-curses', false, literal('')),
  ])
  turnBody.push(curseGuard)
  const curses = curseGuard.then
  curses.push(
    call('enemy', 'content.enemy-player', { player: output('player', 'player') }),
    call('messages', 'collection.text-list-create'),
    {
      kind: 'foreach',
      id: 'resolve-curses',
      items: output('hand', 'cards'),
      item: 'card',
      index: 'card-index',
      body: [
        call('damage', 'content.card-number', { cardId: output('resolve-curses', 'item') }, { field: 'damageAmount', fallback: 4 }),
        call('friendly', 'query.pieces', { ownerId: output('player', 'player') }, { includeDead: false }),
        call('friendly-count', 'list.count-pieces', { items: output('friendly', 'pieces') }),
        call('has-friendly', 'compare.greater-than', { left: output('friendly-count', 'value'), right: literal(0) }),
        branch('friendly-guard', output('has-friendly', 'value'), [
          call('target', 'query.random-item', { items: output('friendly', 'pieces') }),
          call('target-name', 'attribute.text', { piece: output('target', 'item') }, { attribute: 'name' }),
          call('damage-result', 'effect.damage-with-killer-typed', {
            source: output('target', 'item'), target: output('target', 'item'), amount: output('damage', 'value'), killerPlayer: output('enemy', 'enemy'),
          }, { damageType: 'magical', skillId: 'curse-end-turn', inputPolicy: 'host' }),
          call('damage-text', 'text.from-number', { value: output('damage-result', 'damage') }),
          call('message-0', 'text.concat', { left: literal('诅咒对'), right: output('target-name', 'text') }),
          call('message-1', 'text.concat', { left: output('message-0', 'text'), right: literal('造成了') }),
          call('message-2', 'text.concat', { left: output('message-1', 'text'), right: output('damage-text', 'text') }),
          call('message', 'text.concat', { left: output('message-2', 'text'), right: literal('点伤害') }),
          call('append-message', 'collection.text-list-add', { items: output('messages', 'items'), value: output('message', 'text') }),
        ]),
      ],
    },
    call('joined-message', 'list.join', { items: output('messages', 'items') }, { separator: '，' }),
    ...actionResult('success', true, output('joined-message', 'text')),
  )
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    outputs: [{ name: 'result', type: 'record', nullable: true }],
    schemas: [],
    body,
  }
}

/** Preserve the direct status append, card materialization and blocked result
 * of the damage-ward trigger without embedding either generated-card code or
 * mutable battle object paths in the graph. */
export function buildRafaamCurseWardGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('rule-piece-ref', 'ref.rule-piece'),
    call('event-piece-ref', 'ref.event-piece'),
    call('rule-piece-present', 'query.has-piece', { pieceId: output('rule-piece-ref', 'piece') }),
  ]
  const holderGuard = branch('holder-guard', output('rule-piece-present', 'exists'), [], actionResult('missing-holder', false, literal('')))
  body.push(holderGuard)
  const active = holderGuard.then
  active.push(
    call('event-piece-present', 'query.has-piece', { pieceId: output('event-piece-ref', 'piece') }),
  )
  const eventGuard = branch('event-piece-guard', output('event-piece-present', 'exists'), [], actionResult('missing-event-piece', false, literal('')))
  active.push(eventGuard)
  const eventBody = eventGuard.then
  eventBody.push(
    call('same-piece', 'compare.equal-piece-nullable', { left: output('rule-piece-ref', 'piece'), right: output('event-piece-ref', 'piece') }),
  )
  const sameGuard = branch('same-piece-guard', output('same-piece', 'value'), [], actionResult('wrong-piece', false, literal('')))
  eventBody.push(sameGuard)
  const sameBody = sameGuard.then
  sameBody.push(
    call('piece', 'query.piece', { pieceId: output('rule-piece-ref', 'piece') }),
    call('owner', 'piece.owner', { piece: output('piece', 'piece') }),
    call('current-player', 'turn.current-player'),
    call('own-turn', 'compare.player-reference', { left: output('owner', 'player'), right: output('current-player', 'player') }),
  )
  const turnGuard = branch('turn-guard', output('own-turn', 'value'), [], actionResult('wrong-turn', false, literal('')))
  sameBody.push(turnGuard)
  const turnBody = turnGuard.then
  turnBody.push(
    call('already-used', 'status.has-piece', { piece: output('piece', 'piece') }, { statusType: 'curse-ward-used' }),
    call('not-used', 'logic.not', { value: output('already-used', 'value') }),
  )
  const usedGuard = branch('unused-guard', output('not-used', 'value'), [], actionResult('already-used', false, literal('')))
  turnBody.push(usedGuard)
  const unusedBody = usedGuard.then
  unusedBody.push(
    call('damage-event', 'event.read-number', { fallback: literal(0) }, { field: 'damage' }),
    call('attack', 'attribute.read', { piece: output('piece', 'piece') }, { attribute: 'attack' }),
    call('attack-half', 'math.multiply', { left: output('attack', 'value'), right: literal(0.5) }),
    call('attack-bonus', 'math.floor', { value: output('attack-half', 'value') }),
    call('raw-damage', 'math.add', { left: output('damage-event', 'value'), right: output('attack-bonus', 'value') }),
    call('damage', 'math.max', { left: literal(0), right: output('raw-damage', 'value') }),
    call('status-time', 'identity.host-time'),
    call('status-time-text', 'text.from-number', { value: output('status-time', 'value') }),
    call('turn-number', 'turn.number'),
    call('status-id-prefix', 'text.concat', { left: literal('curse-ward-used-'), right: output('status-time-text', 'text') }),
    recordCreate('used-status-record', CURSE_STATUS_SCHEMA.id + '@' + CURSE_STATUS_SCHEMA.version, {
      id: output('status-id-prefix', 'text'), type: literal('curse-ward-used'), name: literal('诅咒结界已使用'),
      remainingDuration: literal(-1), currentDuration: literal(-1), expiresAtTurnEnd: output('turn-number', 'value'),
    }),
    call('apply-status', 'status.apply-record', { target: output('piece', 'piece'), record: output('used-status-record', 'value') }, { inputPolicy: 'host' }),
    call('enemy', 'content.enemy-player', { player: output('owner', 'player') }),
    call('enemy-present', 'query.has-player', { playerId: output('enemy', 'enemy') }),
    call('damage-text', 'text.from-number', { value: output('damage', 'value') }),
  )
  const enemyGuard = branch('enemy-guard', output('enemy-present', 'exists'), [], [])
  unusedBody.push(enemyGuard)
  const enemyBody = enemyGuard.then
  enemyBody.push(
    call('enemy-player', 'query.player', { playerId: output('enemy', 'enemy') }),
    call('card-time', 'identity.host-time'),
    call('card-time-text', 'text.from-number', { value: output('card-time', 'value') }),
    call('card-id-prefix', 'text.concat', { left: literal('rafaam-curse-'), right: output('card-time-text', 'text') }),
    call('card-name-prefix', 'text.concat', { left: literal('诅咒('), right: output('damage-text', 'text') }),
    call('card-name', 'text.concat', { left: output('card-name-prefix', 'text'), right: literal(')') }),
    call('description-prefix', 'text.concat', { left: literal('可消耗1点行动点弃置；若未弃置，回合结束时使1个随机友军受到'), right: output('damage-text', 'text') }),
    call('description', 'text.concat', { left: output('description-prefix', 'text'), right: literal('点伤害。') }),
    call('materialize', 'content.materialize-curse-template', {
      templateId: literal('rafaam-curse-sample'), cardId: output('card-id-prefix', 'text'), name: output('card-name', 'text'),
      description: output('description', 'text'), owner: output('enemy-player', 'player'), damageAmount: output('damage', 'value'), sourcePieceId: output('piece', 'piece'),
    }),
    call('add-card', 'card.hand-add-ref', { player: output('enemy-player', 'player'), cardId: output('materialize', 'cardId') }),
  )
  // The direct append and materialization happen before the blocked result,
  // exactly like addStatusEffectById then addCardToHand in the legacy rule.
  unusedBody.push(
    call('piece-name', 'attribute.text', { piece: output('piece', 'piece') }, { attribute: 'name' }),
    call('message-prefix', 'text.concat', { left: output('piece-name', 'text'), right: literal('的诅咒结界免疫伤害并交给对手1张记录') }),
    call('message', 'text.concat', { left: output('message-prefix', 'text'), right: output('damage-text', 'text') }),
    call('full-message', 'text.concat', { left: output('message', 'text'), right: literal('点伤害的诅咒') }),
    call('blocked', 'result.blocked', { message: output('full-message', 'text') }),
    returnResult('return-blocked', output('blocked', 'result')),
  )
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    outputs: [{ name: 'result', type: 'record', nullable: true }],
    schemas: [CURSE_STATUS_SCHEMA],
    body,
  }
}

/** The generated card is itself a normal semantic card graph.  The host
 * supplies the bound damage/source fields through the closed card modules. */
export function buildRafaamCurseCardGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('type', 'card.current-type'),
    call('template-card-id', 'card.current-id'),
    // Generated cards bind damageAmount even when its value is zero.  The
    // sample authoring card has no such field, so a negative fallback tests
    // binding presence instead of conflating a zero-value card with the sample.
    call('template-damage', 'content.card-number', { cardId: output('template-card-id', 'cardId') }, { field: 'damageAmount', fallback: -1 }),
    call('has-bound-damage', 'compare.greater-than', { left: output('template-damage', 'value'), right: literal(-1) }),
    call('is-end-turn', 'compare.equal-string', { left: output('type', 'type'), right: literal('endTurn') }),
  ]
  const typeBranch = branch('type-branch', output('is-end-turn', 'value'), [], [
    branch('generated-card-branch', output('has-bound-damage', 'value'), cardResult('discard', true, literal('弃置了诅咒')), cardResult('sample-discard', true, literal('诅咒卡（?）'))),
  ])
  body.push(typeBranch)
  const turn = typeBranch.then
  turn.push(
    call('owner', 'ref.player'),
    call('current-player', 'turn.current-player'),
    call('own-turn', 'compare.player-reference', { left: output('owner', 'player'), right: output('current-player', 'player') }),
  )
  const turnGuard = branch('turn-guard', output('own-turn', 'value'), [], cardResult('wrong-turn', false))
  turn.push(turnGuard)
  const active = turnGuard.then
  active.push(
    call('allies', 'query.pieces', { ownerId: output('owner', 'player') }, { includeDead: false }),
    call('ally-count', 'list.count-pieces', { items: output('allies', 'pieces') }),
    call('has-allies', 'compare.greater-than', { left: output('ally-count', 'value'), right: literal(0) }),
  )
  const allyGuard = branch('ally-guard', output('has-allies', 'value'), [], cardResult('no-allies', true, literal('诅咒结算时没有存活的友军目标')))
  active.push(allyGuard)
  const hasAllies = allyGuard.then
  hasAllies.push(
    call('target', 'query.random-item', { items: output('allies', 'pieces') }),
    call('target-name', 'attribute.text', { piece: output('target', 'item') }, { attribute: 'name' }),
    call('card-id', 'card.current-id'),
    call('damage', 'content.card-number', { cardId: output('card-id', 'cardId') }, { field: 'damageAmount', fallback: 0 }),
    call('damage-result', 'effect.card-damage', { cardId: output('card-id', 'cardId'), target: output('target', 'item'), amount: output('damage', 'value') }, { damageType: 'true', skillId: 'curse-end-turn' }),
    call('damage-text', 'text.from-number', { value: output('damage-result', 'damage') }),
    call('message-0', 'text.concat', { left: literal('诅咒对'), right: output('target-name', 'text') }),
    call('message-1', 'text.concat', { left: output('message-0', 'text'), right: literal('造成了') }),
    call('message-2', 'text.concat', { left: output('message-1', 'text'), right: output('damage-text', 'text') }),
    call('message', 'text.concat', { left: output('message-2', 'text'), right: literal('点伤害') }),
    ...cardResult('success', true, output('message', 'text'), true),
  )
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'card',
    outputs: [{ name: 'result', type: 'record', nullable: true }],
    schemas: [],
    body,
  }
}

type JsonRecord = Record<string, unknown>
const GENERATED_FIELDS = new Set(['skillCode', 'code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])

/**
 * Some production rules were already migrated by the compatibility content
 * graph compiler before the gameplay-module document was introduced.  Treat
 * that pair as a generated compatibility artifact only when its declared
 * graph recompiles to the stored executable byte-for-byte.  A stale marker or
 * edited executable must still fail the preflight rather than being silently
 * replaced by this migration.
 */
function assertLegacyContentGraphArtifact(current: JsonRecord, id: string, field: 'skillCode'): void {
  const graph = current.contentGraph
  const graphField = current.contentGraphField
  const compilerVersion = current.contentGraphCompilerVersion
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)
    || graphField !== field || compilerVersion !== CONTENT_GRAPH_COMPILER_VERSION
    || (graph as JsonRecord).version !== CONTENT_GRAPH_VERSION
    || (graph as JsonRecord).surface !== 'rule'
    || typeof current[field] !== 'string') {
    throw new Error(`${id}: invalid legacy content graph artifact`)
  }
  let compiled: string
  try {
    compiled = compileContentGraph(graph).code
  } catch (cause) {
    throw new Error(`${id}: invalid legacy content graph artifact`, { cause })
  }
  if (compiled !== current[field]) throw new Error(`${id}: legacy content graph executable differs from artifact`)
}

/** Migrate both rule documents as one preflight transaction. */
export function migrateSemanticRafaamCurse(root: string, write = false): string[] {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')) as { entries: Record<string, JsonRecord> }
  // Build and validate all next documents before the first write.  This keeps
  // a malformed second rule from leaving a partially migrated pair on disk.
  const ids = [RAFAAM_CURSE_END_TURN_RULE_ID, RAFAAM_CURSE_WARD_RULE_ID] as const
  const graphs = [buildRafaamCurseEndTurnGraph(), buildRafaamCurseWardGraph()] as const
  const pending = ids.map((id, index) => {
    const original = fixture.entries[`rules/${id}`]
    if (!original) throw new Error(`rules/${id}: missing frozen baseline`)
    const file = path.join(root, 'data/rules', `${id}.json`)
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonRecord
    if (current.gameplayModules && typeof current.gameplayModules === 'object') {
      assertGameplayModuleDocument(current)
      return { id, file, next: current }
    }
    // Compare only frozen compatibility fields.  Extra author metadata is
    // intentionally opaque and must survive the migration unchanged.
    for (const field of Object.keys(original)) {
      if (!GENERATED_FIELDS.has(field) && JSON.stringify(current[field]) !== JSON.stringify(original[field])) throw new Error(`${id}: changed compatibility field ${field}`)
    }
    if (current.contentGraph !== undefined || current.contentGraphField !== undefined || current.contentGraphCompilerVersion !== undefined) {
      assertLegacyContentGraphArtifact(current, id, 'skillCode')
    } else {
      assertFrozenExecutable(current, original, 'skillCode', 'rule', id)
    }
    const next = applyGameplayModuleGraph(current, graphs[index], 'skillCode')
    assertGameplayModuleDocument(next)
    return { id, file, next }
  })
  if (write) for (const item of pending) fs.writeFileSync(item.file, JSON.stringify(item.next, null, 2) + '\n')
  return pending.map(item => item.id)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(migrateSemanticRafaamCurse(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), process.argv.includes('--write'))))
}
