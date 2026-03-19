"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { ArrowLeft, Trophy, Swords, Shield, Clock, TrendingUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

interface PieceInfo {
  templateId: string
  name: string
}

interface GameRecord {
  id: string
  playerId: string
  playerName: string
  opponentId?: string
  opponentName?: string
  result: "win" | "loss"
  turns: number
  myPieces: PieceInfo[]
  opponentPieces: PieceInfo[]
  roomId?: string
  mapId?: string
  createdAt: string
}

interface Stats {
  total: number
  wins: number
  losses: number
  winRate: number
}

export default function HistoryPage() {
  const [playerId, setPlayerId] = useState<string | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [records, setRecords] = useState<GameRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const stored = localStorage.getItem("user")
    if (stored) {
      try {
        const user = JSON.parse(stored)
        setPlayerId(user.id)
      } catch {
        setLoading(false)
        return
      }
    } else {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!playerId) return
    fetch(`/api/records?playerId=${encodeURIComponent(playerId)}`)
      .then(r => r.json())
      .then(data => {
        setStats(data.stats ?? null)
        setRecords(data.records ?? [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [playerId])

  function formatDate(iso: string) {
    const d = new Date(iso)
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 px-4 py-8">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="icon">
            <Link href="/"><ArrowLeft className="h-4 w-4" /></Link>
          </Button>
          <h1 className="text-xl font-bold">战绩记录</h1>
        </div>

        {/* Not logged in */}
        {!loading && !playerId && (
          <Card className="bg-zinc-900 border-zinc-800">
            <CardContent className="py-8 text-center text-zinc-400">
              请先登录以查看战绩
              <div className="mt-4 flex justify-center gap-3">
                <Button asChild size="sm" className="bg-blue-600 hover:bg-blue-700">
                  <Link href="/auth/login">登录</Link>
                </Button>
                <Button asChild size="sm" className="bg-green-600 hover:bg-green-700">
                  <Link href="/auth/register">注册</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {loading && (
          <Card className="bg-zinc-900 border-zinc-800">
            <CardContent className="py-8 text-center text-zinc-400">加载中...</CardContent>
          </Card>
        )}

        {/* Stats summary */}
        {stats && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Card className="bg-zinc-900 border-zinc-800">
              <CardContent className="pt-4 pb-3 text-center">
                <div className="flex justify-center mb-1">
                  <TrendingUp className="h-4 w-4 text-yellow-400" />
                </div>
                <p className="text-2xl font-black text-yellow-400">{stats.winRate}%</p>
                <p className="text-xs text-zinc-500 mt-0.5">胜率</p>
              </CardContent>
            </Card>
            <Card className="bg-zinc-900 border-zinc-800">
              <CardContent className="pt-4 pb-3 text-center">
                <div className="flex justify-center mb-1">
                  <Swords className="h-4 w-4 text-zinc-400" />
                </div>
                <p className="text-2xl font-black">{stats.total}</p>
                <p className="text-xs text-zinc-500 mt-0.5">总对局</p>
              </CardContent>
            </Card>
            <Card className="bg-zinc-900 border-zinc-800">
              <CardContent className="pt-4 pb-3 text-center">
                <div className="flex justify-center mb-1">
                  <Trophy className="h-4 w-4 text-green-400" />
                </div>
                <p className="text-2xl font-black text-green-400">{stats.wins}</p>
                <p className="text-xs text-zinc-500 mt-0.5">胜场</p>
              </CardContent>
            </Card>
            <Card className="bg-zinc-900 border-zinc-800">
              <CardContent className="pt-4 pb-3 text-center">
                <div className="flex justify-center mb-1">
                  <Shield className="h-4 w-4 text-red-400" />
                </div>
                <p className="text-2xl font-black text-red-400">{stats.losses}</p>
                <p className="text-xs text-zinc-500 mt-0.5">败场</p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Records list */}
        {stats && records.length === 0 && (
          <Card className="bg-zinc-900 border-zinc-800">
            <CardContent className="py-8 text-center text-zinc-400">暂无对局记录</CardContent>
          </Card>
        )}

        {records.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-zinc-400 px-1">历史对局</h2>
            {records.map(record => (
              <Card key={record.id} className="bg-zinc-900 border-zinc-800">
                <CardContent className="py-3 px-4">
                  <div className="flex items-start justify-between gap-3">
                    {/* Left: result + opponent */}
                    <div className="flex items-center gap-3 min-w-0">
                      <Badge
                        className={`text-xs px-2 py-0.5 shrink-0 font-bold ${
                          record.result === "win"
                            ? "bg-green-500/20 text-green-400 border border-green-500/30"
                            : "bg-red-500/20 text-red-400 border border-red-500/30"
                        }`}
                        variant="outline"
                      >
                        {record.result === "win" ? "胜" : "负"}
                      </Badge>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          vs {record.opponentName || record.opponentId || "未知对手"}
                        </p>
                        <div className="flex items-center gap-1 mt-0.5 text-xs text-zinc-500">
                          <Clock className="h-3 w-3" />
                          <span>{record.turns} 回合</span>
                          <span className="mx-1">·</span>
                          <span>{formatDate(record.createdAt)}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Pieces row */}
                  <div className="mt-2.5 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <p className="text-zinc-500 mb-1">我方出战</p>
                      <div className="flex flex-wrap gap-1">
                        {record.myPieces.map((p, i) => (
                          <span key={i} className="bg-blue-900/40 text-blue-300 border border-blue-700/30 rounded px-1.5 py-0.5">
                            {p.name}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-zinc-500 mb-1">对方出战</p>
                      <div className="flex flex-wrap gap-1">
                        {record.opponentPieces.map((p, i) => (
                          <span key={i} className="bg-red-900/40 text-red-300 border border-red-700/30 rounded px-1.5 py-0.5">
                            {p.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
