import { createServer } from 'node:net'

import { Client as ColyseusClient, type Room as ColyseusRoom } from '@colyseus/sdk'
import { describe, expect, it } from 'vitest'

import { BATTLE_AUTHORITY_BUILD_ID, BATTLE_AUTHORITY_PROTOCOL_VERSION } from '@/lib/game/battle-public-patch'
import { createColyseusBattleServer } from '@/lib/server/colyseus/create-colyseus-server'
import {
  BATTLE_COMMAND_MESSAGE,
  BATTLE_RECEIPT_MESSAGE,
  BATTLE_SNAPSHOT_MESSAGE,
} from '@/lib/server/colyseus/battle-room-protocol'
import { PostgresAuthorityJournal } from '@/lib/server/postgres/postgres-authority-journal'

import { FakeAuthorityRepository } from './fake-authority-repository'

describe('RED-170 two-client single-match soak', () => {
  it('takes 100 real SDK room pairs from creation through one terminal authority settlement', async () => {
    const repository = new FakeAuthorityRepository()
    const journal = new PostgresAuthorityJournal(repository, { maxBatchSize: 8, maxDwellMs: 1 })
    const candidate = createColyseusBattleServer({ repository, journal })
    const port = await availablePort()
    await candidate.server.listen(port, '127.0.0.1')
    const endpoint = `ws://127.0.0.1:${port}`
    const redClient = new ColyseusClient(endpoint)
    const blueClient = new ColyseusClient(endpoint)

    try {
      for (let index = 0; index < 100; index += 1) {
        const redRoom = await redClient.create('battle', {
          battleId: `red170-soak-${index}`,
          playerId: 'player-red',
        })
        const blueRoom = await blueClient.joinById(redRoom.roomId, {
          playerId: 'player-blue',
        })
        try {
          const initial = await requestSnapshot(redRoom)
          const clientActionId = `red170-soak-surrender-${index}`
          const receipt = nextMessage(
            redRoom,
            BATTLE_RECEIPT_MESSAGE,
            message => message?.receipt?.clientActionId === clientActionId,
          )
          redRoom.send(BATTLE_COMMAND_MESSAGE, {
            protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
            authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
            roomId: redRoom.roomId,
            playerId: 'player-red',
            expectedAuthorityVersion: initial.authorityVersion,
            clientActionId,
            command: { type: 'surrender', playerId: 'player-red', reason: 'voluntary', clientActionId },
          })
          await expect(receipt).resolves.toMatchObject({
            kind: 'applied',
            receipt: { clientActionId, status: 'applied' },
          })
          await expect(requestSnapshot(redRoom)).resolves.toMatchObject({
            state: { terminalResult: { status: 'finished', reason: 'surrender' } },
          })
        } finally {
          await redRoom.leave()
          await blueRoom.leave()
        }
      }
    } finally {
      await candidate.server.gracefullyShutdown(false)
    }
  }, 60_000)
})

function requestSnapshot(room: ColyseusRoom) {
  const snapshot = nextMessage(room, BATTLE_SNAPSHOT_MESSAGE)
  room.send('battleResync', {})
  return snapshot
}

function nextMessage(
  room: ColyseusRoom,
  type: string,
  predicate: (message: SoakProtocolMessage) => boolean = () => true,
): Promise<SoakProtocolMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 5_000)
    const unsubscribe = room.onMessage(type, message => {
      if (!predicate(message)) return
      clearTimeout(timeout)
      unsubscribe()
      resolve(message)
    })
  })
}

interface SoakProtocolMessage {
  [key: string]: unknown
  authorityVersion: number
  receipt?: { clientActionId?: string }
  state: { terminalResult?: { status?: string; reason?: string } }
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
