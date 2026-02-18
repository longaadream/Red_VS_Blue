"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter, useParams, useSearchParams } from "next/navigation"
import { ArrowLeft, Loader2, Swords, Shield, Zap, Footprints, Flag } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { GameBoard } from "@/components/game-board"
import type { BattleState, BattleAction } from "@/lib/game/turn"
import { getPieceById, loadPieces } from "@/lib/game/piece-repository"

type Room = {
  id: string
  name: string
  status: "waiting" | "in-progress" | "finished"
  players: { id: string; name: string }[]
  currentTurnIndex: number
}

export default function BattlePage() {
  const router = useRouter()
  const params = useParams()
  const searchParams = useSearchParams()

  const [roomId, setRoomId] = useState<string | null>(null)
  const [room, setRoom] = useState<Room | null>(null)
  const [battle, setBattle] = useState<BattleState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [currentPlayerId, setCurrentPlayerId] = useState<string | null>(null)

  useEffect(() => {
    const id = params.roomId as string
    if (id) {
      setRoomId(id)
      void fetchRoomAndBattle(id)
      // 加载棋子数据
      void loadPieces()
    } else {
      setLoading(false)
    }
  }, [params])

  // 从URL参数获取玩家ID
  useEffect(() => {
    const playerId = searchParams.get("playerId")
    if (playerId && battle?.players) {
      // 查找对应的玩家
      const player = battle.players.find(p => p.playerId === playerId)
      if (player) {
        setCurrentPlayerId(player.playerId)
      }
    }
  }, [searchParams, battle])

  async function fetchRoomAndBattle(id: string) {
    try {
      setLoading(true)
      setError(null)

      const res = await fetch(`/api/rooms/${id}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Failed to load room")
      }

      const data = (await res.json()) as Room
      setRoom(data)

      if (data.status === "in-progress") {
        await fetchBattle(id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }

  async function fetchBattle(id: string) {
    try {
      const res = await fetch(`/api/rooms/${id}/battle`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Failed to load battle state")
      }
      const data = (await res.json()) as BattleState
      setBattle(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load battle state")
    }
  }

  async function sendBattleAction(action: BattleAction) {
    if (!roomId) return
    try {
      setLoading(true)
      setError(null)
      const res = await fetch(`/api/rooms/${roomId}/battle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || "Failed to apply battle action")
      }
      setBattle(data as BattleState)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }

  // 当 battle 加载时，尝试从本地存储获取上次选择的玩家 ID
  useEffect(() => {
    if (battle?.players?.length > 0 && !currentPlayerId) {
      const storedPlayerId = localStorage.getItem(`battle-player-${roomId}`)
      if (storedPlayerId) {
        // 检查存储的玩家 ID 是否存在于当前战斗中
        const playerExists = battle.players.some(p => p.playerId.toLowerCase() === storedPlayerId.toLowerCase())
        if (playerExists) {
          setCurrentPlayerId(storedPlayerId)
        }
      }
      // 不再默认选择第一个玩家，强制显示选择界面
    }
  }, [battle, roomId, currentPlayerId])

  // 保存玩家选择到本地存储
  useEffect(() => {
    if (currentPlayerId && roomId) {
      localStorage.setItem(`battle-player-${roomId}`, currentPlayerId)
    }
  }, [currentPlayerId, roomId])

  // 轮询检查战斗状态，确保所有玩家能及时获取状态更新
  useEffect(() => {
    if (!roomId || !currentPlayerId) return

    // 立即检查一次状态
    const checkStatusImmediately = async () => {
      try {
        const res = await fetch(`/api/rooms/${roomId}/battle`)
        if (res.ok) {
          const data = (await res.json()) as BattleState
          setBattle(data)
          checkGameEnd(data)
        }
      } catch (error) {
        // 忽略错误
      }
    }

    // 立即检查一次
    void checkStatusImmediately()

    // 然后设置轮询，缩短轮询间隔到1秒，确保更快地检测到游戏状态变化
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/rooms/${roomId}/battle`)
        if (res.ok) {
          const data = (await res.json()) as BattleState
          setBattle(data)
          
          // 检查游戏是否结束
          checkGameEnd(data)
        }
      } catch (error) {
        // 忽略错误
      }
    }, 1000) // 缩短轮询间隔到1秒

    return () => clearInterval(interval)
  }, [roomId, currentPlayerId])

  // 检查游戏是否结束
  function checkGameEnd(battleState: BattleState) {
    if (!battleState || !battleState.players || battleState.players.length === 0) return

    // 统计每个玩家的存活棋子数量
    const playerAlivePieces: Record<string, number> = {}
    
    battleState.players.forEach(player => {
      playerAlivePieces[player.playerId] = 0
    })
    
    battleState.pieces.forEach(piece => {
      if (piece.currentHp > 0 && piece.ownerPlayerId in playerAlivePieces) {
        playerAlivePieces[piece.ownerPlayerId]++
      }
    })
    
    console.log('Player alive pieces:', playerAlivePieces)
    
    // 检查是否有玩家的所有棋子都已阵亡
    const eliminatedPlayers = Object.entries(playerAlivePieces)
      .filter(([_, count]) => count === 0)
      .map(([playerId]) => playerId)
    
    console.log('Eliminated players:', eliminatedPlayers)
    
    if (eliminatedPlayers.length > 0) {
      // 确定获胜者
      const remainingPlayers = battleState.players
        .filter(player => !eliminatedPlayers.includes(player.playerId))
      
      console.log('Remaining players:', remainingPlayers)
      
      if (remainingPlayers.length === 1) {
        // 显示游戏结束消息
        const winner = remainingPlayers[0]
        const isCurrentPlayerWinner = winner.playerId.toLowerCase() === currentPlayerId?.toLowerCase()
        
        // 立即显示胜利/失败画面
        alert(isCurrentPlayerWinner ? "恭喜你获胜了！" : `你输了，${winner.playerId} 获胜！`)
        
        // 重定向回大厅
        router.push('/play')
      }
    }
  }

  const isMyTurn = useMemo(() => {
    if (!room || !battle || !currentPlayerId) return false
    return battle.turn.currentPlayerId.toLowerCase() === currentPlayerId.toLowerCase()
  }, [room, battle, currentPlayerId])

  const myPieces = useMemo(() => {
    if (!battle || !currentPlayerId) return []
    return battle.pieces.filter((p) => p.ownerPlayerId.toLowerCase() === currentPlayerId.toLowerCase() && p.currentHp > 0)
  }, [battle, currentPlayerId])

  const [selectedPieceId, setSelectedPieceId] = useState<string | null>(null)
  const [isSelectingMoveTarget, setIsSelectingMoveTarget] = useState(false)
  const [isSelectingTeleportTarget, setIsSelectingTeleportTarget] = useState(false)
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)

  const selectedPiece = useMemo(() => {
    if (!selectedPieceId || !battle) return null
    return battle.pieces.find(p => p.instanceId === selectedPieceId)
  }, [selectedPieceId, battle])

  if (loading) {
    return (
      <main className="flex min-h-svh flex-col items-center justify-center bg-zinc-950 px-4">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
        <p className="mt-4 text-zinc-400">加载中...</p>
      </main>
    )
  }

  if (error) {
    return (
      <main className="flex min-h-svh flex-col items-center justify-center bg-zinc-950 px-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-destructive">错误</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{error}</p>
            <div className="flex gap-2">
              <Button asChild variant="outline">
                <Link href="/play">返回大厅</Link>
              </Button>
              {roomId && (
                <Button onClick={() => void fetchRoomAndBattle(roomId)}>
                  重试
                </Button>
              )}
            </div>
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
            <CardTitle>等待游戏开始</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">游戏尚未开始，请稍候...</p>
            <Button asChild variant="outline">
              <Link href="/play">返回大厅</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    )
  }

  // 玩家选择界面
  if (!currentPlayerId && battle.players.length > 1) {
    return (
      <main className="flex min-h-svh flex-col items-center justify-center bg-zinc-950 px-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>选择你的身份</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">请选择你在本次对战中的身份：</p>
            <div className="space-y-2">
              {battle.players.map((player) => (
                <Button
                  key={player.playerId}
                  className="w-full justify-between"
                  onClick={() => setCurrentPlayerId(player.playerId)}
                >
                  <span>{player.playerId}</span>
                  <Zap className="h-4 w-4 text-yellow-400" />
                </Button>
              ))}
            </div>
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
      <div className="mx-auto w-full max-w-6xl space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button asChild variant="ghost" size="sm">
              <Link href="/play">
                <ArrowLeft className="mr-2 h-4 w-4" />
                大厅
              </Link>
            </Button>
            <h1 className="text-xl font-bold text-zinc-100">
              <Swords className="mr-2 inline h-5 w-5 text-red-500" />
              Red VS Blue
            </h1>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2">
              <span className="text-sm text-zinc-400">回合</span>
              <span className="text-lg font-bold text-zinc-100">{battle.turn.turnNumber}</span>
            </div>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  <Flag className="mr-2 h-4 w-4" />
                  投降
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>确认投降</DialogTitle>
                  <DialogDescription>
                    你确定要投降吗？这将导致你输掉当前游戏。
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline">取消</Button>
                  <Button 
                    variant="destructive" 
                    onClick={async () => {
                      if (currentPlayerId) {
                        try {
                          await sendBattleAction({
                            type: "surrender",
                            playerId: currentPlayerId
                          })
                          
                          // 投降后立即显示战败画面
                          alert("你已投降，游戏结束！")
                          router.push('/play')
                        } catch (error) {
                          console.error("投降失败：", error)
                        }
                      }
                    }}
                  >
                    确认投降
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
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
                        // 检查移动是否有效（这里也可以在客户端做一次验证）
                        sendBattleAction({
                          type: "move",
                          playerId: currentPlayerId!,
                          pieceId: selectedPiece.instanceId,
                          toX: x,
                          toY: y,
                        })
                        setIsSelectingMoveTarget(false)
                      } else if (isSelectingTeleportTarget && selectedPiece && selectedSkillId === "teleport") {
                        // 处理传送目标选择
                        sendBattleAction({
                          type: "useBasicSkill",
                          playerId: currentPlayerId!,
                          pieceId: selectedPiece.instanceId,
                          skillId: "teleport",
                          targetX: x,
                          targetY: y,
                        })
                        setIsSelectingTeleportTarget(false)
                        setSelectedSkillId(null)
                      }
                    }}
                    selectedPieceId={selectedPieceId}
                    isSelectingMoveTarget={isSelectingMoveTarget}
                    isSelectingTeleportTarget={isSelectingTeleportTarget}
                    teleportRange={battle.skillsById.teleport?.areaSize || 5}
                  />
                </CardContent>
            </Card>

            {myPieces.length > 0 && (
              <Card className="bg-zinc-900/50">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">我的棋子</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {myPieces.map((piece) => (
                      <div 
                        key={piece.instanceId} 
                        className={`group relative flex items-center gap-4 cursor-pointer rounded-md p-2 transition-colors ${
                          selectedPieceId === piece.instanceId 
                            ? 'bg-zinc-800/80 border-l-4 border-green-500' 
                            : 'hover:bg-zinc-800/50'
                        }`}
                        onClick={() => setSelectedPieceId(piece.instanceId)}
                      >
                        {(() => {
                          const pieceTemplate = getPieceById(piece.templateId)
                          const image = pieceTemplate?.image
                          return (
                            <div className={`flex h-12 w-12 items-center justify-center rounded-lg ${
                              piece.faction === "red" ? "bg-red-600" : "bg-blue-600"
                            }`}>
                              {image && image.startsWith("http") ? (
                                <img 
                                  src={image} 
                                  alt={pieceTemplate?.name || "Piece"} 
                                  className="h-8 w-8 object-contain"
                                />
                              ) : image ? (
                                <span className="text-2xl">{image}</span>
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
                            <span className={`text-sm ${
                              piece.faction === "red" ? "text-red-400" : "text-blue-400"
                            }`}>
                              {piece.faction === "red" ? "红方" : "蓝方"}
                            </span>
                          </div>
                          <div className="flex items-center gap-4 text-xs text-zinc-400">
                            <span className="flex items-center gap-1">
                              <Shield className="h-3 w-3" />
                              HP: {piece.currentHp}
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
                              护盾: {piece.shield || 0}
                            </span>
                          </div>
                        </div>
                        
                        {/* 技能信息悬停显示 */}
                        <div className="absolute right-0 top-0 -translate-y-full mr-2 mb-2 w-64 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-10">
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
                                    return (
                                      <div key={skill.skillId} className="space-y-1">
                                        <div className="flex items-center justify-between text-xs">
                                          <span className="font-medium text-zinc-200">
                                            {skillDef?.name || skill.skillId}
                                          </span>
                                          <span className={`text-xs ${
                                            skillDef?.type === "super" ? "text-yellow-400" : "text-green-400"
                                          }`}>
                                            {skillDef?.type === "super" ? "充能" : "普通"}
                                          </span>
                                        </div>
                                        <p className="text-xs text-zinc-400">
                                          {skillDef?.description || "无描述"}
                                        </p>
                                      </div>
                                    )
                                  })}
                                </div>
                              </div>
                            )
                          })()}
                        </div>
                      </div>
                    ))}
                  <div className="text-xs text-zinc-400 border-t border-zinc-800 pt-2">
                    <span className="flex items-center gap-1">
                      <Swords className="h-3 w-3" />
                      剩余棋子: {myPieces.length}
                    </span>
                  </div>
                </CardContent>
              </Card>
            )}

            {(() => {
              const opponentPieces = battle.pieces.filter(p => 
                p.ownerPlayerId !== currentPlayerId && p.currentHp > 0
              )
              return opponentPieces.length > 0 ? (
                <Card className="bg-zinc-900/50">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">对方棋子</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {opponentPieces.map((piece) => (
                      <div 
                        key={piece.instanceId} 
                        className="group relative flex items-center gap-4 rounded-md p-2 hover:bg-zinc-800/30"
                      >
                        {(() => {
                          const pieceTemplate = getPieceById(piece.templateId)
                          const image = pieceTemplate?.image
                          return (
                            <div className={`flex h-12 w-12 items-center justify-center rounded-lg ${
                              piece.faction === "red" ? "bg-red-600" : "bg-blue-600"
                            }`}>
                              {image && image.startsWith("http") ? (
                                <img 
                                  src={image} 
                                  alt={pieceTemplate?.name || "Piece"} 
                                  className="h-8 w-8 object-contain"
                                />
                              ) : image ? (
                                <span className="text-2xl">{image}</span>
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
                            <span className={`text-sm ${
                              piece.faction === "red" ? "text-red-400" : "text-blue-400"
                            }`}>
                              {piece.faction === "red" ? "红方" : "蓝方"}
                            </span>
                          </div>
                          <div className="flex items-center gap-4 text-xs text-zinc-400">
                            <span className="flex items-center gap-1">
                              <Shield className="h-3 w-3" />
                              HP: {piece.currentHp}
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
                              护盾: {piece.shield || 0}
                            </span>
                          </div>
                        </div>
                        
                        {/* 技能信息悬停显示 */}
                        <div className="absolute right-0 top-0 -translate-y-full mr-2 mb-2 w-64 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-10">
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
                                    return (
                                      <div key={skill.skillId} className="space-y-1">
                                        <div className="flex items-center justify-between text-xs">
                                          <span className="font-medium text-zinc-200">
                                            {skillDef?.name || skill.skillId}
                                          </span>
                                          <span className={`text-xs ${
                                            skillDef?.type === "super" ? "text-yellow-400" : "text-green-400"
                                          }`}>
                                            {skillDef?.type === "super" ? "充能" : "普通"}
                                          </span>
                                        </div>
                                        <p className="text-xs text-zinc-400">
                                          {skillDef?.description || "无描述"}
                                        </p>
                                      </div>
                                    )
                                  })}
                                </div>
                              </div>
                            )
                          })()}
                        </div>
                      </div>
                    ))}
                    <div className="text-xs text-zinc-400 border-t border-zinc-800 pt-2">
                      <span className="flex items-center gap-1">
                        <Swords className="h-3 w-3" />
                        剩余棋子: {opponentPieces.length}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ) : null
            })()}
          </div>

          <div className="space-y-4">
            <Card className="bg-zinc-900/50">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-sm">
                  <span>当前行动</span>
                  <span className={`px-2 py-0.5 text-xs font-medium rounded ${
                    isMyTurn ? "bg-green-600 text-white" : "bg-zinc-700 text-zinc-300"
                  }`}>
                    {isMyTurn ? "你的回合" : "对手回合"}
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
                  <div className="mb-2 text-xs text-zinc-400">本回合行动</div>
                  <div className="space-y-1 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1 text-zinc-400">
                        <Footprints className="h-3 w-3" />
                        移动
                      </span>
                      <span className={battle.turn.actions.hasMoved ? "text-red-400" : "text-green-400"}>
                        {battle.turn.actions.hasMoved ? "已使用" : "可用"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1 text-zinc-400">
                        <Zap className="h-3 w-3" />
                        普通技能
                      </span>
                      <span className={battle.turn.actions.hasUsedBasicSkill ? "text-red-400" : "text-green-400"}>
                        {battle.turn.actions.hasUsedBasicSkill ? "已使用" : "可用"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1 text-zinc-400">
                        <Swords className="h-3 w-3" />
                        充能技能
                      </span>
                      <span className={battle.turn.actions.hasUsedChargeSkill ? "text-red-400" : "text-green-400"}>
                        {battle.turn.actions.hasUsedChargeSkill ? "已使用" : "可用"}
                      </span>
                    </div>
                  </div>
                </div>

                {battle.turn.phase === "action" && isMyTurn && (
                  <div className="space-y-2">
                    {!selectedPiece && (
                      <p className="text-xs text-muted-foreground text-center">
                        请从左侧选择一个棋子进行操作
                      </p>
                    )}
                    
                    {isSelectingMoveTarget ? (
                      <>
                        <p className="text-xs text-muted-foreground text-center">
                          请点击棋盘上的格子选择移动目标（像国际象棋的车一样移动）
                        </p>
                        <Button
                          className="w-full"
                          size="sm"
                          variant="outline"
                          disabled={loading}
                          onClick={() => {
                            setIsSelectingMoveTarget(false)
                          }}
                        >
                          取消移动
                        </Button>
                      </>
                    ) : isSelectingTeleportTarget ? (
                      <>
                        <p className="text-xs text-muted-foreground text-center">
                          请点击棋盘上的格子选择传送目标（{battle.skillsById.teleport?.areaSize || 5}格范围内）
                        </p>
                        <Button
                          className="w-full"
                          size="sm"
                          variant="outline"
                          disabled={loading}
                          onClick={() => {
                            setIsSelectingTeleportTarget(false)
                            setSelectedSkillId(null)
                          }}
                        >
                          取消传送
                        </Button>
                      </>
                    ) : (
                      <Button
                        className="w-full"
                        size="sm"
                        disabled={loading || battle.turn.actions.hasMoved || !selectedPiece}
                        onClick={() => {
                          setIsSelectingMoveTarget(true)
                        }}
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
                          
                          console.log('Selected piece:', selectedPiece.templateId)
                          console.log('Piece skills:', pieceSkills)
                          console.log('Battle skills:', Object.keys(battle.skillsById))
                          
                          const availableSkills = pieceSkills.map(skill => {
                            const skillDef = battle.skillsById[skill.skillId]
                            console.log('Skill', skill.skillId, 'found:', !!skillDef)
                            
                            // 确保技能对象总是有完整的属性
                            const mergedSkill = {
                              id: skill.skillId,
                              name: skill.skillId,
                              type: "normal",
                              ...skill,
                              ...skillDef
                            }
                            
                            return mergedSkill
                          }).filter(skill => skill)
                          
                          console.log('Available skills:', availableSkills)
                          
                          return availableSkills.map(skill => (
                            <Button
                              key={skill.id}
                              className="w-full"
                              variant="outline"
                              size="sm"
                              disabled={loading || 
                                (skill.type === "normal" && battle.turn.actions.hasUsedBasicSkill) || 
                                (skill.type === "super" && battle.turn.actions.hasUsedChargeSkill) || 
                                isSelectingMoveTarget}
                              onClick={() => {
                                if (selectedPiece) {
                                  if (skill.id === "teleport") {
                                    // 进入传送目标选择模式
                                    setSelectedSkillId(skill.id)
                                    setIsSelectingTeleportTarget(true)
                                  } else {
                                    // 直接使用其他技能
                                    sendBattleAction({
                                      type: skill.type === "normal" ? "useBasicSkill" : "useChargeSkill",
                                      playerId: currentPlayerId!,
                                      pieceId: selectedPiece.instanceId,
                                      skillId: skill.id,
                                    })
                                  }
                                }
                              }}
                            >
                              <Zap className="mr-2 h-4 w-4" />
                              {skill.name} ({skill.type === "super" ? "充能" : "普通"})
                            </Button>
                          ))
                        })()}
                      </div>
                    )}
                    <Button
                      className="w-full"
                      variant="secondary"
                      size="sm"
                      disabled={loading || isSelectingMoveTarget}
                      onClick={() => {
                        sendBattleAction({
                          type: "endTurn",
                          playerId: currentPlayerId!,
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
                    disabled={loading}
                    onClick={() => {
                      sendBattleAction({
                        type: "beginPhase",
                        playerId: currentPlayerId!,
                      })
                    }}
                  >
                    继续
                  </Button>
                )}
              </CardContent>
            </Card>

            <Card className="bg-zinc-900/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">玩家信息</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {battle.players.map((player) => {
                  const isCurrentPlayer = player.playerId.toLowerCase() === currentPlayerId?.toLowerCase()
                  const playerPiece = battle.pieces.find(p => p.ownerPlayerId === player.playerId)
                  return (
                    <div
                      key={player.playerId}
                      className={`flex items-center justify-between rounded-md p-2 ${
                        battle.turn.currentPlayerId === player.playerId
                          ? "bg-green-900/30"
                          : "bg-zinc-800/50"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div className={`h-2 w-2 rounded-full ${
                          battle.turn.currentPlayerId === player.playerId
                            ? "animate-pulse bg-green-500"
                            : "bg-zinc-500"
                        }`} />
                        <span className={`text-sm ${isCurrentPlayer ? "font-medium text-zinc-200" : "text-zinc-400"}`}>
                          {player.playerId} {isCurrentPlayer && "(你)"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <span className="flex items-center gap-1 text-zinc-300">
                          <Swords className="h-3 w-3" />
                          {battle.pieces.filter(p => p.ownerPlayerId === player.playerId && p.currentHp > 0).length}
                        </span>
                        <span className="flex items-center gap-1 text-yellow-400">
                          <Zap className="h-3 w-3" />
                          {player.chargePoints}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </main>
  )
}
