import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'

const FAKE_TOKEN = 'local-test-token'
const ACCOUNT_ID = 'local-bot-account'
const MATCH_ID = 'local-match'
const PIECES = Array.from({ length: 8 }, (_, index) => `local-piece-${index}`)
const profileIdentity = getServerGameProfileIdentityV1()

describe('cloud bot CLI process lifecycle', () => {
  it('exits nonzero when native matchmaking never settles and does not print a success result', async () => {
    const sockets = new Set<Duplex>()
    const matchmakingRequests: string[] = []
    const server = createHangingOfficialServer(sockets, matchmakingRequests)
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'rvb-cloud-bot-lifecycle-'))
    const configPath = join(temporaryDirectory, 'config.json')
    let child: ChildProcessWithoutNullStreams | undefined

    try {
      const port = await listen(server)
      const config = {
        serverUrl: `http://127.0.0.1:${port}`,
        mode: 'official',
        alignment: 'light',
        pieces: PIECES,
        maxRuntimeMs: 3_000,
        maxActions: 1,
        requestTimeoutMs: 50,
      }
      writeFileSync(configPath, JSON.stringify(config), 'utf8')

      const startedAt = Date.now()
      child = spawn(process.execPath, ['scripts/ai/run-cloud-bot.mjs', '--run', configPath], {
        cwd: process.cwd(),
        env: { NODE_ENV: 'test', RVB_BOT_OFFICIAL_TOKEN: FAKE_TOKEN },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      child.stdin.end()
      const result = await waitForChild(child, 8_000)
      const elapsedMs = Date.now() - startedAt
      const output = `${result.stdout}\n${result.stderr}`

      expect(result.code).toBeGreaterThan(0)
      expect(result.signal).toBeNull()
      expect(elapsedMs).toBeLessThanOrEqual(8_000)
      expect(matchmakingRequests).toHaveLength(1)
      expect(output).toContain('[ai:cloud-bot]')
      expect(output).not.toContain(FAKE_TOKEN)
      expect(output).not.toMatch(/"status"\s*:\s*"(?:terminal|action-limit|runtime-limit|stopped)"/)
      expect(output).not.toMatch(/RVB_BOT_(?:ACCOUNT_EMAIL|PASSWORD)/)
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill()
        await waitForChild(child, 1_000).catch(() => undefined)
      }
      closeSockets(sockets)
      await closeServer(server)
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  }, 12_000)
})

function createHangingOfficialServer(sockets: Set<Duplex>, matchmakingRequests: string[]): Server {
  const server = createServer((request, response) => {
    void respond(request, response, sockets, matchmakingRequests)
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (_request, socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  return server
}

async function respond(
  request: IncomingMessage,
  response: ServerResponse,
  sockets: Set<Duplex>,
  matchmakingRequests: string[],
): Promise<void> {
  const pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`).pathname
  if (pathname.startsWith('/matchmake/joinById/')) {
    matchmakingRequests.push(pathname)
    request.resume()
    return
  }
  if (pathname === '/catalog/identity') {
    sendJson(response, { profileIdentity })
    return
  }
  if (pathname === '/official/me') {
    sendJson(response, { account: { id: ACCOUNT_ID, name: 'Local Bot' }, matchId: MATCH_ID, queued: false })
    return
  }
  if (pathname === `/official/pregame/${MATCH_ID}`) {
    sendJson(response, { phase: 'battle', players: [{ id: ACCOUNT_ID, locked: true, revision: 1 }] })
    return
  }
  sendJson(response, { error: 'not found' }, 404)
  sockets.delete(request.socket)
}

function sendJson(response: ServerResponse, payload: unknown, statusCode = 200): void {
  const body = JSON.stringify(payload)
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
  })
  response.end(body)
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('The lifecycle fixture did not receive an ephemeral port'))
        return
      }
      resolve(address.port)
    })
  })
}

function waitForChild(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<ChildResult> {
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Cloud bot CLI did not exit within ${timeoutMs}ms`)), timeoutMs)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

function closeSockets(sockets: Set<Duplex>): void {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>(resolve => server.close(() => resolve()))
}

interface ChildResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}
