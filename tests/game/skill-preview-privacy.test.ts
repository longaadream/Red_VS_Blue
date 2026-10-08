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

function armorCardState(selectedOption: readonly [string, string]): { state: BattleState; cardId: string; cardInstanceId: string } {
  const armor = canonicalSkill('tails-armor-assembly')
  const tails = asPieceInstance(makePiece({
    instanceId: 'tails', templateId: 'tails', name: 'Tails', ownerPlayerId: 'player-red', faction: 'red',
    x: 0, y: 0, attack: 3,
    skills: [{ skillId: armor.id, currentCooldown: 0, usesRemaining: -1 }],
  }))
  const ally = asPieceInstance(makePiece({
    instanceId: 'ally', templateId: 'test-ally', name: 'Ally', ownerPlayerId: 'player-red', faction: 'red',
    x: 1, y: 0, attack: 4, defense: 1, currentHp: 8, maxHp: 16,
  }))
  const state = makeState({ pieces: [tails, ally] })
  state.pieces = [tails, ally]
  state.skillsById = { [armor.id]: armor }
  state.players[0].actionPoints = 10
  state.players[0].chargePoints = 2

  const selecting = applyBattleAction(state, {
    type: 'useChargeSkill', playerId: 'player-red', pieceId: 'tails', skillId: armor.id,
  })
  const pending = selecting.pendingOptionSelection
  if (!pending) throw new Error('Armor Assembly did not request module selection')
  const resolved = applyBattleAction(selecting, {
    type: 'pendingOptionSelect', playerId: 'player-red', selectedOption,
    selectionId: pending.selectionId, stateRevision: pending.stateRevision,
  })
  const card = resolved.players[0].hand.find(entry => entry.cardId.startsWith('armor-'))
  if (!card) throw new Error('Armor Assembly did not create a card')
  return { state: resolved, cardId: card.cardId, cardInstanceId: card.instanceId }
}

function demonSummonStoredCardFixture(storage: 'owner-scoped' | 'legacy'): { state: BattleState; action: BattleAction } {
  const anchor = asPieceInstance(makePiece({
    instanceId: 'demon-anchor', templateId: 'red-anchor', name: 'Sacrifice', ownerPlayerId: 'player-red', faction: 'red',
    x: 0, y: 0, currentHp: 20, maxHp: 20, attack: 3,
  }))
  const state = makeState({ pieces: [anchor], width: 4, height: 4 })
  state.pieces = [anchor]
  state.players[0].actionPoints = 3
  state.players[0].hand = [{ cardId: 'demon-summon-5', instanceId: 'demon-card-5', ownerPlayerId: 'player-red', actionPointCost: 3 }]
  const stored = {
    instanceId: 'stored-kiljaedan', templateId: 'kiljaedan', name: 'Kiljaedan', ownerPlayerId: 'player-red', faction: 'red',
    x: 0, y: 0, currentHp: 99, maxHp: 99, attack: 44, defense: 3, moveRange: 4,
    skills: [], rules: [], statusTags: [],
  }
  if (storage === 'owner-scoped') {
    ;(state.extensions as Record<string, unknown>).kiljaedanPiecesByPlayerId = { 'player-red': stored }
  } else {
    ;(state.extensions as Record<string, unknown>).kiljaedanPiece = stored
  }
  const draft: BattleAction = { type: 'playCard', playerId: 'player-red', cardInstanceId: 'demon-card-5' }
  const preparation = prepareAction(state, draft)
  if (preparation.kind !== 'needTarget') throw new Error(`expected demon target prompt, got ${preparation.kind}`)
  return {
    state,
    action: {
      ...draft,
      targetPieceId: anchor.instanceId,
      targetX: 0,
      targetY: 0,
      extraTargets: [{ x: 2, y: 2 }],
      selectionId: preparation.selectionId,
      stateRevision: preparation.stateRevision,
    },
  }
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
  it('does not let an existing Armor Assembly registry disable later public previews', () => {
    const armor = canonicalSkill('tails-armor-assembly')
    const knownSkill = canonicalSkill('venom-claw-rend')
    const source = asPieceInstance(makePiece({
      instanceId: 'source',
      templateId: 'tails',
      name: 'Tails',
      ownerPlayerId: 'player-red',
      faction: 'red',
      x: 0,
      y: 0,
      attack: 3,
      skills: [
        { skillId: armor.id, currentCooldown: 0, usesRemaining: -1 },
        { skillId: knownSkill.id, currentCooldown: 0, usesRemaining: -1 },
      ],
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
    state.players.find(player => player.playerId === 'player-red')!.chargePoints = 2
    state.skillsById = { [armor.id]: armor, [knownSkill.id]: knownSkill }

    const armorPreviewInput = JSON.stringify(state)
    const armorPreview = previewBattleAction(state, {
      type: 'useChargeSkill', playerId: 'player-red', pieceId: 'source', skillId: armor.id,
      selectedOption: ['heal', 'attack'],
    }, 'player-red')
    expect(armorPreview.status).toBe('unavailable')
    expect(JSON.stringify(armorPreview)).not.toContain('function executeCard')
    expect(JSON.stringify(state)).toBe(armorPreviewInput)

    const existingRegistryState = structuredClone(state)
    existingRegistryState.customCards = {
      'armor-attack-heal': {
        id: 'armor-attack-heal', name: 'existing armor', description: '', type: 'active',
        actionPointCost: 2, code: "function executeCard() { return { success: true } }",
      },
    }
    const existingRegistryInput = JSON.stringify(existingRegistryState)
    const changedRegistryPreview = previewBattleAction(existingRegistryState, {
      type: 'useChargeSkill', playerId: 'player-red', pieceId: 'source', skillId: armor.id,
      selectedOption: ['heal', 'attack'],
    }, 'player-red')
    expect(changedRegistryPreview.status).toBe('unavailable')
    expect(JSON.stringify(existingRegistryState)).toBe(existingRegistryInput)

    const selecting = applyBattleAction(state, {
      type: 'useChargeSkill', playerId: 'player-red', pieceId: 'source', skillId: armor.id,
    })
    const pending = selecting.pendingOptionSelection
    if (!pending) throw new Error('Armor Assembly did not request module selection')
    const afterArmor = applyBattleAction(selecting, {
      type: 'pendingOptionSelect', playerId: 'player-red', selectedOption: ['heal', 'attack'],
      selectionId: pending.selectionId, stateRevision: pending.stateRevision,
    })

    expect(afterArmor.customCards).toMatchObject({
      'armor-attack-heal': expect.objectContaining({ type: 'active' }),
    })
    const knownPreview = previewBattleAction(afterArmor, targetedAction(afterArmor, knownSkill.id), 'player-red')
    expect(knownPreview.status).toBe('ready')
    expect(JSON.stringify(knownPreview)).not.toContain('function executeCard')
    if (knownPreview.status === 'ready') expect(knownPreview.snapshot.customCards).toBeUndefined()
    const moveAction: BattleAction = {
      type: 'move', playerId: 'player-red', pieceId: 'source',
      path: [{ x: 0, y: 1 }], toX: 0, toY: 1,
    }
    expect(previewBattleAction(afterArmor, moveAction, 'player-red').status).toBe('ready')
  })

  it.each(['playCard', 'useCard'] as const)('keeps an unknown %s action unavailable without touching card code', type => {
    const marker = '__red241PreviewCardCodeExecuted'
    delete (globalThis as Record<string, unknown>)[marker]
    const state = publicState()
    state.players[0].hand = [{ cardId: 'unknown-preview-card', instanceId: 'unknown-card', ownerPlayerId: 'player-red' }]
    state.customCards = {
      'unknown-preview-card': {
        id: 'unknown-preview-card', name: 'unknown preview card', description: '', type: 'active',
        actionPointCost: 0,
        code: `function executeCard() { globalThis.${marker} = true; return { success: true } }`,
      },
    }
    const before = JSON.stringify(state)
    try {
      const result = previewBattleAction(state, {
        type, playerId: 'player-red', cardInstanceId: 'unknown-card', cardId: 'unknown-preview-card',
      } as unknown as BattleAction, 'player-red')
      expect(result).toEqual(expect.objectContaining({ status: 'unavailable', reason: 'preview-unavailable' }))
      expect(JSON.stringify(result)).not.toContain('function executeCard')
      expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined()
      expect(JSON.stringify(state)).toBe(before)
    } finally {
      delete (globalThis as Record<string, unknown>)[marker]
    }
  })

  it.each([
    ['move', 'beforeMove', (state: BattleState): BattleAction => {
      const source = state.pieces.find(piece => piece.instanceId === 'source')!
      if (source.x === null || source.y === null) throw new Error('Preview source is not on the board')
      return {
        type: 'move', playerId: 'player-red', pieceId: 'source',
        path: [{ x: source.x, y: source.y + 1 }], toX: source.x, toY: source.y + 1,
      }
    }],
    ['skill', 'beforeSkillUse', (state: BattleState): BattleAction => targetedAction(state)],
  ] as const)('rejects an unknown own-hand reactive card while previewing a %s without executing its code', (_kind, triggerType, actionFor) => {
    const marker = '__red241UnknownReactivePreviewExecuted'
    delete (globalThis as Record<string, unknown>)[marker]
    const state = publicState()
    state.players[0].hand = [{
      cardId: 'unknown-reactive-preview-card', instanceId: 'unknown-reactive-card', ownerPlayerId: 'player-red',
    }]
    state.customCards = {
      'unknown-reactive-preview-card': {
        id: 'unknown-reactive-preview-card', name: 'unknown reactive preview card', description: '', type: 'reactive',
        trigger: { type: triggerType },
        code: `function executeCard() { globalThis.${marker} = true; return { success: true }; }`,
      },
    }
    const before = JSON.stringify(state)
    try {
      const result = previewBattleAction(state, actionFor(state), 'player-red')
      expect(result).toEqual(expect.objectContaining({ status: 'unavailable', reason: 'preview-unavailable' }))
      expect(JSON.stringify(result)).not.toContain('function executeCard')
      expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined()
      expect(JSON.stringify(state)).toBe(before)
    } finally {
      delete (globalThis as Record<string, unknown>)[marker]
    }
  })

  it('uses the canonical static card when the snapshot supplies a same-ID override', () => {
    const marker = '__red241CanonicalCardOverrideExecuted'
    delete (globalThis as Record<string, unknown>)[marker]
    const state = publicState()
    state.players[0].hand = [{ cardId: 'holy-smite', instanceId: 'canonical-card', ownerPlayerId: 'player-red' }]
    state.customCards = {
      'holy-smite': {
        id: 'holy-smite', name: 'forged holy smite', description: '', type: 'active', actionPointCost: 0,
        targeting: { steps: [{ type: 'piece', filter: 'ally' }] },
        code: `function executeCard() { globalThis.${marker} = true; return { success: true }; }`,
      },
    }
    const action = { type: 'playCard', playerId: 'player-red', cardInstanceId: 'canonical-card' } as BattleAction
    const before = JSON.stringify(state)
    try {
      const result = previewBattleAction(state, action, 'player-red')
      expect(result.status).toBe('ready')
      expect(JSON.stringify(result)).not.toContain('forged holy smite')
      expect(JSON.stringify(result)).not.toContain('function executeCard')
      expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined()
      if (result.status === 'ready') {
        expect(result.snapshot.pieces.find(piece => piece.instanceId === 'target')?.currentHp).toBe(7)
      }
      expect(JSON.stringify(state)).toBe(before)
    } finally {
      delete (globalThis as Record<string, unknown>)[marker]
    }
  })

  it.each(['owner-scoped', 'legacy'] as const)('does not predict private stored Kiljaedan data for demon-summon-5 (%s)', storage => {
    const fixture = demonSummonStoredCardFixture(storage)
    const authority = applyBattleAction(structuredClone(fixture.state), fixture.action)
    const summoned = authority.pieces.find(piece => piece.instanceId === 'stored-kiljaedan')
    expect(summoned).toMatchObject({ currentHp: 99, maxHp: 99, attack: 44, x: 2, y: 2 })

    const before = JSON.stringify(fixture.state)
    const preview = previewBattleAction(fixture.state, fixture.action, 'player-red')
    expect(preview.status).toBe('unavailable')
    expect(JSON.stringify(preview)).not.toContain('kiljaedanPiecesByPlayerId')
    expect(JSON.stringify(preview)).not.toContain('kiljaedanPiece')
    expect(JSON.stringify(preview)).not.toContain('stored-kiljaedan')
    expect(JSON.stringify(fixture.state)).toBe(before)
  })

  it.each([
    ['holy-smite', 'target', 5],
    ['holy-heal', 'ally', 8],
  ] as const)('previews deterministic canonical %s card effects without exposing source', (cardId, kind, amount) => {
    const source = asPieceInstance(makePiece({
      instanceId: 'card-source', templateId: 'test-source', ownerPlayerId: 'player-red',
      faction: 'red', x: 0, y: 0,
      currentHp: kind === 'ally' ? 8 : 20, maxHp: 20,
    }))
    const target = asPieceInstance(makePiece({
      instanceId: 'card-target', templateId: 'test-target', ownerPlayerId: kind === 'ally' ? 'player-red' : 'player-blue',
      faction: kind === 'ally' ? 'red' : 'blue', x: 1, y: 0,
      currentHp: kind === 'ally' ? 4 : 20, maxHp: 20,
    }))
    const state = makeState({ pieces: [source, target] })
    state.pieces = [source, target]
    state.players[0].actionPoints = 10
    state.players[0].hand = [{ cardId, instanceId: `card-${cardId}`, ownerPlayerId: 'player-red', actionPointCost: 1 }]
    const action = { type: 'playCard', playerId: 'player-red', cardInstanceId: `card-${cardId}` } as BattleAction
    const before = JSON.stringify(state)
    const authority = applyBattleAction(structuredClone(state), action)
    const preview = previewBattleAction(state, action, 'player-red')

    expect(preview.status).toBe('ready')
    expect(JSON.stringify(preview)).not.toContain('function executeCard')
    expect(JSON.stringify(state)).toBe(before)
    if (preview.status !== 'ready') return
    const authorityPiece = authority.pieces.find(piece => piece.instanceId === 'card-target')!
    const previewPiece = preview.snapshot.pieces.find(piece => piece.instanceId === 'card-target')!
    if (kind === 'target') expect(authorityPiece.currentHp - previewPiece.currentHp).toBe(0)
    else expect(previewPiece.currentHp).toBe(authorityPiece.currentHp)
    expect(previewPiece.currentHp).toBe(kind === 'target' ? 20 - amount : 12)
    expect(preview.snapshot.players[0].hand).toEqual([])
  })

  it.each([
    [['heal', 'attack'], 'armor-attack-heal'],
    [['heal', 'speed'], 'armor-heal-speed'],
    [['heal', 'defense'], 'armor-defense-heal'],
    [['attack', 'speed'], 'armor-attack-speed'],
    [['attack', 'defense'], 'armor-attack-defense'],
    [['speed', 'defense'], 'armor-defense-speed'],
  ] as const)('previews canonical generated Armor card %s', (selectedOption, expectedCardId) => {
    const { state, cardId, cardInstanceId } = armorCardState(selectedOption)
    expect(cardId).toBe(expectedCardId)
    const draft = { type: 'playCard', playerId: 'player-red', cardInstanceId } as BattleAction
    const preparation = previewBattleAction(state, draft, 'player-red')
    expect(preparation.status).toBe('needs-input')
    if (preparation.status !== 'needs-input') return
    expect(preparation.preparation).toMatchObject({ kind: 'needTarget', source: { type: 'card', id: cardId } })
    const prepared = prepareAction(state, draft)
    if (prepared.kind !== 'needTarget') throw new Error(`expected Armor target prompt, got ${prepared.kind}`)
    const action = {
      ...draft,
      targetPieceId: 'ally',
      selectionId: prepared.selectionId,
      stateRevision: prepared.stateRevision,
    } as BattleAction
    const before = JSON.stringify(state)
    const authority = applyBattleAction(structuredClone(state), action)
    const preview = previewBattleAction(state, action, 'player-red')
    expect(preview.status).toBe('ready')
    expect(JSON.stringify(state)).toBe(before)
    expect(JSON.stringify(preview)).not.toContain('function executeCard')
    if (preview.status !== 'ready') return
    const authorityAlly = authority.pieces.find(piece => piece.instanceId === 'ally')!
    const previewAlly = preview.snapshot.pieces.find(piece => piece.instanceId === 'ally')!
    expect(previewAlly.attack).toBe(authorityAlly.attack)
    expect(previewAlly.defense).toBe(authorityAlly.defense)
    expect(previewAlly.statusTags.map(tag => tag.type).sort()).toEqual(authorityAlly.statusTags.map(tag => tag.type).sort())
    expect(preview.snapshot.customCards).toBeUndefined()
  })

  it('rejects forged generated Armor definitions before card code can run', () => {
    const { state, cardId, cardInstanceId } = armorCardState(['heal', 'attack'])
    const forged = state.customCards![cardId]
    forged.code = "function executeCard(context){ globalThis.__red241ForgedCard = true; return { success: true } }"
    forged.actionPointCost = 0
    const before = JSON.stringify(state)
    const preview = previewBattleAction(state, {
      type: 'playCard', playerId: 'player-red', cardInstanceId,
    } as BattleAction, 'player-red')
    expect(preview.status).toBe('unavailable')
    expect(JSON.stringify(preview)).not.toContain('function executeCard')
    expect((globalThis as Record<string, unknown>).__red241ForgedCard).toBeUndefined()
    expect(JSON.stringify(state)).toBe(before)
  })

  it.each([
    ['missing', 'does-not-exist'],
    ['opponent', 'opponent-card'],
  ] as const)('rejects a %s hand card root before execution', (_label, cardInstanceId) => {
    const state = publicState()
    state.players[0].hand = [{ cardId: 'holy-smite', instanceId: 'red-card', ownerPlayerId: 'player-red' }]
    state.players[1].hand = [{ cardId: 'holy-smite', instanceId: 'opponent-card', ownerPlayerId: 'player-blue' }]
    const preview = previewBattleAction(state, {
      type: 'playCard', playerId: 'player-red', cardInstanceId,
    } as BattleAction, 'player-red')
    expect(preview.status).toBe('unavailable')
  })

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
