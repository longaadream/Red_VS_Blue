import { prisma } from '../db'
import {
  BattleAuthorityAsyncJournal,
  type BattleAuthorityJournalInspection,
} from './battle-authority-async-journal'
import { installNativeBattleSha256 } from './battle-hash'
import { hashPublicBattleState } from '../game/battle-public-patch'
import { getBattleStorage } from '../game/battle-storage'
import {
  hashStable,
  materializeBattleTraceForTerminal,
  type BattleActionTrace,
  type BattleReplayFrame,
} from '../game/battle-trace'
import type { ServerBattleState } from '../game/battle-storage'
import {
  assertBattleAuthorityRestoreCheckpoint,
  createBattleAuthorityGenesisHash,
  hashBattleAuthorityAction,
  hashBattleAuthorityTransition,
  isBattleAuthorityAsyncJournalEnabled,
  isBattleAuthorityV2Enabled,
  replayBattleAuthorityTransitions,
  roomBattleAuthorityVersion,
  type BattleAuthorityCheckpointRecord,
  type BattleAuthorityReceipt,
  type BattleAuthorityTransitionRecord,
} from '../game/battle-transition'
import type { Room } from '../game/room-store'
import type { BattleState } from '../game/turn'

installNativeBattleSha256()

interface CachedAuthorityRoom {
  version: number
  room: Room
}

interface CachedAuthorityHistory {
  hydrated: boolean
  transitions: BattleAuthorityTransitionRecord[]
}

const persistenceGlobal = globalThis as typeof globalThis & {
  __rvbAuthorityRoomCacheV2?: Map<string, CachedAuthorityRoom>
  __rvbAuthorityReceiptCacheV2?: Map<string, Map<string, BattleAuthorityReceipt>>
  __rvbAuthorityHistoryCacheV2?: Map<string, CachedAuthorityHistory>
  __rvbAuthorityAsyncJournalV2?: BattleAuthorityAsyncJournal
  __rvbAuthoritySqliteWalPromiseV2?: Promise<void>
}

const authorityRoomCache = (
  persistenceGlobal.__rvbAuthorityRoomCacheV2 ??= new Map<string, CachedAuthorityRoom>()
)
const authorityReceiptCache = (
  persistenceGlobal.__rvbAuthorityReceiptCacheV2 ??= new Map<string, Map<string, BattleAuthorityReceipt>>()
)
const authorityHistoryCache = (
  persistenceGlobal.__rvbAuthorityHistoryCacheV2 ??= new Map<string, CachedAuthorityHistory>()
)
const authorityAsyncJournal = (
  persistenceGlobal.__rvbAuthorityAsyncJournalV2 ??= new BattleAuthorityAsyncJournal({
    isRetryablePersistError: isRetryableBattleAuthorityPersistenceError,
    onStateChange: updateCachedPersistenceState,
  })
)
const BATTLE_AUTHORITY_SQLITE_BUSY_TIMEOUT_MS = 500
const BATTLE_AUTHORITY_PRISMA_TRANSACTION_OPTIONS = {
  maxWait: 250,
  timeout: 1_250,
} as const

export interface CommitBattleAuthorityTransitionInput {
  roomId: string
  expectedVersion: number
  nextRoom: Room
  transition: BattleAuthorityTransitionRecord
  transitionPreStateHash: string
  runnerPreStateHash: string
  runnerPostStateHash: string
  baseCheckpoint?: BattleAuthorityCheckpointRecord
  checkpoint?: BattleAuthorityCheckpointRecord
}

export interface BattleAuthorityPersistenceInspection extends BattleAuthorityJournalInspection {
  authorityVersion: number
}

export function getRememberedBattleAuthorityRoom(roomId: string): Room | undefined {
  const cached = authorityRoomCache.get(normalizeRoomId(roomId))
  return cached ? clone(cached.room) : undefined
}

export function inspectBattleAuthorityPersistence(
  roomId: string,
): BattleAuthorityPersistenceInspection {
  const normalizedRoomId = normalizeRoomId(roomId)
  const journal = authorityAsyncJournal.inspect(normalizedRoomId)
  return {
    ...journal,
    authorityVersion: authorityRoomCache.get(normalizedRoomId)?.version
      ?? journal.durableAuthorityVersion,
  }
}

export function drainBattleAuthorityPersistence(roomId?: string): Promise<void> {
  return authorityAsyncJournal.drain(roomId)
}

export function beginBattleAuthorityPersistenceShutdown(): void {
  authorityAsyncJournal.closeIngress()
}

export async function drainBattleAuthorityPersistenceForShutdown(): Promise<void> {
  authorityAsyncJournal.closeIngress()
  await authorityAsyncJournal.drain()
  for (const [roomId, cached] of authorityRoomCache) {
    const persistence = authorityAsyncJournal.inspect(roomId)
    if (
      persistence.status !== 'durable'
      || persistence.pending !== 0
      || persistence.durableAuthorityVersion !== cached.version
    ) {
      throw new Error(
        `Battle authority shutdown drain incomplete in ${roomId}: authority=${cached.version} durable=${persistence.durableAuthorityVersion} status=${persistence.status}`,
      )
    }
  }
}

export async function getBattleAuthorityReceipt(
  roomId: string,
  clientActionId: string,
): Promise<BattleAuthorityReceipt | undefined> {
  const normalizedRoomId = normalizeRoomId(roomId)
  const cachedReceipts = authorityReceiptCache.get(normalizedRoomId)
  const cached = cachedReceipts?.get(clientActionId)
  if (cached) return clone(cached)
  if (isBattleAuthorityAsyncJournalEnabled() && authorityHistoryCache.get(normalizedRoomId)?.hydrated) {
    return undefined
  }
  const row = await prisma.battleAuthorityReceipt.findUnique({
    where: {
      roomId_clientActionId: {
        roomId: normalizedRoomId,
        clientActionId,
      },
    },
  })
  if (!row) return undefined
  const receipt = JSON.parse(row.receiptJson) as BattleAuthorityReceipt
  rememberAuthorityReceipt(receipt)
  return clone(receipt)
}

export async function persistBattleAuthorityReceipt(receipt: BattleAuthorityReceipt): Promise<void> {
  rememberAuthorityReceipt(receipt)
  if (isBattleAuthorityAsyncJournalEnabled()) {
    const accepted = authorityAsyncJournal.enqueue({
      roomId: receipt.roomId,
      kind: 'receipt',
      clientActionId: receipt.clientActionId,
      persist: () => persistBattleAuthorityReceiptAtomic(receipt),
    })
    if (!accepted) {
      console.error('[battle-authority-persistence] async journal rejected receipt', {
        roomId: normalizeRoomId(receipt.roomId),
        clientActionId: receipt.clientActionId,
        persistence: authorityAsyncJournal.inspect(receipt.roomId),
      })
    }
    return
  }
  await persistBattleAuthorityReceiptAtomic(receipt)
}

async function persistBattleAuthorityReceiptAtomic(receipt: BattleAuthorityReceipt): Promise<void> {
  await setBattleAuthoritySqliteBusyTimeout()
  await prisma.$transaction(async transaction => {
    await transaction.battleAuthorityReceipt.upsert({
      where: {
        roomId_clientActionId: {
          roomId: normalizeRoomId(receipt.roomId),
          clientActionId: receipt.clientActionId,
        },
      },
      update: {},
      create: {
        roomId: normalizeRoomId(receipt.roomId),
        clientActionId: receipt.clientActionId,
        status: receipt.status,
        authorityVersion: receipt.authorityVersion,
        code: receipt.code,
        message: receipt.message,
        receiptJson: JSON.stringify(receipt),
      },
    })
  }, BATTLE_AUTHORITY_PRISMA_TRANSACTION_OPTIONS)
}

export async function commitBattleAuthorityTransition(
  input: CommitBattleAuthorityTransitionInput,
): Promise<boolean> {
  if (isBattleAuthorityAsyncJournalEnabled()) {
    assertBattleAuthorityTransitionMetadata(input)
    return commitBattleAuthorityTransitionInMemory(input)
  }
  return persistBattleAuthorityTransitionAtomic(input)
}

async function persistBattleAuthorityTransitionAtomic(input: CommitBattleAuthorityTransitionInput): Promise<boolean> {
  const roomId = assertBattleAuthorityTransitionMetadata(input)
  const transition = input.transition
  // Prepare every JSON payload before opening the SQLite write transaction.
  // The async journal already keeps this work off the ACK path; doing it here
  // also keeps serialization and full-checkpoint cloning out of the lock hold.
  const payload = {
    roomBattleState: input.checkpoint ? JSON.stringify(input.checkpoint.storage) : undefined,
    baseCheckpointState: input.baseCheckpoint ? JSON.stringify(input.baseCheckpoint.storage) : undefined,
    commandJson: JSON.stringify(transition.commands),
    internalPatch: JSON.stringify(transition.internalPatch),
    publicPatch: JSON.stringify(transition.publicPatch),
    pendingJson: transition.pending ? JSON.stringify(transition.pending) : null,
    traceJson: transition.traces.length > 0 ? JSON.stringify(transition.traces) : null,
    replayFrameJson: transition.replayFrames.length > 0 ? JSON.stringify(transition.replayFrames) : null,
    receiptJson: JSON.stringify(transition.receipt),
    checkpointState: input.checkpoint ? JSON.stringify(input.checkpoint.storage) : undefined,
    baseCheckpointSeed: input.baseCheckpoint ? encodeBattleAuthorityCheckpointSeed(input.baseCheckpoint.seed) : undefined,
    checkpointSeed: input.checkpoint ? encodeBattleAuthorityCheckpointSeed(input.checkpoint.seed) : undefined,
  }
  await setBattleAuthoritySqliteBusyTimeout()
  const committed = await prisma.$transaction(async transaction => {
    const result = await transaction.room.updateMany({
      where: {
        id: roomId,
        battleAuthorityVersion: input.expectedVersion,
        battleAuthorityTransitionHash: input.expectedVersion === 0
          ? { in: ['', transition.previousTransitionHash] }
          : transition.previousTransitionHash,
      },
      data: {
        status: input.nextRoom.status,
        ...(payload.roomBattleState ? { battleState: payload.roomBattleState } : {}),
        battleAuthorityVersion: { increment: 1 },
        battleAuthorityTransitionHash: transition.transitionHash,
      },
    })
    if (result.count === 0) return false

    if (input.baseCheckpoint) {
      const base = input.baseCheckpoint
      await transaction.battleAuthorityCheckpoint.upsert({
        where: { roomId_authorityVersion: { roomId, authorityVersion: base.authorityVersion } },
        update: {},
        create: {
          roomId,
          authorityVersion: base.authorityVersion,
          protocolVersion: base.protocolVersion,
          seed: payload.baseCheckpointSeed!,
          stateJson: payload.baseCheckpointState!,
          stateHash: base.stateHash,
          publicHash: base.publicHash,
          transitionHash: base.transitionHash,
          reason: base.reason,
        },
      })
    }

    await transaction.battleAuthorityTransition.create({
      data: {
        roomId,
        fromVersion: transition.fromVersion,
        toVersion: transition.toVersion,
        protocolVersion: transition.protocolVersion,
        clientActionId: transition.clientActionId,
        playerId: transition.playerId,
        commandJson: payload.commandJson,
        internalPatch: payload.internalPatch,
        publicPatch: payload.publicPatch,
        preStateHash: transition.preStateHash,
        postStateHash: transition.postStateHash,
        prePublicHash: transition.prePublicHash,
        postPublicHash: transition.postPublicHash,
        actionHash: transition.actionHash,
        previousTransitionHash: transition.previousTransitionHash,
        transitionHash: transition.transitionHash,
        pendingJson: payload.pendingJson,
        traceJson: payload.traceJson,
        replayFrameJson: payload.replayFrameJson,
      },
    })
    await transaction.battleAuthorityReceipt.create({
      data: {
        roomId,
        clientActionId: transition.clientActionId,
        status: transition.receipt.status,
        authorityVersion: transition.receipt.authorityVersion,
        code: transition.receipt.code,
        message: transition.receipt.message,
        receiptJson: payload.receiptJson,
      },
    })
    if (input.checkpoint) {
      await transaction.battleAuthorityCheckpoint.create({
        data: {
          roomId,
          authorityVersion: input.checkpoint.authorityVersion,
          protocolVersion: input.checkpoint.protocolVersion,
          seed: payload.checkpointSeed!,
          stateJson: payload.checkpointState!,
          stateHash: input.checkpoint.stateHash,
          publicHash: input.checkpoint.publicHash,
          transitionHash: input.checkpoint.transitionHash,
          reason: input.checkpoint.reason,
        },
      })
    }
    return true
  }, BATTLE_AUTHORITY_PRISMA_TRANSACTION_OPTIONS)
  if (committed) {
    rememberBattleAuthorityRoom({
      ...input.nextRoom,
      battleAuthorityVersion: input.expectedVersion + 1,
      battleAuthorityTransitionHash: input.transition.transitionHash,
    })
  }
  return committed
}

async function setBattleAuthoritySqliteBusyTimeout(): Promise<void> {
  await ensureBattleAuthoritySqliteWal()
  await prisma.$queryRawUnsafe(`PRAGMA busy_timeout = ${BATTLE_AUTHORITY_SQLITE_BUSY_TIMEOUT_MS}`)
}

async function ensureBattleAuthoritySqliteWal(): Promise<void> {
  const existing = persistenceGlobal.__rvbAuthoritySqliteWalPromiseV2
  if (existing) return existing
  const configuring = (async () => {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL')
  })()
  persistenceGlobal.__rvbAuthoritySqliteWalPromiseV2 = configuring
  try {
    await configuring
  } catch (error) {
    if (persistenceGlobal.__rvbAuthoritySqliteWalPromiseV2 === configuring) {
      delete persistenceGlobal.__rvbAuthoritySqliteWalPromiseV2
    }
    throw error
  }
}

export function isRetryableBattleAuthorityPersistenceError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'BattleAuthorityJournalPersistTimeoutError') {
    return true
  }
  const candidate = error as { code?: unknown; message?: unknown }
  const code = typeof candidate?.code === 'string' ? candidate.code.toUpperCase() : ''
  if (['P1008', 'P2024', 'P2028', 'P2034', 'SQLITE_BUSY', 'SQLITE_LOCKED'].includes(code)) {
    return true
  }
  const message = typeof candidate?.message === 'string' ? candidate.message : String(error ?? '')
  return /\b(?:SQLITE_BUSY|SQLITE_LOCKED)\b|database (?:is )?(?:busy|locked)|timed?\s*out|transaction already closed|write conflict|deadlock/i.test(message)
}

function encodeBattleAuthorityCheckpointSeed(seed: number): number {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error(`Battle authority checkpoint seed must be an unsigned 32-bit integer, got ${seed}`)
  }
  return seed > 0x7fff_ffff ? seed - 0x1_0000_0000 : seed
}

function decodeBattleAuthorityCheckpointSeed(seed: number): number {
  if (!Number.isSafeInteger(seed) || seed < -0x8000_0000 || seed > 0x7fff_ffff) {
    throw new Error(`Stored battle authority checkpoint seed is not a signed 32-bit integer: ${seed}`)
  }
  return seed >>> 0
}

function assertBattleAuthorityCheckpointSeed(
  roomId: string,
  authorityVersion: number,
  persistedSeed: number,
  storageSeed: number,
): void {
  const decodedSeed = decodeBattleAuthorityCheckpointSeed(persistedSeed)
  if (
    !Number.isSafeInteger(storageSeed)
    || storageSeed < 0
    || storageSeed > 0xffff_ffff
    || storageSeed !== decodedSeed
  ) {
    throw new Error(`Battle authority checkpoint seed mismatch in ${roomId} at ${authorityVersion}`)
  }
}

function assertBattleAuthorityTransitionMetadata(input: CommitBattleAuthorityTransitionInput): string {
  const roomId = normalizeRoomId(input.roomId)
  if (
    input.nextRoom.id.trim().toLowerCase() !== roomId
    || input.transition.roomId !== roomId
    || input.transition.fromVersion !== input.expectedVersion
    || input.transition.toVersion !== input.expectedVersion + 1
    || input.transition.receipt.authorityVersion !== input.transition.toVersion
    || (input.baseCheckpoint && (
      input.baseCheckpoint.roomId !== roomId
      || input.baseCheckpoint.authorityVersion !== input.expectedVersion
      || input.baseCheckpoint.stateHash !== input.transition.preStateHash
      || input.baseCheckpoint.publicHash !== input.transition.prePublicHash
      || input.baseCheckpoint.transitionHash !== input.transition.previousTransitionHash
    ))
    || (input.checkpoint && (
      input.checkpoint.roomId !== roomId
      || input.checkpoint.authorityVersion !== input.transition.toVersion
      || input.checkpoint.stateHash !== input.transition.postStateHash
      || input.checkpoint.publicHash !== input.transition.postPublicHash
      || input.checkpoint.transitionHash !== input.transition.transitionHash
    ))
  ) {
    throw new Error('Battle authority transition metadata does not match the atomic commit boundary')
  }
  return roomId
}

function commitBattleAuthorityTransitionInMemory(
  input: CommitBattleAuthorityTransitionInput,
): boolean {
  if (!authorityAsyncJournal.isAccepting()) return false
  const roomId = normalizeRoomId(input.roomId)
  const cached = authorityRoomCache.get(roomId)
  if (!cached || cached.version !== input.expectedVersion) return false
  assertInMemoryBattleAuthorityAckBoundary(input, cached)

  const committedRoom: Room = {
    ...input.nextRoom,
    battleAuthorityVersion: input.transition.toVersion,
    battleAuthorityTransitionHash: input.transition.transitionHash,
  }
  const accepted = authorityAsyncJournal.enqueue({
    roomId,
    kind: 'transition',
    authorityVersion: input.transition.toVersion,
    clientActionId: input.transition.clientActionId,
    audit: () => auditInMemoryBattleAuthorityTransition(input, cached),
    persist: async () => {
      const durable = await persistBattleAuthorityTransitionAtomic(input)
      if (durable) return
      const existing = await prisma.battleAuthorityTransition.findUnique({
        where: {
          roomId_toVersion: {
            roomId,
            toVersion: input.transition.toVersion,
          },
        },
      })
      if (
        existing?.clientActionId === input.transition.clientActionId
        && existing.transitionHash === input.transition.transitionHash
      ) return
      throw new Error(
        `Battle authority durable version conflict in ${roomId} at ${input.transition.toVersion}`,
      )
    },
  })
  if (!accepted) {
    console.error('[battle-authority-persistence] async journal rejected transition', {
      roomId,
      authorityVersion: input.transition.toVersion,
      clientActionId: input.transition.clientActionId,
      persistence: authorityAsyncJournal.inspect(roomId),
    })
    return false
  }
  rememberAuthorityReceipt(input.transition.receipt)
  rememberAuthorityTransition(input.transition)
  rememberBattleAuthorityRoom(committedRoom)
  return true
}

function assertInMemoryBattleAuthorityAckBoundary(
  input: CommitBattleAuthorityTransitionInput,
  cached: CachedAuthorityRoom,
): void {
  const roomId = normalizeRoomId(input.roomId)
  const transition = input.transition
  const cachedTransitionHash = cached.room.battleAuthorityTransitionHash ?? ''
  if (cachedTransitionHash !== transition.previousTransitionHash) {
    throw new Error(
      `Battle authority in-memory chain mismatch in ${roomId} at ${transition.toVersion}: cached=${cachedTransitionHash} transition=${transition.previousTransitionHash}`,
    )
  }
  if (
    input.nextRoom.battleAuthorityTransitionHash !== transition.transitionHash
    || transition.receipt.roomId !== roomId
    || transition.receipt.clientActionId !== transition.clientActionId
  ) {
    throw new Error(
      `Battle authority in-memory receipt or next-room metadata mismatch in ${roomId} at ${transition.toVersion}`,
    )
  }
  const expectedActionHash = hashBattleAuthorityAction(transition)
  if (transition.actionHash !== expectedActionHash) {
    throw new Error(`Battle authority action hash mismatch in ${roomId} at ${transition.toVersion}`)
  }
  const expectedTransitionHash = hashBattleAuthorityTransition(transition)
  if (transition.transitionHash !== expectedTransitionHash) {
    throw new Error(`Battle authority transition hash mismatch in ${roomId} at ${transition.toVersion}`)
  }
  if (
    !input.transitionPreStateHash
    || !input.runnerPreStateHash
    || !input.runnerPostStateHash
    || transition.preStateHash !== input.transitionPreStateHash
    || transition.postStateHash !== input.runnerPostStateHash
  ) {
    throw new Error(`Battle authority state hash evidence mismatch in ${roomId} at ${transition.toVersion}`)
  }
  const firstTrace = transition.traces[0]
  const lastTrace = transition.traces.at(-1)
  if (
    (firstTrace && firstTrace.preStateHash !== input.runnerPreStateHash)
    || (lastTrace && lastTrace.postStateHash !== input.runnerPostStateHash)
  ) {
    throw new Error(
      `Battle authority runner trace boundary mismatch in ${roomId} at ${transition.toVersion}: pre=${firstTrace?.preStateHash ?? 'none'}/${input.runnerPreStateHash} post=${lastTrace?.postStateHash ?? 'none'}/${input.runnerPostStateHash}`,
    )
  }

  const previousStorage = getBattleStorage(cached.room)
  const nextStorage = getBattleStorage(input.nextRoom)
  if (!previousStorage || !nextStorage) {
    throw new Error(`Battle authority in-memory state missing in ${roomId} at ${transition.toVersion}`)
  }
}

function auditInMemoryBattleAuthorityTransition(
  input: CommitBattleAuthorityTransitionInput,
  cached: CachedAuthorityRoom,
): void {
  const roomId = normalizeRoomId(input.roomId)
  const transition = input.transition
  const cachedTransitionHash = cached.room.battleAuthorityTransitionHash ?? ''
  const previousStorage = getBattleStorage(cached.room)
  const nextStorage = getBattleStorage(input.nextRoom)
  if (!previousStorage || !nextStorage) {
    throw new Error(`Battle authority in-memory state missing in ${roomId} at ${transition.toVersion}`)
  }
  const replayedStorage = replayBattleAuthorityTransitions({
    roomId,
    checkpointStorage: previousStorage,
    checkpointVersion: input.expectedVersion,
    checkpointStateHash: transition.preStateHash,
    checkpointPublicHash: transition.prePublicHash,
    checkpointTransitionHash: cachedTransitionHash,
    targetVersion: transition.toVersion,
    targetTransitionHash: transition.transitionHash,
    transitions: [transition],
  })
  if (hashStable(replayedStorage) !== hashStable(nextStorage)) {
    throw new Error(
      `Battle authority in-memory delta does not reproduce next state in ${roomId} at ${transition.toVersion}`,
    )
  }
}

export async function initializeBattleAuthorityCheckpoint(input: {
  room: Room
  storage: ServerBattleState
  stateHash: string
  publicHash: string
}): Promise<void> {
  await setBattleAuthoritySqliteBusyTimeout()
  const roomId = normalizeRoomId(input.room.id)
  const authorityVersion = roomBattleAuthorityVersion(input.room)
  const transitionHash = createBattleAuthorityGenesisHash({
    roomId,
    stateHash: input.stateHash,
    publicHash: input.publicHash,
  })
  const persistedSeed = encodeBattleAuthorityCheckpointSeed(input.storage.seed)
  await prisma.battleAuthorityCheckpoint.upsert({
    where: { roomId_authorityVersion: { roomId, authorityVersion } },
    update: {
      protocolVersion: 2,
      seed: persistedSeed,
      stateJson: JSON.stringify(input.storage),
      stateHash: input.stateHash,
      publicHash: input.publicHash,
      transitionHash,
      reason: 'initial',
    },
    create: {
      roomId,
      authorityVersion,
      protocolVersion: 2,
      seed: persistedSeed,
      stateJson: JSON.stringify(input.storage),
      stateHash: input.stateHash,
      publicHash: input.publicHash,
      transitionHash,
      reason: 'initial',
    },
  })
  authorityAsyncJournal.markDurable(roomId, authorityVersion)
  authorityReceiptCache.set(roomId, new Map())
  authorityHistoryCache.set(roomId, { hydrated: true, transitions: [] })
  rememberBattleAuthorityRoom({ ...input.room, battleAuthorityTransitionHash: transitionHash })
}

export async function restoreBattleAuthorityRoom(room: Room): Promise<Room> {
  if (!isBattleAuthorityV2Enabled()) return room

  const version = roomBattleAuthorityVersion(room)
  const roomId = normalizeRoomId(room.id)
  const cached = authorityRoomCache.get(roomId)
  if (cached?.version === version) return clone(cached.room)

  const checkpoint = assertBattleAuthorityRestoreCheckpoint(
    roomId,
    version,
    await prisma.battleAuthorityCheckpoint.findFirst({
      where: { roomId, authorityVersion: { lte: version } },
      orderBy: { authorityVersion: 'desc' },
    }) ?? undefined,
  )
  if (!checkpoint) return room

  const checkpointStorage = JSON.parse(checkpoint.stateJson) as ServerBattleState
  assertBattleAuthorityCheckpointSeed(
    roomId,
    checkpoint.authorityVersion,
    checkpoint.seed,
    checkpointStorage.seed,
  )
  const checkpointTransitionHash = checkpoint.transitionHash || (
    checkpoint.authorityVersion === 0
      ? createBattleAuthorityGenesisHash({
          roomId,
          stateHash: checkpoint.stateHash,
          publicHash: checkpoint.publicHash,
        })
      : ''
  )
  const targetTransitionHash = version === 0
    ? room.battleAuthorityTransitionHash || checkpointTransitionHash
    : room.battleAuthorityTransitionHash || ''
  const allTransitions = await prisma.battleAuthorityTransition.findMany({
    where: {
      roomId,
      toVersion: { lte: version },
    },
    orderBy: { toVersion: 'asc' },
  })
  const transitions = allTransitions.filter(transition => transition.toVersion > checkpoint.authorityVersion)
  const storage = replayBattleAuthorityTransitions({
    roomId,
    checkpointStorage,
    checkpointVersion: checkpoint.authorityVersion,
    checkpointStateHash: checkpoint.stateHash,
    checkpointPublicHash: checkpoint.publicHash,
    checkpointTransitionHash,
    targetVersion: version,
    targetTransitionHash,
    transitions: transitions.map(transition => ({
      protocolVersion: assertBattleAuthorityProtocolVersion(
        transition.protocolVersion,
        roomId,
        transition.toVersion,
      ),
      roomId: transition.roomId,
      fromVersion: transition.fromVersion,
      toVersion: transition.toVersion,
      clientActionId: transition.clientActionId,
      playerId: transition.playerId,
      commands: JSON.parse(transition.commandJson),
      internalPatch: JSON.parse(transition.internalPatch),
      publicPatch: JSON.parse(transition.publicPatch),
      preStateHash: transition.preStateHash,
      postStateHash: transition.postStateHash,
      prePublicHash: transition.prePublicHash,
      postPublicHash: transition.postPublicHash,
      actionHash: transition.actionHash,
      previousTransitionHash: transition.previousTransitionHash,
      transitionHash: transition.transitionHash,
      pending: transition.pendingJson ? JSON.parse(transition.pendingJson) : undefined,
      traces: transition.traceJson ? JSON.parse(transition.traceJson) : [],
      replayFrames: transition.replayFrameJson ? JSON.parse(transition.replayFrameJson) : [],
    })),
  })

  const restored: Room = {
    ...room,
    battleState: storage as unknown as Room['battleState'],
    battleAuthorityTransitionHash: targetTransitionHash,
  }
  const state = storage.state as BattleState
  if (state.terminalResult) {
    materializeBattleTraceForTerminal(state, allTransitions.flatMap(transition => transitionHistoryEntries(
      transition.commandJson,
      transition.traceJson,
      transition.replayFrameJson,
    )))
  }
  authorityAsyncJournal.markDurable(roomId, version)
  authorityHistoryCache.set(roomId, {
    hydrated: true,
    transitions: allTransitions.map(parseTransitionRow),
  })
  const receipts = await prisma.battleAuthorityReceipt.findMany({ where: { roomId } })
  authorityReceiptCache.set(roomId, new Map(receipts.map(row => {
    const receipt = JSON.parse(row.receiptJson) as BattleAuthorityReceipt
    return [receipt.clientActionId, receipt]
  })))
  rememberBattleAuthorityRoom(restored)
  return clone(restored)
}

export async function readBattleAuthorityHistory(roomId: string): Promise<Array<{
  trace?: BattleActionTrace
  command?: Record<string, unknown>
  replayFrame?: BattleReplayFrame
}>> {
  const normalizedRoomId = normalizeRoomId(roomId)
  const cached = authorityHistoryCache.get(normalizedRoomId)
  if (isBattleAuthorityAsyncJournalEnabled() && cached?.hydrated) {
    return cached.transitions.flatMap(transition => transitionHistoryEntries(
      JSON.stringify(transition.commands),
      transition.traces.length > 0 ? JSON.stringify(transition.traces) : null,
      transition.replayFrames.length > 0 ? JSON.stringify(transition.replayFrames) : null,
    ))
  }
  const rows = await prisma.battleAuthorityTransition.findMany({
    where: { roomId: normalizedRoomId },
    orderBy: { toVersion: 'asc' },
  })
  return rows.flatMap(row => transitionHistoryEntries(
    row.commandJson,
    row.traceJson,
    row.replayFrameJson,
  ))
}

export function rememberBattleAuthorityRoom(room: Room): void {
  const version = roomBattleAuthorityVersion(room)
  const roomId = normalizeRoomId(room.id)
  const existing = authorityRoomCache.get(roomId)
  if (existing && existing.version > version) return
  if (isBattleAuthorityAsyncJournalEnabled()) {
    if (!authorityReceiptCache.has(roomId)) authorityReceiptCache.set(roomId, new Map())
    if (!authorityHistoryCache.has(roomId)) authorityHistoryCache.set(roomId, { hydrated: true, transitions: [] })
  }
  const persistence = authorityAsyncJournal.inspect(roomId)
  authorityRoomCache.set(roomId, {
    version,
    room: clone({
      ...room,
      battleAuthorityDurableVersion: persistence.durableAuthorityVersion,
      battleAuthorityPersistenceStatus: persistence.status,
    }),
  })
}

export function forgetBattleAuthorityRoom(roomId: string): void {
  const normalizedRoomId = normalizeRoomId(roomId)
  authorityRoomCache.delete(normalizedRoomId)
  authorityReceiptCache.delete(normalizedRoomId)
  authorityHistoryCache.delete(normalizedRoomId)
  authorityAsyncJournal.forgetRoom(normalizedRoomId)
}

export function checkpointPublicHash(state: BattleState): string {
  return hashPublicBattleState(state)
}

function transitionHistoryEntries(
  commandJson: string,
  traceJson: string | null,
  replayFrameJson: string | null,
): Array<{
  trace?: BattleActionTrace
  command?: Record<string, unknown>
  replayFrame?: BattleReplayFrame
}> {
  const commands = parseJsonArray<Record<string, unknown>>(commandJson)
  const traces = parseJsonArray<BattleActionTrace>(traceJson)
  const replayFrames = parseJsonArray<BattleReplayFrame>(replayFrameJson)
  const count = Math.max(commands.length, traces.length, replayFrames.length)
  return Array.from({ length: count }, (_, index) => ({
    command: commands[index],
    trace: traces[index],
    replayFrame: replayFrames[index],
  }))
}

function parseJsonArray<T>(value: string | null): T[] {
  if (!value) return []
  const parsed = JSON.parse(value) as T | T[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

function assertBattleAuthorityProtocolVersion(
  protocolVersion: number,
  roomId: string,
  toVersion: number,
): 2 {
  if (protocolVersion !== 2) {
    throw new Error(
      `Battle authority protocol version mismatch in ${roomId} at ${toVersion}: ${protocolVersion}`,
    )
  }
  return protocolVersion
}

function rememberAuthorityReceipt(receipt: BattleAuthorityReceipt): void {
  const roomId = normalizeRoomId(receipt.roomId)
  let receipts = authorityReceiptCache.get(roomId)
  if (!receipts) {
    receipts = new Map()
    authorityReceiptCache.set(roomId, receipts)
  }
  receipts.set(receipt.clientActionId, clone(receipt))
}

function rememberAuthorityTransition(transition: BattleAuthorityTransitionRecord): void {
  const roomId = normalizeRoomId(transition.roomId)
  let history = authorityHistoryCache.get(roomId)
  if (!history) {
    history = { hydrated: true, transitions: [] }
    authorityHistoryCache.set(roomId, history)
  }
  const existing = history.transitions.findIndex(item => item.toVersion === transition.toVersion)
  if (existing >= 0) history.transitions[existing] = clone(transition)
  else history.transitions.push(clone(transition))
  history.transitions.sort((left, right) => left.toVersion - right.toVersion)
}

function updateCachedPersistenceState(
  roomId: string,
  persistence: BattleAuthorityJournalInspection,
): void {
  const cached = authorityRoomCache.get(roomId)
  if (cached) {
    cached.room.battleAuthorityDurableVersion = persistence.durableAuthorityVersion
    cached.room.battleAuthorityPersistenceStatus = persistence.status
  }
  if (persistence.status === 'degraded') {
    console.error('[battle-authority-persistence] room persistence degraded', {
      roomId,
      authorityVersion: cached?.version,
      ...persistence,
    })
  }
}

function parseTransitionRow(transition: {
  protocolVersion: number
  roomId: string
  fromVersion: number
  toVersion: number
  clientActionId: string
  playerId: string
  commandJson: string
  internalPatch: string
  publicPatch: string
  preStateHash: string
  postStateHash: string
  prePublicHash: string
  postPublicHash: string
  actionHash: string
  previousTransitionHash: string
  transitionHash: string
  pendingJson: string | null
  traceJson: string | null
  replayFrameJson: string | null
  createdAt: Date
}): BattleAuthorityTransitionRecord {
  const commands = JSON.parse(transition.commandJson) as BattleAuthorityTransitionRecord['commands']
  return {
    ...transition,
    protocolVersion: assertBattleAuthorityProtocolVersion(transition.protocolVersion, transition.roomId, transition.toVersion),
    command: commands[0],
    commands,
    internalPatch: JSON.parse(transition.internalPatch),
    publicPatch: JSON.parse(transition.publicPatch),
    receipt: authorityReceiptCache.get(transition.roomId)?.get(transition.clientActionId) ?? {
      protocolVersion: 2,
      roomId: transition.roomId,
      clientActionId: transition.clientActionId,
      status: 'applied',
      authorityVersion: transition.toVersion,
    },
    pending: transition.pendingJson ? JSON.parse(transition.pendingJson) : undefined,
    traces: transition.traceJson ? JSON.parse(transition.traceJson) : [],
    replayFrames: transition.replayFrameJson ? JSON.parse(transition.replayFrameJson) : [],
    createdAt: transition.createdAt.getTime(),
  }
}

function normalizeRoomId(roomId: string): string {
  return roomId.trim().toLowerCase()
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
