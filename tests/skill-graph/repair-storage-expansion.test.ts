import { describe, expect, it } from 'vitest'
import { repairStorageExpansion } from '../../lib/skill-graph/repair-storage-expansion'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph } from '../../lib/skill-graph/module-types'

const output = (node: string, port = 'value') => ({ kind: 'output' as const, node, port })
function removal(committed: boolean): GameplayModuleGraph {
  const parameters = { namespace: '', name: 'coltZones', valueType: 'record' }
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body: [
    { kind: 'call', id: 'remove--owner-key', module: 'text.from-value', version: '1', inputs: { value: { kind: 'input', name: 'owner' } }, parameters: { valueType: 'piece' } },
    { kind: 'call', id: 'remove--owner-path', module: 'collection.singleton', version: '1', inputs: { value: output('remove--owner-key', 'text') }, parameters: { valueType: 'string' } },
    { kind: 'call', id: 'remove--records', module: 'extension.read-battle', version: '2', parameters },
    { kind: 'call', id: 'remove--remaining-records', module: 'data.omit-key', version: '1', inputs: { record: output('remove--records'), key: output('remove--owner-key', 'text') } },
    { kind: 'call', id: 'remove', module: 'extension.write-battle', version: '2', inputs: { value: output('remove--remaining-records') }, parameters },
    ...(committed ? [{ kind: 'call' as const, id: 'remove--committed', module: 'value.to-boolean', version: '1', inputs: { value: output('remove') }, parameters: { valueType: 'record' } }] : []),
    { kind: 'return', id: 'tail', value: committed ? output('remove--committed') : { kind: 'literal', value: false } },
  ] }
}

const original: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body: [
  { kind: 'call', id: 'set--owner', module: 'extension.declare-battle', version: '2', parameters: { namespace: '', name: 'amaterasuOwnerPlayerId', valueType: JSON.stringify({ kind: 'nullable', value: 'player' }) }, inputs: { value: { kind: 'literal', value: null } } },
  { kind: 'call', id: 'set--empty', module: 'compare.values', version: '1', inputs: { left: { kind: 'output', node: 'set--owner', port: 'value' }, right: { kind: 'literal', value: null } }, parameters: { valueType: JSON.stringify({ kind: 'nullable', value: 'player' }), operator: '==' } },
  { kind: 'if', id: 'set--assign-if-empty', condition: { kind: 'output', node: 'set--empty', port: 'value' }, then: [{ kind: 'call', id: 'set--write-owner', module: 'extension.write-battle', version: '2', inputs: { value: { kind: 'input', name: 'owner' } }, parameters: { namespace: '', name: 'amaterasuOwnerPlayerId', valueType: JSON.stringify({ kind: 'nullable', value: 'player' }) } }] },
  { kind: 'return', id: 'independent', value: { kind: 'literal', value: true } },
] }
describe('repair of the first generated storage expansion', () => {
  it('replaces the known block while preserving independent statements', () => {
    const repaired = repairStorageExpansion(original)
    expect(repaired.body).toEqual([
      { kind: 'call', id: 'set', module: 'extension.set-owner-if-empty', version: '1', inputs: { player: { kind: 'input', name: 'owner' } }, parameters: { storageKey: 'amaterasuOwnerPlayerId' } },
      original.body[3],
    ])
    expect(repairStorageExpansion(repaired)).toEqual(repaired)
  })
  it('does not erase a user-authored extra statement in the conditional', () => {
    const graph = structuredClone(original)
    const branch = graph.body[2]
    if (branch.kind !== 'if') throw new Error('fixture')
    const edited = { ...graph, body: [graph.body[0], graph.body[1], { ...branch, then: [...branch.then, graph.body[3]] }, graph.body[3]] }
    expect(repairStorageExpansion(edited)).toEqual(edited)
  })
  it.each(['operator', 'condition', 'namespace', 'version', 'external-reference'])('preserves an edited %s', change => {
    const graph = structuredClone(original)
    const compare = graph.body[1], branch = graph.body[2]
    if (compare.kind !== 'call' || branch.kind !== 'if' || branch.then[0].kind !== 'call') throw new Error('fixture')
    if (change === 'operator') Object.assign(compare.parameters!, { operator: '!=' })
    if (change === 'condition') Object.assign(branch, { condition: { kind: 'literal', value: false } })
    if (change === 'namespace') Object.assign(branch.then[0].parameters!, { namespace: 'different' })
    if (change === 'version') Object.assign(branch.then[0], { version: '3' })
    if (change === 'external-reference') Object.assign(graph.body[3], { value: { kind: 'output', node: 'set--owner', port: 'value' } })
    expect(repairStorageExpansion(graph)).toEqual(graph)
  })
  it.each([false, true])('repairs the exact removal block, committed output=%s', committed => {
    const graph = removal(committed)
    const repaired = repairStorageExpansion(graph)
    expect(repaired.body).toEqual([
      { kind: 'call', id: 'remove', module: 'extension.remove-owner-record', version: '1', inputs: { owner: { kind: 'input', name: 'owner' } }, parameters: { key: 'coltZones' } },
      { kind: 'return', id: 'tail', value: committed ? output('remove', 'success') : { kind: 'literal', value: false } },
    ])
    expect(repairStorageExpansion(repaired)).toEqual(repaired)
  })
  it.each(['namespace', 'path', 'reference', 'shadowed-result'])('preserves removal edits: %s', change => {
    const graph = removal(true)
    const write = graph.body[4]
    if (write.kind !== 'call') throw new Error('fixture')
    if (change === 'namespace') Object.assign(write, { parameters: { ...write.parameters, namespace: 'custom' } })
    if (change === 'path') Object.assign(write, { inputs: { ...write.inputs, path: { kind: 'literal', value: ['custom'] } } })
    if (change === 'reference') Object.assign(graph.body[6], { value: output('remove--records') })
    if (change === 'shadowed-result') Object.assign(graph.body[6], { id: 'remove--committed' })
    expect(repairStorageExpansion(graph)).toEqual(graph)
  })
})
