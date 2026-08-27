import { describe, expect, it, vi } from 'vitest'

import { listLegalAIActions, observeBattleForAI } from '@/lib/game/ai-environment'
import { runBattleAction } from '@/lib/game/battle-runner'
import { loadRuleById } from '@/lib/game/skills'
import { applyBattleAction } from '@/lib/game/turn'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { prepareAction } from '@/lib/game/targeting'
import { createRunningTurnTimer } from '@/lib/game/turn-timer'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

function minatoWatcherState(): BattleState {
  const minato = makePiece({
    instanceId: 'minato',
    templateId: 'blue-minato',
    ownerPlayerId: 'player-red',
    x: 1,
    y: 1,
  }) as any
  minato.name = '波风水门'
  minato.rules = [loadRuleById('rule-minato-anchor-begin-turn', true)]

  const watcher = makePiece({
    instanceId: 'watcher',
    templateId: 'red-watcher',
    ownerPlayerId: 'player-red',
    x: 2,
    y: 1,
  }) as any
  watcher.name = '观者'
  watcher.rules = [loadRuleById('rule-watcher-form', true)]

  return makeState({
    pieces: [minato, watcher],
    currentPlayerId: 'player-red',
    phase: 'start',
  })
}

function beginMinatoSelection(): BattleState {
  const pending = applyBattleAction(minatoWatcherState(), { type: 'beginPhase' })
  expect(pending.turn.phase).toBe('start')
  expect(pending.pendingTargetSelection).toMatchObject({
    playerId: 'player-red',
    source: { type: 'rule', id: 'rule-minato-anchor-begin-turn', pieceId: 'minato' },
    canCancel: true,
  })
  expect(pending.pendingOptionSelection).toBeUndefined()
  return pending
}

function pendingTargetAction(state: BattleState, overrides: Record<string, unknown> = {}): BattleAction {
  const pending = state.pendingTargetSelection!
  const target = pending.candidates?.find(candidate => candidate.type === 'cell')
  if (!target || target.type !== 'cell') throw new Error('Expected a legal Minato anchor cell')
  return {
    type: 'pendingTargetSelect',
    playerId: 'player-red',
    targetX: target.x,
    targetY: target.y,
    selectionId: pending.selectionId,
    stateRevision: pending.stateRevision,
    ...overrides,
  } as BattleAction
}

function chooseWatcher(state: BattleState, selectedOption: 'calm' | 'rage'): BattleState {
  const pending = state.pendingOptionSelection!
  return applyBattleAction(state, {
    type: 'pendingOptionSelect',
    playerId: 'player-red',
    selectedOption,
    selectionId: pending.selectionId,
    stateRevision: pending.stateRevision,
  } as BattleAction)
}

function withPreparedTarget(state: BattleState, action: Record<string, any>): BattleAction {
  const draft = { ...action }
  delete draft.targetPieceId
  delete draft.targetX
  delete draft.targetY
  const prepared = prepareAction(state, draft as BattleAction)
  if (prepared.kind !== 'needTarget') {
    throw new Error(`Expected target preparation, received ${prepared.kind}`)
  }
  return { ...action, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision } as BattleAction
}
function timeoutPending(state: BattleState, rootSeed = 108): BattleState {
  state.turnTimer = createRunningTurnTimer(state, 0)
  return runBattleAction(state, {
    type: 'turnTimeout',
    now: state.turnTimer.deadlineAt,
    clientActionId: `red-108-timeout-${rootSeed}`,
  }, { rootSeed }).state
}


describe('RED-97 authoritative pending interaction lifecycle', () => {
  it('resolves Minato anchor, then Watcher, before committing begin-turn settlement once', () => {
    const targetPending = beginMinatoSelection()
    const optionPending = applyBattleAction(targetPending, pendingTargetAction(targetPending))

    expect(optionPending.turn.phase).toBe('start')
    expect(optionPending.pendingTargetSelection).toBeUndefined()
    expect(optionPending.pendingOptionSelection).toMatchObject({
      playerId: 'player-red',
      source: { type: 'rule', id: 'rule-watcher-form', pieceId: 'watcher' },
      canCancel: false,
    })
    expect(optionPending.pendingOptionSelection?.selectionId).toEqual(expect.any(String))

    const completed = chooseWatcher(optionPending, 'calm')
    const red = completed.players.find(player => player.playerId === 'player-red')!
    expect(completed.pendingOptionSelection).toBeUndefined()
    expect(completed.turn.phase).toBe('action')
    expect(red.hand.filter(card => card.cardId === 'watcher-calm')).toHaveLength(1)
    expect((completed.extensions?.minatoAnchors || []).filter((anchor: any) => anchor.sourceId === 'minato')).toHaveLength(1)
  })

  it('cancels only Minato and continues to the non-cancellable Watcher choice', () => {
    const targetPending = beginMinatoSelection()
    const pending = targetPending.pendingTargetSelection!
    const optionPending = applyBattleAction(targetPending, {
      type: 'cancelPendingSelection',
      playerId: 'player-red',
      selectionId: pending.selectionId,
      stateRevision: pending.stateRevision,
    })

    expect(optionPending.turn.phase).toBe('start')
    expect(optionPending.pendingTargetSelection).toBeUndefined()
    expect(optionPending.pendingOptionSelection).toMatchObject({
      source: { id: 'rule-watcher-form', pieceId: 'watcher' },
      canCancel: false,
    })
    expect(() => applyBattleAction(optionPending, {
      type: 'cancelPendingSelection',
      playerId: 'player-red',
      selectionId: optionPending.pendingOptionSelection?.selectionId,
      stateRevision: optionPending.pendingOptionSelection?.stateRevision,
    })).toThrow(expect.objectContaining({ code: 'PENDING_OPTION_CANCEL_FORBIDDEN' }))

    const completed = chooseWatcher(optionPending, 'rage')
    expect(completed.turn.phase).toBe('action')
    expect(completed.players[0].hand.filter(card => card.cardId === 'watcher-rage')).toHaveLength(1)
    expect(completed.extensions?.minatoAnchors || []).toEqual([])
  })

  it('keeps Minato pending unchanged after stale or invalid submissions and accepts a legal retry', () => {
    const targetPending = beginMinatoSelection()
    const before = JSON.stringify(targetPending)

    expect(() => applyBattleAction(targetPending, pendingTargetAction(targetPending, {
      selectionId: 'stale-minato-selection',
    }))).toThrow(expect.objectContaining({ code: 'TARGET_SELECTION_ID_MISMATCH' }))
    expect(JSON.stringify(targetPending)).toBe(before)

    expect(() => applyBattleAction(targetPending, pendingTargetAction(targetPending, {
      targetX: -1,
      targetY: -1,
    }))).toThrow(expect.objectContaining({ code: 'TARGET_NOT_FOUND' }))
    expect(JSON.stringify(targetPending)).toBe(before)

    const retried = applyBattleAction(targetPending, pendingTargetAction(targetPending))
    expect(retried.pendingTargetSelection).toBeUndefined()
    expect(retried.pendingOptionSelection?.source?.id).toBe('rule-watcher-form')
  })

  it('versions option sessions, validates values, and exposes the same credentials to AI', () => {
    const targetPending = beginMinatoSelection()
    const optionPending = applyBattleAction(targetPending, pendingTargetAction(targetPending))
    const pending = optionPending.pendingOptionSelection!
    const before = JSON.stringify(optionPending)

    expect(() => applyBattleAction(optionPending, {
      type: 'pendingOptionSelect',
      playerId: 'player-red',
      selectedOption: 'invalid-form',
      selectionId: pending.selectionId,
      stateRevision: pending.stateRevision,
    } as BattleAction)).toThrow(expect.objectContaining({ code: 'PENDING_OPTION_VALUE_INVALID' }))
    expect(JSON.stringify(optionPending)).toBe(before)

    const observation = observeBattleForAI(optionPending, 'player-red')
    expect(observation.pendingOptionSelection).toMatchObject({
      selectionId: pending.selectionId,
      stateRevision: pending.stateRevision,
      canCancel: false,
    })
    const candidates = listLegalAIActions(optionPending, 'player-red')
    expect(candidates.map(candidate => candidate.kind)).toEqual(['pending-option', 'pending-option'])
    expect(candidates.every(candidate => {
      const action = candidate.action as any
      return action.selectionId === pending.selectionId
      && action.stateRevision === pending.stateRevision
    })).toBe(true)
  })

  it('persists Shishio before-damage choice before payment and resumes it with authoritative credentials', () => {
    const shishio = makePiece({
      instanceId: 'shishio',
      templateId: 'red-shishio',
      ownerPlayerId: 'player-red',
      x: 1,
      y: 1,
      attack: 10,
      currentHp: 20,
      maxHp: 20,
    }) as any
    shishio.name = '志志雄真实'
    shishio.rules = [loadRuleById('rule-shishio-execute-option', true)]
    shishio.skills = [{ skillId: 'execute-strike', currentCooldown: 0, usesRemaining: -1 }]
    const target = makePiece({
      instanceId: 'execute-target',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 1,
      currentHp: 5,
      maxHp: 5,
    })
    const state = makeState({
      pieces: [shishio, target],
      currentPlayerId: 'player-red',
      phase: 'action',
    }) as any
    state.players.find((player: any) => player.playerId === 'player-red').actionPoints = 2
    state.skillsById['execute-strike'] = {
      id: 'execute-strike',
      name: '处决测试斩',
      description: '',
      kind: 'active',
      type: 'normal',
      cooldownTurns: 0,
      maxCharges: 0,
      powerMultiplier: 1,
      actionPointCost: 1,
      range: 'single',
      requiresTarget: true,
      code: "function executeSkill(context) { var target = selectTarget({ type: 'piece', range: 2, filter: 'enemy' }); if (!target || target.needsTargetSelection) return target; dealDamage(context.piece, target, 10, 'true', context.battle, 'execute-strike'); return { success: true, message: 'strike' }; }",
    }

    const pending = applyBattleAction(state, withPreparedTarget(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'shishio',
      skillId: 'execute-strike',
      targetPieceId: 'execute-target',
    }))

    expect(pending.pendingOptionSelection).toMatchObject({
      playerId: 'player-red',
      source: { type: 'rule', id: 'rule-shishio-execute-option', pieceId: 'shishio' },
      canCancel: true,
      cancelValue: 'normal',
    })
    expect(pending.players.find(player => player.playerId === 'player-red')?.actionPoints).toBe(2)
    expect(pending.pieces.find(piece => piece.instanceId === 'execute-target')?.currentHp).toBe(5)

    const choice = pending.pendingOptionSelection!
    const resolved = applyBattleAction(pending, {
      type: 'pendingOptionSelect',
      playerId: 'player-red',
      selectedOption: 'normal',
      selectionId: choice.selectionId,
      stateRevision: choice.stateRevision,
    })
    expect(resolved.pendingOptionSelection).toBeUndefined()
    expect(resolved.players.find(player => player.playerId === 'player-red')?.actionPoints).toBe(1)
    expect(resolved.pieces.some(piece => piece.instanceId === 'execute-target')).toBe(false)
    expect(resolved.graveyard.some(piece => piece.instanceId === 'execute-target')).toBe(true)
  })

  it('resumes a targeted skill after Flying Raijin without rejecting its now-stale target credentials', () => {
    const minato = makePiece({
      instanceId: 'raijin-minato',
      templateId: 'blue-minato',
      ownerPlayerId: 'player-red',
      x: 0,
      y: 0,
      attack: 3,
    }) as any
    minato.name = '波风水门'
    minato.rules = [loadRuleById('rule-minato-flying-raijin-trigger', true)]
    const attacker = makePiece({
      instanceId: 'raijin-attacker',
      ownerPlayerId: 'player-red',
      x: 1,
      y: 1,
      attack: 2,
    }) as any
    attacker.skills = [{ skillId: 'marked-shot', currentCooldown: 0, usesRemaining: -1 }]
    const target = makePiece({
      instanceId: 'raijin-target',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 1,
      currentHp: 10,
      maxHp: 10,
    }) as any
    target.statusTags = [{
      id: 'test-raijin-mark',
      type: 'flying-raijin-mark',
      name: '飞雷神',
      sourceId: minato.instanceId,
      stacks: 1,
      visible: true,
    }]
    const state = makeState({
      pieces: [minato, attacker, target],
      currentPlayerId: 'player-red',
      phase: 'action',
    }) as any
    state.players.find((player: any) => player.playerId === 'player-red').actionPoints = 2
    state.skillsById['marked-shot'] = {
      id: 'marked-shot',
      name: '标记射击',
      description: '',
      kind: 'active',
      type: 'normal',
      cooldownTurns: 0,
      maxCharges: 0,
      powerMultiplier: 1,
      actionPointCost: 1,
      range: 'single',
      requiresTarget: true,
      code: "function executeSkill(context) { var target = selectTarget({ type: 'piece', range: 2, filter: 'enemy' }); if (!target || target.needsTargetSelection) return target; dealDamage(context.piece, target, 2, 'true', context.battle, 'marked-shot'); return { success: true, message: 'shot' }; }",
    }

    const pending = applyBattleAction(state, withPreparedTarget(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'raijin-attacker',
      skillId: 'marked-shot',
      targetPieceId: 'raijin-target',
      __pendingContinuationMode: 'skillAfterBeforeTrigger',
    }))
    expect(pending.pendingOptionSelection).toMatchObject({
      source: { type: 'rule', id: 'rule-minato-flying-raijin-trigger', pieceId: 'raijin-minato' },
      canCancel: true,
      cancelValue: 'no',
    })
    expect(pending.players.find(player => player.playerId === 'player-red')?.actionPoints).toBe(2)

    const choice = pending.pendingOptionSelection!
    const resolved = applyBattleAction(pending, {
      type: 'pendingOptionSelect',
      playerId: 'player-red',
      selectedOption: 'no',
      selectionId: choice.selectionId,
      stateRevision: choice.stateRevision,
    })
    expect(resolved.pendingOptionSelection).toBeUndefined()
    expect(resolved.players.find(player => player.playerId === 'player-red')?.actionPoints).toBe(1)
    expect(resolved.pieces.find(piece => piece.instanceId === 'raijin-target')?.currentHp).toBe(8)
  })

  it('settles the turn phase after an interactive begin-turn consumer blocks the remaining event', () => {
    const previousRules = [...globalTriggerSystem.getRules()]
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRules([
      {
        id: 'interactive-begin-blocker',
        name: 'Interactive begin blocker',
        description: '',
        priority: 20,
        trigger: { type: 'beginTurn' },
        effect: (battle: BattleState, context: any) => {
          if (context.selectedOption === undefined) {
            return {
              needsOptionSelection: true,
              playerId: 'player-red',
              title: 'Block remaining begin event',
              options: [{ label: 'Block', value: 'block' }],
              canCancel: false,
            }
          }
          ;(battle.extensions as any).blockerCount = ((battle.extensions as any).blockerCount || 0) + 1
          return { success: true, blocked: true, message: 'blocked' }
        },
      },
      {
        id: 'must-not-run-after-block',
        name: 'Must not run after block',
        description: '',
        priority: 10,
        trigger: { type: 'beginTurn' },
        effect: (battle: BattleState) => {
          ;(battle.extensions as any).afterBlockCount = ((battle.extensions as any).afterBlockCount || 0) + 1
          return { success: true }
        },
      },
    ] as any)

    try {
      const pending = applyBattleAction(makeState({ currentPlayerId: 'player-red', phase: 'start' }), { type: 'beginPhase' })
      const session = pending.pendingOptionSelection!
      const completed = applyBattleAction(pending, {
        type: 'pendingOptionSelect',
        playerId: 'player-red',
        selectedOption: 'block',
        selectionId: session.selectionId,
        stateRevision: session.stateRevision,
      })

      expect(completed.pendingOptionSelection).toBeUndefined()
      expect(completed.turn.phase).toBe('action')
      expect((completed.extensions as any).blockerCount).toBe(1)
      expect((completed.extensions as any).afterBlockCount).toBeUndefined()
    } finally {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRules(previousRules)
    }
  })

  it('suspends a nested after-damage interaction and commits the complete action exactly once', () => {
    const previousRules = [...globalTriggerSystem.getRules()]
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRule({
      id: 'unsupported-after-damage-option',
      name: 'Unsupported after damage option',
      description: '',
      trigger: { type: 'afterDamageDealt' },
      effect: (_battle: BattleState, context: any) => context.selectedOption === 'continue'
        ? { success: true, message: 'continued' }
        : ({
        needsOptionSelection: true,
        playerId: 'player-red',
        title: 'Unsupported option',
        options: [{ label: 'Continue', value: 'continue' }],
      }),
    } as any)

    try {
      const attacker = makePiece({
        instanceId: 'atomic-attacker',
        ownerPlayerId: 'player-red',
        x: 1,
        y: 1,
        attack: 2,
      }) as any
      attacker.skills = [{ skillId: 'atomic-shot', currentCooldown: 0, usesRemaining: -1 }]
      const target = makePiece({
        instanceId: 'atomic-target',
        ownerPlayerId: 'player-blue',
        faction: 'blue',
        x: 2,
        y: 1,
        currentHp: 10,
        maxHp: 10,
      })
      const state = makeState({
        pieces: [attacker, target],
        currentPlayerId: 'player-red',
        phase: 'action',
      }) as any
      state.players[0].actionPoints = 2
      state.skillsById['atomic-shot'] = {
        id: 'atomic-shot',
        name: 'Atomic shot',
        description: '',
        kind: 'active',
        type: 'normal',
        cooldownTurns: 0,
        maxCharges: 0,
        powerMultiplier: 1,
        actionPointCost: 1,
        range: 'single',
        requiresTarget: true,
        code: "function executeSkill(context) { var target = selectTarget({ type: 'piece', range: 2, filter: 'enemy' }); if (!target || target.needsTargetSelection) return target; dealDamage(context.piece, target, 2, 'true', context.battle, 'atomic-shot'); return { success: true, message: 'shot' }; }",
      }
      const action = withPreparedTarget(state, {
        type: 'useBasicSkill',
        playerId: 'player-red',
        pieceId: 'atomic-attacker',
        skillId: 'atomic-shot',
        targetPieceId: 'atomic-target',
      })

      const pending = applyBattleAction(state, action) as any
      expect(pending.pendingOptionSelection?.source).toMatchObject({
        type: 'rule',
        id: 'unsupported-after-damage-option',
      })
      expect(pending.players[0].actionPoints).toBe(2)
      expect(pending.pieces.find((piece: any) => piece.instanceId === 'atomic-target')?.currentHp).toBe(10)

      const resolved = applyBattleAction(pending, {
        type: 'pendingOptionSelect',
        playerId: 'player-red',
        selectedOption: 'continue',
        selectionId: pending.pendingOptionSelection.selectionId,
        stateRevision: pending.pendingOptionSelection.stateRevision,
      } as any) as any
      expect(resolved.pendingOptionSelection).toBeUndefined()
      expect(resolved.players[0].actionPoints).toBe(1)
      expect(resolved.pieces.find((piece: any) => piece.instanceId === 'atomic-target')?.currentHp).toBe(8)
      expect(resolved.actions.filter((entry: any) => entry.type === 'useBasicSkill')).toHaveLength(1)
    } finally {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRules(previousRules)
    }
  })

  it('keeps the root action at its pre-state when a resumed consumer throws', () => {
    const previousRules = [...globalTriggerSystem.getRules()]
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRule({
      id: 'resume-exception-probe',
      name: 'Resume exception probe',
      description: '',
      trigger: { type: 'beginTurn' },
      effect: (_battle: BattleState, context: any) => {
        if (context.selectedOption === 'explode') throw new Error('resume explosion')
        return {
          needsOptionSelection: true,
          playerId: 'player-red',
          title: 'Choose failure',
          options: [{ label: 'Explode', value: 'explode' }],
          canCancel: false,
        }
      },
    } as any)

    try {
      const state = makeState({
        currentPlayerId: 'player-red',
        phase: 'start',
      }) as any
      const pending = applyBattleAction(state, { type: 'beginPhase' }) as any
      expect(pending.turn.phase).toBe('start')
      expect(pending.pendingOptionSelection?.source?.id).toBe('resume-exception-probe')
      const pendingSnapshot = JSON.stringify(pending)

      expect(() => applyBattleAction(pending, {
        type: 'pendingOptionSelect',
        playerId: 'player-red',
        selectedOption: 'explode',
        selectionId: pending.pendingOptionSelection.selectionId,
        stateRevision: pending.pendingOptionSelection.stateRevision,
      } as any)).toThrow(/resume explosion/)
      expect(JSON.stringify(pending)).toBe(pendingSnapshot)
      expect(pending.turn.phase).toBe('start')
    } finally {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRules(previousRules)
    }
  })

  it('continues option-to-target chains, queued rules, and the frozen reactive snapshot exactly once', () => {
    const previousRules = [...globalTriggerSystem.getRules()]
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRules([
      {
        id: 'mixed-interaction-probe',
        name: 'Mixed interaction probe',
        description: '',
        priority: 20,
        trigger: { type: 'beginTurn' },
        effect: (battle: BattleState, context: any) => {
          if (context.selectedOption === undefined) {
            return {
              needsOptionSelection: true,
              playerId: 'player-red',
              title: 'Choose a path',
              options: [{ label: 'Continue', value: 'continue' }],
              canCancel: false,
            }
          }
          if (context.targetX === undefined || context.targetY === undefined) {
            return {
              needsTargetSelection: true,
              playerId: 'player-red',
              title: 'Choose a cell',
              targetType: 'cell',
              filter: 'empty',
              canCancel: true,
            }
          }
          ;(battle.extensions as any).mixedConsumerCount = ((battle.extensions as any).mixedConsumerCount || 0) + 1
          return { success: true, message: 'mixed complete' }
        },
      },
      {
        id: 'queued-rule-probe',
        name: 'Queued rule probe',
        description: '',
        priority: 10,
        trigger: { type: 'beginTurn' },
        effect: (battle: BattleState) => {
          ;(battle.extensions as any).queuedConsumerCount = ((battle.extensions as any).queuedConsumerCount || 0) + 1
          return { success: true, message: 'queue complete' }
        },
      },
    ] as any)

    try {
      const state = makeState({ currentPlayerId: 'player-red', phase: 'start' }) as any
      state.players[0].hand = [{ cardId: 'reactive-probe', instanceId: 'reactive-probe-1', actionPointCost: 0 }]
      state.customCards = {
        'reactive-probe': {
          id: 'reactive-probe',
          name: 'Reactive probe',
          description: '',
          type: 'reactive',
          actionPointCost: 0,
          trigger: { type: 'beginTurn' },
          code: "function executeCard(context) { context.battle.extensions.reactiveConsumerCount = (context.battle.extensions.reactiveConsumerCount || 0) + 1; return { success: true, message: 'reactive complete', keepInHand: true }; }",
        },
      }

      const optionPending = applyBattleAction(state, { type: 'beginPhase' })
      expect(optionPending.pendingOptionSelection?.source?.id).toBe('mixed-interaction-probe')
      expect((optionPending.extensions as any).queuedConsumerCount).toBeUndefined()
      expect((optionPending.extensions as any).reactiveConsumerCount).toBeUndefined()

      const option = optionPending.pendingOptionSelection!
      const targetPending = applyBattleAction(optionPending, {
        type: 'pendingOptionSelect',
        playerId: 'player-red',
        selectedOption: 'continue',
        selectionId: option.selectionId,
        stateRevision: option.stateRevision,
      })
      expect(targetPending.pendingTargetSelection?.source?.id).toBe('mixed-interaction-probe')
      expect(targetPending.turn.phase).toBe('start')

      const targetSession = targetPending.pendingTargetSelection!
      const targetCell = targetSession.candidates?.find(candidate => candidate.type === 'cell')
      if (!targetCell || targetCell.type !== 'cell') throw new Error('Expected a legal mixed-interaction cell')
      const completed = applyBattleAction(targetPending, {
        type: 'pendingTargetSelect',
        playerId: 'player-red',
        targetX: targetCell.x,
        targetY: targetCell.y,
        selectionId: targetSession.selectionId,
        stateRevision: targetSession.stateRevision,
      })
      expect(completed.turn.phase).toBe('action')
      expect((completed.extensions as any).mixedConsumerCount).toBe(1)
      expect((completed.extensions as any).queuedConsumerCount).toBe(1)
      expect((completed.extensions as any).reactiveConsumerCount).toBe(1)
    } finally {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRules(previousRules)
    }
  })
})

describe('RED-121 card execution pending boundaries', () => {
  it('suspends inside an active card effect and commits payment, damage, and discard exactly once', () => {
    const previousRules = [...globalTriggerSystem.getRules()]
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRule({
      id: 'active-card-after-damage-choice',
      name: 'Active card after-damage choice',
      description: '',
      trigger: { type: 'afterDamageDealt' },
      effect: (battle: BattleState, context: any) => {
        if (context.selectedOption !== 'continue') {
          return {
            needsOptionSelection: true,
            playerId: 'player-red',
            title: 'Continue active card',
            options: [{ label: 'Continue', value: 'continue' }],
            canCancel: false,
          }
        }
        ;(battle.extensions as any).activeCardChoiceCount = ((battle.extensions as any).activeCardChoiceCount || 0) + 1
        return { success: true }
      },
    } as any)

    try {
      const attacker = makePiece({ instanceId: 'active-card-source', ownerPlayerId: 'player-red', x: 1, y: 1 })
      const target = makePiece({
        instanceId: 'active-card-target',
        ownerPlayerId: 'player-blue',
        faction: 'blue',
        x: 2,
        y: 1,
        currentHp: 10,
        maxHp: 10,
      })
      const state = makeState({ pieces: [attacker, target], currentPlayerId: 'player-red', phase: 'action' }) as any
      state.players[0].actionPoints = 2
      state.players[0].hand = [{
        cardId: 'active-card-pending-probe',
        instanceId: 'active-card-pending-probe-1',
        ownerPlayerId: 'player-red',
        actionPointCost: 1,
      }]
      state.customCards = {
        'active-card-pending-probe': {
          id: 'active-card-pending-probe',
          name: 'Active pending probe',
          description: '',
          type: 'active',
          actionPointCost: 1,
          code: "function executeCard(context) { var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'active-card-source'; }); var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'active-card-target'; }); dealDamage(source, target, 2, 'true', context.battle, 'active-card-pending-probe'); context.battle.extensions.activeCardExecutionCount = (context.battle.extensions.activeCardExecutionCount || 0) + 1; return { success: true, message: 'active card complete' }; }",
        },
      }

      const pending = applyBattleAction(state, {
        type: 'playCard',
        playerId: 'player-red',
        cardInstanceId: 'active-card-pending-probe-1',
      }) as any
      expect(pending.pendingOptionSelection?.source).toMatchObject({
        type: 'rule',
        id: 'active-card-after-damage-choice',
      })
      expect(pending.players[0].actionPoints).toBe(2)
      expect(pending.players[0].hand).toHaveLength(1)
      expect(pending.players[0].discardPile).toEqual([])
      expect(pending.pieces.find((piece: any) => piece.instanceId === 'active-card-target')?.currentHp).toBe(10)

      const session = pending.pendingOptionSelection
      const completed = applyBattleAction(pending, {
        type: 'pendingOptionSelect',
        playerId: 'player-red',
        selectedOption: 'continue',
        selectionId: session.selectionId,
        stateRevision: session.stateRevision,
      }) as any
      expect(completed.pendingOptionSelection).toBeUndefined()
      expect(completed.players[0].actionPoints).toBe(1)
      expect(completed.players[0].hand).toHaveLength(0)
      expect(completed.players[0].discardPile).toEqual(['active-card-pending-probe'])
      expect(completed.pieces.find((piece: any) => piece.instanceId === 'active-card-target')?.currentHp).toBe(8)
      expect((completed.extensions as any).activeCardChoiceCount).toBe(1)
      expect((completed.extensions as any).activeCardExecutionCount).toBe(1)
      expect(completed.actions.filter((entry: any) => entry.type === 'playCard')).toHaveLength(1)
    } finally {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRules(previousRules)
    }
  })

  it('keeps an active card at its pre-action state when the nested consumer throws after resume', () => {
    const previousRules = [...globalTriggerSystem.getRules()]
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRule({
      id: 'active-card-resume-exception',
      name: 'Active card resume exception',
      description: '',
      trigger: { type: 'afterDamageDealt' },
      effect: (_battle: BattleState, context: any) => {
        if (context.selectedOption === 'explode') throw new Error('active card resume explosion')
        return {
          needsOptionSelection: true,
          playerId: 'player-red',
          title: 'Explode active card',
          options: [{ label: 'Explode', value: 'explode' }],
          canCancel: false,
        }
      },
    } as any)

    try {
      const source = makePiece({ instanceId: 'rollback-card-source', ownerPlayerId: 'player-red', x: 1, y: 1 })
      const target = makePiece({ instanceId: 'rollback-card-target', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 1, currentHp: 10, maxHp: 10 })
      const state = makeState({ pieces: [source, target], currentPlayerId: 'player-red', phase: 'action' }) as any
      state.players[0].actionPoints = 2
      state.players[0].hand = [{ cardId: 'rollback-card-probe', instanceId: 'rollback-card-probe-1', ownerPlayerId: 'player-red', actionPointCost: 1 }]
      state.customCards = {
        'rollback-card-probe': {
          id: 'rollback-card-probe', name: 'Rollback card probe', description: '', type: 'active', actionPointCost: 1,
          code: "function executeCard(context) { var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'rollback-card-source'; }); var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'rollback-card-target'; }); dealDamage(source, target, 2, 'true', context.battle, 'rollback-card-probe'); return { success: true }; }",
        },
      }
      const pending = applyBattleAction(state, { type: 'playCard', playerId: 'player-red', cardInstanceId: 'rollback-card-probe-1' }) as any
      const pendingSnapshot = JSON.stringify(pending)
      const session = pending.pendingOptionSelection

      expect(() => applyBattleAction(pending, {
        type: 'pendingOptionSelect',
        playerId: 'player-red',
        selectedOption: 'explode',
        selectionId: session.selectionId,
        stateRevision: session.stateRevision,
      } as any)).toThrow(/active card resume explosion/)
      expect(JSON.stringify(pending)).toBe(pendingSnapshot)
      expect(pending.players[0].actionPoints).toBe(2)
      expect(pending.players[0].hand).toHaveLength(1)
      expect(pending.pieces.find((piece: any) => piece.instanceId === 'rollback-card-target')?.currentHp).toBe(10)
    } finally {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRules(previousRules)
    }
  })

  it('propagates a nested pending interaction through the reactive-card execution boundary', () => {
    const previousRules = [...globalTriggerSystem.getRules()]
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRule({
      id: 'reactive-card-after-damage-choice',
      name: 'Reactive card after-damage choice',
      description: '',
      trigger: { type: 'afterDamageDealt' },
      effect: (battle: BattleState, context: any) => {
        if (context.selectedOption !== 'continue') {
          return { needsOptionSelection: true, playerId: 'player-red', title: 'Continue reactive card', options: [{ label: 'Continue', value: 'continue' }], canCancel: false }
        }
        ;(battle.extensions as any).reactiveNestedChoiceCount = ((battle.extensions as any).reactiveNestedChoiceCount || 0) + 1
        return { success: true }
      },
    } as any)

    try {
      const source = makePiece({ instanceId: 'reactive-card-source', ownerPlayerId: 'player-red', x: 1, y: 1 })
      const target = makePiece({ instanceId: 'reactive-card-target', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 1, currentHp: 10, maxHp: 10 })
      const state = makeState({ pieces: [source, target], currentPlayerId: 'player-red', phase: 'start' }) as any
      state.players[0].hand = [{ cardId: 'reactive-card-pending-probe', instanceId: 'reactive-card-pending-probe-1', ownerPlayerId: 'player-red', actionPointCost: 0 }]
      state.customCards = {
        'reactive-card-pending-probe': {
          id: 'reactive-card-pending-probe', name: 'Reactive pending probe', description: '', type: 'reactive', actionPointCost: 0,
          trigger: { type: 'beginTurn' },
          code: "function executeCard(context) { var source = context.battle.pieces.find(function(piece) { return piece.instanceId === 'reactive-card-source'; }); var target = context.battle.pieces.find(function(piece) { return piece.instanceId === 'reactive-card-target'; }); dealDamage(source, target, 3, 'true', context.battle, 'reactive-card-pending-probe'); context.battle.extensions.reactiveCardExecutionCount = (context.battle.extensions.reactiveCardExecutionCount || 0) + 1; return { success: true, message: 'reactive complete' }; }",
        },
      }

      const pending = applyBattleAction(state, { type: 'beginPhase' }) as any
      expect(pending.turn.phase).toBe('start')
      expect(pending.pendingOptionSelection?.source?.id).toBe('reactive-card-after-damage-choice')
      expect(pending.players[0].hand).toHaveLength(1)
      expect(pending.pieces.find((piece: any) => piece.instanceId === 'reactive-card-target')?.currentHp).toBe(10)

      const session = pending.pendingOptionSelection
      const completed = applyBattleAction(pending, { type: 'pendingOptionSelect', playerId: 'player-red', selectedOption: 'continue', selectionId: session.selectionId, stateRevision: session.stateRevision }) as any
      expect(completed.turn.phase).toBe('action')
      expect(completed.pendingOptionSelection).toBeUndefined()
      expect(completed.players[0].hand).toHaveLength(0)
      expect(completed.players[0].discardPile).toEqual(['reactive-card-pending-probe'])
      expect(completed.pieces.find((piece: any) => piece.instanceId === 'reactive-card-target')?.currentHp).toBe(7)
      expect((completed.extensions as any).reactiveNestedChoiceCount).toBe(1)
      expect((completed.extensions as any).reactiveCardExecutionCount).toBe(1)
    } finally {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRules(previousRules)
    }
  })
})

describe('RED-121 suspended candidate checkpoints', () => {
  it('computes an afterMove target range from the provisional moved position without committing the move', () => {
    const previousRules = [...globalTriggerSystem.getRules()]
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRule({
      id: 'after-move-target-probe',
      name: 'After-move target probe',
      description: 'Requests a range-one cell after movement',
      priority: 1,
      trigger: { type: 'afterMove' },
      effect: (battle: BattleState, context: any) => {
        if (context.targetX === undefined || context.targetY === undefined) {
          return {
            needsTargetSelection: true,
            playerId: context.playerId,
            title: 'Choose a cell beside the moved piece',
            targetType: 'cell',
            range: 1,
            filter: 'all',
            canCancel: false,
          }
        }
        ;(battle.extensions as any).afterMoveTarget = {
          x: context.targetX,
          y: context.targetY,
        }
        return { success: true }
      },
    } as any)

    try {
      const mover = makePiece({
        instanceId: 'after-move-mover',
        ownerPlayerId: 'player-red',
        x: 1,
        y: 1,
        moveRange: 3,
      })
      const state = makeState({
        pieces: [mover],
        currentPlayerId: 'player-red',
        phase: 'action',
        width: 5,
        height: 3,
      })
      const before = JSON.stringify(state)
      const pending = applyBattleAction(state, {
        type: 'move',
        playerId: 'player-red',
        pieceId: mover.instanceId,
        toX: 2,
        toY: 1,
      })

      expect(JSON.stringify(state)).toBe(before)
      expect(pending.pieces.find(piece => piece.instanceId === mover.instanceId)).toMatchObject({ x: 1, y: 1 })
      expect(pending.players[0].actionPoints).toBe(state.players[0].actionPoints)
      expect(pending.pendingTargetSelection?.candidates).toContainEqual({ type: 'cell', x: 3, y: 1 })
      expect(pending.pendingTargetSelection?.candidates).not.toContainEqual({ type: 'cell', x: 0, y: 1 })

      const session = pending.pendingTargetSelection!
      const completed = applyBattleAction(pending, {
        type: 'pendingTargetSelect',
        playerId: 'player-red',
        targetX: 3,
        targetY: 1,
        selectionId: session.selectionId,
        stateRevision: session.stateRevision,
      })

      expect(completed.pendingTargetSelection).toBeUndefined()
      expect(completed.pieces.find(piece => piece.instanceId === mover.instanceId)).toMatchObject({ x: 2, y: 1 })
      expect(completed.players[0].actionPoints).toBe(state.players[0].actionPoints - 1)
      expect((completed.extensions as any).afterMoveTarget).toEqual({ x: 3, y: 1 })
    } finally {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRules(previousRules)
    }
  })
})

describe('RED-121 legacy direct target transaction adapter', () => {
  it('keeps a post-effect target pending atomic and resolves its effect once', () => {
    const caster = makePiece({
      instanceId: 'legacy-target-caster',
      ownerPlayerId: 'player-red',
      x: 1,
      y: 1,
    }) as any
    caster.skills = [{ skillId: 'legacy-direct-target-probe', currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({
      pieces: [caster],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 5,
      height: 5,
    }) as any
    state.players[0].actionPoints = 2
    state.skillsById['legacy-direct-target-probe'] = {
      id: 'legacy-direct-target-probe',
      name: 'Legacy direct target probe',
      description: '',
      kind: 'active',
      type: 'normal',
      cooldownTurns: 1,
      maxCharges: 0,
      powerMultiplier: 1,
      actionPointCost: 1,
      range: 0,
      requiresTarget: false,
      code: `function executeSkill(context) {
        context.battle.extensions.legacyRootExecutionCount = (context.battle.extensions.legacyRootExecutionCount || 0) + 1;
        return {
          success: true,
          message: 'root complete',
          pendingTargetSelection: {
            playerId: context.piece.ownerPlayerId,
            title: 'Choose legacy target',
            targetType: 'cell',
            range: 2,
            filter: 'all',
            canCancel: false,
            effectCode: "function(ctx) { ctx.battle.extensions.legacyResolvedTarget = { x: ctx.targetX, y: ctx.targetY }; ctx.battle.extensions.legacyTargetEffectCount = (ctx.battle.extensions.legacyTargetEffectCount || 0) + 1; return { success: true, message: 'target complete' }; }"
          }
        };
      }`,
    }

    const pending = applyBattleAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: caster.instanceId,
      skillId: 'legacy-direct-target-probe',
    }) as any
    expect(pending.pendingTargetSelection?.source).toMatchObject({
      type: 'skill',
      id: 'legacy-direct-target-probe',
      pieceId: caster.instanceId,
    })
    expect(pending.pendingTargetSelection?.candidates).toContainEqual({ type: 'cell', x: 2, y: 1 })
    expect(pending.players[0].actionPoints).toBe(2)
    expect((pending.extensions as any).legacyRootExecutionCount).toBeUndefined()

    const session = pending.pendingTargetSelection
    const completed = applyBattleAction(pending, {
      type: 'pendingTargetSelect',
      playerId: 'player-red',
      targetX: 2,
      targetY: 1,
      selectionId: session.selectionId,
      stateRevision: session.stateRevision,
    }) as any
    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(completed.players[0].actionPoints).toBe(1)
    expect((completed.extensions as any).legacyRootExecutionCount).toBe(1)
    expect((completed.extensions as any).legacyTargetEffectCount).toBe(1)
    expect((completed.extensions as any).legacyResolvedTarget).toEqual({ x: 2, y: 1 })
    expect(completed.actions.filter((entry: any) => entry.type === 'useBasicSkill')).toHaveLength(1)
  })

  it('commits the root effect but skips a cancellable post-effect target consumer', () => {
    const caster = makePiece({ instanceId: 'legacy-cancel-caster', ownerPlayerId: 'player-red', x: 1, y: 1 }) as any
    caster.skills = [{ skillId: 'legacy-cancel-target-probe', currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({ pieces: [caster], currentPlayerId: 'player-red', phase: 'action', width: 4, height: 4 }) as any
    state.players[0].actionPoints = 2
    state.skillsById['legacy-cancel-target-probe'] = {
      id: 'legacy-cancel-target-probe',
      name: 'Legacy cancel target probe',
      description: '',
      kind: 'active',
      type: 'normal',
      cooldownTurns: 0,
      maxCharges: 0,
      powerMultiplier: 1,
      actionPointCost: 1,
      range: 0,
      requiresTarget: false,
      code: `function executeSkill(context) {
        context.battle.extensions.legacyCancelledRootCount = (context.battle.extensions.legacyCancelledRootCount || 0) + 1;
        return {
          success: true,
          pendingTargetSelection: {
            playerId: context.piece.ownerPlayerId,
            title: 'Optional post-effect target',
            targetType: 'cell',
            range: 2,
            filter: 'all',
            canCancel: true,
            effectCode: "function(ctx) { ctx.battle.extensions.legacyCancelledTargetCount = (ctx.battle.extensions.legacyCancelledTargetCount || 0) + 1; return { success: true }; }"
          }
        };
      }`,
    }

    const pending = applyBattleAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: caster.instanceId, skillId: 'legacy-cancel-target-probe',
    }) as any
    expect(pending.players[0].actionPoints).toBe(2)
    expect((pending.extensions as any).legacyCancelledRootCount).toBeUndefined()
    const session = pending.pendingTargetSelection

    const completed = applyBattleAction(pending, {
      type: 'cancelPendingSelection',
      playerId: 'player-red',
      selectionId: session.selectionId,
      stateRevision: session.stateRevision,
    } as any) as any
    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(completed.players[0].actionPoints).toBe(1)
    expect((completed.extensions as any).legacyCancelledRootCount).toBe(1)
    expect((completed.extensions as any).legacyCancelledTargetCount).toBeUndefined()
    expect(completed.actions.filter((entry: any) => entry.type === 'useBasicSkill')).toHaveLength(1)
  })
})

describe('RED-108 authoritative pending timeout resolution', () => {
  it('cancels a cancellable target and deterministically resolves the following mandatory option', () => {
    const first = timeoutPending(beginMinatoSelection(), 108)
    const second = timeoutPending(beginMinatoSelection(), 108)

    expect(first.pendingTargetSelection).toBeUndefined()
    expect(first.pendingOptionSelection).toBeUndefined()
    expect(first.extensions?.minatoAnchors || []).toEqual([])
    const firstWatcherCards = first.players[0].hand
      .filter(card => card.cardId === 'watcher-calm' || card.cardId === 'watcher-rage')
      .map(card => card.cardId)
    const secondWatcherCards = second.players[0].hand
      .filter(card => card.cardId === 'watcher-calm' || card.cardId === 'watcher-rage')
      .map(card => card.cardId)
    expect(firstWatcherCards).toHaveLength(1)
    expect(secondWatcherCards).toEqual(firstWatcherCards)
    expect(first.turn).toMatchObject({ currentPlayerId: 'player-blue', phase: 'action' })
  })

  it('selects a deterministic legal candidate when the target cannot be cancelled', () => {
    const firstPending = beginMinatoSelection()
    firstPending.pendingTargetSelection!.canCancel = false
    const secondPending = beginMinatoSelection()
    secondPending.pendingTargetSelection!.canCancel = false

    const first = timeoutPending(firstPending, 109)
    const second = timeoutPending(secondPending, 109)
    const firstAnchors = (first.extensions?.minatoAnchors || [])
      .filter((anchor: any) => anchor.sourceId === 'minato')
    const secondAnchors = (second.extensions?.minatoAnchors || [])
      .filter((anchor: any) => anchor.sourceId === 'minato')

    expect(firstAnchors).toHaveLength(1)
    expect(secondAnchors).toEqual(firstAnchors)
    expect(first.pendingTargetSelection).toBeUndefined()
    expect(first.pendingOptionSelection).toBeUndefined()
  })

  it('fails explicitly when a mandatory target has no authoritative candidate', () => {
    const pending = beginMinatoSelection()
    pending.pendingTargetSelection!.canCancel = false
    pending.map.tiles = []
    pending.turnTimer = createRunningTurnTimer(pending, 0)

    expect(() => runBattleAction(pending, {
      type: 'turnTimeout',
      now: pending.turnTimer!.deadlineAt,
      clientActionId: 'red-108-zero-candidates',
    }, { rootSeed: 110 })).toThrow(expect.objectContaining({
      code: 'PENDING_TIMEOUT_NO_CANDIDATES',
    }))
  })

  it('logs context and safely skips an impossible mandatory pending in production', () => {
    const pending = beginMinatoSelection()
    pending.pendingTargetSelection!.canCancel = false
    pending.map.tiles = []

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubEnv('NODE_ENV', 'production')
    try {
      const resolved = timeoutPending(pending, 111)

      expect(resolved.pendingTargetSelection).toBeUndefined()
      expect(resolved.pendingOptionSelection).toBeUndefined()
      expect(resolved.turn).toMatchObject({ currentPlayerId: 'player-blue', phase: 'action' })
      expect(errorSpy).toHaveBeenCalledWith(
        '[pending-timeout] invariant',
        expect.objectContaining({
          phase: 'start',
          callSite: 'applyBattleActionInternal.turnTimeout.resolveTimedOutPending',
          stack: expect.any(String),
          ownerPlayerId: 'player-red',
          selectionId: expect.any(String),
          stateRevision: expect.any(Number),
        }),
      )
    } finally {
      vi.unstubAllEnvs()
      errorSpy.mockRestore()
    }
  })
})
