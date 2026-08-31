import { createServer } from 'node:net'

import { Client as ColyseusClient, type Room as ColyseusClientRoom } from '@colyseus/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  BATTLE_AUTHORITY_BUILD_ID,
  BATTLE_AUTHORITY_PROTOCOL_VERSION,
} from '@/lib/game/battle-public-patch'
import { createColyseusBattleServer } from '@/lib/server/colyseus/create-colyseus-server'
import {
  BATTLE_COMMAND_MESSAGE,
  BATTLE_DURABLE_MESSAGE,
  BATTLE_RECEIPT_MESSAGE,
  BATTLE_TRANSITION_MESSAGE,
} from '@/lib/server/colyseus/battle-room-protocol'
import { PostgresAuthorityJournal } from '@/lib/server/postgres/postgres-authority-journal'

import { FakeAuthorityRepository } from './fake-authority-repository'

const originalAuthority = process.env.RVB_BATTLE_AUTHORITY_V2

describe('RED-160 Colyseus BattleRoom', () => {
  beforeEach(() => {
    process.env.RVB_BATTLE_AUTHORITY_V2 = '1'
  })

  afterEach(() => {
    if (originalAuthority === undefined) delete process.env.RVB_BATTLE_AUTHORITY_V2
    else process.env.RVB_BATTLE_AUTHORITY_V2 = originalAuthority
  })

  it('accepts two real clients, acknowledges 20 actions without waiting for PostgreSQL, and deduplicates retries', async () => {
    let releaseWriter!: () => void
    const writerBlocked = new Promise<void>(resolve => { releaseWriter = resolve })
    const repository = new FakeAuthorityRepository()
    repository.beforeCommit = () => writerBlocked
    const journal = new PostgresAuthorityJournal(repository, {
      maxBatchSize: 8,
      maxDwellMs: 25,
      maxAttempts: 1,
    })
    const candidate = createColyseusBattleServer({ repository, journal })
    const port = await availablePort()
    await candidate.server.listen(port, '127.0.0.1')
    const health = await fetch(`http://127.0.0.1:${port}/healthz`)
    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      runtime: 'colyseus-postgresql',
      database: 'postgresql',
    })
    const redClient = new ColyseusClient(`ws://127.0.0.1:${port}`)
    const blueClient = new ColyseusClient(`ws://127.0.0.1:${port}`)
    const redRoom = await redClient.joinOrCreate('battle', {
      battleId: 'red160-two-client',
      playerId: 'player-red',
    })
    const blueRoom = await blueClient.joinById(redRoom.roomId, { playerId: 'player-blue' })
    expect(redRoom.state).toMatchObject({
      battleId: redRoom.roomId,
      authorityVersion: 0,
      durableAuthorityVersion: 0,
    })
    for (const room of [redRoom, blueRoom]) {
      room.onMessage(BATTLE_TRANSITION_MESSAGE, () => {})
      room.onMessage(BATTLE_DURABLE_MESSAGE, () => {})
    }

    try {
      const latencies: number[] = []
      const serverTotals: number[] = []
      for (let index = 0; index < 20; index += 1) {
        const room = Math.floor(index / 2) % 2 === 0 ? redRoom : blueRoom
        const playerId = room === redRoom ? 'player-red' : 'player-blue'
        const clientActionId = `red160-action-${index + 1}`
        const command = index % 2 === 0
          ? { type: 'endTurn', playerId, clientActionId }
          : { type: 'beginPhase', clientActionId }
        const startedAt = performance.now()
        const receiptPromise = nextReceipt(room, clientActionId)
        room.send(BATTLE_COMMAND_MESSAGE, envelope(
          redRoom.roomId,
          playerId,
          index,
          clientActionId,
          command,
        ))
        const receipt = await receiptPromise
        latencies.push(performance.now() - startedAt)
        serverTotals.push(receipt.timings?.totalMs ?? Number.POSITIVE_INFINITY)
        expect(receipt).toMatchObject({
          kind: 'applied',
          authorityVersion: index + 1,
          durability: 'pending',
        })
      }

      const duplicateId = 'red160-action-20'
      const duplicates: BattleReceiptMessage[] = []
      for (let retry = 0; retry < 10; retry += 1) {
        const duplicateReceipt = nextReceipt(blueRoom, duplicateId)
        blueRoom.send(BATTLE_COMMAND_MESSAGE, envelope(
          redRoom.roomId,
          'player-blue',
          19,
          duplicateId,
          { type: 'beginPhase', clientActionId: duplicateId },
        ))
        duplicates.push(await duplicateReceipt)
      }
      expect(duplicates.every(receipt => receipt.kind === 'duplicate')).toBe(true)
      const metrics = {
        serverP50Ms: percentile(serverTotals, 0.5),
        serverP95Ms: percentile(serverTotals, 0.95),
        clientP50Ms: percentile(latencies, 0.5),
        clientP95Ms: percentile(latencies, 0.95),
      }
      console.info('[RED-160 applied-latency]', metrics)
      expect(metrics.serverP95Ms).toBeLessThan(100)
      expect(metrics.clientP95Ms).toBeLessThan(1_000)
      expect(repository.batches).toHaveLength(0)

      releaseWriter()
      await journal.drain(redRoom.roomId)
      expect(repository.batches.flat()).toHaveLength(20)
      expect(journal.inspect(redRoom.roomId).durableAuthorityVersion).toBe(20)
    } finally {
      releaseWriter()
      await redRoom.leave()
      await blueRoom.leave()
      await candidate.server.gracefullyShutdown(false)
    }
  }, 20_000)
})

function envelope(
  roomId: string,
  playerId: string,
  expectedAuthorityVersion: number,
  clientActionId: string,
  command: Record<string, unknown>,
) {
  return {
    protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
    authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
    roomId,
    playerId,
    expectedAuthorityVersion,
    clientActionId,
    command,
  }
}

interface BattleReceiptMessage {
  kind: string
  authorityVersion?: number
  durability?: string
  receipt?: { clientActionId?: string }
  timings?: { totalMs?: number }
}

function nextReceipt(room: ColyseusClientRoom, clientActionId: string): Promise<BattleReceiptMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${clientActionId}`)), 3_000)
    const unsubscribe = room.onMessage(BATTLE_RECEIPT_MESSAGE, message => {
      if (message?.receipt?.clientActionId !== clientActionId) return
      clearTimeout(timeout)
      unsubscribe()
      resolve(message)
    })
  })
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

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]
}
