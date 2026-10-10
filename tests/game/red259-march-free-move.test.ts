/* eslint-disable @typescript-eslint/no-explicit-any -- dynamic card and pending target payloads. */
import { beforeEach, describe, expect, it } from 'vitest'

import { applyBattleAction } from '@/lib/game/turn'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { dropChargeCrystal } from '@/lib/game/charge-crystals'
import { loadRuleById } from '@/lib/game/skills'
import { makePiece, makeState } from '../helpers/minimal-state'

beforeEach(() => globalTriggerSystem.clearRules())

function marchRule() {
  return loadRuleById('rule-turalyon-lightforged-march', true)!
}

function selectPiece(state: any, pieceId: string) {
  return applyBattleAction(state, {
    type: 'pendingTargetSelect',
    playerId: 'player-red',
    targetPieceId: pieceId,
    selectionId: state.pendingTargetSelection.selectionId,
    stateRevision: state.pendingTargetSelection.stateRevision,
  } as any) as any
}

function selectCell(state: any, x: number, y: number) {
  return applyBattleAction(state, {
    type: 'pendingTargetSelect',
    playerId: 'player-red',
    targetX: x,
    targetY: y,
    selectionId: state.pendingTargetSelection.selectionId,
    stateRevision: state.pendingTargetSelection.stateRevision,
  } as any) as any
}

describe('RED-259 Turalyon Lightforged March', () => {
  it('triggers once for each consecutive ordinary holy card and follows a corner route', () => {
    const turalyon = makePiece({
      instanceId: 'red259-turalyon', templateId: 'turalyon', ownerPlayerId: 'player-red', x: 0, y: 0,
      rules: [marchRule()],
    }) as any
    const mover = makePiece({
      instanceId: 'red259-mover', ownerPlayerId: 'player-red', x: 1, y: 1, moveRange: 3,
    }) as any
    const state = makeState({ pieces: [turalyon, mover], width: 8, height: 8, turnNumber: 1 }) as any
    state.players[0].actionPoints = 4
    state.players[0].hand = [1, 2].map(index => ({
      cardId: 'holy-charge', instanceId: `red259-card-${index}`, ownerPlayerId: 'player-red', actionPointCost: 2,
    }))

    const firstPending = applyBattleAction(state, {
      type: 'playCard', playerId: 'player-red', cardInstanceId: 'red259-card-1',
    } as any) as any
    expect(firstPending.pendingTargetSelection).toMatchObject({
      targetType: 'piece',
      candidates: expect.arrayContaining([{ type: 'piece', pieceId: mover.instanceId }]),
    })
    const firstDestination = selectPiece(firstPending, mover.instanceId)
    expect(firstDestination.pendingTargetSelection).toMatchObject({ targetType: 'grid' })
    expect(firstDestination.pendingTargetSelection.candidates).toContainEqual({ type: 'cell', x: 2, y: 2 })

    const firstResolved = selectCell(firstDestination, 2, 2)
    expect(firstResolved.pendingTargetSelection).toBeUndefined()
    expect(firstResolved.pieces.find((piece: any) => piece.instanceId === mover.instanceId))
      .toMatchObject({ x: 2, y: 2, hasMoved: false })
    expect(firstResolved.players[0].actionPoints).toBe(2)
    expect(firstResolved.actions.filter((action: any) => action.type === 'move')).toHaveLength(1)
    expect(firstResolved.actions.find((action: any) => action.type === 'move')?.payload).toMatchObject({ freeMove: true })

    const secondPending = applyBattleAction(firstResolved, {
      type: 'playCard', playerId: 'player-red', cardInstanceId: 'red259-card-2',
    } as any) as any
    expect(secondPending.pendingTargetSelection).toMatchObject({
      targetType: 'piece',
      candidates: expect.arrayContaining([{ type: 'piece', pieceId: mover.instanceId }]),
    })
    const secondDestination = selectPiece(secondPending, mover.instanceId)
    expect(secondDestination.pendingTargetSelection.candidates).toContainEqual({ type: 'cell', x: 3, y: 3 })

    const secondResolved = selectCell(secondDestination, 3, 3)
    expect(secondResolved.pendingTargetSelection).toBeUndefined()
    expect(secondResolved.pieces.find((piece: any) => piece.instanceId === mover.instanceId))
      .toMatchObject({ x: 3, y: 3, hasMoved: false })
    expect(secondResolved.players[0].actionPoints).toBe(0)
    expect(secondResolved.players[0].discardPile).toEqual(['holy-charge', 'holy-charge'])
    expect(secondResolved.actions.filter((action: any) => action.type === 'playCard')).toHaveLength(2)
    expect(secondResolved.actions.filter((action: any) => action.type === 'move')).toHaveLength(2)
    expect(secondResolved.extensions?.turalyonLightforgedTurns).toBeUndefined()
  })

  it('resolves the holy card once on march cancellation and lets the next card trigger', () => {
    const turalyon = makePiece({
      instanceId: 'red259-cancel-turalyon', templateId: 'turalyon', ownerPlayerId: 'player-red', x: 0, y: 0,
      rules: [marchRule()],
    }) as any
    const mover = makePiece({ instanceId: 'red259-cancel-mover', ownerPlayerId: 'player-red', x: 1, y: 1 }) as any
    const state = makeState({ pieces: [turalyon, mover], width: 6, height: 6 }) as any
    state.players[0].actionPoints = 4
    state.players[0].hand = [1, 2].map(index => ({
      cardId: 'holy-charge', instanceId: `red259-cancel-card-${index}`, ownerPlayerId: 'player-red', actionPointCost: 2,
    }))

    const pending = applyBattleAction(state, {
      type: 'playCard', playerId: 'player-red', cardInstanceId: 'red259-cancel-card-1',
    } as any) as any
    const cancelled = applyBattleAction(pending, {
      type: 'cancelPendingSelection', playerId: 'player-red',
      selectionId: pending.pendingTargetSelection.selectionId,
      stateRevision: pending.pendingTargetSelection.stateRevision,
    } as any) as any
    expect(cancelled.pendingTargetSelection).toBeUndefined()
    expect(cancelled.players[0]).toMatchObject({ actionPoints: 2, hand: [{ instanceId: 'red259-cancel-card-2' }] })
    expect(cancelled.players[0].discardPile).toEqual(['holy-charge'])
    expect(cancelled.pieces.find((piece: any) => piece.instanceId === mover.instanceId).statusTags)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'damage-buff' })]))
    expect(cancelled.extensions?.turalyonLightforgedTurns).toBeUndefined()

    const nextPending = applyBattleAction(cancelled, {
      type: 'playCard', playerId: 'player-red', cardInstanceId: 'red259-cancel-card-2',
    } as any) as any
    expect(nextPending.pendingTargetSelection).toMatchObject({ targetType: 'piece' })
  })

  it.each([
    ['holy-smite', 'piece'],
    ['holy-smite', 'cell'],
    ['holy-heal', 'piece'],
    ['holy-heal', 'cell'],
  ] as const)('settles %s once when march is cancelled at the %s stage', (cardId, stage) => {
    const turalyon = makePiece({
      instanceId: `red259-${cardId}-${stage}-turalyon`, templateId: 'turalyon', ownerPlayerId: 'player-red', x: 0, y: 0,
      currentHp: 30, maxHp: 30, rules: [marchRule()],
    }) as any
    const mover = makePiece({
      instanceId: `red259-${cardId}-${stage}-mover`, ownerPlayerId: 'player-red', x: 1, y: 1, moveRange: 3,
      currentHp: cardId === 'holy-heal' ? 2 : 10, maxHp: cardId === 'holy-heal' ? 100 : 10,
    }) as any
    const enemy = makePiece({
      instanceId: `red259-${cardId}-${stage}-enemy`, ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 4,
      currentHp: 50, maxHp: 100,
    }) as any
    const state = makeState({ pieces: [turalyon, mover, enemy], width: 6, height: 6 }) as any
    state.players[0].actionPoints = 2
    state.players[0].hand = [{ cardId, instanceId: `red259-${cardId}-${stage}-card`, ownerPlayerId: 'player-red', actionPointCost: 2 }]

    const pending = applyBattleAction(state, {
      type: 'playCard', playerId: 'player-red', cardInstanceId: state.players[0].hand[0].instanceId,
    } as any) as any
    const afterPiece = stage === 'cell' ? selectPiece(pending, mover.instanceId) : pending
    const cancelled = applyBattleAction(afterPiece, {
      type: 'cancelPendingSelection', playerId: 'player-red',
      selectionId: afterPiece.pendingTargetSelection.selectionId,
      stateRevision: afterPiece.pendingTargetSelection.stateRevision,
    } as any) as any

    expect(cancelled.pendingTargetSelection).toBeUndefined()
    expect(cancelled.players[0]).toMatchObject({ actionPoints: 0, hand: [], discardPile: [cardId] })
    expect(cancelled.actions.filter((action: any) => action.type === 'playCard')).toHaveLength(1)
    expect(cancelled.actions.filter((action: any) => action.type === 'move')).toHaveLength(0)
    expect(cancelled.pieces.find((piece: any) => piece.instanceId === mover.instanceId))
      .toMatchObject({ x: 1, y: 1, currentHp: 10 })
    expect(cancelled.pieces.find((piece: any) => piece.instanceId === enemy.instanceId)?.currentHp)
      .toBe(cardId === 'holy-smite' ? 45 : 50)
  })

  it('rejects wrong-player, stale, and non-candidate pending inputs without mutation', () => {
    const turalyon = makePiece({
      instanceId: 'red259-pending-turalyon', templateId: 'turalyon', ownerPlayerId: 'player-red', x: 0, y: 0,
      rules: [marchRule()],
    }) as any
    const mover = makePiece({ instanceId: 'red259-pending-mover', ownerPlayerId: 'player-red', x: 1, y: 1 }) as any
    const state = makeState({ pieces: [turalyon, mover], width: 6, height: 6 }) as any
    state.players[0].actionPoints = 2
    state.players[0].hand = [{ cardId: 'holy-charge', instanceId: 'red259-pending-card', ownerPlayerId: 'player-red', actionPointCost: 2 }]

    const pending = applyBattleAction(state, {
      type: 'playCard', playerId: 'player-red', cardInstanceId: 'red259-pending-card',
    } as any) as any
    const pendingBeforeInvalid = JSON.stringify(pending)
    expect(() => applyBattleAction(pending, {
      type: 'pendingTargetSelect', playerId: 'player-blue', targetPieceId: mover.instanceId,
      selectionId: pending.pendingTargetSelection.selectionId,
      stateRevision: pending.pendingTargetSelection.stateRevision,
    } as any)).toThrow(/player|selection|pending/i)
    expect(JSON.stringify(pending)).toBe(pendingBeforeInvalid)

    expect(() => applyBattleAction(pending, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetPieceId: 'not-a-candidate',
      selectionId: pending.pendingTargetSelection.selectionId,
      stateRevision: pending.pendingTargetSelection.stateRevision,
    } as any)).toThrow(/candidate|target|selection/i)
    expect(JSON.stringify(pending)).toBe(pendingBeforeInvalid)

    const destinationPending = selectPiece(pending, mover.instanceId)
    const destinationBeforeInvalid = JSON.stringify(destinationPending)
    expect(() => applyBattleAction(destinationPending, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetX: 2, targetY: 2,
      selectionId: pending.pendingTargetSelection.selectionId,
      stateRevision: pending.pendingTargetSelection.stateRevision,
    } as any)).toThrow(/selection|state|pending/i)
    expect(JSON.stringify(destinationPending)).toBe(destinationBeforeInvalid)
  })

  it('skips march when no allied normal-move destination exists while settling the card', () => {
    const turalyon = makePiece({
      instanceId: 'red259-skip-turalyon', templateId: 'turalyon', ownerPlayerId: 'player-red', x: 0, y: 0,
      moveRange: 0,
      rules: [marchRule()],
    }) as any
    const mover = makePiece({
      instanceId: 'red259-rooted-mover', ownerPlayerId: 'player-red', x: 1, y: 1, moveRange: 3,
      statusTags: [{ id: 'red259-root', type: 'root' }],
    }) as any
    const state = makeState({ pieces: [turalyon, mover], width: 4, height: 4 }) as any
    state.players[0].actionPoints = 2
    state.players[0].hand = [{ cardId: 'holy-charge', instanceId: 'red259-skip-card', ownerPlayerId: 'player-red', actionPointCost: 2 }]

    const resolved = applyBattleAction(state, {
      type: 'playCard', playerId: 'player-red', cardInstanceId: 'red259-skip-card',
    } as any) as any
    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolved.players[0]).toMatchObject({ actionPoints: 0, hand: [], discardPile: ['holy-charge'] })
    expect(resolved.pieces.find((piece: any) => piece.instanceId === mover.instanceId)).toMatchObject({ x: 1, y: 1 })
    expect(resolved.actions.filter((action: any) => action.type === 'move')).toHaveLength(0)
  })

  it('keeps free-move blocking and card settlement intact', () => {
    const turalyon = makePiece({
      instanceId: 'red259-contact-turalyon', templateId: 'turalyon', ownerPlayerId: 'player-red', x: 0, y: 0,
      rules: [marchRule()],
    }) as any
    const mover = makePiece({
      instanceId: 'red259-contact-mover', ownerPlayerId: 'player-red', x: 1, y: 1, moveRange: 3,
    }) as any
    globalTriggerSystem.addRule({
      id: 'red259-block-before-move', name: 'RED259 block', description: '', trigger: { type: 'beforeMove' },
      effect: (_battle: any, context: any) => context.sourcePiece?.instanceId === mover.instanceId
        ? { success: true, blocked: true, message: 'blocked' }
        : { success: true, message: '' },
    } as any)
    const state = makeState({ pieces: [turalyon, mover], width: 6, height: 6 }) as any
    dropChargeCrystal(state, { id: 'red259-crystal-a', sourcePieceId: 'dead', x: 2, y: 1 })
    dropChargeCrystal(state, { id: 'red259-crystal-b', sourcePieceId: 'dead', x: 2, y: 2 })
    state.players[0].actionPoints = 2
    state.players[0].hand = [{ cardId: 'holy-charge', instanceId: 'red259-blocked-card', ownerPlayerId: 'player-red', actionPointCost: 2 }]

    const pending = applyBattleAction(state, {
      type: 'playCard', playerId: 'player-red', cardInstanceId: 'red259-blocked-card',
    } as any) as any
    const destinationPending = selectPiece(pending, mover.instanceId)
    expect(destinationPending.pendingTargetSelection.candidates).toContainEqual({ type: 'cell', x: 2, y: 2 })
    const resolved = selectCell(destinationPending, 2, 2)

    expect(resolved.pieces.find((piece: any) => piece.instanceId === mover.instanceId)).toMatchObject({ x: 1, y: 1 })
    expect(resolved.players[0]).toMatchObject({ actionPoints: 0, chargePoints: 0, hand: [], discardPile: ['holy-charge'] })
    expect(resolved.actions.filter((action: any) => action.type === 'move')).toHaveLength(0)
    expect(resolved.actions.filter((action: any) => action.type === 'playCard')).toHaveLength(1)
  })

  it('retains ordinary after-move paths and crystal contacts during march', () => {
    globalTriggerSystem.addRule({
      id: 'red259-record-after-move-path', name: 'RED259 path recorder', description: '', trigger: { type: 'afterMove' },
      effect: (battle: any, context: any) => {
        battle.extensions!.red259AfterMovePath = context.pathCells
        return { success: true, message: '' }
      },
    } as any)
    const turalyon = makePiece({
      instanceId: 'red259-path-turalyon', templateId: 'turalyon', ownerPlayerId: 'player-red', x: 0, y: 0,
      rules: [marchRule()],
    }) as any
    const mover = makePiece({
      instanceId: 'red259-path-mover', ownerPlayerId: 'player-red', x: 1, y: 1, moveRange: 3,
    }) as any
    const state = makeState({ pieces: [turalyon, mover], width: 6, height: 6 }) as any
    dropChargeCrystal(state, { id: 'red259-path-crystal-a', sourcePieceId: 'dead', x: 2, y: 1 })
    dropChargeCrystal(state, { id: 'red259-path-crystal-b', sourcePieceId: 'dead', x: 2, y: 2 })
    state.players[0].actionPoints = 2
    state.players[0].hand = [{ cardId: 'holy-charge', instanceId: 'red259-path-card', ownerPlayerId: 'player-red', actionPointCost: 2 }]

    const pending = applyBattleAction(state, {
      type: 'playCard', playerId: 'player-red', cardInstanceId: 'red259-path-card',
    } as any) as any
    const destinationPending = selectPiece(pending, mover.instanceId)
    expect(destinationPending.pendingTargetSelection.candidates).toContainEqual({ type: 'cell', x: 2, y: 2 })
    const resolved = selectCell(destinationPending, 2, 2)

    expect(resolved.pieces.find((piece: any) => piece.instanceId === mover.instanceId)).toMatchObject({ x: 2, y: 2 })
    expect(resolved.players[0].chargePoints).toBe(2)
    expect(resolved.extensions!.tileEffects).toEqual([])
    expect(resolved.extensions!.red259AfterMovePath).toEqual([{ x: 2, y: 1 }, { x: 2, y: 2 }])
    expect(resolved.actions.find((action: any) => action.type === 'positionChanged')?.payload).toMatchObject({
      movementKind: 'walk', path: [{ x: 2, y: 1 }, { x: 2, y: 2 }],
    })
    expect(resolved.actions.filter((action: any) => action.type === 'chargeCrystalPickedUp')).toHaveLength(1)
  })
})
