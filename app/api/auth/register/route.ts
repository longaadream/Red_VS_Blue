import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'

interface RegisterRequest {
  username: string
  password: string
}

interface RegisterResponse {
  success: boolean
  user?: { id: string; username: string; createdAt: string }
  error?: string
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as RegisterRequest
    const { username, password } = body

    if (!username || !password) {
      return NextResponse.json<RegisterResponse>(
        { success: false, error: '用户名和密码不能为空' },
        { status: 400 }
      )
    }

    if (username.length < 3 || username.length > 20) {
      return NextResponse.json<RegisterResponse>(
        { success: false, error: '用户名长度应在3-20个字符之间' },
        { status: 400 }
      )
    }

    if (password.length < 6) {
      return NextResponse.json<RegisterResponse>(
        { success: false, error: '密码长度至少为6个字符' },
        { status: 400 }
      )
    }

    const lowerUsername = username.toLowerCase()
    const existing = await prisma.user.findUnique({
      where: { username: lowerUsername }
    })
    if (existing) {
      return NextResponse.json<RegisterResponse>(
        { success: false, error: '用户名已存在' },
        { status: 400 }
      )
    }

    const passwordHash = await bcrypt.hash(password, 10)
    const newUser = await prisma.user.create({
      data: { username: lowerUsername, passwordHash }
    })

    return NextResponse.json<RegisterResponse>(
      { success: true, user: { id: newUser.id, username: newUser.username, createdAt: newUser.createdAt.toISOString() } },
      { status: 201 }
    )
  } catch (error) {
    console.error('注册失败:', error)
    return NextResponse.json<RegisterResponse>(
      { success: false, error: '注册失败，请重试' },
      { status: 500 }
    )
  }
}
