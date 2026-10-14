import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { migrateStatusChoiceModules } from '../../lib/skill-graph/atomic-migration-status-choice'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayModuleDescriptor,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })

const fixtures: readonly GameplayModuleDescriptor[] = [
  {
    id: 'test.status-target', version: '1', label: 'status target', inputs: [],
    outputs: [{ name: 'piece', type: 'piece' }], allowedSurfaces: ['skill'],
    effects: { pure: true, previewSafe: true }, lower: () => 'context.target',
  },
  {
    id: 'test.status-choice', version: '1', label: 'status choice', inputs: [],
    outputs: [{ name: 'choice', type: 'choice' }], allowedSurfaces: ['skill'],
    effects: { pure: true, previewSafe: true }, lower: () => 'context.choice',
  },
]

const registry: GameplayModuleRegistry = {
  get: (id, version) => fixtures.find(item => item.id === id && item.version === (version ?? '1'))
    ?? GAMEPLAY_MODULE_REGISTRY.get(id, version),
  resolve: (id, version) => fixtures.find(item => item.id === id && item.version === (version ?? '1'))
    ?? GAMEPLAY_MODULE_REGISTRY.resolve(id, version),
  descriptors: [...GAMEPLAY_MODULE_REGISTRY.descriptors, ...fixtures],
}

function graph(withChoice = true): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    body: [
      { kind: 'call', id: 'target', module: 'test.status-target', version: '1' },
      ...(withChoice ? [{ kind: 'call', id: 'choice', module: 'test.status-choice', version: '1' } as const] : []),
      {
        kind: 'call', id: 'remove', module: 'status.remove-choice', version: '1',
        inputs: {
          target: output('target', 'piece'),
          ...(withChoice ? { choice: output('choice', 'choice') } : {}),
        },
        parameters: {},
      },
      {
        kind: 'return', id: 'result', values: {
          valid: output('remove', 'valid'),
          removed: output('remove', 'removed'),
          name: output('remove', 'name'),
        },
      },
    ],
    outputs: [
      { name: 'valid', type: 'boolean' },
      { name: 'removed', type: 'boolean' },
      { name: 'name', type: 'string' },
    ],
  }
}

function execute(source: GameplayModuleGraph, context: { target: string; choice?: unknown }, statuses: Array<Record<string, unknown>>) {
  const migrated = migrateStatusChoiceModules(source)
  const compiled = compileGameplayModuleGraph(migrated, registry)
  const executionValues = new WeakMap<object, unknown>()
  let rawRemovals = 0
  const flow = {
    execution: {
      declare: (_type: unknown, _schemas: unknown, initial: unknown) => {
        const handle = Object.freeze({})
        executionValues.set(handle, initial)
        return { handle, success: true }
      },
      read: (handle: object) => ({ value: executionValues.get(handle), success: true }),
      write: (handle: object, _type: unknown, _schemas: unknown, value: unknown) => {
        executionValues.set(handle, value)
        return { success: true }
      },
    },
    status: {
      instances: (_target: string, ownerType: string) => {
        expect(ownerType).toBe('piece')
        return {
          statuses: statuses.map(tag => ({ tag })),
          present: true,
        }
      },
      fields: (handle: { tag: Record<string, unknown> }) => ({ ...handle.tag }),
      removeInstance: (handle: { tag: Record<string, unknown> }) => {
        const index = statuses.indexOf(handle.tag)
        if (index < 0) throw new Error('status instance expired')
        statuses.splice(index, 1)
        rawRemovals += 1
        return true
      },
    },
  }
  const run = runInNewContext('(' + compiled.code + ')', { context, flow }) as (value: unknown) => unknown
  const result = run(context)
  return { result, statuses, rawRemovals, migrated }
}

describe('status.remove-choice atomic migration', () => {
  it('uses status instance handles and preserves cancellation, invalid values, and names', () => {
    const source = graph()
    const first = execute(source, { target: 'tails', choice: '0' }, [
      { name: '护盾', type: 'armor' },
      { type: 'momentum' },
    ])
    expect(first.result).toEqual({ valid: true, removed: true, name: '护盾' })
    expect(first.statuses).toEqual([{ type: 'momentum' }])
    expect(first.rawRemovals).toBe(1)

    const typeName = execute(source, { target: 'tails', choice: '0' }, [{ type: 'momentum' }])
    expect(typeName.result).toEqual({ valid: true, removed: true, name: 'momentum' })
    const fallbackName = execute(source, { target: 'tails', choice: '0' }, [{}])
    expect(fallbackName.result).toEqual({ valid: true, removed: true, name: '一个效果' })

    const cancelled = execute(source, { target: 'tails', choice: 'none' }, [{ name: '护盾', type: 'armor' }])
    expect(cancelled.result).toEqual({ valid: true, removed: false, name: '' })
    expect(cancelled.rawRemovals).toBe(0)

    const invalid = execute(source, { target: 'tails', choice: 'bogus' }, [{ name: '护盾', type: 'armor' }])
    expect(invalid.result).toEqual({ valid: false, removed: false, name: '' })
    expect(invalid.rawRemovals).toBe(0)
  })

  it('keeps the no-choice branch as a non-removing normal graph call', () => {
    const result = execute(graph(false), { target: 'tails' }, [{ name: '护盾', type: 'armor' }])
    expect(result.result).toEqual({ valid: true, removed: false, name: '' })
    expect(result.rawRemovals).toBe(0)
  })

  it('does not leave the role-specific helper or lifecycle remover in the migrated graph', () => {
    const migrated = migrateStatusChoiceModules(graph())
    const encoded = JSON.stringify(migrated)
    expect(encoded).not.toContain('status.remove-choice')
    expect(encoded).toContain('status.instances')
    expect(encoded).toContain('status.remove-instance')
    expect(encoded).not.toContain('removeInstanceLifecycle')
    expect(compileGameplayModuleGraph(migrated, registry).code).toContain('flow.status.removeInstance')
  })
})
