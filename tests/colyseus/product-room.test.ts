import { createServer } from 'node:net'

import { Client as ColyseusClient, type Room as ColyseusClientRoom } from '@colyseus/sdk'
import { describe, expect, it, vi } from 'vitest'

import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import {
  BATTLE_AUTHORITY_BUILD_ID,
  BATTLE_AUTHORITY_PROTOCOL_VERSION,
} from '@/lib/game/battle-public-patch'
import { getDemoPieceIds, getPieceById } from '@/lib/game/piece-repository'
import { planBotActions } from '@/lib/game/ai'
import { getCurrentInputOwnerPlayerId } from '@/lib/game/turn-timer'
import type { BattleState } from '@/lib/game/turn'
import * as ruleRuntime from '@/lib/game/rule-runtime'
import { createInitialCheckpoint } from '@/lib/server/colyseus/candidate-battle-store'
import { createColyseusBattleServer } from '@/lib/server/colyseus/create-colyseus-server'
import { createDevelopmentBattleRoom } from '@/lib/server/colyseus/development-battle-fixture'
import {
  BATTLE_COMMAND_MESSAGE,
  BATTLE_RECEIPT_MESSAGE,
  BATTLE_SNAPSHOT_MESSAGE,
  BATTLE_RESYNC_MESSAGE,
  PRODUCT_ROOM_RPC_MESSAGE,
  PRODUCT_ROOM_UPDATE_MESSAGE,
} from '@/lib/server/colyseus/battle-room-protocol'
import { PostgresAuthorityJournal } from '@/lib/server/postgres/postgres-authority-journal'

import { FakeAuthorityRepository } from './fake-authority-repository'

describe('RED-161 Colyseus product room', () => {
  it('defaults old PvE requests to easy and rejects invalid difficulty or a human bot seat', async () => {
    const repository = new FakeAuthorityRepository()
    const journal = new PostgresAuthorityJournal(repository)
    const candidate = createColyseusBattleServer({ repository, journal })
    const port = await availablePort()
    await candidate.server.listen(port, '127.0.0.1')
    const client = new ColyseusClient(`ws://127.0.0.1:${port}`)
    const profileIdentity = getServerGameProfileIdentityV1()
    let room: ColyseusClientRoom | undefined
    try {
      await expect(client.create('battle', { product: true, mode: 'pve', difficulty: 'hard', playerId: 'human', profileIdentity }))
        .rejects.toThrow()
      expect(await fetch(`http://127.0.0.1:${port}/rooms`).then(response => response.json())).toEqual({ rooms: [] })
      room = await client.create('battle', { product: true, mode: 'pve', playerId: 'human', profileIdentity })
      const initial = await requestRoomRpc(room, 'rooms.get', {})
      expect(initial.players).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'bot', botDifficulty: 'easy' })]))
      await expect(client.joinById(room.roomId, { playerId: 'bot', profileIdentity })).rejects.toThrow('Bot seats are server controlled')
    } finally {
      if (room) await room.leave()
      await candidate.server.gracefullyShutdown(false)
    }
  })

  it.each(['easy', 'normal'])('creates PvE %s, locks the bot roster and returns control after its turn', async difficulty => {
    // Fix only the external seed source; planners, rules and network are real.
    const seedSource = vi.spyOn(ruleRuntime, 'createRootSeed').mockReturnValue(1001)
    const repository = new FakeAuthorityRepository()
    const journal = new PostgresAuthorityJournal(repository, { maxBatchSize: 8, maxDwellMs: 25 })
    const candidate = createColyseusBattleServer({ repository, journal })
    const port = await availablePort()
    await candidate.server.listen(port, '127.0.0.1')
    const client = new ColyseusClient(`ws://127.0.0.1:${port}`)
    const profileIdentity = getServerGameProfileIdentityV1()
    let room: ColyseusClientRoom | undefined
    try {
      room = await client.create('battle', { product: true, mode: 'pve', difficulty, playerId: 'human', playerName: 'Human', profileIdentity })
      const initial = await requestRoomRpc(room, 'rooms.get', { roomId: room.roomId })
      expect(initial).toMatchObject({ visibility: 'private', players: expect.arrayContaining([
        expect.objectContaining({ id: 'bot', seat: 'blue', isBot: true, botDifficulty: difficulty }),
        expect.objectContaining({ id: 'human', seat: 'red', alignment: 'light' }),
      ]) })
      const started = nextMessage(room, BATTLE_SNAPSHOT_MESSAGE)
      await requestRoomRpc(room, 'rooms.action', { action: 'select-pieces', playerId: 'human', alignment: 'light', pieces: rosterFor('good'), profileIdentity })
      let snapshot = await started
      expect(snapshot.state.turn.currentPlayerId).toBe('human')
      const setup = await requestRoomRpc(room, 'rooms.get', { roomId: room.roomId })
      expect(setup.players).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'bot', rosterLocked: true, selectedPiecesCount: 8 })]))
      for (let step = 0; step < 12 && getCurrentInputOwnerPlayerId(snapshot.state as BattleState) === 'human'; step += 1) {
        const humanState = snapshot.state as BattleState
        const deployment = snapshot.state.deployment
        const position = deployment.legalPositions?.[0]
        const hasPendingInput = humanState.pendingOptionSelection || humanState.pendingTargetSelection
        const action = !hasPendingInput && humanState.deployment?.status === 'awaiting-reserve-deploy'
          ? { type: 'deployReservePiece', pieceId: deployment.offerPieceIds?.[0] ?? deployment.offerPieces?.[0]?.instanceId,
              expectedDeploymentRevision: deployment.revision, ...(position ? { toX: position.x, toY: position.y } : {}) }
          : humanState.turn.phase === 'action' && !hasPendingInput
          ? { type: 'endTurn', playerId: 'human' }
          : planBotActions(humanState, 'human')?.actions[0]
        expect(action, `human input at step ${step}`).toBeDefined()
        const clientActionId = `pve-${difficulty}-human-${step}`
        const receipt = nextMessage(room, BATTLE_RECEIPT_MESSAGE, message => message.receipt?.clientActionId === clientActionId)
        room.send(BATTLE_COMMAND_MESSAGE, {
          protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION, authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
          roomId: room.roomId, playerId: 'human', expectedAuthorityVersion: snapshot.authorityVersion, clientActionId,
          command: { ...action, playerId: 'human', clientActionId },
        })
        expect(await receipt, `${difficulty} human step ${step}`).toMatchObject({ kind: 'applied' })
        const refreshed = nextMessage(room, BATTLE_SNAPSHOT_MESSAGE)
        room.send(BATTLE_RESYNC_MESSAGE, {})
        snapshot = await refreshed
      }
      await vi.waitFor(() => {
        const actions = repository.batches.flat().map(job => job.transition.command)
        expect(actions).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'deployReservePiece', playerId: 'bot' }),
          expect.objectContaining({ type: 'endTurn', playerId: 'bot' }),
        ]))
      }, { timeout: 90_000, interval: 100 })
      let restored = await repository.restoreRoom(room.roomId)
      await vi.waitFor(async () => {
        restored = await repository.restoreRoom(room!.roomId)
        expect((restored?.room.battleState as unknown as { state: { turn: { currentPlayerId: string } } }).state.turn.currentPlayerId).toBe('human')
      }, { timeout: 10_000, interval: 50 })
      expect(restored?.room.players.find(player => player.isBot)?.botDifficulty).toBe(difficulty)
    } finally {
      if (room) await room.leave()
      await candidate.server.gracefullyShutdown(false)
      seedSource.mockRestore()
    }
  }, 120_000)

  it('isolates an incompatible durable room instead of crashing authority startup', async () => {
    const repository = new FakeAuthorityRepository()
    const incompatibleRoom = structuredClone(createDevelopmentBattleRoom('incompatible-profile-room'))
    const incompatibleCheckpoint = createInitialCheckpoint(incompatibleRoom)
    const storage = incompatibleRoom.battleState as unknown as {
      profileIdentity: { authorityContentHash: string }
    }
    storage.profileIdentity.authorityContentHash = '0'.repeat(64)
    await repository.initializeRoom(incompatibleRoom, incompatibleCheckpoint)

    const healthyRoom = createDevelopmentBattleRoom('healthy-restored-room')
    await repository.initializeRoom(healthyRoom, createInitialCheckpoint(healthyRoom))
    const logger = { error: vi.fn() }
    const journal = new PostgresAuthorityJournal(repository, { maxBatchSize: 8, maxDwellMs: 25 })
    const candidate = createColyseusBattleServer({ repository, journal, logger })
    const port = await availablePort()
    await candidate.server.listen(port, '127.0.0.1')

    try {
      await expect(candidate.restoreProductRooms()).resolves.toEqual(['healthy-restored-room'])
      await expect(fetch(`http://127.0.0.1:${port}/healthz`).then(response => response.json()))
        .resolves.toMatchObject({ ok: true, protocol: 'rvb-colyseus' })
      await expect(fetch(`http://127.0.0.1:${port}/rooms`).then(response => response.json()))
        .resolves.toEqual({ rooms: [expect.objectContaining({ id: 'healthy-restored-room' })] })
      expect(logger.error).toHaveBeenCalledWith(
        '[colyseus] durable room restore skipped',
        expect.objectContaining({
          battleId: 'incompatible-profile-room',
          code: 'PINNED_PROFILE_UNAVAILABLE',
        }),
      )
    } finally {
      await candidate.server.gracefullyShutdown(false)
    }
  }, 20_000)

  it('re-registers a durable PostgreSQL room so players can joinById after authority restart', async () => {
    const repository = new FakeAuthorityRepository()
    const profileIdentity = getServerGameProfileIdentityV1()
    const persistedRoom = createDevelopmentBattleRoom('red161-restored-room')
    persistedRoom.players.forEach(player => { player.profileIdentity = profileIdentity })
    await repository.initializeRoom(persistedRoom, createInitialCheckpoint(persistedRoom))
    const journal = new PostgresAuthorityJournal(repository, { maxBatchSize: 8, maxDwellMs: 25 })
    const candidate = createColyseusBattleServer({ repository, journal })
    const port = await availablePort()
    await candidate.server.listen(port, '127.0.0.1')
    const client = new ColyseusClient(`ws://127.0.0.1:${port}`)
    let restoredRoom: ColyseusClientRoom | undefined
    try {
      await expect(candidate.restoreProductRooms()).resolves.toEqual(['red161-restored-room'])
      await expect(fetch(`http://127.0.0.1:${port}/rooms`).then(response => response.json()))
        .resolves.toEqual({ rooms: expect.arrayContaining([expect.objectContaining({ id: 'red161-restored-room' })]) })
      restoredRoom = await client.joinById('red161-restored-room', {
        product: true,
        playerId: 'player-red',
        playerName: 'Red',
        profileIdentity,
      })
      await expect(requestRoomRpc(restoredRoom, 'rooms.get', { roomId: restoredRoom.roomId }))
        .resolves.toMatchObject({ id: 'red161-restored-room', status: 'in-progress' })
    } finally {
      if (restoredRoom) await restoredRoom.leave()
      await candidate.server.gracefullyShutdown(false)
    }
  }, 20_000)

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
      activeRoom.reconnection.minUptime = 0
      activeRoom.reconnection.minDelay = 10
      activeRoom.reconnection.maxDelay = 50
      const resumedSnapshot = nextMessage(activeRoom, BATTLE_SNAPSHOT_MESSAGE)
      const resumed = nextReconnect(activeRoom)
      void activeRoom.leave(false)
      await resumed
      await expect(resumedSnapshot).resolves.toMatchObject({
        authorityVersion: 0,
        stateHash: activePlayerId === 'player-red' ? redInitial.stateHash : blueInitial.stateHash,
        state: { deployment: activeState.deployment },
        turnTimer: {
          status: 'running',
          deadlineAt: activePlayerId === 'player-red'
            ? redInitial.turnTimer?.deadlineAt
            : blueInitial.turnTimer?.deadlineAt,
        },
      })
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
  return room.request(PRODUCT_ROOM_RPC_MESSAGE, { method, data }, { timeout: 5_000 }) as Promise<TestRoomSnapshot>
}

function nextReconnect(room: ColyseusClientRoom): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for native reconnection')), 5_000)
    room.onReconnect.once(() => {
      clearTimeout(timeout)
      resolve()
    })
  })
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
  stateHash?: string
  data?: unknown
  error?: string
  ok?: boolean
  receipt?: { clientActionId?: string; status?: string }
  requestId?: string
  room?: { status?: string }
  turnTimer?: { status?: string; deadlineAt?: number; remainingSeconds?: number }
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
