import { describe, expect, it } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph } from '../../lib/skill-graph/module-types'
import { makeState } from '../helpers/minimal-state'

function setup(extensions: Record<string, unknown> = {}) {
  const battle = makeState({ pieces: [] }); battle.extensions = extensions
  const flow = createFlowRuntime(battle, {}, 'skill', {})
  return { battle, flow, extension: flow.extensionRoot }
}
describe('typed global root extension access', () => {
  it('preserves existing root shape, validates declarations and commits copied values', () => {
    const { battle, extension } = setup({ stored: { count: 3, name: '原内容' } })
    expect(extension.declareValue('battle', 'battle', '', 'stored', 'record', [], { count: 0 })).toEqual({ count: 3, name: '原内容' })
    const snapshot = extension.readValue('battle', 'battle', '', 'stored', '', 'record', []) as Record<string, unknown>
    snapshot.count = 90
    expect(battle.extensions?.stored.count).toBe(3)
    extension.writeValue('battle', 'battle', '', 'stored', 'count', 'number', [], 4)
    expect(battle.extensions).toEqual({ stored: { count: 4, name: '原内容' } })
    const resumed = createFlowRuntime(battle, {}, 'pending', {}).extensionRoot
    expect(resumed.readValue('battle', 'battle', '', 'stored', 'count', 'number', [])).toBe(4)
  })
  it('keeps absent reads and writes noncreating and validates before any commit', () => {
    const { battle, extension } = setup({ count: 3 })
    expect(() => extension.readValue('battle', 'battle', '', 'absent', '', 'number', [])).toThrow('不存在')
    expect(() => extension.writeValue('battle', 'battle', '', 'absent', '', 'number', [], 4)).toThrow('不存在')
    expect(() => extension.writeValue('battle', 'battle', '', 'count', '', 'number', [], 'bad')).toThrow('指定类型')
    expect(() => extension.declareValue('battle', 'battle', '', 'count', 'string', [], 'bad')).toThrow('指定类型')
    expect(battle.extensions).toEqual({ count: 3 })
  })
  it('uses path segments for instance keys containing dots', () => {
    const { battle, extension } = setup({ records: { 'piece.a': { turns: 2 } } })
    extension.writeValue('battle', 'battle', '', 'records', ['piece.a', 'turns'], 'number', [], 1)
    expect(battle.extensions).toEqual({ records: { 'piece.a': { turns: 1 } } })
    expect(() => extension.writeValue('battle', 'battle', '', 'records', ['piece.a', '__proto__'], 'record', [], {})).toThrow('字段路径无效')
  })
  it('rejects engine-owned fields, cross-scope routes, prototype keys and accessors', () => {
    const { battle, extension } = setup()
    for (const name of ['flowState', 'tileEffects', 'battleProfile', 'debugBattle', 'adventureWorld', 'adventureCards', 'skillPresentation', 'contentMode', 'removedPieces', '__dryRunSkillPreflight', '__proto__', 'constructor', 'prototype']) {
      expect(() => extension.declareValue('battle', 'battle', '', name, 'record', [], {}), name).toThrow()
      expect(() => extension.writeValue('battle', 'battle', '', name, '', 'record', [], {}), name).toThrow()
      expect(() => extension.readValue('battle', 'battle', '', name, '', 'record', []), name).toThrow()
    }
    expect(battle.extensions).toEqual({})
    expect(() => extension.declareValue('piece', 'a', '', 'field', 'number', [], 1)).toThrow('仅用于全局')
    expect(() => extension.declareValue('battle', 'battle', 'content', 'field', 'number', [], 1)).toThrow('仅用于全局')
    let called = false
    Object.defineProperty(battle.extensions, 'getter', { get() { called = true; return {} }, configurable: true })
    expect(() => extension.readValue('battle', 'battle', '', 'getter', '', 'record', [])).toThrow('访问器')
    expect(called).toBe(false)
    expect(Object.keys(battle.extensions!)).toEqual([])
  })
  it('keeps v1 namespaced storage separate and requires explicit root declaration', () => {
    const { battle, flow, extension } = setup()
    expect(() => flow.extension.declareValue('battle', 'battle', '', 'new', 'number', [], 1)).toThrow()
    extension.declareValue('battle', 'battle', '', 'new', 'number', [], 1)
    expect(battle.extensions).toEqual({ new: 1 })
    expect(() => extension.declareValue('battle', 'battle', '', 'new', 'string', [], 'x')).toThrow('类型不一致')
    expect(battle.extensions).toEqual({ new: 1 })
  })
  it('deletes a root field and clears its execution-local declaration', () => {
    const { battle, extension } = setup({ empty: {} })
    extension.declareValue('battle', 'battle', '', 'empty', 'record', [], {})
    expect(extension.removeValue('battle', 'battle', '', 'empty', 'record', [])).toBe(true)
    expect(battle.extensions).toEqual({})
    expect(extension.removeValue('battle', 'battle', '', 'empty', 'record', [])).toBe(false)

    // A stale declaration would reject this new type after the root is gone.
    extension.declareValue('battle', 'battle', '', 'empty', 'number', [], 1)
    expect(battle.extensions).toEqual({ empty: 1 })
  })
  it.each(['', 'content'])('returns the real deletion result through the compiled module in namespace %j', (namespace) => {
    const { battle, flow, extension } = setup({ untouched: 7 })
    const storage = namespace === '' ? extension : flow.extension
    storage.declareValue('battle', 'battle', namespace, 'empty', 'record', [], {})
    const graph: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      outputs: [{ name: 'success', type: 'boolean' }],
      body: [
        { kind: 'call', id: 'remove', module: 'extension.remove-battle', version: '1',
          parameters: { namespace, name: 'empty', valueType: 'record' } },
        { kind: 'return', id: 'done', values: { success: { kind: 'output', node: 'remove', port: 'success' } } },
      ],
    }
    const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
    const execute = new Function('flow', 'return (' + compiled.code + ')')(flow) as (context: unknown) => unknown
    expect(execute({})).toEqual({ success: true })
    expect(execute({})).toEqual({ success: false })
    expect(battle.extensions?.untouched).toBe(7)
  })
})
