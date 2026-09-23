/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-authored content is exercised through the runtime. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { runBattleAction } from '@/lib/game/battle-runner'
import { dealDamage, loadRuleById } from '@/lib/game/skills'
import { makePiece, makeState } from '../helpers/minimal-state'

const DATA_ROOT = join(process.cwd(), 'data')
const loadJson = (path: string) => JSON.parse(readFileSync(join(DATA_ROOT, path), 'utf8')) as any
const loadSkill = (id: string) => loadJson(`skills/${id}.json`)

function meteorState() {
  const primo = makePiece({ instanceId: 'primo', templateId: 'el-primo', x: 2, y: 2, currentHp: 17, maxHp: 17 }) as any
  primo.defense = 1
  primo.rules = [loadRuleById('rule-el-primo-injury-counter', true)!]
  primo.skills = [{ skillId: 'el-primo-meteor-belt', currentCooldown: 0, usesRemaining: -1 }]
  const state = makeState({ pieces: [primo], width: 7, height: 7 })
  state.players[0].actionPoints = 1
  state.skillsById['el-primo-meteor-belt'] = loadSkill('el-primo-meteor-belt')
  return { state, primo }
}

function step(state: any, action: any) {
  const next = runBattleAction(state, action, { rootSeed: 213 }).state
  next.skillsById = state.skillsById
  return next
}

describe('RED-213 El Primo Meteor Belt content', () => {
  it('publishes defense, the retained three skills, the fourth skill, and approved costs', () => {
    const piece = loadJson('pieces/el-primo.json')
    const punch = loadSkill('el-primo-punch')
    const meteor = loadSkill('el-primo-meteor-belt')

    expect(piece.stats.defense).toBe(1)
    expect(piece.skills.map((skill: any) => skill.skillId)).toEqual([
      'passive-injury-charge-discount', 'el-primo-punch', 'el-primo-elbow', 'el-primo-meteor-belt',
    ])
    expect(punch.cooldownTurns).toBe(1)
    expect(meteor).toMatchObject({
      id: 'el-primo-meteor-belt', actionPointCost: 1, cooldownTurns: 3, chargeCost: 0,
      type: 'normal', targeting: { steps: [] },
    })
    expect(meteor.description).toContain('持续2回合')
    expect(meteor.description).toContain('3×3')
  })

  it('loads the real rule and activates the no-target skill through runBattleAction', () => {
    const rule = loadRuleById('rule-el-primo-meteor-belt', true)
    expect(rule).toMatchObject({ id: 'rule-el-primo-meteor-belt', trigger: { type: 'beforeDamageRedirect' } })

    const { state, primo } = meteorState()
    const next = runBattleAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: primo.instanceId, skillId: 'el-primo-meteor-belt',
    }, { rootSeed: 213 }).state
    const activated = next.pieces.find(piece => piece.instanceId === primo.instanceId)!

    expect(next.players[0].actionPoints).toBe(0)
    expect(activated.skills[0].currentCooldown).toBe(3)
    expect(activated.statusTags).toContainEqual(expect.objectContaining({
      type: 'el-primo-meteor-belt', currentDuration: 2, remainingDuration: 2,
      relatedRules: ['rule-el-primo-meteor-belt'],
    }))
    expect(activated.rules.map(ruleEntry => ruleEntry.id)).toContain('rule-el-primo-meteor-belt')
  })

  it('protects only allied pieces currently within the live 3x3 area', () => {
    const { state, primo } = meteorState()
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', faction: 'red', x: 3, y: 3, currentHp: 20, maxHp: 20 }) as any
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 2, currentHp: 20, maxHp: 20 }) as any
    const attacker = makePiece({ instanceId: 'attacker', ownerPlayerId: 'player-blue', faction: 'blue', x: 0, y: 0, attack: 5 }) as any
    state.pieces.push(ally, enemy, attacker)
    const activated = runBattleAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: primo.instanceId, skillId: 'el-primo-meteor-belt',
    }, { rootSeed: 213 }).state
    const guard = activated.pieces.find(piece => piece.instanceId === primo.instanceId)!
    const protectedAlly = activated.pieces.find(piece => piece.instanceId === ally.instanceId)!
    const enemyTarget = activated.pieces.find(piece => piece.instanceId === enemy.instanceId)!
    const source = activated.pieces.find(piece => piece.instanceId === attacker.instanceId)!

    dealDamage(source, protectedAlly, 5, 'physical', activated, 'fixture-hit')
    expect(protectedAlly.currentHp).toBe(20)
    expect(guard.currentHp).toBe(13)
    expect(activated.extensions?.contentCounters['player-red']).toBe(0)
    expect(activated.extensions?.contentCounters.elPrimoChargeDiscount['player-red']).toBe(1)

    protectedAlly.x = 4
    protectedAlly.y = 4
    dealDamage(source, protectedAlly, 5, 'physical', activated, 'fixture-hit-outside')
    expect(protectedAlly.currentHp).toBe(15)
    expect(guard.currentHp).toBe(13)

    dealDamage(source, enemyTarget, 5, 'physical', activated, 'fixture-hit-enemy')
    expect(enemyTarget.currentHp).toBe(15)
    expect(guard.currentHp).toBe(13)
  })

  it('ticks only at the owner end phase and expires after the second owner end', () => {
    const { state, primo } = meteorState()
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', faction: 'red', x: 3, y: 3, currentHp: 20, maxHp: 20 }) as any
    const attacker = makePiece({ instanceId: 'attacker', ownerPlayerId: 'player-blue', faction: 'blue', x: 0, y: 0, attack: 5 }) as any
    state.pieces.push(ally, attacker)

    let current = step(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: primo.instanceId, skillId: 'el-primo-meteor-belt',
    })
    const status = () => current.pieces.find((piece: any) => piece.instanceId === primo.instanceId)?.statusTags
      .find((tag: any) => tag.type === 'el-primo-meteor-belt')

    expect(status()).toMatchObject({ currentDuration: 2, remainingDuration: 2 })
    current = step(current, { type: 'endTurn', playerId: 'player-red' })
    expect(status()).toMatchObject({ currentDuration: 2, remainingDuration: 2 })

    current = step(current, { type: 'beginPhase' })
    current = step(current, { type: 'endTurn', playerId: 'player-blue' })
    expect(status()).toMatchObject({ currentDuration: 2, remainingDuration: 2 })

    current = step(current, { type: 'beginPhase' })
    current = step(current, { type: 'endTurn', playerId: 'player-red' })
    expect(status()).toMatchObject({ currentDuration: 1, remainingDuration: 1 })

    current = step(current, { type: 'beginPhase' })
    current = step(current, { type: 'endTurn', playerId: 'player-blue' })
    expect(status()).toMatchObject({ currentDuration: 1, remainingDuration: 1 })

    current = step(current, { type: 'beginPhase' })
    current = step(current, { type: 'endTurn', playerId: 'player-red' })
    const expiredPrimo = current.pieces.find((piece: any) => piece.instanceId === primo.instanceId)!
    expect(status()).toBeUndefined()
    expect(expiredPrimo.rules.map((rule: any) => rule.id)).not.toContain('rule-el-primo-meteor-belt')

    const expiredAlly = current.pieces.find((piece: any) => piece.instanceId === ally.instanceId)!
    const expiredAttacker = current.pieces.find((piece: any) => piece.instanceId === attacker.instanceId)!
    dealDamage(expiredAttacker, expiredAlly, 5, 'physical', current, 'fixture-after-expiry')
    expect(expiredAlly.currentHp).toBe(15)
    expect(expiredPrimo.currentHp).toBe(17)
  })

  it('keeps the original ally divine shield even when that piece is ordered before the protector', () => {
    const { state, primo } = meteorState()
    const shieldRule = loadRuleById('rule-divine-shield', true)
    if (!shieldRule) throw new Error('Missing divine shield fixture')
    const ally = makePiece({ instanceId: 'shielded-ally', x: 3, y: 2,
      rules: [shieldRule], statusTags: [{ id: 'test-divine-shield', type: 'divine-shield' }],
    })
    const attacker = makePiece({ instanceId: 'attacker', ownerPlayerId: 'player-blue', x: 0, y: 0 })
    state.pieces.unshift(ally as any)
    state.pieces.push(attacker as any)
    const current = step(state, { type: 'useBasicSkill', playerId: 'player-red', pieceId: primo.instanceId, skillId: 'el-primo-meteor-belt' })
    const target = current.pieces.find(piece => piece.instanceId === ally.instanceId)!
    const guard = current.pieces.find(piece => piece.instanceId === primo.instanceId)!
    const source = current.pieces.find(piece => piece.instanceId === attacker.instanceId)!
    dealDamage(source, target, 5, 'physical', current, 'shield-order')
    expect(target.currentHp).toBe(100)
    expect(target.statusTags.some(tag => tag.type === 'divine-shield')).toBe(true)
    expect(guard.currentHp).toBe(13)
  })
})
