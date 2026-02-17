"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { ArrowLeft, Loader2, UserPlus, LogIn } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { GameBoard } from "@/components/game-board"
import type { BattleState, BattleAction } from "@/lib/game/turn"

type Room = {
  id: string
  name: string
  status: "waiting" | "in-progress" | "finished"
  players: { id: string; name: string }[]
  currentTurnIndex: number
}

type User = {
  id: string
  username: string
  password: string
  createdAt: string
}

export default function PlayPage() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [user, setUser] = useState<User | null>(null)
  const [roomId, setRoomId] = useState<string | null>(null)
  const [room, setRoom] = useState<Room | null>(null)
  const [battle, setBattle] = useState<BattleState | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 检查用户登录状态
  useEffect(() => {
    const storedUser = localStorage.getItem('user')
    if (storedUser) {
      try {
        setUser(JSON.parse(storedUser))
      } catch (error) {
        console.error('解析用户信息失败:', error)
        localStorage.removeItem('user')
        setUser(null)
      }
    }
  }, [])

  // 如果 URL 上已经有 roomId（例如分享链接），进入页面时自动加载
  useEffect(() => {
    const id = searchParams.get("roomId")
    if (id && !roomId) {
      setRoomId(id)
      void fetchRoom(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, roomId])

  async function fetchRoom(id: string) {
    try {
      setLoading(true)
      setError(null)
      const res = await fetch(`/api/rooms/${id}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        // 不再显示错误信息，而是等待用户登录并加入房间
        setError(null)
        return
      }
      const data = (await res.json()) as Room
      setRoom(data)
      if (data.status === "in-progress") {
        void fetchBattle(id)
      } else {
        setBattle(null)
      }
    } catch (err) {
      // 捕获错误但不显示，避免不必要的 "Room not found" 提示
      setError(null)
    } finally {
      setLoading(false)
    }
  }

  async function handleCreateRoom() {
    if (!user) {
      setError("请先登录")
      return
    }
    try {
      setLoading(true)
      setError(null)

      // 1. 创建房间
      const res = await fetch("/api/lobby", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `${user.username} 的 1v1 房间` }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Failed to create room")
      }

      const created = (await res.json()) as Room
      setRoomId(created.id)
      setRoom(created)

      // 更新 URL，方便分享
      router.replace(`/play?roomId=${created.id}`)

      // 2. 让自己加入房间
      await joinRoom(created.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }

  async function joinRoom(id: string) {
    if (!user) {
      throw new Error("请先登录")
    }
    const res = await fetch(`/api/rooms/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "join", playerName: user.username, playerId: user.id }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || "Failed to join room")
    }
    const updated = (await res.json()) as Room
    setRoom(updated)
  }

  async function handleJoinExisting() {
    if (!user) {
      setError("请先登录")
      return
    }
    if (!roomId) {
      setError("请先输入或获取房间 ID")
      return
    }
    try {
      setLoading(true)
      setError(null)
      await joinRoom(roomId)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }

  async function handleStartGame() {
    if (!roomId || !user) return
    try {
      setLoading(true)
      setError(null)
      // 重定向到棋子选择页面，而不是直接开始游戏
      router.replace(`/piece-selection?roomId=${roomId}&playerName=${encodeURIComponent(user.username)}&playerId=${encodeURIComponent(user.id)}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }

  async function handleMakeMove() {
    if (!roomId || !battle || !user) return
    const me = user.id
    const myPiece = battle.pieces.find((p) => p.ownerPlayerId === me)
    if (!myPiece || myPiece.x == null || myPiece.y == null) return

    // 尝试多个移动方向，直到找到一个可用的格子
    const directions = [
      { dx: 1, dy: 0 },   // 右
      { dx: -1, dy: 0 },  // 左
      { dx: 0, dy: 1 },   // 下
      { dx: 0, dy: -1 },  // 上
    ]
    
    let moveToX = myPiece.x
    let moveToY = myPiece.y
    let foundValidMove = false
    
    for (const dir of directions) {
      const newX = myPiece.x + dir.dx
      const newY = myPiece.y + dir.dy
      
      // 检查是否在地图范围内
      if (newX >= 0 && newX < battle.map.width && newY >= 0 && newY < battle.map.height) {
        // 检查目标格子是否可走
        const targetTile = battle.map.tiles.find(t => t.x === newX && t.y === newY)
        if (targetTile && targetTile.props.walkable) {
          // 检查目标格子是否被占用
          const isOccupied = battle.pieces.some(p => 
            p.x === newX && p.y === newY && p.currentHp > 0
          )
          if (!isOccupied) {
            moveToX = newX
            moveToY = newY
            foundValidMove = true
            break
          }
        }
      }
    }
    
    if (foundValidMove) {
      const action: BattleAction = {
        type: "move",
        playerId: me,
        pieceId: myPiece.instanceId,
        toX: moveToX,
        toY: moveToY,
      }
      await sendBattleAction(action)
    }
  }

  async function fetchBattle(id: string) {
    try {
      setError(null)
      const res = await fetch(`/api/rooms/${id}/battle`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Failed to load battle state")
      }
      const data = (await res.json()) as BattleState
      setBattle(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
      setBattle(null)
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

  async function handleDeleteRoom() {
    if (!roomId) return
    try {
      setLoading(true)
      setError(null)
      const res = await fetch(`/api/rooms/${roomId}`, {
        method: "DELETE",
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || "Failed to delete room")
      }

      // 清空状态
      setRoom(null)
      setRoomId(null)
      setBattle(null)
      // 移除 URL 上的 roomId
      router.replace("/play")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }

  const currentPlayerName =
    room && room.players[room.currentTurnIndex]
      ? room.players[room.currentTurnIndex]!.name
      : null

  const isMyTurn =
    !!room &&
    !!user &&
    currentPlayerName?.toLowerCase() === user.username.toLowerCase()

  const currentPlayerId = useMemo(
    () => (user ? user.id : null),
    [user],
  )

  // 轮询检查房间状态，确保所有玩家都能及时获取状态变化
  useEffect(() => {
    if (!roomId || !user) return

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/rooms/${roomId}`)
        if (res.ok) {
          const data = (await res.json()) as Room
          if (data.status === "in-progress") {
            router.replace(`/battle/${roomId}?playerName=${encodeURIComponent(user.username)}&playerId=${encodeURIComponent(user.id)}`)
          }
        }
      } catch (error) {
        // 忽略错误
      }
    }, 2000) // 每2秒检查一次

    return () => clearInterval(interval)
  }, [roomId, router, user])

  // 监听房间状态变化，当游戏开始时自动跳转
  useEffect(() => {
    if (room?.status === "in-progress" && roomId && user) {
      router.replace(`/battle/${roomId}?playerName=${encodeURIComponent(user.username)}&playerId=${encodeURIComponent(user.id)}`)
    }
  }, [room?.status, roomId, router, user])

  return (
    <main className="flex min-h-svh flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Menu
        </Link>

        {/* 未登录状态 */}
        {!user && (
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl font-bold">
                1v1 对战大厅
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Alert>
                <AlertTitle>需要登录</AlertTitle>
                <AlertDescription>
                  请先登录或注册账号，才能进行 1v1 对战
                </AlertDescription>
              </Alert>
              <div className="flex gap-2">
                <Button asChild className="flex-1 bg-blue-600 hover:bg-blue-700 text-white">
                  <Link href="/auth/login">
                    <LogIn className="mr-2 h-4 w-4" />
                    登录
                  </Link>
                </Button>
                <Button asChild className="flex-1 bg-green-600 hover:bg-green-700 text-white">
                  <Link href="/auth/register">
                    <UserPlus className="mr-2 h-4 w-4" />
                    注册
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* 已登录状态 */}
        {user && (
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl font-bold">
                1v1 对战大厅
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>当前用户</Label>
                <div className="flex items-center gap-2 rounded-md border border-border bg-card/60 p-2">
                  <span className="font-medium">{user.username}</span>
                  <span className="text-xs text-muted-foreground">ID: {user.id}</span>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="roomId">房间 ID（可选，用于加入他人房间）</Label>
                <Input
                  id="roomId"
                  placeholder="创建房间后会自动生成"
                  value={roomId ?? ""}
                  onChange={(e) => setRoomId(e.target.value || null)}
                />
              </div>

              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  className="flex-1"
                  onClick={handleCreateRoom}
                  disabled={loading}
                >
                  {loading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      处理中…
                    </>
                  ) : (
                    "创建新房间"
                  )}
                </Button>
                <Button
                  className="flex-1"
                  variant="outline"
                  onClick={handleJoinExisting}
                  disabled={loading}
                >
                  加入房间
                </Button>
              </div>

              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {user && room && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>{room.name}</span>
                <span className="text-xs uppercase text-muted-foreground">
                  {room.status === "waiting"
                    ? "等待中"
                    : room.status === "in-progress"
                      ? "对战中"
                      : "已结束"}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1 text-sm">
                <div>
                  <span className="font-medium text-muted-foreground">
                    房间 ID：
                  </span>
                  <span className="font-mono">{room.id}</span>
                </div>
                <div>
                  <span className="font-medium text-muted-foreground">
                    玩家：
                  </span>
                  {room.players.length === 0
                    ? "暂无"
                    : room.players.map((p) => p.name).join(" vs ")}
                </div>
              </div>

              {!battle && room.status === "waiting" && user && (
                <div className="flex justify-center">
                  <Button
                    size="sm"
                    className="w-full"
                    disabled={loading}
                    onClick={handleStartGame}
                  >
                    {loading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        开始游戏中...
                      </>
                    ) : (
                      room.players.length === 1 ? "进入棋子选择" : "开始游戏"
                    )}
                  </Button>
                </div>
              )}

              {battle && (
                <>
                  <div className="space-y-2 rounded-md border border-dashed border-border p-3 text-sm">
                    <div className="font-medium text-muted-foreground">
                      战斗状态：
                    </div>
                    <p className="text-xs text-muted-foreground">
                      当前回合：第 {battle.turn.turnNumber} 回合 ·{" "}
                      {battle.turn.currentPlayerId}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      当前阶段：
                      {battle.turn.phase === "start"
                        ? "开始阶段"
                        : battle.turn.phase === "action"
                          ? "行动阶段"
                          : "结束阶段"}
                    </p>
                  </div>

                  <div className="space-y-2 rounded-md border border-border bg-card/60 p-3 text-xs">
                    <div className="font-medium text-muted-foreground">
                      棋盘（服务器同步）
                    </div>
                    <div className="flex justify-center">
                      <GameBoard map={battle.map} pieces={battle.pieces} />
                    </div>
                  </div>

                  <div className="space-y-2 rounded-md border border-border bg-card/60 p-3 text-xs">
                    <div className="font-medium text-muted-foreground">
                      行动按钮（每回合每种最多一次）
                    </div>
                    <div className="flex flex-col gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={loading}
                        onClick={() => sendBattleAction({ type: "beginPhase" })}
                      >
                        下一阶段 / 轮到下家
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          loading ||
                          !battle ||
                          battle.turn.phase !== "action" ||
                          !user
                        }
                        onClick={handleMakeMove}
                      >
                        我移动一次（示例）
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          loading ||
                          !battle ||
                          battle.turn.phase !== "action" ||
                          !user
                        }
                        onClick={() =>
                          sendBattleAction({
                            type: "useBasicSkill",
                            playerId: user!.id,
                            pieceId:
                              battle.pieces.find(
                                (p) => p.ownerPlayerId === user!.id,
                              )?.instanceId ?? "",
                            skillId: "basic-attack",
                          })
                        }
                      >
                        使用一次普通技能（示例）
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          loading ||
                          !battle ||
                          battle.turn.phase !== "action" ||
                          !user
                        }
                        onClick={() =>
                          sendBattleAction({
                            type: "useChargeSkill",
                            playerId: user!.id,
                            pieceId:
                              battle.pieces.find(
                                (p) => p.ownerPlayerId === user!.id,
                              )?.instanceId ?? "",
                            skillId: "fireball",
                          })
                        }
                      >
                        使用一次充能技能（示例）
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          loading ||
                          !battle ||
                          battle.turn.phase !== "action" ||
                          !user
                        }
                        onClick={() =>
                          sendBattleAction({
                            type: "endTurn",
                            playerId: user!.id,
                          })
                        }
                      >
                        结束回合（进入结束阶段）
                      </Button>
                    </div>
                  </div>
                </>
              )}

              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-destructive hover:text-destructive"
                  onClick={handleDeleteRoom}
                  disabled={loading}
                >
                  删除房间
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  )
}

