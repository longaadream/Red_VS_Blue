"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { ArrowLeft, Swords, Star, UserPlus, LogIn } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { toast } from "sonner"
import { getPiecesByFaction, loadPieces, type PieceTemplate } from "@/lib/game/piece-repository"

type User = {
  id: string
  username: string
  password: string
  createdAt: string
}

export default function PieceSelectionPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [user, setUser] = useState<User | null>(null)
  const [redPieces, setRedPieces] = useState<PieceTemplate[]>([])
  const [bluePieces, setBluePieces] = useState<PieceTemplate[]>([])
  const [redSelectedPieces, setRedSelectedPieces] = useState<PieceTemplate[]>([])
  const [blueSelectedPieces, setBlueSelectedPieces] = useState<PieceTemplate[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [roomId, setRoomId] = useState<string>("")
  const [playerFaction, setPlayerFaction] = useState<"red" | "blue" | null>(null)
  const [roomStatus, setRoomStatus] = useState<"waiting" | "ready">("waiting")
  const [isPiecesSelected, setIsPiecesSelected] = useState(false)
  const [currentPlayerSelected, setCurrentPlayerSelected] = useState(false)
  const [allPlayersSelected, setAllPlayersSelected] = useState(false)
  const [roomPlayers, setRoomPlayers] = useState<Array<{ name: string; hasSelectedPieces: boolean }>>([])
  const [gameStarting, setGameStarting] = useState(false)

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

  // 从URL参数中获取roomId
  useEffect(() => {
    const urlRoomId = searchParams.get('roomId')
    setRoomId(urlRoomId ? urlRoomId.trim() : "")
  }, [searchParams])

  // 加载棋子数据
  useEffect(() => {
    async function fetchPieces() {
      await loadPieces()
      // 加载完成后更新棋子状态
      setRedPieces(getPiecesByFaction("red"))
      setBluePieces(getPiecesByFaction("blue"))
    }
    fetchPieces()
  }, [])

  // 轮询检查房间状态，确保所有玩家都能及时获取状态更新
  useEffect(() => {
    const trimmedRoomId = roomId.trim()
    if (!trimmedRoomId || !playerFaction || !user) {
      return
    }

    const interval = setInterval(async () => {
      try {
        console.log('Polling room status:', { roomId: trimmedRoomId, timestamp: Date.now() })
        const res = await fetch(`/api/rooms/${encodeURIComponent(trimmedRoomId)}`)
        console.log('Fetch response status:', { status: res.status, statusText: res.statusText })
        if (res.ok) {
          const data = await res.json()
          console.log('Room data received:', data)
          // 检查房间状态是否已经是"in-progress"，如果是，直接跳转到战斗页面
          if (data.status === "in-progress") {
            console.log('Room is already in progress, redirecting to battle')
            window.location.href = `/battle/${trimmedRoomId}?playerName=${encodeURIComponent(user.username)}&playerId=${encodeURIComponent(user.id.trim())}`
            return
          }
          
          // 更新房间状态
          if (data.players) {
            console.log('Updating room status with players:', data.players)
            setRoomStatus(data.players.length === 2 ? "ready" : "waiting")
            
            // 更新玩家列表和棋子选择状态
            const players = data.players.map((p: any) => ({
              name: p.name,
              hasSelectedPieces: p.hasSelectedPieces === true || (p.selectedPieces && p.selectedPieces.length > 0)
            }))
            setRoomPlayers(players)
            
            // 输出详细的玩家状态以便调试
            console.log('Player status details:', data.players.map((p: any) => ({
              id: p.id,
              idTrimmed: p.id.trim(),
              name: p.name,
              hasSelectedPieces: p.hasSelectedPieces,
              selectedPiecesCount: p.selectedPieces?.length || 0
            })))
            
            // 检查是否所有玩家都选择了棋子，并且至少有2个玩家
            const allSelected = data.players.length >= 2 && data.players.every((p: any) => {
              const hasSelected = p.hasSelectedPieces === true || (p.selectedPieces && p.selectedPieces.length > 0)
              console.log('Player selection check:', { player: p.name, hasSelectedPieces: p.hasSelectedPieces, selectedPiecesCount: p.selectedPieces?.length || 0, hasSelected })
              return hasSelected
            })
            setAllPlayersSelected(allSelected)
            console.log('All players selected check:', { allSelected, playerCount: data.players.length })
            
            // 检查当前玩家是否已经选择了棋子
            const currentPlayer = data.players.find((p: any) => p.id.trim() === user.id.trim())
            const currentPlayerSelected = currentPlayer && (currentPlayer.hasSelectedPieces === true || (currentPlayer.selectedPieces && currentPlayer.selectedPieces.length > 0))
            setCurrentPlayerSelected(currentPlayerSelected)
            
            // 输出详细的房间状态以便调试
            console.log('Room status update:', {
              roomId: trimmedRoomId,
              playersCount: data.players.length,
              players: data.players.map((p: any) => ({ id: p.id, name: p.name, hasSelectedPieces: p.hasSelectedPieces, selectedPiecesCount: p.selectedPieces?.length || 0, faction: p.faction })),
              allSelected,
              currentPlayerSelected,
              isPiecesSelected,
              roomStatus: data.status,
              currentUserId: user.id.trim()
            })
            
            // 如果所有玩家都选择了棋子，并且当前玩家也选择了棋子，自动开始游戏
            if (allSelected && currentPlayerSelected && !gameStarting) {
              console.log('All players have selected pieces, auto-starting game')
              setGameStarting(true)
              // 延迟一小段时间，让用户看到"游戏即将开始"的消息
              setTimeout(() => {
                void handleStartGame()
              }, 1000)
            }
          } else {
            console.log('No players data in room response:', data)
          }
        } else {
          console.log('Failed to fetch room status:', { status: res.status, statusText: res.statusText })
        }
      } catch (error) {
        console.error('Error polling room status:', error)
      }
    }, 1000) // 每1秒检查一次，增加轮询频率

    return () => clearInterval(interval)
  }, [roomId, playerFaction, user])

  function handleRedPieceToggle(piece: PieceTemplate) {
    const isSelected = redSelectedPieces.some(p => p.id === piece.id)
    if (isSelected) {
      setRedSelectedPieces(redSelectedPieces.filter(p => p.id !== piece.id))
    } else {
      setRedSelectedPieces([...redSelectedPieces, piece])
    }
  }

  function handleBluePieceToggle(piece: PieceTemplate) {
    const isSelected = blueSelectedPieces.some(p => p.id === piece.id)
    if (isSelected) {
      setBlueSelectedPieces(blueSelectedPieces.filter(p => p.id !== piece.id))
    } else {
      setBlueSelectedPieces([...blueSelectedPieces, piece])
    }
  }

  async function handleJoinRoom() {
    if (!user) {
      toast.error("请先登录")
      return
    }
    const trimmedRoomId = roomId.trim()
    if (!trimmedRoomId) {
      toast.error("请输入房间ID")
      return
    }
    if (loading) {
      // 防止重复点击
      return
    }
    setLoading(true)

    try {
      console.log('Attempting to join room:', trimmedRoomId)
      console.log('User:', user.username, 'ID:', user.id)
      
      // 构建完整的URL，确保路径正确
      const url = `/api/rooms/${encodeURIComponent(trimmedRoomId)}`
      console.log('API URL:', url)
      
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          action: "join",
          playerName: user.username,
          playerId: user.id.trim(),
        }),
      })
      
      console.log('Response status:', res.status)
      console.log('Response status text:', res.statusText)
      
      // 尝试解析响应
      let data
      try {
        data = await res.json()
        console.log('Response data:', data)
      } catch (jsonError) {
        console.error('JSON parsing error:', jsonError)
        throw new Error(`响应解析失败: ${jsonError.message}`)
      }
      
      if (!res.ok) {
        if (data.error === "Room is full") {
          // 房间已满，检查是否已经是房间中的玩家
          // 尝试获取房间信息，看看当前玩家是否已经在房间中
          const roomRes = await fetch(`/api/rooms/${encodeURIComponent(trimmedRoomId)}`)
          if (roomRes.ok) {
            const roomData = await roomRes.json()
            const isAlreadyInRoom = roomData.players.some(
              (p: any) => p.id.trim() === user.id.trim()
            )
            if (isAlreadyInRoom) {
              // 如果玩家已经在房间中，调用 claim-faction 来获取实际分配的阵营
              console.log('Player is already in room, claiming faction')
              const factionRes = await fetch(`/api/rooms/${encodeURIComponent(trimmedRoomId)}/actions`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Accept": "application/json"
                },
                body: JSON.stringify({
                  action: "claim-faction",
                  playerName: user.username,
                  playerId: user.id.trim(),
                }),
              })
              
              if (factionRes.ok) {
                const factionData = await factionRes.json()
                if (factionData.success) {
                  setPlayerFaction(factionData.faction)
                  setRoomStatus(roomData.players.length === 2 ? "ready" : "waiting")
                  return
                }
              }
            }
          }
        }
        throw new Error(data.error || `加入房间失败 (${res.status})`)
      }
      
      // 检查响应数据结构
      if (!data.players) {
        throw new Error('响应数据格式不正确，缺少players字段')
      }
      
      // 调用 claim-faction 来获取实际分配的阵营
      console.log('Join room successful, claiming faction')
      const factionRes = await fetch(`/api/rooms/${encodeURIComponent(trimmedRoomId)}/actions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          action: "claim-faction",
          playerName: user.username,
          playerId: user.id.trim(),
        }),
      })
      
      if (factionRes.ok) {
        const factionData = await factionRes.json()
        if (factionData.success) {
          setPlayerFaction(factionData.faction)
          setRoomStatus(data.players.length === 2 ? "ready" : "waiting")
          console.log('Faction claimed successfully:', factionData.faction)
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "加入房间失败"
      console.error('Join room error:', err)
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  function handleStartGame() {
    if (!user) {
      toast.error("请先登录")
      return
    }
    const trimmedRoomId = roomId.trim()
    if (!trimmedRoomId) {
      toast.error("请先加入房间")
      return
    }
    if (loading || gameStarting) {
      // 防止重复调用
      console.log('Game start already in progress, skipping')
      return
    }
    setLoading(true)

    console.log('Attempting to start game:', {
      roomId: trimmedRoomId,
      userId: user.id,
      selectedPiecesCount: playerFaction === "red" ? redSelectedPieces.length : blueSelectedPieces.length,
      clientSidePlayersCount: roomPlayers.length
    })

    // 根据玩家的实际身份发送选择的棋子
    const selectedPieces = playerFaction === "red" ? redSelectedPieces : blueSelectedPieces
    
    fetch(`/api/rooms/${encodeURIComponent(trimmedRoomId)}/actions`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        action: "start-game",
        playerName: user.username,
        playerId: user.id.trim(),
        pieces: selectedPieces.map(p => ({
          templateId: p.id,
          faction: p.faction,
        })),
      }),
    })
      .then((res) => {
        console.log('Start game response status:', res.status)
        return res.json()
      })
      .then((data) => {
        console.log('Start game response data:', data)
        if (data.success) {
          console.log('Game started successfully, redirecting to battle')
          window.location.href = `/battle/${trimmedRoomId}?playerName=${encodeURIComponent(user.username)}&playerId=${encodeURIComponent(user.id.trim())}`
        } else {
          console.log('Game start failed:', data.error || data.message)
          toast.error(data.error || data.message || "开始游戏失败")
          setGameStarting(false)
        }
      })
      .catch((err) => {
        console.error('Error starting game:', err)
        toast.error(err instanceof Error ? err.message : "开始游戏失败")
        setGameStarting(false)
      })
      .finally(() => {
        setLoading(false)
      })
  }

  function handleSelectPieces() {
    if (!user) {
      toast.error("请先登录")
      return
    }
    const trimmedRoomId = roomId.trim()
    if (!trimmedRoomId) {
      toast.error("请先加入房间")
      return
    }
    if (playerFaction === "red" && redSelectedPieces.length === 0) {
      toast.error("请选择至少1个红方棋子")
      return
    }
    if (playerFaction === "blue" && blueSelectedPieces.length === 0) {
      toast.error("请选择至少1个蓝方棋子")
      return
    }
    setLoading(true)

    const selectedPieces = playerFaction === "red" ? redSelectedPieces : blueSelectedPieces
    
    fetch(`/api/rooms/${encodeURIComponent(trimmedRoomId)}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "select-pieces",
        playerName: user.username,
        playerId: user.id.trim(),
        pieces: selectedPieces.map(p => ({
          templateId: p.id,
          faction: p.faction,
        })),
      }),
    })
      .then((res) => {
        if (!res.ok) {
          return res.json().then(data => {
            throw new Error(data.error || "选择棋子失败")
          })
        }
        return res.json()
      })
      .then((data) => {
        if (data.success) {
          toast.success("棋子选择成功！")
          setIsPiecesSelected(true)
        } else {
          toast.error(data.message || "选择棋子失败")
        }
      })
      .catch((err) => {
        const errorMessage = err instanceof Error ? err.message : "选择棋子失败"
        console.error('Select pieces error:', err)
        toast.error(errorMessage)
      })
      .finally(() => {
        setLoading(false)
      })
  }

  function getRarityColor(rarity: string): string {
    switch (rarity) {
      case "common":
        return "bg-zinc-600 text-zinc-100"
      case "rare":
        return "bg-purple-600 text-purple-100"
      case "epic":
        return "bg-yellow-600 text-yellow-100"
      case "legendary":
        return "bg-orange-600 text-orange-100"
      default:
        return "bg-zinc-600 text-zinc-100"
    }
  }

  return (
    <main className="min-h-svh bg-zinc-950 px-4 py-6">
      <div className="mx-auto w-full max-w-6xl space-y-6">
        <div className="flex items-center justify-between">
          <Button asChild variant="ghost" size="sm">
            <Link href="/">
              <ArrowLeft className="mr-2 h-4 w-4" />
              返回主页
            </Link>
          </Button>
          <h1 className="text-xl font-bold text-zinc-100">
            <Swords className="mr-2 inline h-5 w-5 text-red-500" />
            棋子选择
          </h1>
        </div>

        {/* 未登录状态 */}
        {!user && (
          <div className="mb-4">
            <Card className="bg-zinc-900/50">
              <CardHeader>
                <CardTitle>需要登录</CardTitle>
              </CardHeader>
              <CardContent>
                <Alert>
                  <AlertTitle>请先登录</AlertTitle>
                  <AlertDescription>
                    你需要登录后才能进行棋子选择和游戏
                  </AlertDescription>
                </Alert>
                <div className="mt-4 flex gap-2">
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
          </div>
        )}

        {/* 已登录状态 */}
        {user && (
          <div className="mb-4">
            <Card className="bg-zinc-900/50">
              <CardHeader>
                <CardTitle>房间信息</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-medium text-zinc-300 mb-2">
                      房间ID
                    </label>
                    <input
                      type="text"
                      value={roomId}
                      onChange={(e) => setRoomId(e.target.value)}
                      placeholder="输入房间ID或留空创建新房间"
                      className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-600 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-zinc-300 mb-2">
                      当前用户
                    </label>
                    <div className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-zinc-100">
                      <div className="flex items-center justify-between">
                        <span>{user.username}</span>
                        <span className="text-xs text-zinc-400">ID: {user.id}</span>
                      </div>
                    </div>
                  </div>
                  {playerFaction && (
                    <div className="flex items-center gap-2">
                      <Badge className={
                        playerFaction === "red" ? "bg-red-600 text-red-100" : "bg-blue-600 text-blue-100"
                      }>
                        {playerFaction === "red" ? "红方" : "蓝方"}
                      </Badge>
                      <span className="text-sm text-zinc-400">
                        你的阵营
                      </span>
                    </div>
                  )}
                  {roomPlayers.length > 0 && (
                    <div className="mt-4 space-y-2">
                      <div className="text-sm font-medium text-zinc-300">玩家状态：</div>
                      {roomPlayers.map((player, index) => (
                        <div key={index} className="flex items-center justify-between text-sm">
                          <span className="text-zinc-400">{player.name}</span>
                          <span className={`px-2 py-1 rounded ${player.hasSelectedPieces ? 'bg-green-900/50 text-green-100' : 'bg-zinc-800/50 text-zinc-400'}`}>
                            {player.hasSelectedPieces ? '已选择棋子' : '未选择棋子'}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {roomStatus === "ready" && (
                    <div className="rounded-md bg-green-900/50 border border-green-800 p-3 text-sm text-green-100">
                      双方都已加入，可以开始游戏
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {user && playerFaction === "red" && (
          <Card className="bg-zinc-900/50">
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <div className="h-4 w-4 bg-red-500 rounded" />
                  红方棋子
                </span>
                <Badge className="ml-2">已选: {redSelectedPieces.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {redPieces.map((piece) => (
                <div
                  key={piece.id}
                  onClick={() => handleRedPieceToggle(piece)}
                  className={`relative p-4 rounded-lg border-2 cursor-pointer transition-all ${
                    redSelectedPieces.some(p => p.id === piece.id)
                      ? "border-red-500 bg-red-900/20"
                      : "border-zinc-700 bg-zinc-800/50 hover:border-zinc-600"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className={`text-4xl ${piece.image}`}>
                      {piece.image}
                    </div>
                    <div className="flex-1">
                      <div className="font-bold text-zinc-100">{piece.name}</div>
                      <Badge className={getRarityColor(piece.rarity)}>
                        {piece.rarity}
                      </Badge>
                      <p className="text-sm text-zinc-400 mt-1">{piece.description}</p>
                    </div>
                  </div>
                  {redSelectedPieces.some(p => p.id === piece.id) && (
                    <div className="absolute top-2 right-2 h-6 w-6 bg-red-500 rounded-full flex items-center justify-center">
                      <Star className="h-4 w-4 text-white" />
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {user && playerFaction === "blue" && (
          <Card className="bg-zinc-900/50">
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <div className="h-4 w-4 bg-blue-500 rounded" />
                  蓝方棋子
                </span>
                <Badge className="ml-2">已选: {blueSelectedPieces.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {bluePieces.map((piece) => (
                <div
                  key={piece.id}
                  onClick={() => handleBluePieceToggle(piece)}
                  className={`relative p-4 rounded-lg border-2 cursor-pointer transition-all ${
                    blueSelectedPieces.some(p => p.id === piece.id)
                      ? "border-blue-500 bg-blue-900/20"
                      : "border-zinc-700 bg-zinc-800/50 hover:border-zinc-600"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className={`text-4xl ${piece.image}`}>
                      {piece.image}
                    </div>
                    <div className="flex-1">
                      <div className="font-bold text-zinc-100">{piece.name}</div>
                      <Badge className={getRarityColor(piece.rarity)}>
                        {piece.rarity}
                      </Badge>
                      <p className="text-sm text-zinc-400 mt-1">{piece.description}</p>
                    </div>
                  </div>
                  {blueSelectedPieces.some(p => p.id === piece.id) && (
                    <div className="absolute top-2 right-2 h-6 w-6 bg-blue-500 rounded-full flex items-center justify-center">
                      <Star className="h-4 w-4 text-white" />
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {user && !playerFaction && (
          <Card className="bg-zinc-900/50">
            <CardContent>
              <div className="text-center text-zinc-500 text-sm">
                请先加入房间以获取阵营分配
              </div>
            </CardContent>
          </Card>
        )}

        {user && (
          <Card className="bg-zinc-900/50">
            <CardHeader>
              <CardTitle>已选棋子</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {playerFaction === "red" && redSelectedPieces.length > 0 && (
                  <div className="p-4 rounded-lg bg-red-900/20 border border-red-800">
                    <div className="font-bold text-zinc-100 mb-2">红方棋子 ({redSelectedPieces.length}个)</div>
                    <div className="flex flex-wrap gap-2">
                      {redSelectedPieces.map((piece) => (
                        <div key={piece.id} className="flex items-center gap-2">
                          <div className={`text-3xl ${piece.image}`}>{piece.image}</div>
                          <span className="text-sm text-zinc-300">{piece.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {playerFaction === "blue" && blueSelectedPieces.length > 0 && (
                  <div className="p-4 rounded-lg bg-blue-900/20 border border-blue-800">
                    <div className="font-bold text-zinc-100 mb-2">蓝方棋子 ({blueSelectedPieces.length}个)</div>
                    <div className="flex flex-wrap gap-2">
                      {blueSelectedPieces.map((piece) => (
                        <div key={piece.id} className="flex items-center gap-2">
                          <div className={`text-3xl ${piece.image}`}>{piece.image}</div>
                          <span className="text-sm text-zinc-300">{piece.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {(playerFaction === "red" && redSelectedPieces.length === 0) || 
                 (playerFaction === "blue" && blueSelectedPieces.length === 0) && (
                  <div className="text-center text-zinc-500 text-sm">
                    还没有选择棋子
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {user && (
          <div className="grid gap-4 sm:grid-cols-2">
            {!playerFaction && (
              <Button
              className="w-full"
              size="lg"
              onClick={handleJoinRoom}
              disabled={loading || !roomId.trim() || !user}
            >
                {loading ? (
                  <>
                    <div className="h-4 w-4 animate-spin" />
                    <span className="ml-2">加入房间中...</span>
                  </>
                ) : (
                  <>
                    <UserPlus className="mr-2 h-5 w-5" />
                    加入房间
                  </>
                )}
              </Button>
            )}
            <Button
              className="w-full"
              size="lg"
              onClick={handleSelectPieces}
              disabled={loading || !playerFaction || !roomId.trim() || !user}
            >
              {loading ? (
                <>
                  <div className="h-4 w-4 animate-spin" />
                  <span className="ml-2">选择棋子中...</span>
                </>
              ) : (
                <>
                  <Star className="mr-2 h-5 w-5" />
                  确认选择
                </>
              )}
            </Button>
          </div>
        )}
        {user && allPlayersSelected && currentPlayerSelected && (
          <div className="mt-4 p-4 rounded-lg bg-blue-900/30 border border-blue-700 text-center">
            <div className="flex justify-center mb-2">
              <div className="h-6 w-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            </div>
            <p className="text-blue-200">双方都已选择棋子，游戏即将开始...</p>
          </div>
        )}
      </div>
    </main>
  )
}
