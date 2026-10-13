import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayJsonValue, type GameplayModuleGraph, type GameplayPort, type GameplayStatement, type GameplayValue } from '../lib/skill-graph/module-document'
const l = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const o = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const c = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, GameplayJsonValue> = {}): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const fail = (id: string, message = ''): GameplayStatement => ({ kind: 'return', id, values: { success: l(false), message: l(message) } })
const success = (id: string, message?: GameplayValue, replacement?: GameplayValue): GameplayStatement => ({
  kind: 'return', id,
  values: {
    success: l(true),
    ...(message === undefined ? {} : { message }),
    ...(replacement === undefined ? {} : { targetReplacementPieceId: replacement }),
  },
})
const guard = (body: GameplayStatement[], id: string, condition: GameplayValue, message = ''): void => {
  body.push(c(`${id}-not`, 'logic.not', { value: condition }), { kind: 'if', id, condition: o(`${id}-not`, 'value'), then: [fail(`${id}-return`, message)] })
}
export function buildKyokaGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    c('holder', 'ref.holder'), c('source', 'query.piece', { pieceId: o('holder', 'piece') }),
    c('choice', 'choice.target-piece', {}, { range: 4, filter: 'ally' }), c('unresolved', 'choice.is-unresolved', { choice: o('choice', 'choice') }),
    { kind: 'if', id: 'selection-check', condition: o('unresolved'), then: [c('pending', 'choice.as-result', { choice: o('choice', 'choice') }), { kind: 'return', id: 'waiting', value: o('pending', 'result') }] },
    c('target', 'choice.piece', { choice: o('choice', 'choice') }),
    c('remove-active', 'status.remove-type-raw', { piece: o('source', 'piece') }, { statusType: 'aizen-kyoka-active' }),
    c('remove-secret', 'status.remove-type-raw', { piece: o('source', 'piece') }, { statusType: 'aizen-kyoka-secret' }),
    c('owner', 'piece.owner', { piece: o('source', 'piece') }), c('opponent', 'content.enemy-player', { player: o('owner', 'player') }),
    c('has-opponent', 'query.has-player', { playerId: o('opponent', 'enemy') }),
    c('id', 'piece.identifier', { piece: o('source', 'piece') }), c('target-id', 'piece.identifier', { piece: o('target', 'piece') }),
    c('active-id', 'text.concat', { left: l('aizen-kyoka-active-'), right: o('id', 'id') }),
    c('secret-id', 'text.concat', { left: l('aizen-kyoka-secret-'), right: o('id', 'id') }),
    { kind: 'record.create', id: 'active', schema: 'kyoka-status@1', fields: {
      id: o('active-id', 'text'), type: l('aizen-kyoka-active'), name: l('镜花水月'), visible: l(false), currentUses: l(1), stacks: l(1),
    } },
    c('apply-active', 'status.apply-record', { target: o('source', 'piece'), record: o('active') }, { inputPolicy: 'host' }),
    { kind: 'record.create', id: 'secret', schema: 'kyoka-status@1', fields: {
      id: o('secret-id', 'text'), type: l('aizen-kyoka-secret'), name: l('镜花水月·秘密目标'), visible: l(false), currentUses: l(1), stacks: l(1), targetPieceId: o('target-id', 'id'),
    } },
    { kind: 'if', id: 'opponent-check', condition: o('has-opponent', 'exists'), then: [
      { kind: 'record.with', id: 'secret-opponent', record: o('secret'), fields: { opponentPlayerId: o('opponent', 'enemy') } },
      c('apply-secret-opponent', 'status.apply-record', { target: o('source', 'piece'), record: o('secret-opponent') }, { inputPolicy: 'host' }),
    ], else: [c('apply-secret', 'status.apply-record', { target: o('source', 'piece'), record: o('secret') }, { inputPolicy: 'host' })] },
    c('name', 'attribute.text', { piece: o('source', 'piece') }, { attribute: 'name' }),
    c('message', 'text.concat', { left: o('name', 'text'), right: l('发动镜花水月') }),
    c('result', 'result.action', { success: l(true), message: o('message', 'text') }), { kind: 'return', id: 'done', value: o('result', 'result') },
  ]
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', schemas: [{ id: 'kyoka-status', version: '1', fields: [
    { name: 'id', type: 'string' }, { name: 'type', type: 'string' }, { name: 'name', type: 'string' },
    { name: 'visible', type: 'boolean' }, { name: 'currentUses', type: 'number' }, { name: 'stacks', type: 'number' },
    { name: 'targetPieceId', type: 'string', optional: true }, { name: 'opponentPlayerId', type: 'player', nullable: true, optional: true },
  ] }], outputs: [{ name: 'result', type: 'record', nullable: true }], body }
}

const KYOKA_REWRITE_OUTPUTS: readonly GameplayPort[] = [
  { name: 'success', type: 'boolean' as const, optional: true },
  { name: 'message', type: 'string' as const, optional: true },
  { name: 'targetReplacementPieceId', type: 'string' as const, optional: true },
  { name: 'needsTargetSelection', type: 'boolean', optional: true }, { name: 'playerId', type: 'player', optional: true },
  { name: 'title', type: 'string', optional: true }, { name: 'targetType', type: 'string', optional: true }, { name: 'filter', type: 'string', optional: true },
  { name: 'targetCandidates', type: { kind: 'list', element: 'choice' }, optional: true }, { name: 'selectionMode', type: 'string', optional: true },
  { name: 'minSelections', type: 'number', optional: true }, { name: 'maxSelections', type: 'number', optional: true },
  { name: 'canCancel', type: 'boolean', optional: true }, { name: 'resumeOnCancel', type: 'boolean', optional: true },
]

function buildKyokaRewriteResolution(prefix: string): GameplayStatement[] {
  const body: GameplayStatement[] = [
    c(`${prefix}-replacement`, 'choice.first-piece-reference', { items: o('selected-targets', 'targets') }),
    c(`${prefix}-replacement-present`, 'query.has-piece', { pieceId: o(`${prefix}-replacement`, 'piece') }),
    { kind: 'if', id: `${prefix}-missing-check`, condition: o(`${prefix}-replacement-present`, 'exists'), then: [], else: [fail(`${prefix}-missing`, '镜花水月的替代目标已失效')] },
    c(`${prefix}-replacement-ref`, 'query.piece', { pieceId: o(`${prefix}-replacement`, 'piece') }),
    c(`${prefix}-candidates-raw`, 'query.pieces', { originId: o('aizen', 'piece') }, { relation: 'enemy', range: 3, includeDead: false }),
    c(`${prefix}-candidates`, 'list.sort-pieces', { items: o(`${prefix}-candidates-raw`, 'pieces') }),
    c(`${prefix}-valid-replacement`, 'collection.contains-piece', { items: o(`${prefix}-candidates`, 'sorted'), value: o(`${prefix}-replacement-ref`, 'piece') }),
  ]
  guard(body, `${prefix}-replacement-check`, o(`${prefix}-valid-replacement`, 'contains'), '镜花水月的替代目标已失效')
  body.push(
    c(`${prefix}-remove-active`, 'status.remove-type-raw', { piece: o('aizen', 'piece') }, { statusType: 'aizen-kyoka-active' }),
    c(`${prefix}-remove-secret`, 'status.remove-type-raw', { piece: o('aizen', 'piece') }, { statusType: 'aizen-kyoka-secret' }),
    c(`${prefix}-aizen-name`, 'attribute.text', { piece: o('aizen', 'piece') }, { attribute: 'name' }),
    c(`${prefix}-message`, 'text.concat', { left: o(`${prefix}-aizen-name`, 'text'), right: l('发动镜花水月，改写了技能目标') }),
    c(`${prefix}-replacement-id`, 'piece.identifier', { piece: o(`${prefix}-replacement-ref`, 'piece') }),
    success(`${prefix}-resolved`, o(`${prefix}-message`, 'text'), o(`${prefix}-replacement-id`, 'id')),
  )
  return body
}

/** Build the beforeSkillUse rule as a graph with an explicit pending choice. */
export function buildKyokaRewriteGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    c('holder-ref', 'ref.holder'),
    c('holder-exists', 'query.has-piece', { pieceId: o('holder-ref', 'piece') }),
  ]
  guard(body, 'holder-check', o('holder-exists', 'exists'))
  body.push(
    c('aizen', 'query.piece', { pieceId: o('holder-ref', 'piece') }),
    c('aizen-alive', 'piece.alive', { piece: o('aizen', 'piece') }),
  )
  guard(body, 'aizen-alive-check', o('aizen-alive', 'alive'))
  body.push(
    c('source-ref', 'ref.source'),
    c('source-exists', 'query.has-piece', { pieceId: o('source-ref', 'piece') }),
  )
  guard(body, 'source-check', o('source-exists', 'exists'))
  body.push(
    c('source', 'query.piece', { pieceId: o('source-ref', 'piece') }),
    c('aizen-owner-check', 'piece.owner', { piece: o('aizen', 'piece') }),
    c('source-owner-check', 'piece.owner', { piece: o('source', 'piece') }),
    c('source-allied', 'compare.allied-players', { left: o('source-owner-check', 'player'), right: o('aizen-owner-check', 'player') }),
    c('source-is-enemy', 'logic.not', { value: o('source-allied', 'value') }),
  )
  guard(body, 'source-enemy-check', o('source-is-enemy', 'value'))
  body.push(
    c('secret-id', 'status.find-id', { piece: o('aizen', 'piece') }, { statusType: 'aizen-kyoka-secret' }),
    c('secret-present', 'value.present-string', { value: o('secret-id', 'id') }),
  )
  guard(body, 'secret-check', o('secret-present', 'present'))
  body.push(
    c('source-owner', 'piece.owner', { piece: o('source', 'piece') }),
    c('opponent', 'followup.status-player-field', { piece: o('aizen', 'piece'), statusId: o('secret-id', 'id') }, { field: 'opponentPlayerId' }),
    c('same-opponent', 'compare.player-reference', { left: o('source-owner', 'player'), right: o('opponent', 'player') }),
  )
  guard(body, 'opponent-check', o('same-opponent', 'value'))
  body.push(c('cancelled', 'event.cancelled'))
  body.push({ kind: 'if', id: 'cancel-check', condition: o('cancelled', 'value'), then: [fail('cancel-check-return')] })
  const answerBranch = buildKyokaRewriteResolution('answer')
  const initialBranch: GameplayStatement[] = [
    c('single-target', 'event.single-piece-target-action'),
    c('original', 'ref.target'),
    c('secret-target', 'status.read-piece-reference', { piece: o('aizen', 'piece'), statusId: o('secret-id', 'id') }, { field: 'targetPieceId' }),
    c('original-matches', 'compare.equal-piece-nullable', { left: o('original', 'piece'), right: o('secret-target', 'reference') }),
    c('candidates-raw', 'query.pieces', { originId: o('aizen', 'piece') }, { relation: 'enemy', range: 3, includeDead: false }),
    c('candidates', 'list.sort-pieces', { items: o('candidates-raw', 'pieces') }),
    c('candidate-count', 'list.count-pieces', { items: o('candidates', 'sorted') }),
    c('has-candidates', 'compare.greater-than', { left: o('candidate-count', 'value'), right: l(0) }),
  ]
  guard(initialBranch, 'single-target-check', o('single-target', 'value'))
  guard(initialBranch, 'original-check', o('original-matches', 'value'))
  guard(initialBranch, 'candidate-check', o('has-candidates', 'value'))
  initialBranch.push(
    c('candidate-choices', 'choice.from-pieces', { pieces: o('candidates', 'sorted') }),
    c('aizen-owner', 'piece.owner', { piece: o('aizen', 'piece') }),
    c('player', 'player.require', { player: o('aizen-owner', 'player') }),
    { kind: 'return', id: 'replacement-choice', values: {
      success: l(false), needsTargetSelection: l(true), playerId: o('player', 'player'), title: l('镜花水月：选择替代目标'),
      targetType: l('piece'), filter: l('enemy'), targetCandidates: o('candidate-choices', 'choices'), selectionMode: l('single'),
      minSelections: l(1), maxSelections: l(1), canCancel: l(true), resumeOnCancel: l(true),
    } },
  )
  body.push(
    c('selected-targets', 'event.selected-targets'),
    c('selected-count', 'list.count-choices', { items: o('selected-targets', 'targets') }),
    c('has-selected', 'compare.greater-than', { left: o('selected-count', 'value'), right: l(0) }),
    { kind: 'if', id: 'selected-answer-branch', condition: o('has-selected', 'value'), then: answerBranch, else: initialBranch },
  )
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    outputs: KYOKA_REWRITE_OUTPUTS,
    body,
    layout: { trigger: { type: 'beforeSkillUse' } },
  }
}

const GENERATED_KEYS = new Set(['code', 'skillCode', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])

function assertCompatibility(current: Record<string, unknown>, original: Record<string, unknown>, id: string): void {
  for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) {
    if (!GENERATED_KEYS.has(key) && JSON.stringify(current[key]) !== JSON.stringify(original[key])) throw new Error(`${id}: changed compatibility field ${key}`)
  }
}

function moduleOwned(current: Record<string, unknown>, field: string): boolean {
  const modules = current.gameplayModules
  if (!modules || typeof modules !== 'object' || Array.isArray(modules)) return false
  const entries = (modules as Record<string, unknown>).entries
  return Boolean(entries && typeof entries === 'object' && !Array.isArray(entries) && (entries as Record<string, unknown>)[field])
}

export function migrateKyoka(root: string, write = false): void {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/game/fixtures/RED-252-legacy-content.json'), 'utf8')).entries as Record<string, Record<string, unknown>>
  const pending: Array<{ file: string; document: Record<string, unknown> }> = []
  const targets: Array<{ id: string; file: string; field: string; graph: GameplayModuleGraph; surface: 'skill' | 'rule' }> = [
    { id: 'aizen-kyoka-suiguetsu', file: path.join(root, 'data/skills/aizen-kyoka-suiguetsu.json'), field: 'code', graph: buildKyokaGraph(), surface: 'skill' },
    { id: 'rule-aizen-kyoka-rewrite', file: path.join(root, 'data/rules/rule-aizen-kyoka-rewrite.json'), field: 'skillCode', graph: buildKyokaRewriteGraph(), surface: 'rule' },
  ]
  for (const target of targets) {
    const current = JSON.parse(fs.readFileSync(target.file, 'utf8')) as Record<string, unknown>
    if (moduleOwned(current, target.field)) {
      assertGameplayModuleDocument(current)
      continue
    }
    const original = fixture[`${target.surface === 'skill' ? 'skills' : 'rules'}/${target.id}`]
    if (!original) throw new Error(`missing frozen fixture ${target.surface}/${target.id}`)
    assertFrozenExecutable(current, original, target.field, target.surface, target.id)
    const next = applyGameplayModuleGraph(current, target.graph, target.field)
    assertCompatibility(next, original, target.id)
    assertGameplayModuleDocument(next)
    pending.push({ file: target.file, document: next })
  }
  if (write) for (const item of pending) fs.writeFileSync(item.file, JSON.stringify(item.document, null, 2) + '\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) migrateKyoka(process.cwd(), process.argv.includes('--write'))
