import { NextRequest, NextResponse } from "next/server"
import type { BattleState, BattleAction } from "@/lib/game/turn"
import { applyBattleAction } from "@/lib/game/turn"
import { getMap, DEFAULT_MAP_ID, loadMaps } from "@/config/maps"
import type { BoardMap } from "@/lib/game/map"
import type { PieceInstance, PieceTemplate } from "@/lib/game/piece"
import { getAllPieces, getPieceById } from "@/lib/game/piece-repository"
import { buildDefaultSkills } from "@/lib/game/battle-setup"
import { globalTriggerSystem } from "@/lib/game/triggers"
import { reloadSkills } from "@/lib/game/skill-repository"

// 确保地图数据在模块加载时就被加载
loadMaps().catch(error => {
  console.error('Error loading maps in training route:', error)
})

// 全局棋子 ID 计数器，用于生成唯一的 instanceId
let globalPieceIdCounter = 0

// 生成唯一的棋子 ID
function generateUniquePieceId(ownerPlayerId: string): string {
  globalPieceIdCounter++
  return `${ownerPlayerId}-${Date.now()}-${globalPieceIdCounter}`
}

// 创建初始训练营战斗状态
function createTrainingBattleState(mapId?: string): BattleState {
  // 重新加载技能文件（开发模式热重载）
  reloadSkills()

  // 获取地图
  let map = getMap(mapId || DEFAULT_MAP_ID)

  // 如果地图没有加载成功，使用默认地图
  if (!map) {
    console.warn(`Map ${mapId || DEFAULT_MAP_ID} not found, using default map`)
    map = createDefaultMap()
  }

  const skills = buildDefaultSkills()

  // 创建两个训练玩家
  const player1 = "training-red"
  const player2 = "training-blue"

  // 获取默认棋子
  const allPieces = getAllPieces()
  const redPiece = allPieces.find(p => p.id === "red-warrior") || allPieces[0]
  const bluePiece = allPieces.find(p => p.id === "blue-warrior") || allPieces[1]

  // 找到可走的地板方格
  const floorTiles = map.tiles.filter((tile: { props: { walkable: boolean; type?: string } }) =>
    tile.props.walkable && tile.props.type === "floor"
  )
  const availableTiles = floorTiles.length > 0 ? floorTiles : map.tiles.filter((tile: { props: { walkable: boolean } }) => tile.props.walkable)

  // 创建初始棋子
  const pieces: PieceInstance[] = []

  if (redPiece) {
    const redPosition = availableTiles.length > 0
      ? { x: availableTiles[0].x, y: availableTiles[0].y }
      : { x: 1, y: 1 }
    pieces.push(createPieceInstance(redPiece, player1, "red", redPosition.x, redPosition.y, 1))
  }

  if (bluePiece) {
    const bluePosition = availableTiles.length > 1
      ? { x: availableTiles[availableTiles.length - 1].x, y: availableTiles[availableTiles.length - 1].y }
      : { x: map.width - 2, y: map.height - 2 }
    pieces.push(createPieceInstance(bluePiece, player2, "blue", bluePosition.x, bluePosition.y, 2))
  }

  // 收集规则ID
  const ruleIds: string[] = []
  allPieces.forEach((piece: PieceTemplate & { rules?: string[] }) => {
    if (piece.rules && Array.isArray(piece.rules)) {
      piece.rules.forEach((ruleId: string) => ruleIds.push(ruleId))
    }
  })
  if ((map as any).rules && Array.isArray((map as any).rules)) {
    (map as any).rules.forEach((ruleId: string) => ruleIds.push(ruleId))
  }
  globalTriggerSystem.loadSpecificRules(ruleIds)

  return {
    map,
    pieces,
    graveyard: [],
    pieceStatsByTemplateId: {},
    skillsById: skills,
    players: [
      { playerId: player1, name: "红方", chargePoints: 0, actionPoints: 10, maxActionPoints: 10 },
      { playerId: player2, name: "蓝方", chargePoints: 0, actionPoints: 0, maxActionPoints: 10 },
    ],
    turn: {
      currentPlayerId: player1,
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

// 创建默认地图
function createDefaultMap(): BoardMap {
  const map: BoardMap & { rules?: string[] } = {
    id: "training-default",
    name: "训练场",
    width: 10,
    height: 8,
    tiles: [],
  }

  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 10; x++) {
      if (x === 0 || x === 9 || y === 0 || y === 7) {
        map.tiles.push({
          id: `training-${x}-${y}`,
          x,
          y,
          props: {
            walkable: false,
            bulletPassable: false,
            type: "wall",
          },
        })
      } else {
        map.tiles.push({
          id: `training-${x}-${y}`,
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

  return map
}

// 创建棋子实例
function createPieceInstance(
  template: PieceTemplate,
  ownerPlayerId: string,
  faction: "red" | "blue",
  x: number,
  y: number,
  _index: number
): PieceInstance {
  const isUltimate = (skillId: string) => skillId.includes('ultimate') || skillId.includes('ult')

  return {
    instanceId: generateUniquePieceId(ownerPlayerId),
    templateId: template.id,
    name: template.name,
    ownerPlayerId,
    faction,
    currentHp: template.stats.maxHp,
    maxHp: template.stats.maxHp,
    attack: template.stats.attack,
    defense: template.stats.defense,
    moveRange: template.stats.moveRange,
    x,
    y,
    skills: template.skills.map((s) => ({
      skillId: s.skillId,
      level: s.level || 1,
      currentCooldown: 0,
      usesRemaining: isUltimate(s.skillId) ? 1 : -1,
    })),
    buffs: [],
    debuffs: [],
    statusTags: [],
    ruleTags: [],
    rules: [],
  }
}

// POST - 初始化训练营
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const mapId = body.mapId as string | undefined

    const battleState = createTrainingBattleState(mapId)
    return NextResponse.json(battleState)
  } catch (error) {
    console.error("Error initializing training:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to initialize training" },
      { status: 500 }
    )
  }
}

// PUT - 执行战斗动作
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json()
    const { action, battleState } = body as { action: BattleAction; battleState: BattleState }

    if (!action || !battleState) {
      return NextResponse.json(
        { error: "Missing action or battleState" },
        { status: 400 }
      )
    }

    // 重新加载技能文件（开发模式热重载）
    reloadSkills()

    // 使用原版的 applyBattleAction 处理战斗逻辑
    const newState = applyBattleAction(battleState, action)
    return NextResponse.json(newState)
  } catch (error) {
    console.error("Error executing battle action:", error)

    // 检查是否是需要目标选择的错误
    const err = error as any
    if (err.needsTargetSelection) {
      return NextResponse.json(
        {
          error: err.message,
          needsTargetSelection: true,
          targetType: err.targetType,
          range: err.range,
          filter: err.filter,
        },
        { status: 400 }
      )
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to execute action" },
      { status: 500 }
    )
  }
}

// PATCH - 管理操作（添加棋子、修改资源等）
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const { type, battleState } = body as { type: string; battleState: BattleState }

    if (!type || !battleState) {
      return NextResponse.json(
        { error: "Missing type or battleState" },
        { status: 400 }
      )
    }

    let newState = { ...battleState }

    switch (type) {
      case "addPiece": {
        const { faction, templateId, x, y } = body as {
          faction: "red" | "blue"
          templateId: string
          x: number
          y: number
        }

        const template = getPieceById(templateId)
        if (!template) {
          return NextResponse.json(
            { error: `Piece template not found: ${templateId}` },
            { status: 400 }
          )
        }

        // 检查位置是否有效
        const targetTile = battleState.map.tiles.find((t: { x: number; y: number; props: { walkable: boolean } }) => t.x === x && t.y === y)
        if (!targetTile || !targetTile.props.walkable) {
          return NextResponse.json(
            { error: "Invalid position" },
            { status: 400 }
          )
        }

        // 检查位置是否已被占用
        const isOccupied = battleState.pieces.some(p => p.x === x && p.y === y && p.currentHp > 0)
        if (isOccupied) {
          return NextResponse.json(
            { error: "Position is already occupied" },
            { status: 400 }
          )
        }

        const ownerPlayerId = faction === "red" ? "training-red" : "training-blue"
        const existingPieces = battleState.pieces.filter(p => p.ownerPlayerId === ownerPlayerId)
        const newIndex = existingPieces.length + 1

        const newPiece = createPieceInstance(template, ownerPlayerId, faction, x, y, newIndex)
        newState.pieces = [...battleState.pieces, newPiece]
        break
      }

      case "updateResources": {
        const { playerId, actionPoints, chargePoints } = body as {
          playerId: string
          actionPoints: number
          chargePoints: number
        }

        newState.players = battleState.players.map(player => {
          if (player.playerId === playerId) {
            return {
              ...player,
              actionPoints: Math.max(0, Math.min(20, actionPoints)),
              chargePoints: Math.max(0, Math.min(20, chargePoints)),
            }
          }
          return player
        })
        break
      }

      case "removePiece": {
        const { instanceId } = body as { instanceId: string }
        newState.pieces = battleState.pieces.filter(p => p.instanceId !== instanceId)
        break
      }

      case "resetCooldowns": {
        newState.pieces = battleState.pieces.map(piece => ({
          ...piece,
          skills: piece.skills.map(skill => ({
            ...skill,
            currentCooldown: 0,
            usesRemaining: skill.usesRemaining === 0 ? 1 : skill.usesRemaining,
          })),
        }))
        break
      }

      default:
        return NextResponse.json(
          { error: `Unknown operation type: ${type}` },
          { status: 400 }
        )
    }

    return NextResponse.json(newState)
  } catch (error) {
    console.error("Error in training management:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to execute operation" },
      { status: 500 }
    )
  }
}
