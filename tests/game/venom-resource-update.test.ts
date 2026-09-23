import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runBattleAction } from '@/lib/game/battle-runner'
import { prepareAction } from '@/lib/game/targeting'
import { loadRuleById } from '@/lib/game/skills'
import type { BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'
import { pinTestBattleState } from './profile-test-identity'

function cast(state: BattleState, skillId: string, target: { targetPieceId?: string; targetX?: number; targetY?: number }) {
  pinTestBattleState(state as unknown as Record<string, unknown>, 1112212747)
  const draft = { type: 'useBasicSkill' as const, playerId: 'player-red', pieceId: 'venom', skillId }
  const prepared = prepareAction(state, draft)
  if (prepared.kind !== 'needTarget') throw new Error(`Unexpected ${prepared.kind}`)
  return runBattleAction(state, { ...draft, ...target, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision }).state
}

function fixture(skillId: string, x = 1, y = 1) {
  const skill = JSON.parse(readFileSync(`data/skills/${skillId}.json`, 'utf8'))
  const caster = makePiece({ instanceId: 'venom', templateId: 'red-venom', x: 2, y: 2, attack: 3,
    skills: [{ skillId, currentCooldown: 0, usesRemaining: -1 }] })
  const enemy = makePiece({ instanceId: 'enemy', templateId: 'sonic', ownerPlayerId: 'player-blue', x, y, currentHp: 6, maxHp: 14 })
  const state = makeState({ pieces: [caster, enemy] })
  state.skillsById[skillId] = skill
  return { state, enemy }
}

describe('RED-212 authoritative Venom resource execution', () => {
  it('commits a claw attack blocked by Elune protection instead of rolling back the protection consumption', () => {
    const { state } = fixture('venom-claw-rend', 3, 2)
    const defender = state.players[1]
    defender.statusTags = [{ id: 'elune-protection', type: 'elune-protection', name: '艾露恩的守护', currentUses: 1 }]
    defender.rules = [loadRuleById('rule-elune-protection-player', true)!]
    const next = cast(state, 'venom-claw-rend', { targetPieceId: 'enemy' })
    expect(next.pieces.find(p => p.instanceId === 'enemy')?.currentHp).toBe(11)
    expect(next.players[1].statusTags).toEqual([])
    expect(next.players[0].actionPoints).toBe(1)
    expect(next.pieces[0].skills[0].currentCooldown).toBe(1)
    expect(next.actions!.filter(a => a.type === 'useBasicSkill')).toHaveLength(1)
    expect(next.actions!.filter(a => a.type === 'damage')).toHaveLength(1)
    expect(next.actions!.find(a => a.type === 'damage')?.payload).toMatchObject({ finalDamage: 0, blocked: true })
  })

  it('consumes divine shield once and records a successful cast with blocked damage', () => {
    const { state, enemy } = fixture('venom-claw-rend', 3, 2)
    enemy.statusTags = [{ id: 'divine-shield', type: 'divine-shield', intensity: 1 }]
    enemy.rules = [loadRuleById('rule-divine-shield', true)!]
    const next = cast(state, 'venom-claw-rend', { targetPieceId: 'enemy' })
    expect(next.pieces[1].currentHp).toBe(6)
    expect(next.pieces[1].statusTags).toEqual([])
    expect(next.players[0].actionPoints).toBe(1)
    expect(next.pieces[0].skills[0].currentCooldown).toBe(1)
    expect(next.actions!.filter(a => a.type === 'useBasicSkill')).toHaveLength(1)
  })

  it.each([[3, 2], [1, 2], [2, 1], [2, 3]])('roots an adjacent enemy at (%i,%i) without moving it', (x, y) => {
    const { state } = fixture('venom-symbiote-drag', x, y)
    const next = cast(state, 'venom-symbiote-drag', { targetX: x, targetY: y })
    expect(next.pieces[1]).toMatchObject({ x, y, currentHp: 6 })
    expect(next.pieces[1].statusTags).toContainEqual(expect.objectContaining({ type: 'root', remainingDuration: 1 }))
    expect(next.actions!.filter(a => a.type === 'positionChanged')).toHaveLength(0)
    expect(next.players.map(p => p.chargePoints)).toEqual([0, 0])
    expect(next.players[0].actionPoints).toBe(1)
    expect(next.pieces[0].skills[0].currentCooldown).toBe(1)
    expect(next.actions!.filter(a => a.type === 'useBasicSkill')).toHaveLength(1)
  })

  it.each(['venom-claw-rend', 'venom-symbiote-drag'])('%s commits its effect', skillId => {
    const skill = JSON.parse(readFileSync(`data/skills/${skillId}.json`, 'utf8'))
    const caster = makePiece({ instanceId: 'venom', templateId: 'red-venom', x: 0, y: 1, attack: 3,
      skills: [{ skillId, currentCooldown: 0, usesRemaining: -1 }] })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: skillId === 'venom-claw-rend' ? 1 : 4, y: 1, currentHp: 10 })
    const state = makeState({ pieces: [caster, enemy] })
    state.skillsById[skillId] = skill
    pinTestBattleState(state as unknown as Record<string, unknown>, 111221747)
    const draft = { type: 'useBasicSkill' as const, playerId: 'player-red', pieceId: 'venom', skillId }
    const prepared = prepareAction(state, draft)
    if (prepared.kind !== 'needTarget') throw new Error(`Unexpected ${prepared.kind}`)
    const target = skillId === 'venom-claw-rend' ? { targetPieceId: 'enemy' } : { targetX: 5, targetY: 1 }
    const next = runBattleAction(state, { ...draft, ...target, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision }).state
    expect(next.players[0].actionPoints).toBe(1)
    expect(next.pieces.find(p => p.instanceId === 'venom')?.skills[0].currentCooldown).toBe(1)
    const actual = next.pieces.find(p => p.instanceId === 'enemy')!
    if (skillId === 'venom-claw-rend') expect(actual.currentHp).toBe(4)
    else {
      expect(actual).toMatchObject({ x: 1, y: 1 })
      expect(actual.statusTags).toContainEqual(expect.objectContaining({ type: 'root', remainingDuration: 1 }))
    }
  })
})
