import type { PieceTemplate } from "./piece"

// 客户端版本：初始为空对象，通过API获取数据
export let DEFAULT_PIECES: Record<string, PieceTemplate> = {}

// 从API加载棋子数据
export async function loadPieces(): Promise<void> {
  try {
    const response = await fetch('/api/pieces')
    if (response.ok) {
      DEFAULT_PIECES = await response.json()
    }
  } catch (error) {
    console.error('Error loading pieces:', error)
  }
}

// 服务器端版本：使用文件系统加载数据
if (typeof window === 'undefined') {
  // 只在服务器端执行
  const { loadJsonFilesServer } = require('./file-loader')
  DEFAULT_PIECES = loadJsonFilesServer<PieceTemplate>('data/pieces')
  
  // 如果没有加载到棋子，使用空对象
  if (Object.keys(DEFAULT_PIECES).length === 0) {
    console.warn('No pieces loaded from JSON files, using empty object')
  }
}

export function getPieceById(id: string): PieceTemplate | undefined {
  return DEFAULT_PIECES[id]
}

export function getPiecesByFaction(faction: "red" | "blue"): PieceTemplate[] {
  return Object.values(DEFAULT_PIECES).filter(
    (piece) => piece.faction === faction
  )
}

export function getAllPieces(): PieceTemplate[] {
  return Object.values(DEFAULT_PIECES)
}

