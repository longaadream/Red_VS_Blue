import { describe, expect, it } from 'vitest'

import { previewBattleAction } from '@/lib/game/skill-preview'
import { RuleRuntime, withRuleRuntime, createRuleExecutionContext, withRuleExecutionContext,
  getActiveRuleExecutionContext, getActiveRuleRuntime } from '@/lib/game/rule-runtime'
import { TriggerSystem } from '@/lib/game/triggers'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

function moveState(): BattleState {
  const mover = asPieceInstance(makePiece({
    instanceId: 'mover',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: 0,
    y: 0,
    moveRange: 4,
  }))
  const opponent = asPieceInstance(makePiece({
    instanceId: 'opponent',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 4,
    y: 2,
  }))
  const state = makeState({ pieces: [mover, opponent], width: 5, height: 3 })
  state.pieces = [mover, opponent]
  state.players.find(player => player.playerId === 'player-red')!.actionPoints = 2
  return state
}

function moveAction(path: Array<{ x: number; y: number }>): BattleAction {
  const destination = path[path.length - 1]
  return {
    type: 'move',
    playerId: 'player-red',
    pieceId: 'mover',
    toX: destination.x,
    toY: destination.y,
    path,
  }
}

function withoutDuration<T>(value: T): T {
  const copy = structuredClone(value) as T & { durationMs?: number }
  delete copy.durationMs
  return copy
}

describe('isolated public ordinary move preview', () => {
  it('does not claim a complete result when a visible move reaction needs a target', () => {
    const state = moveState()
    const ruleId = 'rule-grimmjow-hunt-after-move'
    state.pieces[1].rules = [{ id: ruleId } as never]
    state.pieces[1].initialDefinition = { rules: [ruleId], statusTags: [] } as never
    const result = previewBattleAction(state, moveAction([{ x: 0, y: 1 }, { x: 1, y: 1 }]), 'player-red')
    expect(result.status).toBe('needs-input')
  })
  it('restores active context/cache identity and runtime on success and rejected paths', () => {
    const state = moveState()
    const context = createRuleExecutionContext(new TriggerSystem())
    const runtime = new RuleRuntime({ rootSeed: 240, tick: 5 })
    const cache = context.cache
    const sentinel = Symbol('authority-cache')
    cache.set(sentinel, { authority: true })
    withRuleExecutionContext(context, () => withRuleRuntime(runtime, () => {
      expect(previewBattleAction(state, moveAction([{ x: 0, y: 1 }]), 'player-red').status).toBe('ready')
      expect(previewBattleAction(state, moveAction([{ x: 3, y: 1 }]), 'player-red').status).toBe('unavailable')
      expect(getActiveRuleExecutionContext()).toBe(context)
      expect(getActiveRuleRuntime()).toBe(runtime)
      expect(context.cache).toBe(cache)
      expect([...context.cache.entries()]).toEqual([[sentinel, { authority: true }]])
    }))
  })
  it('previews the actual chosen path through visible Amaterasu cells', () => {
    const state = moveState()
    state.players[0].rules = [{ id: 'rule-sasuke-amaterasu-move' } as never]
    state.extensions = { amaterasuOwnerPlayerId: 'player-red',
      amaterasuCells: [{ x: 0, y: 1 }, { x: 1, y: 0 }],
      tileEffects: [{ x: 0, y: 1, tileType: 'amaterasu' }, { x: 1, y: 0, tileType: 'amaterasu' }] }
    const before = JSON.stringify(state)
    const result = previewBattleAction(state, moveAction([{ x: 0, y: 1 }, { x: 1, y: 1 }]), 'player-red')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.snapshot.pieces[0].statusTags).toContainEqual(expect.objectContaining({ type: 'amaterasu-burn', stacks: 1 }))
    expect(JSON.stringify(state)).toBe(before)
  })
  it('returns the predicted landing and exact committed route without mutating input', () => {
    const state = moveState()
    const path = [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }]
    const action = moveAction(path)
    const before = JSON.stringify(state)

    const result = previewBattleAction(state, action, 'player-red')

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.snapshot.pieces.find(piece => piece.instanceId === 'mover')).toMatchObject({ x: 2, y: 1 })
    expect(result.snapshot.players.find(player => player.playerId === 'player-red')?.actionPoints).toBe(1)
    expect(result.events.find(event => event.kind === 'move')).toMatchObject({
      presentation: { cue: 'displacement', pathCells: path, endPoint: { x: 2, y: 1 } },
    })
    expect(JSON.stringify(state)).toBe(before)
  })

  it('runs a public after-move rule and returns its visible status effect', () => {
    const state = moveState()
    state.pieces[0].rules = [{ id: 'rule-kenshin-tenken' } as never]
    const result = previewBattleAction(state, moveAction([{ x: 0, y: 1 }, { x: 1, y: 1 }]), 'player-red')

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.snapshot.pieces.find(piece => piece.instanceId === 'mover')?.statusTags)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'damage-multiplier' })]))
    expect(result.events.some(event => event.kind === 'statusAdded' && event.targetPieceIds?.includes('mover'))).toBe(true)
  })

  it('keeps the move result independent of hidden opponent status and inventory data', () => {
    const first = moveState()
    first.players.find(player => player.playerId === 'player-blue')!.hand = [
      { cardId: 'secret-a', instanceId: 'secret-a', ownerPlayerId: 'player-blue' },
    ] as never
    ;(first.players.find(player => player.playerId === 'player-blue') as BattleState['players'][number] & { deck: unknown[] }).deck = [
      { cardId: 'deck-a', instanceId: 'deck-a' },
    ]
    const second = structuredClone(first)
    second.pieces.find(piece => piece.instanceId === 'opponent')!.statusTags = [{
      id: 'hidden', type: 'hidden-passive', visible: false,
    }]
    second.players.find(player => player.playerId === 'player-blue')!.hand = [
      { cardId: 'other-secret', instanceId: 'other-secret', ownerPlayerId: 'player-blue' },
    ] as never
    ;(second.players.find(player => player.playerId === 'player-blue') as BattleState['players'][number] & { deck: unknown[] }).deck = [
      { cardId: 'other-deck', instanceId: 'other-deck' },
    ]

    const firstResult = previewBattleAction(first, moveAction([{ x: 0, y: 1 }, { x: 1, y: 1 }]), 'player-red')
    const secondResult = previewBattleAction(second, moveAction([{ x: 0, y: 1 }, { x: 1, y: 1 }]), 'player-red')

    expect(withoutDuration(secondResult)).toEqual(withoutDuration(firstResult))
    if (firstResult.status === 'ready') {
      expect(firstResult.snapshot.players.find(player => player.playerId === 'player-blue')).not.toHaveProperty('deck')
      expect(firstResult.snapshot.players.find(player => player.playerId === 'player-blue')?.hand).toEqual([
        { cardId: 'hidden', instanceId: 'hidden-card-0', ownerPlayerId: 'player-blue' },
      ])
    }
  })

  it('ignores hidden tile effects when previewing an otherwise valid route', () => {
    const first = moveState()
    const second = structuredClone(first)
    second.extensions = {
      tileEffects: [{ id: 'private-effect', type: 'hidden-trap', x: 1, y: 1, blocksLanding: true, visible: false }],
    }
    const path = [{ x: 0, y: 1 }, { x: 1, y: 1 }]

    const firstResult = previewBattleAction(first, moveAction(path), 'player-red')
    const secondResult = previewBattleAction(second, moveAction(path), 'player-red')

    expect(withoutDuration(secondResult)).toEqual(withoutDuration(firstResult))
    expect(secondResult.status).toBe('ready')
  })

  it('restores the caller runtime after an isolated move preview', () => {
    const state = moveState()
    const action = moveAction([{ x: 0, y: 1 }, { x: 1, y: 1 }])
    const runtime = new RuleRuntime({ rootSeed: 224, tick: 3, cursors: { 'skill/effect': 7 } })
    const before = runtime.snapshot()

    withRuleRuntime(runtime, () => previewBattleAction(state, action, 'player-red'))

    expect(runtime.snapshot()).toEqual(before)
  })
})
