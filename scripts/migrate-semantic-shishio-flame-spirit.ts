import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSemanticPreviewGraph } from './migrate-semantic-previews'
import { assertFrozenExecutable } from './semantic-migration-source'
import {
  applyGameplayModuleGraph,
  assertGameplayModuleDocument,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayJsonValue,
  type GameplayModuleGraph,
  type GameplayStatement,
  type GameplayValue,
} from '../lib/skill-graph/module-document'

export const SHISHIO_FLAME_SPIRIT_SKILL_ID = 'shishio-flame-spirit' as const

const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
type MutableIfStatement = { kind: 'if'; id: string; condition: GameplayValue; then: GameplayStatement[]; else?: GameplayStatement[] }
const branch = (id: string, condition: GameplayValue, then: GameplayStatement[], otherwise: GameplayStatement[] = []): MutableIfStatement => ({ kind: 'if', id, condition, then, else: otherwise })
const returnValue = (id: string, value: GameplayValue): GameplayStatement => ({ kind: 'return', id, value })

const result = (id: string, success: boolean, message: GameplayValue): GameplayStatement[] => [
  call(`${id}-result`, 'result.action', { success: literal(success), message }),
  returnValue(`${id}-return`, output(`${id}-result`, 'result')),
]

function textConcat(statements: GameplayStatement[], id: string, left: GameplayValue, right: GameplayValue): GameplayValue {
  statements.push(call(id, 'text.concat', { left, right }))
  return output(id, 'text')
}

function messageWithPrefix(statements: GameplayStatement[], id: string, prefix: GameplayValue, suffix: GameplayValue): GameplayValue {
  return textConcat(statements, id, prefix, suffix)
}

export function buildShishioFlameSpiritGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    call('source-ref', 'ref.holder'),
    call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') }),
  ]
  const sourceBranch = branch('source-branch', output('source-present', 'exists'), [], result('missing-source', false, literal('施法者丢失')))
  body.push(sourceBranch)
  const active = sourceBranch.then

  active.push(
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('kills-status', 'status.find-id', { piece: output('source', 'piece') }, { statusType: 'shishio-kills' }),
    call('kills', 'status.read-number', { piece: output('source', 'piece'), statusId: output('kills-status', 'id'), fallback: literal(0) }, { field: 'intensity' }),
    call('kills-at-two', 'compare.greater-or-equal', { left: output('kills', 'value'), right: literal(2) }),
    call('kills-at-one', 'compare.greater-or-equal', { left: output('kills', 'value'), right: literal(1) }),
    call('one-multiplier', 'value.select-number', { condition: output('kills-at-one', 'value'), whenTrue: literal(1.5), whenFalse: literal(1) }),
    call('multiplier', 'value.select-number', { condition: output('kills-at-two', 'value'), whenTrue: literal(2), whenFalse: output('one-multiplier', 'value') }),
    call('attack', 'attribute.read', { piece: output('source', 'piece') }, { attribute: 'attack' }),
    call('damage-scaled', 'math.multiply', { left: output('attack', 'value'), right: output('multiplier', 'value') }),
    call('damage', 'math.floor', { value: output('damage-scaled', 'value') }),
    call('cells', 'spatial.cardinal-cells-ordered', { target: output('source', 'piece') }, { order: 'up-down-left-right' }),
    call('existing-records', 'extension.read-list', {}, { key: 'shishioBurnTiles' }),
    call('existing-cells', 'extension.records-to-cells', { records: output('existing-records', 'cells') }),
    {
      kind: 'collection', id: 'new-cells', method: 'filter', items: output('cells', 'cells'), item: 'cell',
      inputs: { existing: output('existing-cells', 'cells') },
      body: [
        call('already-present', 'spatial.cell-in-list', { cell: input('cell'), cells: input('existing') }),
        call('is-new', 'logic.not', { value: output('already-present', 'value') }),
        returnValue('new-cell', output('is-new', 'value')),
      ],
    },
    call('append', 'extension.append-cell-records-ordered', { source: output('source', 'piece'), cells: output('new-cells', 'value') }, { key: 'shishioBurnTiles' }),
    call('tile-batch', 'tile.batch-effect-markers', { cells: output('new-cells', 'value') }, { sourceId: 'shishio-burn', tileType: 'shishio-burn', icon: '♨️', iconPosition: 'bottom-right' }),
    call('source-owner', 'piece.owner', { piece: output('source', 'piece') }),
    call('move-rule', 'rule.apply-player', { target: output('source-owner', 'player') }, { ruleId: 'rule-shishio-burn-move' }),
    call('endturn-rule', 'rule.apply-player', { target: output('source-owner', 'player') }, { ruleId: 'rule-shishio-burn-endturn' }),
    call('all-records', 'extension.read-list', {}, { key: 'shishioBurnTiles' }),
    call('all-cells', 'extension.records-to-cells', { records: output('all-records', 'cells') }),
    call('total-burn', 'list.count-cells', { items: output('all-cells', 'cells') }),
    call('source-name', 'attribute.text', { piece: output('source', 'piece') }, { attribute: 'name' }),
    call('added-text', 'text.from-number', { value: output('append', 'added') }),
    call('total-text', 'text.from-number', { value: output('total-burn', 'value') }),
  )

  let prefix: GameplayValue = output('source-name', 'text')
  prefix = textConcat(active, 'message-prefix-0', prefix, literal(' 发动我流·炎灵！新增'))
  prefix = messageWithPrefix(active, 'message-prefix-1', prefix, output('added-text', 'text'))
  prefix = textConcat(active, 'message-prefix-2', prefix, literal(' 格永久燃烧（当前共 '))
  prefix = messageWithPrefix(active, 'message-prefix-3', prefix, output('total-text', 'text'))
  prefix = textConcat(active, 'message-prefix-4', prefix, literal(' 格）'))

  active.push(
    call('enemies', 'query.pieces', { originId: output('source', 'piece') }, { relation: 'enemy', range: 6, includeDead: false }),
    call('enemy-count', 'list.count-pieces', { items: output('enemies', 'pieces') }),
    call('has-enemy', 'compare.greater-than', { left: output('enemy-count', 'value'), right: literal(0) }),
  )
  const enemyBranch = branch('enemy-branch', output('has-enemy', 'value'), [], [])
  active.push(enemyBranch)

  const hit = enemyBranch.then
  hit.push(
    call('random-enemy', 'query.random-item', { items: output('enemies', 'pieces') }),
    // Capture the message target before the damage facade can remove it; the
    // old helper retained the target object for this same reason.
    call('saved-enemy', 'source.capture', { source: output('random-enemy', 'item') }),
    call('enemy-name', 'piece.captured-name', { source: output('saved-enemy', 'source') }, { fallback: 'none' }),
    call('deal', 'effect.damage-pieces-unattributed', { source: output('source', 'piece'), target: output('random-enemy', 'item'), amount: output('damage', 'value') }, { damageType: 'true' }),
    call('damage-text', 'text.from-number', { value: output('damage', 'value') }),
    call('multiplier-percent', 'math.multiply', { left: output('multiplier', 'value'), right: literal(100) }),
    call('multiplier-percent-floor', 'math.floor', { value: output('multiplier-percent', 'value') }),
    call('multiplier-text', 'text.from-number', { value: output('multiplier-percent-floor', 'value') }),
  )
  let hitSuffix: GameplayValue = literal('精神之火锁定 ')
  hitSuffix = textConcat(hit, 'hit-suffix-0', hitSuffix, output('enemy-name', 'value'))
  hitSuffix = textConcat(hit, 'hit-suffix-1', hitSuffix, literal('，造成 '))
  hitSuffix = textConcat(hit, 'hit-suffix-2', hitSuffix, output('damage-text', 'text'))
  hitSuffix = textConcat(hit, 'hit-suffix-3', hitSuffix, literal(' 点真实伤害（'))
  hitSuffix = textConcat(hit, 'hit-suffix-4', hitSuffix, output('multiplier-text', 'text'))
  hitSuffix = textConcat(hit, 'hit-suffix-5', hitSuffix, literal('%）'))
  const hitMessage = messageWithPrefix(hit, 'hit-message', prefix, textConcat(hit, 'hit-separator', literal('；'), hitSuffix))
  hit.push(...result('hit-success', true, hitMessage))

  const noHit = enemyBranch.else!
  const noHitMessage = messageWithPrefix(noHit, 'no-hit-message', prefix, literal('；6格内无敌人，精神之火未命中'))
  noHit.push(...result('no-hit-success', true, noHitMessage))

  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    outputs: [{ name: 'result', type: 'record', nullable: true }],
    schemas: [],
    body,
  }
}

type JsonRecord = Record<string, unknown>
const GENERATED_FIELDS = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])

export function migrateSemanticShishioFlameSpirit(root: string, write = false): string[] {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')) as { entries: Record<string, JsonRecord> }
  const original = fixture.entries[`skills/${SHISHIO_FLAME_SPIRIT_SKILL_ID}`]
  if (!original) throw new Error(`skills/${SHISHIO_FLAME_SPIRIT_SKILL_ID}: missing frozen baseline`)
  const file = path.join(root, 'data/skills', `${SHISHIO_FLAME_SPIRIT_SKILL_ID}.json`)
  const current = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonRecord

  // A previous migration may already have produced an author-owned module
  // document.  Validate that document and retain the author's graph and
  // metadata verbatim; rebuilding from this script would silently overwrite
  // an intentional graph edit.  A malformed document (including a tampered
  // generated source) must fail through the shared document validator.
  if (current.gameplayModules && typeof current.gameplayModules === 'object') {
    assertGameplayModuleDocument(current)
    return [`skills/${SHISHIO_FLAME_SPIRIT_SKILL_ID}`]
  }

  for (const field of new Set([...Object.keys(original), ...Object.keys(current)])) {
    if (!GENERATED_FIELDS.has(field) && JSON.stringify(current[field]) !== JSON.stringify(original[field])) throw new Error(`${SHISHIO_FLAME_SPIRIT_SKILL_ID}: changed compatibility field ${field}`)
  }

  // Only the frozen executable or a compiler artifact proven to originate
  // from that exact frozen source may be migrated.  This protects both the
  // active code and the preview code from an author edit being overwritten.
  assertFrozenExecutable(current, original, 'code', 'skill', SHISHIO_FLAME_SPIRIT_SKILL_ID)
  if (typeof original.previewCode === 'string') {
    assertFrozenExecutable(current, original, 'previewCode', 'preview', SHISHIO_FLAME_SPIRIT_SKILL_ID)
  }

  const graph = buildShishioFlameSpiritGraph()
  let next = applyGameplayModuleGraph(current, graph, 'code')
  if (typeof original.previewCode === 'string') next = applyGameplayModuleGraph(next, buildSemanticPreviewGraph(original.previewCode), 'previewCode')
  assertGameplayModuleDocument(next)
  if (write) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return [`skills/${SHISHIO_FLAME_SPIRIT_SKILL_ID}`]
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(migrateSemanticShishioFlameSpirit(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), process.argv.includes('--write'))))
}
