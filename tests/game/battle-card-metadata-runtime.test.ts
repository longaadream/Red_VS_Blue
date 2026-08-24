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
  new Script(readNamedFunction('renderHand')).runInContext(context)
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
    expect(fetchServerJson).toHaveBeenCalledWith('/api/cards/lucky-coin', 3500)

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
    const fetchServerJson = vi.fn(async (path: string) => {
      if (path.endsWith('/missing-card')) throw new Error('HTTP 404')
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
    const fetchServerJson = vi.fn((path: string) => {
      if (path.endsWith('/old-card')) return oldResponse.promise
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
