import { spawn } from 'node:child_process'
import path from 'node:path'

import { NextRequest } from 'next/server'
import { afterEach, describe, expect, test } from 'vitest'

import { proxy } from '../../proxy'

const originalActivationId = process.env.RVB_PROFILE_ACTIVATION_ID
const originalAdmissionPause = process.env.RVB_PROFILE_ADMISSION_PAUSED

afterEach(() => {
  if (originalActivationId === undefined) delete process.env.RVB_PROFILE_ACTIVATION_ID
  else process.env.RVB_PROFILE_ACTIVATION_ID = originalActivationId
  if (originalAdmissionPause === undefined) delete process.env.RVB_PROFILE_ADMISSION_PAUSED
  else process.env.RVB_PROFILE_ADMISSION_PAUSED = originalAdmissionPause
})

function request(pathname: string, method = 'GET'): NextRequest {
  return new NextRequest(`http://127.0.0.1:3000${pathname}`, { method })
}

async function probeWebSocketUpgrade(route: string): Promise<{
  statusLine: string
  gameHandlerCalls: number
}> {
  const preloadPath = path.resolve(process.cwd(), 'scripts', 'ws-same-port-server.cjs')
  const source = String.raw`
    const http = require('node:http')
    const net = require('node:net')
    process.env.RVB_PROFILE_ADMISSION_PAUSED = 'activation-test'
    require(process.argv[1])
    let gameHandlerCalls = 0
    globalThis.__rvbWsUpgradeHandler = (_request, socket) => {
      gameHandlerCalls += 1
      socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    }
    const server = http.createServer((_request, response) => response.end())
    const fail = (error) => {
      console.error(error && error.stack ? error.stack : String(error))
      try { server.close() } catch {}
      process.exitCode = 1
    }
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const socket = net.connect(address.port, '127.0.0.1')
      let response = ''
      socket.setEncoding('utf8')
      socket.once('error', fail)
      socket.on('data', chunk => { response += chunk })
      socket.once('connect', () => {
        socket.write(
          'GET ' + process.argv[2] + ' HTTP/1.1\r\n'
          + 'Host: 127.0.0.1\r\n'
          + 'Connection: Upgrade\r\n'
          + 'Upgrade: websocket\r\n'
          + 'Sec-WebSocket-Version: 13\r\n'
          + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
          + '\r\n'
        )
      })
      socket.once('close', () => {
        console.log(JSON.stringify({
          statusLine: response.split('\r\n')[0],
          gameHandlerCalls,
        }))
        server.close()
      })
    })
    setTimeout(() => fail(new Error('upgrade timeout')), 3000).unref()
  `

  return await new Promise<{
    statusLine: string
    gameHandlerCalls: number
  }>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source, preloadPath, route], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve(JSON.parse(stdout.trim()))
      else reject(new Error(stderr || stdout || `child exited ${code}`))
    })
  })
}

describe('RED-115 Profile activation admission gate', () => {
  test('rejects ordinary API traffic while activation admission is paused', async () => {
    process.env.RVB_PROFILE_ADMISSION_PAUSED = 'activation-test'

    const response = proxy(request('/api/rooms'))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: 'PROFILE_ACTIVATION_IN_PROGRESS',
    })
    expect(response.headers.get('retry-after')).toBe('1')
  })

  test.each([
    '/api/ping',
    '/api/content-profile',
    '/api/content-profile/activation/commit',
  ])('keeps the Profile control plane available at %s', (pathname) => {
    process.env.RVB_PROFILE_ACTIVATION_ID = 'activation-test'

    const response = proxy(request(pathname))

    expect(response.status).toBe(200)
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })

  test('allows Profile admin headers in CORS preflight', () => {
    process.env.RVB_PROFILE_ADMISSION_PAUSED = 'activation-test'

    const response = proxy(request('/api/content-profile/install', 'OPTIONS'))

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-headers')).toContain('x-rvb-profile-admin-key')
    expect(response.headers.get('access-control-allow-headers')).toContain('x-rvb-local-dev-profile')
  })

  test('rejects ordinary game WebSocket upgrades while paused', async () => {
    await expect(probeWebSocketUpgrade('/ws/rooms/game-1'))
      .resolves.toEqual({
        statusLine: 'HTTP/1.1 503 Profile Activation In Progress',
        gameHandlerCalls: 0,
      })
  })

  test('handles the Profile health probe without entering the game RPC handler', async () => {
    await expect(probeWebSocketUpgrade('/ws/rooms/__profile-health__'))
      .resolves.toEqual({
        statusLine: 'HTTP/1.1 101 Switching Protocols',
        gameHandlerCalls: 0,
      })
  })
})
