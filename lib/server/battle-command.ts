import type { ServerBattleState } from '../game/battle-storage'
import { roomStore, type Room, type RoomStore } from '../game/room-store'
import { syncRoomTerminalStatus } from './battle-terminal'

export const BATTLE_STATE_CONFLICT = 'BATTLE_STATE_CONFLICT'

export class BattleCommandError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'BattleCommandError'
  }
}

export interface BattleCommandStore {
  getRoom(roomId: string): ReturnType<RoomStore['getRoom']>
  setRoomIfVersion(roomId: string, room: Room, expectedVersion: number): Promise<boolean>
}

function requireRoomVersion(room: Room): number {
  if (!Number.isSafeInteger(room.version) || (room.version ?? -1) < 0) {
    throw new BattleCommandError(
      'Battle room version is unavailable',
      BATTLE_STATE_CONFLICT,
      409,
    )
  }
  return room.version as number
}

export async function persistAuthoritativeBattleState(input: {
  roomId: string
  room: Room
  storage: ServerBattleState
  expectedVersion?: number
  store?: BattleCommandStore
}): Promise<Room> {
  const store = input.store ?? roomStore
  const expectedVersion = input.expectedVersion ?? requireRoomVersion(input.room)

  syncRoomTerminalStatus(input.room, input.storage.state)
  input.room.battleState = input.storage as unknown as Room['battleState']

  if (!await store.setRoomIfVersion(input.roomId, input.room, expectedVersion)) {
    throw new BattleCommandError(
      'Battle state changed before this command could be committed',
      BATTLE_STATE_CONFLICT,
      409,
    )
  }

  input.room.version = expectedVersion + 1
  return input.room
}

export function isBattleStateConflict(error: unknown): boolean {
  return error instanceof BattleCommandError && error.code === BATTLE_STATE_CONFLICT
}
