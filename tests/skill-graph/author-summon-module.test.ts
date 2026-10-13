/* eslint-disable @typescript-eslint/no-explicit-any -- compiled author graph host values are opaque runtime references. */
import { describe, expect, it } from 'vitest'

import {
  createDeclaredSummonQueueWriter,
  createEffectChain,
  withEffectChain,
} from '../../lib/game/effect-batch'
import { createSkillCodeFlow, drainBattleEffectChain, executeSkillFunction, type SkillDefinition } from '../../lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '../../lib/game/rule-runtime'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { applyGameplayModuleGraph } from '../../lib/skill-graph/module-document'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph, type GameplayValue } from '../../lib/skill-graph/module-types'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

const CAPABILITY = {
  version: 1,
  recipe: 'authored-piece',
  maxSummons: 64,
  modes: ['new-instance', 'return-instance'],
} as const

const STORED_CAPABILITY = {
  version: 1,
  recipe: 'stored-or-declared-piece',
  maxSummons: 1,
  storageExtensionKey: 'storedCompiledSummon',
  ownerScopedStorageExtensionKey: 'storedCompiledSummonsByPlayer',
  uniqueTemplateId: 'compiled-stored-summon',
  fallback: {
    instanceIdPrefix: 'compiled-stored-summon-',
    templateId: 'compiled-stored-summon',
    name: 'Compiled stored summon',
    faction: 'red',
    maxHp: 17,
    attack: 4,
    defense: 3,
    moveRange: 4,
    skills: [{ skillId: 'compiled-stored-summon-skill', level: 1, currentCooldown: 0 }],
  },
} as const

const literal = (value: unknown): GameplayValue => ({ kind: 'literal', value: value as never })
const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })

function sourcePiece() {
  return asPieceInstance(makePiece({
    instanceId: 'compiled-summon-source',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: 0,
    y: 0,
    currentHp: 80,
    maxHp: 100,
  }))
}

function summonGraph(
  template: unknown,
  destination: unknown,
  options: { sourceType?: string; templateType?: string; destinationType?: string; captureSource?: boolean; detachSource?: boolean } = {},
): GameplayModuleGraph {
  const templateSchema = 'compiled-author-summon-template'
  const templateValues = Array.isArray(template) ? template : [template]
  const destinationValues = Array.isArray(destination) ? destination : [destination]
  const body: any[] = [
    { kind: 'call', id: 'source', module: 'ref.source', version: '1' },
  ]
  const templateRefs: GameplayValue[] = templateValues.map((value, index) => {
    const id = `template-${index}`
    body.push({
      kind: 'record.create',
      id,
      schema: templateSchema,
      fields: Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, fieldValue]) => [key, literal(fieldValue)])),
    })
    return output(id, 'value')
  })
  const destinationRefs: GameplayValue[] = destinationValues.map((value, index) => {
    const cellId = `cell-${index}`
    body.push({ kind: 'call', id: cellId, module: 'spatial.cell', version: '1', inputs: { x: literal((value as any).x), y: literal((value as any).y) } })
    return output(cellId, 'cell')
  })
  const tuple = (prefix: string, values: GameplayValue[], valueType: string): GameplayValue => {
    if (values.length === 1 && !Array.isArray(template) && prefix === 'template') return values[0]
    if (values.length === 1 && !Array.isArray(destination) && prefix === 'destination') return values[0]
    const singletonIds = values.map((value, index) => {
      const id = `${prefix}-singleton-${index}`
      body.push({ kind: 'call', id, module: 'collection.singleton', version: '1', inputs: { value }, parameters: { valueType } })
      return output(id, 'items')
    })
    let current = singletonIds[0]
    for (let index = 1; index < singletonIds.length; index += 1) {
      const id = `${prefix}-concat-${index}`
      body.push({ kind: 'call', id, module: 'collection.concat', version: '1', inputs: { left: current, right: singletonIds[index] }, parameters: { valueType: JSON.stringify({ kind: 'list', element: valueType === 'cell' ? 'cell' : { kind: 'record', schema: templateSchema } }) } })
      current = output(id, 'items')
    }
    return current
  }
  const templateInput = tuple('template', templateRefs, JSON.stringify({ kind: 'record', schema: templateSchema }))
  const destinationInput = tuple('destination', destinationRefs, 'cell')
  let sourceInput: GameplayValue = output('source', 'piece')
  if (options.captureSource) {
    body.push({ kind: 'call', id: 'capture', module: 'source.capture', version: '1', inputs: { source: sourceInput } })
    sourceInput = output('capture', 'source')
  }
  if (options.detachSource) {
    body.push({
      kind: 'call',
      id: 'detach',
      module: 'piece.detach-active',
      version: '2',
      inputs: { piece: output('source', 'piece') },
      parameters: { flowStatePolicy: 'preserve' },
    })
  }
  body.push({
    kind: 'call',
    id: 'summon',
    module: 'author.effect.summon',
    version: '1',
    inputs: {
      source: sourceInput,
      template: templateInput,
      destination: destinationInput,
    },
    parameters: {
      mode: 'new-instance',
      sourceType: options.sourceType ?? 'piece',
      templateType: options.templateType ?? 'record',
      destinationType: options.destinationType ?? 'cell',
      displayType: 'record',
    },
  })
  body.push({ kind: 'return', id: 'done', values: { result: output('summon', 'result') } })
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION,
    surface: 'skill',
    schemas: [{
      id: templateSchema,
      version: '1',
      fields: [
        { name: 'templateId', type: 'string' },
        { name: 'name', type: 'string' },
        { name: 'maxHp', type: 'number' },
        { name: 'currentHp', type: 'number', optional: true },
        { name: 'attack', type: 'number' },
        { name: 'defense', type: 'number' },
        { name: 'moveRange', type: 'number' },
      ],
    }],
    body,
    outputs: [{ name: 'result', type: 'record' }],
  }
}

function executeCompiled(graph: GameplayModuleGraph, state: any, source: any, capability: unknown = CAPABILITY) {
  const contentId = 'compiled-author-summon'
  const chain = createEffectChain({
    actionId: contentId + ':action',
    chainId: contentId + ':chain',
    turn: state.turn.turnNumber,
    rootSeed: 252,
  })
  const context: any = {
    piece: source,
    sourcePiece: source,
    skill: { id: contentId },
  }
  context.summonQueue = createDeclaredSummonQueueWriter(chain, contentId, capability)
  const flow = createSkillCodeFlow(state, context, 'skill')
  const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
  const execute = new Function('flow', 'return (' + compiled.code + ')')(flow) as (value: unknown) => unknown
  const result = withRuleRuntime(new RuleRuntime({ rootSeed: 252, tick: 4 }), () => (
    withEffectChain(state, chain, () => execute(context))
  ))
  return { compiled, result, chain }
}

describe('author.effect.summon compiled graph', () => {
  it('compiles a single template and settles it through the declared queue host', () => {
    const source = sourcePiece()
    const state = makeState({ pieces: [source] }) as any
    const template = {
      templateId: 'compiled-author-one',
      name: 'Compiled One',
      maxHp: 30,
      currentHp: 21,
      attack: 8,
      defense: 2,
      moveRange: 2,
    }

    const { compiled, result } = executeCompiled(summonGraph(template, { x: 2, y: 1 }), state, source)

    expect(compiled.diagnostics).toEqual([])
    expect(compiled.code).toContain('lifecycle.summonAuthored')
    expect(result).toMatchObject({
      result: {
        success: true,
        results: [{ inputIndex: 0, piece: { templateId: template.templateId, name: template.name, x: 2, y: 1, currentHp: 21 } }],
      },
    })
    expect(state.pieces).toHaveLength(2)
    expect(state.pieces[1]).toMatchObject({
      templateId: template.templateId,
      name: template.name,
      ownerPlayerId: 'player-red',
      faction: 'red',
      x: 2,
      y: 1,
      currentHp: 21,
    })
  })

  it('returns success and blocked status through the existing result output when occupied', () => {
    const source = sourcePiece()
    const state = makeState({ pieces: [source] }) as any
    const template = {
      templateId: 'compiled-author-blocked',
      name: 'Blocked',
      maxHp: 30,
      attack: 8,
      defense: 2,
      moveRange: 2,
    }
    const graph = summonGraph(template, { x: 0, y: 0 })

    const { compiled, result } = executeCompiled(graph, state, source)

    expect(compiled.diagnostics).toEqual([])
    expect(result).toEqual({
      result: { success: false, blocked: true, message: '召唤落点已被占用' },
    })
    expect(state.pieces).toHaveLength(1)
  })

  it('compiles a template tuple and destination tuple in input order through the same host', () => {
    const source = sourcePiece()
    const state = makeState({ pieces: [source] }) as any
    const templates = [
      { templateId: 'compiled-author-beta', name: 'Beta', maxHp: 30, attack: 8, defense: 2, moveRange: 2 },
      { templateId: 'compiled-author-alpha', name: 'Alpha', maxHp: 40, attack: 9, defense: 1, moveRange: 3 },
    ]
    const destinations = [{ x: 3, y: 1 }, { x: 1, y: 2 }]

    const { compiled, result } = executeCompiled(
      summonGraph(templates, destinations, {
        templateType: JSON.stringify({ kind: 'list', element: 'record' }),
        destinationType: JSON.stringify({ kind: 'list', element: 'cell' }),
      }),
      state,
      source,
    )

    expect(compiled.diagnostics).toEqual([])
    expect(result).toMatchObject({
      result: {
        success: true,
        results: [
          { inputIndex: 0, piece: { templateId: templates[0].templateId, name: templates[0].name, x: 3, y: 1 } },
          { inputIndex: 1, piece: { templateId: templates[1].templateId, name: templates[1].name, x: 1, y: 2 } },
        ],
      },
    })
    expect(state.pieces.slice(1).map((piece: any) => [piece.templateId, piece.name, piece.x, piece.y]).sort((left: any[], right: any[]) => left[3] - right[3] || left[2] - right[2])).toEqual([
      [templates[0].templateId, templates[0].name, destinations[0].x, destinations[0].y],
      [templates[1].templateId, templates[1].name, destinations[1].x, destinations[1].y],
    ].sort((left: any[], right: any[]) => left[3] - right[3] || left[2] - right[2]))
  })

  it('accepts an authenticated captured source and preserves it after author detach', () => {
    const source = sourcePiece()
    const state = makeState({ pieces: [source] }) as any
    const template = {
      templateId: 'compiled-author-captured',
      name: 'Captured',
      maxHp: 30,
      currentHp: 21,
      attack: 8,
      defense: 2,
      moveRange: 2,
    }

    const { compiled, result } = executeCompiled(
      summonGraph(template, { x: 2, y: 1 }, { sourceType: 'record', captureSource: true, detachSource: true }),
      state,
      source,
    )

    expect(compiled.diagnostics).toEqual([])
    expect(compiled.code).toContain('captureSource')
    expect(result).toMatchObject({
      result: {
        success: true,
        results: [{ piece: { templateId: template.templateId, ownerPlayerId: 'player-red', faction: 'red', x: 2, y: 1 } }],
      },
    })
    expect(state.pieces).toHaveLength(1)
    expect(state.pieces[0]).toMatchObject({ templateId: template.templateId, ownerPlayerId: 'player-red', faction: 'red' })
    expect(state.extensions.authorOutOfPlay?.pieces?.['compiled-summon-source']).toBeDefined()
  })

  it('runs the public graph after applying it to a capability-bearing skill document', () => {
    const source = sourcePiece()
    const state = makeState({ pieces: [source] }) as any
    const template = {
      templateId: 'compiled-author-document',
      name: 'Document graph summon',
      maxHp: 30,
      currentHp: 21,
      attack: 8,
      defense: 2,
      moveRange: 2,
    }
    const graph = summonGraph(template, { x: 2, y: 1 }, {
      sourceType: 'record',
      captureSource: true,
      detachSource: true,
    })
    const skill = applyGameplayModuleGraph({
      id: 'compiled-author-document-skill',
      kind: 'active',
      type: 'normal',
      name: 'Document graph summon',
      summonCapability: CAPABILITY,
    }, graph) as unknown as SkillDefinition

    const result = withRuleRuntime(new RuleRuntime({ rootSeed: 252, tick: 4 }), () => executeSkillFunction(skill, {
      battle: state,
      piece: source,
      skill,
      target: null,
      targetPosition: null,
      targets: [],
    }, state))

    expect(result).toMatchObject({ result: expect.objectContaining({ success: true }) })
    expect(state.pieces).toHaveLength(1)
    expect(state.pieces[0]).toMatchObject({
      templateId: template.templateId,
      ownerPlayerId: 'player-red',
      faction: 'red',
      x: 2,
      y: 1,
      currentHp: 21,
    })
    expect(state.extensions.authorOutOfPlay?.pieces?.['compiled-summon-source']).toBeDefined()
  })

  it('uses the same public sentence for a stored declaration and returns the queue count', () => {
    const source = sourcePiece()
    const state = makeState({ pieces: [source] }) as any
    state.extensions.storedCompiledSummonsByPlayer = {
      'player-red': {
        instanceId: 'compiled-stored-summon-original',
        templateId: 'compiled-stored-summon',
        name: 'Stored original',
        ownerPlayerId: 'player-red',
        faction: 'red',
        currentHp: 3,
        maxHp: 17,
        attack: 4,
        defense: 3,
        moveRange: 4,
        skills: [{ skillId: 'compiled-stored-summon-skill', level: 1, currentCooldown: 0 }],
        rules: [],
        statusTags: [],
      },
    }
    const graph: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      body: [
        { kind: 'call', id: 'source', module: 'ref.source', version: '1' },
        { kind: 'call', id: 'capture', module: 'source.capture', version: '1', inputs: { source: output('source', 'piece') } },
        { kind: 'call', id: 'cell', module: 'spatial.cell', version: '1', inputs: { x: literal(2), y: literal(1) } },
        {
          kind: 'call', id: 'summon', module: 'author.effect.summon', version: '2',
          inputs: { source: output('capture', 'source'), destination: output('cell', 'cell') },
          parameters: { mode: 'declaration', sourceType: 'record', destinationType: 'cell' },
        },
        { kind: 'return', id: 'done', values: { result: output('summon', 'result') } },
      ],
      outputs: [{ name: 'result', type: 'record' }],
    }
    const { compiled, result } = executeCompiled(graph, state, source, STORED_CAPABILITY)

    expect(compiled.diagnostics).toEqual([])
    expect(compiled.code).toContain('lifecycle.summonDeclared')
    expect(result).toEqual({ result: { queued: true, queueCount: 1 } })
    expect(state.pieces).toHaveLength(1)
  })

  it('settles a stored declaration after its captured anchor dies, preserving the stored instance and consuming owner storage', () => {
    const source = sourcePiece()
    source.currentHp = 6
    const state = makeState({ pieces: [source] }) as any
    state.extensions.storedCompiledSummonsByPlayer = {
      'player-red': {
        instanceId: 'compiled-stored-summon-original',
        templateId: 'compiled-stored-summon',
        name: 'Stored original',
        ownerPlayerId: 'player-red',
        faction: 'red',
        currentHp: 3,
        maxHp: 17,
        attack: 4,
        defense: 3,
        moveRange: 4,
        skills: [],
        rules: [],
        statusTags: [],
      },
    }
    const graph: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'skill',
      body: [
        { kind: 'call', id: 'source', module: 'ref.source', version: '1' },
        { kind: 'call', id: 'capture', module: 'source.capture', version: '1', inputs: { source: output('source', 'piece') } },
        {
          kind: 'call', id: 'damage', module: 'author.effect.damage', version: '2',
          inputs: { source: output('source', 'piece'), target: output('source', 'piece'), amount: literal(6) },
          parameters: {
            sourceType: 'piece', targetType: 'piece', amountType: 'number', resultType: 'record',
            damageType: 'true', legacyNormalSpelling: 'physical', attribution: 'current',
          },
        },
        { kind: 'call', id: 'cell', module: 'spatial.cell', version: '1', inputs: { x: literal(2), y: literal(1) } },
        {
          kind: 'call', id: 'summon', module: 'author.effect.summon', version: '2',
          inputs: { source: output('capture', 'source'), destination: output('cell', 'cell') },
          parameters: { mode: 'declaration', sourceType: 'record', destinationType: 'cell' },
        },
        { kind: 'return', id: 'done', values: { result: output('summon', 'result') } },
      ],
      outputs: [{ name: 'result', type: 'record' }],
    }

    const { compiled, result, chain } = executeCompiled(graph, state, source, STORED_CAPABILITY)

    expect(compiled.diagnostics).toEqual([])
    expect(result).toEqual({ result: { queued: true, queueCount: 1 } })
    expect(state.pieces).toHaveLength(0)
    expect(state.graveyard).toHaveLength(1)
    expect(state.graveyard[0]).toMatchObject({ instanceId: source.instanceId, currentHp: 0 })

    const executions = withRuleRuntime(new RuleRuntime({ rootSeed: 252, tick: 4 }), () => (
      withEffectChain(state, chain, () => drainBattleEffectChain(state, chain))
    ))
    expect(executions).toHaveLength(1)
    expect(executions[0].result).toMatchObject({ success: true, results: [{ piece: { instanceId: 'compiled-stored-summon-original', currentHp: 17, x: 2, y: 1 } }] })
    expect(state.pieces).toHaveLength(1)
    expect(state.pieces[0]).toMatchObject({ instanceId: 'compiled-stored-summon-original', currentHp: 17, maxHp: 17, ownerPlayerId: 'player-red' })
    expect(state.extensions.storedCompiledSummonsByPlayer).toBeUndefined()
  })
})
