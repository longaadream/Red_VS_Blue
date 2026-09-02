import { beforeEach, describe, expect, it } from 'vitest'

import { runBattleAction } from '@/lib/game/battle-runner'
import { executeSkillFunction, loadAllSkillsById, loadRuleById } from '@/lib/game/skills'
import { prepareAction, targetRefKey } from '@/lib/game/targeting'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

function installSkill(state: any, piece: any, skillId: string): void {
  state.skillsById[skillId] = loadAllSkillsById()[skillId]
  piece.skills = [{ skillId, currentCooldown: 0, usesRemaining: -1 }]
}

function expectUniqueLivingCells(state: any): void {
  const cells = state.pieces
    .filter((piece: any) => piece.currentHp > 0)
    .map((piece: any) => `${piece.x},${piece.y}`)
  expect(new Set(cells).size).toBe(cells.length)
}

beforeEach(() => globalTriggerSystem.clearRules())

describe('RED-174 skill landing contracts', () => {
  it('lets Illidan Blade Dash damage through enemies but land only on an open cell', () => {
    const illidan = makePiece({
      instanceId: 'illidan', templateId: 'red-illidan', ownerPlayerId: 'player-red', x: 0, y: 1,
    }) as any
    const enemy = makePiece({
      instanceId: 'dash-enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 1,
    }) as any
    const state = makeState({ pieces: [illidan, enemy], width: 7, height: 3 }) as any
    installSkill(state, illidan, 'illidan-blade-dash')

    const prepared = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: illidan.instanceId,
      skillId: 'illidan-blade-dash',
    } as any)

    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    expect(prepared.candidates.map(targetRefKey)).not.toContain('cell:2,1')
    expect(prepared.candidates.map(targetRefKey)).toContain('cell:3,1')

    const resolved = runBattleAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: illidan.instanceId,
      skillId: 'illidan-blade-dash', targetX: 3, targetY: 1,
      selectionId: prepared.selectionId, stateRevision: prepared.stateRevision,
    } as any, { rootSeed: 174 }).state as any

    expect(resolved.pieces.find((piece: any) => piece.instanceId === illidan.instanceId)).toMatchObject({ x: 3, y: 1 })
    expect(resolved.pieces.find((piece: any) => piece.instanceId === enemy.instanceId).currentHp).toBeLessThan(enemy.currentHp)
    expectUniqueLivingCells(resolved)
  })

  it('keeps Grimmjow hunting destinations away from cells reserved by the triggering skill', () => {
    const grimmjow = makePiece({
      instanceId: 'grimmjow', templateId: 'dark-grimmjow', ownerPlayerId: 'player-red', x: 0, y: 1,
    }) as any
    grimmjow.rules = [loadRuleById('rule-grimmjow-hunt-after-skill', true)]
    const enemy = makePiece({
      instanceId: 'enemy-caster', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 1,
    }) as any
    enemy.skills = [{ skillId: 'reserved-cell-skill', currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({
      pieces: [grimmjow, enemy], currentPlayerId: 'player-blue', width: 6, height: 4,
    }) as any
    state.skillsById['reserved-cell-skill'] = {
      id: 'reserved-cell-skill', name: '预留落点技能', description: '', kind: 'active', type: 'normal',
      cooldownTurns: 0, maxCharges: 0, powerMultiplier: 1, actionPointCost: 1,
      targeting: { steps: [{ kind: 'target', type: 'grid', filter: 'all', range: 3, requireWalkable: true, requireUnoccupied: true }] },
      code: "function executeSkill() { return { success: true, message: 'reserved' }; }",
    }
    const base = {
      type: 'useBasicSkill', playerId: 'player-blue', pieceId: enemy.instanceId, skillId: 'reserved-cell-skill',
    }
    const prepared = prepareAction(state, base as any)
    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return

    const pending = runBattleAction(state, {
      ...base, targetX: 1, targetY: 1,
      selectionId: prepared.selectionId, stateRevision: prepared.stateRevision,
    } as any, { rootSeed: 174 }).state as any

    expect(pending.pendingTargetSelection).toMatchObject({ playerId: 'player-red' })
    expect(pending.pendingTargetSelection.candidates).not.toContainEqual({ type: 'cell', x: 1, y: 1 })
  })

  it('reserves Aizen Shunpo landing so Flying Raijin cannot take it during beforeSkillUse', () => {
    const aizen = makePiece({
      instanceId: 'aizen', templateId: 'dark-aizen', ownerPlayerId: 'player-red', x: 0, y: 0,
      attack: 4,
    }) as any
    const minato = makePiece({
      instanceId: 'minato', templateId: 'blue-minato', ownerPlayerId: 'player-red', x: 0, y: 4,
      attack: 3,
    }) as any
    minato.rules = [loadRuleById('rule-minato-flying-raijin-trigger', true)]
    const target = makePiece({
      instanceId: 'marked-enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 2,
      attack: 2, currentHp: 20, maxHp: 20,
    }) as any
    target.statusTags = [{
      id: 'raijin-mark', type: 'flying-raijin-mark', sourceId: minato.instanceId,
      name: '飞雷神', stacks: 1, visible: true,
    }]
    const blockers = [[2, 2], [3, 3]].map(([x, y], index) => makePiece({
      instanceId: `landing-blocker-${index}`, ownerPlayerId: 'player-red', x, y,
    }))
    const state = makeState({ pieces: [aizen, minato, target, ...blockers], width: 6, height: 5 }) as any
    installSkill(state, aizen, 'aizen-shunpo')
    state.players[0].actionPoints = 2
    const base = {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: aizen.instanceId, skillId: 'aizen-shunpo',
    }
    const prepared = prepareAction(state, base as any)
    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    const action = {
      ...base,
      targetPieceId: target.instanceId,
      extraTargets: [{ x: 3, y: 1 }],
      selectionId: prepared.selectionId,
      stateRevision: prepared.stateRevision,
    }
    expect(prepareAction(state, action as any)).toEqual({ kind: 'ready' })

    const pendingRun = runBattleAction(state, action as any, { rootSeed: 174 })
    const repeatedPendingRun = runBattleAction(state, action as any, { rootSeed: 174 })
    expect(repeatedPendingRun.stateHash).toBe(pendingRun.stateHash)
    const pending = pendingRun.state as any
    expect(pending.pendingOptionSelection).toMatchObject({ playerId: 'player-red' })
    const resolveAction = {
      type: 'pendingOptionSelect', playerId: 'player-red', selectedOption: 'yes',
      selectionId: pending.pendingOptionSelection.selectionId,
      stateRevision: pending.pendingOptionSelection.stateRevision,
    }
    const resolvedRun = runBattleAction(pending, resolveAction as any, { rootSeed: 174 })
    const repeatedResolvedRun = runBattleAction(repeatedPendingRun.state, resolveAction as any, { rootSeed: 174 })
    expect(repeatedResolvedRun.stateHash).toBe(resolvedRun.stateHash)
    const resolved = resolvedRun.state as any

    expect(resolved.pendingOptionSelection).toBeUndefined()
    expect(resolved.pieces.find((piece: any) => piece.instanceId === aizen.instanceId)).toMatchObject({ x: 3, y: 1 })
    expect(resolved.pieces.find((piece: any) => piece.instanceId === minato.instanceId)).toMatchObject({ x: 4, y: 2, attack: 4 })
    expectUniqueLivingCells(resolved)
  })

  it('cancels Shadow Step exact teleport and cleans its marker when the saved cell is occupied', () => {
    const reaper = makePiece({
      instanceId: 'reaper', ownerPlayerId: 'player-red', x: 0, y: 0,
      statusTags: [{ id: 'shadow-step-tag', type: 'shadow-step', remainingDuration: 1, value: 2, intensity: 1 }],
    }) as any
    reaper.name = '死神'
    const blocker = makePiece({ instanceId: 'shadow-step-blocker', ownerPlayerId: 'player-blue', x: 2, y: 1 }) as any
    const state = makeState({ pieces: [reaper, blocker], width: 4, height: 3 }) as any
    state.extensions.tileEffects = [{ x: 2, y: 1, sourceId: 'shadow-step-reaper', tileType: 'shadow-step' }]
    const skill = loadAllSkillsById()['shadow-step-teleport']

    const result = executeSkillFunction(skill, {
      piece: reaper,
      playerId: 'player-red',
      battle: state,
      target: null,
      targetPosition: null,
      skill: { id: skill.id, name: skill.name, type: skill.type, powerMultiplier: skill.powerMultiplier },
    } as any, state)

    expect(result).toMatchObject({ success: true })
    expect(reaper).toMatchObject({ x: 0, y: 0 })
    expect(reaper.statusTags).not.toContainEqual(expect.objectContaining({ type: 'shadow-step' }))
    expect(state.extensions.tileEffects).toEqual([])
    expectUniqueLivingCells(state)
  })

  it('offers Kenshin only enemies that currently have a legal nearby landing', () => {
    const kenshin = makePiece({ instanceId: 'kenshin', ownerPlayerId: 'player-red', x: 0, y: 0, attack: 4 }) as any
    const blocked = makePiece({ instanceId: 'blocked-enemy', ownerPlayerId: 'player-blue', x: 2, y: 2 }) as any
    const open = makePiece({ instanceId: 'open-enemy', ownerPlayerId: 'player-blue', x: 5, y: 2 }) as any
    const blockers = [[2, 1], [1, 2], [3, 2], [2, 3]].map(([x, y], index) => makePiece({
      instanceId: `kenshin-blocker-${index}`, ownerPlayerId: 'player-red', x, y,
    }))
    const state = makeState({ pieces: [kenshin, blocked, open, ...blockers], width: 7, height: 5 }) as any
    installSkill(state, kenshin, 'kenshin-amakakeru')
    state.players[0].actionPoints = 4
    state.players[0].chargePoints = 2

    const prepared = prepareAction(state, {
      type: 'useChargeSkill', playerId: 'player-red', pieceId: kenshin.instanceId,
      skillId: 'kenshin-amakakeru',
    } as any)

    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    expect(prepared.candidates).not.toContainEqual({ type: 'piece', pieceId: blocked.instanceId })
    expect(prepared.candidates).toContainEqual({ type: 'piece', pieceId: open.instanceId })
  })
})
