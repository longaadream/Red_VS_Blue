import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

const TRIGGER_OK = { success: true, messages: [], blocked: false }
vi.mock('@/lib/game/triggers', () => ({
  globalTriggerSystem: {
    checkTriggers: vi.fn(() => TRIGGER_OK),
    updateCooldowns: vi.fn(),
    addRule: vi.fn(),
    removeRule: vi.fn(),
    clearRules: vi.fn(),
    getRules: vi.fn(() => []),
  },
  TriggerType: {},
}))
vi.mock('@/lib/game/skill-repository', () => ({
  getSkillById: vi.fn(() => null),
  getAllSkills: vi.fn(() => []),
}))
vi.mock('@/lib/game/attached-effect', () => ({
  buildSelfObject: vi.fn(() => ({})),
  removeEffectFromPiece: vi.fn(),
  applyEffectToPiece: vi.fn(),
}))

import {
  getTargetingStateRevision,
  finalizePendingTargetSession,
  prepareAction,
  assertActionPlayer,
  targetRefKey,
  validateTargetRef,
} from '@/lib/game/targeting'
import { applyBattleAction } from '@/lib/game/turn'
import { generateBotActions } from '@/lib/game/ai'
import { hashStable } from '@/lib/game/battle-runner'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState, makeTile } from '../helpers/minimal-state'

function targetedSkill(
  id: string,
  code: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name: id,
    description: '',
    kind: 'active',
    type: 'normal',
    cooldownTurns: 0,
    maxCharges: 0,
    powerMultiplier: 1,
    actionPointCost: 1,
    range: 'single',
    requiresTarget: true,
    code,
    ...overrides,
  }
}

describe('authoritative target preparation', () => {
  it('returns exact living enemy candidates without mutating state, triggers, logs, or RNG', () => {
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 1, y: 1 })
    const enemyNear = makePiece({ instanceId: 'enemy-near', ownerPlayerId: 'player-blue', x: 3, y: 1 })
    const enemyFar = makePiece({ instanceId: 'enemy-far', ownerPlayerId: 'player-blue', x: 5, y: 4 })
    const deadEnemy = makePiece({ instanceId: 'enemy-dead', ownerPlayerId: 'player-blue', x: 2, y: 1, currentHp: 0 })
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 1, y: 2 })
    caster.skills = [{ skillId: 'contract-shot', currentCooldown: 0, usesRemaining: -1 }] as never
    const state = makeState({ pieces: [caster, enemyNear, enemyFar, deadEnemy, ally], width: 6, height: 5 })
    state.skillsById['contract-shot'] = targetedSkill(
      'contract-shot',
      "function executeSkill(context) { var target = selectTarget({ type: 'piece', range: 2, filter: 'enemy' }); context.battle.extensions.executed = true; Math.random(); return target && target.needsTargetSelection ? target : { success: true }; }",
    ) as never
    const before = JSON.stringify(state)
    const randomSpy = vi.spyOn(Math, 'random')

    const prepared = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'caster', skillId: 'contract-shot',
    })

    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    expect(prepared.candidates.map(targetRefKey)).toEqual(['piece:enemy-near'])
    expect(prepared).toMatchObject({ step: 0, min: 1, max: 1, stateRevision: 0, canCancel: true })
    expect(JSON.stringify(state)).toBe(before)
    expect(randomSpy).not.toHaveBeenCalled()
    expect(globalTriggerSystem.checkTriggers).not.toHaveBeenCalled()
    randomSpy.mockRestore()
  })

  it('keeps an exact empty candidate set instead of inventing a fallback', () => {
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 0, y: 0 })
    caster.skills = [{ skillId: 'no-targets', currentCooldown: 0, usesRemaining: -1 }] as never
    const state = makeState({ pieces: [caster] })
    state.skillsById['no-targets'] = targetedSkill(
      'no-targets',
      "function executeSkill() { return selectTarget({ type: 'piece', range: 1, filter: 'enemy' }); }",
    ) as never

    const prepared = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'caster', skillId: 'no-targets',
    })

    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind === 'needTarget') expect(prepared.candidates).toEqual([])
  })

  it('uses the same validator for returned candidates and rejects omitted dead/ally/range targets', () => {
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 1, y: 1 })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2, y: 1 })
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 2, y: 2 })
    const state = makeState({ pieces: [caster, enemy, ally] })
    const constraint = {
      type: 'piece' as const,
      filter: 'enemy' as const,
      range: 1,
      ownerPlayerId: 'player-red',
      sourcePieceId: 'caster',
    }

    expect(validateTargetRef(state, constraint, { type: 'piece', pieceId: 'enemy' })).toBeUndefined()
    expect(validateTargetRef(state, constraint, { type: 'piece', pieceId: 'ally' })?.code).toBe('TARGET_FILTER_MISMATCH')
    enemy.currentHp = 0
    expect(validateTargetRef(state, constraint, { type: 'piece', pieceId: 'enemy' })?.code).toBe('TARGET_NOT_ALIVE')
  })

  it('requires the query selection id/revision and rejects stale, wrong-id, and illegal submissions atomically', () => {
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 1, y: 1 })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2, y: 1 })
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 1, y: 2 })
    caster.skills = [{ skillId: 'versioned-shot', currentCooldown: 0, usesRemaining: -1 }] as never
    const state = makeState({ pieces: [caster, enemy, ally] })
    state.skillsById['versioned-shot'] = targetedSkill(
      'versioned-shot',
      "function executeSkill(context) { var target = selectTarget({ type: 'piece', range: 2, filter: 'enemy' }); if (!target || target.needsTargetSelection) return target; context.battle.extensions.hit = target.instanceId; return { success: true, message: 'hit' }; }",
    ) as never
    const prepared = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'caster', skillId: 'versioned-shot',
    })
    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    const before = JSON.stringify(state)
    const baseAction = {
      type: 'useBasicSkill' as const,
      playerId: 'player-red',
      pieceId: 'caster',
      skillId: 'versioned-shot',
      targetPieceId: 'enemy',
      selectionId: prepared.selectionId,
      stateRevision: prepared.stateRevision,
    }

    for (const invalid of [
      [{ ...baseAction, selectionId: 'wrong' }, 'TARGET_SELECTION_ID_MISMATCH'],
      [{ ...baseAction, stateRevision: prepared.stateRevision + 1 }, 'TARGET_SELECTION_STALE'],
      [{ ...baseAction, targetPieceId: 'ally' }, 'TARGET_FILTER_MISMATCH'],
    ]) {
      expect(() => applyBattleAction(state, invalid[0] as never))
        .toThrow(expect.objectContaining({ code: invalid[1] }))
      expect(JSON.stringify(state)).toBe(before)
    }

    const next = applyBattleAction(state, baseAction as never)
    expect(next.extensions?.hit).toBe('enemy')
    expect(getTargetingStateRevision(next)).toBe(prepared.stateRevision + 1)
    expect(state.players[0].actionPoints).toBe(2)
    expect(next.players[0].actionPoints).toBe(1)
  })

  it('supports precise multi-step candidates and does not pay or execute before the final target', () => {
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 1, y: 1 })
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 2, y: 1 })
    caster.skills = [{ skillId: 'two-step', currentCooldown: 0, usesRemaining: -1 }] as never
    const state = makeState({ pieces: [caster, ally], width: 4, height: 3 })
    state.map.tiles = state.map.tiles.map(tile => tile.x === 3 && tile.y === 2 ? makeTile(3, 2, false) : tile) as never
    state.skillsById['two-step'] = targetedSkill(
      'two-step',
      "function executeSkill(context) { var ally = selectTarget({ type: 'piece', range: 3, filter: 'ally' }); if (!ally || ally.needsTargetSelection) return ally; var cell = selectTarget({ type: 'grid', range: 2, filter: 'all' }); if (!cell || cell.needsTargetSelection) return cell; context.battle.extensions.done = [ally.instanceId, cell.x, cell.y]; return { success: true, message: 'done' }; }",
    ) as never
    const draft = { type: 'useBasicSkill' as const, playerId: 'player-red', pieceId: 'caster', skillId: 'two-step' }
    const first = prepareAction(state, draft)
    expect(first.kind).toBe('needTarget')
    if (first.kind !== 'needTarget') return

    const second = prepareAction(state, {
      ...draft,
      targetPieceId: 'ally',
      selectionId: first.selectionId,
      stateRevision: first.stateRevision,
    })
    expect(second.kind).toBe('needTarget')
    if (second.kind !== 'needTarget') return
    expect(second.step).toBe(1)
    expect(second.selectionId).toBe(first.selectionId)
    expect(second.candidates.some(ref => ref.type === 'cell' && ref.x === 3 && ref.y === 2)).toBe(false)
    expect(state.players[0].actionPoints).toBe(2)
    expect(state.extensions?.done).toBeUndefined()
  })

  it('supports a declarative option between action preparation and exact targets', () => {
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 1, y: 1 })
    caster.skills = [{ skillId: 'option-then-target', currentCooldown: 0, usesRemaining: -1 }] as never
    const state = makeState({ pieces: [caster], width: 8, height: 8 })
    state.skillsById['option-then-target'] = targetedSkill(
      'option-then-target',
      'function executeSkill() { throw new Error("query must not execute effects") }',
      {
        targeting: {
          steps: [
            { kind: 'option', title: 'mode', options: [{ label: 'teleport', value: 'teleport' }] },
            {
              kind: 'target', type: 'grid', filter: 'all', range: 2,
              distanceMetric: 'chebyshev', requireWalkable: true, requireUnoccupied: true,
              allowSourceOccupantOptions: ['teleport'],
            },
          ],
        },
      },
    ) as never
    const draft = { type: 'useBasicSkill' as const, playerId: 'player-red', pieceId: 'caster', skillId: 'option-then-target' }

    const option = prepareAction(state, draft)
    expect(option.kind).toBe('needOption')
    if (option.kind !== 'needOption') return
    const target = prepareAction(state, {
      ...draft,
      selectedOption: 'teleport',
      selectionId: option.selectionId,
      stateRevision: option.stateRevision,
    })
    expect(target.kind).toBe('needTarget')
    if (target.kind !== 'needTarget') return
    expect(target.step).toBe(1)
    expect(target.selectionId).toBe(option.selectionId)
    expect(target.candidates).toContainEqual({ type: 'cell', x: 3, y: 3 })
    expect(target.candidates).toContainEqual({ type: 'cell', x: 1, y: 1 })
  })

  it('executes declared Chebyshev cell candidates with the same distance semantics', () => {
    const caster = makePiece({ instanceId: 'blink-caster', ownerPlayerId: 'player-red', x: 1, y: 1 })
    caster.skills = [{ skillId: 'blink-contract', currentCooldown: 0, usesRemaining: -1 }] as never
    const state = makeState({ pieces: [caster], width: 5, height: 5 }) as any
    state.skillsById['blink-contract'] = {
      ...targetedSkill('blink-contract', "function executeSkill(context) { var caster = context.piece; var pos = selectTarget({ type: 'grid', range: 2, filter: 'all' }); if (!pos || pos.needsTargetSelection) return pos; caster.x = pos.x; caster.y = pos.y; return { success: true, message: 'blink' }; }"),
      targeting: {
        steps: [{ kind: 'target', type: 'grid', filter: 'all', range: 2, distanceMetric: 'chebyshev' }],
      },
    }
    const draft = { type: 'useBasicSkill' as const, playerId: 'player-red', pieceId: 'blink-caster', skillId: 'blink-contract' }
    const prepared = prepareAction(state, draft)
    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    expect(prepared.candidates).toContainEqual({ type: 'cell', x: 3, y: 3 })

    const next = applyBattleAction(state, {
      ...draft,
      targetX: 3,
      targetY: 3,
      selectionId: prepared.selectionId,
      stateRevision: prepared.stateRevision,
    } as never)
    expect(next.pieces.find(piece => piece.instanceId === 'blink-caster')).toMatchObject({ x: 3, y: 3 })
  })

  it('rejects ordinary actions while a target session is pending and keeps cancel available', () => {
    const state = makeState({ pieces: [makePiece({ instanceId: 'caster', x: 1, y: 1 })] }) as any
    state.pendingTargetSelection = {
      playerId: 'player-red',
      ownerPlayerId: 'player-red',
      source: { type: 'rule', id: 'rule-test', pieceId: 'caster' },
      targetType: 'grid',
      range: 1,
      filter: 'all',
      min: 1,
      max: 1,
      step: 0,
      selectedTargets: [],
      selectionId: 'pending-test',
      stateRevision: 0,
      candidates: [{ type: 'cell', x: 1, y: 0 }],
      canCancel: true,
    }
    const before = JSON.stringify(state)

    expect(() => applyBattleAction(state, {
      type: 'move', playerId: 'player-red', pieceId: 'caster', toX: 1, toY: 0,
    })).toThrow()
    expect(JSON.stringify(state)).toBe(before)

    const cancelled = applyBattleAction(state, {
      type: 'cancelPendingSelection', playerId: 'player-red', selectionId: 'pending-test', stateRevision: 0,
    } as never)
    expect(cancelled.pendingTargetSelection).toBeUndefined()
  })

  it('rejects wrong-player and repeated pending target submissions with stable codes', () => {
    const state = makeState({ pieces: [makePiece({ instanceId: 'caster', x: 1, y: 1 })] }) as any
    state.pendingTargetSelection = finalizePendingTargetSession(state, {
      playerId: 'player-red',
      ownerPlayerId: 'player-red',
      source: { type: 'rule', id: 'pending-contract', pieceId: 'caster' },
      targetType: 'cell',
      range: 1,
      filter: 'all',
    }, 0)
    const selection = state.pendingTargetSelection
    const validAction = {
      type: 'pendingTargetSelect' as const,
      playerId: 'player-red',
      targetX: 1,
      targetY: 0,
      selectionId: selection.selectionId,
      stateRevision: selection.stateRevision,
    }

    expect(() => applyBattleAction(state, { ...validAction, playerId: 'player-blue' } as never))
      .toThrow(expect.objectContaining({ code: 'TARGET_SELECTION_PLAYER_MISMATCH' }))
    const next = applyBattleAction(state, validAction as never)
    expect(() => applyBattleAction(next, validAction as never))
      .toThrow(expect.objectContaining({ code: 'TARGET_SELECTION_ALREADY_RESOLVED' }))
  })

  it('advances a versioned multi-step pending session and runs its effect only after the final target', () => {
    const caster = makePiece({ instanceId: 'pending-caster', ownerPlayerId: 'player-red', x: 1, y: 1 })
    const state = makeState({ pieces: [caster], width: 4, height: 4 }) as any
    state.pendingTargetSelection = finalizePendingTargetSession(state, {
      playerId: 'player-red',
      ownerPlayerId: 'player-red',
      source: { type: 'rule', id: 'pending-two-step', pieceId: 'pending-caster' },
      title: 'Two targets',
      targetType: 'piece',
      steps: [
        { type: 'piece', filter: 'ally', range: 1 },
        { type: 'cell', filter: 'all', range: 1, requireWalkable: true, requireUnoccupied: true },
      ],
      effectCode: "function(ctx) { ctx.battle.extensions.pendingResolvedTargets = ctx.pending.selectedTargets; return { success: true, message: 'resolved' }; }",
    }, 0)

    const firstSession = state.pendingTargetSelection
    const afterFirst = applyBattleAction(state, {
      type: 'pendingTargetSelect',
      playerId: 'player-red',
      targetPieceId: 'pending-caster',
      selectionId: firstSession.selectionId,
      stateRevision: firstSession.stateRevision,
    } as never) as any
    expect(afterFirst.extensions.pendingResolvedTargets).toBeUndefined()
    expect(afterFirst.pendingTargetSelection).toMatchObject({ step: 1, stateRevision: 1 })
    expect(afterFirst.pendingTargetSelection.selectedTargets).toEqual([{ type: 'piece', pieceId: 'pending-caster' }])
    expect(afterFirst.pendingTargetSelection.candidates).toContainEqual({ type: 'cell', x: 1, y: 0 })

    const secondSession = afterFirst.pendingTargetSelection
    const afterSecond = applyBattleAction(afterFirst, {
      type: 'pendingTargetSelect',
      playerId: 'player-red',
      targetX: 1,
      targetY: 0,
      selectionId: secondSession.selectionId,
      stateRevision: secondSession.stateRevision,
    } as never) as any
    expect(afterSecond.pendingTargetSelection).toBeUndefined()
    expect(afterSecond.extensions.pendingResolvedTargets).toEqual([
      { type: 'piece', pieceId: 'pending-caster' },
      { type: 'cell', x: 1, y: 0 },
    ])
  })

  it('distinguishes stale cancellation, wrong IDs, and repeated cancellation', () => {
    const state = makeState({ pieces: [makePiece({ instanceId: 'caster', x: 1, y: 1 })] }) as any
    state.pendingTargetSelection = finalizePendingTargetSession(state, {
      playerId: 'player-red',
      ownerPlayerId: 'player-red',
      source: { type: 'rule', id: 'pending-cancel-contract', pieceId: 'caster' },
      targetType: 'cell',
      range: 1,
      filter: 'all',
    }, 0)
    const selection = state.pendingTargetSelection
    const baseAction = {
      type: 'cancelPendingSelection' as const,
      playerId: 'player-red',
      selectionId: selection.selectionId,
      stateRevision: selection.stateRevision,
    }

    expect(() => applyBattleAction(state, { ...baseAction, stateRevision: 1 } as never))
      .toThrow(expect.objectContaining({ code: 'TARGET_SELECTION_STALE' }))
    expect(() => applyBattleAction(state, { ...baseAction, selectionId: 'wrong' } as never))
      .toThrow(expect.objectContaining({ code: 'TARGET_SELECTION_ID_MISMATCH' }))
    const cancelled = applyBattleAction(state, baseAction as never)
    expect(() => applyBattleAction(cancelled, baseAction as never))
      .toThrow(expect.objectContaining({ code: 'TARGET_SELECTION_ALREADY_RESOLVED' }))
  })

  it('rejects a transport submission for a different authenticated player with a stable code', () => {
    expect(() => assertActionPlayer('player-red', { type: 'pendingTargetSelect', playerId: 'player-blue' }))
      .toThrow(expect.objectContaining({ code: 'ACTION_PLAYER_MISMATCH' }))
    expect(() => assertActionPlayer(undefined, { type: 'pendingTargetSelect', playerId: 'player-red' }))
      .toThrow(expect.objectContaining({ code: 'ACTION_PLAYER_MISMATCH' }))
    expect(() => assertActionPlayer(undefined, { type: 'beginPhase' })).not.toThrow()
  })

  it('makes AI consume the same candidates and produce the same authoritative state hash as UI selection', () => {
    const caster = makePiece({ instanceId: 'bot-caster', ownerPlayerId: 'player-red', x: 1, y: 1 })
    const enemy = makePiece({ instanceId: 'only-enemy', ownerPlayerId: 'player-blue', x: 2, y: 1, currentHp: 7 })
    caster.skills = [{ skillId: 'shared-shot', currentCooldown: 0, usesRemaining: -1 }] as never
    const state = makeState({ pieces: [caster, enemy] })
    state.skillsById['shared-shot'] = targetedSkill(
      'shared-shot',
      "function executeSkill(context) { var target = selectTarget({ type: 'piece', range: 1, filter: 'enemy' }); if (!target || target.needsTargetSelection) return target; context.battle.extensions.sharedHit = target.instanceId; return { success: true, message: 'hit' }; }",
    ) as never
    const draft = { type: 'useBasicSkill' as const, playerId: 'player-red', pieceId: 'bot-caster', skillId: 'shared-shot' }
    const prepared = prepareAction(state, draft)
    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    const aiAction = generateBotActions(state, 'player-red').find(action => action.type === 'useBasicSkill')
    expect(aiAction).toMatchObject({
      ...draft,
      targetPieceId: 'only-enemy',
      selectionId: prepared.selectionId,
      stateRevision: prepared.stateRevision,
    })
    const uiAction = {
      ...draft,
      targetPieceId: 'only-enemy',
      selectionId: prepared.selectionId,
      stateRevision: prepared.stateRevision,
    }
    expect(hashStable(applyBattleAction(state, aiAction as never)))
      .toBe(hashStable(applyBattleAction(state, uiAction as never)))
  })
})

describe('Demo targeting admission fixture', () => {
  it('covers the fixed 25-piece / 79-skill / 16-card manifest with a stable preparation hash', () => {
    const pieceIds = JSON.parse(readFileSync(resolve(process.cwd(), 'data/pieces/manifest.json'), 'utf8')) as string[]
    const cardIds = JSON.parse(readFileSync(resolve(process.cwd(), 'data/cards/manifest.json'), 'utf8')) as string[]
    const skillIds = [...new Set(pieceIds.flatMap(pieceId => {
      const piece = JSON.parse(readFileSync(resolve(process.cwd(), `data/pieces/${pieceId}.json`), 'utf8'))
      return (piece.skills || []).map((skill: any) => skill.skillId as string)
    }))].sort()
    expect({ pieces: pieceIds.length, skills: skillIds.length, cards: cardIds.length })
      .toEqual({ pieces: 25, skills: 79, cards: 16 })

    const source = makePiece({ instanceId: 'fixture-source', templateId: 'blue-minato', ownerPlayerId: 'player-red', x: 10, y: 8 })
    source.statusTags = [{ id: 'fixture-divine-shield', type: 'divine-shield' }] as never
    const ally = makePiece({ instanceId: 'fixture-ally', ownerPlayerId: 'player-red', x: 11, y: 8 })
    const watcher = makePiece({ instanceId: 'fixture-watcher', templateId: 'blue-watcher', ownerPlayerId: 'player-red', x: 9, y: 8 })
    const hashirama = makePiece({ instanceId: 'fixture-hashirama', templateId: 'hashirama-edo', ownerPlayerId: 'player-red', x: 8, y: 8 })
    const enemy = makePiece({ instanceId: 'fixture-enemy', ownerPlayerId: 'player-blue', x: 12, y: 8 })
    const state = makeState({ pieces: [source, ally, watcher, hashirama, enemy], width: 20, height: 16 }) as any
    state.players.find((player: any) => player.playerId === 'player-red').actionPoints = 999
    state.players.find((player: any) => player.playerId === 'player-red').chargePoints = 999
    state.extensions.minatoAnchors = [{ sourceId: source.instanceId, x: 13, y: 8 }]
    state.extensions.amaterasuCells = [{ x: 7, y: 7 }]

    const fixture: any[] = []
    for (const skillId of skillIds) {
      const definition = JSON.parse(readFileSync(resolve(process.cwd(), `data/skills/${skillId}.json`), 'utf8'))
      source.skills = [{ skillId, currentCooldown: 0, usesRemaining: 1 }] as never
      state.skillsById = { [skillId]: definition }
      const actionType = (definition.chargeCost || 0) > 0 ? 'useChargeSkill' : 'useBasicSkill'
      const prepared = prepareAction(state, {
        type: actionType, playerId: 'player-red', pieceId: source.instanceId, skillId,
      })
      expect(prepared.kind, skillId).not.toBe('invalid')
      fixture.push(prepared.kind === 'needTarget'
        ? [skillId, prepared.kind, prepared.step, prepared.candidates.map(targetRefKey)]
        : prepared.kind === 'needOption'
          ? [skillId, prepared.kind, prepared.step, prepared.options.map(option => option.value)]
          : [skillId, prepared.kind])
    }

    const red = state.players.find((player: any) => player.playerId === 'player-red')
    for (const cardId of cardIds) {
      red.hand = [{ cardId, instanceId: `fixture-card-${cardId}`, actionPointCost: 0 }]
      const prepared = prepareAction(state, {
        type: 'playCard', playerId: 'player-red', cardInstanceId: `fixture-card-${cardId}`,
      })
      expect(prepared.kind, cardId).not.toBe('invalid')
      fixture.push(prepared.kind === 'needTarget'
        ? [cardId, prepared.kind, prepared.step, prepared.candidates.map(targetRefKey)]
        : prepared.kind === 'needOption'
          ? [cardId, prepared.kind, prepared.step, prepared.options.map(option => option.value)]
          : [cardId, prepared.kind])
    }

    const fixtureHash = createHash('sha256').update(JSON.stringify(fixture)).digest('hex')
    expect(fixtureHash).toBe('463c53edf669b388339f5ca81cd847a0357aa97c3d14fba4344129e76e11b9e1')
  })
})

describe('targeting consumers and performance contract', () => {
  it('keeps a multi-step card target session alive across battlefield clicks', () => {
    const html = readFileSync(resolve(process.cwd(), 'data/pages/battle.html'), 'utf8')
    const helperStart = html.indexOf('function shouldCancelPendingCardTarget')
    const helperEnd = html.indexOf('\n\n      // Click outside', helperStart)
    const helperSource = html.slice(helperStart, helperEnd)

    expect(helperStart).toBeGreaterThanOrEqual(0)
    expect(helperEnd).toBeGreaterThan(helperStart)

    const shouldCancel = new Function(
      `${helperSource}; return shouldCancelPendingCardTarget`,
    )() as (pendingAction: unknown, target: unknown) => boolean
    const targetWithin = (matchedSelector: string | null) => ({
      closest: (selector: string) => matchedSelector && selector.includes(matchedSelector) ? {} : null,
    })

    expect(shouldCancel({ step: 1 }, targetWithin('#boardWrap'))).toBe(false)
    expect(shouldCancel({ step: 1 }, targetWithin('.arc-card'))).toBe(false)
    expect(shouldCancel({ step: 1 }, targetWithin(null))).toBe(true)
    expect(shouldCancel(null, targetWithin(null))).toBe(false)
    expect(html).toContain('if (!shouldCancelPendingCardTarget(pendingCardAction, e.target)) return')
  })

  it('battle UI consumes exact candidate arrays and contains no reducer/heuristic target fallback', () => {
    const html = readFileSync(resolve(process.cwd(), 'data/pages/battle.html'), 'utf8')
    const start = html.indexOf('function computeValidSkillTargets')
    const end = html.indexOf('function _updatePendingSkillTargets', start)
    const implementation = html.slice(start, end)
    expect(implementation).toContain('preparation.candidates')
    expect(implementation).not.toContain('GameEngine.applyBattleAction')
    expect(html).not.toContain('_computeValidSkillTargetsHeuristic')
    expect(html).toMatch(/pendingCardAction = null\s+document\.getElementById\('handTarget'\)[\s\S]*?doAction\(action\)/)
    expect(html).toMatch(/_appendTargetToAction\(action, piece, x, y, pendingSkill\.preparation && pendingSkill\.preparation\.targetType\)\s+pendingSkill = null\s+doAction\(action\)/)
    expect(html).toContain("targetType === 'piece' && piece")
  })

  it('rejects unknown runtime commands without advancing the targeting revision', () => {
    const state = makeState({ pieces: [] }) as any
    const before = JSON.stringify(state)
    expect(() => applyBattleAction(state, { type: 'not-a-real-command' } as never)).toThrow(/Unknown battle action/)
    expect(JSON.stringify(state)).toBe(before)
  })

  it('exposes stable selection errors over WS/API and keeps legacy targeting adapters presentation-only', () => {
    const ws = readFileSync(resolve(process.cwd(), 'lib/ws-server.ts'), 'utf8')
    const route = readFileSync(resolve(process.cwd(), 'app/api/rooms/[roomId]/battle/route.ts'), 'utf8')
    expect(ws).toContain('assertActionPlayer(playerId, msg.action)')
    expect(ws).toContain('preparation: errAny?.preparation')
    expect(route).toContain('assertActionPlayer(body.playerId, action)')
    expect(route).toContain('preparation: errAny.preparation')
    const html = readFileSync(resolve(process.cwd(), 'data/pages/battle.html'), 'utf8')
    expect(html).toContain("String(msg.from).toLowerCase() !== String(msg.action.playerId).toLowerCase()")

    for (const path of [
      'data/pages/js/skill-targeting.js',
      'android-client/www/js/skill-targeting.js',
    ]) {
      const adapter = readFileSync(resolve(process.cwd(), path), 'utf8')
      expect(adapter).toContain('preparation.candidates')
      expect(adapter).not.toContain('new Function')
      expect(adapter).not.toContain('executeSkill')
      expect(adapter).not.toContain('applyBattleAction')
    }
  })

  it('enumerates a 20x16 board without executing the reducer once per tile', () => {
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 10, y: 8 })
    caster.skills = [{ skillId: 'large-map-area', currentCooldown: 0, usesRemaining: -1 }] as never
    const state = makeState({ pieces: [caster], width: 20, height: 16 })
    state.skillsById['large-map-area'] = targetedSkill(
      'large-map-area',
      "function executeSkill() { return selectTarget({ type: 'grid', range: 99, filter: 'all' }); }",
    ) as never

    // Reproduce the removed UI loop's unavoidable lower-bound cost: it cloned
    // the full battle once per tile before also invoking the reducer.
    const legacyStarted = performance.now()
    for (let index = 0; index < state.map.tiles.length; index += 1) JSON.parse(JSON.stringify(state))
    const legacyCloneOnlyMs = performance.now() - legacyStarted

    const started = performance.now()
    const prepared = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'caster', skillId: 'large-map-area',
    })
    const elapsedMs = performance.now() - started

    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    expect(prepared.candidates).toHaveLength(320)
    expect(prepared.diagnostics).toMatchObject({ candidatesScanned: 320, reducerExecutions: 0 })
    expect(elapsedMs).toBeGreaterThanOrEqual(0)
    console.info(`[RED-59 performance] legacy-clone-only=${legacyCloneOnlyMs.toFixed(2)}ms authoritative-query=${elapsedMs.toFixed(2)}ms candidates=320 reducerExecutions=0`)
  })
})
