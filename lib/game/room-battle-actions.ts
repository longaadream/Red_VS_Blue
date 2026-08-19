import { getBattleStorage, type ServerBattleState } from './battle-storage'
import { hashBattleState, runBattleAction, type BattleActionResult } from './battle-runner'
import {
  systemDeploymentRuleClock,
  toPublicBattleState,
  type DeploymentRuleClock,
} from './deployment'
import { stampPendingDeploymentAuthorityVersion } from './battle-trace'
import type { Room } from './room-store'
import { assertActionPlayer } from './targeting'
import type { BattleAction, BattleState } from './turn'

const MAX_ROOM_ACTION_ATTEMPTS = 5

export interface DeploymentRoomStore {
  getRoom(roomId: string): Promise<Room | undefined>
  setRoom(roomId: string, room: Room): Promise<void>
  setRoomIfVersion(roomId: string, room: Room, expectedVersion: number): Promise<boolean>
}

export interface PublicBattleSnapshot {
  state: BattleState
  seed: number
  stateHash: string
  authorityVersion: number
}

export interface DispatchRoomBattleActionResult {
  kind: 'applied' | 'duplicate' | 'expired'
  snapshot: PublicBattleSnapshot
  actionResult: BattleActionResult
}

export interface DispatchRoomBattleActionOptions {
  allowSystem?: boolean
  clock?: DeploymentRuleClock
}

export interface ScheduleDeploymentTimeoutOptions {
  clock?: DeploymentRuleClock
  onCommitted?: (snapshot: PublicBattleSnapshot) => void | Promise<void>
}

export class RoomBattleActionError extends Error {
  code: string
  context: Record<string, unknown>

  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    super(message)
    this.name = 'RoomBattleActionError'
    this.code = code
    this.context = context
  }
}

type DeploymentTimer = ReturnType<typeof setTimeout>
const timerGlobal = globalThis as typeof globalThis & {
  __rvbDeploymentTimers?: Map<string, DeploymentTimer>
}
const deploymentTimers = (timerGlobal.__rvbDeploymentTimers ??= new Map())

export function createPublicBattleSnapshot(
  room: Room,
  viewerPlayerId?: string,
): PublicBattleSnapshot {
  const storage = getBattleStorage(room)
  if (!storage) throw new RoomBattleActionError('BATTLE_NOT_STARTED', 'Battle not started')
  const state = toPublicBattleState(storage.state as BattleState, viewerPlayerId)
  return {
    state,
    seed: storage.seed,
    stateHash: hashBattleState(state),
    authorityVersion: typeof room.version === 'number' ? room.version : 0,
  }
}

export function createPublicRoomSnapshot(room: Room): Room {
  const storage = getBattleStorage(room)
  if (!storage) return room
  const snapshot = createPublicBattleSnapshot(room)
  const publicStorage: ServerBattleState = {
    type: 'server-state',
    seed: snapshot.seed,
    state: snapshot.state,
  }
  return {
    ...room,
    battleState: publicStorage as unknown as Room['battleState'],
  }
}

export async function dispatchRoomBattleAction(
  store: DeploymentRoomStore,
  roomId: string,
  viewerPlayerId: string | null | undefined,
  action: BattleAction,
  options: DispatchRoomBattleActionOptions = {},
): Promise<DispatchRoomBattleActionResult> {
  const normalizedRoomId = roomId.trim().toLowerCase()
  const clock = options.clock ?? systemDeploymentRuleClock

  for (let attempt = 0; attempt < MAX_ROOM_ACTION_ATTEMPTS; attempt += 1) {
    const room = await store.getRoom(normalizedRoomId)
    if (!room) throw new RoomBattleActionError('ROOM_NOT_FOUND', 'Room not found', { roomId: normalizedRoomId })
    const storage = getBattleStorage(room)
    if (!storage) throw new RoomBattleActionError('BATTLE_NOT_STARTED', 'Battle not started', { roomId: normalizedRoomId })
    const state = storage.state as BattleState

    try {
      assertRoomActionViewer(room, viewerPlayerId, action, options.allowSystem === true)
    } catch (error) {
      throw decorateRoomActionError(error, normalizedRoomId, room, storage, action, viewerPlayerId)
    }

    if (action.type === 'deploymentTimeout' && state.deployment?.status !== 'awaiting-locks') {
      return {
        kind: 'duplicate',
        snapshot: createPublicBattleSnapshot(room, viewerPlayerId ?? undefined),
        actionResult: duplicateResult(state),
      }
    }

    const now = clock.now()
    const expired = action.type !== 'deploymentTimeout'
      && state.deployment?.status === 'awaiting-locks'
      && now >= state.deployment.deadlineAt
    const actionToApply: BattleAction = action.type === 'deploymentTimeout'
      ? {
          type: 'deploymentTimeout',
          now,
          clientActionId: action.clientActionId,
        }
      : expired
      ? {
          type: 'deploymentTimeout',
          now,
          clientActionId: `system-deployment-timeout:${normalizedRoomId}:${state.deployment!.deadlineAt}`,
        }
      : action

    let actionResult: BattleActionResult
    try {
      actionResult = runBattleAction(state, actionToApply, { rootSeed: storage.seed })
    } catch (error) {
      throw decorateRoomActionError(error, normalizedRoomId, room, storage, actionToApply, viewerPlayerId)
    }

    if (actionResult.duplicate) {
      return {
        kind: 'duplicate',
        snapshot: createPublicBattleSnapshot(room, viewerPlayerId ?? undefined),
        actionResult,
      }
    }

    if (typeof room.version !== 'number') {
      throw new RoomBattleActionError(
        'AUTHORITY_VERSION_MISSING',
        'Authoritative room version is required for battle actions',
        roomActionContext(normalizedRoomId, room, storage, actionToApply, viewerPlayerId),
      )
    }

    const nextAuthorityVersion = room.version + 1
    stampPendingDeploymentAuthorityVersion(actionResult.state, nextAuthorityVersion)
    const nextStorage: ServerBattleState = {
      type: 'server-state',
      seed: storage.seed,
      state: actionResult.state,
    }
    const isTerminal = actionResult.state.terminalResult?.status === 'finished'
    const nextRoom: Room = {
      ...room,
      battleState: nextStorage as unknown as Room['battleState'],
      ...(isTerminal ? { status: 'finished' as const } : {}),
    }
    if (!await store.setRoomIfVersion(normalizedRoomId, nextRoom, room.version)) continue

    const committedRoom: Room = { ...nextRoom, version: room.version + 1 }
    const snapshot = createPublicBattleSnapshot(committedRoom, viewerPlayerId ?? undefined)
    if (isTerminal || actionResult.state.deployment?.status === 'complete') {
      clearRoomDeploymentTimeout(normalizedRoomId)
    }
    return {
      kind: expired ? 'expired' : 'applied',
      snapshot,
      actionResult,
    }
  }

  throw new RoomBattleActionError(
    'ROOM_VERSION_CONFLICT',
    'Battle action could not commit because the room changed concurrently',
    { roomId: normalizedRoomId },
  )
}

export async function scheduleRoomDeploymentTimeout(
  store: DeploymentRoomStore,
  roomId: string,
  options: ScheduleDeploymentTimeoutOptions = {},
): Promise<void> {
  const normalizedRoomId = roomId.trim().toLowerCase()
  clearRoomDeploymentTimeout(normalizedRoomId)

  const room = await store.getRoom(normalizedRoomId)
  if (!room) return
  const storage = getBattleStorage(room)
  const deployment = (storage?.state as BattleState | undefined)?.deployment
  if (!deployment || deployment.status !== 'awaiting-locks') return

  const clock = options.clock ?? systemDeploymentRuleClock
  const delay = Math.max(0, deployment.deadlineAt - clock.now())
  const timer = setTimeout(async () => {
    const firedAt = clock.now()
    if (firedAt < deployment.deadlineAt) {
      await scheduleRoomDeploymentTimeout(store, normalizedRoomId, options)
      return
    }
    deploymentTimers.delete(normalizedRoomId)
    try {
      const result = await dispatchRoomBattleAction(
        store,
        normalizedRoomId,
        undefined,
        {
          type: 'deploymentTimeout',
          now: firedAt,
          clientActionId: `system-deployment-timeout:${normalizedRoomId}:${deployment.deadlineAt}`,
        },
        { allowSystem: true, clock },
      )
      if (result.kind === 'applied') await options.onCommitted?.(result.snapshot)
    } catch (error) {
      const code = (error as { code?: unknown })?.code
      if (code !== 'ROOM_NOT_FOUND' && code !== 'BATTLE_NOT_STARTED') {
        console.warn('[deployment-timeout] failed', {
          roomId: normalizedRoomId,
          code,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }, delay)
  ;(timer as DeploymentTimer & { unref?: () => void }).unref?.()
  deploymentTimers.set(normalizedRoomId, timer)
}

export function clearRoomDeploymentTimeout(roomId: string): void {
  const normalizedRoomId = roomId.trim().toLowerCase()
  const timer = deploymentTimers.get(normalizedRoomId)
  if (!timer) return
  clearTimeout(timer)
  deploymentTimers.delete(normalizedRoomId)
}

function assertRoomActionViewer(
  room: Room,
  viewerPlayerId: string | null | undefined,
  action: BattleAction,
  allowSystem: boolean,
): void {
  if (action.type === 'deploymentTimeout') {
    if (!allowSystem) {
      throw new RoomBattleActionError(
        'DEPLOYMENT_SYSTEM_ACTION_FORBIDDEN',
        'Deployment timeout may only be issued by the authoritative server clock',
      )
    }
    return
  }

  assertActionPlayer(viewerPlayerId, action)
  const normalizedViewer = normalizePlayerId(viewerPlayerId)
  if (!normalizedViewer || !room.players.some(player => normalizePlayerId(player.id) === normalizedViewer)) {
    throw new RoomBattleActionError(
      'VIEWER_FORBIDDEN',
      'Only a participating player may submit a battle command',
    )
  }
}

function decorateRoomActionError(
  error: unknown,
  roomId: string,
  room: Room,
  storage: ServerBattleState,
  action: BattleAction,
  viewerPlayerId: string | null | undefined,
): Error {
  const decorated = error instanceof Error ? error : new Error(String(error))
  const candidateCode = (decorated as unknown as { code?: unknown }).code
  const code = typeof candidateCode === 'string'
    ? candidateCode
    : 'BATTLE_ACTION_REJECTED'
  const context = {
    ...roomActionContext(roomId, room, storage, action, viewerPlayerId),
    ...((decorated as { determinism?: Record<string, unknown> }).determinism ?? {}),
  }
  Object.assign(decorated, { code, context })
  console.warn('[battle-action] rejected', { code, ...context, error: decorated.message })
  return decorated
}

function roomActionContext(
  roomId: string,
  room: Room,
  storage: ServerBattleState,
  action: BattleAction,
  viewerPlayerId: string | null | undefined,
): Record<string, unknown> {
  const state = storage.state as BattleState
  return {
    roomId,
    playerId: 'playerId' in action ? action.playerId : 'system',
    viewerPlayerId: normalizePlayerId(viewerPlayerId) || undefined,
    phase: state.deployment?.status ?? state.turn?.phase ?? 'unknown',
    actionId: 'clientActionId' in action ? action.clientActionId : undefined,
    authorityVersion: room.version,
    seed: storage.seed,
  }
}

function duplicateResult(state: BattleState): BattleActionResult {
  return {
    state,
    stateHash: hashBattleState(state),
    actionHash: '',
    duplicate: true,
  }
}

function normalizePlayerId(playerId: unknown): string {
  return typeof playerId === 'string' ? playerId.trim().toLowerCase() : ''
}
