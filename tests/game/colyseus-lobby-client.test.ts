import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getServerGameProfileIdentityV1 } from '../../lib/content-pipeline/runtime/profile-game-identity'

type RpcClient = {
  requestAt(baseUrl: string, method: string, data?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

class FakeLobbyRoom {
  readonly roomId: string
  private readonly handlers = new Map<string, (message: Record<string, unknown>) => void>()

  constructor(roomId: string) {
    this.roomId = roomId
  }

  onMessage(type: string, handler: (message: Record<string, unknown>) => void) {
    this.handlers.set(type, handler)
    return () => this.handlers.delete(type)
  }

  send(type: string, payload: Record<string, unknown>) {
    if (type !== 'roomRpc') return
    queueMicrotask(() => this.handlers.get('roomRpcResult')?.({
      requestId: payload.requestId,
      ok: true,
      data: { id: this.roomId, status: 'waiting', players: [] },
    }))
  }

  async request(type: string) {
    if (type !== 'roomRpc') throw new Error(`unsupported request: ${type}`)
    return { id: this.roomId, status: 'waiting', players: [] }
  }

  async leave() {}
}

class FakeColyseusClient {
  static createCalls: Array<Record<string, unknown>> = []
  static joinCalls: Array<{ roomId: string; options: Record<string, unknown> }> = []

  async create(_roomType: string, options: Record<string, unknown>) {
    FakeColyseusClient.createCalls.push(options)
    await Promise.resolve()
    return new FakeLobbyRoom(`created-${FakeColyseusClient.createCalls.length}`)
  }

  async joinById(roomId: string, options: Record<string, unknown>) {
    FakeColyseusClient.joinCalls.push({ roomId, options })
    return new FakeLobbyRoom(roomId)
  }
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function loadLobbyClient(fetchMock: ReturnType<typeof vi.fn>): RpcClient {
  const profileIdentity = getServerGameProfileIdentityV1()
  const browserWindow: Record<string, unknown> = {
    location: { search: '' },
    Colyseus: { Client: FakeColyseusClient },
    RvBIdentity: {
      getIdentity: () => ({ id: 'player-blue', displayName: 'Blue Player', accountId: 'account-blue' }),
    },
    RvBUtils: {
      getConnectionConfig: () => ({ url: 'http://127.0.0.1:38621' }),
      getServerUrl: () => 'http://127.0.0.1:38621',
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
    fetch: fetchMock,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    console,
  })
  new Script(
    readFileSync(resolve(process.cwd(), 'data/pages/js/colyseus-client.js'), 'utf8'),
    { filename: 'colyseus-client.js' },
  ).runInContext(context)
  return (browserWindow as { RvBColyseus: RpcClient }).RvBColyseus
}

beforeEach(() => {
  FakeColyseusClient.createCalls = []
  FakeColyseusClient.joinCalls = []
})

describe('RED-158 Colyseus lobby client', () => {
  it('loads one room detail without joining or falling through to an unsupported RPC', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      room: { id: 'Room-A', status: 'in-progress', players: [{ id: 'player-blue' }] },
    }))
    const client = loadLobbyClient(fetchMock)

    await expect(client.requestAt(
      'http://127.0.0.1:38621',
      'rooms.get',
      { roomId: 'Room-A' },
      5000,
    )).resolves.toMatchObject({ id: 'Room-A', status: 'in-progress' })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:38621/rooms/Room-A',
      expect.objectContaining({ cache: 'no-store' }),
    )
    expect(FakeColyseusClient.joinCalls).toHaveLength(0)
  })

  it('performs real Colyseus admission instead of treating a room-list probe as join success', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      rooms: [{ id: 'room-a', status: 'waiting', players: [{ id: 'player-red' }] }],
    }))
    const client = loadLobbyClient(fetchMock)
    const profileIdentity = getServerGameProfileIdentityV1()

    await expect(client.requestAt('http://127.0.0.1:38621', 'rooms.action', {
      action: 'join',
      roomId: 'room-a',
      playerId: 'player-blue',
      playerName: 'Blue Player',
      alignment: 'light',
      profileIdentity,
    }, 5000)).resolves.toMatchObject({ success: true, room: { id: 'room-a' } })

    expect(FakeColyseusClient.joinCalls).toEqual([{
      roomId: 'room-a',
      options: expect.objectContaining({
        product: true,
        playerId: 'player-blue',
        playerName: 'Blue Player',
        accountId: 'account-blue',
        alignment: 'light',
        profileIdentity,
      }),
    }])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('single-flights concurrent create requests from one host', async () => {
    const client = loadLobbyClient(vi.fn())
    const input = {
      hostId: 'player-blue',
      hostName: 'Blue Player',
      name: 'Blue Player room',
      mapId: 'winding-pass',
      visibility: 'public',
      profileIdentity: getServerGameProfileIdentityV1(),
    }

    const [first, second] = await Promise.all([
      client.requestAt('http://127.0.0.1:38621', 'rooms.create', input, 5000),
      client.requestAt('http://127.0.0.1:38621', 'rooms.create', input, 5000),
    ])

    expect(FakeColyseusClient.createCalls).toHaveLength(1)
    expect(first).toEqual(second)
    expect(first).toMatchObject({ id: 'created-1' })
    expect(FakeColyseusClient.createCalls[0]).toMatchObject({
      product: true,
      creationKey: expect.stringMatching(/^player-blue:/),
    })
  })
})
