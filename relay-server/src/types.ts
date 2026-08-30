export const STANDALONE_SELECTABLE_MAP_IDS = [
  'large-hole-arena',
  'open-expanse',
  'winding-pass',
  'narrow-corridors',
] as const
const STANDALONE_SELECTABLE_MAP_NAMES = [
  '大型洞穴',
  '开阔原野',
  '回风曲径',
  '狭廊要道',
] as const

export const STANDALONE_SELECTABLE_MAP_CATALOG = STANDALONE_SELECTABLE_MAP_IDS.map((id, index) => ({
  id,
  name: STANDALONE_SELECTABLE_MAP_NAMES[index],
}))

export type StandaloneSelectableMapId = (typeof STANDALONE_SELECTABLE_MAP_IDS)[number]
export type StandaloneMapSelectionErrorCode = 'MAP_ID_REQUIRED' | 'MAP_NOT_SELECTABLE'

export type StandaloneMapSelectionResult =
  | { ok: true; mapId: StandaloneSelectableMapId }
  | { ok: false; code: StandaloneMapSelectionErrorCode; error: string }

export function validateStandaloneMapId(input: unknown): StandaloneMapSelectionResult {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, code: 'MAP_ID_REQUIRED', error: 'A map ID is required' }
  }
  if (!(STANDALONE_SELECTABLE_MAP_IDS as readonly string[]).includes(input)) {
    return { ok: false, code: 'MAP_NOT_SELECTABLE', error: 'The requested map is not selectable' }
  }
  return { ok: true, mapId: input as StandaloneSelectableMapId }
}

export type RoomStatus = 'waiting' | 'selecting' | 'ready' | 'battle' | 'waiting_host' | 'finished'
export type PlayerRole = 'host' | 'guest' | 'spectator'
export type RelaySeat = 'red' | 'blue'
export type StandaloneRosterPiece = string | { templateId: string; faction?: string }

export interface RoomPlayer {
  id: string
  name: string
  publicKey: string
  faction?: RelaySeat
  alignment?: 'light' | 'dark'
  pieces?: StandaloneRosterPiece[]
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
  mapId?: string
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
      protocolVersion: number
      authorityBuildId: string
      publicKey: string
      payload: {
        type: 'battle-subscribe'
        roomId: string
        playerId: string
        protocolVersion: number
        authorityBuildId: string
        timestamp: number
      }
      signature: string
    }
  | {
      type: 'action'
      seq: number
      protocolVersion: number
      authorityBuildId: string
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
      authorityBuildId: string
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
  | { type: 'subscribed'; role: PlayerRole; protocolVersion: number; authorityBuildId: string }
  | {
      type: 'pendingAction'
      seq: number
      protocolVersion: number
      authorityBuildId: string
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
      authorityBuildId: string
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
