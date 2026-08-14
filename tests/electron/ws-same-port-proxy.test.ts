import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
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

function extractGeneratedProxyPatch(): string {
  const stageScript = fs.readFileSync(
    path.join(root, 'scripts', 'stage-client-resources.js'),
    'utf8',
  )
  const match = stageScript.match(
    /  const patch = `([\s\S]*?)`\r?\n\r?\n  if \(!text\.startsWith\(marker\)\)/,
  )
  if (!match) throw new Error('Could not extract the standalone WebSocket proxy patch')
  return vm.runInNewContext(`\`${match[1]}\``)
}

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : null
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
  if (!port) throw new Error('Could not reserve a loopback port')
  return port
}

async function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Proxy fixture did not become ready')), 5000)
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (!String(chunk).includes('READY')) return
      clearTimeout(timer)
      resolve()
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Proxy fixture exited with ${code}: ${stderr}`))
    })
  })
}

async function connectAndReceive(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { 'x-rvb-probe': 'forwarded' } })
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error(`WebSocket timed out: ${url}`))
    }, 3000)
    socket.once('open', () => socket.send('probe'))
    socket.once('message', (data) => {
      clearTimeout(timer)
      const message = String(data)
      socket.close()
      resolve(message)
    })
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer)
      reject(new Error(`Unexpected HTTP ${response.statusCode} from ${url}`))
    })
    socket.once('error', (error) => {
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
    }, 3000)
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer)
      socket.terminate()
      resolve(response.statusCode ?? 0)
    })
    socket.once('open', () => {
      clearTimeout(timer)
      socket.close()
      reject(new Error(`Non-matching upgrade was unexpectedly proxied: ${url}`))
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

describe('standalone same-port WebSocket proxy', () => {
  it('forwards the supported public paths with valid HTTP framing', async () => {
    const publicPort = await reservePort()
    let internalPort = await reservePort()
    while (internalPort === publicPort) {
      internalPort = await reservePort()
    }
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-ws-proxy-'))
    temporaryDirectories.add(temporaryDirectory)
    const fixturePath = path.join(temporaryDirectory, 'proxy-fixture.cjs')
    const wsModulePath = require.resolve('ws')
    const proxyPatch = extractGeneratedProxyPatch()

    fs.writeFileSync(fixturePath, `${proxyPatch}

const { WebSocketServer } = require(${JSON.stringify(wsModulePath)})
const internalHttpServer = __rvbOriginalCreateServer()
const internalWebSocketServer = new WebSocketServer({ server: internalHttpServer })
internalWebSocketServer.on('connection', function(socket, request) {
  socket.on('message', function() {
    socket.send('path:' + request.url + ';header:' + request.headers['x-rvb-probe'])
  })
})

const publicServer = http.createServer(function(_request, response) {
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end('ok')
})
publicServer.on('upgrade', function(_request, socket) {
  socket.end('HTTP/1.1 418 Not Proxied\\r\\nConnection: close\\r\\n\\r\\n')
})

internalHttpServer.listen(Number(process.env.WS_PORT), '127.0.0.1', function() {
  publicServer.listen(Number(process.env.PUBLIC_PORT), '127.0.0.1', function() {
    process.stdout.write('READY\\n')
  })
})
`, 'utf8')

    const child = spawn(process.execPath, [fixturePath], {
      env: {
        ...process.env,
        PUBLIC_PORT: String(publicPort),
        WS_PORT: String(internalPort),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    children.add(child)
    await waitForReady(child)

    for (const pathname of ['/ws', '/ws/', '/ws/rooms/__lobby']) {
      await expect(
        connectAndReceive(`ws://127.0.0.1:${publicPort}${pathname}`),
      ).resolves.toBe('path:/;header:forwarded')
    }
    await expect(
      getUpgradeStatus(`ws://127.0.0.1:${publicPort}/not-websocket-proxy`),
    ).resolves.toBe(418)
  }, 15000)
})
