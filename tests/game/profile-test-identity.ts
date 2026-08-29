import type { BattleState } from '@/lib/game/turn'
import type { Room } from '@/lib/game/room-store'
import {
  createServerBattleStateV1,
  type ServerBattleState,
} from '@/lib/game/battle-storage'
import { pinBattleProfileIdentityV1 } from '@/lib/game/battle-trace'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'

export function pinTestBattleState(
  state: Record<string, unknown>,
  rootSeed = 109,
): void {
  pinBattleProfileIdentityV1(
    state as unknown as BattleState,
    getServerGameProfileIdentityV1(),
    rootSeed,
  )
}

export function createTestServerBattleState(
  state: Record<string, unknown>,
  rootSeed = 109,
): ServerBattleState & NonNullable<Room['battleState']> {
  const battleState = state as unknown as BattleState
  const profileIdentity = getServerGameProfileIdentityV1()
  pinTestBattleState(state, rootSeed)
  return createServerBattleStateV1(profileIdentity, rootSeed, battleState) as unknown as ServerBattleState & NonNullable<Room['battleState']>
}
