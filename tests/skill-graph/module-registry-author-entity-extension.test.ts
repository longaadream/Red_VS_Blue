import { describe, expect, it } from 'vitest'

import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { AUTHOR_CARD_MODULES } from '../../lib/skill-graph/module-registry-author-cards'
import { AUTHOR_ENTITY_EXTENSION_MODULES } from '../../lib/skill-graph/module-registry-author-entity-extension'
import { AUTHOR_SKILL_INSTANCE_MODULES } from '../../lib/skill-graph/module-registry-author-skill-instance'
import { AUTHOR_RULE_INSTANCE_MODULES } from '../../lib/skill-graph/module-registry-author-rule-instance'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayModuleRegistry,
  type GameplayModuleSurface,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'

const allDescriptors = [...AUTHOR_CARD_MODULES, ...AUTHOR_SKILL_INSTANCE_MODULES, ...AUTHOR_RULE_INSTANCE_MODULES, ...AUTHOR_ENTITY_EXTENSION_MODULES]
const descriptors = new Map(allDescriptors.map(descriptor => [`${descriptor.id}@${descriptor.version}`, descriptor]))
const registry: GameplayModuleRegistry = {
  get: (id: string, version = '1') => descriptors.get(`${id}@${version}`),
  resolve: (id: string, version = '1') => descriptors.get(`${id}@${version}`),
  descriptors: allDescriptors,
}
const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })

function lower(id: string, surface: GameplayModuleSurface, inputs: Record<string, string>, parameters: Record<string, string>): string {
  const descriptor = allDescriptors.find(candidate => candidate.id === id)
  if (!descriptor) throw new Error(`missing descriptor ${id}`)
  const result = descriptor.lower({
    surface,
    callId: 'test-call',
    moduleId: descriptor.id,
    moduleVersion: descriptor.version,
    inputs,
    parameters,
    outputPorts: descriptor.outputs,
    emitLiteral: value => JSON.stringify(value),
  })
  if (typeof result !== 'string') throw new Error(`${id} must lower to an expression`)
  return result
}

describe('author entity extension module descriptors', () => {
  it('types the live current hand as an opaque instance record while keeping definitions as cards', () => {
    expect(descriptors.get('ref.current-card@1')?.outputs[0].type).toBe('record')
    expect(descriptors.get('card.instance-reference@1')?.outputs[0].type).toBe('record')
    expect(descriptors.get('ref.card-definition@1')?.outputs[0].type).toBe('card')
  })

  it('lowers all operations through the live entity host and pending flow', () => {
    expect(lower('ref.current-rule', 'pending', {}, {})).toContain('ctx.flow.rules.current')
    expect(lower('extension.declare-instance', 'skill', { entity: 'instance', value: 'initial' }, {
      entityKind: 'skill', namespace: 'content', name: 'uses', valueType: 'number',
    })).toContain('flow.entityExtension.declare')
    expect(lower('extension.read-instance', 'pending', { entity: 'instance' }, {
      entityKind: 'status', namespace: 'content', name: 'uses', path: '', valueType: 'number',
    })).toContain('ctx.flow.entityExtension.read')
    expect(lower('extension.write-instance', 'rule', { entity: 'instance', value: 'next' }, {
      entityKind: 'rule', namespace: 'content', name: 'uses', path: '', valueType: 'number',
    })).toContain('flow.entityExtension.write')
  })

  it('compiles a pending typed declaration and read against one opaque instance input', () => {
    const compiled = compileGameplayModuleGraph({
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'pending',
      inputs: [],
      body: [
        {
          kind: 'call',
          id: 'current',
          module: 'ref.current-skill',
          version: '1',
          inputs: {},
          parameters: {},
        },
        {
          kind: 'call',
          id: 'declare',
          module: 'extension.declare-instance',
          version: '1',
          inputs: { entity: output('current', 'instance'), value: { kind: 'literal', value: 1 } },
          parameters: { entityKind: 'skill', namespace: 'content', name: 'uses', valueType: 'number' },
        },
        {
          kind: 'call',
          id: 'read',
          module: 'extension.read-instance',
          version: '1',
          inputs: { entity: output('current', 'instance') },
          parameters: { entityKind: 'skill', namespace: 'content', name: 'uses', path: '', valueType: 'number' },
        },
        { kind: 'return', id: 'done', values: { value: output('read', 'value') } },
      ],
      outputs: [{ name: 'value', type: 'number' }],
    }, registry)

    expect(compiled.diagnostics).toEqual([])
    expect(compiled.code).toContain('ctx.flow.entityExtension.declare')
    expect(compiled.code).toContain('ctx.flow.entityExtension.read')
  })
})
