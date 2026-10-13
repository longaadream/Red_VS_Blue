import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

import { createDeclaredSummonQueueWriter, createEffectChain, withEffectChain } from '../../lib/game/effect-batch'
import { createSkillCodeFlow } from '../../lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '../../lib/game/rule-runtime'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { getGameplayModuleCatalog, GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import {
  AUTHOR_PIECE_IDENTITY_SCHEMA_ID,
  AUTHOR_PIECE_INSTANCE_SCHEMA_ID,
  AUTHOR_PIECE_SNAPSHOT_FIELDS_SCHEMA_ID,
  AUTHOR_PIECE_TEMPLATE_SCHEMA_ID,
} from '../../lib/game/author-summon-schema'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph } from '../../lib/skill-graph/module-types'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

const literal = (value: unknown) => ({ kind: 'literal' as const, value: value as never })
const output = (node: string, port: string) => ({ kind: 'output' as const, node, port })
const recordType = (schema: string) => ({ kind: 'record' as const, schema })

describe('author summon built-in record schemas', () => {
  it('publishes named template/display schemas in the catalog', () => {
    const summon = getGameplayModuleCatalog().find(item => item.id === 'author.effect.summon' && item.version === '1')
    expect(summon?.recordSchemas?.some(schema => `${schema.id}@${schema.version}` === AUTHOR_PIECE_TEMPLATE_SCHEMA_ID)).toBe(true)
    expect(summon?.parameters?.find(parameter => parameter.name === 'templateType')?.default).toContain(AUTHOR_PIECE_TEMPLATE_SCHEMA_ID)
  })

  it('compiles a blank typed template before its summon call without graph-local schema boilerplate', () => {
    const graph: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      body: [
        { kind: 'call', id: 'source', module: 'ref.source', version: '1' },
        {
          kind: 'record.create', id: 'template', schema: AUTHOR_PIECE_TEMPLATE_SCHEMA_ID,
          fields: { templateId: literal('blank-template'), name: literal('Blank'), maxHp: literal(10), attack: literal(1), defense: literal(0), moveRange: literal(0) },
        },
        { kind: 'call', id: 'cell', module: 'spatial.cell', version: '1', inputs: { x: literal(2), y: literal(1) } },
        {
          kind: 'call', id: 'summon', module: 'author.effect.summon', version: '1',
          inputs: { source: output('source', 'piece'), template: output('template', 'value'), destination: output('cell', 'cell') },
          parameters: { mode: 'new-instance' },
        },
        { kind: 'return', id: 'done', values: { result: output('summon', 'result') } },
      ],
      outputs: [{ name: 'result', type: 'record' }],
    }
    const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
    expect(compiled.diagnostics).toEqual([])
    expect(compiled.code).toContain('lifecycle.summonAuthored')
  })

  it('keeps explicitly declared JSON members when an open record is updated', () => {
    const graph: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      schemas: [{
        id: 'open-payload',
        version: '1',
        fields: [{ name: 'count', type: 'number' }],
        additionalFields: 'json',
      }],
      body: [
        {
          kind: 'record.create', id: 'created', schema: 'open-payload@1',
          fields: { count: literal(2), snapshotFields: literal({ shield: 3, flow: { value: ['kept'] } }) },
        },
        {
          kind: 'record.with', id: 'updated', record: output('created', 'value'),
          fields: { count: literal(5) },
        },
        { kind: 'return', id: 'done', values: { result: output('updated', 'value') } },
      ],
      outputs: [{ name: 'result', type: { kind: 'record', schema: 'open-payload@1' } }],
    }
    const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
    expect(compiled.diagnostics).toEqual([])
    const execute = runInNewContext('(' + compiled.code + ')') as (context: unknown) => unknown
    expect(execute({})).toEqual({ result: { count: 5, snapshotFields: { shield: 3, flow: { value: ['kept'] } } } })
  })

  it('compiles typed snapshot copy/read/summon flow and rejects opaque unknown fields', () => {
    const graph: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      body: [
        { kind: 'call', id: 'source', module: 'ref.source', version: '1' },
        {
          kind: 'record.create', id: 'identity', schema: AUTHOR_PIECE_IDENTITY_SCHEMA_ID,
          fields: {
            templateId: literal('typed-source'), name: literal('Typed source'), faction: literal('red'), ownerPlayerId: literal('player-red'),
          },
        },
        {
          kind: 'record.create', id: 'fields', schema: AUTHOR_PIECE_SNAPSHOT_FIELDS_SCHEMA_ID,
          fields: {
            templateId: literal('typed-source'), name: literal('Typed source'), ownerPlayerId: literal('player-red'), faction: literal('red'),
            maxHp: literal(20), currentHp: literal(20), attack: literal(3), defense: literal(1), moveRange: literal(2),
            customSnapshot: literal({ nested: ['kept'] }),
          },
        },
        { kind: 'record.get', id: 'readMaxHp', record: output('fields', 'value'), field: 'maxHp' },
        {
          kind: 'record.with', id: 'updatedFields', record: output('fields', 'value'),
          fields: { maxHp: output('readMaxHp', 'value') },
        },
        {
          kind: 'record.create', id: 'snapshot', schema: AUTHOR_PIECE_INSTANCE_SCHEMA_ID,
          fields: {
            schemaVersion: literal(1), kind: literal('author-piece-instance/v1'), sourcePieceId: literal('typed-source'), ownerPlayerId: literal('player-red'),
            identity: output('identity', 'value'), fields: output('updatedFields', 'value'), flowState: literal([]),
          },
        },
        {
          kind: 'record.create', id: 'template', schema: AUTHOR_PIECE_TEMPLATE_SCHEMA_ID,
          fields: {
            baseSnapshot: output('snapshot', 'value'), templateId: literal('typed-summon'), name: literal('Typed summon'),
            maxHp: output('readMaxHp', 'value'), attack: literal(3), defense: literal(1), moveRange: literal(2),
          },
        },
        { kind: 'call', id: 'cell', module: 'spatial.cell', version: '1', inputs: { x: literal(2), y: literal(1) } },
        {
          kind: 'call', id: 'summon', module: 'author.effect.summon', version: '1',
          inputs: { source: output('source', 'piece'), template: output('template', 'value'), destination: output('cell', 'cell') },
          parameters: { mode: 'new-instance' },
        },
        {
          kind: 'return', id: 'done', values: {
            result: output('summon', 'result'), snapshotFields: output('updatedFields', 'value'),
          },
        },
      ],
      outputs: [{ name: 'result', type: 'record' }, { name: 'snapshotFields', type: recordType(AUTHOR_PIECE_SNAPSHOT_FIELDS_SCHEMA_ID) }],
    }
    const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
    expect(compiled.diagnostics).toEqual([])

    const source = asPieceInstance(makePiece({ instanceId: 'typed-source' }))
    const state = makeState({ pieces: [source] })
    const chain = createEffectChain({ actionId: 'typed-snapshot:action', chainId: 'typed-snapshot:chain', turn: 1, rootSeed: 252 })
    const context = { piece: source, sourcePiece: source, skill: { id: 'typed-snapshot' } } as Parameters<typeof createSkillCodeFlow>[1]
    context.summonQueue = createDeclaredSummonQueueWriter(chain, 'typed-snapshot', {
      version: 1, recipe: 'authored-piece', maxSummons: 1, modes: ['new-instance', 'return-instance'],
    })
    const flow = createSkillCodeFlow(state, context, 'skill')
    const execute = new Function('flow', 'return (' + compiled.code + ')')(flow) as (value: unknown) => unknown
    const result = withRuleRuntime(new RuleRuntime({ rootSeed: 252, tick: 4 }), () => withEffectChain(state, chain, () => {
      const execution = execute(context)
      return execution
    })) as { result: Record<string, unknown>; snapshotFields: Record<string, unknown> }

    expect(result.result).toMatchObject({ success: true })
    expect(result.snapshotFields.customSnapshot).toEqual({ nested: ['kept'] })
    expect(state.pieces[1]).toMatchObject({ templateId: 'typed-summon', maxHp: 20, ownerPlayerId: 'player-red', faction: 'red' })

    const unsafeGraph: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      body: [
        { kind: 'call', id: 'source', module: 'ref.source', version: '1' },
        {
          kind: 'record.create', id: 'unsafe', schema: AUTHOR_PIECE_SNAPSHOT_FIELDS_SCHEMA_ID,
          fields: { customSnapshot: output('source', 'piece') },
        },
        { kind: 'return', id: 'done', values: { result: output('unsafe', 'value') } },
      ],
      outputs: [{ name: 'result', type: recordType(AUTHOR_PIECE_SNAPSHOT_FIELDS_SCHEMA_ID) }],
    }
    expect(() => compileGameplayModuleGraph(unsafeGraph, GAMEPLAY_MODULE_REGISTRY)).toThrow(/expects json/)
  })
})
