import { createServer } from 'node:net'

import { Client as ColyseusClient, type Room as ColyseusClientRoom } from '@colyseus/sdk'
import { describe, expect, it } from 'vitest'

import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import {
  BATTLE_AUTHORITY_BUILD_ID,
  BATTLE_AUTHORITY_PROTOCOL_VERSION,
} from '@/lib/game/battle-public-patch'
import { getDemoPieceIds, getPieceById } from '@/lib/game/piece-repository'
import { createColyseusBattleServer } from '@/lib/server/colyseus/create-colyseus-server'
import {
  BATTLE_COMMAND_MESSAGE,
  BATTLE_RECEIPT_MESSAGE,
  BATTLE_SNAPSHOT_MESSAGE,
  PRODUCT_ROOM_RPC_MESSAGE,
  PRODUCT_ROOM_RPC_RESULT_MESSAGE,
  PRODUCT_ROOM_UPDATE_MESSAGE,
} from '@/lib/server/colyseus/battle-room-protocol'
import { PostgresAuthorityJournal } from '@/lib/server/postgres/postgres-authority-journal'

import { FakeAuthorityRepository } from './fake-authority-repository'

describe('RED-161 Colyseus product room', () => {
  it('owns lobby, roster lock, version-zero durability and battle admission without legacy RoomStore', async () => {
    const repository = new FakeAuthorityRepository()
    const journal = new PostgresAuthorityJournal(repository, { maxBatchSize: 8, maxDwellMs: 25 })
    const candidate = createColyseusBattleServer({ repository, journal })
    const port = await availablePort()
    await candidate.server.listen(port, '127.0.0.1')

    const profileIdentity = getServerGameProfileIdentityV1()
    await expect(fetch(`http://127.0.0.1:${port}/healthz`).then(response => response.json()))
      .resolves.toMatchObject({ ok: true, protocol: 'rvb-colyseus' })
    const redClient = new ColyseusClient(`ws://127.0.0.1:${port}`)
    const blueClient = new ColyseusClient(`ws://127.0.0.1:${port}`)
    const redRoom = await redClient.create('battle', {
      product: true,
      name: 'RED-161 product room',
      mapId: 'open-expanse',
      visibility: 'public',
      playerId: 'player-red',
      playerName: 'Red',
      profileIdentity,
    })
    expect(redRoom.roomId).toBe(redRoom.roomId.toLowerCase())
    await expect(fetch(`http://127.0.0.1:${port}/catalog/identity`).then(response => response.json()))
      .resolves.toMatchObject({ profileIdentity })
    await expect(fetch(`http://127.0.0.1:${port}/rooms`).then(response => response.json()))
      .resolves.toEqual({ rooms: expect.arrayContaining([expect.objectContaining({ id: redRoom.roomId })]) })
    const blueRoom = await blueClient.joinById(redRoom.roomId, {
      product: true,
      playerId: 'player-blue',
      playerName: 'Blue',
      profileIdentity,
    })

    try {
      const joined = await requestRoomRpc(redRoom, 'rooms.get', { roomId: redRoom.roomId })
      expect(joined).toMatchObject({
        id: redRoom.roomId,
        status: 'waiting',
      })
      expect(joined.players.map((player: { seat: string }) => player.seat).sort()).toEqual(['blue', 'red'])
      expect(joined.players.map((player: { id: string }) => player.id)).toEqual(['player-red', 'player-blue'])

      await requestRoomRpc(redRoom, 'rooms.action', {
        action: 'claim-faction', playerId: 'player-red', alignment: 'light', profileIdentity,
      })
      await requestRoomRpc(blueRoom, 'rooms.action', {
        action: 'claim-faction', playerId: 'player-blue', alignment: 'dark', profileIdentity,
      })
      await requestRoomRpc(redRoom, 'rooms.action', {
        action: 'toggle-ready', playerId: 'player-red', profileIdentity,
      })
      await requestRoomRpc(blueRoom, 'rooms.action', {
        action: 'toggle-ready', playerId: 'player-blue', profileIdentity,
      })

      const redRoster = rosterFor('good')
      const blueRoster = rosterFor('evil')
      const redSnapshot = nextMessage(redRoom, BATTLE_SNAPSHOT_MESSAGE)
      const blueSnapshot = nextMessage(blueRoom, BATTLE_SNAPSHOT_MESSAGE)
      await requestRoomRpc(redRoom, 'rooms.action', {
        action: 'select-pieces', playerId: 'player-red', alignment: 'light', pieces: redRoster, profileIdentity,
      })
      await requestRoomRpc(blueRoom, 'rooms.action', {
        action: 'select-pieces', playerId: 'player-blue', alignment: 'dark', pieces: blueRoster, profileIdentity,
      })

      const redInitial = await redSnapshot
      const blueInitial = await blueSnapshot
      expect(redInitial).toMatchObject({
        type: 'stateUpdate',
        authorityVersion: 0,
        durableAuthorityVersion: 0,
        persistenceStatus: 'durable',
        state: { deployment: { mode: 'progressive-reserve-v1' } },
        turnTimer: { status: 'running' },
      })
      expect(blueInitial).toMatchObject({
        type: 'stateUpdate', authorityVersion: 0, durableAuthorityVersion: 0,
      })
      await expect(repository.restoreRoom(redRoom.roomId)).resolves.toMatchObject({
        durableAuthorityVersion: 0,
        room: { status: 'in-progress', battleAuthorityVersion: 0 },
      })
      expect(repository.batches).toHaveLength(0)

      const roomUpdate = nextMessage(redRoom, PRODUCT_ROOM_UPDATE_MESSAGE)
      redRoom.send(PRODUCT_ROOM_RPC_MESSAGE, {
        requestId: 'room-get-after-start', method: 'rooms.get', data: { roomId: redRoom.roomId },
      })
      await expect(roomUpdate).resolves.toMatchObject({
        type: 'roomUpdate', room: { status: 'in-progress' },
      })

      const activePlayerId = redInitial.state.turn.currentPlayerId
      const activeRoom = activePlayerId === 'player-red' ? redRoom : blueRoom
      const activeState = activePlayerId === 'player-red' ? redInitial.state : blueInitial.state
      const deployment = activeState.deployment
      const pieceId = deployment.offerPieceIds?.[0] ?? deployment.offerPieces?.[0]?.instanceId
      expect(pieceId).toBeTruthy()
      const clientActionId = 'red161-first-product-action'
      const receipt = nextMessage(
        activeRoom,
        BATTLE_RECEIPT_MESSAGE,
        message => message?.receipt?.clientActionId === clientActionId,
      )
      const position = deployment.legalPositions?.[0]
      activeRoom.send(BATTLE_COMMAND_MESSAGE, {
        protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
        authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
        roomId: redRoom.roomId,
        playerId: activePlayerId,
        expectedAuthorityVersion: 0,
        clientActionId,
        command: {
          type: 'deployReservePiece',
          playerId: activePlayerId,
          expectedDeploymentRevision: deployment.revision,
          pieceId,
          ...(position ? { toX: position.x, toY: position.y } : {}),
          clientActionId,
        },
      })
      await expect(receipt).resolves.toMatchObject({
        kind: 'applied',
        authorityVersion: 1,
        receipt: { clientActionId, status: 'applied' },
      })
    } finally {
      await redRoom.leave()
      await blueRoom.leave()
      await candidate.server.gracefullyShutdown(false)
    }
  }, 20_000)
})

function rosterFor(faction: 'good' | 'evil') {
  return getDemoPieceIds()
    .filter(id => getPieceById(id)?.faction === faction)
    .slice(0, 8)
    .map(templateId => ({ templateId }))
}

async function requestRoomRpc(
  room: ColyseusClientRoom,
  method: string,
  data: Record<string, unknown>,
): Promise<TestRoomSnapshot> {
  const requestId = `${method}:${Math.random().toString(36).slice(2)}`
  const response = nextMessage(room, PRODUCT_ROOM_RPC_RESULT_MESSAGE, message => message?.requestId === requestId)
  room.send(PRODUCT_ROOM_RPC_MESSAGE, { requestId, method, data })
  const message = await response
  if (!message.ok) throw new Error(message.error || `RPC ${method} failed`)
  return message.data as TestRoomSnapshot
}

function nextMessage(
  room: ColyseusClientRoom,
  type: string,
  predicate: (message: TestProtocolMessage) => boolean = () => true,
): Promise<TestProtocolMessage> {
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

interface TestProtocolMessage {
  [key: string]: unknown
  authorityVersion?: number
  data?: unknown
  error?: string
  ok?: boolean
  receipt?: { clientActionId?: string; status?: string }
  requestId?: string
  room?: { status?: string }
  turnTimer?: { status?: string; remainingSeconds?: number }
  state: {
    deployment: {
      legalPositions?: Array<{ x: number; y: number }>
      mode?: string
      offerPieceIds?: string[]
      offerPieces?: Array<{ instanceId: string }>
      revision: number
    }
    turn: { currentPlayerId: string }
  }
}

interface TestRoomSnapshot {
  id: string
  status: string
  players: Array<{ id: string; seat: string }>
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
