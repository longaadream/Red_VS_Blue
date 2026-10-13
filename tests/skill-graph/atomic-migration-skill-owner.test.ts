import { describe, expect, it } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { rewriteAtomicGraph } from '../../lib/skill-graph/atomic-graph-rewrite'
import { atomicSkillOwnerRecipe } from '../../lib/skill-graph/atomic-migration-skill-owner'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph } from '../../lib/skill-graph/module-types'
import { makeState } from '../helpers/minimal-state'

function run(graph: GameplayModuleGraph) {
  const battle = makeState()
  battle.skillsById = { 'blizzard-damage': { id: 'blizzard-damage', name: '暴风雪伤害', description: '', kind: 'active', type: 'normal',
    cooldownTurns: 0, maxCharges: 0, powerMultiplier: 1, code: '', range: 'self', actionPointCost: 0 } }
  const held: string[] = []
  const history: string[][] = []
  const delegates = {
    addPlayerSkillById: (player: string, skill: string) => {
      history.push(['add', player, skill]); held.push(skill); return true
    },
    removePlayerSkillById: (player: string, skill: string) => {
      history.push(['remove', player, skill]); held.splice(held.indexOf(skill), 1); return true
    },
  }
  const flow = createFlowRuntime(battle, { playerId: 'player-red' }, 'skill', delegates)
  const code = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code
  const execute = new Function('flow', 'battle', ...Object.keys(delegates), `return (${code})`)(flow, battle, ...Object.values(delegates)) as (context: unknown) => unknown
  return { result: execute({}), held, history }
}

describe('player skill ownership migration', () => {
  it('preserves player, skill, operation order and success outputs through the unified boundary', () => {
    const source: GameplayModuleGraph = {
      version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill',
      outputs: [{ name: 'added', type: 'boolean' }, { name: 'removed', type: 'boolean' }],
      body: [
        { kind: 'call', id: 'player', module: 'ref.player', version: '1' },
        ...(['add', 'remove'] as const).map(operation => ({
          kind: 'call' as const, id: operation, module: `skill.${operation}-player`, version: '1',
          inputs: { player: { kind: 'output' as const, node: 'player', port: 'player' } },
          parameters: { skillId: 'blizzard-damage' },
        })),
        { kind: 'return', id: 'done', values: {
          added: { kind: 'output', node: 'add', port: 'success' },
          removed: { kind: 'output', node: 'remove', port: 'success' },
        } },
      ],
    }
    const migrated = rewriteAtomicGraph(source, atomicSkillOwnerRecipe)
    expect(run(migrated)).toEqual(run(source))
    expect(run(migrated)).toEqual({
      result: { added: true, removed: true }, held: [],
      history: [['add', 'player-red', 'blizzard-damage'], ['remove', 'player-red', 'blizzard-damage']],
    })
    expect(rewriteAtomicGraph(migrated, atomicSkillOwnerRecipe)).toEqual(migrated)
  })
})
