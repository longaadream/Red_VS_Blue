/* eslint-disable @typescript-eslint/no-explicit-any -- frozen full-state host differential fixtures. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { executeSkillFunction, loadRuleById, clearRuleCache } from '@/lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { recordBattlePresentation, recordedBattlePresentation } from '@/lib/game/battle-presentation-recording'
import { buildTemporalDistortionGraph, buildTemporalRepaymentGraph } from '@/scripts/migrate-semantic-temporal-distortion'
import { makePiece, makeState } from '../helpers/minimal-state'
const original = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries['skills/rafaam-temporal-distortion']
const migrated = applyGameplayModuleGraph(original, buildTemporalDistortionGraph())
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
function run(semantic: boolean, selected: boolean, attack: number, repetitions: number, grave: 'none' | 'source' | 'target') {
  const runtime = new RuleRuntime({ rootSeed: 594 })
  return withRuleRuntime(runtime, () => {
    const caster: any = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 1, y: 1, attack: 7 })
    caster.name = '拉法姆'
    const target: any = makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', x: 2, y: 1, attack })
    target.name = '目标'
    const battle: any = makeState({ pieces: [caster, target] })
    const definition: any = semantic ? migrated : original
    battle.skillsById[definition.id] = definition
    const results: unknown[] = []
    recordBattlePresentation(battle, () => {
      for (let i = 0; i < repetitions; i++) results.push(executeSkillFunction(definition, { piece: caster, skill: definition, battle, target: selected ? target : null, targets: selected ? [{ info: target, pos: null }] : [] } as any, battle))
    }, () => battle)
    const state = clone(battle); delete state.skillsById
    const first = { results: clone(results), state, presentation: clone(recordedBattlePresentation(battle)), runtime: runtime.snapshot() }
    if (!selected) return { first }
    if (grave !== 'none') {
      const moved = grave === 'source' ? caster : target
      battle.pieces = battle.pieces.filter((piece: any) => piece !== moved)
      battle.graveyard.push(moved)
      moved.currentHp = 0
    }
    battle.turn.currentPlayerId = 'player-blue'
    const rule = loadRuleById('rule-rafaam-temporal-distortion')
    if (!rule) throw new Error('missing temporal repayment rule')
    const result = recordBattlePresentation(battle, () => rule.effect(battle, { type: 'endTurn', playerId: 'player-blue', battle } as any), () => battle)
    const after = clone(battle); delete after.skillsById
    return { first, repayment: { result, state: after, presentation: clone(recordedBattlePresentation(battle)), runtime: runtime.snapshot() } }
  })
}
describe('semantic temporal distortion', () => {
  for (const selected of [false, true]) for (const attack of [-2, 0, 8]) for (const repetitions of [1, 2]) for (const grave of ['none', 'source', 'target'] as const) {
    it(`preserves theft and repayment: selected=${selected}, attack=${attack}, repetitions=${repetitions}, grave=${grave}`, () => {
      const actual = run(true, selected, attack, repetitions, grave)
      expect(actual).toEqual(run(false, selected, attack, repetitions, grave))
      if (selected) {
        expect(actual.first.state.pieces[0].attack).toBe(7 + Math.max(0, attack))
        expect(actual.first.state.pieces[1].attack).toBe(Math.min(0, attack))
        const all = [...actual.repayment!.state.pieces, ...actual.repayment!.state.graveyard]
        expect(all.find((piece: any) => piece.instanceId === 'caster').attack).toBe(7)
        expect(all.find((piece: any) => piece.instanceId === 'target').attack).toBe(attack)
      }
    })
  }
})

function runRepayment(semantic: boolean, scenario: string) {
  const root = mkdtempSync(join(tmpdir(), 'rvb-temporal-repay-'))
  const previous = process.env.RVB_PROFILE_ROOT
  const ruleOriginal = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries['rules/rule-rafaam-temporal-distortion']
  mkdirSync(join(root, 'data/rules'), { recursive: true })
  writeFileSync(join(root, 'data/rules/rule-rafaam-temporal-distortion.json'), JSON.stringify(semantic ? applyGameplayModuleGraph(ruleOriginal, buildTemporalRepaymentGraph(), 'skillCode') : ruleOriginal))
  process.env.RVB_PROFILE_ROOT = root
  clearRuleCache()
  try {
    const source: any = makePiece({ instanceId: 'source', ownerPlayerId: 'player-red', attack: scenario === 'underflow' ? 1 : 15 })
    const target: any = makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', attack: 0 })
    const battle: any = makeState({ pieces: [source, target], currentPlayerId: scenario === 'wrong-turn' ? 'player-red' : 'player-blue' })
    const player = battle.players.find((p: any) => p.playerId === 'player-blue')
    player.rules = [{ id: ruleOriginal.id }, { id: 'unrelated' }]
    player.statusTags = [{ id: 'other', type: 'other', intensity: 2 }]
    if (scenario !== 'empty' && scenario !== 'missing-status') player.statusTags.push({ id: 'loan1', type: 'rafaam-temporal-distortion', sourceId: source.instanceId, targetId: target.instanceId, intensity: 8 })
    if (scenario === 'multiple') player.statusTags.push({ id: 'loan2', type: 'rafaam-temporal-distortion', sourceId: source.instanceId, targetId: target.instanceId, intensity: 3 })
    if (scenario === 'missing-status') delete player.statusTags
    if (scenario === 'negative') player.statusTags[1].intensity = -3
    if (scenario === 'missing-amount') delete player.statusTags[1].intensity
    if (scenario === 'graveyard') { battle.pieces = []; battle.graveyard = [source, target] }
    if (scenario === 'missing-target') battle.pieces = [source]
    if (scenario === 'missing-source') battle.pieces = [target]
    if (scenario === 'same-piece') player.statusTags[1].targetId = source.instanceId
    const runtime = new RuleRuntime({ rootSeed: 594 })
    const rule = loadRuleById(ruleOriginal.id)
    if (!rule) throw new Error('missing repayment fixture')
    const result = recordBattlePresentation(battle, () => withRuleRuntime(runtime, () => rule.effect(battle, { type: 'endTurn', playerId: 'player-blue', battle } as any)), () => battle)
    const state = clone(battle); delete state.skillsById
    return { result, state, presentation: clone(recordedBattlePresentation(battle)), runtime: runtime.snapshot() }
  } finally {
    clearRuleCache()
    if (previous === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previous
    rmSync(root, { recursive: true, force: true })
  }
}
describe('semantic attribute repayment', () => {
  for (const scenario of ['normal', 'wrong-turn', 'empty', 'missing-status', 'multiple', 'negative', 'missing-amount', 'graveyard', 'missing-target', 'missing-source', 'same-piece', 'underflow']) {
    it(`matches complete stored state: ${scenario}`, () => expect(runRepayment(true, scenario)).toEqual(runRepayment(false, scenario)))
  }
})
