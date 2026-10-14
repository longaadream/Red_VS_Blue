/* eslint-disable @typescript-eslint/no-explicit-any -- Real host differential fixtures. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { executeSkillFunction } from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { buildMovementSkillGraph, MOVEMENT_SKILL_IDS } from '@/scripts/migrate-semantic-movement-skills'
import { makePiece, makeState } from '../helpers/minimal-state'

const entries = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries
function run(id: string, semantic: boolean, scenario: string) {
  globalTriggerSystem.clearRules()
  if (scenario === 'blocked') globalTriggerSystem.addRule({ id: 'block', name: '阻止位移', description: '', trigger: { type: 'beforePiecePositionChange' }, effect: () => ({ success: true, blocked: true, message: '测试阻挡' }) })
  if (scenario === 'removed-caster') globalTriggerSystem.addRule({ id: 'remove-on-contact', name: '接触后离场', description: '', trigger: { type: 'afterPiecePositionChange' }, effect: battle => { battle.pieces = battle.pieces.filter(piece => piece.instanceId !== 'caster'); return { success: true } } })
  try {
    const original = entries['skills/' + id], definition = semantic ? applyGameplayModuleGraph(original, buildMovementSkillGraph(id)) : original
    const caster = makePiece({ instanceId: 'caster', x: 2, y: 2 }), enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 4, y: 2 })
    caster.name = '施放者'; enemy.name = '敌人'
    const battle = makeState({ pieces: [caster, enemy], width: 9, height: 9 })
    battle.skillsById[id] = definition
    let pos: { x: number; y: number } | null = { x: 3, y: 2 }
    if (scenario === 'diagonal') pos = { x: 3, y: 3 }
    if (scenario === 'far') pos = { x: 8, y: 7 }
    if (scenario === 'self') pos = { x: 2, y: 2 }
    if (scenario === 'occupied') pos = { x: 4, y: 2 }
    if (scenario === 'wall') battle.map.tiles.find(tile => tile.x === 3 && tile.y === 2)!.props.walkable = false
    if (scenario === 'pending' || scenario === 'second-pending') pos = null
    const selectedEnemy = scenario !== 'pending' && id === 'aizen-shunpo'
    const targets = [...(selectedEnemy ? [{ info: enemy, pos: null }] : []), ...(pos ? [{ info: null, pos }] : [])]
    const result = executeSkillFunction(definition, { piece: caster, skill: definition, battle, target: selectedEnemy ? enemy : null, targetPosition: pos, targets } as any, battle)
    const state = JSON.parse(JSON.stringify(battle)); delete state.skillsById
    return { result, state }
  } finally { globalTriggerSystem.clearRules() }
}
describe('semantic movement preserves selection and authoritative displacement', () => {
  for (const id of MOVEMENT_SKILL_IDS) for (const scenario of ['legal', 'pending', 'second-pending', 'diagonal', 'far', 'self', 'occupied', 'wall', 'blocked', 'removed-caster']) it(id + ':' + scenario, () => {
    const expected = run(id, false, scenario)
    expect(run(id, true, scenario)).toEqual(expected)
    if (scenario === 'legal') expect(expected.state.pieces.find((piece: any) => piece.instanceId === 'caster')).toMatchObject({ x: 3, y: 2 })
    if (scenario === 'removed-caster') expect(expected.state.pieces.some((piece: any) => piece.instanceId === 'caster')).toBe(false)
    if (scenario === 'blocked') {
      expect(expected.result).toMatchObject({ success: true, message: '位移被阻挡，本次位移效果取消' })
      expect(expected.state.pieces.find((piece: any) => piece.instanceId === 'caster')).toMatchObject({ x: 2, y: 2 })
    }
  })
})
