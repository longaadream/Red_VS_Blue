/* eslint-disable @typescript-eslint/no-explicit-any -- battle.html runs in a browser VM. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext, Script } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

const page = readFileSync(resolve('data/pages/battle.html'), 'utf8')

function readFunction(name: string) {
  const marker = `function ${name}(`
  const start = page.indexOf(marker)
  if (start < 0) throw new Error(`Missing ${name}`)
  const next = [
    page.indexOf('\n    function ', start + marker.length),
    page.indexOf('\n    async function ', start + marker.length),
  ].filter(index => index >= 0)
  const end = Math.min(...next)
  if (!Number.isFinite(end)) throw new Error(`Could not isolate ${name}`)
  return page.slice(start, end)
}

const helperNames = [
  '_actionHasFirstTarget',
  '_targetPayloadFromCell',
  '_appendTargetToAction',
  'cloneLocalSkillValue',
  'isLocalSkillDraft',
  'localSkillRootAction',
  'localSkillChoices',
  'localSkillBatchAction',
  'localSkillSource',
  'normalizeLocalSkillPreparation',
  'prepareLocalSkillAction',
  'localSkillInitialOptionPreparation',
  'localSkillTargetChoice',
  'localSkillTargetSelectionChoice',
  'localSkillUsesRootInput',
  'advanceLocalSkillChoice',
  'advanceLocalSkillTarget',
  'advanceLocalSkillOption',
]

function harness(results: Array<Record<string, any>>) {
  const preparePublicSkillAction = vi.fn(() => results.shift() || { status: 'ready' })
  const submitted: any[] = []
  const installed: any[] = []
  const context = createContext({
    G: { revision: 12 },
    myPlayerId: 'player-red',
    GameEngine: { preparePublicSkillAction },
    pendingSkill: null,
    skillDefOf: vi.fn(() => ({ type: 'normal' })),
    installLocalSkillDraft: vi.fn((action: any, skillData: any, preparation: any, origin: string, root: any, choices: any[]) => {
      installed.push({ action, skillData, preparation, origin, root, choices })
      context.pendingSkill = {
        localChoiceDraft: true,
        skillId: action.skillId,
        rootAction: root,
        baseAction: root,
        skillChoices: choices,
        preparation,
        previewOrigin: origin,
      }
      return true
    }),
    submitLocalSkillBatch: vi.fn((root: any, skill: any, choices: any[]) => {
      submitted.push({ action: (context as any).localSkillBatchAction(skill, root, choices), root, choices })
      return true
    }),
  }) as unknown as Record<string, any>
  new Script(helperNames.map(readFunction).join('\n')).runInContext(context as any)
  return { context, preparePublicSkillAction, submitted, installed }
}

const promptKey = 'public-choice-v1-' + 'a'.repeat(64)

function targetPreparation(source: Record<string, any>, targetType = 'cell', continuation = false) {
  return {
    kind: 'needTarget',
    source,
    promptKey,
    continuation,
    targetType,
    candidates: [{ type: targetType === 'piece' ? 'piece' : 'cell', ...(targetType === 'piece' ? { pieceId: 'target' } : { x: 2, y: 3 }) }],
  }
}

describe('RED-227 local skill choice sequence', () => {
  it.each(['target', 'option'])('restores an editable final %s after rejection and replaces its answer', kind => {
    const h = harness([])
    const attempts: any[] = []
    Object.assign(h.context, {
      pendingCardAction: null, pendingBoardTargetSelection: { selectionId: null, selectedPieceIds: [], selectedCells: [] },
      pendingOptionAction: null, pendingOptionPickerSelection: null, _pickerOptions: [], targetSubmissionDraft: null,
      currentTargetSourceName: () => '测试技能', clearSkillPreview: vi.fn(), renderBoard: vi.fn(),
      renderActionBar: vi.fn(), renderTargetOverlay: vi.fn(), showOptionPicker: vi.fn(),
      document: { body: { classList: { add: vi.fn() } }, getElementById: () => ({ classList: { remove: vi.fn() } }) },
      submitTargetAction: (action: any) => { attempts.push({ action, draft: h.context.targetSubmissionDraft }); h.context.targetSubmissionDraft = null; return true },
    })
    new Script(['snapshotTargetInteraction', 'restoreTargetInteractionDraft', 'submitLocalSkillBatch'].map(readFunction).join('\n')).runInContext(h.context as any)
    const prefix = { kind: 'option', source: { type: 'rule', id: 'earlier', pieceId: 'source' }, promptKey, selectedOption: 'prior' }
    h.context.pendingSkill = { localChoiceDraft: true, skillId: 'skill-a', rootStateRevision: 12,
      rootAction: { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'source', skillId: 'skill-a', targetX: 1, targetY: 1, stateRevision: 12 },
      skillChoices: [prefix], preparation: kind === 'target'
        ? targetPreparation({ type: 'rule', id: 'last', pieceId: 'source' }, 'cell', true)
        : { kind: 'needOption', continuation: true, promptKey, source: { type: 'rule', id: 'last', pieceId: 'source' }, options: [{ value: 'first' }, { value: 'second' }] } }
    if (kind === 'target') h.context.advanceLocalSkillTarget(null, 2, 3)
    else h.context.advanceLocalSkillOption('first')
    h.context.restoreTargetInteractionDraft(attempts[0].draft)
    expect(h.context.pendingSkill.preparation).toMatchObject({ kind: kind === 'target' ? 'needTarget' : 'needOption' })
    expect(h.context.pendingSkill.skillChoices).toEqual([prefix])
    expect(h.context.pendingSkill.localReady).not.toBe(true)
    if (kind === 'target') h.context.advanceLocalSkillTarget(null, 4, 5)
    else h.context.advanceLocalSkillOption('second')
    expect(attempts).toHaveLength(2)
    expect(attempts[1].action.skillChoices).toHaveLength(2)
    expect(attempts[1].action.skillChoices[1]).toMatchObject(kind === 'target' ? { targetX: 4, targetY: 5 } : { selectedOption: 'second' })
  })
  it('sends the original root revision for a continuation with no declared root input', () => {
    const h = harness([])
    const result = h.context.localSkillBatchAction({ rootAction: { type: 'useBasicSkill', skillId: 'skill-a' },
      rootStateRevision: 7, skillChoices: [{ kind: 'target', source: { type: 'rule', id: 'r' }, promptKey, targetX: 2, targetY: 3 }] })
    expect(result.stateRevision).toBe(7)
    expect(result).not.toHaveProperty('selectionId')
  })
  it('gets an option-first root prompt from public preparation instead of skill metadata', () => {
    const h = harness([{
      status: 'needs-input',
      preparation: {
        kind: 'needOption',
        continuation: false,
        source: { type: 'skill', id: 'skill-a', pieceId: 'source' },
        selectionId: 'root-option',
        stateRevision: 7,
        options: [{ label: 'First', value: 'first' }],
      },
    }])

    const preparation = h.context.localSkillInitialOptionPreparation(
      { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'source', skillId: 'skill-a' },
      { targeting: { steps: [{ kind: 'target', targetType: 'piece' }] } },
    )

    expect(preparation).toMatchObject({ kind: 'needOption', continuation: false, selectionId: 'root-option', stateRevision: 7 })
    expect(h.preparePublicSkillAction).toHaveBeenCalledOnce()
  })

  it('keeps the first root target flat and discovers the next target without submitting', () => {
    const h = harness([{ status: 'needs-input', preparation: targetPreparation({ type: 'rule', id: 'rule-next', pieceId: 'source' }, 'cell', true) }])
    h.context.pendingSkill = {
      localChoiceDraft: true,
      skillId: 'skill-a',
      rootAction: { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'source', skillId: 'skill-a', selectionId: 'root-1', stateRevision: 12 },
      baseAction: {},
      skillChoices: [],
      preparation: Object.assign(targetPreparation({ type: 'skill', id: 'skill-a', pieceId: 'source' }), { promptKey: undefined, continuation: false }),
      previewOrigin: 'click',
    }

    h.context.advanceLocalSkillTarget(null, 2, 3)

    expect(h.preparePublicSkillAction).toHaveBeenCalledOnce()
    const preparedAction = (h.preparePublicSkillAction.mock.calls[0] as any[])[1]
    expect(preparedAction.targetX).toBe(2)
    expect(preparedAction.targetY).toBe(3)
    expect(preparedAction.selectionId).toBe('root-1')
    expect(preparedAction).not.toHaveProperty('skillChoices')
    expect(h.submitted).toHaveLength(0)
    expect(h.installed).toHaveLength(1)
    expect(h.installed[0].preparation.promptKey).toBe(promptKey)
  })

  it('keeps a second root target flat until the engine marks a continuation', () => {
    const h = harness([{ status: 'ready' }])
    h.context.pendingSkill = {
      localChoiceDraft: true,
      skillId: 'skill-a',
      rootAction: { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'source', skillId: 'skill-a', targetX: 1, targetY: 1 },
      baseAction: {},
      skillChoices: [],
      preparation: Object.assign(targetPreparation({ type: 'rule', id: 'root-target-2', pieceId: 'source' }), { promptKey: undefined, continuation: false }),
      previewOrigin: 'click',
    }

    h.context.advanceLocalSkillTarget(null, 4, 4)

    expect(h.submitted).toHaveLength(1)
    expect(h.submitted[0].action).toMatchObject({ targetX: 1, targetY: 1, extraTargets: [{ x: 4, y: 4 }] })
    expect(h.submitted[0].action).not.toHaveProperty('skillChoices')
  })

  it('retains root credentials for an option-first local draft', () => {
    const context = createContext({
      G: { targetingRevision: 7 },
      pendingMove: true,
      pendingSkill: null,
      renderLocalSkillPreparation: vi.fn(),
    }) as unknown as Record<string, any>
    new Script([
      readFunction('_actionHasFirstTarget'),
      readFunction('cloneLocalSkillValue'),
      readFunction('localSkillSource'),
      readFunction('installLocalSkillDraft'),
    ].join('\n')).runInContext(context as any)

    const installed = new Script(`installLocalSkillDraft(
      { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'source', skillId: 'skill-a' },
      { type: 'normal' },
      { kind: 'needOption', continuation: false, source: { type: 'skill', id: 'skill-a', pieceId: 'source' }, selectionId: 'root-option', stateRevision: 7, options: [{ label: 'First', value: 'first' }] },
      'click',
    )`).runInContext(context as any)

    expect(installed).toBe(true)
    expect(context.pendingSkill.rootAction).toMatchObject({ selectionId: 'root-option', stateRevision: 7 })
    expect(context.pendingSkill.rootStateRevision).toBe(7)
  })

  it('does not promote synthetic continuation credentials into a root action', () => {
    const context = createContext({
      G: { targetingRevision: 7 },
      pendingMove: false,
      pendingSkill: null,
      renderLocalSkillPreparation: vi.fn(),
    }) as unknown as Record<string, any>
    new Script([
      readFunction('_actionHasFirstTarget'),
      readFunction('cloneLocalSkillValue'),
      readFunction('localSkillSource'),
      readFunction('installLocalSkillDraft'),
    ].join('\n')).runInContext(context as any)

    const installed = new Script(`installLocalSkillDraft(
      { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'source', skillId: 'skill-a' },
      { type: 'normal' },
      { kind: 'needTarget', continuation: true, promptKey: '${promptKey}', source: { type: 'rule', id: 'continuation-target', pieceId: 'source' }, selectionId: 'synthetic', stateRevision: 8, targetType: 'cell' },
      'click',
    )`).runInContext(context as any)

    expect(installed).toBe(true)
    expect(context.pendingSkill.rootAction).not.toHaveProperty('selectionId')
    expect(context.pendingSkill.rootAction).not.toHaveProperty('stateRevision')
    expect(context.pendingSkill.rootStateRevision).toBe(7)
  })

  it('guards a local continuation by the root revision, not its synthetic prompt revision', () => {
    const clearEvents: string[] = []
    const context = createContext({
      G: null,
      locallyCancelledSelectionId: null,
      targetSubmissionDraft: null,
      targetSubmissionPending: null,
      pendingSkill: {
        localChoiceDraft: true,
        rootAction: { selectedOption: 'first-answer', stateRevision: 4 },
        rootStateRevision: 4,
        preparation: { kind: 'needTarget', continuation: true, stateRevision: 99 },
      },
      pendingCardAction: null,
      pendingOptionAction: null,
      pendingOptionPickerSelection: { selectionId: null, selectedValues: [] },
      _pickerOptions: [],
      pendingBoardTargetSelection: { selectionId: null, selectedPieceIds: [] },
      pendingMove: false,
      selectedPieceId: 'source',
      myPlayerId: 'player-red',
      validMoves: new Set(),
      clearSkillPreview: () => undefined,
      clearMoveDraft: () => undefined,
      recordTargetClear: (reason: string) => clearEvents.push(reason),
      renderTargetOverlay: () => undefined,
      setStatusMsg: () => undefined,
      document: { body: { classList: { remove: () => undefined } } },
    }) as unknown as Record<string, any>
    new Script([
      readFunction('clearTargetInteraction'),
      readFunction('reconcileBattleInteractionState'),
    ].join('\n')).runInContext(context as any)

    const unchanged = new Script(`reconcileBattleInteractionState(
      { turn: { currentPlayerId: 'player-red' } },
      { turn: { currentPlayerId: 'player-red' }, targetingRevision: 4, pieces: [{ instanceId: 'source', currentHp: 10 }] },
    )`).runInContext(context as any)
    expect(unchanged).toBe('')
    expect(context.pendingSkill).not.toBeNull()

    const stale = new Script(`reconcileBattleInteractionState(
      { turn: { currentPlayerId: 'player-red' } },
      { turn: { currentPlayerId: 'player-red' }, targetingRevision: 5, pieces: [{ instanceId: 'source', currentHp: 10 }] },
    )`).runInContext(context as any)
    expect(stale).toBe('战局状态已更新，请重新选择技能目标')
    expect(context.pendingSkill).toBeNull()
    expect(clearEvents).toEqual(['targeting-revision-changed'])
  })

  it('batches target then option in order and submits once after the final local preparation', () => {
    const h = harness([
      { status: 'needs-input', preparation: { kind: 'needOption', source: { type: 'rule', id: 'rule-option', pieceId: 'source' }, promptKey, continuation: true, title: 'Choose', options: [{ label: 'Yes', value: 'yes' }] } },
      { status: 'ready' },
    ])
    h.context.pendingSkill = {
      localChoiceDraft: true,
      skillId: 'skill-a',
      rootAction: { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'source', skillId: 'skill-a', targetPieceId: 'first', selectionId: 'root-1', stateRevision: 12 },
      baseAction: {},
      skillChoices: [],
      preparation: targetPreparation({ type: 'skill', id: 'skill-a', pieceId: 'source' }, 'cell', true),
      previewOrigin: 'click',
    }

    h.context.advanceLocalSkillTarget(null, 2, 3)
    h.context.advanceLocalSkillOption('yes')

    expect(h.submitted).toHaveLength(1)
    expect(h.submitted[0].action).toMatchObject({ targetPieceId: 'first', skillChoices: [
      { kind: 'target', source: { type: 'skill', id: 'skill-a', pieceId: 'source' }, targetX: 2, targetY: 3, promptKey },
      { kind: 'option', source: { type: 'rule', id: 'rule-option', pieceId: 'source' }, selectedOption: 'yes', promptKey },
    ] })
    expect(h.submitted[0].action.selectionId).toBe('root-1')
    expect(h.submitted[0].action.skillChoices[0]).not.toHaveProperty('selectionId')
    expect(h.submitted[0].action.skillChoices[0]).not.toHaveProperty('stateRevision')
  })

  it('supports option then target and multi-option continuation batches', () => {
    const h = harness([{ status: 'ready' }, { status: 'ready' }])
    h.context.pendingSkill = {
      localChoiceDraft: true,
      skillId: 'skill-a',
      rootAction: { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'source', skillId: 'skill-a', selectedOption: 'summon' },
      baseAction: {},
      skillChoices: [],
      preparation: targetPreparation({ type: 'rule', id: 'rule-target', pieceId: 'source' }, 'cell', true),
      previewOrigin: 'click',
    }
    h.context.advanceLocalSkillTarget(null, 4, 4)
    expect(h.submitted[0].action).toMatchObject({ selectedOption: 'summon', skillChoices: [
      { kind: 'target', targetX: 4, targetY: 4, promptKey },
    ] })

    h.context.pendingSkill = {
      localChoiceDraft: true,
      skillId: 'skill-a',
      rootAction: { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'source', skillId: 'skill-a', targetPieceId: 'first' },
      baseAction: {},
      skillChoices: [],
      preparation: { kind: 'needOption', source: { type: 'rule', id: 'rule-multi', pieceId: 'source' }, promptKey, continuation: true, selectionMode: 'multi', minSelections: 1, maxSelections: 2 },
      previewOrigin: 'click',
    }
    h.context.advanceLocalSkillOption(['a', 'b'])
    expect(h.submitted[1].action.skillChoices).toEqual([
      { kind: 'option', source: { type: 'rule', id: 'rule-multi', pieceId: 'source' }, selectedOption: ['a', 'b'], promptKey },
    ])
    expect(h.submitted).toHaveLength(2)
  })
})
