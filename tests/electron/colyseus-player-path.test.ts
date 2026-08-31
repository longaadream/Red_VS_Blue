import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const PLAYER_PAGES = ['index.html', 'lobby.html', 'room.html', 'piece-selection.html', 'battle.html']

describe('RED-161 default player transport', () => {
  it('loads the Colyseus SDK before the compatibility client on every player page', async () => {
    for (const page of PLAYER_PAGES) {
      const source = await readFile(path.join(ROOT, 'data', 'pages', page), 'utf8')
      const sdk = source.indexOf('js/colyseus-sdk.js')
      const adapter = source.indexOf('js/ws-client.js')
      expect(sdk, `${page} SDK tag`).toBeGreaterThan(0)
      expect(adapter, `${page} adapter tag`).toBeGreaterThan(sdk)
    }
  })

  it('routes room and battle traffic through Colyseus without the legacy websocket endpoint', async () => {
    const source = await readFile(path.join(ROOT, 'data', 'pages', 'js', 'ws-client.js'), 'utf8')
    expect(source).toContain('new Colyseus.Client(base)')
    expect(source).toContain("_client.joinById(_roomId")
    expect(source).toContain("_room.send('battleCommand', message)")
    expect(source).toContain("_room.send('battleResync', {})")
    expect(source).not.toContain('/ws/rooms/')
    expect(source).not.toContain('new WebSocket(')
  })

  it('routes authoritative rejections through the existing action-error interaction flow', async () => {
    const source = await readFile(path.join(ROOT, 'data', 'pages', 'js', 'ws-client.js'), 'utf8')
    expect(source).toContain("message && message.kind === 'rejected' ? 'actionError' : 'battleReceipt'")
  })

  it('keeps the turn timer enabled in the manual Colyseus acceptance server', async () => {
    const source = await readFile(path.join(ROOT, 'scripts', 'run-colyseus-qa-server.mjs'), 'utf8')
    expect(source).toContain("process.env.RVB_TURN_TIMER_ENABLED = '1'")
    expect(source).not.toContain("process.env.RVB_TURN_TIMER_ENABLED = '0'")
  })

  it('preserves the opaque case-sensitive Colyseus room id at battle admission', async () => {
    const source = await readFile(path.join(ROOT, 'data', 'pages', 'battle.html'), 'utf8')
    expect(source).toContain("const roomId = (params.get('roomId') || '').trim()")
    expect(source).not.toContain("params.get('roomId') || '').trim().toLowerCase()")
  })

  it('starts and publishes the packaged Colyseus authority as the Electron local game endpoint', async () => {
    const main = await readFile(path.join(ROOT, 'electron-client', 'main.ts'), 'utf8')
    const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
    const builder = JSON.parse(await readFile(path.join(ROOT, 'electron-builder.client.json'), 'utf8'))
    expect(main).toContain("findColyseusEntry(appRoot)")
    expect(main).toContain("RVB_POSTGRES_URL: databaseUrl")
    expect(main).toContain("localUrl: `http://localhost:${actualGamePort}`")
    expect(main).toContain("var url = 'http://localhost:${actualGamePort}';")
    expect(packageJson.scripts['build:electron:client']).toContain('npm run build:colyseus')
    expect(builder.extraResources).toContainEqual({ from: '_client-colyseus', to: 'app/colyseus' })
  })

  it('keeps SQLite and Prisma out of the new Colyseus authority modules', async () => {
    const modules = [
      'battle-room.ts',
      'candidate-battle-store.ts',
      'create-colyseus-server.ts',
      'product-battle-store.ts',
    ]
    for (const moduleFile of modules) {
      const source = await readFile(path.join(ROOT, 'lib', 'server', 'colyseus', moduleFile), 'utf8')
      expect(source.toLowerCase(), moduleFile).not.toContain('sqlite')
      expect(source.toLowerCase(), moduleFile).not.toContain('prisma')
      expect(source, moduleFile).not.toMatch(/import(?!\s+type)[^\n]+room-store/)
    }
  })

  it('opens locally predictable skill targeting without a preparatory network round trip', async () => {
    const source = await readFile(path.join(ROOT, 'data', 'pages', 'battle.html'), 'utf8')
    expect(source).toContain('BattleLegalActions.probeSkillTarget({')
    expect(source).toContain('enterActionTargetMode(draftAction, localTargetProbe.preparation)')
  })

  it('installs the native server SHA-256 provider on the Colyseus hot path', async () => {
    const source = await readFile(path.join(ROOT, 'lib', 'server', 'colyseus', 'create-colyseus-server.ts'), 'utf8')
    expect(source).toContain("import { installNativeBattleSha256 } from '@/lib/server/battle-hash'")
    expect(source).toContain('installNativeBattleSha256()')
  })
})
