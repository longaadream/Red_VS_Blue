import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
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

export const LAMENT_SKILL_ID = 'muru-lament' as const
const HOLY_CARD_IDS = ['holy-smite', 'holy-heal', 'holy-charge'] as const

const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const call = (
  id: string,
  module: string,
  inputs: Record<string, GameplayValue> = {},
  parameters: Record<string, GameplayJsonValue> = {},
): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
type MutableIfStatement = Omit<Extract<GameplayStatement, { kind: 'if' }>, 'then' | 'else'> & {
  then: GameplayStatement[]
  else: GameplayStatement[]
}
const branch = (id: string, condition: GameplayValue, then: GameplayStatement[], otherwise: GameplayStatement[] = []): MutableIfStatement => ({ kind: 'if', id, condition, then, else: otherwise })
const returnResult = (id: string, value: GameplayValue): GameplayStatement => ({ kind: 'return', id, value })
const recordCreate = (id: string, schema: string, fields: Record<string, GameplayValue>): GameplayStatement => ({ kind: 'record.create', id, schema, fields })

const resultBranch = (id: string, success: boolean, message: GameplayValue): GameplayStatement[] => {
  const result = `${id}-result`
  return [call(result, 'result.action', { success: literal(success), message }), returnResult(`${id}-return`, output(result, 'result'))]
}

const SHIELD_SCHEMA: GameplayRecordSchema = {
  id: 'muru-divine-shield-status',
  version: '1',
  fields: [
    { name: 'id', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'type', type: 'string' },
    { name: 'currentDuration', type: 'number' },
    { name: 'currentUses', type: 'number' },
    { name: 'intensity', type: 'number' },
    { name: 'stacks', type: 'number' },
    { name: 'relatedRules', type: { kind: 'list', element: 'string' } },
  ],
}

function holyLabels(id: string, cards: GameplayValue, player: GameplayValue): GameplayStatement {
  const body: GameplayStatement[] = [
    call(`${id}-definition`, 'card.read-definition-id', { player: input('player'), card: input('card') }),
    call(`${id}-name`, 'card.read-definition-name', { player: input('player'), card: input('card') }),
    call(`${id}-name-text`, 'value.string-or-empty', { value: output(`${id}-name`, 'name') }),
    call(`${id}-has-name`, 'compare.not-equal-string', { left: output(`${id}-name-text`, 'text'), right: literal('') }),
    call(`${id}-label`, 'value.select-text', { condition: output(`${id}-has-name`, 'value'), whenTrue: output(`${id}-name-text`, 'text'), whenFalse: output(`${id}-definition`, 'cardId') }),
    { kind: 'return', id: `${id}-return`, value: output(`${id}-label`, 'text') },
  ]
  return { kind: 'collection', id, method: 'map', items: cards, item: 'card', inputs: { player }, body }
}

export function buildMuruLamentGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('caster-ref', 'ref.holder'),
    call('caster', 'query.piece', { pieceId: output('caster-ref', 'piece') }),
    call('owner-id', 'piece.owner', { piece: output('caster', 'piece') }),
    call('player-exists', 'query.has-player', { playerId: output('owner-id', 'player') }),
  ]
  const playerGuard = branch('player-guard', output('player-exists', 'exists'), [], resultBranch('missing-player', false, literal('未找到玩家')))
  body.push(playerGuard)
  const playerBody = playerGuard.then

  playerBody.push(
    call('owner', 'query.player', { playerId: output('owner-id', 'player') }),
    call('holy-cards', 'card.hand-instances-by-definition-ids', { player: output('owner', 'player') }, { cardIds: [...HOLY_CARD_IDS] }),
    call('holy-count', 'list.count', { items: output('holy-cards', 'cards') }),
    call('has-holy-cards', 'compare.greater-than', { left: output('holy-count', 'count'), right: literal(0) }),
  )
  const cardGuard = branch('card-guard', output('has-holy-cards', 'value'), [], resultBranch('no-holy-cards', false, literal('没有圣光手牌')))
  playerBody.push(cardGuard)
  const cardBody = cardGuard.then

  cardBody.push(
    holyLabels('labels', output('holy-cards', 'cards'), output('owner', 'player')),
    call('max-selections', 'math.min', { left: output('holy-count', 'count'), right: literal(4) }),
    call('choice', 'choice.hand-cards-bounded', {
      player: output('owner', 'player'), cards: output('holy-cards', 'cards'), labels: output('labels', 'value'), maxSelections: output('max-selections', 'value'),
    }, { title: '穆鲁的挽歌：选择要丢弃的圣光手牌', selectionMode: 'multi', minSelections: 1, canCancel: true }),
    call('choice-unresolved', 'choice.is-unresolved', { choice: output('choice', 'choice') }),
  )
  const pending = branch('pending-or-cancel', output('choice-unresolved', 'value'), [], [])
  cardBody.push(pending)
  pending.then.push(call('pending-result', 'choice.as-result', { choice: output('choice', 'choice') }), returnResult('return-pending', output('pending-result', 'result')))

  const completedChoice = pending.else!
  completedChoice.push(
    call('choice-is-array', 'choice.is-array', { choice: output('choice', 'choice') }),
  )
  const arrayGuard = branch('array-guard', output('choice-is-array', 'value'), [], resultBranch('invalid-choice', false, literal('穆鲁的挽歌选择无效')))
  completedChoice.push(arrayGuard)
  const arrayBody = arrayGuard.then

  arrayBody.push(
    call('selected-count', 'choice.array-length', { choice: output('choice', 'choice') }),
    call('too-few', 'compare.less-than', { left: output('selected-count', 'count'), right: literal(1) }),
    call('too-many', 'compare.greater-than', { left: output('selected-count', 'count'), right: literal(4) }),
    call('bad-count', 'logic.or', { left: output('too-few', 'value'), right: output('too-many', 'value') }),
  )
  const countGuard = branch('count-guard', output('bad-count', 'value'), [], [])
  arrayBody.push(countGuard)
  countGuard.then.push(...resultBranch('invalid-count', false, literal('穆鲁的挽歌选择无效')))

  const validCount = countGuard.else!
  validCount.push(
    call('raw-duplicate', 'choice.array-has-duplicate', { choice: output('choice', 'choice') }),
    call('raw-strict-values', 'choice.strict-string-list', { choice: output('choice', 'choice') }),
    call('raw-strict-list', 'choice.is-strict-string-list', { choice: output('choice', 'choice') }),
  )
  const rawDuplicateGuard = branch('raw-duplicate-guard', output('raw-duplicate', 'duplicate'), resultBranch('raw-duplicate-choice', false, literal('不能重复选择同一张手牌')), [])
  validCount.push(rawDuplicateGuard)
  const strictInput = rawDuplicateGuard.else!
  const strictGuard = branch('strict-guard', output('raw-strict-list', 'value'), [], resultBranch('stale-choice', false, literal('选择的圣光手牌已失效')))
  strictInput.push(strictGuard)
  const strictBody = strictGuard.then
  strictBody.push(
    call('duplicate', 'list.has-duplicate', { items: output('raw-strict-values', 'values') }),
  )
  const duplicateGuard = branch('duplicate-guard', output('duplicate', 'duplicate'), resultBranch('duplicate-choice', false, literal('不能重复选择同一张手牌')), [])
  strictBody.push(duplicateGuard)
  const uniqueBody = duplicateGuard.else!
  uniqueBody.push(
    call('selected-valid', 'collection.all-in-strings', { items: output('raw-strict-values', 'values'), allowed: output('holy-cards', 'cards') }),
  )
  const selectedGuard = branch('selected-guard', output('selected-valid', 'valid'), [], resultBranch('stale-selected-choice', false, literal('选择的圣光手牌已失效')))
  uniqueBody.push(selectedGuard)
  const selectedBody = selectedGuard.then

  selectedBody.push(
    { kind: 'foreach', id: 'discard-selected', items: output('raw-strict-values', 'values'), item: 'card', body: [
      call('discard', 'card.discard-instance', { card: output('discard-selected', 'item') }),
    ] },
    call('damage-total', 'local.counter-create', { initial: literal(0) }),
    call('heal-total', 'local.counter-create', { initial: literal(0) }),
    {
      kind: 'foreach', id: 'apply-per-card', items: output('raw-strict-values', 'values'), item: 'selected-card', body: [
        call('enemies', 'query.affectable-pieces-from-source', { owner: output('owner', 'player'), source: output('caster', 'piece') }, { relation: 'enemy' }),
        call('enemy-count', 'collection.piece-count', { pieces: output('enemies', 'pieces') }),
        call('has-enemies', 'compare.greater-than', { left: output('enemy-count', 'value'), right: literal(0) }),
        {
          kind: 'if', id: 'enemy-guard', condition: output('has-enemies', 'value'), then: [
            call('damage', 'effect.damage-many', { source: output('caster', 'piece'), targets: output('enemies', 'pieces'), amount: literal(2) }, { damageType: 'true', skillId: 'muru-lament' }),
            call('damage-value', 'effect.result-number', { result: output('damage', 'result') }, { field: 'totalDamage' }),
            call('damage-add', 'local.counter-add', { counter: output('damage-total', 'counter'), amount: output('damage-value', 'value') }),
          ], else: [],
        },
        call('allies', 'query.affectable-pieces-from-source', { owner: output('owner', 'player'), source: output('caster', 'piece') }, { relation: 'ally' }),
        call('ally-count', 'collection.piece-count', { pieces: output('allies', 'pieces') }),
        call('has-allies', 'compare.greater-than', { left: output('ally-count', 'value'), right: literal(0) }),
        {
          kind: 'if', id: 'ally-guard', condition: output('has-allies', 'value'), then: [
            call('heal', 'effect.heal-many', { source: output('caster', 'piece'), targets: output('allies', 'pieces'), amount: literal(2) }, { skillId: 'muru-lament' }),
            call('heal-value', 'effect.result-number', { result: output('heal', 'result') }, { field: 'totalHeal' }),
            call('heal-add', 'local.counter-add', { counter: output('heal-total', 'counter'), amount: output('heal-value', 'value') }),
          ], else: [],
        },
      ],
    },
    call('at-least-three', 'compare.greater-or-equal', { left: output('selected-count', 'count'), right: literal(3) }),
  )
  const shieldGuard = branch('shield-and-reset', output('at-least-three', 'value'), [], [])
  selectedBody.push(shieldGuard)
  const shieldBody = shieldGuard.then
  shieldBody.push(
    call('shield-allies', 'query.affectable-pieces-from-source', { owner: output('owner', 'player'), source: output('caster', 'piece') }, { relation: 'ally' }),
    {
      kind: 'foreach', id: 'apply-shields', items: output('shield-allies', 'pieces'), item: 'ally', body: [
        call('existing-shield', 'status.has-piece', { piece: output('apply-shields', 'item') }, { statusType: 'divine-shield' }),
        call('missing-shield', 'logic.not', { value: output('existing-shield', 'value') }),
        {
          kind: 'if', id: 'shield-guard', condition: output('missing-shield', 'value'), then: [
            recordCreate('shield-record', 'muru-divine-shield-status@1', {
              id: literal('divine-shield'), name: literal('圣盾'), type: literal('divine-shield'),
              currentDuration: literal(-1), currentUses: literal(-1), intensity: literal(1), stacks: literal(1),
              relatedRules: literal(['rule-divine-shield']),
            }),
            call('apply-shield', 'status.apply-record', { target: output('apply-shields', 'item'), record: output('shield-record', 'value') }, { inputPolicy: 'host' }),
            call('apply-shield-rule', 'rule.apply-piece', { target: output('apply-shields', 'item') }, { ruleId: 'rule-divine-shield' }),
          ], else: [],
        },
      ],
    },
    call('reset-extraction', 'skill.reset-cooldown', { piece: output('caster', 'piece'), skillId: literal('light-extraction') }),
  )

  // Keep the >=3 branch above as a normal conditional, then build the final
  // message after it so both branches share the same accumulated counters.
  selectedBody.push(
    call('damage-value-final', 'local.counter-read', { counter: output('damage-total', 'counter') }),
    call('heal-value-final', 'local.counter-read', { counter: output('heal-total', 'counter') }),
    call('caster-name', 'attribute.text', { piece: output('caster', 'piece') }, { attribute: 'name' }),
    call('count-text', 'text.from-number', { value: output('selected-count', 'count') }),
    call('damage-text', 'text.from-number', { value: output('damage-value-final', 'value') }),
    call('heal-text', 'text.from-number', { value: output('heal-value-final', 'value') }),
    call('message-0', 'text.concat', { left: output('caster-name', 'text'), right: literal('发动穆鲁的挽歌，丢弃') }),
    call('message-1', 'text.concat', { left: output('message-0', 'text'), right: output('count-text', 'text') }),
    call('message-2', 'text.concat', { left: output('message-1', 'text'), right: literal('张圣光手牌，造成') }),
    call('message-3', 'text.concat', { left: output('message-2', 'text'), right: output('damage-text', 'text') }),
    call('message-4', 'text.concat', { left: output('message-3', 'text'), right: literal('点伤害并恢复') }),
    call('message-5', 'text.concat', { left: output('message-4', 'text'), right: output('heal-text', 'text') }),
    call('message-6', 'text.concat', { left: output('message-5', 'text'), right: literal('点生命') }),
    call('success', 'result.action', { success: literal(true), message: output('message-6', 'text') }),
    returnResult('return-success', output('success', 'result')),
  )

  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    outputs: [{ name: 'result', type: 'record', nullable: true }],
    schemas: [SHIELD_SCHEMA],
    body,
  }
}

type JsonRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JsonRecord => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const GENERATED_FIELDS = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])

function assertLamentSource(current: JsonRecord, original: JsonRecord): void {
  // `assertFrozenExecutable` recognizes only the frozen source itself and
  // byte-identical compatibility compiler artifacts derived from that source.
  // Do not trust a caller supplied `contentGraph` marker as provenance: an
  // edited executable must fail the preflight even when its metadata looks
  // like an old graph artifact.
  assertFrozenExecutable(current, original, 'code', 'skill', LAMENT_SKILL_ID)
}

export function migrateSemanticLament(root: string, write = false): string[] {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')) as { entries: Record<string, JsonRecord> }
  const original = fixture.entries[`skills/${LAMENT_SKILL_ID}`]
  if (!original) throw new Error(`skills/${LAMENT_SKILL_ID}: missing frozen baseline`)
  const file = path.join(root, 'data/skills', `${LAMENT_SKILL_ID}.json`)
  const current = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonRecord
  for (const field of new Set([...Object.keys(original), ...Object.keys(current)])) {
    if (!GENERATED_FIELDS.has(field) && JSON.stringify(current[field]) !== JSON.stringify(original[field])) throw new Error(`${LAMENT_SKILL_ID}: changed compatibility field ${field}`)
  }
  const graph = buildMuruLamentGraph()
  const existing = isRecord(current.gameplayModules) && isRecord(current.gameplayModules.entries) ? current.gameplayModules.entries.code : undefined
  if (isRecord(existing)) {
    // A valid author graph is already the source of truth for this document.
    // Validate its generated fields, then retain the graph byte-for-byte even
    // when it is an intentionally different (but contract-valid) composition.
    assertGameplayModuleDocument(current)
    return [`skills/${LAMENT_SKILL_ID}`]
  }
  assertLamentSource(current, original)
  const next = applyGameplayModuleGraph(current, graph)
  assertGameplayModuleDocument(next)
  if (write) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return [`skills/${LAMENT_SKILL_ID}`]
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(migrateSemanticLament(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), process.argv.includes('--write'))))
}
