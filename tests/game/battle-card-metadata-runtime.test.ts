import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext, type Context } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

const battlePage = readFileSync(resolve(process.cwd(), 'data/pages/battle.html'), 'utf8')

function readNamedFunction(name: string, isAsync = false) {
  const marker = `${isAsync ? 'async ' : ''}function ${name}(`
  const start = battlePage.indexOf(marker)
  if (start === -1) throw new Error(`Missing ${marker} in battle.html`)

  const candidates = [
    battlePage.indexOf('\n    function ', start + marker.length),
    battlePage.indexOf('\n    async function ', start + marker.length),
  ].filter(index => index !== -1)
  const end = Math.min(...candidates)
  if (!Number.isFinite(end)) throw new Error(`Could not isolate ${name} in battle.html`)
  return battlePage.slice(start, end)
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (reason?: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

interface HandContainer {
  innerHTML: string
  renderCount: number
  setAttribute: ReturnType<typeof vi.fn>
  replaceChildren: () => void
}

interface Runtime {
  context: Context
  container: HandContainer
  fetchServerJson: ReturnType<typeof vi.fn>
  submittedActions: unknown[]
  errors: unknown[][]
}

function createRuntime(overrides: Record<string, unknown> = {}): Runtime {
  let renderedHtml = ''
  let renderCount = 0
  const container = {
    get innerHTML() { return renderedHtml },
    set innerHTML(value: string) {
      renderedHtml = value
      renderCount += 1
    },
    get renderCount() { return renderCount },
    setAttribute: vi.fn(),
    replaceChildren: () => {
      renderedHtml = ''
      renderCount += 1
    },
  }
  const hudHandCount = { textContent: '' }
  const handMultiSelectControls = { hidden: true }
  const handMultiSelectCount = { textContent: '' }
  const handMultiSelectConfirm = { disabled: true, textContent: '' }
  const handMultiSelectCancel = { disabled: false, hidden: false }
  const submittedActions: unknown[] = []
  const errors: unknown[][] = []
  const fetchServerJson = vi.fn(async () => {
    throw new Error('unexpected card metadata request')
  })
  const context = createContext({
    G: {
      players: [{
        playerId: 'player-blue',
        actionPoints: 2,
        hand: [{ cardId: 'lucky-coin', instanceId: 'lucky-coin-instance' }],
      }],
      turn: { currentPlayerId: 'player-blue' },
    },
    myPlayerId: 'player-blue',
    TRAINING_MODE: false,
    wsMode: 'lan',
    cardsById: {},
    cardDisplayMetadataById: Object.create(null),
    cardDisplayMetadataRequests: new Map(),
    cardDisplayMetadataFailures: new Set(),
    cardDisplayMetadataLoggedErrors: new Set(),
    battlePageDisposed: false,
    pendingCardAction: null,
    pendingHandOptionSelection: { selectionId: null, selectedValues: [], submitting: false },
    fetchServerJson,
    renderHand: undefined,
    doAction: (action: unknown) => submittedActions.push(action),
    console: {
      error: (...args: unknown[]) => errors.push(args),
      warn: vi.fn(),
    },
    document: {
      getElementById: (id: string) => {
        if (id === 'hudHandCount') return hudHandCount
        if (id === 'handCards') return container
        if (id === 'handMultiSelectControls') return handMultiSelectControls
        if (id === 'handMultiSelectCount') return handMultiSelectCount
        if (id === 'handMultiSelectConfirm') return handMultiSelectConfirm
        if (id === 'handMultiSelectCancel') return handMultiSelectCancel
        return null
      },
      querySelector: () => null,
    },
    window: {
      BattleContextLayout: {
        handArc: () => ({ angle: 0, lift: 0, zIndex: 1 }),
      },
    },
    escHtml: (value: unknown) => String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;'),
    ...overrides,
  })

  const runtimeFunctions = [
    ['reportCardDisplayMetadataFailure', false],
    ['isStableCardId', false],
    ['isTrustedCardArtName', false],
    ['cardArtSource', false],
    ['sanitizeCardDisplayMetadata', false],
    ['getCardDisplayDefinition', false],
    ['currentHandHasCard', false],
    ['loadCardDisplayMetadata', true],
    ['ensureHandCardDisplayMetadata', false],
  ] as const
  new Script(runtimeFunctions.map(([name, isAsync]) => readNamedFunction(name, isAsync)).join('\n'))
    .runInContext(context)

  return { context, container, fetchServerJson, submittedActions, errors }
}

function installRenderHand(context: Context) {
  new Script([
    readNamedFunction('isPendingHandSelection'),
    readNamedFunction('pendingHandCandidateValues'),
    readNamedFunction('syncPendingHandSelection'),
    readNamedFunction('renderPendingHandSelectionControls'),
    readNamedFunction('cardDisplayDescription'),
    readNamedFunction('renderHand'),
  ].join('\n')).runInContext(context)
}

describe('LAN battle hand card display metadata', () => {
  it('renders complete local metadata without contacting the authority server', async () => {
    const runtime = createRuntime({
      TRAINING_MODE: true,
      cardsById: {
        'lucky-coin': {
          id: 'lucky-coin',
          name: '幸运币',
          description: '获得1点行动点。',
          actionPointCost: 0,
          type: 'active',
          image: 'the-coin.jpg',
        },
      },
    })
    installRenderHand(runtime.context)

    new Script('renderHand()').runInContext(runtime.context)
    await new Script('ensureHandCardDisplayMetadata(G.players[0].hand)').runInContext(runtime.context)

    expect(runtime.container.innerHTML).toContain('幸运币')
    expect(runtime.container.innerHTML).toContain('获得1点行动点。')
    expect(runtime.container.innerHTML).toContain('card-mana-gem free">0')
    expect(runtime.container.innerHTML).toContain('card-type-badge">主动')
    expect(runtime.container.innerHTML).toContain('images/card-art/the-coin.jpg')
    expect(runtime.fetchServerJson).not.toHaveBeenCalled()
    expect(runtime.submittedActions).toEqual([])
  })

  it('recovers a minimal LAN hand through one deduplicated display-only request', async () => {
    const response = deferred<Record<string, unknown>>()
    const fetchServerJson = vi.fn(() => response.promise)
    const runtime = createRuntime({
      fetchServerJson,
      G: {
        players: [{
          playerId: 'player-blue',
          actionPoints: 2,
          hand: [
            { cardId: 'lucky-coin', instanceId: 'lucky-coin-instance-1' },
            { cardId: 'lucky-coin', instanceId: 'lucky-coin-instance-2' },
          ],
        }],
        turn: { currentPlayerId: 'player-blue' },
      },
    })
    installRenderHand(runtime.context)
    const stateBefore = JSON.stringify(runtime.context.G)

    new Script('renderHand(); renderHand()').runInContext(runtime.context)
    const settled = new Script('ensureHandCardDisplayMetadata(G.players[0].hand)')
      .runInContext(runtime.context) as Promise<unknown>

    expect(runtime.container.innerHTML).toContain('lucky-coin')
    expect(runtime.container.innerHTML).toContain('暂无描述')
    expect(fetchServerJson).toHaveBeenCalledTimes(1)
    expect(fetchServerJson).toHaveBeenCalledWith('catalog.card', { cardId: 'lucky-coin' }, 3500)

    response.resolve({
      id: 'lucky-coin',
      name: '幸运币',
      description: '获得1点行动点。',
      actionPointCost: 0,
      type: 'active',
      image: 'the-coin.jpg',
      code: 'throw new Error("must never execute")',
    })
    await settled

    expect(runtime.container.innerHTML).toContain('幸运币')
    expect(runtime.container.innerHTML).toContain('获得1点行动点。')
    expect(runtime.container.innerHTML).toContain('images/card-art/the-coin.jpg')
    new Script('G = JSON.parse(JSON.stringify(G)); renderHand()').runInContext(runtime.context)
    await new Script('ensureHandCardDisplayMetadata(G.players[0].hand)').runInContext(runtime.context)
    expect(fetchServerJson).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(runtime.context.G)).toBe(stateBefore)
    expect(runtime.context.pendingCardAction).toBeNull()
    expect(runtime.submittedActions).toEqual([])
    expect(runtime.context.cardDisplayMetadataById['lucky-coin']).not.toHaveProperty('code')
  })

  it.each([
    ['404', new Error('HTTP 404')],
    ['timeout', new Error('/api/cards/missing-card timeout after 3500ms')],
  ])('negative-caches %s failures and keeps the stable ID placeholder', async (_label, error) => {
    const fetchServerJson = vi.fn(async () => { throw error })
    const runtime = createRuntime({
      fetchServerJson,
      G: {
        players: [{
          playerId: 'player-blue',
          actionPoints: 2,
          hand: [{ cardId: 'missing-card', instanceId: 'missing-instance' }],
        }],
        turn: { currentPlayerId: 'player-blue' },
      },
    })
    installRenderHand(runtime.context)

    await new Script('ensureHandCardDisplayMetadata(G.players[0].hand)')
      .runInContext(runtime.context)
    await new Script('ensureHandCardDisplayMetadata(G.players[0].hand)')
      .runInContext(runtime.context)
    new Script('renderHand()').runInContext(runtime.context)

    expect(fetchServerJson).toHaveBeenCalledTimes(1)
    expect(runtime.container.innerHTML).toContain('missing-card')
    expect(runtime.container.innerHTML).toContain('暂无描述')
    expect(runtime.errors.some(args => JSON.stringify(args).includes('missing-card'))).toBe(true)
    expect(runtime.submittedActions).toEqual([])
  })

  it('keeps sibling cards visible when one authority lookup fails', async () => {
    const fetchServerJson = vi.fn(async (_method: string, data: { cardId: string }) => {
      if (data.cardId === 'missing-card') throw new Error('WS catalog miss')
      return {
        id: 'lucky-coin',
        name: '幸运币',
        description: '获得1点行动点。',
        actionPointCost: 0,
        type: 'active',
        image: 'the-coin.jpg',
      }
    })
    const runtime = createRuntime({
      fetchServerJson,
      G: {
        players: [{
          playerId: 'player-blue',
          actionPoints: 2,
          hand: [
            { cardId: 'missing-card', instanceId: 'missing-instance' },
            { cardId: 'lucky-coin', instanceId: 'lucky-coin-instance' },
          ],
        }],
        turn: { currentPlayerId: 'player-blue' },
      },
    })
    installRenderHand(runtime.context)

    await new Script('ensureHandCardDisplayMetadata(G.players[0].hand)')
      .runInContext(runtime.context)
    new Script('renderHand()').runInContext(runtime.context)

    expect(fetchServerJson).toHaveBeenCalledTimes(2)
    expect(runtime.container.innerHTML).toContain('missing-card')
    expect(runtime.container.innerHTML).toContain('暂无描述')
    expect(runtime.container.innerHTML).toContain('幸运币')
    expect(runtime.container.innerHTML).toContain('获得1点行动点。')
    expect(runtime.errors.some(args => JSON.stringify(args).includes('missing-card'))).toBe(true)
  })

  it('rejects non-local image identifiers and does not inject them into the hand', async () => {
    const fetchServerJson = vi.fn(async () => ({
      id: 'lucky-coin',
      name: '幸运币',
      description: '获得1点行动点。',
      actionPointCost: 0,
      type: 'active',
      image: 'https://attacker.invalid/card.jpg',
    }))
    const runtime = createRuntime({ fetchServerJson })
    installRenderHand(runtime.context)

    await new Script('ensureHandCardDisplayMetadata(G.players[0].hand)')
      .runInContext(runtime.context)
    new Script('renderHand()').runInContext(runtime.context)

    expect(runtime.container.innerHTML).toContain('lucky-coin')
    expect(runtime.container.innerHTML).not.toContain('attacker.invalid')
    expect(runtime.errors.some(args => JSON.stringify(args).includes('lucky-coin'))).toBe(true)
  })

  it('does not repaint an old hand or store a response that arrives after page disposal', async () => {
    const oldResponse = deferred<Record<string, unknown>>()
    const disposedResponse = deferred<Record<string, unknown>>()
    const fetchServerJson = vi.fn((_method: string, data: { cardId: string }) => {
      if (data.cardId === 'old-card') return oldResponse.promise
      return disposedResponse.promise
    })
    let renderCount = 0
    const runtime = createRuntime({
      fetchServerJson,
      renderHand: () => { renderCount += 1 },
      G: {
        players: [{
          playerId: 'player-blue',
          actionPoints: 2,
          hand: [{ cardId: 'old-card', instanceId: 'old-instance' }],
        }],
        turn: { currentPlayerId: 'player-blue' },
      },
    })

    const oldSettled = new Script('ensureHandCardDisplayMetadata(G.players[0].hand)')
      .runInContext(runtime.context) as Promise<unknown>
    runtime.context.G.players[0].hand = [{ cardId: 'new-card', instanceId: 'new-instance' }]
    oldResponse.resolve({
      id: 'old-card', name: '旧卡', description: '旧描述', actionPointCost: 1, type: 'active', image: 'old.jpg',
    })
    await oldSettled

    expect(renderCount).toBe(0)
    expect(runtime.context.cardDisplayMetadataById['old-card']).toMatchObject({ name: '旧卡' })

    const disposedSettled = new Script('ensureHandCardDisplayMetadata(G.players[0].hand)')
      .runInContext(runtime.context) as Promise<unknown>
    runtime.context.battlePageDisposed = true
    disposedResponse.resolve({
      id: 'new-card', name: '新卡', description: '新描述', actionPointCost: 1, type: 'active', image: 'new.jpg',
    })
    await disposedSettled

    expect(renderCount).toBe(0)
    expect(runtime.context.cardDisplayMetadataById['new-card']).toBeUndefined()
  })

  it('marks the page disposed before clearing in-flight card metadata requests', () => {
    expect(battlePage).toMatch(/function disposeBattlePage\(\) \{\s*battlePageDisposed = true\s*cardDisplayMetadataRequests\.clear\(\)/)
  })
})

describe('RED-121 authoritative hand selection presentation', () => {
  it('selects pending card instances in the hand, enforces four, and submits once', async () => {
    const statusMessages: string[] = []
    const hand = Array.from({ length: 5 }, (_, index) => ({
      cardId: ['holy-smite', 'holy-heal', 'holy-charge'][index % 3],
      instanceId: `holy-${index + 1}`,
    })).concat([{ cardId: 'filler', instanceId: 'filler-1' }])
    const pendingOptionSelection = {
      playerId: 'player-blue',
      title: '穆鲁的挽歌：选择要丢弃的圣光手牌',
      options: hand.slice(0, 5).map(card => ({ label: card.cardId, value: card.instanceId })),
      selectionId: 'muru-hand-selection',
      stateRevision: 7,
      canCancel: true,
      selectionMode: 'multi',
      presentation: 'hand',
      minSelections: 1,
      maxSelections: 4,
    }
    const runtime = createRuntime({
      G: {
        players: [{ playerId: 'player-blue', actionPoints: 3, hand }],
        turn: { currentPlayerId: 'player-blue' },
        pendingOptionSelection,
      },
      cardsById: {
        'holy-smite': { name: '圣光惩击', actionPointCost: 2, type: 'active' },
        'holy-heal': { name: '圣光治疗', actionPointCost: 2, type: 'active' },
        'holy-charge': { name: '圣光充能', actionPointCost: 2, type: 'active' },
        filler: { name: '填充牌', actionPointCost: 1, type: 'active' },
      },
      pendingOptionSelectionForMe: () => true,
      renderActionBar: vi.fn(),
      renderPieceContextMenu: vi.fn(),
      setMoveButtonClass: vi.fn(),
      setStatusMsg: (message: string) => statusMessages.push(message),
    })

    new Script([
      readNamedFunction('isPendingHandSelection'),
      readNamedFunction('pendingHandCandidateValues'),
      readNamedFunction('syncPendingHandSelection'),
      readNamedFunction('renderPendingHandSelectionControls'),
      readNamedFunction('togglePendingHandOption'),
      readNamedFunction('confirmPendingHandOptionSelection', true),
      readNamedFunction('cancelPendingHandOptionSelection', true),
      readNamedFunction('onCardClick'),
    ].join('\n')).runInContext(runtime.context)
    installRenderHand(runtime.context)

    new Script('syncPendingHandSelection(G.pendingOptionSelection); renderHand()').runInContext(runtime.context)
    expect(runtime.container.innerHTML).toContain('card-choice-selectable')
    expect(runtime.container.innerHTML).toContain('card-choice-disabled')
    expect(new Script("document.getElementById('handMultiSelectCount').textContent").runInContext(runtime.context))
      .toBe('已选择 0 / 4')

    for (const id of ['holy-1', 'holy-2', 'holy-3', 'holy-4']) {
      new Script(`onCardClick('${id}', 'holy-smite')`).runInContext(runtime.context)
    }
    expect(new Script('pendingHandOptionSelection.selectedValues.length').runInContext(runtime.context)).toBe(4)
    expect(runtime.container.innerHTML).toContain('card-choice-selected')

    new Script("onCardClick('holy-5', 'holy-heal')").runInContext(runtime.context)
    expect(new Script('pendingHandOptionSelection.selectedValues.length').runInContext(runtime.context)).toBe(4)
    expect(statusMessages.at(-1)).toContain('最多选择4张')

    new Script("onCardClick('holy-2', 'holy-heal')").runInContext(runtime.context)
    await new Script('confirmPendingHandOptionSelection()').runInContext(runtime.context)
    expect(runtime.submittedActions).toEqual([{
      type: 'pendingOptionSelect',
      playerId: 'player-blue',
      selectedOption: ['holy-1', 'holy-3', 'holy-4'],
      selectionId: 'muru-hand-selection',
      stateRevision: 7,
    }])
    expect(new Script('pendingHandOptionSelection.selectedValues').runInContext(runtime.context))
      .toEqual(['holy-1', 'holy-3', 'holy-4'])
  })

  it('selects prophecy cards in the hand and submits a scalar value without opening the picker', async () => {
    const pendingOptionSelection = {
      playerId: 'player-blue',
      title: '圣光预言：选择一张圣光手牌',
      options: [{ label: '圣光惩击', value: 'prophecy-card' }],
      selectionId: 'prophecy-hand-selection',
      stateRevision: 9,
      canCancel: true,
      selectionMode: 'single',
      presentation: 'hand',
      minSelections: 1,
      maxSelections: 1,
    }
    const runtime = createRuntime({
      G: {
        players: [{
          playerId: 'player-blue', actionPoints: 3,
          hand: [
            { cardId: 'holy-smite', instanceId: 'prophecy-card' },
            { cardId: 'filler', instanceId: 'filler-card' },
          ],
        }],
        turn: { currentPlayerId: 'player-blue' },
        pendingOptionSelection,
      },
      cardsById: {
        'holy-smite': { name: '圣光惩击', description: '基础描述', actionPointCost: 2, type: 'active' },
        filler: { name: '填充牌', description: '填充描述', actionPointCost: 1, type: 'active' },
      },
      pendingOptionSelectionForMe: () => true,
      renderActionBar: vi.fn(),
      renderPieceContextMenu: vi.fn(),
      setMoveButtonClass: vi.fn(),
      setStatusMsg: vi.fn(),
    })

    new Script([
      readNamedFunction('isPendingHandSelection'),
      readNamedFunction('pendingHandCandidateValues'),
      readNamedFunction('syncPendingHandSelection'),
      readNamedFunction('renderPendingHandSelectionControls'),
      readNamedFunction('togglePendingHandOption'),
      readNamedFunction('confirmPendingHandOptionSelection', true),
      readNamedFunction('onCardClick'),
    ].join('\n')).runInContext(runtime.context)
    installRenderHand(runtime.context)

    new Script('syncPendingHandSelection(G.pendingOptionSelection); renderHand()').runInContext(runtime.context)
    expect(runtime.container.innerHTML).toContain('card-choice-selectable')
    expect(runtime.container.innerHTML).toContain('card-choice-disabled')
    new Script("onCardClick('prophecy-card', 'holy-smite')").runInContext(runtime.context)
    await new Script('confirmPendingHandOptionSelection()').runInContext(runtime.context)

    expect(runtime.submittedActions).toEqual([{
      type: 'pendingOptionSelect',
      playerId: 'player-blue',
      selectedOption: 'prophecy-card',
      selectionId: 'prophecy-hand-selection',
      stateRevision: 9,
    }])
  })

  it('renders prophecy-enhanced holy cards with visible state and their actual enhanced values', () => {
    const runtime = createRuntime({
      TRAINING_MODE: true,
      G: {
        players: [{
          playerId: 'player-blue', actionPoints: 10,
          hand: [
            { cardId: 'holy-smite', instanceId: 'enhanced-smite', presentation: { variant: 'enhanced', badge: '预言强化', description: '预言强化：对敌方生命值最低的棋子造成7点真实伤害。' } },
            { cardId: 'holy-heal', instanceId: 'enhanced-heal', presentation: { variant: 'enhanced', badge: '预言强化', description: '预言强化：治疗己方生命值最低的棋子12点生命。' } },
            { cardId: 'holy-charge', instanceId: 'enhanced-charge', presentation: { variant: 'enhanced', badge: '预言强化', description: '预言强化：使己方所有棋子下次造成的伤害提高3点。' } },
            { cardId: 'holy-smite', instanceId: 'pending-prophecy', contentState: { velenHolyProphecy: { sourcePieceId: 'velen' } } },
          ],
        }],
        turn: { currentPlayerId: 'player-blue' },
      },
      cardsById: {
        'holy-smite': { name: '圣光惩击', description: '对敌方生命值最低的棋子造成5点真实伤害。', actionPointCost: 2, type: 'active' },
        'holy-heal': { name: '圣光治疗', description: '治疗己方生命值最低的棋子8点生命。', actionPointCost: 2, type: 'active' },
        'holy-charge': { name: '圣光充能', description: '使己方所有棋子下次造成的伤害提高2点。', actionPointCost: 2, type: 'active' },
      },
      pendingOptionSelectionForMe: () => false,
    })
    installRenderHand(runtime.context)

    new Script('renderHand()').runInContext(runtime.context)

    expect(runtime.container.innerHTML.match(/card-content-enhanced/g)).toHaveLength(3)
    expect(runtime.container.innerHTML.match(/预言强化/g)?.length).toBeGreaterThanOrEqual(3)
    expect(runtime.container.innerHTML).toContain('造成7点真实伤害')
    expect(runtime.container.innerHTML).toContain('12点生命')
    expect(runtime.container.innerHTML).toContain('提高3点')
    expect(runtime.container.innerHTML).toContain('造成5点真实伤害')
  })
})
