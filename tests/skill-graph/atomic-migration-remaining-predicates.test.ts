import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  ATOMIC_REMAINING_PREDICATE_MODULES,
  migrateRemainingPredicateModules,
} from '../../lib/skill-graph/atomic-migration-remaining-predicates'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { AMATERASU_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-amaterasu'
import { CONTEXT_FIELD_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-context-fields'
import { COUNTER_PASSIVE_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-counter-passives'
import { DAMAGE_REDIRECT_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-damage-redirect'
import { FIELD_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-fields'
import { GENERIC_READ_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-generic-reads'
import { GENERIC_VALUE_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-generic-values'
import { COLLECTION_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-collections'
import { SCALAR_VALUE_MODULES } from '../../lib/skill-graph/module-registry-scalar-values'
import { ABILITY_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-abilities'
import { LAMENT_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-lament'
import { PENDING_SPATIAL_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-pending-spatial'
import { SHISHIO_VELEN_COLT_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-shishio-velen-colt'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayCallStatement,
  type GameplayJsonValue,
  type GameplayModuleDescriptor,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayStatement,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'

const version = '1'

const input = (name: string): GameplayValue => ({ kind: 'input', name })
const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters?: Readonly<Record<string, GameplayJsonValue>>,
): GameplayCallStatement {
  return {
    kind: 'call', id, module, version, inputs,
    ...(parameters === undefined ? {} : { parameters }),
  }
}

function graph(body: readonly GameplayStatement[], extra: Partial<GameplayModuleGraph> = {}): GameplayModuleGraph {
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'rule', body, ...extra }
}

function callsIn(body: readonly GameplayStatement[]): GameplayCallStatement[] {
  const result: GameplayCallStatement[] = []
  const visit = (statements: readonly GameplayStatement[]): void => {
    for (const statement of statements) {
      if (statement.kind === 'call') result.push(statement)
      if (statement.kind === 'if') {
        visit(statement.then)
        if (statement.else) visit(statement.else)
      } else if (statement.kind === 'while') {
        visit(statement.condition.body)
        visit(statement.body)
      } else if (statement.kind === 'foreach') {
        visit(statement.body)
      } else if (statement.kind === 'collection' || statement.kind === 'collection.map' || statement.kind === 'collection.filter' || statement.kind === 'collection.find' || statement.kind === 'collection.reduce') {
        visit(statement.body)
      }
    }
  }
  visit(body)
  return result
}

const testChoice: GameplayModuleDescriptor = {
  id: 'test.choice', version, label: 'test.choice',
  inputs: [], outputs: [{ name: 'choice', type: 'choice', nullable: true, optional: true }],
  allowedSurfaces: ['rule'], effects: { pure: true, previewSafe: true, reads: ['choice'] },
  lower: () => 'context.choice',
}

const testPiece: GameplayModuleDescriptor = {
  id: 'test.piece', version, label: 'test.piece',
  inputs: [], outputs: [{ name: 'piece', type: 'piece', nullable: true }],
  allowedSurfaces: ['rule'], effects: { pure: true, previewSafe: true, reads: ['pieces'] },
  lower: () => 'context.pieceId',
}

const logicAnd: GameplayModuleDescriptor = {
  id: 'logic.and', version, label: 'logic.and',
  inputs: [{ name: 'left', type: 'boolean' }, { name: 'right', type: 'boolean' }],
  outputs: [{ name: 'value', type: 'boolean' }], allowedSurfaces: ['rule'],
  effects: { pure: true, previewSafe: true },
  lower: ctx => `(${ctx.inputs.left} && ${ctx.inputs.right})`,
}

const logicOr: GameplayModuleDescriptor = {
  id: 'logic.or', version, label: 'logic.or',
  inputs: [{ name: 'left', type: 'boolean' }, { name: 'right', type: 'boolean' }],
  outputs: [{ name: 'value', type: 'boolean' }], allowedSurfaces: ['rule'],
  effects: { pure: true, previewSafe: true },
  lower: ctx => `(${ctx.inputs.left} || ${ctx.inputs.right})`,
}

const legacyNumberOrZero: GameplayModuleDescriptor = {
  id: 'value.number-or-zero', version, label: 'legacy number-or-zero',
  inputs: [{ name: 'value', type: 'number', nullable: true }], outputs: [{ name: 'value', type: 'number' }],
  allowedSurfaces: ['rule'], effects: { pure: true, previewSafe: true },
  lower: ctx => `Math.max(0, ${ctx.inputs.value} ?? 0)`,
}

const baseDescriptors = [
  ...AMATERASU_GAMEPLAY_MODULES,
  ...CONTEXT_FIELD_GAMEPLAY_MODULES,
  ...COUNTER_PASSIVE_GAMEPLAY_MODULES,
  ...DAMAGE_REDIRECT_GAMEPLAY_MODULES,
  ...ABILITY_GAMEPLAY_MODULES,
  ...COLLECTION_GAMEPLAY_MODULES,
  ...FIELD_GAMEPLAY_MODULES,
  ...GENERIC_VALUE_GAMEPLAY_MODULES,
  ...SCALAR_VALUE_MODULES,
  ...LAMENT_GAMEPLAY_MODULES,
  ...PENDING_SPATIAL_GAMEPLAY_MODULES,
  ...SHISHIO_VELEN_COLT_GAMEPLAY_MODULES,
]
const baseByKey = new Map(baseDescriptors.map(descriptor => [`${descriptor.id}@${descriptor.version}`, descriptor]))
const extraDescriptors = [testChoice, testPiece, logicAnd, logicOr, legacyNumberOrZero, ...GENERIC_READ_GAMEPLAY_MODULES]
const extraByKey = new Map(extraDescriptors.map(descriptor => [`${descriptor.id}@${descriptor.version}`, descriptor]))

function testRegistry(): GameplayModuleRegistry {
  const get = (id: string, requestedVersion?: string): GameplayModuleDescriptor | undefined => {
    const key = `${id}@${requestedVersion ?? version}`
    return extraByKey.get(key) ?? baseByKey.get(key)
  }
  const descriptors = [...baseDescriptors]
  const existing = new Set(descriptors.map(descriptor => `${descriptor.id}@${descriptor.version}`))
  for (const descriptor of extraDescriptors) {
    const key = `${descriptor.id}@${descriptor.version}`
    if (!existing.has(key)) descriptors.push(descriptor)
  }
  return { get, resolve: get, descriptors }
}

function execute(
  source: GameplayModuleGraph,
  globals: Readonly<Record<string, unknown>> = {},
  context: Readonly<Record<string, unknown>> = {},
): { compiled: ReturnType<typeof compileGameplayModuleGraph>; value: unknown } {
  const compiled = compileGameplayModuleGraph(source, testRegistry())
  const run = source.surface === 'rule'
    ? runInNewContext('(function(context){' + compiled.code + '})', globals) as (context: unknown) => unknown
    : runInNewContext('(' + compiled.code + ')', globals) as (context: unknown) => unknown
  return { compiled, value: run(context) }
}

describe('remaining atomic predicate migrations', () => {
  it('rewrites all remaining aliases in nested scopes and is idempotent', () => {
    const source = graph([
      call('owner', 'rule.authorized-by-owner'),
      call('piece-position', 'piece.has-position', { piece: input('piece') }),
      call('spatial-position', 'spatial.has-position', { piece: input('piece') }),
      call('length', 'choice.array-length', { choice: input('choice') }),
      call('duplicate', 'choice.array-has-duplicate', { choice: input('choice') }),
    ], {
      inputs: [
        { name: 'piece', type: 'piece' },
        { name: 'choice', type: 'choice', nullable: true, optional: true },
      ],
      composites: [{
        id: 'nested', version, inputs: [], outputs: [],
        body: [call('nested-owner', 'rule.authorized-by-owner')],
      }],
      continuations: [{
        id: 'later', version,
        graph: graph([call('later-length', 'choice.array-length', { choice: input('choice') })]),
      }],
    })
    const migrated = migrateRemainingPredicateModules(source)
    const modules = callsIn(migrated.body).map(statement => statement.module)
    expect(modules).not.toEqual(expect.arrayContaining([...ATOMIC_REMAINING_PREDICATE_MODULES]))
    expect(modules).toEqual(expect.arrayContaining([
      'battle.field', 'context.field', 'compare.values', 'logic.or',
      'piece.optional-field', 'value.is-finite', 'logic.and', 'choice.as-array', 'collection.length', 'collection.distinct',
    ]))
    expect(migrateRemainingPredicateModules(migrated)).toEqual(migrated)
    expect(callsIn(migrated.composites![0].body).map(statement => statement.module)).not.toContain('rule.authorized-by-owner')
    expect(callsIn(migrated.continuations![0].graph.body).map(statement => statement.module)).not.toContain('choice.array-length')
  })

  it('preserves owner authorization for missing, empty, matching, and different owners', () => {
    const source = graph([
      call('authorized', 'rule.authorized-by-owner', {}, { storageKey: 'amaterasuOwnerPlayerId' }),
      { kind: 'return', id: 'done', value: output('authorized', 'authorized') },
    ], { outputs: [{ name: 'authorized', type: 'boolean' }] })
    const cases: ReadonlyArray<{ extensions?: Record<string, unknown>; playerId: string; expected: boolean }> = [
      { extensions: undefined, playerId: 'red', expected: true },
      { extensions: { amaterasuOwnerPlayerId: '' }, playerId: 'red', expected: true },
      { extensions: { amaterasuOwnerPlayerId: 'red' }, playerId: 'red', expected: true },
      { extensions: { amaterasuOwnerPlayerId: 'red' }, playerId: 'blue', expected: false },
    ]
    for (const testCase of cases) {
      const globals = { battle: { extensions: testCase.extensions }, context: testCase }
      const original = execute(source, globals, testCase)
      const migrated = execute(migrateRemainingPredicateModules(source), globals, testCase)
      expect(migrated.value, JSON.stringify(testCase)).toEqual(original.value)
      expect(migrated.value).toBe(testCase.expected)
    }
  })

  it('preserves finite and nullable coordinate semantics for both position aliases', () => {
    const source = graph([
      call('piece', 'test.piece'),
      call('finite', 'piece.has-position', { piece: output('piece', 'piece') }),
      call('nullable', 'spatial.has-position', { piece: output('piece', 'piece') }),
      { kind: 'return', id: 'done', values: { finite: output('finite'), nullable: output('nullable') } },
    ], {
      outputs: [{ name: 'finite', type: 'boolean' }, { name: 'nullable', type: 'boolean' }],
    })
    const cases: ReadonlyArray<{ x: unknown; y: unknown; finite: boolean; nullable: boolean }> = [
      { x: 0, y: -2, finite: true, nullable: true },
      { x: Number.NaN, y: 1, finite: false, nullable: true },
      { x: Number.POSITIVE_INFINITY, y: 1, finite: false, nullable: true },
      { x: null, y: 1, finite: false, nullable: false },
      { x: 0, y: null, finite: false, nullable: false },
      { x: undefined, y: 1, finite: false, nullable: false },
      { x: '3', y: 1, finite: false, nullable: true },
    ]
    for (const testCase of cases) {
      const piece = { x: testCase.x, y: testCase.y }
      const globals = {
        flow: { query: { piece: (id: unknown) => id === 'target' ? piece : null } },
      }
      const context = { pieceId: 'target' }
      const original = execute(source, globals, context)
      const migrated = execute(migrateRemainingPredicateModules(source), globals, context)
      expect(migrated.value, JSON.stringify(testCase)).toEqual(original.value)
      expect(migrated.value).toEqual({ finite: testCase.finite, nullable: testCase.nullable })
    }
  })

  it('keeps raw choice identity and SameValueZero duplicate behavior', () => {
    const source = graph([
      call('choice', 'test.choice'),
      call('length', 'choice.array-length', { choice: output('choice', 'choice') }),
      call('duplicate', 'choice.array-has-duplicate', { choice: output('choice', 'choice') }),
      { kind: 'return', id: 'done', values: { length: output('length', 'count'), duplicate: output('duplicate', 'duplicate') } },
    ], {
      outputs: [{ name: 'length', type: 'number' }, { name: 'duplicate', type: 'boolean' }],
    })
    const shared = { id: 'same' }
    const cases: ReadonlyArray<{ choice: unknown; length: number; duplicate: boolean }> = [
      { choice: [shared, shared], length: 2, duplicate: true },
      { choice: [{ id: 'same' }, { id: 'same' }], length: 2, duplicate: false },
      { choice: [Number.NaN, Number.NaN], length: 2, duplicate: true },
      { choice: null, length: 0, duplicate: false },
      { choice: 'cancelled', length: 0, duplicate: false },
    ]
    for (const testCase of cases) {
      const original = execute(source, {}, { choice: testCase.choice })
      const migrated = execute(migrateRemainingPredicateModules(source), {}, { choice: testCase.choice })
      expect(migrated.value).toEqual(original.value)
      expect(migrated.value).toEqual({ length: testCase.length, duplicate: testCase.duplicate })
    }
  })

  it('preserves simple skill, ability, scalar, text, and singleton aliases', () => {
    const source = graph([
      call('piece', 'test.piece'),
      call('identifiers', 'skill.identifiers', { piece: output('piece', 'piece') }),
      call('spent', 'ability.was-spent', { piece: output('piece', 'piece') }, { abilityId: 'dash' }),
      call('single', 'collection.single-piece-list', { piece: output('piece', 'piece') }),
      call('number', 'value.number-or-zero', { value: input('number') }),
      call('text', 'text.strip-leading-comma', { text: input('text') }),
      { kind: 'return', id: 'done', values: {
        identifiers: output('identifiers', 'ids'),
        spent: output('spent'),
        single: output('single', 'pieces'),
        number: output('number'),
        text: output('text'),
      } },
    ], {
      inputs: [
        { name: 'number', type: 'number', nullable: true },
        { name: 'text', type: 'string' },
      ],
      inputBindings: { number: null, text: 'placeholder' },
      outputs: [
        { name: 'identifiers', type: { kind: 'list', element: 'string' } },
        { name: 'spent', type: 'boolean' },
        { name: 'single', type: { kind: 'list', element: 'piece' } },
        { name: 'number', type: 'number' },
        { name: 'text', type: 'string' },
      ],
    })
    const cases: ReadonlyArray<{
      piece: { skills?: unknown; spentPassives?: unknown }
      number: number | null
      text: string
      expected: { identifiers: string[]; spent: boolean; number: number; text: string }
    }> = [
      {
        piece: { skills: [{ skillId: 'dash' }, { skillId: 'guard' }], spentPassives: ['dash'] },
        number: null, text: '，前缀', expected: { identifiers: ['dash', 'guard'], spent: true, number: 0, text: '前缀' },
      },
      {
        piece: { skills: [], spentPassives: [] },
        number: -3, text: '普通', expected: { identifiers: [], spent: false, number: 0, text: '普通' },
      },
      {
        piece: { skills: [{ skillId: 'dash' }], spentPassives: [] },
        number: 0, text: '，，', expected: { identifiers: ['dash'], spent: false, number: 0, text: '，' },
      },
    ]
    for (const testCase of cases) {
      const globals = {
        flow: {
          query: { piece: (id: unknown) => id === 'caster' ? testCase.piece : null },
          skills: { wasSpent: (id: unknown, abilityId: unknown) => id === 'caster' && Array.isArray(testCase.piece.spentPassives) && testCase.piece.spentPassives.includes(abilityId) },
        },
      }
      const context = { pieceId: 'caster', number: testCase.number, text: testCase.text }
      const boundSource = { ...source, inputBindings: { number: testCase.number, text: testCase.text } }
      const original = execute(boundSource, globals, context)
      const migrated = execute(migrateRemainingPredicateModules(boundSource), globals, context)
      expect(migrated.value, JSON.stringify(testCase)).toEqual(original.value)
      expect(migrated.value).toEqual({ ...testCase.expected, single: ['caster'] })
    }
  })
})
