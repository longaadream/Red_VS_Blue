import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

interface User {
  id: string
  username: string
  password: string
  createdAt: string
}

interface RegisterRequest {
  username: string
  password: string
}

interface RegisterResponse {
  success: boolean
  user?: User
  error?: string
}

function generateUserId(): string {
  return 'user_' + Date.now() + '_' + Math.floor(Math.random() * 10000)
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

    // 读取用户数据文件
    const usersFilePath = join(process.cwd(), 'data', 'users.json')
    let usersData: { users: User[] }

    try {
      const usersFileContent = readFileSync(usersFilePath, 'utf-8')
      usersData = JSON.parse(usersFileContent)
    } catch (error) {
      usersData = { users: [] }
    }

    // 检查用户名是否已存在
    const existingUser = usersData.users.find(user => user.username.toLowerCase() === username.toLowerCase())
    if (existingUser) {
      return NextResponse.json<RegisterResponse>(
        { success: false, error: '用户名已存在' },
        { status: 400 }
      )
    }

    // 创建新用户
    const newUser: User = {
      id: generateUserId(),
      username,
      password, // 注意：在实际应用中，应该对密码进行加密
      createdAt: new Date().toISOString()
    }

    // 添加新用户到数据中
    usersData.users.push(newUser)

    // 写回文件
    writeFileSync(usersFilePath, JSON.stringify(usersData, null, 2), 'utf-8')

    return NextResponse.json<RegisterResponse>(
      { success: true, user: newUser },
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
