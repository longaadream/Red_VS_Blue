import { describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph, GAMEPLAY_MODULE_GRAPH_VERSION, type GameplayModuleGraph, type GameplayValue } from '../../lib/skill-graph/module-document'
import { executeSkillFunction, type SkillDefinition } from '../../lib/game/skills'
import { RuleRuntime, createRuleExecutionContext, withRuleExecutionContext, withRuleRuntime } from '../../lib/game/rule-runtime'
import { TriggerSystem } from '../../lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })
const literal = (value: number): GameplayValue => ({ kind: 'literal', value })
function effectGraph(effect: 'damage' | 'heal'): GameplayModuleGraph {
  return {
    version: GAMEPLAY_MODULE_GRAPH_VERSION, surface: 'skill', outputs: [{ name: 'result', type: 'record' }],
    body: [
      { kind: 'call', id: 'holder', module: 'ref.holder', version: '1' },
      { kind: 'call', id: 'source', module: 'query.piece', version: '1', inputs: { pieceId: output('holder', 'piece') } },
      { kind: 'call', id: 'selected', module: 'ref.target', version: '1' },
      { kind: 'call', id: 'target', module: 'query.piece', version: '1', inputs: { pieceId: output('selected', 'piece') } },
      { kind: 'call', id: 'effect', module: `effect.${effect}`, version: '1', inputs: { source: output('source', 'piece'), target: output('target', 'piece'), amount: literal(3) }, parameters: { skillId: 'module-effect' } },
      { kind: 'return', id: 'done', value: output('effect', 'result') },
    ],
  }
}
const definition = { id: 'module-effect', name: '模块效果', kind: 'active', type: 'normal', actionPointCost: 0, cooldownTurns: 0, maxCharges: 0, powerMultiplier: 1 }

function execute(skill: SkillDefinition) {
  const source = makePiece({ instanceId: 'source', ownerPlayerId: 'player-red', x: 0, y: 0 })
  const target = makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 7, maxHp: 12, defense: 1 })
  const battle = makeState({ pieces: [source, target] })
  const runtime = new RuleRuntime({ rootSeed: 252 })
  const result = withRuleExecutionContext(createRuleExecutionContext(new TriggerSystem()), () => withRuleRuntime(runtime, () => executeSkillFunction(skill, {
    piece: source, target, targetPosition: null, targets: [], skill, battle,
  }, battle)))
  return { result, battle, random: runtime.snapshot() }
}

describe('registered effect modules use real authoritative effect batches', () => {
  for (const effect of ['damage', 'heal'] as const) it(`${effect} retains result, events, logs and fixed-seed state`, () => {
    const graph = applyGameplayModuleGraph(definition, effectGraph(effect)) as unknown as SkillDefinition
    const call = effect === 'damage'
      ? "dealDamage(context.piece, context.target, 3, 'physical', context.battle, 'module-effect')"
      : "healDamage(context.piece, context.target, 3, context.battle, 'module-effect')"
    const legacy = { ...definition, code: `function executeSkill(context) { return ${call}; }` } as SkillDefinition
    const expected = execute(legacy)
    const actual = execute(graph)
    expect(actual).toEqual(expected)
    expect(actual.battle.pieces[1].currentHp).toBe(effect === 'damage' ? 4 : 10)
  })
})
