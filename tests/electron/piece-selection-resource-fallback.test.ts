import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, test, vi } from 'vitest'

const root = path.resolve(__dirname, '..', '..')

type Piece = {
  id: string
  name: string
  faction: 'good' | 'evil'
  stats: { maxHp: number; attack: number; defense: number; moveRange: number }
  skills: never[]
}

type MockResponse = {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

type PageContract = {
  confirmSelection: () => Promise<void>
  getPieces: () => Piece[]
  loadPieces: () => Promise<void>
  pollRoomStatus: () => Promise<void>
  setAlignment: (alignment: 'light' | 'dark') => Promise<void>
  setSelectedIds: (ids: string[]) => void
  updateFactionBadge: () => void
}

type MockElement = {
  classList: {
    add: (name: string) => void
    contains: (name: string) => boolean
    remove: (name: string) => void
    toggle: (name: string, force?: boolean) => boolean
  }
  disabled: boolean
  innerHTML: string
  style: Record<string, string>
  textContent: string
  addEventListener: () => void
}

function makePieces(faction: 'good' | 'evil', count: number): Piece[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${faction}-${index + 1}`,
    name: `${faction} ${index + 1}`,
    faction,
    stats: { maxHp: 10, attack: 2, defense: 1, moveRange: 3 },
    skills: [],
  }))
}

function response(body: unknown, status = 200): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function createElement(): MockElement {
  const classes = new Set<string>()
  return {
    classList: {
      add: name => { classes.add(name) },
      contains: name => classes.has(name),
      remove: name => { classes.delete(name) },
      toggle: (name, force) => {
        const enabled = force === undefined ? !classes.has(name) : force
        if (enabled) classes.add(name)
        else classes.delete(name)
        return enabled
      },
    },
    disabled: false,
    innerHTML: '',
    style: {},
    textContent: '',
    addEventListener: () => {},
  }
}

function createHarness(options: {
  fetchPackJson: (path: string) => Promise<unknown>
  serverFetch: (path: string, init?: Record<string, unknown>) => Promise<MockResponse>
}) {
  const page = fs.readFileSync(path.join(root, 'data/pages/piece-selection.html'), 'utf8')
  const inlineScripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  const script = inlineScripts.at(-1)?.[1]
  if (!script) throw new Error('piece-selection inline script not found')

  const elements = new Map<string, MockElement>()
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, createElement())
    return elements.get(id)!
  }
  const alerts: string[] = []
  const location = {
    href: 'piece-selection.html',
    search: '?roomId=room-54&playerId=alice&playerName=Alice&alignment=light',
  }
  const serverFetch = vi.fn(options.serverFetch)
  const window = {
    addEventListener: () => {},
    fetchPackJson: options.fetchPackJson,
    location,
    RvBUtils: {
      appendServerParams: (params: URLSearchParams) => params,
      getActiveServerMode: () => 'lan',
      getServerUrl: () => 'http://127.0.0.1:3000',
      serverFetch,
    },
  }
  const context = vm.createContext({
    AbortController,
    URLSearchParams,
    alert: (message: string) => { alerts.push(message) },
    clearInterval: () => {},
    clearTimeout,
    console,
    document: { getElementById: element },
    fetch: vi.fn(),
    location,
    setInterval: () => 1,
    setTimeout,
    window,
    RvBUtils: window.RvBUtils,
  })

  vm.runInContext(`${script}\n;globalThis.__pieceSelectionContract = {
    confirmSelection,
    getPieces: () => PIECE_TEMPLATES,
    loadPieces,
    pollRoomStatus,
    setAlignment,
    setSelectedIds: (ids) => { selectedIds = new Set(ids) },
    updateFactionBadge,
  }`, context)

  return {
    alerts,
    contract: context.__pieceSelectionContract as PageContract,
    element,
    location,
    serverFetch,
  }
}

function localPack(pieces: Piece[]) {
  return async (resourcePath: string): Promise<unknown> => {
    if (resourcePath.endsWith('/manifest.json')) return pieces.map(piece => piece.id)
    const id = resourcePath.split('/').at(-1)?.replace(/\.json$/, '')
    const piece = pieces.find(candidate => candidate.id === id)
    if (!piece) throw new Error(`missing local resource ${resourcePath}`)
    return piece
  }
}

describe('Electron piece-selection resource contract', () => {
  const lightPieces = makePieces('good', 10)
  const darkPieces = makePieces('evil', 9)
  const allPieces = [...lightPieces, ...darkPieces]

  test('keeps versioned local resources first and avoids the server when they load', async () => {
    const harness = createHarness({
      fetchPackJson: localPack(allPieces),
      serverFetch: async () => { throw new Error('server must not be used') },
    })

    await harness.contract.loadPieces()

    expect(harness.contract.getPieces().map(piece => piece.id)).toEqual(lightPieces.map(piece => piece.id))
    expect(harness.serverFetch).not.toHaveBeenCalled()
  })

  test('falls back to current server pieces without allowing a locked alignment switch', async () => {
    const harness = createHarness({
      fetchPackJson: async resourcePath => {
        if (resourcePath.endsWith('/manifest.json')) return allPieces.map(piece => piece.id)
        throw new Error(`pack file unavailable: ${resourcePath}`)
      },
      serverFetch: async resourcePath => {
        expect(resourcePath).toBe('/api/pieces')
        return response({ pieces: allPieces })
      },
    })

    await harness.contract.loadPieces()
    harness.contract.updateFactionBadge()
    expect(harness.contract.getPieces().every(piece => piece.faction === 'good')).toBe(true)
    expect(harness.element('alignmentLightBtn').disabled).toBe(true)
    expect(harness.element('alignmentDarkBtn').disabled).toBe(true)

    await harness.contract.setAlignment('dark')
    expect(harness.contract.getPieces()).toHaveLength(lightPieces.length)
    expect(harness.contract.getPieces().every(piece => piece.faction === 'good')).toBe(true)
    expect(harness.alerts).toEqual(['阵营已在大厅锁定，无法在选棋阶段切换'])
    expect(harness.serverFetch).toHaveBeenCalledWith('/api/pieces', { timeoutMs: expect.any(Number) })
  })

  test('leaves enough of the five-second budget for server fallback when local loading hangs', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness({
        fetchPackJson: async () => new Promise(() => {}),
        serverFetch: async () => response({ pieces: allPieces }),
      })

      const loading = harness.contract.loadPieces()
      await vi.advanceTimersByTimeAsync(2000)
      await loading

      expect(harness.contract.getPieces()).toHaveLength(lightPieces.length)
      expect(harness.serverFetch).toHaveBeenCalledWith('/api/pieces', { timeoutMs: 2500 })
    } finally {
      vi.useRealTimers()
    }
  })

  test('shows both source failures instead of a silent empty roster', async () => {
    const harness = createHarness({
      fetchPackJson: async () => { throw new Error('local pack read failed') },
      serverFetch: async () => { throw new Error('server unavailable') },
    })

    await harness.contract.loadPieces()

    expect(harness.contract.getPieces()).toEqual([])
    expect(harness.element('pieceGrid').innerHTML).toContain('本地资源')
    expect(harness.element('pieceGrid').innerHTML).toContain('local pack read failed')
    expect(harness.element('pieceGrid').innerHTML).toContain('服务器')
    expect(harness.element('pieceGrid').innerHTML).toContain('server unavailable')
    expect(harness.element('pieceGrid').innerHTML).not.toContain('加载棋子数据')
  })

  test('times out stalled server response bodies instead of loading forever', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness({
        fetchPackJson: async () => { throw new Error('local unavailable') },
        serverFetch: async () => ({
          ok: true,
          status: 200,
          json: async () => new Promise(() => {}),
        }),
      })

      const loading = harness.contract.loadPieces()
      await vi.advanceTimersByTimeAsync(2500)
      await loading

      expect(harness.contract.getPieces()).toEqual([])
      expect(harness.element('pieceGrid').innerHTML).toContain('服务器 /api/pieces timeout after 2500ms')
      expect(harness.element('pieceGrid').innerHTML).not.toContain('加载棋子数据')
    } finally {
      vi.useRealTimers()
    }
  })

  test.each([
    [{ pieces: [{ id: 'missing-faction' }] }, 'faction 必须是 good 或 evil'],
    [{ pieces: darkPieces }, '光方可用棋子不足 8 个'],
  ])('diagnoses unusable server piece data: %s', async (serverBody, expectedError) => {
    const harness = createHarness({
      fetchPackJson: async () => { throw new Error('local unavailable') },
      serverFetch: async () => response(serverBody),
    })

    await harness.contract.loadPieces()

    expect(harness.contract.getPieces()).toEqual([])
    expect(harness.element('pieceGrid').innerHTML).toContain('服务器 /api/pieces')
    expect(harness.element('pieceGrid').innerHTML).toContain(expectedError)
  })

  test('rejects non-eight selections, then waits and enters the shared battle page', async () => {
    let roomReady = false
    const harness = createHarness({
      fetchPackJson: localPack(allPieces),
      serverFetch: async (resourcePath, init) => {
        if (resourcePath.endsWith('/actions')) {
          const body = JSON.parse(String(init?.body)) as { pieces: Piece[] }
          expect(body.pieces).toHaveLength(8)
          return response({ room: { status: 'selecting' } })
        }
        expect(resourcePath).toBe('/api/rooms/room-54')
        return response({ status: roomReady ? 'in-progress' : 'selecting' })
      },
    })
    await harness.contract.loadPieces()

    harness.contract.setSelectedIds(lightPieces.slice(0, 7).map(piece => piece.id))
    await harness.contract.confirmSelection()
    harness.contract.setSelectedIds(lightPieces.slice(0, 9).map(piece => piece.id))
    await harness.contract.confirmSelection()
    expect(harness.alerts).toEqual(['请选择正好 8 个棋子', '请选择正好 8 个棋子'])
    expect(harness.serverFetch).not.toHaveBeenCalled()

    harness.contract.setSelectedIds(lightPieces.slice(0, 8).map(piece => piece.id))
    await harness.contract.confirmSelection()
    expect(harness.element('waitOverlay').classList.contains('show')).toBe(true)

    roomReady = true
    await harness.contract.pollRoomStatus()
    expect(harness.location.href).toContain('battle.html?')
  })
})
