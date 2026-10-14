import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { ATOMIC_HAND_QUERY_MODULES, migrateHandQueryModules } from '../../lib/skill-graph/atomic-migration-hand-queries'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GENERIC_CARD_FIELD_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-generic-card-fields'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayCallStatement,
  type GameplayModuleDescriptor,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayStatement,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const inputValue = (name: string): GameplayValue => ({ kind: 'input', name })
const literal = (value: string | number | boolean | null | readonly string[]): GameplayValue => ({ kind: 'literal', value })

function fixtureDescriptor(id: string, outputName: 'player' | 'piece', expression: string): GameplayModuleDescriptor {
  return {
    id, version: '1', label: id, inputs: [], outputs: [{ name: outputName, type: outputName }],
    allowedSurfaces: ['skill'], effects: { pure: true, previewSafe: true }, lower: () => ({ expression }),
  }
}

const FIXTURE_PLAYER = fixtureDescriptor('test.hand-player', 'player', 'context.player')
const FIXTURE_PIECE = fixtureDescriptor('test.hand-piece', 'piece', 'context.source')

const registry: GameplayModuleRegistry = {
  get: (id, version) => {
    const descriptors = [FIXTURE_PLAYER, FIXTURE_PIECE, ...GENERIC_CARD_FIELD_GAMEPLAY_MODULES]
    return descriptors.find(descriptor => descriptor.id === id && descriptor.version === (version ?? '1'))
      ?? GAMEPLAY_MODULE_REGISTRY.get(id, version)
  },
  resolve: (id, version) => {
    const descriptors = [FIXTURE_PLAYER, FIXTURE_PIECE, ...GENERIC_CARD_FIELD_GAMEPLAY_MODULES]
    return descriptors.find(descriptor => descriptor.id === id && descriptor.version === (version ?? '1'))
      ?? GAMEPLAY_MODULE_REGISTRY.resolve(id, version)
  },
  descriptors: [...GAMEPLAY_MODULE_REGISTRY.descriptors, FIXTURE_PLAYER, FIXTURE_PIECE, ...GENERIC_CARD_FIELD_GAMEPLAY_MODULES],
}

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters?: Readonly<Record<string, string | number | boolean | null | readonly string[]>>,
): GameplayCallStatement {
  return {
    kind: 'call', id, module, version: '1', inputs,
    ...(parameters === undefined ? {} : { parameters }),
  }
}

function graph(body: readonly GameplayStatement[], outputs: GameplayModuleGraph['outputs']): GameplayModuleGraph {
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body, outputs }
}

function callsIn(body: readonly GameplayStatement[]): GameplayCallStatement[] {
  const result: GameplayCallStatement[] = []
  const visit = (statements: readonly GameplayStatement[]): void => {
    for (const statement of statements) {
      if (statement.kind === 'call') result.push(statement)
      if (statement.kind === 'if') {
        visit(statement.then)
        visit(statement.else ?? [])
      } else if (statement.kind === 'foreach' || statement.kind === 'collection' || statement.kind === 'while') {
        visit(statement.body)
        if (statement.kind === 'while') visit(statement.condition.body)
      }
    }
  }
  visit(body)
  return result
}

type Card = {
  readonly cardId: string
  readonly instanceId: string
  readonly name?: string
  readonly boundPieceInstanceId?: string
  readonly contentState?: Record<string, unknown>
}

type Piece = { readonly instanceId: string; readonly ownerPlayerId: string; readonly templateId: string; readonly currentHp: number }

function runtime(cards: readonly Card[], pieces: readonly Piece[] = []): { readonly globals: Record<string, unknown>; readonly context: Record<string, string> } {
  const player = { playerId: 'red', hand: [...cards] }
  const battle = { players: [player], pieces: [...pieces] }
  const findPlayer = (id: unknown) => battle.players.find(item => item.playerId === id)
  const findPiece = (id: unknown) => battle.pieces.find(item => item.instanceId === id) ?? null
  const flow = {
    cards: { hand: (id: unknown) => findPlayer(id)?.hand ?? [] },
    content: {
      filterHand: (id: unknown, options: { readonly nameContains?: string | null; readonly cardIdPrefix?: string | null }) => {
        const owner = findPlayer(id)
        if (!owner?.hand) return { cards: [], hasHand: false }
        return {
          cards: owner.hand.filter(card => (
            (options.nameContains != null && card.name?.includes(options.nameContains) === true)
            || (options.cardIdPrefix != null && card.cardId?.startsWith(options.cardIdPrefix) === true)
          )).map(card => card.cardId),
          hasHand: true,
        }
      },
    },
    query: {
      hasPlayer: (id: unknown) => findPlayer(id) !== undefined,
      player: (id: unknown) => findPlayer(id) ?? null,
      hasPiece: (id: unknown) => findPiece(id) !== null,
      piece: (id: unknown) => findPiece(id),
      pieces: (options: { readonly ownerId?: string; readonly relation?: string; readonly includeDead?: boolean }) => battle.pieces
        .filter(piece => options.includeDead === true || piece.currentHp > 0)
        .filter(piece => options.ownerId === undefined || piece.ownerPlayerId === options.ownerId)
        .filter(piece => options.relation !== 'enemy' || piece.ownerPlayerId !== options.ownerId)
        .map(piece => piece.instanceId),
    },
  }
  return { globals: { battle, flow }, context: { player: 'red', source: 'source' } }
}

function execute(source: GameplayModuleGraph, migrated: boolean, cards: readonly Card[], pieces: readonly Piece[] = []): unknown {
  const value = migrated ? migrateHandQueryModules(source) : source
  const compiled = compileGameplayModuleGraph(value, migrated ? registry : registry)
  const { globals, context } = runtime(cards, pieces)
  const diagnostics: string[] = []
  globals.__gameplayModuleDiagnosticHost = { shouldRethrow: () => true, record: (_id: string, error: Error, module?: string) => diagnostics.push(`${module ?? 'graph'}:${error.message}`) }
  const run = runInNewContext('(' + compiled.code + ')', globals) as (value: unknown) => unknown
  try { return run(context) } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} [${diagnostics.join('; ')}]`)
  }
}

function base(callNode: GameplayCallStatement, outputs: GameplayModuleGraph['outputs'], values: Readonly<Record<string, GameplayValue>>): GameplayModuleGraph {
  return graph([
    call('player', FIXTURE_PLAYER.id),
    call('source', FIXTURE_PIECE.id),
    callNode,
    { kind: 'return', id: 'done', values },
  ], outputs)
}

const cards: readonly Card[] = [
  {
    cardId: 'prophecy', instanceId: 'prophecy-1', name: 'Holy Prophecy',
    contentState: { velenHolyProphecy: { sourcePieceId: 'source', createdTurnNumber: 1 }, velenHolyProphecyEnhanced: true },
  },
  {
    cardId: 'other', instanceId: 'other-1', name: 'Alpha',
    contentState: { velenHolyProphecy: { sourcePieceId: 'source', createdTurnNumber: 3 } },
  },
  {
    cardId: 'prophecy', instanceId: 'prophecy-2', name: '',
    contentState: { velenHolyProphecy: { sourcePieceId: 'source', createdTurnNumber: 3 } },
  },
  {
    cardId: 'prophecy', instanceId: 'prophecy-3', name: 'No turn',
    contentState: { velenHolyProphecy: { sourcePieceId: 'source' } },
  },
]
const sourcePiece: Piece = { instanceId: 'source', ownerPlayerId: 'red', templateId: 'source-template', currentHp: 10 }

describe('atomic hand-query migrations', () => {
  it('rewrites all retired hand helpers into generic hand records and fields', () => {
    const sources: GameplayModuleGraph[] = [
      base(call('filter', 'content.filter-hand', { player: output('player', 'player') }, { nameContains: 'a' }), [{ name: 'cards', type: { kind: 'list', element: 'string' } }, { name: 'hasHand', type: 'boolean' }], { cards: output('filter', 'cards'), hasHand: output('filter', 'hasHand') }),
      base(call('by-definitions', 'card.hand-instances-by-definition-ids', { player: output('player', 'player') }, { cardIds: ['prophecy'] }), [{ name: 'cards', type: { kind: 'list', element: 'string' } }], { cards: output('by-definitions', 'cards') }),
      base(call('bound', 'card.bound-living-template', { owner: output('player', 'player') }, { cardId: 'prophecy', templateId: 'template' }), [{ name: 'piece', type: { kind: 'nullable', value: 'piece' } }], { piece: output('bound', 'piece') }),
      base(call('records', 'card.find-content-records', { player: output('player', 'player'), source: output('source', 'piece'), turn: literal(3) }, { field: 'velenHolyProphecy' }), [{ name: 'cards', type: { kind: 'list', element: 'string' } }], { cards: output('records', 'cards') }),
      base(call('read-id', 'card.read-definition-id', { player: output('player', 'player'), card: literal('prophecy-1') }), [{ name: 'id', type: 'string' }], { id: output('read-id', 'cardId') }),
      base(call('read-name', 'card.read-definition-name', { player: output('player', 'player'), card: literal('prophecy-1') }), [{ name: 'name', type: { kind: 'nullable', value: 'string' } }], { name: output('read-name', 'name') }),
      base(call('read-boolean', 'card.read-content-boolean', { player: output('player', 'player'), card: literal('prophecy-1') }, { field: 'velenHolyProphecy' }), [{ name: 'value', type: 'boolean' }], { value: output('read-boolean', 'value') }),
    ]
    for (const source of sources) {
      const migrated = migrateHandQueryModules(source)
      const modules = callsIn(migrated.body).map(statement => statement.module)
      expect(modules).not.toEqual(expect.arrayContaining([...ATOMIC_HAND_QUERY_MODULES]))
      expect(modules).toEqual(expect.arrayContaining(['card.hand-records']))
      expect(migrateHandQueryModules(migrated)).toEqual(migrated)
    }
  })

  it('preserves hand order, definition/instance identity, content truthiness, and missing names', () => {
    const oneDefinition = base(
      call('query', 'query.hand-card-instances', { player: output('player', 'player') }, { cardId: 'prophecy' }),
      [{ name: 'cards', type: { kind: 'list', element: 'string' } }],
      { cards: output('query', 'cards') },
    )
    for (const hand of [[], cards]) expect(execute(oneDefinition, true, hand)).toEqual(execute(oneDefinition, false, hand))
    const filter = base(
      call('filter', 'content.filter-hand', { player: output('player', 'player') }, { nameContains: 'Holy', cardIdPrefix: 'prophecy' }),
      [{ name: 'cards', type: { kind: 'list', element: 'string' } }, { name: 'hasHand', type: 'boolean' }],
      { cards: output('filter', 'cards'), hasHand: output('filter', 'hasHand') },
    )
    const byDefinitions = base(
      call('by-definitions', 'card.hand-instances-by-definition-ids', { player: output('player', 'player') }, { cardIds: ['other', 'prophecy'] }),
      [{ name: 'cards', type: { kind: 'list', element: 'string' } }],
      { cards: output('by-definitions', 'cards') },
    )
    const reads = graph([
      call('player', FIXTURE_PLAYER.id),
      call('read-id', 'card.read-definition-id', { player: output('player', 'player'), card: literal('prophecy-1') }),
      call('read-name', 'card.read-definition-name', { player: output('player', 'player'), card: literal('missing') }),
      call('read-object', 'card.read-content-boolean', { player: output('player', 'player'), card: literal('prophecy-1') }, { field: 'velenHolyProphecy' }),
      call('read-flag', 'card.read-content-boolean', { player: output('player', 'player'), card: literal('prophecy-1') }, { field: 'velenHolyProphecyEnhanced' }),
      { kind: 'return', id: 'done', values: {
        id: output('read-id', 'cardId'), name: output('read-name', 'name'), object: output('read-object', 'value'), flag: output('read-flag', 'value'),
      } },
    ], [
      { name: 'id', type: 'string' }, { name: 'name', type: { kind: 'nullable', value: 'string' } },
      { name: 'object', type: 'boolean' }, { name: 'flag', type: 'boolean' },
    ])
    expect(execute(filter, false, cards)).toEqual(execute(filter, true, cards))
    expect(execute(filter, true, cards)).toEqual({ cards: ['prophecy', 'prophecy', 'prophecy'], hasHand: true })
    expect(execute(byDefinitions, true, cards)).toEqual({ cards: ['prophecy-1', 'other-1', 'prophecy-2', 'prophecy-3'] })
    expect(execute(reads, false, cards)).toEqual(execute(reads, true, cards))
    expect(execute(reads, true, cards)).toEqual({ id: 'prophecy', name: null, object: true, flag: true })
    expect(execute(filter, true, [])).toEqual({ cards: [], hasHand: true })
  })

  it('keeps the content-record turn boundary and treats absent created turns as eligible', () => {
    const source = base(
      call('records', 'card.find-content-records', { player: output('player', 'player'), source: output('source', 'piece'), turn: literal(3) }, { field: 'velenHolyProphecy' }),
      [{ name: 'cards', type: { kind: 'list', element: 'string' } }],
      { cards: output('records', 'cards') },
    )
    expect(execute(source, false, cards, [sourcePiece])).toEqual(execute(source, true, cards, [sourcePiece]))
    expect(execute(source, true, cards, [sourcePiece])).toEqual({ cards: ['prophecy-1', 'prophecy-3'] })
  })

  it('does not fall back to a same-template piece when an existing binding is dead', () => {
    const source = base(
      call('bound', 'card.bound-living-template', { owner: output('player', 'player') }, { cardId: 'prophecy', templateId: 'template' }),
      [{ name: 'piece', type: { kind: 'nullable', value: 'piece' } }],
      { piece: output('bound', 'piece') },
    )
    const live = [
      { instanceId: 'bound-live', ownerPlayerId: 'red', templateId: 'other', currentHp: 10 },
      { instanceId: 'fallback', ownerPlayerId: 'red', templateId: 'template', currentHp: 10 },
    ] as const
    expect(execute(source, false, [{ cardId: 'prophecy', instanceId: 'card-1', boundPieceInstanceId: 'bound-live' }], live)).toEqual({ piece: 'bound-live' })
    expect(execute(source, true, [{ cardId: 'prophecy', instanceId: 'card-1', boundPieceInstanceId: 'bound-live' }], live)).toEqual({ piece: 'bound-live' })

    const dead = [
      { instanceId: 'bound-dead', ownerPlayerId: 'red', templateId: 'template', currentHp: 0 },
      { instanceId: 'fallback', ownerPlayerId: 'red', templateId: 'template', currentHp: 10 },
    ] as const
    expect(execute(source, false, [{ cardId: 'prophecy', instanceId: 'card-1', boundPieceInstanceId: 'bound-dead' }], dead)).toEqual({ piece: null })
    expect(execute(source, true, [{ cardId: 'prophecy', instanceId: 'card-1', boundPieceInstanceId: 'bound-dead' }], dead)).toEqual({ piece: null })
    expect(execute(source, true, [{ cardId: 'prophecy', instanceId: 'card-1' }], dead)).toEqual({ piece: 'fallback' })
  })

  it('captures an outer hand item when a retired card read is nested in a collection', () => {
    const source = graph([
      call('player', FIXTURE_PLAYER.id),
      call('hand', 'card.hand-instances', { player: output('player', 'player') }),
      {
        kind: 'collection', id: 'ids', method: 'map', items: output('hand', 'cards'), item: 'card',
        inputs: { player: output('player', 'player') },
        body: [
          call('read', 'card.read-definition-id', { player: inputValue('player'), card: inputValue('card') }),
          { kind: 'return', id: 'map-return', value: output('read', 'cardId') },
        ],
      },
      { kind: 'return', id: 'done', values: { ids: output('ids') } },
    ], [{ name: 'ids', type: { kind: 'list', element: 'string' } }])

    const migrated = migrateHandQueryModules(source)
    expect(() => compileGameplayModuleGraph(migrated, registry)).not.toThrow()
    expect(migrateHandQueryModules(migrated)).toEqual(migrated)
  })
})
