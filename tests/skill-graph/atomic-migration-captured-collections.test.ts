import { describe, expect, it } from 'vitest'
import { atomicCapturedCollectionRecipe } from '../../lib/skill-graph/atomic-migration-captured-collections'
import { rewriteAtomicGraph } from '../../lib/skill-graph/atomic-graph-rewrite'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { createExecutionLocalRuntime } from '../../lib/game/execution-local-runtime'
import type { GameplayModuleGraph, GameplayModuleDescriptor } from '../../lib/skill-graph/module-types'

const out = (node: string, port = 'value') => ({ kind: 'output' as const, node, port })
const fixture: GameplayModuleDescriptor = { id: 'fixture.pieces', version: '1', label: 'fixture', inputs: [], outputs: [{ name: 'value', type: { kind: 'list', element: 'piece' } }], allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: false }, lower: () => '({value:context.pieces})' }
const registry = { get: (id: string, version?: string) => id === fixture.id ? fixture : GAMEPLAY_MODULE_REGISTRY.get(id, version) }
function graph(damage = false): GameplayModuleGraph {
  return { version: 'rvb-gameplay-modules/v1', surface: 'skill', outputs: [{ name: 'value', type: damage ? 'record' : { kind: 'list', element: 'record' } }], body: [
    { kind: 'call', id: 'pieces', module: fixture.id, version: '1' },
    { kind: 'call', id: 'captured', module: 'source.capture-list', version: '1', inputs: { pieces: out('pieces') } },
    ...(damage ? [
      { kind: 'call' as const, id: 'first', module: 'collection.at', version: '1', inputs: { items: out('captured', 'sources'), position: { kind: 'literal' as const, value: 1 } } },
      { kind: 'call' as const, id: 'damage', module: 'effect.damage-captured-list', version: '1', inputs: { source: out('first'), targets: out('captured', 'sources'), amount: { kind: 'literal' as const, value: 3 } }, parameters: { damageType: 'true', skillId: 'test-batch' } },
    ] : []),
    { kind: 'return', id: 'return', value: out(damage ? 'damage' : 'captured', damage ? 'result' : 'sources') },
  ] }
}
function execute(value: GameplayModuleGraph, pieces: string[], skillId?: string) {
  const code = compileGameplayModuleGraph(value, registry).code
  const refs = new WeakMap<object, string>(), calls: unknown[][] = []
  const locals = createExecutionLocalRuntime(value => refs.has(value))
  const flow = {
    execution: locals,
    query: { hasPiece: () => true },
    effects: {
      captureSource: (id: string) => { const ref = Object.freeze({ scope: 'captured' }); refs.set(ref, id); return ref },
      capturedIdentifier: (ref: object) => { const id = refs.get(ref); if (!id) throw new Error('invalid source'); return id },
      damageManyCaptured: (source: object, targets: string[], amount: number, type: string, skillId: string) => { calls.push([refs.get(source), targets, amount, type, skillId]); return { results: targets.map(targetId => ({ targetId, damage: amount })) } },
      healManyCaptured: (source: object, targets: string[], amount: number, skillId: string) => { calls.push([refs.get(source), targets, amount, 'heal', skillId]); return { results: targets.map(targetId => ({ targetId, heal: amount })) } },
    },
  }
  const result = new Function('flow', 'context', `return (${code})(context)`)(flow, { pieces, ...(skillId === undefined ? {} : { skill: { id: skillId } }) })
  return { result: Array.isArray(result) ? result.map(ref => refs.get(ref)) : result, calls }
}

function batchGraph(kind: 'damage-many-captured' | 'heal-many-captured', parameters: Record<string, string> = {}): GameplayModuleGraph {
  return {
    version: 'rvb-gameplay-modules/v1', surface: 'skill',
    outputs: [{ name: 'value', type: 'record' }], body: [
      { kind: 'call', id: 'pieces', module: fixture.id, version: '1' },
      { kind: 'call', id: 'captured', module: 'source.capture-list', version: '1', inputs: { pieces: out('pieces') } },
      { kind: 'call', id: 'first', module: 'collection.at', version: '1', inputs: { items: out('captured', 'sources'), position: { kind: 'literal', value: 1 } } },
      { kind: 'call', id: 'batch', module: `effect.${kind}`, version: '1', inputs: { source: out('first'), targets: out('pieces'), amount: { kind: 'literal', value: 2 } }, parameters },
      { kind: 'return', id: 'return', value: out('batch', 'result') },
    ],
  }
}
describe('captured collection atomic migration', () => {
  it('preserves ordered duplicate handles and empty input without leaking host objects', () => {
    const original = graph(), migrated = rewriteAtomicGraph(original, atomicCapturedCollectionRecipe)
    for (const pieces of [[], ['one'], ['two', 'one', 'two']]) expect(execute(migrated, pieces)).toEqual(execute(original, pieces))
    expect(rewriteAtomicGraph(migrated, atomicCapturedCollectionRecipe)).toEqual(migrated)
  })
  it('keeps one authoritative batch and exact source, target order, amount and skill attribution', () => {
    const original = graph(true), migrated = rewriteAtomicGraph(original, atomicCapturedCollectionRecipe)
    const result = execute(migrated, ['one', 'two', 'one'])
    expect(result).toEqual(execute(original, ['one', 'two', 'one']))
    expect(result.calls).toEqual([['one', ['one', 'two', 'one'], 3, 'true', 'test-batch']])
  })
  it('moves captured damage and healing batches to the unified effect interface', () => {
    const damage = rewriteAtomicGraph(batchGraph('damage-many-captured', { damageType: 'magical' }), atomicCapturedCollectionRecipe)
    const heal = rewriteAtomicGraph(batchGraph('heal-many-captured'), atomicCapturedCollectionRecipe)
    expect(damage.body.some(statement => statement.kind === 'call' && statement.module === 'effect.damage-many-captured')).toBe(false)
    expect(heal.body.some(statement => statement.kind === 'call' && statement.module === 'effect.heal-many-captured')).toBe(false)
    expect(execute(damage, ['one', 'two'], 'current-skill')).toEqual({
      result: { results: [{ targetId: 'one', damage: 2 }, { targetId: 'two', damage: 2 }] },
      calls: [['one', ['one', 'two'], 2, 'magical', 'current-skill']],
    })
    expect(execute(heal, ['one', 'two'], 'current-skill')).toEqual({
      result: { results: [{ targetId: 'one', heal: 2 }, { targetId: 'two', heal: 2 }] },
      calls: [['one', ['one', 'two'], 2, 'heal', 'current-skill']],
    })
  })
})
