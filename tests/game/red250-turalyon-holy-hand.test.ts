/* eslint-disable @typescript-eslint/no-explicit-any -- this regression inspects the public and authority battle snapshots. */
import { describe, expect, it } from 'vitest'

import { hashStable, runBattleAction } from '@/lib/game/battle-runner'
import { toPublicBattleState } from '@/lib/game/deployment'
import { readSkillChoices } from '@/lib/game/skill-choice-sequence'
import { preparePublicSkillAction } from '@/lib/game/skill-preview'
import { loadRuleById } from '@/lib/game/skills'
import type { BattleAction } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

function makeHolyHandState(cardId = 'holy-heal', actionPointCost = 2) {
  const turalyon = makePiece({
    instanceId: 'red250-turalyon',
    templateId: 'turalyon',
    ownerPlayerId: 'player-red',
    x: 0,
    y: 0,
  }) as any
  turalyon.rules = [loadRuleById('rule-turalyon-lightforged-march', true)!]
  const ally = makePiece({
    instanceId: 'red250-ally',
    ownerPlayerId: 'player-red',
    x: 1,
    y: 1,
    moveRange: 3,
    currentHp: 5,
    maxHp: 10,
  }) as any
  const state = makeState({
    pieces: [turalyon, ally],
    currentPlayerId: 'player-red',
    width: 8,
    height: 8,
    turnNumber: 1,
  }) as any
  state.players[0].actionPoints = 3
  state.players[0].hand = [{
    cardId,
    instanceId: `red250-${cardId}`,
    ownerPlayerId: 'player-red',
    actionPointCost,
  }]
  return state
}

function publicMarchChoices(state: any, root: BattleAction) {
  const publicState = toPublicBattleState(state, 'player-red')
  const firstPreparation = preparePublicSkillAction(publicState, root, 'player-red')
  if (firstPreparation.status !== 'needs-input' || !firstPreparation.preparation) {
    throw new Error('Expected public first holy march choice')
  }
  const firstChoice = {
    kind: 'target' as const,
    source: firstPreparation.preparation.source,
    promptKey: firstPreparation.preparation.promptKey,
    targetPieceId: 'red250-ally',
  }
  const secondPreparation = preparePublicSkillAction(publicState, {
    ...root,
    skillChoices: [firstChoice],
  } as BattleAction, 'player-red')
  if (secondPreparation.status !== 'needs-input' || !secondPreparation.preparation) {
    throw new Error('Expected public second holy march choice')
  }
  const secondChoice = {
    kind: 'target' as const,
    source: secondPreparation.preparation.source,
    promptKey: secondPreparation.preparation.promptKey,
    targetX: 2,
    targetY: 1,
  }
  return {
    choices: [firstChoice, secondChoice],
    completedPreview: preparePublicSkillAction(publicState, {
      ...root,
      skillChoices: [firstChoice, secondChoice],
    } as BattleAction, 'player-red'),
  }
}

describe('RED-250 Turalyon holy-hand authority continuation', () => {
  it('keeps a complete local card root pending, then resolves the two march choices once', () => {
    const authorityState = makeHolyHandState()
    const root = {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'red250-holy-heal',
      // These fields are the complete local card draft. They are card-root
      // inputs and must not be mistaken for the afterCardPlay rule answers.
      targetPieceId: 'red250-ally',
      targetX: 1,
      targetY: 1,
      extraTargets: [{ x: 2, y: 1 }],
    } as BattleAction

    const publicPreparation = preparePublicSkillAction(
      toPublicBattleState(authorityState, 'player-red'),
      root,
      'player-red',
    )
    expect(publicPreparation).toMatchObject({
      status: 'needs-input',
      preparation: {
        kind: 'needTarget',
        continuation: true,
        source: {
          type: 'rule',
          id: 'rule-turalyon-lightforged-march',
          pieceId: 'red250-turalyon',
        },
        targetType: 'piece',
        candidates: expect.arrayContaining([{ type: 'piece', pieceId: 'red250-ally' }]),
      },
    })

    const pending = runBattleAction(authorityState, root, { rootSeed: 250 }).state as any
    expect(pending.pendingTargetSelection).toMatchObject({
      source: {
        type: 'rule',
        id: 'rule-turalyon-lightforged-march',
        pieceId: 'red250-turalyon',
      },
      targetType: 'piece',
      candidates: expect.arrayContaining([{ type: 'piece', pieceId: 'red250-ally' }]),
    })
    expect(pending.players[0]).toMatchObject({ actionPoints: 3, hand: expect.any(Array), discardPile: [] })

    const destinationPending = runBattleAction(pending, {
      type: 'pendingTargetSelect',
      playerId: 'player-red',
      targetPieceId: 'red250-ally',
      selectionId: pending.pendingTargetSelection.selectionId,
      stateRevision: pending.pendingTargetSelection.stateRevision,
    } as BattleAction, { rootSeed: 250 }).state as any
    expect(destinationPending.pendingTargetSelection).toMatchObject({
      source: {
        type: 'rule',
        id: 'rule-turalyon-lightforged-march',
        pieceId: 'red250-turalyon',
      },
      targetType: 'grid',
      candidates: expect.arrayContaining([{ type: 'cell', x: 2, y: 1 }]),
    })
    expect(destinationPending.players[0]).toMatchObject({ actionPoints: 3, discardPile: [] })

    const resolved = runBattleAction(destinationPending, {
      type: 'pendingTargetSelect',
      playerId: 'player-red',
      targetX: 2,
      targetY: 1,
      selectionId: destinationPending.pendingTargetSelection.selectionId,
      stateRevision: destinationPending.pendingTargetSelection.stateRevision,
    } as BattleAction, { rootSeed: 250 }).state as any

    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolved.pendingOptionSelection).toBeUndefined()
    expect(resolved.players[0]).toMatchObject({ actionPoints: 1, hand: [], discardPile: ['holy-heal'] })
    expect(resolved.pieces.find((piece: any) => piece.instanceId === 'red250-ally'))
      .toMatchObject({ x: 2, y: 1, currentHp: 10 })
    expect(resolved.actions.filter((entry: any) => entry.type === 'playCard')).toHaveLength(1)
  })

  it('replays both public march choices inside one card root action', () => {
    const authorityState = makeHolyHandState()
    const root = {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'red250-holy-heal',
      targetPieceId: 'red250-ally',
      targetX: 1,
      targetY: 1,
      extraTargets: [{ x: 2, y: 1 }],
    } as BattleAction
    const publicState = toPublicBattleState(authorityState, 'player-red')

    const firstPreparation = preparePublicSkillAction(publicState, root, 'player-red')
    expect(firstPreparation.status).toBe('needs-input')
    if (firstPreparation.status !== 'needs-input' || !firstPreparation.preparation) return
    const firstChoice = {
      kind: 'target' as const,
      source: firstPreparation.preparation.source,
      promptKey: firstPreparation.preparation.promptKey,
      targetPieceId: 'red250-ally',
    }

    const secondPreparation = preparePublicSkillAction(publicState, {
      ...root,
      skillChoices: [firstChoice],
    } as BattleAction, 'player-red')
    expect(secondPreparation).toMatchObject({
      status: 'needs-input',
      preparation: {
        kind: 'needTarget',
        continuation: true,
        source: {
          type: 'rule',
          id: 'rule-turalyon-lightforged-march',
          pieceId: 'red250-turalyon',
        },
        targetType: 'cell',
      },
    })
    if (secondPreparation.status !== 'needs-input' || !secondPreparation.preparation) return
    const secondChoice = {
      kind: 'target' as const,
      source: secondPreparation.preparation.source,
      promptKey: secondPreparation.preparation.promptKey,
      targetX: 2,
      targetY: 1,
    }

    const completedPreview = preparePublicSkillAction(publicState, {
      ...root,
      skillChoices: [firstChoice, secondChoice],
    } as BattleAction, 'player-red')
    expect(completedPreview.status).toBe('ready')

    const resolved = runBattleAction(authorityState, {
      ...root,
      skillChoices: [firstChoice, secondChoice],
    } as BattleAction, { rootSeed: 250 }).state as any
    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolved.pendingOptionSelection).toBeUndefined()
    expect(resolved.players[0]).toMatchObject({ actionPoints: 1, hand: [], discardPile: ['holy-heal'] })
    expect(resolved.pieces.find((piece: any) => piece.instanceId === 'red250-ally'))
      .toMatchObject({ x: 2, y: 1, currentHp: 10 })
    expect(resolved.actions.filter((entry: any) => entry.type === 'playCard')).toHaveLength(1)
  })

  it('settles holy smite damage once after both march choices', () => {
    const authorityState = makeHolyHandState('holy-smite', 1)
    authorityState.pieces.push(makePiece({
      instanceId: 'red250-smite-enemy',
      templateId: 'test-enemy',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 5,
      y: 5,
      currentHp: 30,
      maxHp: 30,
    }) as any)
    const root = {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'red250-holy-smite',
    } as BattleAction
    const { choices, completedPreview } = publicMarchChoices(authorityState, root)
    expect(completedPreview.status).toBe('ready')

    const resolved = runBattleAction(authorityState, {
      ...root,
      skillChoices: choices,
    } as BattleAction, { rootSeed: 250 }).state as any
    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolved.players[0]).toMatchObject({ actionPoints: 2, hand: [], discardPile: ['holy-smite'] })
    expect(resolved.pieces.find((piece: any) => piece.instanceId === 'red250-smite-enemy'))
      .toMatchObject({ currentHp: 25 })
    expect(resolved.pieces.find((piece: any) => piece.instanceId === 'red250-ally'))
      .toMatchObject({ x: 2, y: 1 })
    expect(resolved.actions.filter((entry: any) => entry.type === 'playCard')).toHaveLength(1)
    expect(resolved.actions.filter((entry: any) => entry.type === 'damage'
      && entry.payload?.skillId === 'holy-smite')).toHaveLength(1)
  })

  it('applies holy charge to each ally once after both march choices', () => {
    const authorityState = makeHolyHandState('holy-charge', 1)
    const root = {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'red250-holy-charge',
    } as BattleAction
    const { choices, completedPreview } = publicMarchChoices(authorityState, root)
    expect(completedPreview.status).toBe('ready')

    const resolved = runBattleAction(authorityState, {
      ...root,
      skillChoices: choices,
    } as BattleAction, { rootSeed: 250 }).state as any
    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolved.players[0]).toMatchObject({ actionPoints: 2, hand: [], discardPile: ['holy-charge'] })
    for (const piece of resolved.pieces.filter((candidate: any) => candidate.ownerPlayerId === 'player-red')) {
      expect(piece.statusTags.filter((tag: any) => tag.id === 'damage-buff')).toHaveLength(1)
      expect(piece.statusTags.find((tag: any) => tag.id === 'damage-buff'))
        .toMatchObject({ currentUses: 1, intensity: 2 })
      expect(piece.rules.filter((rule: any) => rule.id === 'rule-damage-buff')).toHaveLength(1)
    }
    expect(resolved.actions.filter((entry: any) => entry.type === 'playCard')).toHaveLength(1)
  })

  it('replays a public cancel choice through the card transaction', () => {
    const authorityState = makeHolyHandState()
    const root = {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'red250-holy-heal',
    } as BattleAction
    const publicState = toPublicBattleState(authorityState, 'player-red')
    const preparation = preparePublicSkillAction(publicState, root, 'player-red')
    expect(preparation.status).toBe('needs-input')
    if (preparation.status !== 'needs-input' || !preparation.preparation) return

    const cancelChoice = {
      kind: 'target' as const,
      source: preparation.preparation.source,
      promptKey: preparation.preparation.promptKey,
      cancelled: true,
    }
    const completedPreview = preparePublicSkillAction(publicState, {
      ...root,
      skillChoices: [cancelChoice],
    } as BattleAction, 'player-red')
    expect(completedPreview.status).toBe('ready')

    const resolved = runBattleAction(authorityState, {
      ...root,
      skillChoices: [cancelChoice],
    } as BattleAction, { rootSeed: 250 }).state as any
    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolved.players[0]).toMatchObject({ actionPoints: 1, hand: [], discardPile: ['holy-heal'] })
    expect(resolved.pieces.find((piece: any) => piece.instanceId === 'red250-ally'))
      .toMatchObject({ x: 1, y: 1, currentHp: 10 })
    expect(resolved.actions.filter((entry: any) => entry.type === 'playCard')).toHaveLength(1)
  })

  it('cancels the second march prompt without undoing the holy card effect', () => {
    const authorityState = makeHolyHandState()
    const root = {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'red250-holy-heal',
    } as BattleAction
    const publicState = toPublicBattleState(authorityState, 'player-red')
    const firstPreparation = preparePublicSkillAction(publicState, root, 'player-red')
    expect(firstPreparation.status).toBe('needs-input')
    if (firstPreparation.status !== 'needs-input' || !firstPreparation.preparation) return
    const firstChoice = {
      kind: 'target' as const,
      source: firstPreparation.preparation.source,
      promptKey: firstPreparation.preparation.promptKey,
      targetPieceId: 'red250-ally',
    }
    const secondPreparation = preparePublicSkillAction(publicState, {
      ...root,
      skillChoices: [firstChoice],
    } as BattleAction, 'player-red')
    expect(secondPreparation.status).toBe('needs-input')
    if (secondPreparation.status !== 'needs-input' || !secondPreparation.preparation) return
    const secondCancel = {
      kind: 'target' as const,
      source: secondPreparation.preparation.source,
      promptKey: secondPreparation.preparation.promptKey,
      cancelled: true,
    }

    const completedPreview = preparePublicSkillAction(publicState, {
      ...root,
      skillChoices: [firstChoice, secondCancel],
    } as BattleAction, 'player-red')
    expect(completedPreview.status).toBe('ready')

    const resolved = runBattleAction(authorityState, {
      ...root,
      skillChoices: [firstChoice, secondCancel],
    } as BattleAction, { rootSeed: 250 }).state as any
    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolved.players[0]).toMatchObject({ actionPoints: 1, hand: [], discardPile: ['holy-heal'] })
    expect(resolved.pieces.find((piece: any) => piece.instanceId === 'red250-ally'))
      .toMatchObject({ x: 1, y: 1, currentHp: 10 })
  })

  it('leaves the authority pending on a forged or stale public choice', () => {
    const authorityState = makeHolyHandState()
    const root = {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'red250-holy-heal',
    } as BattleAction
    const publicState = toPublicBattleState(authorityState, 'player-red')
    const preparation = preparePublicSkillAction(publicState, root, 'player-red')
    expect(preparation.status).toBe('needs-input')
    if (preparation.status !== 'needs-input' || !preparation.preparation) return
    const promptKey = preparation.preparation.promptKey as string
    const forgedPromptKey = `${promptKey.slice(0, -1)}${promptKey.endsWith('0') ? '1' : '0'}`
    const forgedChoice = {
      kind: 'target' as const,
      source: preparation.preparation.source,
      promptKey: forgedPromptKey,
      targetPieceId: 'red250-ally',
    }
    expect(() => readSkillChoices([{ ...forgedChoice, cancelled: true }])).toThrow()

    const forged = runBattleAction(authorityState, {
      ...root,
      skillChoices: [forgedChoice],
    } as BattleAction, { rootSeed: 250 }).state as any
    expect(forged.pendingTargetSelection).toMatchObject({
      targetType: 'piece',
      source: { type: 'rule', id: 'rule-turalyon-lightforged-march' },
    })
    expect(forged.players[0]).toMatchObject({ actionPoints: 3, discardPile: [] })

    const staleState = makeHolyHandState()
    const staleHash = hashStable(staleState)
    expect(() => runBattleAction(staleState, {
      ...root,
      stateRevision: 99,
      skillChoices: [],
    } as BattleAction, { rootSeed: 250 })).toThrow()
    expect(hashStable(staleState)).toBe(staleHash)
    expect(staleState.players[0]).toMatchObject({ actionPoints: 3, discardPile: [] })
  })

  it('rejects an enemy candidate under a valid prompt and can retry from the unchanged state', () => {
    const authorityState = makeHolyHandState()
    authorityState.pieces.push(makePiece({
      instanceId: 'red250-invalid-enemy',
      templateId: 'test-enemy',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 5,
      y: 5,
    }) as any)
    const root = {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'red250-holy-heal',
    } as BattleAction
    const publicPreparation = preparePublicSkillAction(
      toPublicBattleState(authorityState, 'player-red'),
      root,
      'player-red',
    )
    expect(publicPreparation.status).toBe('needs-input')
    if (publicPreparation.status !== 'needs-input' || !publicPreparation.preparation) return
    const invalidChoice = {
      kind: 'target' as const,
      source: publicPreparation.preparation.source,
      promptKey: publicPreparation.preparation.promptKey,
      targetPieceId: 'red250-invalid-enemy',
    }
    const beforeHash = hashStable(authorityState)
    expect(() => runBattleAction(authorityState, {
      ...root,
      skillChoices: [invalidChoice],
    } as BattleAction, { rootSeed: 250 })).toThrow()
    expect(hashStable(authorityState)).toBe(beforeHash)
    expect(authorityState.players[0]).toMatchObject({ actionPoints: 3, discardPile: [] })
    expect(authorityState.pendingTargetSelection).toBeUndefined()

    const { choices, completedPreview } = publicMarchChoices(authorityState, root)
    expect(completedPreview.status).toBe('ready')
    const resolved = runBattleAction(authorityState, {
      ...root,
      skillChoices: choices,
    } as BattleAction, { rootSeed: 250 }).state as any
    expect(resolved.players[0]).toMatchObject({ actionPoints: 1, hand: [], discardPile: ['holy-heal'] })
    expect(resolved.pendingTargetSelection).toBeUndefined()
  })

  it('rejects an occupied landing under a valid prompt and can retry with a legal cell', () => {
    const authorityState = makeHolyHandState()
    authorityState.pieces.push(makePiece({
      instanceId: 'red250-occupied-landing',
      ownerPlayerId: 'player-red',
      x: 2,
      y: 1,
    }) as any)
    const root = {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'red250-holy-heal',
    } as BattleAction
    const publicState = toPublicBattleState(authorityState, 'player-red')
    const firstPreparation = preparePublicSkillAction(publicState, root, 'player-red')
    expect(firstPreparation.status).toBe('needs-input')
    if (firstPreparation.status !== 'needs-input' || !firstPreparation.preparation) return
    const firstChoice = {
      kind: 'target' as const,
      source: firstPreparation.preparation.source,
      promptKey: firstPreparation.preparation.promptKey,
      targetPieceId: 'red250-ally',
    }
    const secondPreparation = preparePublicSkillAction(publicState, {
      ...root,
      skillChoices: [firstChoice],
    } as BattleAction, 'player-red')
    expect(secondPreparation.status).toBe('needs-input')
    if (secondPreparation.status !== 'needs-input' || !secondPreparation.preparation) return
    expect(secondPreparation.preparation.candidates).toContainEqual({ type: 'cell', x: 3, y: 2 })
    const invalidLanding = {
      kind: 'target' as const,
      source: secondPreparation.preparation.source,
      promptKey: secondPreparation.preparation.promptKey,
      targetX: 2,
      targetY: 1,
    }
    const beforeHash = hashStable(authorityState)
    expect(() => runBattleAction(authorityState, {
      ...root,
      skillChoices: [firstChoice, invalidLanding],
    } as BattleAction, { rootSeed: 250 })).toThrow()
    expect(hashStable(authorityState)).toBe(beforeHash)
    expect(authorityState.players[0]).toMatchObject({ actionPoints: 3, discardPile: [] })
    expect(authorityState.pendingTargetSelection).toBeUndefined()

    const legalLanding = { ...invalidLanding, targetX: 3, targetY: 2 }
    const completedPreview = preparePublicSkillAction(publicState, {
      ...root,
      skillChoices: [firstChoice, legalLanding],
    } as BattleAction, 'player-red')
    expect(completedPreview.status).toBe('ready')
    const resolved = runBattleAction(authorityState, {
      ...root,
      skillChoices: [firstChoice, legalLanding],
    } as BattleAction, { rootSeed: 250 }).state as any
    expect(resolved.players[0]).toMatchObject({ actionPoints: 1, hand: [], discardPile: ['holy-heal'] })
    expect(resolved.pieces.find((piece: any) => piece.instanceId === 'red250-ally'))
      .toMatchObject({ x: 3, y: 2 })
  })

  it('opens a fresh march prompt for a second holy card and settles its effect once', () => {
    const authorityState = makeHolyHandState()
    authorityState.pieces.push(makePiece({
      instanceId: 'red250-smite-enemy',
      templateId: 'test-enemy',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 5,
      y: 5,
      currentHp: 30,
      maxHp: 30,
    }) as any)
    authorityState.players[0].actionPoints = 5
    authorityState.players[0].hand.push({
      cardId: 'holy-smite',
      instanceId: 'red250-holy-smite',
      ownerPlayerId: 'player-red',
      actionPointCost: 2,
    })
    const firstRoot = {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'red250-holy-heal',
    } as BattleAction
    const publicState = toPublicBattleState(authorityState, 'player-red')
    const firstPreparation = preparePublicSkillAction(publicState, firstRoot, 'player-red')
    expect(firstPreparation.status).toBe('needs-input')
    if (firstPreparation.status !== 'needs-input' || !firstPreparation.preparation) return
    const firstChoice = {
      kind: 'target' as const,
      source: firstPreparation.preparation.source,
      promptKey: firstPreparation.preparation.promptKey,
      targetPieceId: 'red250-ally',
    }
    const secondPreparation = preparePublicSkillAction(publicState, {
      ...firstRoot,
      skillChoices: [firstChoice],
    } as BattleAction, 'player-red')
    expect(secondPreparation.status).toBe('needs-input')
    if (secondPreparation.status !== 'needs-input' || !secondPreparation.preparation) return
    const secondChoice = {
      kind: 'target' as const,
      source: secondPreparation.preparation.source,
      promptKey: secondPreparation.preparation.promptKey,
      targetX: 2,
      targetY: 1,
    }
    const firstResolved = runBattleAction(authorityState, {
      ...firstRoot,
      skillChoices: [firstChoice, secondChoice],
    } as BattleAction, { rootSeed: 250 }).state as any
    expect(firstResolved.players[0]).toMatchObject({
      actionPoints: 3,
      hand: [{ cardId: 'holy-smite' }],
      discardPile: ['holy-heal'],
    })
    expect(firstResolved.pieces.find((piece: any) => piece.instanceId === 'red250-smite-enemy'))
      .toMatchObject({ currentHp: 30 })

    const secondPending = runBattleAction(firstResolved, {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'red250-holy-smite',
    } as BattleAction, { rootSeed: 250 }).state as any
    expect(secondPending.pendingTargetSelection).toMatchObject({
      targetType: 'piece',
      candidates: expect.arrayContaining([{ type: 'piece', pieceId: 'red250-ally' }]),
    })
    expect(secondPending.players[0]).toMatchObject({
      actionPoints: 3,
      hand: [{ cardId: 'holy-smite', instanceId: 'red250-holy-smite' }],
      discardPile: ['holy-heal'],
    })
    const secondDestination = runBattleAction(secondPending, {
      type: 'pendingTargetSelect',
      playerId: 'player-red',
      targetPieceId: 'red250-ally',
      selectionId: secondPending.pendingTargetSelection.selectionId,
      stateRevision: secondPending.pendingTargetSelection.stateRevision,
    } as BattleAction, { rootSeed: 250 }).state as any
    expect(secondDestination.pendingTargetSelection).toMatchObject({
      targetType: 'grid',
      candidates: expect.arrayContaining([{ type: 'cell', x: 3, y: 1 }]),
    })

    const secondResolved = runBattleAction(secondDestination, {
      type: 'pendingTargetSelect',
      playerId: 'player-red',
      targetX: 3,
      targetY: 1,
      selectionId: secondDestination.pendingTargetSelection.selectionId,
      stateRevision: secondDestination.pendingTargetSelection.stateRevision,
    } as BattleAction, { rootSeed: 250 }).state as any
    expect(secondResolved.pendingTargetSelection).toBeUndefined()
    expect(secondResolved.players[0]).toMatchObject({
      actionPoints: 1,
      hand: [],
      discardPile: ['holy-heal', 'holy-smite'],
    })
    expect(secondResolved.pieces.find((piece: any) => piece.instanceId === 'red250-smite-enemy'))
      .toMatchObject({ currentHp: 25 })
    expect(secondResolved.actions.filter((entry: any) => entry.type === 'playCard')).toHaveLength(2)
    expect(secondResolved.actions.filter((entry: any) => entry.type === 'damage'
      && entry.payload?.skillId === 'holy-smite')).toHaveLength(1)
    expect(secondResolved.actions.filter((entry: any) => entry.type === 'move')).toHaveLength(2)
  })

  it('ignores a stale same-turn march marker, opens a fresh prompt, and keeps source IDs private', () => {
    const authorityState = makeHolyHandState()
    authorityState.turn.turnNumber = 2
    authorityState.pieces[0].instanceId = 'training-blue-2'
    authorityState.pieces.push(makePiece({
      instanceId: 'training-red-1',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 5,
      y: 5,
    }) as any)
    ;(authorityState.extensions as any).turalyonLightforgedTurns = {
      'training-blue-2': 2,
      'training-red-1': 2,
      'unknown-source': 2,
    }
    const root = {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'red250-holy-heal',
    } as BattleAction

    const ownerProjection = toPublicBattleState(authorityState, 'player-red')
    const opponentProjection = toPublicBattleState(authorityState, 'player-blue')
    const spectatorProjection = toPublicBattleState(authorityState)
    expect((ownerProjection.extensions as any).turalyonLightforgedTurns)
      .toEqual({ 'training-blue-2': 2 })
    expect((opponentProjection.extensions as any).turalyonLightforgedTurns)
      .toEqual({ 'training-red-1': 2 })
    expect((spectatorProjection.extensions as any).turalyonLightforgedTurns)
      .toEqual({})
    const unknownOnly = {
      ...authorityState,
      extensions: { ...authorityState.extensions },
    }
    ;(unknownOnly.extensions as any).turalyonLightforgedTurns = { 'unknown-source': 2 }
    expect((toPublicBattleState(unknownOnly, 'player-red').extensions as any).turalyonLightforgedTurns)
      .toEqual({})

    const ownerPreparation = preparePublicSkillAction(ownerProjection, root, 'player-red')
    expect(ownerPreparation).toMatchObject({
      status: 'needs-input',
      preparation: {
        targetType: 'piece',
        candidates: expect.arrayContaining([{ type: 'piece', pieceId: 'training-blue-2' }]),
      },
    })
    if (ownerPreparation.status !== 'needs-input' || !ownerPreparation.preparation) return
    expect(ownerPreparation.preparation.candidates)
      .not.toContainEqual({ type: 'piece', pieceId: 'training-red-1' })
    const firstChoice = {
      kind: 'target' as const,
      source: ownerPreparation.preparation.source,
      promptKey: ownerPreparation.preparation.promptKey,
      targetPieceId: 'training-blue-2',
    }
    const destinationPreparation = preparePublicSkillAction(ownerProjection, {
      ...root,
      skillChoices: [firstChoice],
    } as BattleAction, 'player-red')
    expect(destinationPreparation).toMatchObject({
      status: 'needs-input',
      preparation: {
        targetType: 'cell',
        candidates: expect.arrayContaining([{ type: 'cell', x: 1, y: 0 }]),
      },
    })
    if (destinationPreparation.status !== 'needs-input' || !destinationPreparation.preparation) return
    const secondChoice = {
      kind: 'target' as const,
      source: destinationPreparation.preparation.source,
      promptKey: destinationPreparation.preparation.promptKey,
      targetX: 1,
      targetY: 0,
    }
    const accepted = runBattleAction(authorityState, {
      ...root,
      skillChoices: [firstChoice, secondChoice],
    } as BattleAction, { rootSeed: 250 }).state as any
    expect(accepted.pendingTargetSelection).toBeUndefined()
    expect(accepted.players[0]).toMatchObject({ actionPoints: 1, hand: [], discardPile: ['holy-heal'] })
    expect(accepted.pieces.find((piece: any) => piece.instanceId === 'training-blue-2'))
      .toMatchObject({ x: 1, y: 0 })

    const nextTurn = makeHolyHandState()
    nextTurn.turn.turnNumber = 3
    nextTurn.pieces[0].instanceId = 'training-blue-2'
    ;(nextTurn.extensions as any).turalyonLightforgedTurns = { 'training-blue-2': 2 }
    expect(preparePublicSkillAction(
      toPublicBattleState(nextTurn, 'player-red'),
      root,
      'player-red',
    ).status).toBe('needs-input')
  })
})
