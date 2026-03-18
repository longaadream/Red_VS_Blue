"use client"

import { useEffect, useState, useCallback } from "react"
import Link from "next/link"
import {
  ArrowLeft,
  Swords,
  Shield,
  Zap,
  Footprints,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { toast } from "sonner"
import { GameBoard } from "@/components/game-board"

interface TutorialStep {
  id: string
  title: string
  description: string
}

const TUTORIAL_STEPS: TutorialStep[] = [
  { id: "welcome", title: "欢迎", description: "教程开始" },
  { id: "victory", title: "胜利", description: "教程完成" },
]

const RED_ID = "tutorial-red"
const BLUE_ID = "tutorial-blue"

export default function TutorialPage() {
  const [currentStep, setCurrentStep] = useState(0)
  const [battle, setBattle] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedPieceId, setSelectedPieceId] = useState<string>()
  const [isSelectingMoveTarget, setIsSelectingMoveTarget] = useState(false)
  const [isSelectingSkillTarget, setIsSelectingSkillTarget] = useState(false)
  const [selectedSkillId, setSelectedSkillId] = useState<string>()
  const [selectedSkillType, setSelectedSkillType] = useState<"normal" | "super">("normal")
  const [isSelectingTeleportTarget, setIsSelectingTeleportTarget] = useState(false)
  const [targetSelectionType, setTargetSelectionType] = useState<"piece" | "grid">("piece")
  const [isSelectingOption, setIsSelectingOption] = useState(false)
  const [optionSelectionOptions, setOptionSelectionOptions] = useState<any[]>([])
  const [pendingOptionAction, setPendingOptionAction] = useState<any>(null)

  const step = TUTORIAL_STEPS[currentStep]
  const isMyTurn = battle?.turn?.currentPlayerId === RED_ID
  const phaseLabel = battle?.turn?.phase === "start" ? "开始" : battle?.turn?.phase === "action" ? "行动" : "结束"
  const currentPlayer = battle?.players?.find((p: any) => p.playerId === battle?.turn?.currentPlayerId)
  const actionPoints = currentPlayer?.actionPoints || 0
  const maxActionPoints = currentPlayer?.maxActionPoints || 10

  useEffect(() => { initTutorial() }, [])

  async function initTutorial() {
    try {
      setLoading(true)
      const res = await fetch("/api/tutorial", { method: "POST", headers: { "Content-Type": "application/json" } })
      if (!res.ok) throw new Error("Failed to init")
      const data = await res.json()
      setBattle(data)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function sendBattleAction(action: any) {
    if (!battle) return
    try {
      const res = await fetch("/api/tutorial", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, battleState: battle }),
      })
      const data = await res.json()
      if (!res.ok) {
        if (data.needsTargetSelection) {
          setTargetSelectionType(data.targetType || "piece")
          if (data.targetType === "grid") setIsSelectingMoveTarget(true)
          else setIsSelectingSkillTarget(true)
          return
        }
        if (data.needsOptionSelection) {
          setIsSelectingOption(true)
          setOptionSelectionOptions(data.options || [])
          setPendingOptionAction(action)
          return
        }
        toast.error(data.error || "Action failed")
        return
      }
      setBattle(data)
      setSelectedPieceId(undefined)
      setIsSelectingMoveTarget(false)
      setIsSelectingSkillTarget(false)
      setIsSelectingTeleportTarget(false)
      setSelectedSkillId(undefined)
      setIsSelectingOption(false)
      setPendingOptionAction(null)

      if (action.type === "endTurn" && currentStep < TUTORIAL_STEPS.length - 1) {
        setTimeout(() => setCurrentStep(currentStep + 1), 1000)
      }
    } catch (err) { console.error(err) }
  }

  const handlePieceClick = useCallback((pieceId: string) => {
    if (!battle || battle.turn.phase !== "action" || battle.turn.currentPlayerId !== RED_ID) return

    if (isSelectingSkillTarget && selectedPieceId && selectedSkillId) {
      sendBattleAction({
        type: selectedSkillType === "super" ? "useChargeSkill" : "useBasicSkill",
        playerId: RED_ID,
        pieceId: selectedPieceId,
        skillId: selectedSkillId,
        targetPieceId: pieceId,
      })
      return
    }

    const clicked = battle.pieces.find((p: any) => p.instanceId === pieceId)
    if (!clicked) return

    if (clicked.ownerPlayerId !== RED_ID) {
      if (selectedPieceId && !battle.turn.actions.hasUsedBasicSkill) {
        sendBattleAction({ type: "useBasicSkill", playerId: RED_ID, pieceId: selectedPieceId, skillId: "basic-attack", targetPieceId: pieceId })
      }
      return
    }

    setSelectedPieceId(pieceId)
    setIsSelectingMoveTarget(false)
    setIsSelectingSkillTarget(false)
  }, [battle, selectedPieceId, selectedSkillId, selectedSkillType, isSelectingSkillTarget])

  const handleTileClick = useCallback((x: number, y: number) => {
    if (!battle || !selectedPieceId) return

    if (isSelectingMoveTarget) {
      sendBattleAction({ type: "move", playerId: RED_ID, pieceId: selectedPieceId, toX: x, toY: y })
      return
    }

    if (isSelectingTeleportTarget && selectedSkillId === "teleport") {
      sendBattleAction({ type: "useBasicSkill", playerId: RED_ID, pieceId: selectedPieceId, skillId: "teleport", targetX: x, targetY: y })
      setIsSelectingTeleportTarget(false)
      setSelectedSkillId(undefined)
      return
    }

    if (isSelectingSkillTarget && selectedPieceId && selectedSkillId) {
      sendBattleAction({
        type: selectedSkillType === "super" ? "useChargeSkill" : "useBasicSkill",
        playerId: RED_ID,
        pieceId: selectedPieceId,
        skillId: selectedSkillId,
        targetX: x,
        targetY: y,
      })
    }
  }, [battle, selectedPieceId, isSelectingMoveTarget, isSelectingSkillTarget, selectedSkillId, selectedSkillType, isSelectingTeleportTarget])

  const handleOptionSelect = (value: any) => {
    if (value === null) { setIsSelectingOption(false); setPendingOptionAction(null); return }
    if (pendingOptionAction) sendBattleAction({ ...pendingOptionAction, selectedOption: value })
  }

  const selectedPiece = battle?.pieces?.find((p: any) => p.instanceId === selectedPieceId)

  if (loading) return <div className="flex min-h-svh items-center justify-center bg-zinc-950"><div className="text-zinc-100">加载中...</div></div>
  if (error) return <div className="flex min-h-svh items-center justify-center bg-zinc-950"><div className="text-red-500">{error}</div></div>

  return (
    <main className="flex min-h-svh flex-col bg-zinc-950 px-4 py-6">
      <div className="mx-auto w-full max-w-6xl space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button asChild variant="ghost" size="sm"><Link href="/"><ArrowLeft className="mr-2 h-4 w-4" />菜单</Link></Button>
            <h1 className="text-xl font-bold text-zinc-100"><Swords className="mr-2 inline h-5 w-5 text-red-500" />红蓝大作战 - 新手教程</h1>
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2">
            <span className="text-sm text-zinc-400">教程进度</span>
            <span className="text-lg font-bold text-zinc-100">{currentStep + 1}/{TUTORIAL_STEPS.length}</span>
          </div>
        </div>

        <div className="h-1 bg-zinc-800 rounded"><div className="h-full bg-primary rounded" style={{ width: `${((currentStep + 1) / TUTORIAL_STEPS.length) * 100}%` }} /></div>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Card className="bg-zinc-900/50">
              <CardHeader className="pb-2"><CardTitle className="flex items-center justify-between text-sm"><span>战场</span><span className="text-xs font-normal text-zinc-400">{battle?.map?.name}</span></CardTitle></CardHeader>
              <CardContent className="flex justify-center">
                <GameBoard map={battle?.map} pieces={battle?.pieces} onTileClick={handleTileClick} onPieceClick={handlePieceClick} selectedPieceId={selectedPieceId} isSelectingMoveTarget={isSelectingMoveTarget} isSelectingSkillTarget={isSelectingSkillTarget} isSelectingTeleportTarget={isSelectingTeleportTarget} />
              </CardContent>
            </Card>
            <Card className="bg-zinc-900/50 border-yellow-500/30">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-yellow-500">教程提示</CardTitle></CardHeader>
              <CardContent><p className="text-sm text-zinc-300">{step.description}</p></CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            <Card className="bg-zinc-900/50">
              <CardHeader className="pb-2"><CardTitle className="flex items-center justify-between text-sm"><span>当前行动</span><span className={`px-2 py-0.5 text-xs font-medium rounded ${isMyTurn ? "bg-green-600 text-white" : "bg-zinc-700 text-zinc-300"}`}>{isMyTurn ? "你的回合" : "对手回合"}</span></CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="rounded-md bg-zinc-800 p-3">
                  <div className="flex items-center justify-between"><span className="text-sm text-zinc-400">阶段</span><span className="font-medium text-zinc-200">{phaseLabel}</span></div>
                  <div className="mt-2 flex gap-1">{["start", "action", "end"].map(p => <div key={p} className={`h-1 flex-1 rounded ${battle?.turn?.phase === p ? (p === "start" ? "bg-yellow-500" : p === "action" ? "bg-green-500" : "bg-red-500") : "bg-zinc-700"}`} />)}</div>
                </div>
                <div className="rounded-md bg-zinc-800 p-3">
                  <div className="mb-2 text-xs text-zinc-400">当前回合</div>
                  <div className={`flex items-center justify-between p-2 rounded ${RED_ID === battle?.turn?.currentPlayerId ? "bg-red-950/30 border border-red-900/50" : "bg-blue-950/30 border border-blue-900/50"}`}>
                    <div className="flex items-center gap-2">
                      <div className={`h-2 w-2 rounded-full ${RED_ID === battle?.turn?.currentPlayerId ? "bg-red-500" : "bg-blue-500"}`} />
                      <span className={`text-sm font-medium ${RED_ID === battle?.turn?.currentPlayerId ? "text-red-400" : "text-blue-400"}`}>{RED_ID === battle?.turn?.currentPlayerId ? "红方 (你)" : "蓝方"}</span>
                    </div>
                  </div>
                </div>
                <div className="rounded-md bg-zinc-800 p-3">
                  <div className="flex items-center justify-between"><span className="text-sm text-zinc-400">行动点</span><div className="flex items-center gap-1"><Zap className="h-4 w-4 text-yellow-500" /><span className="font-medium text-zinc-200">{actionPoints}/{maxActionPoints}</span></div></div>
                </div>
              </CardContent>
            </Card>

            {battle && (
              <Card className="bg-zinc-900/50">
                <CardHeader className="pb-2"><CardTitle className="text-sm">我方棋子</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {battle.pieces.filter((p: any) => p.ownerPlayerId === RED_ID && p.currentHp > 0).map((piece: any) => (
                    <div key={piece.instanceId} onClick={() => { setSelectedPieceId(piece.instanceId); setIsSelectingMoveTarget(false); setIsSelectingSkillTarget(false); setIsSelectingTeleportTarget(false) }} className={`group relative flex items-center gap-3 cursor-pointer rounded-md p-2 transition-colors ${selectedPieceId === piece.instanceId ? "bg-zinc-800/80 border-l-4 border-green-500" : "hover:bg-zinc-800/50"}`}>
                      <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${piece.faction === "red" ? "bg-red-600" : "bg-blue-600"}`}><Swords className="h-5 w-5 text-white" /></div>
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center justify-between"><span className="font-medium text-zinc-200">{piece.name}</span></div>
                        <div className="flex items-center gap-3 text-xs text-zinc-400"><span className="flex items-center gap-1"><Shield className="h-3 w-3" />HP: {piece.currentHp}/{piece.maxHp}</span><span className="flex items-center gap-1"><Swords className="h-3 w-3" />攻击: {piece.attack}</span></div>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {battle && (
              <Card className="bg-zinc-900/50">
                <CardHeader className="pb-2"><CardTitle className="text-sm">敌方棋子</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {battle.pieces.filter((p: any) => p.ownerPlayerId === BLUE_ID && p.currentHp > 0).map((piece: any) => (
                    <div key={piece.instanceId} className="flex items-center gap-3 rounded-md p-2 bg-zinc-900/50">
                      <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${piece.faction === "red" ? "bg-red-600" : "bg-blue-600"}`}><Swords className="h-5 w-5 text-white" /></div>
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center justify-between"><span className="font-medium text-zinc-200">{piece.name}</span></div>
                        <div className="flex items-center gap-3 text-xs text-zinc-400"><span className="flex items-center gap-1"><Shield className="h-3 w-3" />HP: {piece.currentHp}/{piece.maxHp}</span><span className="flex items-center gap-1"><Swords className="h-3 w-3" />攻击: {piece.attack}</span></div>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            <Card className="bg-zinc-900/50">
              <CardHeader className="pb-2"><CardTitle className="text-sm">操作</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {isSelectingOption && (
                  <div className="space-y-2">
                    {optionSelectionOptions.map((opt: any, i: number) => <Button key={i} className="w-full" size="sm" variant="outline" onClick={() => handleOptionSelect(opt.value)}>{opt.label}</Button>)}
                    <Button className="w-full" size="sm" variant="ghost" onClick={() => handleOptionSelect(null)}>取消</Button>
                  </div>
                )}
                {!isSelectingOption && (
                  <>
                    {isSelectingMoveTarget ? (
                      <><p className="text-xs text-zinc-400 text-center">点击棋盘选择移动目标</p><Button className="w-full" size="sm" variant="outline" onClick={() => setIsSelectingMoveTarget(false)}>取消</Button></>
                    ) : isSelectingSkillTarget ? (
                      <><p className="text-xs text-zinc-400 text-center">{targetSelectionType === "grid" ? "点击棋盘选择技能目标" : "点击敌人选择技能目标"}</p><Button className="w-full" size="sm" variant="outline" onClick={() => { setIsSelectingSkillTarget(false); setSelectedSkillId(undefined) }}>取消</Button></>
                    ) : (
                      <>
                        <Button className="w-full" size="sm" disabled={!selectedPiece || battle?.turn?.actions?.hasMoved || !isMyTurn} onClick={() => setIsSelectingMoveTarget(true)}><Footprints className="mr-2 h-4 w-4" />移动</Button>
                        {selectedPiece && selectedPiece.skills?.map((skill: any) => {
                          const skillDef = battle?.skillsById?.[skill.skillId]
                          if (!skillDef || skillDef.kind === "passive") return null
                          const canUse = isMyTurn && (!skill.currentCooldown || skill.currentCooldown === 0)
                          return <Button key={skill.skillId} className="w-full" variant="outline" size="sm" disabled={!canUse} onClick={() => { setSelectedSkillId(skill.skillId); setSelectedSkillType(skillDef.type === "super" ? "super" : "normal"); if (skill.skillId === "teleport") setIsSelectingTeleportTarget(true); else setIsSelectingSkillTarget(true) }}><Zap className="mr-2 h-4 w-4" />{skillDef.name}</Button>
                        })}
                        {isMyTurn && <Button className="w-full" variant="secondary" size="sm" onClick={() => sendBattleAction({ type: "endTurn", playerId: RED_ID })}>结束回合</Button>}
                      </>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </main>
  )
}
