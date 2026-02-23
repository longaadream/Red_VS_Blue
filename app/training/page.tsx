"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft, Loader2, Swords, Shield, Zap, Footprints, Plus, Settings, Map as MapIcon, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { toast } from "sonner"
import { GameBoard } from "@/components/game-board"
import type { BattleState, BattleAction } from "@/lib/game/training-types"
import { getPieceById, loadPieces, getAllPieces } from "@/lib/game/piece-repository"
import type { PieceTemplate } from "@/lib/game/piece"
import type { BoardMap as GameMap } from "@/lib/game/map"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

// 训练营状态
interface TrainingState {
  battle: BattleState | null
  loading: boolean
  error: string | null
}

// 当前控制的玩家ID
const TRAINING_PLAYER_1 = "training-red"
const TRAINING_PLAYER_2 = "training-blue"

export default function TrainingPage() {
  const router = useRouter()

  const [battle, setBattle] = useState<BattleState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [currentPlayerId, setCurrentPlayerId] = useState<string>(TRAINING_PLAYER_1)
  const [selectedPieceId, setSelectedPieceId] = useState<string | undefined>(undefined)
  const [isSelectingMoveTarget, setIsSelectingMoveTarget] = useState(false)
  const [isSelectingSkillTarget, setIsSelectingSkillTarget] = useState(false)
  const [selectedSkillId, setSelectedSkillId] = useState<string | undefined>(undefined)
  const [targetSelectionType, setTargetSelectionType] = useState<'piece' | 'grid'>('piece')
  const [targetSelectionRange, setTargetSelectionRange] = useState(5)
  const [targetSelectionFilter, setTargetSelectionFilter] = useState<'enemy' | 'ally' | 'all'>('enemy')
  const [availableMaps, setAvailableMaps] = useState<GameMap[]>([])
  const [availablePieces, setAvailablePieces] = useState<PieceTemplate[]>([])
  const [showAddPieceDialog, setShowAddPieceDialog] = useState(false)
  const [showMapSelectDialog, setShowMapSelectDialog] = useState(false)
  const [showResourceDialog, setShowResourceDialog] = useState(false)
  const [selectedMapId, setSelectedMapId] = useState<string>("")
  const [newPieceFaction, setNewPieceFaction] = useState<"red" | "blue">("red")
  const [newPieceTemplateId, setNewPieceTemplateId] = useState<string>("")
  const [newPieceX, setNewPieceX] = useState<number>(0)
  const [newPieceY, setNewPieceY] = useState<number>(0)
  const [resourcePlayerId, setResourcePlayerId] = useState<string>(TRAINING_PLAYER_1)
  const [resourceActionPoints, setResourceActionPoints] = useState<number>(10)
  const [resourceChargePoints, setResourceChargePoints] = useState<number>(10)

  // 初始化训练营
  useEffect(() => {
    void initTraining()
    void loadAvailableData()
  }, [])

  async function loadAvailableData() {
    await loadPieces()
    const pieces = getAllPieces()
    setAvailablePieces(pieces)
    // 通过API获取地图数据
    try {
      const res = await fetch("/api/maps")
      if (res.ok) {
        const data = await res.json()
        if (data.maps && Array.isArray(data.maps)) {
          setAvailableMaps(data.maps)
        }
      }
    } catch (error) {
      console.error("Failed to load maps:", error)
    }
  }

  async function initTraining(mapId?: string) {
    try {
      setLoading(true)
      setError(null)

      const res = await fetch("/api/training", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapId }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Failed to initialize training")
      }

      const data = (await res.json()) as BattleState
      setBattle(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }

  async function sendBattleAction(action: BattleAction) {
    if (!battle) return
    try {
      setLoading(true)
      const res = await fetch("/api/training", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, battleState: battle }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (data.needsTargetSelection) {
          setIsSelectingSkillTarget(true)
          // skillId only exists on useBasicSkill or useChargeSkill actions
          if ('skillId' in action) {
            setSelectedSkillId(action.skillId!)
          }
          setTargetSelectionType(data.targetType || 'piece')
          setTargetSelectionRange(data.range || 5)
          setTargetSelectionFilter(data.filter || 'enemy')
          return
        }
        toast.error(data.error || "操作失败")
        return
      }
      setBattle(data as BattleState)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "未知错误")
    } finally {
      setLoading(false)
    }
  }

  async function addPiece(faction: "red" | "blue", templateId: string, x: number, y: number) {
    if (!battle) return
    try {
      setLoading(true)
      const res = await fetch("/api/training", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "addPiece",
          faction,
          templateId,
          x,
          y,
          battleState: battle,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Failed to add piece")
      }
      const data = (await res.json()) as BattleState
      setBattle(data)
      toast.success("棋子添加成功")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "添加棋子失败")
    } finally {
      setLoading(false)
    }
  }

  async function updateResources(playerId: string, actionPoints: number, chargePoints: number) {
    if (!battle) return
    try {
      setLoading(true)
      const res = await fetch("/api/training", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "updateResources",
          playerId,
          actionPoints,
          chargePoints,
          battleState: battle,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Failed to update resources")
      }
      const data = (await res.json()) as BattleState
      setBattle(data)
      toast.success("资源更新成功")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新资源失败")
    } finally {
      setLoading(false)
    }
  }

  async function resetCooldowns() {
    if (!battle) return
    try {
      setLoading(true)
      const res = await fetch("/api/training", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "resetCooldowns",
          battleState: battle,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Failed to reset cooldowns")
      }
      const data = (await res.json()) as BattleState
      setBattle(data)
      toast.success("所有技能冷却已重置")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "重置冷却失败")
    } finally {
      setLoading(false)
    }
  }

  const isMyTurn = useMemo(() => {
    if (!battle) return false
    return battle.turn.currentPlayerId === currentPlayerId
  }, [battle, currentPlayerId])

  const myPieces = useMemo(() => {
    if (!battle) return []
    return battle.pieces.filter((p) => p.ownerPlayerId === currentPlayerId && p.currentHp > 0)
  }, [battle, currentPlayerId])

  const selectedPiece = useMemo(() => {
    if (!selectedPieceId || !battle) return null
    return battle.pieces.find(p => p.instanceId === selectedPieceId) || null
  }, [selectedPieceId, battle])

  if (loading && !battle) {
    return (
      <main className="flex min-h-svh flex-col items-center justify-center bg-zinc-950 px-4">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
        <p className="mt-4 text-zinc-400">加载训练营...</p>
      </main>
    )
  }

  if (error && !battle) {
    return (
      <main className="flex min-h-svh flex-col items-center justify-center bg-zinc-950 px-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-destructive">错误</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button asChild variant="outline">
              <Link href="/">返回主页</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    )
  }

  if (!battle) {
    return (
      <main className="flex min-h-svh flex-col items-center justify-center bg-zinc-950 px-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>训练营初始化失败</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">无法加载训练营，请重试</p>
            <Button onClick={() => void initTraining()}>重试</Button>
            <Button asChild variant="outline">
              <Link href="/">返回主页</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    )
  }

  const phaseLabel = {
    start: "开始阶段",
    action: "行动阶段",
    end: "结束阶段",
  }[battle.turn.phase]

  return (
    <main className="flex min-h-svh flex-col bg-zinc-950 px-4 py-6">
      <div className="mx-auto w-full max-w-7xl space-y-6">
        {/* 顶部导航 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button asChild variant="ghost" size="sm">
              <Link href="/">
                <ArrowLeft className="mr-2 h-4 w-4" />
                主页
              </Link>
            </Button>
            <h1 className="text-xl font-bold text-zinc-100">
              <Swords className="mr-2 inline h-5 w-5 text-yellow-500" />
              训练营
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowMapSelectDialog(true)}
            >
              <MapIcon className="mr-2 h-4 w-4" />
              切换地图
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void initTraining(battle.map.id)}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              重置
            </Button>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* 左侧控制面板 */}
          <div className="space-y-4 lg:col-span-1">
            {/* 玩家切换 */}
            <Card className="bg-zinc-900/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">当前控制方</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex gap-2">
                  <Button
                    className="flex-1"
                    variant={currentPlayerId === TRAINING_PLAYER_1 ? "default" : "outline"}
                    size="sm"
                    onClick={() => setCurrentPlayerId(TRAINING_PLAYER_1)}
                  >
                    <span className="text-red-500 mr-2">●</span>
                    红方
                  </Button>
                  <Button
                    className="flex-1"
                    variant={currentPlayerId === TRAINING_PLAYER_2 ? "default" : "outline"}
                    size="sm"
                    onClick={() => setCurrentPlayerId(TRAINING_PLAYER_2)}
                  >
                    <span className="text-blue-500 mr-2">●</span>
                    蓝方
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* 回合信息 */}
            <Card className="bg-zinc-900/50">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-sm">
                  <span>回合信息</span>
                  <span className={`px-2 py-0.5 text-xs font-medium rounded ${
                    isMyTurn ? "bg-green-600 text-white" : "bg-zinc-700 text-zinc-300"
                  }`}>
                    {isMyTurn ? "当前回合" : "等待中"}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="rounded-md bg-zinc-800 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-zinc-400">阶段</span>
                    <span className="font-medium text-zinc-200">{phaseLabel}</span>
                  </div>
                  <div className="mt-2 flex gap-1">
                    {["start", "action", "end"].map((phase) => (
                      <div
                        key={phase}
                        className={`h-1 flex-1 rounded ${
                          battle.turn.phase === phase
                            ? phase === "start"
                              ? "bg-yellow-500"
                              : phase === "action"
                                ? "bg-green-500"
                                : "bg-red-500"
                            : "bg-zinc-700"
                        }`}
                      />
                    ))}
                  </div>
                </div>

                <div className="rounded-md bg-zinc-800 p-3">
                  <div className="mb-2 text-xs text-zinc-400">回合数: {battle.turn.turnNumber}</div>
                </div>

                {battle.turn.phase === "action" && isMyTurn && (
                  <div className="space-y-2">
                    {!selectedPiece && (
                      <p className="text-xs text-muted-foreground text-center">
                        请从下方选择一个棋子进行操作
                      </p>
                    )}

                    {isSelectingMoveTarget ? (
                      <>
                        <p className="text-xs text-muted-foreground text-center">
                          请点击棋盘上的格子选择移动目标
                        </p>
                        <Button
                          className="w-full"
                          size="sm"
                          variant="outline"
                          onClick={() => setIsSelectingMoveTarget(false)}
                        >
                          取消移动
                        </Button>
                      </>
                    ) : isSelectingSkillTarget ? (
                      <>
                        <p className="text-xs text-muted-foreground text-center">
                          {targetSelectionType === 'grid' ? '请点击棋盘上的格子选择技能目标' : '请点击棋盘上的目标选择技能目标'}
                        </p>
                        <Button
                          className="w-full"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setIsSelectingSkillTarget(false)
                            setSelectedSkillId(undefined)
                          }}
                        >
                          取消技能
                        </Button>
                      </>
                    ) : (
                      <Button
                        className="w-full"
                        size="sm"
                        disabled={!selectedPiece}
                        onClick={() => setIsSelectingMoveTarget(true)}
                      >
                        <Footprints className="mr-2 h-4 w-4" />
                        移动
                      </Button>
                    )}

                    {selectedPiece && (
                      <div className="space-y-2">
                        {(() => {
                          const pieceTemplate = getPieceById(selectedPiece.templateId)
                          const pieceSkills = pieceTemplate?.skills || []

                          const availableSkills = pieceSkills.map(skill => {
                            const skillDef = battle.skillsById[skill.skillId]
                            return {
                              ...skillDef,
                              ...skill,
                              id: skill.skillId,
                              name: skillDef?.name || skill.skillId,
                              type: skillDef?.type || "normal",
                            }
                          }).filter(skill => skill && skill.kind !== "passive")

                          return availableSkills.map(skill => (
                            <Button
                              key={skill.id}
                              className="w-full"
                              variant="outline"
                              size="sm"
                              disabled={isSelectingMoveTarget}
                              onClick={() => {
                                if (selectedPiece) {
                                  sendBattleAction({
                                    type: skill.type === "normal" ? "useBasicSkill" : "useChargeSkill",
                                    playerId: currentPlayerId,
                                    pieceId: selectedPiece.instanceId,
                                    skillId: skill.id,
                                  })
                                }
                              }}
                            >
                              <Zap className="mr-2 h-4 w-4" />
                              {skill.name} ({skill.actionPointCost || 0}AP)
                            </Button>
                          ))
                        })()}
                      </div>
                    )}
                    <Button
                      className="w-full"
                      variant="secondary"
                      size="sm"
                      disabled={isSelectingMoveTarget}
                      onClick={() => {
                        sendBattleAction({
                          type: "endTurn",
                          playerId: currentPlayerId,
                        })
                      }}
                    >
                      结束回合
                    </Button>
                  </div>
                )}

                {battle.turn.phase !== "action" && isMyTurn && (
                  <Button
                    className="w-full"
                    size="sm"
                    onClick={() => {
                      sendBattleAction({
                        type: "beginPhase",
                      })
                    }}
                  >
                    继续
                  </Button>
                )}
              </CardContent>
            </Card>

            {/* 管理工具 */}
            <Card className="bg-zinc-900/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">管理工具</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Button
                  className="w-full"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowAddPieceDialog(true)}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  添加棋子
                </Button>
                <Button
                  className="w-full"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowResourceDialog(true)}
                >
                  <Settings className="mr-2 h-4 w-4" />
                  修改资源
                </Button>
                <Button
                  className="w-full"
                  variant="outline"
                  size="sm"
                  onClick={() => void resetCooldowns()}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  重置冷却
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* 中间战场和棋子 */}
          <div className="space-y-4 lg:col-span-2">
            <Card className="bg-zinc-900/50">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-sm">
                  <span>战场</span>
                  <span className="text-xs font-normal text-zinc-400">
                    {battle.map.name}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex justify-center">
                <GameBoard
                  map={battle.map}
                  pieces={battle.pieces}
                  onTileClick={(x, y) => {
                    if (isSelectingMoveTarget && selectedPiece) {
                      sendBattleAction({
                        type: "move",
                        playerId: currentPlayerId,
                        pieceId: selectedPiece.instanceId,
                        toX: x,
                        toY: y,
                      })
                      setIsSelectingMoveTarget(false)
                    } else if (isSelectingSkillTarget && selectedPiece && selectedSkillId) {
                      sendBattleAction({
                        type: "useBasicSkill",
                        playerId: currentPlayerId,
                        pieceId: selectedPiece.instanceId,
                        skillId: selectedSkillId,
                        targetX: x,
                        targetY: y,
                      })
                      setIsSelectingSkillTarget(false)
                      setSelectedSkillId(undefined)
                    }
                  }}
                  onPieceClick={(pieceId) => {
                    if (isSelectingSkillTarget && selectedPiece && selectedSkillId) {
                      sendBattleAction({
                        type: "useBasicSkill",
                        playerId: currentPlayerId,
                        pieceId: selectedPiece.instanceId,
                        skillId: selectedSkillId,
                        targetPieceId: pieceId,
                      })
                      setIsSelectingSkillTarget(false)
                      setSelectedSkillId(undefined)
                    } else {
                      setSelectedPieceId(pieceId)
                      setIsSelectingMoveTarget(false)
                      setIsSelectingSkillTarget(false)
                      setSelectedSkillId(undefined)
                    }
                  }}
                  selectedPieceId={selectedPieceId}
                  isSelectingMoveTarget={isSelectingMoveTarget}
                  isSelectingSkillTarget={isSelectingSkillTarget}
                  selectedSkillId={selectedSkillId}
                  teleportRange={battle.skillsById.teleport?.areaSize || 5}
                />
              </CardContent>
            </Card>

            {/* 战斗日志 */}
            <Card className="bg-zinc-900/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">战斗日志</CardTitle>
              </CardHeader>
              <CardContent className="max-h-40 overflow-y-auto space-y-2">
                {(battle.actions || []).map((action, index) => {
                  let pieceName = "未知棋子"
                  const payload = action.payload
                  if (payload?.pieceId) {
                    const piece = battle.pieces.find(p => p.instanceId === payload.pieceId)
                    if (piece) {
                      const pieceTemplate = getPieceById(piece.templateId)
                      pieceName = pieceTemplate?.name || piece.templateId || "未知棋子"
                    }
                  }

                  let formattedMessage = payload?.message || action.type || "未知操作"

                  return (
                    <div key={index} className="text-xs text-zinc-300">
                      <span className="text-zinc-500">[{action.turn || battle.turn.turnNumber}] </span>
                      <span className={action.playerId === TRAINING_PLAYER_1 ? "text-red-400" : "text-blue-400"}>
                        {pieceName}
                      </span>
                      <span className="text-zinc-400">: </span>
                      <span>{formattedMessage}</span>
                    </div>
                  )
                })}
                {(battle.actions || []).length === 0 && (
                  <div className="text-xs text-zinc-500">
                    战斗日志为空
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* 所有棋子 - 平铺显示在战场下方 */}
          <Card className="bg-zinc-900/50 lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">所有棋子</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {battle.pieces.filter(p => p.currentHp > 0).map((piece) => {
                const isRed = piece.faction === "red"
                const isSelected = selectedPieceId === piece.instanceId
                return (
                  <div
                    key={piece.instanceId}
                    className={`group relative flex items-center gap-4 cursor-pointer rounded-md p-2 transition-colors ${
                      isSelected
                        ? 'bg-zinc-800/80 border-l-4 border-green-500'
                        : 'hover:bg-zinc-800/50'
                    }`}
                    onClick={() => setSelectedPieceId(piece.instanceId)}
                  >
                    {(() => {
                      const pieceTemplate = getPieceById(piece.templateId)
                      const image = pieceTemplate?.image
                      return (
                        <div className={`flex h-12 w-12 items-center justify-center rounded-lg ${isRed ? "bg-red-600" : "bg-blue-600"}`}>
                          {image && image.startsWith("http") ? (
                            <img src={image} alt={pieceTemplate?.name || "Piece"} className="h-full w-full object-contain" />
                          ) : image && (image.length <= 3 || image.includes("️")) ? (
                            <span className="text-3xl font-bold text-white">{image}</span>
                          ) : image ? (
                            <img src={`/${image}`} alt={pieceTemplate?.name || "Piece"} className="h-full w-full object-contain" />
                          ) : (
                            <Swords className="h-6 w-6 text-white" />
                          )}
                        </div>
                      )
                    })()}
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-zinc-200">
                          {(() => {
                            const pieceTemplate = getPieceById(piece.templateId)
                            return pieceTemplate?.name || piece.templateId
                          })()}
                        </span>
                        <span className={`text-sm ${isRed ? "text-red-400" : "text-blue-400"}`}>
                          {isRed ? "红方" : "蓝方"}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-zinc-400">
                        <span className="flex items-center gap-1">
                          <Shield className="h-3 w-3" />
                          HP: {piece.currentHp}/{piece.maxHp}
                        </span>
                        <span className="flex items-center gap-1">
                          <Swords className="h-3 w-3" />
                          攻击: {piece.attack}
                        </span>
                        <span className="flex items-center gap-1">
                          <Footprints className="h-3 w-3" />
                          移动: {piece.moveRange}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-zinc-400">
                        <span className="flex items-center gap-1">
                          <Footprints className="h-3 w-3" />
                          位置: ({piece.x}, {piece.y})
                        </span>
                        <span className="flex items-center gap-1">
                          <Shield className="h-3 w-3" />
                          防御: {piece.defense || 0}
                        </span>
                      </div>
                      {/* 状态标签显示 */}
                      {piece.statusTags && piece.statusTags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {piece.statusTags.filter(tag => tag.visible !== false).map((tag, index) => (
                            <span key={index} className="px-2 py-0.5 rounded-full text-xs bg-zinc-800 text-zinc-300">
                              {tag.id}
                              {tag.currentDuration && ` (${tag.currentDuration})`}
                              {tag.stacks && ` x${tag.stacks}`}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 技能信息悬停显示 - 改为向下显示 */}
                    <div className="absolute left-0 top-full mt-2 w-64 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50">
                      {(() => {
                        const pieceTemplate = getPieceById(piece.templateId)
                        if (!pieceTemplate || !pieceTemplate.skills || pieceTemplate.skills.length === 0) {
                          return null
                        }
                        return (
                          <div className="rounded-lg border border-border bg-zinc-800 p-3 shadow-lg">
                            <div className="mb-2 text-xs font-medium text-zinc-200">技能</div>
                            <div className="space-y-2">
                              {pieceTemplate.skills.map((skill) => {
                                const skillDef = battle.skillsById[skill.skillId]
                                if (!skillDef) return null

                                // 计算技能的预期效果
                                const { calculateSkillPreview } = require('@/lib/game/skills')
                                // 从棋子的技能状态中获取当前冷却回合数
                                const pieceSkillState = piece.skills.find(s => s.skillId === skill.skillId)
                                const currentCooldown = pieceSkillState?.currentCooldown || 0
                                const skillPreview = calculateSkillPreview(skillDef, piece, currentCooldown)

                                return (
                                  <div key={skill.skillId} className="space-y-1">
                                    <div className="flex items-center justify-between text-xs">
                                      <span className="font-medium text-zinc-200">
                                        {skillDef.name || skill.skillId}
                                      </span>
                                      <span className={`text-xs ${
                                        skillDef.type === "super" ? "text-yellow-400" :
                                        skillDef.type === "ultimate" ? "text-purple-400" : "text-green-400"
                                      }`}>
                                        {skillDef.type === "super" ? "充能" :
                                         skillDef.type === "ultimate" ? "终极" : "普通"}
                                        {pieceSkillState?.usesRemaining === 1 && ' (限定技)'}
                                      </span>
                                    </div>
                                    <p className="text-xs text-zinc-400">
                                      {skillPreview.description || "无描述"}
                                    </p>
                                    <div className="flex items-center justify-between text-xs">
                                      <span className="text-zinc-500">冷却:</span>
                                      <span className={`text-xs ${
                                        skillPreview.currentCooldown && skillPreview.currentCooldown > 0
                                          ? "text-red-400"
                                          : "text-green-400"
                                      }`}>
                                        {skillPreview.currentCooldown && skillPreview.currentCooldown > 0
                                          ? `${skillPreview.currentCooldown} 回合`
                                          : "0 回合"}
                                      </span>
                                    </div>
                                    {skillDef.type === "super" && skillPreview.chargeCost && (
                                      <div className="flex items-center justify-between text-xs">
                                        <span className="text-zinc-500">充能点数:</span>
                                        <span className="text-yellow-400">
                                          {skillPreview.chargeCost} 点
                                        </span>
                                      </div>
                                    )}
                                    {skillDef.actionPointCost && (
                                      <div className="flex items-center justify-between text-xs">
                                        <span className="text-zinc-500">行动点数:</span>
                                        <span className="text-blue-400">
                                          {skillDef.actionPointCost} 点
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )
                      })()}
                    </div>
                  </div>
                )
              })}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* 添加棋子对话框 */}
      <Dialog open={showAddPieceDialog} onOpenChange={setShowAddPieceDialog}>
        <DialogContent className="bg-zinc-900 border-zinc-800">
          <DialogHeader>
            <DialogTitle>添加棋子</DialogTitle>
            <DialogDescription>
              选择要添加的棋子和位置
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>阵营</Label>
              <Select
                value={newPieceFaction}
                onValueChange={(v: "red" | "blue") => setNewPieceFaction(v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="red">红方</SelectItem>
                  <SelectItem value="blue">蓝方</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>棋子类型</Label>
              <Select
                value={newPieceTemplateId}
                onValueChange={setNewPieceTemplateId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择棋子" />
                </SelectTrigger>
                <SelectContent>
                  {availablePieces.map((piece) => (
                    <SelectItem key={piece.id} value={piece.id}>
                      {piece.name} ({piece.faction})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>X 坐标</Label>
                <Input
                  type="number"
                  value={newPieceX}
                  onChange={(e) => setNewPieceX(parseInt(e.target.value) || 0)}
                  min={0}
                  max={battle.map.width - 1}
                />
              </div>
              <div className="space-y-2">
                <Label>Y 坐标</Label>
                <Input
                  type="number"
                  value={newPieceY}
                  onChange={(e) => setNewPieceY(parseInt(e.target.value) || 0)}
                  min={0}
                  max={battle.map.height - 1}
                />
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowAddPieceDialog(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                if (newPieceTemplateId) {
                  void addPiece(newPieceFaction, newPieceTemplateId, newPieceX, newPieceY)
                  setShowAddPieceDialog(false)
                }
              }}
              disabled={!newPieceTemplateId}
            >
              添加
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 修改资源对话框 */}
      <Dialog open={showResourceDialog} onOpenChange={setShowResourceDialog}>
        <DialogContent className="bg-zinc-900 border-zinc-800">
          <DialogHeader>
            <DialogTitle>修改资源</DialogTitle>
            <DialogDescription>
              修改玩家的行动点和充能点
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>目标玩家</Label>
              <Select
                value={resourcePlayerId}
                onValueChange={setResourcePlayerId}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TRAINING_PLAYER_1}>红方</SelectItem>
                  <SelectItem value={TRAINING_PLAYER_2}>蓝方</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>行动点</Label>
              <Input
                type="number"
                value={resourceActionPoints}
                onChange={(e) => setResourceActionPoints(parseInt(e.target.value) || 0)}
                min={0}
                max={20}
              />
            </div>
            <div className="space-y-2">
              <Label>充能点</Label>
              <Input
                type="number"
                value={resourceChargePoints}
                onChange={(e) => setResourceChargePoints(parseInt(e.target.value) || 0)}
                min={0}
                max={20}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowResourceDialog(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                void updateResources(resourcePlayerId, resourceActionPoints, resourceChargePoints)
                setShowResourceDialog(false)
              }}
            >
              更新
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 选择地图对话框 */}
      <Dialog open={showMapSelectDialog} onOpenChange={setShowMapSelectDialog}>
        <DialogContent className="bg-zinc-900 border-zinc-800">
          <DialogHeader>
            <DialogTitle>选择地图</DialogTitle>
            <DialogDescription>
              选择要使用的训练地图
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>地图</Label>
              <Select
                value={selectedMapId}
                onValueChange={setSelectedMapId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择地图" />
                </SelectTrigger>
                <SelectContent>
                  {availableMaps.map((map) => (
                    <SelectItem key={map.id} value={map.id}>
                      {map.name} ({map.width}x{map.height})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowMapSelectDialog(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                if (selectedMapId) {
                  void initTraining(selectedMapId)
                  setShowMapSelectDialog(false)
                }
              }}
              disabled={!selectedMapId}
            >
              切换
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  )
}
