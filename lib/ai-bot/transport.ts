import { randomUUID } from 'node:crypto'

import { Client as ColyseusClient } from '@colyseus/sdk'
import type { SchemaConstructor } from '@colyseus/sdk/serializer/SchemaSerializer'

import {
  assertGameProfileCompatibleV1,
  getServerGameProfileIdentityV1,
  sameGameProfileIdentityV1,
  type GameProfileIdentityV1,
} from '@/lib/content-pipeline/runtime/profile-game-identity'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { createShadowState } from './shadow-state'
import {
  BATTLE_AUTHORITY_BUILD_ID,
  BATTLE_AUTHORITY_PROTOCOL_VERSION,
} from '@/lib/game/battle-public-patch'
import {
  BATTLE_COMMAND_MESSAGE,
  BATTLE_RECEIPT_MESSAGE,
  BATTLE_RECEIPT_REQUEST_MESSAGE,
  BATTLE_RESYNC_MESSAGE,
  BATTLE_SNAPSHOT_MESSAGE,
  PRODUCT_ROOM_RPC_MESSAGE,
} from '@/lib/server/colyseus/battle-room-protocol'
import { httpEndpoint } from './official-session'

export type CloudBotAlignment = 'light' | 'dark'
export type CloudBotVisibility = 'public' | 'private'

export interface CloudBotRoomCreateConfig {
  name: string
  mapId: string
  visibility: CloudBotVisibility
}

export interface CloudBotConfig {
  serverUrl: string
  roomId?: string
  create?: CloudBotRoomCreateConfig
  playerId: string
  playerName: string
  alignment: CloudBotAlignment
  pieces: Array<string | { templateId: string }>
  accountId?: string
  mode?: 'direct' | 'official'
  maxRuntimeMs?: number
  maxActions?: number
  requestTimeoutMs?: number
  maxConsecutiveRejections?: number
  decisionBudgetMs?: number
  goal?: Record<string, unknown>
}

export interface CloudBotSnapshot {
  type?: string
  protocolVersion: number
  authorityBuildId: string
  roomId: string
  state: BattleState
  stateHash?: string
  authorityVersion: number
  serverNow?: number
  durableAuthorityVersion?: number
  persistenceStatus?: string
  turnTimer?: CloudBotTimer
  pendingTimer?: CloudBotTimer
}

interface AuthoritySnapshot extends CloudBotSnapshot {
  /** Authority-only fields stay private to this module. */
  seed?: number
  rootSeed?: number
  profileIdentity?: GameProfileIdentityV1
  [key: string]: unknown
}

interface CloudBotTimer {
  status?: string
  remainingMs?: number
  deadlineAt?: number
  burnStartsAt?: number
  inputOwnerPlayerId?: string
  ownerPlayerId?: string
  turnNumber?: number
}

export interface CloudBotReceipt {
  kind?: 'applied' | 'rejected' | 'duplicate' | 'resyncRequired'
  code?: string
  message?: string
  error?: string
  clientActionId?: string
  authorityVersion?: number
  receipt?: {
    clientActionId?: string
    status?: string
    authorityVersion?: number
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface CloudBotActionResult {
  outcome: 'applied' | 'rejected'
  clientActionId: string
  receipt: CloudBotReceipt
  snapshot: CloudBotSnapshot
}

export interface CloudBotDecisionContext {
  playerId: string
  actionCount: number
  authorityVersion: number
  turnNumber?: number
  remainingMs?: number
  budgetMs: number
}

export interface CloudBotDecision {
  action?: BattleAction
  reason?: string
  diagnostics?: string[]
}

export type CloudBotDecide = (
  snapshotState: BattleState,
  playerId: string,
  options: CloudBotDecisionContext,
) => CloudBotDecision | Promise<CloudBotDecision>

export interface CloudBotClientLike {
  joinById(roomId: string, options: Record<string, unknown>): Promise<CloudBotRoomLike>
  create(roomName: string, options: Record<string, unknown>): Promise<CloudBotRoomLike>
  /**
   * The SDK allocates a Room/socket before its join promise settles.  The
   * default client exposes this small lifecycle hook so a timed out join can
   * close that native connection as well as the outer promise.
   */
  beginPendingJoin?: () => CloudBotPendingJoin
}

export interface CloudBotPendingJoin {
  abort(): void
  finish(): void
}

export interface CloudBotRoomLike {
  roomId: string
  reconnectionToken?: string
  reconnection?: {
    enabled: boolean
    maxRetries: number
    minDelay: number
    maxDelay: number
    minUptime?: number
    maxEnqueuedMessages?: number
    isReconnecting?: boolean
  }
  connection?: { isOpen?: boolean; close?: (code?: number, reason?: string) => void }
  onMessage(type: string, callback: (payload: unknown) => void): () => void
  send(type: string, payload?: unknown): void
  request(type: string, payload?: unknown, options?: { timeout?: number }): Promise<unknown>
  leave(consented?: boolean): Promise<unknown>
  onReconnect: CloudBotSignal<[]>
  onDrop: CloudBotSignal<[number?, string?]>
  onLeave: CloudBotSignal<[number?, string?]>
}

export type CloudBotSignal<Args extends unknown[]> = {
  (callback: (...args: Args) => void): (() => void) | void
  once?: (callback: (...args: Args) => void) => void
  remove?: (callback: (...args: Args) => void) => void
}

export interface CloudBotTransportOptions {
  config: CloudBotConfig
  officialToken?: string
  client?: CloudBotClientLike
  fetchFn?: typeof fetch
  trustedProfileIdentity?: GameProfileIdentityV1
  now?: () => number
  uuid?: () => string
  logger?: Pick<Console, 'warn'>
}

export interface CloudBotRunOptions {
  decide: CloudBotDecide
  signal?: AbortSignal
  maxRuntimeMs?: number
  maxActions?: number
}

export interface CloudBotRunResult {
  status: 'terminal' | 'runtime-limit' | 'action-limit' | 'stopped'
  actionCount: number
  roomId: string
  authorityVersion: number
  terminal?: unknown
}

export class CloudBotTransportError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'CloudBotTransportError'
  }
}

interface SnapshotWaiter {
  minVersion: number
  afterSequence: number
  resolve: (snapshot: AuthoritySnapshot) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface ReceiptWaiter {
  resolve: (receipt: CloudBotReceipt) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface InFlightCommand {
  clientActionId: string
  baselineVersion: number
  envelope: Record<string, unknown>
}

interface DecisionBaseline {
  authorityVersion: number
  snapshotSequence: number
  connectionGeneration: number
}

interface ReconnectWaiter {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000
const DEFAULT_DECISION_BUDGET_MS = 1_000
const DEFAULT_MAX_RUNTIME_MS = 15 * 60_000
const DEFAULT_MAX_ACTIONS = 200
const DEFAULT_MAX_REJECTIONS = 3
const SNAPSHOT_WAIT_POLL_MS = 250
const TURN_DEADLINE_GUARD_MS = 100

interface NativeJoinCapture {
  rooms: Set<CloudBotRoomLike>
  aborted: boolean
}

interface NativeRoomRuntime {
  connect?: (...args: unknown[]) => void
}

/**
 * @colyseus/sdk@0.18.2 creates the native Room inside
 * consumeSeatReservation() and only resolves after the private onJoin signal.
 * Capture those Rooms while a join is pending so a join deadline can close a
 * socket even when the server never sends JOIN_ROOM.
 */
class BoundedColyseusClient extends ColyseusClient {
  private pendingCapture?: NativeJoinCapture

  beginPendingJoin(): CloudBotPendingJoin {
    const capture: NativeJoinCapture = { rooms: new Set(), aborted: false }
    this.pendingCapture = capture
    return {
      abort: () => {
        capture.aborted = true
        for (const room of capture.rooms) closeNativeRoom(room)
      },
      finish: () => {
        if (this.pendingCapture === capture) this.pendingCapture = undefined
        capture.rooms.clear()
      },
    }
  }

  protected override createRoom<T>(roomName: string, rootSchema?: SchemaConstructor<T>) {
    const room = super.createRoom(roomName, rootSchema)
    const capture = this.pendingCapture
    if (!capture) return room
    const observedRoom = room as unknown as CloudBotRoomLike
    capture.rooms.add(observedRoom)
    const runtimeRoom = observedRoom as unknown as NativeRoomRuntime
    const originalConnect = runtimeRoom.connect
    if (originalConnect) {
      runtimeRoom.connect = (...args: unknown[]) => {
        Reflect.apply(originalConnect, observedRoom, args)
        if (capture.aborted) closeNativeRoom(observedRoom)
      }
    }
    if (capture.aborted) closeNativeRoom(observedRoom)
    return room
  }
}

function closeNativeRoom(room: CloudBotRoomLike): void {
  try { room.connection?.close?.(4000, 'cloud bot join timeout') } catch { /* best effort */ }
}

/**
 * A single-session Colyseus transport for the independent AI process.
 * Decisions are made from the latest server projection and every accepted
 * action is followed by a fresh authoritative snapshot before another action
 * can be considered.
 */
export class CloudBotTransport {
  readonly config: CloudBotConfig
  private readonly client: CloudBotClientLike
  private readonly fetchFn: typeof fetch
  private readonly trustedProfileIdentity?: GameProfileIdentityV1
  private readonly now: () => number
  private readonly uuid: () => string
  private readonly logger?: Pick<Console, 'warn'>
  private readonly officialToken?: string
  private room?: CloudBotRoomLike
  private pendingJoin?: Promise<CloudBotRoomLike>
  private pendingJoinControl?: CloudBotPendingJoin
  private profileIdentity?: GameProfileIdentityV1
  private latestSnapshot?: AuthoritySnapshot
  private snapshotSequence = 0
  private snapshotWaiters = new Set<SnapshotWaiter>()
  private receiptWaiters = new Map<string, ReceiptWaiter>()
  private subscriptions: Array<() => void> = []
  private inFlight?: InFlightCommand
  private reconnectTask?: Promise<void>
  private reconnectWaiter?: ReconnectWaiter
  private fatalError?: CloudBotTransportError
  private closing = false
  private connected = false
  private consecutiveRejections = 0
  private connectionGeneration = 0
  private runtimeExpired = false
  private runtimeTimer?: ReturnType<typeof setTimeout>
  private activeRequestController?: AbortController

  constructor(options: CloudBotTransportOptions) {
    this.config = options.config
    this.client = options.client ?? new BoundedColyseusClient(options.config.serverUrl) as unknown as CloudBotClientLike
    this.fetchFn = options.fetchFn ?? fetch
    this.trustedProfileIdentity = options.trustedProfileIdentity
    this.now = options.now ?? Date.now
    this.uuid = options.uuid ?? randomUUID
    this.logger = options.logger
    this.officialToken = options.officialToken
  }

  get activeRoom(): CloudBotRoomLike | undefined { return this.room }
  get snapshot(): CloudBotSnapshot | undefined {
    return this.latestSnapshot ? publicSnapshot(this.latestSnapshot, this.config.playerId) : undefined
  }
  get connectedState(): boolean { return this.connected && !this.reconnectTask && !this.fatalError }

  async connect(): Promise<CloudBotSnapshot> {
    if (this.room) return this.waitUntilReady()
    if (this.closing) throw this.error('BOT_CLOSING', 'Cloud bot transport is closing')
    const remoteIdentity = await this.fetchAndVerifyProfileIdentity()
    this.throwIfStopped()
    this.profileIdentity = remoteIdentity
    const officialToken = this.resolveOfficialToken()
    if (this.config.mode === 'official' && !this.config.roomId) {
      throw this.error('OFFICIAL_ROOM_REQUIRED', 'Official mode requires an assigned roomId')
    }
    if (this.config.mode === 'official' && !officialToken) {
      throw this.error('OFFICIAL_TOKEN_REQUIRED', 'Official mode requires an existing session token')
    }
    const options: Record<string, unknown> = {
      product: true,
      playerId: this.config.playerId,
      playerName: this.config.playerName,
      accountId: this.config.accountId,
      alignment: this.config.alignment,
      profileIdentity: remoteIdentity,
      ...(officialToken ? { officialToken } : {}),
    }
    let joinOperation: Promise<CloudBotRoomLike>
    if (this.config.roomId) {
      joinOperation = Promise.resolve().then(() => this.client.joinById(this.config.roomId!, options))
    } else if (this.config.create) {
      const create = this.config.create
      joinOperation = Promise.resolve().then(() => this.client.create('battle', {
        ...options,
        name: create.name,
        mapId: create.mapId,
        visibility: create.visibility,
      }))
    } else {
      joinOperation = Promise.reject(this.error('ROOM_REQUIRED', 'Either roomId or create is required'))
    }
    const pendingJoinControl = this.client.beginPendingJoin?.()
    this.pendingJoinControl = pendingJoinControl
    this.pendingJoin = joinOperation
    const settlePendingJoin = () => {
      if (this.pendingJoin === joinOperation) this.pendingJoin = undefined
      if (this.pendingJoinControl === pendingJoinControl) this.pendingJoinControl = undefined
      pendingJoinControl?.finish()
    }
    void joinOperation.then(settlePendingJoin, settlePendingJoin)
    let joinedRoom: CloudBotRoomLike
    try {
      joinedRoom = await this.withRequestTimeout(joinOperation, 'JOIN_TIMEOUT', 'Timed out joining the cloud bot room')
    } catch (error) {
      if (error instanceof CloudBotTransportError && error.code === 'JOIN_TIMEOUT') pendingJoinControl?.abort()
      throw error
    }
    this.room = joinedRoom
    if (this.fatalError || this.closing) {
      await this.leaveRoomBounded(this.room)
      throw this.fatalError ?? this.error('BOT_CLOSING', 'Cloud bot transport is closing')
    }
    this.bindRoom(this.room)
    this.connected = true
    if (this.config.mode !== 'official') await this.prepareDirectRoom()
    return publicSnapshot(await this.requestFreshSnapshot(0), this.config.playerId)
  }

  private async prepareDirectRoom(): Promise<void> {
    const room = this.requireRoom()
    let view: Record<string, unknown>
    try {
      const response = await room.request(PRODUCT_ROOM_RPC_MESSAGE, { method: 'rooms.get' }, { timeout: this.requestTimeoutMs() })
      view = asRecord(response) ?? {}
    } catch (error) {
      throw this.error('DIRECT_ROOM_SETUP_FAILED', `Direct QA room setup lookup failed (${safeErrorCode(error)})`)
    }
    if (!view || (view.status !== 'waiting' && view.status !== 'ready')) return
    const players = Array.isArray(view.players) ? view.players.map(asRecord).filter((candidate): candidate is Record<string, unknown> => !!candidate) : []
    const player = players.find(candidate => samePlayer(candidate.id, this.config.playerId))
    if (!player) return
    const rpc = (data: Record<string, unknown>) => room.request(PRODUCT_ROOM_RPC_MESSAGE, {
      method: 'rooms.action',
      data: { ...data, playerId: this.config.playerId, profileIdentity: this.profileIdentity },
    }, { timeout: this.requestTimeoutMs() })
    if (player.alignment !== this.config.alignment) {
      await rpc({ action: 'claim-faction', alignment: this.config.alignment, ...(this.config.accountId ? { accountId: this.config.accountId } : {}), playerName: this.config.playerName })
    }
    if (player.ready !== true) await rpc({ action: 'toggle-ready' })
    const selectedPieces = Array.isArray(player.selectedPieces) ? player.selectedPieces : []
    const selectedCount = Number(player.selectedPiecesCount ?? selectedPieces.length)
    if (player.rosterLocked !== true && selectedCount !== 8) {
      await rpc({ action: 'select-pieces', alignment: this.config.alignment, pieces: normalizeCloudBotPieces(this.config.pieces) })
    }
  }

  async run(options: CloudBotRunOptions): Promise<CloudBotRunResult> {
    const startedAt = this.now()
    const maxRuntimeMs = positiveInteger(options.maxRuntimeMs ?? this.config.maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS)
    const maxActions = positiveInteger(options.maxActions ?? this.config.maxActions, DEFAULT_MAX_ACTIONS)
    let actionCount = 0
    if (options.signal?.aborted) {
      this.stop('BOT_ABORTED')
      throw this.fatalError ?? this.error('BOT_ABORTED', 'Cloud bot stopped')
    }
    this.runtimeExpired = false
    this.runtimeTimer = setTimeout(() => {
      this.runtimeExpired = true
      this.stop('BOT_RUNTIME_LIMIT')
    }, maxRuntimeMs)
    let lastSnapshot: CloudBotSnapshot
    const onAbort = () => { this.stop('BOT_ABORTED') }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      lastSnapshot = await this.connect()
      while (true) {
        this.throwIfStopped()
        await this.waitUntilReady()
        lastSnapshot = publicSnapshot(this.requireSnapshot(), this.config.playerId)
        if (lastSnapshot.state.terminalResult) {
          return {
            status: 'terminal', actionCount, roomId: this.requireRoom().roomId,
            authorityVersion: lastSnapshot.authorityVersion, terminal: lastSnapshot.state.terminalResult,
          }
        }
        if (this.now() - startedAt >= maxRuntimeMs) {
          return { status: 'runtime-limit', actionCount, roomId: this.requireRoom().roomId, authorityVersion: lastSnapshot.authorityVersion }
        }
        if (actionCount >= maxActions) {
          return { status: 'action-limit', actionCount, roomId: this.requireRoom().roomId, authorityVersion: lastSnapshot.authorityVersion }
        }

        const owner = currentInputOwner(lastSnapshot.state)
        if (!samePlayer(owner, this.config.playerId)) {
          await this.waitForSnapshotChange(lastSnapshot, Math.min(this.remainingInputMs(lastSnapshot) ?? SNAPSHOT_WAIT_POLL_MS, SNAPSHOT_WAIT_POLL_MS))
          continue
        }
        const remainingMs = this.remainingInputMs(lastSnapshot)
        const configuredBudget = positiveInteger(this.config.decisionBudgetMs, DEFAULT_DECISION_BUDGET_MS)
        const budgetMs = remainingMs === undefined
          ? configuredBudget
          : Math.min(configuredBudget, Math.max(1, remainingMs - TURN_DEADLINE_GUARD_MS))
        if (remainingMs !== undefined && remainingMs <= TURN_DEADLINE_GUARD_MS) {
          throw this.error('TURN_DEADLINE_EXPIRED', 'The authoritative input deadline is too close to make a safe decision')
        }
        const shadow = createShadowState(lastSnapshot.state, this.config.playerId).state
        const baseline: DecisionBaseline = {
          authorityVersion: lastSnapshot.authorityVersion,
          snapshotSequence: this.snapshotSequence,
          connectionGeneration: this.connectionGeneration,
        }
        const decisionStartedAt = this.now()
        const decision = await withTimeout(
          Promise.resolve(options.decide(shadow, this.config.playerId, {
            playerId: this.config.playerId,
            actionCount,
            authorityVersion: lastSnapshot.authorityVersion,
            turnNumber: lastSnapshot.state.turn?.turnNumber,
            remainingMs,
            budgetMs,
          })),
          budgetMs,
          () => this.error('DECISION_BUDGET_EXCEEDED', `Goal policy exceeded its ${budgetMs}ms decision budget`),
        )
        const decisionElapsedMs = Math.max(0, this.now() - decisionStartedAt)
        if (decisionElapsedMs > budgetMs) {
          throw this.error('DECISION_BUDGET_EXCEEDED', `Goal policy exceeded its ${budgetMs}ms decision budget`)
        }
        if (remainingMs !== undefined && remainingMs - decisionElapsedMs <= TURN_DEADLINE_GUARD_MS) {
          throw this.error('TURN_DEADLINE_EXPIRED', 'The authoritative input deadline passed while computing the decision')
        }
        // A public snapshot or native session generation change invalidates a
        // decision that was computed from the previous authority revision.
        // Discard it and let the next loop re-plan from the newest projection.
        if (this.snapshotSequence !== baseline.snapshotSequence
          || this.requireSnapshot().authorityVersion !== baseline.authorityVersion
          || this.connectionGeneration !== baseline.connectionGeneration
          || this.reconnectTask
          || !this.connected) {
          continue
        }
        if (!decision?.action) {
          await this.waitForSnapshotChange(lastSnapshot, Math.min(this.remainingInputMs(lastSnapshot) ?? SNAPSHOT_WAIT_POLL_MS, SNAPSHOT_WAIT_POLL_MS))
          continue
        }
        if (Array.isArray((decision as unknown as { actions?: unknown }).actions)) {
          throw this.error('MULTI_STEP_DECISION', 'Cloud bot decisions must contain at most one action')
        }
        let result: CloudBotActionResult
        try {
          result = await this.sendAction(decision.action, baseline)
        } catch (error) {
          if (error instanceof CloudBotTransportError && error.code === 'STALE_DECISION') continue
          throw error
        }
        if (result.outcome === 'applied') actionCount += 1
        lastSnapshot = result.snapshot
      }
    } catch (error) {
      if (this.runtimeExpired) {
        const snapshot = this.latestSnapshot
        return {
          status: 'runtime-limit',
          actionCount,
          roomId: this.room?.roomId ?? this.config.roomId ?? '',
          authorityVersion: snapshot?.authorityVersion ?? 0,
        }
      }
      if (error instanceof CloudBotTransportError && error.code === 'BOT_ABORTED') {
        return {
          status: 'stopped',
          actionCount,
          roomId: this.room?.roomId ?? this.config.roomId ?? '',
          authorityVersion: this.latestSnapshot?.authorityVersion ?? 0,
        }
      }
      throw error
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      if (this.runtimeTimer) clearTimeout(this.runtimeTimer)
      this.runtimeTimer = undefined
    }
  }

  async sendAction(action: BattleAction, baseline?: DecisionBaseline): Promise<CloudBotActionResult> {
    await this.waitUntilReady()
    const room = this.requireRoom()
    const snapshot = this.requireSnapshot()
    if (baseline && (this.snapshotSequence !== baseline.snapshotSequence
      || snapshot.authorityVersion !== baseline.authorityVersion
      || this.connectionGeneration !== baseline.connectionGeneration)) {
      throw this.error('STALE_DECISION', 'The authoritative snapshot changed before the decision could be sent')
    }
    if (this.inFlight) throw this.error('ACTION_IN_FLIGHT', 'A previous cloud bot action has not reached a definite outcome')
    if (snapshot.state.terminalResult) throw this.error('BATTLE_TERMINAL', 'The battle is already terminal')
    if (!isCloudBotActionAllowed(action)) throw this.error('ACTION_TYPE_FORBIDDEN', 'Cloud bot may submit only ordinary player actions')
    const submittedPlayerId = (action as unknown as { playerId?: string }).playerId
    if (submittedPlayerId !== undefined && !samePlayer(submittedPlayerId, this.config.playerId)) {
      throw this.error('ACTION_PLAYER_MISMATCH', 'Action playerId does not match the connected cloud bot')
    }
    const clientActionId = this.uuid()
    const command = { ...action, playerId: this.config.playerId, clientActionId } as Record<string, unknown>
    const envelope = {
      protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
      authorityBuildId: BATTLE_AUTHORITY_BUILD_ID,
      roomId: room.roomId,
      clientActionId,
      expectedAuthorityVersion: snapshot.authorityVersion,
      playerId: this.config.playerId,
      command,
    }
    this.inFlight = { clientActionId, baselineVersion: snapshot.authorityVersion, envelope }
    try {
      const receiptPromise = this.waitForReceipt(clientActionId, this.requestTimeoutMs())
      room.send(BATTLE_COMMAND_MESSAGE, envelope)
      let receipt: CloudBotReceipt
      try {
        receipt = await receiptPromise
      } catch (error) {
        receipt = await this.resolveTimedOutReceipt(clientActionId, error)
      }
      const outcome = receipt.kind === 'rejected' || receipt.kind === 'resyncRequired'
        || receipt.receipt?.status === 'rejected' || receipt.receipt?.status === 'resyncRequired'
        ? 'rejected' as const : 'applied' as const
      const authorityVersion = receipt.authorityVersion ?? receipt.receipt?.authorityVersion ?? snapshot.authorityVersion
      if (outcome === 'rejected') {
        this.consecutiveRejections += 1
        await this.requestFreshSnapshot(Math.max(snapshot.authorityVersion, authorityVersion))
        const result = { outcome, clientActionId, receipt, snapshot: publicSnapshot(this.requireSnapshot(), this.config.playerId) }
        if (this.consecutiveRejections >= positiveInteger(this.config.maxConsecutiveRejections, DEFAULT_MAX_REJECTIONS)) {
          throw this.error('REJECTION_LIMIT', 'Cloud bot stopped after consecutive authoritative rejections', { authorityVersion })
        }
        return result
      }
      this.consecutiveRejections = 0
      const committed = await this.requestFreshSnapshot(Math.max(snapshot.authorityVersion + 1, authorityVersion))
      return { outcome, clientActionId, receipt, snapshot: publicSnapshot(committed, this.config.playerId) }
    } finally {
      this.inFlight = undefined
    }
  }

  async resync(): Promise<CloudBotSnapshot> {
    await this.waitUntilReady()
    return publicSnapshot(await this.requestFreshSnapshot(this.requireSnapshot().authorityVersion), this.config.playerId)
  }

  stop(code = 'BOT_STOPPED'): void {
    if (!this.fatalError && code !== 'BOT_STOPPED') this.fatalError = this.error(code, 'Cloud bot stopped')
    this.connected = false
    this.pendingJoinControl?.abort()
    this.activeRequestController?.abort()
    this.rejectReconnectWait(this.fatalError ?? this.error(code, 'Cloud bot stopped'))
    this.rejectWaiters(this.fatalError ?? this.error(code, 'Cloud bot stopped'))
  }

  async leave(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.connected = false
    this.rejectReconnectWait(this.error('BOT_CLOSING', 'Cloud bot transport is closing'))
    this.rejectWaiters(this.error('BOT_CLOSING', 'Cloud bot transport is closing'))
    const pendingJoin = this.pendingJoin
    this.pendingJoinControl?.abort()
    if (pendingJoin) {
      await this.withRequestTimeout(pendingJoin, 'JOIN_TIMEOUT', 'Timed out waiting for the cloud bot room to close')
        .then(room => this.leaveRoomBounded(room))
        .catch(() => undefined)
    }
    for (const unsubscribe of this.subscriptions.splice(0)) {
      try { unsubscribe() } catch { /* SDK listener removal is best effort during shutdown. */ }
    }
    if (this.room) {
      const room = this.room
      this.room = undefined
      await this.leaveRoomBounded(room)
    }
  }

  private async leaveRoomBounded(room: CloudBotRoomLike): Promise<void> {
    if (room.reconnection) room.reconnection.enabled = false
    try {
      await withTimeout(
        Promise.resolve().then(() => room.leave()),
        this.requestTimeoutMs(),
        () => this.error('LEAVE_TIMEOUT', 'Timed out leaving the cloud bot room'),
      )
    } catch {
      // A closing WebSocket may never receive the SDK leave acknowledgement.
      // Close the native transport explicitly so process shutdown remains bounded.
      try { room.connection?.close?.(4000, 'cloud bot shutdown') } catch { /* best effort */ }
    } finally {
      if (room.connection?.isOpen) {
        try { room.connection.close?.(4000, 'cloud bot shutdown') } catch { /* best effort */ }
      }
    }
  }

  private async withRequestTimeout<T>(promise: Promise<T>, code: string, message: string): Promise<T> {
    try {
      return await withTimeout(promise, this.requestTimeoutMs(), () => this.error(code, message))
    } catch (error) {
      if (code === 'JOIN_TIMEOUT') {
        void promise.then(value => {
          if (value && typeof value === 'object' && 'leave' in value) {
            void this.leaveRoomBounded(value as unknown as CloudBotRoomLike)
          }
        }).catch(() => undefined)
      }
      throw error
    }
  }

  private async fetchAndVerifyProfileIdentity(): Promise<GameProfileIdentityV1> {
    const endpoint = httpEndpoint(this.config.serverUrl, '/catalog/identity')
    const controller = new AbortController()
    this.activeRequestController = controller
    const timeoutMs = this.requestTimeoutMs()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.fetchFn(endpoint, { headers: { accept: 'application/json' }, signal: controller.signal })
      if (!response.ok) throw this.error('PROFILE_FETCH_FAILED', `Profile identity request failed with HTTP ${response.status}`)
      const payload = await response.json() as { profileIdentity?: unknown }
      const trusted = this.trustedProfileIdentity ?? getServerGameProfileIdentityV1()
      const remote = assertGameProfileCompatibleV1(payload?.profileIdentity, trusted)
      if (!sameGameProfileIdentityV1(remote, trusted)) {
        throw this.error('PROFILE_IDENTITY_MISMATCH', 'Remote and local trusted game profiles differ')
      }
      return remote
    } catch (error) {
      if (error instanceof CloudBotTransportError) throw error
      if (this.fatalError || this.closing) throw this.fatalError ?? this.error('BOT_CLOSING', 'Cloud bot transport is closing')
      if (isAbortError(error)) throw this.error('PROFILE_FETCH_TIMEOUT', `Profile identity request timed out after ${timeoutMs}ms`)
      throw this.error('PROFILE_FETCH_FAILED', 'Profile identity request failed')
    } finally {
      clearTimeout(timeout)
      if (this.activeRequestController === controller) this.activeRequestController = undefined
    }
  }

  private bindRoom(room: CloudBotRoomLike): void {
    room.reconnection ??= { enabled: true, maxRetries: 8, minDelay: 250, maxDelay: 2_000, minUptime: 0 }
    room.reconnection.enabled = true
    room.reconnection.maxRetries = Math.max(1, Math.min(20, room.reconnection.maxRetries ?? 8))
    room.reconnection.minDelay = Math.max(10, room.reconnection.minDelay ?? 250)
    room.reconnection.maxDelay = Math.max(room.reconnection.minDelay, room.reconnection.maxDelay ?? 2_000)
    this.subscriptions.push(room.onMessage(BATTLE_SNAPSHOT_MESSAGE, payload => this.acceptSnapshot(payload)))
    this.subscriptions.push(room.onMessage(BATTLE_RECEIPT_MESSAGE, payload => this.acceptReceipt(payload)))
    this.subscriptions.push(bindSignal(room.onDrop, () => {
      if (this.closing) return
      this.connected = false
      this.connectionGeneration += 1
      this.startReconnectWait()
    }))
    this.subscriptions.push(bindSignal(room.onReconnect, () => {
      if (this.closing) return
      this.connected = true
      this.connectionGeneration += 1
      this.resolveReconnectWait()
      this.reconnectTask = this.handleReconnect().catch(error => {
        this.fail(error)
        throw error
      }).finally(() => { this.reconnectTask = undefined })
    }))
    this.subscriptions.push(bindSignal(room.onLeave, () => {
      if (this.closing) return
      this.connected = false
      const error = this.error('RECONNECT_FAILED', 'The native Colyseus session could not be recovered')
      this.rejectReconnectWait(error)
      this.fail(error)
    }))
  }

  private async handleReconnect(): Promise<void> {
    const inFlight = this.inFlight
    if (inFlight) {
      try {
        const receipt = await this.queryReceipt(inFlight.clientActionId)
        this.settleReceiptWaiter(inFlight.clientActionId, receipt)
      } catch (error) {
        this.rejectReceiptWaiter(inFlight.clientActionId, error)
        throw error
      }
    }
    await this.requestFreshSnapshot(this.latestSnapshot?.authorityVersion ?? 0)
  }

  private async queryReceipt(clientActionId: string): Promise<CloudBotReceipt> {
    const room = this.requireRoom()
    let result: Record<string, unknown>
    try {
      result = asRecord(await room.request(BATTLE_RECEIPT_REQUEST_MESSAGE, { clientActionId }, { timeout: this.requestTimeoutMs() })) ?? {}
    } catch {
      throw this.error('RECEIPT_LOOKUP_FAILED', 'Unable to query the previous action receipt after reconnect')
    }
    if (result.snapshot) this.acceptSnapshot(result.snapshot)
    const outcome = result.outcome
    if (outcome === 'unknown') {
      throw this.error('RECEIPT_UNKNOWN', 'The previous action has no authoritative applied or rejected receipt; stopping without retry')
    }
    if (outcome !== 'applied' && outcome !== 'rejected') {
      throw this.error('RECEIPT_LOOKUP_INVALID', 'The authority returned an invalid receipt outcome')
    }
    const normalizedOutcome: 'applied' | 'rejected' = outcome
    const receipt = result.receipt && typeof result.receipt === 'object'
      ? result.receipt as CloudBotReceipt
      : { kind: normalizedOutcome, clientActionId }
    if (normalizedOutcome === 'rejected') receipt.kind = 'rejected'
    else receipt.kind = 'applied'
    return receipt
  }

  private async resolveTimedOutReceipt(clientActionId: string, originalError: unknown): Promise<CloudBotReceipt> {
    await this.waitUntilReady()
    try {
      return await this.queryReceipt(clientActionId)
    } catch (error) {
      if (error instanceof CloudBotTransportError && error.code === 'RECEIPT_UNKNOWN') throw error
      throw this.error('RECEIPT_UNCERTAIN', `The action receipt timed out and could not be resolved (${safeErrorCode(originalError)})`)
    }
  }

  private waitForReceipt(clientActionId: string, timeoutMs: number): Promise<CloudBotReceipt> {
    if (this.fatalError || this.closing) return Promise.reject(this.fatalError ?? this.error('BOT_CLOSING', 'Cloud bot transport is closing'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.receiptWaiters.delete(clientActionId)
        reject(this.error('RECEIPT_TIMEOUT', `Timed out waiting for receipt ${clientActionId}`))
      }, timeoutMs)
      this.receiptWaiters.set(clientActionId, { resolve, reject, timer })
    })
  }

  private settleReceiptWaiter(clientActionId: string, receipt: CloudBotReceipt): void {
    const waiter = this.receiptWaiters.get(clientActionId)
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.receiptWaiters.delete(clientActionId)
    waiter.resolve(receipt)
  }

  private rejectReceiptWaiter(clientActionId: string, error: unknown): void {
    const waiter = this.receiptWaiters.get(clientActionId)
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.receiptWaiters.delete(clientActionId)
    waiter.reject(error instanceof Error ? error : this.error('RECEIPT_LOOKUP_FAILED', 'Unable to resolve the previous receipt'))
  }

  private acceptReceipt(payload: unknown): void {
    const receipt = payload && typeof payload === 'object' ? payload as CloudBotReceipt : {}
    const id = receipt.clientActionId ?? receipt.receipt?.clientActionId
    if (!id) return
    const waiter = this.receiptWaiters.get(id)
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.receiptWaiters.delete(id)
    waiter.resolve({ ...receipt, clientActionId: id })
  }

  private acceptSnapshot(payload: unknown): void {
    const candidate = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    const snapshot = candidate as unknown as AuthoritySnapshot
    if (snapshot.type && snapshot.type !== 'stateUpdate') return
    if (snapshot.roomId && snapshot.roomId.toLowerCase() !== this.requireRoomId().toLowerCase()) return
    if (snapshot.protocolVersion !== BATTLE_AUTHORITY_PROTOCOL_VERSION || snapshot.authorityBuildId !== BATTLE_AUTHORITY_BUILD_ID) return
    if (!Number.isSafeInteger(snapshot.authorityVersion) || !snapshot.state || typeof snapshot.state !== 'object') return
    if (this.latestSnapshot && snapshot.authorityVersion < this.latestSnapshot.authorityVersion) return
    if (!snapshot.roomId) snapshot.roomId = this.requireRoomId()
    this.latestSnapshot = clone(snapshot)
    this.snapshotSequence += 1
    for (const waiter of [...this.snapshotWaiters]) {
      if (this.snapshotSequence <= waiter.afterSequence || this.latestSnapshot.authorityVersion < waiter.minVersion) continue
      clearTimeout(waiter.timer)
      this.snapshotWaiters.delete(waiter)
      waiter.resolve(this.latestSnapshot)
    }
  }

  private async requestFreshSnapshot(minVersion: number): Promise<AuthoritySnapshot> {
    this.throwIfStopped()
    const room = this.requireRoom()
    const afterSequence = this.snapshotSequence
    const wait = this.waitForSnapshot(minVersion, afterSequence, this.requestTimeoutMs())
    room.send(BATTLE_RESYNC_MESSAGE, {})
    return wait
  }

  private waitForSnapshot(minVersion: number, afterSequence: number, timeoutMs: number): Promise<AuthoritySnapshot> {
    if (this.fatalError || this.closing) return Promise.reject(this.fatalError ?? this.error('BOT_CLOSING', 'Cloud bot transport is closing'))
    if (this.latestSnapshot && this.snapshotSequence > afterSequence && this.latestSnapshot.authorityVersion >= minVersion) return Promise.resolve(this.latestSnapshot)
    return new Promise((resolve, reject) => {
      const waiter: SnapshotWaiter = {
        minVersion, afterSequence, resolve, reject,
        timer: setTimeout(() => {
          this.snapshotWaiters.delete(waiter)
          reject(this.error('SNAPSHOT_TIMEOUT', `Timed out waiting for authority version ${minVersion}`))
        }, timeoutMs),
      }
      this.snapshotWaiters.add(waiter)
    })
  }

  private async waitForSnapshotChange(snapshot: Pick<CloudBotSnapshot, 'authorityVersion'>, timeoutMs: number): Promise<AuthoritySnapshot | undefined> {
    try {
      return await this.waitForSnapshot(snapshot.authorityVersion, this.snapshotSequence, Math.max(1, timeoutMs))
    } catch (error) {
      if (error instanceof CloudBotTransportError && error.code === 'SNAPSHOT_TIMEOUT') return undefined
      throw error
    }
  }

  private async waitUntilReady(): Promise<CloudBotSnapshot> {
    this.throwIfStopped()
    if (this.reconnectTask) await this.reconnectTask
    this.throwIfStopped()
    if (!this.connected && this.room) {
      this.startReconnectWait()
      const reconnectWaiter = this.reconnectWaiter
      if (reconnectWaiter) await reconnectWaiter.promise
      if (this.reconnectTask) await this.reconnectTask
      this.throwIfStopped()
      if (!this.connected) throw this.error('RECONNECT_FAILED', 'The native Colyseus session could not be recovered')
    }
    return this.requireSnapshot()
  }

  private startReconnectWait(): void {
    if (this.reconnectWaiter || this.closing || this.fatalError || !this.room) return
    const reconnection = this.room.reconnection
    const retries = Math.max(1, reconnection?.maxRetries ?? 8)
    const maxDelay = Math.max(10, reconnection?.maxDelay ?? 2_000)
    const timeoutMs = Math.min(120_000, retries * maxDelay + this.requestTimeoutMs())
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    // A drop may occur between policy turns; keep the native lifecycle
    // promise from becoming an unhandled rejection before the next wait.
    promise.catch(() => undefined)
    const timer = setTimeout(() => {
      const error = this.error('RECONNECT_FAILED', 'The native Colyseus session did not reconnect within the bounded retry window')
      this.reconnectWaiter = undefined
      reject(error)
      this.fail(error)
    }, timeoutMs)
    this.reconnectWaiter = { promise, resolve, reject, timer }
  }

  private resolveReconnectWait(): void {
    const waiter = this.reconnectWaiter
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.reconnectWaiter = undefined
    waiter.resolve()
  }

  private rejectReconnectWait(error: Error): void {
    const waiter = this.reconnectWaiter
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.reconnectWaiter = undefined
    waiter.reject(error)
  }

  private requireRoom(): CloudBotRoomLike {
    if (!this.room) throw this.error('ROOM_NOT_CONNECTED', 'Cloud bot is not connected')
    return this.room
  }

  private requireRoomId(): string {
    return this.room?.roomId ?? this.config.roomId ?? ''
  }

  private requireSnapshot(): AuthoritySnapshot {
    if (!this.latestSnapshot) throw this.error('SNAPSHOT_REQUIRED', 'No authoritative battle snapshot has been received')
    return this.latestSnapshot
  }

  private resolveOfficialToken(): string | undefined {
    return this.officialToken
  }

  private requestTimeoutMs(): number {
    return positiveInteger(this.config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS)
  }

  private remainingInputMs(snapshot: CloudBotSnapshot): number | undefined {
    const pending = snapshot.pendingTimer
    const timer = snapshot.turnTimer
    if (pending && samePlayer(pending.ownerPlayerId, this.config.playerId)) return safeNonNegative(pending.remainingMs)
    if (timer && samePlayer(timer.inputOwnerPlayerId ?? timer.ownerPlayerId, this.config.playerId)) return safeNonNegative(timer.remainingMs)
    return undefined
  }

  private throwIfStopped(): void {
    if (this.fatalError) throw this.fatalError
    if (this.closing) throw this.error('BOT_CLOSING', 'Cloud bot transport is closing')
  }

  private fail(error: unknown): void {
    this.fatalError = error instanceof CloudBotTransportError
      ? error
      : this.error('TRANSPORT_FAILED', 'Cloud bot transport failed')
    this.connected = false
    this.rejectWaiters(this.fatalError)
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.snapshotWaiters) { clearTimeout(waiter.timer); waiter.reject(error) }
    this.snapshotWaiters.clear()
    for (const [id, waiter] of this.receiptWaiters) { clearTimeout(waiter.timer); waiter.reject(error); this.receiptWaiters.delete(id) }
  }

  private error(code: string, message: string, details: Record<string, unknown> = {}): CloudBotTransportError {
    this.logger?.warn?.(`[cloud-bot] ${code}: ${message}`)
    return new CloudBotTransportError(code, message, details)
  }
}

function currentInputOwner(state: BattleState): string | undefined {
  const pendingOption = state.pendingOptionSelection?.playerId
  const pendingTarget = state.pendingTargetSelection?.ownerPlayerId ?? state.pendingTargetSelection?.playerId
  const deployment = state.deployment?.mode === 'progressive-reserve-v1'
    && state.deployment.status === 'awaiting-reserve-deploy'
    ? state.deployment.activePlayerId : undefined
  return pendingOption ?? pendingTarget ?? deployment ?? state.turn?.currentPlayerId
}

function isCloudBotActionAllowed(action: BattleAction): boolean {
  switch (action.type) {
    case 'beginPhase':
      return true
    case 'deploymentChoice':
    case 'deploymentLock':
    case 'deployReservePiece':
    case 'move':
    case 'useBasicSkill':
    case 'useChargeSkill':
    case 'playCard':
    case 'pendingOptionSelect':
    case 'pendingTargetSelect':
    case 'cancelPendingSelection':
    case 'endTurn':
      return true
    default:
      return false
  }
}

function samePlayer(left: unknown, right: unknown): boolean {
  return typeof left === 'string' && typeof right === 'string' && left.trim().toLowerCase() === right.trim().toLowerCase()
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? Math.floor(value!) : fallback
}

function safeNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function publicSnapshot(snapshot: AuthoritySnapshot, playerId: string): CloudBotSnapshot {
  const shadow = createShadowState(snapshot.state, playerId).state
  return {
    type: snapshot.type,
    protocolVersion: snapshot.protocolVersion,
    authorityBuildId: snapshot.authorityBuildId,
    roomId: snapshot.roomId,
    state: shadow,
    stateHash: snapshot.stateHash,
    authorityVersion: snapshot.authorityVersion,
    serverNow: snapshot.serverNow,
    durableAuthorityVersion: snapshot.durableAuthorityVersion,
    persistenceStatus: snapshot.persistenceStatus,
    turnTimer: publicTimer(snapshot.turnTimer),
    pendingTimer: publicTimer(snapshot.pendingTimer),
  }
}

function publicTimer(value: unknown): CloudBotTimer | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const timer: CloudBotTimer = {}
  for (const key of ['status', 'remainingMs', 'deadlineAt', 'burnStartsAt', 'inputOwnerPlayerId', 'ownerPlayerId', 'turnNumber'] as const) {
    const candidate = source[key]
    if (key === 'status' || key === 'inputOwnerPlayerId' || key === 'ownerPlayerId') {
      if (typeof candidate === 'string') timer[key] = candidate
    } else if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      timer[key] = candidate
    }
  }
  return Object.keys(timer).length ? timer : undefined
}

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError'
}

function safeErrorCode(error: unknown): string {
  return error instanceof CloudBotTransportError ? error.code : 'unknown'
}

function bindSignal<Args extends unknown[]>(signal: CloudBotSignal<Args>, callback: (...args: Args) => void): () => void {
  const unsubscribe = signal(callback)
  return typeof unsubscribe === 'function' ? unsubscribe : () => signal.remove?.(callback)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, makeError: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      reject(makeError())
    }, timeoutMs)
    promise.then(value => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(value)
    }, error => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
  })
}

export function normalizeCloudBotPieces(pieces: unknown): Array<{ templateId: string }> {
  if (!Array.isArray(pieces)) throw new CloudBotTransportError('PIECES_REQUIRED', 'pieces must contain exactly eight template IDs')
  const normalized = pieces.map(piece => {
    const templateId = typeof piece === 'string' ? piece.trim() : piece && typeof piece === 'object' && typeof (piece as { templateId?: unknown }).templateId === 'string'
      ? (piece as { templateId: string }).templateId.trim() : ''
    if (!templateId) throw new CloudBotTransportError('PIECES_INVALID', 'Each piece must contain a templateId')
    return { templateId }
  })
  if (normalized.length !== 8) throw new CloudBotTransportError('PIECES_COUNT_INVALID', 'Exactly eight pieces are required')
  if (new Set(normalized.map(piece => piece.templateId)).size !== normalized.length) throw new CloudBotTransportError('PIECES_DUPLICATE', 'Roster pieces must be unique')
  return normalized
}
