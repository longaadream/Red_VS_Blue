import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

const lobbyPagePath = path.join(process.cwd(), 'data', 'pages', 'lobby.html')

type StoredBattle = {
  roomId: string
  playerId: string
  playerName?: string
}

type MockElement = {
  disabled: boolean
  innerHTML: string
  style: Record<string, string>
  textContent: string
}

function readLobbyPage() {
  return fs.readFileSync(lobbyPagePath, 'utf8')
}

function inlineScript(html: string) {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  const source = scripts.at(-1)?.[1]
  if (!source) throw new Error('lobby inline script not found')
  return source
}

function initialRejoinDisplay(html: string) {
  const tag = html.match(/<div\s+id="rejoinBar"[^>]*>/i)?.[0] ?? ''
  const style = tag.match(/\sstyle="([^"]*)"/i)?.[1] ?? ''
  const declarations = style.split(';').map(part => part.trim()).filter(Boolean)
  return declarations.reduce((display, declaration) => {
    const [property, value] = declaration.split(':').map(part => part.trim())
    return property === 'display' ? value : display
  }, '')
}

function createHarness(options: {
  saved?: StoredBattle | string
  room?: unknown
  roomError?: Error
} = {}) {
  const html = readLobbyPage()
  const storage = new Map<string, string>()
  if (options.saved !== undefined) {
    storage.set('rvb_active_battle', typeof options.saved === 'string'
      ? options.saved
      : JSON.stringify(options.saved))
  }

  const elements = new Map<string, MockElement>()
  const element = (id: string) => {
    if (!elements.has(id)) {
      elements.set(id, {
        disabled: false,
        innerHTML: '',
        style: { display: id === 'rejoinBar' ? initialRejoinDisplay(html) : '' },
        textContent: '',
      })
    }
    return elements.get(id)!
  }
  const alerts: string[] = []
  const warnings: unknown[][] = []
  const location = { href: 'lobby.html', search: '' }
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => { storage.delete(key) },
    setItem: (key: string, value: string) => { storage.set(key, value) },
  }
  const window = {
    addEventListener: () => {},
    location,
    RvBUtils: {
      getActiveServerMode: () => 'lan',
      getServerUrl: () => 'http://127.0.0.1:3000',
    },
  }
  const context = vm.createContext({
    URLSearchParams,
    alert: (message: string) => { alerts.push(message) },
    clearInterval: () => {},
    clearTimeout,
    confirm: () => true,
    console: { ...console, warn: (...args: unknown[]) => { warnings.push(args) } },
    document: { getElementById: element },
    fetch: vi.fn(),
    localStorage,
    location,
    setInterval: () => 1,
    setTimeout,
    window,
    RvBIdentity: { getIdentity: () => ({ id: 'alice', displayName: 'Alice' }) },
    RvBUtils: window.RvBUtils,
  })

  const script = `${inlineScript(html)}\n;globalThis.__lobbyRejoinContract = {
    checkRejoin,
    rejoinBattle,
    setLobbyRequest: (request) => { lobbyRequest = request },
  }`
  vm.runInContext(script, context)
  const contract = context.__lobbyRejoinContract as {
    checkRejoin: () => Promise<void> | void
    rejoinBattle: () => void
    setLobbyRequest: (request: (method: string, data: unknown) => Promise<unknown>) => void
  }
  contract.setLobbyRequest(async (method, data) => {
    expect(method).toBe('rooms.get')
    expect(data).toEqual({ roomId: 'room-58' })
    if (options.roomError) throw options.roomError
    return options.room
  })

  return { alerts, contract, element, location, storage, warnings }
}

describe('Electron lobby rejoin entry', () => {
  it('stays hidden when there is no saved active battle', async () => {
    const harness = createHarness()

    await harness.contract.checkRejoin()

    expect(harness.element('rejoinBar').style.display).toBe('none')
  })

  it('shows a valid in-progress battle and navigates with the saved player identity', async () => {
    const harness = createHarness({
      saved: { roomId: 'room-58', playerId: 'Alice', playerName: 'Alice' },
      room: { id: 'room-58', status: 'in-progress', players: [{ id: 'alice' }, { id: 'bob' }] },
    })

    await harness.contract.checkRejoin()
    expect(harness.element('rejoinBar').style.display).toBe('flex')

    harness.contract.rejoinBattle()
    expect(harness.location.href).toBe('battle.html?roomId=room-58&playerId=Alice&playerName=Alice')
  })

  it.each([
    ['room is no longer active', { id: 'room-58', status: 'waiting', players: [{ id: 'alice' }] }],
    ['saved player is no longer in the room', { id: 'room-58', status: 'in-progress', players: [{ id: 'bob' }] }],
  ])('clears a stale server battle when %s and exposes why rejoin is unavailable', async (_reason, room) => {
    const harness = createHarness({
      saved: { roomId: 'room-58', playerId: 'alice' },
      room,
    })

    await harness.contract.checkRejoin()

    expect(harness.element('rejoinBar').style.display).toBe('none')
    expect(harness.storage.has('rvb_active_battle')).toBe(false)
    expect(harness.element('rejoinFeedback').textContent).toContain('已失效')
    expect(harness.warnings.length).toBeGreaterThan(0)
  })

  it('clears malformed saved data and makes an empty click observable', async () => {
    const harness = createHarness({ saved: '{broken json' })

    await harness.contract.checkRejoin()
    expect(harness.storage.has('rvb_active_battle')).toBe(false)
    expect(harness.element('rejoinBar').style.display).toBe('none')
    expect(harness.element('rejoinFeedback').textContent).toContain('无效')

    harness.contract.rejoinBattle()
    expect(harness.alerts.at(-1)).toContain('没有可重新加入的对局')
  })
})
