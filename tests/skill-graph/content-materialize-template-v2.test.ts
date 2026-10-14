import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_GRAPH_VERSION } from '../../lib/skill-graph/module-types'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { gainCardInstance } from '../../lib/game/skills'
import { makeState } from '../helpers/minimal-state'

const templateFixtures: Record<string, Record<string, unknown>> = {
  // Tails' production graph computes one of these generated card IDs from the
  // selected modules (for example armor-attack-defense); the source skill ID
  // is not itself a card template.
  'armor-attack-defense': JSON.parse(readFileSync('data/cards/armor-attack-defense.json', 'utf8')) as Record<string, unknown>,
  'rafaam-curse-sample': JSON.parse(readFileSync('data/cards/rafaam-curse-sample.json', 'utf8')) as Record<string, unknown>,
}

function output(node: string, port: string) {
  return { kind: 'output' as const, node, port }
}

function materializeAndGainGraph(templateId: string, cardId: string) {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill' as const,
    schemas: [
      { id: 'template-fields', version: '1', fields: [{ name: 'damageAmount', type: 'number' as const }] },
      { id: 'card-extension', version: '1', fields: [{ name: 'sourcePlayerId', type: 'string' as const }] },
    ],
    outputs: [{ name: 'instance', type: 'record' as const, nullable: true }, { name: 'cardId', type: 'card' as const }],
    body: [
      { kind: 'call' as const, id: 'owner', module: 'ref.player', version: '1' },
      { kind: 'call' as const, id: 'template', module: 'ref.card-template', version: '1', parameters: { templateId } },
      { kind: 'record.create' as const, id: 'fields', schema: 'template-fields@1', fields: {
        damageAmount: { kind: 'literal' as const, value: 6 },
      } },
      { kind: 'record.create' as const, id: 'extension', schema: 'card-extension@1', fields: {
        sourcePlayerId: { kind: 'literal' as const, value: 'player-red' },
      } },
      { kind: 'call' as const, id: 'materialize', module: 'content.materialize-template', version: '2', parameters: {
        fieldsType: JSON.stringify({ kind: 'record', schema: 'template-fields@1' }),
        extensionType: JSON.stringify({ kind: 'record', schema: 'card-extension@1' }),
      }, inputs: {
        template: output('template', 'template'),
        cardId: { kind: 'literal' as const, value: cardId },
        name: { kind: 'literal' as const, value: '公开动态卡' },
        description: { kind: 'literal' as const, value: '来自类型化模板引用' },
        owner: output('owner', 'player'),
        fields: output('fields', 'value'),
        extension: output('extension', 'value'),
      } },
      { kind: 'call' as const, id: 'card-local', module: 'local.declare', version: '2', parameters: {
        name: 'generatedCard', valueType: 'card',
      }, inputs: { initial: output('materialize', 'card') } },
      { kind: 'call' as const, id: 'card-read', module: 'local.read', version: '1', parameters: {
        valueType: 'card',
      }, inputs: { handle: output('card-local', 'handle') } },
      { kind: 'call' as const, id: 'extension-local', module: 'local.declare', version: '2', parameters: {
        name: 'generatedExtension', valueType: JSON.stringify({ kind: 'record', schema: 'card-extension@1' }),
      }, inputs: { initial: output('extension', 'value') } },
      { kind: 'call' as const, id: 'extension-read', module: 'local.read', version: '1', parameters: {
        valueType: JSON.stringify({ kind: 'record', schema: 'card-extension@1' }),
      }, inputs: { handle: output('extension-local', 'handle') } },
      { kind: 'call' as const, id: 'gain', module: 'author.card.gain', version: '1', parameters: {
        extensionType: JSON.stringify({ kind: 'record', schema: 'card-extension@1' }),
      }, inputs: {
        player: output('owner', 'player'),
        card: output('card-read', 'value'),
        extension: output('extension-read', 'value'),
      } },
      { kind: 'return' as const, id: 'return', values: { instance: output('gain', 'instance'), cardId: output('card-read', 'value') } },
    ],
  }
}

function runMaterializeAndGain(templateId: string, cardId: string) {
  const battle = makeState()
  const owner = battle.players[0]
  const template = { ...(templateFixtures[templateId] ?? templateFixtures['rafaam-curse-sample']), id: templateId }
  const flow = createFlowRuntime(battle, { playerId: owner.playerId }, 'skill', {
    loadCardDefinition: (requestedId: string) => requestedId === templateId ? template : undefined,
    gainCardInstance: (requestedCardId: string, playerId: string, initial: unknown) =>
      gainCardInstance(battle, requestedCardId, playerId, undefined, initial as never),
  })
  const code = compileGameplayModuleGraph(materializeAndGainGraph(templateId, cardId), GAMEPLAY_MODULE_REGISTRY).code
  const result = Function('context', 'flow', 'battle', `return (${code})(context)`)(
    { playerId: owner.playerId }, flow, battle,
  ) as { instance: { cardId: string; extension?: unknown } | null; cardId: string }
  return { battle, result }
}

describe('public typed content.materialize-template@2', () => {
  it('exposes a template reference and a typed card output without raw JSON inputs', () => {
    const materialize = GAMEPLAY_MODULE_REGISTRY.get?.('content.materialize-template', '2')
    expect(materialize).toBeDefined()
    expect(materialize?.inputs.map(input => [input.name, input.type])).toEqual([
      ['template', 'content'], ['cardId', 'string'], ['name', 'string'], ['description', 'string'],
      ['owner', 'player'], ['fields', 'record'], ['extension', 'record'], ['omitFields', { kind: 'list', element: 'string' }],
    ])
    expect(materialize?.outputs.find(output => output.name === 'card')?.type).toBe('card')
    expect(materialize?.ui?.authoring).toBe('standard')
    expect(materialize?.description).toMatch(/结构化/)
    expect(GAMEPLAY_MODULE_REGISTRY.get?.('ref.card-template', '1')?.outputs[0]).toMatchObject({ name: 'template', type: 'content' })
  })

  it.each([
    ['Tails armor assembly / armor-attack-defense', 'armor-attack-defense', 'tails-public-armor'],
    ['Rafaam curse ward / rafaam-curse-sample', 'rafaam-curse-sample', 'rafaam-public-curse'],
  ])('materializes %s and feeds the typed definition directly into card gain', (_scenario, templateId, cardId) => {
    const { battle, result } = runMaterializeAndGain(templateId, cardId)
    const owner = battle.players[0]
    expect(result.cardId).toBe(cardId)
    expect(result.instance).toMatchObject({ cardId, ownerPlayerId: owner.playerId, extension: { sourcePlayerId: owner.playerId } })
    expect(owner.hand.some(card => card.cardId === cardId)).toBe(true)
    expect(battle.customCards?.[cardId]).toMatchObject({ id: cardId, damageAmount: 6 })
  })

  it('rejects fields of the wrong semantic type before graph execution is accepted', () => {
    const invalid = materializeAndGainGraph('invalid-template', 'invalid-card')
    const invalidGraph = {
      ...invalid,
      body: invalid.body.map(statement => statement.kind === 'call' && statement.id === 'materialize'
        ? { ...statement, inputs: { ...statement.inputs, fields: output('owner', 'player') } }
        : statement),
    }
    expect(() => compileGameplayModuleGraph(invalidGraph, GAMEPLAY_MODULE_REGISTRY)).toThrow(/type|端口|record/i)
  })

  it('rejects a verified non-card template before writing custom content', () => {
    const battle = makeState()
    const owner = battle.players[0]
    const template = { ...templateFixtures['rafaam-curse-sample'], id: 'invalid-skill-template', type: 'super' }
    const flow = createFlowRuntime(battle, { playerId: owner.playerId }, 'skill', {
      loadCardDefinition: (requestedId: string) => requestedId === template.id ? template : undefined,
    })
    expect(() => flow.content.materializeTemplate({
      kind: 'card', templateId: template.id, cardId: 'should-not-exist', name: '非法模板', description: '', owner: owner.playerId,
    })).toThrow(/模板类型/)
    expect(battle.customCards).toBeUndefined()
  })
})
