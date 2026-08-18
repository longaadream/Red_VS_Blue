import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  assignNextRelaySeat,
  claimRelayRoomSeat,
  createRelayRoomPlayer,
  ensureRelayRoomSeats,
} from '../relay-server/src/room-seats'
import type { RoomPlayer } from '../relay-server/src/types'

function input(id: string) {
  return { id, name: id, publicKey: `public-key-${id}` }
}

describe('Relay room seat authority', () => {
  it('preserves the canonical player ID while comparing identities case-insensitively', () => {
    expect(createRelayRoomPlayer([], input('HostABC'), () => 'red').id).toBe('HostABC')
    expect(() => createRelayRoomPlayer([createRelayRoomPlayer([], input('HostABC'), () => 'red')], input('hostabc')))
      .toThrow('already joined')
  })

  it('supports both first-seat outcomes and always assigns the remaining seat second', () => {
    expect(assignNextRelaySeat([], 'host', () => 'red')).toBe('red')
    expect(assignNextRelaySeat([], 'host', () => 'blue')).toBe('blue')

    const redHost = createRelayRoomPlayer([], input('red-host'), () => 'red')
    const blueGuest = createRelayRoomPlayer([redHost], input('blue-guest'), () => 'red')
    expect(redHost.faction).toBe('red')
    expect(blueGuest.faction).toBe('blue')

    const blueHost = createRelayRoomPlayer([], input('blue-host'), () => 'blue')
    const redGuest = createRelayRoomPlayer([blueHost], input('red-guest'), () => 'blue')
    expect(blueHost.faction).toBe('blue')
    expect(redGuest.faction).toBe('red')
  })

  it('persists the assigned seat and makes legacy claim-faction idempotent', () => {
    const host = createRelayRoomPlayer([], input('host'), () => 'blue')
    const guest = createRelayRoomPlayer([host], input('guest'), () => 'red')
    const persisted = JSON.parse(JSON.stringify([host, guest])) as RoomPlayer[]

    expect(claimRelayRoomSeat(persisted, 'host')).toBe('blue')
    expect(claimRelayRoomSeat(persisted, 'guest')).toBe('red')
    expect(persisted).toMatchObject([
      { id: 'host', faction: 'blue' },
      { id: 'guest', faction: 'red' },
    ])
  })

  it('rejects missing identity keys and duplicate persisted seats', () => {
    expect(() => createRelayRoomPlayer([], { ...input('host'), publicKey: '' }, () => 'red'))
      .toThrow('publicKey is required')
    const duplicate = [
      { ...createRelayRoomPlayer([], input('alice'), () => 'red') },
      { ...createRelayRoomPlayer([], input('bob'), () => 'red'), faction: 'red' as const },
    ]
    expect(() => ensureRelayRoomSeats(duplicate)).toThrow('duplicate seats')
  })

  it('wires Relay lobby/join to server-assigned seats and removes client overwrite', () => {
    const lobby = readFileSync(resolve(process.cwd(), 'relay-server/src/routes/lobby.ts'), 'utf8')
    const rooms = readFileSync(resolve(process.cwd(), 'relay-server/src/routes/rooms.ts'), 'utf8')

    expect(lobby).toContain('createRelayRoomPlayer([],')
    expect(rooms).toContain('createRelayRoomPlayer(room.players')
    expect(rooms).toContain('claimRelayRoomSeat(room.players')
    expect(rooms).not.toContain('player.faction = body.faction')
    expect(rooms).not.toContain('faction: null')
  })
})
