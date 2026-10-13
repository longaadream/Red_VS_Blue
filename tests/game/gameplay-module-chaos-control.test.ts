/* eslint-disable @typescript-eslint/no-explicit-any -- full-state frozen baseline differential fixtures. */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { executeSkillFunction, dealDamage } from '@/lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { recordBattlePresentation, recordedBattlePresentation } from '@/lib/game/battle-presentation-recording'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { prepareAction } from '@/lib/game/targeting'
import { runBattleAction } from '@/lib/game/battle-runner'
import { buildChaosControlGraph } from '@/scripts/migrate-semantic-chaos-control'
import { makePiece, makeState } from '../helpers/minimal-state'
const original = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries['skills/shadow-chaos-control']
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
function run(semantic: boolean, scenario: string, host = false) {
  const runtime = new RuleRuntime({ rootSeed: 594 })
  return withRuleRuntime(runtime, () => {
    const caster: any = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', faction: 'red', x: 1, y: 1 })
    const enemy: any = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 3 })
    const ally: any = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', faction: 'red', x: 4, y: 4 })
    const far: any = makePiece({ instanceId: 'far', ownerPlayerId: 'player-blue', faction: 'blue', x: 7, y: 7 })
    const battle: any = makeState({ pieces: [caster, enemy, ally, far], width: 9, height: 9 })
    let position: any = { x: 3, y: 3 }
    if (scenario === 'self') position = { x: 1, y: 1 }
    if (scenario === 'occupied') position = { x: 4, y: 3 }
    if (scenario === 'outside') position = { x: 30, y: 30 }
    if (scenario === 'dead-target') enemy.currentHp = 0
    if (scenario === 'no-enemy') enemy.ownerPlayerId = 'player-red'
    if (scenario === 'refresh') enemy.statusTags = [{ id: 'existing-root', type: 'chidori-immobile', name: '定身', currentDuration: 4, remainingDuration: 4, stacks: 3 }]
    const tile = battle.map.tiles.find((t: any) => t.x === 3 && t.y === 3)
    tile.props.type = scenario === 'cover' ? 'cover' : scenario === 'other-terrain' ? 'water' : 'floor'
    if (scenario === 'unwalkable') tile.props.walkable = false
    if (scenario === 'blocked' || scenario === 'source-death') globalTriggerSystem.addRule({
      id: 'chaos-test-hook', name: 'test', description: '', trigger: { type: 'beforePiecePositionChange' },
      effect: (state: any, context: any) => {
        if (context.sourcePiece?.instanceId !== caster.instanceId) return { success: false }
        if (scenario === 'source-death') { dealDamage(enemy, caster, 999, 'true', state, 'test'); return { success: true } }
        return { success: true, blocked: true }
      },
    } as any)
    const skill: any = semantic ? applyGameplayModuleGraph(original, buildChaosControlGraph()) : original
    battle.skillsById[skill.id] = skill
    try {
      if (host) {
        caster.skills = [{ skillId: skill.id, currentCooldown: 0, usesRemaining: -1 }]
        battle.turn.phase = 'action'; battle.turn.currentPlayerId = 'player-red'
        battle.players[0].chargePoints = 5; battle.players[0].actionPoints = 5
        const base: any = { type: 'useChargeSkill', playerId: 'player-red', pieceId: caster.instanceId, skillId: skill.id }
        const selection = prepareAction(battle, base)
        if (selection.kind !== 'needTarget') throw new Error(`Expected target choice, got ${selection.kind}`)
        const outcome = recordBattlePresentation(battle, () => runBattleAction(battle, {
          ...base, targetX: position.x, targetY: position.y, selectionId: selection.selectionId, stateRevision: selection.stateRevision,
        }, { rootSeed: 594 }), result => result.state)
        const state: Record<string, unknown> = clone({ ...outcome.state }); delete state.skillsById
        return { state, trace: outcome.trace, stateHash: outcome.stateHash, presentation: clone(recordedBattlePresentation(outcome.state)) }
      }
      const result = recordBattlePresentation(battle, () => executeSkillFunction(skill, {
        piece: caster, skill, battle, playerId: 'player-red', targetPosition: scenario === 'pending' ? null : position,
        targets: scenario === 'pending' ? [] : [{ info: null, pos: position }],
      } as any, battle), () => battle)
      const state = clone(battle); delete state.skillsById
      return { result, state, runtime: runtime.snapshot(), presentation: clone(recordedBattlePresentation(battle)) }
    } finally { globalTriggerSystem.clearRules() }
  })
}
describe('semantic chaos control', () => {
  beforeEach(() => globalTriggerSystem.clearRules())
  for (const scenario of ['normal', 'cover', 'other-terrain', 'unwalkable', 'self', 'occupied', 'outside', 'dead-target', 'no-enemy', 'refresh', 'pending', 'blocked', 'source-death']) {
    it(`matches frozen state, result, presentation and seeded runtime: ${scenario}`, () => {
      expect(run(true, scenario)).toEqual(run(false, scenario))
    })
  }
  for (const scenario of ['normal', 'cover', 'refresh', 'blocked', 'no-enemy', 'source-death']) {
    it(`matches a real charge-skill transaction: ${scenario}`, () => {
      expect(run(true, scenario, true)).toEqual(run(false, scenario, true))
    })
  }
})
