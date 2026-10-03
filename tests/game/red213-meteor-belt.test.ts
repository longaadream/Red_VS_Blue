import { afterEach, describe, expect, it } from 'vitest'
import { dealDamage } from '@/lib/game/skills'
import { globalTriggerSystem, type TriggerRule } from '@/lib/game/triggers'
import type { PieceInstance } from '@/lib/game/piece'
import { makePiece, makeState } from '../helpers/minimal-state'

function fixture() {
  const state = makeState({ pieces: [
    makePiece({ instanceId: 'attacker', ownerPlayerId: 'player-blue', x: 4, y: 4 }),
    makePiece({ instanceId: 'ally', x: 1, y: 1 }),
    makePiece({ instanceId: 'guard', x: 2, y: 1 }),
  ] })
  const [attacker, ally, guard] = state.pieces
  guard.defense = 1
  return { state, attacker, ally, guard }
}

function protect(guard: PieceInstance) {
  globalTriggerSystem.addRule({
    id: 'guard-' + guard.instanceId, name: 'guard', description: '',
    trigger: { type: 'beforeDamageRedirect' },
    effect: (_battle, context) => {
      const redirect = (context as unknown as { damageRedirectQueue?: { push(input: { target: PieceInstance }): boolean } }).damageRedirectQueue
      if (context.piece?.instanceId === guard.instanceId || !redirect || guard.currentHp <= 0) return { success: false }
      return { success: true, blocked: redirect.push({ target: guard }) }
    },
  } as TriggerRule)
}

afterEach(() => globalTriggerSystem.clearRules())

describe('RED-213 damage substitution', () => {
  it('applies source amplification once and uses the protector defense and shield', () => {
    const { state, attacker, ally, guard } = fixture()
    guard.shield = 2
    ally.defense = 99
    let beforeCount = 0
    globalTriggerSystem.addRule({ id: 'double', name: 'double', description: '', trigger: { type: 'beforeDamageDealt' },
      effect: (_battle, context) => { beforeCount++; context.damage = Number(context.damage) * 2; return { success: true } },
    } as TriggerRule)
    protect(guard)
    const result = dealDamage(attacker, ally, 3, 'physical', state, 'original-attack')
    expect(result).toMatchObject({ success: true, damage: 0, blocked: false, redirectedTo: guard.instanceId })
    expect(beforeCount).toBe(1)
    expect(ally.currentHp).toBe(100)
    expect(guard.currentHp).toBe(97)
    expect(guard.shield).toBe(0)
    expect(state.actions?.filter(action => action.type === 'damage').map(action => action.payload)).toContainEqual(expect.objectContaining({ sourceId: attacker.instanceId, targetId: guard.instanceId, skillId: 'original-attack', finalDamage: 3 }))
  })

  it('prevents two guardians from redirecting the same damage repeatedly', () => {
    const { state, attacker, ally, guard } = fixture()
    const second = { ...guard, instanceId: 'guard-2', statusTags: [], rules: [] }
    state.pieces.push(second)
    protect(guard)
    protect(second)
    dealDamage(attacker, ally, 5, 'true', state)
    expect(ally.currentHp).toBe(100)
    expect(guard.currentHp).toBe(95)
    expect(second.currentHp).toBe(100)
  })

  it('preserves environment attribution', () => {
    const { state, ally, guard } = fixture()
    protect(guard)
    dealDamage({ kind: 'environment', instanceId: 'fire', ownerPlayerId: 'player-blue', name: 'Fire' }, ally, 5, 'true', state, 'fire')
    expect(ally.currentHp).toBe(100)
    expect(guard.currentHp).toBe(95)
    expect(state.actions?.filter(action => action.type === 'damage').map(action => action.payload)).toContainEqual(expect.objectContaining({ targetId: guard.instanceId, damageSource: expect.objectContaining({ kind: 'environment', sourceId: 'fire' }) }))
  })

  it('falls back to the original target if the guardian dies in the parent area attack', () => {
    const { state, attacker, ally, guard } = fixture()
    guard.currentHp = 2
    protect(guard)
    expect(() => dealDamage(attacker, [ally, guard], 5, 'true', state)).not.toThrow()
    expect(guard.currentHp).toBe(0)
    expect(ally.currentHp).toBe(95)
  })

  it('commits each area hit once and falls back after the first queued hit kills the guardian', () => {
    const { state, attacker, ally, guard } = fixture()
    const other = { ...ally, instanceId: 'ally-2', statusTags: [], rules: [] }
    state.pieces.push(other)
    guard.currentHp = 3
    protect(guard)
    dealDamage(attacker, [other, ally], 5, 'true', state)
    expect(guard.currentHp).toBe(0)
    expect(ally.currentHp).toBe(100)
    expect(other.currentHp).toBe(95)
    expect(state.graveyard.filter(piece => piece.instanceId === guard.instanceId)).toHaveLength(1)
  })

  it('does not emit a blocked-damage event for a substituted hit', () => {
    const { state, attacker, ally, guard } = fixture()
    let blocked = 0
    let afterDealt = 0
    const taken: string[] = []
    globalTriggerSystem.addRule({ id: 'blocked', name: 'blocked', description: '', trigger: { type: 'afterDamageBlocked' },
      effect: () => { blocked++; return { success: true } },
    } as TriggerRule)
    globalTriggerSystem.addRule({ id: 'dealt', name: 'dealt', description: '', trigger: { type: 'afterDamageDealt' },
      effect: () => { afterDealt++; return { success: true } },
    } as TriggerRule)
    globalTriggerSystem.addRule({ id: 'taken', name: 'taken', description: '', trigger: { type: 'afterDamageTaken' },
      effect: (_battle, context) => { taken.push(context.piece!.instanceId); return { success: true } },
    } as TriggerRule)
    protect(guard)
    dealDamage(attacker, ally, 5, 'physical', state)
    expect(blocked).toBe(0)
    expect(afterDealt).toBe(1)
    expect(taken).toEqual([guard.instanceId])
  })

  it('substitutes before consuming the original target immunity', () => {
    const { state, attacker, ally, guard } = fixture()
    let originalShieldUsed = false
    globalTriggerSystem.addRule({ id: 'ally-shield', name: 'ally-shield', description: '', trigger: { type: 'beforeDamageTaken' },
      effect: (_battle, context) => {
        if (context.piece?.instanceId !== ally.instanceId) return { success: false }
        originalShieldUsed = true
        return { success: true, blocked: true }
      },
    } as TriggerRule)
    protect(guard)
    dealDamage(attacker, ally, 5, 'true', state)
    expect(originalShieldUsed).toBe(false)
    expect(guard.currentHp).toBe(95)
  })
})
