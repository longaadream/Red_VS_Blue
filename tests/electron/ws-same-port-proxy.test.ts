import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

const root = path.resolve(import.meta.dirname, '..', '..')
const require = createRequire(import.meta.url)
const children = new Set<ChildProcessWithoutNullStreams>()
const temporaryDirectories = new Set<string>()

afterEach(() => {
  for (const child of children) child.kill()
  children.clear()
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
  temporaryDirectories.clear()
})

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : null
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
  if (!port) throw new Error('Could not reserve a loopback port')
  return port
}

async function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Same-port fixture did not become ready')), 5_000)
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (!String(chunk).includes('READY')) return
      clearTimeout(timer)
      resolve()
    })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`Same-port fixture exited with ${code}: ${stderr}`))
    })
  })
}

async function connectAndReceive(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { 'x-rvb-probe': 'forwarded' } })
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error(`WebSocket timed out: ${url}`))
    }, 3_000)
    socket.once('open', () => socket.send('probe'))
    socket.once('message', data => {
      clearTimeout(timer)
      const message = String(data)
      socket.close()
      resolve(message)
    })
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer)
      reject(new Error(`Unexpected HTTP ${response.statusCode} from ${url}`))
    })
    socket.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function getUpgradeStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error(`Upgrade probe timed out: ${url}`))
    }, 3_000)
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer)
      socket.terminate()
      resolve(response.statusCode ?? 0)
    })
    socket.once('open', () => {
      clearTimeout(timer)
      socket.close()
      reject(new Error(`Non-game upgrade was unexpectedly claimed: ${url}`))
    })
    socket.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

describe('standalone same-origin WebSocket upgrade', () => {
  it('stages the preload alongside the standalone server', () => {
    const stageSource = fs.readFileSync(path.join(root, 'scripts', 'stage-client-resources.js'), 'utf8')
    expect(stageSource).toContain("require('./ws-same-port-server.cjs')")
    expect(stageSource).toContain("copyFile(path.join(__dirname, 'ws-same-port-server.cjs')")
    for (const entry of ['electron/main.ts', 'electron-client/main.ts']) {
      const electronSource = fs.readFileSync(path.join(root, ...entry.split('/')), 'utf8')
      expect(electronSource).toContain('findSamePortPreload(appRoot, serverEntry)')
      expect(electronSource).toContain("['--require', samePortPreload, serverEntry]")
      expect(electronSource).not.toContain('WS_PORT:')
    }
  })

  it('serves HTTP and every supported game WebSocket path on one port', async () => {
    const publicPort = await reservePort()
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-ws-same-port-'))
    temporaryDirectories.add(temporaryDirectory)
    const fixturePath = path.join(temporaryDirectory, 'same-port-fixture.cjs')
    const preloadPath = path.join(root, 'scripts', 'ws-same-port-server.cjs')
    const wsModulePath = require.resolve('ws')

    fs.writeFileSync(fixturePath, `
require(${JSON.stringify(preloadPath)})
const http = require('node:http')
const { WebSocketServer } = require(${JSON.stringify(wsModulePath)})
const wss = new WebSocketServer({ noServer: true })

globalThis.__rvbWsUpgradeHandler = function(request, socket, head) {
  wss.handleUpgrade(request, socket, head, function(client) {
    wss.emit('connection', client, request)
  })
}
wss.on('connection', function(socket, request) {
  socket.on('message', function() {
    socket.send('path:' + request.url + ';header:' + request.headers['x-rvb-probe'])
  })
})

const publicServer = http.createServer(function(_request, response) {
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end('ok')
})
publicServer.on('upgrade', function(_request, socket) {
  socket.end('HTTP/1.1 418 Not Claimed\\r\\nConnection: close\\r\\n\\r\\n')
})
publicServer.listen(Number(process.env.PUBLIC_PORT), '127.0.0.1', function() {
  process.stdout.write('READY\\n')
})
`, 'utf8')

    const child = spawn(process.execPath, [fixturePath], {
      env: { ...process.env, PUBLIC_PORT: String(publicPort) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    children.add(child)
    await waitForReady(child)

    for (const pathname of ['/ws', '/ws/', '/ws/rooms/__lobby']) {
      await expect(
        connectAndReceive(`ws://127.0.0.1:${publicPort}${pathname}`),
      ).resolves.toBe(`path:${pathname};header:forwarded`)
    }
    for (const pathname of ['/not-a-game-socket', '/ws/rooms-not-a-room']) {
      await expect(
        getUpgradeStatus(`ws://127.0.0.1:${publicPort}${pathname}`),
      ).resolves.toBe(418)
    }

    const httpResponse = await fetch(`http://127.0.0.1:${publicPort}/ws/rooms/__lobby`)
    await expect(httpResponse.text()).resolves.toBe('ok')
  }, 15_000)
})
