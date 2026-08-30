import { describe, expect, it } from 'vitest'

import { BATTLE_STATE_CONFLICT, persistAuthoritativeBattleState } from '@/lib/server/battle-command'
import type { Room } from '@/lib/game/room-store'
import { createTestServerBattleState } from './profile-test-identity'

function room(): Room {
  return {
    id: 'bot-terminal',
    name: 'Bot terminal',
    status: 'in-progress',
    players: [],
    spectators: [],
    currentTurnIndex: 0,
    actions: [],
    version: 7,
  }
}

const terminalStorage = createTestServerBattleState(
  { terminalResult: { status: 'finished', reason: 'core-eliminated' } },
  9,
)

describe('authoritative battle command persistence', () => {
  it('marks a bot-produced terminal room finished in the CAS write', async () => {
    const currentRoom = room()
    let committed: { room: Room; expectedVersion: number } | null = null

    await persistAuthoritativeBattleState({
      roomId: currentRoom.id,
      room: currentRoom,
      storage: terminalStorage,
      store: {
        async getRoom() { return currentRoom },
        async setRoomIfVersion(_roomId, nextRoom, expectedVersion) {
          committed = { room: nextRoom, expectedVersion }
          return true
        },
      },
    })

    expect(committed).toMatchObject({
      expectedVersion: 7,
      room: { status: 'finished' },
    })
    expect(currentRoom.version).toBe(8)
  })

  it('reports a stable conflict when another command wins the room version', async () => {
    const currentRoom = room()

    await expect(persistAuthoritativeBattleState({
      roomId: currentRoom.id,
      room: currentRoom,
      storage: terminalStorage,
      store: {
        async getRoom() { return currentRoom },
        async setRoomIfVersion() { return false },
      },
    })).rejects.toMatchObject({ code: BATTLE_STATE_CONFLICT, status: 409 })
  })
})
