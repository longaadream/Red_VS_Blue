import { createServer } from 'node:net'

import { Client as ColyseusClient, type Room as ColyseusClientRoom } from '@colyseus/sdk'
import { matchMaker } from 'colyseus'
import { describe, expect, it, vi } from 'vitest'

import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { createInitialCheckpoint } from '@/lib/server/colyseus/candidate-battle-store'
import { createDevelopmentBattleRoom } from '@/lib/server/colyseus/development-battle-fixture'
import { createColyseusBattleServer } from '@/lib/server/colyseus/create-colyseus-server'
import {
  BATTLE_SNAPSHOT_MESSAGE,
  SOCIAL_ACK_MESSAGE,
  SOCIAL_EVENT_MESSAGE,
  SOCIAL_HELLO_MESSAGE,
  SOCIAL_READY_MESSAGE,
  SOCIAL_SEND_MESSAGE,
} from '@/lib/server/colyseus/battle-room-protocol'
import { PostgresAuthorityJournal } from '@/lib/server/postgres/postgres-authority-journal'

import { FakeAuthorityRepository } from './fake-authority-repository'

type SocialMessage = {
  [key: string]: unknown
  event?: SocialMessage
  messageId?: string
  requestId?: string
}

type BattleSnapshot = {
  authorityVersion: number
  durableAuthorityVersion?: number
  stateHash: string
  seed: number
  rootSeed: number
  state: unknown
}

describe('RED-241 Colyseus room social channel', () => {
  it('keeps authority state/journal unchanged, deduplicates retries, and preserves cooldown across native reconnect', async () => {
    const repository = new FakeAuthorityRepository()
    const roomId = 'red241-social-authority'
    const fixture = createDevelopmentBattleRoom(roomId)
    await repository.initializeRoom(fixture, createInitialCheckpoint(fixture))
    const journal = new PostgresAuthorityJournal(repository, { maxBatchSize: 8, maxDwellMs: 25 })
    const candidate = createColyseusBattleServer({ repository, journal })
    const port = await availablePort()
    await candidate.server.listen(port, '127.0.0.1')
    const redClient = new ColyseusClient(`ws://127.0.0.1:${port}`)
    const blueClient = new ColyseusClient(`ws://127.0.0.1:${port}`)
    const redRoom = await redClient.joinOrCreate('battle', { battleId: roomId, playerId: 'player-red' })
    const blueRoom = await blueClient.joinById(redRoom.roomId, { playerId: 'player-blue' })
    const redEvents: SocialMessage[] = []
    const blueEvents: SocialMessage[] = []
    redRoom.onMessage(SOCIAL_EVENT_MESSAGE, message => redEvents.push(message as SocialMessage))
    blueRoom.onMessage(SOCIAL_EVENT_MESSAGE, message => blueEvents.push(message as SocialMessage))

    try {
      await expectSocialReady(redRoom, 'red-hello')
      await expectSocialReady(blueRoom, 'blue-hello')

      const before = await requestSnapshot(redRoom)
      const journalBefore = journal.inspect(roomId)
      const batchesBefore = repository.batches.length
      const roomBefore = await repository.restoreRoom(roomId)

      const request = { requestId: 'red-social-1', kind: 'text', payload: '桌边问候' }
      const firstEvent = nextMessage(blueRoom, SOCIAL_EVENT_MESSAGE, event => event.messageId === 'social:["player-red","red-social-1"]')
      const firstAck = nextMessage(redRoom, SOCIAL_ACK_MESSAGE, message => message.requestId === request.requestId)
      redRoom.send(SOCIAL_SEND_MESSAGE, request)
      const [ack, event] = await Promise.all([firstAck, firstEvent])
      expect(ack).toMatchObject({
        type: SOCIAL_ACK_MESSAGE,
        requestId: request.requestId,
        ok: true,
        event: { messageId: 'social:["player-red","red-social-1"]' },
      })
      expect(event).toMatchObject({
        type: SOCIAL_EVENT_MESSAGE,
        messageId: 'social:["player-red","red-social-1"]',
        playerId: 'player-red',
        displayName: 'Red',
        kind: 'text',
        payload: '桌边问候',
      })

      const duplicateAck = nextMessage(redRoom, SOCIAL_ACK_MESSAGE, message => message.requestId === request.requestId)
      redRoom.send(SOCIAL_SEND_MESSAGE, request)
      await expect(duplicateAck).resolves.toMatchObject({
        ok: true,
        event: { messageId: 'social:["player-red","red-social-1"]' },
      })
      await waitForTurn()
      expect(redEvents.filter(message => message.messageId === event.messageId)).toHaveLength(1)
      expect(blueEvents.filter(message => message.messageId === event.messageId)).toHaveLength(1)

      const after = await requestSnapshot(redRoom)
      const journalAfter = journal.inspect(roomId)
      const roomAfter = await repository.restoreRoom(roomId)
      expect(after).toMatchObject({
        authorityVersion: before.authorityVersion,
        durableAuthorityVersion: before.durableAuthorityVersion,
        stateHash: before.stateHash,
        seed: before.seed,
        rootSeed: before.rootSeed,
        state: before.state,
      })
      expect(journalAfter).toMatchObject({
        authorityVersion: journalBefore.authorityVersion,
        durableAuthorityVersion: journalBefore.durableAuthorityVersion,
        pending: journalBefore.pending,
        reserved: journalBefore.reserved,
        committedTransitions: journalBefore.committedTransitions,
      })
      expect(repository.batches).toHaveLength(batchesBefore)
      expect(roomAfter?.room.battleAuthorityVersion).toBe(roomBefore?.room.battleAuthorityVersion)
      expect(roomAfter?.room.battleAuthorityDurableVersion).toBe(roomBefore?.room.battleAuthorityDurableVersion)
      expect(roomAfter?.room.battleState).toEqual(roomBefore?.room.battleState)

      redRoom.reconnection.minUptime = 0
      redRoom.reconnection.minDelay = 10
      redRoom.reconnection.maxDelay = 50
      redRoom.reconnection.maxRetries = 20
      const sessionId = redRoom.sessionId
      const reconnected = nextReconnect(redRoom)
      void redRoom.leave(false)
      await reconnected
      expect(redRoom.sessionId).toBe(sessionId)

      const reconnectDuplicate = nextMessage(redRoom, SOCIAL_ACK_MESSAGE, message => message.requestId === request.requestId)
      redRoom.send(SOCIAL_SEND_MESSAGE, request)
      await expect(reconnectDuplicate).resolves.toMatchObject({ ok: true, event: { messageId: event.messageId } })
      const reconnectRetry = nextMessage(redRoom, SOCIAL_ACK_MESSAGE, message => message.requestId === 'red-social-reconnect')
      redRoom.send(SOCIAL_SEND_MESSAGE, { ...request, requestId: 'red-social-reconnect' })
      await expect(reconnectRetry).resolves.toMatchObject({ ok: false, code: 'SOCIAL_COOLDOWN' })
      expect(redEvents.filter(message => message.messageId === event.messageId)).toHaveLength(1)
      expect(blueEvents.filter(message => message.messageId === event.messageId)).toHaveLength(1)

      const roomInstance = matchMaker.getLocalRoomById(redRoom.roomId) as unknown as {
        requireGameRoom(): Promise<unknown>
        playerBySession: Map<string, string>
        socialLastSuccessfulAt: Map<string, number>
      }
      const originalRead = roomInstance.requireGameRoom.bind(roomInstance)
      let releaseRead!: () => void
      let readStarted!: () => void
      const blockedRead = new Promise<void>(resolve => { releaseRead = resolve })
      const readStartedPromise = new Promise<void>(resolve => { readStarted = resolve })
      const read = vi.spyOn(roomInstance, 'requireGameRoom').mockImplementationOnce(async () => {
        readStarted()
        const room = await originalRead()
        await blockedRead
        return room
      })
      const staleTimestamp = roomInstance.socialLastSuccessfulAt.get('player-red')
      const revokedAck = nextMessage(redRoom, SOCIAL_ACK_MESSAGE, message => message.requestId === 'red-social-revoked')
      redRoom.send(SOCIAL_SEND_MESSAGE, { requestId: 'red-social-revoked', kind: 'text', payload: '撤销期间不应发送' })
      await readStartedPromise
      roomInstance.playerBySession.delete(redRoom.sessionId)
      releaseRead()
      await expect(revokedAck).resolves.toMatchObject({ ok: false, code: 'SOCIAL_NOT_AUTHENTICATED' })
      expect(roomInstance.socialLastSuccessfulAt.get('player-red')).toBe(staleTimestamp)
      expect(redEvents.filter(message => message.messageId === 'social:["player-red","red-social-revoked"]').length).toBe(0)
      expect(blueEvents.filter(message => message.messageId === 'social:["player-red","red-social-revoked"]').length).toBe(0)
      read.mockRestore()
    } finally {
      redRoom.reconnection.enabled = false
      blueRoom.reconnection.enabled = false
      await redRoom.leave().catch(() => undefined)
      await blueRoom.leave().catch(() => undefined)
      await candidate.server.gracefullyShutdown(false)
    }
  }, 20_000)

  it('allows authorized spectators to receive local events but rejects their sends', async () => {
    const repository = new FakeAuthorityRepository()
    const journal = new PostgresAuthorityJournal(repository, { maxBatchSize: 8, maxDwellMs: 25 })
    const candidate = createColyseusBattleServer({ repository, journal })
    const port = await availablePort()
    await candidate.server.listen(port, '127.0.0.1')
    const client = new ColyseusClient(`ws://127.0.0.1:${port}`)
    const profileIdentity = getServerGameProfileIdentityV1()
    const host = await client.create('battle', {
      product: true,
      visibility: 'public',
      playerId: 'host',
      playerName: 'Host',
      profileIdentity,
    })
    const spectator = await client.joinById(host.roomId, {
      product: true,
      spectator: true,
      playerId: 'watcher',
      profileIdentity,
    })

    try {
      await expectSocialReady(host, 'host-hello')
      await expectSocialReady(spectator, 'watcher-hello')

      const forbidden = nextMessage(spectator, SOCIAL_ACK_MESSAGE, message => message.requestId === 'watcher-send')
      spectator.send(SOCIAL_SEND_MESSAGE, { requestId: 'watcher-send', kind: 'stamp', payload: 'star' })
      await expect(forbidden).resolves.toMatchObject({
        type: SOCIAL_ACK_MESSAGE,
        requestId: 'watcher-send',
        ok: false,
        code: 'SOCIAL_SPECTATOR_FORBIDDEN',
      })

      const received = nextMessage(spectator, SOCIAL_EVENT_MESSAGE, event => event.messageId === 'social:["host","host-send"]')
      const acknowledged = nextMessage(host, SOCIAL_ACK_MESSAGE, message => message.requestId === 'host-send')
      host.send(SOCIAL_SEND_MESSAGE, { requestId: 'host-send', kind: 'preset', payload: 'hello' })
      await expect(acknowledged).resolves.toMatchObject({ ok: true, event: { messageId: 'social:["host","host-send"]' } })
      await expect(received).resolves.toMatchObject({
        type: SOCIAL_EVENT_MESSAGE,
        messageId: 'social:["host","host-send"]',
        playerId: 'host',
        displayName: 'Host',
        kind: 'preset',
        payload: 'hello',
      })
    } finally {
      host.reconnection.enabled = false
      spectator.reconnection.enabled = false
      await host.leave().catch(() => undefined)
      await spectator.leave().catch(() => undefined)
      await candidate.server.gracefullyShutdown(false)
    }
  }, 20_000)
})

async function expectSocialReady(room: ColyseusClientRoom, requestId: string): Promise<void> {
  const ready = nextMessage(room, SOCIAL_READY_MESSAGE, message => message.requestId === requestId)
  room.send(SOCIAL_HELLO_MESSAGE, { requestId })
  await expect(ready).resolves.toMatchObject({
    type: SOCIAL_READY_MESSAGE,
    supported: true,
    protocolVersion: 1,
    cooldownMs: 3_000,
    limits: { text: { maxGraphemes: 60, maxLines: 2, maxUtf8Bytes: 256 } },
  })
}

function nextMessage(
  room: ColyseusClientRoom,
  type: string,
  predicate: (message: SocialMessage) => boolean = () => true,
): Promise<SocialMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 3_000)
    const unsubscribe = room.onMessage(type, message => {
      const parsed = message as SocialMessage
      if (!predicate(parsed)) return
      clearTimeout(timeout)
      unsubscribe()
      resolve(parsed)
    })
  })
}

function nextReconnect(room: ColyseusClientRoom): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('native reconnection timed out')), 3_000)
    room.onReconnect.once(() => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

function requestSnapshot(room: ColyseusClientRoom): Promise<BattleSnapshot> {
  const snapshot = nextMessage(room, BATTLE_SNAPSHOT_MESSAGE) as unknown as Promise<BattleSnapshot>
  room.send('battleResync', {})
  return snapshot
}

async function waitForTurn(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0))
}

async function availablePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  return port
}
