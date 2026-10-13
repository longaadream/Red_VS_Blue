import { describe, expect, it } from 'vitest'

import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { createSkillCodeFlow, gainCardInstance } from '../../lib/game/skills'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph } from '../../lib/skill-graph/module-types'
import type { CardInstance } from '../../lib/game/battle-types'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

describe('concrete author entity extensions', () => {
  it('does not materialize persistent IDs for execution-local instance lists', () => {
    const target = makePiece({
      instanceId: 'caster',
      skills: [{ skillId: 'same' }],
      statusTags: [{ id: 'mark', type: 'mark' }],
      rules: [{ id: 'rule' }],
    })
    const battle = makeState({ pieces: [target] })
    const flow = createFlowRuntime(battle, { piece: target }, 'skill', {})

    flow.skills.instances('caster')
    flow.rules.instances('caster')
    flow.status.instances('caster')

    expect(target.skills[0].instanceId).toBeUndefined()
    expect(target.rules[0].instanceId).toBeUndefined()
    expect(target.statusTags[0].instanceId).toBeUndefined()
  })

  it('does not let a stale serialized status reference retarget a replacement at the same slot', () => {
    const target = makePiece({
      instanceId: 'caster',
      statusTags: [{ id: 'old-mark', type: 'mark' }],
    })
    const battle = makeState({ pieces: [target] })
    const flow = createFlowRuntime(battle, { piece: target }, 'skill', {})
    const staleReference = { pieceId: 'caster', instanceId: 'caster:status:0' }

    flow.entityExtension.declare('status', staleReference, 'content', 'oldValue', 'number', [], 1)
    expect(target.statusTags[0].instanceId).toBe('caster:status:0')

    target.statusTags = [{ id: 'replacement-mark', type: 'mark' }]

    // The old execution-local object is gone. A serialized ID must not be
    // lazily regenerated from the replacement's array index and rebound.
    expect(() => flow.entityExtension.declare(
      'status', staleReference, 'content', 'replacementValue', 'number', [], 2,
    )).toThrow('已经失效')
    expect(target.statusTags[0].instanceId).toBeUndefined()
    expect(target.statusTags[0].extension).toBeUndefined()
  })

  it.each(['pending', 'skill'] as const)('does not rebind a stale status reference after restoring a saved battle in %s flow', (surface) => {
    const target = makePiece({
      instanceId: 'caster',
      statusTags: [{ id: 'old-mark', type: 'mark' }],
    })
    const battle = makeState({ pieces: [target] })
    const firstFlow = createFlowRuntime(battle, { piece: target }, 'skill', {})
    const staleReference = { pieceId: 'caster', instanceId: 'caster:status:0' }

    firstFlow.entityExtension.declare('status', staleReference, 'content', 'oldValue', 'number', [], 1)
    target.statusTags = [{ id: 'replacement-mark', type: 'mark' }]

    const restored = JSON.parse(JSON.stringify(battle))
    const restoredFlow = createFlowRuntime(restored, {}, surface, {})

    // A new runtime has no execution-local tombstone map. It must still not
    // infer the deleted identity from the replacement's array index.
    expect(() => restoredFlow.entityExtension.declare(
      'status', staleReference, 'content', 'replacementValue', 'number', [], 2,
    )).toThrow('已经失效')
    expect(restored.pieces[0].statusTags[0].instanceId).toBeUndefined()
    expect(restored.pieces[0].statusTags[0].extension).toBeUndefined()
  })

  it('keeps same-name entity extensions isolated by namespace and declaration type', () => {
    const target = makePiece({
      instanceId: 'caster',
      skills: [{ skillId: 'same', instanceId: 'caster:skill:0' }],
    })
    const battle = makeState({ pieces: [target] })
    const flow = createFlowRuntime(battle, { piece: target }, 'skill', {})
    const handle = flow.skills.instances('caster').instances[0]

    flow.entityExtension.declare('skill', handle, 'alpha', 'shared', 'number', [], 1)
    flow.entityExtension.declare('skill', handle, 'beta', 'shared', 'string', [], 'two')

    expect(flow.entityExtension.read('skill', handle, 'alpha', 'shared', '', 'number', [])).toBe(1)
    expect(flow.entityExtension.read('skill', handle, 'beta', 'shared', '', 'string', [])).toBe('two')
    flow.entityExtension.write('skill', handle, 'beta', 'shared', '', 'string', [], 'updated')
    expect(flow.entityExtension.read('skill', handle, 'alpha', 'shared', '', 'number', [])).toBe(1)
    expect(flow.entityExtension.read('skill', handle, 'beta', 'shared', '', 'string', [])).toBe('updated')
  })

  it('does not collide declaration metadata when namespace or name contains a dot', () => {
    const target = makePiece({
      instanceId: 'caster',
      skills: [{ skillId: 'same', instanceId: 'caster:skill:0' }],
    })
    const battle = makeState({ pieces: [target] })
    const flow = createFlowRuntime(battle, { piece: target }, 'skill', {})
    const handle = flow.skills.instances('caster').instances[0]

    flow.entityExtension.declare('skill', handle, 'a.b', 'c', 'number', [], 1)
    flow.entityExtension.declare('skill', handle, 'a', 'b.c', 'string', [], 'two')

    expect(flow.entityExtension.read('skill', handle, 'a.b', 'c', '', 'number', [])).toBe(1)
    expect(flow.entityExtension.read('skill', handle, 'a', 'b.c', '', 'string', [])).toBe('two')
  })

  it('writes the selected duplicate Skill instance and survives serialization by instanceId', () => {
    const target = makePiece({
      instanceId: 'caster',
      skills: [
        { skillId: 'same', instanceId: 'caster:skill:0' },
        { skillId: 'same', instanceId: 'caster:skill:1' },
      ],
    })
    const battle = makeState({ pieces: [target] })
    const flow = createFlowRuntime(battle, { piece: target }, 'skill', {})
    const handles = flow.skills.instances('caster').instances
    flow.entityExtension.declare('skill', handles[1], 'content', 'uses', 'number', [], 2)
    const extensionRoot = target.skills[1].extension
    flow.entityExtension.write('skill', handles[1], 'content', 'uses', '', 'number', [], 7)

    expect(target.skills.map(skill => skill.extension?.uses)).toEqual([undefined, 7])
    expect(target.skills[1].extension).toBe(extensionRoot)
    expect(battle.extensions?.flowState).toBeUndefined()

    const restored = JSON.parse(JSON.stringify(battle))
    const restoredFlow = createFlowRuntime(restored, {}, 'pending', {})
    const reference = { pieceId: 'caster', instanceId: 'caster:skill:1', skillId: 'same' }
    expect(restoredFlow.entityExtension.read('skill', reference, 'content', 'uses', '', 'number', [])).toBe(7)
    expect(() => restoredFlow.entityExtension.read('skill', { ...reference, instanceId: 'caster:skill:0' }, 'content', 'uses', '', 'number', [])).toThrow()
  })

  it('keeps card, Cluster, status, and tile-effect writes on the authoritative objects', () => {
    const target = asPieceInstance(makePiece({ instanceId: 'caster', statusTags: [{ id: 'mark', type: 'mark' }] }))
    target.abilityGroups = [{ id: 'group', instanceId: 'group:0', skills: [], rules: [] }]
    const battle = makeState({ pieces: [target] })
    const extensions = battle.extensions ?? (battle.extensions = {})
    battle.players[0].hand.push({ cardId: 'card', instanceId: 'card:0', ownerPlayerId: 'player-red' })
    extensions.tileEffects = [{ id: 'tile:0', tileType: 'aura', x: 1, y: 1 }]
    const flow = createFlowRuntime(battle, { piece: target }, 'skill', {})

    const status = flow.status.instances('caster').statuses[0]
    // Execution-local status handles preserve the legacy object exactly; a
    // serializable reference is the point at which an old status receives its
    // deterministic lazy identity.
    expect(target.statusTags[0].instanceId).toBeUndefined()
    const group = flow.clusters.list('caster')[0]
    const card = flow.refs.card(battle.players[0].hand[0])
    for (const [kind, reference] of [
      ['status', status],
      ['cluster', group],
      ['card', card],
      ['tile-effect', { id: 'tile:0' }],
    ] as const) {
      flow.entityExtension.declare(kind, reference, 'content', 'value', 'number', [], 1)
      flow.entityExtension.write(kind, reference, 'content', 'value', '', 'number', [], 9)
    }

    expect(target.statusTags[0].extension).toEqual({ value: 9 })
    expect(target.statusTags[0].instanceId).toBeUndefined()
    expect(target.abilityGroups[0].extension).toEqual({ value: 9 })
    expect(battle.players[0].hand[0].extension).toEqual({ value: 9 })
    expect(battle.extensions?.tileEffects?.[0]?.extension).toEqual({ value: 9 })

    flow.entityExtension.read('status', { pieceId: 'caster', instanceId: 'caster:status:0' }, 'content', 'value', '', 'number', [])
    expect(target.statusTags[0].instanceId).toBe('caster:status:0')
  })

  it('executes a compiled card graph against the current hand instance and reads its extension after restore', () => {
    const battle = makeState()
    const player = battle.players[0]
    const gained = gainCardInstance(battle, 'watcher-calm', player.playerId)
    expect(gained).toMatchObject({ success: true, placement: 'hand' })
    const card = gained.instance as CardInstance
    const graph: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION,
      surface: 'card',
      outputs: [{ name: 'value', type: 'number' }],
      body: [
        { kind: 'call', id: 'current', module: 'ref.current-card', version: '1', inputs: {}, parameters: {} },
        {
          kind: 'call', id: 'declare', module: 'extension.declare-instance', version: '1',
          inputs: {
            entity: { kind: 'output', node: 'current', port: 'card' },
            value: { kind: 'literal', value: 1 },
          },
          parameters: { entityKind: 'card', namespace: 'content', name: 'armor', valueType: 'number' },
        },
        {
          kind: 'call', id: 'read', module: 'extension.read-instance', version: '1',
          inputs: { entity: { kind: 'output', node: 'current', port: 'card' } },
          parameters: { entityKind: 'card', namespace: 'content', name: 'armor', path: '', valueType: 'number' },
        },
        {
          kind: 'return', id: 'result',
          values: { value: { kind: 'output', node: 'read', port: 'value' } },
        },
      ],
    }
    const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
    expect(compiled.diagnostics).toEqual([])

    const execute = (state: typeof battle) => {
      const current = state.players[0].hand[0]
      const context = { playerId: state.players[0].playerId, card: { id: current.cardId }, cardInstance: current }
      const flow = createSkillCodeFlow(state, context, 'card')
      return Function('context', 'flow', 'battle', `return (${compiled.code})(context)`)(context, flow, state)
    }

    expect(execute(battle)).toEqual({ value: 1 })
    expect(card.extension).toEqual({ armor: 1 })
    expect(card.authorExtensionDeclarations?.['content.armor']?.type).toBe('number')

    const restored = JSON.parse(JSON.stringify(battle)) as typeof battle
    expect(execute(restored)).toEqual({ value: 1 })
    expect(restored.players[0].hand[0].extension).toEqual({ armor: 1 })
  })

  it('rejects declaration type changes and leaves the entity untouched after invalid writes', () => {
    const target = makePiece({ instanceId: 'caster', skills: [{ skillId: 'one', instanceId: 'caster:skill:0' }] })
    const battle = makeState({ pieces: [target] })
    const flow = createFlowRuntime(battle, { piece: target }, 'skill', {})
    const handle = flow.skills.instances('caster').instances[0]
    flow.entityExtension.declare('skill', handle, 'content', 'state', 'number', [], 3)
    expect(() => flow.entityExtension.declare('skill', handle, 'content', '__proto__', 'number', [], 1)).toThrow()
    expect(() => flow.entityExtension.declare('skill', handle, 'content', 'state', 'string', [], 'bad')).toThrow('声明类型')
    expect(() => flow.entityExtension.write('skill', handle, 'content', 'state', '', 'number', [], Infinity)).toThrow()
    expect(target.skills[0].extension).toEqual({ state: 3 })
    expect(target.skills[0].authorExtensionDeclarations?.['content.state']?.type).toBe('number')
  })
})
