/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-authored skills are exercised through the runtime. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { hashBattleState } from '@/lib/game/battle-trace'
import { runBattleAction } from '@/lib/game/battle-runner'
import { prepareAction } from '@/lib/game/targeting'
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
})
