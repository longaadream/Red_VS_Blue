import { describe, expect, it } from 'vitest'

import { previewBattleAction } from '@/lib/game/skill-preview'
import { RuleRuntime, withRuleRuntime, createRuleExecutionContext, withRuleExecutionContext,
  getActiveRuleExecutionContext, getActiveRuleRuntime } from '@/lib/game/rule-runtime'
import { loadRuleById } from '@/lib/game/skills'
import { TriggerSystem } from '@/lib/game/triggers'
import { applyBattleAction, type BattleAction, type BattleState } from '@/lib/game/turn'
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

function canonicalRule(ruleId: string) {
  const rule = loadRuleById(ruleId, true)
  if (!rule) throw new Error(`missing canonical rule fixture: ${ruleId}`)
  return rule
}

function enemyAmaterasuMoveState(): BattleState {
  const state = moveState()
  state.players[1].rules = [canonicalRule('rule-sasuke-amaterasu-move')]
  state.extensions = {
    amaterasuOwnerPlayerId: 'player-blue',
    amaterasuCells: [{ x: 0, y: 1, ownerPlayerId: 'player-blue', sourcePieceId: 'opponent' }],
    // This is the shape emitted by the canonical Sasuke skill: the visible
    // tile itself has no private player status or rule descriptor.
    tileEffects: [{ id: 'amaterasu-1', x: 0, y: 1, tileType: 'amaterasu' }],
  }
  return state
}

function enemyToxinMoveState({ hidden = false }: { hidden?: boolean } = {}): BattleState {
  const state = moveState()
  const toxin: Record<string, unknown> = {
    id: 'toxin-1',
    type: 'lethal-toxin',
    intensity: 4,
    value: 1,
    extraValue: 1,
    sourceId: 'opponent',
    currentDuration: -1,
  }
  if (hidden) toxin.visible = false
  state.players[1].rules = [canonicalRule('rule-blackwidow-toxin-player')]
  state.players[1].statusTags = [toxin]
  state.extensions = {
    tileEffects: [{ id: 'toxin-1', sourceId: 'toxin-1', tileType: 'lethal-toxin', x: 1, y: 1,
      ownerPlayerId: 'player-blue', ...(hidden ? { visible: false } : {}) }],
  }
  return state
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

  it('previews a visible enemy canonical Amaterasu rule without mutating authority', () => {
    const state = enemyAmaterasuMoveState()
    const action = moveAction([{ x: 0, y: 1 }, { x: 1, y: 1 }])
    const before = JSON.stringify(state)
    const actual = applyBattleAction(state, action)
    const result = previewBattleAction(state, action, 'player-red')

    expect(actual.pieces.find(piece => piece.instanceId === 'mover')?.statusTags)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'amaterasu-burn', stacks: 1 })]))
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.snapshot.pieces.find(piece => piece.instanceId === 'mover')?.statusTags)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'amaterasu-burn', stacks: 1 })]))
    expect(JSON.stringify(state)).toBe(before)
  })

  it('counts each entered Amaterasu cell once and includes the destination once', () => {
    const state = enemyAmaterasuMoveState()
    state.extensions!.amaterasuCells = [
      { x: 0, y: 1, ownerPlayerId: 'player-blue', sourcePieceId: 'opponent' },
      { x: 1, y: 1, ownerPlayerId: 'player-blue', sourcePieceId: 'opponent' },
    ]
    state.extensions!.tileEffects = [
      { id: 'amaterasu-1', x: 0, y: 1, tileType: 'amaterasu' },
      { id: 'amaterasu-2', x: 1, y: 1, tileType: 'amaterasu' },
    ]
    const action = moveAction([{ x: 0, y: 1 }, { x: 1, y: 1 }])
    const actual = applyBattleAction(state, action)
    const result = previewBattleAction(state, action, 'player-red')

    expect(actual.pieces.find(piece => piece.instanceId === 'mover')?.statusTags)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'amaterasu-burn', stacks: 2, intensity: 2 })]))
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.snapshot.pieces.find(piece => piece.instanceId === 'mover')?.statusTags)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'amaterasu-burn', stacks: 2, intensity: 2 })]))
  })

  it('previews enemy Itachi terrain whose canonical cells only contain coordinates', () => {
    const state = enemyAmaterasuMoveState()
    state.extensions!.amaterasuCells = [{ x: 0, y: 1 }]
    state.extensions!.tileEffects = [{ x: 0, y: 1, sourceId: 'amaterasu', tileType: 'amaterasu' }]
    const action = moveAction([{ x: 0, y: 1 }, { x: 1, y: 1 }])
    const actual = applyBattleAction(state, action)
    const before = JSON.stringify(state)
    const result = previewBattleAction(state, action, 'player-red')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    const contactStatuses = (snapshot: BattleState) => snapshot.pieces.find(piece => piece.instanceId === 'mover')?.statusTags
      .map(tag => ({ type: tag.type, stacks: tag.stacks }))
    expect(contactStatuses(result.snapshot)).toEqual(contactStatuses(actual))
    expect(result.snapshot.pieces.find(piece => piece.instanceId === 'mover')?.statusTags)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'amaterasu-burn', stacks: 1 })]))
    expect(JSON.stringify(state)).toBe(before)
  })

  it('keeps a visible permanent Amaterasu route after its source piece leaves the board', () => {
    const state = enemyAmaterasuMoveState()
    state.pieces = state.pieces.filter(piece => piece.instanceId !== 'opponent')
    const action = moveAction([{ x: 0, y: 1 }, { x: 1, y: 1 }])
    const actual = applyBattleAction(state, action)
    const result = previewBattleAction(state, action, 'player-red')

    expect(actual.pieces.find(piece => piece.instanceId === 'mover')?.statusTags)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'amaterasu-burn', stacks: 1 })]))
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.snapshot.pieces.find(piece => piece.instanceId === 'mover')?.statusTags)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'amaterasu-burn', stacks: 1 })]))
  })

  it('fails closed when visible enemy Amaterasu proof loses its public cell', () => {
    const state = enemyAmaterasuMoveState()
    state.extensions!.amaterasuCells = []
    const result = previewBattleAction(state, moveAction([{ x: 0, y: 1 }, { x: 1, y: 1 }]), 'player-red')

    expect(result).toEqual(expect.objectContaining({ status: 'unavailable', reason: 'preview-unavailable' }))
  })

  it('uses the canonical global Amaterasu owner over stale cell metadata', () => {
    const state = enemyAmaterasuMoveState()
    ;(state.extensions!.amaterasuCells![0] as Record<string, unknown>).ownerPlayerId = 'player-red'
    const result = previewBattleAction(state, moveAction([{ x: 0, y: 1 }, { x: 1, y: 1 }]), 'player-red')

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.snapshot.pieces[0].statusTags)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'amaterasu-burn', stacks: 1 })]))
  })

  it('fails closed when fallback Amaterasu owner proofs disagree', () => {
    const state = enemyAmaterasuMoveState()
    delete state.extensions!.amaterasuOwnerPlayerId
    ;(state.extensions!.amaterasuCells![0] as Record<string, unknown>).ownerPlayerId = 'player-red'
    ;(state.extensions!.tileEffects![0] as Record<string, unknown>).ownerPlayerId = 'player-blue'
    const result = previewBattleAction(state, moveAction([{ x: 0, y: 1 }, { x: 1, y: 1 }]), 'player-red')

    expect(result).toEqual(expect.objectContaining({ status: 'unavailable', reason: 'preview-unavailable' }))
  })

  it('previews a visible enemy canonical toxin rule with four damage and consumes only the public tile', () => {
    const state = enemyToxinMoveState()
    const action = moveAction([{ x: 0, y: 1 }, { x: 1, y: 1 }])
    const before = JSON.stringify(state)
    const actual = applyBattleAction(state, action)
    const result = previewBattleAction(state, action, 'player-red')

    expect(actual.pieces.find(piece => piece.instanceId === 'mover')?.currentHp).toBe(96)
    expect(actual.extensions?.tileEffects).toEqual([])
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.snapshot.pieces.find(piece => piece.instanceId === 'mover')?.currentHp)
      .toBe(actual.pieces.find(piece => piece.instanceId === 'mover')?.currentHp)
    expect(result.snapshot.extensions?.tileEffects).toEqual([])
    expect(JSON.stringify(state)).toBe(before)
  })

  it('does not reveal or execute a hidden enemy toxin', () => {
    const hidden = enemyToxinMoveState({ hidden: true })
    const clear = moveState()
    const action = moveAction([{ x: 0, y: 1 }, { x: 1, y: 1 }])

    const hiddenResult = previewBattleAction(hidden, action, 'player-red')
    const clearResult = previewBattleAction(clear, action, 'player-red')

    expect(withoutDuration(hiddenResult)).toEqual(withoutDuration(clearResult))
    if (hiddenResult.status === 'ready') {
      expect(hiddenResult.snapshot.pieces.find(piece => piece.instanceId === 'mover')?.currentHp).toBe(100)
      expect(hiddenResult.snapshot.extensions?.tileEffects ?? []).toEqual([])
    }
    expect(JSON.stringify(hiddenResult)).not.toContain('toxin-1')
    expect(JSON.stringify(hiddenResult)).not.toContain('lethal-toxin')
  })

  it('fails closed when a network public snapshot has the toxin tile but no matching status', () => {
    const state = enemyToxinMoveState()
    delete (state.players[1] as BattleState['players'][number] & { statusTags?: unknown[] }).statusTags
    const result = previewBattleAction(state, moveAction([{ x: 0, y: 1 }, { x: 1, y: 1 }]), 'player-red')

    expect(result).toEqual(expect.objectContaining({ status: 'unavailable', reason: 'preview-unavailable' }))
    expect(JSON.stringify(result)).not.toContain('toxin-1')
  })

  it('fails closed when visible enemy toxin proof loses its public owner or source id', () => {
    const state = enemyToxinMoveState()
    const tile = state.extensions!.tileEffects![0] as Record<string, unknown>
    delete tile.ownerPlayerId
    delete tile.sourceId
    const result = previewBattleAction(state, moveAction([{ x: 0, y: 1 }, { x: 1, y: 1 }]), 'player-red')

    expect(result).toEqual(expect.objectContaining({ status: 'unavailable', reason: 'preview-unavailable' }))
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
