import { beforeEach, describe, expect, it } from 'vitest'
import { dealDamage, loadRuleById } from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

beforeEach(() => globalTriggerSystem.clearRules())

describe('Akaza fighting spirit', () => {
  it.each([
    { hp: 20, owner: 'player-blue', expected: 6 },
    { hp: 19, owner: 'player-blue', expected: 4 },
    { hp: 20, owner: 'player-red', expected: 4 },
  ])('only boosts full-HP enemy damage: $hp, $owner', ({ hp, owner, expected }) => {
    const source = makePiece({ instanceId: 'akaza', attack: 4, rules: [loadRuleById('rule-akaza-fighting-spirit', true)!] })
    const target = makePiece({ instanceId: 'target', ownerPlayerId: owner, x: 1, currentHp: hp, maxHp: 20 })
    const state = makeState({ pieces: [source, target] })
    const [actor, victim] = state.pieces
    expect(dealDamage(actor, victim, 4, 'physical', state, 'test-akaza-hit').damage).toBe(expected)
  })

  it('checks current HP again on later hits and applies the boost before shield absorption', () => {
    const source = makePiece({ instanceId: 'akaza', rules: [loadRuleById('rule-akaza-fighting-spirit', true)!] })
    const target = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 1, currentHp: 20, maxHp: 20 })
    const state = makeState({ pieces: [source, target] })
    const [actor, victim] = state.pieces
    victim.shield = 6
    expect(dealDamage(actor, victim, 4, 'physical', state, 'shielded').damage).toBe(0)
    expect(victim.currentHp).toBe(20)
    expect(dealDamage(actor, victim, 4, 'physical', state, 'first-hp-hit').damage).toBe(6)
    expect(dealDamage(actor, victim, 4, 'physical', state, 'later-hit').damage).toBe(4)
  })

  it('applies the boost before defense and numeric shield absorption', () => {
    const source = makePiece({ instanceId: 'akaza', attack: 4, rules: [loadRuleById('rule-akaza-fighting-spirit', true)!] })
    const target = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 1, currentHp: 20, maxHp: 20 })
    target.defense = 2
    const state = makeState({ pieces: [source, target] })
    state.pieces[1].shield = 3

    const result = dealDamage(state.pieces[0], state.pieces[1], 4, 'physical', state, 'before-defense-and-shield')

    expect(result).toMatchObject({ modifiedDamage: 6, defense: 2, shieldAbsorbed: 3, damage: 1 })
    expect(target.currentHp).toBe(19)
  })

  it.each([
    { order: ['full', 'wounded', 'ally'] },
    { order: ['wounded', 'ally', 'full'] },
    { order: ['ally', 'full', 'wounded'] },
  ])('applies the boost per target for mixed batches regardless of target order: $order', ({ order }) => {
    const source = makePiece({ instanceId: 'akaza', attack: 4, rules: [loadRuleById('rule-akaza-fighting-spirit', true)!] })
    const full = makePiece({ instanceId: 'full', ownerPlayerId: 'player-blue', x: 1, currentHp: 20, maxHp: 20 })
    const wounded = makePiece({ instanceId: 'wounded', ownerPlayerId: 'player-blue', x: 2, currentHp: 19, maxHp: 20 })
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 3, currentHp: 20, maxHp: 20 })
    const state = makeState({ pieces: [source, full, wounded, ally] })
    const byId: Record<string, typeof state.pieces[number]> = Object.fromEntries(
      state.pieces.map(piece => [piece.instanceId, piece]),
    )

    const result = dealDamage(state.pieces[0], order.map(id => byId[id]), 4, 'physical', state, 'mixed-target-batch')

    expect(result.results).toHaveLength(3)
    expect(full.currentHp).toBe(14)
    expect(wounded.currentHp).toBe(15)
    expect(ally.currentHp).toBe(16)
  })

  it('does not boost another source when Akaza is on the board', () => {
    const holder = makePiece({ instanceId: 'akaza', rules: [loadRuleById('rule-akaza-fighting-spirit', true)!] })
    const other = makePiece({ instanceId: 'other', x: 1 })
    const target = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2, currentHp: 20, maxHp: 20 })
    const state = makeState({ pieces: [holder, other, target] })
    expect(dealDamage(state.pieces[1], state.pieces[2], 4, 'physical', state, 'other-hit').damage).toBe(4)
  })
})
