import { describe, expect, it } from 'vitest'
import { atomicSkillDefinitionFieldRecipe, migrateSkillDefinitionFieldModules, ATOMIC_SKILL_DEFINITION_FIELD_MODULES } from '../../lib/skill-graph/atomic-migration-skill-definition-fields'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { SKILL_DEFINITION_FIELD_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-skill-definition-fields'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayCallStatement,
  type GameplayLiteral,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'

const version = '1'
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayLiteral>> = {},
): GameplayCallStatement {
  return { kind: 'call', id, module, version, inputs, parameters }
}

function registry(): GameplayModuleRegistry {
  const byKey = new Map(SKILL_DEFINITION_FIELD_GAMEPLAY_MODULES.map(descriptor => [descriptor.id + '@' + descriptor.version, descriptor]))
  return {
    get: (id, requestedVersion) => byKey.get(id + '@' + (requestedVersion ?? version)) ?? GAMEPLAY_MODULE_REGISTRY.get(id, requestedVersion),
  }
}

function graph(skillId: string | null = 'momentum'): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    inputs: [{ name: 'skillId', type: 'string', nullable: true }],
    inputBindings: { skillId },
    body: [
      call('flag', 'skill.boolean-flag', { skillId: input('skillId') }, { field: 'momentumGainOnUse' }),
      { kind: 'return', id: 'done', value: output('flag') },
    ],
    outputs: [{ name: 'value', type: 'boolean' }],
  }
}

function execute(compiled: ReturnType<typeof compileGameplayModuleGraph>, battle: Record<string, unknown>, skillId: string | null): unknown {
  return new Function('context', 'flow', 'battle', 'ctx', compiled.code)({ skillId }, {}, battle, undefined)
}

describe('atomic skill definition field migration', () => {
  it('reads a closed definition flag and keeps missing/null values false', () => {
    const source = graph()
    const migrated = migrateSkillDefinitionFieldModules(source)
    expect([...ATOMIC_SKILL_DEFINITION_FIELD_MODULES]).toEqual(['skill.boolean-flag'])
    expect(JSON.stringify(migrated.body)).not.toContain('skill.boolean-flag')
    expect(atomicSkillDefinitionFieldRecipe(source.body[0] as GameplayCallStatement, suffix => 'fresh-' + suffix)).toBeDefined()

    const compiled = compileGameplayModuleGraph(migrated, registry())
    expect(execute(compiled, { skillsById: { momentum: { momentumGainOnUse: true } } }, 'momentum')).toBe(true)
    expect(execute(compiled, { skillsById: { momentum: { momentumGainOnUse: false } } }, 'momentum')).toBe(false)
    expect(execute(compiled, { skillsById: {} }, 'missing')).toBe(false)
    expect(execute(compileGameplayModuleGraph(migrateSkillDefinitionFieldModules(graph(null)), registry()), { skillsById: { momentum: { momentumGainOnUse: true } } }, null)).toBe(false)
  })

  it('invalidates accessor or malformed definition flags without invoking accessors', () => {
    const definition: Record<string, unknown> = {}
    let reads = 0
    Object.defineProperty(definition, 'momentumGainOnUse', {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1
        return true
      },
    })
    const compiled = compileGameplayModuleGraph(migrateSkillDefinitionFieldModules(graph()), registry())
    expect(execute(compiled, { skillsById: { momentum: definition } }, 'momentum')).toBeUndefined()
    expect(reads).toBe(0)
    expect(execute(compiled, { skillsById: { momentum: { momentumGainOnUse: 'yes' } } }, 'momentum')).toBeUndefined()
  })
})
