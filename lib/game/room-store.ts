import type { BattleState } from './turn'
import { prisma } from '../db'

// 玩家类型
export interface Player {
  id: string
  name: string
  joinedAt?: number
  faction?: "red" | "blue"
  selectedPieces?: Array<{ templateId: string; faction: string }>
  hasSelectedPieces?: boolean
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
export interface Room {
  id: string
  name: string
  status: RoomStatus
  players: Player[]
  currentTurnIndex: number
  battleState?: BattleState
  actions: GameAction[]
  maxPlayers?: number
  hostId?: string
  mapId?: string
  createdAt?: number
  visibility?: "private" | "public"
}

// DB 行 → Room 对象
function deserializeRoom(row: {
  id: string
  name: string
  status: string
  mapId: string | null
  hostId: string | null
  visibility: string | null
  maxPlayers: number | null
  players: string
  battleState: string | null
  createdAt: Date
  version: number
}): Room {
  const players: Player[] = JSON.parse(row.players).map((p: Player) => ({
    ...p,
    hasSelectedPieces: p.hasSelectedPieces === true || (p.selectedPieces != null && p.selectedPieces.length > 0),
    selectedPieces: p.selectedPieces || []
  }))

  return {
    id: row.id,
    name: row.name,
    status: row.status as RoomStatus,
    mapId: row.mapId ?? undefined,
    hostId: row.hostId ?? undefined,
    visibility: (row.visibility as "private" | "public") ?? undefined,
    maxPlayers: row.maxPlayers ?? undefined,
    players,
    currentTurnIndex: 0,
    actions: [],
    battleState: row.battleState ? JSON.parse(row.battleState) : undefined,
    createdAt: row.createdAt.getTime(),
  }
}

// Room 对象 → DB 行字段
function serializeRoom(room: Room) {
  const players = JSON.stringify(
    room.players.map(p => ({
      ...p,
      hasSelectedPieces: p.hasSelectedPieces === true || (p.selectedPieces != null && p.selectedPieces.length > 0),
      selectedPieces: p.selectedPieces || []
    }))
  )

  const battleState = room.battleState
    ? JSON.stringify(room.battleState, (_key, value) => {
        if (typeof value === 'function') return undefined
        return value
      })
    : null

  return {
    id: room.id,
    name: room.name,
    status: room.status,
    mapId: room.mapId ?? null,
    hostId: room.hostId ?? null,
    visibility: room.visibility ?? null,
    maxPlayers: room.maxPlayers ?? null,
    players,
    battleState,
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
      }
    })
    return deserializeRoom(row)
  }

  // 获取房间
  async getRoom(roomId: string): Promise<Room | undefined> {
    const id = roomId.trim().toLowerCase()
    const row = await prisma.room.findUnique({ where: { id } })
    if (!row) return undefined
    return deserializeRoom(row)
  }

  // 获取所有房间
  async getAllRooms(): Promise<Room[]> {
    const rows = await prisma.room.findMany()
    return rows.map(deserializeRoom)
  }

  // 设置房间（upsert）
  async setRoom(roomId: string, room: Room): Promise<void> {
    const id = roomId.trim().toLowerCase()
    const data = serializeRoom({ ...room, id })
    const { id: _id, ...updateData } = data
    await prisma.room.upsert({
      where: { id },
      update: { ...updateData, version: { increment: 1 } },
      create: data,
    })
  }

  // 移除房间
  async removeRoom(roomId: string): Promise<boolean> {
    const id = roomId.trim().toLowerCase()
    try {
      await prisma.room.delete({ where: { id } })
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
