import { prisma } from '../db'
import { hashPublicBattleState } from '../game/battle-public-patch'
import {
  materializeBattleTraceForTerminal,
  type BattleActionTrace,
  type BattleReplayFrame,
} from '../game/battle-trace'
import type { ServerBattleState } from '../game/battle-storage'
import {
  assertBattleAuthorityRestoreCheckpoint,
  createBattleAuthorityGenesisHash,
  replayBattleAuthorityTransitions,
  roomBattleAuthorityVersion,
  type BattleAuthorityCheckpointRecord,
  type BattleAuthorityReceipt,
  type BattleAuthorityTransitionRecord,
} from '../game/battle-transition'
import type { Room } from '../game/room-store'
import type { BattleState } from '../game/turn'

interface CachedAuthorityRoom {
  version: number
  room: Room
}

const persistenceGlobal = globalThis as typeof globalThis & {
  __rvbAuthorityRoomCacheV2?: Map<string, CachedAuthorityRoom>
}

const authorityRoomCache = (
  persistenceGlobal.__rvbAuthorityRoomCacheV2 ??= new Map<string, CachedAuthorityRoom>()
)

export async function getBattleAuthorityReceipt(
  roomId: string,
  clientActionId: string,
): Promise<BattleAuthorityReceipt | undefined> {
  const row = await prisma.battleAuthorityReceipt.findUnique({
    where: {
      roomId_clientActionId: {
        roomId: normalizeRoomId(roomId),
        clientActionId,
      },
    },
  })
  if (!row) return undefined
  return JSON.parse(row.receiptJson) as BattleAuthorityReceipt
}

export async function persistBattleAuthorityReceipt(receipt: BattleAuthorityReceipt): Promise<void> {
  await prisma.battleAuthorityReceipt.upsert({
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
}

export async function commitBattleAuthorityTransition(input: {
  roomId: string
  expectedVersion: number
  nextRoom: Room
  transition: BattleAuthorityTransitionRecord
  baseCheckpoint?: BattleAuthorityCheckpointRecord
  checkpoint?: BattleAuthorityCheckpointRecord
}): Promise<boolean> {
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
  const transition = input.transition
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
        ...(input.checkpoint ? { battleState: JSON.stringify(input.checkpoint.storage) } : {}),
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
          seed: base.seed,
          stateJson: JSON.stringify(base.storage),
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
        commandJson: JSON.stringify(transition.commands),
        internalPatch: JSON.stringify(transition.internalPatch),
        publicPatch: JSON.stringify(transition.publicPatch),
        preStateHash: transition.preStateHash,
        postStateHash: transition.postStateHash,
        prePublicHash: transition.prePublicHash,
        postPublicHash: transition.postPublicHash,
        actionHash: transition.actionHash,
        previousTransitionHash: transition.previousTransitionHash,
        transitionHash: transition.transitionHash,
        pendingJson: transition.pending ? JSON.stringify(transition.pending) : null,
        traceJson: transition.traces.length > 0 ? JSON.stringify(transition.traces) : null,
        replayFrameJson: transition.replayFrames.length > 0 ? JSON.stringify(transition.replayFrames) : null,
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
        receiptJson: JSON.stringify(transition.receipt),
      },
    })
    if (input.checkpoint) {
      await transaction.battleAuthorityCheckpoint.create({
        data: {
          roomId,
          authorityVersion: input.checkpoint.authorityVersion,
          protocolVersion: input.checkpoint.protocolVersion,
          seed: input.checkpoint.seed,
          stateJson: JSON.stringify(input.checkpoint.storage),
          stateHash: input.checkpoint.stateHash,
          publicHash: input.checkpoint.publicHash,
          transitionHash: input.checkpoint.transitionHash,
          reason: input.checkpoint.reason,
        },
      })
    }
    return true
  })
  if (committed) {
    rememberBattleAuthorityRoom({
      ...input.nextRoom,
      battleAuthorityVersion: input.expectedVersion + 1,
      battleAuthorityTransitionHash: input.transition.transitionHash,
    })
  }
  return committed
}

export async function initializeBattleAuthorityCheckpoint(input: {
  room: Room
  storage: ServerBattleState
  stateHash: string
  publicHash: string
}): Promise<void> {
  const roomId = normalizeRoomId(input.room.id)
  const authorityVersion = roomBattleAuthorityVersion(input.room)
  const transitionHash = createBattleAuthorityGenesisHash({
    roomId,
    stateHash: input.stateHash,
    publicHash: input.publicHash,
  })
  await prisma.battleAuthorityCheckpoint.upsert({
    where: { roomId_authorityVersion: { roomId, authorityVersion } },
    update: {},
    create: {
      roomId,
      authorityVersion,
      protocolVersion: 2,
      seed: input.storage.seed,
      stateJson: JSON.stringify(input.storage),
      stateHash: input.stateHash,
      publicHash: input.publicHash,
      transitionHash,
      reason: 'initial',
    },
  })
  rememberBattleAuthorityRoom({ ...input.room, battleAuthorityTransitionHash: transitionHash })
}

export async function restoreBattleAuthorityRoom(room: Room): Promise<Room> {
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
  const transitions = await prisma.battleAuthorityTransition.findMany({
    where: {
      roomId,
      toVersion: { gt: checkpoint.authorityVersion, lte: version },
    },
    orderBy: { toVersion: 'asc' },
  })
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
    const allTransitions = await prisma.battleAuthorityTransition.findMany({
      where: { roomId, toVersion: { lte: version } },
      orderBy: { toVersion: 'asc' },
    })
    materializeBattleTraceForTerminal(state, allTransitions.flatMap(transition => transitionHistoryEntries(
      transition.commandJson,
      transition.traceJson,
      transition.replayFrameJson,
    )))
  }
  rememberBattleAuthorityRoom(restored)
  return clone(restored)
}

export async function readBattleAuthorityHistory(roomId: string): Promise<Array<{
  trace?: BattleActionTrace
  command?: Record<string, unknown>
  replayFrame?: BattleReplayFrame
}>> {
  const rows = await prisma.battleAuthorityTransition.findMany({
    where: { roomId: normalizeRoomId(roomId) },
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
  authorityRoomCache.set(normalizeRoomId(room.id), { version, room: clone(room) })
}

export function forgetBattleAuthorityRoom(roomId: string): void {
  authorityRoomCache.delete(normalizeRoomId(roomId))
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

function normalizeRoomId(roomId: string): string {
  return roomId.trim().toLowerCase()
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
