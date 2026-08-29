import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { afterEach, describe, expect, it, vi } from 'vitest'

type BrowserHandler = ((event?: any) => void) | null

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readyState = 0
  sent: string[] = []
  onopen: BrowserHandler = null
  onmessage: BrowserHandler = null
  onclose: BrowserHandler = null
  onerror: BrowserHandler = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(payload: string) {
    this.sent.push(payload)
  }

  open() {
    this.readyState = 1
    this.onopen?.({})
  }

  receive(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  beginClosing() {
    this.readyState = 2
  }

  closeFromPeer() {
    this.readyState = 3
    this.onclose?.({})
  }

  close() {
    this.closeFromPeer()
  }
}

function loadClient() {
  FakeWebSocket.instances = []
  const browserWindow: Record<string, any> = {
    location: { search: '' },
    RvBUtils: {
      getConnectionConfig: () => ({ url: 'http://127.0.0.1:38521' }),
    },
  }
  const context = createContext({
    window: browserWindow,
    localStorage: { getItem: () => null },
    URLSearchParams,
    WebSocket: FakeWebSocket,
    setTimeout,
    clearTimeout,
    console,
  })
  new Script(
    readFileSync(resolve(process.cwd(), 'data/pages/js/ws-client.js'), 'utf8'),
    { filename: 'ws-client.js' },
  ).runInContext(context)
  return browserWindow.RvBWs as {
    connect(roomId: string, playerId: string, mode: string): void
    disconnect(): void
    isConnected(): boolean
    on(event: string, handler: () => void): void
  }
}

afterEach(() => {
  vi.useRealTimers()
  FakeWebSocket.instances = []
})

describe('battle WebSocket reconnect state machine', () => {
  it('becomes connected only after subscription and resubscribes after a disconnect', async () => {
    vi.useFakeTimers()
    const client = loadClient()
    let connects = 0
    let disconnects = 0
    client.on('connect', () => { connects += 1 })
    client.on('disconnect', () => { disconnects += 1 })

    client.connect('room-a', 'player-red', 'lan')
    const first = FakeWebSocket.instances[0]
    first.open()
    await Promise.resolve()

    expect(client.isConnected()).toBe(false)
    expect(connects).toBe(0)
    expect(JSON.parse(first.sent[0])).toEqual({
      type: 'subscribe',
      roomId: 'room-a',
      playerId: 'player-red',
    })

    first.receive({ type: 'subscribed', roomId: 'room-a', role: 'guest' })
    expect(client.isConnected()).toBe(true)
    expect(connects).toBe(1)

    first.closeFromPeer()
    expect(client.isConnected()).toBe(false)
    expect(disconnects).toBe(1)
    await vi.advanceTimersByTimeAsync(3_000)

    const second = FakeWebSocket.instances[1]
    second.open()
    await Promise.resolve()
    second.receive({ type: 'subscribed', roomId: 'room-a', role: 'guest' })
    expect(client.isConnected()).toBe(true)
    expect(connects).toBe(2)
    expect(JSON.parse(second.sent[0])).toMatchObject({ type: 'subscribe', roomId: 'room-a' })
  })

  it('ignores a stale socket close after a replacement connection is subscribed', async () => {
    vi.useFakeTimers()
    const client = loadClient()
    let disconnects = 0
    client.on('disconnect', () => { disconnects += 1 })

    client.connect('room-a', 'player-red', 'lan')
    const stale = FakeWebSocket.instances[0]
    stale.open()
    await Promise.resolve()
    stale.receive({ type: 'subscribed', roomId: 'room-a', role: 'guest' })
    stale.beginClosing()

    client.connect('room-a', 'player-red', 'lan')
    const replacement = FakeWebSocket.instances[1]
    replacement.open()
    await Promise.resolve()
    replacement.receive({ type: 'subscribed', roomId: 'room-a', role: 'guest' })
    expect(client.isConnected()).toBe(true)

    stale.closeFromPeer()
    expect(client.isConnected()).toBe(true)
    expect(disconnects).toBe(0)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })
})
