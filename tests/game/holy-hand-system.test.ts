/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-authored skills expose dynamic runtime fields. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { executeCardFunction, executeSkillFunction, loadCardById, loadRuleById } from '@/lib/game/skills'
import { applyBattleAction, type BattleState } from '@/lib/game/turn'
import { hashStable, runBattleAction } from '@/lib/game/battle-runner'
import { globalTriggerSystem, TriggerSystem } from '@/lib/game/triggers'
import { getPieceById } from '@/lib/game/piece-repository'
import { prepareAction } from '@/lib/game/targeting'
import { getSkillById } from '@/lib/game/skill-repository'
import { makePiece, makeState } from '../helpers/minimal-state'

const DATA_ROOT = join(process.cwd(), 'data')
const priorRules = [...globalTriggerSystem.getRules()]

function loadJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(join(DATA_ROOT, ...segments), 'utf8')) as T
}

function skill(id: string): any {
  return loadJson('skills', `${id}.json`)
}

function executeSkill(id: string, state: BattleState, casterId: string, options: {
  targetId?: string
  selectedOption?: any
} = {}) {
  const definition = skill(id)
  const caster = state.pieces.find(piece => piece.instanceId === casterId)!
  const target = options.targetId
    ? state.pieces.find(piece => piece.instanceId === options.targetId) ?? null
    : null
  return executeSkillFunction(definition, {
    piece: caster,
    target,
    targetPosition: target ? { x: target.x!, y: target.y! } : null,
    targets: target ? [{ info: target, pos: { x: target.x!, y: target.y! } }] : [],
    selectedOption: options.selectedOption,
    battle: state,
    playerId: caster.ownerPlayerId,
    skill: {
      id: definition.id,
      name: definition.name,
      type: definition.type,
      powerMultiplier: definition.powerMultiplier,
    },
  } as any, state)
}

beforeEach(() => globalTriggerSystem.clearRules())
afterEach(() => {
  globalTriggerSystem.clearRules()
  globalTriggerSystem.addRules(priorRules)
})

describe('RED-121 holy-hand roster contracts', () => {
  it('registers Velen, Turalyon, and the reworked legendary Liadrin', () => {
    expect(getPieceById('liadrin')).toMatchObject({
      name: '\u8389\u4e9a\u5fb7\u7433', rarity: 'legendary',
      stats: { maxHp: 14, attack: 4, defense: 1, moveRange: 3 },
    })
    expect(getPieceById('velen')).toMatchObject({
      name: '\u7ef4\u4f26', rarity: 'legendary',
      stats: { maxHp: 12, attack: 3, defense: 1, moveRange: 3 },
    })
    expect(getPieceById('turalyon')).toMatchObject({
      name: '\u56fe\u62c9\u626c', rarity: 'legendary',
      stats: { maxHp: 15, attack: 4, defense: 2, moveRange: 3 },
    })

    const pieceManifest = loadJson<string[]>('pieces', 'manifest.json')
    const skillManifest = loadJson<string[]>('skills', 'manifest.json')
    for (const id of ['velen', 'turalyon']) expect(pieceManifest.filter(item => item === id)).toHaveLength(1)
    for (const id of [
      'velen-holy-prophecy', 'velen-fate-shelter', 'velen-thousand-futures-ultimate',
      'turalyon-expedition-order', 'turalyon-lightforged-march', 'turalyon-grand-crusade',
    ]) {
      expect(skillManifest.filter(item => item === id)).toHaveLength(1)
      expect(getSkillById(id)?.id).toBe(id)
    }
  })

  it('exposes the approved AP, cooldown, and charge costs', () => {
    expect(skill('light-extraction')).toMatchObject({ actionPointCost: 0, cooldownTurns: 2 })
    expect(skill('muru-lament')).toMatchObject({ actionPointCost: 3, cooldownTurns: 2, chargeCost: 3 })
    expect(skill('velen-holy-prophecy')).toMatchObject({ actionPointCost: 0, cooldownTurns: 2 })
    expect(skill('velen-fate-shelter')).toMatchObject({ actionPointCost: 1, cooldownTurns: 3 })
    expect(skill('velen-thousand-futures-ultimate')).toMatchObject({ actionPointCost: 2, type: 'ultimate' })
    expect(skill('turalyon-expedition-order')).toMatchObject({ actionPointCost: 1, cooldownTurns: 2 })
    expect(skill('turalyon-grand-crusade')).toMatchObject({
      actionPointCost: 4, chargeCost: 1, cooldownTurns: 3, maxCharges: 1, type: 'super',
    })
  })
})

describe('Liadrin holy-hand engine', () => {
  it('consumes a shield and creates Smite plus Heal without an empty-slot precondition', () => {
    const liadrin = makePiece({ instanceId: 'liadrin', templateId: 'liadrin', ownerPlayerId: 'player-red', x: 0, y: 0 }) as any
    liadrin.rules = [loadRuleById('rule-blood-echo', true)!]
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 1, y: 0 }) as any
    ally.statusTags = [{ id: 'divine-shield', type: 'divine-shield' }]
    const state = makeState({ pieces: [liadrin, ally] }) as any
    state.players[0].hand = Array.from({ length: 8 }, (_, index) => ({
      cardId: 'holy-smite',
      instanceId: `f-${index}`,
      ownerPlayerId: 'player-red',
    }))

    expect(executeSkill('light-extraction', state, 'liadrin', { targetId: 'ally' }).success).toBe(true)
    expect(ally.statusTags).toHaveLength(0)
    expect(state.players[0].hand).toHaveLength(10)
    expect(state.players[0].hand.filter((card: any) => card.cardId === 'holy-smite')).toHaveLength(9)
    expect(state.players[0].hand.filter((card: any) => card.cardId === 'holy-charge')).toHaveLength(1)
    expect(state.players[0].discardPile).toContain('holy-heal')
    expect(state.actions).toContainEqual(expect.objectContaining({
      type: 'cardOverflow',
      payload: expect.objectContaining({ message: expect.stringContaining('圣光治疗') }),
    }))
  })

  it('turns one to four discarded holy cards into repeated true damage/healing and restores shields at three', () => {
    const liadrin = makePiece({ instanceId: 'liadrin', templateId: 'liadrin', ownerPlayerId: 'player-red', x: 0, y: 0, currentHp: 4, maxHp: 14 }) as any
    liadrin.skills = [{ skillId: 'light-extraction', currentCooldown: 1, usesRemaining: -1 }]
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 1, y: 0, currentHp: 4, maxHp: 10 }) as any
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 0, currentHp: 20, maxHp: 20 }) as any
    const state = makeState({ pieces: [liadrin, ally, enemy] }) as any
    state.players[0].hand = ['holy-smite', 'holy-heal', 'holy-charge'].map((cardId, index) => ({ cardId, instanceId: `holy-${index}`, ownerPlayerId: 'player-red' }))

    const result = executeSkill('muru-lament', state, 'liadrin', { selectedOption: ['holy-0', 'holy-1', 'holy-2'] })

    expect(result.success).toBe(true)
    expect(enemy.currentHp).toBe(14)
    expect(liadrin.currentHp).toBe(10)
    expect(ally.currentHp).toBe(10)
    expect(state.players[0].hand).toHaveLength(0)
    expect(liadrin.skills[0].currentCooldown).toBe(0)
    expect(liadrin.statusTags.some((tag: any) => tag.type === 'divine-shield')).toBe(true)
    expect(ally.statusTags.some((tag: any) => tag.type === 'divine-shield')).toBe(true)
  })

  it('offers a linear authoritative hand multi-select and resolves four cards exactly once', () => {
    const lament = skill('muru-lament')
    const liadrin = makePiece({
      instanceId: 'liadrin-linear-options', templateId: 'liadrin', ownerPlayerId: 'player-red', x: 0, y: 0,
    }) as any
    liadrin.skills = [{ skillId: lament.id, currentCooldown: 0, usesRemaining: -1 }]
    const enemy = makePiece({
      instanceId: 'linear-options-enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 0,
      currentHp: 30, maxHp: 30,
    }) as any
    const state = makeState({ pieces: [liadrin, enemy], currentPlayerId: 'player-red', phase: 'action' }) as any
    state.skillsById[lament.id] = lament
    state.players[0].actionPoints = 3
    state.players[0].chargePoints = 3
    state.players[0].hand = Array.from({ length: 10 }, (_, index) => ({
      cardId: ['holy-smite', 'holy-heal', 'holy-charge'][index % 3],
      instanceId: `linear-holy-${index}`,
      ownerPlayerId: 'player-red',
    }))
    const runnerPending = runBattleAction(JSON.parse(JSON.stringify(state)), {
      type: 'useChargeSkill', playerId: 'player-red', pieceId: liadrin.instanceId, skillId: lament.id,
    } as any).state as any
    expect(runnerPending.pendingOptionSelection).toMatchObject({
      canCancel: true,
      selectionMode: 'multi',
      presentation: 'hand',
      minSelections: 1,
      maxSelections: 4,
    })

    const pending = applyBattleAction(state, {
      type: 'useChargeSkill', playerId: 'player-red', pieceId: liadrin.instanceId, skillId: lament.id,
    } as any) as any

    expect(pending.pendingOptionSelection).toMatchObject({
      selectionMode: 'multi',
      presentation: 'hand',
      minSelections: 1,
      maxSelections: 4,
    })
    expect(pending.pendingOptionSelection.options).toHaveLength(10)
    expect(pending.pendingOptionSelection.options.map((option: any) => option.value))
      .toEqual(state.players[0].hand.map((card: any) => card.instanceId))
    expect(pending.pendingOptionSelection.options.every((option: any) => !Array.isArray(option.value))).toBe(true)
    expect(pending.players[0]).toMatchObject({ actionPoints: 3, chargePoints: 3 })

    const beforeInvalid = hashStable(pending)
    expect(() => applyBattleAction(pending, {
      type: 'pendingOptionSelect', playerId: 'player-red', selectedOption: [],
      selectionId: pending.pendingOptionSelection.selectionId,
      stateRevision: pending.pendingOptionSelection.stateRevision,
    } as any)).toThrow(/selection|option|candidate/i)
    expect(hashStable(pending)).toBe(beforeInvalid)

    for (const selectedOption of [
      ['linear-holy-0', 'linear-holy-0'],
      pending.pendingOptionSelection.options.slice(0, 5).map((option: any) => option.value),
      ['not-in-current-hand'],
    ]) {
      expect(() => applyBattleAction(pending, {
        type: 'pendingOptionSelect', playerId: 'player-red', selectedOption,
        selectionId: pending.pendingOptionSelection.selectionId,
        stateRevision: pending.pendingOptionSelection.stateRevision,
      } as any)).toThrow(/selection|option|candidate|duplicate/i)
      expect(hashStable(pending)).toBe(beforeInvalid)
    }

    const cancelled = applyBattleAction(pending, {
      type: 'cancelPendingSelection', playerId: 'player-red',
      selectionId: pending.pendingOptionSelection.selectionId,
      stateRevision: pending.pendingOptionSelection.stateRevision,
    } as any) as any
    expect(cancelled.pendingOptionSelection).toBeUndefined()
    expect(cancelled.players[0]).toMatchObject({ actionPoints: 3, chargePoints: 3 })
    expect(cancelled.players[0].hand.map((card: any) => card.instanceId))
      .toEqual(state.players[0].hand.map((card: any) => card.instanceId))
    expect(pending.pendingOptionSelection).toBeDefined()

    const selected = pending.pendingOptionSelection.options.slice(0, 4).map((option: any) => option.value)
    const resolved = applyBattleAction(pending, {
      type: 'pendingOptionSelect', playerId: 'player-red', selectedOption: selected,
      selectionId: pending.pendingOptionSelection.selectionId,
      stateRevision: pending.pendingOptionSelection.stateRevision,
    } as any) as any

    expect(resolved.pendingOptionSelection).toBeUndefined()
    expect(resolved.players[0]).toMatchObject({ actionPoints: 0, chargePoints: 0 })
    expect(resolved.players[0].hand.map((card: any) => card.instanceId))
      .toEqual(state.players[0].hand.slice(4).map((card: any) => card.instanceId))
    expect(resolved.pieces.find((piece: any) => piece.instanceId === enemy.instanceId).currentHp).toBe(22)
    expect(resolved.actions.filter((action: any) => action.type === 'useChargeSkill')).toHaveLength(1)
  })

  it('uses the reset 0 AP extraction in the same turn to rebuild all three holy components', () => {
    const lament = skill('muru-lament')
    const extraction = skill('light-extraction')
    const liadrin = makePiece({
      instanceId: 'liadrin-rebuild', templateId: 'liadrin', ownerPlayerId: 'player-red', x: 0, y: 0,
    }) as any
    liadrin.rules = [loadRuleById('rule-blood-echo', true)!]
    liadrin.skills = [
      { skillId: extraction.id, currentCooldown: 1, usesRemaining: -1 },
      { skillId: lament.id, currentCooldown: 0, usesRemaining: -1 },
    ]
    const ally = makePiece({ instanceId: 'rebuild-target', ownerPlayerId: 'player-red', x: 1, y: 0 }) as any
    const enemy = makePiece({
      instanceId: 'rebuild-enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 0,
      currentHp: 20, maxHp: 20,
    }) as any
    const state = makeState({ pieces: [liadrin, ally, enemy], currentPlayerId: 'player-red', phase: 'action' }) as any
    state.skillsById[lament.id] = lament
    state.skillsById[extraction.id] = extraction
    state.players[0].actionPoints = 3
    state.players[0].chargePoints = 3
    state.players[0].hand = ['holy-smite', 'holy-heal', 'holy-charge'].map((cardId, index) => ({
      cardId, instanceId: `rebuild-${index}`, ownerPlayerId: 'player-red',
    }))

    const lamentPending = applyBattleAction(state, {
      type: 'useChargeSkill', playerId: 'player-red', pieceId: liadrin.instanceId, skillId: lament.id,
    } as any) as any
    const discardAll = lamentPending.pendingOptionSelection.options.map((option: any) => option.value)
    expect(discardAll).toHaveLength(3)
    expect(lamentPending.players[0]).toMatchObject({ actionPoints: 3, chargePoints: 3 })

    const afterLament = applyBattleAction(lamentPending, {
      type: 'pendingOptionSelect', playerId: 'player-red', selectedOption: discardAll,
      selectionId: lamentPending.pendingOptionSelection.selectionId,
      stateRevision: lamentPending.pendingOptionSelection.stateRevision,
    } as any) as any
    expect(afterLament.players[0]).toMatchObject({ actionPoints: 0, chargePoints: 0 })
    expect(afterLament.players[0].hand).toHaveLength(0)
    expect(afterLament.pieces.find((piece: any) => piece.instanceId === liadrin.instanceId).skills
      .find((entry: any) => entry.skillId === extraction.id).currentCooldown).toBe(0)
    expect(afterLament.pieces.find((piece: any) => piece.instanceId === ally.instanceId).statusTags
      .some((tag: any) => tag.type === 'divine-shield')).toBe(true)

    const extractionDraft = {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: liadrin.instanceId, skillId: extraction.id,
    }
    const extractionPrepared = prepareAction(afterLament, extractionDraft as any)
    expect(extractionPrepared.kind).toBe('needTarget')
    if (extractionPrepared.kind !== 'needTarget') {
      throw new Error('Expected authoritative target preparation for the reset light extraction')
    }
    expect(afterLament.players[0].actionPoints).toBe(0)
    expect(extractionPrepared.candidates).toContainEqual({ type: 'piece', pieceId: ally.instanceId })
    const rebuilt = applyBattleAction(afterLament, {
      ...extractionDraft,
      targetPieceId: ally.instanceId,
      selectionId: extractionPrepared.selectionId,
      stateRevision: extractionPrepared.stateRevision,
    } as any) as any

    expect(rebuilt.players[0].actionPoints).toBe(0)
    expect(rebuilt.players[0].hand.map((card: any) => card.cardId).sort())
      .toEqual(['holy-charge', 'holy-heal', 'holy-smite'])
    expect(rebuilt.actions.filter((action: any) => action.type === 'useChargeSkill')).toHaveLength(1)
    expect(rebuilt.actions.filter((action: any) => action.type === 'useBasicSkill')).toHaveLength(1)
  })
})

  it.each([1, 2, 3, 4])('settles exactly %i discarded holy cards', count => {
    const liadrin = makePiece({
      instanceId: 'liadrin-boundary',
      templateId: 'liadrin',
      ownerPlayerId: 'player-red',
      x: 0,
      y: 0,
      currentHp: 4,
      maxHp: 20,
    }) as any
    liadrin.skills = [{ skillId: 'light-extraction', currentCooldown: 1, usesRemaining: -1 }]
    const ally = makePiece({ instanceId: 'ally-boundary', ownerPlayerId: 'player-red', x: 1, y: 0, currentHp: 4, maxHp: 20 }) as any
    const enemy = makePiece({ instanceId: 'enemy-boundary', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 0, currentHp: 30, maxHp: 30 }) as any
    const state = makeState({ pieces: [liadrin, ally, enemy] }) as any
    state.players[0].hand = Array.from({ length: 4 }, (_, index) => ({
      cardId: ['holy-smite', 'holy-heal', 'holy-charge'][index % 3],
      instanceId: `holy-boundary-${index}`,
      ownerPlayerId: 'player-red',
    }))

    const selected = state.players[0].hand.slice(0, count).map((card: any) => card.instanceId)
    expect(executeSkill('muru-lament', state, 'liadrin-boundary', { selectedOption: selected }).success).toBe(true)
    expect(enemy.currentHp).toBe(30 - count * 2)
    expect(ally.currentHp).toBe(4 + count * 2)
    expect(state.players[0].hand).toHaveLength(4 - count)
    expect(liadrin.skills[0].currentCooldown).toBe(count >= 3 ? 0 : 1)
    expect(ally.statusTags.some((tag: any) => tag.type === 'divine-shield')).toBe(count >= 3)
  })

describe('Velen delayed holy cards', () => {
  it('completes prophecy next own turn and multiplies after Tyrande, producing 15 true damage', () => {
    const velen = makePiece({ instanceId: 'velen', templateId: 'velen', ownerPlayerId: 'player-red', x: 0, y: 0 }) as any
    velen.rules = [loadRuleById('rule-velen-delayed-effects', true)!, loadRuleById('rule-velen-death-cleanup', true)!]
    const tyrande = makePiece({ instanceId: 'tyrande', templateId: 'tyrande', ownerPlayerId: 'player-red', x: 1, y: 0 }) as any
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 0, currentHp: 20, maxHp: 20 }) as any
    const state = makeState({ pieces: [velen, tyrande, enemy], turnNumber: 1 }) as any
    const card: any = { cardId: 'holy-smite', instanceId: 'prophecy-smite', ownerPlayerId: 'player-red', actionPointCost: 2 }
    state.players[0].hand = [card]

    expect(executeSkill('velen-holy-prophecy', state, 'velen', { selectedOption: card.instanceId }).success).toBe(true)
    expect(card.contentState?.velenHolyProphecy).toMatchObject({ sourcePieceId: 'velen', createdTurnNumber: 1 })
    state.turn.turnNumber = 2
    const trigger = new TriggerSystem().checkTriggers(state, { type: 'beginTurn', playerId: 'player-red' } as any)
    expect(trigger.success).toBe(true)
    expect(card.contentState?.velenHolyProphecy).toBeUndefined()
    expect(card.contentState?.velenHolyProphecyEnhanced).toBe(true)
    expect(card.presentation).toMatchObject({
      variant: 'enhanced', badge: '预言强化',
      description: '预言强化：对敌方生命值最低的棋子造成7点真实伤害。',
    })

    state.players[0].buffs = { 'elune-blessing-buff': { multiplier: 2, uses: 1 } }
    const result = executeCardFunction(loadCardById('holy-smite', true)!, 'player-red', state, undefined, undefined, undefined, undefined, undefined, card)
    expect(result.success).toBe(true)
    expect(enemy.currentHp).toBe(5)
  })
  it('enhances holy healing from 8 to 12 and holy charge from 2 to 3', () => {
    const source = makePiece({ instanceId: 'source', ownerPlayerId: 'player-red', x: 0, y: 0, currentHp: 20, maxHp: 20 }) as any
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 1, y: 0, currentHp: 1, maxHp: 20 }) as any
    const state = makeState({ pieces: [source, ally] }) as any
    const healCard = { cardId: 'holy-heal', instanceId: 'enhanced-heal', ownerPlayerId: 'player-red', contentState: { velenHolyProphecyEnhanced: true }, effectModifiers: [{ effect: 'heal', operation: 'multiply', value: 1.5 }] }
    const chargeCard = { cardId: 'holy-charge', instanceId: 'enhanced-charge', ownerPlayerId: 'player-red', contentState: { velenHolyProphecyEnhanced: true }, effectModifiers: [{ effect: 'statusIntensity', operation: 'multiply', value: 1.5, statusType: 'damage-buff' }] }

    const heal = executeCardFunction(loadCardById('holy-heal', true)!, 'player-red', state, undefined, undefined, undefined, undefined, undefined, healCard)
    expect(heal.success).toBe(true)
    expect(ally.currentHp).toBe(13)

    const charge = executeCardFunction(loadCardById('holy-charge', true)!, 'player-red', state, undefined, undefined, undefined, undefined, undefined, chargeCard)
    expect(charge.success).toBe(true)
    expect(source.statusTags.find((tag: any) => tag.type === 'damage-buff')?.intensity).toBe(3)
    expect(ally.statusTags.find((tag: any) => tag.type === 'damage-buff')?.intensity).toBe(3)
  })


  it('resolves fate shelter for 8 healing plus shield, and clears unfinished prophecy when Velen dies', () => {
    const velen = makePiece({ instanceId: 'velen', templateId: 'velen', ownerPlayerId: 'player-red', x: 0, y: 0 }) as any
    velen.rules = [loadRuleById('rule-velen-delayed-effects', true)!, loadRuleById('rule-velen-death-cleanup', true)!]
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 1, y: 0, currentHp: 2, maxHp: 12 }) as any
    const state = makeState({ pieces: [velen, ally], turnNumber: 1 }) as any

    expect(executeSkill('velen-fate-shelter', state, 'velen', { targetId: 'ally' }).success).toBe(true)
    state.turn.turnNumber = 2
    new TriggerSystem().checkTriggers(state, { type: 'beginTurn', playerId: 'player-red' } as any)
    expect(ally.currentHp).toBe(10)
    expect(ally.statusTags.some((tag: any) => tag.type === 'divine-shield')).toBe(true)

    state.players[0].hand = [{
      cardId: 'holy-heal', instanceId: 'unfinished', ownerPlayerId: 'player-red',
      contentState: { velenHolyProphecy: { sourcePieceId: 'velen', createdTurnNumber: 2 } },
    }]
    velen.currentHp = 0
    new TriggerSystem().checkTriggers(state, { type: 'onPieceDied', playerId: 'player-red', sourcePiece: velen } as any)
    expect(state.players[0].hand[0].contentState?.velenHolyProphecy).toBeUndefined()
  })

  it('cancels fate shelter when its target dies before the next own turn', () => {
    const velen = makePiece({ instanceId: 'velen-target-death', templateId: 'velen', ownerPlayerId: 'player-red', x: 0, y: 0 }) as any
    velen.rules = [loadRuleById('rule-velen-delayed-effects', true)!, loadRuleById('rule-velen-death-cleanup', true)!]
    const ally = makePiece({ instanceId: 'shelter-target', ownerPlayerId: 'player-red', x: 1, y: 0, currentHp: 2, maxHp: 12 }) as any
    const state = makeState({ pieces: [velen, ally], turnNumber: 1 }) as any

    expect(executeSkill('velen-fate-shelter', state, velen.instanceId, { targetId: ally.instanceId }).success).toBe(true)
    expect(ally.statusTags.some((tag: any) => tag.type === 'velen-fate-shelter')).toBe(true)
    ally.currentHp = 0
    new TriggerSystem().checkTriggers(state, {
      type: 'onPieceDied',
      playerId: 'player-red',
      sourcePiece: ally,
    } as any)
    expect(ally.statusTags.some((tag: any) => tag.type === 'velen-fate-shelter')).toBe(false)

    state.turn.turnNumber = 2
    new TriggerSystem().checkTriggers(state, { type: 'beginTurn', playerId: 'player-red' } as any)
    expect(ally.currentHp).toBe(0)
    expect(ally.statusTags.some((tag: any) => tag.type === 'divine-shield')).toBe(false)
  })


  it('tracks prophecy by hand instance across duplicate names, early play, early discard, and repeat attempts', () => {
    const velen = makePiece({
      instanceId: 'velen-instance-contract', templateId: 'velen', ownerPlayerId: 'player-red', x: 0, y: 0,
    }) as any
    velen.rules = [loadRuleById('rule-velen-delayed-effects', true)!, loadRuleById('rule-velen-death-cleanup', true)!]
    const liadrin = makePiece({
      instanceId: 'liadrin-instance-contract', templateId: 'liadrin', ownerPlayerId: 'player-red', x: 0, y: 1,
    }) as any
    const enemy = makePiece({
      instanceId: 'prophecy-instance-enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 0,
      currentHp: 30, maxHp: 30,
    }) as any
    const state = makeState({ pieces: [velen, liadrin, enemy], turnNumber: 1 }) as any
    state.players[0].actionPoints = 2
    state.players[0].hand = ['played', 'discarded', 'survivor'].map(suffix => ({
      cardId: 'holy-smite', instanceId: `prophecy-${suffix}`, ownerPlayerId: 'player-red', actionPointCost: 2,
    }))

    expect(executeSkill('velen-holy-prophecy', state, velen.instanceId, {
      selectedOption: 'prophecy-played',
    }).success).toBe(true)
    expect(state.players[0].hand.find((card: any) => card.instanceId === 'prophecy-played').contentState?.velenHolyProphecy)
      .toMatchObject({ sourcePieceId: velen.instanceId, createdTurnNumber: 1 })
    expect(state.players[0].hand.filter((card: any) => card.contentState?.velenHolyProphecy)).toHaveLength(1)

    const repeated = executeSkill('velen-holy-prophecy', state, velen.instanceId, {
      selectedOption: 'prophecy-played',
    })
    expect(repeated.success).toBe(false)
    expect(state.players[0].hand.filter((card: any) => card.contentState?.velenHolyProphecy)).toHaveLength(1)

    const afterPlay = applyBattleAction(state, {
      type: 'playCard', playerId: 'player-red', cardInstanceId: 'prophecy-played',
    } as any) as any
    expect(afterPlay.players[0].discardPile).toContain('holy-smite')
    expect(afterPlay.players[0].hand.map((card: any) => card.instanceId).sort())
      .toEqual(['prophecy-discarded', 'prophecy-survivor'])
    expect(afterPlay.players[0].hand.some((card: any) => card.contentState?.velenHolyProphecyEnhanced)).toBe(false)

    expect(executeSkill('velen-holy-prophecy', afterPlay, velen.instanceId, {
      selectedOption: 'prophecy-discarded',
    }).success).toBe(true)
    expect(executeSkill('muru-lament', afterPlay, liadrin.instanceId, {
      selectedOption: ['prophecy-discarded'],
    }).success).toBe(true)
    expect(afterPlay.players[0].hand.map((card: any) => card.instanceId)).toEqual(['prophecy-survivor'])

    afterPlay.turn.turnNumber = 2
    expect(new TriggerSystem().checkTriggers(afterPlay, {
      type: 'beginTurn', playerId: 'player-red',
    } as any).success).toBe(false)
    expect(afterPlay.players[0].hand[0]).toMatchObject({ instanceId: 'prophecy-survivor' })
    expect(afterPlay.players[0].hand[0].contentState?.velenHolyProphecy).toBeUndefined()
    expect(afterPlay.players[0].hand[0].contentState?.velenHolyProphecyEnhanced).toBeUndefined()
  })

  it('publishes holy prophecy as an exact single-card hand selection', () => {
    const definition = skill('velen-holy-prophecy')
    const velen = makePiece({ instanceId: 'velen-prophecy-hand', templateId: 'velen', ownerPlayerId: 'player-red', x: 0, y: 0 }) as any
    velen.skills = [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({ pieces: [velen] }) as any
    state.skillsById[definition.id] = definition
    state.players[0].hand = [
      { cardId: 'holy-smite', instanceId: 'prophecy-choice', ownerPlayerId: 'player-red' },
      { cardId: 'holy-heal', instanceId: 'already-enhanced', ownerPlayerId: 'player-red', contentState: { velenHolyProphecyEnhanced: true } },
      { cardId: 'filler', instanceId: 'not-holy', ownerPlayerId: 'player-red' },
    ]

    const pending = applyBattleAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: velen.instanceId, skillId: definition.id,
    } as any) as any

    expect(pending.pendingOptionSelection).toMatchObject({
      selectionMode: 'single', presentation: 'hand', minSelections: 1, maxSelections: 1,
      options: [{ value: 'prophecy-choice' }],
    })
  })
})
  it('commits one to three immediate futures once and rejects a second ultimate use', () => {
    const definition = skill('velen-thousand-futures-ultimate')
    const velen = makePiece({ instanceId: 'velen-ultimate', templateId: 'velen', ownerPlayerId: 'player-red', x: 0, y: 0 }) as any
    velen.skills = [{ skillId: definition.id, currentCooldown: 0, usesRemaining: 1 }]
    const state = makeState({ pieces: [velen], turnNumber: 1 }) as any
    state.skillsById[definition.id] = definition
    state.players[0].actionPoints = 2
    state.players[0].hand = ['holy-smite', 'holy-heal', 'holy-charge'].map((cardId, index) => ({
      cardId,
      instanceId: `future-${index}`,
      ownerPlayerId: 'player-red',
    }))

    const pending = applyBattleAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'velen-ultimate',
      skillId: definition.id,
    } as any) as any
    expect(pending.players[0].actionPoints).toBe(2)
    expect(pending.pendingOptionSelection?.source).toMatchObject({ type: 'skill', id: definition.id })
    expect(pending.pendingOptionSelection).toMatchObject({
      selectionMode: 'multi', presentation: 'hand', minSelections: 1, maxSelections: 3,
    })
    expect(pending.pendingOptionSelection.options.map((option: any) => option.value))
      .toEqual(['future-0', 'future-1', 'future-2'])

    const resolved = applyBattleAction(pending, {
      type: 'pendingOptionSelect',
      playerId: 'player-red',
      selectedOption: ['future-0', 'future-1', 'future-2'],
      selectionId: pending.pendingOptionSelection.selectionId,
      stateRevision: pending.pendingOptionSelection.stateRevision,
    } as any) as any
    expect(resolved.players[0].actionPoints).toBe(0)
    expect(resolved.players[0].hand.every((card: any) => card.contentState?.velenHolyProphecyEnhanced === true)).toBe(true)
    expect(resolved.pieces[0].skills[0].usesRemaining).toBe(0)

    resolved.players[0].actionPoints = 2
    resolved.players[0].perTurnFlags.hasUsedBasicSkill = false
    expect(() => applyBattleAction(resolved, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'velen-ultimate',
      skillId: definition.id,
    } as any)).toThrow(/already been used/)
  })

describe('Turalyon holy-hand mobility', () => {
  it('publishes a three-card option and creates exactly the selected holy card', () => {
    const definition = skill('turalyon-expedition-order')
    const turalyon = makePiece({
      instanceId: 'turalyon-order', templateId: 'turalyon', ownerPlayerId: 'player-red', x: 0, y: 0,
    }) as any
    turalyon.skills = [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({ pieces: [turalyon] }) as any
    state.skillsById[definition.id] = definition
    state.players[0].hand = [
      { cardId: 'holy-smite', instanceId: 'existing-smite', ownerPlayerId: 'player-red', actionPointCost: 1 },
    ]
    const base = {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: turalyon.instanceId, skillId: definition.id,
    } as any
    const prepared = prepareAction(state, base)
    expect(prepared.kind).toBe('needOption')
    if (prepared.kind !== 'needOption') throw new Error('Expected Expedition Order option selection')
    expect(prepared.options).toEqual([
      { label: '圣光惩戒', value: 'holy-smite' },
      { label: '圣光治疗', value: 'holy-heal' },
      { label: '圣光冲锋', value: 'holy-charge' },
    ])
    expect(state.players[0]).toMatchObject({ actionPoints: 2 })
    expect(state.players[0].hand).toHaveLength(1)
    expect(turalyon.skills[0].currentCooldown).toBe(0)

    const resolved = applyBattleAction(state, {
      ...base,
      selectedOption: 'holy-heal',
      selectionId: prepared.selectionId,
      stateRevision: prepared.stateRevision,
    } as any) as any
    expect(resolved.players[0].actionPoints).toBe(1)
    expect(resolved.players[0].hand.map((card: any) => card.cardId)).toEqual(['holy-smite', 'holy-heal'])
    expect(resolved.players[0].hand.every((card: any) => card.actionPointCost === 1)).toBe(true)
    expect(resolved.pieces[0].skills[0].currentCooldown).toBe(2)
  })

  it('keeps the card action uncommitted through piece then cell selection, then commits exactly once', () => {
    const turalyon = makePiece({ instanceId: 'turalyon', templateId: 'turalyon', ownerPlayerId: 'player-red', x: 0, y: 0 }) as any
    turalyon.rules = [loadRuleById('rule-turalyon-lightforged-march', true)!]
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 1, y: 1, moveRange: 3, currentHp: 5, maxHp: 10 }) as any
    const state = makeState({ pieces: [turalyon, ally], width: 8, height: 8, turnNumber: 1 }) as any
    state.players[0].actionPoints = 3
    state.players[0].hand = [{ cardId: 'holy-heal', instanceId: 'heal', ownerPlayerId: 'player-red', actionPointCost: 2 }]

    const pending = applyBattleAction(state, { type: 'playCard', playerId: 'player-red', cardInstanceId: 'heal' } as any) as any
    expect(pending.pendingTargetSelection?.source).toMatchObject({ type: 'rule', id: 'rule-turalyon-lightforged-march', pieceId: 'turalyon' })
    expect(pending.pendingTargetSelection).toMatchObject({
      targetType: 'piece', candidates: expect.arrayContaining([{ type: 'piece', pieceId: 'ally' }]),
    })
    expect(pending.players[0].actionPoints).toBe(3)
    expect(pending.players[0].hand).toHaveLength(1)
    expect(pending.players[0].discardPile).toEqual([])

    const cancelled = applyBattleAction(pending, {
      type: 'cancelPendingSelection', playerId: 'player-red',
      selectionId: pending.pendingTargetSelection.selectionId,
      stateRevision: pending.pendingTargetSelection.stateRevision,
    } as any) as any
    expect(cancelled.pendingTargetSelection).toBeUndefined()
    expect(cancelled.players[0]).toMatchObject({ actionPoints: 1, hand: [], discardPile: ['holy-heal'] })
    expect(cancelled.pieces.find((piece: any) => piece.instanceId === 'ally')).toMatchObject({ x: 1, y: 1 })
    expect((cancelled.extensions as any).turalyonLightforgedTurns).toMatchObject({ turalyon: 1 })

    const destinationPending = applyBattleAction(pending, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetPieceId: 'ally',
      selectionId: pending.pendingTargetSelection.selectionId,
      stateRevision: pending.pendingTargetSelection.stateRevision,
    } as any) as any
    expect(destinationPending.pendingTargetSelection).toMatchObject({
      targetType: 'grid', candidates: expect.arrayContaining([{ type: 'cell', x: 2, y: 1 }]),
    })
    expect(destinationPending.players[0].actionPoints).toBe(3)
    expect(destinationPending.players[0].hand).toHaveLength(1)

    const resolved = applyBattleAction(destinationPending, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetX: 2, targetY: 1,
      selectionId: destinationPending.pendingTargetSelection.selectionId,
      stateRevision: destinationPending.pendingTargetSelection.stateRevision,
    } as any) as any
    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolved.pieces.find((piece: any) => piece.instanceId === 'ally')).toMatchObject({ x: 2, y: 1 })
    expect(resolved.players[0].actionPoints).toBe(1)
    expect(resolved.players[0].discardPile).toEqual(['holy-heal'])
    expect(resolved.actions.filter((action: any) => action.type === 'playCard')).toHaveLength(1)

    const ordinaryMove = applyBattleAction(resolved, {
      type: 'move', playerId: 'player-red', pieceId: 'ally', toX: 3, toY: 1,
    } as any) as any
    expect(ordinaryMove.pieces.find((piece: any) => piece.instanceId === 'ally')).toMatchObject({ x: 3, y: 1 })
    expect(ordinaryMove.players[0].actionPoints).toBe(0)
    expect(ordinaryMove.actions.filter((action: any) => action.type === 'move')).toHaveLength(1)
  })

  it('rolls the complete holy card action back when a later afterCardPlay consumer throws after march resumes', () => {
    const marchRule = { ...loadRuleById('rule-turalyon-lightforged-march', true)!, priority: 10 } as any
    globalTriggerSystem.addRule(marchRule)
    globalTriggerSystem.addRule({
      id: 'turalyon-after-card-resume-exception',
      name: 'Turalyon after-card resume exception',
      description: '',
      priority: -10,
      trigger: { type: 'afterCardPlay' },
      effect: (battle: BattleState) => {
        ;(battle.extensions as any).laterAfterCardConsumerTouched = true
        throw new Error('turalyon afterCardPlay resume explosion')
      },
    } as any)

    const turalyon = makePiece({
      instanceId: 'turalyon-rollback', templateId: 'turalyon', ownerPlayerId: 'player-red', x: 0, y: 0,
    }) as any
    turalyon.rules = [{ id: marchRule.id }]
    const ally = makePiece({
      instanceId: 'turalyon-rollback-ally', ownerPlayerId: 'player-red', x: 1, y: 1,
      moveRange: 3, currentHp: 5, maxHp: 10,
    }) as any
    const state = makeState({ pieces: [turalyon, ally], width: 8, height: 8, turnNumber: 1 }) as any
    state.players[0].actionPoints = 2
    state.players[0].hand = [{
      cardId: 'holy-heal', instanceId: 'turalyon-rollback-heal', ownerPlayerId: 'player-red', actionPointCost: 2,
    }]

    const pending = applyBattleAction(state, {
      type: 'playCard', playerId: 'player-red', cardInstanceId: 'turalyon-rollback-heal',
    } as any) as any
    expect(pending.pendingTargetSelection?.source).toMatchObject({
      type: 'rule', id: marchRule.id, pieceId: turalyon.instanceId,
    })
    expect(pending.players[0]).toMatchObject({ actionPoints: 2 })
    expect(pending.players[0].hand).toHaveLength(1)
    expect(pending.players[0].discardPile).toEqual([])
    expect(pending.pieces.find((piece: any) => piece.instanceId === ally.instanceId)).toMatchObject({ x: 1, y: 1, currentHp: 5 })
    expect((pending.extensions as any).turalyonLightforgedTurns).toBeUndefined()
    expect((pending.extensions as any).laterAfterCardConsumerTouched).toBeUndefined()
    expect(pending.actions.filter((action: any) => action.type === 'playCard')).toHaveLength(0)
    const pendingHash = hashStable(pending)
    const destinationPending = applyBattleAction(pending, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetPieceId: ally.instanceId,
      selectionId: pending.pendingTargetSelection.selectionId,
      stateRevision: pending.pendingTargetSelection.stateRevision,
    } as any) as any
    expect(destinationPending.pendingTargetSelection.candidates).toContainEqual({ type: 'cell', x: 2, y: 1 })

    expect(() => applyBattleAction(destinationPending, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetX: 2, targetY: 1,
      selectionId: destinationPending.pendingTargetSelection.selectionId,
      stateRevision: destinationPending.pendingTargetSelection.stateRevision,
    } as any)).toThrow(/turalyon afterCardPlay resume explosion/)
    expect(hashStable(pending)).toBe(pendingHash)
    expect(pending.players[0]).toMatchObject({ actionPoints: 2 })
    expect(pending.players[0].hand).toHaveLength(1)
    expect(pending.players[0].discardPile).toEqual([])
    expect(pending.pieces.find((piece: any) => piece.instanceId === ally.instanceId)).toMatchObject({ x: 1, y: 1, currentHp: 5 })
    expect((pending.extensions as any).turalyonLightforgedTurns).toBeUndefined()
    expect((pending.extensions as any).laterAfterCardConsumerTouched).toBeUndefined()
  })

  it('produces the same full state hash for identical holy march states and command sequences', () => {
    const marchRule = { ...loadRuleById('rule-turalyon-lightforged-march', true)!, priority: 10 } as any
    globalTriggerSystem.addRule(marchRule)
    const triggerCheckpoint = globalTriggerSystem.snapshotTransactionState()
    const runSequence = () => {
      globalTriggerSystem.restoreTransactionState(triggerCheckpoint)
      const turalyon = makePiece({
        instanceId: 'turalyon-deterministic', templateId: 'turalyon', ownerPlayerId: 'player-red', x: 0, y: 0,
      }) as any
      turalyon.rules = [{ id: marchRule.id }]
      const ally = makePiece({
        instanceId: 'turalyon-deterministic-ally', ownerPlayerId: 'player-red', x: 1, y: 1,
        moveRange: 3, currentHp: 5, maxHp: 10,
      }) as any
      const state = makeState({ pieces: [turalyon, ally], width: 8, height: 8, turnNumber: 1 }) as any
      state.players[0].actionPoints = 2
      state.players[0].hand = [{
        cardId: 'holy-heal', instanceId: 'turalyon-deterministic-heal', ownerPlayerId: 'player-red', actionPointCost: 2,
      }]
      const pending = applyBattleAction(state, {
        type: 'playCard', playerId: 'player-red', cardInstanceId: 'turalyon-deterministic-heal',
      } as any) as any
      const destinationPending = applyBattleAction(pending, {
        type: 'pendingTargetSelect', playerId: 'player-red', targetPieceId: ally.instanceId,
        selectionId: pending.pendingTargetSelection.selectionId,
        stateRevision: pending.pendingTargetSelection.stateRevision,
      } as any) as any
      if (!destinationPending.pendingTargetSelection.candidates.some((target: any) => target.type === 'cell' && target.x === 2 && target.y === 1)) {
        throw new Error('Expected deterministic holy march destination')
      }
      return applyBattleAction(destinationPending, {
        type: 'pendingTargetSelect', playerId: 'player-red', targetX: 2, targetY: 1,
        selectionId: destinationPending.pendingTargetSelection.selectionId,
        stateRevision: destinationPending.pendingTargetSelection.stateRevision,
      } as any) as any
    }

    const first = runSequence()
    const second = runSequence()
    expect(hashStable(first)).toBe(hashStable(second))
    expect(first.players[0]).toMatchObject({ actionPoints: 0, hand: [], discardPile: ['holy-heal'] })
    expect(first.pieces.find((piece: any) => piece.instanceId === 'turalyon-deterministic-ally'))
      .toMatchObject({ x: 2, y: 1, currentHp: 10 })
  })
  it('crosses allies, stops at enemies and impassable terrain, and triggers only for the first holy card', () => {
    const turalyon = makePiece({ instanceId: 'turalyon-corridor', templateId: 'turalyon', ownerPlayerId: 'player-red', x: 0, y: 0 }) as any
    turalyon.rules = [loadRuleById('rule-turalyon-lightforged-march', true)!]
    const allyLaneMover = makePiece({ instanceId: 'ally-lane-mover', ownerPlayerId: 'player-red', x: 0, y: 1, moveRange: 3 })
    const allyLaneBlocker = makePiece({ instanceId: 'ally-lane-blocker', ownerPlayerId: 'player-red', x: 1, y: 1 })
    const enemyBlocker = makePiece({ instanceId: 'enemy-lane-blocker', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 1 })
    const terrainLaneMover = makePiece({ instanceId: 'terrain-lane-mover', ownerPlayerId: 'player-red', x: 0, y: 3, moveRange: 3 })
    const terrainLaneBlocker = makePiece({ instanceId: 'terrain-lane-blocker', ownerPlayerId: 'player-red', x: 1, y: 3 })
    const state = makeState({
      pieces: [turalyon, allyLaneMover, allyLaneBlocker, enemyBlocker, terrainLaneMover, terrainLaneBlocker],
      width: 5,
      height: 5,
      turnNumber: 1,
    }) as any
    for (const tile of state.map.tiles) {
      tile.props.walkable = tile.y === 1 || tile.y === 3 || (tile.x === 0 && tile.y === 0)
    }
    state.map.tiles.find((tile: any) => tile.x === 3 && tile.y === 3).props.walkable = false
    state.players[0].actionPoints = 4
    state.players[0].hand = [1, 2].map(index => ({
      cardId: 'holy-charge', instanceId: `march-card-${index}`, ownerPlayerId: 'player-red', actionPointCost: 2,
    }))

    const firstPending = applyBattleAction(state, { type: 'playCard', playerId: 'player-red', cardInstanceId: 'march-card-1' } as any) as any
    expect(firstPending.pendingTargetSelection.candidates).toEqual(expect.arrayContaining([
      { type: 'piece', pieceId: 'ally-lane-mover' },
      { type: 'piece', pieceId: 'terrain-lane-mover' },
    ]))
    const laneDestinationPending = applyBattleAction(firstPending, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetPieceId: 'ally-lane-mover',
      selectionId: firstPending.pendingTargetSelection.selectionId,
      stateRevision: firstPending.pendingTargetSelection.stateRevision,
    } as any) as any
    expect(laneDestinationPending.pendingTargetSelection.candidates).toContainEqual({ type: 'cell', x: 2, y: 1 })
    expect(laneDestinationPending.pendingTargetSelection.candidates).not.toContainEqual({ type: 'cell', x: 4, y: 1 })
    const firstResolved = applyBattleAction(laneDestinationPending, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetX: 2, targetY: 1,
      selectionId: laneDestinationPending.pendingTargetSelection.selectionId,
      stateRevision: laneDestinationPending.pendingTargetSelection.stateRevision,
    } as any) as any
    expect(firstResolved.players[0].actionPoints).toBe(2)
    const secondResolved = applyBattleAction(firstResolved, {
      type: 'playCard', playerId: 'player-red', cardInstanceId: 'march-card-2',
    } as any) as any
    expect(secondResolved.pendingTargetSelection).toBeUndefined()
    expect(secondResolved.players[0].actionPoints).toBe(0)
    expect(secondResolved.players[0].hand).toHaveLength(0)
  })

  it('uses straight-line normal-move geometry while allies are transparent blockers', () => {
    const turalyon = makePiece({
      instanceId: 'turalyon-straight-march', templateId: 'turalyon', ownerPlayerId: 'player-red', x: 0, y: 0,
    }) as any
    turalyon.rules = [loadRuleById('rule-turalyon-lightforged-march', true)!]
    const mover = makePiece({
      instanceId: 'straight-mover', ownerPlayerId: 'player-red', x: 6, y: 6, moveRange: 3,
    }) as any
    const friendlyBlocker = makePiece({
      instanceId: 'straight-friendly', ownerPlayerId: 'player-red', x: 7, y: 6,
    }) as any
    const enemyBlocker = makePiece({
      instanceId: 'straight-enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 6, y: 8,
    }) as any
    const state = makeState({
      pieces: [turalyon, mover, friendlyBlocker, enemyBlocker], width: 13, height: 13, turnNumber: 1,
    }) as any
    state.map.tiles.find((tile: any) => tile.x === 9 && tile.y === 6).props.walkable = false
    state.players[0].actionPoints = 2
    state.players[0].hand = [{
      cardId: 'holy-charge', instanceId: 'straight-march-card', ownerPlayerId: 'player-red', actionPointCost: 2,
    }]

    const moverPending = applyBattleAction(state, {
      type: 'playCard', playerId: 'player-red', cardInstanceId: 'straight-march-card',
    } as any) as any
    const destinationPending = applyBattleAction(moverPending, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetPieceId: mover.instanceId,
      selectionId: moverPending.pendingTargetSelection.selectionId,
      stateRevision: moverPending.pendingTargetSelection.stateRevision,
    } as any) as any
    const candidates = destinationPending.pendingTargetSelection.candidates

    expect(candidates).not.toContainEqual({ type: 'cell', x: 7, y: 6 })
    expect(candidates).toContainEqual({ type: 'cell', x: 8, y: 6 })
    expect(candidates).not.toContainEqual({ type: 'cell', x: 10, y: 6 })
    expect(candidates).toContainEqual({ type: 'cell', x: 6, y: 7 })
    expect(candidates).not.toContainEqual({ type: 'cell', x: 6, y: 9 })
    expect(candidates).toContainEqual({ type: 'cell', x: 6, y: 1 })
    expect(candidates).not.toContainEqual({ type: 'cell', x: 6, y: 0 })
    expect(candidates).not.toContainEqual({ type: 'cell', x: 5, y: 5 })
  })

  it('selects 1-3 friendly core pieces and a gathering cell in two authoritative stages', () => {
    const definition = skill('turalyon-grand-crusade')
    const turalyon = makePiece({ instanceId: 'turalyon', templateId: 'turalyon', ownerPlayerId: 'player-red', x: 0, y: 0 }) as any
    turalyon.isCore = true
    turalyon.skills = [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 }]
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 1, y: 0 }) as any
    ally.isCore = true
    ally.statusTags = [{ id: 'existing-grand-crusade-shield', type: 'divine-shield' }]
    const nonCore = makePiece({ instanceId: 'non-core', ownerPlayerId: 'player-red', x: 2, y: 0 }) as any
    nonCore.isCore = false
    const state = makeState({ pieces: [turalyon, ally, nonCore], width: 8, height: 8, turnNumber: 1 }) as any
    state.skillsById[definition.id] = definition
    state.players[0].actionPoints = 4
    state.players[0].chargePoints = 1

    const use = (input: any) => {
      const pending = applyBattleAction(input, { type: 'useChargeSkill', playerId: 'player-red', pieceId: 'turalyon', skillId: definition.id } as any) as any
      expect(pending.players[0]).toMatchObject({ actionPoints: 4, chargePoints: 1 })
      expect(pending.pendingOptionSelection).toBeUndefined()
      expect(pending.pendingTargetSelection).toMatchObject({
        targetType: 'piece', selectionMode: 'multi', minSelections: 1, maxSelections: 3,
      })
      expect(pending.pendingTargetSelection.candidates).toEqual([
        { type: 'piece', pieceId: 'ally' },
        { type: 'piece', pieceId: 'turalyon' },
      ])

      const beforeInvalid = JSON.stringify(pending)
      expect(() => applyBattleAction(pending, {
        type: 'pendingTargetSelect', playerId: 'player-red', targetPieceId: 'ally',
        extraTargets: [{ pieceId: 'ally' }],
        selectionId: pending.pendingTargetSelection.selectionId,
        stateRevision: pending.pendingTargetSelection.stateRevision,
      } as any)).toThrow(/duplicate/i)
      expect(JSON.stringify(pending)).toBe(beforeInvalid)

      const gatheringPending = applyBattleAction(pending, {
        type: 'pendingTargetSelect', playerId: 'player-red', targetPieceId: 'turalyon',
        extraTargets: [{ pieceId: 'ally' }],
        selectionId: pending.pendingTargetSelection.selectionId,
        stateRevision: pending.pendingTargetSelection.stateRevision,
      } as any) as any
      expect(gatheringPending.players[0]).toMatchObject({ actionPoints: 4, chargePoints: 1 })
      expect(gatheringPending.pendingOptionSelection).toBeUndefined()
      expect(gatheringPending.pendingTargetSelection).toMatchObject({
        targetType: 'grid', selectionMode: 'single', minSelections: 1, maxSelections: 1,
      })
      expect(gatheringPending.pendingTargetSelection.candidates.length).toBeGreaterThan(0)
      const destination = gatheringPending.pendingTargetSelection.candidates[0]
      return applyBattleAction(gatheringPending, {
        type: 'pendingTargetSelect', playerId: 'player-red', targetX: destination.x, targetY: destination.y,
        selectionId: gatheringPending.pendingTargetSelection.selectionId,
        stateRevision: gatheringPending.pendingTargetSelection.stateRevision,
      } as any) as any
    }

    const first = use(state)
    expect(first.players[0]).toMatchObject({ actionPoints: 0, chargePoints: 0 })
    expect(first.pieces.find((piece: any) => piece.instanceId === 'turalyon').skills[0]).toMatchObject({ currentCooldown: 3, usesRemaining: -1 })
    expect(first.pieces.find((piece: any) => piece.instanceId === 'turalyon').statusTags.some((tag: any) => tag.type === 'divine-shield')).toBe(true)
    expect(first.pieces.find((piece: any) => piece.instanceId === 'ally').statusTags.some((tag: any) => tag.type === 'divine-shield')).toBe(true)
    expect(first.pieces.find((piece: any) => piece.instanceId === 'ally').statusTags.filter((tag: any) => tag.type === 'divine-shield')).toHaveLength(1)
    expect(first.pieces.find((piece: any) => piece.instanceId === 'non-core').statusTags.some((tag: any) => tag.type === 'divine-shield')).toBe(false)

    first.turn.turnNumber = 2
    first.turn.phase = 'action'
    first.players[0].actionPoints = 4
    first.players[0].chargePoints = 1
    first.players[0].perTurnFlags.hasUsedChargeSkill = false
    first.pieces.find((piece: any) => piece.instanceId === 'turalyon').skills[0].currentCooldown = 0
    const second = use(first)
    expect(second.pieces.find((piece: any) => piece.instanceId === 'turalyon').skills[0].usesRemaining).toBe(-1)
  })

  it('rolls back AP, charge, cooldown, and movement when either Grand Crusade stage is cancelled', () => {
    const definition = skill('turalyon-grand-crusade')
    const turalyon = makePiece({ instanceId: 'cancel-turalyon', templateId: 'turalyon', ownerPlayerId: 'player-red', x: 0, y: 0 }) as any
    turalyon.isCore = true
    turalyon.skills = [{ skillId: definition.id, currentCooldown: 0, usesRemaining: -1 }]
    const ally = makePiece({ instanceId: 'cancel-ally', ownerPlayerId: 'player-red', x: 1, y: 0 }) as any
    ally.isCore = true
    const state = makeState({ pieces: [turalyon, ally], width: 8, height: 8, turnNumber: 1 }) as any
    state.skillsById[definition.id] = definition
    state.players[0].actionPoints = 4
    state.players[0].chargePoints = 1
    const start = () => applyBattleAction(state, {
      type: 'useChargeSkill', playerId: 'player-red', pieceId: 'cancel-turalyon', skillId: definition.id,
    } as any) as any
    const cancel = (pendingState: any) => applyBattleAction(pendingState, {
      type: 'cancelPendingSelection', playerId: 'player-red',
      selectionId: pendingState.pendingTargetSelection.selectionId,
      stateRevision: pendingState.pendingTargetSelection.stateRevision,
    } as any) as any
    const expectRolledBack = (result: any) => {
      expect(result.pendingTargetSelection).toBeUndefined()
      expect(result.players[0]).toMatchObject({ actionPoints: 4, chargePoints: 1 })
      expect(result.pieces.find((piece: any) => piece.instanceId === 'cancel-turalyon')).toMatchObject({ x: 0, y: 0 })
      expect(result.pieces.find((piece: any) => piece.instanceId === 'cancel-turalyon').skills[0].currentCooldown).toBe(0)
      expect(result.pieces.find((piece: any) => piece.instanceId === 'cancel-ally')).toMatchObject({ x: 1, y: 0 })
    }

    expectRolledBack(cancel(start()))

    const firstStage = start()
    const secondStage = applyBattleAction(firstStage, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetPieceId: 'cancel-turalyon',
      extraTargets: [{ pieceId: 'cancel-ally' }],
      selectionId: firstStage.pendingTargetSelection.selectionId,
      stateRevision: firstStage.pendingTargetSelection.stateRevision,
    } as any) as any
    expect(secondStage.pendingTargetSelection.targetType).toBe('grid')
    expectRolledBack(cancel(secondStage))
  })
})
