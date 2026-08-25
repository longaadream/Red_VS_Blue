import {
  BATTLE_AUTHORITY_PROTOCOL_VERSION,
  applyBattlePublicPatch,
  createBattlePublicPatch,
  hashPublicBattleState,
  type BattlePatchOperation,
} from './battle-public-patch'
import { hashBattleState, type BattleActionTrace, type BattleReplayFrame } from './battle-trace'
import type { ServerBattleState } from './battle-storage'
import type { BattleAction, BattleState } from './turn'

export type BattleAuthorityReceiptStatus = 'applied' | 'duplicate' | 'rejected' | 'resyncRequired'

export interface BattleAuthorityCommandEnvelope {
  protocolVersion: typeof BATTLE_AUTHORITY_PROTOCOL_VERSION
  roomId: string
  clientActionId: string
  expectedAuthorityVersion: number
  playerId: string
  command: BattleAction
  selectionId?: string
  stateRevision?: number
}

export interface BattleAuthorityReceipt {
  protocolVersion: typeof BATTLE_AUTHORITY_PROTOCOL_VERSION
  roomId: string
  clientActionId: string
  status: BattleAuthorityReceiptStatus
  authorityVersion: number
  code?: string
  message?: string
}

export interface PublicPendingInteraction {
  ownerPlayerId: string
  kind: 'option' | 'target'
  selectionId: string
  stateRevision: number
  step: number
  canCancel: boolean
  source?: { kind?: string; id?: string }
  candidates: unknown[]
}

export interface BattleAuthorityTransitionRecord {
  protocolVersion: typeof BATTLE_AUTHORITY_PROTOCOL_VERSION
  roomId: string
  fromVersion: number
  toVersion: number
  clientActionId: string
  playerId: string
  command: BattleAction
  commands: BattleAction[]
  internalPatch: BattlePatchOperation[]
  publicPatch: BattlePatchOperation[]
  preStateHash: string
  postStateHash: string
  prePublicHash: string
  postPublicHash: string
  receipt: BattleAuthorityReceipt
  pending?: PublicPendingInteraction
  traces: BattleActionTrace[]
  replayFrames: BattleReplayFrame[]
  createdAt: number
}

export interface BattleAuthorityCheckpointRecord {
  protocolVersion: typeof BATTLE_AUTHORITY_PROTOCOL_VERSION
  roomId: string
  authorityVersion: number
  seed: number
  storage: ServerBattleState
  stateHash: string
  publicHash: string
  reason: 'initial' | 'interval' | 'turn' | 'terminal' | 'close'
  createdAt: number
}

export function isBattleAuthorityV2Enabled(): boolean {
  const configured = String(process.env.RVB_BATTLE_AUTHORITY_V2 ?? '').trim().toLowerCase()
  return configured !== '0' && configured !== 'false' && configured !== 'off'
}

export function roomBattleAuthorityVersion(room: {
  version?: number
  battleAuthorityVersion?: number
}): number {
  const value = isBattleAuthorityV2Enabled()
    ? room.battleAuthorityVersion ?? room.version ?? 0
    : room.version ?? 0
  if (!Number.isSafeInteger(value) || value < 0) {
    throw authorityEnvelopeError('AUTHORITY_VERSION_MISSING', 'Battle authority version is invalid')
  }
  return value
}

export function parseBattleAuthorityEnvelope(
  input: unknown,
  expectedRoomId?: string,
): BattleAuthorityCommandEnvelope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw authorityEnvelopeError('BATTLE_ENVELOPE_INVALID', 'Battle command envelope must be an object')
  }
  const value = input as Record<string, unknown>
  if (value.protocolVersion !== BATTLE_AUTHORITY_PROTOCOL_VERSION) {
    throw authorityEnvelopeError('BATTLE_PROTOCOL_UNSUPPORTED', 'Unsupported battle authority protocol version')
  }
  const roomId = normalizedString(value.roomId)
  const playerId = normalizedString(value.playerId)
  const clientActionId = normalizedString(value.clientActionId, false)
  if (!roomId || (expectedRoomId && roomId !== expectedRoomId.trim().toLowerCase())) {
    throw authorityEnvelopeError('BATTLE_ENVELOPE_ROOM_MISMATCH', 'Battle command room does not match the transport room')
  }
  if (!playerId) throw authorityEnvelopeError('BATTLE_ENVELOPE_PLAYER_REQUIRED', 'Battle command playerId is required')
  if (!clientActionId) throw authorityEnvelopeError('BATTLE_ENVELOPE_ACTION_ID_REQUIRED', 'Battle command clientActionId is required')
  if (!Number.isSafeInteger(value.expectedAuthorityVersion) || Number(value.expectedAuthorityVersion) < 0) {
    throw authorityEnvelopeError('BATTLE_ENVELOPE_VERSION_INVALID', 'Battle command expectedAuthorityVersion is invalid')
  }
  if (!value.command || typeof value.command !== 'object' || Array.isArray(value.command)) {
    throw authorityEnvelopeError('BATTLE_ENVELOPE_COMMAND_REQUIRED', 'Battle command payload is required')
  }
  const command = { ...(value.command as Record<string, unknown>), clientActionId } as unknown as BattleAction
  return {
    protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
    roomId,
    clientActionId,
    expectedAuthorityVersion: Number(value.expectedAuthorityVersion),
    playerId,
    command,
    selectionId: typeof value.selectionId === 'string' ? value.selectionId : undefined,
    stateRevision: Number.isSafeInteger(value.stateRevision) ? Number(value.stateRevision) : undefined,
  }
}

export function buildBattleAuthorityTransition(input: {
  roomId: string
  fromVersion: number
  clientActionId: string
  playerId: string
  command: BattleAction
  commands?: BattleAction[]
  previousStorage: ServerBattleState
  nextStorage: ServerBattleState
  previousPublicState: BattleState
  nextPublicState: BattleState
  preStateHash: string
  postStateHash: string
  traces?: BattleActionTrace[]
  replayFrames?: BattleReplayFrame[]
  now: number
}): BattleAuthorityTransitionRecord {
  const toVersion = input.fromVersion + 1
  const prePublicHash = hashPublicBattleState(input.previousPublicState)
  const postPublicHash = hashPublicBattleState(input.nextPublicState)
  const receipt: BattleAuthorityReceipt = {
    protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
    roomId: input.roomId,
    clientActionId: input.clientActionId,
    status: 'applied',
    authorityVersion: toVersion,
  }
  return {
    protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
    roomId: input.roomId,
    fromVersion: input.fromVersion,
    toVersion,
    clientActionId: input.clientActionId,
    playerId: input.playerId,
    command: input.command,
    commands: input.commands ?? [input.command],
    internalPatch: createBattlePublicPatch(input.previousStorage, input.nextStorage),
    publicPatch: createBattlePublicPatch(input.previousPublicState, input.nextPublicState),
    preStateHash: input.preStateHash,
    postStateHash: input.postStateHash,
    prePublicHash,
    postPublicHash,
    receipt,
    pending: projectPendingInteraction(input.nextPublicState),
    traces: input.traces ?? [],
    replayFrames: input.replayFrames ?? [],
    createdAt: input.now,
  }
}

export function createBattleAuthorityReceipt(input: {
  roomId: string
  clientActionId: string
  status: BattleAuthorityReceiptStatus
  authorityVersion: number
  code?: string
  message?: string
}): BattleAuthorityReceipt {
  return {
    protocolVersion: BATTLE_AUTHORITY_PROTOCOL_VERSION,
    ...input,
  }
}

export function replayBattleAuthorityTransitions(input: {
  roomId: string
  checkpointStorage: ServerBattleState
  checkpointVersion: number
  checkpointStateHash: string
  targetVersion: number
  transitions: Array<Pick<BattleAuthorityTransitionRecord, 'fromVersion' | 'toVersion' | 'internalPatch' | 'postStateHash'>>
}): ServerBattleState {
  let storage = structuredClone(input.checkpointStorage)
  const actualCheckpointHash = hashBattleState(storage.state as BattleState)
  if (actualCheckpointHash !== input.checkpointStateHash) {
    throw new Error(`Battle authority checkpoint hash mismatch in ${input.roomId} at ${input.checkpointVersion}`)
  }
  let expectedVersion = input.checkpointVersion
  for (const transition of input.transitions) {
    if (transition.fromVersion !== expectedVersion || transition.toVersion !== expectedVersion + 1) {
      throw new Error(
        `Battle authority transition gap in ${input.roomId}: expected ${expectedVersion + 1}, got ${transition.toVersion}`,
      )
    }
    storage = applyBattlePublicPatch(storage, transition.internalPatch)
    const actualHash = hashBattleState(storage.state as BattleState)
    if (actualHash !== transition.postStateHash) {
      throw new Error(`Battle authority transition hash mismatch in ${input.roomId} at ${transition.toVersion}`)
    }
    expectedVersion = transition.toVersion
  }
  if (expectedVersion !== input.targetVersion) {
    throw new Error(`Battle authority restore stopped at ${expectedVersion}, room is ${input.targetVersion}`)
  }
  return storage
}

export function checkpointReasonForTransition(
  previousState: BattleState,
  nextState: BattleState,
  toVersion: number,
  interval = 20,
): BattleAuthorityCheckpointRecord['reason'] | undefined {
  if (nextState.terminalResult) return 'terminal'
  if (previousState.turn?.turnNumber !== nextState.turn?.turnNumber) return 'turn'
  if (interval > 0 && toVersion % interval === 0) return 'interval'
  return undefined
}

export function projectPendingInteraction(state: BattleState): PublicPendingInteraction | undefined {
  const option = state.pendingOptionSelection
  if (option?.selectionId && Number.isSafeInteger(option.stateRevision)) {
    return {
      ownerPlayerId: option.playerId,
      kind: 'option',
      selectionId: option.selectionId,
      stateRevision: option.stateRevision!,
      step: 0,
      canCancel: option.canCancel !== false,
      source: option.source ? { kind: option.source.type, id: option.source.id } : undefined,
      candidates: Array.isArray(option.options) ? [...option.options] : [],
    }
  }
  const target = state.pendingTargetSelection
  if (target?.selectionId && Number.isSafeInteger(target.stateRevision)) {
    return {
      ownerPlayerId: target.playerId,
      kind: 'target',
      selectionId: target.selectionId,
      stateRevision: target.stateRevision!,
      step: Number.isSafeInteger(target.step) ? target.step! : 0,
      canCancel: target.canCancel !== false,
      source: target.source ? { kind: target.source.type, id: target.source.id } : undefined,
      candidates: Array.isArray(target.candidates) ? structuredClone(target.candidates) : [],
    }
  }
  return undefined
}

function normalizedString(value: unknown, lowerCase = true): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  return lowerCase ? normalized.toLowerCase() : normalized
}

function authorityEnvelopeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}
