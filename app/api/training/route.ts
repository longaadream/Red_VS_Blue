import { NextRequest, NextResponse } from "next/server"
import type { BattleState, BattleAction } from "@/lib/game/turn"
import { applyBattleAction, summonPiece } from "@/lib/game/turn"
import type { PieceInstance, PieceTemplate } from "@/lib/game/piece"
import { getAllPieces } from "@/lib/game/piece-repository"
import { createInitialBattleForPlayers } from "@/lib/game/battle-setup"
import { loadJsonFilesServer } from "@/lib/game/file-loader"
import { reloadSkills } from "@/lib/game/skill-repository"
import { loadRuleById } from "@/lib/game/skills"

// 全局棋子 ID 计数器，用于生成唯一的 instanceId
let globalPieceIdCounter = 0

// 生成唯一的棋子 ID
function generateUniquePieceId(ownerPlayerId: string): string {
  globalPieceIdCounter++
  return `${ownerPlayerId}-${Date.now()}-${globalPieceIdCounter}`
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

  // 加载棋子的规则
  const rules: any[] = []
  if ((template as any).rules && Array.isArray((template as any).rules)) {
    (template as any).rules.forEach((ruleId: string) => {
      const rule = loadRuleById(ruleId)
      if (rule) {
        rules.push(rule)
      }
    })
  }

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
    rules,
  }
}

// POST - 初始化训练营
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const mapId = body.mapId as string | undefined

    reloadSkills()

    const allPieces = getAllPieces()
    const redPiece = allPieces.find(p => p.id === "red-sasuke") || allPieces.find(p => p.id?.startsWith("red-")) || allPieces[0]
    const bluePiece = allPieces.find(p => p.id === "blue-naruto") || allPieces.find(p => p.id?.startsWith("blue-")) || allPieces[1] || allPieces[0]

    const playerSelectedPieces = [
      { playerId: 'training-red', pieces: redPiece ? [redPiece] : [] },
      { playerId: 'training-blue', pieces: bluePiece ? [bluePiece] : [] },
    ]

    const battleState = await createInitialBattleForPlayers(
      ['training-red', 'training-blue'],
      [],
      playerSelectedPieces,
      mapId,
    )

    if (!battleState) {
      return NextResponse.json({ error: 'Failed to create training battle state' }, { status: 500 })
    }

    // 训练营特有设置：行动点上限为 10（正式对战为 1）
    battleState.players = battleState.players.map(player => ({
      ...player,
      actionPoints: player.playerId === 'training-red' ? 10 : 0,
      maxActionPoints: 10,
    }))

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

    console.log('[PUT] Before applyBattleAction, pieces:', battleState.pieces.map(p => `${p.templateId}(${p.instanceId})`))
    // 使用原版的 applyBattleAction 处理战斗逻辑
    const newState = applyBattleAction(battleState, action)
    console.log('[PUT] After applyBattleAction, pieces count:', newState.pieces.length)
    console.log('[PUT] After applyBattleAction, pieces:', newState.pieces.map(p => `${p.templateId}(${p.instanceId})`))
    console.log('[PUT] Graveyard:', newState.graveyard?.map(p => `${p.templateId}(${p.instanceId})`))
    
    // 临时修复：去除重复的棋子
    const uniquePieces = newState.pieces.filter((piece, index, self) => 
      index === self.findIndex((p) => p.instanceId === piece.instanceId)
    )
    if (uniquePieces.length !== newState.pieces.length) {
      console.log('[PUT] Found duplicate pieces, deduplicating...')
      newState.pieces = uniquePieces
    }
    
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
    // 检查是否是需要选项选择的错误
    if (err.needsOptionSelection) {
      return NextResponse.json(
        {
          error: err.message,
          needsOptionSelection: true,
          options: err.options,
          title: err.title,
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

    // 重新加载技能文件（开发模式热重载）
    reloadSkills()

    let newState = { ...battleState }

    switch (type) {
      case "addPiece": {
        const { faction, templateId, x, y } = body as {
          faction: "red" | "blue"
          templateId: string
          x: number
          y: number
        }

        console.log('[addPiece] faction:', faction, 'templateId:', templateId, 'x:', x, 'y:', y)

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

        // 从文件系统实时加载棋子模板（避免模块缓存导致新棋子找不到）
        const freshPieces = loadJsonFilesServer<PieceTemplate>('data/pieces')
        const getPieceFresh = (id: string) => freshPieces[id]

        // 使用 summonPiece 函数召唤棋子
        const summonResult = summonPiece(
          newState,
          {
            templateId,
            faction,
            ownerPlayerId,
            x,
            y,
            index: newIndex
          },
          getPieceFresh,
          createPieceInstance
        )

        if (!summonResult.success) {
          return NextResponse.json(
            { error: summonResult.message || "召唤棋子失败" },
            { status: 400 }
          )
        }

        console.log('[addPiece] Summon result:', summonResult.message)
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
