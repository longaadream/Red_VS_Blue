import { describe, expect, it } from 'vitest'

import { hashStable, replayBattle, runBattleAction } from '@/lib/game/battle-runner'
import { createDebugDuel } from '@/lib/game/debug-battle'
import { makePiece, makeState } from '../helpers/minimal-state'

describe('debug battle pipeline', () => {
  it('creates a local duel with eight pieces per player', async () => {
    const duel = await createDebugDuel({ seed: 1234, beginPhase: false })

    expect(duel.state.players).toHaveLength(2)
    expect(duel.players[0].templateIds).toHaveLength(8)
    expect(duel.players[1].templateIds).toHaveLength(8)
    expect(duel.state.pieces.some(piece => piece.ownerPlayerId === 'debug-red')).toBe(true)
    expect(duel.state.pieces.some(piece => piece.ownerPlayerId === 'debug-blue')).toBe(true)
    expect((duel.state.extensions as any).debugBattle.actionLog[0]).toMatchObject({
      actionId: 'system-initialize',
      rootSeed: 1234,
      preStateHash: expect.any(String),
      postStateHash: expect.any(String),
      randomStreams: expect.arrayContaining([
        expect.objectContaining({ name: 'deployment', startCursor: 0 }),
      ]),
    })
  })

  it('allows light/light and dark/dark mirror debug duels', async () => {
    const lightMirror = await createDebugDuel({
      seed: 1,
      first: { alignment: 'light' },
      second: { alignment: 'light' },
    })
    const darkMirror = await createDebugDuel({
      seed: 2,
      first: { alignment: 'dark' },
      second: { alignment: 'dark' },
    })

    expect(lightMirror.players.map(player => player.alignment)).toEqual(['light', 'light'])
    expect(darkMirror.players.map(player => player.alignment)).toEqual(['dark', 'dark'])
  })

  it('keeps content alignment and ownership stable when seats are swapped', async () => {
    const duel = await createDebugDuel({
      seed: 3,
      beginPhase: false,
      first: { playerId: 'alice', seat: 'blue', alignment: 'light' },
      second: { playerId: 'bob', seat: 'red', alignment: 'light' },
    })

    expect(duel.players).toMatchObject([
      { playerId: 'alice', seat: 'blue', alignment: 'light' },
      { playerId: 'bob', seat: 'red', alignment: 'light' },
    ])
    expect(duel.state.pieces.every(piece => piece.ownerPlayerId === 'alice' || piece.ownerPlayerId === 'bob')).toBe(true)
  })

  it('replays scripted actions through the same battle runner', async () => {
    const duel = await createDebugDuel({ seed: 99, beginPhase: false })
    const action = { type: 'beginPhase' as const }
    const once = runBattleAction(duel.state, action)
    const replay = replayBattle({ initialState: duel.state, actions: [action], seed: 99 })

    expect(replay.actionsApplied).toBe(1)
    expect(replay.actionHashes).toEqual([once.actionHash])
    expect(replay.finalStateHash).toBe(once.stateHash)
  })

  it('does not run an opponent piece begin-turn passive on the active player', async () => {
    const duel = await createDebugDuel({
      seed: 2026,
      beginPhase: false,
      first: { alignment: 'dark', templateIds: ['kiljaedan'] },
      second: { alignment: 'light', templateIds: ['blue-watcher'] },
    })

    const result = runBattleAction(duel.state, { type: 'beginPhase' })

    expect(result.state.turn.currentPlayerId).toBe('debug-red')
    expect((result.state as any).pendingOptionSelection).toBeUndefined()
    expect(result.state.actions?.some(action =>
      action.type === 'triggerEffect' &&
      action.playerId === 'debug-red' &&
      JSON.stringify(action.payload).includes('Watcher')
    )).toBe(false)
  })

  it('runs the watcher begin-turn passive only on its owner turn', async () => {
    const duel = await createDebugDuel({
      seed: 2027,
      beginPhase: false,
      first: { alignment: 'dark', templateIds: ['kiljaedan'] },
      second: { alignment: 'light', templateIds: ['blue-watcher'] },
    })

    let state = runBattleAction(duel.state, { type: 'beginPhase' }).state
    expect(state.pendingOptionSelection).toBeUndefined()

    state = runBattleAction(state, { type: 'endTurn', playerId: 'debug-red' } as any).state
    state = runBattleAction(state, { type: 'beginPhase' }).state

    expect(state.turn.currentPlayerId).toBe('debug-blue')
    expect(state.pendingOptionSelection?.playerId).toBe('debug-blue')
    expect(state.pendingOptionSelection?.options.map((option: any) => option.id)).toEqual(['calm', 'rage'])
  })

  it('gives lucky coin to the explicit second player', async () => {
    const duel = await createDebugDuel({
      seed: 2028,
      beginPhase: false,
      first: { alignment: 'dark', templateIds: ['kiljaedan'] },
      second: { alignment: 'light', templateIds: ['blue-watcher'] },
    })

    const red = duel.state.players.find(player => player.playerId === 'debug-red')
    const blue = duel.state.players.find(player => player.playerId === 'debug-blue')

    expect(duel.state.turn.currentPlayerId).toBe('debug-red')
    expect(red?.hand.some(card => card.cardId === 'lucky-coin')).toBe(false)
    expect(blue?.hand.some(card => card.cardId === 'lucky-coin')).toBe(true)
  })

  it('treats repeated client action ids as idempotent duplicates', async () => {
    const duel = await createDebugDuel({ seed: 77, beginPhase: false })
    const action = { type: 'beginPhase' as const, clientActionId: 'debug-action-1' } as any

    const first = runBattleAction(duel.state, action)
    const duplicate = runBattleAction(first.state, action)

    expect(duplicate.duplicate).toBe(true)
    expect(duplicate.stateHash).toBe(first.stateHash)
    expect((duplicate.state.extensions as any).debugBattle.appliedActionIds).toContain('debug-action-1')
  })

  it('rejects an illegal move without mutating authoritative state or action trace', () => {
    const mover = makePiece({ instanceId: 'mover', ownerPlayerId: 'player-red', x: 0, y: 0, moveRange: 3 })
    const blocker = makePiece({ instanceId: 'blocker', ownerPlayerId: 'player-blue', x: 1, y: 0 })
    const state = makeState({ pieces: [mover, blocker], currentPlayerId: 'player-red', phase: 'action' })
    delete state.extensions
    Reflect.deleteProperty(state.pieces[0], 'rules')
    Reflect.deleteProperty(state.players[0], 'rules')

    const beforeJson = JSON.stringify(state)
    const beforeHash = hashStable(state)
    const beforeActionPoints = state.players[0].actionPoints
    const beforeActions = [...(state.actions ?? [])]

    const illegalMove = {
      type: 'move',
      playerId: 'player-red',
      pieceId: 'mover',
      toX: 2,
      toY: 0,
      clientActionId: 'illegal-move-1',
    } as Parameters<typeof runBattleAction>[1] & { clientActionId: string }
    expect(() => runBattleAction(state, illegalMove)).toThrow(/blocked|occupied/i)

    expect(hashStable(state)).toBe(beforeHash)
    expect(JSON.stringify(state)).toBe(beforeJson)
    expect(state.players[0].actionPoints).toBe(beforeActionPoints)
    expect(state.actions).toEqual(beforeActions)
    expect(state.extensions).toBeUndefined()
  })
})
