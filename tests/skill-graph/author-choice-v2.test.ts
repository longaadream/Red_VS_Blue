import { describe, expect, it } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { createGameplayModuleDiagnosticHost, installGameplayModuleDiagnosticHost } from '../../lib/game/gameplay-module-diagnostics'
import { SuspendableActionPending, SuspendableActionRuntime, withSuspendableActionRuntime, type SuspendableInteractionAnswer } from '../../lib/game/suspendable-action-transaction'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY, getGameplayModule } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph } from '../../lib/skill-graph/module-types'
import { makePiece, makeState } from '../helpers/minimal-state'

const optionSchema = {
  id: 'choice-options', version: '1', fields: [
    { name: 'first', type: 'number' as const },
    { name: 'second', type: 'number' as const },
    { name: 'third', type: 'number' as const },
  ],
}

const boundsSchema = {
  id: 'choice-bounds', version: '1', fields: [
    { name: 'minimum', type: 'number' as const },
    { name: 'maximum', type: 'number' as const },
  ],
}

function choiceGraph(
  selectionMode: 'single' | 'multi',
  minSelections: number,
  maxSelections: number,
  valueType: 'number' | string = selectionMode === 'multi'
    ? '{"kind":"list","element":"number"}'
    : 'number',
): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    schemas: [optionSchema, boundsSchema],
    outputs: [{ name: 'value', type: selectionMode === 'multi' ? { kind: 'list', element: 'number' } : 'number' }],
    body: [
      { kind: 'record.create', id: 'options', schema: 'choice-options', fields: {
        first: { kind: 'literal', value: 7 },
        second: { kind: 'literal', value: 7 },
        third: { kind: 'literal', value: 2 },
      } },
      { kind: 'record.create', id: 'bounds', schema: 'choice-bounds', fields: {
        minimum: { kind: 'literal', value: minSelections },
        maximum: { kind: 'literal', value: maxSelections },
      } },
      { kind: 'record.get', id: 'minimum', record: { kind: 'output', node: 'bounds', port: 'value' }, field: 'minimum' },
      { kind: 'record.get', id: 'maximum', record: { kind: 'output', node: 'bounds', port: 'value' }, field: 'maximum' },
      { kind: 'call', id: 'owner', module: 'ref.player', version: '1' },
      { kind: 'call', id: 'pick', module: 'author.choice.option', version: '2', inputs: {
        options: { kind: 'output', node: 'options', port: 'value' },
        player: { kind: 'output', node: 'owner', port: 'player' },
        minSelections: { kind: 'output', node: 'minimum', port: 'value' },
        maxSelections: { kind: 'output', node: 'maximum', port: 'value' },
      }, parameters: { valueType, selectionMode, title: 'v2 choice' } },
      { kind: 'return', id: 'done', values: { value: { kind: 'output', node: 'pick', port: 'value' } } },
    ],
  }
}

function compileChoice(
  selectionMode: 'single' | 'multi',
  minSelections: number,
  maxSelections: number,
  valueType?: 'number' | string,
) {
  return compileGameplayModuleGraph(choiceGraph(selectionMode, minSelections, maxSelections, valueType), GAMEPLAY_MODULE_REGISTRY)
}

function executeCompiled(
  code: string,
  battle: ReturnType<typeof makeState>,
  source: ReturnType<typeof makePiece>,
  answers: readonly SuspendableInteractionAnswer[],
): { value: unknown } | SuspendableActionPending | undefined {
  const context = { piece: source, skill: { id: 'author-choice-v2-test' } }
  const flow = createFlowRuntime(battle, context, 'skill', {})
  const diagnostics = createGameplayModuleDiagnosticHost('skill', {}, () => undefined)
  const restore = installGameplayModuleDiagnosticHost(context, diagnostics)
  const runtime = new SuspendableActionRuntime(answers)
  try {
    const result = withSuspendableActionRuntime(runtime, () => new Function('flow', 'return (' + code + ')')(flow)(context))
    runtime.assertReplayComplete()
    return result
  } catch (error) {
    if (!(error instanceof SuspendableActionPending)) throw error
    return error
  } finally {
    restore()
    expect(diagnostics.diagnostics).toEqual([])
  }
}

describe('author.choice.option@2 compiled graph', () => {
  it('accepts a typed map in v3 without leaking container metadata into choices', () => {
    for (const mode of ['single', 'multi'] as const) {
      const original = choiceGraph(mode, 1, mode === 'multi' ? 2 : 1)
      const value: GameplayModuleGraph = { ...original, body: original.body.map(node => node.id === 'options' ? {
        kind: 'call', id: 'options', module: 'map.create', version: '1',
        inputs: { keys: { kind: 'literal', value: ['10', '2', '重复值'] }, values: { kind: 'literal', value: [7, 2, 7] } },
        parameters: { containerType: '{"kind":"map","key":"string","value":"number"}', keysType: '{"kind":"list","element":"string"}', valuesType: '{"kind":"list","element":"number"}' },
      } : node.kind === 'call' && node.id === 'pick' ? {
        ...node, version: '3', inputs: { ...node.inputs, options: { kind: 'output', node: 'options', port: 'value' } },
        parameters: { ...node.parameters, optionsType: '{"kind":"map","key":"string","value":"number"}' },
      } : node) }
      const compiled = compileGameplayModuleGraph(value, GAMEPLAY_MODULE_REGISTRY)
      const source = makePiece({ instanceId: 'source', ownerPlayerId: 'player-red' }), battle = makeState({ pieces: [source] })
      const pending = executeCompiled(compiled.code, battle, source, [])
      if (!(pending instanceof SuspendableActionPending)) throw new Error('expected pending')
      expect(pending.prompt.options).toEqual([
        { label: '10', value: { authorOptionIndex: 1 } },
        { label: '2', value: { authorOptionIndex: 2 } },
        { label: '重复值', value: { authorOptionIndex: 3 } },
      ])
      const selected = mode === 'multi' ? [{ authorOptionIndex: 3 }, { authorOptionIndex: 1 }] : { authorOptionIndex: 2 }
      expect(executeCompiled(compiled.code, battle, source, [{ key: pending.key, input: { selectedOption: selected } }])).toEqual({ value: mode === 'multi' ? [7, 7] : 2 })
    }
  })
  it('opens a real suspendable multi selector with dynamic bounds and selected player', () => {
    const source = makePiece({ instanceId: 'source', ownerPlayerId: 'player-red' })
    const battle = makeState({ pieces: [source] })
    const compiled = compileChoice('multi', 1, 2)

    const first = executeCompiled(compiled.code, battle, source, [])
    expect(first).toBeInstanceOf(SuspendableActionPending)
    if (!(first instanceof SuspendableActionPending)) throw new Error('expected an initial pending interaction')
    expect(first.prompt).toMatchObject({
      kind: 'option', playerId: 'player-red', title: 'v2 choice', selectionMode: 'multi', minSelections: 1, maxSelections: 2,
    })
    expect(first.prompt.options).toEqual([
      { label: 'first', value: { authorOptionIndex: 1 } },
      { label: 'second', value: { authorOptionIndex: 2 } },
      { label: 'third', value: { authorOptionIndex: 3 } },
    ])

    const replay = executeCompiled(compiled.code, battle, source, [{
      key: first.key,
      input: { selectedOption: [{ authorOptionIndex: 3 }] },
    }])
    expect(replay).toEqual({ value: [2] })

    const duplicateValues = executeCompiled(compiled.code, battle, source, [{
      key: first.key,
      input: { selectedOption: [{ authorOptionIndex: 2 }, { authorOptionIndex: 1 }] },
    }])
    expect(duplicateValues).toEqual({ value: [7, 7] })
  })

  it('keeps single mode scalar and validates the multi return type at compile time', () => {
    const source = makePiece({ instanceId: 'source', ownerPlayerId: 'player-red' })
    const battle = makeState({ pieces: [source] })
    const compiled = compileChoice('single', 1, 1)
    const first = executeCompiled(compiled.code, battle, source, [])
    expect(first).toBeInstanceOf(SuspendableActionPending)
    if (!(first instanceof SuspendableActionPending)) throw new Error('expected an initial pending interaction')
    expect(first.prompt).toMatchObject({ selectionMode: 'single', minSelections: 1, maxSelections: 1 })

    expect(executeCompiled(compiled.code, battle, source, [{
      key: first.key,
      input: { selectedOption: { authorOptionIndex: 2 } },
    }])).toEqual({ value: 7 })

    expect(() => compileChoice('multi', 1, 2, 'number')).toThrow(/expects list<number>|多选返回值必须是元组类型/)
    const descriptor = getGameplayModule('author.choice.option', '2')
    if (!descriptor) throw new Error('missing author.choice.option@2')
    expect(() => descriptor.lower({
      surface: 'skill', callId: 'mutation', moduleId: descriptor.id, moduleVersion: descriptor.version,
      inputs: { options: 'options', minSelections: '1', maxSelections: '2' },
      parameters: { selectionMode: 'multi', valueType: 'number' }, outputPorts: descriptor.outputs,
      emitLiteral: value => JSON.stringify(value),
    })).toThrow('多选返回值必须是元组类型')
  })
})
