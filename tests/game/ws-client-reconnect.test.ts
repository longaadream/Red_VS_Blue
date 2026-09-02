import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { getServerGameProfileIdentityV1 } from '../../lib/content-pipeline/runtime/profile-game-identity'

const TEST_PLAYER_ID = 'player-red'

class FakeRoom {
  static instances: FakeRoom[] = []
  readonly roomId = 'room-a'
  readonly sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  readonly joinOptions: Record<string, unknown>
  private readonly messageHandlers = new Map<string, Array<(message: unknown) => void>>()
  private errorHandler: ((code: number, message: string) => void) | null = null
  private leaveHandler: (() => void) | null = null

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

  send(type: string, payload: Record<string, unknown>) {
    this.sent.push({ type, payload })
    if (type === 'roomRpc') {
      queueMicrotask(() => this.emit('roomRpcResult', {
        requestId: payload.requestId,
        ok: true,
        data: { hostId: 'player-blue' },
      }))
    }
  }

  emit(type: string, message: unknown) {
    for (const handler of this.messageHandlers.get(type) ?? []) handler(message)
  }

  fail(code: number, message: string) { this.errorHandler?.(code, message) }
  leaveFromServer() { this.leaveHandler?.() }
  async leave() {}
}

class FakeColyseusClient {
  static endpoints: string[] = []

  constructor(endpoint: string) { FakeColyseusClient.endpoints.push(endpoint) }

  async joinById(_roomId: string, options: Record<string, unknown>) {
    return new FakeRoom(options)
  }
}

function loadClient() {
  FakeRoom.instances = []
  FakeColyseusClient.endpoints = []
  const profileIdentity = getServerGameProfileIdentityV1()
  const browserWindow: Record<string, unknown> = {
    location: { search: '' },
    Colyseus: { Client: FakeColyseusClient },
    RvBIdentity: {
      getIdentity: () => ({ id: TEST_PLAYER_ID, displayName: 'Test Red' }),
    },
    RvBUtils: {
      getConnectionConfig: () => ({ url: 'http://127.0.0.1:38521' }),
    },
  }
  const context = createContext({
    window: browserWindow,
    localStorage: {
      getItem: (key: string) => key === 'rvb_game_profile_identity'
        ? JSON.stringify(profileIdentity)
        : null,
    },
    URLSearchParams,
    URL,
    AbortController,
    fetch,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    console,
  })
  new Script(
    readFileSync(resolve(process.cwd(), 'data/pages/js/ws-client.js'), 'utf8'),
    { filename: 'ws-client.js' },
  ).runInContext(context)
  return (browserWindow as { RvBWs: {
    connect(roomId: string, playerId: string, mode?: string): void
    disconnect(): void
    isConnected(): boolean
    isAuthoritySyncing(): boolean
    requestAuthorityReceiptSync(reason: string, clientActionId: string): boolean
    send(message: Record<string, unknown>): boolean
    on(event: string, handler: (data?: unknown) => void): void
  } }).RvBWs
}

async function finishConnect() {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  FakeRoom.instances = []
  FakeColyseusClient.endpoints = []
})

describe('Colyseus reconnect and authority resync state machine', () => {
  it('uses the Colyseus SDK for desktop while keeping Android on its explicit legacy protocol', () => {
    const desktop = readFileSync(resolve('data/pages/js/ws-client.js'), 'utf8')
    const android = readFileSync(resolve('android-client/www/js/ws-client.js'), 'utf8')

    expect(desktop).toContain('new Colyseus.Client(base)')
    expect(desktop).toContain('_client.joinById(_roomId, joinOptions(_playerId))')
    expect(desktop).not.toContain('new WebSocket(')
    expect(desktop).not.toContain('BATTLE_AUTHORITY_PROTOCOL_VERSION')
    expect(android).toContain('BATTLE_AUTHORITY_PROTOCOL_VERSION')
    expect(android).not.toContain('progressive-reserve-v1')
  })

  it('becomes connected after joining and rejoins after a server leave', async () => {
    vi.useFakeTimers()
    const client = loadClient()
    let connects = 0
    let disconnects = 0
    client.on('connect', () => { connects += 1 })
    client.on('disconnect', () => { disconnects += 1 })

    client.connect('room-a', TEST_PLAYER_ID, 'lan')
    expect(client.isConnected()).toBe(false)
    await finishConnect()
    const first = FakeRoom.instances[0]

    expect(client.isConnected()).toBe(true)
    expect(connects).toBe(1)
    expect(FakeColyseusClient.endpoints).toEqual(['http://127.0.0.1:38521'])
    expect(first.joinOptions).toMatchObject({ product: true, playerId: TEST_PLAYER_ID })

    first.leaveFromServer()
    expect(client.isConnected()).toBe(false)
    expect(disconnects).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await finishConnect()

    expect(FakeRoom.instances).toHaveLength(2)
    expect(client.isConnected()).toBe(true)
    expect(connects).toBe(2)
  })

  it('ignores a stale Room leave after a replacement join', async () => {
    const client = loadClient()
    let disconnects = 0
    client.on('disconnect', () => { disconnects += 1 })

    client.connect('room-a', TEST_PLAYER_ID)
    await finishConnect()
    const stale = FakeRoom.instances[0]
    client.connect('room-a', TEST_PLAYER_ID)
    await finishConnect()

    stale.leaveFromServer()
    expect(client.isConnected()).toBe(true)
    expect(disconnects).toBe(0)
    expect(FakeRoom.instances).toHaveLength(2)
  })

  it('surfaces Colyseus Room errors without silently applying an action', async () => {
    const client = loadClient()
    const errors: Array<{ code?: number; message?: string }> = []
    client.on('error', error => errors.push(error as { code?: number; message?: string }))

    client.connect('room-a', TEST_PLAYER_ID)
    await finishConnect()
    const room = FakeRoom.instances[0]
    room.fail(4400, 'profile mismatch')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 4400, message: 'profile mismatch' })
    expect(room.sent.filter(message => message.type === 'battleCommand')).toHaveLength(0)
  })

  it('requests one authoritative snapshot and gates actions until it arrives', async () => {
    const client = loadClient()
    let starts = 0
    let completes = 0
    client.on('authoritySyncStart', () => { starts += 1 })
    client.on('authoritySyncComplete', () => { completes += 1 })

    client.connect('room-a', TEST_PLAYER_ID)
    await finishConnect()
    const room = FakeRoom.instances[0]
    room.sent.length = 0

    expect(client.requestAuthorityReceiptSync('version-gap', 'action-1')).toBe(true)
    expect(client.requestAuthorityReceiptSync('duplicate', 'action-2')).toBe(false)
    expect(client.isAuthoritySyncing()).toBe(true)
    expect(starts).toBe(1)
    expect(room.sent.filter(message => message.type === 'battleResync')).toHaveLength(1)
    expect(client.send({ type: 'action', command: { type: 'move' } })).toBe(false)

    room.emit('battleSnapshot', { authorityVersion: 4, state: { turn: { turnNumber: 1 } } })
    expect(client.isAuthoritySyncing()).toBe(false)
    expect(completes).toBe(1)
    expect(client.send({ type: 'action', command: { type: 'move' } })).toBe(true)
    expect(room.sent.filter(message => message.type === 'battleCommand')).toHaveLength(1)
  })

  it('correlates a resync request with the original timed-out action', async () => {
    const client = loadClient()
    const starts: Array<{ clientActionId?: string }> = []
    client.on('authoritySyncStart', message => starts.push(message as { clientActionId?: string }))

    client.connect('room-a', TEST_PLAYER_ID)
    await finishConnect()
    expect(client.requestAuthorityReceiptSync('action-timeout', 'action-original-1')).toBe(true)

    expect(starts).toEqual([expect.objectContaining({
      reason: 'action-timeout',
      clientActionId: 'action-original-1',
    })])
  })

  it('releases the authority sync gate on timeout and disconnect', async () => {
    vi.useFakeTimers()
    const client = loadClient()
    let timeouts = 0
    client.on('authoritySyncTimeout', () => { timeouts += 1 })

    client.connect('room-a', TEST_PLAYER_ID)
    await finishConnect()
    const room = FakeRoom.instances[0]
    expect(client.requestAuthorityReceiptSync('action-timeout', 'action-1')).toBe(true)

    await vi.advanceTimersByTimeAsync(8_000)
    expect(client.isAuthoritySyncing()).toBe(false)
    expect(timeouts).toBe(1)

    expect(client.requestAuthorityReceiptSync('version-gap', 'action-2')).toBe(true)
    room.leaveFromServer()
    expect(client.isAuthoritySyncing()).toBe(false)
  })
})
