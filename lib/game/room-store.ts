import type { BattleState } from "./turn"
import { readFileSync, writeFileSync, existsSync } from "fs"
import { join } from "path"

type Player = {
  id: string
  name: string
  joinedAt: number
  faction?: "red" | "blue"
  selectedPieces?: Array<{ templateId: string; faction: string }>
  hasSelectedPieces?: boolean
}

type RoomStatus = "waiting" | "in-progress" | "finished"

type GameAction = {
  id: string
  playerId: string
  type: string
  payload: unknown
  createdAt: number
  turn: number
}

export type Room = {
  id: string
  name: string
  status: RoomStatus
  createdAt: number
  maxPlayers: number
  players: Player[]
  hostId: string
  mapId: string
  visibility: "private" | "public"
  currentTurnIndex: number
  actions: GameAction[]
  battleState: BattleState | null
  selectedPieces?: Array<{ templateId: string; faction: string }>
}

// 存储文件路径
const STORAGE_FILE = join(process.cwd(), "rooms.json")

// 房间存储类
class RoomStore {
  private rooms: Map<string, Room>

  constructor() {
    // 从文件加载数据
    this.rooms = this.loadFromFile()
  }

  // 从文件加载
  private loadFromFile(): Map<string, Room> {
    try {
      if (existsSync(STORAGE_FILE)) {
        const data = readFileSync(STORAGE_FILE, "utf8")
        const roomsArray = JSON.parse(data)
        const map = new Map<string, Room>()
        roomsArray.forEach((room: Room) => map.set(room.id, room))
        return map
      }
    } catch (error) {
      console.error("Failed to load rooms from file:", error)
    }
    return new Map<string, Room>()
  }

  // 保存到文件
  private saveToFile(): void {
    try {
      const roomsArray = Array.from(this.rooms.values())
      writeFileSync(STORAGE_FILE, JSON.stringify(roomsArray, null, 2))
    } catch (error) {
      console.error("Failed to save rooms to file:", error)
    }
  }

  // 获取所有房间
  getRooms(): Map<string, Room> {
    return this.rooms
  }

  // 标准化房间ID（转换为小写，确保大小写不敏感）
  private normalizeId(id: string): string {
    return id.toLowerCase()
  }

  // 获取单个房间（大小写不敏感）
  getRoom(id: string): Room | undefined {
    const normalizedId = this.normalizeId(id)
    return this.rooms.get(normalizedId)
  }

  // 分配玩家身份
  assignFaction(room: Room, playerId: string): "red" | "blue" | null {
    // 检查玩家是否已经有身份
    const existingPlayer = room.players.find(p => p.id === playerId)
    if (existingPlayer && existingPlayer.faction) {
      return existingPlayer.faction
    }

    // 检查已分配的身份
    const assignedFactions = room.players.map(p => p.faction).filter(Boolean) as Array<"red" | "blue">
    
    // 如果两个身份都已分配，返回null
    if (assignedFactions.length >= 2) {
      return null
    }

    // 如果还没有分配身份，随机分配一个
    if (assignedFactions.length === 0) {
      const randomFaction = Math.random() > 0.5 ? "red" : "blue"
      if (existingPlayer) {
        existingPlayer.faction = randomFaction
      }
      return randomFaction
    }

    // 如果已经分配了一个身份，分配剩下的那个
    const remainingFaction = assignedFactions[0] === "red" ? "blue" : "red"
    if (existingPlayer) {
      existingPlayer.faction = remainingFaction
    }
    return remainingFaction
  }

  // 添加房间
  setRoom(id: string, room: Room): void {
    const normalizedId = this.normalizeId(id)
    // 更新房间对象的ID为标准化后的ID
    const normalizedRoom = { ...room, id: normalizedId }
    console.log('Saving room:', normalizedId, room.name)
    this.rooms.set(normalizedId, normalizedRoom)
    this.saveToFile()
    console.log('Rooms in store:', Array.from(this.rooms.keys()))
  }

  // 删除房间（大小写不敏感）
  deleteRoom(id: string): boolean {
    const normalizedId = this.normalizeId(id)
    const result = this.rooms.delete(normalizedId)
    this.saveToFile()
    return result
  }
}

// 导出单例实例（使用 globalThis 确保跨模块共享）
declare global {
  // eslint-disable-next-line no-var
  var __roomStore: RoomStore | undefined
}

const roomStore = globalThis.__roomStore ?? new RoomStore()

if (!globalThis.__roomStore) {
  globalThis.__roomStore = roomStore
}

export default roomStore
