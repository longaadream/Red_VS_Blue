import { getMapAsync, getMap, DEFAULT_MAP_ID, loadMaps } from "@/config/maps"
import type { BoardMap } from "./map"
import type { PieceInstance, PieceTemplate, PieceStats } from "./piece"
import type { SkillDefinition, SkillState } from "./skills"
import type { BattleState, PlayerId } from "./turn"
import { loadJsonFilesServer } from "./file-loader"
import { DEFAULT_PIECES } from "./piece-repository"
import { globalTriggerSystem } from "./triggers"

// 确保地图数据在模块加载时就被加载
loadMaps().catch(error => {
  console.error('Error loading maps in battle-setup:', error)
})

export function buildDefaultSkills(): Record<string, SkillDefinition> {
  // 从文件系统加载技能数据
  const loadedSkills = loadJsonFilesServer<SkillDefinition>('data/skills')
  
  console.log('Loaded skills from files:', Object.keys(loadedSkills))
  console.log('Number of skills:', Object.keys(loadedSkills).length)
  
  return loadedSkills
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

// 玩家选择的棋子信息
interface PlayerSelectedPieces {
  playerId: string
  pieces: PieceTemplate[]
}

export function buildInitialPiecesForPlayers(
  map: BoardMap,
  players: PlayerId[],
  selectedPieces: PieceTemplate[],
  playerSelectedPieces?: PlayerSelectedPieces[]
): PieceInstance[] {
  if (players.length !== 2) return []
  
  const [p1, p2] = players
  
  // 固定分配玩家到红方和蓝方，避免随机导致的问题
  // 玩家数组已按红方在前、蓝方在后的顺序排序
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
  
  // 随机选择位置的函数，确保位置不重叠
  const getRandomPosition = () => {
    if (availableTiles.length === 0) {
      // 如果没有可走的方格，返回默认位置
      return { x: Math.floor(map.width / 2), y: Math.floor(map.height / 2) }
    }
    
    // 尝试最多100次，找到一个未被占用的位置
    for (let i = 0; i < 100; i++) {
      const randomIndex = Math.floor(Math.random() * availableTiles.length)
      const position = { x: availableTiles[randomIndex].x, y: availableTiles[randomIndex].y }
      
      // 检查位置是否已经被占用
      const isOccupied = pieces.some(piece => piece.x === position.x && piece.y === position.y)
      if (!isOccupied) {
        return position
      }
    }
    
    // 如果所有位置都被占用，返回第一个可用位置
    return { x: availableTiles[0].x, y: availableTiles[0].y }
  }
  
  console.log('Selected pieces count:', selectedPieces.length)
  console.log('Selected pieces:', selectedPieces)
  console.log('Player selected pieces:', playerSelectedPieces)
  
  // 初始化棋子计数器
  let redPieceIndex = 0
  let bluePieceIndex = 0
  
  // 分配棋子给玩家
  // 优先使用玩家选择的棋子信息
  if (playerSelectedPieces && playerSelectedPieces.length > 0) {
    console.log('Using player selected pieces info for allocation')
    console.log('Player selected pieces:', playerSelectedPieces)
    console.log('Red player:', redPlayer)
    console.log('Blue player:', bluePlayer)
    
    // 为每个玩家分配棋子
    // 确保红方玩家获得红方棋子，蓝方玩家获得蓝方棋子
    playerSelectedPieces.forEach((playerInfo, playerIndex) => {
      const playerId = playerInfo.playerId
      
      // 确定玩家的所有者ID和对应阵营
      const ownerPlayerId = playerIndex === 0 ? redPlayer : bluePlayer
      const expectedFaction = playerIndex === 0 ? "red" : "blue"
      
      console.log(`Allocating pieces for player ${playerId} (owner: ${ownerPlayerId}, expected faction: ${expectedFaction})`)
      
      let pieceIndex = 0
      playerInfo.pieces.forEach(pieceTemplate => {
        const position = getRandomPosition()
        // 强制使用对应玩家的阵营，确保红方玩家获得红方棋子，蓝方玩家获得蓝方棋子
        const actualFaction = expectedFaction
        pieces.push({
          instanceId: `${ownerPlayerId}-${pieceIndex + 1}`,
          templateId: pieceTemplate.id,
          ownerPlayerId,
          faction: actualFaction,
          currentHp: pieceTemplate.stats.maxHp,
          maxHp: pieceTemplate.stats.maxHp,
          attack: pieceTemplate.stats.attack,
          defense: pieceTemplate.stats.defense,
          moveRange: pieceTemplate.stats.moveRange,
          x: position.x,
          y: position.y,
          skills: pieceTemplate.skills.map(s => {
            // 检查技能是否为限定技
            const isUltimate = s.skillId.includes('ultimate') || s.skillId.includes('ult');
            return {
              skillId: s.skillId,
              currentCooldown: 0,
              currentCharges: 0,
              unlocked: true,
              usesRemaining: isUltimate ? 1 : -1, // 限定技1次，普通技能无限制
            } as SkillState;
          }),
        })
        pieceIndex++
        
        // 更新计数器
        if (actualFaction === "red") {
          redPieceIndex++
        } else {
          bluePieceIndex++
        }
      })
    })
  } else {
    // 没有玩家选择的棋子信息，根据棋子模板的faction属性分配，
    // 确保每个玩家至少有一个棋子，并且分配给正确的阵营
    console.log('Using default allocation based on piece faction')
    
    // 收集红方和蓝方的棋子模板
    const redPieces = selectedPieces.filter(piece => piece.faction === "red")
    const bluePieces = selectedPieces.filter(piece => piece.faction === "blue")
    
    console.log('Red pieces found:', redPieces.length)
    console.log('Blue pieces found:', bluePieces.length)
    
    // 为红方玩家分配棋子
    if (redPieces.length > 0) {
      redPieces.forEach((pieceTemplate, index) => {
        const position = getRandomPosition()
        pieces.push({
          instanceId: `${redPlayer}-${index + 1}`,
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
          skills: pieceTemplate.skills.map(s => {
            // 检查技能是否为限定技
            const isUltimate = s.skillId.includes('ultimate') || s.skillId.includes('ult');
            return {
              skillId: s.skillId,
              currentCooldown: 0,
              currentCharges: 0,
              unlocked: true,
              usesRemaining: isUltimate ? 1 : -1, // 限定技1次，普通技能无限制
            } as SkillState;
          }),
        })
        redPieceIndex++
      })
    }
    
    // 为蓝方玩家分配棋子
    if (bluePieces.length > 0) {
      bluePieces.forEach((pieceTemplate, index) => {
        const position = getRandomPosition()
        pieces.push({
          instanceId: `${bluePlayer}-${index + 1}`,
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
          skills: pieceTemplate.skills.map(s => {
            // 检查技能是否为限定技
            const isUltimate = s.skillId.includes('ultimate') || s.skillId.includes('ult');
            return {
              skillId: s.skillId,
              currentCooldown: 0,
              currentCharges: 0,
              unlocked: true,
              usesRemaining: isUltimate ? 1 : -1, // 限定技1次，普通技能无限制
            } as SkillState;
          }),
        })
        bluePieceIndex++
      })
    }
    
    // 如果没有按阵营分配到足够的棋子，将剩余棋子平均分配给两个玩家
    const remainingPieces = selectedPieces.filter(piece => 
      !redPieces.includes(piece) && !bluePieces.includes(piece)
    )
    
    console.log('Remaining pieces to distribute:', remainingPieces.length)
    
    if (remainingPieces.length > 0) {
      remainingPieces.forEach((pieceTemplate, index) => {
        // 交替分配给两个玩家
        const isRedPlayer = index % 2 === 0
        const playerId = isRedPlayer ? redPlayer : bluePlayer
        const faction = isRedPlayer ? "red" : "blue"
        const pieceIndex = isRedPlayer ? redPieceIndex : bluePieceIndex
        
        const position = getRandomPosition()
        pieces.push({
          instanceId: `${playerId}-${pieceIndex + 1}`,
          templateId: pieceTemplate.id,
          ownerPlayerId: playerId,
          faction: faction,
          currentHp: pieceTemplate.stats.maxHp,
          maxHp: pieceTemplate.stats.maxHp,
          attack: pieceTemplate.stats.attack,
          defense: pieceTemplate.stats.defense,
          moveRange: pieceTemplate.stats.moveRange,
          x: position.x,
          y: position.y,
          skills: pieceTemplate.skills.map(s => {
            // 检查技能是否为限定技
            const isUltimate = s.skillId.includes('ultimate') || s.skillId.includes('ult');
            return {
              skillId: s.skillId,
              currentCooldown: 0,
              currentCharges: 0,
              unlocked: true,
              usesRemaining: isUltimate ? 1 : -1, // 限定技1次，普通技能无限制
            } as SkillState;
          }),
        })
        
        if (isRedPlayer) {
          redPieceIndex++
        } else {
          bluePieceIndex++
        }
      })
    }
  }
  
  console.log('Red pieces created:', redPieceIndex)
  console.log('Blue pieces created:', bluePieceIndex)
  
  // 确保每个玩家至少有一个棋子
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
      skills: defaultRedPiece.skills.map(s => {
        // 检查技能是否为限定技
        const isUltimate = s.skillId.includes('ultimate') || s.skillId.includes('ult');
        return {
          skillId: s.skillId,
          currentCooldown: 0,
          currentCharges: 0,
          unlocked: true,
          usesRemaining: isUltimate ? 1 : -1, // 限定技1次，普通技能无限制
        };
      }),
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
      skills: defaultBluePiece.skills.map(s => {
        // 检查技能是否为限定技
        const isUltimate = s.skillId.includes('ultimate') || s.skillId.includes('ult');
        return {
          skillId: s.skillId,
          currentCooldown: 0,
          currentCharges: 0,
          unlocked: true,
          usesRemaining: isUltimate ? 1 : -1, // 限定技1次，普通技能无限制
        };
      }),
    })
  } else {
    // 检查是否每个玩家至少有一个棋子
    const redPlayerPieces = pieces.filter(p => p.ownerPlayerId === redPlayer)
    const bluePlayerPieces = pieces.filter(p => p.ownerPlayerId === bluePlayer)
    
    console.log('Red player pieces count:', redPlayerPieces.length)
    console.log('Blue player pieces count:', bluePlayerPieces.length)
    
    // 如果红方玩家没有棋子，添加默认红方棋子
    if (redPlayerPieces.length === 0) {
      console.log('Red player has no pieces, adding default red piece')
      const position = getRandomPosition()
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
        x: position.x,
        y: position.y,
        skills: defaultRedPiece.skills.map(s => {
          // 检查技能是否为限定技
          const isUltimate = s.skillId.includes('ultimate') || s.skillId.includes('ult');
          return {
            skillId: s.skillId,
            currentCooldown: 0,
            currentCharges: 0,
            unlocked: true,
            usesRemaining: isUltimate ? 1 : -1, // 限定技1次，普通技能无限制
          };
        }),
      })
    }
    
    // 如果蓝方玩家没有棋子，添加默认蓝方棋子
    if (bluePlayerPieces.length === 0) {
      console.log('Blue player has no pieces, adding default blue piece')
      const position = getRandomPosition()
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
        x: position.x,
        y: position.y,
        skills: defaultBluePiece.skills.map(s => {
          // 检查技能是否为限定技
          const isUltimate = s.skillId.includes('ultimate') || s.skillId.includes('ult');
          return {
            skillId: s.skillId,
            currentCooldown: 0,
            currentCharges: 0,
            unlocked: true,
            usesRemaining: isUltimate ? 1 : -1, // 限定技1次，普通技能无限制
          };
        }),
      })
    }
  }
  
  console.log('Final pieces count:', pieces.length)
  console.log('Final pieces:', pieces)
  
  return pieces
}

export async function createInitialBattleForPlayers(
  playerIds: PlayerId[],
  selectedPieces: PieceTemplate[],
  playerSelectedPieces?: Array<{ playerId: string; pieces: PieceTemplate[] }>,
  mapId?: string,
): Promise<BattleState | null> {
  if (playerIds.length !== 2) return null

  const [p1, p2] = playerIds
  
  // 尝试获取指定地图或默认地图
  let map = getMap(mapId || DEFAULT_MAP_ID)
  
  // 如果地图没有加载成功，尝试异步加载
  if (!map) {
    console.warn(`Map ${mapId || DEFAULT_MAP_ID} not found in cache, trying to load...`)
    await loadMaps()
    map = getMap(mapId || DEFAULT_MAP_ID)
  }
  
  // 如果地图仍然没有加载成功，使用默认地图
  if (!map) {
    console.warn(`Map ${mapId || DEFAULT_MAP_ID} not found, using default map`)
    
    // 创建一个更真实的默认地图，包含墙壁和不同类型的格子
    const defaultMap: BoardMap = {
      id: "default-8x6",
      name: "默认地图",
      width: 8,
      height: 6,
      tiles: [],
      rules: []
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
    
    map = defaultMap
  }

  const pieces = buildInitialPiecesForPlayers(map, playerIds, selectedPieces, playerSelectedPieces)
  // 玩家数组已按红方在前、蓝方在后的顺序排序，所以第一个玩家是红方
  const redPlayer = playerIds[0]

  const skills = buildDefaultSkills()
  console.log('Skills for battle:', Object.keys(skills))
  console.log('Teleport in skills:', 'teleport' in skills)
  
  // 收集所有规则ID
  const ruleIds = collectRuleIds(selectedPieces, map as any)
  // 加载指定的规则
  globalTriggerSystem.loadSpecificRules(ruleIds)
  
  return {
    map,
    pieces,
    pieceStatsByTemplateId: buildDefaultPieceStats(),
    skillsById: skills,
    players: [
      { playerId: p1, chargePoints: 0, actionPoints: 1, maxActionPoints: 1 },
      { playerId: p2, chargePoints: 0, actionPoints: 0, maxActionPoints: 0 },
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

// 收集所有规则ID
function collectRuleIds(selectedPieces: PieceTemplate[], map: any): string[] {
  const ruleIds = new Set<string>()
  
  // 收集棋子的规则
  selectedPieces.forEach(piece => {
    if (piece.rules && Array.isArray(piece.rules)) {
      piece.rules.forEach(ruleId => ruleIds.add(ruleId))
    }
  })
  
  // 收集地图的规则
  if (map.rules && Array.isArray(map.rules)) {
    map.rules.forEach(ruleId => ruleIds.add(ruleId))
  }
  
  return Array.from(ruleIds)
}
