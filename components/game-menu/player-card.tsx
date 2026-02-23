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

export function PlayerCard() {
  const [user, setUser] = useState<User | null>(null)

  useEffect(() => {
    // 从本地存储获取用户信息
    const storedUser = localStorage.getItem('user')
    if (storedUser) {
      try {
        setUser(JSON.parse(storedUser))
      } catch (error) {
        console.error('解析用户信息失败:', error)
        localStorage.removeItem('user')
      }
    }
  }, [])

  // 生成用户头像的首字母
  const getAvatarFallback = (username: string) => {
    return username.substring(0, 2).toUpperCase()
  }

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
    <div className="flex items-center gap-4 rounded-lg border border-border bg-card p-4">
      <Avatar className="h-12 w-12 border-2 border-primary/40">
        <AvatarFallback className="bg-primary/20 text-primary text-sm font-bold">
          {getAvatarFallback(user.username)}
        </AvatarFallback>
      </Avatar>

      <div className="flex flex-1 flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold text-foreground">{user.username}</span>
          <Button 
            size="sm" 
            variant="ghost" 
            className="h-6 px-2 text-xs" 
            onClick={() => {
              localStorage.removeItem('user')
              setUser(null)
            }}
          >
            退出
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold text-muted-foreground">
            ID: {user.id}
          </span>
        </div>
      </div>
    </div>
  )
}
