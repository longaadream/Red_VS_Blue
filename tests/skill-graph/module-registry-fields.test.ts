import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleDescriptor, type GameplayModuleGraph, type GameplayValue } from '../../lib/skill-graph/module-types'
import { GAMEPLAY_MODULE_REGISTRY, getGameplayModule, getGameplayModuleCatalog } from '../../lib/skill-graph/module-registry'

const version = '1'
const value = (value: unknown): GameplayValue => ({ kind: 'literal', value: value as never })
const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const call = (id: string, module: string, inputs: Record<string, GameplayValue> = {}, parameters: Record<string, unknown> = {}) => ({
  kind: 'call' as const, id, module, version, inputs, parameters: parameters as Record<string, never>,
})
const graph = (
  body: GameplayModuleGraph['body'],
  outputs: GameplayModuleGraph['outputs'] = [],
  extra: Partial<GameplayModuleGraph> = {},
): GameplayModuleGraph => ({
  version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body, outputs, ...extra,
})

describe('trusted generic field readers', () => {
  it('registers field readers and parameter-bound output types', () => {
    expect(getGameplayModule('piece.field')).toBeDefined()
    expect(getGameplayModule('player.field')).toBeDefined()
    expect(getGameplayModule('event.field')).toBeDefined()
    expect(getGameplayModule('data.field')).toBeDefined()
    expect(getGameplayModule('battle.field')).toBeDefined()
    expect(getGameplayModule('result.field')).toBeDefined()
    expect(getGameplayModule('source.fields')?.outputs).toEqual([{ name: 'record', type: 'record' }])
    expect(getGameplayModule('status.fields')?.outputs).toEqual([{ name: 'record', type: 'record' }])
  })

  it('infers the selected field type before validating graph consumers', () => {
    const compiled = compileGameplayModuleGraph(graph([
      call('target', 'ref.target'),
      call('hp', 'piece.field', { piece: output('target', 'piece') }, { field: 'currentHp' }),
      { kind: 'return', id: 'done', value: output('hp') },
    ], [{ name: 'value', type: 'number' }]), GAMEPLAY_MODULE_REGISTRY)
    expect(compiled.code).toContain('query.piece')

    expect(() => compileGameplayModuleGraph(graph([
      call('target', 'ref.target'),
      call('hp', 'piece.field', { piece: output('target', 'piece') }, { field: 'currentHp' }),
      { kind: 'return', id: 'done', value: output('hp') },
    ], [{ name: 'value', type: 'string' }]), GAMEPLAY_MODULE_REGISTRY)).toThrow(/expects string|port type|number/)
  })

  it('rejects fields outside the trusted closed field table', () => {
    expect(() => compileGameplayModuleGraph(graph([
      call('target', 'ref.target'),
      call('read', 'piece.field', { piece: output('target', 'piece') }, { field: 'not-a-piece-field' }),
    ]), GAMEPLAY_MODULE_REGISTRY)).toThrow(/enum|field|parameter/)
  })

  it('rejects descriptor metadata that binds an output to an unknown parameter', () => {
    const piece = getGameplayModule('piece.field')!
    const malicious: GameplayModuleDescriptor = {
      ...piece,
      outputParameterTypeBindings: {
        value: { parameter: 'authorSuppliedPath', types: { currentHp: 'number' } },
      },
    }
    const registry = {
      get: (id: string, requestedVersion?: string) => id === malicious.id && requestedVersion === malicious.version
        ? malicious
        : GAMEPLAY_MODULE_REGISTRY.get(id, requestedVersion),
    }
    expect(() => compileGameplayModuleGraph(graph([
      call('target', 'ref.target'),
      call('hp', 'piece.field', { piece: output('target', 'piece') }, { field: 'currentHp' }),
    ]), registry)).toThrow(/field type binding parameter/)
  })

  it('allows trusted value bindings to inspect opaque references without live guards', () => {
    const compareValues: GameplayModuleDescriptor = {
      id: 'test.compare-values', version, label: 'test.compare-values',
      inputs: [{ name: 'left', type: 'record' }, { name: 'right', type: 'record' }],
      outputs: [{ name: 'value', type: 'boolean' }],
      inputValueTypeBindings: {
        left: { parameter: 'valueType' },
        right: { parameter: 'valueType' },
      },
      parameters: [{ name: 'valueType', type: 'string' }],
      inspectReferences: ['left', 'right'],
      allowedSurfaces: ['skill'],
      effects: { pure: true, previewSafe: true },
      lower: ({ inputs }) => ({ expression: '({value: (' + inputs.left + ' === ' + inputs.right + ')})' }),
    }
    const registry = {
      get: (id: string, requestedVersion?: string) => id === compareValues.id && requestedVersion === compareValues.version
        ? compareValues
        : GAMEPLAY_MODULE_REGISTRY.get(id, requestedVersion),
    }
    const compiled = compileGameplayModuleGraph(graph([
      call('left', 'ref.target'),
      call('right', 'ref.target'),
      call('same', compareValues.id, {
        left: output('left', 'piece'),
        right: output('right', 'piece'),
      }, { valueType: 'piece' }),
      { kind: 'return', id: 'done', value: output('same') },
    ], [{ name: 'value', type: 'boolean' }]), registry)
    expect(compiled.code).not.toContain('query.hasPiece')
    const execute = runInNewContext('(' + compiled.code + ')', {
      flow: {
        refs: { target: () => 'opaque-id' },
        query: { hasPiece: () => { throw new Error('opaque identity must not resolve a live piece') } },
      },
    }) as (context: unknown) => unknown
    expect(execute({})).toEqual(true)
  })

  it('allows a typed list field to drive a record field filter', () => {
    const compiled = compileGameplayModuleGraph(graph([
      call('target', 'ref.target'),
      call('tags', 'piece.field', { piece: output('target', 'piece') }, { field: 'statusTags' }),
      {
        kind: 'collection', id: 'matching', method: 'filter', items: output('tags'), item: 'tag',
        body: [
          call('type', 'data.field', { record: { kind: 'input', name: 'tag' } }, { field: 'type' }),
          call('same', 'compare.equal-string', { left: output('type'), right: value('freeze') }),
          { kind: 'return', id: 'keep', value: output('same') },
        ],
      },
      { kind: 'return', id: 'done', value: output('matching') },
    ], [{ name: 'value', type: { kind: 'list', element: 'record' } }]), GAMEPLAY_MODULE_REGISTRY)
    expect(compiled.code).toContain('statusTags')
  })

  it('reads HP0 pieces and historical source snapshots without exposing host objects', () => {
    const compiled = compileGameplayModuleGraph(graph([
      call('target', 'ref.target'),
      call('hp', 'piece.field', { piece: output('target', 'piece') }, { field: 'currentHp' }),
      call('captured', 'source.capture-event-piece', {}, { field: 'piece' }),
      call('source', 'source.require-present', { source: output('captured', 'source') }),
      call('fields', 'source.fields', { source: output('source', 'source') }, {}),
      call('id', 'data.field', { record: output('fields', 'record') }, { field: 'id' }),
      { kind: 'return', id: 'done', values: { hp: output('hp'), id: output('id') } },
    ], [{ name: 'hp', type: 'number' }, { name: 'id', type: { kind: 'nullable', value: 'string' } }]), GAMEPLAY_MODULE_REGISTRY)
    const flow = {
      refs: { target: () => 'target' },
      query: {
        hasPiece: () => true,
        piece: () => ({ currentHp: 0, statusTags: [] }),
        pieceText: () => 'target',
      },
      effects: {
        captureEventPiece: () => ({ scope: 'execution-source', id: 'target' }),
        capturedOwner: () => 'owner',
        capturedFields: () => ({ id: 'target', statusTags: [] }),
      },
    }
    const execute = runInNewContext('(' + compiled.code + ')', { flow }) as (context: unknown) => unknown
    const result = execute({}) as { hp: number; id: string }
    expect(result).toEqual({ hp: 0, id: 'target' })
  })

  it('keeps record values opaque while exposing battle and result fields', () => {
    const compiled = compileGameplayModuleGraph(graph([
      call('captured', 'source.capture-event-piece', {}, { field: 'piece' }),
      call('source', 'source.fields', { source: output('captured', 'source') }),
      call('recordValue', 'result.field', { record: output('source', 'record') }, { field: 'targetId' }),
      call('resultDamage', 'result.field', { record: output('source', 'record') }, { field: 'damage' }),
      call('battleTurn', 'battle.field', {}, { field: 'turnNumber' }),
      { kind: 'return', id: 'done', values: {
        targetId: output('recordValue'), damage: output('resultDamage'), turn: output('battleTurn'),
      } },
    ], [
      { name: 'targetId', type: { kind: 'nullable', value: 'piece' } },
      { name: 'damage', type: 'number' },
      { name: 'turn', type: 'number' },
    ]), GAMEPLAY_MODULE_REGISTRY)
    const flow = {
      effects: {
        captureEventPiece: () => ({ scope: 'execution-source', id: 'target' }),
        capturedFields: () => ({ value: 'user-record-value', targetId: 'target', damage: undefined }),
      },
    }
    const battle = { turn: { turnNumber: 7 } }
    const execute = runInNewContext('(' + compiled.code + ')', { flow, battle }) as (context: unknown) => unknown
    expect(execute({})).toEqual({ targetId: 'target', damage: 0, turn: 7 })
  })

  it('normalizes legacy status strings and copies list values', () => {
    const compiled = compileGameplayModuleGraph(graph([
      call('captured', 'source.capture-event-piece', {}, { field: 'piece' }),
      call('source', 'source.fields', { source: output('captured', 'source') }),
      call('legacy', 'data.field', { record: output('source', 'record') }, { field: 'legacyText' }),
      call('tags', 'data.field', { record: output('source', 'record') }, { field: 'statusTags' }),
      call('skills', 'data.field', { record: output('source', 'record') }, { field: 'skillIds' }),
      { kind: 'return', id: 'done', values: { legacy: output('legacy'), tags: output('tags'), skills: output('skills') } },
    ], [
      { name: 'legacy', type: { kind: 'nullable', value: 'string' } },
      { name: 'tags', type: { kind: 'list', element: 'record' } },
      { name: 'skills', type: { kind: 'list', element: 'string' } },
    ]), GAMEPLAY_MODULE_REGISTRY)
    const flow = {
      effects: {
        captureEventPiece: () => ({ scope: 'execution-source', id: 'target' }),
        capturedFields: () => ({ _legacyText: 'freeze', statusTags: ['burn'], skillIds: ['one', 'two'] }),
      },
    }
    const execute = runInNewContext('(' + compiled.code + ')', { flow }) as (context: unknown) => unknown
    expect(execute({})).toEqual({ legacy: 'freeze', tags: [{ _legacyText: 'burn' }], skills: ['one', 'two'] })
  })

  it('publishes field bindings and nullable comparison v2 metadata', () => {
    const piece = getGameplayModule('piece.field')!
    expect(piece.outputParameterTypeBindings?.value.parameter).toBe('field')
    expect(piece.outputParameterTypeBindings?.value.types.currentHp).toBe('number')
    expect(Object.isFrozen(piece.outputParameterTypeBindings)).toBe(true)
    expect(Object.isFrozen(piece.outputParameterTypeBindings?.value.types)).toBe(true)
    expect(getGameplayModule('data.field')?.outputParameterTypeBindings?.value.types.targetId).toEqual({ kind: 'nullable', value: 'string' })
    expect(getGameplayModule('result.field')?.outputParameterTypeBindings?.value.types.targetId).toEqual({ kind: 'nullable', value: 'piece' })
    expect(getGameplayModule('compare.equal-string', '1')).toBeDefined()
    expect(getGameplayModule('compare.text', '2')).toBeDefined()
    expect(getGameplayModule('compare.equal-string-nullable', '2')).toBeDefined()
    const catalog = getGameplayModuleCatalog().find(item => item.id === 'piece.field')!
    expect(catalog.outputParameterTypeBindings?.value.types.statusTags).toEqual({ kind: 'list', element: 'record' })
    expect(Object.isFrozen(GAMEPLAY_MODULE_REGISTRY.descriptors)).toBe(true)
  })
})
