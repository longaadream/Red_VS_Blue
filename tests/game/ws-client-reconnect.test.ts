import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { getServerGameProfileIdentityV1 } from '../../lib/content-pipeline/runtime/profile-game-identity'

type BrowserHandler = ((event?: any) => void) | null

const TEST_PLAYER_ID = 'player-red'
const TEST_PUBLIC_KEY = 'test-public-key-player-red'
const TEST_SUBSCRIBE_TIMESTAMP = 1_750_000_000_000

function deterministicSignature(payload: unknown): string {
  return `test-signature:${JSON.stringify(payload)}`
}

function normalizeSource(source: string): string {
  return source.replace(/\r\n/g, '\n')
}

function readSection(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  if (start < 0 || end < 0) {
    throw new Error(`Missing client contract section: ${startMarker} -> ${endMarker}`)
  }
  return source.slice(start, end)
}

function readConstant(source: string, name: string): string {
  const match = source.match(new RegExp(`var ${name} = ([^\\n]+)`))
  if (!match) throw new Error(`Missing client contract constant: ${name}`)
  return match[1].trim()
}

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
  const profileIdentity = getServerGameProfileIdentityV1()
  const browserWindow: Record<string, any> = {
    location: { search: '' },
    RvBIdentity: {
      getIdentity: () => ({ id: TEST_PLAYER_ID, displayName: 'Test Red' }),
      getPublicKey: () => TEST_PUBLIC_KEY,
      sign: async (payload: unknown) => {
        await Promise.resolve()
        return deterministicSignature(payload)
      },
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
    WebSocket: FakeWebSocket,
    Date: { now: () => TEST_SUBSCRIBE_TIMESTAMP },
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
    isAuthoritySyncing(): boolean
    send(message: Record<string, unknown>): boolean
    on(event: string, handler: (data?: any) => void): void
  }
}

async function openWithSignedSubscribe(socket: FakeWebSocket) {
  socket.open()
  expect(socket.sent).toEqual([])
  for (let turn = 0; turn < 6 && socket.sent.length === 0; turn += 1) {
    await Promise.resolve()
  }

  expect(socket.sent).toHaveLength(1)
  const message = JSON.parse(socket.sent[0])
  const payload = {
    type: 'battle-subscribe',
    roomId: 'room-a',
    playerId: TEST_PLAYER_ID,
    protocolVersion: 3,
    authorityBuildId: 'rvb-authority-v3-chunked-sha256-1',
    timestamp: TEST_SUBSCRIBE_TIMESTAMP,
  }
  expect(message).toEqual({
    type: 'subscribe',
    roomId: 'room-a',
    playerId: TEST_PLAYER_ID,
    protocolVersion: 3,
    authorityBuildId: 'rvb-authority-v3-chunked-sha256-1',
    profileIdentity: getServerGameProfileIdentityV1(),
    publicKey: TEST_PUBLIC_KEY,
    payload,
    signature: deterministicSignature(payload),
  })
  return message
}

afterEach(() => {
  vi.useRealTimers()
  FakeWebSocket.instances = []
})

describe('battle WebSocket reconnect state machine', () => {
  it('shares protocol and reconnect contracts while keeping desktop signed and Android LAN legacy', () => {
    const desktopClient = normalizeSource(
      readFileSync(resolve(process.cwd(), 'data/pages/js/ws-client.js'), 'utf8'),
    )
    const androidClient = normalizeSource(
      readFileSync(resolve(process.cwd(), 'android-client/www/js/ws-client.js'), 'utf8'),
    )
    const androidAuthority = normalizeSource(
      readFileSync(resolve(process.cwd(), 'mobile-server/mobile-server-entry.ts'), 'utf8'),
    )

    for (const name of ['BATTLE_AUTHORITY_PROTOCOL_VERSION', 'BATTLE_AUTHORITY_BUILD_ID']) {
      expect(readConstant(androidClient, name)).toBe(readConstant(desktopClient, name))
    }
    expect(readConstant(desktopClient, 'BATTLE_AUTHORITY_PROTOCOL_VERSION')).toBe('3')
    expect(readConstant(desktopClient, 'BATTLE_AUTHORITY_BUILD_ID'))
      .toBe("'rvb-authority-v3-chunked-sha256-1'")

    for (const [start, end] of [
      ['function _scheduleReconnect(roomId)', 'function _emit(event, data)'],
      ['function requestAuthoritySync(reason)', 'function makeRpcError(message)'],
      ['function connect(roomId, playerId, mode)', 'function disconnect()'],
    ]) {
      expect(readSection(androidClient, start, end))
        .toBe(readSection(desktopClient, start, end))
    }

    const desktopSubscribe = readSection(
      desktopClient,
      'async function buildSubscribeMessage()',
      'function _doConnect(roomId)',
    )
    expect(desktopSubscribe).toContain("if (roomId === '__lobby') return message")
    expect(desktopSubscribe).toContain('signature: await window.RvBIdentity.sign(payload)')
    expect(desktopSubscribe).not.toContain("if (_mode !== 'relay') return message")

    const androidSubscribe = readSection(
      androidClient,
      'async function buildSubscribeMessage()',
      'function _doConnect(roomId)',
    )
    expect(androidSubscribe).toContain("if (_mode !== 'relay') return message")
    expect(androidSubscribe).toContain('Signed identity is required for Relay WebSocket subscriptions')
    expect(androidClient).toContain("msg.type === 'battleProtocolUnsupported'")
    expect(androidClient).toContain("'BATTLE_PROTOCOL_UNSUPPORTED'")
    expect(androidAuthority.match(/deploymentMode:\s*'legacy-reroll-v1'/g)).toHaveLength(2)
    expect(androidAuthority).not.toContain("deploymentMode: 'progressive-reserve-v1'")
    expect(androidClient).not.toContain('progressive-reserve-v1')
  })

  it('becomes connected only after subscription and resubscribes after a disconnect', async () => {
    vi.useFakeTimers()
    const client = loadClient()
    let connects = 0
    let disconnects = 0
    client.on('connect', () => { connects += 1 })
    client.on('disconnect', () => { disconnects += 1 })

    client.connect('room-a', 'player-red', 'lan')
    const first = FakeWebSocket.instances[0]
    await openWithSignedSubscribe(first)

    expect(client.isConnected()).toBe(false)
    expect(connects).toBe(0)

    first.receive({ type: 'subscribed', roomId: 'room-a', role: 'guest' })
    expect(client.isConnected()).toBe(true)
    expect(connects).toBe(1)

    first.closeFromPeer()
    expect(client.isConnected()).toBe(false)
    expect(disconnects).toBe(1)
    await vi.advanceTimersByTimeAsync(3_000)

    const second = FakeWebSocket.instances[1]
    await openWithSignedSubscribe(second)
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
    await openWithSignedSubscribe(stale)
    stale.receive({ type: 'subscribed', roomId: 'room-a', role: 'guest' })
    stale.beginClosing()

    client.connect('room-a', 'player-red', 'lan')
    const replacement = FakeWebSocket.instances[1]
    await openWithSignedSubscribe(replacement)
    replacement.receive({ type: 'subscribed', roomId: 'room-a', role: 'guest' })
    expect(client.isConnected()).toBe(true)

    stale.closeFromPeer()
    expect(client.isConnected()).toBe(true)
    expect(disconnects).toBe(0)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('stops reconnecting when the server rejects the authority protocol build', async () => {
    vi.useFakeTimers()
    const client = loadClient()
    const errors: Array<{ code?: string }> = []
    client.on('error', error => { errors.push(error) })

    client.connect('room-a', 'player-red', 'lan')
    const socket = FakeWebSocket.instances[0]
    await openWithSignedSubscribe(socket)
    socket.receive({
      type: 'battleProtocolUnsupported',
      code: 'BATTLE_PROTOCOL_UNSUPPORTED',
      expectedProtocolVersion: 3,
      expectedAuthorityBuildId: 'rvb-authority-v3-chunked-sha256-1',
    })

    expect(errors).toHaveLength(1)
    expect(errors[0].code).toBe('BATTLE_PROTOCOL_UNSUPPORTED')
    expect(client.isConnected()).toBe(false)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('requests one authoritative snapshot on a room version conflict and gates actions until it arrives', async () => {
    vi.useFakeTimers()
    const client = loadClient()
    let syncStarts = 0
    let syncCompletes = 0
    client.on('authoritySyncStart', () => { syncStarts += 1 })
    client.on('authoritySyncComplete', () => { syncCompletes += 1 })

    client.connect('room-a', 'player-red', 'lan')
    const socket = FakeWebSocket.instances[0]
    await openWithSignedSubscribe(socket)
    socket.receive({ type: 'subscribed', roomId: 'room-a', role: 'guest' })

    socket.receive({
      type: 'actionError',
      code: 'ROOM_VERSION_CONFLICT',
      error: 'room changed concurrently',
    })
    socket.receive({
      type: 'actionError',
      code: 'ROOM_VERSION_CONFLICT',
      error: 'same conflict delivered twice',
    })

    expect(client.isAuthoritySyncing()).toBe(true)
    expect(syncStarts).toBe(1)
    const snapshotRequests = socket.sent.map(payload => JSON.parse(payload)).filter(message => message.type === 'requestBattleSnapshot')
    expect(snapshotRequests).toHaveLength(1)
    expect(snapshotRequests[0].requestId).toMatch(/^authority-sync-/)
    expect(client.send({ type: 'action', command: { type: 'move' } })).toBe(false)
    expect(socket.sent.map(payload => JSON.parse(payload)).filter(message => message.type === 'action')).toHaveLength(0)

    socket.receive({ type: 'stateUpdate', authorityVersion: 3, state: { turn: { turnNumber: 1 } } })
    expect(client.isAuthoritySyncing()).toBe(true)
    expect(syncCompletes).toBe(0)

    socket.receive({
      type: 'stateUpdate',
      requestId: snapshotRequests[0].requestId,
      authorityVersion: 4,
      state: { turn: { turnNumber: 1 } },
    })

    expect(client.isAuthoritySyncing()).toBe(false)
    expect(syncCompletes).toBe(1)
    expect(client.send({ type: 'action', command: { type: 'move' } })).toBe(true)
    expect(socket.sent.map(payload => JSON.parse(payload)).filter(message => message.type === 'action')).toHaveLength(1)
  })

  it('releases the authority sync gate on timeout or disconnect without treating persistence degradation as a conflict', async () => {
    vi.useFakeTimers()
    const client = loadClient()
    let syncTimeouts = 0
    client.on('authoritySyncTimeout', () => { syncTimeouts += 1 })

    client.connect('room-a', 'player-red', 'lan')
    const first = FakeWebSocket.instances[0]
    await openWithSignedSubscribe(first)
    first.receive({ type: 'subscribed', roomId: 'room-a', role: 'guest' })
    first.receive({ type: 'actionError', code: 'ROOM_VERSION_CONFLICT' })

    await vi.advanceTimersByTimeAsync(8_000)
    expect(client.isAuthoritySyncing()).toBe(false)
    expect(syncTimeouts).toBe(1)

    first.receive({ type: 'actionError', code: 'ROOM_VERSION_CONFLICT' })
    expect(client.isAuthoritySyncing()).toBe(true)
    first.closeFromPeer()
    expect(client.isAuthoritySyncing()).toBe(false)

    await vi.advanceTimersByTimeAsync(3_000)
    const replacement = FakeWebSocket.instances[1]
    await openWithSignedSubscribe(replacement)
    replacement.receive({ type: 'subscribed', roomId: 'room-a', role: 'guest' })
    replacement.receive({ type: 'actionError', code: 'BATTLE_AUTHORITY_PERSISTENCE_DEGRADED' })

    expect(client.isAuthoritySyncing()).toBe(false)
    expect(replacement.sent.map(payload => JSON.parse(payload)).filter(message => message.type === 'requestBattleSnapshot')).toHaveLength(0)
  })
})
