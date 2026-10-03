import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { previewBattleAction } from '@/lib/game/skill-preview'
import { createPublicRuleSource } from '@/lib/game/public-rule-source'
import { applyBattleAction, type BattleAction, type BattleState } from '@/lib/game/turn'
import { prepareAction } from '@/lib/game/targeting'
import type { SkillDefinition } from '@/lib/game/skills'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

function venomClaw(): SkillDefinition {
  return JSON.parse(readFileSync('data/skills/venom-claw-rend.json', 'utf8')) as SkillDefinition
}

function skill(id: string): SkillDefinition {
  return JSON.parse(readFileSync(`data/skills/${id}.json`, 'utf8')) as SkillDefinition
}

function publicFixture(): BattleState {
  const source = asPieceInstance(makePiece({
    instanceId: 'venom',
    templateId: 'red-venom',
    name: '毒液',
    ownerPlayerId: 'player-red',
    faction: 'evil',
    x: 0,
    y: 0,
    attack: 3,
    skills: [{ skillId: 'venom-claw-rend', currentCooldown: 0, usesRemaining: -1 }],
  }))
  const target = asPieceInstance(makePiece({
    instanceId: 'uther',
    templateId: 'uther',
    name: '乌瑟尔',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 1,
    y: 0,
    currentHp: 10,
    maxHp: 14,
  }))
  const state = makeState({ pieces: [source, target] })
  state.pieces = [source, target]
  state.skillsById = { 'venom-claw-rend': venomClaw() }
  return state
}

function targetedAction(state: BattleState): BattleAction {
  const draft = {
    type: 'useBasicSkill' as const,
    playerId: 'player-red',
    pieceId: 'venom',
    skillId: 'venom-claw-rend',
  }
  const prepared = prepareAction(state, draft)
  if (prepared.kind !== 'needTarget') throw new Error(`expected needTarget, got ${prepared.kind}`)
  return { ...draft, targetPieceId: 'uther', selectionId: prepared.selectionId, stateRevision: prepared.stateRevision }
}

function pieceTargetAction(state: BattleState, skillId: string, targetPieceId: string): BattleAction {
  const draft = {
    type: 'useBasicSkill' as const,
    playerId: 'player-red',
    pieceId: 'venom',
    skillId,
  }
  const prepared = prepareAction(state, draft)
  if (prepared.kind !== 'needTarget') throw new Error(`expected needTarget, got ${prepared.kind}`)
  return { ...draft, targetPieceId, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision }
}

function withoutDuration<T>(value: T): T {
  const copy = structuredClone(value) as T & { durationMs?: number }
  delete copy.durationMs
  return copy
}

describe('RED-224 isolated public skill preview', () => {
  it('previews a public single target skill and matches applyBattleAction', () => {
    const state = publicFixture()
    const action = targetedAction(state)
    const before = JSON.stringify(state)
    const actual = applyBattleAction(structuredClone(state), action)
    const result = previewBattleAction(state, action, 'player-red')

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.snapshot.pieces.find(piece => piece.instanceId === 'uther')?.currentHp)
      .toBe(actual.pieces.find(piece => piece.instanceId === 'uther')?.currentHp)
    expect(result.snapshot.players.find(player => player.playerId === 'player-red')?.actionPoints)
      .toBe(actual.players.find(player => player.playerId === 'player-red')?.actionPoints)
    expect(result.events.some(event => event.kind === 'damage')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('previewCode')
    expect(JSON.stringify(result)).not.toContain('venom-claw-rend-random')
    expect(JSON.stringify(state)).toBe(before)
  })

  it('does not use pending continuation, multi-target input, or another player action', () => {
    const state = publicFixture()
    const action = targetedAction(state)
    expect(previewBattleAction({ ...state, pendingTargetSelection: {} as never }, action, 'player-red').status)
      .toBe('needs-input')
    expect(previewBattleAction(state, { ...action, extraTargets: [{ pieceId: 'uther' }] } as BattleAction, 'player-red').status)
      .toBe('unavailable')
    expect(previewBattleAction(state, action, 'player-blue').status).toBe('unavailable')
    expect(previewBattleAction(state, { ...action, type: 'move' } as BattleAction, 'player-red').status)
      .toBe('unavailable')
  })

  it('fails closed for hidden rules and private extensions without returning them', () => {
    const state = publicFixture()
    const action = targetedAction(state)
    state.pieces[0].rules = [{ id: 'private-rule', effect: () => 'secret' }]
    state.extensions = { secret: { rootSeed: 999, trace: ['private'] } }

    const result = previewBattleAction(state, action, 'player-red')
    expect(result).toEqual(expect.objectContaining({ status: 'unavailable', reason: 'preview-unavailable' }))
    expect(JSON.stringify(result)).not.toContain('private-rule')
    expect(JSON.stringify(result)).not.toContain('rootSeed')
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('fails closed for skill code that accesses preview randomness', () => {
    const state = publicFixture()
    const action = targetedAction(state)
    const marker = '__red224PreviewSnapshotCodeExecuted__'
    delete (globalThis as Record<string, unknown>)[marker]
    state.skillsById['venom-claw-rend'] = {
      ...state.skillsById['venom-claw-rend'],
      code: `function executeSkill(context) { globalThis.${marker} = true; var n = Math.random(); return { success: !!n }; }`,
    }
    const result = previewBattleAction(state, action, 'player-red')
    expect(result).toEqual(expect.objectContaining({ status: 'unavailable', reason: 'preview-unavailable' }))
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined()
    delete (globalThis as Record<string, unknown>)[marker]
  })

  it('fails closed when a canonical skill consumes preview randomness', () => {
    const state = publicFixture()
    state.pieces[0].skills = [{ skillId: 'kenshin-ryutsuisen', currentCooldown: 0, usesRemaining: -1 }]
    state.skillsById = { 'kenshin-ryutsuisen': skill('kenshin-ryutsuisen') }
    const action = pieceTargetAction(state, 'kenshin-ryutsuisen', 'uther')
    const result = previewBattleAction(state, action, 'player-red')
    expect(result).toEqual(expect.objectContaining({ status: 'unavailable', reason: 'preview-unavailable' }))
  })

  it('keeps the result stable when hidden status, rule, and deck order differ', () => {
    const first = publicFixture()
    ;(first.players[0] as typeof first.players[number] & { deck: unknown[] }).deck = [
      { cardId: 'secret-a', instanceId: 'deck-a' },
      { cardId: 'secret-b', instanceId: 'deck-b' },
    ]
    ;(first.players[1] as typeof first.players[number] & { deck: unknown[] }).deck = [
      { cardId: 'opponent-a', instanceId: 'opponent-a' },
    ]
    const second = structuredClone(first)
    const secondTarget = second.pieces.find(piece => piece.instanceId === 'uther')!
    secondTarget.statusTags = [{ id: 'hidden', type: 'hidden-passive', visible: false }]
    secondTarget.rules = [{ id: 'secret-rule-not-proven' }]
    ;(second.players[0] as typeof second.players[number] & { deck: unknown[] }).deck.reverse()
    ;(second.players[1] as typeof second.players[number] & { deck: unknown[] }).deck = [
      { cardId: 'opponent-secret', instanceId: 'opponent-secret' },
    ]

    const firstResult = previewBattleAction(first, targetedAction(first), 'player-red')
    const secondResult = previewBattleAction(second, targetedAction(second), 'player-red')
    expect(withoutDuration(secondResult)).toEqual(withoutDuration(firstResult))
    expect(JSON.stringify(firstResult)).not.toContain('secret-a')
    expect(JSON.stringify(secondResult)).not.toContain('secret-rule-not-proven')
    if (firstResult.status === 'ready') {
      expect(firstResult.snapshot.players[0]).not.toHaveProperty('deck')
      expect(firstResult.snapshot.players[1]).not.toHaveProperty('deck')
    }
  })

  it('keeps a public preview available when the state already has a graveyard', () => {
    const state = publicFixture()
    const dead = structuredClone(state.pieces[1])
    dead.instanceId = 'dead-uther'
    dead.currentHp = 0
    state.graveyard.push(dead)

    const result = previewBattleAction(state, targetedAction(state), 'player-red')
    expect(result.status).toBe('ready')
  })

  it('drops unknown extensions without changing public availability', () => {
    const first = publicFixture()
    const second = structuredClone(first)
    second.extensions = { privateFoo: { hiddenRule: 'secret', trace: [1, 2, 3] } }

    const firstResult = previewBattleAction(first, targetedAction(first), 'player-red')
    const secondResult = previewBattleAction(second, targetedAction(second), 'player-red')
    expect(withoutDuration(secondResult)).toEqual(withoutDuration(firstResult))
  })

  it('materializes a public display binding before running a hidden clone', () => {
    const real = publicFixture()
    const target = real.pieces.find(piece => piece.instanceId === 'uther')!
    target.currentHp = 12
    target.maxHp = 16
    target.attack = 5
    real.extensions = {
      skillPresentation: {
        version: 1,
        bindings: [{
          id: 'public-clone',
          targetId: 'uther',
          display: { currentHp: 12, maxHp: 16, attack: 5, defense: 0, moveRange: 3, skills: [], statusTags: [] },
        }],
        indicators: [],
        markers: [],
        cues: [],
      },
    }
    const clone = structuredClone(real)
    const cloneTarget = clone.pieces.find(piece => piece.instanceId === 'uther')!
    cloneTarget.currentHp = 1
    cloneTarget.maxHp = 1
    cloneTarget.attack = 99
    Object.assign(cloneTarget as typeof cloneTarget & Record<string, unknown>, {
      masterPieceId: 'private-master',
      displayCurrentHp: 12,
      displayMaxHp: 16,
      displayAttack: 5,
    })

    const realResult = previewBattleAction(real, targetedAction(real), 'player-red')
    const cloneResult = previewBattleAction(clone, targetedAction(clone), 'player-red')
    expect(withoutDuration(cloneResult)).toEqual(withoutDuration(realResult))
    if (cloneResult.status === 'ready') {
      expect(cloneResult.snapshot.pieces.find(piece => piece.instanceId === 'uther')?.currentHp).toBe(6)
      expect(JSON.stringify(cloneResult)).not.toContain('private-master')
    }
  })

  it('hydrates canonical public status rules in the fresh scope', () => {
    const state = publicFixture()
    const ally = state.pieces.find(piece => piece.instanceId === 'uther')!
    ally.ownerPlayerId = 'player-red'
    ally.faction = 'evil'
    ally.currentHp = 8
    ally.skills = []
    state.pieces[0].skills = [{ skillId: 'shield-of-light', currentCooldown: 0, usesRemaining: -1 }]
    state.skillsById = { 'shield-of-light': skill('shield-of-light') }
    const action = pieceTargetAction(state, 'shield-of-light', 'uther')
    const actual = applyBattleAction(structuredClone(state), action)
    const result = previewBattleAction(state, action, 'player-red')

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.snapshot.pieces.find(piece => piece.instanceId === 'uther')?.statusTags)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'divine-shield' })]))
    expect(result.snapshot.pieces.find(piece => piece.instanceId === 'uther')?.statusTags?.map(status => ({
      type: status.type,
      currentDuration: status.currentDuration,
      currentUses: status.currentUses,
      intensity: status.intensity,
      stacks: status.stacks,
    }))).toEqual(actual.pieces.find(piece => piece.instanceId === 'uther')?.statusTags?.map(status => ({
      type: status.type,
      currentDuration: status.currentDuration,
      currentUses: status.currentUses,
      intensity: status.intensity,
      stacks: status.stacks,
    })))
  })

  it.each([
    ['hydrated opponent rule', false],
    ['serialized opponent rule omitted', true],
  ])('hydrates a public opponent initial passive when %s', (_label, omitRule) => {
    const state = publicFixture()
    const target = state.pieces.find(piece => piece.instanceId === 'uther')!
    Object.assign(target as typeof target & Record<string, unknown>, {
      initialDefinition: { rules: ['rule-divine-shield'] },
      statusTags: [{
        id: 'divine-shield',
        type: 'divine-shield',
        visible: true,
        currentDuration: -1,
        currentUses: -1,
        intensity: 1,
        stacks: 1,
        relatedRules: ['rule-divine-shield'],
      }],
      rules: omitRule ? undefined : [{ id: 'rule-divine-shield' }],
    })
    const action = targetedAction(state)
    const actual = applyBattleAction(structuredClone(state), action)
    const result = previewBattleAction(state, action, 'player-red')

    expect(actual.pieces.find(piece => piece.instanceId === 'uther')?.currentHp).toBe(10)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.snapshot.pieces.find(piece => piece.instanceId === 'uther')?.currentHp)
      .toBe(actual.pieces.find(piece => piece.instanceId === 'uther')?.currentHp)
    expect(result.snapshot.pieces.find(piece => piece.instanceId === 'uther')?.statusTags)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'divine-shield' })]))
  })

  it('previews canonical movement and healing effects without exposing rule sources', () => {
    const moveState = publicFixture()
    moveState.pieces[0].skills = [{ skillId: 'blink', currentCooldown: 0, usesRemaining: -1 }]
    moveState.skillsById = { blink: skill('blink') }
    const moveDraft = { type: 'useBasicSkill' as const, playerId: 'player-red', pieceId: 'venom', skillId: 'blink' }
    const movePrepared = prepareAction(moveState, moveDraft)
    if (movePrepared.kind !== 'needTarget') throw new Error(`expected needTarget, got ${movePrepared.kind}`)
    const moveAction = { ...moveDraft, targetX: 2, targetY: 0, selectionId: movePrepared.selectionId, stateRevision: movePrepared.stateRevision }
    const moveResult = previewBattleAction(moveState, moveAction, 'player-red')
    expect(moveResult.status).toBe('ready')
    if (moveResult.status === 'ready') {
      expect(moveResult.snapshot.pieces.find(piece => piece.instanceId === 'venom')).toMatchObject({ x: 2, y: 0 })
      expect(JSON.stringify(moveResult)).not.toContain('rule-')
    }

    const healState = publicFixture()
    healState.pieces[1].ownerPlayerId = 'player-red'
    healState.pieces[1].faction = 'evil'
    healState.pieces[1].currentHp = 5
    healState.pieces[0].skills = [{ skillId: 'light-of-the-light', currentCooldown: 0, usesRemaining: -1 }]
    healState.skillsById = { 'light-of-the-light': skill('light-of-the-light') }
    const healAction = pieceTargetAction(healState, 'light-of-the-light', 'uther')
    const healResult = previewBattleAction(healState, healAction, 'player-red')
    expect(healResult.status).toBe('ready')
    if (healResult.status === 'ready') {
      expect(healResult.snapshot.pieces.find(piece => piece.instanceId === 'uther')?.currentHp).toBe(10)
      expect(healResult.events.some(event => event.kind === 'heal')).toBe(true)
    }
  })

  it('keeps public tile effects in the ready preview snapshot', () => {
    const state = publicFixture()
    state.extensions = {
      tileEffects: [{
        id: 'amaterasu-1',
        tileType: 'amaterasu',
        x: 1,
        y: 0,
      }],
    }

    const result = previewBattleAction(state, targetedAction(state), 'player-red')

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.snapshot.extensions?.tileEffects).toEqual([
      expect.objectContaining({ id: 'amaterasu-1', tileType: 'amaterasu', x: 1, y: 0 }),
    ])
  })

  it('previews newly created tiles from the real Amaterasu skill, without spending real AP', () => {
    const state = publicFixture()
    const source = state.pieces[0]
    source.skills = [{ skillId: 'sasuke-amaterasu', currentCooldown: 0, usesRemaining: -1 }]
    state.skillsById = { 'sasuke-amaterasu': skill('sasuke-amaterasu') }
    const draft = { type: 'useBasicSkill' as const, playerId: 'player-red', pieceId: source.instanceId, skillId: 'sasuke-amaterasu' }
    const prepared = prepareAction(state, draft)
    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    const action = { ...draft, targetX: 2, targetY: 2, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision }
    const before = JSON.stringify(state)
    const actualTiles = applyBattleAction(structuredClone(state), action)
    expect(actualTiles.extensions?.tileEffects).toHaveLength(9)
    const result = previewBattleAction(state, action, 'player-red')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.snapshot.extensions?.tileEffects).toHaveLength(9)
    expect(result.snapshot.extensions?.tileEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ tileType: 'amaterasu', x: 2, y: 2 }),
    ]))
    expect(JSON.stringify(state)).toBe(before)
  })

  it('allows newly attached viewer rules but still rejects undeclared opponent rule sources', () => {
    const state = publicFixture()
    const owned = createPublicRuleSource(state, 'player-red')
    expect(owned.ruleResolver?.(state, 'rule-sasuke-amaterasu-move', { sourceId: 'player-red' })).toMatchObject({ id: 'rule-sasuke-amaterasu-move' })
    expect(owned.hasUnsupportedAccess()).toBe(false)
    const opponent = createPublicRuleSource(state, 'player-red')
    expect(opponent.ruleResolver?.(state, 'rule-sasuke-amaterasu-move', { sourceId: 'player-blue' })).toBeNull()
    expect(opponent.hasUnsupportedAccess()).toBe(true)
  })

  it('skips a public reaction that requests input and retries from a fresh state', () => {
    const state = publicFixture()
    const target = state.pieces.find(piece => piece.instanceId === 'uther')!
    target.statusTags = [{
      id: 'grimm-hunt-status',
      type: 'grimmjow-hunt',
      visible: true,
      relatedRules: ['rule-grimmjow-hunt-after-skill'],
    }]
    target.rules = [{ id: 'rule-grimmjow-hunt-after-skill', public: true }]
    const action = targetedAction(state)
    const authoritative = applyBattleAction(structuredClone(state), action)
    expect(authoritative.pendingTargetSelection).toBeDefined()

    const result = previewBattleAction(state, action, 'player-red')
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.snapshot.pieces.find(piece => piece.instanceId === 'uther')?.currentHp)
      .toBe(4)
    expect(result.snapshot.pendingTargetSelection).toBeUndefined()
  })
})
