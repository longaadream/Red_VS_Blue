/* eslint-disable @typescript-eslint/no-explicit-any -- battle.html is exercised through a browser VM. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import { createContext, runInNewContext, Script } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

import { toPublicBattleState } from '@/lib/game/deployment'
import { makePiece, makeState } from '../helpers/minimal-state'

const page = readFileSync(resolve('data/pages/battle.html'), 'utf8')
const resourceCategories = ['skills', 'rules', 'pieces'] as const

function readJson(relativePath: string): any {
  return JSON.parse(readFileSync(resolve(process.cwd(), relativePath), 'utf8'))
}

function loadBrowserEngine(): any {
  const files: Record<string, unknown> = {}
  for (const category of resourceCategories) {
    const manifestPath = `data/${category}/manifest.json`
    const ids = readJson(manifestPath)
    files[manifestPath] = ids
    for (const id of ids as string[]) {
      const relativePath = `data/${category}/${id}.json`
      files[relativePath] = readJson(relativePath)
    }
  }
  const context: Record<string, any> = {
    Buffer,
    clearTimeout,
    console: { error: vi.fn(), log: vi.fn(), warn: vi.fn() },
    setTimeout,
    TextDecoder,
    TextEncoder,
  }
  context.window = context
  context.process = { env: {}, cwd: () => '' }
  runInNewContext(readFileSync(resolve('data/pages/js/game-engine-runtime.js'), 'utf8'), context)
  context.RvBGameEngine.primeJsonFiles(files)
  runInNewContext(readFileSync(resolve('data/pages/js/game-engine.js'), 'utf8'), context)
  return context.GameEngine
}

function readFunction(name: string) {
  const markers = [`function ${name}(`, `async function ${name}(`]
  const matches = markers
    .map(marker => ({ marker, start: page.indexOf(marker) }))
    .filter(entry => entry.start >= 0)
  if (!matches.length) throw new Error(`Missing ${name}`)
  const { marker, start } = matches.sort((a, b) => a.start - b.start)[0]
  const next = [
    page.indexOf('\n    function ', start + marker.length),
    page.indexOf('\n    async function ', start + marker.length),
  ].filter(index => index >= 0)
  const end = Math.min(...next)
  if (!Number.isFinite(end)) throw new Error(`Could not isolate ${name}`)
  return page.slice(start, end)
}

function makeAkaza(options: Record<string, unknown> = {}) {
  return makePiece({
    instanceId: 'akaza',
    templateId: 'dark-akaza',
    name: '猗窝座',
    ownerPlayerId: 'player-red',
    faction: 'evil',
    x: 1,
    y: 1,
    currentHp: 16,
    maxHp: 16,
    attack: 4,
    defense: 0,
    moveRange: 5,
    ...options,
  })
}

function skillState(skillId: string) {
  return { skillId, currentCooldown: 0, usesRemaining: -1 }
}

function attachRule(engine: any, piece: any, ruleId: string) {
  const rule = engine.loadRuleById(ruleId)
  if (!rule) throw new Error(`Missing browser rule ${ruleId}`)
  piece.rules = [...(piece.rules || []), rule]
}

function prepareAuthorityAction(engine: any, state: any, action: any) {
  try {
    engine.applyBattleAction(state, action)
  } catch (error) {
    if ((error as any)?.needsTargetSelection) return (error as any).preparation
    throw error
  }
  throw new Error('Expected the authority to request a target')
}

function pageTargetHarness(engine: any, publicState: any, authorityState: any, skill: any) {
  const authorityActions: any[] = []
  const preparations: any[] = []
  let resolvedState: any = null
  const messages: string[] = []
  const context = createContext({
    ADVENTURE_MODE: false,
    TRAINING_MODE: false,
    PRACTICE_MODE: false,
    SPECTATE_MODE: false,
    TUTORIAL_MODE: false,
    G: publicState,
    GameEngine: engine,
    myPlayerId: 'player-red',
    myFaction: 'red',
    selectedPieceId: 'akaza',
    pendingSkill: null,
    pendingCardAction: null,
    cardNeedsTarget: () => false,
    pendingMove: false,
    pendingActionFeedback: null,
    targetSubmissionPending: null,
    targetSubmissionDraft: null,
    pendingOptionAction: null,
    pendingOptionSelection: null,
    moveDraft: null,
    pendingOptionPickerSelection: { selectionId: null, selectedValues: [] },
    pendingBoardTargetSelection: { selectionId: null, selectedPieceIds: [], selectedCells: [] },
    locallyCancelledSelectionId: null,
    localDeploymentChoiceId: null,
    placingMode: false,
    cardsById: {},
    skillsById: { [skill.id]: skill },
    red50Evidence: { targetCommands: [], clearEvents: [], rejections: [] },
    window: {},
    document: {
      body: { classList: { add: vi.fn(), remove: vi.fn() } },
      getElementById: () => ({ classList: { add: vi.fn(), remove: vi.fn() }, style: {}, disabled: false }),
    },
    refreshBattleLegalActions: vi.fn(),
    pendingTargetSelectionForMe: () => false,
    pendingOptionSelectionForMe: () => false,
    pendingOptionSelectionForOther: () => false,
    waitingForOtherPending: () => false,
    progressiveDeploymentPending: () => false,
    progressiveDeploymentOwned: () => false,
    skillDefOf: (skillId: string) => skillId === skill.id ? skill : null,
    skillUsesCharge: () => false,
    resolveSkillAvailability: () => ({ available: true }),
    closePieceContextMenu: vi.fn(),
    clearSkillPreview: vi.fn(),
    clearTargetInteraction: vi.fn(),
    flushPresentationBeforePendingSelection: vi.fn(),
    recordTargetClear: vi.fn(),
    setMoveButtonClass: vi.fn(),
    renderBoard: vi.fn(),
    renderPieceContextMenu: vi.fn(),
    renderActionBar: vi.fn(),
    renderTargetOverlay: vi.fn(),
    updateRed43QaEvidence: vi.fn(),
    addLog: vi.fn(),
    setStatusMsg: (message: string) => messages.push(message),
    targetStepPrefix: () => '请选择目标：',
    targetTypeText: () => '目标',
    tutorialActionAllowed: () => true,
    currentTargetSourceName: () => '猗窝座瞬步',
    showTileStatus: vi.fn(),
    selectPiece: vi.fn(),
    cancelLocalCardContinuation: vi.fn(() => false),
  }) as unknown as Record<string, any>
  context.window = context
  context.clearTargetInteraction = vi.fn(() => {
    context.pendingSkill = null
    context.pendingCardAction = null
    context.targetSubmissionPending = null
    context.targetSubmissionDraft = null
  })

  const functions = [
    'snapshotTargetInteraction',
    'currentTargetSourceName',
    'prepareFreshSelectionAction',
    'cloneLocalSkillValue',
    '_actionHasFirstTarget',
    '_targetPayloadFromCell',
    '_appendTargetToAction',
    'localSkillRootAction',
    'localSkillChoices',
    'localSkillBatchAction',
    'localSkillSource',
    'normalizeLocalSkillPreparation',
    'prepareLocalSkillAction',
    'localSkillInitialOptionPreparation',
    'isLocalSkillDraft',
    'computeValidSkillTargets',
    '_updatePendingSkillTargets',
    'renderLocalSkillPreparation',
    'installLocalSkillDraft',
    'rememberTargetInteraction',
    'withClientActionId',
    'submitTargetAction',
    'enterActionTargetMode',
    'onCellClick',
    'cancelTargetSelection',
    'selectSkillCard',
  ]
  new Script(functions.map(readFunction).join('\n')).runInContext(context)

  context.doAction = async (rawAction: any) => {
    const action = context.withClientActionId(rawAction)
    authorityActions.push(action)
    if (action.targetPieceId && action.extraTargets?.length) {
      resolvedState = engine.applyBattleAction(authorityState, action)
      context.targetSubmissionPending = null
      return
    }
    const preparation = prepareAuthorityAction(engine, authorityState, action)
    preparations.push(preparation)
    context.enterActionTargetMode(action, preparation)
  }

  return { context, authorityActions, preparations, get resolvedState() { return resolvedState }, messages }
}

describe('RED-256 Akaza target selection', () => {
  it.each([false, true])('exits with a clear hint when authority has no candidate (blocked=%s)', async (blocked) => {
    const engine = loadBrowserEngine()
    const akaza = makeAkaza({ skills: [skillState('akaza-flash-step')] })
    const enemy = makePiece({ instanceId: 'damaged', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 1 })
    if (blocked) enemy.statusTags = [{ id: 'akaza-damaged-by:akaza', type: 'akaza-damaged', sourceId: 'akaza', visible: false, currentDuration: -1 }] as any
    const blockers = blocked ? [[2, 0], [3, 1], [2, 2]].map(([x, y], index) => makePiece({ instanceId: `blocker-${index}`, x, y })) : []
    const state = makeState({ pieces: [akaza, enemy, ...blockers], currentPlayerId: 'player-red', phase: 'action', width: 7, height: 7 }) as any
    state.skillsById['akaza-flash-step'] = readJson('data/skills/akaza-flash-step.json')
    const before = JSON.stringify(state)
    const harness = pageTargetHarness(engine, toPublicBattleState(state, 'player-red'), state, readJson('data/skills/akaza-flash-step.json'))
    await harness.context.selectSkillCard('akaza-flash-step')
    expect(harness.preparations[0].candidates).toEqual([])
    expect(harness.context.pendingSkill).toBeNull()
    expect(harness.messages.at(-1)).toContain('没有可用目标')
    expect(JSON.stringify(state)).toBe(before)
    await harness.context.selectSkillCard('akaza-flash-step')
    expect(harness.context.pendingSkill).toBeNull()
    expect(harness.authorityActions).toHaveLength(2)
    expect(JSON.stringify(state)).toBe(before)
  })

  it('falls back to the authority when public root preparation has no visible candidate', async () => {
    const engine = loadBrowserEngine()
    const akaza = makeAkaza({ skills: [skillState('akaza-annihilation'), skillState('akaza-flash-step')] })
    const damaged = makePiece({
      instanceId: 'damaged', ownerPlayerId: 'player-blue', faction: 'blue',
      x: 2, y: 1, currentHp: 49, maxHp: 50,
    })
    const authorityState = makeState({
      pieces: [akaza, damaged], currentPlayerId: 'player-red', phase: 'action', width: 7, height: 7,
    }) as any
    authorityState.players[0].actionPoints = 2
    attachRule(engine, akaza, 'rule-akaza-fighting-spirit')
    attachRule(engine, akaza, 'rule-akaza-damage-mark')
    authorityState.skillsById['akaza-annihilation'] = readJson('data/skills/akaza-annihilation.json')
    authorityState.skillsById['akaza-flash-step'] = readJson('data/skills/akaza-flash-step.json')

    const attack = {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'akaza', skillId: 'akaza-annihilation',
    }
    const attackPreparation = prepareAuthorityAction(engine, authorityState, attack)
    const attackTarget = attackPreparation.candidates.find((candidate: any) =>
      candidate.type === 'cell' && candidate.x === 2 && candidate.y === 1)
    expect(attackTarget).toBeDefined()
    const afterAttack = engine.applyBattleAction(authorityState, {
      ...attack, targetX: attackTarget.x, targetY: attackTarget.y,
      selectionId: attackPreparation.selectionId, stateRevision: attackPreparation.stateRevision,
    })
    expect(afterAttack.pieces.find((piece: any) => piece.instanceId === 'damaged')?.currentHp).toBe(44)

    const rootAction = {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'akaza', skillId: 'akaza-flash-step',
    }
    const publicState = toPublicBattleState(afterAttack, 'player-red')
    const publicPreparation = engine.preparePublicSkillAction(publicState, rootAction, 'player-red')
    expect(publicPreparation).toMatchObject({
      status: 'needs-input',
      preparation: { kind: 'needTarget', targetType: 'piece', candidates: [] },
    })

    const harness = pageTargetHarness(engine, publicState, afterAttack, readJson('data/skills/akaza-flash-step.json'))
    const partialSnapshot = {
      akaza: { x: afterAttack.pieces.find((piece: any) => piece.instanceId === 'akaza')?.x,
        y: afterAttack.pieces.find((piece: any) => piece.instanceId === 'akaza')?.y,
        currentHp: afterAttack.pieces.find((piece: any) => piece.instanceId === 'akaza')?.currentHp,
        attack: afterAttack.pieces.find((piece: any) => piece.instanceId === 'akaza')?.attack },
      damagedHp: afterAttack.pieces.find((piece: any) => piece.instanceId === 'damaged')?.currentHp,
      actionPoints: afterAttack.players.find((player: any) => player.playerId === 'player-red')?.actionPoints,
      flashCooldown: afterAttack.pieces.find((piece: any) => piece.instanceId === 'akaza')?.skills
        .find((entry: any) => entry.skillId === 'akaza-flash-step')?.currentCooldown,
    }
    await harness.context.selectSkillCard('akaza-flash-step')

    expect(harness.authorityActions).toHaveLength(1)
    expect(afterAttack.pieces.find((piece: any) => piece.instanceId === 'akaza')?.skills
      .find((entry: any) => entry.skillId === 'akaza-flash-step')?.currentCooldown).toBe(0)
    expect(afterAttack.pieces.find((piece: any) => piece.instanceId === 'akaza')?.skills
      .find((entry: any) => entry.skillId === 'akaza-flash-step')?.currentCooldown).toBe(partialSnapshot.flashCooldown)
    expect(afterAttack.pieces.find((piece: any) => piece.instanceId === 'akaza')).toMatchObject(partialSnapshot.akaza)
    expect(afterAttack.pieces.find((piece: any) => piece.instanceId === 'damaged')?.currentHp).toBe(partialSnapshot.damagedHp)
    expect(afterAttack.players.find((player: any) => player.playerId === 'player-red')?.actionPoints).toBe(partialSnapshot.actionPoints)
    expect(harness.context.pendingSkill).toMatchObject({
      skillId: 'akaza-flash-step',
      baseAction: { type: 'useBasicSkill', pieceId: 'akaza' },
      preparation: { kind: 'needTarget', targetType: 'piece', candidates: [{ type: 'piece', pieceId: 'damaged' }] },
    })
    expect(harness.context.pendingSkill.localChoiceDraft).not.toBe(true)

    harness.context.cancelTargetSelection()
    expect(harness.authorityActions).toHaveLength(1)
    expect(harness.context.pendingSkill).toBeNull()
    expect(harness.messages.at(-1)).toBe('已取消目标选择')
    expect(afterAttack.pieces.find((piece: any) => piece.instanceId === 'akaza')).toMatchObject(partialSnapshot.akaza)
    expect(afterAttack.pieces.find((piece: any) => piece.instanceId === 'damaged')?.currentHp).toBe(partialSnapshot.damagedHp)
    expect(afterAttack.players.find((player: any) => player.playerId === 'player-red')?.actionPoints).toBe(partialSnapshot.actionPoints)

    // Re-enter the same flow after cancellation so the success path proves
    // cancellation did not leave an inert or stale local draft behind.
    harness.authorityActions.length = 0
    harness.preparations.length = 0
    await harness.context.selectSkillCard('akaza-flash-step')
    expect(harness.authorityActions).toHaveLength(1)
    expect(harness.context.pendingSkill.localChoiceDraft).not.toBe(true)

    harness.context.onCellClick(4, 4)
    expect(harness.authorityActions).toHaveLength(1)
    expect(harness.context.pendingSkill).toMatchObject({
      baseAction: { type: 'useBasicSkill', pieceId: 'akaza' },
      preparation: { kind: 'needTarget', targetType: 'piece' },
    })
    expect(harness.messages.at(-1)).toBe('目标不在技能范围内')

    harness.context.onCellClick(2, 1)
    expect(harness.authorityActions).toHaveLength(2)
    expect(harness.preparations).toHaveLength(2)
    expect(harness.preparations[1]).toMatchObject({ kind: 'needTarget', targetType: 'cell' })
    expect(harness.context.pendingSkill).toMatchObject({
      baseAction: { targetPieceId: 'damaged' },
      preparation: { kind: 'needTarget', targetType: 'cell' },
    })
    expect(afterAttack.pieces.find((piece: any) => piece.instanceId === 'akaza')).toMatchObject(partialSnapshot.akaza)
    expect(afterAttack.pieces.find((piece: any) => piece.instanceId === 'damaged')?.currentHp).toBe(partialSnapshot.damagedHp)
    expect(afterAttack.players.find((player: any) => player.playerId === 'player-red')?.actionPoints).toBe(partialSnapshot.actionPoints)

    const landing = harness.preparations[1].candidates.find((candidate: any) =>
      candidate.type === 'cell' && !(candidate.x === 1 && candidate.y === 1))
    expect(landing).toBeDefined()
    harness.context.onCellClick(0, 0)
    expect(harness.authorityActions).toHaveLength(2)
    expect(harness.context.pendingSkill).toMatchObject({
      baseAction: { targetPieceId: 'damaged' },
      preparation: { kind: 'needTarget', targetType: 'cell' },
    })
    expect(harness.messages.at(-1)).toBe('目标不在技能范围内')
    harness.context.onCellClick(landing.x, landing.y)

    expect(harness.authorityActions).toHaveLength(3)
    expect(new Set(harness.authorityActions.map(action => action.clientActionId)).size).toBe(3)
    expect(harness.authorityActions[1]).toMatchObject({
      targetPieceId: 'damaged',
      selectionId: harness.preparations[0].selectionId,
      stateRevision: harness.preparations[0].stateRevision,
    })
    expect(harness.authorityActions[2]).toMatchObject({
      targetPieceId: 'damaged',
      extraTargets: [{ x: landing.x, y: landing.y }],
      selectionId: harness.preparations[1].selectionId,
      stateRevision: harness.preparations[1].stateRevision,
    })
    expect(harness.resolvedState?.pieces.find((piece: any) => piece.instanceId === 'akaza')).toMatchObject({
      x: landing.x, y: landing.y, attack: 5,
    })
    expect(harness.resolvedState?.players.find((player: any) => player.playerId === 'player-red')?.actionPoints).toBe(0)
    const resolvedAkaza = harness.resolvedState?.pieces.find((piece: any) => piece.instanceId === 'akaza')
    const flashSkills = resolvedAkaza?.skills.filter((entry: any) => entry.skillId === 'akaza-flash-step')
    expect(flashSkills).toHaveLength(1)
    expect(flashSkills[0].currentCooldown).toBe(3)
    expect(harness.context.pendingSkill).toBeNull()
    expect(harness.context.targetSubmissionPending).toBeNull()
  })
})
