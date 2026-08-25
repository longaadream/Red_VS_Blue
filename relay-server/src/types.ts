export type RoomStatus = 'waiting' | 'selecting' | 'battle' | 'waiting_host' | 'finished'
export type PlayerRole = 'host' | 'guest' | 'spectator'
export type RelaySeat = 'red' | 'blue'

export interface RoomPlayer {
  id: string
  name: string
  publicKey: string
  faction?: RelaySeat
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
  | {
      type: 'subscribe'
      roomId?: string
      playerId: string
      publicKey: string
      payload: {
        type: 'battle-subscribe'
        roomId: string
        playerId: string
        timestamp: number
      }
      signature: string
    }
  | {
      type: 'action'
      seq: number
      protocolVersion?: number
      roomId?: string
      clientActionId?: string
      expectedAuthorityVersion?: number
      playerId?: string
      command?: unknown
      action?: unknown
      auth?: unknown
      prevStateHash?: string
      signature?: string
    }
  | { type: 'stateUpdate'; seq: number; authorityVersion?: number; state: unknown; seed?: number; stateHash?: string }
  | {
      type: 'battleTransition'
      protocolVersion: number
      roomId: string
      fromVersion: number
      toVersion: number
      prePublicHash: string
      postPublicHash: string
      patch: unknown
      receipt: unknown
      pending?: unknown
      seed: number
      stateHash: string
      serverNow: number
      turnTimer?: unknown
      timings?: unknown
    }
  | { type: 'battleReceipt'; to: string; receipt: unknown }
  | {
      type: 'actionError'
      to: string
      action: unknown
      error: string
      code?: string
      preparation?: unknown
      needsTargetSelection?: boolean
      targetType?: string
      range?: number
      filter?: string
      targetIndex?: number
      needsOptionSelection?: boolean
      title?: string
      options?: unknown[]
      receipt?: unknown
    }
  | { type: 'ping' }

// Outbound WS messages to clients
export type WsOutbound =
  | { type: 'subscribed'; role: PlayerRole }
  | {
      type: 'pendingAction'
      seq: number
      protocolVersion?: number
      roomId?: string
      clientActionId?: string
      expectedAuthorityVersion?: number
      playerId?: string
      command?: unknown
      action?: unknown
      auth?: unknown
      from: string
    }
  | { type: 'stateUpdate'; seq: number; authorityVersion?: number; state: unknown; seed?: number; stateHash?: string }
  | {
      type: 'battleTransition'
      protocolVersion: number
      roomId: string
      fromVersion: number
      toVersion: number
      prePublicHash: string
      postPublicHash: string
      patch: unknown
      receipt: unknown
      pending?: unknown
      seed: number
      stateHash: string
      serverNow: number
      turnTimer?: unknown
      timings?: unknown
    }
  | { type: 'battleReceipt'; to: string; receipt: unknown }
  | {
      type: 'actionError'
      from: string
      action: unknown
      error: string
      code?: string
      preparation?: unknown
      needsTargetSelection?: boolean
      targetType?: string
      range?: number
      filter?: string
      targetIndex?: number
      needsOptionSelection?: boolean
      title?: string
      options?: unknown[]
      receipt?: unknown
    }
  | { type: 'roomUpdate'; room: Omit<Room, 'lastStateBlob' | 'actionLog'> }
  | { type: 'gameOver'; winner: string }
  | { type: 'hostResume'; authorityVersion?: number; state: unknown; seed?: number; stateHash?: string }
  | { type: 'error'; message: string; code?: string }
  | { type: 'pong' }
