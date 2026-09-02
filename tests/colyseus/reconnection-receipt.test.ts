import { createServer } from 'node:net'

import { Client as ColyseusClient, type Room as ColyseusClientRoom } from '@colyseus/sdk'
import { describe, expect, it } from 'vitest'

import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import {
  BATTLE_AUTHORITY_BUILD_ID,
  BATTLE_AUTHORITY_PROTOCOL_VERSION,
} from '@/lib/game/battle-public-patch'
import { createColyseusBattleServer } from '@/lib/server/colyseus/create-colyseus-server'
import {
  BATTLE_COMMAND_MESSAGE,
  BATTLE_RECEIPT_MESSAGE,
  BATTLE_RECEIPT_REQUEST_MESSAGE,
  BATTLE_SNAPSHOT_MESSAGE,
} from '@/lib/server/colyseus/battle-room-protocol'
import { PostgresAuthorityJournal } from '@/lib/server/postgres/postgres-authority-journal'

import { FakeAuthorityRepository } from './fake-authority-repository'

describe('RED-170 native reconnection and exact receipts', () => {
  it('rejects a second live session for the same product player', async () => {
    const candidate = createCandidate()
    const port = await availablePort()
    await candidate.server.listen(port, '127.0.0.1')
    const profileIdentity = getServerGameProfileIdentityV1()
    const firstClient = new ColyseusClient(`ws://127.0.0.1:${port}`)
    const duplicateClient = new ColyseusClient(`ws://127.0.0.1:${port}`)
    const room = await firstClient.create('battle', {
      product: true,
      playerId: 'player-red',
      playerName: 'Red',
      profileIdentity,
    })

    try {
      await expect(duplicateClient.joinById(room.roomId, {
        product: true,
        playerId: 'player-red',
        playerName: 'Red duplicate',
        profileIdentity,
      })).rejects.toMatchObject({ message: expect.stringMatching(/already connected/i) })
    } finally {
      await room.leave()
      await candidate.server.gracefullyShutdown(false)
    }
  })

  it('reconnects the same SDK room/session and preserves its authority snapshot', async () => {
    const candidate = createCandidate()
    const port = await availablePort()
    await candidate.server.listen(port, '127.0.0.1')
    const client = new ColyseusClient(`ws://127.0.0.1:${port}`)
    const room = await client.joinOrCreate('battle', {
      battleId: 'red170-native-reconnect',
      playerId: 'player-red',
    })
    room.reconnection.minUptime = 0
    room.reconnection.minDelay = 10
    room.reconnection.maxDelay = 50
    room.reconnection.maxRetries = 20

    try {
      const before = await requestSnapshot(room)
      const sessionId = room.sessionId
      const reconnected = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('native reconnection timed out')), 3_000)
        room.onReconnect.once(() => {
          clearTimeout(timeout)
          resolve()
        })
      })
      void room.leave(false)
      await reconnected
      expect(room.sessionId).toBe(sessionId)
      await expect(requestSnapshot(room)).resolves.toMatchObject({
        authorityVersion: before.authorityVersion,
        stateHash: before.stateHash,
      })
    } finally {
      await room.leave().catch(() => undefined)
      await candidate.server.gracefullyShutdown(false)
    }
  }, 10_000)

  it('survives 100 transient drops without creating a replacement session or ghost seat', async () => {
    const candidate = createCandidate()
    const port = await availablePort()
    await candidate.server.listen(port, '127.0.0.1')
    const client = new ColyseusClient(`ws://127.0.0.1:${port}`)
    const duplicate = new ColyseusClient(`ws://127.0.0.1:${port}`)
    const room = await client.joinOrCreate('battle', {
      battleId: 'red170-drop-soak',
      playerId: 'player-red',
    })
    room.reconnection.minUptime = 0
    room.reconnection.minDelay = 1
    room.reconnection.maxDelay = 5
    room.reconnection.maxRetries = 20
    const originalSessionId = room.sessionId

    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const reconnected = nextReconnect(room)
        void room.leave(false)
        await reconnected
        expect(room.sessionId).toBe(originalSessionId)
      }
      await expect(duplicate.joinById(room.roomId, { playerId: 'player-red' }))
        .rejects.toMatchObject({ message: expect.stringMatching(/already connected/i) })
      await expect(requestSnapshot(room)).resolves.toMatchObject({
        authorityVersion: 0,
      })
    } finally {
      await room.leave().catch(() => undefined)
      await candidate.server.gracefullyShutdown(false)
    }
  }, 30_000)

  it('returns the exact stored outcome by clientActionId after a receipt is lost', async () => {
    const candidate = createCandidate()
    const port = await availablePort()
    await candidate.server.listen(port, '127.0.0.1')
    const client = new ColyseusClient(`ws://127.0.0.1:${port}`)
    const room = await client.joinOrCreate('battle', {
      battleId: 'red170-receipt-lookup',
      playerId: 'player-red',
    })

    try {
      const before = await requestSnapshot(room)
      const clientActionId = 'red170-lost-receipt'
      room.send(BATTLE_COMMAND_MESSAGE, {
        protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
        authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
        roomId: room.roomId,
        playerId: 'player-red',
        expectedAuthorityVersion: before.authorityVersion,
        clientActionId,
        command: { type: 'beginPhase', clientActionId },
      })
      await nextMessage(room, BATTLE_RECEIPT_MESSAGE, message => message?.receipt?.clientActionId === clientActionId)

      await expect(room.request(BATTLE_RECEIPT_REQUEST_MESSAGE, { clientActionId }, { timeout: 2_000 }))
        .resolves.toMatchObject({
          clientActionId,
          outcome: 'applied',
          receipt: { clientActionId, status: 'applied' },
          snapshot: { authorityVersion: before.authorityVersion + 1 },
        })
      await expect(room.request(BATTLE_RECEIPT_REQUEST_MESSAGE, { clientActionId: 'never-submitted' }, { timeout: 2_000 }))
        .resolves.toMatchObject({ clientActionId: 'never-submitted', outcome: 'unknown' })
    } finally {
      await room.leave()
      await candidate.server.gracefullyShutdown(false)
    }
  }, 10_000)
})

function createCandidate() {
  const repository = new FakeAuthorityRepository()
  const journal = new PostgresAuthorityJournal(repository, { maxBatchSize: 8, maxDwellMs: 25 })
  return createColyseusBattleServer({ repository, journal })
}

function requestSnapshot(room: ColyseusClientRoom): Promise<TestSnapshot> {
  const snapshot = nextMessage(room, BATTLE_SNAPSHOT_MESSAGE)
  room.send('battleResync', {})
  return snapshot as unknown as Promise<TestSnapshot>
}

function nextMessage(
  room: ColyseusClientRoom,
  type: string,
  predicate: (message: TestProtocolMessage) => boolean = () => true,
): Promise<TestProtocolMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 3_000)
    const unsubscribe = room.onMessage(type, message => {
      if (!predicate(message)) return
      clearTimeout(timeout)
      unsubscribe()
      resolve(message)
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

interface TestSnapshot {
  authorityVersion: number
  stateHash: string
  state: {
    deployment: { revision: number; offerPieceIds?: string[] }
  }
}

interface TestProtocolMessage {
  [key: string]: unknown
  receipt?: { clientActionId?: string }
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
