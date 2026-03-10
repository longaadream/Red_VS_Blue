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
  // 已删除房间ID集合，防止syncWithStorage重新加载
  private deletedRoomIds: Set<string> = new Set()

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

    // 确保使用小写ID作为文件名
    const lowerCaseId = room.id.toLowerCase()
    const filePath = path.join(this.storagePath, `${lowerCaseId}.json`)

    try {
      const roomWithValidPlayers = {
        ...room,
        id: lowerCaseId,  // 确保房间ID是小写
        players: room.players.map(player => ({
          ...player,
          // 确保 hasSelectedPieces 和 selectedPieces 都被正确保存
          hasSelectedPieces: player.hasSelectedPieces === true || (player.selectedPieces && player.selectedPieces.length > 0),
          selectedPieces: player.selectedPieces || []
        }))
      }

      // Use a replacer to strip functions (rule.effect etc.) so JSON.stringify never throws
      const roomData = JSON.stringify(roomWithValidPlayers, (_key, value) => {
        if (typeof value === 'function') return undefined
        return value
      }, 2)
      fs.writeFileSync(filePath, roomData)
      console.log(`[saveRoom] Room ${lowerCaseId} saved successfully with ${room.players.length} players`)
    } catch (error) {
      console.error(`[saveRoom] Error saving room ${room.id}:`, error)
    }
  }

  // 从存储加载单个房间
  private loadRoom(roomId: string): Room | null {
    if (!this.storagePath) return null

    // 确保使用小写ID作为文件名
    const lowerCaseId = roomId.toLowerCase()
    const filePath = path.join(this.storagePath, `${lowerCaseId}.json`)

    if (!fs.existsSync(filePath)) {
      return null
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const room = JSON.parse(content) as Room
      // 确保加载的房间ID是小写
      room.id = room.id.toLowerCase()
      // 确保玩家数据正确
      room.players = room.players.map(player => ({
        ...player,
        hasSelectedPieces: player.hasSelectedPieces === true || (player.selectedPieces && player.selectedPieces.length > 0),
        selectedPieces: player.selectedPieces || []
      }))
      return room
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
  // 策略：以磁盘为准，内存中只保留磁盘上存在的房间
  syncWithStorage(): void {
    if (!this.storagePath) return
    
    try {
      if (!fs.existsSync(this.storagePath)) {
        // 如果存储目录不存在，清空内存
        this.rooms.clear()
        return
      }
      
      const files = fs.readdirSync(this.storagePath)
      const diskRoomIds = new Set<string>()
      
      // 第一步：加载磁盘上存在的房间到内存
      files.forEach(file => {
        if (file.endsWith('.json')) {
          const roomId = file.replace('.json', '')
          const lowerCaseId = roomId.trim().toLowerCase()
          diskRoomIds.add(lowerCaseId)
          
          // 跳过已删除的房间（删除标记）
          if (this.deletedRoomIds.has(lowerCaseId)) {
            // 删除磁盘文件
            const filePath = path.join(this.storagePath!, `${lowerCaseId}.json`)
            try {
              if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath)
                console.log(`[syncWithStorage] Deleted file for removed room: ${lowerCaseId}`)
              }
            } catch {
              // 忽略删除错误
            }
            diskRoomIds.delete(lowerCaseId)
            return
          }
          
          // 加载或更新房间
          const existingRoom = this.rooms.get(lowerCaseId)
          if (!existingRoom) {
            // 内存中没有，从磁盘加载
            const room = this.loadRoom(lowerCaseId)
            if (room) {
              const roomWithCorrectId = {
                ...room,
                id: lowerCaseId
              }
              this.rooms.set(lowerCaseId, roomWithCorrectId)
              console.log(`[syncWithStorage] Loaded room: ${lowerCaseId}`)
            }
          }
          // 如果内存中已有，保留内存版本（避免覆盖未保存的更改）
        }
      })
      
      // 第二步：删除内存中存在但磁盘上不存在的房间
      const memoryRoomIds = Array.from(this.rooms.keys())
      for (const roomId of memoryRoomIds) {
        if (!diskRoomIds.has(roomId) && !this.deletedRoomIds.has(roomId)) {
          console.log(`[syncWithStorage] Removing room from memory (not on disk): ${roomId}`)
          this.rooms.delete(roomId)
        }
      }
      
    } catch (error) {
      console.error('[syncWithStorage] Error:', error)
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
    const lowerCaseId = trimmedRoomId.toLowerCase()
    
    // 清除删除标记（以防房间被重新创建）
    this.deletedRoomIds.delete(lowerCaseId)
    
    const newRoom: Room = {
      id: lowerCaseId,  // 强制使用小写ID
      name: roomName,
      status: 'waiting',
      players: [],
      currentTurnIndex: 0,
      actions: [],
      createdAt: Date.now()
    }
    this.rooms.set(lowerCaseId, newRoom)
    this.saveRoom(newRoom)
    return newRoom
  }

  // 获取房间 - 始终从磁盘读取，避免Next.js模块重新加载导致内存数据丢失
  getRoom(roomId: string, loadFromStorage: boolean = true): Room | undefined {
    const trimmedRoomId = roomId.trim()
    const lowerCaseId = trimmedRoomId.toLowerCase()

    // 直接从磁盘加载房间，不依赖内存
    if (loadFromStorage) {
      const room = this.loadRoom(lowerCaseId)
      if (room) {
        // 更新内存缓存
        this.rooms.set(lowerCaseId, room)
        return room
      }
    }
    
    // 如果不需要从磁盘加载，或磁盘没有，尝试从内存获取
    return this.rooms.get(lowerCaseId) || this.rooms.get(trimmedRoomId)
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

  // 移除房间 - 强制删除，确保内存和磁盘都删除
  removeRoom(roomId: string): boolean {
    const trimmedRoomId = roomId.trim()
    const lowerCaseId = trimmedRoomId.toLowerCase()
    
    // 添加到已删除集合，防止syncWithStorage重新加载
    this.deletedRoomIds.add(lowerCaseId)
    
    // 删除所有可能的键（包括大小写变体）
    const keysToDelete: string[] = []
    this.rooms.forEach((room, key) => {
      if (key.trim().toLowerCase() === lowerCaseId || 
          room.id.trim().toLowerCase() === lowerCaseId) {
        keysToDelete.push(key)
      }
    })
    keysToDelete.forEach(key => this.rooms.delete(key))
    
    // 从磁盘删除所有可能的文件变体
    let storageDeleted = true
    if (this.storagePath) {
      const variations = [
        trimmedRoomId,
        trimmedRoomId.toLowerCase(),
        trimmedRoomId.toUpperCase()
      ]
      
      variations.forEach(variant => {
        const filePath = path.join(this.storagePath!, `${variant}.json`)
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
            console.log(`[removeRoom] Deleted file: ${filePath}`)
          }
        } catch (error) {
          console.error(`[removeRoom] Error deleting file ${filePath}:`, error)
          storageDeleted = false
        }
      })
    }
    
    // 验证删除结果
    const roomStillExists = Array.from(this.rooms.values()).some(room => 
      room.id.trim().toLowerCase() === lowerCaseId
    )
    
    const success = !roomStillExists && storageDeleted
    console.log(`[removeRoom] Room ${trimmedRoomId} removal result:`, { 
      success, 
      roomStillExists, 
      storageDeleted,
      deletedKeys: keysToDelete 
    })
    
    return success
  }

  // 设置房间
  setRoom(roomId: string, room: Room): void {
    const trimmedRoomId = roomId.trim()
    const lowerCaseId = trimmedRoomId.toLowerCase()

    // 确保玩家数据正确
    const roomWithValidPlayers = {
      ...room,
      id: lowerCaseId,  // 强制使用小写ID
      players: room.players.map(player => ({
        ...player,
        // 确保 hasSelectedPieces 和 selectedPieces 都被正确处理
        hasSelectedPieces: player.hasSelectedPieces === true || (player.selectedPieces && player.selectedPieces.length > 0),
        selectedPieces: player.selectedPieces || []
      }))
    }

    // 清除删除标记（以防房间被重新创建）
    this.deletedRoomIds.delete(lowerCaseId)

    // 先更新内存，确保内存状态是最新的（使用小写ID）
    this.rooms.set(lowerCaseId, roomWithValidPlayers)
    // 然后保存到磁盘
    this.saveRoom(roomWithValidPlayers)
  }

  // 删除房间 - 强制立即删除，优先级最高
  deleteRoom(roomId: string): boolean {
    // 直接调用 removeRoom，确保逻辑一致
    return this.removeRoom(roomId)
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
