import type { BattleState } from '@/lib/game/turn'
import type { Room } from '@/lib/game/room-model'
import {
  createServerBattleStateV1,
  type ServerBattleState,
} from '@/lib/game/battle-storage'
import { pinBattleProfileIdentityV1, recordBattleInitialization } from '@/lib/game/battle-trace'
import { RuleRuntime } from '@/lib/game/rule-runtime'
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
  if (!(battleState.extensions?.debugBattle?.actionLog?.length)) {
    recordBattleInitialization(
      battleState,
      new RuleRuntime({ rootSeed }),
      (battleState.players ?? []).map(player => player.playerId),
    )
  }
  const serializedState = JSON.parse(JSON.stringify(battleState)) as BattleState
  return createServerBattleStateV1(profileIdentity, rootSeed, serializedState) as unknown as ServerBattleState & NonNullable<Room['battleState']>
}
