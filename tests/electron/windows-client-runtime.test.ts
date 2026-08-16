import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { resolveDevelopmentProfile } from '../../electron-client/development-profile'

const root = path.resolve(__dirname, '..', '..')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

describe('Windows Electron client runtime', () => {
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
})
