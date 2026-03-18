import { NextRequest, NextResponse } from "next/server"
import type { BattleState } from "@/lib/game/turn"
import { getMap, DEFAULT_MAP_ID, loadMaps } from "@/config/maps"
import type { BoardMap } from "@/lib/game/map"
import type { PieceTemplate } from "@/lib/game/piece"
import { getAllPieces, getPieceById } from "@/lib/game/piece-repository"
import { buildDefaultSkills } from "@/lib/game/battle-setup"
import { globalTriggerSystem } from "@/lib/game/triggers"
import { reloadSkills } from "@/lib/game/skill-repository"
import { loadRuleById } from "@/lib/game/skills"

loadMaps().catch(error => {
  console.error('Error loading maps in tutorial route:', error)
})

let globalPieceIdCounter = 0

function generateUniquePieceId(ownerPlayerId: string): string {
  globalPieceIdCounter++
  return `${ownerPlayerId}-${Date.now()}-${globalPieceIdCounter}`
}

function createPieceInstance(
  template: PieceTemplate,
  ownerPlayerId: string,
  faction: "red" | "blue",
  x: number,
  y: number
): PieceInstance {
  const isUltimate = (skillId: string) => skillId.includes('ultimate') || skillId.includes('ult')

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
    statusTags: [],
    rules,
  }
}

export async function POST(request: NextRequest) {
  try {
    reloadSkills()

    const map = getMap("large-battlefield") || getMap("arena-8x6") || getMap(DEFAULT_MAP_ID)
    if (!map) {
      return NextResponse.json({ error: "Map not found" }, { status: 404 })
    }

    const skills = buildDefaultSkills()
    const allPieces = getAllPieces()

    const player1 = "tutorial-red"
    const player2 = "tutorial-blue"

    const tutorialPieces: PieceInstance[] = []

    const utherTemplate = allPieces.find(p => p.id === "uther")
    const jainaTemplate = allPieces.find(p => p.id === "jaina")
    const tracerTemplate = allPieces.find(p => p.id === "tracer")
    const reaperTemplate = allPieces.find(p => p.id === "reaper")

    if (utherTemplate) {
      const uther = createPieceInstance(utherTemplate, player1, "blue", 1, 4)
      uther.currentHp = 8
      tutorialPieces.push(uther)
    }

    if (jainaTemplate) {
      const jaina = createPieceInstance(jainaTemplate, player1, "blue", 2, 3)
      jaina.currentHp = 6
      tutorialPieces.push(jaina)
    }

    if (tracerTemplate) {
      const tracer = createPieceInstance(tracerTemplate, player1, "blue", 1, 2)
      tracer.currentHp = 5
      tutorialPieces.push(tracer)
    }

    const redPieces = allPieces.filter(p => p.faction === "red")
    const redWarriorTemplate = redPieces[0]
    const redArcherTemplate = redPieces[1] || redPieces[0]

    if (redWarriorTemplate) {
      const warrior = createPieceInstance(redWarriorTemplate, player2, "red", 6, 4)
      warrior.currentHp = 3
      tutorialPieces.push(warrior)
    }

    if (redArcherTemplate) {
      const archer = createPieceInstance(redArcherTemplate, player2, "red", 5, 2)
      archer.currentHp = 2
      tutorialPieces.push(archer)
    }

    const ruleIds: string[] = []
    allPieces.forEach((piece: PieceTemplate & { rules?: string[] }) => {
      if (piece.rules && Array.isArray(piece.rules)) {
        piece.rules.forEach((ruleId: string) => {
          if (!ruleIds.includes(ruleId)) {
            ruleIds.push(ruleId)
          }
        })
      }
    })
    if ((map as any).rules && Array.isArray((map as any).rules)) {
      (map as any).rules.forEach((ruleId: string) => {
        if (!ruleIds.includes(ruleId)) {
          ruleIds.push(ruleId)
        }
      })
    }
    globalTriggerSystem.loadSpecificRules(ruleIds, true)

    const battleState: BattleState = {
      map,
      pieces: tutorialPieces,
      graveyard: [],
      pieceStatsByTemplateId: {},
      skillsById: skills,
      players: [
        {
          playerId: player1,
          name: "红方(教程)",
          chargePoints: 0,
          actionPoints: 5,
          maxActionPoints: 5,
          hand: [],
          discardPile: [],
          rules: [],
        },
        {
          playerId: player2,
          name: "蓝方(敌人)",
          chargePoints: 0,
          actionPoints: 0,
          maxActionPoints: 5,
          hand: [],
          discardPile: [],
          rules: [],
        },
      ],
      turn: {
        currentPlayerId: player1,
        turnNumber: 1,
        phase: "action",
        actions: {
          hasMoved: false,
          hasUsedBasicSkill: false,
          hasUsedChargeSkill: false,
        },
      },
    }

    return NextResponse.json(battleState)
  } catch (error) {
    console.error("Error creating tutorial battle:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { action, battleState } = await request.json()

    if (!battleState || !action) {
      return NextResponse.json({ error: "Missing battleState or action" }, { status: 400 })
    }

    const { applyBattleAction } = await import("@/lib/game/turn")
    const result = await applyBattleAction(battleState, action)

    return NextResponse.json(result)
  } catch (error) {
    console.error("Error applying tutorial action:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
