import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import {
  GAMEPLAY_MODULE_COMPILER_V3_VERSION,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayLiteral,
  type GameplayModuleDescriptor,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'

const version = '1'

function registryOf(...descriptors: GameplayModuleDescriptor[]): GameplayModuleRegistry {
  const byKey = new Map(descriptors.map(descriptor => [descriptor.id + '@' + descriptor.version, descriptor]))
  return { get: (id, requestedVersion) => byKey.get(id + '@' + (requestedVersion ?? version)) }
}

function descriptor(
  id: string,
  inputs: GameplayModuleDescriptor['inputs'],
  outputs: GameplayModuleDescriptor['outputs'],
  lower: GameplayModuleDescriptor['lower'],
): GameplayModuleDescriptor {
  return { id, version, label: id, inputs, outputs, allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower }
}

function graph(body: GameplayModuleGraph['body'], extra: Partial<GameplayModuleGraph> = {}): GameplayModuleGraph {
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body, ...extra }
}

function literal(value: GameplayLiteral): GameplayValue {
  return { kind: 'literal', value }
}

function input(name: string): GameplayValue {
  return { kind: 'input', name }
}

function output(node: string, port = 'value'): GameplayValue {
  return { kind: 'output', node, port }
}

function call(id: string, module: string, inputs: Readonly<Record<string, GameplayValue>> = {}) {
  return { kind: 'call' as const, id, module, version, inputs }
}

function execute(code: string, context: Record<string, unknown>): unknown {
  return (runInNewContext('(' + code + ')') as (value: Record<string, unknown>) => unknown)(context)
}

function find(
  kind: 'collection' | 'collection.find',
  items: GameplayValue,
  body: GameplayModuleGraph['body'],
  extra: Record<string, unknown> = {},
) {
  return {
    kind,
    id: 'found',
    ...(kind === 'collection' ? { method: 'find' } : {}),
    items,
    ...extra,
    body,
  } as never
}

describe('structural collection.find', () => {
  it('normalizes the collection.find alias, returns the first match, and stops', () => {
    const predicate = descriptor(
      'test.match-second',
      [{ name: 'value', type: 'number' }],
      [{ name: 'value', type: 'boolean' }],
      ({ inputs }) => ({
        statements: 'context.visits.push(' + inputs.value + ');',
        result: '({value: ' + inputs.value + ' === 2})',
      }),
    )
    const compiled = compileGameplayModuleGraph(graph([
      find('collection.find', literal([1, 2, 3]), [
        call('predicate', predicate.id, { value: input('candidate') }),
        { kind: 'return', id: 'predicate-result', value: output('predicate') },
      ], { item: 'candidate' }),
      { kind: 'return', id: 'done', values: { result: output('found') } },
    ], { outputs: [{ name: 'result', type: { kind: 'nullable', value: 'number' } }] }), registryOf(predicate))

    const context = { visits: [] as number[] }
    expect(execute(compiled.code, context)).toEqual({ result: 2 })
    expect(context.visits).toEqual([1, 2])
  })

  it('returns null when the predicate never matches', () => {
    const predicate = descriptor(
      'test.never-match',
      [{ name: 'value', type: 'number' }],
      [{ name: 'value', type: 'boolean' }],
      () => ({ expression: '({value: false})' }),
    )
    const compiled = compileGameplayModuleGraph(graph([
      find('collection', literal([3, 4]), [
        call('predicate', predicate.id, { value: input('item') }),
        { kind: 'return', id: 'predicate-result', value: output('predicate') },
      ]),
      { kind: 'return', id: 'done', values: { result: output('found') } },
    ], { outputs: [{ name: 'result', type: { kind: 'nullable', value: 'number' } }] }), registryOf(predicate))

    expect(execute(compiled.code, {})).toEqual({ result: null })
  })

  it('enforces the deterministic collection iteration bound at runtime', () => {
    const predicate = descriptor(
      'test.bound-never-match',
      [{ name: 'value', type: 'number' }],
      [{ name: 'value', type: 'boolean' }],
      () => ({ expression: '({value: false})' }),
    )
    const compiled = compileGameplayModuleGraph(graph([
      find('collection.find', input('items'), [
        call('predicate', predicate.id, { value: input('item') }),
        { kind: 'return', id: 'predicate-result', value: output('predicate') },
      ]),
      { kind: 'return', id: 'done', values: { result: output('found') } },
    ], {
      inputs: [{ name: 'items', type: { kind: 'list', element: 'number' } }],
      inputBindings: { items: [1, 2, 3] },
      outputs: [{ name: 'result', type: { kind: 'nullable', value: 'number' } }],
    }), registryOf(predicate), { maxCollectionIterations: 2 })

    expect(() => execute(compiled.code, {})).toThrow(/collection iteration budget exceeded/)
  })

  it('requires a boolean predicate and exposes a nullable element result', () => {
    const numberPredicate = graph([
      find('collection.find', literal([1]), [
        { kind: 'return', id: 'bad-predicate', value: literal(1) },
      ]),
    ], { outputs: [{ name: 'result', type: { kind: 'nullable', value: 'number' } }] })
    expect(() => compileGameplayModuleGraph(numberPredicate, registryOf())).toThrow(/find body must return boolean/)

    const predicate = descriptor(
      'test.true',
      [{ name: 'value', type: 'number' }],
      [{ name: 'value', type: 'boolean' }],
      () => ({ expression: '({value: true})' }),
    )
    const incompatibleResult = graph([
      find('collection.find', literal([1]), [
        call('predicate', predicate.id, { value: input('item') }),
        { kind: 'return', id: 'predicate-result', value: output('predicate') },
      ]),
      { kind: 'return', id: 'done', values: { result: output('found') } },
    ], { outputs: [{ name: 'result', type: 'number' }] })
    expect(() => compileGameplayModuleGraph(incompatibleResult, registryOf(predicate))).toThrow(/expects number, got nullable<number>/)
  })

  it('invalidates an invalid capture while an independent continuation still runs', () => {
    const invalid = descriptor(
      'test.invalid-capture',
      [],
      [{ name: 'value', type: 'number' }],
      () => ({ expression: '__gameplayInvalid' }),
    )
    const predicate = descriptor(
      'test.should-not-run',
      [{ name: 'value', type: 'number' }, { name: 'captured', type: 'number' }],
      [{ name: 'value', type: 'boolean' }],
      ({ inputs }) => ({
        statements: 'context.visits.push(' + inputs.value + ');',
        result: '({value: true})',
      }),
    )
    const tail = descriptor(
      'test.independent-tail',
      [],
      [],
      () => ({ expression: 'context.events.push("tail")' }),
    )
    const compiled = compileGameplayModuleGraph(graph([
      call('invalid', invalid.id),
      find('collection.find', literal([1, 2]), [
        call('predicate', predicate.id, { value: input('item'), captured: input('captured') }),
        { kind: 'return', id: 'predicate-result', value: output('predicate') },
      ], { inputs: { captured: output('invalid') } }),
      call('tail', tail.id),
      { kind: 'return', id: 'done', values: { result: output('found') } },
    ], { outputs: [{ name: 'result', type: { kind: 'nullable', value: 'number' } }] }), registryOf(invalid, predicate, tail))

    const context = { visits: [] as number[], events: [] as string[] }
    expect(execute(compiled.code, context)).toBeUndefined()
    expect(context.visits).toEqual([])
    expect(context.events).toEqual(['tail'])
  })

  it('skips an invalid item predicate and continues to the next item', () => {
    const predicate = descriptor(
      'test.invalid-first-predicate',
      [{ name: 'value', type: 'number' }],
      [{ name: 'value', type: 'boolean' }],
      ({ inputs }) => ({
        statements: 'context.visits.push(' + inputs.value + ');',
        result: '({value: (' + inputs.value + ' === 1 ? __gameplayInvalid : ' + inputs.value + ' === 2)})',
      }),
    )
    const compiled = compileGameplayModuleGraph(graph([
      find('collection.find', literal([1, 2, 3]), [
        call('predicate', predicate.id, { value: input('item') }),
        { kind: 'return', id: 'predicate-result', value: output('predicate') },
      ]),
      { kind: 'return', id: 'done', values: { result: output('found') } },
    ], { outputs: [{ name: 'result', type: { kind: 'nullable', value: 'number' } }] }), registryOf(predicate))

    const context = { visits: [] as number[] }
    expect(execute(compiled.code, context)).toEqual({ result: 2 })
    expect(context.visits).toEqual([1, 2])
  })

  it('does not take an if else branch when its v3 condition is invalid', () => {
    const invalidCondition = descriptor(
      'test.invalid-condition',
      [{ name: 'value', type: 'number' }],
      [{ name: 'value', type: 'boolean' }],
      () => ({ expression: '__gameplayInvalid' }),
    )
    const tail = descriptor(
      'test.if-tail',
      [],
      [],
      () => ({ expression: 'context.events.push("tail")' }),
    )
    const compiled = compileGameplayModuleGraph(graph([
      find('collection.find', literal([1, 2]), [
        call('condition', invalidCondition.id, { value: input('item') }),
        {
          kind: 'if',
          id: 'predicate-branch',
          condition: output('condition'),
          then: [{ kind: 'return', id: 'match', value: literal(true) }],
          else: [{ kind: 'return', id: 'fallback-match', value: literal(true) }],
        },
      ]),
      call('tail', tail.id),
      { kind: 'return', id: 'done', values: { result: output('found') } },
    ], { outputs: [{ name: 'result', type: { kind: 'nullable', value: 'number' } }] }), registryOf(invalidCondition, tail))

    expect(compiled.compilerVersion).toBe(GAMEPLAY_MODULE_COMPILER_V3_VERSION)
    const context = { events: [] as string[] }
    expect(execute(compiled.code, context)).toEqual({ result: null })
    expect(context.events).toEqual(['tail'])
  })

  it('allows a legitimate null capture to reach a nullable predicate input', () => {
    const nullableCapture = descriptor(
      'test.null-capture',
      [],
      [{ name: 'value', type: 'string', nullable: true }],
      () => ({ expression: 'null' }),
    )
    const predicate = descriptor(
      'test.matches-null-capture',
      [{ name: 'value', type: 'number' }, { name: 'captured', type: 'string', nullable: true }],
      [{ name: 'value', type: 'boolean' }],
      ({ inputs }) => ({ expression: '({value: ' + inputs.captured + ' === null})' }),
    )
    const compiled = compileGameplayModuleGraph(graph([
      call('capture', nullableCapture.id),
      find('collection.find', literal([7, 8]), [
        call('predicate', predicate.id, { value: input('item'), captured: input('captured') }),
        { kind: 'return', id: 'predicate-result', value: output('predicate') },
      ], { inputs: { captured: output('capture') } }),
      { kind: 'return', id: 'done', values: { result: output('found') } },
    ], { outputs: [{ name: 'result', type: { kind: 'nullable', value: 'number' } }] }), registryOf(nullableCapture, predicate))

    expect(execute(compiled.code, {})).toEqual({ result: 7 })
  })
})
