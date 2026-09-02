import type { DispatchRoomBattleActionResult } from '@/lib/game/room-battle-actions'

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
