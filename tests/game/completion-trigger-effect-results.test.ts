/* eslint-disable @typescript-eslint/no-explicit-any -- authoritative trigger fixtures intentionally use JSON-shaped state. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runBattleAction } from '@/lib/game/battle-runner'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import {
  clearRuleCache,
  clearSkillDefinitionCache,
  loadRuleById,
} from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

const ROOT_SEED = 252

function fixturePiece(overrides: Record<string, any>): any {
  return asPieceInstance(makePiece(overrides))
}

function fixtureState(
  pieces: any[],
  currentPlayerId: 'player-red' | 'player-blue',
): BattleState {
  const state = makeState({ pieces, currentPlayerId, width: 8, height: 8 })
  state.players.forEach(player => {
    player.actionPoints = 5
    player.maxActionPoints = 5
  })
  return state
}

function requiredRule(id: string): any {
  const rule = loadRuleById(id, true, true)
  if (!rule) throw new Error(`Missing fixture rule: ${id}`)
  return rule
}

function triggerMessages(state: BattleState): string[] {
  return (state.actions ?? [])
    .filter((action: any) => action.type === 'triggerEffect')
    .map((action: any) => String(action.payload?.message ?? ''))
}

function installNoopSkill(state: BattleState, piece: any): void {
  const skillId = 'completion-trigger-noop'
  state.skillsById[skillId] = {
    id: skillId,
    name: '触发回归无操作技能',
    description: '仅用于验证 beforeSkillUse 触发器完成后仍继续宿主技能。',
    kind: 'active',
    type: 'normal',
    range: 'self',
    actionPointCost: 0,
    cooldownTurns: 0,
    maxCharges: 0,
    powerMultiplier: 1,
    targeting: { steps: [] },
    code: 'function executeSkill(context) { return { success: true }; }',
  }
  piece.skills = [{ skillId, currentCooldown: 0, usesRemaining: -1 }]
}

beforeEach(() => {
  globalTriggerSystem.clearRules()
})

afterEach(() => {
  globalTriggerSystem.clearRules()
  clearRuleCache()
  clearSkillDefinitionCache()
})

describe('real triggerSkill effects settle and expose their result to downstream graph nodes', () => {
  it('settles Blizzard damage through endTurn and consumes total damage for its message path', () => {
    const caster = fixturePiece({
      instanceId: 'blizzard-caster',
      templateId: 'red-blizzard',
      ownerPlayerId: 'player-red',
      faction: 'red',
      x: 0,
      y: 0,
      attack: 7,
      skills: [{ skillId: 'blizzard-damage', currentCooldown: 0, usesRemaining: -1 }],
    })
    const enemy = fixturePiece({
      instanceId: 'blizzard-target',
      templateId: 'blue-target',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 0,
      currentHp: 30,
      maxHp: 30,
      defense: 0,
    })
    const state = fixtureState([caster, enemy], 'player-blue')
    ;(state.players[0] as any).statusTags = [{
      id: 'blizzard-status',
      type: 'blizzard',
      centerX: 2,
      centerY: 0,
      damage: 5,
    }]
    ;(state.players[0] as any).rules = [requiredRule('rule-blizzard-active')]

    const next = runBattleAction(
      state,
      { type: 'endTurn', playerId: 'player-blue', clientActionId: 'blizzard-real-chain' } as BattleAction,
      { rootSeed: ROOT_SEED },
    ).state

    expect(next.pieces.find(piece => piece.instanceId === enemy.instanceId)?.currentHp).toBe(25)
    expect((next.players[0] as any).statusTags).toEqual([])
    expect(triggerMessages(next).some(message => message.includes('5'))).toBe(true)
  })

  it('settles Pulse Pistol damage during beforeSkillUse before the host skill continues', () => {
    const caster = fixturePiece({
      instanceId: 'pulse-caster',
      templateId: 'red-pulse-pistol',
      ownerPlayerId: 'player-red',
      faction: 'red',
      x: 0,
      y: 0,
      attack: 10,
    })
    caster.rules = [requiredRule('rule-pulse-pistol')]
    const actor = fixturePiece({
      instanceId: 'pulse-skill-actor',
      templateId: 'blue-actor',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 0,
      currentHp: 30,
      maxHp: 30,
      defense: 0,
    })
    const state = fixtureState([caster, actor], 'player-blue')
    installNoopSkill(state, actor)

    const next = runBattleAction(
      state,
      {
        type: 'useBasicSkill',
        playerId: 'player-blue',
        pieceId: actor.instanceId,
        skillId: 'completion-trigger-noop',
        clientActionId: 'pulse-skill-real-chain',
      } as BattleAction,
      { rootSeed: ROOT_SEED },
    ).state

    expect(next.pieces.find(piece => piece.instanceId === actor.instanceId)?.currentHp).toBe(20)
    expect(triggerMessages(next).some(message => message.includes('10'))).toBe(true)
  })

  it('settles Pulse Pistol damage during beforeMove and still commits the move', () => {
    const caster = fixturePiece({
      instanceId: 'pulse-move-caster',
      templateId: 'red-pulse-pistol',
      ownerPlayerId: 'player-red',
      faction: 'red',
      x: 0,
      y: 0,
      attack: 10,
    })
    caster.rules = [requiredRule('rule-pulse-pistol-move')]
    const mover = fixturePiece({
      instanceId: 'pulse-mover',
      templateId: 'blue-mover',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 1,
      y: 0,
      currentHp: 30,
      maxHp: 30,
      moveRange: 3,
      defense: 0,
    })
    const state = fixtureState([caster, mover], 'player-blue')

    const next = runBattleAction(
      state,
      {
        type: 'move',
        playerId: 'player-blue',
        pieceId: mover.instanceId,
        toX: 1,
        toY: 1,
        clientActionId: 'pulse-move-real-chain',
      } as BattleAction,
      { rootSeed: ROOT_SEED },
    ).state

    const moved = next.pieces.find(piece => piece.instanceId === mover.instanceId)
    expect(moved).toMatchObject({ x: 1, y: 1, currentHp: 20 })
    expect(triggerMessages(next).some(message => message.includes('10'))).toBe(true)
  })

  it('settles Shishio burn after a real movement contact and consumes the damage result', () => {
    const shishio = fixturePiece({
      instanceId: 'shishio',
      templateId: 'red-shishio',
      ownerPlayerId: 'player-red',
      faction: 'red',
      x: 0,
      y: 0,
      attack: 7,
    })
    shishio.rules = [requiredRule('rule-shishio-burn-move')]
    const mover = fixturePiece({
      instanceId: 'burn-mover',
      templateId: 'red-mover',
      ownerPlayerId: 'player-red',
      faction: 'red',
      x: 1,
      y: 0,
      currentHp: 20,
      maxHp: 20,
      moveRange: 3,
      defense: 0,
    })
    const state = fixtureState([shishio, mover], 'player-red')
    ;(state.extensions as any).shishioBurnTiles = [{
      sourcePieceId: shishio.instanceId,
      x: 2,
      y: 0,
    }]

    const next = runBattleAction(
      state,
      {
        type: 'move',
        playerId: 'player-red',
        pieceId: mover.instanceId,
        toX: 2,
        toY: 0,
        clientActionId: 'shishio-burn-real-chain',
      } as BattleAction,
      { rootSeed: ROOT_SEED },
    ).state

    const moved = next.pieces.find(piece => piece.instanceId === mover.instanceId)
    expect(moved).toMatchObject({ x: 2, y: 0, currentHp: 10 })
    expect(triggerMessages(next).some(message => message.includes('10'))).toBe(true)
  })
})
