import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import {
  ATOMIC_ABILITY_WRITE_MODULES,
  migrateAbilityWriteModules,
} from '../../lib/skill-graph/atomic-migration-ability-writes'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GENERIC_ABILITY_WRITE_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-generic-ability-writes'
import { OPTIONAL_FIELD_GAMEPLAY_MODULES } from '../../lib/skill-graph/module-registry-optional-fields'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { makeState, makePiece } from '../helpers/minimal-state'
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

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })

const fixturePiece: GameplayModuleDescriptor = {
  id: 'test.ability-piece',
  version: '1',
  label: '测试棋子',
  inputs: [],
  outputs: [{ name: 'piece', type: 'piece' }],
  allowedSurfaces: ['skill'],
  effects: { pure: true, previewSafe: true, reads: ['test'] },
  lower: () => ({ expression: '"piece-1"' }),
}
const fixtureMissingPiece: GameplayModuleDescriptor = {
  id: 'test.missing-ability-piece',
  version: '1',
  label: '缺失棋子',
  inputs: [],
  outputs: [{ name: 'piece', type: 'piece' }],
  allowedSurfaces: ['skill'],
  effects: { pure: true, previewSafe: true, reads: ['test'] },
  lower: () => ({ expression: '"missing"' }),
}
const fixtureInvalidAmount: GameplayModuleDescriptor = {
  id: 'test.invalid-ability-amount',
  version: '1',
  label: '无效冷却值',
  inputs: [],
  outputs: [{ name: 'amount', type: 'number' }],
  allowedSurfaces: ['skill'],
  effects: { pure: true, previewSafe: true, reads: ['test'] },
  lower: () => ({ expression: '__gameplayInvalid' }),
}
const fixtureInvalidTypes: GameplayModuleDescriptor = {
  id: 'test.invalid-status-types',
  version: '1',
  label: '无效状态类型集合',
  inputs: [],
  outputs: [{ name: 'types', type: { kind: 'list', element: 'string' } }],
  allowedSurfaces: ['skill'],
  effects: { pure: true, previewSafe: true, reads: ['test'] },
  lower: () => ({ expression: '__gameplayInvalid' }),
}

const extras = [fixturePiece, fixtureMissingPiece, fixtureInvalidAmount, fixtureInvalidTypes, ...GENERIC_ABILITY_WRITE_GAMEPLAY_MODULES, ...OPTIONAL_FIELD_GAMEPLAY_MODULES]
const registry: GameplayModuleRegistry = {
  get: (id, version) => extras.find(item => item.id === id && item.version === (version ?? '1')) ?? GAMEPLAY_MODULE_REGISTRY.get(id, version),
  resolve: (id, version) => extras.find(item => item.id === id && item.version === (version ?? '1')) ?? GAMEPLAY_MODULE_REGISTRY.resolve(id, version),
  descriptors: [...GAMEPLAY_MODULE_REGISTRY.descriptors, ...extras],
}

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
): GameplayCallStatement {
  return { kind: 'call', id, module, version: '1', inputs, parameters }
}

function graph(body: readonly GameplayStatement[], inputs: GameplayModuleGraph['inputs'], outputs: GameplayModuleGraph['outputs']): GameplayModuleGraph {
  const inputBindings = Object.fromEntries((inputs ?? []).map(port => [
    port.name,
    port.name === 'amount' ? 2 : ['remove-a', 'remove-b'],
  ]))
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', inputs, inputBindings, body, outputs }
}

type SkillState = { skillId: string; currentCooldown?: number; kind?: string }
type Status = { id?: string; type?: string; [key: string]: unknown }

function runtime(
  skills: SkillState[] | undefined,
  statusTags: Status[] = [],
  definitions: Record<string, { kind?: string }> = {},
) {
  const piece = { instanceId: 'piece-1', currentHp: 1, skills, statusTags }
  const setCalls: Array<{ index: number; value: number }> = []
  let statusInstanceRemovals = 0
  let statusIdRemovals = 0
  const localValues = new WeakMap<object, unknown>()
  const flow = {
    query: {
      piece: (id: string) => id === piece.instanceId ? piece : null,
      hasPiece: (id: string) => id === piece.instanceId,
    },
    execution: {
      declare: (_type: unknown, _schemas: unknown, initial: unknown) => {
        const handle = Object.freeze(Object.create(null)) as object
        localValues.set(handle, structuredClone(initial))
        return { handle, success: true }
      },
      read: (handle: object) => {
        if (!localValues.has(handle)) throw new Error('local handle expired')
        return { value: structuredClone(localValues.get(handle)), success: true }
      },
    },
    skills: {
      instances: (id: string) => {
        if (id !== piece.instanceId || !Array.isArray(piece.skills)) return { instances: [], present: false }
        return {
          instances: piece.skills.map((skill, index) => ({ pieceId: id, index, skillId: skill.skillId, kind: skill.kind ?? definitions[skill.skillId]?.kind, currentCooldown: skill.currentCooldown })),
          present: true,
        }
      },
      field: (instance: { pieceId: string; index: number }, field: string) => {
        const skill = piece.skills?.[instance.index]
        const value = field === 'definitionExists'
          ? Boolean(skill && Object.prototype.hasOwnProperty.call(definitions, skill.skillId))
          : field === 'kind'
            ? skill === undefined ? undefined : skill.kind ?? definitions[skill.skillId]?.kind
            : skill?.[field as keyof SkillState]
        return { value: value === undefined ? null : value, defined: value !== undefined }
      },
      setInstanceCooldown: (instance: { pieceId: string; index: number }, value: number) => {
        const target = instance.pieceId === piece.instanceId ? piece.skills?.[instance.index] : undefined
        if (!target) return false
        target.currentCooldown = value
        setCalls.push({ index: instance.index, value })
        return true
      },
    },
    status: {
      fields: (handle: { pieceId: string; tag: Status }) => {
        const tag = piece.statusTags?.find(candidate => candidate === handle.tag)
        if (!tag) throw new Error('status instance expired')
        return { ...tag }
      },
      instances: (id: string) => {
        if (id !== piece.instanceId || !Array.isArray(piece.statusTags)) return { statuses: [], present: false }
        return {
          statuses: piece.statusTags
            .filter(tag => tag && typeof tag === 'object')
            .map(tag => ({ pieceId: id, tag })),
          present: true,
        }
      },
      removeInstance: (handle: { pieceId: string; tag: Status }) => {
        if (handle.pieceId !== piece.instanceId || !Array.isArray(piece.statusTags)) return false
        const index = piece.statusTags.findIndex(status => status === handle.tag)
        if (index < 0) return false
        piece.statusTags.splice(index, 1)
        statusInstanceRemovals += 1
        return true
      },
      remove: (id: string, statusId: string) => {
        statusIdRemovals += 1
        if (id !== piece.instanceId || !Array.isArray(piece.statusTags)) return false
        const index = piece.statusTags.findIndex(status => status.id === statusId)
        if (index < 0) return false
        piece.statusTags.splice(index, 1)
        return true
      },
    },
  }
  const battle = { skillsById: definitions }
  return { piece, flow, battle, setCalls, get statusInstanceRemovals() { return statusInstanceRemovals }, get statusIdRemovals() { return statusIdRemovals } }
}

function execute(source: GameplayModuleGraph, migrated: boolean, state: ReturnType<typeof runtime>, context: Record<string, unknown> = {}): unknown {
  const value = migrated ? migrateAbilityWriteModules(source) : source
  const compiled = compileGameplayModuleGraph(value, registry)
  const globals = { flow: state.flow, battle: state.battle }
  const run = runInNewContext('(' + compiled.code + ')', globals) as (context: unknown) => unknown
  return run({ piece: state.piece.instanceId, types: ['remove-a', 'remove-b'], amount: 2, ...context })
}

describe('atomic ability-write migrations', () => {
  it('does not partially refresh a status when a later coordinate is invalid', () => {
    const source: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body: [
      call('piece', fixturePiece.id),
      call('invalid-y', fixtureInvalidAmount.id),
      call('write', 'status.refresh-position', { target: output('piece', 'piece'), x: { kind: 'literal', value: 8 }, y: output('invalid-y', 'amount') }, { statusType: 'anchor', duration: 9 }),
    ] }
    for (const migrate of [false, true]) {
      const original = { id: 'anchor', type: 'anchor', value: 1, intensity: 2, remainingDuration: 3 }
      const battle = makeState({ pieces: [makePiece({ instanceId: 'piece-1', statusTags: [{ ...original }] })] })
      const flow = createFlowRuntime(battle, {}, 'skill', {})
      const compiled = compileGameplayModuleGraph(migrate ? migrateAbilityWriteModules(source) : source, registry)
      runInNewContext('(' + compiled.code + ')', { flow })({})
      expect(battle.pieces[0]!.statusTags).toEqual([original])
    }
  })
  it('updates only the first matching status and preserves empty-match results', () => {
    for (const moduleId of ['status.replace-related-rules', 'status.refresh-position']) for (const present of [true, false]) {
      const position = moduleId === 'status.refresh-position'
      const source: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body: [
        call('piece', fixturePiece.id),
        call('write', moduleId, position
          ? { target: output('piece', 'piece'), x: { kind: 'literal', value: 2 }, y: { kind: 'literal', value: 3 } }
          : { piece: output('piece', 'piece'), rules: { kind: 'literal', value: ['new-rule'] } },
        position ? { statusType: 'anchor', duration: 2 } : { statusId: 'same', statusType: 'anchor' }),
        { kind: 'return', id: 'done', value: output('write', position ? 'success' : 'changed') },
      ], outputs: [{ name: 'value', type: 'boolean' }] }
      const snapshots: unknown[] = []
      for (const migrate of [false, true]) {
        const battle = makeState({ pieces: [makePiece({ instanceId: 'piece-1', statusTags: present ? [{ id: 'same', type: 'anchor' }, { id: 'same', type: 'anchor' }] : [] })] })
        const flow = createFlowRuntime(battle, {}, 'skill', {})
        const compiled = compileGameplayModuleGraph(migrate ? migrateAbilityWriteModules(source) : source, registry)
        expect(runInNewContext('(' + compiled.code + ')', { flow })({})).toBe(present)
        snapshots.push(battle)
      }
      expect(snapshots[0]).toEqual(snapshots[1])
    }
  })
  it('records spent abilities through field assignment while retaining order and duplicate entries', () => {
    const source: GameplayModuleGraph = { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body: [
      call('piece', fixturePiece.id),
      call('spent', 'ability.mark-spent', { piece: output('piece', 'piece') }, { abilityId: 'passive' }),
    ] }
    for (const initial of [undefined, [], ['older', 'passive']]) {
      const snapshots: unknown[] = []
      for (const migrate of [false, true]) {
        const battle = makeState({ pieces: [makePiece({ instanceId: 'piece-1' })] })
        if (initial) battle.pieces[0]!.spentPassives = [...initial]
        const flow = createFlowRuntime(battle, {}, 'skill', {})
        const compiled = compileGameplayModuleGraph(migrate ? migrateAbilityWriteModules(source) : source, registry)
        runInNewContext('(' + compiled.code + ')', { flow })({})
        expect(battle.pieces[0]!.spentPassives).toEqual([...(initial ?? []), 'passive'])
        snapshots.push(battle)
      }
      expect(snapshots[0]).toEqual(snapshots[1])
    }
  })
  it('adjusts every instance including duplicate and passive skills with the same empty-list result', () => {
    for (const mode of ['add', 'atLeast']) for (const skills of [[], [
      { skillId: 'duplicate', currentCooldown: 3 },
      { skillId: 'duplicate', currentCooldown: 0 },
      { skillId: 'passive', currentCooldown: undefined },
    ]]) {
      const source = graph([
        call('piece-ref', 'test.ability-piece'),
        call('write', 'skill.adjust-all-cooldowns', { piece: output('piece-ref', 'piece'), amount: input('amount') }, { mode }),
        { kind: 'return', id: 'done', values: { success: output('write', 'success') } },
      ], [{ name: 'amount', type: 'number' }], [{ name: 'success', type: 'boolean' }])
      const before = runtime(structuredClone(skills)), after = runtime(structuredClone(skills))
      expect(execute(source, true, after)).toEqual(execute(source, false, before))
      expect(after.piece.skills).toEqual(before.piece.skills)
    }
  })
  it('retires the convenience writers and converges on a second pass', () => {
    for (const moduleId of ATOMIC_ABILITY_WRITE_MODULES) {
      const inputs: Readonly<Record<string, GameplayValue>> = moduleId === 'followup.remove-status-types'
        ? { piece: output('piece-ref', 'piece'), types: input('types') }
        : ['skill.adjust-active-cooldowns-at-least', 'skill.adjust-all-cooldowns'].includes(moduleId)
          ? { piece: output('piece-ref', 'piece'), amount: input('amount') }
          : { piece: output('piece-ref', 'piece') }
      const source = graph([
        call('piece-ref', 'test.ability-piece'),
        call('write', moduleId, inputs, moduleId === 'skill.reset-cooldowns' ? { excludeSkillId: 'keep' }
          : moduleId === 'status.refresh-position' ? { duration: 2, statusType: 'anchor' } : {}),
        { kind: 'return', id: 'done', values: { value: output('write', moduleId === 'followup.remove-status-types' ? 'success' : 'success') } },
      ], ['skill.adjust-active-cooldowns-at-least', 'skill.adjust-all-cooldowns'].includes(moduleId)
        ? [{ name: 'amount', type: 'number' }]
        : moduleId === 'followup.remove-status-types'
          ? [{ name: 'types', type: { kind: 'list', element: 'string' } }]
          : [],
      [{ name: 'value', type: 'boolean' }])
      const migrated = migrateAbilityWriteModules(source)
      const modules: string[] = []
      const visit = (items: readonly GameplayStatement[]): void => items.forEach(statement => {
        if (statement.kind === 'call') modules.push(statement.module)
        if (statement.kind === 'foreach' || statement.kind === 'collection') visit(statement.body)
      })
      visit(migrated.body)
      expect(modules).not.toContain(moduleId)
      expect(migrateAbilityWriteModules(migrated)).toEqual(migrated)
    }
  })

  it('resets only positive cooldowns and keeps duplicate skill instances independent', () => {
    const source = graph([
      call('piece-ref', 'test.ability-piece'),
      call('write', 'skill.reset-cooldowns', { piece: output('piece-ref', 'piece') }, { excludeSkillId: 'excluded' }),
      { kind: 'return', id: 'done', values: { success: output('write', 'success'), present: output('write', 'present') } },
    ], [], [{ name: 'success', type: 'boolean' }, { name: 'present', type: 'boolean' }])
    const skills = [
      { skillId: 'duplicate', currentCooldown: 3 },
      { skillId: 'duplicate', currentCooldown: 0 },
      { skillId: 'excluded', currentCooldown: 4 },
      { skillId: 'missing', currentCooldown: undefined },
    ]
    const oldState = runtime(structuredClone(skills))
    const newState = runtime(structuredClone(skills))
    expect(execute(source, false, oldState)).toEqual(execute(source, true, newState))
    expect(newState.piece.skills).toEqual([
      { skillId: 'duplicate', currentCooldown: 0 },
      { skillId: 'duplicate', currentCooldown: 0 },
      { skillId: 'excluded', currentCooldown: 4 },
      { skillId: 'missing', currentCooldown: undefined },
    ])
    expect(newState.setCalls).toEqual([{ index: 0, value: 0 }])
  })

  it('resets all positive cooldowns when no exclusion is supplied', () => {
    const source = graph([
      call('piece-ref', 'test.ability-piece'),
      call('write', 'skill.reset-cooldowns', { piece: output('piece-ref', 'piece') }),
      { kind: 'return', id: 'done', values: { success: output('write', 'success') } },
    ], [], [{ name: 'success', type: 'boolean' }])
    const skills = [
      { skillId: 'first', currentCooldown: 3 },
      { skillId: 'second', currentCooldown: 0 },
      { skillId: 'third', currentCooldown: 2 },
    ]
    const oldState = runtime(structuredClone(skills))
    const newState = runtime(structuredClone(skills))
    expect(execute(source, false, oldState)).toEqual(execute(source, true, newState))
    expect(newState.piece.skills).toEqual([
      { skillId: 'first', currentCooldown: 0 },
      { skillId: 'second', currentCooldown: 0 },
      { skillId: 'third', currentCooldown: 0 },
    ])
    expect(newState.setCalls).toEqual([{ index: 0, value: 0 }, { index: 2, value: 0 }])
  })

  it('raises every active or undefined-kind instance to the requested minimum in order', () => {
    const source = graph([
      call('piece-ref', 'test.ability-piece'),
      call('write', 'skill.adjust-active-cooldowns-at-least', { piece: output('piece-ref', 'piece'), amount: input('amount') }),
      { kind: 'return', id: 'done', values: { success: output('write', 'success'), present: output('write', 'present') } },
    ], [{ name: 'amount', type: 'number' }], [{ name: 'success', type: 'boolean' }, { name: 'present', type: 'boolean' }])
    const skills = [
      { skillId: 'active-a', currentCooldown: 1 },
      { skillId: 'passive', currentCooldown: 7 },
      { skillId: 'active-a', currentCooldown: 4 },
      { skillId: 'empty-definition', currentCooldown: 9 },
      { skillId: 'unknown', currentCooldown: 0 },
    ]
    const definitions = { 'active-a': { kind: 'active' }, passive: { kind: 'passive' }, 'empty-definition': {} }
    const oldState = runtime(structuredClone(skills), [], definitions)
    const newState = runtime(structuredClone(skills), [], definitions)
    expect(execute(source, false, oldState)).toEqual(execute(source, true, newState))
    expect(newState.piece.skills).toEqual([
      { skillId: 'active-a', currentCooldown: 2 },
      { skillId: 'passive', currentCooldown: 7 },
      { skillId: 'active-a', currentCooldown: 4 },
      { skillId: 'empty-definition', currentCooldown: 9 },
      { skillId: 'unknown', currentCooldown: 2 },
    ])
    expect(newState.setCalls).toEqual([{ index: 0, value: 2 }, { index: 2, value: 4 }, { index: 4, value: 2 }])
  })

  it('filters statuses by type and removes each matching record through the status boundary', () => {
    const source = graph([
      call('piece-ref', 'test.ability-piece'),
      call('write', 'followup.remove-status-types', { piece: output('piece-ref', 'piece'), types: input('types') }),
      { kind: 'return', id: 'done', values: { success: output('write', 'success') } },
    ], [{ name: 'types', type: { kind: 'list', element: 'string' } }], [{ name: 'success', type: 'boolean' }])
    const statuses = [
      { id: 'keep-a', type: 'keep', relatedRules: ['rule-1'] },
      { id: 'remove-a', type: 'remove-a', skillIds: ['skill-1'] },
      { type: 'remove-a', skillIds: ['skill-2'] },
      { id: 'keep-b', type: 'keep', relatedRules: ['rule-2'] },
      { type: 'remove-b' },
    ]
    const oldState = runtime([], structuredClone(statuses))
    const newState = runtime([], structuredClone(statuses))
    expect(execute(source, false, oldState)).toEqual(execute(source, true, newState))
    expect(newState.piece.statusTags).toEqual([
      { id: 'keep-a', type: 'keep', relatedRules: ['rule-1'] },
      { id: 'keep-b', type: 'keep', relatedRules: ['rule-2'] },
    ])
    expect(newState.statusInstanceRemovals).toBe(3)
    expect(newState.statusIdRemovals).toBe(0)
  })

  it('returns the legacy absence result for an absent skill array and keeps empty status collections successful', () => {
    const reset = graph([
      call('piece-ref', 'test.ability-piece'),
      call('write', 'skill.reset-cooldowns', { piece: output('piece-ref', 'piece') }),
      { kind: 'return', id: 'done', values: { success: output('write', 'success'), present: output('write', 'present') } },
    ], [], [{ name: 'success', type: 'boolean' }, { name: 'present', type: 'boolean' }])
    const state = runtime(undefined)
    expect(execute(reset, true, state)).toEqual({ success: false, present: false })

    const remove = graph([
      call('piece-ref', 'test.ability-piece'),
      call('write', 'followup.remove-status-types', { piece: output('piece-ref', 'piece'), types: input('types') }),
      { kind: 'return', id: 'done', values: { success: output('write', 'success') } },
    ], [{ name: 'types', type: { kind: 'list', element: 'string' } }], [{ name: 'success', type: 'boolean' }])
    expect(execute(remove, true, runtime([], []))).toEqual({ success: true })
  })

  it('propagates an invalid status target instead of returning an unconditional success', () => {
    const remove = graph([
      call('piece-ref', 'test.missing-ability-piece'),
      call('write', 'followup.remove-status-types', { piece: output('piece-ref', 'piece'), types: input('types') }),
      { kind: 'return', id: 'done', values: { success: output('write', 'success') } },
    ], [{ name: 'types', type: { kind: 'list', element: 'string' } }], [{ name: 'success', type: 'boolean' }])
    expect(execute(remove, true, runtime([], []))).toBeUndefined()
  })

  it('propagates an invalid required amount even when no skill instances would be written', () => {
    const source = graph([
      call('piece-ref', 'test.ability-piece'),
      call('amount-ref', 'test.invalid-ability-amount'),
      call('write', 'skill.adjust-active-cooldowns-at-least', {
        piece: output('piece-ref', 'piece'), amount: output('amount-ref', 'amount'),
      }),
      { kind: 'return', id: 'done', values: { success: output('write', 'success') } },
    ], [], [{ name: 'success', type: 'boolean' }])
    const oldResult = execute(source, false, runtime([]))
    const newResult = execute(source, true, runtime([]))
    expect(oldResult).toBeUndefined()
    expect(newResult).toBeUndefined()
  })

  it('propagates an invalid required status-type collection even when no status matches', () => {
    const source = graph([
      call('piece-ref', 'test.ability-piece'),
      call('types-ref', 'test.invalid-status-types'),
      call('write', 'followup.remove-status-types', {
        piece: output('piece-ref', 'piece'), types: output('types-ref', 'types'),
      }),
      { kind: 'return', id: 'done', values: { success: output('write', 'success') } },
    ], [], [{ name: 'success', type: 'boolean' }])
    const oldResult = execute(source, false, runtime([], []))
    const newResult = execute(source, true, runtime([], []))
    expect(oldResult).toBeUndefined()
    expect(newResult).toBeUndefined()
  })
})
