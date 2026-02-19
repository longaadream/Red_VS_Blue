import type { PieceTemplate } from "./piece"

// 硬编码默认棋子数据，确保getPieceById总是能返回有效的棋子模板
const defaultPiecesData: Record<string, PieceTemplate> = {
  "red-mage": {
    id: "red-mage",
    name: "红方法师",
    faction: "red",
    description: "高攻击力，低防御力",
    rarity: "rare",
    image: "🔥",
    stats: {
      maxHp: 80,
      attack: 30,
      defense: 3,
      moveRange: 2
    },
    skills: [
      {
        skillId: "teleport",
        level: 1
      },
      {
        skillId: "fireball",
        level: 1
      }
    ],
    isDefault: true
  },
  "blue-mage": {
    id: "blue-mage",
    name: "蓝方法师",
    faction: "blue",
    description: "高攻击力，低防御力",
    rarity: "rare",
    image: "🔥",
    stats: {
      maxHp: 80,
      attack: 28,
      defense: 4,
      moveRange: 2
    },
    skills: [
      {
        skillId: "teleport",
        level: 1
      },
      {
        skillId: "fireball",
        level: 1
      }
    ],
    isDefault: true
  },
  "red-warrior": {
    id: "red-warrior",
    name: "红方战士",
    faction: "red",
    description: "高防御力，中等攻击力",
    rarity: "common",
    image: "⚔️",
    stats: {
      maxHp: 120,
      attack: 20,
      defense: 8,
      moveRange: 3
    },
    skills: [
      {
        skillId: "basic-attack",
        level: 1
      },
      {
        skillId: "shield",
        level: 1
      }
    ],
    isDefault: true
  },
  "blue-warrior": {
    id: "blue-warrior",
    name: "蓝方战士",
    faction: "blue",
    description: "高防御力，中等攻击力",
    rarity: "common",
    image: "⚔️",
    stats: {
      maxHp: 120,
      attack: 20,
      defense: 8,
      moveRange: 3
    },
    skills: [
      {
        skillId: "basic-attack",
        level: 1
      },
      {
        skillId: "shield",
        level: 1
      }
    ],
    isDefault: true
  },
  "red-archer": {
    id: "red-archer",
    name: "红方射手",
    faction: "red",
    description: "高攻击力，低防御力，远射程",
    rarity: "rare",
    image: "🏹",
    stats: {
      maxHp: 100,
      attack: 25,
      defense: 5,
      moveRange: 4
    },
    skills: [
      {
        skillId: "basic-attack",
        level: 1
      },
      {
        skillId: "buff-attack",
        level: 1
      }
    ],
    isDefault: true
  },
  "blue-archer": {
    id: "blue-archer",
    name: "蓝方射手",
    faction: "blue",
    description: "高攻击力，低防御力，远射程",
    rarity: "rare",
    image: "🏹",
    stats: {
      maxHp: 100,
      attack: 25,
      defense: 5,
      moveRange: 4
    },
    skills: [
      {
        skillId: "basic-attack",
        level: 1
      },
      {
        skillId: "buff-attack",
        level: 1
      }
    ],
    isDefault: true
  }
}

// 客户端版本：初始为默认棋子数据，通过API获取数据
export let DEFAULT_PIECES: Record<string, PieceTemplate> = { ...defaultPiecesData }

// 从API加载棋子数据
export async function loadPieces(): Promise<void> {
  try {
    const response = await fetch('/api/pieces')
    if (response.ok) {
      const data = await response.json()
      // 合并API返回的数据和默认数据，确保默认数据总是可用
      DEFAULT_PIECES = { ...defaultPiecesData, ...data }
    }
  } catch (error) {
    console.error('Error loading pieces:', error)
  }
}

// 服务器端版本：使用文件系统加载数据
if (typeof window === 'undefined') {
  // 只在服务器端执行
  try {
    const { loadJsonFilesServer } = require('./file-loader')
    const loadedPieces = loadJsonFilesServer<PieceTemplate>('data/pieces')
    // 合并加载的数据和默认数据，确保默认数据总是可用
    DEFAULT_PIECES = { ...defaultPiecesData, ...loadedPieces }
    
    console.log('Loaded pieces:', Object.keys(DEFAULT_PIECES))
  } catch (error) {
    console.error('Error loading pieces from files:', error)
    // 加载失败，使用默认数据
    DEFAULT_PIECES = { ...defaultPiecesData }
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

