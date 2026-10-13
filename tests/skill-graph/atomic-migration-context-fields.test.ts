import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { atomicContextFieldRecipe, migrateContextFieldModules } from '../../lib/skill-graph/atomic-migration-context-fields'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { CONTEXT_FIELD_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-context-fields'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
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

function registryWith(...descriptors: GameplayModuleDescriptor[]): GameplayModuleRegistry {
  const byKey = new Map(descriptors.map(descriptor => [descriptor.id + '@' + descriptor.version, descriptor]))
  return {
    get: (id, requestedVersion) => byKey.get(id + '@' + (requestedVersion ?? version))
      ?? GAMEPLAY_MODULE_REGISTRY.get(id, requestedVersion),
  }
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

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayLiteral>> = {},
): GameplayModuleGraph['body'][number] {
  return { kind: 'call', id, module, version, inputs, parameters }
}

function execute(code: string, context: Record<string, unknown>): unknown {
  if (code.trimStart().startsWith('function')) {
    return (runInNewContext('(' + code + ')') as (value: Record<string, unknown>) => unknown)(context)
  }
  return new Function('context', code)(context)
}

function executeRuntime(
  code: string,
  context: Record<string, unknown>,
  runtime: { flow?: unknown; battle?: unknown; ctx?: unknown },
): unknown {
  return new Function('context', 'flow', 'battle', 'ctx', code)(context, runtime.flow, runtime.battle, runtime.ctx)
}

function compileAlias(
  module: string,
  parameters: Readonly<Record<string, GameplayLiteral>> = {},
  surface: GameplayModuleGraph['surface'] = 'skill',
): { original: GameplayModuleGraph; migrated: GameplayModuleGraph; registry: GameplayModuleRegistry } {
  const original = { ...graph([
    call('read', module, module === 'event.read-number' || module === 'event.read-string' ? { fallback: literal(module === 'event.read-number' ? 11 : 'fallback') } : {}, parameters),
    { kind: 'return', id: 'done', value: output('read') },
  ], { surface, outputs: [{ name: 'value', type: module === 'event.read-number' ? 'number' : { kind: 'nullable', value: 'string' } }] }), surface }
  return { original, migrated: migrateContextFieldModules(original), registry: registryWith(...CONTEXT_FIELD_GAMEPLAY_MODULES) }
}

describe('closed context and skill field readers', () => {
  it('normalizes typed scalar fields and keeps null/undefined presence distinct', () => {
    const source = graph([
      call('damage', 'context.field', {}, { field: 'damage' }),
      call('damageNull', 'context.field', {}, { field: 'actualDamage' }),
      call('badNumber', 'context.field', {}, { field: 'targetX' }),
      call('skill', 'context.field', {}, { field: 'skillId' }),
      call('nullText', 'context.field', {}, { field: 'cardId' }),
      call('undefinedText', 'context.field', {}, { field: 'statusId' }),
      call('missingText', 'context.field', {}, { field: 'statusType' }),
      call('cancelled', 'context.field', {}, { field: 'cancelled' }),
      { kind: 'return', id: 'done', values: {
        damage: output('damage'), damageDefined: output('damage', 'defined'),
        damageNull: output('damageNull'), damageNullDefined: output('damageNull', 'defined'),
        badNumber: output('badNumber'),
        skill: output('skill'), nullText: output('nullText'),
        undefinedText: output('undefinedText'), missingText: output('missingText'),
        cancelled: output('cancelled'), cancelledDefined: output('cancelled', 'defined'),
      } },
    ], {
      outputs: [
        { name: 'damage', type: { kind: 'nullable', value: 'number' } }, { name: 'damageDefined', type: 'boolean' },
        { name: 'damageNull', type: { kind: 'nullable', value: 'number' } }, { name: 'damageNullDefined', type: 'boolean' },
        { name: 'badNumber', type: { kind: 'nullable', value: 'number' } },
        { name: 'skill', type: { kind: 'nullable', value: 'string' } }, { name: 'nullText', type: { kind: 'nullable', value: 'string' } },
        { name: 'undefinedText', type: { kind: 'nullable', value: 'string' } }, { name: 'missingText', type: { kind: 'nullable', value: 'string' } },
        { name: 'cancelled', type: 'boolean' }, { name: 'cancelledDefined', type: 'boolean' },
      ],
    })
    const context = { damage: '7', actualDamage: null, targetX: 'bad', skillId: 0, cardId: null, statusId: undefined, cancelled: null }
    expect(execute(compileGameplayModuleGraph(source, registryWith(...CONTEXT_FIELD_GAMEPLAY_MODULES)).code, context)).toEqual({
      damage: 7, damageDefined: true,
      damageNull: null, damageNullDefined: true,
      badNumber: NaN,
      skill: '0', nullText: null, undefinedText: null, missingText: null,
      cancelled: false, cancelledDefined: true,
    })
  })

  it('reads only the closed immutable skill scalar table and rejects preview use', () => {
    const source = graph([
      call('power', 'skill.field', {}, { field: 'powerMultiplier' }),
      call('cost', 'skill.field', {}, { field: 'actionPointCost' }),
      call('name', 'skill.field', {}, { field: 'name' }),
      call('description', 'skill.field', {}, { field: 'description' }),
      { kind: 'return', id: 'done', values: {
        power: output('power'), cost: output('cost'), name: output('name'), description: output('description'),
      } },
    ], { outputs: [
      { name: 'power', type: 'number' }, { name: 'cost', type: 'number' },
      { name: 'name', type: 'string' }, { name: 'description', type: 'string' },
    ] })
    const registry = registryWith(...CONTEXT_FIELD_GAMEPLAY_MODULES)
    const compiled = compileGameplayModuleGraph(source, registry)
    expect(execute(compiled.code, { skill: { powerMultiplier: 2, actionPointCost: 3, name: 'Slash', description: 'A cut' } })).toEqual({
      power: 2, cost: 3, name: 'Slash', description: 'A cut',
    })
    expect(() => compileGameplayModuleGraph({ ...source, surface: 'preview' }, registry)).toThrow(/not allowed on preview/)
    expect(() => compileGameplayModuleGraph({
      ...source,
      body: [call('bad', 'skill.field', {}, { field: 'arbitraryPath' })],
    }, registry)).toThrow(/enum|field|parameter/)
  })

  it.each([
    ['event.read-number', 'damage', { damage: undefined }, 11],
    ['event.read-number', 'damage', { damage: null }, 11],
    ['event.read-number', 'damage', { damage: 0 }, 0],
    ['event.read-number', 'damage', { damage: '4' }, 4],
    ['event.read-number', 'damage', { damage: false }, 0],
    ['event.read-number', 'damage', { damage: 'bad' }, NaN],
    ['event.read-string', 'skillId', { skillId: undefined }, 'fallback'],
    ['event.read-string', 'skillId', { skillId: null }, 'fallback'],
    ['event.read-string', 'skillId', { skillId: 0 }, '0'],
    ['event.read-string', 'skillId', { skillId: false }, 'false'],
  ] as const)('preserves %s legacy fallback/conversion for %s', (module, field, context, expected) => {
    const { original, migrated, registry } = compileAlias(module, { field })
    const originalResult = execute(compileGameplayModuleGraph(original, GAMEPLAY_MODULE_REGISTRY).code, context)
    const migratedResult = execute(compileGameplayModuleGraph(migrated, registry).code, context)
    expect(migratedResult).toEqual(originalResult)
    expect(migratedResult).toEqual(expected)
  })

  it('rewrites context aliases without changing their old output bindings', () => {
    const source = graph([
      call('status', 'event.status-text', {}, { field: 'statusType' }),
      call('card', 'event.card-id'),
      call('skill', 'event.skill-id'),
      call('cancelled', 'event.cancelled'),
      call('has', 'event.has-field', {}, { field: 'targetX' }),
      call('power', 'skill.power-multiplier'),
      { kind: 'return', id: 'done', values: {
        status: output('status'), card: output('card'), skill: output('skill'), cancelled: output('cancelled'), has: output('has'), power: output('power'),
      } },
    ], { surface: 'rule', outputs: [
      { name: 'status', type: { kind: 'nullable', value: 'string' } }, { name: 'card', type: { kind: 'nullable', value: 'string' } },
      { name: 'skill', type: { kind: 'nullable', value: 'string' } }, { name: 'cancelled', type: 'boolean' }, { name: 'has', type: 'boolean' },
      { name: 'power', type: 'number' },
    ] })
    const migrated = migrateContextFieldModules(source)
    expect(migrated.body.map(statement => statement.kind === 'call' ? statement.module : statement.kind)).toEqual([
      'context.field', 'context.field', 'context.field', 'context.field', 'context.field', 'skill.field', 'return',
    ])
    expect(execute(compileGameplayModuleGraph(source, GAMEPLAY_MODULE_REGISTRY).code, { statusType: 'freeze', cardId: 7, skillId: 'old', cancelled: 1, targetX: null, skill: { powerMultiplier: 2 } })).toEqual({
      status: 'freeze', card: '7', skill: 'old', cancelled: true, has: true, power: 2,
    })
    expect(execute(compileGameplayModuleGraph(migrated, registryWith(...CONTEXT_FIELD_GAMEPLAY_MODULES)).code, { statusType: 'freeze', cardId: 7, skillId: 'old', cancelled: 1, targetX: null, skill: { powerMultiplier: 2 } })).toEqual({
      status: 'freeze', card: '7', skill: 'old', cancelled: true, has: true, power: 2,
    })
    expect(atomicContextFieldRecipe(source.body[0] as Extract<GameplayModuleGraph['body'][number], { kind: 'call' }>, suffix => 'fresh-' + suffix)).toBeDefined()
  })

  it('routes event, selection, coordinate, and turn aliases through versioned generic fields', () => {
    const source = graph([
      call('type', 'event.type'),
      call('player', 'event.player'),
      call('actualDamage', 'event.actual-damage'),
      call('movement', 'event.movement-kind'),
      call('single', 'event.single-piece-target-action'),
      call('reserved', 'event.reserved-cells'),
      call('targets', 'event.selected-targets'),
      call('option', 'event.selected-option'),
      call('coordinate', 'event.read-coordinate', { fallback: literal(9) }, { field: 'fromX' }),
      call('turn', 'turn.number'),
      call('current', 'turn.current-player'),
      { kind: 'return', id: 'done', values: {
        type: output('type'), player: output('player'), actualDamage: output('actualDamage'), movement: output('movement'),
        single: output('single'), reserved: output('reserved', 'cells'), targets: output('targets', 'targets'), option: output('option'),
        coordinate: output('coordinate'), turn: output('turn'), current: output('current', 'player'),
      } },
    ], {
      surface: 'rule',
      outputs: [
        { name: 'type', type: { kind: 'nullable', value: 'string' } },
        { name: 'player', type: { kind: 'nullable', value: 'player' } },
        { name: 'actualDamage', type: { kind: 'nullable', value: 'number' } },
        { name: 'movement', type: { kind: 'nullable', value: 'string' } },
        { name: 'single', type: 'boolean' },
        { name: 'reserved', type: { kind: 'list', element: 'cell' } },
        { name: 'targets', type: { kind: 'list', element: 'choice' } },
        { name: 'option', type: { kind: 'nullable', value: 'string' } },
        { name: 'coordinate', type: 'number' },
        { name: 'turn', type: 'number' },
        { name: 'current', type: 'player' },
      ],
    })
    const migrated = migrateContextFieldModules(source)
    const migratedCalls = migrated.body.filter(statement => statement.kind === 'call') as Extract<GameplayModuleGraph['body'][number], { kind: 'call' }>[]
    expect(migratedCalls.map(statement => `${statement.module}@${statement.version}`)).toEqual([
      'event.field@2', 'event.field@2', 'event.field@2', 'event.field@2',
      'context.field@2', 'context.field@2', 'context.field@2', 'context.field@2',
      'context.field@1', 'value.coalesce@1', 'battle.field@3', 'battle.field@3',
    ])
    expect(migratedCalls.find(statement => statement.id === 'reserved')?.parameters).toEqual({ field: 'reservedCells' })
    expect(migratedCalls.find(statement => statement.id === 'targets')?.parameters).toEqual({ field: 'selectedTargets' })
    expect(migratedCalls.find(statement => statement.id === 'current')?.parameters).toEqual({ field: 'currentPlayerId' })

    const registry = registryWith(...CONTEXT_FIELD_GAMEPLAY_MODULES)
    const event = { type: 'move', playerId: 'p1', actualDamage: '4', movementKind: 'dash' }
    const runtime = { flow: { event: { read: () => event } }, battle: { turn: { turnNumber: 7, currentPlayerId: 'p1' } } }
    const normalContext = {
      isSinglePieceTargetAction: true,
      reservedCells: [{ x: 1, y: 2 }],
      selectedTargets: [{ type: 'piece', pieceId: 'target' }],
      selectedOption: 0,
      fromX: '4',
    }
    const originalNormal = executeRuntime(compileGameplayModuleGraph(source, GAMEPLAY_MODULE_REGISTRY).code, normalContext, runtime)
    const migratedNormal = executeRuntime(compileGameplayModuleGraph(migrated, registry).code, normalContext, runtime)
    expect(migratedNormal).toEqual(originalNormal)
    expect(migratedNormal).toEqual({
      type: 'move', player: 'p1', actualDamage: '4', movement: 'dash', single: true,
      reserved: [{ x: 1, y: 2 }], targets: [{ type: 'piece', pieceId: 'target' }], option: '0',
      coordinate: 4, turn: 7, current: 'p1',
    })

    const missingEvent = {}
    const missingRuntime = { flow: { event: { read: () => missingEvent } }, battle: { turn: {} } }
    const missingContext = {
      isSinglePieceTargetAction: 'true', reservedCells: null, selectedTargets: 'invalid',
      selectedOption: undefined, fromX: null,
    }
    const originalMissing = executeRuntime(compileGameplayModuleGraph(source, GAMEPLAY_MODULE_REGISTRY).code, missingContext, missingRuntime)
    const migratedMissing = executeRuntime(compileGameplayModuleGraph(migrated, registry).code, missingContext, missingRuntime)
    expect(migratedMissing).toEqual(originalMissing)
    expect(migratedMissing).toEqual({
      type: undefined, player: undefined, actualDamage: undefined, movement: undefined, single: false,
      reserved: [], targets: [], option: null, coordinate: 9, turn: undefined, current: undefined,
    })
  })

  it('reads current card id and type through the additive context field version', () => {
    const source = graph([
      call('id', 'card.current-id'),
      call('type', 'card.current-type'),
      { kind: 'return', id: 'done', values: { id: output('id', 'cardId'), type: output('type', 'type') } },
    ], {
      surface: 'card',
      outputs: [{ name: 'id', type: 'string' }, { name: 'type', type: 'string' }],
    })
    const migrated = migrateContextFieldModules(source)
    expect((migrated.body[0] as Extract<GameplayModuleGraph['body'][number], { kind: 'call' }>).module).toBe('context.field')
    expect((migrated.body[0] as Extract<GameplayModuleGraph['body'][number], { kind: 'call' }>).version).toBe('3')
    const registry = registryWith(...CONTEXT_FIELD_GAMEPLAY_MODULES)
    const runtime = { flow: { cards: { currentId: () => 'dynamic-card', currentType: () => 'onUse' } } }
    const runCard = (graphToRun: GameplayModuleGraph, context: Record<string, unknown>): unknown => {
      const compiled = compileGameplayModuleGraph(graphToRun, registry)
      const run = runInNewContext('(' + compiled.code + ')', { flow: runtime.flow }) as (value: Record<string, unknown>) => unknown
      return run(context)
    }
    const normalContext = { card: { id: 'dynamic-card' }, cardInstance: { cardId: 'fallback-card' }, type: 'onUse' }
    const originalRun = (graphToRun: GameplayModuleGraph, context: Record<string, unknown>): unknown => {
      const compiled = compileGameplayModuleGraph(graphToRun, GAMEPLAY_MODULE_REGISTRY)
      const run = runInNewContext('(' + compiled.code + ')', { flow: runtime.flow }) as (value: Record<string, unknown>) => unknown
      return run(context)
    }
    expect(originalRun(source, normalContext)).toEqual({ id: 'dynamic-card', type: 'onUse' })
    expect(runCard(migrated, normalContext)).toEqual({ id: 'dynamic-card', type: 'onUse' })
    const fallbackContext = { card: { id: null }, cardInstance: { cardId: 'fallback-card' }, type: undefined }
    expect(runCard(migrated, fallbackContext)).toEqual({ id: 'fallback-card', type: '' })
    const missingContext = {}
    expect(runCard(migrated, missingContext)).toEqual({ id: '', type: '' })
  })

  it('composes rule source player fallback from closed context and extension fields', () => {
    const source = graph([
      call('read', 'rule.source-player-fallback', {}, { storageKey: 'amaterasuOwnerPlayerId' }),
      { kind: 'return', id: 'done', value: output('read', 'player') },
    ], {
      surface: 'rule',
      outputs: [{ name: 'value', type: { kind: 'nullable', value: 'player' } }],
    })
    const migrated = migrateContextFieldModules(source)
    const modules = migrated.body.flatMap(statement => statement.kind === 'call' ? [statement.module] : [])
    expect(modules).toEqual(expect.arrayContaining(['context.field', 'battle.field', 'value.to-boolean', 'logic.select']))
    expect(modules).not.toContain('rule.source-player-fallback')

    const registry = registryWith(...CONTEXT_FIELD_GAMEPLAY_MODULES)
    const run = (context: Record<string, unknown>, battle: Record<string, unknown>): unknown => {
      const compiled = compileGameplayModuleGraph(migrated, registry)
      return executeRuntime(compiled.code, context, { battle, flow: {} })
    }
    expect(run({ ruleOwnerPlayerId: 'owner', playerId: 'event' }, { extensions: { amaterasuOwnerPlayerId: 'extension' } })).toEqual('owner')
    expect(run({ playerId: 'event' }, { extensions: { amaterasuOwnerPlayerId: 'extension' } })).toEqual('event')
    expect(run({}, { extensions: { amaterasuOwnerPlayerId: 'extension' } })).toEqual('extension')
    expect(run({ ruleOwnerPlayerId: null, playerId: '' }, { extensions: { amaterasuOwnerPlayerId: null } })).toEqual(null)
  })

  it('keeps v3 invalid captures out of an if/else predicate and runs the independent tail', () => {
    const invalid = descriptor('test.invalid-capture', [], [{ name: 'value', type: 'number' }], () => ({ expression: '__gameplayInvalid' }))
    const predicate = descriptor('test.invalid-predicate', [{ name: 'captured', type: 'number' }], [{ name: 'value', type: 'boolean' }], () => ({ expression: '__gameplayInvalid' }))
    const tail = descriptor('test.tail', [], [], () => ({ expression: 'context.events.push("tail")' }))
    const source = graph([
      call('invalid', invalid.id),
      {
        kind: 'collection', id: 'found', method: 'find', items: literal([1, 2]), item: 'item',
        inputs: { captured: output('invalid') },
        body: [
          call('predicate', predicate.id, { captured: input('captured') }),
          {
            kind: 'if', id: 'predicate-branch', condition: output('predicate'),
            then: [{ kind: 'return', id: 'match', value: literal(true) }],
            else: [{ kind: 'return', id: 'fallback-match', value: literal(true) }],
          },
        ],
      },
      call('tail', tail.id),
      { kind: 'return', id: 'done', values: { result: output('found') } },
    ], { outputs: [{ name: 'result', type: { kind: 'nullable', value: 'number' } }] })
    const compiled = compileGameplayModuleGraph(source, registryWith(invalid, predicate, tail))
    expect(compiled.compilerVersion).toBe(GAMEPLAY_MODULE_COMPILER_V3_VERSION)
    const context = { events: [] as string[] }
    expect(execute(compiled.code, context)).toBeUndefined()
    expect(context.events).toEqual(['tail'])
  })

  it('allows a legitimate null capture to flow through a nullable predicate', () => {
    const nullableCapture = descriptor('test.null-capture', [], [{ name: 'value', type: 'string', nullable: true }], () => ({ expression: 'null' }))
    const predicate = descriptor(
      'test.matches-null',
      [{ name: 'value', type: 'number' }, { name: 'captured', type: 'string', nullable: true }],
      [{ name: 'value', type: 'boolean' }],
      ({ inputs }) => ({ expression: `({value:${inputs.captured}===null})` }),
    )
    const source = graph([
      call('capture', nullableCapture.id),
      {
        kind: 'collection', id: 'found', method: 'find', items: literal([7, 8]), item: 'item',
        inputs: { captured: output('capture') },
        body: [
          call('predicate', predicate.id, { value: input('item'), captured: input('captured') }),
          { kind: 'return', id: 'predicate-result', value: output('predicate') },
        ],
      },
      { kind: 'return', id: 'done', values: { result: output('found') } },
    ], { outputs: [{ name: 'result', type: { kind: 'nullable', value: 'number' } }] })
    const compiled = compileGameplayModuleGraph(source, registryWith(nullableCapture, predicate))
    expect(execute(compiled.code, {})).toEqual({ result: 7 })
  })
})
