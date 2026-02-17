import { NextRequest, NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'

interface User {
  id: string
  username: string
  password: string
  createdAt: string
}

interface LoginRequest {
  username: string
  password: string
}

interface LoginResponse {
  success: boolean
  user?: User
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

    // 读取用户数据文件
    const usersFilePath = join(process.cwd(), 'data', 'users.json')
    let usersData: { users: User[] }

    try {
      const usersFileContent = readFileSync(usersFilePath, 'utf-8')
      usersData = JSON.parse(usersFileContent)
    } catch (error) {
      return NextResponse.json<LoginResponse>(
        { success: false, error: '用户数据加载失败' },
        { status: 500 }
      )
    }

    // 查找用户
    const user = usersData.users.find(
      user => user.username.toLowerCase() === username.toLowerCase() && user.password === password
    )

    if (!user) {
      return NextResponse.json<LoginResponse>(
        { success: false, error: '用户名或密码错误' },
        { status: 401 }
      )
    }

    return NextResponse.json<LoginResponse>(
      { success: true, user },
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
