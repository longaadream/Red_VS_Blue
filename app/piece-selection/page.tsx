"use client"

import { useState, useEffect, useRef, Suspense } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { ArrowLeft, Swords, Star, UserPlus, LogIn, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { toast } from "sonner"
import { getPiecesByFaction, loadPieces, type PieceTemplate } from "@/lib/game/piece-repository"
import { loadSkills, getSkillById, type SkillDefinition } from "@/lib/game/skill-repository"

type User = {
  id: string
  username: string
  password: string
  createdAt: string
}

export default function PieceSelectionPage() {
  return (
    <Suspense>
      <PieceSelectionContent />
    </Suspense>
  )
}

function PieceSelectionContent() {
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
  const [showDetails, setShowDetails] = useState(false)
  const [selectedPiece, setSelectedPiece] = useState<PieceTemplate | null>(null)
  const [expandedSkills, setExpandedSkills] = useState<Record<string, boolean>>({})
  const fetchRequestIdRef = useRef(0)
  const lastSelectTimeRef = useRef(0)

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

  // 加载棋子和技能数据
  useEffect(() => {
    async function fetchData() {
      await loadPieces()
      await loadSkills()
      // 加载完成后更新棋子状态
      setRedPieces(getPiecesByFaction("red"))
      setBluePieces(getPiecesByFaction("blue"))
    }
    fetchData()
  }, [])

  // 手动获取房间状态的函数
  function fetchRoomStatus() {
    const trimmedRoomId = roomId.trim()
    if (!trimmedRoomId || !user) {
      return
    }

    // 如果在选择棋子后的2秒内，跳过这次轮询
    const timeSinceLastSelect = Date.now() - lastSelectTimeRef.current
    if (timeSinceLastSelect < 2000) {
      console.log('Skipping fetch, recently selected pieces:', timeSinceLastSelect, 'ms ago')
      return
    }

    // 生成新的请求ID
    const requestId = ++fetchRequestIdRef.current
    console.log('Fetching room status:', { roomId: trimmedRoomId, requestId })
    const apiUrl = `/api/rooms/${encodeURIComponent(trimmedRoomId)}`
    console.log('API request URL:', apiUrl)

    fetch(apiUrl)
      .then(res => {
        console.log('Fetch response details:', {
          status: res.status,
          statusText: res.statusText,
          headers: Object.fromEntries(res.headers.entries())
        })
        
        if (res.ok) {
          // 检查响应是否为JSON
          const contentType = res.headers.get('content-type')
          console.log('Response content type:', contentType)
          
          if (contentType && contentType.includes('application/json')) {
            return res.json()
          } else {
            console.error('Response is not JSON:', contentType)
            return res.text().then(text => {
              console.error('Response text:', text.substring(0, 200) + '...')
              throw new Error('Response is not JSON')
            })
          }
        } else {
          console.log('Failed to fetch room status:', { status: res.status, statusText: res.statusText })
          return res.json().catch(() => res.text()).then(data => {
            console.log('Error response data:', data)
            throw new Error('Failed to fetch room status')
          })
        }
      })
      .then(data => {
        console.log('Room data received:', data)
        
        // 检查房间状态是否已经是"in-progress"，如果是，直接跳转到战斗页面
        if (data.status === "in-progress") {
          console.log('Room is already in progress, redirecting to battle')
          window.location.href = `/battle/${trimmedRoomId}?playerName=${encodeURIComponent(user.username)}&playerId=${encodeURIComponent(user.id.trim())}`
          return
        }
        
        // 更新房间状态和玩家列表
        if (data.players) {
          console.log('Updating room status with players:', data.players)
          setRoomStatus(data.players.length === 2 ? "ready" : "waiting")
          
          // 更新玩家列表和棋子选择状态
          const trimmedUserId = user.id.trim()
          const players = data.players.map((p: any) => {
            // 确保正确计算玩家的选择状态，处理undefined情况
            const isCurrentPlayer = p.id.trim() === trimmedUserId
            // 计算玩家的实际选择状态，不强制将当前玩家标记为已选择
            const hasSelected = Boolean(p.hasSelectedPieces === true || (p.selectedPieces && p.selectedPieces.length > 0))
            console.log('Processing player:', {
              name: p.name,
              playerId: p.id,
              trimmedUserId,
              isCurrentPlayer,
              hasSelectedPiecesFromAPI: p.hasSelectedPieces,
              selectedPiecesFromAPI: p.selectedPieces,
              selectedPiecesCount: p.selectedPieces?.length || 0,
              calculatedHasSelected: hasSelected
            })
            return {
              name: p.name,
              hasSelectedPieces: hasSelected
            }
          })
          
          console.log('Updated room players:', players)
          setRoomPlayers(players)
          
          // 更新当前玩家的选择状态
          const currentPlayer = data.players.find((p: any) => p.id.trim() === trimmedUserId)
          const currentPlayerHasSelected = currentPlayer ? Boolean(currentPlayer.hasSelectedPieces === true || (currentPlayer.selectedPieces && currentPlayer.selectedPieces.length > 0)) : false
          setCurrentPlayerSelected(currentPlayerHasSelected)
          setIsPiecesSelected(currentPlayerHasSelected)
          
          // 检查是否所有玩家都已选择
          const allSelected = players.length >= 2 && players.every(p => p.hasSelectedPieces)
          setAllPlayersSelected(allSelected)
          
          // 如果所有玩家都已选择，自动开始游戏
          if (allSelected) {
            console.log('All players have selected pieces, auto-starting game')
            handleStartGame()
          }
        }
      })
      .catch(error => {
        console.error('Error fetching room status:', error)
        if (error instanceof Error) {
          console.error('Error message:', error.message)
        }
      })
  }

  // 状态检查，确保其他玩家的操作能及时同步
  useEffect(() => {
    const trimmedRoomId = roomId.trim()
    if (!trimmedRoomId || !playerFaction || !user) {
      return
    }

    // 初始加载时获取一次状态
    fetchRoomStatus()

    // 每1秒检查一次状态，确保其他玩家的操作能及时同步
    // 1秒的频率既能保证及时性，又不会对服务器造成太大压力
    const interval = setInterval(() => {
      fetchRoomStatus()
    }, 1000) // 1秒一次，确保状态及时同步

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
            const trimmedUserId = user.id.trim()
            const isAlreadyInRoom = roomData.players.some(
              (p: any) => p.id.trim() === trimmedUserId
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
                  
                  // 玩家已经在房间中时，获取最新的房间状态
                  await fetchRoomStatus()
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
          // 加入房间后获取最新的房间状态
          await fetchRoomStatus()
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
    setGameStarting(true)

    console.log('Attempting to start game:', {
      roomId: trimmedRoomId,
      userId: user.id,
      selectedPiecesCount: playerFaction === "red" ? redSelectedPieces.length : blueSelectedPieces.length,
      clientSidePlayersCount: roomPlayers.length
    })

    // 根据玩家的实际身份发送选择的棋子
    const selectedPieces = playerFaction === "red" ? redSelectedPieces : blueSelectedPieces
    
    console.log('Selected pieces to send:', selectedPieces)
    
    const apiUrl = `/api/rooms/${encodeURIComponent(trimmedRoomId)}/actions`
    console.log('API URL:', apiUrl)
    
    const requestBody = JSON.stringify({
      action: "start-game",
      playerName: user.username,
      playerId: user.id.trim(),
      pieces: selectedPieces.map(p => ({
        templateId: p.id,
        faction: p.faction,
      })),
    })
    
    console.log('Request body:', requestBody)
    
    fetch(apiUrl, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: requestBody,
    })
      .then((res) => {
        console.log('Start game response status:', res.status)
        console.log('Start game response status text:', res.statusText)
        return res.json().catch(() => ({
          success: false,
          error: `响应解析失败 (${res.status})`
        }))
      })
      .then((data) => {
        console.log('Start game response data:', data)
        if (data.success) {
          console.log('Game started successfully, redirecting to battle')
          const battleUrl = `/battle/${trimmedRoomId}?playerName=${encodeURIComponent(user.username)}&playerId=${encodeURIComponent(user.id.trim())}`
          console.log('Battle URL:', battleUrl)
          window.location.href = battleUrl
        } else {
          console.log('Game start failed:', data.error || data.message)
          toast.error(data.error || data.message || "开始游戏失败")
          setGameStarting(false)
          
          // 游戏启动失败后，获取最新的房间状态
          fetchRoomStatus()
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

    // 记录选择棋子的时间，用于跳过轮询
    lastSelectTimeRef.current = Date.now()

    const selectedPieces = playerFaction === "red" ? redSelectedPieces : blueSelectedPieces

    console.log('=== Select Pieces Operation ===')
    console.log('Input parameters:', {
      roomId: {
        original: roomId,
        trimmed: trimmedRoomId
      },
      playerId: {
        original: user.id,
        trimmed: user.id.trim()
      },
      playerName: user.username,
      playerFaction: playerFaction,
      selectedPiecesCount: selectedPieces.length,
      selectedPieces: selectedPieces
    })
    
    const apiUrl = `/api/rooms/${encodeURIComponent(trimmedRoomId)}/actions`
    console.log('API URL:', apiUrl)
    
    const requestBody = {
      action: "select-pieces",
      playerName: user.username,
      playerId: user.id.trim(),
      pieces: selectedPieces.map(p => ({
        templateId: p.id,
        faction: p.faction,
      })),
    }
    
    console.log('Request body:', requestBody)
    
    fetch(apiUrl, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(requestBody),
    })
      .then((res) => {
        console.log('Response status:', { status: res.status, statusText: res.statusText })
        if (!res.ok) {
          return res.json().then(data => {
            console.log('Error response data:', data)
            throw new Error(data.error || "选择棋子失败")
          })
        }
        return res.json()
      })
      .then((data) => {
        console.log('Success response data:', data)
        if (data.success) {
          toast.success("棋子选择成功！")
          
          // 使用后端返回的房间数据更新本地状态
          if (data.room && data.room.players) {
            console.log('Using backend returned room data to update local state:', data.room.players)
            
            // 计算所有玩家的选择状态
            const trimmedUserId = user.id.trim()
            const currentPlayerFromServer = data.room.players.find((p: any) => p.id.trim() === trimmedUserId)
            const hasActuallySelected = currentPlayerFromServer ? 
              Boolean(currentPlayerFromServer.hasSelectedPieces === true || (currentPlayerFromServer.selectedPieces && currentPlayerFromServer.selectedPieces.length > 0)) : 
              false

            console.log('Current player from server:', {
              player: currentPlayerFromServer,
              hasActuallySelected
            })

            // 更新玩家列表状态（使用后端返回的数据）
            const players = data.room.players.map((p: any) => ({
              name: p.name,
              hasSelectedPieces: Boolean(p.hasSelectedPieces === true || (p.selectedPieces && p.selectedPieces.length > 0))
            }))
            console.log('Updated room players:', players)
            setRoomPlayers(players)

            // 更新当前玩家的选择状态（使用后端返回的数据）
            setIsPiecesSelected(hasActuallySelected)
            setCurrentPlayerSelected(hasActuallySelected)

            // 检查是否所有玩家都已选择完成（至少2个玩家）
            const allSelected = data.room.players.length >= 2 && data.room.players.every((p: any) => 
              Boolean(p.hasSelectedPieces === true || (p.selectedPieces && p.selectedPieces.length > 0))
            )
            console.log('All players selected check:', allSelected)
            setAllPlayersSelected(allSelected)

            // 如果所有玩家都已选择，自动开始游戏
            if (allSelected) {
              console.log('All players have selected pieces, auto-starting game')
              handleStartGame()
            }
          } else {
            // 如果后端返回的数据中没有房间信息，根据实际选择情况更新状态
            console.log('No room data in response, updating local state based on actual selection')
            const hasActuallySelected = selectedPieces.length > 0
            setIsPiecesSelected(hasActuallySelected)
            setCurrentPlayerSelected(hasActuallySelected)
            
            // 只有在没有房间数据时才需要重新获取
            fetchRoomStatus()
          }
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
        console.log('Select pieces operation completed')
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
                  onContextMenu={(e) => {
                    e.preventDefault();
                    // 显示棋子详细信息
                    console.log('Right-click on piece:', piece.name);
                    setSelectedPiece(piece);
                    setShowDetails(true);
                  }}
                  className={`relative p-3 rounded-lg border-2 cursor-pointer transition-all ${
                    redSelectedPieces.some(p => p.id === piece.id)
                      ? "border-red-500 bg-red-900/20"
                      : "border-zinc-700 bg-zinc-800/50 hover:border-zinc-600"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className={`flex items-center justify-center rounded-lg ${piece.faction === "red" ? "bg-red-600" : "bg-blue-600"} h-14 w-14`}>
                      {piece.image && piece.image.startsWith("http") ? (
                        <img 
                          src={piece.image} 
                          alt={piece.name} 
                          className="h-10 w-10 object-contain"
                        />
                      ) : piece.image && (piece.image.length <= 3 || piece.image.includes("️")) ? (
                        <span className="text-4xl font-bold text-white">{piece.image}</span>
                      ) : piece.image ? (
                        <img 
                          src={`/${piece.image}`} 
                          alt={piece.name} 
                          className="h-10 w-10 object-contain"
                        />
                      ) : (
                        <Swords className="h-7 w-7 text-white" />
                      )}
                    </div>
                    <div className="flex-1">
                      <div className="font-bold text-zinc-100">{piece.name}</div>
                      <div className="flex items-center gap-1">
                        <Badge className={getRarityColor(piece.rarity)}>
                          {piece.rarity}
                        </Badge>
                        <span className="text-xs text-zinc-400">
                          HP: {piece.stats.maxHp} | 攻击: {piece.stats.attack} | 防御: {piece.stats.defense}
                        </span>
                      </div>
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
                  onContextMenu={(e) => {
                    e.preventDefault();
                    // 显示棋子详细信息
                    console.log('Right-click on piece:', piece.name);
                    setSelectedPiece(piece);
                    setShowDetails(true);
                  }}
                  className={`relative p-3 rounded-lg border-2 cursor-pointer transition-all ${
                    blueSelectedPieces.some(p => p.id === piece.id)
                      ? "border-blue-500 bg-blue-900/20"
                      : "border-zinc-700 bg-zinc-800/50 hover:border-zinc-600"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className={`flex items-center justify-center rounded-lg ${piece.faction === "red" ? "bg-red-600" : "bg-blue-600"} h-14 w-14`}>
                      {piece.image && piece.image.startsWith("http") ? (
                        <img 
                          src={piece.image} 
                          alt={piece.name} 
                          className="h-10 w-10 object-contain"
                        />
                      ) : piece.image && (piece.image.length <= 3 || piece.image.includes("️")) ? (
                        <span className="text-4xl font-bold text-white">{piece.image}</span>
                      ) : piece.image ? (
                        <img 
                          src={`/${piece.image}`} 
                          alt={piece.name} 
                          className="h-10 w-10 object-contain"
                        />
                      ) : (
                        <Swords className="h-7 w-7 text-white" />
                      )}
                    </div>
                    <div className="flex-1">
                      <div className="font-bold text-zinc-100">{piece.name}</div>
                      <div className="flex items-center gap-1">
                        <Badge className={getRarityColor(piece.rarity)}>
                          {piece.rarity}
                        </Badge>
                        <span className="text-xs text-zinc-400">
                          HP: {piece.stats.maxHp} | 攻击: {piece.stats.attack} | 防御: {piece.stats.defense}
                        </span>
                      </div>
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
                          <div className="h-8 w-8 flex items-center justify-center bg-red-600 rounded">
                            {piece.image && piece.image.startsWith("http") ? (
                              <img 
                                src={piece.image} 
                                alt={piece.name} 
                                className="h-6 w-6 object-contain"
                              />
                            ) : piece.image && (piece.image.length <= 3 || piece.image.includes("️")) ? (
                              <span className="text-2xl font-bold text-white">{piece.image}</span>
                            ) : piece.image ? (
                              <img 
                                src={`/${piece.image}`} 
                                alt={piece.name} 
                                className="h-6 w-6 object-contain"
                              />
                            ) : (
                              <Swords className="h-4 w-4 text-white" />
                            )}
                          </div>
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
                          <div className="h-8 w-8 flex items-center justify-center bg-blue-600 rounded">
                            {piece.image && piece.image.startsWith("http") ? (
                              <img 
                                src={piece.image} 
                                alt={piece.name} 
                                className="h-6 w-6 object-contain"
                              />
                            ) : piece.image && (piece.image.length <= 3 || piece.image.includes("️")) ? (
                              <span className="text-2xl font-bold text-white">{piece.image}</span>
                            ) : piece.image ? (
                              <img 
                                src={`/${piece.image}`} 
                                alt={piece.name} 
                                className="h-6 w-6 object-contain"
                              />
                            ) : (
                              <Swords className="h-4 w-4 text-white" />
                            )}
                          </div>
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

        {/* 棋子详细信息弹窗 */}
        {showDetails && selectedPiece && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
            <div className="bg-zinc-900 rounded-lg border border-zinc-700 w-full max-w-md p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-zinc-100">棋子详情</h2>
                <button 
                  onClick={() => setShowDetails(false)} 
                  className="text-zinc-400 hover:text-zinc-100"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              
              <div className="flex items-center gap-3 mb-4">
                <div className={`flex items-center justify-center rounded-lg ${selectedPiece.faction === "red" ? "bg-red-600" : "bg-blue-600"} h-16 w-16`}>
                  {selectedPiece.image && selectedPiece.image.startsWith("http") ? (
                    <img 
                      src={selectedPiece.image} 
                      alt={selectedPiece.name} 
                      className="h-12 w-12 object-contain"
                    />
                  ) : selectedPiece.image && (selectedPiece.image.length <= 3 || selectedPiece.image.includes("️")) ? (
                    <span className="text-5xl font-bold text-white">{selectedPiece.image}</span>
                  ) : selectedPiece.image ? (
                    <img 
                      src={`/${selectedPiece.image}`} 
                      alt={selectedPiece.name} 
                      className="h-12 w-12 object-contain"
                    />
                  ) : (
                    <Swords className="h-8 w-8 text-white" />
                  )}
                </div>
                <div>
                  <div className="font-bold text-xl text-zinc-100">{selectedPiece.name}</div>
                  <Badge className={getRarityColor(selectedPiece.rarity)}>
                    {selectedPiece.rarity}
                  </Badge>
                </div>
              </div>
              
              <p className="text-sm text-zinc-300 mb-4">{selectedPiece.description}</p>
              
              <div className="grid grid-cols-2 gap-2 mb-4">
                <div className="flex items-center gap-1">
                  <span className="text-zinc-400">HP:</span>
                  <span className="text-white">{selectedPiece.stats.maxHp}</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-zinc-400">攻击:</span>
                  <span className="text-white">{selectedPiece.stats.attack}</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-zinc-400">防御:</span>
                  <span className="text-white">{selectedPiece.stats.defense}</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-zinc-400">移动范围:</span>
                  <span className="text-white">{selectedPiece.stats.moveRange}</span>
                </div>
              </div>
              
              {selectedPiece.skills && selectedPiece.skills.length > 0 && (
                <div className="mt-4">
                  <div className="font-medium text-zinc-300 mb-2">技能:</div>
                  <div className="space-y-2">
                    {selectedPiece.skills.map((skill) => {
                      const skillDefinition = getSkillById(skill.skillId)
                      return (
                        <div key={skill.skillId} className="bg-zinc-800 rounded overflow-hidden">
                          <div 
                            className="p-2 cursor-pointer hover:bg-zinc-700 transition-colors flex items-center justify-between"
                            onClick={() => setExpandedSkills(prev => ({
                              ...prev,
                              [skill.skillId]: !prev[skill.skillId]
                            }))}
                          >
                            <div>
                              <div className="font-medium text-zinc-200">{skillDefinition?.name || skill.skillId}</div>
                              <div className="text-xs text-zinc-400">等级: {skill.level}</div>
                            </div>
                            <div className="text-zinc-400">
                              {expandedSkills[skill.skillId] ? '▼' : '►'}
                            </div>
                          </div>
                          {expandedSkills[skill.skillId] && skillDefinition && (
                            <div className="p-2 border-t border-zinc-700 bg-zinc-900/50">
                              <div className="text-xs space-y-1">
                                {skillDefinition.kind && (
                                  <div>
                                    <span className="text-zinc-400">类型:</span>
                                    <span className="text-white">{skillDefinition.kind === 'active' ? '主动' : '被动'}</span>
                                  </div>
                                )}
                                {skillDefinition.type && (
                                  <div>
                                    <span className="text-zinc-400">技能类型:</span>
                                    <span className="text-white">
                                      {skillDefinition.type === 'super' ? '充能' : 
                                       skillDefinition.type === 'ultimate' ? '终极' : '普通'}
                                      {skill.usesRemaining === 1 && ' (限定技)'}
                                    </span>
                                  </div>
                                )}
                                {skillDefinition.description && (
                                  <div>
                                    <span className="text-zinc-400">描述:</span>
                                    <span className="text-white">{skillDefinition.description}</span>
                                  </div>
                                )}
                                {skillDefinition.actionPointCost !== undefined && (
                                  <div>
                                    <span className="text-zinc-400">行动点消耗:</span>
                                    <span className="text-white">{skillDefinition.actionPointCost}</span>
                                  </div>
                                )}
                                {skillDefinition.chargeCost !== undefined && (
                                  <div>
                                    <span className="text-zinc-400">充能点消耗:</span>
                                    <span className="text-white">{skillDefinition.chargeCost}</span>
                                  </div>
                                )}
                                {skillDefinition.cooldownTurns > 0 && (
                                  <div>
                                    <span className="text-zinc-400">冷却回合:</span>
                                    <span className="text-white">{skillDefinition.cooldownTurns}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {(selectedPiece as any).transformedSkills && (selectedPiece as any).transformedSkills.length > 0 && (
                <div className="mt-4">
                  <div className="font-medium text-purple-400 mb-2 text-xs flex items-center gap-1">
                    <span>🔮</span>
                    <span>变身后获得:</span>
                  </div>
                  <div className="space-y-2">
                    {(selectedPiece as any).transformedSkills.map((tSkill: any) => {
                      const skillDefinition = getSkillById(tSkill.skillId)
                      const triggerSkill = getSkillById(tSkill.triggeredBy)
                      return (
                        <div key={tSkill.skillId} className="bg-zinc-800/60 rounded overflow-hidden border-l-2 border-purple-500/50">
                          <div
                            className="p-2 cursor-pointer hover:bg-zinc-700 transition-colors flex items-center justify-between"
                            onClick={() => setExpandedSkills(prev => ({
                              ...prev,
                              [`transform_${tSkill.skillId}`]: !prev[`transform_${tSkill.skillId}`]
                            }))}
                          >
                            <div>
                              <div className="font-medium text-zinc-300">{skillDefinition?.name || tSkill.skillId}</div>
                              <div className="text-xs text-zinc-500">使用「{triggerSkill?.name || tSkill.triggeredBy}」后获得</div>
                            </div>
                            <div className="text-zinc-400">
                              {expandedSkills[`transform_${tSkill.skillId}`] ? '▼' : '►'}
                            </div>
                          </div>
                          {expandedSkills[`transform_${tSkill.skillId}`] && skillDefinition && (
                            <div className="p-2 border-t border-zinc-700 bg-zinc-900/50">
                              <div className="text-xs space-y-1">
                                {skillDefinition.kind && (
                                  <div>
                                    <span className="text-zinc-400">类型:</span>
                                    <span className="text-white">{skillDefinition.kind === 'active' ? '主动' : '被动'}</span>
                                  </div>
                                )}
                                {skillDefinition.description && (
                                  <div>
                                    <span className="text-zinc-400">描述:</span>
                                    <span className="text-white">{skillDefinition.description}</span>
                                  </div>
                                )}
                                {skillDefinition.actionPointCost !== undefined && (
                                  <div>
                                    <span className="text-zinc-400">行动点消耗:</span>
                                    <span className="text-white">{skillDefinition.actionPointCost}</span>
                                  </div>
                                )}
                                {skillDefinition.cooldownTurns > 0 && (
                                  <div>
                                    <span className="text-zinc-400">冷却回合:</span>
                                    <span className="text-white">{skillDefinition.cooldownTurns}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="mt-6 flex justify-end">
                <Button onClick={() => setShowDetails(false)}>
                  关闭
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
