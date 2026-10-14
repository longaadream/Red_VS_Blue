import { describe, expect, it } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { rewriteAtomicGraph } from '../../lib/skill-graph/atomic-graph-rewrite'
import { atomicUniqueSummonRecipe } from '../../lib/skill-graph/atomic-migration-unique-summon'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph } from '../../lib/skill-graph/module-types'
import { makePiece, makeState } from '../helpers/minimal-state'

const graph: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'card', outputs: [{ name: 'value', type: 'boolean' }], body: [
  { kind: 'call', id: 'owner', module: 'ref.player', version: '1' },
  { kind: 'call', id: 'unique', module: 'summon.unique-template-available', version: '1', inputs: { owner: { kind: 'output', node: 'owner', port: 'player' } }, parameters: { templateId: 'unique-demon', storageExtensionKey: 'storedDemon', ownerScopedStorageExtensionKey: 'storedDemons' } },
  { kind: 'return', id: 'done', value: { kind: 'output', node: 'unique', port: 'available' } },
] }
function run(source: GameplayModuleGraph, pieces: ReturnType<typeof makePiece>[], extensions: Record<string, unknown>) {
  const battle = makeState({ pieces: structuredClone(pieces) }); battle.extensions = structuredClone(extensions)
  const before = structuredClone(battle), context = { playerId: 'player-red' }
  const flow = createFlowRuntime(battle, context, 'card', {})
  const code = compileGameplayModuleGraph(source, GAMEPLAY_MODULE_REGISTRY).code
  const value = new Function('flow', 'battle', 'return (' + code + ')')(flow, battle)(context)
  expect(battle).toEqual(before)
  return value
}
describe('unique summon policy is a storage and collection expression', () => {
  it.each([
    ['no existing summon', [], {}, true],
    ['living summon', [makePiece({ templateId: 'unique-demon' })], {}, false],
    ['dead summon', [makePiece({ templateId: 'unique-demon', currentHp: 0 })], {}, true],
    ['other owner', [makePiece({ templateId: 'unique-demon', ownerPlayerId: 'player-blue' })], {}, true],
    ['identifier match', [makePiece({ instanceId: 'unique-demon', templateId: 'other' })], {}, false],
    ['owner normalization', [makePiece({ templateId: 'unique-demon', ownerPlayerId: ' PLAYER-RED ' })], {}, false],
    ['scoped storage', [makePiece({ templateId: 'unique-demon' })], { storedDemons: { 'player-red': { instanceId: 'stored' } } }, true],
    ['legacy storage', [makePiece({ templateId: 'unique-demon' })], { storedDemon: { ownerPlayerId: ' PLAYER-RED ' } }, true],
    ['record key is content, not an output envelope', [makePiece({ templateId: 'unique-demon' })], { record: {}, storedDemon: { ownerPlayerId: 'player-red' } }, true],
    ['other legacy owner', [makePiece({ templateId: 'unique-demon' })], { storedDemon: { ownerPlayerId: 'player-blue' } }, false],
  ] as const)('%s', (_name, pieces, extensions, expected) => {
    const migrated = rewriteAtomicGraph(graph, atomicUniqueSummonRecipe)
    expect(run(migrated, [...pieces], extensions)).toBe(expected)
    expect(run(graph, [...pieces], extensions)).toBe(expected)
    expect(rewriteAtomicGraph(migrated, atomicUniqueSummonRecipe)).toEqual(migrated)
  })
})
