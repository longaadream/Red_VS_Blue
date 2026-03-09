import type { BattleState } from './turn'
import fs from 'fs'
import path from 'path'

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

// 房间存储类
export class RoomStore {
  private rooms: Map<string, Room> = new Map()
  private storagePath: string | null = null

  constructor() {
    // 初始化存储路径
    if (typeof window === 'undefined') {
      this.storagePath = path.join(process.cwd(), 'data', 'rooms')
      this.ensureStorageDirectory()
      this.clearOldStorage()
      this.loadRooms()
    }
  }

  // 确保存储目录存在
  private ensureStorageDirectory(): void {
    if (!this.storagePath) return
    
    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true })
    }
  }

  // 保存单个房间到存储
  private saveRoom(room: Room): void {
    if (!this.storagePath) return

    const filePath = path.join(this.storagePath, `${room.id}.json`)

    try {
      const roomWithValidPlayers = {
        ...room,
        players: room.players.map(player => ({
          ...player,
          hasSelectedPieces: player.hasSelectedPieces === true || (player.selectedPieces && player.selectedPieces.length > 0)
        }))
      }

      // Use a replacer to strip functions (rule.effect etc.) so JSON.stringify never throws
      const roomData = JSON.stringify(roomWithValidPlayers, (_key, value) => {
        if (typeof value === 'function') return undefined
        return value
      }, 2)
      fs.writeFileSync(filePath, roomData)
    } catch (error) {
      console.error(`Error saving room ${room.id}:`, error)
    }
  }

  // 从存储加载单个房间
  private loadRoom(roomId: string): Room | null {
    if (!this.storagePath) return null
    
    const filePath = path.join(this.storagePath, `${roomId}.json`)
    
    if (!fs.existsSync(filePath)) {
      return null
    }
    
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      return JSON.parse(content) as Room
    } catch (error) {
      // console.error(`Error loading room ${roomId}:`, error)
      return null
    }
  }

  // 从存储加载所有房间
  private loadRooms(): void {
    this.syncWithStorage()
  }

  // 与存储同步，确保内存与存储一致
  syncWithStorage(): void {
    if (!this.storagePath) return
    
    try {
      if (!fs.existsSync(this.storagePath)) {
        this.rooms.clear()
        return
      }
      
      const files = fs.readdirSync(this.storagePath)
      
      const storageRoomIds = files
        .filter(file => file.endsWith('.json'))
        .map(file => file.replace('.json', '').trim())
      
      this.rooms.clear()
      
      files.forEach(file => {
        if (file.endsWith('.json')) {
          const roomId = file.replace('.json', '')
          const trimmedRoomId = roomId.trim()
          const room = this.loadRoom(trimmedRoomId)
          if (room) {
            const roomWithCorrectId = {
              ...room,
              id: trimmedRoomId
            }
            this.rooms.set(trimmedRoomId, roomWithCorrectId)
          }
        }
      })
    } catch (error) {
      // console.error('Error syncing with storage:', error)
    }
  }

  // 删除存储中的房间
  private deleteStoredRoom(roomId: string): boolean {
    if (!this.storagePath) return false
    
    const filePath = path.join(this.storagePath, `${roomId}.json`)
    
    try {
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath)
          return true
        } catch (error) {
          return false
        }
      } else {
        return true
      }
    } catch (error) {
      return false
    }
  }

  // 创建新房间
  createRoom(roomId: string, roomName: string): Room {
    const trimmedRoomId = roomId.trim()
    const newRoom: Room = {
      id: trimmedRoomId,
      name: roomName,
      status: 'waiting',
      players: [],
      currentTurnIndex: 0,
      actions: [],
      createdAt: Date.now()
    }
    this.rooms.set(trimmedRoomId, newRoom)
    this.saveRoom(newRoom)
    return newRoom
  }

  // 获取房间
  getRoom(roomId: string, loadFromStorage: boolean = true): Room | undefined {
    const trimmedRoomId = roomId.trim()

    // Only sync from disk if the room isn't already in memory.
    // Syncing on every call clears in-memory state with (potentially stale)
    // disk data, which can lose battle state when saveRoom fails silently.
    if (!this.rooms.has(trimmedRoomId)) {
      this.syncWithStorage()
    }

    let room = this.rooms.get(trimmedRoomId)
    
    if (room) {
      const roomWithValidPlayers = {
        ...room,
        players: room.players.map(player => ({
          ...player,
          hasSelectedPieces: player.hasSelectedPieces === true || (player.selectedPieces && player.selectedPieces.length > 0)
        }))
      }
      this.rooms.set(trimmedRoomId, roomWithValidPlayers)
      room = roomWithValidPlayers
    }
    
    // console.log('Get room result:', { roomId: trimmedRoomId, found: !!room, mapId: room?.mapId })
    return room
  }

  // 获取所有房间
  getAllRooms(): Room[] {
    this.syncWithStorage()
    return Array.from(this.rooms.values())
  }

  // 获取所有房间（返回 Map 实例）
  getRooms(): Map<string, Room> {
    this.syncWithStorage()
    return this.rooms
  }

  // 添加玩家到房间
  addPlayer(roomId: string, player: Player): boolean {
    const room = this.getRoom(roomId)
    if (!room || room.status !== 'waiting') {
      return false
    }
    if (room.players.some(p => p.id === player.id)) {
      return false
    }
    room.players.push(player)
    this.saveRoom(room)
    return true
  }

  // 更新房间状态
  updateRoomStatus(roomId: string, status: RoomStatus): boolean {
    const room = this.getRoom(roomId)
    if (!room) {
      return false
    }
    room.status = status
    this.saveRoom(room)
    return true
  }

  // 更新房间的战斗状态
  updateBattleState(roomId: string, battleState: BattleState): boolean {
    const room = this.getRoom(roomId)
    if (!room) {
      return false
    }
    room.battleState = battleState
    this.saveRoom(room)
    return true
  }

  // 添加游戏动作到房间
  addAction(roomId: string, action: GameAction): boolean {
    const room = this.getRoom(roomId)
    if (!room) {
      return false
    }
    room.actions.push(action)
    this.saveRoom(room)
    return true
  }

  // 移除房间
  removeRoom(roomId: string): boolean {
    const trimmedRoomId = roomId.trim()
    
    const storageDeleted = this.deleteStoredRoom(trimmedRoomId)
    this.syncWithStorage()
    
    const roomStillExists = Array.from(this.rooms.values()).some(room => 
      room.id.trim().toLowerCase() === trimmedRoomId.toLowerCase()
    )
    
    return !roomStillExists
  }

  // 设置房间
  setRoom(roomId: string, room: Room): void {
    const trimmedRoomId = roomId.trim()

    const roomWithCorrectId = {
      ...room,
      id: trimmedRoomId
    }

    this.saveRoom(roomWithCorrectId)
    this.syncWithStorage()
    // Always ensure in-memory reflects the intended state, even if saveRoom
    // silently failed (e.g. serialization error) and syncWithStorage loaded
    // stale data from disk.
    this.rooms.set(trimmedRoomId, roomWithCorrectId)
  }

  // 删除房间 - 强制立即删除，优先级最高
  deleteRoom(roomId: string): boolean {
    const trimmedRoomId = roomId.trim()
    
    if (this.storagePath) {
      const filePath = path.join(this.storagePath, `${trimmedRoomId}.json`)
      
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath)
        }
      } catch (error) {
        // console.error('ERROR: Failed to delete room file:', error)
      }
    }
    
    this.syncWithStorage()
    
    const remainingRooms = Array.from(this.rooms.keys())
    
    const hasAnyMatch = remainingRooms.some(key => {
      const keyMatches = key.trim().toLowerCase() === trimmedRoomId.toLowerCase()
      const room = this.rooms.get(key)
      const roomIdMatches = room && (room.id.trim().toLowerCase() === trimmedRoomId.toLowerCase())
      return keyMatches || roomIdMatches
    })
    
    let storageClean = true
    if (this.storagePath) {
      const filePath = path.join(this.storagePath, `${trimmedRoomId}.json`)
      storageClean = !fs.existsSync(filePath)
    }
    
    const finalResult = !hasAnyMatch && storageClean
    return finalResult
  }
  
  // 清除旧的rooms.json存储（如果存在）
  private clearOldStorage(): void {
    const oldStoragePath = path.join(process.cwd(), 'rooms.json')
    if (fs.existsSync(oldStoragePath)) {
      try {
        fs.writeFileSync(oldStoragePath, JSON.stringify([]))
      } catch (error) {
        // console.error('Error clearing old storage:', error)
      }
    }
  }
}

// 导出单例实例
let roomStoreInstance: RoomStore | null = null

export function getRoomStore(): RoomStore {
  if (!roomStoreInstance) {
    roomStoreInstance = new RoomStore()
  }
  return roomStoreInstance
}

// 导出默认单例实例
export const roomStore = getRoomStore()
