import { randomInt } from 'node:crypto'
import type { BattleState } from './turn'
import { prisma } from '../db'
import { isPlayerSeat, normalizeContentAlignment, type ContentAlignment, type PlayerSeat } from './match-identity'
import { isBattleAuthorityAsyncJournalEnabled } from './battle-transition'
import {
  commitBattleAuthorityTransition as persistBattleAuthorityTransition,
  drainBattleAuthorityPersistence,
  forgetBattleAuthorityRoom,
  getBattleAuthorityReceipt as loadBattleAuthorityReceipt,
  getRememberedBattleAuthorityRoom,
  inspectBattleAuthorityPersistence,
  initializeBattleAuthorityCheckpoint as persistInitialBattleAuthorityCheckpoint,
  persistBattleAuthorityReceipt as persistAuthorityReceipt,
  readBattleAuthorityHistory as loadBattleAuthorityHistory,
  rememberBattleAuthorityRoom,
  restoreBattleAuthorityRoom,
} from '../server/battle-authority-persistence'

export type { PlayerSeat } from './match-identity'
export type PlayerAlignment = ContentAlignment

export function normalizePlayerAlignment(value: unknown): PlayerAlignment | undefined {
  return normalizeContentAlignment(value)
}

export function alignmentToPieceFaction(alignment: PlayerAlignment | undefined): "good" | "evil" | undefined {
  if (alignment === "light") return "good"
  if (alignment === "dark") return "evil"
  return undefined
}

export function getPlayerSeat(player: { seat?: PlayerSeat; faction?: PlayerSeat }): PlayerSeat | undefined {
  return isPlayerSeat(player.seat) ? player.seat : isPlayerSeat(player.faction) ? player.faction : undefined
}

export function randomPlayerSeat(): PlayerSeat {
  return randomInt(2) === 0 ? 'red' : 'blue'
}

export function assignNextSeat(players: Array<{ id?: string; seat?: PlayerSeat; faction?: PlayerSeat }>, playerId?: string, chooseFirstSeat: () => PlayerSeat = randomPlayerSeat): PlayerSeat {
  const normalizedPlayerId = playerId ? playerId.trim().toLowerCase() : undefined
  const taken = players
    .filter(p => !normalizedPlayerId || !p.id || p.id.toLowerCase() !== normalizedPlayerId)
    .map(getPlayerSeat)
    .filter(Boolean) as PlayerSeat[]
  if (taken.includes("red") && !taken.includes("blue")) return "blue"
  if (taken.includes("blue") && !taken.includes("red")) return "red"
  return chooseFirstSeat()
}

// 玩家类型
export interface Player {
  id: string
  /** Stable account identity. A local debug account may control two match players. */
  accountId?: string
  name: string
  joinedAt?: number
  /** red/blue are relative battle seats only. They do not mean light/dark. */
  seat?: PlayerSeat
  /** Legacy alias for seat kept for existing battle/setup code. */
  faction?: PlayerSeat
  /** Player-chosen content alignment. Same-alignment mirrors are allowed. */
  alignment?: PlayerAlignment
  /** Public key used by the decentralized identity/signature flow. */
  publicKey?: string
  packMd5?: string
  selectedPieces?: Array<{ templateId: string; faction: string }>
  hasSelectedPieces?: boolean
  /** A confirmed Demo roster. Once true, only an equivalent resubmission is accepted. */
  rosterLocked?: boolean
  /** Admission-manifest version used when the roster was locked. */
  rosterManifestVersion?: string
  ready?: boolean
  isBot?: boolean
}

// 观战者类型
export interface Spectator {
  id: string
  name: string
  joinedAt: number
}

// 房间状态类型
export type RoomStatus = 'waiting' | 'ready' | 'in-progress' | 'finished'

// 游戏动作类型
export interface GameAction {
  type: string
  playerId: string
  payload?: any
}

// 房间类型
export interface GameRecord {
  gameId: string
  timestamp: number
  roomId: string
  players: Array<{ id: string; name: string; publicKey?: string }>
  winner: string | null
  signatures: Record<string, string>
}

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
  /** Explicit authority field derived from the red seat when the room battle starts. */
  firstPlayerId?: string
  mapId?: string
  createdAt?: number
  visibility?: "private" | "public"
  inviteCode?: string
  version?: number
  /** Monotonic battle-only version; lobby/spectator writes must not advance it. */
  battleAuthorityVersion?: number
  /** SHA-256 chain head for the committed battleAuthorityVersion. */
  battleAuthorityTransitionHash?: string
  /** Runtime-only durable watermark for the asynchronous RED-109 journal. */
  battleAuthorityDurableVersion?: number
  /** Runtime-only persistence health; never used to adjudicate game rules. */
  battleAuthorityPersistenceStatus?: 'durable' | 'pending' | 'degraded'
  gameRecord?: GameRecord
}

// DB 行 → Room 对象
function deserializeRoom(row: {
  id: string
  name: string
  status: string
  mapId: string | null
  hostId: string | null
  visibility: string | null
  inviteCode?: string | null
  maxPlayers: number | null
  players: string
  spectators?: string | null
  battleState: string | null
  createdAt: Date
  version: number
  battleAuthorityVersion: number
  battleAuthorityTransitionHash: string
}): Room {
  const players: Player[] = JSON.parse(row.players).map((p: Player) => ({
    ...p,
    seat: p.seat || p.faction,
    faction: p.faction || p.seat,
    hasSelectedPieces: p.rosterLocked === true,
    selectedPieces: p.selectedPieces || []
  }))

  const spectators: Spectator[] = row.spectators ? JSON.parse(row.spectators) : []

  return {
    id: row.id,
    name: row.name,
    status: row.status as RoomStatus,
    mapId: row.mapId ?? undefined,
    hostId: row.hostId ?? undefined,
    visibility: (row.visibility as "private" | "public") ?? undefined,
    inviteCode: row.inviteCode ?? undefined,
    maxPlayers: row.maxPlayers ?? undefined,
    players,
    spectators,
    currentTurnIndex: 0,
    actions: [],
    battleState: row.battleState ? JSON.parse(row.battleState) : undefined,
    createdAt: row.createdAt.getTime(),
    version: row.version,
    battleAuthorityVersion: row.battleAuthorityVersion,
    battleAuthorityTransitionHash: row.battleAuthorityTransitionHash,
  }
}

// Room 对象 → DB 行字段
function serializeRoom(room: Room) {
  const players = JSON.stringify(
    room.players.map(p => ({
      ...p,
      seat: p.seat || p.faction,
      faction: p.faction || p.seat,
      hasSelectedPieces: p.rosterLocked === true,
      selectedPieces: p.selectedPieces || []
    }))
  )

  // 序列化时排除 skillsById（静态数据，可从文件重新加载，避免占用过多 Neon 存储）
  const battleStateToStore = room.battleState
    ? (() => { const { skillsById: _skills, ...rest } = room.battleState; return rest })()
    : null
  const battleState = battleStateToStore
    ? JSON.stringify(battleStateToStore, (_key, value) => {
        if (typeof value === 'function') return undefined
        return value
      })
    : null

  const spectators = JSON.stringify(room.spectators || [])

  return {
    id: room.id,
    name: room.name,
    status: room.status,
    mapId: room.mapId ?? null,
    hostId: room.hostId ?? null,
    visibility: room.visibility ?? null,
    inviteCode: room.inviteCode ?? null,
    maxPlayers: room.maxPlayers ?? null,
    players,
    spectators,
    battleState,
    battleAuthorityVersion: room.battleAuthorityVersion ?? 0,
    battleAuthorityTransitionHash: room.battleAuthorityTransitionHash ?? '',
  }
}

// 房间存储类（Prisma 版本）
export class RoomStore {
  // 创建新房间
  async createRoom(roomId: string, roomName: string): Promise<Room> {
    const id = roomId.trim().toLowerCase()
    const row = await prisma.room.create({
      data: {
        id,
        name: roomName,
        status: 'waiting',
        players: '[]',
        spectators: '[]',
      }
    })
    return deserializeRoom(row)
  }

  // 获取房间
  async getRoom(roomId: string): Promise<Room | undefined> {
    const id = roomId.trim().toLowerCase()
    if (isBattleAuthorityAsyncJournalEnabled()) {
      const cached = getRememberedBattleAuthorityRoom(id)
      if (cached) return cached
    }
    const row = await prisma.room.findUnique({ where: { id } })
    if (!row) return undefined
    return restoreBattleAuthorityRoom(deserializeRoom(row))
  }

  // 获取所有房间
  async getAllRooms(): Promise<Room[]> {
    const rows = await prisma.room.findMany()
    return rows.map(row => {
      const room = deserializeRoom(row)
      return isBattleAuthorityAsyncJournalEnabled()
        ? getRememberedBattleAuthorityRoom(room.id) ?? room
        : room
    })
  }

  // 设置房间（upsert）
  async setRoom(roomId: string, room: Room): Promise<void> {
    const id = roomId.trim().toLowerCase()
    const data = serializeRoom({ ...room, id })
    const cached = isBattleAuthorityAsyncJournalEnabled()
      ? getRememberedBattleAuthorityRoom(id)
      : undefined
    const {
      id: _id,
      battleAuthorityVersion: _battleAuthorityVersion,
      battleAuthorityTransitionHash: _battleAuthorityTransitionHash,
      ...updateData
    } = data
    const { battleState: _cachedBattleState, ...metadataUpdate } = updateData
    await prisma.room.upsert({
      where: { id },
      update: { ...(cached ? metadataUpdate : updateData), version: { increment: 1 } },
      create: data,
    })
    if (cached) {
      rememberBattleAuthorityRoom(mergeCachedBattleRoom(
        cached,
        { ...room, id },
        (room.version ?? cached.version ?? 0) + 1,
      ))
    } else {
      forgetBattleAuthorityRoom(id)
    }
  }

  // 带乐观锁的更新：仅当 DB 版本 === expectedVersion 时才写入
  // 返回 true = 成功；false = 版本冲突（另一个请求已更新）
  async setRoomIfVersion(roomId: string, room: Room, expectedVersion: number): Promise<boolean> {
    const id = roomId.trim().toLowerCase()
    const data = serializeRoom({ ...room, id })
    const cached = isBattleAuthorityAsyncJournalEnabled()
      ? getRememberedBattleAuthorityRoom(id)
      : undefined
    const {
      id: _id,
      battleAuthorityVersion: _battleAuthorityVersion,
      battleAuthorityTransitionHash: _battleAuthorityTransitionHash,
      ...updateData
    } = data
    const { battleState: _cachedBattleState, ...metadataUpdate } = updateData
    const result = await prisma.room.updateMany({
      where: { id, version: expectedVersion },
      data: { ...(cached ? metadataUpdate : updateData), version: { increment: 1 } },
    })
    if (result.count > 0) {
      if (cached) {
        rememberBattleAuthorityRoom(mergeCachedBattleRoom(cached, { ...room, id }, expectedVersion + 1))
      } else {
        forgetBattleAuthorityRoom(id)
      }
    }
    return result.count > 0
  }

  // 移除房间
  async removeRoom(roomId: string): Promise<boolean> {
    const id = roomId.trim().toLowerCase()
    if (isBattleAuthorityAsyncJournalEnabled()) {
      try {
        await drainBattleAuthorityPersistence(id)
      } catch (error) {
        console.error('[room-store] refusing to delete room with undurable authority journal', {
          roomId: id,
          error: error instanceof Error ? error.message : String(error),
        })
        return false
      }
    }
    try {
      await prisma.$transaction([
        prisma.battleAuthorityReceipt.deleteMany({ where: { roomId: id } }),
        prisma.battleAuthorityTransition.deleteMany({ where: { roomId: id } }),
        prisma.battleAuthorityCheckpoint.deleteMany({ where: { roomId: id } }),
        prisma.room.delete({ where: { id } }),
      ])
      forgetBattleAuthorityRoom(id)
      return true
    } catch {
      return false
    }
  }

  // deleteRoom 别名
  async deleteRoom(roomId: string): Promise<boolean> {
    return this.removeRoom(roomId)
  }

  // 添加玩家到房间
  async addPlayer(roomId: string, player: Player): Promise<boolean> {
    const room = await this.getRoom(roomId)
    if (!room || room.status !== 'waiting') return false
    if (room.players.some(p => p.id === player.id)) return false
    room.players.push(player)
    await this.setRoom(roomId, room)
    return true
  }

  // 更新房间状态
  async updateRoomStatus(roomId: string, status: RoomStatus): Promise<boolean> {
    const room = await this.getRoom(roomId)
    if (!room) return false
    room.status = status
    await this.setRoom(roomId, room)
    return true
  }

  // 更新战斗状态
  async updateBattleState(roomId: string, battleState: BattleState): Promise<boolean> {
    const room = await this.getRoom(roomId)
    if (!room) return false
    room.battleState = battleState
    await this.setRoom(roomId, room)
    return true
  }

  // 添加游戏动作
  async addAction(roomId: string, action: GameAction): Promise<boolean> {
    const room = await this.getRoom(roomId)
    if (!room) return false
    room.actions.push(action)
    await this.setRoom(roomId, room)
    return true
  }

  // 添加观战者
  async addSpectator(roomId: string, spectator: Spectator): Promise<boolean> {
    const room = await this.getRoom(roomId)
    if (!room) return false
    if (!room.spectators) room.spectators = []
    // 已存在则更新 joinedAt
    const existing = room.spectators.findIndex(s => s.id === spectator.id)
    if (existing >= 0) {
      room.spectators[existing] = spectator
    } else {
      room.spectators.push(spectator)
    }
    await this.setRoom(roomId, room)
    return true
  }

  // 移除观战者
  async removeSpectator(roomId: string, spectatorId: string): Promise<boolean> {
    const room = await this.getRoom(roomId)
    if (!room) return false
    if (!room.spectators) return true
    room.spectators = room.spectators.filter(s => s.id !== spectatorId)
    await this.setRoom(roomId, room)
    return true
  }

  async getBattleAuthorityReceipt(
    roomId: string,
    clientActionId: string,
  ): ReturnType<typeof loadBattleAuthorityReceipt> {
    return loadBattleAuthorityReceipt(roomId, clientActionId)
  }

  async persistBattleAuthorityReceipt(
    receipt: Parameters<typeof persistAuthorityReceipt>[0],
  ): Promise<void> {
    await persistAuthorityReceipt(receipt)
  }

  async commitBattleAuthorityTransition(
    input: Parameters<typeof persistBattleAuthorityTransition>[0],
  ): Promise<boolean> {
    return persistBattleAuthorityTransition(input)
  }

  async readBattleAuthorityHistory(
    roomId: string,
  ): ReturnType<typeof loadBattleAuthorityHistory> {
    return loadBattleAuthorityHistory(roomId)
  }

  async initializeBattleAuthorityCheckpoint(
    input: Parameters<typeof persistInitialBattleAuthorityCheckpoint>[0],
  ): Promise<void> {
    await persistInitialBattleAuthorityCheckpoint(input)
  }

  inspectBattleAuthorityPersistence(roomId: string) {
    return inspectBattleAuthorityPersistence(roomId)
  }

  async drainBattleAuthorityPersistence(roomId?: string): Promise<void> {
    await drainBattleAuthorityPersistence(roomId)
  }

  // 旧接口兼容（同步包装，返回 Map）
  getRooms(): Map<string, Room> {
    throw new Error('getRooms() is async now, use getAllRooms()')
  }

  // 与存储同步（Prisma 版本无需此操作，保留空实现供兼容）
  syncWithStorage(): void {}
}

// 单例
const globalForStore = globalThis as unknown as { roomStore: RoomStore }

export const roomStore: RoomStore =
  globalForStore.roomStore || new RoomStore()

if (process.env.NODE_ENV !== 'production') globalForStore.roomStore = roomStore

export function getRoomStore(): RoomStore {
  return roomStore
}

function mergeCachedBattleRoom(cached: Room, metadata: Room, version: number): Room {
  return {
    ...metadata,
    version,
    status: cached.status === 'finished' ? 'finished' : metadata.status,
    battleState: cached.battleState,
    battleAuthorityVersion: cached.battleAuthorityVersion,
    battleAuthorityTransitionHash: cached.battleAuthorityTransitionHash,
    battleAuthorityDurableVersion: cached.battleAuthorityDurableVersion,
    battleAuthorityPersistenceStatus: cached.battleAuthorityPersistenceStatus,
  }
}
