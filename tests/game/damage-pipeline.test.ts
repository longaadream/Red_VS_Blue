/* eslint-disable @typescript-eslint/no-explicit-any -- focused engine fixtures use data-driven runtime shapes */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { hashBattleState } from '@/lib/game/battle-trace'
import { runBattleAction } from '@/lib/game/battle-runner'
import { createEffectChain, withEffectChain } from '@/lib/game/effect-batch'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { dealDamage, loadRuleById } from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

function requiredRule(id: string) {
  const rule = loadRuleById(id, true)
  if (!rule) throw new Error(`Missing RED-33 fixture rule: ${id}`)
  return rule
}

function eventRule(id: string, type: string, effect: (battle: any, context: any) => void) {
  return {
    id,
    name: id,
    description: '',
    trigger: { type },
    effect: (battle: any, context: any) => {
      effect(battle, context)
      return { success: true }
    },
  }
}

function damageLogs(state: any) {
  return state.actions.filter((action: any) => action.type === 'damage').map((action: any) => action.payload)
}

describe('RED-33 deterministic damage pipeline', () => {
  beforeEach(() => globalTriggerSystem.clearRules())
  afterEach(() => globalTriggerSystem.clearRules())

  it.each([
    ['physical', 2],
    ['magical', 2],
    ['true', 5],
    ['toxin', 5],
  ] as const)('resolves %s damage through the approved defense stage', (damageType, expectedDamage) => {
    const attacker = makePiece({ instanceId: `attacker-${damageType}`, ownerPlayerId: 'player-red' }) as any
    const target = makePiece({ instanceId: `target-${damageType}`, ownerPlayerId: 'player-blue' }) as any
    target.defense = 3
    const state = makeState({ pieces: [attacker, target] }) as any

    const result = dealDamage(attacker, target, 5, damageType, state, `stage-${damageType}`)

    expect(result).toMatchObject({
      success: true,
      rawDamage: 5,
      modifiedDamage: 5,
      defense: damageType === 'physical' || damageType === 'magical' ? 3 : 0,
      shieldAbsorbed: 0,
      damage: expectedDamage,
      targetHp: 100 - expectedDamage,
    })
    expect(damageLogs(state)).toEqual([
      expect.objectContaining({
        batchId: result.batchId,
        sourceId: attacker.instanceId,
        skillId: `stage-${damageType}`,
        targetId: target.instanceId,
        damageType,
        rawDamage: 5,
        modifiedDamage: 5,
        defense: damageType === 'physical' || damageType === 'magical' ? 3 : 0,
        shieldAbsorbed: 0,
        finalDamage: expectedDamage,
        blocked: false,
        killed: false,
      }),
    ])
  })

  it('runs beforeDamageDealt once for the whole batch', () => {
    const attacker = makePiece({ instanceId: 'source-once', ownerPlayerId: 'player-red' }) as any
    const first = makePiece({ instanceId: 'source-once-first', ownerPlayerId: 'player-blue' }) as any
    const second = makePiece({ instanceId: 'source-once-second', ownerPlayerId: 'player-blue' }) as any
    const state = makeState({ pieces: [attacker, first, second] }) as any
    state.extensions.beforeDealtCount = 0
    globalTriggerSystem.addRule(eventRule('source-once-observer', 'beforeDamageDealt', (battle, context) => {
      battle.extensions.beforeDealtCount += 1
      context.damage += 2
    }) as any)

    const result = dealDamage(attacker, [second, first], 3, 'true', state, 'source-once')

    expect(state.extensions.beforeDealtCount).toBe(1)
    expect(result).toMatchObject({ success: true, damages: [5, 5], totalDamage: 10 })
    expect(result.results.map((entry: any) => entry.modifiedDamage)).toEqual([5, 5])
  })

  it('keeps original zero at zero while preserving minimum one for positive effective damage', () => {
    const attacker = makePiece({ instanceId: 'minimum-attacker', ownerPlayerId: 'player-red' }) as any
    const zeroTarget = makePiece({ instanceId: 'zero-target', ownerPlayerId: 'player-blue' }) as any
    const minimumTarget = makePiece({ instanceId: 'minimum-target', ownerPlayerId: 'player-blue' }) as any
    zeroTarget.defense = 99
    minimumTarget.defense = 99
    const state = makeState({ pieces: [attacker, zeroTarget, minimumTarget] }) as any

    const zero = dealDamage(attacker, zeroTarget, 0, 'physical', state, 'zero')
    const minimum = dealDamage(attacker, minimumTarget, 1, 'physical', state, 'minimum')

    expect(zero).toMatchObject({ success: true, damage: 0, targetHp: 100, blocked: false })
    expect(minimum).toMatchObject({ success: true, damage: 1, targetHp: 99, blocked: false })
  })

  it('keeps original zero at zero when Icebound Fortitude modifies incoming damage', () => {
    const attacker = makePiece({ instanceId: 'icebound-zero-attacker', ownerPlayerId: 'player-red' }) as any
    const defender = makePiece({ instanceId: 'icebound-zero-defender', ownerPlayerId: 'player-blue' }) as any
    defender.statusTags = [{ id: 'icebound-fortitude', type: 'icebound-fortitude', intensity: 1 }]
    defender.rules = [requiredRule('rule-arthas-icebound')]
    const state = makeState({ pieces: [attacker, defender] }) as any
    state.extensions.beforeDealtCount = 0
    state.extensions.blockedEvents = 0
    globalTriggerSystem.addRules([
      eventRule('observe-icebound-zero-source', 'beforeDamageDealt', battle => {
        battle.extensions.beforeDealtCount += 1
      }),
      eventRule('observe-icebound-zero-blocked', 'afterDamageBlocked', battle => {
        battle.extensions.blockedEvents += 1
      }),
    ] as any)

    const result = dealDamage(attacker, defender, 0, 'physical', state, 'icebound-zero')

    expect(result).toMatchObject({
      success: true,
      rawDamage: 0,
      modifiedDamage: 0,
      damage: 0,
      targetHp: 100,
      blocked: false,
    })
    expect(defender.currentHp).toBe(100)
    expect(state.extensions.beforeDealtCount).toBe(1)
    expect(state.extensions.blockedEvents).toBe(0)
    expect(damageLogs(state)).toEqual([
      expect.objectContaining({ rawDamage: 0, modifiedDamage: 0, finalDamage: 0, blocked: false }),
    ])
  })

  it('absorbs numeric shields after defense and emits afterDamageBlocked exactly once', () => {
    const attacker = makePiece({ instanceId: 'shield-attacker', ownerPlayerId: 'player-red' }) as any
    const target = makePiece({ instanceId: 'shield-target', ownerPlayerId: 'player-blue' }) as any
    target.defense = 3
    target.statusTags = [{ id: 'calm-shield', type: 'calm-shield', intensity: 2 }]
    target.rules = [requiredRule('rule-watcher-shield')]
    const state = makeState({ pieces: [attacker, target] }) as any
    state.extensions.blockedEvents = 0
    globalTriggerSystem.addRule(eventRule('observe-blocked', 'afterDamageBlocked', battle => {
      battle.extensions.blockedEvents += 1
    }) as any)

    const result = dealDamage(attacker, target, 5, 'physical', state, 'numeric-shield')

    expect(result).toMatchObject({
      success: false,
      rawDamage: 5,
      modifiedDamage: 5,
      defense: 3,
      shieldAbsorbed: 2,
      damage: 0,
      blocked: true,
      targetHp: 100,
    })
    expect(state.extensions.blockedEvents).toBe(1)
    expect(target.statusTags).toEqual([])
    expect(target.rules).toEqual([])
  })

  it('consumes divine shield as one complete block and does not emit damage-taken events', () => {
    const attacker = makePiece({ instanceId: 'divine-attacker', ownerPlayerId: 'player-red' }) as any
    const target = makePiece({ instanceId: 'divine-target', ownerPlayerId: 'player-blue' }) as any
    target.statusTags = [{ id: 'divine-shield', type: 'divine-shield', intensity: 1 }]
    target.rules = [requiredRule('rule-divine-shield')]
    const state = makeState({ pieces: [attacker, target] }) as any
    state.extensions.events = []
    globalTriggerSystem.addRules([
      eventRule('observe-divine-block', 'afterDamageBlocked', battle => battle.extensions.events.push('blocked')),
      eventRule('observe-divine-taken', 'afterDamageTaken', battle => battle.extensions.events.push('taken')),
    ] as any)

    const result = dealDamage(attacker, target, 8, 'true', state, 'divine')

    expect(result).toMatchObject({ success: false, damage: 0, blocked: true, targetHp: 100 })
    expect(state.extensions.events).toEqual(['blocked'])
    expect(target.statusTags).toEqual([])
    expect(target.rules).toEqual([])
  })

  it('treats an explicit immunity as one complete block without damage-taken events', () => {
    const attacker = makePiece({ instanceId: 'immune-attacker', ownerPlayerId: 'player-red' }) as any
    const defender = makePiece({ instanceId: 'immune-defender', ownerPlayerId: 'player-blue' }) as any
    defender.statusTags = [{ id: 'hidan-dying', type: 'hidan-dying', intensity: 1 }]
    defender.rules = [requiredRule('rule-hidan-dying-immune')]
    const state = makeState({ pieces: [attacker, defender] }) as any
    state.extensions.events = []
    globalTriggerSystem.addRules([
      eventRule('observe-immunity-block', 'afterDamageBlocked', battle => battle.extensions.events.push('blocked')),
      eventRule('observe-immunity-taken', 'afterDamageTaken', battle => battle.extensions.events.push('taken')),
    ] as any)

    const result = dealDamage(attacker, defender, 6, 'true', state, 'explicit-immunity')

    expect(result).toMatchObject({ success: false, damage: 0, blocked: true, targetHp: 100 })
    expect(state.extensions.events).toEqual(['blocked'])
    expect(defender.currentHp).toBe(100)
    expect(damageLogs(state)).toEqual([expect.objectContaining({ finalDamage: 0, blocked: true })])
  })

  it('queues reflection after its parent batch and links the structured logs', () => {
    const attacker = makePiece({ instanceId: 'reflect-attacker', ownerPlayerId: 'player-red' }) as any
    const defender = makePiece({ instanceId: 'reflect-defender', ownerPlayerId: 'player-blue' }) as any
    defender.statusTags = [{ id: 'kamui-shield', type: 'kamui-shield', intensity: 1 }]
    defender.rules = [requiredRule('rule-obito-kamui-block')]
    const state = makeState({ pieces: [attacker, defender] }) as any

    const result = dealDamage(attacker, defender, 9, 'true', state, 'matrix-reflect')
    const logs = damageLogs(state)

    expect(result).toMatchObject({ success: false, damage: 0, blocked: true })
    expect(defender.currentHp).toBe(100)
    expect(attacker.currentHp).toBe(91)
    expect(logs).toHaveLength(2)
    expect(logs[0]).toMatchObject({ sourceId: attacker.instanceId, targetId: defender.instanceId, finalDamage: 0, blocked: true })
    expect(logs[1]).toMatchObject({ sourceId: defender.instanceId, targetId: attacker.instanceId, skillId: 'kamui-reflect', finalDamage: 9 })
    expect(logs[1].parentBatchId).toBe(logs[0].batchId)
  })

  it('commits every HP result before after-damage and death processing', () => {
    const redCore = makePiece({ instanceId: 'core-red', ownerPlayerId: 'player-red', currentHp: 5, maxHp: 5 }) as any
    const blueCore = makePiece({ instanceId: 'core-blue', ownerPlayerId: 'player-blue', currentHp: 5, maxHp: 5 }) as any
    redCore.isCore = true
    blueCore.isCore = true
    const state = makeState({ pieces: [redCore, blueCore] }) as any
    state.extensions.afterDamageSnapshots = []
    state.extensions.lifecycle = []
    globalTriggerSystem.addRules([
      eventRule('observe-simultaneous-hp', 'afterDamageTaken', battle => {
        battle.extensions.afterDamageSnapshots.push(battle.pieces
          .map((piece: any) => [piece.instanceId, piece.currentHp])
          .sort((left: any, right: any) => left[0].localeCompare(right[0])))
      }),
      eventRule('observe-kill', 'afterPieceKilled', (battle, context) => battle.extensions.lifecycle.push(`kill:${context.targetPiece.instanceId}`)),
      eventRule('observe-death', 'onPieceDied', (battle, context) => battle.extensions.lifecycle.push(`death:${context.sourcePiece.instanceId}`)),
    ] as any)

    const result = dealDamage(redCore, [redCore, blueCore], 5, 'true', state, 'mutual-core')

    expect(result).toMatchObject({ success: true, damages: [5, 5], totalDamage: 10 })
    expect(state.extensions.afterDamageSnapshots).toEqual([
      [['core-blue', 0], ['core-red', 0]],
      [['core-blue', 0], ['core-red', 0]],
    ])
    expect(state.extensions.lifecycle).toEqual([
      'kill:core-blue', 'death:core-blue',
      'kill:core-red', 'death:core-red',
    ])
    expect(state.pieces).toEqual([])
    expect(state.graveyard.map((piece: any) => piece.instanceId)).toEqual(['core-blue', 'core-red'])
    expect(state.players.find((player: any) => player.playerId === 'player-red').chargePoints).toBe(1)
  })

  it('produces the same final state hash when batch input order changes', () => {
    const run = (reverse: boolean) => {
      const attacker = makePiece({ instanceId: 'order-attacker', ownerPlayerId: 'player-red' }) as any
      const alpha = makePiece({ instanceId: 'order-alpha', ownerPlayerId: 'player-blue', currentHp: 4, maxHp: 4 }) as any
      const beta = makePiece({ instanceId: 'order-beta', ownerPlayerId: 'player-blue', currentHp: 4, maxHp: 4 }) as any
      const state = makeState({ pieces: [attacker, alpha, beta] }) as any
      withRuleRuntime(new RuleRuntime({ rootSeed: 3301, tick: 1 }), () => {
        dealDamage(attacker, reverse ? [beta, alpha] : [alpha, beta], 4, 'true', state, 'order-invariant')
      })
      return { state, hash: hashBattleState(state) }
    }

    const forward = run(false)
    const reverse = run(true)

    expect(reverse.hash).toBe(forward.hash)
    expect(reverse.state).toEqual(forward.state)
  })

  it('awards summon kill charge once unless the summon explicitly opts out', () => {
    const attacker = makePiece({ instanceId: 'summon-attacker', ownerPlayerId: 'player-red' }) as any
    const defaultSummon = makePiece({ instanceId: 'summon-default', ownerPlayerId: 'player-blue', currentHp: 1, maxHp: 1 }) as any
    const excludedSummon = makePiece({ instanceId: 'summon-excluded', ownerPlayerId: 'player-blue', currentHp: 1, maxHp: 1 }) as any
    defaultSummon.isCore = false
    excludedSummon.isCore = false
    excludedSummon.noKillCharge = true
    const state = makeState({ pieces: [attacker, defaultSummon, excludedSummon] }) as any

    const result = dealDamage(attacker, [excludedSummon, defaultSummon], 1, 'true', state, 'summon-charge')

    expect(result.results.map((entry: any) => entry.isKilled)).toEqual([true, true])
    expect(state.players.find((player: any) => player.playerId === 'player-red').chargePoints).toBe(1)
    expect(state.graveyard.map((piece: any) => piece.instanceId)).toEqual(['summon-default', 'summon-excluded'])
  })

  it('rejects illegal damage input before triggers and preserves the original state', () => {
    const attacker = makePiece({ instanceId: 'invalid-attacker', ownerPlayerId: 'player-red' }) as any
    const target = makePiece({ instanceId: 'invalid-target', ownerPlayerId: 'player-blue' }) as any
    const state = makeState({ pieces: [attacker, target] }) as any
    const before = hashBattleState(state)

    expect(() => dealDamage(attacker, target, Number.NaN, 'true', state, 'invalid-number')).toThrow(/finite non-negative/i)
    expect(hashBattleState(state)).toBe(before)
    expect(() => dealDamage(attacker, [target, target], 1, 'true', state, 'duplicate-target')).toThrow(/duplicate target/i)
    expect(hashBattleState(state)).toBe(before)
  })

  it('rejects direct reentrant damage from a consumer and clears the ambient guard', () => {
    const attacker = makePiece({ instanceId: 'reentrant-attacker', ownerPlayerId: 'player-red' }) as any
    const defender = makePiece({ instanceId: 'reentrant-defender', ownerPlayerId: 'player-blue' }) as any
    const state = makeState({ pieces: [attacker, defender] }) as any
    const before = hashBattleState(state)
    globalTriggerSystem.addRule(eventRule('illegal-direct-damage', 'beforeDamageTaken', (battle, context) => {
      dealDamage(context.piece, context.targetPiece, 1, 'true', battle, 'illegal-nested-damage')
    }) as any)

    let thrown: any
    try {
      dealDamage(attacker, defender, 1, 'true', state, 'reentrant-root')
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      name: 'DamagePipelineError',
      code: 'RVB_DAMAGE_REENTRANT_CALL',
      context: {
        depth: 1,
      },
    })
    expect(thrown.context.chainId).toMatch(/^damage-batch-/)
    expect(thrown.context.parentBatchId).toMatch(/^damage-batch-/)
    expect(hashBattleState(state)).toBe(before)

    globalTriggerSystem.clearRules()
    expect(dealDamage(attacker, defender, 1, 'true', state, 'after-reentrant-error')).toMatchObject({ damage: 1 })
  })

  it('binds a real Rule skillCode facade to the root battle and rejects its context.battle alias during processing', () => {
    const attacker = makePiece({
      instanceId: 'hidan-reentry-attacker', ownerPlayerId: 'player-red',
    }) as any
    const hidan = makePiece({
      instanceId: 'hidan-reentry-target', ownerPlayerId: 'player-red', currentHp: 10, maxHp: 10,
    }) as any
    const defender = makePiece({
      instanceId: 'hidan-reentry-defender', ownerPlayerId: 'player-blue', currentHp: 10, maxHp: 10,
    }) as any
    hidan.statusTags = [{ id: 'hidan-dying', type: 'hidan-dying', remainingTurns: 1 }]
    hidan.rules = [requiredRule('rule-hidan-undying-tick')]
    const skillId = 'hidan-reentry-root'
    attacker.skills = [{ skillId, currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({ pieces: [attacker, hidan, defender], currentPlayerId: 'player-red' }) as any
    globalTriggerSystem.addRule(eventRule(
      'hidan-end-turn-forwarder',
      'beforeDamageTaken',
      battle => {
        globalTriggerSystem.checkTriggers(battle, { type: 'endTurn', playerId: 'player-red' } as any)
      },
    ) as any)
    state.skillsById[skillId] = {
      id: skillId,
      name: skillId,
      description: '',
      kind: 'active',
      type: 'normal',
      cooldownTurns: 0,
      maxCharges: 0,
      powerMultiplier: 1,
      actionPointCost: 0,
      range: 'self',
      requiresTarget: false,
      code: "function executeSkill(context) { var attacker = context.battle.pieces.find(function(piece) { return piece.instanceId === 'hidan-reentry-attacker'; }); var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'hidan-reentry-defender'; }); dealDamage(attacker, target, 1, 'true', context.battle, 'hidan-reentry-root'); return { success: true }; }",
    }
    const before = hashBattleState(state)
    let caught: any

    try {
      runBattleAction(state, {
        type: 'useBasicSkill',
        playerId: 'player-red',
        pieceId: attacker.instanceId,
        skillId,
        clientActionId: 'hidan-reentry-action',
      } as any, { rootSeed: 139 })
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({
      name: 'EffectChainFatalError',
      code: 'RVB_EFFECT_CHAIN_REENTRANT',
      context: expect.objectContaining({
        chainId: 'effect-chain:hidan-reentry-action',
        sourceId: 'hidan-reentry-target',
        skillId: 'undying-expire',
      }),
    })
    expect(hashBattleState(state)).toBe(before)
  })

  it('keeps the real Hidan context.battle facade on an idle root chain through DeathBatch finalization', () => {
    const hidan = makePiece({
      instanceId: 'hidan-root-chain', ownerPlayerId: 'player-red', currentHp: 1, maxHp: 10,
    }) as any
    hidan.statusTags = [{ id: 'hidan-dying', type: 'hidan-dying', remainingTurns: 1 }]
    hidan.rules = [requiredRule('rule-hidan-undying-tick')]
    const state = makeState({ pieces: [hidan], currentPlayerId: 'player-red' }) as any
    const chain = createEffectChain({
      actionId: 'hidan-end-turn-action',
      chainId: 'hidan-end-turn-chain',
      turn: state.turn.turnNumber,
      rootSeed: 139,
    })

    const triggerResult = withEffectChain(state, chain, () => globalTriggerSystem.checkTriggers(
      state,
      { type: 'endTurn', playerId: 'player-red' } as any,
    ))

    expect(triggerResult.success).toBe(true)
    expect(chain.processedBatches).toBe(2)
    expect(chain.pendingCount).toBe(0)
    expect(chain.state).toBe('idle')
    expect(state.pieces.some((piece: any) => piece.instanceId === hidan.instanceId)).toBe(false)
    expect(state.graveyard.find((piece: any) => piece.instanceId === hidan.instanceId)).toMatchObject({
      currentHp: 0,
    })
    expect(damageLogs(state)).toEqual([
      expect.objectContaining({ chainId: 'hidan-end-turn-chain', skillId: 'undying-expire' }),
    ])
  })

  it('keeps lethal interception out of death, graveyard, and kill-charge processing', () => {
    const attacker = makePiece({ instanceId: 'lich-attacker', ownerPlayerId: 'player-red' }) as any
    const defender = makePiece({ instanceId: 'lich-defender', ownerPlayerId: 'player-blue', currentHp: 5, maxHp: 40, attack: 10 }) as any
    defender.statusTags = [{ id: 'lich-covenant', type: 'lich-covenant', intensity: 1 }]
    defender.skills = [{ skillId: 'matrix-cooldown', currentCooldown: 3 }]
    defender.rules = [requiredRule('rule-arthas-lich-covenant')]
    const state = makeState({ pieces: [attacker, defender] }) as any

    const result = dealDamage(attacker, defender, 99, 'true', state, 'lich-intercept')

    expect(result).toMatchObject({ success: false, damage: 0, blocked: true, isKilled: false, targetHp: 40 })
    expect(state.graveyard).toEqual([])
    expect(state.players.find((player: any) => player.playerId === 'player-red').chargePoints).toBe(0)
    expect(defender.statusTags).toEqual([expect.objectContaining({ type: 'undead-body' })])
  })

  it('finalizes an on-death revival once without graveyard or kill charge', () => {
    const attacker = makePiece({ instanceId: 'revive-attacker', ownerPlayerId: 'player-red' }) as any
    const defender = makePiece({ instanceId: 'revive-defender', ownerPlayerId: 'player-blue', currentHp: 5, maxHp: 20 }) as any
    const state = makeState({ pieces: [attacker, defender] }) as any
    state.extensions.lifecycle = []
    globalTriggerSystem.addRules([
      eventRule('observe-revive-kill', 'afterPieceKilled', battle => {
        battle.extensions.lifecycle.push('kill')
      }),
      eventRule('revive-on-death', 'onPieceDied', (battle, context) => {
        battle.extensions.lifecycle.push('revive')
        context.sourcePiece.currentHp = 7
      }),
    ] as any)

    const result = dealDamage(attacker, defender, 5, 'true', state, 'on-death-revive')

    expect(result).toMatchObject({
      success: true,
      damage: 5,
      isKilled: false,
      targetHp: 7,
    })
    expect(state.extensions.lifecycle).toEqual(['kill', 'revive'])
    expect(state.pieces.map((piece: any) => piece.instanceId)).toContain(defender.instanceId)
    expect(state.graveyard).toEqual([])
    expect(state.players.find((player: any) => player.playerId === 'player-red').chargePoints).toBe(0)
  })

  it('stops a reflected damage cycle with deterministic chain context', () => {
    const first = makePiece({ instanceId: 'cycle-first', ownerPlayerId: 'player-red' }) as any
    const second = makePiece({ instanceId: 'cycle-second', ownerPlayerId: 'player-blue' }) as any
    const state = makeState({ pieces: [first, second] }) as any
    globalTriggerSystem.addRule(eventRule('cycle-reflection', 'beforeDamageTaken', (_battle, context) => {
      context.damageQueue.push({
        attacker: context.piece,
        target: context.targetPiece,
        damage: context.damage,
        damageType: 'true',
        skillId: 'cycle-reflection',
      })
    }) as any)

    let thrown: any
    try {
      withRuleRuntime(new RuleRuntime({ rootSeed: 0x33, tick: 1 }), () => {
        dealDamage(first, second, 1, 'true', state, 'cycle-root')
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      name: 'DamagePipelineError',
      code: 'RVB_DAMAGE_CHAIN_DEPTH',
      context: {
        depth: 21,
        rootSeed: 0x33,
      },
    })
    expect(thrown.context.chainId).toMatch(/^damage-batch-/)
    expect(thrown.context.parentBatchId).toMatch(/^damage-batch-/)
  })

})
