import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

const projectRoot = process.cwd()
const battlePagePath = path.join(projectRoot, 'data', 'pages', 'battle.html')
const battlePresentationPath = path.join(projectRoot, 'data', 'pages', 'js', 'battle-ui', 'battle-presentation.js')

function readBattlePage(): string {
  return fs.readFileSync(battlePagePath, 'utf8')
}

interface InlineScript {
  source: string
  htmlLine: number
}

function inlineScripts(html: string): InlineScript[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => {
      const source = match[1]
      const sourceOffset = (match.index ?? 0) + match[0].indexOf(source)
      return {
        source,
        htmlLine: html.slice(0, sourceOffset).split('\n').length,
      }
    })
}

function styleBlocks(html: string): string[] {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map(match => match[1])
}

function documentMarkup(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
}

function runtimeFunction(html: string, name: string): string {
  const marker = `function ${name}(`
  for (const script of inlineScripts(html)) {
    const start = script.source.indexOf(marker)
    if (start === -1) continue
    const bodyStart = script.source.indexOf('{', start)
    let depth = 0
    for (let index = bodyStart; index < script.source.length; index += 1) {
      if (script.source[index] === '{') depth += 1
      if (script.source[index] !== '}') continue
      depth -= 1
      if (depth === 0) return script.source.slice(start, index + 1)
    }
  }
  throw new Error(`Missing runtime function: ${name}`)
}

function createClassList() {
  const values = new Set<string>()
  return {
    add: (...tokens: string[]) => tokens.forEach(token => values.add(token)),
    remove: (...tokens: string[]) => tokens.forEach(token => values.delete(token)),
    toggle: (token: string, force?: boolean) => {
      const enabled = force ?? !values.has(token)
      if (enabled) values.add(token)
      else values.delete(token)
      return enabled
    },
    contains: (token: string) => values.has(token),
  }
}

describe('battle page runtime source', () => {
  it('parses every inline script before the loading overlay can initialize', () => {
    const scripts = inlineScripts(readBattlePage())

    expect(scripts.length).toBeGreaterThan(0)
    scripts.forEach((script, index) => {
      const filename = `battle-inline-${index + 1}.js`
      expect(() => {
        try {
          new vm.Script(script.source, { filename })
        } catch (error) {
          const stack = error instanceof Error ? error.stack ?? '' : ''
          const scriptLine = Number(stack.match(new RegExp(`${filename.replace('.', '\\.')}:(\\d+)`))?.[1] ?? 1)
          const htmlLine = script.htmlLine + scriptLine - 1
          throw new Error(`battle.html:${htmlLine} inline script ${index + 1} failed to parse: ${String(error)}`, {
            cause: error,
          })
        }
      }).not.toThrow()
    })
  })

  it('keeps HTML elements out of style blocks', () => {
    const styles = styleBlocks(readBattlePage())

    expect(styles.length).toBeGreaterThan(0)
    styles.forEach(style => {
      expect(style).not.toMatch(/^\s*<[a-z][^>]*>/im)
    })
  })

  it('uses unique ids in the rendered document markup', () => {
    const markup = documentMarkup(readBattlePage())
    const ids = [...markup.matchAll(/\bid=["']([^"']+)["']/gi)].map(match => match[1])
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]

    expect(duplicates).toEqual([])
  })

  it('marks every initial training roster piece as core', async () => {
    const html = readBattlePage()
    const createInitialBattleForPlayers = vi.fn(async () => ({
      pieces: [
        { instanceId: 'training-red-core' },
        { instanceId: 'training-blue-core', isCore: false },
      ],
      players: [
        { playerId: 'training-red', faction: 'red', actionPoints: 0 },
        { playerId: 'training-blue', faction: 'blue', actionPoints: 0 },
      ],
      turn: { currentPlayerId: 'training-red' },
      skillsById: {},
    }))
    const context = vm.createContext({
      window: { RvBGameEngine: { ensure: async () => ({ createInitialBattleForPlayers }) } },
      skillsById: {},
      resolveTrainingInitialPieces: (alignment: string) => [{ id: `${alignment}-piece` }],
    })
    new vm.Script(`async ${runtimeFunction(html, 'trainingApiFetch')}`).runInContext(context)

    const state = await (context as any).trainingApiFetch('POST', {
      firstPlayerId: 'training-red', firstFaction: 'red', secondFaction: 'blue',
    })

    expect(createInitialBattleForPlayers).toHaveBeenCalledOnce()
    expect(state.pieces).toEqual([
      { instanceId: 'training-red-core', isCore: true },
      { instanceId: 'training-blue-core', isCore: true },
    ])
  })

  it('uses the instance-aware display description in the card detail modal', () => {
    expect(runtimeFunction(readBattlePage(), 'showCardDetail'))
      .toMatch(/cardDisplayDescription\(cardInstance, def\)/)
  })

  it('includes template-derived skills in battle piece details without adding them to runtime skills', () => {
    const context = vm.createContext({
      PIECES_BY_ID: {
        'blue-ichigo': {
          transformedSkills: [{ skillId: 'ichigo-black-getsuga-tensho', triggeredBy: 'ichigo-bankai-tensa-zangetsu' }],
        },
      },
    })
    new vm.Script([
      runtimeFunction(readBattlePage(), 'pieceDispSkills'),
      runtimeFunction(readBattlePage(), 'skillIdOf'),
      runtimeFunction(readBattlePage(), 'pieceInfoDisplaySkills'),
    ].join('\n')).runInContext(context)

    const piece = {
      templateId: 'blue-ichigo',
      skills: [{ skillId: 'ichigo-zangetsu' }, { skillId: 'ichigo-bankai-tensa-zangetsu' }],
    }
    const displayed = (context as any).pieceInfoDisplaySkills(piece)

    expect(displayed.map((skill: any) => skill.skillId)).toEqual([
      'ichigo-zangetsu', 'ichigo-bankai-tensa-zangetsu', 'ichigo-black-getsuga-tensho',
    ])
    expect(displayed[2]).toMatchObject({ derived: true, triggeredBy: 'ichigo-bankai-tensa-zangetsu' })
    expect(piece.skills).toHaveLength(2)
    expect((context as any).pieceDispSkills(piece).map((skill: any) => skill.skillId))
      .not.toContain('ichigo-black-getsuga-tensho')
  })

  it('keeps a single-card hand selection out of the generic option picker and submits through hand controls', async () => {
    const overlay = { classList: { remove: vi.fn() } }
    const showOptionPicker = vi.fn()
    const doAction = vi.fn().mockResolvedValue(undefined)
    const context = vm.createContext({
      G: {
        turn: { turnNumber: 2 },
        pendingOptionSelection: {
          playerId: 'player-red', selectionId: 'prophecy-single',
          stateRevision: 7, canCancel: true,
          selectionMode: 'single', presentation: 'hand',
          options: [{ value: 'holy-card-1' }],
        },
      },
      pendingHandOptionSelection: { selectionId: null, selectedValues: [], submitting: false },
      pendingOptionSelectionForMe: () => true,
      pendingTargetSelectionForMe: () => false,
      showOptionPicker,
      doAction,
      myPlayerId: 'player-red',
      setStatusMsg: vi.fn(),
      renderHand: vi.fn(),
      renderActionBar: vi.fn(),
      renderPendingHandSelectionControls: vi.fn(),
      document: { getElementById: (id: string) => id === 'optionPickerOverlay' ? overlay : null },
      pendingSkill: null,
    })
    vm.runInContext('let _pendingChoiceShown = null; let pendingOptionAction = null; let _pickerOptions = [];', context)
    new vm.Script([
      runtimeFunction(readBattlePage(), 'isPendingHandSelection'),
      runtimeFunction(readBattlePage(), 'pendingHandCandidateValues'),
      runtimeFunction(readBattlePage(), 'syncPendingHandSelection'),
      runtimeFunction(readBattlePage(), 'syncAuthoritativePendingPresentation'),
      runtimeFunction(readBattlePage(), 'togglePendingHandOption'),
      'async ' + runtimeFunction(readBattlePage(), 'confirmPendingHandOptionSelection'),
      'async ' + runtimeFunction(readBattlePage(), 'cancelPendingHandOptionSelection'),
    ].join('\n')).runInContext(context)

    ;(context as any).syncAuthoritativePendingPresentation()

    expect(showOptionPicker).not.toHaveBeenCalled()
    expect(overlay.classList.remove).toHaveBeenCalledWith('show')
    expect((context as any).pendingHandOptionSelection.selectionId).toBe('prophecy-single')

    ;(context as any).togglePendingHandOption('holy-card-1')
    await (context as any).confirmPendingHandOptionSelection()
    expect(doAction).toHaveBeenNthCalledWith(1, {
      type: 'pendingOptionSelect',
      playerId: 'player-red',
      selectedOption: 'holy-card-1',
      selectionId: 'prophecy-single',
      stateRevision: 7,
    })

    await (context as any).cancelPendingHandOptionSelection()
    expect(doAction).toHaveBeenNthCalledWith(2, {
      type: 'cancelPendingSelection',
      playerId: 'player-red',
      selectionId: 'prophecy-single',
      stateRevision: 7,
    })
  })

  it('submits a declarative option choice as a fresh authority action', () => {
    const html = readBattlePage()
    const doAction = vi.fn()
    const overlay = { classList: { remove: vi.fn() } }
    const context = vm.createContext({
      document: { getElementById: () => overlay },
      doAction,
    })
    vm.runInContext(`
      let pendingOptionAction = {
        type: 'useBasicSkill',
        playerId: 'player-red',
        pieceId: 'tracer',
        skillId: 'recall',
        clientActionId: 'rejected-option-action',
        requestId: 'rejected-option-request',
        selectionId: 'recall-option',
        stateRevision: 4,
      }
      let _pickerOptions = [{ label: '2', value: 2 }]
      ${runtimeFunction(html, 'prepareFreshSelectionAction')}
      ${runtimeFunction(html, 'selectOptionChoice')}
    `, context)

    ;(context as any).selectOptionChoice(0)

    const submitted = doAction.mock.calls[0]?.[0]
    expect(submitted).toEqual({
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'tracer',
      skillId: 'recall',
      selectedOption: 2,
      selectionId: 'recall-option',
      stateRevision: 4,
    })
    expect(submitted).not.toHaveProperty('clientActionId')
    expect(submitted).not.toHaveProperty('requestId')
  })

  it('hides an active target-selection overlay when target interaction is cleared', () => {
    const html = readBattlePage()
    const overlay = { classList: createClassList() }
    const body = { classList: createClassList() }
    const elements: Record<string, unknown> = {
      targetOverlay: overlay,
      targetSourceName: { textContent: '' },
      targetPromptText: { textContent: '' },
      targetCancelButton: { disabled: false, textContent: '' },
    }
    const context = vm.createContext({
      document: {
        body,
        getElementById: (id: string) => elements[id] ?? null,
      },
      window: { matchMedia: () => ({ matches: false }) },
      closePieceContextMenu: () => undefined,
      currentTargetSourceName: () => '暗影步',
      _targetPromptText: () => '',
      recordTargetClear: () => undefined,
      setStatusMsg: () => undefined,
    })

    vm.runInContext(`
      let pendingSkill = { skillId: 'shadow-step', targetType: 'cell' }
      let pendingCardAction = null
      let targetSubmissionPending = null
      let pendingBoardTargetSelection = { selectionId: null, selectedPieceIds: [] }
      let pendingMove = false
      ${runtimeFunction(html, 'isPendingBoardMultiTarget')}
      ${runtimeFunction(html, 'pendingBoardMultiLimits')}
      ${runtimeFunction(html, 'pendingBoardMultiSummary')}
      ${runtimeFunction(html, 'renderTargetOverlay')}
      ${runtimeFunction(html, 'clearTargetInteraction')}
      renderTargetOverlay()
    `, context)

    expect(overlay.classList.contains('show')).toBe(true)
    vm.runInContext("clearTargetInteraction('authority-receipt-applied')", context)
    expect(overlay.classList.contains('show')).toBe(false)
  })

  it('submits a completed target step with a fresh authority action id', () => {
    const html = readBattlePage()
    const overlay = { classList: createClassList() }
    const body = { classList: createClassList() }
    let boardRenders = 0
    let actionBarRenders = 0
    let submittedAction: Record<string, unknown> | null = null
    const elements: Record<string, unknown> = {
      targetOverlay: overlay,
      targetSourceName: { textContent: '' },
      targetPromptText: { textContent: '' },
      targetCancelButton: { disabled: false, textContent: '' },
    }
    const context = vm.createContext({
      document: {
        body,
        getElementById: (id: string) => elements[id] ?? null,
      },
      window: { matchMedia: () => ({ matches: false }) },
      closePieceContextMenu: () => undefined,
      currentTargetSourceName: () => '暗影步',
      _targetPromptText: () => '选择一个地格',
      recordTargetClear: () => undefined,
      setStatusMsg: () => undefined,
      withClientActionId: (action: Record<string, unknown>) => action.clientActionId
        ? action
        : { ...action, clientActionId: 'fresh-target-action' },
      renderBoard: () => { boardRenders += 1 },
      renderActionBar: () => { actionBarRenders += 1 },
      doAction: (action: Record<string, unknown>) => {
        submittedAction = action
        return Promise.resolve()
      },
    })

    vm.runInContext(`
      let pendingSkill = { skillId: 'shadow-step', targetType: 'cell' }
      let pendingCardAction = null
      let targetSubmissionPending = null
      let pendingBoardTargetSelection = { selectionId: null, selectedPieceIds: [] }
      let pendingMove = false
      const red50Evidence = { targetCommands: [], clearEvents: [], rejections: [] }
      ${runtimeFunction(html, 'isPendingBoardMultiTarget')}
      ${runtimeFunction(html, 'pendingBoardMultiLimits')}
      ${runtimeFunction(html, 'pendingBoardMultiSummary')}
      ${runtimeFunction(html, 'renderTargetOverlay')}
      ${runtimeFunction(html, 'prepareFreshSelectionAction')}
      ${runtimeFunction(html, 'submitTargetAction')}
      renderTargetOverlay()
    `, context)

    expect(overlay.classList.contains('show')).toBe(true)
    vm.runInContext(`submitTargetAction({
      type: 'useBasicSkill',
      pieceId: 'piece-1',
      clientActionId: 'rejected-target-action',
      requestId: 'rejected-target-request',
    }, '暗影步')`, context)

    expect(submittedAction).toMatchObject({ clientActionId: 'fresh-target-action' })
    expect(submittedAction).not.toHaveProperty('requestId')
    expect(overlay.classList.contains('show')).toBe(false)
    expect(boardRenders).toBe(0)
    expect(actionBarRenders).toBe(0)
  })

  it('routes Grand Crusade confirmation through presentation and submits selected pieces once', () => {
    const html = readBattlePage()
    const renderBoard = vi.fn()
    const renderTargetOverlay = vi.fn()
    const setStatusMsg = vi.fn()
    const doAction = vi.fn(() => Promise.resolve())
    const pieces = ['ally-a', 'ally-b', 'ally-c', 'ally-d'].map(instanceId => ({
      instanceId, name: instanceId,
    }))
    const context = vm.createContext({
      window: {},
      G: { pieces },
      myPlayerId: 'player-red',
      renderBoard,
      renderTargetOverlay,
      setStatusMsg,
      doAction,
      currentTargetSourceName: () => '圣光大远征',
      withClientActionId: (action: Record<string, unknown>) => ({ ...action, clientActionId: 'grand-crusade-1' }),
      addLog: vi.fn(),
      Date,
    })
    new vm.Script(fs.readFileSync(battlePresentationPath, 'utf8')).runInContext(context)

    vm.runInContext(`
      let battlePresentation = null
      let pendingSkill = {
        turnTargetActionType: 'pendingTargetSelect',
        turnTargetPlayerId: 'player-red',
        preparation: {
          targetType: 'piece', selectionMode: 'multi', minSelections: 1, maxSelections: 3,
          selectionId: 'grand-crusade-pieces', stateRevision: 7,
          candidates: G.pieces.map(piece => ({ type: 'piece', pieceId: piece.instanceId })),
        },
      }
      let pendingCardAction = null
      let targetSubmissionPending = null
      let pendingBoardTargetSelection = { selectionId: 'grand-crusade-pieces', selectedPieceIds: [] }
      const red50Evidence = { targetCommands: [], clearEvents: [], rejections: [] }
      ${runtimeFunction(html, 'isPendingBoardMultiTarget')}
      ${runtimeFunction(html, 'pendingBoardMultiLimits')}
      ${runtimeFunction(html, 'togglePendingBoardTarget')}
      ${runtimeFunction(html, 'prepareFreshSelectionAction')}
      ${runtimeFunction(html, 'submitTargetAction')}
      ${runtimeFunction(html, 'confirmPendingBoardTargetSelection')}
      ${runtimeFunction(html, 'handleBattleIntent')}
      ${runtimeFunction(html, 'dispatchBattleIntent')}
      battlePresentation = window.BattlePresentation.create({
        renderer: { init: function() {}, dispose: function() {} },
        domUi: { update: function() {}, dispose: function() {} },
        onIntent: handleBattleIntent,
      })
    `, context)

    ;(context as any).dispatchBattleIntent({ type: 'confirm-target-selection' })
    expect(doAction).not.toHaveBeenCalled()
    expect((context as any).togglePendingBoardTarget(pieces[0])).toBe(true)
    expect((context as any).togglePendingBoardTarget(pieces[1])).toBe(true)
    expect((context as any).togglePendingBoardTarget(pieces[2])).toBe(true)
    expect((context as any).togglePendingBoardTarget(pieces[3])).toBe(false)

    ;(context as any).dispatchBattleIntent({ type: 'confirm-target-selection' })
    expect(doAction).toHaveBeenCalledOnce()
    expect(doAction).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pendingTargetSelect',
      playerId: 'player-red',
      targetPieceId: 'ally-a',
      extraTargets: [{ pieceId: 'ally-b' }, { pieceId: 'ally-c' }],
      selectionId: 'grand-crusade-pieces',
      stateRevision: 7,
      clientActionId: 'grand-crusade-1',
    }))
  })

  it('submits a legal dropped move once and rejects non-highlighted or invalid drops', () => {
    const html = readBattlePage()
    const doAction = vi.fn()
    const setStatusMsg = vi.fn()
    const closePieceContextMenu = vi.fn()
    const context = vm.createContext({ doAction, setStatusMsg, closePieceContextMenu, Set, Number })

    vm.runInContext(`
      let G = {
        pieces: [
          { instanceId: 'piece-1', ownerPlayerId: 'player-red', currentHp: 10, x: 1, y: 1 },
          { instanceId: 'piece-2', ownerPlayerId: 'player-blue', currentHp: 10, x: 2, y: 2 },
        ],
      }
      let myPlayerId = 'player-red'
      let selectedPieceId = 'piece-1'
      let pendingMove = true
      let validMoves = new Set(['2,1'])
      let pendingActionFeedback = null
      let targetSubmissionPending = null
      let pendingSkill = null
      let pendingCardAction = null
      let dismissedPieceContextId = 'piece-1'
      ${runtimeFunction(html, 'moveSelectedPieceToCell')}
    `, context)

    expect(vm.runInContext("moveSelectedPieceToCell('piece-1', 2, 1)", context)).toBe(true)
    expect(doAction).toHaveBeenCalledTimes(1)
    expect(doAction).toHaveBeenCalledWith({ type: 'move', playerId: 'player-red', pieceId: 'piece-1', toX: 2, toY: 1 })
    expect(vm.runInContext('dismissedPieceContextId', context)).toBeNull()
    expect(vm.runInContext("moveSelectedPieceToCell('piece-1', 2, 1)", context)).toBe(false)
    expect(doAction).toHaveBeenCalledTimes(1)

    vm.runInContext('pendingMove = true; validMoves = new Set()', context)
    expect(vm.runInContext("moveSelectedPieceToCell('piece-1', 2, 2)", context)).toBe(false)
    expect(vm.runInContext("moveSelectedPieceToCell('piece-1', null, null)", context)).toBe(false)
    expect(doAction).toHaveBeenCalledTimes(1)
    expect(setStatusMsg).toHaveBeenCalledWith('无法移动到该位置')
  })

  it('switches from piece details to history without toggling an already-restored expansion off', () => {
    const html = readBattlePage()
    const click = vi.fn()
    const focus = vi.fn()
    const closePieceInfo = vi.fn()
    let expanded = true
    const dock = {
      hidden: false,
      querySelector: () => ({ click, focus }),
      classList: { contains: () => expanded },
    }
    const context = vm.createContext({
      closePieceInfo,
      document: { getElementById: () => dock },
      requestAnimationFrame: (callback: () => void) => callback(),
      setStatusMsg: vi.fn(),
    })
    new vm.Script(runtimeFunction(html, 'switchPieceInfoToActionHistory')).runInContext(context)

    vm.runInContext('switchPieceInfoToActionHistory()', context)
    expect(closePieceInfo).toHaveBeenCalledWith({ restoreFocus: false })
    expect(click).not.toHaveBeenCalled()
    expect(focus).toHaveBeenCalledOnce()

    expanded = false
    vm.runInContext('switchPieceInfoToActionHistory()', context)
    expect(click).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledTimes(2)
  })

  it('automatically queries move cells for an eligible selection and clears them for target mode', () => {
    const html = readBattlePage()
    const queryMoveCells = vi.fn(() => new Set(['2,1']))
    const context = vm.createContext({
      window: { BattleLegalActions: { queryMoveCells } },
      BattleLegalActions: { queryMoveCells },
      GameEngine: {},
      Set,
    })

    vm.runInContext(`
      let G = {
        pieces: [{ instanceId: 'piece-1', ownerPlayerId: 'player-red', currentHp: 10, x: 1, y: 1 }],
        players: [{ playerId: 'player-red' }],
        turn: { currentPlayerId: 'player-red', phase: 'action' },
      }
      let myPlayerId = 'player-red'
      let selectedPieceId = 'piece-1'
      let pendingMove = false
      let validMoves = new Set()
      let pendingSkill = null
      let pendingCardAction = null
      let pendingActionFeedback = null
      let targetSubmissionPending = null
      let placingMode = false
      const SPECTATE_MODE = false
      const TRAINING_MODE = false
      function progressiveDeploymentPending() { return false }
      function _updatePendingSkillTargets() {}
      ${runtimeFunction(html, 'refreshBattleLegalActions')}
    `, context)

    vm.runInContext('refreshBattleLegalActions()', context)
    expect(queryMoveCells).toHaveBeenCalledTimes(1)
    expect(vm.runInContext('pendingMove', context)).toBe(true)
    expect(vm.runInContext("validMoves.has('2,1')", context)).toBe(true)

    vm.runInContext("pendingSkill = { skillId: 'skill-1' }; refreshBattleLegalActions()", context)
    expect(queryMoveCells).toHaveBeenCalledTimes(1)
    expect(vm.runInContext('pendingMove', context)).toBe(false)
    expect(vm.runInContext('validMoves.size', context)).toBe(0)
  })

  it('defers and coalesces pending-action presentation until the next animation frame', () => {
    const html = readBattlePage()
    let boardRenders = 0
    let actionBarRenders = 0
    const frames: Array<() => void> = []
    const context = vm.createContext({
      performance: { now: () => 10 },
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      requestAnimationFrame: (callback: () => void) => {
        frames.push(callback)
        return frames.length
      },
      setStatusMsg: () => undefined,
      rejectPendingActionFeedback: () => undefined,
      renderBoard: () => { boardRenders += 1 },
      renderActionBar: () => { actionBarRenders += 1 },
    })

    vm.runInContext(`
      const PENDING_ACTION_TIMEOUT_MS = 8000
      let selectedPieceId = 'piece-1'
      let pendingActionFeedback = null
      let pendingActionFeedbackTimer = null
      let pendingActionPresentationFrame = null
      ${runtimeFunction(html, 'beginPendingActionFeedback')}
      ${runtimeFunction(html, 'schedulePendingActionPresentation')}
    `, context)

    expect(vm.runInContext("beginPendingActionFeedback({ type: 'move', clientActionId: 'action-1' })", context)).toBe(true)
    expect(boardRenders).toBe(0)
    expect(actionBarRenders).toBe(0)

    vm.runInContext(`
      schedulePendingActionPresentation()
      schedulePendingActionPresentation()
    `, context)

    expect(frames).toHaveLength(1)
    expect(boardRenders).toBe(0)
    expect(actionBarRenders).toBe(0)
    frames.shift()?.()
    expect(boardRenders).toBe(0)
    expect(actionBarRenders).toBe(1)

    vm.runInContext(`
      pendingActionFeedback = null
      schedulePendingActionPresentation()
    `, context)
    expect(frames).toHaveLength(1)
    frames.shift()?.()
    expect(boardRenders).toBe(0)
    expect(actionBarRenders).toBe(1)
  })

  it('keeps the original action pending and requests a correlated resync after feedback timeout', () => {
    const html = readBattlePage()
    let timeoutCallback: (() => void) | undefined
    const recover = vi.fn()
    const status = vi.fn()
    const context = vm.createContext({
      performance: { now: () => 10 },
      setTimeout: (callback: () => void) => { timeoutCallback = callback; return 9 },
      clearTimeout: () => undefined,
      setStatusMsg: status,
      renderActionBar: () => undefined,
      requestAuthorityRecovery: recover,
    })

    vm.runInContext(`
      const PENDING_ACTION_TIMEOUT_MS = 8000
      let selectedPieceId = 'piece-1'
      let pendingActionFeedback = null
      let pendingActionFeedbackTimer = null
      ${runtimeFunction(html, 'beginPendingActionFeedback')}
    `, context)

    expect(vm.runInContext("beginPendingActionFeedback({ type: 'move', clientActionId: 'action-timeout-1' })", context)).toBe(true)
    timeoutCallback?.()

    expect(vm.runInContext('pendingActionFeedback.clientActionId', context)).toBe('action-timeout-1')
    expect(vm.runInContext('pendingActionFeedback.timedOut', context)).toBe(true)
    expect(vm.runInContext('pendingActionFeedbackTimer', context)).toBeNull()
    expect(recover).toHaveBeenCalledWith('action-timeout', 'action-timeout-1')
    expect(status).toHaveBeenCalledWith(expect.stringContaining('请勿重复操作'))
    expect(vm.runInContext("beginPendingActionFeedback({ type: 'move', clientActionId: 'action-timeout-2' })", context)).toBe(false)
  })

  it('settles a timed-out pending action from every matching late receipt status without replaying it', () => {
    const html = readBattlePage()
    const recover = vi.fn()
    const context = vm.createContext({
      clearTimeout: () => undefined,
      recordAuthorityPerformance: () => undefined,
      clearTargetInteraction: () => true,
      renderActionBar: () => undefined,
      setStatusMsg: () => undefined,
      requestAuthorityRecovery: recover,
    })

    vm.runInContext(`
      let pendingActionFeedback = null
      let pendingActionFeedbackTimer = null
      let targetSubmissionPending = null
      ${runtimeFunction(html, 'clearPendingActionFeedback')}
      ${runtimeFunction(html, 'applyAuthorityReceipt')}
    `, context)

    for (const status of ['applied', 'duplicate', 'rejected', 'resyncRequired']) {
      const clientActionId = `late-${status}`
      context.__receipt = {
        clientActionId,
        status,
        authorityVersion: 4,
        code: status === 'resyncRequired' ? 'ROOM_VERSION_CONFLICT' : undefined,
        message: status === 'rejected' ? '服务端拒绝了原指令' : undefined,
      }
      vm.runInContext(`
        pendingActionFeedback = {
          clientActionId: ${JSON.stringify(clientActionId)},
          type: 'move',
          startedAt: 0,
          timedOut: true,
        }
        pendingActionFeedbackTimer = null
      `, context)

      expect(vm.runInContext('applyAuthorityReceipt(__receipt)', context)).toBe(true)
      expect(vm.runInContext('pendingActionFeedback', context)).toBeNull()
    }

    expect(recover).toHaveBeenCalledTimes(1)
    expect(recover).toHaveBeenCalledWith('ROOM_VERSION_CONFLICT')
  })

  it('applies the successful training authority receipt before rendering', async () => {
    const html = readBattlePage()
    let clearedTimers = 0
    const projectedEvents = [{
      eventId: 'training-action-1:0',
      rootEventId: 'training-action-1:0',
      actionId: 'training-action-1',
      sequence: 0,
      kind: 'skill',
      iconId: 'action-skill',
      sourcePieceId: 'liadrin',
      skillId: 'liadrin-divine-shield',
    }]
    const projectBattlePresentationEvents = vi.fn(() => structuredClone(projectedEvents))
    const projectBattlePresentationEventsForViewer = vi.fn((events: typeof projectedEvents) => structuredClone(events))
    const Engine = { projectBattlePresentationEvents, projectBattlePresentationEventsForViewer }
    const presentationUpdate = vi.fn()
    const elements: Record<string, { disabled?: boolean; textContent?: string }> = {
      btnEnd: { disabled: false },
      btnSwitchPov: { textContent: '' },
    }
    const nextState = {
      pieces: [{ instanceId: 'liadrin', currentHp: 14 }],
      players: [{ playerId: 'player-red', actionPoints: 0, hand: [] }],
      turn: { currentPlayerId: 'player-red', phase: 'action' },
      terminalResult: null,
    }
    const context = vm.createContext({
      window: { RvBGameEngine: { ensure: async () => Engine } },
      __presentationUpdate: presentationUpdate,
      document: { getElementById: (id: string) => elements[id] ?? null },
      clearTimeout: () => { clearedTimers += 1 },
      setMoveButtonDisabled: () => undefined,
      trainingApiFetch: async () => nextState,
      spawnStateFloaters: () => undefined,
      flushActionLog: () => undefined,
      getTrainingPlayerFaction: () => 'red',
      trainingPlayerLabel: () => '红方',
      reconcileBattleInteractionState: () => '',
      restoreSelectedPieceMenu: () => undefined,
      handleGameOver: () => undefined,
      setStatusMsg: () => undefined,
      rejectPendingActionFeedback: () => undefined,
      recordAuthorityPerformance: () => undefined,
      requestAuthorityRecovery: () => undefined,
      renderActionBar: () => undefined,
      addLog: () => undefined,
    })

    vm.runInContext(`
      let G = {
        pieces: [{ instanceId: 'liadrin', currentHp: 14 }],
        players: [{ playerId: 'player-red', actionPoints: 3, hand: [] }],
        turn: { currentPlayerId: 'player-red', phase: 'action' },
      }
      let pendingActionFeedback = {
        clientActionId: 'training-action-1',
        type: 'playCard',
        startedAt: 0,
      }
      let pendingActionFeedbackTimer = 99
      let targetSubmissionPending = {
        clientActionId: 'training-action-1',
        type: 'playCard',
        label: '圣光盾',
      }
      let pendingSkill = null
      let pendingCardAction = null
      let latestBattlePresentationEvents = []
      let trainingBattlePresentationChains = []
      let selectedPieceId = null
      let myPlayerId = 'player-red'
      let myFaction = 'red'
      const TRAINING_MODE = true
      let _use3d = false
      let battlePresentation = { update: globalThis.__presentationUpdate }
      const red50Evidence = { targetCommands: [], clearEvents: [], rejections: [] }
      function clearTargetInteraction() {
        pendingSkill = null
        pendingCardAction = null
        targetSubmissionPending = null
        return true
      }
      function render() {
        globalThis.__pendingAtRender = pendingActionFeedback
        globalThis.__targetPendingAtRender = targetSubmissionPending
        const model = createBattlePresentationModel(G)
        battlePresentation.update(model)
        globalThis.__eventsAtRender = model.presentationEvents
      }
      function createBattlePresentationModel(snapshot) {
        return { snapshot, presentationEvents: latestBattlePresentationEvents }
      }
      ${runtimeFunction(html, 'clearPendingActionFeedback')}
      ${runtimeFunction(html, 'applyAuthorityReceipt')}
      ${runtimeFunction(html, 'refreshTrainingPresentationEvents')}
      ${runtimeFunction(html, 'appendTrainingPresentationEvents')}
      async ${runtimeFunction(html, 'trainingDoAction')}
    `, context)

    const submittedAction = {
      type: 'playCard',
      playerId: 'player-red',
      clientActionId: 'training-action-1',
      targetPieceId: 'liadrin',
    }
    context.__submittedAction = structuredClone(submittedAction)
    const actionBefore = structuredClone(context.__submittedAction)
    const nextStateBefore = structuredClone(nextState)

    await vm.runInContext('trainingDoAction(__submittedAction)', context)

    expect(context.__pendingAtRender).toBeNull()
    expect(context.__targetPendingAtRender).toBeNull()
    expect(context.__eventsAtRender).toEqual(projectedEvents)
    expect(presentationUpdate).toHaveBeenCalledWith(expect.objectContaining({ presentationEvents: projectedEvents }))
    expect(projectBattlePresentationEvents).toHaveBeenCalledOnce()
    expect(projectBattlePresentationEvents).toHaveBeenCalledWith({
      actionId: 'training-action-1',
      command: expect.objectContaining(submittedAction),
      beforeState: expect.objectContaining({
        players: [expect.objectContaining({ playerId: 'player-red', actionPoints: 3 })],
      }),
      afterState: nextState,
    })
    expect(projectBattlePresentationEventsForViewer).toHaveBeenCalledWith(projectedEvents, 'player-red')
    expect(context.__submittedAction).toEqual(actionBefore)
    expect(nextState).toEqual(nextStateBefore)
    expect(vm.runInContext('pendingActionFeedback', context)).toBeNull()
    expect(vm.runInContext('targetSubmissionPending', context)).toBeNull()
    expect(vm.runInContext('pendingActionFeedbackTimer', context)).toBeNull()
    expect(clearedTimers).toBe(1)
  })

  it('coalesces a pending-option transition and its matching receipt into one lightweight render', () => {
    const html = readBattlePage()
    const counts = { board: 0, hud: 0, panels: 0, actionBar: 0, hand: 0, target: 0, performance: 0 }
    const context = vm.createContext({
      renderBoard: () => { counts.board += 1 },
      renderBattleHud: () => { counts.hud += 1 },
      renderPanels: () => { counts.panels += 1 },
      renderActionBar: () => { counts.actionBar += 1 },
      renderHand: () => { counts.hand += 1 },
      renderTargetOverlay: () => { counts.target += 1 },
      syncAuthoritativePendingPresentation: () => undefined,
      updateRed43QaEvidence: () => undefined,
      clearTargetInteraction: () => undefined,
      recordAuthorityPerformance: () => { counts.performance += 1 },
      requestAuthorityRecovery: () => undefined,
      setStatusMsg: () => undefined,
      clearTimeout: () => undefined,
      battleInteractionMode: () => 'inspect',
    })

    vm.runInContext(`
      const previousState = {
        map: { id: 'arena', width: 2, height: 2, tiles: [] },
        pieces: [{ instanceId: 'piece-1', currentHp: 10 }],
        players: [{ playerId: 'red', actionPoints: 1, hand: [] }],
        turn: { currentPlayerId: 'red', turnNumber: 1, phase: 'start' },
        pendingOptionSelection: { playerId: 'red', selectionId: 'option-1' },
        extensions: { tileEffects: [] },
      }
      const nextState = JSON.parse(JSON.stringify(previousState))
      delete nextState.pendingOptionSelection
      nextState.turn.phase = 'action'
      let G = previousState
      let latestAuthorityVersion = 1
      let latestAuthorityStateHash = 'hash-1'
      let selectedPieceId = 'piece-1'
      let currentBattleViewModel = {
        selection: { pieceId: 'piece-1', mode: 'inspect' },
        interaction: { pendingCommandId: null },
      }
      let pendingActionFeedback = { clientActionId: 'action-1', type: 'pendingOptionSelect', startedAt: 1 }
      let pendingActionFeedbackTimer = null
      let targetSubmissionPending = null
      let _use3d = false
      let battlePresentation = null
      const GameEngine = { applyBattlePublicPatch: () => nextState }
      function authorityPatchBaseState() { return previousState }
      function applyServerState(state, seed, preserveWsSeq, serverNow, turnTimer, options) {
        const oldState = G
        G = state
        const policy = options.deriveRenderPolicy ? deriveAuthorityRenderPolicy(oldState, G) : {}
        render(Object.assign({}, policy, { beforeBoardUpdate: options.beforeBoardUpdate }))
        globalThis.__policy = policy
      }
      ${runtimeFunction(html, 'sameBattleRenderValue')}
      ${runtimeFunction(html, 'deriveAuthorityRenderPolicy')}
      ${runtimeFunction(html, 'clearPendingActionFeedback')}
      ${runtimeFunction(html, 'applyAuthorityReceipt')}
      ${runtimeFunction(html, 'render')}
      ${runtimeFunction(html, 'applyBattleTransition')}
      globalThis.__applied = applyBattleTransition({
        protocolVersion: 3,
        authorityBuildId: 'rvb-authority-v3-chunked-sha256-1',
        roomId: 'room-1',
        fromVersion: 1,
        toVersion: 2,
        prePublicHash: 'hash-1',
        postPublicHash: 'hash-2',
        stateHash: 'hash-2',
        patch: [{ op: 'replace', path: '/turn/phase', value: 'action' }],
        receipt: { clientActionId: 'action-1', status: 'applied', authorityVersion: 2 },
      })
      globalThis.__result = { pendingActionFeedback, latestAuthorityVersion }
    `, context)

    expect(context.__applied).toBe(true)
    expect((context.__policy as { board: boolean }).board).toBe(false)
    expect((context.__result as { pendingActionFeedback: unknown }).pendingActionFeedback).toBeNull()
    expect((context.__result as { latestAuthorityVersion: number }).latestAuthorityVersion).toBe(2)
    expect(counts).toEqual({ board: 0, hud: 1, panels: 1, actionBar: 1, hand: 1, target: 1, performance: 1 })
  })

  it('renders the board exactly once when an authoritative transition changes a piece', () => {
    const html = readBattlePage()
    const counts = { board: 0, hud: 0, panels: 0, actionBar: 0, hand: 0, target: 0 }
    const context = vm.createContext({
      renderBoard: () => { counts.board += 1 },
      renderBattleHud: () => { counts.hud += 1 },
      renderPanels: () => { counts.panels += 1 },
      renderActionBar: () => { counts.actionBar += 1 },
      renderHand: () => { counts.hand += 1 },
      renderTargetOverlay: () => { counts.target += 1 },
      syncAuthoritativePendingPresentation: () => undefined,
      updateRed43QaEvidence: () => undefined,
      recordAuthorityPerformance: () => undefined,
      requestAuthorityRecovery: () => undefined,
      battleInteractionMode: () => 'inspect',
    })

    vm.runInContext(`
      const previousState = {
        map: { id: 'arena', width: 2, height: 2, tiles: [] },
        pieces: [{ instanceId: 'piece-1', currentHp: 10, x: 0, y: 0 }],
        extensions: { tileEffects: [] },
      }
      const nextState = JSON.parse(JSON.stringify(previousState))
      nextState.pieces[0].x = 1
      let G = previousState
      let latestAuthorityVersion = 1
      let latestAuthorityStateHash = 'hash-1'
      let selectedPieceId = null
      let pendingActionFeedback = null
      let currentBattleViewModel = {
        selection: { pieceId: null, mode: 'inspect' },
        interaction: { pendingCommandId: null },
      }
      let _use3d = false
      let battlePresentation = null
      const GameEngine = { applyBattlePublicPatch: () => nextState }
      function authorityPatchBaseState() { return previousState }
      function applyServerState(state, seed, preserveWsSeq, serverNow, turnTimer, options) {
        const oldState = G
        G = state
        const policy = options.deriveRenderPolicy ? deriveAuthorityRenderPolicy(oldState, G) : {}
        render(Object.assign({}, policy, { beforeBoardUpdate: options.beforeBoardUpdate }))
        globalThis.__policy = policy
      }
      ${runtimeFunction(html, 'sameBattleRenderValue')}
      ${runtimeFunction(html, 'deriveAuthorityRenderPolicy')}
      ${runtimeFunction(html, 'applyAuthorityReceipt')}
      ${runtimeFunction(html, 'render')}
      ${runtimeFunction(html, 'applyBattleTransition')}
      globalThis.__applied = applyBattleTransition({
        protocolVersion: 3,
        authorityBuildId: 'rvb-authority-v3-chunked-sha256-1',
        roomId: 'room-1',
        fromVersion: 1,
        toVersion: 2,
        prePublicHash: 'hash-1',
        postPublicHash: 'hash-2',
        stateHash: 'hash-2',
        patch: [{ op: 'replace', path: '/pieces/0/x', value: 1 }],
        receipt: null,
      })
    `, context)

    expect(context.__applied).toBe(true)
    expect((context.__policy as { board: boolean }).board).toBe(true)
    expect(counts).toEqual({ board: 1, hud: 0, panels: 1, actionBar: 1, hand: 1, target: 1 })
  })

  it('preserves the transition motion callback before a HUD-only presentation update', () => {
    const html = readBattlePage()
    const events: string[] = []
    const context = vm.createContext({
      __events: events,
      refreshBattleLegalActions: () => { events.push('legal-actions') },
      createBattlePresentationModel: () => {
        events.push('create-model')
        return { marker: 'created' }
      },
    })

    vm.runInContext(`
      let G = { map: { id: 'arena', width: 2, height: 2, tiles: [] } }
      let currentBattleViewModel = null
      const battleDomUi = {
        update: () => { globalThis.__events.push('dom-update') },
      }
      const preparedModel = { marker: 'prepared' }
      ${runtimeFunction(html, 'prepareCurrentBattlePresentationModel')}
      ${runtimeFunction(html, 'renderBattleHud')}
      renderBattleHud(preparedModel, () => { globalThis.__events.push('motion') })
      globalThis.__reusedPreparedModel = currentBattleViewModel === preparedModel
    `, context)

    expect(context.__reusedPreparedModel).toBe(true)
    expect(events).toEqual(['legal-actions', 'motion', 'dom-update'])
  })

  it('starts initialization on load and turns terminal setup errors into visible errors', () => {
    const html = readBattlePage()

    expect(html).toMatch(/window\.addEventListener\('load',[\s\S]*?\binit\(\)/)
    expect(html).toMatch(/if \(!roomId \|\| !myPlayerId\) \{ showMsg\([^\n]+, 'err'\); return \}/)
    expect(html).toContain("spinner.style.display = type === 'err' ? 'none' : ''")
  })
})
