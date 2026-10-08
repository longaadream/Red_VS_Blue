import type { DispatchRoomBattleActionResult } from '@/lib/game/room-battle-actions'
import {
  SOCIAL_COOLDOWN_MS,
  SOCIAL_KINDS,
  SOCIAL_MAX_TEXT_GRAPHEMES,
  SOCIAL_MAX_TEXT_LINES,
  SOCIAL_MAX_TEXT_UTF8_BYTES,
  SOCIAL_PRESET_ALLOWLIST,
  SOCIAL_PROTOCOL_VERSION,
  SOCIAL_STAMP_ALLOWLIST,
  type SocialEvent,
} from './battle-social'

export {
  SOCIAL_COOLDOWN_MS,
  SOCIAL_KINDS,
  SOCIAL_MAX_REQUEST_CACHE,
  SOCIAL_MAX_REQUEST_ID_LENGTH,
  SOCIAL_MAX_PLAYER_TRACKING,
  SOCIAL_MAX_TEXT_GRAPHEMES,
  SOCIAL_MAX_TEXT_LINES,
  SOCIAL_MAX_TEXT_UTF8_BYTES,
  SOCIAL_PRESET_ALLOWLIST,
  SOCIAL_PROTOCOL_VERSION,
  SOCIAL_STAMP_ALLOWLIST,
  type SocialKind,
} from './battle-social'

export const BATTLE_ROOM_TYPE = 'battle'
export const BATTLE_COMMAND_MESSAGE = 'battleCommand'
export const BATTLE_RECEIPT_MESSAGE = 'battleReceipt'
export const BATTLE_RECEIPT_REQUEST_MESSAGE = 'battleReceiptRequest'
export const BATTLE_TRANSITION_MESSAGE = 'battleTransition'
export const BATTLE_DURABLE_MESSAGE = 'battleDurable'
export const BATTLE_SNAPSHOT_MESSAGE = 'battleSnapshot'
export const BATTLE_RESYNC_MESSAGE = 'battleResync'
export const PRODUCT_ROOM_RPC_MESSAGE = 'roomRpc'
export const PRODUCT_ROOM_RPC_RESULT_MESSAGE = 'roomRpcResult'
export const PRODUCT_ROOM_UPDATE_MESSAGE = 'roomUpdate'
export const SOCIAL_HELLO_MESSAGE = 'socialHello'
export const SOCIAL_READY_MESSAGE = 'socialReady'
export const SOCIAL_SEND_MESSAGE = 'socialSend'
export const SOCIAL_ACK_MESSAGE = 'socialAck'
export const SOCIAL_EVENT_MESSAGE = 'socialEvent'

// Explicit aliases keep the battle-room prefix available to callers that
// group protocol constants by feature, while the wire names remain short and
// independent from battle command/receipt messages.
export const BATTLE_SOCIAL_HELLO_MESSAGE = SOCIAL_HELLO_MESSAGE
export const BATTLE_SOCIAL_READY_MESSAGE = SOCIAL_READY_MESSAGE
export const BATTLE_SOCIAL_SEND_MESSAGE = SOCIAL_SEND_MESSAGE
export const BATTLE_SOCIAL_ACK_MESSAGE = SOCIAL_ACK_MESSAGE
export const BATTLE_SOCIAL_EVENT_MESSAGE = SOCIAL_EVENT_MESSAGE
export const SOCIAL_CAPABILITY_MESSAGE = SOCIAL_READY_MESSAGE

export function createColyseusAppliedReceipt(result: DispatchRoomBattleActionResult) {
  const transition = result.transition
  const receipt = result.receipt
  return {
    kind: result.kind,
    receipt,
    actionHash: transition?.actionHash,
    stateHash: result.snapshot.stateHash,
    transitionHash: transition?.transitionHash,
    authorityVersion: result.snapshot.authorityVersion,
    durableAuthorityVersion: result.snapshot.durableAuthorityVersion ?? 0,
    durability: (result.snapshot.durableAuthorityVersion ?? 0) >= result.snapshot.authorityVersion
      ? 'durable' as const
      : 'pending' as const,
    timings: result.timings,
  }
}

interface ColyseusRejectedReceiptInput {
  failure: Error & {
    code?: string
    receipt?: unknown
    preparation?: unknown
    needsTargetSelection?: true
    needsOptionSelection?: true
    targetType?: 'piece' | 'cell'
    range?: number
    filter?: unknown
    targetIndex?: number
    title?: string
    options?: unknown[]
  }
  clientActionId: string
  action?: unknown
  authorityVersion: number
  durableAuthorityVersion: number
}

export function createColyseusRejectedReceipt(input: ColyseusRejectedReceiptInput) {
  const { failure, clientActionId } = input
  const code = failure.code ?? 'BATTLE_COMMAND_REJECTED'
  const message = failure.message || 'Battle command was rejected'
  return {
    kind: 'rejected' as const,
    code,
    message,
    // battle.html's established actionError path reads `error`, while the
    // authority receipt contract calls the same field `message`.
    error: message,
    clientActionId,
    action: input.action,
    receipt: failure.receipt ?? { clientActionId, status: 'rejected', code, message },
    authorityVersion: input.authorityVersion,
    durableAuthorityVersion: input.durableAuthorityVersion,
    preparation: failure.preparation,
    needsTargetSelection: failure.needsTargetSelection,
    needsOptionSelection: failure.needsOptionSelection,
    targetType: failure.targetType,
    range: failure.range,
    filter: failure.filter,
    targetIndex: failure.targetIndex,
    title: failure.title,
    options: failure.options,
  }
}

export function createSocialReadyMessage(requestId?: string) {
  return {
    type: SOCIAL_READY_MESSAGE,
    supported: true as const,
    protocolVersion: SOCIAL_PROTOCOL_VERSION,
    cooldownMs: SOCIAL_COOLDOWN_MS,
    kinds: [...SOCIAL_KINDS],
    limits: {
      text: {
        maxGraphemes: SOCIAL_MAX_TEXT_GRAPHEMES,
        maxLines: SOCIAL_MAX_TEXT_LINES,
        maxUtf8Bytes: SOCIAL_MAX_TEXT_UTF8_BYTES,
      },
    },
    presetIds: [...SOCIAL_PRESET_ALLOWLIST],
    stampIds: [...SOCIAL_STAMP_ALLOWLIST],
    ...(requestId ? { requestId } : {}),
  }
}

export interface SocialAckInput {
  requestId: string
  ok: boolean
  code?: string
  message?: string
  retryAfterMs?: number
  retryAt?: number
  event?: SocialEvent
}

export function createSocialAckMessage(input: SocialAckInput) {
  return {
    type: SOCIAL_ACK_MESSAGE,
    requestId: input.requestId,
    ok: input.ok,
    ...(input.code ? { code: input.code } : {}),
    ...(input.message ? { message: input.message } : {}),
    ...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
    ...(input.retryAt !== undefined ? { retryAt: input.retryAt } : {}),
    ...(input.event ? { event: input.event } : {}),
  }
}

export function createSocialEventMessage(event: SocialEvent) {
  return {
    type: SOCIAL_EVENT_MESSAGE,
    messageId: event.messageId,
    playerId: event.playerId,
    displayName: event.displayName,
    kind: event.kind,
    payload: event.payload,
    sentAt: event.sentAt,
  }
}
