import type { Player, Room } from './room-model'

export type MatchMode = '1v1' | '2v2'
export type MatchTeam = 'red' | 'blue'
export const TEAM_TURN_ORDER = ['blue', 'red', 'red', 'blue'] as const

export function matchCapacity(mode: unknown): 2 | 4 {
  if (mode === undefined || mode === '1v1') return 2
  if (mode === '2v2') return 4
  throw Object.assign(new Error('Unsupported match mode'), { code: 'MATCH_MODE_INVALID' })
}

export function nextTeamSlot(players: Player[]): number {
  const slot = TEAM_TURN_ORDER.findIndex((_, index) => !players.some(player => player.teamSlot === index))
  if (slot < 0) throw Object.assign(new Error('Room is full'), { code: 'ROOM_FULL' })
  return slot
}

export function orderedMatchPlayers(room: Room): Player[] {
  if (room.mode !== '2v2') return [...room.players].sort((a, b) => a.seat === b.seat ? 0 : a.seat === 'red' ? -1 : 1)
  if (room.players.length !== 4 || new Set(room.players.map(p => p.teamSlot)).size !== 4
    || room.players.some(p => !Number.isInteger(p.teamSlot) || TEAM_TURN_ORDER[p.teamSlot!] !== p.seat)) {
    throw Object.assign(new Error('2v2 requires four distinct blue-red-red-blue seats'), { code: 'MATCH_TEAMS_INVALID' })
  }
  return [...room.players].sort((a, b) => a.teamSlot! - b.teamSlot!)
}

interface TeamState {
  players: readonly { playerId: string; teamId?: MatchTeam }[]
}

/** Ownership is unchanged. Team equality is used only for ally/enemy rules. */
export function areMatchAllies(state: TeamState, first: string, second: string): boolean {
  const a = String(first).trim().toLowerCase()
  const b = String(second).trim().toLowerCase()
  if (a === b) return true
  const one = state.players.find(p => p.playerId.toLowerCase() === a)
  const two = state.players.find(p => p.playerId.toLowerCase() === b)
  return !!one?.teamId && one.teamId === two?.teamId
}

export function isTeamMatch(state: TeamState): boolean {
  return state.players.length === 4 && state.players.every(p => p.teamId === 'blue' || p.teamId === 'red')
}

export function nextMatchOpponent(state: TeamState, owner: string): string | undefined {
  const index = state.players.findIndex(p => p.playerId.toLowerCase() === owner.toLowerCase())
  for (let offset = 1; offset < state.players.length; offset++) {
    const player = state.players[(Math.max(0, index) + offset) % state.players.length]
    if (!areMatchAllies(state, owner, player.playerId)) return player.playerId
  }
  return undefined
}
