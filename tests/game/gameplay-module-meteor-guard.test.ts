/* eslint-disable @typescript-eslint/no-explicit-any -- frozen rule differential contexts. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { clearRuleCache, dealDamage, loadRuleById } from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { recordBattlePresentation, recordedBattlePresentation } from '@/lib/game/battle-presentation-recording'
import { buildMeteorGuardGraph } from '@/scripts/migrate-semantic-meteor-guard'
import { makePiece, makePlayer, makeState } from '../helpers/minimal-state'

const original = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries['rules/rule-el-primo-meteor-belt']
const migrated = applyGameplayModuleGraph(original, buildMeteorGuardGraph(), 'skillCode')
type Case = 'success' | 'teammate' | 'diagonal' | 'distant' | 'enemy' | 'self' | 'dead-guard' | 'missing-guard' | 'dead-target' | 'missing-target' | 'no-status' | 'off-board' | 'no-queue' | 'rejected-queue'

function run(semantic: boolean, scenario: Case, realDamage = false, lethal = false) {
  const root = mkdtempSync(join(tmpdir(), 'rvb-meteor-guard-')), previousRoot = process.env.RVB_PROFILE_ROOT
  mkdirSync(join(root, 'data/rules'), { recursive: true })
  writeFileSync(join(root, 'data/rules', original.id + '.json'), JSON.stringify(semantic ? migrated : original))
  try {
    process.env.RVB_PROFILE_ROOT = root
    clearRuleCache()
    const rule = loadRuleById(original.id, true, true)!
    const guard: any = makePiece({ instanceId: 'guard', ownerPlayerId: 'player-red', x: 2, y: 1, currentHp: lethal ? 1 : 100 })
    guard.name = '普里莫'; guard.defense = 1
    guard.statusTags = [{ id: 'belt', type: 'el-primo-meteor-belt', currentDuration: -1 }]
    const target: any = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 1, y: 1 })
    target.name = '友军'
    const attacker: any = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 4, y: 4 })
    const battle: any = makeState({ pieces: [attacker, target, guard] })
    if (scenario === 'teammate') {
      target.ownerPlayerId = 'red-ally'
      battle.players.find((p: any) => p.playerId === 'player-red').teamId = 'red'
      battle.players.push({ ...makePlayer('red-ally', 'red'), teamId: 'red' })
    }
    if (scenario === 'diagonal') target.y = 2
    if (scenario === 'distant') target.x = 5
    if (scenario === 'enemy') target.ownerPlayerId = 'player-blue'
    if (scenario === 'dead-guard') guard.currentHp = 0
    if (scenario === 'dead-target') target.currentHp = 0
    if (scenario === 'off-board') guard.x = null
    if (scenario === 'no-status') guard.statusTags = []
    if (scenario === 'missing-guard') battle.pieces = battle.pieces.filter((p: any) => p !== guard)
    const queued: string[] = []
    const context: any = { type: 'beforeDamageRedirect', rulePiece: guard, piece: scenario === 'missing-target' ? null : scenario === 'self' ? guard : target, sourcePiece: attacker,
      damage: 8, playerId: 'player-red', damageRedirectQueue: scenario === 'no-queue' ? undefined : { push: ({ target: next }: any) => { queued.push(next.instanceId); return scenario !== 'rejected-queue' } } }
    const runtime = new RuleRuntime({ rootSeed: 594 })
    if (realDamage) globalTriggerSystem.addRule({ ...rule, effect: (state, event) => rule.effect(state, { ...event, rulePiece: guard }) })
    const result = recordBattlePresentation(battle, () => withRuleRuntime(runtime, () => realDamage ? dealDamage(attacker, target, 8, 'physical', battle, 'test-hit') : rule.effect(battle, context)), () => battle)
    return { result, state: JSON.parse(JSON.stringify(battle)), runtime: runtime.snapshot(), queued, presentation: recordedBattlePresentation(battle) }
  } finally {
    globalTriggerSystem.clearRules(); clearRuleCache()
    if (previousRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
}

describe('semantic Meteor Belt protection', () => {
  const cases: Case[] = ['success', 'teammate', 'diagonal', 'distant', 'enemy', 'self', 'dead-guard', 'missing-guard', 'dead-target', 'missing-target', 'no-status', 'off-board', 'no-queue', 'rejected-queue']
  for (const scenario of cases) it(`matches frozen guard and queue behavior: ${scenario}`, () => {
    const actual = run(true, scenario)
    expect(actual).toEqual(run(false, scenario))
    expect(actual.result.success).toBe(scenario === 'success' || scenario === 'diagonal' || scenario === 'teammate')
    if (actual.result.success) expect(actual.queued).toEqual(['guard'])
  })
  for (const lethal of [false, true]) it(`uses real redirect lifecycle, lethal=${lethal}`, () => {
    const actual = run(true, 'success', true, lethal)
    expect(actual).toEqual(run(false, 'success', true, lethal))
    expect(actual.result.redirectedTo).toBe('guard')
    expect(actual.state.pieces.find((p: any) => p.instanceId === 'ally').currentHp).toBe(100)
    if (lethal) expect(actual.state.graveyard.some((p: any) => p.instanceId === 'guard')).toBe(true)
    else expect(actual.state.pieces.find((p: any) => p.instanceId === 'guard').currentHp).toBeLessThan(100)
  })
})
