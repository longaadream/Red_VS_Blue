/* eslint-disable @typescript-eslint/no-explicit-any -- data-driven audit fixtures intentionally use runtime shapes */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { dealDamage, executeSkillFunction, loadRuleById } from '@/lib/game/skills'
import { finalizePendingTargetSession } from '@/lib/game/targeting'
import { TriggerSystem, globalTriggerSystem } from '@/lib/game/triggers'
import { applyBattleAction, summonPiece } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

function requiredRule(id: string) {
  const rule = loadRuleById(id, true)
  if (!rule) throw new Error(`Missing fixture rule: ${id}`)
  return rule
}

describe('RED-45 complex combat mechanisms', () => {
  beforeEach(() => globalTriggerSystem.clearRules())
  afterEach(() => globalTriggerSystem.clearRules())

  it('applies one modified damage value to multiple targets', () => {
    const attacker = makePiece({ instanceId: 'multi-attacker', ownerPlayerId: 'player-red' }) as any
    const first = makePiece({ instanceId: 'multi-first', ownerPlayerId: 'player-blue' }) as any
    const second = makePiece({ instanceId: 'multi-second', ownerPlayerId: 'player-blue' }) as any
    const state = makeState({ pieces: [attacker, first, second] }) as any

    const result = dealDamage(attacker, [first, second], 7, 'true', state, 'matrix-multi')

    expect(result).toMatchObject({ success: true, damages: [7, 7], totalDamage: 14 })
    expect([first.currentHp, second.currentHp]).toEqual([93, 93])
  })

  it('blocks incoming damage and reflects it exactly once', () => {
    const attacker = makePiece({ instanceId: 'reflect-attacker', ownerPlayerId: 'player-red' }) as any
    const defender = makePiece({ instanceId: 'reflect-defender', ownerPlayerId: 'player-blue' }) as any
    defender.statusTags = [{ id: 'kamui-shield', type: 'kamui-shield', intensity: 1 }]
    defender.rules = [requiredRule('rule-obito-kamui-block')]
    const state = makeState({ pieces: [attacker, defender] }) as any

    const result = dealDamage(attacker, defender, 9, 'true', state, 'matrix-reflect')

    expect(result).toMatchObject({ success: false, damage: 0 })
    expect(defender.currentHp).toBe(100)
    expect(attacker.currentHp).toBe(91)
    expect(defender.statusTags).toEqual([])
    expect(defender.rules).toEqual([])
  })

  it('intercepts lethal damage and revives through the real lich covenant rule', () => {
    const attacker = makePiece({ instanceId: 'lethal-attacker', ownerPlayerId: 'player-red' }) as any
    const defender = makePiece({ instanceId: 'lich-defender', ownerPlayerId: 'player-blue', attack: 10 }) as any
    defender.currentHp = 5
    defender.maxHp = 40
    defender.statusTags = [{ id: 'lich-covenant', type: 'lich-covenant', intensity: 1 }]
    defender.skills = [{ skillId: 'matrix-cooldown', currentCooldown: 3 }]
    defender.rules = [requiredRule('rule-arthas-lich-covenant')]
    const state = makeState({ pieces: [attacker, defender] }) as any

    const result = dealDamage(attacker, defender, 99, 'true', state, 'matrix-lethal')

    expect(result).toMatchObject({ success: false, damage: 0 })
    expect(defender.currentHp).toBe(40)
    expect(defender.attack).toBe(15)
    expect(defender.skills[0].currentCooldown).toBe(0)
    expect(defender.statusTags).toEqual([expect.objectContaining({ type: 'undead-body' })])
    expect(defender.rules).toEqual([])
  })

  it('dispatches before/after summon around one inserted piece', () => {
    const state = makeState({ pieces: [] }) as any
    state.extensions.runtimeTrace = []
    const eventRule = (id: string, type: string) => ({
      id,
      name: id,
      description: '',
      trigger: { type },
      effect: (battle: any) => {
        battle.extensions.runtimeTrace.push(type)
        return { success: true }
      },
    })
    globalTriggerSystem.addRules([
      eventRule('summon-before', 'beforePieceSummoned'),
      eventRule('summon-after', 'afterPieceSummoned'),
    ] as any)
    const summoned = makePiece({ instanceId: 'summoned-piece', templateId: 'matrix-summon', ownerPlayerId: 'player-red' }) as any

    const result = summonPiece(
      state,
      { templateId: 'matrix-summon', faction: 'red', ownerPlayerId: 'player-red', x: 2, y: 3 },
      () => ({ id: 'matrix-summon', rules: [] }),
      () => summoned,
    )

    expect(result).toMatchObject({ success: true, piece: summoned })
    expect(state.extensions.runtimeTrace).toEqual(['beforePieceSummoned', 'afterPieceSummoned'])
    expect(state.pieces).toEqual([summoned])
  })

  it('executes the real Susanoo transformation and replaces skills', () => {
    const skill = JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills/sasuke-susanoo.json'), 'utf8'))
    const caster = makePiece({ instanceId: 'sasuke', ownerPlayerId: 'player-red', attack: 10 }) as any
    caster.skills = [{ skillId: 'sasuke-chidori', currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({ pieces: [caster] }) as any
    state.skillsById[skill.id] = skill

    const result = executeSkillFunction(skill, { piece: caster, target: null, playerId: 'player-red', battle: state } as any, state)

    expect(result.success).toBe(true)
    expect(caster.attack).toBe(13)
    expect(caster.skills.map((entry: any) => entry.skillId)).toEqual([
      'sasuke-kagutsuchi',
      'sasuke-indra-arrow',
    ])
    expect(caster.statusTags).toEqual([expect.objectContaining({ type: 'susanoo-active' })])
  })

  it('expires a timed status and its rule at the approved end-turn event', () => {
    const cursed = makePiece({ instanceId: 'cursed', ownerPlayerId: 'player-blue' }) as any
    cursed.statusTags = [{
      id: 'blood-oath-cursed',
      type: 'blood-oath',
      sourcePlayerId: 'player-red',
      remainingTurns: 1,
      remainingDuration: 1,
      currentDuration: 1,
    }]
    cursed.rules = [requiredRule('rule-blood-oath-tick')]
    const state = makeState({ pieces: [cursed], currentPlayerId: 'player-red' }) as any
    state.turn.currentPlayerId = 'player-red'

    const result = new TriggerSystem().checkTriggers(state, { type: 'endTurn', playerId: 'player-red' } as any)

    expect(result.success).toBe(true)
    expect(cursed.statusTags).toEqual([])
    expect(cursed.rules).toEqual([])
  })

  it('executes and discards a reactive response card', () => {
    const state = makeState() as any
    state.extensions.runtimeTrace = []
    state.players[0].hand = [{ cardId: 'matrix-response', instanceId: 'response-card', ownerPlayerId: 'player-red' }]
    state.customCards = {
      'matrix-response': {
        id: 'matrix-response', name: 'response', description: '', type: 'reactive',
        trigger: { type: 'matrix-response' },
        code: "function executeCard(context) { context.battle.extensions.runtimeTrace.push('response'); return { success: true }; }",
      },
    }

    const result = new TriggerSystem().checkTriggers(state, { type: 'matrix-response', playerId: 'player-red' } as any)

    expect(result.success).toBe(true)
    expect(state.extensions.runtimeTrace).toEqual(['response'])
    expect(state.players[0].hand).toEqual([])
    expect(state.players[0].discardPile).toEqual(['matrix-response'])
  })

  it('keeps a two-step pending session ordered and executes only after completion', () => {
    const state = makeState({ currentPlayerId: 'player-blue', phase: 'action' }) as any
    state.extensions.runtimeTrace = []
    state.pendingTargetSelection = finalizePendingTargetSession(state, {
      playerId: 'player-blue',
      title: 'matrix continuous pending',
      targetType: 'cell',
      filter: 'all',
      steps: [
        { type: 'cell', filter: 'all', canCancel: true },
        { type: 'cell', filter: 'all', canCancel: true },
      ],
      effectCode: "function(ctx) { ctx.battle.extensions.runtimeTrace.push(ctx.pending.selectedTargets); return { success: true, message: 'complete' }; }",
    }, 0)

    const afterFirst = applyBattleAction(state, {
      type: 'pendingTargetSelect', playerId: 'player-blue', targetX: 1, targetY: 1,
      selectionId: state.pendingTargetSelection.selectionId,
      stateRevision: state.pendingTargetSelection.stateRevision,
    } as any) as any
    expect(afterFirst.extensions.runtimeTrace).toEqual([])

    const completed = applyBattleAction(afterFirst, {
      type: 'pendingTargetSelect', playerId: 'player-blue', targetX: 2, targetY: 2,
      selectionId: afterFirst.pendingTargetSelection.selectionId,
      stateRevision: afterFirst.pendingTargetSelection.stateRevision,
    } as any) as any

    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(completed.extensions.runtimeTrace).toEqual([[
      { type: 'cell', x: 1, y: 1 },
      { type: 'cell', x: 2, y: 2 },
    ]])
  })
})
