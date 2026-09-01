import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { resolveDevelopmentProfile } from '../../electron-client/development-profile'
import { findFreePort } from '../../electron-client/local-port'

const root = path.resolve(__dirname, '..', '..')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

describe('Windows Electron client runtime', () => {
  test('selects another loopback port when the preferred port is already occupied publicly', async () => {
    const occupied = net.createServer()
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(0, '0.0.0.0', resolve)
    })

    const address = occupied.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected an occupied TCP port.')
    }

    try {
      const selected = await findFreePort(address.port)
      expect(selected).not.toBe(address.port)

      const verification = net.createServer()
      await new Promise<void>((resolve, reject) => {
        verification.once('error', reject)
        verification.listen(selected, '127.0.0.1', resolve)
      })
      await new Promise<void>((resolve, reject) => {
        verification.close((error) => error ? reject(error) : resolve())
      })
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupied.close((error) => error ? reject(error) : resolve())
      })
    }
  })

  test('selects another loopback port when the preferred port is occupied on loopback', async () => {
    const occupied = net.createServer()
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(0, '127.0.0.1', resolve)
    })

    const address = occupied.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected an occupied TCP port.')
    }

    try {
      const selected = await findFreePort(address.port)
      expect(selected).not.toBe(address.port)

      const verification = net.createServer()
      await new Promise<void>((resolve, reject) => {
        verification.once('error', reject)
        verification.listen(selected, '127.0.0.1', resolve)
      })
      await new Promise<void>((resolve, reject) => {
        verification.close((error) => error ? reject(error) : resolve())
      })
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupied.close((error) => error ? reject(error) : resolve())
      })
    }
  })

  test('registers the game protocol as a secure standard origin', () => {
    const source = read('electron-client/main.ts')

    expect(source).toMatch(/privileges:\s*\{[^}]*standard:\s*true[^}]*secure:\s*true[^}]*supportFetchAPI:\s*true[^}]*corsEnabled:\s*true[^}]*\}/)
    expect(source).toContain(": path.join(__dirname, '../../data/pages')")
  })

  test('resolves a development profile beneath an isolated user-data root', () => {
    const defaultUserData = path.resolve('C:/Users/test/AppData/Roaming/RED vs BLUE')

    expect(resolveDevelopmentProfile(
      ['electron.exe', 'electron-client/dist/main.js', '--rvb-dev-profile=player-one'],
      false,
      defaultUserData,
    )).toEqual({
      name: 'player-one',
      userDataPath: path.join(defaultUserData, 'dev-profiles', 'player-one'),
    })
    expect(resolveDevelopmentProfile(['electron.exe', 'electron-client/dist/main.js'], false, defaultUserData)).toBeNull()
  })

  test.each([
    '--rvb-dev-profile=',
    '--rvb-dev-profile=../escape',
    '--rvb-dev-profile=player/two',
    '--rvb-dev-profile=player\\two',
    '--rvb-dev-profile= player',
    `--rvb-dev-profile=${'a'.repeat(33)}`,
  ])('rejects unsafe development profile argument %s', (argument) => {
    expect(() => resolveDevelopmentProfile(['electron.exe', argument], false, path.resolve('user-data')))
      .toThrow(/development profile/i)
  })

  test('rejects development profiles in packaged builds and duplicate arguments everywhere', () => {
    const defaultUserData = path.resolve('user-data')

    expect(() => resolveDevelopmentProfile(
      ['client.exe', '--rvb-dev-profile=player-one'],
      true,
      defaultUserData,
    )).toThrow(/development builds/i)
    expect(() => resolveDevelopmentProfile(
      ['electron.exe', '--rvb-dev-profile=one', '--rvb-dev-profile=two'],
      false,
      defaultUserData,
    )).toThrow(/only once/i)
  })

  test('configures the profile before preserving the existing single-instance lock', () => {
    const source = read('electron-client/main.ts')
    const profileConfiguration = source.indexOf('resolveDevelopmentProfile(')
    const singleInstanceLock = source.indexOf('app.requestSingleInstanceLock()')

    expect(profileConfiguration).toBeGreaterThan(-1)
    expect(singleInstanceLock).toBeGreaterThan(profileConfiguration)
  })

  test('uses a distinct embedded PostgreSQL cluster for every named development profile', () => {
    const defaultUserData = path.resolve('C:/Users/test/AppData/Roaming/RED vs BLUE')
    const first = resolveDevelopmentProfile(
      ['electron.exe', '--rvb-dev-profile=player-one'],
      false,
      defaultUserData,
    )!
    const second = resolveDevelopmentProfile(
      ['electron.exe', '--rvb-dev-profile=player-two'],
      false,
      defaultUserData,
    )!
    const firstDatabase = path.join(first.userDataPath, 'postgres', '16')
    const secondDatabase = path.join(second.userDataPath, 'postgres', '16')
    const source = read('electron-client/main.ts')

    expect(firstDatabase).not.toBe(secondDatabase)
    expect(source).toContain("stateRoot: path.join(getUserData(), 'postgres', '16')")
    expect(source).toContain('RVB_POSTGRES_URL: databaseUrl')
    expect(source).not.toContain("path.join(userData, 'game.db')")
    expect(source).not.toContain('initDatabase(')
  })

  test('shows identity initialization and save failures instead of swallowing them', () => {
    const page = read('data/pages/index.html')

    expect(page).toContain('id="identityError"')
    expect(page).toContain('function showIdentityError(')
    expect(page).toContain('function assertIdentityPersisted(')
    expect(page).toContain("assertIdentityPersisted(created, '初始化账号')")
    expect(page).toContain("assertIdentityPersisted(updated, '保存名称')")
    expect(page).not.toMatch(/ensureIdentity\(\)\s*}\s*catch\s*\{\s*}/)
    expect(page).toContain("showIdentityError(e, '初始化账号')")
    expect(page).toContain("showIdentityError(e, '保存名称')")
  })
  test('starts the packaged host on every interface with candidate authority features enabled', () => {
    const clientMain = read('electron-client/main.ts')
    const profileRuntime = clientMain.slice(
      clientMain.indexOf('async function startLocalServer('),
      clientMain.indexOf('type JsonObject ='),
    )
    const gameAuthority = clientMain.slice(
      clientMain.indexOf('async function startLocalGameAuthorityOnce('),
      clientMain.indexOf('function findServerEntry('),
    )

    expect(gameAuthority).toContain("RVB_COLYSEUS_HOST: '0.0.0.0'")
    expect(gameAuthority).toContain("RVB_TURN_TIMER_ENABLED: '1'")
    expect(gameAuthority).toContain('RVB_POSTGRES_URL: databaseUrl')
    expect(profileRuntime).toContain("HOSTNAME: '0.0.0.0'")
    expect(profileRuntime).not.toContain('DISABLE_WS')
    expect(profileRuntime).not.toContain('RVB_BATTLE_AUTHORITY_V2')
    expect(clientMain).not.toContain("HOSTNAME: '127.0.0.1'")
  })

  test('classifies Radmin 26/8 addresses as LAN without HTTPS upgrade', () => {
    const utilities = read('data/pages/js/server-utils.js')
    const websocket = read('data/pages/js/colyseus-client.js')

    expect(utilities).toMatch(/26\\\./)
    expect(websocket).toContain("if (base && !/^[a-z]+:\\/\\//i.test(base)) base = 'http://' + base")
    expect(websocket).not.toContain("base = 'https://' + base")
  })

})
