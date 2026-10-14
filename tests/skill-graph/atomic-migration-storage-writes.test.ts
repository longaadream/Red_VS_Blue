import { describe, expect, it } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { createGameplayModuleDiagnosticHost, installGameplayModuleDiagnosticHost } from '../../lib/game/gameplay-module-diagnostics'
import { rewriteAtomicGraph } from '../../lib/skill-graph/atomic-graph-rewrite'
import { atomicStorageWriteRecipe } from '../../lib/skill-graph/atomic-migration-storage-writes'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph } from '../../lib/skill-graph/module-types'
import { makePiece, makeState } from '../helpers/minimal-state'

const graph: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'result', type: 'boolean' }], body: [
  { kind: 'call', id: 'player', module: 'ref.player', version: '1' },
  { kind: 'call', id: 'set', module: 'extension.set-owner-if-empty', version: '1', inputs: { player: { kind: 'output', node: 'player', port: 'player' } }, parameters: { storageKey: 'amaterasuOwnerPlayerId' } },
  { kind: 'return', id: 'done', value: { kind: 'output', node: 'set', port: 'success' } },
] }
function run(source: GameplayModuleGraph, extensions: Record<string, unknown>, options: { playerId?: string; includePiece?: boolean } = {}) {
  const piece = options.includePiece === false ? undefined : makePiece({ instanceId: 'owner.with.dot' })
  const battle = makeState({ pieces: piece ? [piece] : [] }); battle.extensions = structuredClone(extensions)
  const context = { playerId: options.playerId ?? 'player-red', ...(piece ? { piece } : {}) }
  installGameplayModuleDiagnosticHost(context, createGameplayModuleDiagnosticHost('skill', {}, () => undefined))
  const flow = createFlowRuntime(battle, context, 'skill', {})
  const code = compileGameplayModuleGraph(source, GAMEPLAY_MODULE_REGISTRY).code
  return { result: new Function('flow', 'battle', 'return (' + code + ')')(flow, battle)(context), extensions: battle.extensions }
}

it('preserves an invalid player dependency instead of returning literal success', () => {
  const invalidPlayerGraph: GameplayModuleGraph = { ...graph, body: [
    graph.body[0],
    graph.body[1],
    { kind: 'return', id: 'dependent', value: { kind: 'output', node: 'set', port: 'success' } },
    { kind: 'return', id: 'independent', value: { kind: 'literal', value: false } },
  ] }
  const migrated = rewriteAtomicGraph(invalidPlayerGraph, atomicStorageWriteRecipe)
  expect(run(migrated, {}, { playerId: 'absent', includePiece: false })).toEqual({ result: false, extensions: {} })
})

describe('storage writes use ordinary declarations and branches', () => {
  it.each([false, true])('preserves explicit owner overwrite policy: %s', overwrite => {
    const source: GameplayModuleGraph = { ...graph, body: graph.body.map(node => node.kind === 'call' && node.id === 'set' ? { ...node, module: 'extension.set-owner', parameters: { ...node.parameters, overwrite } } : node) }
    const migrated = rewriteAtomicGraph(source, atomicStorageWriteRecipe)
    for (const initial of [{}, { amaterasuOwnerPlayerId: null }, { amaterasuOwnerPlayerId: 'player-blue' }]) {
      expect(run(migrated, initial)).toEqual(run(source, initial))
    }
    expect(rewriteAtomicGraph(migrated, atomicStorageWriteRecipe)).toEqual(migrated)
  })
  it.each([{}, { amaterasuOwnerPlayerId: null }, { amaterasuOwnerPlayerId: 'player-blue' }])('preserves assignment only on null or missing values: %j', extensions => {
    const migrated = rewriteAtomicGraph(graph, atomicStorageWriteRecipe)
    expect(run(migrated, extensions)).toEqual(run(graph, extensions))
    expect(rewriteAtomicGraph(migrated, atomicStorageWriteRecipe)).toEqual(migrated)
  })
  const owner = { kind: 'output', node: 'owner', port: 'piece' } as const
  const countdown: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'value', type: 'number' }], body: [
    { kind: 'call', id: 'owner', module: 'ref.holder', version: '1' },
    { kind: 'call', id: 'record', module: 'extension.read-owner-record', version: '1', inputs: { owner }, parameters: { key: 'coltZones' } },
    { kind: 'call', id: 'decrement', module: 'extension.decrement-turns', version: '1', inputs: { record: { kind: 'output', node: 'record', port: 'record' } } },
    { kind: 'return', id: 'done', value: { kind: 'output', node: 'decrement', port: 'value' } },
    { kind: 'return', id: 'independent', value: { kind: 'literal', value: 99 } },
  ] }
  it('decrements authoritative storage across invocations and preserves other records', () => {
    const migrated = rewriteAtomicGraph(countdown, atomicStorageWriteRecipe)
    const initial = { coltZones: { 'owner.with.dot': { turns: 2, sourceId: 'source' }, another: { turns: 8 } } }
    const first = run(migrated, initial)
    expect(first).toEqual(run(countdown, initial))
    expect(first.extensions?.coltZones['owner.with.dot'].turns).toBe(1)
    expect(run(migrated, first.extensions!).extensions?.coltZones['owner.with.dot'].turns).toBe(0)
    expect(rewriteAtomicGraph(migrated, atomicStorageWriteRecipe)).toEqual(migrated)
  })
  it('skips missing storage without creating it, while independent statements continue', () => {
    expect(run(rewriteAtomicGraph(countdown, atomicStorageWriteRecipe), {})).toEqual({ result: 99, extensions: {} })
  })
  it('removes exactly the selected owner key and keeps siblings', () => {
    const remove: GameplayModuleGraph = { ...countdown, outputs: [{ name: 'value', type: 'boolean' }], body: [countdown.body[0],
      { kind: 'call', id: 'remove', module: 'extension.remove-owner-record', version: '1', inputs: { owner }, parameters: { key: 'coltZones' } },
      { kind: 'return', id: 'done', value: { kind: 'output', node: 'remove', port: 'success' } },
    ] }
    const initial = { coltZones: { 'owner.with.dot': { turns: 1 }, other: { turns: 4 } } }
    expect(run(rewriteAtomicGraph(remove, atomicStorageWriteRecipe), initial)).toEqual(run(remove, initial))
  })
  it('returns false and does not write when the owner key is absent', () => {
    const remove: GameplayModuleGraph = { ...countdown, outputs: [{ name: 'value', type: 'boolean' }], body: [countdown.body[0],
      { kind: 'call', id: 'remove', module: 'extension.remove-owner-record', version: '1', inputs: { owner }, parameters: { key: 'coltZones' } },
      { kind: 'return', id: 'done', value: { kind: 'output', node: 'remove', port: 'success' } },
    ] }
    const initial = { coltZones: { other: { turns: 4 } } }
    expect(run(rewriteAtomicGraph(remove, atomicStorageWriteRecipe), initial)).toEqual({ result: false, extensions: initial })
  })

  it('keeps removal invalid when omit exceeds its copy budget and continues the independent tail', () => {
    const remove: GameplayModuleGraph = { ...countdown, outputs: [{ name: 'value', type: 'boolean' }], body: [countdown.body[0],
      { kind: 'call', id: 'remove', module: 'extension.remove-owner-record', version: '1', inputs: { owner }, parameters: { key: 'coltZones' } },
      { kind: 'return', id: 'done', value: { kind: 'output', node: 'remove', port: 'success' } },
      { kind: 'return', id: 'independent', value: { kind: 'literal', value: false } },
    ] }
    const initial = { coltZones: { 'owner.with.dot': { turns: 1 }, other: Array.from({ length: 10005 }, () => 0) } }
    expect(run(rewriteAtomicGraph(remove, atomicStorageWriteRecipe), initial)).toEqual({ result: false, extensions: initial })
  })
})
