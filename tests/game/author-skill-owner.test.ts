import { describe, expect, it, vi } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { createSkillCodeFlow } from '../../lib/game/skills'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph } from '../../lib/skill-graph/module-types'
import { makePiece, makeState } from '../helpers/minimal-state'

function fixture() {
  const piece = makePiece({ instanceId: 'holder' })
  const battle = makeState({ pieces: [piece] })
  battle.skillsById = { basic: { id: 'basic', name: '测试技能', description: '', kind: 'active', type: 'normal',
    cooldownTurns: 0, maxCharges: 0, powerMultiplier: 1, code: '', range: 'self', actionPointCost: 0 } }
  const calls: Array<[string, string, string]> = []
  const delegate = (name: string) => vi.fn((owner: string, skill: string) => {
    calls.push([name, owner, skill])
    return true
  })
  const delegates = {
    addPlayerSkillById: delegate('player:add'), removePlayerSkillById: delegate('player:remove'),
    addSkillById: delegate('piece:add'), removeSkillById: delegate('piece:remove'),
  }
  const flow = createFlowRuntime(battle, { piece }, 'skill', delegates)
  return { flow, delegates, calls, piece, battle }
}

function graph(operation: 'add' | 'remove', ownerType: 'piece' | 'player'): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill',
    outputs: [{ name: 'success', type: 'boolean' }],
    body: [
      { kind: 'call', id: 'owner', module: ownerType === 'piece' ? 'ref.holder' : 'ref.player', version: '1' },
      { kind: 'call', id: 'definition', module: 'ref.skill-definition', version: '1', parameters: { skillId: 'basic' } },
      { kind: 'call', id: 'change', module: `skill.${operation}`, version: '2', parameters: { ownerType },
        inputs: { owner: { kind: 'output', node: 'owner', port: ownerType }, skill: { kind: 'output', node: 'definition', port: 'skill' } } },
      { kind: 'return', id: 'done', values: { success: { kind: 'output', node: 'change', port: 'success' } } },
    ],
  }
}

describe('unified typed skill owner', () => {
  it('resolves a real lazy definition without registering it or changing the player skills', () => {
    const battle = makeState()
    battle.skillsById = {}
    const before = structuredClone(battle)
    const flow = createSkillCodeFlow(battle, { playerId: 'player-red' }, 'skill')
    expect(flow.skills.definitionReference('blizzard-damage')).toBe('blizzard-damage')
    expect(battle).toEqual(before)
    expect(battle.skillsById).toEqual({})
  })

  it.each(['add', 'remove'] as const)('routes %s for pieces and players through their original lifecycle', operation => {
    for (const ownerType of ['piece', 'player'] as const) {
      const { flow, calls, piece } = fixture()
      const code = compileGameplayModuleGraph(graph(operation, ownerType), GAMEPLAY_MODULE_REGISTRY).code
      const execute = new Function('flow', `return (${code})`)(flow) as (context: unknown) => unknown
      expect(execute({})).toEqual({ success: true })
      expect(calls).toEqual([[`${ownerType}:${operation}`, ownerType === 'piece' ? 'holder' : 'player-red', 'basic']])
      expect(piece.skills).toEqual([])
    }
  })

  it('keeps unavailable owners and definitions from invoking lifecycle delegates', () => {
    const { flow, calls } = fixture()
    expect(() => flow.skills.definitionReference('missing')).toThrow('技能定义不存在')
    expect(() => flow.skills.definitionReference('__proto__')).toThrow()
    expect(() => flow.skills.add('missing-player', 'basic', 'player')).toThrow()
    expect(() => flow.skills.remove('player-red', 'basic', 'invalid' as 'player')).toThrow()
    expect(calls).toEqual([])
  })

  it('rejects mixing a runtime skill instance into a definition input', () => {
    const original = graph('add', 'piece')
    const wrong: GameplayModuleGraph = {
      ...original,
      body: [
        original.body[0],
        { kind: 'call', id: 'definition', module: 'ref.current-skill', version: '1' },
        ...original.body.slice(2).map(statement => statement.kind === 'call' ? {
          ...statement, inputs: { ...statement.inputs, skill: { kind: 'output' as const, node: 'definition', port: 'instance' } },
        } : statement),
      ],
    }
    expect(() => compileGameplayModuleGraph(wrong, GAMEPLAY_MODULE_REGISTRY)).toThrow()
  })
})
