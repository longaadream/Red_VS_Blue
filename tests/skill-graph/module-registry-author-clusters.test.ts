import { describe, expect, it } from 'vitest'

import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { AUTHOR_CLUSTER_MODULES } from '../../lib/skill-graph/module-registry-author-clusters'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayLiteral,
  type GameplayModuleDescriptor,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayModuleSurface,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'

const descriptors = new Map(AUTHOR_CLUSTER_MODULES.map(descriptor => [`${descriptor.id}@${descriptor.version}`, descriptor]))

const registry: GameplayModuleRegistry = {
  get: (id: string, version = '1') => descriptors.get(`${id}@${version}`),
  resolve: (id: string, version = '1') => descriptors.get(`${id}@${version}`),
  descriptors: AUTHOR_CLUSTER_MODULES,
}

const descriptor = (id: string): GameplayModuleDescriptor => {
  const entry = AUTHOR_CLUSTER_MODULES.find(candidate => candidate.id === id)
  if (!entry) throw new Error(`missing descriptor ${id}`)
  return entry
}

const input = (name: string): GameplayValue => ({ kind: 'input', name })
const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })

function lower(
  id: string,
  surface: GameplayModuleSurface,
  inputs: Readonly<Record<string, string>>,
  parameters: Readonly<Record<string, GameplayLiteral>> = {},
): string {
  const entry = descriptor(id)
  const result = entry.lower({
    surface,
    callId: 'test-call',
    moduleId: entry.id,
    moduleVersion: entry.version,
    inputs,
    parameters,
    outputPorts: entry.outputs,
    emitLiteral: value => JSON.stringify(value),
  })
  if (typeof result !== 'string') throw new Error(`${id} must lower to an expression`)
  return result
}

const clusterDefinitionType = JSON.stringify({ kind: 'record', schema: 'author-cluster-definition' })

const clusterDefinitionSchema = {
  id: 'author-cluster-definition',
  version: '1',
  fields: [
    { name: 'id', type: 'string' as const },
    { name: 'skills', type: { kind: 'list' as const, element: 'string' as const } },
    { name: 'rules', type: { kind: 'list' as const, element: 'string' as const } },
    { name: 'extension', type: 'record' as const, optional: true },
  ],
}

function pendingGraph(
  body: GameplayModuleGraph['body'],
  outputs: NonNullable<GameplayModuleGraph['outputs']>,
  includeDefinition = false,
): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'pending',
    inputs: [
      { name: 'targetPiece', type: 'piece' },
      ...(includeDefinition ? [{ name: 'payload', type: { kind: 'record' as const, schema: clusterDefinitionSchema.id } }] : []),
    ],
    hostBindings: {
      targetPiece: 'piece',
      ...(includeDefinition ? { payload: { kind: 'record' as const, schema: clusterDefinitionSchema.id } } : {}),
    },
    schemas: [clusterDefinitionSchema],
    body,
    outputs,
  }
}

describe('author Cluster module descriptors', () => {
  it('publishes acquire, list, and remove as active atomic operations', () => {
    expect(AUTHOR_CLUSTER_MODULES.map(entry => entry.id)).toEqual([
      'author.cluster.acquire',
      'author.cluster.list',
      'author.cluster.remove',
    ])
    for (const entry of AUTHOR_CLUSTER_MODULES) {
      expect(entry.allowedSurfaces).toEqual(['skill', 'card', 'rule', 'triggerSkill', 'pending'])
      expect(entry.allowedSurfaces).not.toContain('preview')
      expect(entry.effects.pure).toBe(entry.id === 'author.cluster.list')
      expect(entry.effects.previewSafe).toBe(false)
      expect(entry.ui?.authoring).toBe('standard')
    }

    const acquire = descriptor('author.cluster.acquire')
    expect(acquire.inputs.map(port => port.name)).toEqual(['piece', 'definition'])
    expect(acquire.inputValueTypeBindings).toEqual({ definition: { parameter: 'definitionType' } })
    expect(acquire.parameters).toEqual([{ name: 'definitionType', type: 'string', label: '定义类型', default: 'record' }])
    expect(acquire.outputs).toEqual([{ name: 'group', type: 'record', label: '能力组实例' }])
    expect(descriptor('author.cluster.list').outputs).toEqual([{
      name: 'groups',
      type: { kind: 'list', element: 'record' },
      label: '能力组实例元组',
    }])
    expect(descriptor('author.cluster.remove').inputs).toEqual([{ name: 'group', type: 'record', label: '能力组实例' }])
  })

  it('lowers every operation through flow and uses ctx.flow for pending effects', () => {
    expect(lower('author.cluster.acquire', 'skill', { piece: 'pieceId', definition: 'definition' }, { definitionType: 'record' }))
      .toBe('flow.clusters.acquire(pieceId,definition)')
    expect(lower('author.cluster.list', 'card', { piece: 'pieceId' }))
      .toBe('flow.clusters.list(pieceId)')
    expect(lower('author.cluster.remove', 'rule', { group: 'groupRecord' }))
      .toBe('flow.clusters.remove(groupRecord)')

    expect(lower('author.cluster.acquire', 'pending', { piece: 'pieceId', definition: 'definition' }, { definitionType: clusterDefinitionType }))
      .toBe('ctx.flow.clusters.acquire(pieceId,definition)')
    expect(lower('author.cluster.list', 'pending', { piece: 'pieceId' }))
      .toBe('ctx.flow.clusters.list(pieceId)')
    expect(lower('author.cluster.remove', 'pending', { group: 'groupRecord' }))
      .toBe('ctx.flow.clusters.remove(groupRecord)')
  })

  it('compiles pending acquire and remove calls with a schema-bound definition', () => {
    const compiled = compileGameplayModuleGraph(pendingGraph([
      {
        kind: 'call',
        id: 'acquire',
        module: 'author.cluster.acquire',
        version: '1',
        inputs: { piece: input('targetPiece'), definition: input('payload') },
        parameters: { definitionType: clusterDefinitionType },
      },
      {
        kind: 'call',
        id: 'remove',
        module: 'author.cluster.remove',
        version: '1',
        inputs: { group: output('acquire', 'group') },
      },
      { kind: 'return', id: 'done', values: { removed: output('remove', 'removed') } },
    ], [{ name: 'removed', type: 'boolean' }], true), registry)

    expect(compiled.diagnostics).toEqual([])
    expect(compiled.code).toContain('ctx.flow.clusters.acquire')
    expect(compiled.code).toContain('ctx.flow.clusters.remove')
    expect(compiled.dependencies).toEqual([
      { id: 'author.cluster.acquire', version: '1', kind: 'native' },
      { id: 'author.cluster.remove', version: '1', kind: 'native' },
    ])
  })

  it('compiles pending list with the live piece host binding', () => {
    const compiled = compileGameplayModuleGraph(pendingGraph([
      {
        kind: 'call',
        id: 'list',
        module: 'author.cluster.list',
        version: '1',
        inputs: { piece: input('targetPiece') },
      },
      { kind: 'return', id: 'done', values: { groups: output('list', 'groups') } },
    ], [{ name: 'groups', type: { kind: 'list', element: 'record' } }]), registry)

    expect(compiled.diagnostics).toEqual([])
    expect(compiled.code).toContain('ctx.flow.clusters.list')
    expect(compiled.dependencies).toEqual([{ id: 'author.cluster.list', version: '1', kind: 'native' }])
  })
})
