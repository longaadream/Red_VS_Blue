import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createEffectChain, withEffectChain } from '@/lib/game/effect-batch'
import { dealDamage, loadRuleById, type DamageResult } from '@/lib/game/skills'
import { globalTriggerSystem, type TriggerRule } from '@/lib/game/triggers'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

let previousRules: TriggerRule[]
beforeEach(() => {
  previousRules = [...globalTriggerSystem.getRules()]
  globalTriggerSystem.clearRules()
})
afterEach(() => {
  globalTriggerSystem.clearRules()
  globalTriggerSystem.addRules(previousRules)
})

function fixture() {
  const source = asPieceInstance(makePiece({ instanceId: 'source' }))
  const victim = asPieceInstance(makePiece({ instanceId: 'victim', ownerPlayerId: 'player-blue', currentHp: 2, x: 1 }))
  const survivor = asPieceInstance(makePiece({ instanceId: 'survivor', ownerPlayerId: 'player-blue', x: 2 }))
  const state = makeState({ pieces: [source, victim, survivor] })
  const chain = createEffectChain({ actionId: 'red215', chainId: 'red215', turn: 1, rootSeed: 215 })
  const kill = () => dealDamage(source, victim, 2, 'true', state, 'first-hit')
  return { source, victim, survivor, state, chain, kill }
}

function expectDamageError(operation: () => unknown, code: string) {
  expect(operation).toThrowError(expect.objectContaining({
    cause: expect.objectContaining({ code }),
  }))
}

describe('RED-215 same-action damage boundaries', () => {
  it('returns a complete no-op without repeating any damage or death events', () => {
    const f = fixture()
    const events: string[] = []
    for (const type of ['beforeDamageDealt', 'beforeDamageTaken', 'afterDamageTaken', 'afterDamageBlocked', 'beforePieceKilled', 'afterPieceKilled', 'onPieceDied'] as const) {
      globalTriggerSystem.addRule({
        id: `observe-${type}`, name: type, description: '', trigger: { type },
        effect: () => { events.push(type); return { success: true } },
      })
    }
    withEffectChain(f.state, f.chain, () => {
      expect(f.kill()).toMatchObject({ isKilled: true, damage: 2 })
      const before = [...events]
      const actions = JSON.stringify(f.state.actions)
      const result = dealDamage(f.source, f.victim, 3, 'physical', f.state, 'second-hit')
      expect(result).toMatchObject({ success: true, skipped: 'target-already-dead', rawDamage: 3,
        damage: 0, resolvedDamage: 0, shieldAbsorbed: 0, blocked: false, isKilled: false, targetHp: 0,
        sourceId: 'source', targetId: 'victim', skillId: 'second-hit', chainId: 'red215' })
      expect(result.batchId).toBeTruthy()
      expect(events).toEqual(before)
      expect(events.filter(event => event === 'onPieceDied')).toHaveLength(1)
      expect(JSON.stringify(f.state.actions)).toBe(actions)
      expect(f.state.graveyard).toEqual([f.victim])
    })
  })

  it.each([false, true])('keeps mixed results in caller order (dead first: %s)', deadFirst => {
    const f = fixture()
    withEffectChain(f.state, f.chain, () => {
      f.kill()
      const targets = deadFirst ? [f.victim, f.survivor] : [f.survivor, f.victim]
      const result = dealDamage(f.source, targets, 3, 'true', f.state)
      expect(result.results.map((entry: DamageResult) => entry.targetId)).toEqual(targets.map(target => target.instanceId))
      expect(result.damages).toEqual(deadFirst ? [0, 3] : [3, 0])
      expect(result.totalDamage).toBe(3)
      expect(f.survivor.currentHp).toBe(97)
    })
  })

  it('retains skipped entries when the source blocks the remaining live target', () => {
    const f = fixture()
    withEffectChain(f.state, f.chain, () => {
      f.kill()
      globalTriggerSystem.addRule({ id: 'source-block', name: 'source-block', description: '',
        trigger: { type: 'beforeDamageDealt' }, effect: () => ({ success: true, blocked: true }) })
      const result = dealDamage(f.source, [f.victim, f.survivor], 3, 'true', f.state)
      expect(result.results).toMatchObject([
        { targetId: 'victim', skipped: 'target-already-dead', damage: 0, blocked: false },
        { targetId: 'survivor', damage: 0, blocked: true },
      ])
      expect(f.survivor.currentHp).toBe(100)
    })
  })

  it('rejects a forged same-ID corpse reference', () => {
    const f = fixture()
    withEffectChain(f.state, f.chain, () => {
      f.kill()
      expectDamageError(() => dealDamage(f.source, { ...f.victim }, 3, 'true', f.state), 'RVB_DAMAGE_TARGET_UNAVAILABLE')
    })
  })

  it('rejects a previous action corpse', () => {
    const f = fixture()
    withEffectChain(f.state, f.chain, f.kill)
    const next = createEffectChain({ actionId: 'next', chainId: 'next', turn: 1, rootSeed: 215 })
    withEffectChain(f.state, next, () => {
      expectDamageError(() => dealDamage(f.source, f.victim, 3, 'true', f.state), 'RVB_DAMAGE_TARGET_UNAVAILABLE')
    })
  })

  it.each([-1, NaN, Infinity])('still rejects invalid damage %s against an eligible corpse', damage => {
    const f = fixture()
    withEffectChain(f.state, f.chain, () => {
      f.kill()
      expectDamageError(() => dealDamage(f.source, f.victim, damage, 'true', f.state), 'RVB_DAMAGE_VALUE_INVALID')
    })
  })

  it('still rejects duplicate targets before resolving a mixed batch', () => {
    const f = fixture()
    withEffectChain(f.state, f.chain, () => {
      f.kill()
      expectDamageError(() => dealDamage(f.source, [f.survivor, f.victim, f.victim], 3, 'true', f.state), 'RVB_DAMAGE_TARGET_DUPLICATE')
      expect(f.survivor.currentHp).toBe(100)
    })
  })

  it.each(['hp', 'graveyard', 'replacement'] as const)('rejects corrupted death state: %s', mutation => {
    const f = fixture()
    withEffectChain(f.state, f.chain, () => {
      f.kill()
      if (mutation === 'hp') f.victim.currentHp = 1
      if (mutation === 'graveyard') f.state.graveyard = []
      if (mutation === 'replacement') {
        f.state.pieces.push({ ...f.victim, currentHp: 5 })
        f.victim.currentHp = 1
      }
      expectDamageError(() => dealDamage(f.source, f.victim, 3, 'true', f.state), 'RVB_DAMAGE_TARGET_UNAVAILABLE')
      if (mutation === 'replacement') expect(f.state.pieces.find(piece => piece.instanceId === f.victim.instanceId)?.currentHp).toBe(5)
    })
  })

  it('preserves legacy live-target canonicalization for an ordinary stale HP copy', () => {
    const f = fixture()
    withEffectChain(f.state, f.chain, () => {
      const result = dealDamage(f.source, { ...f.survivor, currentHp: 0 }, 3, 'true', f.state)
      expect(result).toMatchObject({ damage: 3, targetHp: 97 })
    })
  })

  it('does not damage the new incarnation after a formal covenant revival', () => {
    const f = fixture()
    const covenant = loadRuleById('rule-arthas-lich-covenant', true)
    if (!covenant) throw new Error('Missing covenant rule')
    f.victim.initialDefinition = { stats: { maxHp: 40, attack: 5, defense: 0, moveRange: 3 }, skills: [], rules: [], statusTags: [] }
    f.victim.statusTags = [{ id: 'lich-covenant', type: 'lich-covenant', intensity: 1 }]
    f.victim.rules = [covenant]
    withEffectChain(f.state, f.chain, () => {
      f.kill()
      const revived = f.state.pieces.find(piece => piece.instanceId !== f.source.instanceId && piece.instanceId !== f.survivor.instanceId)
      expect(revived).toMatchObject({ currentHp: 40 })
      expect(revived?.instanceId).not.toBe(f.victim.instanceId)
      expect(dealDamage(f.source, f.victim, 99, 'true', f.state)).toMatchObject({ damage: 0, skipped: 'target-already-dead', isKilled: false })
      expect(revived?.currentHp).toBe(40)
      expect(f.state.graveyard).toEqual([f.victim])
    })
  })

  it('does not authorize a different state clone that shares the effect chain', () => {
    const f = fixture()
    withEffectChain(f.state, f.chain, f.kill)
    const clone = { ...f.state }
    withEffectChain(clone, f.chain, () => {
      expectDamageError(() => dealDamage(f.source, f.victim, 3, 'true', clone), 'RVB_DAMAGE_TARGET_UNAVAILABLE')
    })
  })

  it('restores death allowance with the chain checkpoint', () => {
    const f = fixture()
    withEffectChain(f.state, f.chain, () => {
      const before = f.chain.snapshot()
      f.kill()
      f.chain.restore(before)
      expectDamageError(() => dealDamage(f.source, f.victim, 3, 'true', f.state), 'RVB_DAMAGE_TARGET_UNAVAILABLE')
    })
  })

  it('continues separate shield and HP resolution while the target remains alive', () => {
    const f = fixture()
    f.survivor.shield = 2
    withEffectChain(f.state, f.chain, () => {
      expect(dealDamage(f.source, f.survivor, 2, 'physical', f.state)).toMatchObject({ damage: 0, blocked: true, shieldAbsorbed: 2 })
      expect(dealDamage(f.source, f.survivor, 3, 'physical', f.state)).toMatchObject({ damage: 3, blocked: false, targetHp: 97 })
    })
  })

  it.each([false, true])('preserves existing queued invalidation filtering (mixed batch: %s)', mixed => {
    const f = fixture()
    globalTriggerSystem.addRule({ id: 'queue-before-finalization', name: 'queue-before-finalization', description: '',
      trigger: { type: 'afterDamageTaken' },
      effect: (_battle, context) => {
        if (context.piece?.instanceId === f.victim.instanceId) {
          // Existing queued callers may hold a copy captured before DeathBatch.
          const staleCopy = { ...f.victim }
          context.damageQueue!.push({ attacker: f.source, target: mixed ? [staleCopy, f.survivor] : staleCopy,
            damage: 3, damageType: 'true' })
        }
        return { success: true }
      },
    })
    withEffectChain(f.state, f.chain, () => {
      expect(f.kill()).toMatchObject({ isKilled: true })
      expect(f.survivor.currentHp).toBe(mixed ? 97 : 100)
      expect(f.state.graveyard).toEqual([f.victim])
    })
  })
})
