import type { BattleState } from '@/lib/game/turn'
import type { TriggerContext } from '@/lib/game/triggers'
import type { SkillExecutionContext } from '@/lib/game/skills'
import type { TestPiece } from '../helpers/minimal-state'
import { readFileSync } from 'node:fs'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { executeCardFunction, executeSkillFunction, loadAllSkillsById, loadRuleById } from '@/lib/game/skills'
import { TriggerSystem, globalTriggerSystem } from '@/lib/game/triggers'
import { convertToTriggerRule } from '@/lib/game/rule-loader'
import { makePiece, makePlayer, makeState } from '../helpers/minimal-state'

const definition = (group: string, id: string) => JSON.parse(readFileSync(`data/${group}/${id}.json`, 'utf8'))
beforeEach(() => globalTriggerSystem.clearRules())
afterEach(() => globalTriggerSystem.clearRules())
function stateWith(pieces: TestPiece[]) {
  const state = makeState({ pieces, currentPlayerId: 'blue1' })
  state.players = ['blue1', 'red1', 'red2', 'blue2'].map((id, i) => ({ ...makePlayer(id, i === 0 || i === 3 ? 'blue' : 'red'), teamId: i === 0 || i === 3 ? 'blue' : 'red' }))
  state.skillsById = loadAllSkillsById()
  return state
}
it('holy cards target teammates as allies and never smite a low-health teammate', () => {
  const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'blue1', x: 0 })
  const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'blue2', x: 1, currentHp: 1 })
  const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'red2', x: 2, currentHp: 20 })
  const state = stateWith([caster, ally, enemy])
  const play = (id: string) => executeCardFunction(definition('cards', id), 'blue1', state)
  expect(play('holy-smite').success).toBe(true)
  expect([ally.currentHp, enemy.currentHp]).toEqual([1, 15])
  expect(play('holy-heal').success).toBe(true)
  expect(ally.currentHp).toBe(9)
  expect(play('holy-charge').success).toBe(true)
  expect(ally.statusTags.some((s) => s.type === 'damage-buff')).toBe(true)
  expect(enemy.statusTags.some((s) => s.type === 'damage-buff')).toBe(false)
})
it.each(['skills-loader', 'rule-loader'])('blood echo gives one card per allied Liadrin owner through %s trigger contexts', loader => {
  const pieces = ['blue1', 'blue2', 'red1'].map((ownerPlayerId, i) => ({
    ...makePiece({ instanceId: `liadrin-${i}`, templateId: 'liadrin', ownerPlayerId, x: i }),
    rules: [loader === 'skills-loader' ? loadRuleById('rule-blood-echo', true)! : convertToTriggerRule(definition('rules', 'rule-blood-echo'))],
  }))
  const target = makePiece({ instanceId: 'shielded', ownerPlayerId: 'blue2', x: 4 })
  const state = stateWith([...pieces, target])
  new TriggerSystem().checkTriggers(state, { type: 'afterStatusRemoved', playerId: 'blue2', sourcePiece: target, statusId: 'divine-shield' } as unknown as TriggerContext)
  expect(state.players.map((p) => p.hand.filter((c) => c.cardId === 'holy-charge').length)).toEqual([1, 0, 0, 1])
})
it('two Tracers count each enemy action exactly once per instance, including restored serialized state', () => {
  const tracers = ['blue1', 'blue2'].map((ownerPlayerId, i) => ({ ...makePiece({ instanceId: `tracer-${i}`, templateId: 'tracer', ownerPlayerId, x: i }), rules: [loadRuleById('rule-recall-move', true)!] }))
  const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'red1', x: 3 })
  const state = stateWith([...tracers, enemy])
  state.extensions!.recallData = tracers.map(p => ({ pieceId: p.instanceId, ownerPlayerId: p.ownerPlayerId, targetCount: 3, actionCount: 0, snapshot: { x: p.x, y: p.y, hp: 100 } }))
  new TriggerSystem().checkTriggers(state, { type: 'afterMove', playerId: 'red1', sourcePiece: enemy } as unknown as TriggerContext)
  expect(state.extensions!.recallData.map((r: { actionCount: number }) => r.actionCount)).toEqual([1, 1])
  const restored: BattleState = JSON.parse(JSON.stringify(state))
  for (const p of restored.pieces.filter((p) => p.templateId === 'tracer')) p.rules = [loadRuleById('rule-recall-move', true)!]
  new TriggerSystem().checkTriggers(restored, { type: 'afterMove', playerId: 'red1', sourcePiece: restored.pieces[2] } as unknown as TriggerContext)
  expect(restored.extensions!.recallData.map((r: { actionCount: number }) => r.actionCount)).toEqual([2, 2])
})
it('blizzard waits past a teammate turn without consuming its status', () => {
  const caster = makePiece({ instanceId: 'jaina', ownerPlayerId: 'red1' })
  const state = stateWith([caster]); state.turn.currentPlayerId = 'red2'
  const player = state.players[1]; player.statusTags = [{ id: 'blizzard-1', type: 'blizzard', centerX: 2, centerY: 2, damage: 5 }]
  const result = executeSkillFunction(definition('skills', 'blizzard-damage'), { piece: caster, player, playerId: 'red1', battle: state, skill: {} } as unknown as SkillExecutionContext, state)
  expect(result.success).toBe(false)
  expect(player.statusTags).toHaveLength(1)
})
it('two Shishio casters apply each permanent burning tile only once', () => {
  const casters = ['red1', 'red2'].map((ownerPlayerId, i) => makePiece({ instanceId: `shishio-${i}`, templateId: 'red-shishio', ownerPlayerId, x: i }))
  const mover = makePiece({ instanceId: 'mover', ownerPlayerId: 'blue1', x: 4 })
  const state = stateWith([...casters, mover])
  for (const player of state.players.slice(1, 3)) player.rules = [loadRuleById('rule-shishio-burn-move', true)!]
  state.extensions!.shishioBurnTiles = [{ x: mover.x, y: mover.y, sourcePieceId: casters[0].instanceId, ownerPlayerId: 'red1' }, { x: 5, y: 4, sourcePieceId: casters[1].instanceId, ownerPlayerId: 'red2' }]
  new TriggerSystem().checkTriggers(state, { type: 'afterMove', playerId: 'blue1', sourcePiece: mover } as unknown as TriggerContext)
  expect(mover.currentHp).toBe(50)
})
it('two Sasuke player rules stack and damage once while preserving the tile source', () => {
  const casters = ['red1', 'red2'].map((ownerPlayerId, i) => makePiece({ instanceId: `sasuke-${i}`, templateId: 'red-sasuke', ownerPlayerId, x: i }))
  const victim = makePiece({ instanceId: 'victim', ownerPlayerId: 'blue1', x: 4 })
  const state = stateWith([...casters, victim])
  for (const player of state.players.slice(1, 3)) player.rules = ['stack', 'damage'].map(name => loadRuleById(`rule-sasuke-amaterasu-${name}`, true)!)
  state.extensions!.amaterasuOwnerPlayerId = 'red1'
  state.extensions!.amaterasuCells = [{ x: 4, y: 0, sourcePieceId: 'sasuke-1', ownerPlayerId: 'red2' }]
  new TriggerSystem().checkTriggers(state, { type: 'endTurn', playerId: 'blue1' } as unknown as TriggerContext)
  expect(victim.statusTags).toContainEqual(expect.objectContaining({ type: 'amaterasu-burn', stacks: 1, sourcePieceId: 'sasuke-1' }))
  expect(victim.currentHp).toBe(98)
})
