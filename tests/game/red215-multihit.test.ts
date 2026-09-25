/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-authored skills are exercised through the runtime. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { hashBattleState } from '@/lib/game/battle-trace'
import { runBattleAction } from '@/lib/game/battle-runner'
import { createEffectChain, getActiveEffectChain, withEffectChain } from '@/lib/game/effect-batch'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { prepareAction } from '@/lib/game/targeting'
import { applyBattleAction, validateSkillActionByDryRun } from '@/lib/game/turn'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const DATA_ROOT = join(process.cwd(), 'data')

function loadSkill(skillId: string): any {
  return JSON.parse(readFileSync(join(DATA_ROOT, 'skills', `${skillId}.json`), 'utf8'))
}

function installSkill(state: BattleState, piece: any, skillId: string): void {
  state.skillsById[skillId] = loadSkill(skillId)
  piece.skills = [{ skillId, currentCooldown: 0, usesRemaining: -1 }]
}

function selectedGridAction(
  state: BattleState,
  pieceId: string,
  skillId: string,
  targetX: number,
  targetY: number,
): BattleAction {
  const base = { type: 'useBasicSkill', playerId: 'player-red', pieceId, skillId } as BattleAction
  const prepared = prepareAction(state, base)
  if (prepared.kind !== 'needTarget') throw new Error(`Expected target selection, received ${prepared.kind}`)
  return { ...base, targetX, targetY, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision } as BattleAction
}

describe('RED-215 multi-hit damage', () => {
  it('allows Alfonso Kick to finish its second hit after the first hit kills the target', () => {
    const alfonso = makePiece({
      instanceId: 'alfonso-red215-first-hit-kill',
      templateId: 'red-alfonso',
      x: 0,
      y: 0,
      attack: 4,
    }) as any
    const victim = makePiece({
      instanceId: 'victim-red215-first-hit-kill',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 1,
      y: 0,
      currentHp: 2,
      maxHp: 2,
    }) as any
    const state = makeState({ pieces: [alfonso, victim], width: 6, height: 2 })
    installSkill(state, alfonso, 'alfonso-kick')
    state.players[0].actionPoints = 1

    const action = selectedGridAction(state, alfonso.instanceId, 'alfonso-kick', 1, 0)

    const outcome = runBattleAction(state, action, { rootSeed: 215 })
    const { state: next } = outcome
    expect(runBattleAction(state, action, { rootSeed: 215 }).stateHash).toBe(outcome.stateHash)

    expect(next.players[0].actionPoints).toBe(0)
    expect(next.pieces.find(piece => piece.instanceId === alfonso.instanceId)?.skills?.[0].currentCooldown).toBe(1)
    expect(next.pieces.some(piece => piece.instanceId === victim.instanceId)).toBe(false)
    expect(next.graveyard.filter(piece => piece.instanceId === victim.instanceId)).toHaveLength(1)
    expect(next.actions?.filter(entry => (
      entry.type === 'damage' && entry.payload?.targetId === victim.instanceId
    ))).toHaveLength(1)
  })

  it('allows the direct reducer entrypoint to finish Alfonso Kick after the first hit kills the target', () => {
    const alfonso = makePiece({
      instanceId: 'alfonso-red215-direct-apply',
      templateId: 'red-alfonso',
      x: 0,
      y: 0,
      attack: 4,
    }) as any
    const victim = makePiece({
      instanceId: 'victim-red215-direct-apply',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 1,
      y: 0,
      currentHp: 2,
      maxHp: 2,
    }) as any
    const state = makeState({ pieces: [alfonso, victim], width: 6, height: 2 })
    installSkill(state, alfonso, 'alfonso-kick')
    state.players[0].actionPoints = 1

    const action = selectedGridAction(state, alfonso.instanceId, 'alfonso-kick', 1, 0)
    const next = applyBattleAction(state, action)

    expect(next.players[0].actionPoints).toBe(0)
    expect(next.pieces.some(piece => piece.instanceId === victim.instanceId)).toBe(false)
    expect(next.graveyard.filter(piece => piece.instanceId === victim.instanceId)).toHaveLength(1)
    expect(getActiveEffectChain(state)).toBeUndefined()
    expect(getActiveEffectChain(next)).toBeUndefined()
  })

  it('keeps repeated standalone skill validation calls free of state mutation', () => {
    const alfonso = makePiece({
      instanceId: 'alfonso-red215-standalone-validation',
      templateId: 'red-alfonso',
      x: 0,
      y: 0,
      attack: 4,
    }) as any
    const victim = makePiece({
      instanceId: 'victim-red215-standalone-validation',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 1,
      y: 0,
      currentHp: 2,
      maxHp: 2,
    }) as any
    const state = makeState({ pieces: [alfonso, victim], width: 6, height: 2 })
    installSkill(state, alfonso, 'alfonso-kick')
    state.players[0].actionPoints = 1
    const action = selectedGridAction(state, alfonso.instanceId, 'alfonso-kick', 1, 0)
    const before = hashBattleState(state)

    expect(() => validateSkillActionByDryRun(state, action)).not.toThrow()
    expect(() => validateSkillActionByDryRun(state, action)).not.toThrow()
    expect(hashBattleState(state)).toBe(before)
    expect(state.pieces.find(piece => piece.instanceId === victim.instanceId)?.currentHp).toBe(2)
  })

  it('reuses a caller-provided effect chain without clearing its outer scope', () => {
    const alfonso = makePiece({
      instanceId: 'alfonso-red215-attached-direct',
      templateId: 'red-alfonso',
      x: 0,
      y: 0,
      attack: 4,
    }) as any
    const victim = makePiece({
      instanceId: 'victim-red215-attached-direct',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 1,
      y: 0,
      currentHp: 2,
      maxHp: 2,
    }) as any
    const state = makeState({ pieces: [alfonso, victim], width: 6, height: 2 })
    installSkill(state, alfonso, 'alfonso-kick')
    state.players[0].actionPoints = 1
    const action = selectedGridAction(state, alfonso.instanceId, 'alfonso-kick', 1, 0)
    const chain = createEffectChain({
      actionId: 'red215-attached-direct-action',
      chainId: 'effect-chain:red215-attached-direct-action',
      turn: state.turn.turnNumber,
      rootSeed: null,
    })

    let next: BattleState | undefined
    withEffectChain(state, chain, () => {
      expect(getActiveEffectChain(state)).toBe(chain)
      next = applyBattleAction(state, action)
      expect(getActiveEffectChain(state)).toBe(chain)
      expect(getActiveEffectChain(next!)).toBeUndefined()
    })

    expect(next?.graveyard.filter(piece => piece.instanceId === victim.instanceId)).toHaveLength(1)
    expect(chain.processedBatches).toBeGreaterThan(0)
    expect(getActiveEffectChain(state)).toBeUndefined()
  })

  it('uses a distinct temporary chain for consecutive direct actions in one turn', () => {
    const observed: Array<{ chainId?: string; batchId?: string }> = []
    const alfonso = makePiece({
      instanceId: 'alfonso-red215-direct-sequence',
      templateId: 'red-alfonso',
      x: 0,
      y: 0,
      attack: 4,
      rules: [{
        id: 'red215-observe-direct-chain',
        trigger: { type: 'beforeDamageDealt' },
        effect: (_battle: BattleState, context: any) => {
          observed.push({ chainId: context.damageChainId, batchId: context.damageBatchId })
          return { success: true }
        },
      }],
    }) as any
    const victim = makePiece({
      instanceId: 'victim-red215-direct-sequence',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 1,
      y: 0,
      currentHp: 12,
      maxHp: 12,
    }) as any
    const state = makeState({ pieces: [alfonso, victim], width: 6, height: 2 })
    installSkill(state, alfonso, 'alfonso-kick')
    state.players[0].actionPoints = 2

    const action = selectedGridAction(state, alfonso.instanceId, 'alfonso-kick', 1, 0)
    const first = applyBattleAction(state, action)
    const firstAlfonso = first.pieces.find(piece => piece.instanceId === alfonso.instanceId)!
    firstAlfonso.skills![0].currentCooldown = 0
    const second = applyBattleAction(first, selectedGridAction(
      first,
      alfonso.instanceId,
      'alfonso-kick',
      1,
      0,
    ))

    expect(second.pieces.find(piece => piece.instanceId === victim.instanceId)?.currentHp).toBe(4)
    expect(observed).toHaveLength(4)
    expect(observed.slice(0, 2).every(entry => entry.chainId === observed[0].chainId)).toBe(true)
    expect(observed.slice(2).every(entry => entry.chainId === observed[2].chainId)).toBe(true)
    expect(observed[0].chainId).toBeDefined()
    expect(observed[0].chainId).not.toBe(observed[2].chainId)
    expect(observed[0].batchId).not.toBe(observed[2].batchId)
    expect(getActiveEffectChain(state)).toBeUndefined()
    expect(getActiveEffectChain(first)).toBeUndefined()
    expect(getActiveEffectChain(second)).toBeUndefined()
  })

  it('allocates unique damage batches for consecutive direct actions under a replay runtime', () => {
    const alfonso = makePiece({
      instanceId: 'alfonso-red215-direct-runtime',
      templateId: 'red-alfonso',
      x: 0,
      y: 0,
      attack: 4,
    }) as any
    const victim = makePiece({
      instanceId: 'victim-red215-direct-runtime',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 1,
      y: 0,
      currentHp: 12,
      maxHp: 12,
    }) as any
    const state = makeState({ pieces: [alfonso, victim], width: 6, height: 2 })
    installSkill(state, alfonso, 'alfonso-kick')
    state.players[0].actionPoints = 2
    const runtime = new RuleRuntime({ rootSeed: 215, tick: 0 })

    const second = withRuleRuntime(runtime, () => {
      const first = applyBattleAction(state, selectedGridAction(state, alfonso.instanceId, 'alfonso-kick', 1, 0))
      first.pieces.find(piece => piece.instanceId === alfonso.instanceId)!.skills![0].currentCooldown = 0
      return applyBattleAction(first, selectedGridAction(first, alfonso.instanceId, 'alfonso-kick', 1, 0))
    })

    const damageActions = (second.actions || []).filter(action => action.type === 'damage')
    const batchIds = damageActions.map(action => action.payload?.batchId)
    expect(batchIds).toHaveLength(4)
    expect(new Set(batchIds).size).toBe(4)
    expect(runtime.getCursor('instance-id/damage-batch')).toBe(4)
  })

  it('rolls back the first lethal hit when a later hit in the same skill is invalid', () => {
    const skillId = 'red215-rollback-after-lethal-hit'
    const attacker = makePiece({
      instanceId: 'attacker-red215-rollback',
      templateId: 'red-alfonso',
      x: 0,
      y: 0,
    }) as any
    const victim = makePiece({
      instanceId: 'victim-red215-rollback',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 1,
      y: 0,
      currentHp: 2,
      maxHp: 2,
    }) as any
    const state = makeState({ pieces: [attacker, victim], width: 6, height: 2 })
    state.skillsById[skillId] = {
      id: skillId,
      name: skillId,
      description: '',
      kind: 'active',
      type: 'normal',
      cooldownTurns: 1,
      maxCharges: 0,
      powerMultiplier: 1,
      actionPointCost: 1,
      range: 'self',
      requiresTarget: false,
      code: `function executeSkill(context) {
        var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'victim-red215-rollback'; });
        dealDamage(context.piece, target, 2, 'true', context.battle, '${skillId}');
        dealDamage(context.piece, target, NaN, 'true', context.battle, '${skillId}');
        return { success: true };
      }`,
    }
    attacker.skills = [{ skillId, currentCooldown: 0, usesRemaining: -1 }]
    state.players[0].actionPoints = 1
    const before = hashBattleState(state)

    let caught: any
    try {
      runBattleAction(state, {
        type: 'useBasicSkill',
        playerId: 'player-red',
        pieceId: attacker.instanceId,
        skillId,
      }, { rootSeed: 215 })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({
      name: 'EffectChainFatalError',
      cause: expect.objectContaining({ code: 'RVB_DAMAGE_VALUE_INVALID' }),
    })

    expect(hashBattleState(state)).toBe(before)
    expect(state.players[0].actionPoints).toBe(1)
    expect(state.pieces.find(piece => piece.instanceId === victim.instanceId)?.currentHp).toBe(2)
    expect(state.graveyard).toHaveLength(0)
  })

  it('rolls back a direct reducer action when a later multi-hit damage value is invalid', () => {
    const skillId = 'red215-direct-rollback-after-lethal-hit'
    const attacker = makePiece({
      instanceId: 'attacker-red215-direct-rollback',
      templateId: 'red-alfonso',
      x: 0,
      y: 0,
    }) as any
    const victim = makePiece({
      instanceId: 'victim-red215-direct-rollback',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 1,
      y: 0,
      currentHp: 2,
      maxHp: 2,
    }) as any
    const state = makeState({ pieces: [attacker, victim], width: 6, height: 2 })
    state.skillsById[skillId] = {
      id: skillId,
      name: skillId,
      description: '',
      kind: 'active',
      type: 'normal',
      cooldownTurns: 1,
      maxCharges: 0,
      powerMultiplier: 1,
      actionPointCost: 1,
      range: 'self',
      requiresTarget: false,
      code: `function executeSkill(context) {
        var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'victim-red215-direct-rollback'; });
        dealDamage(context.piece, target, 2, 'true', context.battle, '${skillId}');
        dealDamage(context.piece, target, NaN, 'true', context.battle, '${skillId}');
        return { success: true };
      }`,
    }
    attacker.skills = [{ skillId, currentCooldown: 0, usesRemaining: -1 }]
    state.players[0].actionPoints = 1
    const before = hashBattleState(state)

    expect(() => applyBattleAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: attacker.instanceId,
      skillId,
    })).toThrow()

    expect(hashBattleState(state)).toBe(before)
    expect(state.players[0].actionPoints).toBe(1)
    expect(state.pieces.find(piece => piece.instanceId === victim.instanceId)?.currentHp).toBe(2)
    expect(state.graveyard).toHaveLength(0)
    expect(getActiveEffectChain(state)).toBeUndefined()
  })
})
