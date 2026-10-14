import { describe, expect, it } from 'vitest'
import { ATOMIC_CARD_READ_MODULES, migrateCardReadModules } from '../../lib/skill-graph/atomic-migration-card-reads'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { CONTENT_FIELD_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-content-fields'
import { RECORD_KEY_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-record-key'
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

function call(id: string, module: string, inputs: Readonly<Record<string, GameplayValue>> = {}, parameters: Readonly<Record<string, GameplayLiteral>> = {}): GameplayCallStatement {
  return { kind: 'call', id, module, version, inputs, parameters }
}

function registry(): GameplayModuleRegistry {
  const overlays = [...CONTENT_FIELD_GAMEPLAY_MODULES, ...RECORD_KEY_GAMEPLAY_MODULES]
  const byKey = new Map(overlays.map(descriptor => [descriptor.id + '@' + descriptor.version, descriptor]))
  return { get: (id, requestedVersion) => byKey.get(id + '@' + (requestedVersion ?? version)) ?? GAMEPLAY_MODULE_REGISTRY.get(id, requestedVersion) }
}

function graph(body: GameplayModuleGraph['body']): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'rule',
    body,
    inputs: [{ name: 'cardId', type: 'string' }],
    inputBindings: { cardId: 'curse-a' },
    outputs: [{ name: 'value', type: 'number' }],
  }
}

function execute(compiled: ReturnType<typeof compileGameplayModuleGraph>, battle: Record<string, unknown>, flow: Record<string, unknown>): unknown {
  return new Function('context', 'flow', 'battle', 'ctx', compiled.code)({}, flow, battle, undefined)
}

describe('atomic card content readers', () => {
  it('reads finite dynamic card damage and preserves fallback for missing definitions', () => {
    const source = graph([
      call('read', 'content.card-number', { cardId: input('cardId') }, { field: 'damageAmount', fallback: 4 }),
      { kind: 'return', id: 'done', value: output('read') },
    ])
    const migrated = migrateCardReadModules(source)
    expect([...ATOMIC_CARD_READ_MODULES]).toEqual(['content.card-number'])
    expect(JSON.stringify(migrated.body)).not.toContain('content.card-number')
    const flow = {
      content: {
        cardNumber: (id: string, field: string, fallback: number) => {
          const value = (battle.customCards as Record<string, Record<string, unknown>> | undefined)?.[id]?.[field]
          return typeof value === 'number' && Number.isFinite(value) ? value : fallback
        },
      },
    }
    const battle = { customCards: { 'curse-a': { damageAmount: 7, name: 'Curse' } } }
    expect(execute(compileGameplayModuleGraph(source, GAMEPLAY_MODULE_REGISTRY), battle, flow)).toBe(7)
    expect(execute(compileGameplayModuleGraph(migrated, registry()), battle, flow)).toBe(7)
    expect(execute(compileGameplayModuleGraph(migrated, registry()), { customCards: {} }, flow)).toBe(4)
    expect(execute(compileGameplayModuleGraph(migrated, registry()), {}, flow)).toBe(4)
  })

  it('preserves explicit zero and fallback on a missing damage field', () => {
    const source = graph([
      call('read', 'content.card-number', { cardId: input('cardId') }, { field: 'damageAmount', fallback: 4 }),
      { kind: 'return', id: 'done', value: output('read') },
    ])
    const migrated = migrateCardReadModules(source)
    const flow = { content: { cardNumber: () => 0 } }
    expect(execute(compileGameplayModuleGraph(migrated, registry()), { customCards: { 'curse-a': { damageAmount: 0 } } }, flow)).toBe(0)
    expect(execute(compileGameplayModuleGraph(migrated, registry()), { customCards: { 'curse-a': {} } }, flow)).toBe(4)
  })
})
