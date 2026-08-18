/* eslint-disable @typescript-eslint/no-explicit-any -- deliberately minimal dynamic-code fixtures */
import { describe, expect, it } from 'vitest'

import { executeCardFunction, executeSkillFunction, loadRuleById } from '@/lib/game/skills'
import { TriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

describe('RED-45 runtime skillCode matrix', () => {
  it('runs a loaded rule skillCode against its owning piece and mutates the shared context', () => {
    const piece = makePiece({ instanceId: 'rage-owner' }) as any
    piece.statusTags = [{ id: 'rage', type: 'rage-stance' }]
    const rule = loadRuleById('rule-watcher-rage-dealt', true)
    expect(rule).not.toBeNull()
    piece.rules = [rule]
    const state = makeState({ pieces: [piece] }) as any
    const context: any = { type: 'beforeDamageDealt', playerId: 'player-red', sourcePiece: piece, damage: 3 }

    const result = new TriggerSystem().checkTriggers(state, context)

    expect(result.success).toBe(true)
    expect(context.damage).toBe(6)
  })

  it('runs a loaded triggerSkill rule through the skill executor', () => {
    const piece = makePiece({ instanceId: 'blessing-owner' }) as any
    piece.statusTags = [{ id: 'divine-blessing-buff', type: 'divine-blessing-buff', intensity: 4 }]
    const rule = loadRuleById('rule-divine-blessing', true)
    expect(rule).not.toBeNull()
    piece.rules = [rule]
    const state = makeState({ pieces: [piece] }) as any
    const context: any = { type: 'beforeDamageDealt', playerId: 'player-red', sourcePiece: piece, piece, damage: 3 }

    const result = new TriggerSystem().checkTriggers(state, context)

    expect(result.success).toBe(true)
    expect(context.damage).toBe(7)
    expect(piece.statusTags).toEqual([])
  })

  it('runs a piece skill code fixture with its battle/context helpers', () => {
    const piece = makePiece({ instanceId: 'caster' })
    const state = makeState({ pieces: [piece] }) as any
    const result = executeSkillFunction({
      id: 'matrix-skill', name: 'matrix', description: '', kind: 'active', type: 'normal',
      cooldownTurns: 0, maxCharges: 0, powerMultiplier: 1, actionPointCost: 0, range: 'self', requiresTarget: false,
      code: "function executeSkill(context) { context.battle.extensions.skillSurface = context.piece.instanceId; return { success: true }; }",
    } as any, { piece, target: null, playerId: 'player-red', battle: state } as any, state)

    expect(result.success).toBe(true)
    expect(state.extensions.skillSurface).toBe('caster')
  })

  it('runs an active card code fixture with its player and battle context', () => {
    const state = makeState() as any
    const result = executeCardFunction({
      id: 'matrix-card', name: 'matrix', description: '', type: 'active', actionPointCost: 0,
      code: "function executeCard(context) { context.battle.extensions.cardSurface = context.playerId; return { success: true }; }",
    } as any, 'player-red', state)

    expect(result.success).toBe(true)
    expect(state.extensions.cardSurface).toBe('player-red')
  })

})
