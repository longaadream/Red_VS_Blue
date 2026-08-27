import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Room, WsData } from '../relay-server/src/types'

type JsonObject = Record<string, unknown>
type TestIdentity = { id: string; publicKey: string; privateKey: CryptoKey }

const relayStore = vi.hoisted(() => ({
  getRoom: vi.fn(),
  setRoom: vi.fn(),
  addWsClient: vi.fn(),
  removeWsClient: vi.fn(),
  getWsClients: vi.fn(),
  broadcastToRoom: vi.fn(),
  appendAction: vi.fn(),
  sendToHost: vi.fn(),
  startHostTimeout: vi.fn(),
  cancelHostTimeout: vi.fn(),
}))

vi.mock('../relay-server/src/store', () => ({ store: relayStore }))

type RelaySocket = { readyState: number; url?: string; data: WsData; send(raw: string): unknown }
type RelayHandler = {
  message(ws: RelaySocket, raw: string | Buffer): void | Promise<void>
  close(ws: RelaySocket): void
}
let wsHandler: RelayHandler

beforeAll(async () => {
  const handlerPath = '../relay-server/src/ws/' + 'handler'
  wsHandler = (await import(handlerPath) as { wsHandler: RelayHandler }).wsHandler
})

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function createTestIdentity(): Promise<TestIdentity> {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair
  const publicBytes = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey))
  const publicKey = bytesToHex(publicBytes)
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', publicBytes))
  return { id: bytesToHex(digest).slice(0, 8), publicKey, privateKey: pair.privateKey }
}

async function signedSubscribe(
  identity: TestIdentity,
  roomId: string,
  claimedPlayerId = identity.id,
) {
  const payload = {
    type: 'battle-subscribe' as const,
    roomId,
    playerId: claimedPlayerId,
    timestamp: Date.now(),
  }
  const signature = await globalThis.crypto.subtle.sign(
    'Ed25519',
    identity.privateKey,
    new TextEncoder().encode(JSON.stringify(payload)),
  )
  return {
    type: 'subscribe' as const,
    roomId,
    playerId: claimedPlayerId,
    publicKey: identity.publicKey,
    payload,
    signature: bytesToHex(new Uint8Array(signature)),
  }
}

function roomFor(host: TestIdentity): Room {
  return {
    id: 'relay-auth-room',
    hostId: host.id,
    name: 'Relay auth room',
    status: 'battle',
    players: [{
      id: host.id,
      name: 'Host',
      publicKey: host.publicKey,
      connected: true,
    }],
    actionLog: [],
    createdAt: Date.now(),
  }
}

function fakeWebSocket(roomId: string) {
  const sent: JsonObject[] = []
  const ws = {
    readyState: 1,
    url: `ws://relay.test/ws/rooms/${roomId}`,
    data: {} as WsData,
    send: vi.fn((raw: string) => sent.push(JSON.parse(raw) as JsonObject)),
  } satisfies RelaySocket
  return { ws, sent }
}

function roomForPair(host: TestIdentity, guest: TestIdentity): Room {
  const room = roomFor(host)
  room.players.push({ id: guest.id, name: 'Guest', publicKey: guest.publicKey, connected: true })
  return room
}

describe('Relay WebSocket signed subscription identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects a forged host identity before assigning a role or accepting state', async () => {
    const host = await createTestIdentity()
    const attacker = await createTestIdentity()
    const room = roomFor(host)
    relayStore.getRoom.mockReturnValue(room)
    const { ws, sent } = fakeWebSocket(room.id)

    await wsHandler.message(ws, JSON.stringify(await signedSubscribe(attacker, room.id, host.id)))

    expect(sent[0]).toMatchObject({ type: 'error', code: 'SUBSCRIBE_AUTH_INVALID' })
    expect(ws.data).toEqual({})
    expect(relayStore.addWsClient).not.toHaveBeenCalled()

    await wsHandler.message(ws, JSON.stringify({
      type: 'stateUpdate',
      seq: 1,
      authorityVersion: 99,
      state: { forged: true },
      stateHash: 'forged',
    }))

    expect(sent.at(-1)).toMatchObject({ type: 'error', message: 'not subscribed' })
    expect(room.lastStateBlob).toBeUndefined()
    expect(relayStore.setRoom).not.toHaveBeenCalled()
    expect(relayStore.broadcastToRoom).not.toHaveBeenCalled()
  })

  it('binds a valid host signature and then accepts that host state update', async () => {
    const host = await createTestIdentity()
    const room = roomFor(host)
    relayStore.getRoom.mockReturnValue(room)
    const { ws, sent } = fakeWebSocket(room.id)

    await wsHandler.message(ws, JSON.stringify(await signedSubscribe(host, room.id)))

    expect(sent[0]).toEqual({ type: 'subscribed', role: 'host' })
    expect(ws.data).toEqual({ roomId: room.id, playerId: host.id, role: 'host' })
    expect(relayStore.addWsClient).toHaveBeenCalledWith(room.id, ws)

    await wsHandler.message(ws, JSON.stringify({
      type: 'stateUpdate',
      seq: 1,
      authorityVersion: 2,
      state: { deployment: { status: 'awaiting-locks' } },
      seed: 42,
      stateHash: 'public-state',
    }))

    expect(JSON.parse(room.lastStateBlob ?? '{}')).toMatchObject({
      type: 'stateUpdate',
      authorityVersion: 2,
      seed: 42,
      stateHash: 'public-state',
    })
    expect(relayStore.setRoom).toHaveBeenCalledWith(room)
    expect(relayStore.broadcastToRoom).toHaveBeenCalledWith(
      room.id,
      expect.objectContaining({ type: 'stateUpdate', authorityVersion: 2 }),
      ws,
    )
  })

  it('forwards host authority preparation only to the addressed guest', async () => {
    const host = await createTestIdentity()
    const guest = await createTestIdentity()
    const outsider = await createTestIdentity()
    const room = roomForPair(host, guest)
    relayStore.getRoom.mockReturnValue(room)
    const hostSocket = fakeWebSocket(room.id)
    const guestSocket = fakeWebSocket(room.id)

    await wsHandler.message(hostSocket.ws, JSON.stringify(await signedSubscribe(host, room.id)))
    await wsHandler.message(guestSocket.ws, JSON.stringify(await signedSubscribe(guest, room.id)))
    relayStore.getWsClients.mockReturnValue(new Set([hostSocket.ws, guestSocket.ws]))

    const action = {
      type: 'useBasicSkill',
      playerId: guest.id,
      pieceId: 'caster',
      skillId: 'contract-shot',
    }
    const preparation = {
      kind: 'needTarget',
      selectionId: 'sel-1',
      stateRevision: 3,
      targetType: 'piece',
      candidates: [{ type: 'piece', pieceId: 'enemy' }],
    }
    await wsHandler.message(hostSocket.ws, JSON.stringify({
      type: 'actionError',
      to: guest.id,
      from: outsider.id,
      action,
      error: '需要选择目标',
      code: 'TARGET_REQUIRED',
      preparation,
      needsTargetSelection: true,
      targetType: 'piece',
      range: 2,
      filter: 'enemy',
      targetIndex: 0,
    }))

    expect(guestSocket.sent.at(-1)).toEqual({
      type: 'actionError',
      from: host.id,
      action,
      error: '需要选择目标',
      code: 'TARGET_REQUIRED',
      preparation,
      needsTargetSelection: true,
      targetType: 'piece',
      range: 2,
      filter: 'enemy',
      targetIndex: 0,
    })
    expect(hostSocket.sent).toHaveLength(1)
    const optionAction = {
      type: 'playCard',
      playerId: guest.id,
      cardInstanceId: 'choice-card',
    }
    const optionPreparation = {
      kind: 'needOption',
      selectionId: 'sel-2',
      stateRevision: 3,
      options: ['left', 'right'],
    }
    await wsHandler.message(hostSocket.ws, JSON.stringify({
      type: 'actionError',
      to: guest.id,
      action: optionAction,
      error: '需要选择选项',
      preparation: optionPreparation,
      needsOptionSelection: true,
      title: '选择方向',
      options: ['left', 'right'],
    }))
    expect(guestSocket.sent.at(-1)).toEqual({
      type: 'actionError',
      from: host.id,
      action: optionAction,
      error: '需要选择选项',
      preparation: optionPreparation,
      needsOptionSelection: true,
      title: '选择方向',
      options: ['left', 'right'],
    })

    await wsHandler.message(guestSocket.ws, JSON.stringify({
      type: 'actionError',
      to: host.id,
      action,
      error: 'forged',
      needsOptionSelection: true,
      title: 'forged',
      options: ['forged'],
    }))
    expect(guestSocket.sent.at(-1)).toMatchObject({
      type: 'error',
      code: 'ACTION_ERROR_FORBIDDEN',
    })
    expect(hostSocket.sent).toHaveLength(1)

    const guestMessageCount = guestSocket.sent.length
    await wsHandler.message(hostSocket.ws, JSON.stringify({
      type: 'actionError',
      to: outsider.id,
      action,
      error: 'unknown target',
    }))
    expect(hostSocket.sent.at(-1)).toMatchObject({ type: 'error', code: 'ACTION_ERROR_TARGET_INVALID' })
    expect(guestSocket.sent).toHaveLength(guestMessageCount)
  })
  it('forwards RED-109 transitions transiently and routes receipts without replacing the reconnect snapshot', async () => {
    const host = await createTestIdentity()
    const guest = await createTestIdentity()
    const room = roomForPair(host, guest)
    room.lastStateBlob = JSON.stringify({
      type: 'stateUpdate',
      authorityVersion: 7,
      state: { checkpoint: true },
      stateHash: 'checkpoint-hash',
    })
    relayStore.getRoom.mockReturnValue(room)
    const hostSocket = fakeWebSocket(room.id)
    const guestSocket = fakeWebSocket(room.id)

    await wsHandler.message(hostSocket.ws, JSON.stringify(await signedSubscribe(host, room.id)))
    await wsHandler.message(guestSocket.ws, JSON.stringify(await signedSubscribe(guest, room.id)))
    relayStore.getWsClients.mockReturnValue(new Set([hostSocket.ws, guestSocket.ws]))
    relayStore.broadcastToRoom.mockClear()
    relayStore.setRoom.mockClear()

    const transition = {
      type: 'battleTransition',
      protocolVersion: 2,
      roomId: room.id,
      fromVersion: 7,
      toVersion: 8,
      prePublicHash: 'before',
      postPublicHash: 'after',
      patch: [{ op: 'set', path: ['turn', 'turnNumber'], value: 2 }],
      receipt: { clientActionId: 'guest-action-1', status: 'applied', authorityVersion: 8 },
      seed: 42,
      stateHash: 'after',
      serverNow: 2_000,
    }
    await wsHandler.message(hostSocket.ws, JSON.stringify(transition))

    expect(relayStore.broadcastToRoom).toHaveBeenCalledWith(room.id, transition, hostSocket.ws)
    expect(relayStore.setRoom).not.toHaveBeenCalled()
    expect(JSON.parse(room.lastStateBlob)).toMatchObject({ authorityVersion: 7, stateHash: 'checkpoint-hash' })

    await wsHandler.message(hostSocket.ws, JSON.stringify({
      type: 'battleReceipt',
      to: guest.id,
      receipt: { clientActionId: 'guest-action-2', status: 'rejected', authorityVersion: 8 },
    }))
    expect(guestSocket.sent.at(-1)).toEqual({
      type: 'battleReceipt',
      receipt: { clientActionId: 'guest-action-2', status: 'rejected', authorityVersion: 8 },
    })

    await wsHandler.message(guestSocket.ws, JSON.stringify(transition))
    expect(guestSocket.sent.at(-1)).toMatchObject({
      type: 'error',
      code: 'BATTLE_TRANSITION_FORBIDDEN',
    })
  })

  it.each(['waiting', 'selecting'] as const)(
    'does not mutate a %s room when its host changes prebattle pages',
    async status => {
      const host = await createTestIdentity()
      const room = roomFor(host)
      room.status = status
      room.mapId = 'winding-pass'
      const original = structuredClone(room)
      relayStore.getRoom.mockReturnValue(room)
      const { ws } = fakeWebSocket(room.id)
      ws.data = { roomId: room.id, playerId: host.id, role: 'host' }

      wsHandler.close(ws)

      expect(relayStore.removeWsClient).toHaveBeenCalledWith(room.id, ws)
      expect(room).toEqual(original)
      expect(relayStore.setRoom).not.toHaveBeenCalled()
      expect(relayStore.startHostTimeout).not.toHaveBeenCalled()
      expect(relayStore.broadcastToRoom).not.toHaveBeenCalled()
    },
  )

  it('does not enter host recovery when a battle has no recoverable snapshot', async () => {
    const host = await createTestIdentity()
    const room = roomFor(host)
    const original = structuredClone(room)
    relayStore.getRoom.mockReturnValue(room)
    const { ws } = fakeWebSocket(room.id)
    ws.data = { roomId: room.id, playerId: host.id, role: 'host' }

    wsHandler.close(ws)

    expect(room).toEqual(original)
    expect(relayStore.setRoom).not.toHaveBeenCalled()
    expect(relayStore.startHostTimeout).not.toHaveBeenCalled()
    expect(relayStore.broadcastToRoom).not.toHaveBeenCalled()
  })

  it('enters host recovery only for a battle with a recoverable snapshot', async () => {
    const host = await createTestIdentity()
    const room = roomFor(host)
    room.lastStateBlob = JSON.stringify({
      type: 'stateUpdate',
      state: { recoverable: true },
      authorityVersion: 3,
    })
    relayStore.getRoom.mockReturnValue(room)
    const { ws } = fakeWebSocket(room.id)
    ws.data = { roomId: room.id, playerId: host.id, role: 'host' }

    wsHandler.close(ws)

    expect(room.status).toBe('waiting_host')
    expect(room.hostDisconnectedAt).toEqual(expect.any(Number))
    expect(relayStore.setRoom).toHaveBeenCalledWith(room)
    expect(relayStore.startHostTimeout).toHaveBeenCalledWith(room.id, expect.any(Function))
    expect(relayStore.broadcastToRoom).toHaveBeenCalledWith(
      room.id,
      expect.objectContaining({
        type: 'roomUpdate',
        room: expect.objectContaining({ status: 'waiting_host' }),
      }),
    )
  })

  it('does not resume a waiting_host room that has no recoverable snapshot', async () => {
    const host = await createTestIdentity()
    const room = roomFor(host)
    room.status = 'waiting_host'
    room.lastStateBlob = undefined
    relayStore.getRoom.mockReturnValue(room)
    const { ws, sent } = fakeWebSocket(room.id)

    await wsHandler.message(ws, JSON.stringify(await signedSubscribe(host, room.id)))

    expect(sent[0]).toEqual({ type: 'subscribed', role: 'host' })
    expect(room.status).toBe('waiting_host')
    expect(relayStore.cancelHostTimeout).not.toHaveBeenCalled()
    expect(relayStore.setRoom).not.toHaveBeenCalled()
    expect(relayStore.broadcastToRoom).not.toHaveBeenCalled()
  })
})
