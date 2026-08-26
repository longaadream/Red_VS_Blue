import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

import { describe, expect, it } from 'vitest'

const projectRoot = process.cwd()
const battlePagePath = path.join(projectRoot, 'data', 'pages', 'battle.html')

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
      let pendingMove = false
      ${runtimeFunction(html, 'renderTargetOverlay')}
      ${runtimeFunction(html, 'clearTargetInteraction')}
      renderTargetOverlay()
    `, context)

    expect(overlay.classList.contains('show')).toBe(true)
    vm.runInContext("clearTargetInteraction('authority-receipt-applied')", context)
    expect(overlay.classList.contains('show')).toBe(false)
  })

  it('shows target selection but hides the blocking overlay as soon as its command is submitted', () => {
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
      withClientActionId: (action: Record<string, unknown>) => ({ ...action, clientActionId: 'action-1' }),
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
      let pendingMove = false
      const red50Evidence = { targetCommands: [], clearEvents: [], rejections: [] }
      ${runtimeFunction(html, 'renderTargetOverlay')}
      ${runtimeFunction(html, 'submitTargetAction')}
      renderTargetOverlay()
    `, context)

    expect(overlay.classList.contains('show')).toBe(true)
    vm.runInContext("submitTargetAction({ type: 'useBasicSkill', pieceId: 'piece-1' }, '暗影步')", context)

    expect(submittedAction).toMatchObject({ clientActionId: 'action-1' })
    expect(overlay.classList.contains('show')).toBe(false)
    expect(boardRenders).toBe(0)
    expect(actionBarRenders).toBe(0)
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
        protocolVersion: 2,
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
        protocolVersion: 2,
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
