import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { hashPublicBattleState } from '@/lib/game/battle-public-patch'
const originalDatabaseUrl = process.env.DATABASE_URL
const originalAsyncFlag = process.env.RVB_BATTLE_ASYNC_JOURNAL
const originalAuthorityFlag = process.env.RVB_BATTLE_AUTHORITY_V2
const temporaryDirectories: string[] = []
const activePrismaClients: Array<{ $disconnect: () => Promise<void> }> = []

afterAll(async () => {
  await Promise.allSettled(activePrismaClients.map(client => client.$disconnect()))
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDatabaseUrl
  if (originalAsyncFlag === undefined) delete process.env.RVB_BATTLE_ASYNC_JOURNAL
  else process.env.RVB_BATTLE_ASYNC_JOURNAL = originalAsyncFlag
  if (originalAuthorityFlag === undefined) delete process.env.RVB_BATTLE_AUTHORITY_V2
  else process.env.RVB_BATTLE_AUTHORITY_V2 = originalAuthorityFlag
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('battle authority async SQLite persistence', () => {
  it('drains ordered deltas and restores the durable state from a real database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rvb-red109-sqlite-'))
    temporaryDirectories.push(directory)
    process.env.DATABASE_URL = `file:${join(directory, 'authority.db').replaceAll('\\', '/')}`
    process.env.RVB_BATTLE_AUTHORITY_V2 = '1'
    process.env.RVB_BATTLE_ASYNC_JOURNAL = '1'
    vi.resetModules()
    resetAuthorityGlobals()

    const { PrismaClient } = await import('@prisma/client')
    const setup = new PrismaClient()
    await createAuthoritySchema(setup)
    await setup.$disconnect()

    const [{ prisma }, roomStoreModule, actions, trace, deployment, runtime, helpers, persistence] = await Promise.all([
      import('@/lib/db'),
      import('@/lib/game/room-store'),
      import('@/lib/game/room-battle-actions'),
      import('@/lib/game/battle-trace'),
      import('@/lib/game/deployment'),
      import('@/lib/game/rule-runtime'),
      import('../helpers/minimal-state'),
      import('@/lib/server/battle-authority-persistence'),
    ])
    const store = new roomStoreModule.RoomStore()
    activePrismaClients.push(prisma)
    const room = makeRoom(helpers.makeState, helpers.makePiece, trace.recordBattleInitialization, runtime.RuleRuntime)
    await store.setRoom(room.id, room)
    const storage = room.battleState as unknown as { type: 'server-state'; seed: number; state: unknown }
    await store.initializeBattleAuthorityCheckpoint({
      room,
      storage: storage as never,
      stateHash: trace.hashBattleState(storage.state as never),
      publicHash: hashPublicBattleState(actions.createPublicBattleSnapshot(
        persistence.getRememberedBattleAuthorityRoom(room.id) ?? room,
      ).state),
    })

    let lastHash = ''
    for (let index = 0; index < 20; index += 1) {
      const current = await store.getRoom(room.id)
      const result = await actions.dispatchRoomBattleAction(
        store,
        room.id,
        'player-red',
        {
          type: 'deploymentChoice',
          playerId: 'player-red',
          pieceId: index % 2 === 0 ? 'piece-red' : null,
          clientActionId: `sqlite-action-${index + 1}`,
        },
        {
          expectedAuthorityVersion: current?.battleAuthorityVersion,
          clock: { now: () => 2_000 },
        },
      )
      expect(result.kind).toBe('applied')
      lastHash = result.snapshot.stateHash
    }

    await store.drainBattleAuthorityPersistence(room.id)
    const durableRoom = await prisma.room.findUniqueOrThrow({ where: { id: room.id } })
    expect(durableRoom.battleAuthorityVersion).toBe(20)
    expect(await prisma.battleAuthorityTransition.count({ where: { roomId: room.id } })).toBe(20)
    expect(await prisma.battleAuthorityReceipt.count({ where: { roomId: room.id } })).toBe(20)
    expect(await prisma.battleAuthorityCheckpoint.count({ where: { roomId: room.id } })).toBe(2)

    persistence.forgetBattleAuthorityRoom(room.id)
    const restored = await store.getRoom(room.id)
    expect(restored?.battleAuthorityVersion).toBe(20)
    expect(actions.createPublicBattleSnapshot(restored!).stateHash).toBe(lastHash)
    expect(store.inspectBattleAuthorityPersistence(room.id)).toMatchObject({
      status: 'durable',
      durableAuthorityVersion: 20,
      authorityVersion: 20,
      pending: 0,
    })
    expect(deployment.toPublicBattleState(
      (restored?.battleState as unknown as { state: unknown }).state as never,
    )).toBeDefined()

    await prisma.$disconnect()
    resetAuthorityGlobals()
  }, 30_000)

  it('contains a real SQLite lock failure to one room without overlapping the next room write', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rvb-red109-sqlite-lock-'))
    temporaryDirectories.push(directory)
    process.env.DATABASE_URL = `file:${join(directory, 'authority.db').replaceAll('\\', '/')}`
    process.env.RVB_BATTLE_AUTHORITY_V2 = '1'
    process.env.RVB_BATTLE_ASYNC_JOURNAL = '1'
    vi.resetModules()
    resetAuthorityGlobals()

    const { PrismaClient } = await import('@prisma/client')
    const setup = new PrismaClient()
    await createAuthoritySchema(setup)
    await setup.$disconnect()

    const [{ prisma }, roomStoreModule, actions, trace, runtime, helpers, persistence] = await Promise.all([
      import('@/lib/db'),
      import('@/lib/game/room-store'),
      import('@/lib/game/room-battle-actions'),
      import('@/lib/game/battle-trace'),
      import('@/lib/game/rule-runtime'),
      import('../helpers/minimal-state'),
      import('@/lib/server/battle-authority-persistence'),
    ])
    const store = new roomStoreModule.RoomStore()
    activePrismaClients.push(prisma)
    const roomA = makeRoom(
      helpers.makeState,
      helpers.makePiece,
      trace.recordBattleInitialization,
      runtime.RuleRuntime,
      'red109-sqlite-lock-a',
    )
    const roomB = makeRoom(
      helpers.makeState,
      helpers.makePiece,
      trace.recordBattleInitialization,
      runtime.RuleRuntime,
      'red109-sqlite-lock-b',
    )
    for (const room of [roomA, roomB]) {
      await store.setRoom(room.id, room)
      const storage = room.battleState as unknown as { type: 'server-state'; seed: number; state: unknown }
      await store.initializeBattleAuthorityCheckpoint({
        room,
        storage: storage as never,
        stateHash: trace.hashBattleState(storage.state as never),
        publicHash: hashPublicBattleState(actions.createPublicBattleSnapshot(
          persistence.getRememberedBattleAuthorityRoom(room.id) ?? room,
        ).state),
      })
    }

    const locker = new PrismaClient()
    activePrismaClients.push(locker)
    let releaseLock!: () => void
    let signalLockReady!: () => void
    const lockReady = new Promise<void>(resolve => { signalLockReady = resolve })
    const lockPromise = locker.$transaction(async transaction => {
      await transaction.room.update({
        where: { id: roomA.id },
        data: { name: `${roomA.name}-locked` },
      })
      signalLockReady()
      await new Promise<void>(resolve => { releaseLock = resolve })
    }, { maxWait: 250, timeout: 10_000 })
    await lockReady

    for (const room of [roomA, roomB]) {
      const result = await actions.dispatchRoomBattleAction(
        store,
        room.id,
        'player-red',
        {
          type: 'deploymentChoice',
          playerId: 'player-red',
          pieceId: 'piece-red',
          clientActionId: `${room.id}-action-1`,
        },
        {
          expectedAuthorityVersion: 0,
          clock: { now: () => 2_000 },
        },
      )
      expect(result.kind).toBe('applied')
    }

    try {
      await vi.waitFor(() => {
        expect(persistence.inspectBattleAuthorityPersistence(roomA.id).status).toBe('degraded')
      }, { timeout: 8_000 })
      expect(persistence.inspectBattleAuthorityPersistence(roomB.id).status).toBe('pending')
    } finally {
      releaseLock()
      await lockPromise
    }

    await persistence.drainBattleAuthorityPersistence(roomB.id)
    const roomAPersistence = persistence.inspectBattleAuthorityPersistence(roomA.id)
    expect(roomAPersistence).toMatchObject({
      status: 'degraded',
      durableAuthorityVersion: 0,
      authorityVersion: 1,
      pending: 0,
    })
    expect(roomAPersistence.lastError).not.toContain('journal persist timed out')
    expect(persistence.inspectBattleAuthorityPersistence(roomB.id)).toMatchObject({
      status: 'durable',
      durableAuthorityVersion: 1,
      authorityVersion: 1,
      pending: 0,
    })
    await expect(prisma.room.findUniqueOrThrow({ where: { id: roomA.id } }))
      .resolves.toMatchObject({ battleAuthorityVersion: 0 })
    await expect(prisma.room.findUniqueOrThrow({ where: { id: roomB.id } }))
      .resolves.toMatchObject({ battleAuthorityVersion: 1 })

    await prisma.$disconnect()
    await locker.$disconnect()
    resetAuthorityGlobals()
  }, 20_000)
})

function makeRoom(
  makeState: typeof import('../helpers/minimal-state').makeState,
  makePiece: typeof import('../helpers/minimal-state').makePiece,
  recordBattleInitialization: typeof import('@/lib/game/battle-trace').recordBattleInitialization,
  RuleRuntime: typeof import('@/lib/game/rule-runtime').RuleRuntime,
  roomId = 'red109-real-sqlite',
) {
  const state = makeState({
    pieces: [
      Object.assign(
        makePiece({ instanceId: 'piece-red', ownerPlayerId: 'player-red', faction: 'red', x: 1, y: 1 }),
        { isCore: true },
      ),
      Object.assign(
        makePiece({ instanceId: 'piece-blue', ownerPlayerId: 'player-blue', faction: 'blue', x: 8, y: 8 }),
        { isCore: true },
      ),
    ] as never[],
    phase: 'start',
  }) as import('@/lib/game/turn').BattleState
  ;(state as import('@/lib/game/turn').BattleState & { deployment: unknown }).deployment = {
    status: 'awaiting-locks',
    playerIds: ['player-red', 'player-blue'],
    choices: {},
    locks: {
      'player-red': { locked: false },
      'player-blue': { locked: false },
    },
    startedAt: 1_000,
    deadlineAt: 46_000,
    revision: 0,
    initialPositions: {
      'piece-red': { x: 1, y: 1 },
      'piece-blue': { x: 8, y: 8 },
    },
  }
  recordBattleInitialization(state, new RuleRuntime({ rootSeed: 109 }), ['player-red', 'player-blue'])
  return {
    id: roomId,
    name: roomId,
    status: 'in-progress' as const,
    players: [
      { id: 'player-red', name: 'Red', seat: 'red' as const, alignment: 'light' as const },
      { id: 'player-blue', name: 'Blue', seat: 'blue' as const, alignment: 'dark' as const },
    ],
    spectators: [],
    currentTurnIndex: 0,
    actions: [],
    version: 0,
    battleAuthorityVersion: 0,
    battleState: { type: 'server-state', seed: 109, state } as unknown as import('@/lib/game/room-store').Room['battleState'],
  }
}

async function createAuthoritySchema(prisma: import('@prisma/client').PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE TABLE "Room" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "mapId" TEXT,
    "hostId" TEXT,
    "visibility" TEXT,
    "maxPlayers" INTEGER,
    "players" TEXT NOT NULL DEFAULT '[]',
    "spectators" TEXT NOT NULL DEFAULT '[]',
    "battleState" TEXT,
    "inviteCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "battleAuthorityVersion" INTEGER NOT NULL DEFAULT 0,
    "battleAuthorityTransitionHash" TEXT NOT NULL DEFAULT ''
  )`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "BattleAuthorityTransition" (
    "roomId" TEXT NOT NULL,
    "fromVersion" INTEGER NOT NULL,
    "toVersion" INTEGER NOT NULL,
    "protocolVersion" INTEGER NOT NULL,
    "clientActionId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "commandJson" TEXT NOT NULL,
    "internalPatch" TEXT NOT NULL,
    "publicPatch" TEXT NOT NULL,
    "preStateHash" TEXT NOT NULL,
    "postStateHash" TEXT NOT NULL,
    "prePublicHash" TEXT NOT NULL,
    "postPublicHash" TEXT NOT NULL,
    "actionHash" TEXT NOT NULL,
    "previousTransitionHash" TEXT NOT NULL,
    "transitionHash" TEXT NOT NULL,
    "pendingJson" TEXT,
    "traceJson" TEXT,
    "replayFrameJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("roomId", "toVersion"),
    UNIQUE ("roomId", "clientActionId")
  )`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "BattleAuthorityReceipt" (
    "roomId" TEXT NOT NULL,
    "clientActionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "authorityVersion" INTEGER NOT NULL,
    "code" TEXT,
    "message" TEXT,
    "receiptJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("roomId", "clientActionId")
  )`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "BattleAuthorityCheckpoint" (
    "roomId" TEXT NOT NULL,
    "authorityVersion" INTEGER NOT NULL,
    "protocolVersion" INTEGER NOT NULL,
    "seed" INTEGER NOT NULL,
    "stateJson" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "publicHash" TEXT NOT NULL,
    "transitionHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("roomId", "authorityVersion")
  )`)
}

function resetAuthorityGlobals(): void {
  const globals = globalThis as Record<string, unknown>
  delete globals.prisma
  delete globals.__rvbAuthorityRoomCacheV2
  delete globals.__rvbAuthorityReceiptCacheV2
  delete globals.__rvbAuthorityHistoryCacheV2
  delete globals.__rvbAuthorityAsyncJournalV2
}
