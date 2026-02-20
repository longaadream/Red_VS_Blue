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
      // 确保存储目录存在
      this.ensureStorageDirectory()
      // 从存储加载房间
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
      fs.writeFileSync(filePath, JSON.stringify(room, null, 2))
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
      console.error(`Error loading room ${roomId}:`, error)
      return null
    }
  }

  // 从存储加载所有房间
  private loadRooms(): void {
    if (!this.storagePath) return
    
    if (!fs.existsSync(this.storagePath)) {
      return
    }
    
    try {
      const files = fs.readdirSync(this.storagePath)
      console.log('Found room files:', files)
      
      // 清空现有的房间列表，避免重复加载
      this.rooms.clear()
      console.log('Cleared existing rooms from memory')
      
      files.forEach(file => {
        if (file.endsWith('.json')) {
          const roomId = file.replace('.json', '')
          const room = this.loadRoom(roomId)
          if (room) {
            console.log('Loading room:', roomId)
            this.rooms.set(roomId, room)
          }
        }
      })
      
      console.log('Rooms loaded from storage:', Array.from(this.rooms.keys()))
    } catch (error) {
      console.error('Error loading rooms:', error)
    }
  }

  // 删除存储中的房间
  private deleteStoredRoom(roomId: string): void {
    if (!this.storagePath) {
      console.error('Storage path is not set, cannot delete room file')
      return
    }
    
    const filePath = path.join(this.storagePath, `${roomId}.json`)
    
    console.log('Attempting to delete room file:', filePath)
    
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath)
        console.log('Successfully deleted room file:', filePath)
      } catch (error) {
        console.error(`Error deleting room ${roomId} from storage:`, error)
      }
    } else {
      console.log('Room file does not exist:', filePath)
    }
  }

  // 创建新房间
  createRoom(roomId: string, roomName: string): Room {
    const newRoom: Room = {
      id: roomId,
      name: roomName,
      status: 'waiting',
      players: [],
      currentTurnIndex: 0,
      actions: [],
      createdAt: Date.now()
    }
    this.rooms.set(roomId, newRoom)
    this.saveRoom(newRoom)
    return newRoom
  }

  // 获取房间
  getRoom(roomId: string): Room | undefined {
    const trimmedRoomId = roomId.trim()
    console.log('=== Get Room Operation ===')
    console.log('Input roomId:', { original: roomId, trimmed: trimmedRoomId })
    console.log('Current rooms in memory:', Array.from(this.rooms.keys()))
    
    // 先从内存中获取，只使用修剪后的 ID
    let room = this.rooms.get(trimmedRoomId)
    console.log('Get room with trimmed ID:', !!room)
    
    // 如果内存中没有，尝试从存储中加载
    if (!room) {
      console.log('Room not in memory, trying to load from storage:', trimmedRoomId)
      const loadedRoom = this.loadRoom(trimmedRoomId)
      if (loadedRoom) {
        console.log('Loaded room from storage:', trimmedRoomId)
        room = loadedRoom
        this.rooms.set(trimmedRoomId, room)
        console.log('Room added to memory:', trimmedRoomId)
      } else {
        console.log('Room not found in storage:', trimmedRoomId)
      }
    }
    
    console.log('Get room result:', { roomId: trimmedRoomId, found: !!room })
    if (room && room.players) {
      console.log('Players in room:', room.players.map(p => ({
        id: p.id,
        hasSelectedPieces: p.hasSelectedPieces,
        selectedPiecesCount: p.selectedPieces?.length || 0
      })))
    }
    console.log('=== Get Room Operation Complete ===')
    return room
  }

  // 获取所有房间
  getAllRooms(): Room[] {
    return Array.from(this.rooms.values())
  }

  // 获取所有房间（返回 Map 实例）
  getRooms(): Map<string, Room> {
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
    const removed = this.rooms.delete(roomId)
    if (removed) {
      this.deleteStoredRoom(roomId)
    }
    return removed
  }

  // 设置房间
  setRoom(roomId: string, room: Room): void {
    const trimmedRoomId = roomId.trim()
    console.log('Setting room:', { originalRoomId: roomId, trimmedRoomId, roomName: room.name })
    console.log('Players in room to set:', room.players?.map(p => ({
      id: p.id,
      hasSelectedPieces: p.hasSelectedPieces,
      selectedPiecesCount: p.selectedPieces?.length || 0
    })) || [])
    
    // 确保房间 ID 与传入的 ID 一致
    const roomWithCorrectId = {
      ...room,
      id: trimmedRoomId
    }
    
    this.rooms.set(trimmedRoomId, roomWithCorrectId)
    this.saveRoom(roomWithCorrectId)
    console.log('Room set successfully:', trimmedRoomId)
    console.log('Players after set:', this.rooms.get(trimmedRoomId)?.players?.map(p => ({
      id: p.id,
      hasSelectedPieces: p.hasSelectedPieces,
      selectedPiecesCount: p.selectedPieces?.length || 0
    })) || [])
  }

  // 删除房间
  deleteRoom(roomId: string): boolean {
    const trimmedRoomId = roomId.trim()
    console.log('=== Delete Room Operation ===')
    console.log('Input roomId:', { original: roomId, trimmed: trimmedRoomId })
    console.log('Current rooms in memory before delete:', Array.from(this.rooms.keys()))
    
    // 尝试删除房间，先使用修剪后的 ID，再使用原始 ID
    let deleted = this.rooms.delete(trimmedRoomId)
    console.log('Delete result with trimmed ID:', deleted)
    
    if (!deleted) {
      deleted = this.rooms.delete(roomId)
      console.log('Delete result with original ID:', deleted)
    }
    
    // 无论房间是否存在于内存中，都尝试从存储中删除房间文件
    // 这样即使房间不在内存中，也能从文件系统中删除
    console.log('Attempting to delete room file from storage:', trimmedRoomId)
    this.deleteStoredRoom(trimmedRoomId)
    
    console.log('Final delete result:', deleted || true) // 即使房间不存在，也返回 true，表示删除操作已尝试
    console.log('Current rooms in memory after delete:', Array.from(this.rooms.keys()))
    console.log('=== Delete Room Operation Complete ===')
    return true // 总是返回 true，表示删除操作已尝试
  }
}

// 导出单例实例
export const roomStore = new RoomStore()