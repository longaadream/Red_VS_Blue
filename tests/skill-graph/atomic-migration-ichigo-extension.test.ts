import { describe, expect, it } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { createGameplayModuleDiagnosticHost, installGameplayModuleDiagnosticHost } from '../../lib/game/gameplay-module-diagnostics'
import { atomicIchigoExtensionRecipe, ICHIGO_EXTENSION_KEY, migrateIchigoExtensionModules } from '../../lib/skill-graph/atomic-migration-ichigo-extension'
import { migrateAtomicAuthorGraph } from '../../scripts/migrate-atomic-author-modules'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { RETIRED_AUTHOR_MODULES } from '../../lib/skill-graph/author-module-catalog'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayEffectMetadata, type GameplayModuleDescriptor, type GameplayModuleGraph, type GameplayModuleRegistry, type GameplayModuleSurface, type GameplayValueType } from '../../lib/skill-graph/module-types'
import { ICHIGO_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-ichigo'
import { makePiece, makeState } from '../helpers/minimal-state'

const pieceType: GameplayValueType = 'piece'
const nullablePieceType: GameplayValueType = { kind: 'nullable', value: pieceType }
const cellType: GameplayValueType = 'cell'
const cellListType: GameplayValueType = { kind: 'list', element: cellType }
const active: readonly GameplayModuleSurface[] = ['skill']
const pure: GameplayEffectMetadata = { pure: true, previewSafe: true }
const output = (node: string, port = 'value') => ({ kind: 'output' as const, node, port })

function fixtureDescriptor<T extends GameplayValueType>(id: string, name: string, type: T, expression: string): GameplayModuleDescriptor {
  return {
    id,
    version: '1',
    label: id,
    inputs: [],
    outputs: [{ name, type }],
    allowedSurfaces: active,
    effects: pure,
    lower: () => expression,
  }
}

const fixtureModules = [
  fixtureDescriptor('test.owner', 'owner', nullablePieceType, 'context.owner'),
  fixtureDescriptor('test.cells', 'cells', cellListType, 'context.cells'),
]

function registry(): GameplayModuleRegistry {
  const local = new Map([
    ...ICHIGO_GAMEPLAY_MODULES.map(module => [module.id + '@' + module.version, module] as const),
    ...fixtureModules.map(module => [module.id + '@' + module.version, module] as const),
  ])
  return {
    get: (id, version) => local.get(id + '@' + (version ?? '1')) ?? GAMEPLAY_MODULE_REGISTRY.get(id, version),
  }
}

function graph(module: string, outputType: GameplayValueType, inputs: Record<string, ReturnType<typeof output>> = {}): GameplayModuleGraph {
  const operationInputs: Record<string, ReturnType<typeof output>> = module === 'extension.set-piece-cells'
    ? { owner: output('owner', 'owner'), cells: output('cells', 'cells') }
    : { owner: output('owner', 'owner'), ...inputs }
  const body: GameplayModuleGraph['body'] = [
    { kind: 'call', id: 'owner', module: 'test.owner', version: '1' },
    ...(module === 'extension.set-piece-cells' ? [{ kind: 'call' as const, id: 'cells', module: 'test.cells', version: '1' }] : []),
    { kind: 'call', id: 'operation', module, version: '1', inputs: operationInputs, parameters: { key: 'ichigoBlackGetsugaTeleportByCaster' } },
    { kind: 'return', id: 'done', value: output('operation', module === 'extension.read-piece-cells' ? 'cells' : 'success') },
  ]
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body, outputs: [{ name: 'value', type: outputType }] }
}

function run(source: GameplayModuleGraph, extensions: Record<string, unknown>, contextValues: { owner: string | null; cells?: Array<{ x: number; y: number }> }): { result: unknown; extensions: Record<string, unknown> } {
  const piece = makePiece({ instanceId: 'owner-1' })
  const battle = makeState({ pieces: [piece] })
  battle.extensions = structuredClone(extensions)
  const context = { owner: contextValues.owner, cells: contextValues.cells ?? [] }
  installGameplayModuleDiagnosticHost(context, createGameplayModuleDiagnosticHost('skill', {}, () => undefined))
  const flow = createFlowRuntime(battle, context, 'skill', {})
  const compiled = compileGameplayModuleGraph(source, registry())
  const result = new Function('flow', 'battle', 'return (' + compiled.code + ')')(flow, battle)(context)
  return { result, extensions: battle.extensions as Record<string, unknown> }
}

function pair(module: string, outputType: GameplayValueType, inputs: Record<string, ReturnType<typeof output>> = {}) {
  const source = graph(module, outputType, inputs)
  return { source, migrated: migrateIchigoExtensionModules(source) }
}

describe('Ichigo extension adapter migration', () => {
  it('replaces all four closed adapters and is idempotent', () => {
    for (const [module, outputType] of [
      ['extension.read-piece-cells', cellListType],
      ['extension.set-piece-cells', 'boolean'],
      ['extension.clear-piece-cells', 'boolean'],
      ['extension.remove-empty-piece-store', 'boolean'],
    ] as const) {
      const migrated = migrateIchigoExtensionModules(graph(module, outputType))
      const calls = JSON.stringify(migrated)
      expect(calls).not.toContain(module)
      expect(migrateIchigoExtensionModules(migrated)).toEqual(migrated)
    }
    expect(atomicIchigoExtensionRecipe).toBeTypeOf('function')
    expect(GAMEPLAY_MODULE_REGISTRY.get('extension.remove-battle', '1')).toBeDefined()
    expect(GAMEPLAY_MODULE_REGISTRY.get('record.set-key', '1')).toBeDefined()
    expect(GAMEPLAY_MODULE_REGISTRY.get('record.is-empty', '1')).toBeDefined()
    expect([...['extension.read-piece-cells', 'extension.set-piece-cells', 'extension.clear-piece-cells', 'extension.remove-empty-piece-store']].every(id => RETIRED_AUTHOR_MODULES.has(id))).toBe(true)
  })

  it('reads only integer coordinates, preserves order, and does not create an absent store', () => {
    const { source, migrated } = pair('extension.read-piece-cells', cellListType)
    const initial = {
      ichigoBlackGetsugaTeleportByCaster: {
        'owner-1': [{ type: 'cell', x: 1, y: 2 }, { x: 2.5, y: 3 }, { x: 4, y: 5 }],
      },
    }
    expect(run(migrated, initial, { owner: 'owner-1' })).toEqual(run(source, initial, { owner: 'owner-1' }))
    expect(run(migrated, {}, { owner: 'owner-1' })).toEqual({ result: [], extensions: {} })
    expect(run(migrated, initial, { owner: null })).toEqual({ result: [], extensions: initial })
  })

  it('runs through the central atomic migrator and central registry', () => {
    const source = graph('extension.remove-empty-piece-store', 'boolean')
    const migrated = migrateAtomicAuthorGraph(source)
    expect(JSON.stringify(migrated)).not.toContain('extension.remove-empty-piece-store')
    expect(run(migrated, { [ICHIGO_EXTENSION_KEY]: {} }, { owner: 'owner-1' })).toEqual({ result: true, extensions: {} })
  })

  it('writes normalized cells under one owner while preserving siblings', () => {
    const { source, migrated } = pair('extension.set-piece-cells', 'boolean')
    const initial = {
      ichigoBlackGetsugaTeleportByCaster: {
        sibling: [{ type: 'cell', x: 9, y: 9 }],
      },
    }
    const context = { owner: 'owner-1', cells: [{ x: 1, y: 2 }, { x: 1.5, y: 2 }, { x: 4, y: 5 }] }
    const oldResult = run(source, initial, context)
    const newResult = run(migrated, initial, context)
    expect(newResult).toEqual(oldResult)
    expect(newResult.result).toBe(true)
    expect(newResult.extensions.ichigoBlackGetsugaTeleportByCaster).toEqual({
      sibling: [{ type: 'cell', x: 9, y: 9 }],
      'owner-1': [{ type: 'cell', x: 1, y: 2 }, { type: 'cell', x: 4, y: 5 }],
    })
    expect(run(migrated, initial, { owner: null, cells: context.cells })).toEqual({ result: false, extensions: initial })
  })

  it('removes one owner only when present and leaves the root for later reads', () => {
    const { source, migrated } = pair('extension.clear-piece-cells', 'boolean')
    const initial = {
      ichigoBlackGetsugaTeleportByCaster: {
        'owner-1': [{ type: 'cell', x: 1, y: 2 }],
        sibling: [{ type: 'cell', x: 3, y: 4 }],
      },
    }
    expect(run(migrated, initial, { owner: 'owner-1' })).toEqual(run(source, initial, { owner: 'owner-1' }))
    expect(run(migrated, initial, { owner: 'missing' })).toEqual({ result: false, extensions: initial })
    expect(run(migrated, initial, { owner: null })).toEqual({ result: false, extensions: initial })
  })

  it('reports empty-store removal without touching absent or non-empty stores', () => {
    const { migrated } = pair('extension.remove-empty-piece-store', 'boolean')
    const key = 'ichigoBlackGetsugaTeleportByCaster'
    expect(run(migrated, {}, { owner: 'owner-1' })).toEqual({ result: false, extensions: {} })
    expect(run(migrated, { [key]: { sibling: [{ type: 'cell', x: 1, y: 1 }] } }, { owner: 'owner-1' })).toEqual({
      result: false,
      extensions: { [key]: { sibling: [{ type: 'cell', x: 1, y: 1 }] } },
    })
    // Removal must preserve the distinction between an absent root and an
    // explicitly empty record: the legacy adapter deletes the named field.
    expect(run(migrated, { [key]: {} }, { owner: 'owner-1' })).toEqual({ result: true, extensions: {} })
  })
})
