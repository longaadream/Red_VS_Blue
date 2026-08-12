import type { Faction, PieceTemplate } from "./piece"
import { loadJsonFilesServer } from './file-loader'

// 客户端版本：初始为空对象，通过API获取数据
export let DEFAULT_PIECES: Record<string, PieceTemplate> = {}

// 从API加载棋子数据
export async function loadPieces(): Promise<void> {
  try {
    const response = await fetch('/api/pieces')
    if (response.ok) {
      const data = await response.json()
      // 检查API返回的数据格式
      if (data && data.pieces && Array.isArray(data.pieces)) {
        // 将数组转换为对象格式
        const piecesObject: Record<string, PieceTemplate> = {}
        data.pieces.forEach((piece: PieceTemplate) => {
          piecesObject[piece.id] = piece
        })
        // 直接使用API返回的数据，不使用默认数据
        DEFAULT_PIECES = piecesObject
        console.log('Loaded pieces from API:', Object.keys(DEFAULT_PIECES))
      }
    }
  } catch (error) {
    console.error('Error loading pieces:', error)
    // 加载失败，使用空对象
    DEFAULT_PIECES = {}
  }
}

// 服务器端版本：使用文件系统加载数据
if (typeof window === 'undefined') {
  // 只在服务器端执行
  try {
    const loadedPieces = loadJsonFilesServer<PieceTemplate>('data/pieces')
    // 直接使用加载的数据，不使用默认数据
    DEFAULT_PIECES = loadedPieces
    
    console.log('Loaded pieces:', Object.keys(DEFAULT_PIECES))
  } catch (error) {
    console.error('Error loading pieces from files:', error)
    // 加载失败，使用空对象
    DEFAULT_PIECES = {}
  }
}

export function getPieceById(id: string): PieceTemplate | undefined {
  return DEFAULT_PIECES[id]
}

export function getPiecesByFaction(faction: Faction): PieceTemplate[] {
  return Object.values(DEFAULT_PIECES).filter(
    (piece) => piece.faction === faction
  )
}

export function getAllPieces(): PieceTemplate[] {
  return Object.values(DEFAULT_PIECES)
}
