"use client"

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface User {
  id: string
  username: string
  password: string
  createdAt: string
}

interface Stats {
  total: number
  wins: number
  losses: number
  winRate: number
}

export function PlayerCard() {
  const [user, setUser] = useState<User | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)

  useEffect(() => {
    const storedUser = localStorage.getItem('user')
    if (storedUser) {
      try {
        const parsed = JSON.parse(storedUser) as User
        setUser(parsed)
        // 拉取战绩统计
        fetch(`/api/records?playerId=${encodeURIComponent(parsed.id)}`)
          .then(r => r.json())
          .then(data => setStats(data.stats))
          .catch(() => {})
      } catch {
        localStorage.removeItem('user')
      }
    }
  }, [])

  const getAvatarFallback = (username: string) => username.substring(0, 2).toUpperCase()

  // 未登录状态
  if (!user) {
    return (
      <Card className="bg-zinc-900/50 border-zinc-800">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-zinc-300">用户登录</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-zinc-400">登录后可以保存游戏进度和个人数据</p>
          <div className="flex gap-2">
            <Button asChild size="sm" className="flex-1 bg-blue-600 hover:bg-blue-700 text-white">
              <Link href="/auth/login">登录</Link>
            </Button>
            <Button asChild size="sm" className="flex-1 bg-green-600 hover:bg-green-700 text-white">
              <Link href="/auth/register">注册</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  // 登录状态
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-4">
        <Avatar className="h-12 w-12 border-2 border-primary/40">
          <AvatarFallback className="bg-primary/20 text-primary text-sm font-bold">
            {getAvatarFallback(user.username)}
          </AvatarFallback>
        </Avatar>

        <div className="flex flex-1 flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold text-foreground">{user.username}</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => {
                localStorage.removeItem('user')
                setUser(null)
                setStats(null)
              }}
            >
              退出
            </Button>
          </div>
          <span className="text-[10px] text-muted-foreground">ID: {user.id}</span>
        </div>
      </div>

      {/* 战绩统计 */}
      {stats && (
        <div className="grid grid-cols-4 divide-x divide-border border-t border-border pt-3 text-center">
          <div>
            <p className="text-base font-black text-yellow-400">{stats.winRate}%</p>
            <p className="text-[10px] text-muted-foreground">胜率</p>
          </div>
          <div>
            <p className="text-base font-black">{stats.total}</p>
            <p className="text-[10px] text-muted-foreground">总局</p>
          </div>
          <div>
            <p className="text-base font-black text-green-400">{stats.wins}</p>
            <p className="text-[10px] text-muted-foreground">胜</p>
          </div>
          <div>
            <p className="text-base font-black text-red-400">{stats.losses}</p>
            <p className="text-[10px] text-muted-foreground">负</p>
          </div>
        </div>
      )}
    </div>
  )
}
