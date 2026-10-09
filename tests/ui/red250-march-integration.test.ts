/* eslint-disable @typescript-eslint/no-explicit-any -- battle.html runs in a browser VM. */
import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

import { recordBattlePresentation } from '@/lib/game/battle-presentation-recording'
import { loadRuleById } from '@/lib/game/skills'
import { preparePublicSkillAction } from '@/lib/game/skill-preview'
import { applyBattleAction, safeCloneBattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const page = readFileSync('data/pages/battle.html', 'utf8').replace(/\r\n/g, '\n')

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function runtimeFunction(name: string) {
  const marker = `function ${name}(`
  const start = page.indexOf(marker)
  if (start < 0) throw new Error(`Missing function: ${name}`)
  const bodyStart = page.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < page.length; index += 1) {
    if (page[index] === '{') depth += 1
    else if (page[index] === '}') {
      depth -= 1
      if (depth === 0) return page.slice(start, index + 1)
    }
  }
  throw new Error(`Unclosed function: ${name}`)
}

function asyncRuntimeFunction(name: string) {
  const marker = `async function ${name}(`
  const start = page.indexOf(marker)
  if (start < 0) throw new Error(`Missing async function: ${name}`)
  const bodyStart = page.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < page.length; index += 1) {
    if (page[index] === '{') depth += 1
    else if (page[index] === '}') {
      depth -= 1
      if (depth === 0) return page.slice(start, index + 1)
    }
  }
  throw new Error(`Unclosed async function: ${name}`)
}

function coreEngine() {
  return {
    applyBattleAction: (state: any, action: any) => applyBattleAction(state, jsonClone(action)),
    preparePublicSkillAction: (state: any, action: any, viewer: string) =>
      preparePublicSkillAction(state, jsonClone(action), viewer),
    recordBattlePresentation,
    safeCloneBattleState,
  }
}

type Seat = 'player-red' | 'player-blue'

function makeHolyHandState(cardId = 'holy-smite', playerId: Seat = 'player-red') {
  const faction = playerId === 'player-red' ? 'red' : 'blue'
  const enemyPlayerId = playerId === 'player-red' ? 'player-blue' : 'player-red'
  const enemyFaction = faction === 'red' ? 'blue' : 'red'
  const turalyon = makePiece({
    instanceId: 'red250-turalyon',
    templateId: 'turalyon',
    ownerPlayerId: playerId,
    faction,
    x: 0,
    y: 0,
  }) as any
  turalyon.rules = [loadRuleById('rule-turalyon-lightforged-march', true)!]
  const ally = makePiece({
    instanceId: 'red250-ally',
    ownerPlayerId: playerId,
    faction,
    x: 1,
    y: 1,
    moveRange: 3,
    currentHp: 5,
    maxHp: 10,
  }) as any
  const enemy = makePiece({
    instanceId: 'red250-enemy',
    ownerPlayerId: enemyPlayerId,
    faction: enemyFaction,
    x: 5,
    y: 4,
    currentHp: 30,
    maxHp: 30,
  }) as any
  const state = makeState({
    pieces: [turalyon, ally, enemy],
    width: 8,
    height: 8,
    currentPlayerId: playerId,
  }) as any
  const player = state.players.find((entry: any) => entry.playerId === playerId)
  player.actionPoints = 10
  player.maxActionPoints = 10
  player.hand = [{
    cardId,
    instanceId: `${faction}250-${cardId}`,
    ownerPlayerId: playerId,
    actionPointCost: 1,
  }]
  return state
}

function createPageHarness(initialState: any, playerId: Seat = 'player-red') {
  const Engine = coreEngine()
  const commands: any[] = []
  const statuses: string[] = []
  const pendingActions: Promise<void>[] = []
  const faction = playerId === 'player-red' ? 'red' : 'blue'
  const context = createContext({
    ADVENTURE_MODE: false,
    SPECTATE_MODE: false,
    TRAINING_MODE: true,
    PRACTICE_MODE: false,
    TUTORIAL_MODE: false,
    params: { has: () => false },
    G: initialState,
    GameEngine: Engine,
    myPlayerId: playerId,
    myFaction: faction,
    selectedPieceId: 'red250-turalyon',
    skillsById: {},
    cardsById: {
      'holy-smite': JSON.parse(readFileSync('data/cards/holy-smite.json', 'utf8')),
    },
    commands,
    pendingActions,
    pendingCardAction: null,
    pendingSkill: null,
    pendingMove: false,
    pendingActionFeedback: null,
    targetSubmissionPending: null,
    targetSubmissionDraft: null,
    locallyCancelledSelectionId: null,
    red50Evidence: { targetCommands: [], rejections: [], clearEvents: [] },
    placingMode: false,
    deployment: null,
    adventureDeployPieceId: null,
    refreshBattleLegalActions: vi.fn(),
    adventureOpenCell: vi.fn(() => false),
    pendingOptionSelectionForMe: vi.fn(() => false),
    pendingOptionSelectionForOther: vi.fn(() => false),
    waitingForOtherPending: vi.fn(() => false),
    flushPresentationBeforePendingSelection: vi.fn(),
    syncPendingBoardTargetSelection: vi.fn(),
    updateRed43QaEvidence: vi.fn(),
    renderHand: vi.fn(),
    renderBoard: vi.fn(),
    renderActionBar: vi.fn(),
    renderTargetOverlay: vi.fn(),
    renderLocalCardPreparation: vi.fn(),
    renderPieceContextMenu: vi.fn(),
    clearSkillPreview: vi.fn(),
    render: vi.fn(),
    rememberTargetInteraction: vi.fn(),
    setMoveButtonClass: vi.fn(),
    targetStepPrefix: (index: number) => Number(index) > 0 ? `第${Number(index) + 1}步：` : '',
    targetTypeText: (targetType: string, filter: string) => targetType === 'cell'
      ? '选择一个地格'
      : filter === 'ally' ? '选择一个友方角色' : '选择目标',
    setStatusMsg: vi.fn((message: string) => statuses.push(message)),
    tutorialActionAllowed: () => true,
    document: {
      body: { classList: { toggle: vi.fn() } },
      getElementById: () => ({ classList: { remove: vi.fn(), toggle: vi.fn() }, disabled: false, textContent: '' }),
    },
    window: {
      refreshTargetSkillButtonState: vi.fn(),
      RvBGameEngine: { ensure: async () => Engine },
    },
    Date,
  })

  const source = [
    'var pendingCardAction = null; var pendingSkill = null; var targetSubmissionPending = null; var targetSubmissionDraft = null; var pendingMove = false; var pendingOptionAction = null; var _pickerOptions = []; var pendingHandOptionSelection = { selectionId: null, selectedValues: [], submitting: false }; var _pendingChoiceShown = null;',
    'var pendingBoardTargetSelection = { selectionId: null, selectedPieceIds: [], selectedCells: [] };',
    'function withClientActionId(action) { return action.clientActionId ? action : Object.assign({}, action, { clientActionId: `test-${commands.length + 1}` }); }',
    'function snapshotTargetInteraction() { return null; } function restoreTargetInteractionDraft() {}',
    'function rejectPendingActionFeedback() {} function releaseTargetSubmissionForRetry() { return false; }',
    'function recordTargetClear() {} function closePieceContextMenu() {}',
    'function updateRed43QaEvidence() {} function refreshBattleLegalActions() {}',
    'function pendingTargetSelectionForMe() { return !!(G && G.pendingTargetSelection && G.pendingTargetSelection.playerId === myPlayerId); }',
    'function pendingOptionSelectionForMe() { return false; } function pendingOptionSelectionForOther() { return false; }',
    'function isPendingHandSelection() { return false; }',
    'function isPendingBoardMultiTarget() { return false; }',
    'function syncPendingHandSelection() {}',
    runtimeFunction('cardCandidateSet'),
    runtimeFunction('_actionHasFirstTarget'),
    runtimeFunction('_targetPayloadFromCell'),
    runtimeFunction('_appendTargetToAction'),
    runtimeFunction('cloneLocalSkillValue'),
    runtimeFunction('cardPreviewAction'),
    runtimeFunction('cardRootAction'),
    runtimeFunction('cardNeedsTarget'),
    runtimeFunction('normalizeLocalCardPreparation'),
    runtimeFunction('localCardSource'),
    runtimeFunction('localCardChoices'),
    runtimeFunction('localCardUsesRootInput'),
    runtimeFunction('localCardTargetChoice'),
    runtimeFunction('localCardBatchAction'),
    runtimeFunction('installLocalCardDraft'),
    runtimeFunction('localCardTargetPrompt'),
    runtimeFunction('isLocalCardDraft'),
    runtimeFunction('prepareLocalCardAction'),
    runtimeFunction('commitLocalCardAction'),
    runtimeFunction('continueLocalCardPreparation'),
    runtimeFunction('advanceLocalCardTarget'),
    runtimeFunction('currentTargetSourceName'),
    runtimeFunction('prepareFreshSelectionAction'),
    runtimeFunction('submitTargetAction'),
    runtimeFunction('computeValidSkillTargets'),
    runtimeFunction('_updatePendingSkillTargets'),
    runtimeFunction('serverPendingTargetChanged'),
    runtimeFunction('syncAuthoritativePendingPresentation'),
    runtimeFunction('onCardClick'),
    runtimeFunction('onCellClick'),
    asyncRuntimeFunction('trainingApiFetch'),
    'async function doAction(action) {',
  ]
  source.splice(source.length - 1, 1,
    'async function doAction(action) { const stamped = withClientActionId(action); commands.push(stamped); const task = (async function() { G = await trainingApiFetch("PUT", { action: stamped, battleState: G }); targetSubmissionPending = null; pendingActionFeedback = null; })(); pendingActions.push(task); await task; }',
  )
  new Script(source.join('\n')).runInContext(context)
  return { context, commands, statuses, pendingActions }
}

async function settlePageActions(harness: ReturnType<typeof createPageHarness>): Promise<void> {
  while (harness.pendingActions.length > 0) {
    const batch = harness.pendingActions.splice(0)
    await Promise.all(batch)
  }
}

describe('RED-250 Turalyon march through the page and engine', () => {
  it.each(['player-red', 'player-blue'] as const)('%s prepares the holy card locally, submits real continuation credentials, and settles once', async (playerId) => {
    const harness = createPageHarness(makeHolyHandState('holy-smite', playerId), playerId)
    const pageContext: any = harness.context
    const player = () => pageContext.G.players.find((entry: any) => entry.playerId === playerId)
    const cardInstanceId = player().hand[0].instanceId

    pageContext.onCardClick(cardInstanceId, 'holy-smite')
    expect(pageContext.pendingCardAction?.preparation).toMatchObject({
      kind: 'needTarget',
      continuation: true,
      targetType: 'piece',
    })
    const firstRef = pageContext.pendingCardAction.preparation.candidates[0]
    const mover = pageContext.G.pieces.find((piece: any) => piece.instanceId === firstRef.pieceId)
    pageContext.onCellClick(mover.x, mover.y)
    if (!pageContext.pendingCardAction) throw new Error(JSON.stringify({ commands: harness.commands, statuses: harness.statuses, evidence: pageContext.red50Evidence }))
    const secondRef = pageContext.pendingCardAction.preparation.candidates[0]
    pageContext.onCellClick(secondRef.x, secondRef.y)
    await settlePageActions(harness)

    expect(harness.commands).toHaveLength(1)
    expect(harness.commands[0]).toMatchObject({
      type: 'playCard',
      playerId,
      cardInstanceId,
      clientActionId: 'test-1',
      skillChoices: [
        { kind: 'target', targetPieceId: mover.instanceId },
        { kind: 'target', targetX: secondRef.x, targetY: secondRef.y },
      ],
    })
    expect(player().actionPoints).toBe(9)
    expect(player().hand).toHaveLength(0)
    expect(pageContext.G.pieces.find((piece: any) => piece.instanceId === mover.instanceId)).toMatchObject({ x: secondRef.x, y: secondRef.y })
    expect(pageContext.G.pieces.find((piece: any) => piece.instanceId === 'red250-enemy').currentHp).toBe(25)
    expect(pageContext.G.pendingTargetSelection).toBeUndefined()
    expect(harness.statuses).not.toContain('没有合法地格')
  })

  it.each(['player-red', 'player-blue'] as const)('%s projects an authoritative root pending session and translates both target types', async (playerId) => {
    const harness = createPageHarness(makeHolyHandState('holy-smite', playerId), playerId)
    const pageContext: any = harness.context
    const player = () => pageContext.G.players.find((entry: any) => entry.playerId === playerId)
    const cardInstanceId = player().hand[0].instanceId

    pageContext.onCardClick(cardInstanceId, 'holy-smite', true)
    await settlePageActions(harness)
    expect(pageContext.G.pendingTargetSelection).toMatchObject({ targetType: 'piece' })

    pageContext.syncAuthoritativePendingPresentation()
    const firstRef = pageContext.G.pendingTargetSelection.candidates[0]
    const mover = pageContext.G.pieces.find((piece: any) => piece.instanceId === firstRef.pieceId)
    pageContext.onCellClick(mover.x, mover.y)
    await settlePageActions(harness)
    expect(pageContext.G.pendingTargetSelection?.targetType).toMatch(/^(grid|cell)$/)

    pageContext.syncAuthoritativePendingPresentation()
    expect(pageContext.pendingSkill?.preparation?.targetType).toBe('cell')
    const secondRef = pageContext.G.pendingTargetSelection.candidates[0]
    pageContext.onCellClick(secondRef.x, secondRef.y)
    await settlePageActions(harness)

    expect(harness.commands).toHaveLength(3)
    expect(harness.commands[1]).toMatchObject({
      type: 'pendingTargetSelect',
      playerId,
      targetPieceId: mover.instanceId,
      selectionId: expect.any(String),
      stateRevision: expect.any(Number),
    })
    expect(harness.commands[2]).toMatchObject({
      type: 'pendingTargetSelect',
      playerId,
      targetX: secondRef.x,
      targetY: secondRef.y,
      selectionId: expect.any(String),
      stateRevision: expect.any(Number),
    })
    expect(player().actionPoints).toBe(9)
    expect(player().hand).toHaveLength(0)
    expect(pageContext.G.pieces.find((piece: any) => piece.instanceId === mover.instanceId)).toMatchObject({ x: secondRef.x, y: secondRef.y })
    expect(pageContext.G.pieces.find((piece: any) => piece.instanceId === 'red250-enemy').currentHp).toBe(25)
    expect(pageContext.G.pendingTargetSelection).toBeUndefined()
    expect(harness.statuses).not.toContain('没有合法地格')
  })
})
