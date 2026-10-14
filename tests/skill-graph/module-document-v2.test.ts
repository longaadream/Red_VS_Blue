import { describe, expect, it } from 'vitest'
import {
  applyGameplayModuleGraph,
  applyGameplayModuleTextBindings,
  assertGameplayModuleDocument,
  createGameplayModuleGraph,
} from '../../lib/skill-graph/module-document'
import { compileGameplayModuleGraphV1, compileGameplayModuleGraphV2 } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import type { GameplayModuleGraph } from '../../lib/skill-graph/module-types'

describe('gameplay module document compiler routing', () => {
  it('keeps v2 collection source proofs readable while new writes use v3', () => {
    const graph: GameplayModuleGraph = { ...createGameplayModuleGraph('skill'), body: [{
      kind: 'collection', id: 'values', method: 'map', items: { kind: 'literal', value: [1] },
      inputs: { saved: { kind: 'literal', value: 7 } },
      body: [{ kind: 'return', id: 'item', value: { kind: 'input', name: 'saved' } }],
    }] }
    const v2 = compileGameplayModuleGraphV2(graph, GAMEPLAY_MODULE_REGISTRY)
    const document = {
      id: 'v2-collection', kind: 'active', type: 'normal', code: v2.code,
      gameplayModules: { version: 'rvb-gameplay-module-document/v1', entries: {
        code: { graph, compilerVersion: 'rvb-gameplay-module-compiler/v2' },
      } },
    }
    expect(() => assertGameplayModuleDocument(document)).not.toThrow()
    const current = applyGameplayModuleGraph(document, graph)
    expect(current.code).not.toBe(v2.code)
    expect(() => assertGameplayModuleDocument(current)).not.toThrow()
  })

  it('accepts a valid legacy v1 entry and rejects version/code mismatches', () => {
    const graph = createGameplayModuleGraph('skill')
    const legacy = compileGameplayModuleGraphV1(graph, GAMEPLAY_MODULE_REGISTRY)
    const document = {
      id: 'legacy',
      kind: 'active',
      type: 'normal',
      code: legacy.code,
      gameplayModules: {
        version: 'rvb-gameplay-module-document/v1',
        entries: { code: { graph, compilerVersion: 'rvb-gameplay-module-compiler/v1' } },
      },
    }
    expect(() => assertGameplayModuleDocument(document)).not.toThrow()
    expect(() => assertGameplayModuleDocument({
      ...document,
      gameplayModules: { ...document.gameplayModules, entries: { code: { graph, compilerVersion: 'rvb-gameplay-module-compiler/v2' } } },
    })).toThrow(/generated code|match/)
    expect(() => assertGameplayModuleDocument({
      ...document,
      code: applyGameplayModuleGraph({ id: 'legacy', kind: 'active', type: 'normal' }, graph).code,
    })).toThrow(/generated code|match/)
  })

  it('replaces stale text bindings after validating graph ownership without the old binding', () => {
    const document = applyGameplayModuleGraph({ id: 'draft', kind: 'active', type: 'normal' }, createGameplayModuleGraph('skill'))
    const stale = {
      ...document,
      gameplayModules: {
        ...(document.gameplayModules as Record<string, unknown>),
        textBindings: {
          description: {
            template: '{{missing}}',
            values: { missing: { entry: 'code', node: 'missing', input: 'value' } },
          },
        },
      },
    }
    expect(() => applyGameplayModuleTextBindings(stale, {
      description: { template: 'Repaired draft', values: {} },
    })).not.toThrow()
  })
})
