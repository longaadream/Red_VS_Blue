/* eslint-disable @typescript-eslint/no-explicit-any -- Extracts the browser deployment controller into a focused VM. */
import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

const page = readFileSync('data/pages/battle.html', 'utf8')

function readFunction(html: string, name: string, isAsync = false) {
  const marker = `${isAsync ? 'async ' : ''}function ${name}(`
  const start = html.indexOf(marker)
  if (start === -1) throw new Error(`Missing ${name} in battle.html`)
  const opening = html.indexOf('{', start + marker.length)
  if (opening === -1) throw new Error(`Could not isolate ${name} in battle.html`)
  let depth = 0
  let quote = ''
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = opening; index < html.length; index += 1) {
    const character = html[index]
    const next = html[index + 1]
    if (lineComment) {
      if (character === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') { blockComment = false; index += 1 }
      continue
    }
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '/' && next === '/') { lineComment = true; index += 1; continue }
    if (character === '/' && next === '*') { blockComment = true; index += 1; continue }
    if (character === '\'' || character === '"' || character === '`') { quote = character; continue }
    if (character === '{') depth += 1
    else if (character === '}' && --depth === 0) return html.slice(start, index + 1)
  }
  throw new Error(`Could not isolate ${name} in battle.html`)
}

class FakeElement {
  hidden = false
  textContent = ''
  innerHTML = ''
  style: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  readonly classNames = new Set<string>()
  readonly classList = {
    toggle: (name: string, force?: boolean) => {
      const next = force === undefined ? !this.classNames.has(name) : force
      if (next) this.classNames.add(name)
      else this.classNames.delete(name)
      return next
    },
    contains: (name: string) => this.classNames.has(name),
  }

  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
}

type DeploymentHarness = {
  context: Record<string, any>
  deployment: Record<string, any>
  elements: Record<string, FakeElement>
  doAction: ReturnType<typeof vi.fn>
  render: ReturnType<typeof vi.fn>
  setStatusMsg: ReturnType<typeof vi.fn>
  renderPieceInfoRecord: ReturnType<typeof vi.fn>
}

function createHarness(): DeploymentHarness {
  const elements = Object.fromEntries([
    'deploymentStatus',
    'deploymentLabel',
    'deploymentCountdown',
    'deploymentState',
    'deploymentChoices',
    'deploymentChangeChoice',
    'deploymentFooter',
    'deploymentReserveCount',
  ].map(id => [id, new FakeElement()])) as Record<string, FakeElement>
  const bodyClasses = new Set<string>()
  const deployment = {
    mode: 'progressive-reserve-v1',
    status: 'awaiting-reserve-deploy',
    revision: 17,
    activePlayerId: 'PLAYER-RED',
    offerPieces: [
      { instanceId: 'reserve-1', templateId: 'hero-template', name: 'Hero' },
      { instanceId: 'reserve-2', templateId: 'other-template', name: 'Other' },
    ],
    legalPositions: [{ x: 2, y: 3 }],
    reserveCounts: { 'PLAYER-RED': 6 },
  }
  const doAction = vi.fn(() => Promise.resolve())
  const render = vi.fn()
  const setStatusMsg = vi.fn()
  const renderPieceInfoRecord = vi.fn()
  const windowObject: Record<string, any> = {}
  const document = {
    activeElement: null,
    body: { classList: { toggle: vi.fn((name: string, force: boolean) => force ? bodyClasses.add(name) : bodyClasses.delete(name)) } },
    getElementById: (id: string) => elements[id] || null,
  }
  const context = createContext({
    window: windowObject,
    globalThis: windowObject,
    document,
    console,
    G: { deployment, pieces: [], turn: { currentPlayerId: 'player-red' } },
    myPlayerId: 'player-red',
    SPECTATE_MODE: false,
    ADVENTURE_MODE: false,
    TRAINING_MODE: false,
    adventureDeployPieceId: null,
    targetSubmissionPending: null,
    pendingActionFeedback: null,
    selectedPieceId: null,
    currentAuthorityNow: () => 0,
    presentedDeployment: () => deployment,
    progressiveDeploymentOwned: () => true,
    pieceName: (piece: Record<string, any>) => piece.name,
    PIECES_BY_ID: {
      'hero-template': { image: 'hero.png' },
      'other-template': { image: 'other.png' },
    },
    resolveDeploymentOfferPiece: (pieceId: string) => ({
      instanceId: pieceId,
      templateId: pieceId === 'reserve-1' ? 'hero-template' : 'other-template',
      name: pieceId === 'reserve-1' ? 'Hero' : 'Other',
      error: false,
      stats: { maxHp: 10, attack: 4, defense: 2, moveRange: 3 },
    }),
    RvBDeploymentStatus: undefined,
    updateDeploymentGhost: vi.fn(),
    render,
    setStatusMsg,
    doAction,
    refreshBattleLegalActions: vi.fn(),
    pendingOptionSelectionForOther: () => false,
    adventureOpenCell: () => false,
    escHtml: (value: unknown) => String(value),
    renderPieceInfoRecord,
    renderDeploymentPieceInfoError: vi.fn(),
    reconcileDeploymentPieceInfo: vi.fn(),
  }) as unknown as Record<string, any>
  new Script(readFileSync('data/pages/js/battle-ui/deployment-status.js', 'utf8'), {
    filename: 'deployment-status.js',
  }).runInContext(context as any)
  context.RvBDeploymentStatus = windowObject.RvBDeploymentStatus
  const script = [
    'let deploymentChoicesExpanded = false',
    'let deploymentChoicesRenderKey = ""',
    'let deploymentHoverCell = null',
    'let deploymentGhost = null',
    'let localDeploymentChoiceId = null',
    'let currentPieceInfoId = null',
    'let currentPieceInfoSource = ""',
    'let currentPieceInfoDeploymentRevision = null',
    'let pieceInfoReturnFocus = null',
    readFunction(page, 'selectReserveDeploymentPiece', true),
    readFunction(page, 'toggleDeploymentCandidates'),
    readFunction(page, 'renderDeploymentStatus'),
    readFunction(page, 'showDeploymentPieceInfo'),
    readFunction(page, 'onCellClick'),
  ].join('\n')
  new Script(script, { filename: 'battle.html:deployment-ui' }).runInContext(context as any)
  return { context, deployment, elements, doAction, render, setStatusMsg, renderPieceInfoRecord }
}

describe('RED-241 deployment candidate presentation', () => {
  it('collapses candidates after selection and lets the player expand them again', async () => {
    const h = createHarness()
    new Script('renderDeploymentStatus()').runInContext(h.context as any)
    expect(h.elements.deploymentChoices.hidden).toBe(false)

    await new Script('selectReserveDeploymentPiece("reserve-1")').runInContext(h.context as any)
    new Script('renderDeploymentStatus()').runInContext(h.context as any)

    expect(h.elements.deploymentChoices.hidden).toBe(true)
    expect(h.elements.deploymentChangeChoice.hidden).toBe(false)
    expect(h.elements.deploymentChangeChoice.textContent).toBe('更换棋子')
    expect(h.elements.deploymentChangeChoice.getAttribute('aria-expanded')).toBe('false')

    new Script('toggleDeploymentCandidates()').runInContext(h.context as any)

    expect(h.elements.deploymentChoices.hidden).toBe(false)
    expect(h.elements.deploymentChangeChoice.textContent).toBe('收起候选')
    expect(h.elements.deploymentChangeChoice.getAttribute('aria-expanded')).toBe('true')
  })

  it('opens candidate details without selecting or submitting a deployment', () => {
    const h = createHarness()
    const trigger = { focus: vi.fn() }

    new Script('showDeploymentPieceInfo("reserve-1", trigger, false)', { filename: 'details' })
      .runInContext(Object.assign(h.context, { trigger }) as any)

    expect(h.renderPieceInfoRecord).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'reserve-1',
      templateId: 'hero-template',
    }), false)
    expect(new Script('localDeploymentChoiceId').runInContext(h.context as any)).toBeNull()
    expect(h.doAction).not.toHaveBeenCalled()
  })

  it('submits exactly one action from a legal highlighted cell after selection', async () => {
    const h = createHarness()
    await new Script('selectReserveDeploymentPiece("reserve-1")').runInContext(h.context as any)

    new Script('onCellClick(2, 3)').runInContext(h.context as any)

    expect(h.doAction).toHaveBeenCalledOnce()
    expect(h.doAction).toHaveBeenCalledWith({
      type: 'deployReservePiece',
      playerId: 'player-red',
      expectedDeploymentRevision: 17,
      pieceId: 'reserve-1',
      toX: 2,
      toY: 3,
    })
    expect(h.render).toHaveBeenCalledOnce()
  })
})
