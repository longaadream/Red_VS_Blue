import type { DispatchRoomBattleActionResult } from '@/lib/game/room-battle-actions'

export const BATTLE_ROOM_TYPE = 'battle'
export const BATTLE_COMMAND_MESSAGE = 'battleCommand'
export const BATTLE_RECEIPT_MESSAGE = 'battleReceipt'
export const BATTLE_TRANSITION_MESSAGE = 'battleTransition'
export const BATTLE_DURABLE_MESSAGE = 'battleDurable'

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
