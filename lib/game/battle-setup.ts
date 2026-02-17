import { getMap, DEFAULT_MAP_ID } from "@/config/maps"
import type { BoardMap } from "./map"
import type { PieceInstance, PieceTemplate, PieceStats } from "./piece"
import type { SkillDefinition, SkillState } from "./skills"
import type { BattleState, PlayerId } from "./turn"
import { loadJsonFilesServer } from "./file-loader"
import { DEFAULT_PIECES } from "./piece-repository"

export function buildDefaultSkills(): Record<string, SkillDefinition> {
  // 从JSON文件加载技能
  const skills = loadJsonFilesServer<SkillDefinition>('data/skills')
  
  // 打印加载的技能
  console.log('Loaded skills:', Object.keys(skills))
  
  // 如果没有加载到技能，返回空对象
  if (Object.keys(skills).length === 0) {
    console.warn('No skills loaded from JSON files, returning empty object')
    return {}
  }
  
  return skills
}

export function buildDefaultPieceStats(): Record<string, PieceStats> {
  return {
    "red-warrior": {
      maxHp: 120,
      attack: 20,
      defense: 5,
      moveRange: 3,
    },
    "blue-warrior": {
      maxHp: 120,
      attack: 20,
      defense: 5,
      moveRange: 3,
    },
  }
}

export function buildInitialPiecesForPlayers(
  map: BoardMap,
  players: PlayerId[],
  selectedPieces: PieceTemplate[],
): PieceInstance[] {
  if (players.length !== 2) return []
  
  const [p1, p2] = players
  
  // 固定分配玩家到红方和蓝方，避免随机导致的问题
  const redPlayer = p1
  const bluePlayer = p2
  
  // 为每个玩家创建棋子
  const pieces: PieceInstance[] = []
  
  // 找到所有可走的地板方格（F方格）
  const floorTiles = map.tiles.filter(tile => 
    tile.props.walkable && tile.props.type === "floor"
  )
  
  // 如果没有地板方格，使用所有可走的方格
  const availableTiles = floorTiles.length > 0 ? floorTiles : map.tiles.filter(tile => tile.props.walkable)
  
  // 随机选择位置的函数
  const getRandomPosition = () => {
    if (availableTiles.length === 0) {
      // 如果没有可走的方格，返回默认位置
      return { x: Math.floor(map.width / 2), y: Math.floor(map.height / 2) }
    }
    const randomIndex = Math.floor(Math.random() * availableTiles.length)
    return { x: availableTiles[randomIndex].x, y: availableTiles[randomIndex].y }
  }
  
  console.log('Selected pieces count:', selectedPieces.length)
  console.log('Selected pieces:', selectedPieces)
  
  // 为红方玩家添加棋子
  let redPieceIndex = 0
  
  // 添加红方专属棋子
  for (const pieceTemplate of selectedPieces) {
    if (pieceTemplate.faction === "red") {
      const position = getRandomPosition()
      pieces.push({
        instanceId: `${redPlayer}-${redPieceIndex + 1}`,
        templateId: pieceTemplate.id,
        ownerPlayerId: redPlayer,
        faction: "red",
        currentHp: pieceTemplate.stats.maxHp,
        maxHp: pieceTemplate.stats.maxHp,
        attack: pieceTemplate.stats.attack,
        defense: pieceTemplate.stats.defense,
        moveRange: pieceTemplate.stats.moveRange,
        x: position.x,
        y: position.y,
        skills: pieceTemplate.skills.map(s => ({
          skillId: s.skillId,
          currentCooldown: 0,
          currentCharges: 0,
          unlocked: true,
        } as SkillState)),
      })
      redPieceIndex++
    }
  }
  
  // 为蓝方玩家添加棋子
  let bluePieceIndex = 0
  
  // 添加蓝方专属棋子
  for (const pieceTemplate of selectedPieces) {
    if (pieceTemplate.faction === "blue") {
      const position = getRandomPosition()
      pieces.push({
        instanceId: `${bluePlayer}-${bluePieceIndex + 1}`,
        templateId: pieceTemplate.id,
        ownerPlayerId: bluePlayer,
        faction: "blue",
        currentHp: pieceTemplate.stats.maxHp,
        maxHp: pieceTemplate.stats.maxHp,
        attack: pieceTemplate.stats.attack,
        defense: pieceTemplate.stats.defense,
        moveRange: pieceTemplate.stats.moveRange,
        x: position.x,
        y: position.y,
        skills: pieceTemplate.skills.map(s => ({
          skillId: s.skillId,
          currentCooldown: 0,
          currentCharges: 0,
          unlocked: true,
        } as SkillState)),
      })
      bluePieceIndex++
    }
  }
  
  console.log('Red pieces created:', redPieceIndex)
  console.log('Blue pieces created:', bluePieceIndex)
  
  // 确保至少有一个棋子
  if (pieces.length === 0) {
    console.log('No pieces created, adding default pieces')
    
    // 获取两个不同的随机位置
    const redPosition = getRandomPosition()
    let bluePosition = getRandomPosition()
    
    // 确保两个位置不同
    while (bluePosition.x === redPosition.x && bluePosition.y === redPosition.y && availableTiles.length > 1) {
      bluePosition = getRandomPosition()
    }
    
    // 添加默认红方棋子
    const defaultRedPiece = DEFAULT_PIECES["red-warrior"]
    pieces.push({
      instanceId: `${redPlayer}-1`,
      templateId: defaultRedPiece.id,
      ownerPlayerId: redPlayer,
      faction: "red",
      currentHp: defaultRedPiece.stats.maxHp,
      maxHp: defaultRedPiece.stats.maxHp,
      attack: defaultRedPiece.stats.attack,
      defense: defaultRedPiece.stats.defense,
      moveRange: defaultRedPiece.stats.moveRange,
      x: redPosition.x,
      y: redPosition.y,
      skills: defaultRedPiece.skills.map(s => ({
        skillId: s.skillId,
        currentCooldown: 0,
        currentCharges: 0,
        unlocked: true,
      })),
    })
    
    // 添加默认蓝方棋子
    const defaultBluePiece = DEFAULT_PIECES["blue-warrior"]
    pieces.push({
      instanceId: `${bluePlayer}-1`,
      templateId: defaultBluePiece.id,
      ownerPlayerId: bluePlayer,
      faction: "blue",
      currentHp: defaultBluePiece.stats.maxHp,
      maxHp: defaultBluePiece.stats.maxHp,
      attack: defaultBluePiece.stats.attack,
      defense: defaultBluePiece.stats.defense,
      moveRange: defaultBluePiece.stats.moveRange,
      x: bluePosition.x,
      y: bluePosition.y,
      skills: defaultBluePiece.skills.map(s => ({
        skillId: s.skillId,
        currentCooldown: 0,
        currentCharges: 0,
        unlocked: true,
      })),
    })
  }
  
  console.log('Final pieces count:', pieces.length)
  console.log('Final pieces:', pieces)
  
  return pieces
}

export function createInitialBattleForPlayers(
  playerIds: PlayerId[],
  selectedPieces: PieceTemplate[],
): BattleState | null {
  if (playerIds.length !== 2) return null

  const [p1, p2] = playerIds
  
  // 尝试获取默认地图
  const map = getMap(DEFAULT_MAP_ID)
  
  // 如果地图没有加载成功，使用默认地图
  if (!map) {
    console.warn(`Map ${DEFAULT_MAP_ID} not found, using default map`)
    
    // 创建一个更真实的默认地图，包含墙壁和不同类型的格子
    const defaultMap: BoardMap = {
      id: "default-8x6",
      name: "默认地图",
      width: 8,
      height: 6,
      tiles: [],
    }
    
    // 生成地图格子
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 8; x++) {
        // 边缘是墙壁
        if (x === 0 || x === 7 || y === 0 || y === 5) {
          defaultMap.tiles.push({
            id: `default-${x}-${y}`,
            x,
            y,
            props: {
              walkable: false,
              bulletPassable: false,
              type: "wall",
            },
          })
        } 
        // 中间区域是地板
        else {
          defaultMap.tiles.push({
            id: `default-${x}-${y}`,
            x,
            y,
            props: {
              walkable: true,
              bulletPassable: true,
              type: "floor",
            },
          })
        }
      }
    }
    
    const pieces = buildInitialPiecesForPlayers(defaultMap, playerIds, selectedPieces)
    const redPlayer = pieces.find(piece => piece.faction === "red")?.ownerPlayerId || p1
    
    return {
      map: defaultMap,
      pieces,
      pieceStatsByTemplateId: buildDefaultPieceStats(),
      skillsById: buildDefaultSkills(),
      players: [
        { playerId: p1, chargePoints: 0 },
        { playerId: p2, chargePoints: 0 },
      ],
      turn: {
        currentPlayerId: redPlayer,
        turnNumber: 1,
        phase: "start",
        actions: {
          hasMoved: false,
          hasUsedBasicSkill: false,
          hasUsedChargeSkill: false,
        },
      },
    }
  }

  const pieces = buildInitialPiecesForPlayers(map, playerIds, selectedPieces)
  const redPlayer = pieces.find(piece => piece.faction === "red")?.ownerPlayerId || p1

  return {
    map,
    pieces,
    pieceStatsByTemplateId: buildDefaultPieceStats(),
    skillsById: buildDefaultSkills(),
    players: [
      { playerId: p1, chargePoints: 0 },
      { playerId: p2, chargePoints: 0 },
    ],
    turn: {
      currentPlayerId: redPlayer,
      turnNumber: 1,
      phase: "start",
      actions: {
        hasMoved: false,
        hasUsedBasicSkill: false,
        hasUsedChargeSkill: false,
      },
    },
  }
}
