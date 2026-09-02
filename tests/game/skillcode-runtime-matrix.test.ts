/* eslint-disable @typescript-eslint/no-explicit-any -- deliberately minimal dynamic-code fixtures */
import { describe, expect, it } from 'vitest'

import { dynamicCodeRuntime, type DynamicCodeSurface } from '@/lib/game/dynamic-code-runtime'
import { calculateSkillPreview, executeCardFunction, executeSkillFunction, loadRuleById } from '@/lib/game/skills'
import { finalizePendingTargetSession } from '@/lib/game/targeting'
import { applyBattleAction } from '@/lib/game/turn'
import { TriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

function expectRuntimeFixtureCache(
  surface: DynamicCodeSurface,
  contentId: string,
  execute: () => void,
) {
  dynamicCodeRuntime.clear()
  execute()
  const afterColdExecution = dynamicCodeRuntime.stats().compiled
  expect(afterColdExecution).toBeGreaterThan(0)

  execute()
  expect(dynamicCodeRuntime.stats().compiled).toBe(afterColdExecution)

  dynamicCodeRuntime.forceReload(surface, contentId)
  execute()
  expect(dynamicCodeRuntime.stats().compiled).toBe(afterColdExecution + 1)
}

function executePendingEffectFixture() {
  const state = makeState({ currentPlayerId: 'player-blue', phase: 'action' }) as any
  state.pendingTargetSelection = finalizePendingTargetSession(state, {
    playerId: 'player-blue',
    title: 'runtime pending fixture',
    targetType: 'cell',
    filter: 'all',
    effectCode: "function(ctx) { ctx.battle.extensions.pendingSurface = ctx.targetX; return { success: true }; }",
  }, 0)

  applyBattleAction(state, {
    type: 'pendingTargetSelect',
    playerId: 'player-blue',
    targetX: 1,
    targetY: 1,
    selectionId: state.pendingTargetSelection.selectionId,
    stateRevision: state.pendingTargetSelection.stateRevision,
  } as any)
  return state.pendingTargetSelection.selectionId as string
}

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
    const piece = makePiece({ instanceId: 'hardy-block-owner' }) as any
    piece.statusTags = [{ id: 'hardy-block', type: 'hardy-block' }]
    const rule = loadRuleById('rule-hardy-block', true)
    expect(rule).not.toBeNull()
    piece.rules = [rule]
    const state = makeState({ pieces: [piece] }) as any
    const beforeAttack = piece.attack
    const context: any = { type: 'afterDamageTaken', playerId: 'player-red', sourcePiece: piece, piece, damage: 4 }

    const result = new TriggerSystem().checkTriggers(state, context)

    expect(result.success).toBe(true)
    expect(piece.attack).toBe(beforeAttack + 2)
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

  it('reuses and force-reloads the compiled function for every real dynamic execution surface', () => {
    const ragePiece = () => {
      const piece = makePiece({ instanceId: 'rage-cache-owner' }) as any
      piece.statusTags = [{ id: 'rage', type: 'rage-stance' }]
      const rule = loadRuleById('rule-watcher-rage-dealt', true)!
      piece.rules = [rule]
      const state = makeState({ pieces: [piece] }) as any
      new TriggerSystem().checkTriggers(state, { type: 'beforeDamageDealt', playerId: 'player-red', sourcePiece: piece, damage: 3 })
    }
    expectRuntimeFixtureCache('ruleSkillCode', 'rule-watcher-rage-dealt', ragePiece)

    const hardyBlockPiece = () => {
      const piece = makePiece({ instanceId: 'hardy-block-cache-owner' }) as any
      piece.statusTags = [{ id: 'hardy-block', type: 'hardy-block' }]
      piece.rules = [loadRuleById('rule-hardy-block', true)!]
      const state = makeState({ pieces: [piece] }) as any
      new TriggerSystem().checkTriggers(state, { type: 'afterDamageTaken', playerId: 'player-red', sourcePiece: piece, piece, damage: 4 })
    }
    expectRuntimeFixtureCache('ruleTriggerSkill', 'hardy-block-trigger', hardyBlockPiece)

    const skill = {
      id: 'runtime-cache-skill', name: 'runtime cache skill', description: '', kind: 'active', type: 'normal',
      cooldownTurns: 0, maxCharges: 0, powerMultiplier: 1, actionPointCost: 0, range: 'self', requiresTarget: false,
      code: "function executeSkill(context) { context.battle.extensions.skillCache = true; return { success: true }; }",
    } as any
    expectRuntimeFixtureCache('skillCode', skill.id, () => {
      const piece = makePiece({ instanceId: 'skill-cache-owner' }) as any
      const state = makeState({ pieces: [piece] }) as any
      executeSkillFunction(skill, { piece, target: null, playerId: 'player-red', battle: state } as any, state)
    })

    const card = {
      id: 'runtime-cache-card', name: 'runtime cache card', description: '', type: 'active', actionPointCost: 0,
      code: "function executeCard(context) { context.battle.extensions.cardCache = true; return { success: true }; }",
    } as any
    expectRuntimeFixtureCache('cardCode', card.id, () => executeCardFunction(card, 'player-red', makeState() as any))

    const previewSkill = {
      ...skill,
      id: 'runtime-cache-preview',
      previewCode: "function calculatePreview() { return { description: 'preview', expectedValues: { damage: 1 } }; }",
    } as any
    expectRuntimeFixtureCache('previewCode', previewSkill.id, () => calculateSkillPreview(previewSkill, makePiece() as any))

    const pendingContentId = executePendingEffectFixture()
    expectRuntimeFixtureCache('pendingEffectCode', pendingContentId, () => { executePendingEffectFixture() })
  })

})
