import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertFrozenExecutable } from './semantic-migration-source'
import {
  applyGameplayModuleGraph,
  assertGameplayModuleDocument,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayModuleGraph,
  type GameplayStatement,
  type GameplayValue,
} from '../lib/skill-graph/module-document'

const literal = (value: string | number | boolean | readonly (string | number | boolean)[]): GameplayValue => ({ kind: 'literal', value })
const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const call = (
  id: string,
  module: string,
  inputs: Record<string, GameplayValue> = {},
  parameters: Record<string, string | number | boolean> = {},
): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const buildResult = (body: GameplayStatement[], id: string, success: GameplayValue, message: GameplayValue): void => {
  const node = id + '-result'
  body.push(call(node, 'result.action', { success, message }), { kind: 'return', id, value: output(node, 'result') })
}
const buildRuleResult = (body: GameplayStatement[], id: string, success: GameplayValue, message: GameplayValue): void => {
  body.push({ kind: 'return', id, values: { success, message } })
}

const statusSchema = {
  id: 'lethal-toxin-status',
  version: '1',
  fields: [
    { name: 'id', type: 'string' as const },
    { name: 'type', type: 'string' as const },
    { name: 'name', type: 'string' as const },
    { name: 'currentDuration', type: 'number' as const },
    { name: 'intensity', type: 'number' as const },
    { name: 'value', type: 'number' as const },
    { name: 'extraValue', type: 'number' as const },
    { name: 'sourceId', type: 'string' as const },
  ],
}

export function buildToxinSkillGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  body.push(
    call('caster-ref', 'ref.holder'),
    call('caster', 'query.piece', { pieceId: output('caster-ref', 'piece') }),
    call('owner', 'piece.owner', { piece: output('caster', 'piece') }),
    call('target-choice', 'choice.target-cell', {}, { range: 5, filter: 'all' }),
    call('unresolved', 'choice.is-unresolved', { choice: output('target-choice', 'choice') }),
    {
      kind: 'if', id: 'wait-or-cancel', condition: output('unresolved', 'value'), then: [
        call('selection-result', 'choice.as-result', { choice: output('target-choice', 'choice') }),
        { kind: 'return', id: 'return-selection', value: output('selection-result', 'result') },
      ],
    },
    call('target', 'choice.cell', { choice: output('target-choice', 'choice') }),
    call('walkable', 'spatial.cell-walkable-safe', { cell: output('target', 'cell') }),
    call('not-walkable', 'logic.not', { value: output('walkable', 'value') }),
  )
  buildResult(body, 'return-not-walkable', literal(false), literal('目标位置不可行走'))
  // The result above must be guarded by the terrain branch.  Insert the guard
  // immediately before the result statements to preserve the legacy order.
  const notWalkableResult = body.splice(body.length - 2, 2)
  body.push({ kind: 'if', id: 'walkable-guard', condition: output('not-walkable', 'value'), then: notWalkableResult })
  body.push(
    call('unoccupied', 'spatial.cell-unoccupied', { cell: output('target', 'cell') }),
    call('occupied', 'logic.not', { value: output('unoccupied', 'value') }),
  )
  buildResult(body, 'return-occupied', literal(false), literal('目标位置已被占用'))
  const occupiedResult = body.splice(body.length - 2, 2)
  body.push({ kind: 'if', id: 'occupied-guard', condition: output('occupied', 'value'), then: occupiedResult })
  body.push(
    call('toxin-x', 'attribute.read', { piece: output('caster', 'piece') }, { attribute: 'x' }),
    call('toxin-y', 'attribute.read', { piece: output('caster', 'piece') }, { attribute: 'y' }),
    call('clock', 'identity.host-time'),
    call('clock-text', 'text.from-number', { value: output('clock', 'value') }),
    call('toxin-id', 'text.concat', { left: literal('lethal-toxin-'), right: output('clock-text', 'text') }),
    call('caster-id', 'piece.identifier', { piece: output('caster', 'piece') }),
    {
      kind: 'record.create', id: 'toxin-record', schema: 'lethal-toxin-status@1', fields: {
        id: output('toxin-id', 'text'),
        type: literal('lethal-toxin'),
        name: literal('致命毒素'),
        currentDuration: literal(-1),
        intensity: literal(4),
        value: output('toxin-x', 'value'),
        extraValue: output('toxin-y', 'value'),
        sourceId: output('caster-id', 'id'),
      },
    },
    call('apply-status', 'status.apply-player-record', { player: output('owner', 'player'), record: output('toxin-record', 'value') }),
    call('apply-rule', 'rule.apply-player', { target: output('owner', 'player') }, { ruleId: 'rule-blackwidow-toxin-player' }),
    call('add-marker', 'tile.add-source-effect', { id: output('toxin-id', 'text'), sourceId: output('toxin-id', 'text'), owner: output('owner', 'player'), cell: output('caster-cell', 'cell') }, { tileType: 'lethal-toxin' }),
  )
  // The legacy marker stores the caster's original location.  This small
  // record keeps that coordinate fixed before the movement submitter runs.
  body.splice(body.length - 1, 0, call('caster-cell', 'spatial.cell', { x: output('toxin-x', 'value'), y: output('toxin-y', 'value') }))
  body.push(
    call('move', 'effect.displace-one', { piece: output('caster', 'piece'), destination: output('target', 'cell') }, { kind: 'teleport' }),
    call('move-blocked', 'logic.not', { value: output('move', 'success') }),
  )
  buildResult(body, 'return-move-blocked', literal(true), literal('位移被阻挡，本次位移效果取消'))
  const blockedResult = body.splice(body.length - 2, 2)
  body.push({ kind: 'if', id: 'move-guard', condition: output('move-blocked', 'value'), then: blockedResult })
  body.push(
    call('caster-name', 'attribute.text', { piece: output('caster', 'piece') }, { attribute: 'name' }),
    // The target cell is a record; read its two coordinates through the stable
    // coordinate adapter instead of embedding a field path in the graph.
    call('target-coordinates', 'spatial.cell-coordinates', { cell: output('target', 'cell') }),
    call('target-x-text', 'text.from-number', { value: output('target-coordinates', 'x') }),
    call('target-y-text', 'text.from-number', { value: output('target-coordinates', 'y') }),
  )
  let message: GameplayValue = output('caster-name', 'text')
  const parts: GameplayValue[] = [literal('放置致命毒素并移动到('), output('target-x-text', 'text'), literal(','), output('target-y-text', 'text'), literal(')')]
  parts.forEach((part, index) => {
    const id = 'message-' + index
    body.push(call(id, 'text.concat', { left: message, right: part }))
    message = output(id, 'text')
  })
  buildResult(body, 'success', literal(true), message)
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    schemas: [statusSchema],
    outputs: [{ name: 'result', type: 'record', nullable: true }],
    body,
  }
}

export function buildToxinRuleGraph(): GameplayModuleGraph {
  const body: GameplayStatement[] = []
  const falseResult = (id: string): void => buildRuleResult(body, id, literal(false), literal(''))
  body.push(
    call('source-ref', 'ref.source'),
    call('source-present', 'query.has-piece', { pieceId: output('source-ref', 'piece') }),
  )
  falseResult('missing-source')
  const missingSource = body.splice(body.length - 1, 1)
  body.push({ kind: 'if', id: 'source-guard', condition: output('source-present', 'exists'), then: [], else: missingSource })
  body.push(
    call('source', 'query.piece', { pieceId: output('source-ref', 'piece') }),
    call('alive', 'piece.alive', { piece: output('source', 'piece') }),
  )
  falseResult('dead-source')
  const deadSource = body.splice(body.length - 1, 1)
  body.push({ kind: 'if', id: 'alive-guard', condition: output('alive', 'alive'), then: [], else: deadSource })
  body.push(
    call('source-owner', 'piece.owner', { piece: output('source', 'piece') }),
    call('rule-owner-ref', 'ref.player'),
    call('rule-owner', 'player.require', { player: output('rule-owner-ref', 'player') }),
    call('allied', 'compare.allied-players', { left: output('source-owner', 'player'), right: output('rule-owner', 'player') }),
  )
  falseResult('friendly-source')
  const friendlySource = body.splice(body.length - 1, 1)
  body.push({ kind: 'if', id: 'enemy-guard', condition: output('allied', 'value'), then: friendlySource })
  body.push(
    call('has-toxin', 'status.has-player', { player: output('rule-owner', 'player') }, { statusType: 'lethal-toxin' }),
    call('no-toxin', 'logic.not', { value: output('has-toxin', 'value') }),
  )
  body.push(call('remove-empty-rule', 'rule.remove-player', { target: output('rule-owner', 'player') }, { ruleId: 'rule-blackwidow-toxin-player' }))
  falseResult('return-no-toxin')
  const noToxin = body.splice(body.length - 2, 2)
  body.push({ kind: 'if', id: 'toxin-guard', condition: output('no-toxin', 'value'), then: noToxin })
  body.push(
    call('source-x', 'attribute.read', { piece: output('source', 'piece') }, { attribute: 'x' }),
    call('source-y', 'attribute.read', { piece: output('source', 'piece') }, { attribute: 'y' }),
    call('toxin-id', 'status.find-player-id-at', { player: output('rule-owner', 'player'), x: output('source-x', 'value'), y: output('source-y', 'value') }, { statusType: 'lethal-toxin' }),
    call('toxin-present', 'value.present-string', { value: output('toxin-id', 'id') }),
  )
  falseResult('no-matching-toxin')
  const noMatching = body.splice(body.length - 1, 1)
  body.push({ kind: 'if', id: 'matching-toxin-guard', condition: output('toxin-present', 'present'), then: [], else: noMatching })
  body.push(
    call('damage', 'status.read-player-number-truthy', { player: output('rule-owner', 'player'), statusId: output('toxin-id', 'id'), fallback: literal(4) }, { field: 'intensity' }),
    call('source-id', 'status.read-player-text-field', { player: output('rule-owner', 'player'), statusId: output('toxin-id', 'id') }, { field: 'sourceId' }),
    call('caster', 'query.piece-by-identifier', { pieceId: output('source-id', 'value') }),
    call('deal', 'effect.damage-with-player-fallback', { pieceSource: output('caster', 'piece'), playerSource: output('rule-owner', 'player'), target: output('source', 'piece'), amount: output('damage', 'value') }, { damageType: 'true', skillId: 'lethal-toxin', inputPolicy: 'host' }),
    call('remove-marker', 'tile.remove-source-effects', { sourceId: output('toxin-id', 'id') }, { tileType: 'lethal-toxin' }),
    call('remove-status', 'status.remove-player-id', { player: output('rule-owner', 'player'), statusId: output('toxin-id', 'id') }),
    call('has-more', 'status.has-player', { player: output('rule-owner', 'player') }, { statusType: 'lethal-toxin' }),
    call('no-more', 'logic.not', { value: output('has-more', 'value') }),
  )
  body.push({ kind: 'if', id: 'remove-empty-rule-after-hit', condition: output('no-more', 'value'), then: [call('remove-rule', 'rule.remove-player', { target: output('rule-owner', 'player') }, { ruleId: 'rule-blackwidow-toxin-player' })] })
  body.push(
    call('source-name', 'attribute.text', { piece: output('source', 'piece') }, { attribute: 'name' }),
    call('damage-text', 'text.from-number', { value: output('damage', 'value') }),
  )
  let message: GameplayValue = output('source-name', 'text')
  ;[literal('触发了致命毒素，受到'), output('damage-text', 'text'), literal('点真实伤害！')].forEach((part, index) => {
    const id = 'message-' + index
    body.push(call(id, 'text.concat', { left: message, right: part }))
    message = output(id, 'text')
  })
  buildRuleResult(body, 'success', literal(true), message)
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }],
    body,
  }
}

export function migrateSemanticToxin(root: string, write = false): string[] {
  const baselinePath = path.join(root, 'tests', 'game', 'fixtures', 'RED-252-legacy-content.json')
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).entries as Record<string, Record<string, unknown>>
  const targets = [
    { file: path.join(root, 'data', 'skills', 'blackwidow-lethal-toxin.json'), key: 'skills/blackwidow-lethal-toxin', field: 'code', graph: buildToxinSkillGraph() },
    { file: path.join(root, 'data', 'rules', 'rule-blackwidow-toxin-player.json'), key: 'rules/rule-blackwidow-toxin-player', field: 'skillCode', graph: buildToxinRuleGraph() },
  ] as const
  const generated = new Set(['code', 'skillCode', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules'])
  const pending: { file: string; next: Record<string, unknown>; key: string }[] = []
  for (const target of targets) {
    const current = JSON.parse(fs.readFileSync(target.file, 'utf8')) as Record<string, unknown>
    const original = baseline[target.key]
    if (!original) throw new Error(`${target.key}: missing frozen baseline`)
    for (const field of new Set([...Object.keys(current), ...Object.keys(original)])) {
      if (field !== 'cluster' && !generated.has(field) && JSON.stringify(current[field]) !== JSON.stringify(original[field])) throw new Error(`${target.key}: compatibility field changed before migration: ${field}`)
    }
    const existing = (current.gameplayModules as { entries?: Record<string, unknown> } | undefined)?.entries?.[target.field]
    if (existing) {
      const existingGraph = (existing as { graph?: unknown }).graph
      // Recompile entries owned by this migration when their typed graph is
      // unchanged. This keeps generated source synchronized with descriptor
      // lowerings while preserving independently edited graphs verbatim.
      if (JSON.stringify(existingGraph) === JSON.stringify(target.graph)) {
        pending.push({ file: target.file, key: target.key, next: applyGameplayModuleGraph(current, target.graph, target.field) })
      } else {
        assertGameplayModuleDocument(current)
      }
      continue
    }
    assertFrozenExecutable(current, original, target.field, target.field === 'code' ? 'skill' : 'rule', target.key)
    pending.push({ file: target.file, key: target.key, next: applyGameplayModuleGraph(current, target.graph, target.field) })
  }
  if (write) for (const item of pending) fs.writeFileSync(item.file, JSON.stringify(item.next, null, 2) + '\n')
  return pending.map(item => item.key)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(migrateSemanticToxin(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), process.argv.includes('--write'))))
}
