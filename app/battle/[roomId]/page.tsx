"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter, useParams, useSearchParams } from "next/navigation"
import { ArrowLeft, Loader2, Swords, Shield, Zap, Footprints } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { toast } from "sonner"
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

  // 从URL参数获取玩家ID（强制小写）
  useEffect(() => {
    const playerId = searchParams.get("playerId")
    if (playerId && battle?.players) {
      // 查找对应的玩家（使用小写比较）
      const normalizedPlayerId = playerId.toLowerCase()
      const player = battle.players.find(p => p.playerId === normalizedPlayerId)
      if (player) {
        setCurrentPlayerId(player.playerId) // 使用服务器返回的小写ID
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

      // 无论房间状态如何，都尝试获取战斗状态
      // 这样可以确保在游戏刚刚启动时能够获取到最新的战斗状态
      await fetchBattle(id)
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
      const res = await fetch(`/api/rooms/${roomId}/battle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        // 检查是否是需要目标选择的情况
        if (data.needsTargetSelection) {
          setIsSelectingSkillTarget(true);
          setTargetSelectionType(data.targetType || 'piece');
          setTargetSelectionRange(data.range || 5);
          setTargetSelectionFilter(data.filter || 'enemy');
          if (action.type === 'playCard') {
            // 卡牌目标选择：保存卡牌 action，onPieceClick/onCellClick 里直接带上 targetPieceId 重发
            setPendingCardAction(action);
          } else {
            setSelectedSkillId(action.skillId!);
            const skillDef = battle?.skillsById[action.skillId!];
            setSelectedSkillType(skillDef?.type as "normal" | "super" | null);
            if ('selectedOption' in action) {
              setPendingSelectedOption((action as any).selectedOption);
            }
          }
          return;
        }
        // 检查是否是需要选项选择的情况
        if (data.needsOptionSelection) {
          setIsSelectingOption(true);
          setOptionSelectionTitle(data.title || '请选择');
          setOptionSelectionOptions(data.options || []);
          setPendingOptionAction(action);
          return;
        }
        // 使用toast通知显示错误信息，而不是设置错误状态
        toast.error(data.error || "操作失败");
        return;
      }
      setBattle(data as BattleState)
    } catch (err) {
      // 使用toast通知显示错误信息，而不是设置错误状态
      toast.error(err instanceof Error ? err.message : "未知错误")
    } finally {
      setLoading(false)
    }
  }

  // 处理选项选择器的选择结果
  async function handleOptionSelect(value: any | null) {
    if (value === null) {
      // 用户取消了技能释放
      setIsSelectingOption(false)
      setOptionSelectionOptions([])
      setOptionSelectionTitle('请选择')
      setPendingOptionAction(null)
      return
    }
    if (pendingOptionAction) {
      const actionWithOption = { ...pendingOptionAction, selectedOption: value } as BattleAction
      setIsSelectingOption(false)
      setOptionSelectionOptions([])
      setOptionSelectionTitle('请选择')
      setPendingOptionAction(null)
      await sendBattleAction(actionWithOption)
    }
  }

  // 当 battle 加载时，尝试从本地存储获取上次选择的玩家 ID
  useEffect(() => {
    if (battle?.players?.length > 0 && !currentPlayerId) {
      const storedPlayerId = localStorage.getItem(`battle-player-${roomId}`)
      if (storedPlayerId) {
        // 检查存储的玩家 ID 是否存在于当前战斗中（使用小写比较）
        const normalizedStoredId = storedPlayerId.toLowerCase()
        const player = battle.players.find(p => p.playerId === normalizedStoredId)
        if (player) {
          setCurrentPlayerId(player.playerId) // 使用服务器返回的小写ID
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
    if (gameResult) return

    const playerAlivePieces: Record<string, number> = {}
    battleState.players.forEach(player => {
      playerAlivePieces[player.playerId] = 0
    })
    battleState.pieces.forEach(piece => {
      if (piece.currentHp > 0 && piece.ownerPlayerId in playerAlivePieces) {
        playerAlivePieces[piece.ownerPlayerId]++
      }
    })

    const eliminatedPlayers = Object.entries(playerAlivePieces)
      .filter(([_, count]) => count === 0)
      .map(([playerId]) => playerId)

    if (eliminatedPlayers.length > 0) {
      const remainingPlayers = battleState.players
        .filter(player => !eliminatedPlayers.includes(player.playerId))
      if (remainingPlayers.length === 1) {
        const winner = remainingPlayers[0]
        setGameResult({ winnerId: winner.playerId, isWinner: winner.playerId === currentPlayerId })
      }
    }
  }

  function handleReturnToMenu() {
    if (roomId) {
      fetch(`/api/rooms/${encodeURIComponent(roomId)}`, { method: "DELETE" })
        .finally(() => router.push('/'))
    } else {
      router.push('/')
    }
  }



  const isMyTurn = useMemo(() => {
    if (!room || !battle || !currentPlayerId) return false
    return battle.turn.currentPlayerId === currentPlayerId
  }, [room, battle, currentPlayerId])

  const myPieces = useMemo(() => {
    if (!battle || !currentPlayerId) return []
    return battle.pieces.filter((p) => p.ownerPlayerId === currentPlayerId && p.currentHp > 0)
  }, [battle, currentPlayerId])

  const [gameResult, setGameResult] = useState<{ winnerId: string; isWinner: boolean } | null>(null)
  const [selectedPieceId, setSelectedPieceId] = useState<string | null>(null)
  const [isSelectingMoveTarget, setIsSelectingMoveTarget] = useState(false)
  const [isSelectingTeleportTarget, setIsSelectingTeleportTarget] = useState(false)
  const [isSelectingSkillTarget, setIsSelectingSkillTarget] = useState(false)
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [selectedSkillType, setSelectedSkillType] = useState<"normal" | "super" | null>(null)
  const [targetSelectionType, setTargetSelectionType] = useState<'piece' | 'grid'>('piece')
  const [targetSelectionRange, setTargetSelectionRange] = useState(5)
  const [targetSelectionFilter, setTargetSelectionFilter] = useState<'enemy' | 'ally' | 'all'>('enemy')

  // 选项选择器状态
  const [isSelectingOption, setIsSelectingOption] = useState(false)
  const [optionSelectionTitle, setOptionSelectionTitle] = useState<string>('请选择')
  const [optionSelectionOptions, setOptionSelectionOptions] = useState<{ label: string; value: any; description?: string }[]>([])
  const [pendingOptionAction, setPendingOptionAction] = useState<BattleAction | null>(null)
  const [pendingSelectedOption, setPendingSelectedOption] = useState<any>(undefined)
  const [pendingCardAction, setPendingCardAction] = useState<BattleAction | null>(null)

  const selectedPiece = useMemo(() => {
    if (!selectedPieceId || !battle || !currentPlayerId) return null
    const piece = battle.pieces.find(p => p.instanceId === selectedPieceId)
    // 只有己方棋子才能被选中为当前操作棋子
    if (piece && piece.ownerPlayerId === currentPlayerId) {
      return piece
    }
    return null
  }, [selectedPieceId, battle, currentPlayerId])

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

  if (gameResult) {
    return (
      <main className="flex min-h-svh flex-col items-center justify-center bg-zinc-950">
        <div className="flex flex-col items-center gap-8">
          {gameResult.isWinner ? (
            <>
              <div className="text-8xl font-black tracking-widest text-yellow-400 drop-shadow-[0_0_40px_rgba(250,204,21,0.6)]">
                胜利
              </div>
              <p className="text-xl text-zinc-300">恭喜你赢得了这场对战！</p>
            </>
          ) : (
            <>
              <div className="text-8xl font-black tracking-widest text-zinc-500 drop-shadow-[0_0_40px_rgba(100,100,100,0.4)]">
                失败
              </div>
              <p className="text-xl text-zinc-400">{gameResult.winnerId} 获胜</p>
            </>
          )}
          <Button size="lg" onClick={handleReturnToMenu} className="mt-4 px-10 py-6 text-lg">
            返回主菜单
          </Button>
        </div>
      </main>
    )
  }

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
                      } else if (isSelectingSkillTarget && pendingCardAction) {
                        // 卡牌目标位置选择
                        sendBattleAction({ ...pendingCardAction, targetX: x, targetY: y } as any)
                        setIsSelectingSkillTarget(false)
                        setPendingCardAction(null)
                      } else if (isSelectingSkillTarget && selectedPiece && selectedSkillId) {
                        // 处理技能目标位置选择（如暴风雪的区域选择）
                        sendBattleAction({
                          type: selectedSkillType === "super" ? "useChargeSkill" : "useBasicSkill",
                          playerId: currentPlayerId!,
                          pieceId: selectedPiece.instanceId,
                          skillId: selectedSkillId,
                          targetX: x,
                          targetY: y,
                          ...(pendingSelectedOption !== undefined ? { selectedOption: pendingSelectedOption } : {}),
                        })
                        setIsSelectingSkillTarget(false)
                        setSelectedSkillId(null)
                        setSelectedSkillType(null)
                        setPendingSelectedOption(undefined)
                      }
                    }}
                    onPieceClick={(pieceId) => {
                      if (isSelectingSkillTarget && pendingCardAction) {
                        // 卡牌目标棋子选择
                        sendBattleAction({ ...pendingCardAction, targetPieceId: pieceId } as any)
                        setIsSelectingSkillTarget(false)
                        setPendingCardAction(null)
                      } else if (isSelectingSkillTarget && selectedPiece && selectedSkillId) {
                        // 处理技能目标棋子选择
                        sendBattleAction({
                          type: selectedSkillType === "super" ? "useChargeSkill" : "useBasicSkill",
                          playerId: currentPlayerId!,
                          pieceId: selectedPiece.instanceId,
                          skillId: selectedSkillId,
                          targetPieceId: pieceId,
                          ...(pendingSelectedOption !== undefined ? { selectedOption: pendingSelectedOption } : {}),
                        })
                        setIsSelectingSkillTarget(false)
                        setSelectedSkillId(null)
                        setSelectedSkillType(null)
                        setPendingSelectedOption(undefined)
                      } else {
                        // 检查点击的是否是己方棋子
                        const clickedPiece = battle.pieces.find(p => p.instanceId === pieceId);
                        if (clickedPiece && clickedPiece.ownerPlayerId === currentPlayerId) {
                          setSelectedPieceId(pieceId);
                          // 重置选择状态
                          setIsSelectingMoveTarget(false);
                          setIsSelectingTeleportTarget(false);
                          setIsSelectingSkillTarget(false);
                          setSelectedSkillId(null);
                        }
                      }
                    }}
                    selectedPieceId={selectedPieceId}
                    isSelectingMoveTarget={isSelectingMoveTarget}
                    isSelectingTeleportTarget={isSelectingTeleportTarget}
                    isSelectingSkillTarget={isSelectingSkillTarget}
                    selectedSkillId={selectedSkillId}
                    teleportRange={battle.skillsById.teleport?.areaSize || 5}
                    extensions={battle.extensions}
                  />
                </CardContent>
            </Card>
            
            {/* 终端框 - 显示技能执行消息 */}
            <Card className="bg-zinc-900/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">战斗日志</CardTitle>
              </CardHeader>
              <CardContent className="max-h-40 overflow-y-auto space-y-2">
                {[...(battle.actions || [])].reverse().map((action, index) => {
                  // 找到相关棋子的名称
                  let pieceName = "未知棋子";
                  if (action.payload?.pieceId) {
                    const piece = battle.pieces.find(p => p.instanceId === action.payload.pieceId);
                    if (piece) {
                      // 尝试获取棋子模板名称
                      const pieceTemplate = getPieceById(piece.templateId);
                      pieceName = pieceTemplate?.name || piece.templateId || "未知棋子";
                    }
                  }
                  
                  // 格式化消息
                  let formattedMessage = action.payload?.message || action.type || "未知操作";
                  
                  // 替换消息中的templateId为更友好的名称
                  if (action.payload?.pieceId) {
                    const piece = battle.pieces.find(p => p.instanceId === action.payload.pieceId);
                    if (piece) {
                      const pieceTemplate = getPieceById(piece.templateId);
                      const friendlyName = pieceTemplate?.name || piece.templateId;
                      formattedMessage = formattedMessage.replace(piece.templateId, friendlyName);
                    }
                  }
                  
                  return (
                    <div key={index} className="text-xs text-zinc-300">
                      <span className="text-zinc-500">[{action.turn || battle.turn.turnNumber}] </span>
                      <span className={action.playerId === currentPlayerId ? "text-green-400" : "text-blue-400"}>
                        {/* 使用友好的棋子名称 */}
                        {pieceName}
                      </span>
                      <span className="text-zinc-400">: </span>
                      <span>{formattedMessage}</span>
                    </div>
                  );
                })}
                {(battle.actions || []).length === 0 && (
                  <div className="text-xs text-zinc-500">
                    战斗日志为空
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 显示所有棋子，包括存活的和死亡的（从墓地中获取） */}
            {battle && (battle.pieces.filter(p => p.ownerPlayerId === currentPlayerId).length + (battle.graveyard?.filter(p => p.ownerPlayerId === currentPlayerId).length || 0)) > 0 && (
              <Card className="bg-zinc-900/50">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">我的棋子</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* 筛选出当前玩家的所有存活棋子，克隆紧挨本体，顺序稳定随机 */}
                  {(() => {
                    const myPieces = battle.pieces.filter(p => p.ownerPlayerId === currentPlayerId && p.currentHp > 0)
                    const clones = myPieces.filter(p => (p as any).masterPieceId)
                    const nonClones = myPieces.filter(p => !(p as any).masterPieceId)
                    const ordered: typeof myPieces = []
                    for (const master of nonClones) {
                      const myClones = clones.filter(c => (c as any).masterPieceId === master.instanceId)
                      if (myClones.length === 0) {
                        ordered.push(master)
                      } else {
                        // 用第一个克隆的 instanceId 末位数字决定克隆组在本体前还是后
                        const cloneFirst = parseInt(myClones[0].instanceId.slice(-1)) % 2 === 0
                        if (cloneFirst) { ordered.push(...myClones); ordered.push(master) }
                        else { ordered.push(master); ordered.push(...myClones) }
                      }
                    }
                    // 找不到本体的孤儿克隆（理论上不会出现）追加到末尾
                    clones.filter(c => !nonClones.some(p => p.instanceId === (c as any).masterPieceId)).forEach(c => ordered.push(c))
                    return ordered
                  })().map((piece) => (
                      <div 
                        key={piece.instanceId} 
                        className={`group relative flex items-center gap-4 cursor-pointer rounded-md p-2 transition-colors ${
                          selectedPieceId === piece.instanceId 
                            ? 'bg-zinc-800/80 border-l-4 border-green-500' 
                            : piece.currentHp <= 0 
                              ? 'bg-zinc-900/50 opacity-70' 
                              : 'hover:bg-zinc-800/50'
                        }`}
                        onClick={() => setSelectedPieceId(piece.instanceId)}
                      >
                        {(() => {
                          const pieceTemplate = getPieceById(piece.templateId)
                          const image = pieceTemplate?.image
                          // 为死亡的棋子添加灰色效果
                          const isDead = piece.currentHp <= 0;
                          const deadClass = isDead ? "opacity-50 grayscale" : "";
                          
                          return (
                            <div className={`flex h-12 w-12 items-center justify-center rounded-lg ${piece.faction === "red" ? "bg-red-600" : "bg-blue-600"} ${deadClass}`}>
                              {image && image.startsWith("http") ? (
                                <img 
                                  src={image} 
                                  alt={pieceTemplate?.name || "Piece"} 
                                  className="h-full w-full object-contain"
                                />
                              ) : image && (image.length <= 3 || image.includes("️")) ? (
                                <span className="text-3xl font-bold text-white">{image}</span>
                              ) : image ? (
                                <img 
                                  src={`/${image}`} 
                                  alt={pieceTemplate?.name || "Piece"} 
                                  className="h-full w-full object-contain"
                                />
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
                              {/* 为死亡的棋子添加阵亡标记 */}
                              {piece.currentHp <= 0 && (
                                <span className="ml-2 text-xs font-bold text-red-500">[阵亡]</span>
                              )}
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
                              HP: {(piece as any).displayCurrentHp ?? piece.currentHp}/{(piece as any).displayMaxHp ?? piece.maxHp}
                            </span>
                            <span className="flex items-center gap-1">
                              <Swords className="h-3 w-3" />
                              攻击: {(piece as any).displayAttack ?? piece.attack}
                            </span>
                            <span className="flex items-center gap-1">
                              <Footprints className="h-3 w-3" />
                              移动: {(piece as any).displayMoveRange ?? piece.moveRange}
                            </span>
                          </div>
                          <div className="flex items-center gap-4 text-xs text-zinc-400">
                            <span className="flex items-center gap-1">
                              <Footprints className="h-3 w-3" />
                              位置: ({piece.x}, {piece.y})
                            </span>
                            <span className="flex items-center gap-1">
                              <Shield className="h-3 w-3" />
                              防御: {(piece as any).displayDefense ?? piece.defense ?? 0}
                            </span>
                          </div>
                          {/* 状态标签显示 */}
                          {(() => {
                            const masterPiece = (piece as any).masterPieceId
                              ? [...battle.pieces, ...(battle.graveyard || [])].find((p: any) => p.instanceId === (piece as any).masterPieceId)
                              : null
                            const displayTags = masterPiece?.statusTags ?? piece.statusTags
                            return displayTags && displayTags.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-2">
                                {displayTags.filter((tag: any) => tag.visible !== false).map((tag: any, index: number) => (
                                  <span key={index} className="px-2 py-0.5 rounded-full text-xs bg-zinc-800 text-zinc-300">
                                    {tag.name || tag.type || tag.id}
                                    {(tag.remainingDuration !== undefined || tag.remainingUses !== undefined) && (
                                      <span className="text-zinc-400">
                                        （持续时间：{tag.remainingDuration ?? '-'}，剩余次数：{tag.remainingUses ?? '-'}）
                                      </span>
                                    )}
                                    {tag.stacks && tag.stacks > 1 && ` x${tag.stacks}`}
                                  </span>
                                ))}
                              </div>
                            )
                          })()}
                        </div>

                        {/* 技能信息悬停显示 */}
                        <div className="absolute right-0 top-0 -translate-y-full mr-2 mb-2 w-64 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-10">
                          {(() => {
                            const pieceTemplate = getPieceById(piece.templateId)
                            if (!pieceTemplate) return null

                            const masterPiece = (piece as any).masterPieceId
                              ? [...battle.pieces, ...(battle.graveyard || [])].find((p: any) => p.instanceId === (piece as any).masterPieceId)
                              : null
                            const displaySkills: any[] = masterPiece?.skills ?? piece.skills

                            const { calculateSkillPreview } = require('@/lib/game/skills')
                            const currentSkillIds = new Set(displaySkills.map((s: any) => s.skillId))
                            const templateTransformedSkills: any[] = (pieceTemplate as any).transformedSkills || []
                            const pendingTransformSkills = templateTransformedSkills.filter((ts: any) => !currentSkillIds.has(ts.skillId))

                            if (displaySkills.length === 0 && pendingTransformSkills.length === 0) return null

                            const renderSkillRow = (skillId: string) => {
                              const skillDef = battle.skillsById[skillId]
                              if (!skillDef) return null
                              const pieceSkillState = displaySkills.find((s: any) => s.skillId === skillId)
                              const currentCooldown = pieceSkillState?.currentCooldown || 0
                              const skillPreview = calculateSkillPreview(skillDef, masterPiece ?? piece, currentCooldown)
                              return (
                                <div key={skillId} className="space-y-1">
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="font-medium text-zinc-200">{skillDef.name || skillId}</span>
                                    <span className={`text-xs ${
                                      skillDef.type === "super" ? "text-yellow-400" :
                                      skillDef.type === "ultimate" ? "text-purple-400" : "text-green-400"
                                    }`}>
                                      {skillDef.type === "super" ? "充能" :
                                       skillDef.type === "ultimate" ? "终极" : "普通"}
                                      {pieceSkillState?.usesRemaining === 1 && ' (限定技)'}
                                    </span>
                                  </div>
                                  <p className="text-xs text-zinc-400">{skillPreview.description || "无描述"}</p>
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="text-zinc-500">冷却:</span>
                                    <span className={`text-xs ${currentCooldown > 0 ? "text-red-400" : "text-green-400"}`}>
                                      {skillDef.cooldownTurns > 0 ? `${skillDef.cooldownTurns}/${currentCooldown} 回合` : `${currentCooldown} 回合`}
                                    </span>
                                  </div>
                                  {skillDef.type === "super" && skillPreview.chargeCost && (
                                    <div className="flex items-center justify-between text-xs">
                                      <span className="text-zinc-500">充能点数:</span>
                                      <span className="text-yellow-400">{skillPreview.chargeCost} 点</span>
                                    </div>
                                  )}
                                  {skillDef.actionPointCost && (
                                    <div className="flex items-center justify-between text-xs">
                                      <span className="text-zinc-500">行动点数:</span>
                                      <span className="text-blue-400">{skillDef.actionPointCost} 点</span>
                                    </div>
                                  )}
                                </div>
                              )
                            }

                            return (
                              <div className="rounded-lg border border-border bg-zinc-800 p-3 shadow-lg">
                                <div className="mb-2 text-xs font-medium text-zinc-200">技能</div>
                                <div className="space-y-2">
                                  {displaySkills.map((s: any) => renderSkillRow(s.skillId))}
                                </div>
                                {pendingTransformSkills.length > 0 && (
                                  <>
                                    <div className="mt-2 mb-1 text-xs font-medium text-purple-400">🔮 变身后获得</div>
                                    <div className="space-y-2">
                                      {pendingTransformSkills.map((ts: any) => renderSkillRow(ts.skillId))}
                                    </div>
                                  </>
                                )}
                              </div>
                            )
                          })()}
                        </div>
                      </div>
                    ))}
                  {/* 筛选出当前玩家的所有死亡棋子（从墓地中获取） */}
                  {battle.graveyard?.filter(p => p.ownerPlayerId === currentPlayerId).map((piece) => (
                      <div 
                        key={piece.instanceId} 
                        className={`group relative flex items-center gap-4 cursor-pointer rounded-md p-2 transition-colors ${'bg-zinc-900/50 opacity-70'}`}
                      >
                        {(() => {
                          const pieceTemplate = getPieceById(piece.templateId)
                          const image = pieceTemplate?.image
                          // 为死亡的棋子添加灰色效果
                          const isDead = true;
                          const deadClass = isDead ? "opacity-50 grayscale" : "";
                          
                          return (
                            <div className={`flex h-12 w-12 items-center justify-center rounded-lg ${piece.faction === "red" ? "bg-red-600" : "bg-blue-600"} ${deadClass}`}>
                              {image && image.startsWith("http") ? (
                                <img 
                                  src={image} 
                                  alt={pieceTemplate?.name || "Piece"} 
                                  className="h-full w-full object-contain"
                                />
                              ) : image && (image.length <= 3 || image.includes("️")) ? (
                                <span className="text-3xl font-bold text-white">{image}</span>
                              ) : image ? (
                                <img 
                                  src={`/${image}`} 
                                  alt={pieceTemplate?.name || "Piece"} 
                                  className="h-full w-full object-contain"
                                />
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
                              {/* 为死亡的棋子添加阵亡标记 */}
                              <span className="ml-2 text-xs font-bold text-red-500">[阵亡]</span>
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
                              HP: 0/{piece.maxHp}
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
                          {(() => {
                            const masterPiece = (piece as any).masterPieceId
                              ? [...battle.pieces, ...(battle.graveyard || [])].find((p: any) => p.instanceId === (piece as any).masterPieceId)
                              : null
                            const displayTags = masterPiece?.statusTags ?? piece.statusTags
                            return displayTags && displayTags.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-2">
                                {displayTags.filter((tag: any) => tag.visible !== false).map((tag: any, index: number) => (
                                  <span key={index} className="px-2 py-0.5 rounded-full text-xs bg-zinc-800 text-zinc-300">
                                    {tag.name || tag.type || tag.id}
                                    {(tag.remainingDuration !== undefined || tag.remainingUses !== undefined) && (
                                      <span className="text-zinc-400">
                                        （持续时间：{tag.remainingDuration ?? '-'}，剩余次数：{tag.remainingUses ?? '-'}）
                                      </span>
                                    )}
                                    {tag.stacks && tag.stacks > 1 && ` x${tag.stacks}`}
                                  </span>
                                ))}
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
              // 显示所有对方棋子，包括存活的和死亡的（从墓地中获取）
              const opponentAlivePieces = battle.pieces.filter(p => 
                p.ownerPlayerId !== currentPlayerId && p.currentHp > 0
              )
              const opponentDeadPieces = battle.graveyard?.filter(p => 
                p.ownerPlayerId !== currentPlayerId
              ) || []
              const totalOpponentPieces = opponentAlivePieces.length + opponentDeadPieces.length
              return totalOpponentPieces > 0 ? (
                <Card className="bg-zinc-900/50">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">对方棋子</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {opponentAlivePieces.map((piece) => (
                      <div 
                        key={piece.instanceId} 
                        className={`group relative flex items-center gap-4 rounded-md p-2 transition-colors ${
                          piece.currentHp <= 0 
                            ? 'bg-zinc-900/50 opacity-70' 
                            : 'hover:bg-zinc-800/30'
                        }`}
                      >
                        {(() => {
                          const pieceTemplate = getPieceById(piece.templateId)
                          const image = pieceTemplate?.image
                          // 为死亡的棋子添加灰色效果
                          const isDead = piece.currentHp <= 0;
                          const deadClass = isDead ? "opacity-50 grayscale" : "";
                          
                          return (
                            <div className={`flex h-12 w-12 items-center justify-center rounded-lg ${piece.faction === "red" ? "bg-red-600" : "bg-blue-600"} ${deadClass}`}>
                              {image && image.startsWith("http") ? (
                                <img 
                                  src={image} 
                                  alt={pieceTemplate?.name || "Piece"} 
                                  className="h-full w-full object-contain"
                                />
                              ) : image && (image.length <= 3 || image.includes("️")) ? (
                                <span className="text-3xl font-bold text-white">{image}</span>
                              ) : image ? (
                                <img 
                                  src={`/${image}`} 
                                  alt={pieceTemplate?.name || "Piece"} 
                                  className="h-full w-full object-contain"
                                />
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
                              {/* 为死亡的棋子添加阵亡标记 */}
                              {piece.currentHp <= 0 && (
                                <span className="ml-2 text-xs font-bold text-red-500">[阵亡]</span>
                              )}
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
                              HP: {(piece as any).displayCurrentHp ?? piece.currentHp}/{(piece as any).displayMaxHp ?? piece.maxHp}
                            </span>
                            <span className="flex items-center gap-1">
                              <Swords className="h-3 w-3" />
                              攻击: {(piece as any).displayAttack ?? piece.attack}
                            </span>
                            <span className="flex items-center gap-1">
                              <Footprints className="h-3 w-3" />
                              移动: {(piece as any).displayMoveRange ?? piece.moveRange}
                            </span>
                          </div>
                          <div className="flex items-center gap-4 text-xs text-zinc-400">
                            <span className="flex items-center gap-1">
                              <Footprints className="h-3 w-3" />
                              位置: ({piece.x}, {piece.y})
                            </span>
                            <span className="flex items-center gap-1">
                              <Shield className="h-3 w-3" />
                              防御: {(piece as any).displayDefense ?? piece.defense ?? 0}
                            </span>
                          </div>
                          {/* 状态标签显示 */}
                          {(() => {
                            const masterPiece = (piece as any).masterPieceId
                              ? [...battle.pieces, ...(battle.graveyard || [])].find((p: any) => p.instanceId === (piece as any).masterPieceId)
                              : null
                            const displayTags = masterPiece?.statusTags ?? piece.statusTags
                            return displayTags && displayTags.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-2">
                                {displayTags.filter((tag: any) => tag.visible !== false).map((tag: any, index: number) => (
                                  <span key={index} className="px-2 py-0.5 rounded-full text-xs bg-zinc-800 text-zinc-300">
                                    {tag.name || tag.type || tag.id}
                                    {(tag.remainingDuration !== undefined || tag.remainingUses !== undefined) && (
                                      <span className="text-zinc-400">
                                        （持续时间：{tag.remainingDuration ?? '-'}，剩余次数：{tag.remainingUses ?? '-'}）
                                      </span>
                                    )}
                                    {tag.stacks && tag.stacks > 1 && ` x${tag.stacks}`}
                                  </span>
                                ))}
                              </div>
                            )
                          })()}
                        </div>

                        {/* 技能信息悬停显示 */}
                        <div className="absolute right-0 top-0 -translate-y-full mr-2 mb-2 w-64 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-10">
                          {(() => {
                            const pieceTemplate = getPieceById(piece.templateId)
                            if (!pieceTemplate) return null

                            const masterPiece = (piece as any).masterPieceId
                              ? [...battle.pieces, ...(battle.graveyard || [])].find((p: any) => p.instanceId === (piece as any).masterPieceId)
                              : null
                            const displaySkills: any[] = masterPiece?.skills ?? piece.skills

                            const { calculateSkillPreview } = require('@/lib/game/skills')
                            const currentSkillIds = new Set(displaySkills.map((s: any) => s.skillId))
                            const templateTransformedSkills: any[] = (pieceTemplate as any).transformedSkills || []
                            const pendingTransformSkills = templateTransformedSkills.filter((ts: any) => !currentSkillIds.has(ts.skillId))

                            if (displaySkills.length === 0 && pendingTransformSkills.length === 0) return null

                            const renderSkillRow = (skillId: string) => {
                              const skillDef = battle.skillsById[skillId]
                              if (!skillDef) return null
                              const pieceSkillState = displaySkills.find((s: any) => s.skillId === skillId)
                              const currentCooldown = pieceSkillState?.currentCooldown || 0
                              const skillPreview = calculateSkillPreview(skillDef, masterPiece ?? piece, currentCooldown)
                              return (
                                <div key={skillId} className="space-y-1">
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="font-medium text-zinc-200">{skillDef.name || skillId}</span>
                                    <span className={`text-xs ${
                                      skillDef.type === "super" ? "text-yellow-400" :
                                      skillDef.type === "ultimate" ? "text-purple-400" : "text-green-400"
                                    }`}>
                                      {skillDef.type === "super" ? "充能" :
                                       skillDef.type === "ultimate" ? "终极" : "普通"}
                                      {pieceSkillState?.usesRemaining === 1 && ' (限定技)'}
                                    </span>
                                  </div>
                                  <p className="text-xs text-zinc-400">{skillPreview.description || "无描述"}</p>
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="text-zinc-500">冷却:</span>
                                    <span className={`text-xs ${currentCooldown > 0 ? "text-red-400" : "text-green-400"}`}>
                                      {skillDef.cooldownTurns > 0 ? `${skillDef.cooldownTurns}/${currentCooldown} 回合` : `${currentCooldown} 回合`}
                                    </span>
                                  </div>
                                  {skillDef.type === "super" && skillPreview.chargeCost && (
                                    <div className="flex items-center justify-between text-xs">
                                      <span className="text-zinc-500">充能点数:</span>
                                      <span className="text-yellow-400">{skillPreview.chargeCost} 点</span>
                                    </div>
                                  )}
                                  {skillDef.actionPointCost && (
                                    <div className="flex items-center justify-between text-xs">
                                      <span className="text-zinc-500">行动点数:</span>
                                      <span className="text-blue-400">{skillDef.actionPointCost} 点</span>
                                    </div>
                                  )}
                                </div>
                              )
                            }

                            return (
                              <div className="rounded-lg border border-border bg-zinc-800 p-3 shadow-lg">
                                <div className="mb-2 text-xs font-medium text-zinc-200">技能</div>
                                <div className="space-y-2">
                                  {displaySkills.map((s: any) => renderSkillRow(s.skillId))}
                                </div>
                                {pendingTransformSkills.length > 0 && (
                                  <>
                                    <div className="mt-2 mb-1 text-xs font-medium text-purple-400">🔮 变身后获得</div>
                                    <div className="space-y-2">
                                      {pendingTransformSkills.map((ts: any) => renderSkillRow(ts.skillId))}
                                    </div>
                                  </>
                                )}
                              </div>
                            )
                          })()}
                        </div>
                      </div>
                    ))}
                    {/* 筛选出对方玩家的所有死亡棋子（从墓地中获取） */}
                    {opponentDeadPieces.map((piece) => (
                      <div 
                        key={piece.instanceId} 
                        className={`group relative flex items-center gap-4 rounded-md p-2 transition-colors ${'bg-zinc-900/50 opacity-70'}`}
                      >
                        {(() => {
                          const pieceTemplate = getPieceById(piece.templateId)
                          const image = pieceTemplate?.image
                          // 为死亡的棋子添加灰色效果
                          const isDead = true;
                          const deadClass = isDead ? "opacity-50 grayscale" : "";
                          
                          return (
                            <div className={`flex h-12 w-12 items-center justify-center rounded-lg ${piece.faction === "red" ? "bg-red-600" : "bg-blue-600"} ${deadClass}`}>
                              {image && image.startsWith("http") ? (
                                <img 
                                  src={image} 
                                  alt={pieceTemplate?.name || "Piece"} 
                                  className="h-full w-full object-contain"
                                />
                              ) : image && (image.length <= 3 || image.includes("️")) ? (
                                <span className="text-3xl font-bold text-white">{image}</span>
                              ) : image ? (
                                <img 
                                  src={`/${image}`} 
                                  alt={pieceTemplate?.name || "Piece"} 
                                  className="h-full w-full object-contain"
                                />
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
                              {/* 为死亡的棋子添加阵亡标记 */}
                              <span className="ml-2 text-xs font-bold text-red-500">[阵亡]</span>
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
                              HP: 0/{piece.maxHp}
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
                          {(() => {
                            const masterPiece = (piece as any).masterPieceId
                              ? [...battle.pieces, ...(battle.graveyard || [])].find((p: any) => p.instanceId === (piece as any).masterPieceId)
                              : null
                            const displayTags = masterPiece?.statusTags ?? piece.statusTags
                            return displayTags && displayTags.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-2">
                                {displayTags.filter((tag: any) => tag.visible !== false).map((tag: any, index: number) => (
                                  <span key={index} className="px-2 py-0.5 rounded-full text-xs bg-zinc-800 text-zinc-300">
                                    {tag.name || tag.type || tag.id}
                                    {(tag.remainingDuration !== undefined || tag.remainingUses !== undefined) && (
                                      <span className="text-zinc-400">
                                        （持续时间：{tag.remainingDuration ?? '-'}，剩余次数：{tag.remainingUses ?? '-'}）
                                      </span>
                                    )}
                                    {tag.stacks && tag.stacks > 1 && ` x${tag.stacks}`}
                                  </span>
                                ))}
                              </div>
                            )
                          })()}
                        </div>
                      </div>
                    ))}
                    <div className="text-xs text-zinc-400 border-t border-zinc-800 pt-2">
                      <span className="flex items-center gap-1">
                        <Swords className="h-3 w-3" />
                        剩余棋子: {opponentAlivePieces.length}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ) : null
            })()}

            {/* 墓地 */}
            {battle.graveyard && battle.graveyard.length > 0 && (
              <Card className="bg-zinc-900/50">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">墓地</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {battle.graveyard.map((piece, index) => {
                    const pieceTemplate = getPieceById(piece.templateId)
                    const image = pieceTemplate?.image
                    return (
                      <div 
                        key={`graveyard-${piece.instanceId}-${index}`}
                        className="group relative flex items-center gap-4 cursor-pointer rounded-md p-2 transition-colors bg-zinc-900/50 opacity-70"
                      >
                        <div className={`flex h-12 w-12 items-center justify-center rounded-lg ${piece.faction === "red" ? "bg-red-600" : "bg-blue-600"} opacity-50 grayscale`}>
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
                        <div className="flex-1 space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-zinc-200">
                              {pieceTemplate?.name || piece.templateId}
                              <span className="ml-2 text-xs font-bold text-red-500">[阵亡]</span>
                            </span>
                            <span className={`text-sm ${piece.faction === "red" ? "text-red-400" : "text-blue-400"}`}>
                              {piece.faction === "red" ? "红方" : "蓝方"}
                            </span>
                          </div>
                          <div className="flex items-center gap-4 text-xs text-zinc-400">
                            <span className="flex items-center gap-1">
                              <Shield className="h-3 w-3" />
                              HP: 0/{piece.maxHp}
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
                        </div>
                      </div>
                    )
                  })}
                </CardContent>
              </Card>
            )}
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

                {/* 当前回合玩家显示 */}
                <div className="rounded-md bg-zinc-800 p-3">
                  <div className="mb-2 text-xs text-zinc-400">当前回合</div>
                  {(() => {
                    const currentPlayer = battle.players.find(p => p.playerId === battle.turn.currentPlayerId)
                    const isCurrentPlayer = currentPlayer?.playerId === currentPlayerId
                    const playerName = room?.players.find(p => p.id === currentPlayer?.playerId)?.name || currentPlayer?.playerId || "未知"
                    const playerPiece = battle.pieces.find(p => p.ownerPlayerId === currentPlayer?.playerId)
                    const isRed = playerPiece?.faction === "red"
                    return (
                      <div className={`flex items-center justify-between p-2 rounded ${
                        isRed ? "bg-red-950/30 border border-red-900/50" : "bg-blue-950/30 border border-blue-900/50"
                      }`}>
                        <div className="flex items-center gap-2">
                          <div className={`h-2 w-2 rounded-full animate-pulse ${
                            isRed ? "bg-red-500" : "bg-blue-500"
                          }`} />
                          <span className={`text-sm font-medium ${
                            isRed ? "text-red-400" : "text-blue-400"
                          }`}>
                            {isRed ? "红方" : "蓝方"}
                          </span>
                          <span className="text-sm text-zinc-200">
                            {playerName}
                            {isCurrentPlayer && " (你)"}
                          </span>
                        </div>
                        <span className="text-xs px-2 py-0.5 rounded bg-green-600/80 text-white">
                          行动中
                        </span>
                      </div>
                    )
                  })()}
                </div>

                {/* 选项选择器覆盖层 - 优先级最高，独立显示 */}
                {isSelectingOption && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-zinc-200 text-center">{optionSelectionTitle}</p>
                    {optionSelectionOptions.map((opt, index) => (
                      <Button
                        key={index}
                        className="w-full justify-start h-auto whitespace-normal py-2 text-left"
                        variant="outline"
                        size="sm"
                        disabled={loading}
                        onClick={() => void handleOptionSelect(opt.value)}
                      >
                        <span className="font-medium break-words">{opt.label}</span>
                        {opt.description && (
                          <span className="ml-2 text-xs text-zinc-400 break-words">{opt.description}</span>
                        )}
                      </Button>
                    ))}
                    <Button
                      className="w-full"
                      variant="ghost"
                      size="sm"
                      disabled={loading}
                      onClick={() => void handleOptionSelect(null)}
                    >
                      取消释放
                    </Button>
                  </div>
                )}

                {battle.turn.phase === "action" && isMyTurn && !isSelectingOption && (
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
                    ) : isSelectingSkillTarget ? (
                      <>
                        <p className="text-xs text-muted-foreground text-center">
                          {targetSelectionType === 'grid' ? '请点击棋盘上的格子选择技能目标' : '请点击棋盘上的敌人棋子选择技能目标'}
                        </p>
                        <Button
                          className="w-full"
                          size="sm"
                          variant="outline"
                          disabled={loading}
                          onClick={() => {
                            setIsSelectingSkillTarget(false)
                            setSelectedSkillId(null)
                          }}
                        >
                          取消技能
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
                          const pieceSkills = selectedPiece.skills || pieceTemplate?.skills || []

                          const allMappedSkills = pieceSkills.map(skill => {
                            const skillDef = battle.skillsById[skill.skillId]
                            return {
                              id: skill.skillId,
                              name: skill.skillId,
                              type: "normal",
                              ...skill,
                              ...skillDef
                            }
                          })

                          const passiveSkills = allMappedSkills.filter(skill => skill && skill.kind === "passive")
                          const availableSkills = allMappedSkills.filter(skill => skill && skill.kind !== "passive")

                          return (<>
                          {passiveSkills.length > 0 && (
                            <div className="flex flex-wrap gap-1 mb-1">
                              {passiveSkills.map((skill: any) => (
                                <span key={skill.id} title={skill.description || ''} className="inline-flex items-center gap-1 rounded bg-zinc-700/60 border border-zinc-600 px-2 py-0.5 text-[11px] text-zinc-300">
                                  {skill.icon && <span>{skill.icon}</span>}
                                  {skill.name}
                                  <span className="text-zinc-500">被动</span>
                                </span>
                              ))}
                            </div>
                          )}
                          {availableSkills.map(skill => {
                            const skillType = skill.type
                            const skillId = skill.id
                            const skillName = skill.name
                            const chargeCost = skill.chargeCost
                            const actionPointCost = skill.actionPointCost
                            const isSuper = skillType === "super"
                            const actionType = isSuper ? "useChargeSkill" : "useBasicSkill"
                            const pieceSkillState = selectedPiece.skills?.find((s: any) => s.skillId === skillId)
                            const currentCooldown = pieceSkillState?.currentCooldown || 0
                            const skillCooldown = skill.cooldownTurns || 0
                            const cooldownDisplay = skillCooldown > 0 ? `${skillCooldown}/${currentCooldown}` : ''

                            return (
                              <Button
                                key={skillId}
                                className="w-full"
                                variant="outline"
                                size="sm"
                                disabled={loading || isSelectingMoveTarget || currentCooldown > 0}
                                onClick={() => {
                                  if (selectedPiece) {
                                    sendBattleAction({
                                      type: actionType,
                                      playerId: currentPlayerId!,
                                      pieceId: selectedPiece.instanceId,
                                      skillId: skillId,
                                    })
                                  }
                                }}
                              >
                                <Zap className="mr-2 h-4 w-4" />
                                {skillName} ({isSuper ? `充能 ${chargeCost || 0}点` : "普通"}) - {actionPointCost || 0}AP{cooldownDisplay ? ` (${cooldownDisplay})` : ''}
                              </Button>
                            )
                          })}
                          </>)
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
                  const isCurrentPlayer = player.playerId === currentPlayerId
                  const playerPiece = battle.pieces.find(p => p.ownerPlayerId === player.playerId)
                  // 从 room.players 中获取玩家的昵称
                  const playerName = room?.players.find(p => p.id === player.playerId)?.name || player.playerId
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
                          {playerName} {isCurrentPlayer && "(你)"}
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
                        <span className="flex items-center gap-1 text-blue-400">
                          <Footprints className="h-3 w-3" />
                          {player.actionPoints}/{player.maxActionPoints}
                        </span>
                      </div>
                      {/* 玩家状态标签 */}
                      {player.statusTags && player.statusTags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {player.statusTags.map((tag, index) => (
                            <span
                              key={tag.id || index}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-purple-600/60 text-white"
                              title={tag.name}
                            >
                              {tag.name}
                              {tag.remainingDuration > 0 && `(${tag.remainingDuration})`}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </CardContent>
            </Card>

            {/* 手牌区 */}
            <HandArea 
              battle={battle} 
              currentPlayerId={currentPlayerId} 
              isMyTurn={isMyTurn}
              sendBattleAction={sendBattleAction}
            />

            <Card className="bg-zinc-900/50">
              <CardContent className="p-4">
                <Button
                  className="w-full bg-red-900/50 hover:bg-red-800 text-red-300 border-red-800"
                  size="sm"
                  onClick={() => {
                    if (currentPlayerId) {
                      try {
                        sendBattleAction({
                          type: "surrender",
                          playerId: currentPlayerId
                        })
                      } catch (error) {
                        console.error("投降失败：", error)
                      }
                    }
                  }}
                >
                  投降
                </Button>
                <p className="mt-2 text-xs text-zinc-500 text-center">
                  投降将导致你输掉当前游戏，并且游戏会自动结束
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </main>
  )
}

// 卡牌定义类型
interface CardDefinition {
  id: string
  name: string
  description: string
  type: "active" | "reactive"
  icon?: string
}

// 手牌区组件
function HandArea({ 
  battle, 
  currentPlayerId, 
  isMyTurn,
  sendBattleAction 
}: { 
  battle: BattleState
  currentPlayerId: string | null
  isMyTurn: boolean
  sendBattleAction: (action: BattleAction) => void
}) {
  const [cardCache, setCardCache] = useState<Map<string, CardDefinition>>(new Map())
  
  const myMeta = battle.players.find(p => p.playerId === currentPlayerId)
  const hand = myMeta?.hand ?? []
  const canPlay = isMyTurn && battle.turn.phase === "action"
  
  // 加载卡牌定义
  useEffect(() => {
    async function loadCardDefinitions() {
      const newCache = new Map(cardCache)
      const cardIds = hand.map(card => card.cardId)
      const uniqueCardIds = [...new Set(cardIds)].filter(id => !newCache.has(id))
      
      if (uniqueCardIds.length === 0) return
      
      for (const cardId of uniqueCardIds) {
        try {
          const response = await fetch(`/api/cards/${cardId}`)
          if (response.ok) {
            const cardDef: CardDefinition = await response.json()
            newCache.set(cardId, cardDef)
          }
        } catch {
          // 忽略加载错误
        }
      }
      
      setCardCache(newCache)
    }
    
    loadCardDefinitions()
  }, [hand])
  
  return (
    <Card className="bg-zinc-900/50">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">手牌 ({hand.length}/10)</CardTitle>
      </CardHeader>
      <CardContent>
        {hand.length === 0 ? (
          <div className="text-xs text-zinc-500 italic">
            {canPlay ? "暂无手牌" : "等待回合开始..."}
          </div>
        ) : (
          <TooltipProvider>
            <div className="flex flex-wrap gap-2">
              {hand.map((card) => {
                const cardDef = cardCache.get(card.cardId)
                const displayDef = cardDef ?? (card.description ? (card as any) : null)
                const apCost = (card as any).actionPointCost ?? displayDef?.actionPointCost
                const apHigh = apCost !== undefined && apCost >= 10
                return (
                  <Tooltip key={card.instanceId}>
                    <TooltipTrigger asChild>
                      <button
                        disabled={!canPlay}
                        onClick={() => currentPlayerId && sendBattleAction({ type: "playCard", playerId: currentPlayerId, cardInstanceId: card.instanceId })}
                        className="flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 transition-colors hover:border-yellow-600 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {apCost !== undefined && (
                          <span className={`font-bold ${apHigh ? "text-red-400" : "text-yellow-400"}`}>{apCost}</span>
                        )}
                        <span>{card.name || card.cardId}</span>
                      </button>
                    </TooltipTrigger>
                    {displayDef && (
                      <TooltipContent
                        side="top"
                        className="max-w-xs bg-zinc-800 border-zinc-700 text-zinc-100"
                      >
                        <div className="space-y-1">
                          <div className="font-semibold text-yellow-400">{displayDef.name}</div>
                          <div className="text-xs text-zinc-400">
                            消耗: {apCost ?? displayDef.actionPointCost ?? "?"}AP &nbsp;|&nbsp; {displayDef.type === "active" ? "主动" : "被动"}
                          </div>
                          <div className="text-xs text-zinc-300 leading-relaxed">
                            {displayDef.description}
                          </div>
                        </div>
                      </TooltipContent>
                    )}
                  </Tooltip>
                )
              })}
            </div>
          </TooltipProvider>
        )}
      </CardContent>
    </Card>
  )
}
