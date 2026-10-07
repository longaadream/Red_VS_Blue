/* eslint-disable @typescript-eslint/no-explicit-any -- Exercises the browser Colyseus adapter with a protocol-only room fake. */
import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'

type RoomMessage = { type: string; payload: Record<string, unknown> }

class FakeRoom {
  static instances: FakeRoom[] = []
  readonly roomId = 'room-a'
  readonly reconnectionToken = 'room-a:social-session'
  readonly sent: RoomMessage[] = []
  readonly reconnection = { enabled: false, maxEnqueuedMessages: 10 }
  readonly joinOptions: Record<string, unknown>
  private readonly messageHandlers = new Map<string, Array<(message: unknown) => void>>()
  private errorHandler: ((code: number, message: string) => void) | null = null
  private leaveHandler: (() => void) | null = null
  private dropHandler: (() => void) | null = null
  private reconnectHandler: (() => void) | null = null

  constructor(joinOptions: Record<string, unknown>) {
    this.joinOptions = joinOptions
    FakeRoom.instances.push(this)
  }

  onMessage(type: string, handler: (message: unknown) => void) {
    const handlers = this.messageHandlers.get(type) ?? []
    handlers.push(handler)
    this.messageHandlers.set(type, handlers)
    return () => this.messageHandlers.set(type, handlers.filter(candidate => candidate !== handler))
  }

  onError(handler: (code: number, message: string) => void) { this.errorHandler = handler }
  onLeave(handler: () => void) { this.leaveHandler = handler }
  onDrop(handler: () => void) { this.dropHandler = handler }
  onReconnect(handler: () => void) { this.reconnectHandler = handler }

  send(type: string, payload: Record<string, unknown>) { this.sent.push({ type, payload }) }

  request(type: string, _payload: Record<string, unknown>) {
    void _payload
    if (type === 'roomRpc') return Promise.resolve({ hostId: 'player-red' })
    if (type === 'battleReceiptRequest') return Promise.resolve({})
    return Promise.reject(new Error(`unsupported request: ${type}`))
  }

  emit(type: string, message: unknown) {
    for (const handler of this.messageHandlers.get(type) ?? []) handler(message)
  }

  fail(code: number, message: string) { this.errorHandler?.(code, message) }
  drop() { this.dropHandler?.() }
  reconnect() { this.reconnectHandler?.() }
  leaveFromServer() { this.leaveHandler?.() }
  async leave() {}
}

class FakeColyseusClient {
  static endpoints: string[] = []
  static joinCalls = 0
  readonly http = { options: {} as Record<string, unknown> }

  constructor(endpoint: string) { FakeColyseusClient.endpoints.push(endpoint) }

  async joinById(_roomId: string, options: Record<string, unknown>) {
    FakeColyseusClient.joinCalls += 1
    return new FakeRoom(options)
  }

  async reconnect(_token: string) {
    void _token
    return new FakeRoom({ reconnected: true })
  }
}

function loadClient() {
  FakeRoom.instances = []
  FakeColyseusClient.endpoints = []
  FakeColyseusClient.joinCalls = 0
  const profileIdentity = getServerGameProfileIdentityV1()
  const storage = new Map<string, string>()
  const browserWindow: Record<string, any> = {
    location: { search: '' },
    Colyseus: { Client: FakeColyseusClient },
    RvBIdentity: { getIdentity: () => ({ id: 'player-red', displayName: 'Test Red' }) },
    RvBUtils: { getConnectionConfig: () => ({ url: 'http://127.0.0.1:38521' }) },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    },
  }
  const localStorage = {
    getItem: (key: string) => key === 'rvb_game_profile_identity' ? JSON.stringify(profileIdentity) : null,
    setItem: () => {},
    removeItem: () => {},
  }
  const context = createContext({
    window: browserWindow,
    localStorage,
    sessionStorage: browserWindow.sessionStorage,
    URLSearchParams,
    URL,
    AbortController,
    fetch,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    console,
  })
  new Script(readFileSync('data/pages/js/colyseus-client.js', 'utf8'), {
    filename: 'colyseus-client.js',
  }).runInContext(context)
  return browserWindow.RvBColyseus as {
    connect(roomId: string, playerId: string, mode?: string): void
    disconnect(): void
    send(message: Record<string, unknown>): boolean
    on(event: string, handler: (data?: unknown) => void): void
    requestAuthoritySync(reason: string, clientActionId?: string): boolean
    isAuthoritySyncing(): boolean
  }
}

async function finishConnect() {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  FakeRoom.instances = []
  FakeColyseusClient.endpoints = []
  FakeColyseusClient.joinCalls = 0
})

describe('RED-241 battle social Colyseus transport', () => {
  it('registers social room messages and sends socialHello/socialSend independently', async () => {
    const client = loadClient()
    const received: any[] = []
    client.on('message', message => {
      if (['socialReady', 'socialAck', 'socialEvent'].includes(String((message as any)?.type))) received.push(message)
    })

    client.connect('room-a', 'player-red')
    await finishConnect()
    const room = FakeRoom.instances[0]
    room.sent.length = 0

    expect(client.send({ type: 'socialHello', requestId: 'hello-1' })).toBe(true)
    expect(client.send({ type: 'socialSend', requestId: 'send-1', kind: 'text', payload: '你好' })).toBe(true)
    expect(room.sent).toEqual([
      { type: 'socialHello', payload: { type: 'socialHello', requestId: 'hello-1' } },
      { type: 'socialSend', payload: { type: 'socialSend', requestId: 'send-1', kind: 'text', payload: '你好' } },
    ])

    room.emit('socialReady', { supported: true, protocolVersion: 1 })
    room.emit('socialAck', { requestId: 'send-1', ok: true })
    room.emit('socialEvent', { messageId: 'message-1', kind: 'text', displayName: 'Blue', payload: '收到' })
    expect(received).toEqual([
      { type: 'socialReady', supported: true, protocolVersion: 1 },
      { type: 'socialAck', requestId: 'send-1', ok: true },
      { type: 'socialEvent', messageId: 'message-1', kind: 'text', displayName: 'Blue', payload: '收到' },
    ])
    client.disconnect()
  })

  it('drops social messages delivered by an obsolete room generation', async () => {
    const client = loadClient()
    const events: any[] = []
    client.on('message', message => { if ((message as any)?.type === 'socialEvent') events.push(message) })

    client.connect('room-a', 'player-red')
    await finishConnect()
    const staleRoom = FakeRoom.instances[0]
    client.connect('room-a', 'player-red')
    await finishConnect()
    const currentRoom = FakeRoom.instances[1]

    staleRoom.emit('socialEvent', { messageId: 'stale', payload: '不要显示' })
    currentRoom.emit('socialEvent', { messageId: 'current', payload: '显示' })

    expect(events).toEqual([{ type: 'socialEvent', messageId: 'current', payload: '显示' }])
    client.disconnect()
  })

  it('does not queue social messages across an explicit disconnect', async () => {
    const client = loadClient()
    client.connect('room-a', 'player-red')
    await finishConnect()
    const firstRoom = FakeRoom.instances[0]
    expect(firstRoom.reconnection.maxEnqueuedMessages).toBe(0)

    client.disconnect()
    expect(client.send({ type: 'socialSend', requestId: 'offline', kind: 'text', payload: '不排队' })).toBe(false)

    client.connect('room-a', 'player-red')
    await finishConnect()
    const secondRoom = FakeRoom.instances[1]
    expect(secondRoom.sent.filter(message => message.type === 'socialSend')).toHaveLength(0)
    client.disconnect()
  })

  it('allows social traffic during authority sync while continuing to block actions', async () => {
    const client = loadClient()
    client.connect('room-a', 'player-red')
    await finishConnect()
    const room = FakeRoom.instances[0]
    room.sent.length = 0

    expect(client.requestAuthoritySync('version-gap')).toBe(true)
    expect(client.isAuthoritySyncing()).toBe(true)
    expect(client.send({ type: 'action', command: { type: 'move' } })).toBe(false)
    expect(client.send({ type: 'socialHello', requestId: 'hello-during-sync' })).toBe(true)
    expect(client.send({ type: 'socialSend', requestId: 'send-during-sync', kind: 'preset', payload: 'hello' })).toBe(true)
    expect(room.sent.filter(message => message.type === 'battleCommand')).toHaveLength(0)
    expect(room.sent.filter(message => message.type === 'socialHello' || message.type === 'socialSend')).toHaveLength(2)

    room.emit('battleSnapshot', { authorityVersion: 4, state: { turn: { turnNumber: 1 } } })
    expect(client.isAuthoritySyncing()).toBe(false)
    client.disconnect()
  })
})
