import type { RelaySeat, RoomPlayer } from './types'

type RelaySeatPicker = () => RelaySeat

export interface RelayPlayerInput {
  id: string
  name: string
  publicKey: string
}

export function isRelaySeat(value: unknown): value is RelaySeat {
  return value === 'red' || value === 'blue'
}

export function randomRelaySeat(): RelaySeat {
  return crypto.getRandomValues(new Uint8Array(1))[0] < 128 ? 'red' : 'blue'
}

export function assignNextRelaySeat(
  players: Array<Pick<RoomPlayer, 'id' | 'faction'>>,
  playerId?: string,
  chooseFirstSeat: RelaySeatPicker = randomRelaySeat,
): RelaySeat {
  const normalizedPlayerId = String(playerId || '').trim().toLowerCase()
  const existing = players.find(player => player.id.trim().toLowerCase() === normalizedPlayerId)
  if (existing && isRelaySeat(existing.faction)) return existing.faction

  const taken = players
    .filter(player => !normalizedPlayerId || player.id.trim().toLowerCase() !== normalizedPlayerId)
    .map(player => player.faction)
    .filter(isRelaySeat)
  if (taken.includes('red') && taken.includes('blue')) {
    throw new Error('Relay room already has both seats assigned')
  }
  if (taken.includes('red')) return 'blue'
  if (taken.includes('blue')) return 'red'
  return chooseFirstSeat()
}

export function ensureRelayRoomSeats(
  players: RoomPlayer[],
  chooseFirstSeat: RelaySeatPicker = randomRelaySeat,
): void {
  const assigned: RoomPlayer[] = []
  for (const player of players) {
    if (isRelaySeat(player.faction) && assigned.some(candidate => candidate.faction === player.faction)) {
      throw new Error('Relay room contains duplicate seats')
    }
    if (!isRelaySeat(player.faction)) {
      player.faction = assignNextRelaySeat(assigned, player.id, chooseFirstSeat)
    }
    assigned.push(player)
  }
}

export function createRelayRoomPlayer(
  players: RoomPlayer[],
  input: RelayPlayerInput,
  chooseFirstSeat: RelaySeatPicker = randomRelaySeat,
): RoomPlayer {
  const id = input.id.trim()
  const normalizedId = id.toLowerCase()
  const publicKey = input.publicKey.trim()
  if (!id) throw new Error('playerId is required')
  if (!publicKey) throw new Error('publicKey is required')
  ensureRelayRoomSeats(players, chooseFirstSeat)
  if (players.some(player => player.id.trim().toLowerCase() === normalizedId)) throw new Error('already joined')
  if (players.length >= 2) throw new Error('room full')
  return {
    id,
    name: input.name.trim() || 'Player',
    publicKey,
    faction: assignNextRelaySeat(players, id, chooseFirstSeat),
    connected: false,
  }
}

export function claimRelayRoomSeat(players: RoomPlayer[], playerId: string): RelaySeat {
  ensureRelayRoomSeats(players)
  const normalizedPlayerId = playerId.trim().toLowerCase()
  const player = players.find(candidate => candidate.id.trim().toLowerCase() === normalizedPlayerId)
  if (!player || !isRelaySeat(player.faction)) throw new Error('not in room')
  return player.faction
}
