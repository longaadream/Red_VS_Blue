/* eslint-disable @typescript-eslint/no-explicit-any -- pending source keeps forward-compatible identity fields. */
import { describe, expect, it } from 'vitest'

import { applyBattleAction, type BattleState } from '@/lib/game/turn'
import type { PieceSkill } from '@/lib/game/piece'
import { finalizePendingTargetSession } from '@/lib/game/targeting'
import { makePiece, makeState } from '../helpers/minimal-state'

const pendingEffect = `function(ctx) {
  const current = ctx.flow.skills.current().instance;
  ctx.flow.skills.setInstanceField(current, 'level', 9);
  return { success: true };
}`

function pendingState(skills: PieceSkill[], source: Record<string, unknown>): BattleState {
  const piece = makePiece({ instanceId: 'caster', skills })
  const state = makeState({ pieces: [piece], currentPlayerId: 'player-red', phase: 'action' })
  state.pendingTargetSelection = finalizePendingTargetSession(state, {
    playerId: 'player-red',
    ownerPlayerId: 'player-red',
    title: 'Choose a cell',
    targetType: 'cell',
    range: 99,
    filter: 'all',
    effectCode: pendingEffect,
    source: source as any,
    candidates: [{ type: 'cell', x: 1, y: 1 }],
    fixedCandidates: true,
  }, 0)
  return state
}

function resolve(state: BattleState): BattleState {
  const pending = state.pendingTargetSelection!
  return applyBattleAction(state, {
    type: 'pendingTargetSelect',
    playerId: 'player-red',
    targetX: 1,
    targetY: 1,
    selectionId: pending.selectionId,
    stateRevision: pending.stateRevision,
  })
}

describe('pending skill instance identity', () => {
  it('rebinds a serialized pending effect to the exact duplicate skill instance', () => {
    const state = pendingState([
      { skillId: 'duplicate', instanceId: 'first', level: 1 },
      { skillId: 'duplicate', instanceId: 'second', level: 2 },
    ], {
      type: 'skill', id: 'duplicate', skillId: 'duplicate', pieceId: 'caster', skillInstanceId: 'second',
    })
    const restored = JSON.parse(JSON.stringify(state)) as BattleState

    const next = resolve(restored)
    expect(next.pieces[0].skills.map(skill => skill.level)).toEqual([1, 9])
    expect(next.pendingTargetSelection).toBeUndefined()
  })

  it('invalidates a deleted or replaced source instead of selecting another same-name skill', () => {
    const deleted = pendingState([
      { skillId: 'duplicate', instanceId: 'first', level: 1 },
    ], {
      type: 'skill', id: 'duplicate', skillId: 'duplicate', pieceId: 'caster', skillInstanceId: 'second',
    })
    const deletedNext = resolve(deleted)
    expect(deletedNext.pieces[0].skills.map(skill => skill.level)).toEqual([1])
    expect(deletedNext.pendingTargetSelection).toBeUndefined()

    const replaced = pendingState([
      { skillId: 'duplicate', instanceId: 'first', level: 1 },
      { skillId: 'replacement', instanceId: 'second', level: 2 },
    ], {
      type: 'skill', id: 'duplicate', skillId: 'duplicate', pieceId: 'caster', skillInstanceId: 'second',
    })
    const replacedNext = resolve(replaced)
    expect(replacedNext.pieces[0].skills.map(skill => skill.level)).toEqual([1, 2])
    expect(replacedNext.pendingTargetSelection).toBeUndefined()
  })

  it('only lazy-generates a legacy identity when the old definition is unique', () => {
    const unique = pendingState([
      { skillId: 'legacy', level: 1 },
    ], {
      type: 'skill', id: 'legacy', pieceId: 'caster',
    })
    const next = resolve(unique)
    expect(next.pieces[0].skills[0].instanceId).toBe('caster:skill:0')
    expect(next.pieces[0].skills[0].level).toBe(9)

    const ambiguous = pendingState([
      { skillId: 'legacy', level: 1 },
      { skillId: 'legacy', level: 2 },
    ], {
      type: 'skill', id: 'legacy', pieceId: 'caster',
    })
    const ambiguousNext = resolve(ambiguous)
    expect(ambiguousNext.pieces[0].skills.map(skill => skill.level)).toEqual([1, 2])
    expect(ambiguousNext.pendingTargetSelection).toBeUndefined()
  })

  it('keeps the exact identity through a two-selection continuation', () => {
    const state = pendingState([
      { skillId: 'duplicate', instanceId: 'first', level: 1 },
      { skillId: 'duplicate', instanceId: 'second', level: 2 },
    ], {
      type: 'skill', id: 'duplicate', skillId: 'duplicate', pieceId: 'caster', skillInstanceId: 'second',
    })
    state.pendingTargetSelection = finalizePendingTargetSession(state, {
      ...state.pendingTargetSelection!,
      steps: [
        { type: 'cell', filter: 'all', canCancel: true },
        { type: 'cell', filter: 'all', canCancel: true },
      ],
    }, 0)

    const first = resolve(JSON.parse(JSON.stringify(state)) as BattleState)
    expect(first.pendingTargetSelection?.step).toBe(1)
    const second = first.pendingTargetSelection!
    const completed = applyBattleAction(first, {
      type: 'pendingTargetSelect',
      playerId: 'player-red',
      targetX: 2,
      targetY: 2,
      selectionId: second.selectionId,
      stateRevision: second.stateRevision,
    })
    expect(completed.pieces[0].skills.map(skill => skill.level)).toEqual([1, 9])
    expect(completed.pendingTargetSelection).toBeUndefined()
  })

  it('does not treat an afterSkillUsed rule ID as a new active skill lookup', () => {
    const state = pendingState([
      { skillId: 'duplicate', instanceId: 'first', level: 1 },
      { skillId: 'duplicate', instanceId: 'second', level: 2 },
    ], {
      type: 'rule', id: 'duplicate', pieceId: 'rule-owner', skillId: 'duplicate',
      skillInstanceId: 'second', skillPieceId: 'caster',
    })
    state.pendingTargetSelection!.triggerContext = {
      type: 'afterSkillUsed',
      sourcePiece: state.pieces[0],
      skillId: 'duplicate',
      skillInstanceId: 'second',
    }
    const next = resolve(JSON.parse(JSON.stringify(state)) as BattleState)
    expect(next.pieces[0].skills.map(skill => skill.level)).toEqual([1, 9])
  })
})
