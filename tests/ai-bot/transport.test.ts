import { createServer } from 'node:http'

import { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'

import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import {
  BATTLE_COMMAND_MESSAGE,
  BATTLE_RECEIPT_MESSAGE,
  BATTLE_RECEIPT_REQUEST_MESSAGE,
  BATTLE_RESYNC_MESSAGE,
  BATTLE_SNAPSHOT_MESSAGE,
} from '@/lib/server/colyseus/battle-room-protocol'
import {
  CloudBotTransport,
  type CloudBotClientLike,
  type CloudBotConfig,
  type CloudBotRoomLike,
  type CloudBotSignal,
} from '@/lib/ai-bot/transport'
import type { BattleState } from '@/lib/game/turn'

const profileIdentity = getServerGameProfileIdentityV1()
const pieces = ['piece-a', 'piece-b', 'piece-c', 'piece-d', 'piece-e', 'piece-f', 'piece-g', 'piece-h']

function battleState(overrides: Partial<BattleState> = {}): BattleState {
  return {
    map: {
      id: 'test-map', name: 'Test map', width: 3, height: 1,
      tiles: [0, 1, 2].map(x => ({ id: `tile-${x}`, x, y: 0, props: { walkable: true, bulletPassable: true, type: 'floor' as const } })),
    },
    pieces: [
      { instanceId: 'red-1', templateId: 'piece-a', name: 'Red', ownerPlayerId: 'red', faction: 'red' as const, currentHp: 10, maxHp: 10, attack: 2, defense: 1, moveRange: 2, x: 0, y: 0, isCore: true, skills: [], buffs: [], debuffs: [], ruleTags: [], statusTags: [], rules: [] },
      { instanceId: 'blue-1', templateId: 'piece-b', name: 'Blue', ownerPlayerId: 'blue', faction: 'blue' as const, currentHp: 10, maxHp: 10, attack: 2, defense: 1, moveRange: 2, x: 2, y: 0, isCore: true, skills: [], buffs: [], debuffs: [], ruleTags: [], statusTags: [], rules: [] },
    ],
    graveyard: [], pieceStatsByTemplateId: {}, skillsById: {},
    players: [
      { playerId: 'red', chargePoints: 0, actionPoints: 3, maxActionPoints: 3, hand: [], discardPile: [], rules: [], statusTags: [] },
      { playerId: 'blue', chargePoints: 0, actionPoints: 3, maxActionPoints: 3, hand: [], discardPile: [], rules: [], statusTags: [] },
    ],
    turn: { currentPlayerId: 'red', turnNumber: 1, phase: 'action' as const, actions: { hasMoved: false, hasUsedBasicSkill: false, hasUsedChargeSkill: false } },
    targetingRevision: 1,
    ...overrides,
  } as unknown as BattleState
}

function signal<Args extends unknown[]>(): CloudBotSignal<Args> & { emit: (...args: Args) => void } {
  const listeners = new Set<(...args: Args) => void>()
  const fn = ((callback: (...args: Args) => void) => {
    listeners.add(callback)
    return () => listeners.delete(callback)
  }) as unknown as CloudBotSignal<Args> & { emit: (...args: Args) => void }
  fn.emit = (...args: Args) => { for (const listener of [...listeners]) listener(...args) }
  return fn
}

class FakeRoom implements CloudBotRoomLike {
  roomId = 'room-1'
  reconnection = { enabled: true, maxRetries: 2, minDelay: 1, maxDelay: 2 }
  connection: { isOpen: boolean; close?: (code?: number, reason?: string) => void } = { isOpen: true }
  onReconnect = signal<[]>()
  onDrop = signal<[number?, string?]>()
  onLeave = signal<[number?, string?]>()
  sent: Array<{ type: string; payload: unknown }> = []
  requests: Array<{ type: string; payload: unknown }> = []
  private messages = new Map<string, Set<(payload: unknown) => void>>()
  private version = 0
  private state = battleState()
  receiptLookup: (id: string) => Promise<unknown> = async id => ({ outcome: 'unknown', clientActionId: id })
  commandHandler: (payload: unknown) => void = payload => {
    const command = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    this.emit(BATTLE_RECEIPT_MESSAGE, {
      kind: 'applied', clientActionId: command.clientActionId, authorityVersion: this.version + 1,
    })
    this.emitSnapshot(this.version + 1)
  }

  onMessage(type: string, callback: (payload: unknown) => void): () => void {
    const listeners = this.messages.get(type) ?? new Set()
    listeners.add(callback)
    this.messages.set(type, listeners)
    return () => listeners.delete(callback)
  }

  send(type: string, payload?: unknown): void {
    this.sent.push({ type, payload })
    if (type === BATTLE_RESYNC_MESSAGE) this.emitSnapshot(this.version)
    if (type === BATTLE_COMMAND_MESSAGE) this.commandHandler(payload)
  }

  request(type: string, payload?: unknown): Promise<unknown> {
    this.requests.push({ type, payload })
    if (type === BATTLE_RECEIPT_REQUEST_MESSAGE) {
      const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
      return this.receiptLookup(String(body.clientActionId ?? ''))
    }
    if (type === 'roomRpc') return Promise.resolve({ status: 'in-progress', players: [] })
    return Promise.resolve(undefined)
  }

  leave(): Promise<unknown> { return Promise.resolve() }

  emit(type: string, payload: unknown): void {
    for (const listener of [...(this.messages.get(type) ?? [])]) listener(payload)
  }

  emitSnapshot(version: number, state = this.state): void {
    if (version >= this.version) this.version = version
    this.state = state
    this.emit(BATTLE_SNAPSHOT_MESSAGE, {
      type: 'stateUpdate', protocolVersion: 3,
      authorityBuildId: 'rvb-authority-v3-chunked-sha256-1', roomId: this.roomId,
      state, authorityVersion: version, seed: 123, rootSeed: 456,
      profileIdentity, extensions: { hidden: true },
      turnTimer: { status: 'running', remainingMs: 5000, hidden: 'drop' },
    })
  }
}

function config(overrides: Partial<CloudBotConfig> = {}): CloudBotConfig {
  return {
    serverUrl: 'http://127.0.0.1:2567', roomId: 'room-1', mode: 'official',
    playerId: 'red', playerName: 'Red AI', alignment: 'light', pieces,
    requestTimeoutMs: 25, decisionBudgetMs: 100, ...overrides,
  }
}

function transport(room: FakeRoom, overrides: Partial<CloudBotConfig> = {}) {
  const client: CloudBotClientLike = { joinById: vi.fn(async () => room), create: vi.fn(async () => room) }
  const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ profileIdentity }) }) as unknown as Response)
  const instance = new CloudBotTransport({ config: config(overrides), client, fetchFn, officialToken: 'session-token', trustedProfileIdentity: profileIdentity })
  return { instance, client, fetchFn }
}

describe('CloudBotTransport', () => {
  it('registers the snapshot listener before resync and strips authority-only fields', async () => {
    const room = new FakeRoom()
    const { instance } = transport(room)
    const snapshot = await instance.connect()

    expect(snapshot.authorityVersion).toBe(0)
    expect(snapshot.state).toBeDefined()
    expect(snapshot).not.toHaveProperty('seed')
    expect(snapshot).not.toHaveProperty('rootSeed')
    expect(snapshot).not.toHaveProperty('profileIdentity')
    expect(snapshot).not.toHaveProperty('extensions')
    expect(snapshot.turnTimer).toEqual({ status: 'running', remainingMs: 5000 })
    expect(room.sent[0]?.type).toBe(BATTLE_RESYNC_MESSAGE)
    await instance.leave()
  })

  it('ignores stale snapshots and accepts a single authoritative action receipt', async () => {
    const room = new FakeRoom()
    const { instance } = transport(room)
    await instance.connect()
    room.emitSnapshot(2)
    room.emitSnapshot(1)
    expect(instance.snapshot?.authorityVersion).toBe(2)

    const result = await instance.sendAction({ type: 'endTurn', playerId: 'red' })
    expect(result.outcome).toBe('applied')
    expect(result.clientActionId).toBeTruthy()
    expect(room.sent.filter(message => message.type === BATTLE_COMMAND_MESSAGE)).toHaveLength(1)
    const commandEnvelope = room.sent.find(message => message.type === BATTLE_COMMAND_MESSAGE)?.payload
    expect(commandEnvelope && typeof commandEnvelope === 'object' ? (commandEnvelope as Record<string, unknown>).command : undefined).toMatchObject({ playerId: 'red' })
    await instance.leave()
  })

  it('fails closed on an unknown receipt without retrying with a new action id', async () => {
    const room = new FakeRoom()
    room.commandHandler = () => undefined
    const { instance } = transport(room)
    await instance.connect()

    await expect(instance.sendAction({ type: 'endTurn', playerId: 'red' })).rejects.toMatchObject({ code: 'RECEIPT_UNKNOWN' })
    expect(room.sent.filter(message => message.type === BATTLE_COMMAND_MESSAGE)).toHaveLength(1)
    expect(room.requests.filter(message => message.type === BATTLE_RECEIPT_REQUEST_MESSAGE)).toHaveLength(1)
    await instance.leave()
  })

  it('resolves an in-flight command by receipt lookup after native reconnect', async () => {
    const room = new FakeRoom()
    room.commandHandler = () => undefined
    room.receiptLookup = async id => {
      room.emitSnapshot(1)
      return { outcome: 'applied', clientActionId: id, authorityVersion: 1, receipt: { clientActionId: id, status: 'applied' } }
    }
    const { instance } = transport(room)
    await instance.connect()
    const action = instance.sendAction({ type: 'endTurn', playerId: 'red' })
    await vi.waitFor(() => expect(room.sent.filter(message => message.type === BATTLE_COMMAND_MESSAGE)).toHaveLength(1))
    room.onDrop.emit(1000, 'test')
    room.onReconnect.emit()
    await expect(action).resolves.toMatchObject({ outcome: 'applied', snapshot: { authorityVersion: 1 } })
    expect(room.requests.filter(message => message.type === BATTLE_RECEIPT_REQUEST_MESSAGE)).toHaveLength(1)
    await instance.leave()
  })

  it('discards a decision when a newer snapshot arrives before send', async () => {
    const room = new FakeRoom()
    const { instance } = transport(room, { maxRuntimeMs: 500, requestTimeoutMs: 25 })
    await instance.connect()
    const controller = new AbortController()
    let calls = 0
    let release!: () => void
    const delayed = new Promise<void>(resolve => { release = resolve })
    const run = instance.run({
      signal: controller.signal,
      maxRuntimeMs: 500,
      maxActions: 1,
      decide: async () => {
        calls += 1
        if (calls === 1) {
          await delayed
          return { action: { type: 'endTurn', playerId: 'red' } }
        }
        controller.abort()
        return {}
      },
    })
    await vi.waitFor(() => expect(calls).toBe(1))
    room.emitSnapshot(1)
    release()
    await expect(run).resolves.toMatchObject({ status: 'stopped' })
    expect(room.sent.filter(message => message.type === BATTLE_COMMAND_MESSAGE)).toHaveLength(0)
    expect(calls).toBeGreaterThanOrEqual(2)
    await instance.leave()
  })

  it('binds the session player to a formal beginPhase action', async () => {
    const room = new FakeRoom()
    const { instance } = transport(room)
    await instance.connect()
    await instance.sendAction({ type: 'beginPhase' })
    const commandEnvelope = room.sent.find(message => message.type === BATTLE_COMMAND_MESSAGE)?.payload
    expect(commandEnvelope && typeof commandEnvelope === 'object' ? (commandEnvelope as Record<string, unknown>).command : undefined).toMatchObject({ type: 'beginPhase', playerId: 'red' })
    await instance.leave()
  })

  it('bounds a pending native join and cleans up a late room result', async () => {
    const room = new FakeRoom()
    let resolveJoin!: (value: FakeRoom) => void
    const join = new Promise<FakeRoom>(resolve => { resolveJoin = resolve })
    const client: CloudBotClientLike = {
      joinById: vi.fn(() => join),
      create: vi.fn(async () => room),
    }
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ profileIdentity }) }) as unknown as Response)
    const instance = new CloudBotTransport({ config: config({ requestTimeoutMs: 15 }), client, fetchFn, officialToken: 'session-token', trustedProfileIdentity: profileIdentity })
    const connect = instance.connect().then(() => undefined, error => error)
    await vi.waitFor(() => expect(client.joinById).toHaveBeenCalled())
    await instance.leave()
    await expect(connect).resolves.toMatchObject({ code: 'JOIN_TIMEOUT' })
    resolveJoin(room)
    await Promise.resolve()
  })

  it('forces the native socket closed when SDK leave never acknowledges', async () => {
    const room = new FakeRoom()
    const close = vi.fn()
    room.connection = { isOpen: true, close }
    room.leave = () => new Promise<unknown>(() => {})
    const { instance } = transport(room, { requestTimeoutMs: 15 })
    await instance.connect()
    await instance.leave()
    expect(close).toHaveBeenCalled()
  })

  it('closes a real SDK socket when the server never completes JOIN_ROOM', async () => {
    const httpServer = createServer((request, response) => {
      if (request.url?.startsWith('/matchmake/joinById/')) {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          name: 'battle', roomId: 'stall-room', processId: 'stall-process', sessionId: 'stall-session',
        }))
        return
      }
      response.statusCode = 404
      response.end()
    })
    const webSocketServer = new WebSocketServer({ server: httpServer })
    const sockets: Array<{ readyState: number; close: () => void }> = []
    webSocketServer.on('connection', socket => sockets.push(socket))
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(0, '127.0.0.1', () => resolve())
    })
    const address = httpServer.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ profileIdentity }) }) as unknown as Response)
    const instance = new CloudBotTransport({
      config: config({ serverUrl: `http://127.0.0.1:${port}`, requestTimeoutMs: 25 }),
      trustedProfileIdentity: profileIdentity,
      fetchFn,
      officialToken: 'session-token',
    })

    try {
      await expect(instance.connect()).rejects.toMatchObject({ code: 'JOIN_TIMEOUT' })
      await vi.waitFor(() => expect(sockets.length).toBe(1))
      await vi.waitFor(() => expect(sockets[0]?.readyState).toBe(3))
    } finally {
      await instance.leave()
      for (const socket of sockets) socket.close()
      await new Promise<void>(resolve => webSocketServer.close(() => resolve()))
      await new Promise<void>(resolve => httpServer.close(() => resolve()))
    }
  })
})
