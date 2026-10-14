import { createContext, runInContext, runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  ATOMIC_FOLLOWUP_COMPOSITION_MODULES,
  migrateFollowupCompositionModules,
} from '../../lib/skill-graph/atomic-migration-followup-compositions'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { FOLLOWUP_COMPOSITION_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-followup-compositions'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayJsonValue,
  type GameplayModuleDescriptor,
  type GameplayModuleGraph,
  type GameplayStatement,
  type GameplayValue,
  type GameplayValueType,
} from '../../lib/skill-graph/module-types'

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })

const fixtures: readonly GameplayModuleDescriptor[] = [
  {
    id: 'test.piece', version: '1', label: 'piece', inputs: [], outputs: [{ name: 'piece', type: 'piece' }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower: () => 'context.piece',
  },
  {
    id: 'test.player', version: '1', label: 'player', inputs: [], outputs: [{ name: 'player', type: 'player' }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower: () => 'context.player',
  },
  {
    id: 'test.number', version: '1', label: 'number', inputs: [], outputs: [{ name: 'value', type: 'number' }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower: () => 'context.number',
  },
  {
    id: 'test.source', version: '1', label: 'source', inputs: [], outputs: [
      { name: 'piece', type: 'piece' }, { name: 'pieces', type: { kind: 'list', element: 'piece' } },
    ], allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true },
    lower: () => '({piece:context.piece,pieces:context.pieces})',
  },
]

const registry = {
  get: (id: string, version?: string) => fixtures.find(item => item.id === id && item.version === (version ?? '1'))
    ?? FOLLOWUP_COMPOSITION_GAMEPLAY_MODULES.find(item => item.id === id && item.version === (version ?? '1'))
    ?? GAMEPLAY_MODULE_REGISTRY.get(id, version),
  resolve: (id: string, version?: string) => fixtures.find(item => item.id === id && item.version === (version ?? '1'))
    ?? FOLLOWUP_COMPOSITION_GAMEPLAY_MODULES.find(item => item.id === id && item.version === (version ?? '1'))
    ?? GAMEPLAY_MODULE_REGISTRY.resolve(id, version),
  descriptors: [...GAMEPLAY_MODULE_REGISTRY.descriptors, ...fixtures, ...FOLLOWUP_COMPOSITION_GAMEPLAY_MODULES],
}

const moduleOutputType = (moduleId: string, port: string): GameplayValueType => {
  const descriptor = GAMEPLAY_MODULE_REGISTRY.get(moduleId)
  const found = descriptor?.outputs.find(item => item.name === port)
  if (!found) throw new Error(`missing output type ${moduleId}.${port}`)
  const type = JSON.parse(JSON.stringify(found.type)) as GameplayValueType
  const normalize = (value: GameplayValueType): GameplayValueType => {
    if (typeof value === 'object' && value.kind === 'record') return 'record'
    if (typeof value === 'object' && value.kind === 'list') return { kind: 'list', element: normalize(value.element) }
    return value
  }
  const normalized = normalize(type)
  return found.nullable ? { kind: 'nullable', value: normalized } : normalized
}

function graph(
  moduleId: string,
  sourceModule: string,
  inputs: Record<string, GameplayValue>,
  parameters: Record<string, GameplayJsonValue>,
  outputs: Record<string, string>,
): GameplayModuleGraph {
  const body: GameplayStatement[] = [
    { kind: 'call', id: 'source', module: sourceModule, version: '1', inputs: {}, parameters: {} },
    { kind: 'call', id: 'source-call', module: moduleId, version: '1', inputs, parameters },
    {
      kind: 'return', id: 'return', values: Object.fromEntries(
        Object.entries(outputs).map(([name, port]) => [name, output('source-call', port)]),
      ),
    },
  ]
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    body,
    outputs: Object.entries(outputs).map(([name, port]) => ({ name, type: moduleOutputType(moduleId, port) })),
  }
}

function compile(moduleId: string, sourceModule: string, inputs: Record<string, GameplayValue>, parameters: Record<string, GameplayJsonValue>, outputs: Record<string, string>): GameplayModuleGraph {
  const migrated = migrateFollowupCompositionModules(graph(moduleId, sourceModule, inputs, parameters, outputs))
  expect(JSON.stringify(migrated)).not.toContain(`"module":"${moduleId}"`)
  compileGameplayModuleGraph(migrated, registry)
  return migrated
}

describe('follow-up composition migrations', () => {
  it('rewrites and compiles every bounded compatibility helper', () => {
    expect(ATOMIC_FOLLOWUP_COMPOSITION_MODULES).toEqual(new Set([
      'rule.append-reference', 'player.consume-buff', 'followup.status-records',
      'followup.status-player-field', 'followup.piece-name-with-template',
      'followup.piece-template-id', 'attribute.read-stored', 'effect.damage-many-ordered', 'effect.damage-many',
    ]))
    compile('rule.append-reference', 'test.piece', { target: output('source', 'piece') }, { ruleId: 'rule-a' }, { success: 'success' })
    compile('player.consume-buff', 'test.player', { player: output('source', 'player') }, { buffId: 'buff-a' }, { applied: 'applied', multiplier: 'multiplier' })
    compile('followup.status-records', 'test.piece', { piece: output('source', 'piece'), turn: literal(2) }, { statusType: 'burn' }, { records: 'records' })
    compile('followup.status-player-field', 'test.piece', { piece: output('source', 'piece'), statusId: literal('status-a') }, { field: 'opponentPlayerId' }, { player: 'player' })
    compile('followup.piece-name-with-template', 'test.piece', { piece: output('source', 'piece') }, {}, { text: 'text' })
    compile('followup.piece-template-id', 'test.piece', { piece: output('source', 'piece') }, {}, { text: 'text' })
    compile('attribute.read-stored', 'test.piece', { id: literal('piece-a') }, { attribute: 'attack' }, { value: 'value', exists: 'exists' })
    compile('effect.damage-many-ordered', 'test.source', { source: output('source', 'piece'), targets: output('source', 'pieces'), amount: literal(4) }, { damageType: 'normal', skillId: 'skill-a' }, { result: 'result', success: 'success', totalDamage: 'totalDamage' })
    compile('effect.damage-many', 'test.source', { source: output('source', 'piece'), targets: output('source', 'pieces'), amount: literal(4) }, {}, { result: 'result' })
  })

  it('deduplicates rule references and writes only when a new reference is needed', () => {
    const migrated = compile('rule.append-reference', 'test.piece', { target: output('source', 'piece') }, { ruleId: 'rule-a' }, { success: 'success' })
    const piece = { instanceId: 'piece-a', rules: [{ id: 'rule-a' }] }
    const flow = { query: { piece: () => piece } }
    const run = runInNewContext('(' + compileGameplayModuleGraph(migrated, registry).code + ')', { flow }) as (context: unknown) => unknown
    expect(run({ piece: 'piece-a' })).toEqual({ success: true })
    expect(piece.rules).toEqual([{ id: 'rule-a' }])
  })

  it('consumes an existing buff and preserves exhausted/missing behavior', () => {
    const migrated = compile('player.consume-buff', 'test.player', { player: output('source', 'player') }, { buffId: 'buff-a' }, { applied: 'applied', multiplier: 'multiplier' })
    const player = { playerId: 'player-a', buffs: { 'buff-a': { uses: 2, multiplier: 3 } } }
    const flow = { query: { player: () => player } }
    const run = runInNewContext('(' + compileGameplayModuleGraph(migrated, registry).code + ')', { flow }) as (context: unknown) => unknown
    expect(run({ player: 'player-a' })).toEqual({ applied: true, multiplier: 3 })
    expect(player.buffs['buff-a'].uses).toBe(1)
    player.buffs['buff-a'].uses = 0
    expect(run({ player: 'player-a' })).toEqual({ applied: false, multiplier: 1 })
  })

  it('filters status records by type and current turn', () => {
    const migrated = compile('followup.status-records', 'test.piece', { piece: output('source', 'piece'), turn: literal(2) }, { statusType: 'burn' }, { records: 'records' })
    const piece = { instanceId: 'piece-a', statusTags: [
      { id: 'old', type: 'burn', appliedTurn: 1 },
      { id: 'new', type: 'burn', appliedTurn: 2 },
      { id: 'freeze', type: 'freeze', appliedTurn: 2 },
    ] }
    const flow = { query: { piece: () => piece } }
    const run = runInNewContext('(' + compileGameplayModuleGraph(migrated, registry).code + ')', { flow }) as (context: unknown) => unknown
    expect(run({ piece: 'piece-a' })).toEqual({ records: [{ id: 'old', type: 'burn', appliedTurn: 1 }] })
  })

  it('reads status player, historical name/template, and stored attributes', () => {
    const statusGraph = compile('followup.status-player-field', 'test.piece', { piece: output('source', 'piece'), statusId: literal('status-a') }, { field: 'opponentPlayerId' }, { player: 'player' })
    const nameGraph = compile('followup.piece-name-with-template', 'test.piece', { piece: output('source', 'piece') }, {}, { text: 'text' })
    const templateGraph = compile('followup.piece-template-id', 'test.piece', { piece: output('source', 'piece') }, {}, { text: 'text' })
    const attributeGraph = compile('attribute.read-stored', 'test.piece', { id: literal('grave-a') }, { attribute: 'attack' }, { value: 'value', exists: 'exists' })
    const flow = { query: { piece: () => ({ instanceId: 'piece-a', statusTags: [{ id: 'status-a', opponentPlayerId: 'player-b' }] }) } }
    const battle = { pieces: [{ instanceId: 'grave-a', templateId: 'template-a', name: '历史名称', attack: 7 }], graveyard: [] }
    const run = (value: GameplayModuleGraph, context: Record<string, unknown>) => runInNewContext('(' + compileGameplayModuleGraph(value, registry).code + ')', { flow, battle })(context)
    expect(run(statusGraph, { piece: 'piece-a' })).toEqual({ player: 'player-b' })
    expect(run(nameGraph, { piece: 'grave-a' })).toEqual({ text: '历史名称' })
    expect(run(templateGraph, { piece: 'grave-a' })).toEqual({ text: 'template-a' })
    expect(run(attributeGraph, { piece: 'grave-a' })).toEqual({ value: 7, exists: true })
  })

  it('keeps host batch damage authoritative and computes total in the graph', () => {
    const migrated = compile('effect.damage-many-ordered', 'test.source', { source: output('source', 'piece'), targets: output('source', 'pieces'), amount: literal(4) }, { damageType: 'normal', skillId: 'skill-a' }, { result: 'result', success: 'success', totalDamage: 'totalDamage' })
    const compiled = compileGameplayModuleGraph(migrated, registry)
    const sandbox: Record<string, unknown> = {}
    createContext(sandbox)
    runInContext('flow = { effects: { apply: function() { return [{ success: true, damage: 2 }, { success: true, damage: 3 }] } } }', sandbox)
    const run = runInContext('(' + compiled.code + ')', sandbox) as (context: unknown) => unknown
    const result = run({ piece: 'piece-a', pieces: ['target-a', 'target-b'] })
    expect(result).toEqual({ result: { success: true, results: [{ success: true, damage: 2 }, { success: true, damage: 3 }], totalDamage: 5 }, success: true, totalDamage: 5 })
  })
})
