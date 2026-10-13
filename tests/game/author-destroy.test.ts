import { afterEach, describe, expect, it } from 'vitest'
import { createSkillCodeFlow, dealDamage, destroyPieces, healDamage } from '../../lib/game/skills'
import { globalTriggerSystem } from '../../lib/game/triggers'
import { createEffectChain, installEffectChain } from '../../lib/game/effect-batch'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

function fixture() {
  const source = asPieceInstance(makePiece({ instanceId: 'source', ownerPlayerId: 'player-red', x: 0, y: 0 }))
  const target = asPieceInstance(makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', x: 2, y: 0, currentHp: 20, maxHp: 20 }))
  target.isCore = false
  const battle = makeState({ pieces: [source, target] })
  return { source, target, battle }
}

afterEach(() => globalTriggerSystem.clearRules())

describe('author destruction uses the formal death pipeline', () => {
  it('bypasses damage hooks and shield, emits one formal death, and ignores repeated/missing targets', () => {
    const { source, target, battle } = fixture()
    target.shield = 100
    const events: string[] = []
    for (const type of ['beforeDamageTaken', 'afterDamageTaken', 'onPieceDied'] as const) {
      globalTriggerSystem.addRule({ id: type, name: type, description: '', trigger: { type },
        effect: () => { events.push(type); return { success: true } } })
    }
    expect(destroyPieces([target, target], battle, source, 'destroy-test')).toBe(true)
    expect(battle.graveyard?.filter(piece => piece === target)).toHaveLength(1)
    expect(events).toEqual(['onPieceDied'])
    expect(target.shield).toBe(100)
    expect(battle.actions?.some(action => action.type === 'chargeCrystalDropped')).toBe(false)
    expect(destroyPieces([target], battle, source)).toBe(false)
    expect(createSkillCodeFlow(battle, { sourcePiece: source }, 'skill').lifecycle.destroy('missing')).toBe(false)
  })

  it.each([1, 30])('self destruction after taking %s damage preserves the kill result without a duplicate death', amount => {
    const { source, target, battle } = fixture()
    let deaths = 0
    globalTriggerSystem.addRule({ id: 'dissolve', name: '受伤消散', description: '', trigger: { type: 'afterDamageTaken' },
      effect: (state, context) => {
        createSkillCodeFlow(state, context, 'rule').lifecycle.destroy(target.instanceId)
        return { success: true }
      } })
    globalTriggerSystem.addRule({ id: 'count', name: '死亡计数', description: '', trigger: { type: 'onPieceDied' },
      effect: () => { deaths += 1; return { success: true } } })
    const result = dealDamage(source, target, amount, 'true', battle, 'hurt-test')
    expect(result.isKilled).toBe(true)
    expect(result.deathBatchId).toBeTruthy()
    expect(deaths).toBe(1)
    expect(battle.graveyard?.filter(piece => piece === target)).toHaveLength(1)
    expect(battle.actions?.filter(action => action.type === 'damage')).toHaveLength(1)
  })

  it('commits the dying state of a whole tuple before dispatching death observers', () => {
    const { source, target, battle } = fixture()
    const second = asPieceInstance(makePiece({ instanceId: 'second', ownerPlayerId: 'player-blue', currentHp: 10, maxHp: 10 }))
    second.isCore = false; battle.pieces.push(second)
    const observed: number[][] = []
    globalTriggerSystem.addRule({ id: 'all-dying', name: '同时观察', description: '', trigger: { type: 'onPieceDied' },
      effect: () => { observed.push([target.currentHp, second.currentHp]); return { success: true } } })
    destroyPieces([second, target, second], battle, source)
    expect(observed).toEqual([[0, 0], [0, 0]])
    expect(battle.graveyard).toHaveLength(2)
  })

  it('can destroy another living piece from a death rule without repeating the current death', () => {
    const { source, target, battle } = fixture()
    const second = asPieceInstance(makePiece({ instanceId: 'second', ownerPlayerId: 'player-blue' }))
    second.isCore = false; battle.pieces.push(second)
    let calls = 0
    globalTriggerSystem.addRule({ id: 'chain-death', name: '连锁死亡', description: '', trigger: { type: 'onPieceDied' },
      effect: () => { calls += 1; destroyPieces([target, second], battle, source); return { success: true } } })
    destroyPieces([target], battle, source)
    expect(calls).toBe(2)
    expect(battle.graveyard).toHaveLength(2)
  })

  it('does not zero health when a child batch exceeds the chain budget', () => {
    const { source, target, battle } = fixture()
    const chain = createEffectChain({ actionId: 'test', chainId: 'test', turn: 0, rootSeed: 594, detached: true, limits: { maxBatches: 1 } })
    const cleanup = installEffectChain(battle, chain)
    try {
      chain.enqueue({ kind: 'damage', attacker: source, targets: [target], baseDamage: 1, damageType: 'true' })
      expect(() => chain.drain({ damage: () => destroyPieces([target], battle, source), heal: () => {}, summon: () => {}, death: () => {} })).toThrow()
      expect(target.currentHp).toBe(20)
      expect(battle.pieces).toContain(target)
    } finally { cleanup() }
  })

  it('keeps a card damage source for self destruction', () => {
    const { target, battle } = fixture()
    globalTriggerSystem.addRule({ id: 'card-dissolve', name: '消散', description: '', trigger: { type: 'afterDamageTaken' },
      effect: (state, context) => { createSkillCodeFlow(state, context, 'rule').lifecycle.destroy(target.instanceId); return { success: true } } })
    dealDamage({ kind: 'card', instanceId: 'card-instance', ownerPlayerId: 'player-red', name: '测试手牌' }, target, 1, 'true', battle)
    expect(battle.actions?.find(action => action.type === 'destroy')).toMatchObject({ playerId: 'player-red', payload: { sourceId: 'card-instance' } })
  })

  it('does not attribute an earlier death to a replacement with the same identifier', () => {
    const { source, target, battle } = fixture()
    const chain = createEffectChain({ actionId: 'return', chainId: 'return', turn: 0, rootSeed: 594, detached: true })
    const cleanup = installEffectChain(battle, chain)
    try {
      destroyPieces([target], battle, source)
      const firstDeath = chain.deathBatchFor(battle, target)
      const replacement = { ...target, currentHp: 20 }
      battle.graveyard = []; battle.pieces.push(replacement)
      expect(dealDamage(source, replacement, 1, 'true', battle).isKilled).toBe(false)
      globalTriggerSystem.addRule({ id: 'returned-dissolve', name: '返场消散', description: '', trigger: { type: 'afterDamageTaken' },
        effect: () => { destroyPieces([replacement], battle, source); return { success: true } } })
      const next = dealDamage(source, replacement, 1, 'true', battle)
      expect(next.isKilled).toBe(true)
      expect(next.deathBatchId).not.toBe(firstDeath)
    } finally { cleanup() }
  })

  it.each(['beforeHealDealt', 'beforeHealTaken'] as const)('does not heal a corpse destroyed during %s', type => {
    const { source, target, battle } = fixture()
    target.currentHp = 10
    const after: string[] = []
    globalTriggerSystem.addRule({ id: 'before-heal', name: '治疗前消灭', description: '', trigger: { type },
      effect: () => { destroyPieces([target], battle, source); return { success: true } } })
    globalTriggerSystem.addRule({ id: 'after-heal', name: '治疗后记录', description: '', trigger: { type: 'afterHealTaken' },
      effect: () => { after.push('healed'); return { success: true } } })
    const result = healDamage(source, target, 5, battle)
    expect(result.heal).toBe(0)
    expect(target.currentHp).toBe(0)
    expect(battle.graveyard).toContain(target)
    expect(after).toEqual([])
  })

  it('does not commit a stale prepared damage target after another target destroys it', () => {
    const { source, target, battle } = fixture()
    target.instanceId = 'a'
    const second = asPieceInstance(makePiece({ instanceId: 'b', ownerPlayerId: 'player-blue', currentHp: 20, maxHp: 20 }))
    battle.pieces.push(second)
    globalTriggerSystem.addRule({ id: 'destroy-earlier', name: '销毁先前目标', description: '', trigger: { type: 'beforeDamageTaken' },
      effect: (_state, context) => { if (context.sourcePiece === second) destroyPieces([target], battle, source); return { success: true } } })
    const result = dealDamage(source, [target, second], 1, 'true', battle)
    expect(target.currentHp).toBe(0)
    expect(result.results[0]).toMatchObject({ damage: 0, isKilled: true })
    expect(result.totalDamage).toBe(1)
    expect(battle.graveyard).toContain(target)
  })
})
