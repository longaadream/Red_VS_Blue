import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'

interface LoginRequest {
  username: string
  password: string
}

interface LoginResponse {
  success: boolean
  user?: { id: string; username: string; createdAt: string }
  error?: string
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as LoginRequest
    const { username, password } = body

    if (!username || !password) {
      return NextResponse.json<LoginResponse>(
        { success: false, error: '用户名和密码不能为空' },
        { status: 400 }
      )
    }

    const user = await prisma.user.findUnique({
      where: { username: username.toLowerCase() }
    })

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return NextResponse.json<LoginResponse>(
        { success: false, error: '用户名或密码错误' },
        { status: 401 }
      )
    }

    return NextResponse.json<LoginResponse>(
      { success: true, user: { id: user.id.toLowerCase(), username: user.username, createdAt: user.createdAt.toISOString() } },
      { status: 200 }
    )
  } catch (error) {
    console.error('登录失败:', error)
    return NextResponse.json<LoginResponse>(
      { success: false, error: '登录失败，请重试' },
      { status: 500 }
    )
  }
}
