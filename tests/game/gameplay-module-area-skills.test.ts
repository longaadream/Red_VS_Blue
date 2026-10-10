/* eslint-disable @typescript-eslint/no-explicit-any -- Real host differential fixtures. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { executeSkillFunction, loadRuleById } from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { buildAreaSkillGraph, AREA_SKILL_IDS } from '@/scripts/migrate-semantic-area-skills'
import { makePiece, makeState } from '../helpers/minimal-state'

const entries = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries
const clone = (value: any) => JSON.parse(JSON.stringify(value))
function run(id: string, semantic: boolean, hp: number, selected: boolean, shield: boolean, empty: boolean) {
  const original = entries['skills/' + id]
  const definition = semantic ? applyGameplayModuleGraph(original, buildAreaSkillGraph(id)) : original
  const caster = makePiece({ instanceId: 'caster', name: '施放者', x: 4, y: 4, attack: 7, currentHp: 6, maxHp: 20 })
  const targets = empty ? [] : Array.from({ length: 5 }, (_, distance) => makePiece({ instanceId: 'enemy-' + distance, name: '敌人' + distance, ownerPlayerId: 'player-blue', x: 5 + distance, y: 4, currentHp: hp, maxHp: 20, defense: 1 }))
  const allies = Array.from({ length: 4 }, (_, distance) => makePiece({ instanceId: 'ally-' + distance, name: '友军' + distance, x: 5, y: 4 + distance, currentHp: 2, maxHp: 20 }))
  caster.name = '施放者'
  targets.forEach((target, index) => { target.name = '敌人' + index; target.defense = 1 })
  allies.forEach((target, index) => { target.name = '友军' + index })
  if (shield && targets.length) {
    targets[0].statusTags = [{ id: 'shield', type: 'divine-shield' }]
    targets[0].rules = [loadRuleById('rule-divine-shield', true)!]
  }
  const dead = makePiece({ instanceId: 'dead', ownerPlayerId: 'player-blue', x: 4, y: 5, currentHp: 0 })
  const battle = makeState({ pieces: [caster, ...targets, ...allies, dead], width: 12, height: 12 })
  battle.skillsById[id] = definition
  const pos = selected ? { x: 5, y: 4 } : null
  const result = executeSkillFunction(definition, { piece: caster, skill: definition, battle, target: null, targetPosition: pos, targets: selected ? [{ info: null, pos }] : [] } as any, battle)
  const state = clone(battle); delete state.skillsById
  return { result: clone(result), state }
}

describe('semantic area effects preserve batch ordering and presentation', () => {
  it('continues the already-started rings after a damage reaction removes their source', () => {
    const execute = (semantic: boolean) => {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRule({ id: 'remove-source', name: '移除来源', description: '', trigger: { type: 'afterDamageDealt' }, effect: battle => { battle.pieces = battle.pieces.filter(piece => piece.instanceId !== 'caster'); return { success: true } } })
      try { return run('holy-light-descend', semantic, 20, true, false, false) }
      finally { globalTriggerSystem.clearRules() }
    }
    const expected = execute(false), actual = execute(true)
    expect(actual).toEqual(expected)
    expect(actual.state.pieces.some((piece: any) => piece.instanceId === 'caster')).toBe(false)
    expect(actual.state.pieces.find((piece: any) => piece.instanceId === 'enemy-1').currentHp).toBeLessThan(20)
  })
  for (const id of AREA_SKILL_IDS) {
    for (const hp of [2, 20]) for (const shield of [false, true]) it(`${id}, hp=${hp}, shield=${shield}`, () => {
      const expected = run(id, false, hp, true, shield, false)
      expect(expected.result.success).toBe(true)
      expect(expected.state.actions.length).toBeGreaterThan(0)
      expect(run(id, true, hp, true, shield, false)).toEqual(expected)
    })
    it(id + ' preserves pending selection', () => expect(run(id, true, 20, false, false, false)).toEqual(run(id, false, 20, false, false, false)))
    it(id + ' preserves empty enemy areas', () => expect(run(id, true, 20, true, false, true)).toEqual(run(id, false, 20, true, false, true)))
  }
})
