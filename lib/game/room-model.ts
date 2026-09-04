import { randomInt } from 'node:crypto'

import type { GameProfileIdentityV1 } from '../content-pipeline/runtime/profile-game-identity'
import type { BattleState } from './turn'
import {
  isPlayerSeat,
  normalizeContentAlignment,
  type ContentAlignment,
  type PlayerSeat,
} from './match-identity'

export type { PlayerSeat } from './match-identity'
export type PlayerAlignment = ContentAlignment

export function normalizePlayerAlignment(value: unknown): PlayerAlignment | undefined {
  return normalizeContentAlignment(value)
}

export function alignmentToPieceFaction(
  alignment: PlayerAlignment | undefined,
): 'good' | 'evil' | undefined {
  if (alignment === 'light') return 'good'
  if (alignment === 'dark') return 'evil'
  return undefined
}

export function getPlayerSeat(player: {
  seat?: PlayerSeat
  faction?: PlayerSeat
}): PlayerSeat | undefined {
  return isPlayerSeat(player.seat)
    ? player.seat
    : isPlayerSeat(player.faction)
      ? player.faction
      : undefined
}

export function randomPlayerSeat(): PlayerSeat {
  return randomInt(2) === 0 ? 'red' : 'blue'
}

export function assignNextSeat(
  players: Array<{ id?: string; seat?: PlayerSeat; faction?: PlayerSeat }>,
  playerId?: string,
  chooseFirstSeat: () => PlayerSeat = randomPlayerSeat,
): PlayerSeat {
  const normalizedPlayerId = playerId?.trim().toLowerCase()
  const taken = players
    .filter(player => !normalizedPlayerId || !player.id || player.id.toLowerCase() !== normalizedPlayerId)
    .map(getPlayerSeat)
    .filter((seat): seat is PlayerSeat => seat !== undefined)
  if (taken.includes('red') && !taken.includes('blue')) return 'blue'
  if (taken.includes('blue') && !taken.includes('red')) return 'red'
  return chooseFirstSeat()
}

export interface Player {
  id: string
  accountId?: string
  name: string
  joinedAt?: number
  seat?: PlayerSeat
  /** Compatibility alias in the rule model; it is not a transport fallback. */
  faction?: PlayerSeat
  alignment?: PlayerAlignment
  publicKey?: string
  profileIdentity?: GameProfileIdentityV1
  selectedPieces?: Array<{ templateId: string; faction: string }>
  hasSelectedPieces?: boolean
  rosterLocked?: boolean
  rosterManifestVersion?: string
  ready?: boolean
  isBot?: boolean
}

export interface Spectator {
  id: string
  name: string
  joinedAt: number
  profileIdentity?: GameProfileIdentityV1
}

export type RoomStatus = 'waiting' | 'ready' | 'in-progress' | 'finished'

export interface GameAction {
  type: string
  playerId: string
  payload?: unknown
}

export interface GameRecord {
  gameId: string
  timestamp: number
  roomId: string
  players: Array<{ id: string; name: string; publicKey?: string }>
  winner: string | null
  signatures: Record<string, string>
}

/** Transport-neutral rule state shared by Colyseus and deterministic tests. */
export interface Room {
  id: string
  name: string
  status: RoomStatus
  players: Player[]
  spectators: Spectator[]
  currentTurnIndex: number
  battleState?: BattleState
  actions: GameAction[]
  maxPlayers?: number
  hostId?: string
  firstPlayerId?: string
  mapId?: string
  createdAt?: number
  visibility?: 'private' | 'public'
  inviteCode?: string
  version?: number
  battleAuthorityVersion?: number
  battleAuthorityTransitionHash?: string
  battleAuthorityDurableVersion?: number
  battleAuthorityPersistenceStatus?: 'durable' | 'pending' | 'degraded'
  gameRecord?: GameRecord
}
