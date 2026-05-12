export type RoomStatus = 'waiting' | 'selecting' | 'battle' | 'waiting_host' | 'finished'
export type PlayerRole = 'host' | 'guest' | 'spectator'

export interface RoomPlayer {
  id: string
  name: string
  publicKey: string
  faction?: string
  pieces?: string[]
  connected: boolean
}

export interface ActionEntry {
  seq: number
  playerId: string
  action: unknown
  prevStateHash: string
  timestamp: number
  signature: string
}

export interface Room {
  id: string
  hostId: string
  name: string
  status: RoomStatus
  players: RoomPlayer[]
  inviteCode?: string
  lastStateBlob?: string
  actionLog: ActionEntry[]
  hostDisconnectedAt?: number
  createdAt: number
}

// WebSocket client metadata attached to each connection
export interface WsData {
  roomId?: string
  playerId?: string
  role?: PlayerRole
}

// Inbound WS messages from clients
export type WsInbound =
  | { type: 'subscribe'; playerId: string; signature: string }
  | { type: 'action'; seq: number; action: unknown; prevStateHash: string; signature: string }
  | { type: 'stateUpdate'; seq: number; state: unknown }
  | { type: 'ping' }

// Outbound WS messages to clients
export type WsOutbound =
  | { type: 'subscribed'; role: PlayerRole }
  | { type: 'pendingAction'; seq: number; action: unknown; from: string }
  | { type: 'stateUpdate'; seq: number; state: unknown }
  | { type: 'roomUpdate'; room: Omit<Room, 'lastStateBlob' | 'actionLog'> }
  | { type: 'gameOver'; winner: string }
  | { type: 'hostResume'; state: unknown }
  | { type: 'error'; message: string }
  | { type: 'pong' }
