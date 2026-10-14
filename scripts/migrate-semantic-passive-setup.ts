import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

export const PASSIVE_SETUP_SKILL_IDS = ['grant-lucky-coin', 'kiljaedan-demonic-pact'] as const
export type PassiveSetupSkillId = typeof PASSIVE_SETUP_SKILL_IDS[number]

const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const call = (
  id: string,
  module: string,
  inputs: Record<string, GameplayValue> = {},
  parameters: Record<string, GameplayJsonValue> = {},
): GameplayStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })
const action = (id: string, success: GameplayValue, message: GameplayValue): GameplayStatement => ({
  kind: 'return',
  id,
  values: { success, message },
})
const failure = (id: string, message: string): GameplayStatement => action(id, literal(false), literal(message))

function buildGrantLuckyCoinGraph(): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'triggerSkill',
    outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }],
    body: [
      call('context-player', 'ref.player-id-text'),
      call('resolved-player', 'query.player-case-insensitive', { playerId: output('context-player', 'text') }),
      call('context-error', 'compare.not-equal-string', {
        left: output('resolved-player', 'error'),
        right: literal(''),
      }),
      {
        kind: 'if',
        id: 'context-error-guard',
        condition: output('context-error', 'value'),
        then: [{
          kind: 'return',
          id: 'context-error-result',
          values: { success: literal(false), message: output('resolved-player', 'error') },
        }],
      },
      call('player-present', 'query.has-player', { playerId: output('resolved-player', 'player') }),
      call('missing-player', 'logic.not', { value: output('player-present', 'exists') }),
      {
        kind: 'if',
        id: 'player-guard',
        condition: output('missing-player', 'value'),
        then: [failure('player-not-found', 'Player not found')],
      },
      call('player', 'query.player', { playerId: output('resolved-player', 'player') }),
      call('add-card', 'card.hand-add-controlled', { player: output('player', 'player') }, { cardId: 'lucky-coin' }),
      call('card-error', 'compare.not-equal-string', {
        left: output('add-card', 'error'),
        right: literal(''),
      }),
      {
        kind: 'if',
        id: 'card-error-guard',
        condition: output('card-error', 'value'),
        then: [{
          kind: 'return',
          id: 'card-error-result',
          values: { success: literal(false), message: output('add-card', 'error') },
        }],
      },
      call('name', 'player.display-name', { player: output('player', 'player') }),
      call('message', 'text.concat', {
        left: output('name', 'text'),
        right: literal(' 获得了幸运币'),
      }),
      action('done', output('add-card', 'success'), output('message', 'text')),
    ],
  }
}

function buildDemonicPactGraph(): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'triggerSkill',
    outputs: [{ name: 'success', type: 'boolean' }, { name: 'message', type: 'string' }],
    body: [
      call('holder-ref', 'ref.holder'),
      call('holder-present', 'query.has-piece', { pieceId: output('holder-ref', 'piece') }),
      call('missing-holder', 'logic.not', { value: output('holder-present', 'exists') }),
      {
        kind: 'if',
        id: 'holder-guard',
        condition: output('missing-holder', 'value'),
        then: [failure('holder-missing', '')],
      },
      call('holder', 'query.piece', { pieceId: output('holder-ref', 'piece') }),
      call('owner', 'piece.owner-id-text', { piece: output('holder', 'piece') }),
      call('snapshot', 'piece.snapshot-serializable', { piece: output('holder', 'piece') }, { policy: 'strip-rule-effects' }),
      call('detached', 'piece.detach-active', { piece: output('holder', 'piece') }, { flowStatePolicy: 'preserve' }),
      call('detach-failed', 'logic.not', { value: output('detached', 'success') }),
      {
        kind: 'if',
        id: 'detach-guard',
        condition: output('detach-failed', 'value'),
        then: [failure('detach-missing', '')],
      },
      call('store', 'extension.store-piece', {
        owner: output('owner', 'playerId'),
        piece: output('snapshot', 'record'),
      }, {
        storageKey: 'kiljaedanPiece',
        ownerScopedStorageKey: 'kiljaedanPiecesByPlayerId',
      }),
      call('store-failed', 'logic.not', { value: output('store', 'success') }),
      {
        kind: 'if',
        id: 'store-guard',
        condition: output('store-failed', 'value'),
        then: [failure('store-rejected', '基尔加丹缺少所属玩家')],
      },
      call('add-card', 'card.hand-add-player-id-text', { playerId: output('owner', 'playerId') }, { cardId: 'demon-summon-1' }),
      action('done', literal(true), literal('基尔加丹隐匿于虚空之中，等待召唤...')),
    ],
  }
}

export function buildPassiveSetupGraph(id: PassiveSetupSkillId): GameplayModuleGraph {
  if (id === 'grant-lucky-coin') return buildGrantLuckyCoinGraph()
  if (id === 'kiljaedan-demonic-pact') return buildDemonicPactGraph()
  throw new Error(`Unknown passive setup skill: ${id}`)
}

export function migratePassiveSetupSkills(root: string, write = false): string[] {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'game', 'fixtures', 'RED-252-legacy-content.json'), 'utf8')).entries as Record<string, Record<string, unknown>>
  const ignored = new Set(['code', 'previewCode', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries', 'gameplayModules', 'cluster'])
  const pending: Array<{ file: string; next: Record<string, unknown> }> = []
  for (const id of PASSIVE_SETUP_SKILL_IDS) {
    const file = path.join(root, 'data', 'skills', id + '.json')
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    if ((current.gameplayModules as Record<string, unknown> | undefined)?.entries) {
      // Module-owned documents are authoritative after their one-time
      // migration. Validate the persisted graph/code pair, then leave valid
      // author edits untouched; a mismatch must fail closed instead of being
      // silently repaired from the migration recipe.
      assertGameplayModuleDocument(current)
      continue
    }
    const graph = buildPassiveSetupGraph(id)
    const original = baseline['skills/' + id]
    if (!original) throw new Error(`Missing frozen fixture for ${id}`)
    assertFrozenExecutable(current, original, 'code', graph.surface, id)
    for (const key of new Set([...Object.keys(original), ...Object.keys(current)])) {
      if (!ignored.has(key) && JSON.stringify(original[key]) !== JSON.stringify(current[key])) throw new Error(`${id}: changed compatibility field ${key}`)
    }
    pending.push({ file, next: applyGameplayModuleGraph(current, graph) })
  }
  if (write) for (const item of pending) fs.writeFileSync(item.file, JSON.stringify(item.next, null, 2) + '\n')
  return pending.map(item => path.basename(item.file, '.json'))
}

function cli(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const args = process.argv.slice(2), write = args.includes('--write')
  const selected = args.filter(value => value !== '--write') as PassiveSetupSkillId[]
  if (selected.some(id => !PASSIVE_SETUP_SKILL_IDS.includes(id))) throw new Error(`Unknown passive setup skill: ${selected.join(', ')}`)
  console.log(JSON.stringify(migratePassiveSetupSkills(root, write)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) cli()
