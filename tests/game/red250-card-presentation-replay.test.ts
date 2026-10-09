/* eslint-disable @typescript-eslint/no-explicit-any -- this regression inspects rule snapshots and presentation facts. */
import { describe, expect, it } from 'vitest'

import { recordBattlePresentation, recordedBattlePresentation } from '@/lib/game/battle-presentation-recording'
import { projectBattlePresentationEvents } from '@/lib/game/battle-presentation-events'
import { hashStable, runBattleAction } from '@/lib/game/battle-runner'
import { toPublicBattleState } from '@/lib/game/deployment'
import { loadRuleById } from '@/lib/game/skills'
import type { SkillChoiceInput } from '@/lib/game/skill-choice-sequence'
import { preparePublicSkillAction } from '@/lib/game/skill-preview'
import type { BattleAction } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

function makeHolyCardState(cardId = 'holy-smite') {
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
  const enemy = makePiece({
    instanceId: 'red250-smite-enemy',
    templateId: 'test-enemy',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 5,
    y: 5,
    currentHp: 30,
    maxHp: 30,
  }) as any
  const state = makeState({
    pieces: [turalyon, ally, enemy],
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
    actionPointCost: 1,
  }]
  return state
}

function makeHolySmiteState() {
  return makeHolyCardState('holy-smite')
}

const rootAction = {
  type: 'playCard',
  playerId: 'player-red',
  cardInstanceId: 'red250-holy-smite',
} as BattleAction

function publicMarchChoicesFor(state: any, root: BattleAction, cancelStage: 0 | 1 | 2 = 0): SkillChoiceInput[] {
  const publicState = toPublicBattleState(state, 'player-red')
  const firstPreparation = preparePublicSkillAction(publicState, root, 'player-red')
  if (firstPreparation.status !== 'needs-input' || !firstPreparation.preparation) {
    throw new Error('Expected the first holy march prompt')
  }
  const firstChoice: SkillChoiceInput = {
    kind: 'target' as const,
    source: firstPreparation.preparation.source as SkillChoiceInput['source'],
    promptKey: firstPreparation.preparation.promptKey as string,
    ...(cancelStage === 1 ? { cancelled: true as const } : { targetPieceId: 'red250-ally' }),
  }
  if (cancelStage === 1) return [firstChoice]

  const secondPreparation = preparePublicSkillAction(publicState, {
    ...root,
    skillChoices: [firstChoice],
  } as BattleAction, 'player-red')
  if (secondPreparation.status !== 'needs-input' || !secondPreparation.preparation) {
    throw new Error('Expected the second holy march prompt')
  }
  const secondChoice: SkillChoiceInput = {
    kind: 'target' as const,
    source: secondPreparation.preparation.source as SkillChoiceInput['source'],
    promptKey: secondPreparation.preparation.promptKey as string,
    ...(cancelStage === 2 ? { cancelled: true as const } : { targetX: 2, targetY: 1 }),
  }
  return [firstChoice, secondChoice]
}

function publicMarchChoices(state: any, cancelStage: 0 | 1 | 2 = 0): SkillChoiceInput[] {
  return publicMarchChoicesFor(state, rootAction, cancelStage)
}

function runRecorded(state: any, choices: SkillChoiceInput[]) {
  return recordBattlePresentation(
    state,
    () => runBattleAction(state, { ...rootAction, skillChoices: choices } as BattleAction, { rootSeed: 250 }),
    result => result.state,
  )
}

describe('RED-250 card presentation replay', () => {
  it.each([
    ['both march choices', 0],
    ['cancel at the first march choice', 1],
    ['cancel at the second march choice', 2],
  ] as const)('records one committed holy-smite damage after %s', (_label, cancelStage) => {
    const state = makeHolySmiteState()
    const choices = publicMarchChoices(state, cancelStage)
    const action = { ...rootAction, skillChoices: choices } as BattleAction & { skillChoices: SkillChoiceInput[] }
    const plain = runBattleAction(state, action, { rootSeed: 250 })
    const result = recordBattlePresentation(
      state,
      () => runBattleAction(state, action, { rootSeed: 250 }),
      reduced => reduced.state,
    )
    expect(result.stateHash).toBe(plain.stateHash)
    expect(result.state).toEqual(plain.state)
    const events = projectBattlePresentationEvents({
      actionId: `red250-holy-smite-${cancelStage}`,
      command: action,
      beforeState: state,
      afterState: result.state,
    })

    expect(result.state.pieces.find((piece: any) => piece.instanceId === 'red250-smite-enemy'))
      .toMatchObject({ currentHp: 25 })
    expect(events.filter(event => event.kind === 'damage')).toEqual([
      expect.objectContaining({
        targetPieceIds: ['red250-smite-enemy'],
        result: { amount: 5, value: 25 },
      }),
    ])
    expect(events.filter(event => event.kind === 'heal')).toEqual([])
    expect(state.pieces.find((piece: any) => piece.instanceId === 'red250-smite-enemy'))
      .toMatchObject({ currentHp: 30 })
  })

  it.each([
    ['both march choices', 0],
    ['cancel at the first march choice', 1],
  ] as const)('keeps one committed holy-heal after %s', (_label, cancelStage) => {
    const state = makeHolyCardState('holy-heal')
    const root = { ...rootAction, cardInstanceId: 'red250-holy-heal' } as BattleAction
    const choices = publicMarchChoicesFor(state, root, cancelStage)
    const action = { ...root, skillChoices: choices } as BattleAction & { skillChoices: SkillChoiceInput[] }
    const plain = runBattleAction(state, action, { rootSeed: 250 })
    const result = recordBattlePresentation(
      state,
      () => runBattleAction(state, action, { rootSeed: 250 }),
      reduced => reduced.state,
    )
    expect(result.stateHash).toBe(plain.stateHash)
    const events = projectBattlePresentationEvents({
      actionId: `red250-holy-heal-${cancelStage}`,
      command: action,
      beforeState: state,
      afterState: result.state,
    })

    expect(result.state.pieces.find((piece: any) => piece.instanceId === 'red250-ally'))
      .toMatchObject({ currentHp: 10 })
    expect(events.filter(event => event.kind === 'heal')).toEqual([
      expect.objectContaining({
        targetPieceIds: ['red250-ally'],
        result: { amount: 5, value: 10 },
      }),
    ])
    expect(events.filter(event => event.kind === 'damage')).toEqual([])
  })

  it('keeps the original state and recorder clean when replay fails', () => {
    const state = makeHolySmiteState()
    const beforeHash = hashStable(state)
    const choices = publicMarchChoices(state, 0)!
    const invalidChoices = choices.map((choice: any) => ({ ...choice }))
    invalidChoices[1].targetX = 99
    invalidChoices[1].targetY = 99

    expect(() => runRecorded(state, invalidChoices)).toThrow()
    expect(hashStable(state)).toBe(beforeHash)
    expect(state.pieces.find((piece: any) => piece.instanceId === 'red250-smite-enemy'))
      .toMatchObject({ currentHp: 30 })
    expect(recordedBattlePresentation(state)).toBeUndefined()
  })
})
