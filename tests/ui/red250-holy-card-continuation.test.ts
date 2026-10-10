/* eslint-disable @typescript-eslint/no-explicit-any -- battle.html runs in a browser VM. */
import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

const page = readFileSync('data/pages/battle.html', 'utf8').replace(/\r\n/g, '\n')

function source(name: string) {
  const start = page.indexOf(`function ${name}(`)
  const end = page.indexOf('\n    function ', start + 1)
  if (start < 0 || end < 0) throw new Error(`Missing function: ${name}`)
  return page.slice(start, end)
}

function continuation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.assign({
    kind: 'needTarget',
    continuation: true,
    source: { type: 'rule', id: 'rule-turalyon-lightforged-march', pieceId: 'turalyon-1' },
    promptKey: 'public-choice-v1-' + '1'.repeat(64),
    selectionId: 'synthetic-selection-1',
    stateRevision: 101,
    step: 0,
    targetType: 'piece',
    filter: 'ally',
    canCancel: true,
    candidates: [{ type: 'piece', pieceId: 'ally-1' }],
  }, overrides)
}

function createCardContext(prepared: unknown[] = []) {
  const submitted: any[] = []
  const prepare = vi.fn(() => prepared.shift() ?? { status: 'ready' })
  const context = createContext({
    G: {
      targetingRevision: 7,
      pieces: [
        { instanceId: 'ally-1', currentHp: 10, x: 1, y: 1 },
      ],
    },
    myPlayerId: 'player-red',
    selectedPieceId: null,
    pendingCardAction: null,
    pendingSkill: null,
    pendingOptionAction: null,
    targetSubmissionPending: null,
    targetSubmissionDraft: null,
    pendingMove: false,
    moveDraft: null,
    pendingBoardTargetSelection: { selectionId: null, selectedPieceIds: [], selectedCells: [] },
    prepareLocalCardAction: prepare,
    currentTargetSourceName: () => '圣铸进军',
    rememberTargetInteraction: vi.fn(),
    clearSkillPreview: vi.fn(),
    renderHand: vi.fn(),
    renderBoard: vi.fn(),
    renderActionBar: vi.fn(),
    renderTargetOverlay: vi.fn(),
    renderPieceContextMenu: vi.fn(),
    renderLocalCardPreparation: vi.fn(),
    setStatusMsg: vi.fn(),
    targetStepPrefix: () => '',
    targetTypeText: () => '选择目标',
    submitTargetAction: vi.fn((action: unknown) => { submitted.push(action); return true }),
    clearTargetInteraction: vi.fn(),
    setMoveButtonClass: vi.fn(),
    document: { getElementById: () => ({ classList: { remove: vi.fn() } }) },
    pendingTargetSelectionForMe: () => false,
    pendingOptionSelectionForMe: () => false,
    isLocalSkillDraft: () => false,
    cloneLocalSkillValue: undefined,
  }) as unknown as Record<string, any>
  const functions = [
    '_actionHasFirstTarget',
    '_targetPayloadFromCell',
    '_appendTargetToAction',
    'cloneLocalSkillValue',
    'cardPreviewAction',
    'cardRootAction',
    'cardNeedsTarget',
    'isLocalCardDraft',
    'cardCandidateSet',
    'normalizeLocalCardPreparation',
    'localCardSource',
    'localCardChoices',
    'localCardUsesRootInput',
    'localCardTargetChoice',
    'localCardBatchAction',
    'installLocalCardDraft',
    'commitLocalCardAction',
    'continueLocalCardPreparation',
    'advanceLocalCardTarget',
    'cancelTargetSelection',
    'targetTypeText',
    'targetStepPrefix',
    'localCardTargetPrompt',
  ]
  new Script(functions.map(source).concat([
    source('cancelLocalCardContinuation'),
  ]).join('\n')).runInContext(context)
  return { context, prepare, submitted }
}

describe('RED-250 Turalyon card continuation', () => {
  it('keeps afterCardPlay target answers in skillChoices and submits one complete card root', () => {
    const first = continuation()
    const second = continuation({
      promptKey: 'public-choice-v1-' + '2'.repeat(64),
      selectionId: 'synthetic-selection-2',
      stateRevision: 102,
      step: 1,
      targetType: 'cell',
      filter: 'all',
      candidates: [{ type: 'cell', x: 2, y: 1 }],
    })
    const { context, prepare, submitted } = createCardContext([
      { status: 'needs-input', preparation: second },
      { status: 'ready' },
    ])
    const root = { type: 'playCard', playerId: 'player-red', cardInstanceId: 'holy-heal-1' }
    const card = Object.assign({}, root, { cardId: 'holy-heal' })

    new Script(`pendingCardAction = installLocalCardDraft(${JSON.stringify(root)}, ${JSON.stringify(card)}, ${JSON.stringify(first)})`).runInContext(context)
    new Script('advanceLocalCardTarget({ instanceId: "ally-1", x: 1, y: 1 }, 1, 1)').runInContext(context)
    new Script('advanceLocalCardTarget(null, 2, 1)').runInContext(context)

    expect(prepare).toHaveBeenCalledTimes(2)
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toMatchObject({
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'holy-heal-1',
      stateRevision: 7,
      skillChoices: [
        {
          kind: 'target',
          source: first.source,
          promptKey: first.promptKey,
          targetPieceId: 'ally-1',
        },
        {
          kind: 'target',
          source: second.source,
          promptKey: second.promptKey,
          targetX: 2,
          targetY: 1,
        },
      ],
    })
    expect(submitted[0]).not.toHaveProperty('targetPieceId')
    expect(submitted[0]).not.toHaveProperty('targetX')
    expect(submitted[0]).not.toHaveProperty('targetY')
    expect(submitted[0]).not.toHaveProperty('selectionId', first.selectionId)
    expect(submitted[0]).not.toHaveProperty('selectionId', second.selectionId)
  })

  it('does not copy a continuation credential onto the card root', () => {
    const prep = continuation()
    const { context } = createCardContext()
    const result = new Script(`installLocalCardDraft({type:'playCard',playerId:'player-red',cardInstanceId:'card-1'}, {cardId:'holy-heal'}, ${JSON.stringify(prep)})`).runInContext(context)

    expect(result.rootAction).not.toHaveProperty('selectionId')
    expect(result.rootAction).not.toHaveProperty('stateRevision')
    expect(result.preparation).toMatchObject({ continuation: true, source: prep.source, promptKey: prep.promptKey })
  })

  it('keeps a real card root target and its root credential on playCard', () => {
    const rootPreparation: Record<string, unknown> = continuation({
      continuation: false,
      source: { type: 'card', id: 'holy-heal' },
      promptKey: undefined,
      selectionId: 'root-selection',
      stateRevision: 8,
      targetType: 'piece',
      filter: 'enemy',
    })
    delete rootPreparation.promptKey
    const { context, submitted } = createCardContext([{ status: 'ready' }])
    const root = { type: 'playCard', playerId: 'player-red', cardInstanceId: 'card-1' }
    new Script(`pendingCardAction = installLocalCardDraft(${JSON.stringify(root)}, {cardId:'holy-heal'}, ${JSON.stringify(rootPreparation)})`).runInContext(context)
    new Script('advanceLocalCardTarget({ instanceId: "ally-1", x: 1, y: 1 }, 1, 1)').runInContext(context)

    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toMatchObject({
      type: 'playCard',
      selectionId: 'root-selection',
      stateRevision: 8,
      targetPieceId: 'ally-1',
      targetX: 1,
      targetY: 1,
    })
    expect(submitted[0]).not.toHaveProperty('skillChoices')
  })

  it('commits the completed root when a draft still carries a stale base action', () => {
    const { context, submitted } = createCardContext()
    const staleBaseAction = {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'card-1',
      stateRevision: 6,
      skillChoices: [{ kind: 'target', promptKey: 'stale-choice' }],
    }
    const completedRootAction = {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'card-1',
      stateRevision: 7,
      skillChoices: [{ kind: 'target', promptKey: 'completed-choice' }],
    }

    new Script(`commitLocalCardAction(${JSON.stringify(completedRootAction)}, ${JSON.stringify({
      cardId: 'holy-heal',
      baseAction: staleBaseAction,
    })})`).runInContext(context)

    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toMatchObject(completedRootAction)
    expect(submitted[0]).not.toMatchObject(staleBaseAction)
  })

  it('uses the same continuation answer shape for hover preview as board click', () => {
    const prep = continuation()
    const { context } = createCardContext()
    const draft = new Script(`installLocalCardDraft({type:'playCard',playerId:'player-red',cardInstanceId:'card-1'}, {cardId:'holy-heal'}, ${JSON.stringify(prep)})`).runInContext(context)
    const clicked = new Script('localCardTargetChoice(pendingCardAction, {instanceId:"ally-1",x:1,y:1}, 1, 1, pendingCardAction.preparation)').runInContext(Object.assign(context, { pendingCardAction: draft }) as any)
    const hovered = new Script('localCardTargetChoice(pendingCardAction, {instanceId:"ally-1",x:1,y:1}, 1, 1, pendingCardAction.preparation)').runInContext(Object.assign(context, { pendingCardAction: draft }) as any)

    expect(hovered).toEqual(clicked)
    expect(hovered).toMatchObject({
      kind: 'target',
      source: prep.source,
      promptKey: prep.promptKey,
      targetPieceId: 'ally-1',
    })
    expect(source('advanceLocalCardTarget')).toContain('localCardTargetChoice')
    expect(source('previewSkillTarget')).toContain('localCardTargetChoice')
  })

  it('cancels a rule continuation by submitting a cancel choice while keeping the root card untouched', () => {
    const prep = continuation()
    const { context, submitted } = createCardContext()
    new Script(`pendingCardAction = installLocalCardDraft({type:'playCard',playerId:'player-red',cardInstanceId:'card-1'}, {cardId:'holy-heal'}, ${JSON.stringify(prep)})`).runInContext(context)

    new Script('cancelTargetSelection()').runInContext(context)

    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toMatchObject({
      type: 'playCard',
      cardInstanceId: 'card-1',
      skillChoices: [{
        kind: 'target',
        source: prep.source,
        promptKey: prep.promptKey,
        cancelled: true,
      }],
    })
    expect(submitted[0]).not.toHaveProperty('targetPieceId')
    expect(submitted[0]).not.toHaveProperty('targetX')
    expect(submitted[0]).not.toHaveProperty('targetY')
  })
})
