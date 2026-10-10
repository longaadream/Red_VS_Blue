/* eslint-disable @typescript-eslint/no-explicit-any -- RED-258 fixtures exercise JSON-authored rules and card code. */
import { afterEach, describe, expect, it } from 'vitest'
import { loadRuleById } from '@/lib/game/skills'
import { replayBattle, runBattleAction } from '@/lib/game/battle-runner'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

function rule(id: string) {
  const loaded = loadRuleById(id, true)
  if (!loaded) throw new Error(`Missing ${id}`)
  return loaded
}

function fixture(
  order: 'colt-first' | 'minato-first' = 'colt-first',
  options: { includeColt?: boolean; includeZone?: boolean } = {},
) {
  const includeColt = options.includeColt !== false
  const includeZone = options.includeZone !== false
  const colt = makePiece({
    instanceId: 'colt', templateId: 'colt', ownerPlayerId: 'player-blue', faction: 'blue',
    x: 1, y: 1, moveRange: 5, attack: 6,
    rules: [rule('rule-colt-big-stride'), ...(includeZone ? [rule('rule-colt-zone-endturn')] : [])],
  })
  const minato = makePiece({
    instanceId: 'minato', templateId: 'blue-minato', ownerPlayerId: 'player-red', faction: 'red',
    x: 1, y: 3, rules: [rule('rule-minato-anchor-end-turn')],
  })
  const target = makePiece({ instanceId: 'target', ownerPlayerId: 'player-red', x: 7, y: 6, currentHp: 20 })
  const pieces = order === 'colt-first' ? [colt, minato, target] : [minato, colt, target]
  const state = makeState({ pieces, currentPlayerId: 'player-red', width: 9, height: 7 }) as any
  if (includeZone) state.extensions!.coltZones = { colt: { sourceId: 'colt', kind: 'revolver', dx: 1, dy: 0, turns: 1 } }
  if (!includeColt) state.pieces = [minato, target]
  return state
}

function select(state: any, targetX: number, targetY: number) {
  const pending = state.pendingTargetSelection
  if (!pending) throw new Error('Expected pending target selection')
  return runBattleAction(state, {
    type: 'pendingTargetSelect', playerId: pending.playerId,
    targetX, targetY, selectionId: pending.selectionId, stateRevision: pending.stateRevision,
  }, { rootSeed: 258 }).state
}

describe('RED-258 end-turn choice isolation', () => {
  it('keeps Minato pending after Colt completes its movement choice', () => {
    const pending = runBattleAction(fixture(), { type: 'endTurn', playerId: 'player-red' }, { rootSeed: 258 }).state
    expect(pending.pendingTargetSelection?.source).toMatchObject({ id: 'rule-colt-big-stride', pieceId: 'colt' })
    expect(pending.pendingTargetSelection?.playerId).toBe('player-blue')

    const afterColt = select(pending, 6, 1)
    expect(afterColt.pendingTargetSelection?.source).toMatchObject({ id: 'rule-minato-anchor-end-turn', pieceId: 'minato' })
    expect(afterColt.pendingTargetSelection?.playerId).toBe('player-red')
    expect(afterColt.extensions?.minatoAnchors || []).toEqual([])
  })

  it('keeps Minato pending after Colt movement is cancelled', () => {
    const pending = runBattleAction(fixture(), { type: 'endTurn', playerId: 'player-red' }, { rootSeed: 258 }).state
    const selection = pending.pendingTargetSelection!
    expect(selection.playerId).toBe('player-blue')
    const afterColt = runBattleAction(pending, {
      type: 'cancelPendingSelection', playerId: selection.playerId,
      selectionId: selection.selectionId, stateRevision: selection.stateRevision,
    }, { rootSeed: 258 }).state
    expect(afterColt.pendingTargetSelection?.source).toMatchObject({ id: 'rule-minato-anchor-end-turn', pieceId: 'minato' })
    expect(afterColt.pendingTargetSelection?.playerId).toBe('player-red')
    expect(afterColt.extensions?.minatoAnchors || []).toEqual([])
    const completed = select(afterColt, 6, 1)
    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(completed.extensions?.minatoAnchors).toContainEqual(expect.objectContaining({ sourceId: 'minato', x: 6, y: 1 }))
  })

  it('keeps Colt pending after Minato cancels its anchor choice', () => {
    const pending = runBattleAction(fixture('minato-first'), { type: 'endTurn', playerId: 'player-red' }, { rootSeed: 258 }).state
    const selection = pending.pendingTargetSelection!
    expect(selection.playerId).toBe('player-red')
    const afterMinato = runBattleAction(pending, {
      type: 'cancelPendingSelection', playerId: selection.playerId,
      selectionId: selection.selectionId, stateRevision: selection.stateRevision,
    }, { rootSeed: 258 }).state
    expect(afterMinato.pendingTargetSelection?.source).toMatchObject({ id: 'rule-colt-big-stride', pieceId: 'colt' })
    expect(afterMinato.pendingTargetSelection?.playerId).toBe('player-blue')
    const completed = select(afterMinato, 6, 1)
    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(completed.extensions?.minatoAnchors || []).toEqual([])
  })

  it('keeps Colt pending after Minato completes its anchor choice', () => {
    const pending = runBattleAction(fixture('minato-first'), { type: 'endTurn', playerId: 'player-red' }, { rootSeed: 258 }).state
    expect(pending.pendingTargetSelection?.source).toMatchObject({ id: 'rule-minato-anchor-end-turn', pieceId: 'minato' })
    expect(pending.pendingTargetSelection?.playerId).toBe('player-red')

    const afterMinato = select(pending, 6, 1)
    expect(afterMinato.pendingTargetSelection?.source).toMatchObject({ id: 'rule-colt-big-stride', pieceId: 'colt' })
    expect(afterMinato.pendingTargetSelection?.playerId).toBe('player-blue')
    expect(afterMinato.extensions?.minatoAnchors || []).toEqual([])
    const completed = select(afterMinato, 6, 1)
    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(completed.extensions?.minatoAnchors).toContainEqual(expect.objectContaining({ sourceId: 'minato', x: 6, y: 1 }))
  })

  it('still opens Minato only when its owner ends the turn, including without Colt', () => {
    const noColt = fixture('colt-first', { includeColt: false, includeZone: false })
    const pending = runBattleAction(noColt, { type: 'endTurn', playerId: 'player-red' }, { rootSeed: 258 }).state
    expect(pending.pendingTargetSelection?.source).toMatchObject({ id: 'rule-minato-anchor-end-turn', pieceId: 'minato' })
    expect(pending.pendingTargetSelection?.playerId).toBe('player-red')

    const opponentTurn = fixture('colt-first', { includeColt: false, includeZone: false })
    opponentTurn.turn.currentPlayerId = 'player-blue'
    const completed = runBattleAction(opponentTurn, { type: 'endTurn', playerId: 'player-blue' }, { rootSeed: 258 }).state
    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(completed.extensions?.minatoAnchors || []).toEqual([])
  })

  it('runs an isolated zone rule before Minato and applies its lethal damage once', () => {
    const state = fixture('colt-first', { includeZone: true })
    const target = state.pieces.find((piece: any) => piece.instanceId === 'target')
    target.currentHp = 6
    target.x = 4
    target.y = 1
    state.pieces[0].rules = [rule('rule-colt-zone-endturn')]
    const pending = runBattleAction(state, { type: 'endTurn', playerId: 'player-red' }, { rootSeed: 258 }).state
    expect(pending.pendingTargetSelection?.source).toMatchObject({ id: 'rule-minato-anchor-end-turn', pieceId: 'minato' })

    const completed = select(pending, 6, 1)
    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(completed.graveyard.filter((piece: any) => piece.instanceId === 'target')).toHaveLength(1)
    expect(completed.pieces.some((piece: any) => piece.instanceId === 'target')).toBe(false)
  })

  it('rejects a stale or occupied anchor input without mutating the pending root', () => {
    const state = fixture('colt-first', { includeColt: false, includeZone: false })
    const pending = runBattleAction(state, { type: 'endTurn', playerId: 'player-red' }, { rootSeed: 258 }).state
    const before = JSON.stringify(pending)
    const session = pending.pendingTargetSelection!
    expect(session.playerId).toBe('player-red')
    expect(() => runBattleAction(pending, {
      type: 'pendingTargetSelect', playerId: 'player-blue', targetX: 2, targetY: 2,
      selectionId: session.selectionId, stateRevision: session.stateRevision,
    }, { rootSeed: 258 })).toThrow(/player|another player|mismatch/i)
    expect(JSON.stringify(pending)).toBe(before)
    expect(() => runBattleAction(pending, {
      type: 'pendingTargetSelect', playerId: session.playerId, targetX: 2, targetY: 2,
      selectionId: `${session.selectionId}-stale`, stateRevision: session.stateRevision,
    }, { rootSeed: 258 })).toThrow(/selection|stale|revision/i)
    expect(JSON.stringify(pending)).toBe(before)
    expect(() => runBattleAction(pending, {
      type: 'pendingTargetSelect', playerId: session.playerId, targetX: 2, targetY: 2,
      selectionId: session.selectionId, stateRevision: session.stateRevision! - 1,
    }, { rootSeed: 258 })).toThrow(/selection|stale|revision/i)
    expect(JSON.stringify(pending)).toBe(before)
    expect(() => runBattleAction(pending, {
      type: 'pendingTargetSelect', playerId: session.playerId, targetX: 1, targetY: 3,
      selectionId: session.selectionId, stateRevision: session.stateRevision,
    }, { rootSeed: 258 })).toThrow(/authoritative candidate|occupied|not found|invalid/i)
    expect(JSON.stringify(pending)).toBe(before)
    expect(() => runBattleAction(pending, {
      type: 'pendingTargetSelect', playerId: session.playerId, targetX: 99, targetY: 99,
      selectionId: session.selectionId, stateRevision: session.stateRevision,
    }, { rootSeed: 258 })).toThrow(/authoritative candidate|out of range|outside the board|not found/i)
    expect(JSON.stringify(pending)).toBe(before)
  })

  it('skips Minato when every legal landing cell is occupied', () => {
    const minato = makePiece({
      instanceId: 'minato', templateId: 'blue-minato', ownerPlayerId: 'player-red', faction: 'red',
      x: 1, y: 1, rules: [rule('rule-minato-anchor-end-turn')],
    })
    const blockers = []
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 3; x += 1) {
        if (x === 1 && y === 1) continue
        blockers.push(makePiece({ instanceId: `blocker-${x}-${y}`, ownerPlayerId: 'player-blue', faction: 'blue', x, y }))
      }
    }
    const state = makeState({
      pieces: [minato, ...blockers], currentPlayerId: 'player-red', width: 3, height: 3,
    }) as any
    const completed = runBattleAction(state, { type: 'endTurn', playerId: 'player-red' }, { rootSeed: 258 }).state
    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(completed.turn.phase).toBe('end')
    expect(completed.extensions?.minatoAnchors || []).toEqual([])
  })

  it('skips Colt when it has no legal movement cell, then offers Minato its own choice', () => {
    const colt = makePiece({
      instanceId: 'colt', templateId: 'colt', ownerPlayerId: 'player-blue', faction: 'blue',
      x: 0, y: 0, moveRange: 5, rules: [rule('rule-colt-big-stride')],
    })
    const minato = makePiece({
      instanceId: 'minato', templateId: 'blue-minato', ownerPlayerId: 'player-red', faction: 'red',
      x: 2, y: 2, rules: [rule('rule-minato-anchor-end-turn')],
    })
    const blockers = []
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        const isOpenLanding = x === 4 && y === 4
        if ((x === 0 && y === 0) || (x === 2 && y === 2) || isOpenLanding) continue
        blockers.push(makePiece({ instanceId: `blocker-${x}-${y}`, ownerPlayerId: 'player-red', faction: 'red', x, y }))
      }
    }
    const state = makeState({
      pieces: [colt, minato, ...blockers], currentPlayerId: 'player-red', width: 5, height: 5,
    }) as any
    const pending = runBattleAction(state, { type: 'endTurn', playerId: 'player-red' }, { rootSeed: 258 }).state
    expect(pending.pendingTargetSelection?.source).toMatchObject({ id: 'rule-minato-anchor-end-turn', pieceId: 'minato' })
    expect(pending.pendingTargetSelection?.playerId).toBe('player-red')
  })

  it('skips dead Colt and still resolves Minato end-turn input', () => {
    const state = fixture('colt-first', { includeZone: true })
    const colt = state.pieces.find((piece: any) => piece.instanceId === 'colt')
    colt.currentHp = 0
    const pending = runBattleAction(state, { type: 'endTurn', playerId: 'player-red' }, { rootSeed: 258 }).state
    expect(pending.pendingTargetSelection?.source).toMatchObject({ id: 'rule-minato-anchor-end-turn', pieceId: 'minato' })
    expect(pending.pendingTargetSelection?.playerId).toBe('player-red')
    const completed = select(pending, 6, 1)
    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(completed.extensions?.minatoAnchors).toContainEqual(expect.objectContaining({ sourceId: 'minato', x: 6, y: 1 }))
  })

  it('replays the full two-choice end-turn chain deterministically for a fixed seed', () => {
    const initial = fixture('colt-first')
    const firstPending = runBattleAction(initial, { type: 'endTurn', playerId: 'player-red' }, { rootSeed: 258 }).state
    const coltSelection = firstPending.pendingTargetSelection!
    const afterColt = select(firstPending, 6, 1)
    const minatoSelection = afterColt.pendingTargetSelection!
    const actions = [
      { type: 'endTurn', playerId: 'player-red' },
      {
        type: 'pendingTargetSelect', playerId: coltSelection.playerId, targetX: 6, targetY: 1,
        selectionId: coltSelection.selectionId, stateRevision: coltSelection.stateRevision,
      },
      {
        type: 'pendingTargetSelect', playerId: minatoSelection.playerId, targetX: 6, targetY: 2,
        selectionId: minatoSelection.selectionId, stateRevision: minatoSelection.stateRevision,
      },
      { type: 'beginPhase' },
    ] as any
    const first = replayBattle({ initialState: fixture('colt-first'), actions, seed: 258 })
    const second = replayBattle({ initialState: fixture('colt-first'), actions, seed: 258 })
    expect(first.stateHashes).toEqual(second.stateHashes)
    expect(first.finalStateHash).toBe(second.finalStateHash)
    expect(first.finalState.pendingTargetSelection).toBeUndefined()
    expect(first.finalState.turn).toMatchObject({ currentPlayerId: 'player-blue', turnNumber: 2, phase: 'action' })
    expect(first.finalState.extensions?.minatoAnchors).toContainEqual(expect.objectContaining({ sourceId: 'minato', x: 6, y: 2 }))
  })
})

afterEach(() => {
  globalTriggerSystem.clearRules()
})

describe('RED-258 consumer input isolation', () => {
  it('does not leak a reactive-card target answer to the next reactive card', () => {
    const state = makeState({ currentPlayerId: 'player-red', phase: 'action', width: 4, height: 4 }) as any
    state.players[0].hand = [
      { cardId: 'red258-target-card', instanceId: 'red258-target-card-1', ownerPlayerId: 'player-red', actionPointCost: 0 },
      { cardId: 'red258-observer-card', instanceId: 'red258-observer-card-1', ownerPlayerId: 'player-red', actionPointCost: 0 },
    ]
    state.customCards = {
      'red258-target-card': {
        id: 'red258-target-card', name: 'target card', description: '', type: 'reactive', trigger: { type: 'endTurn' },
        code: "function executeCard(context) { if (context.targetX === undefined || context.targetY === undefined) return { needsTargetSelection: true, playerId: 'player-red', title: 'Choose a cell', targetType: 'cell', filter: 'all', targetCandidates: [{ type: 'cell', x: 1, y: 1 }], canCancel: false }; context.battle.extensions.red258TargetAnswer = [context.targetX, context.targetY]; return { success: true, keepInHand: true }; }",
      },
      'red258-observer-card': {
        id: 'red258-observer-card', name: 'observer card', description: '', type: 'reactive', trigger: { type: 'endTurn' },
        code: "function executeCard(context) { context.battle.extensions.red258ObserverSawInput = context.targetX !== undefined || context.targetY !== undefined; return { success: true, keepInHand: true }; }",
      },
    }

    const pending = runBattleAction(state, { type: 'endTurn', playerId: 'player-red' }, { rootSeed: 258 }).state
    expect(pending.pendingTargetSelection?.source).toMatchObject({ type: 'card', id: 'red258-target-card' })
    const completed = select(pending, 1, 1)
    expect(completed.extensions?.red258TargetAnswer).toEqual([1, 1])
    expect(completed.extensions?.red258ObserverSawInput).toBe(false)
  })

  it('preserves an explicit retarget made by a rule after its answer is injected', () => {
    globalTriggerSystem.addRules([
      {
        id: 'red258-explicit-retarget', name: 'explicit retarget', description: '', priority: 20,
        trigger: { type: 'beginTurn' },
        effect: (battle: any, context: any) => {
          if (context.targetX === undefined || context.targetY === undefined) {
            return {
              needsTargetSelection: true, playerId: 'player-red', title: 'Choose a cell', targetType: 'cell',
              targetCandidates: [{ type: 'cell', x: 1, y: 1 }], canCancel: false,
            }
          }
          context.targetX += 1
          context.targetY += 1
          battle.extensions.red258ExplicitRetarget = [context.targetX, context.targetY]
          return { success: true }
        },
      },
      {
        id: 'red258-retarget-observer', name: 'retarget observer', description: '', priority: 10,
        trigger: { type: 'beginTurn' },
        effect: (battle: any, context: any) => {
          battle.extensions.red258ObservedRetarget = [context.targetX, context.targetY]
          return { success: true }
        },
      },
    ] as any)

    const state = makeState({ currentPlayerId: 'player-red', phase: 'start', width: 4, height: 4 }) as any
    const pending = runBattleAction(state, { type: 'beginPhase' }, { rootSeed: 258 }).state
    expect(pending.pendingTargetSelection?.source?.id).toBe('red258-explicit-retarget')
    const completed = select(pending, 1, 1)
    expect(completed.extensions?.red258ExplicitRetarget).toEqual([2, 2])
    expect(completed.extensions?.red258ObservedRetarget).toEqual([2, 2])
  })
})
