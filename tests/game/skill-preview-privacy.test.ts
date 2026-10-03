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
import { toPublicBattleState } from '@/lib/game/deployment'
import { createSkillPresentation } from '@/lib/game/skill-presentation'
import { TriggerSystem } from '@/lib/game/triggers'
import { prepareAction } from '@/lib/game/targeting'
import { applyBattleAction, type BattleAction, type BattleState } from '@/lib/game/turn'
import { loadRuleById, type SkillDefinition } from '@/lib/game/skills'
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
  it.each(['authority', 'network'] as const)('keeps already visible markers without exposing private presentation (%s)', inputKind => {
    const state = publicState()
    const presentation = createSkillPresentation(state, 'player-blue', 'preview-test')
    presentation.mark({ id: 'public-cell', audience: 'public', cells: [{ x: 2, y: 2 }], label: '公开地格', icon: '◆' })
    presentation.mark({ id: 'private-cell', audience: 'owner', cells: [{ x: 3, y: 3 }], label: '秘密地格', icon: '◆' })
    const input = inputKind === 'network' ? toPublicBattleState(state, 'player-red') : state
    const expected = toPublicBattleState(state, 'player-red').extensions?.skillPresentation
    const result = previewBattleAction(input, targetedAction(input), 'player-red')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.snapshot.extensions?.skillPresentation?.markers).toEqual(expected?.markers)
  })
  it('ignores Kyoka Suigetsu in the public preview without disabling its real target rewrite', () => {
    const state = publicState()
    const aizen = asPieceInstance(makePiece({
      instanceId: 'aizen', templateId: 'dark-aizen', ownerPlayerId: 'player-blue',
      faction: 'blue', x: 1, y: 1,
    }))
    aizen.rules = [{ id: 'rule-aizen-kyoka-rewrite' }]
    aizen.initialDefinition = {
      stats: { maxHp: aizen.maxHp, attack: aizen.attack, defense: aizen.defense, moveRange: aizen.moveRange },
      skills: [], rules: ['rule-aizen-kyoka-rewrite'], statusTags: [],
    }
    aizen.statusTags = [
      { id: 'active', type: 'aizen-kyoka-active', visible: false },
      { id: 'secret', type: 'aizen-kyoka-secret', visible: false, targetPieceId: 'target', opponentPlayerId: 'player-red' },
    ]
    state.pieces.push(aizen)
    const ordinary = structuredClone(state)
    ordinary.pieces.find(piece => piece.instanceId === 'aizen')!.statusTags = []
    const action = targetedAction(state)
    const before = JSON.stringify(state)
    const preview = previewBattleAction(state, action, 'player-red')
    expect(preview.status).toBe('ready')
    expect(withoutDuration(preview)).toEqual(withoutDuration(
      previewBattleAction(ordinary, targetedAction(ordinary), 'player-red'),
    ))
    expect(JSON.stringify(state)).toBe(before)
    const isolated = createRuleExecutionContext(new TriggerSystem())
    const actual = withRuleExecutionContext(isolated, () => {
      const authority = structuredClone(state)
      authority.pieces.find(piece => piece.instanceId === 'aizen')!.rules = [loadRuleById('rule-aizen-kyoka-rewrite', true)]
      return applyBattleAction(authority, action)
    })
    expect(actual.pendingTargetSelection).toMatchObject({ playerId: 'player-blue' })
    expect(actual.pendingTargetSelection?.candidates).toContainEqual({ type: 'piece', pieceId: 'source' })
    expect(actual.pieces.find(piece => piece.instanceId === 'target')?.currentHp).toBe(12)
  })

  it.each([
    ['authority', 'venom-claw-rend'], ['network', 'venom-claw-rend'],
    ['authority', 'el-primo-punch'], ['network', 'el-primo-punch'],
  ])('keeps a self-protected Aizen preview available and identical to an unarmed Aizen (%s, %s)', (inputKind, skillId) => {
    const ordinary = publicState(skillId)
    if (skillId === 'el-primo-punch') {
      ordinary.pieces[0].templateId = 'el-primo'
      ordinary.pieces[0].attack = 4
      ordinary.pieces[0].rules = [{ id: 'rule-el-primo-injury-counter' }]
    }
    const target = ordinary.pieces.find(piece => piece.instanceId === 'target')!
    target.templateId = 'dark-aizen'
    target.rules = [{ id: 'rule-aizen-kyoka-rewrite' }, { id: 'rule-aizen-kyoka-expire' }]
    target.initialDefinition = {
      stats: { maxHp: target.maxHp, attack: target.attack, defense: target.defense, moveRange: target.moveRange },
      skills: [], rules: ['rule-aizen-kyoka-rewrite', 'rule-aizen-kyoka-expire'], statusTags: [],
    }
    const armed = structuredClone(ordinary)
    armed.pieces.find(piece => piece.instanceId === 'target')!.statusTags = [
      { id: 'active', type: 'aizen-kyoka-active', visible: false, currentUses: 1, stacks: 1 },
      { id: 'secret', type: 'aizen-kyoka-secret', visible: false, currentUses: 1, stacks: 1, targetPieceId: 'target', opponentPlayerId: 'player-red' },
    ]
    const inputs = [ordinary, armed].map(state => inputKind === 'network' ? toPublicBattleState(state, 'player-red') : state)
    const results = inputs.map(state => previewBattleAction(state, targetedAction(state, skillId), 'player-red'))
    expect(results.map(result => result.status)).toEqual(['ready', 'ready'])
    expect(withoutDuration(results[1])).toEqual(withoutDuration(results[0]))
  })

  it('ignores the actual statuses produced by casting Kyoka Suigetsu on oneself', () => {
    const state = publicState()
    const target = state.pieces.find(piece => piece.instanceId === 'target')!
    target.templateId = 'dark-aizen'
    target.skills = [{ skillId: 'aizen-kyoka-suiguetsu', currentCooldown: 0, usesRemaining: -1 }]
    target.rules = [{ id: 'rule-aizen-kyoka-rewrite' }, { id: 'rule-aizen-kyoka-expire' }]
    target.initialDefinition = {
      stats: { maxHp: target.maxHp, attack: target.attack, defense: target.defense, moveRange: target.moveRange },
      skills: target.skills, rules: ['rule-aizen-kyoka-rewrite', 'rule-aizen-kyoka-expire'], statusTags: [],
    }
    state.turn.currentPlayerId = 'player-blue'
    state.players.find(player => player.playerId === 'player-blue')!.actionPoints = 10
    state.skillsById['aizen-kyoka-suiguetsu'] = canonicalSkill('aizen-kyoka-suiguetsu')
    const draft = { type: 'useBasicSkill' as const, playerId: 'player-blue', pieceId: 'target', skillId: 'aizen-kyoka-suiguetsu' }
    const prepared = prepareAction(state, draft)
    if (prepared.kind !== 'needTarget') throw new Error('expected self target preparation')
    const armed = withRuleExecutionContext(createRuleExecutionContext(new TriggerSystem()), () => applyBattleAction(state, {
      ...draft, targetPieceId: 'target', selectionId: prepared.selectionId, stateRevision: prepared.stateRevision,
    }))
    expect(armed.pieces.find(piece => piece.instanceId === 'target')!.statusTags).toContainEqual(expect.objectContaining({ type: 'aizen-kyoka-secret', visible: false }))
    armed.turn.currentPlayerId = 'player-red'
    const ordinary = { ...armed, pieces: armed.pieces.map(piece => (
      piece.instanceId === 'target' ? { ...piece, statusTags: [] } : piece
    )) }
    const results = [ordinary, armed].map(input => previewBattleAction(input, targetedAction(input), 'player-red'))
    expect(results.map(result => result.status)).toEqual(['ready', 'ready'])
    expect(withoutDuration(results[1])).toEqual(withoutDuration(results[0]))
  })

  it.each(['authority', 'network'] as const)('does not execute secret summon rules inherited through initialDefinition (%s)', inputKind => {
    const real = publicState()
    const disguised = structuredClone(real)
    const target = disguised.pieces.find(piece => piece.instanceId === 'target')!
    const secretRules = ['rule-naruto-clone-one-hit', 'rule-naruto-clone-died', 'rule-naruto-clone-immobile']
    Object.assign(target, {
      currentHp: 99, maxHp: 99, attack: 0, moveRange: 0,
      displayCurrentHp: 12, displayMaxHp: 16, displayAttack: real.pieces[1].attack,
      displayDefense: real.pieces[1].defense, displayMoveRange: real.pieces[1].moveRange,
      displaySkills: [], displayStatusTags: [],
      rules: secretRules.map(id => ({ id })),
      statusTags: [{ id: 'secret-clone', type: 'naruto-clone', visible: false, relatedRules: secretRules }],
      initialDefinition: {
        stats: { maxHp: 99, attack: 0, defense: 0, moveRange: 0 }, skills: [], rules: secretRules,
        statusTags: [{ id: 'secret-clone', type: 'naruto-clone', visible: false, relatedRules: secretRules }],
      },
    })
    const input = inputKind === 'network' ? toPublicBattleState(disguised, 'player-red') : disguised
    const before = JSON.stringify(input)
    const realResult = previewBattleAction(real, targetedAction(real), 'player-red')
    const cloneResult = previewBattleAction(input, targetedAction(input), 'player-red')
    expect(realResult.status).toBe('ready')
    expect(withoutDuration(cloneResult)).toEqual(withoutDuration(realResult))
    if (cloneResult.status === 'ready') {
      expect(cloneResult.snapshot.pieces.find(piece => piece.instanceId === 'target')?.currentHp).toBe(6)
      expect(cloneResult.events.some(event => event.kind === 'death')).toBe(false)
    }
    expect(JSON.stringify(input)).toBe(before)
  })

  it('uses the living mirror source health instead of stale summon-time health', () => {
    const state = publicState()
    const target = state.pieces.find(piece => piece.instanceId === 'target')!
    const master = structuredClone(target)
    master.instanceId = 'master'
    master.x = 4
    master.y = 4
    master.currentHp = 12
    Object.assign(target, {
      masterPieceId: 'master', currentHp: 99, maxHp: 99,
      displayCurrentHp: 16, displayMaxHp: 16, displayStatusTags: [],
      initialDefinition: { stats: { maxHp: 99, attack: 0, defense: 0, moveRange: 0 }, skills: [], rules: ['rule-naruto-clone-one-hit'], statusTags: [] },
      rules: [{ id: 'rule-naruto-clone-one-hit' }],
    })
    state.pieces.push(master)
    const before = JSON.stringify(state)
    const result = previewBattleAction(state, targetedAction(state), 'player-red')
    expect(result.status).toBe('ready')
    if (result.status === 'ready') {
      expect(result.snapshot.pieces.find(piece => piece.instanceId === 'target')?.currentHp).toBe(6)
      expect(result.snapshot.pieces.find(piece => piece.instanceId === 'master')?.currentHp).toBe(12)
      expect(result.events.some(event => event.kind === 'death')).toBe(false)
    }
    expect(JSON.stringify(state)).toBe(before)
  })

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
