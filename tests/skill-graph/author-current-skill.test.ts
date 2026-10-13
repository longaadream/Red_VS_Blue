import { describe, expect, it } from 'vitest'

import { createSkillCodeFlow } from '../../lib/game/skills'
import { createGameplayModuleDiagnosticHost, installGameplayModuleDiagnosticHost } from '../../lib/game/gameplay-module-diagnostics'
import { lowerAuthorExpression } from '../../lib/skill-graph/author-expression-graph'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { AUTHOR_SKILL_INSTANCE_MODULES } from '../../lib/skill-graph/module-registry-author-skill-instance'
import {
  GAMEPLAY_MODULE_GRAPH_VERSION,
  type GameplayJsonValue,
  type GameplayModuleGraph,
  type GameplayModuleRegistry,
  type GameplayStatement,
  type GameplayValue,
} from '../../lib/skill-graph/module-types'
import { makePiece, makeState } from '../helpers/minimal-state'

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })

const registry: GameplayModuleRegistry = {
  get: (id, version) => AUTHOR_SKILL_INSTANCE_MODULES.find(item => item.id === id && item.version === (version ?? '1'))
    ?? GAMEPLAY_MODULE_REGISTRY.get(id, version),
  resolve: (id, version) => AUTHOR_SKILL_INSTANCE_MODULES.find(item => item.id === id && item.version === (version ?? '1'))
    ?? GAMEPLAY_MODULE_REGISTRY.resolve(id, version),
  descriptors: [...GAMEPLAY_MODULE_REGISTRY.descriptors, ...AUTHOR_SKILL_INSTANCE_MODULES],
}

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
): GameplayStatement {
  return { kind: 'call', id, module, version: '1', inputs, parameters }
}

function graph(body: readonly GameplayStatement[], outputs: GameplayModuleGraph['outputs']): GameplayModuleGraph {
  return { version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', body, outputs }
}

function expressionGraph(expression: string): GameplayModuleGraph {
  const lowered = lowerAuthorExpression(expression, { surface: 'skill' })
  return graph([
    ...lowered.statements,
    { kind: 'return', id: 'done', value: lowered.value },
  ], [{ name: 'value', type: lowered.type }])
}

function activeSkillGraph(): GameplayModuleGraph {
  return graph([
    call('current', 'ref.current-skill'),
    call('before-cooldown', 'author.skill-instance.field', { instance: output('current', 'instance') }, { field: 'currentCooldown' }),
    call('before-uses', 'author.skill-instance.field', { instance: output('current', 'instance') }, { field: 'usesRemaining' }),
    call('before-skill-id', 'author.skill-instance.field', { instance: output('current', 'instance') }, { field: 'skillId' }),
    call('before-level', 'author.skill-instance.field', { instance: output('current', 'instance') }, { field: 'level' }),
    call('owner', 'author.skill-instance.field', { instance: output('current', 'instance') }, { field: 'owner' }),
    call('write-cooldown', 'author.skill-instance.write', { instance: output('current', 'instance'), value: literal(0) }, { field: 'currentCooldown' }),
    call('write-uses', 'author.skill-instance.write', { instance: output('current', 'instance'), value: literal(1) }, { field: 'usesRemaining' }),
    call('write-level', 'author.skill-instance.write', { instance: output('current', 'instance'), value: literal(3) }, { field: 'level' }),
    call('after-cooldown', 'author.skill-instance.field', { instance: output('current', 'instance') }, { field: 'currentCooldown' }),
    call('after-uses', 'author.skill-instance.field', { instance: output('current', 'instance') }, { field: 'usesRemaining' }),
    call('after-level', 'author.skill-instance.field', { instance: output('current', 'instance') }, { field: 'level' }),
    { kind: 'return', id: 'done', values: {
      beforeCooldown: output('before-cooldown'),
      cooldownDefined: output('before-cooldown', 'defined'),
      beforeUses: output('before-uses'),
      beforeSkillId: output('before-skill-id'),
      beforeLevel: output('before-level'),
      owner: output('owner'),
      cooldownSuccess: output('write-cooldown', 'success'),
      usesSuccess: output('write-uses', 'success'),
      levelSuccess: output('write-level', 'success'),
      afterCooldown: output('after-cooldown'),
      afterUses: output('after-uses'),
      afterLevel: output('after-level'),
    } },
  ], [
    { name: 'beforeCooldown', type: 'number' },
    { name: 'cooldownDefined', type: 'boolean' },
    { name: 'beforeUses', type: 'number' },
    { name: 'beforeSkillId', type: 'string' },
    { name: 'beforeLevel', type: 'number' },
    { name: 'owner', type: 'piece' },
    { name: 'cooldownSuccess', type: 'boolean' },
    { name: 'usesSuccess', type: 'boolean' },
    { name: 'levelSuccess', type: 'boolean' },
    { name: 'afterCooldown', type: 'number' },
    { name: 'afterUses', type: 'number' },
    { name: 'afterLevel', type: 'number' },
  ])
}

function execute(graphValue: GameplayModuleGraph, pieceSkills: Array<{ skillId: string; level?: number; currentCooldown?: number; usesRemaining?: number }>, skillId = 'current-skill') {
  const piece = makePiece({ instanceId: 'caster', skills: pieceSkills })
  const battle = makeState({ pieces: [piece] })
  battle.skillsById[skillId] = { id: skillId } as never
  const context = {
    piece,
    sourcePiece: piece,
    playerId: piece.ownerPlayerId,
    skill: { id: skillId },
  }
  const flow = createSkillCodeFlow(battle, context, 'skill')
  const compiled = compileGameplayModuleGraph(graphValue, registry)
  const run = Function('context', 'flow', 'battle', `return (${compiled.code})(context)`) as (context: unknown, flow: unknown, battle: unknown) => unknown
  return { piece, battle, context, flow, compiled, run }
}

describe('author skill instance modules', () => {
  it('publishes a current instance reference, typed closed fields, and only writable runtime fields', () => {
    const current = AUTHOR_SKILL_INSTANCE_MODULES.find(item => item.id === 'ref.current-skill')!
    const field = AUTHOR_SKILL_INSTANCE_MODULES.find(item => item.id === 'author.skill-instance.field')!
    const write = AUTHOR_SKILL_INSTANCE_MODULES.find(item => item.id === 'author.skill-instance.write')!

    expect(current.outputs).toEqual([expect.objectContaining({ name: 'instance', type: 'record' })])
    expect(current.allowedSurfaces).toEqual(['skill', 'pending'])
    expect(field.outputs?.find(output => output.name === 'value')).toMatchObject({ type: 'unknown' })
    expect(field.outputs?.find(output => output.name === 'value')?.nullable).toBeUndefined()
    expect(field.parameters?.[0]?.enum).toEqual(['currentCooldown', 'usesRemaining', 'skillId', 'level', 'owner'])
    expect(field.outputParameterTypeBindings?.value.types).toEqual({
      currentCooldown: 'number',
      usesRemaining: 'number',
      skillId: 'string',
      level: 'number',
      owner: 'piece',
    })
    expect(write.parameters?.[0]?.enum).toEqual(['currentCooldown', 'usesRemaining', 'level'])
    expect(write.parameters?.[0]?.enum).not.toContain('skillId')
  })

  it('reads and writes the installed current skill instance through the authoritative runtime', () => {
    const state = execute(activeSkillGraph(), [{ skillId: 'current-skill', level: 2, currentCooldown: 4, usesRemaining: 2 }])

    expect(state.compiled.diagnostics).toEqual([])
    expect(state.run(state.context, state.flow, state.battle)).toEqual({
      beforeCooldown: 4,
      cooldownDefined: true,
      beforeUses: 2,
      beforeSkillId: 'current-skill',
      beforeLevel: 2,
      owner: 'caster',
      cooldownSuccess: true,
      usesSuccess: true,
      levelSuccess: true,
      afterCooldown: 0,
      afterUses: 1,
      afterLevel: 3,
    })
    expect(state.piece.skills[0]).toMatchObject({ skillId: 'current-skill', level: 3, currentCooldown: 0, usesRemaining: 1 })
  })

  it('keeps current skill numeric fields usable in arithmetic', () => {
    const state = execute(expressionGraph('当前技能.冷却 + 1'), [{ skillId: 'current-skill', currentCooldown: 4 }])

    expect(state.compiled.diagnostics).toEqual([])
    expect(state.run(state.context, state.flow, state.battle)).toEqual(5)
  })

  it('invalidates a statement when a current skill field is absent', () => {
    const state = execute(expressionGraph('当前技能.冷却 + 1'), [{ skillId: 'current-skill' }])
    const diagnostics = createGameplayModuleDiagnosticHost('skill', {}, () => undefined)
    const restore = installGameplayModuleDiagnosticHost(state.context, diagnostics)
    try {
      expect(state.run(state.context, state.flow, state.battle)).toBeUndefined()
    } finally {
      restore()
    }
    expect(diagnostics.diagnostics).toHaveLength(1)
    expect(state.piece.skills).toEqual([{ skillId: 'current-skill' }])
  })

  it('invalidates an unavailable current skill instead of falling back to its definition', () => {
    const currentOnly = graph([
      call('current', 'ref.current-skill'),
      { kind: 'return', id: 'done', value: output('current', 'instance') },
    ], [{ name: 'value', type: 'record' }])
    const state = execute(currentOnly, [{ skillId: 'different-skill', level: 1 }])
    const diagnostics = createGameplayModuleDiagnosticHost('skill', {}, () => undefined)
    const restore = installGameplayModuleDiagnosticHost(state.context, diagnostics)
    try {
      expect(state.run(state.context, state.flow, state.battle)).toBeUndefined()
    } finally {
      restore()
    }
    expect(diagnostics.diagnostics).toHaveLength(1)
    expect(state.piece.skills).toEqual([{ skillId: 'different-skill', level: 1 }])
  })

  it('rejects skill-id replacement at graph validation time', () => {
    const graphValue = graph([
      call('current', 'ref.current-skill'),
      call('write', 'author.skill-instance.write', {
        instance: output('current', 'instance'),
        value: literal('replacement'),
      }, { field: 'skillId' }),
      { kind: 'return', id: 'done', value: output('write', 'success') },
    ], [{ name: 'value', type: 'boolean' }])

    expect(() => compileGameplayModuleGraph(graphValue, registry)).toThrow()
  })
})
