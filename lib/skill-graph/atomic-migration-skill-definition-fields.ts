import { rewriteAtomicGraph, type AtomicRecipe, type AtomicReplacement } from './atomic-graph-rewrite'
import type {
  GameplayCallStatement,
  GameplayJsonValue,
  GameplayModuleGraph,
  GameplayValue,
} from './module-types'

const nullableBooleanType = { kind: 'nullable', value: 'boolean' } as const

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })

function isValue(value: unknown): value is GameplayValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.kind === 'literal') return Object.prototype.hasOwnProperty.call(record, 'value')
  if (record.kind === 'input') return typeof record.name === 'string' && record.name.length > 0
  return record.kind === 'output' && typeof record.node === 'string' && typeof record.port === 'string'
}

function requiredInput(call: GameplayCallStatement, name: string): GameplayValue | undefined {
  const value = call.inputs?.[name]
  return isValue(value) ? value : undefined
}

function generatedCall(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>>,
  parameters: Readonly<Record<string, GameplayJsonValue>>,
  version = '1',
): GameplayCallStatement {
  return { kind: 'call', id, module, version, inputs, parameters }
}

function migrateBooleanFlag(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  if (call.parameters?.field !== 'momentumGainOnUse') return undefined
  const skillId = requiredInput(call, 'skillId')
  if (!skillId) return undefined
  const readId = fresh('skill-definition-flag')
  const result = generatedCall(call.id, 'value.to-boolean', { value: output(readId) }, {
    valueType: JSON.stringify(nullableBooleanType),
  })
  return {
    statements: [
      generatedCall(readId, 'skill.definition-field', { skillId }, { field: 'momentumGainOnUse' }),
      result,
    ],
    outputs: { value: output(call.id) },
  }
}

export const ATOMIC_SKILL_DEFINITION_FIELD_MODULES = new Set(['skill.boolean-flag'])
export const ATOMIC_SKILL_DEFINITION_FIELD_MODULE_IDS = ATOMIC_SKILL_DEFINITION_FIELD_MODULES

export const atomicSkillDefinitionFieldRecipe: AtomicRecipe = (call, fresh): AtomicReplacement | undefined => {
  if (call.module === 'skill.boolean-flag') return migrateBooleanFlag(call, fresh)
  return undefined
}

export function migrateSkillDefinitionFieldModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicSkillDefinitionFieldRecipe)
}

export const migrateAtomicSkillDefinitionFieldGraph = migrateSkillDefinitionFieldModules
