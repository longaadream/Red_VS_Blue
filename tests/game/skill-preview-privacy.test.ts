import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import {
  RANDOM_STREAM_NAMES,
  RuleRuntime,
  createRuleExecutionContext,
  withRuleExecutionContext,
  withRuleRuntime,
  withRuleRuntimeCheckpoint,
} from '@/lib/game/rule-runtime'
import { previewBattleAction } from '@/lib/game/skill-preview'
import { TriggerSystem } from '@/lib/game/triggers'
import { prepareAction } from '@/lib/game/targeting'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import type { SkillDefinition } from '@/lib/game/skills'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

function canonicalSkill(id: string): SkillDefinition {
  return JSON.parse(readFileSync(`data/skills/${id}.json`, 'utf8')) as SkillDefinition
}

function publicState(skillId = 'venom-claw-rend'): BattleState {
  const source = asPieceInstance(makePiece({
    instanceId: 'source',
    templateId: 'test-source',
    name: 'Source',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: 0,
    y: 0,
    attack: 3,
    skills: [{ skillId, currentCooldown: 0, usesRemaining: -1 }],
  }))
  const target = asPieceInstance(makePiece({
    instanceId: 'target',
    templateId: 'test-target',
    name: 'Target',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 1,
    y: 0,
    currentHp: 12,
    maxHp: 16,
  }))
  const state = makeState({ pieces: [source, target] })
  state.pieces = [source, target]
  state.players.find(player => player.playerId === 'player-red')!.actionPoints = 10
  state.skillsById = { [skillId]: canonicalSkill(skillId) }
  return state
}

function targetedAction(state: BattleState, skillId = 'venom-claw-rend'): BattleAction {
  const draft = {
    type: 'useBasicSkill' as const,
    playerId: 'player-red',
    pieceId: 'source',
    skillId,
  }
  const prepared = prepareAction(state, draft)
  if (prepared.kind !== 'needTarget') throw new Error(`expected needTarget, got ${prepared.kind}`)
  return {
    ...draft,
    targetPieceId: 'target',
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  }
}

function unknownSnapshotSkill(skillId: string, code: string): { state: BattleState; action: BattleAction } {
  const state = publicState()
  state.pieces.find(piece => piece.instanceId === 'source')!.skills = [{
    skillId,
    currentCooldown: 0,
    usesRemaining: -1,
  }]
  state.skillsById[skillId] = {
    id: skillId,
    name: 'Unknown preview skill',
    description: '',
    keywords: [],
    kind: 'active',
    type: 'normal',
    cooldownTurns: 0,
    maxCharges: 0,
    powerMultiplier: 1,
    actionPointCost: 0,
    range: 'self',
    requiresTarget: false,
    code,
  } as SkillDefinition
  return {
    state,
    action: {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'source',
      skillId,
    },
  }
}

function withoutDuration<T>(value: T): T {
  const copy = structuredClone(value) as T & { durationMs?: number }
  delete copy.durationMs
  return copy
}

describe('RED-224 engine skill-preview privacy', () => {
  it('fails closed for a canonical random skill without advancing the source runtime, including a checkpoint call', () => {
    const state = publicState('kenshin-ryutsuisen')
    const action = targetedAction(state, 'kenshin-ryutsuisen')
    const sourceRuntime = new RuleRuntime({
      rootSeed: 224,
      cursors: { [RANDOM_STREAM_NAMES.skillEffect]: 7 },
      tick: 3,
    })
    const before = sourceRuntime.snapshot()

    const directResult = previewBattleAction(state, action, 'player-red')
    const checkpointResult = withRuleRuntime(sourceRuntime, () => withRuleRuntimeCheckpoint(
      () => previewBattleAction(state, action, 'player-red'),
    ))

    expect(directResult.status).toBe('unavailable')
    expect(checkpointResult.status).toBe('unavailable')
    expect(sourceRuntime.snapshot()).toEqual(before)
    expect(sourceRuntime.getCursor(RANDOM_STREAM_NAMES.skillEffect)).toBe(7)
  })

  it('does not execute an unknown snapshot skill source', () => {
    const marker = '__red224PreviewUnknownSkillExecuted'
    delete (globalThis as Record<string, unknown>)[marker]
    const skillId = 'red224-unknown-public-skill'
    const { state, action } = unknownSnapshotSkill(
      skillId,
      `function executeSkill() { globalThis['${marker}'] = true; return { success: true }; }`,
    )

    try {
      const result = previewBattleAction(state, action, 'player-red')
      expect({ status: result.status, marker: (globalThis as Record<string, unknown>)[marker] })
        .toEqual({ status: 'unavailable', marker: undefined })
    } finally {
      delete (globalThis as Record<string, unknown>)[marker]
    }
  })

  it('does not execute an unknown snapshot skill source that reads global random', () => {
    const marker = '__red224PreviewUnknownSkillRandomExecuted'
    delete (globalThis as Record<string, unknown>)[marker]
    const skillId = 'red224-unknown-random-skill'
    const { state, action } = unknownSnapshotSkill(
      skillId,
      `function executeSkill() { globalThis['${marker}'] = globalThis.Math.random(); return { success: true }; }`,
    )

    try {
      const result = previewBattleAction(state, action, 'player-red')
      expect({ status: result.status, marker: (globalThis as Record<string, unknown>)[marker] })
        .toEqual({ status: 'unavailable', marker: undefined })
    } finally {
      delete (globalThis as Record<string, unknown>)[marker]
    }
  })

  it('keeps a public result stable when only the opponent hidden status, hand, and deck differ', () => {
    const first = publicState()
    type PlayerWithPrivateDeck = BattleState['players'][number] & Record<'deck', unknown[]>
    const opponent = first.players.find(player => player.playerId === 'player-blue') as PlayerWithPrivateDeck
    opponent.hand = [
      { cardId: 'secret-a', instanceId: 'secret-a', ownerPlayerId: 'player-blue' },
    ] as never
    opponent.deck = [
      { cardId: 'deck-a', instanceId: 'deck-a' },
      { cardId: 'deck-b', instanceId: 'deck-b' },
    ] as never

    const second = structuredClone(first)
    const secondTarget = second.pieces.find(piece => piece.instanceId === 'target')!
    secondTarget.statusTags = [{ id: 'hidden', type: 'hidden-passive', visible: false }]
    const secondOpponent = second.players.find(player => player.playerId === 'player-blue') as PlayerWithPrivateDeck
    secondOpponent.hand = [
      { cardId: 'other-secret', instanceId: 'other-secret', ownerPlayerId: 'player-blue' },
    ] as never
    secondOpponent.deck = [
      { cardId: 'other-deck-b', instanceId: 'other-deck-b' },
      { cardId: 'other-deck-a', instanceId: 'other-deck-a' },
    ] as never

    const firstResult = previewBattleAction(first, targetedAction(first), 'player-red')
    const secondResult = previewBattleAction(second, targetedAction(second), 'player-red')

    expect(firstResult.status).toBe('ready')
    expect(secondResult.status).toBe('ready')
    expect(withoutDuration(secondResult)).toEqual(withoutDuration(firstResult))
  })

  it('does not call a source compiled closure or mutate source trigger limits', () => {
    const state = publicState()
    const sourceEffect = vi.fn(() => ({ success: true }))
    const sourceRule = {
      id: 'rule-grimmjow-hunt-after-skill',
      public: true,
      trigger: { type: 'afterSkillUsed' },
      limits: { currentCooldown: 2, maxUses: 3, uses: 1 },
      effect: sourceEffect,
    }
    state.pieces[0].rules = [sourceRule as never]

    const sourceTriggerSystem = new TriggerSystem()
    sourceTriggerSystem.addRule(sourceRule as never)
    const sourceContext = createRuleExecutionContext(sourceTriggerSystem)
    const beforeLimits = structuredClone(sourceRule.limits)

    withRuleExecutionContext(sourceContext, () => {
      previewBattleAction(state, targetedAction(state), 'player-red')
    })

    expect(sourceEffect).not.toHaveBeenCalled()
    expect(sourceRule.limits).toEqual(beforeLimits)
    expect(sourceTriggerSystem.getRules()[0]?.limits).toEqual(beforeLimits)
  })

  it('applies actual damage to the public display HP for true and disguised internal targets alike', () => {
    const real = publicState()
    real.extensions = {
      skillPresentation: {
        version: 1,
        bindings: [{
          id: 'public-target',
          targetId: 'target',
          display: { currentHp: 12, maxHp: 16, attack: 5, defense: 0, moveRange: 3, skills: [], statusTags: [] },
        }],
        indicators: [],
        markers: [],
        cues: [],
      },
    }
    const disguised = structuredClone(real)
    const disguisedTarget = disguised.pieces.find(piece => piece.instanceId === 'target')!
    disguisedTarget.currentHp = 2
    disguisedTarget.maxHp = 3
    disguisedTarget.attack = 99

    const realResult = previewBattleAction(real, targetedAction(real), 'player-red')
    const disguisedResult = previewBattleAction(disguised, targetedAction(disguised), 'player-red')

    expect(realResult.status).toBe('ready')
    expect(disguisedResult.status).toBe('ready')
    expect(withoutDuration(disguisedResult)).toEqual(withoutDuration(realResult))
    if (realResult.status !== 'ready' || disguisedResult.status !== 'ready') return
    expect(realResult.snapshot.pieces.find(piece => piece.instanceId === 'target')?.currentHp).toBe(6)
    expect(disguisedResult.snapshot.pieces.find(piece => piece.instanceId === 'target')?.currentHp).toBe(6)
  })
})
