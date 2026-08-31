import { describe, expect, it, vi } from 'vitest'

import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { clearRoomDeploymentTimeout } from '@/lib/game/room-battle-actions'
import { startBattleFromLockedRosters } from '@/lib/game/room-battle-start'
import type { Room } from '@/lib/game/room-store'
import {
  DEMO_ROSTER_MANIFEST_VERSION,
  getDefaultDemoRosterSelection,
  type RosterRoomStore,
} from '@/lib/game/roster-contract'
import { TriggerSystem } from '@/lib/game/triggers'

const PLAYERS = ['player-red', 'player-blue'] as const

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

class MemoryRosterRoomStore implements RosterRoomStore {
  room: Room
  writes = 0

  constructor(room: Room) {
    this.room = clone(room)
  }

  async getRoom(roomId: string): Promise<Room | undefined> {
    return roomId === this.room.id ? clone(this.room) : undefined
  }

  async setRoom(roomId: string, room: Room): Promise<void> {
    if (roomId !== this.room.id) throw new Error('Room not found')
    this.room = clone(room)
    this.writes += 1
  }

  async setRoomIfVersion(roomId: string, room: Room, expectedVersion: number): Promise<boolean> {
    if (roomId !== this.room.id || this.room.version !== expectedVersion) return false
    this.room = { ...clone(room), version: expectedVersion + 1 }
    this.writes += 1
    return true
  }
}

function readyRoom(): Room {
  const profileIdentity = getServerGameProfileIdentityV1()
  return {
    id: 'red-138-opening-terminal-room',
    name: 'RED-138 opening terminal room',
    status: 'ready',
    mapId: 'large-hole-arena',
    players: [
      {
        id: PLAYERS[0],
        name: 'Red',
        seat: 'red',
        alignment: 'light',
        selectedPieces: getDefaultDemoRosterSelection('light'),
        rosterLocked: true,
        rosterManifestVersion: DEMO_ROSTER_MANIFEST_VERSION,
        profileIdentity,
      },
      {
        id: PLAYERS[1],
        name: 'Blue',
        seat: 'blue',
        alignment: 'dark',
        selectedPieces: getDefaultDemoRosterSelection('dark'),
        rosterLocked: true,
        rosterManifestVersion: DEMO_ROSTER_MANIFEST_VERSION,
        profileIdentity,
      },
    ],
    spectators: [],
    currentTurnIndex: 0,
    actions: [],
    version: 1,
  }
}

describe('RED-138 opening terminal room settlement', () => {
  it('commits a terminal opening as finished without starting or scheduling the turn timer', async () => {
    const room = readyRoom()
    const store = new MemoryRosterRoomStore(room)
    const notifications: unknown[] = []
    const originalTimerFlag = process.env.RVB_TURN_TIMER_ENABLED
    const originalAuthorityFlag = process.env.RVB_BATTLE_AUTHORITY_V2
    let openingSummonQueueCount = 0
    const checkTriggers = TriggerSystem.prototype.checkTriggers
    const triggerSpy = vi.spyOn(TriggerSystem.prototype, 'checkTriggers').mockImplementation(function (
      this: TriggerSystem,
      state,
      context,
    ) {
      const result = checkTriggers.call(this, state, context)
      if (context.type === 'afterPieceSummoned' && context.sourcePiece?.isCore === true) {
        openingSummonQueueCount += 1
        const index = state.pieces.findIndex(piece =>
          piece.instanceId === context.sourcePiece?.instanceId)
        const [removed] = index >= 0 ? state.pieces.splice(index, 1) : []
        if (removed) {
          removed.currentHp = 0
          removed.x = null
          removed.y = null
          state.graveyard.push(removed)
        }
      }
      return result
    })

    process.env.RVB_TURN_TIMER_ENABLED = '1'
    delete process.env.RVB_BATTLE_AUTHORITY_V2
    vi.useFakeTimers()

    try {
      const started = await startBattleFromLockedRosters(store, room.id, {
        clock: { now: () => 1_000 },
        onDeploymentUpdate: snapshot => {
          notifications.push(snapshot)
        },
      })
      const state = (store.room.battleState as any).state

      expect(started.started).toBe(true)
      expect(openingSummonQueueCount).toBe(2)
      expect(store.room.status).toBe('finished')
      expect(state.deployment?.openingVanguardsInitialized).toBe(true)
      expect(state.terminalResult).toMatchObject({
        winnerPlayerId: null,
        loserPlayerId: null,
        reason: 'mutual-core-elimination',
      })
      expect(state.gameStartFired).not.toBe(true)
      expect(state.deployment?.offerPieceIds).toBeUndefined()
      expect(state.turnTimer).toBeUndefined()
      expect(store.writes).toBe(1)
      expect(notifications).toHaveLength(1)

      await vi.runOnlyPendingTimersAsync()
      expect(store.writes).toBe(1)
      expect(notifications).toHaveLength(1)

      const resumed = await startBattleFromLockedRosters(store, room.id, {
        clock: { now: () => 2_000 },
        onDeploymentUpdate: snapshot => {
          notifications.push(snapshot)
        },
      })
      expect(resumed.started).toBe(false)
      expect(store.writes).toBe(1)
      expect(notifications).toHaveLength(1)
    } finally {
      clearRoomDeploymentTimeout(room.id)
      triggerSpy.mockRestore()
      vi.useRealTimers()
      if (originalTimerFlag === undefined) delete process.env.RVB_TURN_TIMER_ENABLED
      else process.env.RVB_TURN_TIMER_ENABLED = originalTimerFlag
      if (originalAuthorityFlag === undefined) delete process.env.RVB_BATTLE_AUTHORITY_V2
      else process.env.RVB_BATTLE_AUTHORITY_V2 = originalAuthorityFlag
    }
  })
})
