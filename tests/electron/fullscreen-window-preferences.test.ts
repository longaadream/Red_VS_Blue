import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WINDOW_PREFERENCES_SCHEMA,
  getWindowPreferencesPath,
  readWindowPreferences,
  writeWindowPreferences,
} from '../../electron-client/window-preferences'

const temporaryRoots: string[] = []

function createUserDataPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-window-preferences-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('desktop window fullscreen preferences', () => {
  it('defaults to fullscreen without writing an implicit preference', () => {
    const userDataPath = createUserDataPath()

    expect(readWindowPreferences(userDataPath)).toEqual({
      schema: WINDOW_PREFERENCES_SCHEMA,
      fullscreen: true,
    })
    expect(fs.existsSync(getWindowPreferencesPath(userDataPath))).toBe(false)
  })

  it('persists an explicit choice atomically and leaves client config untouched', () => {
    const userDataPath = createUserDataPath()
    const clientConfigPath = path.join(userDataPath, 'rvb-client-config.json')
    fs.writeFileSync(clientConfigPath, JSON.stringify({ onlineUrl: 'https://example.invalid' }))

    expect(writeWindowPreferences(userDataPath, false)).toEqual({
      schema: WINDOW_PREFERENCES_SCHEMA,
      fullscreen: false,
    })
    expect(readWindowPreferences(userDataPath).fullscreen).toBe(false)
    expect(JSON.parse(fs.readFileSync(clientConfigPath, 'utf8'))).toEqual({ onlineUrl: 'https://example.invalid' })
    expect(fs.existsSync(`${getWindowPreferencesPath(userDataPath)}.tmp`)).toBe(false)
  })

  it.each([
    ['malformed JSON', '{broken'],
    ['unknown schema', JSON.stringify({ schema: 'rvb-window-preferences/v0', fullscreen: false })],
    ['invalid fullscreen value', JSON.stringify({ schema: WINDOW_PREFERENCES_SCHEMA, fullscreen: 'false' })],
  ])('logs and ignores %s', (_description, contents) => {
    const userDataPath = createUserDataPath()
    fs.writeFileSync(getWindowPreferencesPath(userDataPath), contents)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(readWindowPreferences(userDataPath)).toEqual({
      schema: WINDOW_PREFERENCES_SCHEMA,
      fullscreen: true,
    })
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('[window-preferences]'),
      expect.anything(),
    )
  })
})

describe('fullscreen Electron bridge contract', () => {
  it('keeps fullscreen state on the trusted game window and exposes no window handles', () => {
    const root = path.resolve(__dirname, '..', '..')
    const main = fs.readFileSync(path.join(root, 'electron-client', 'main.ts'), 'utf8')
    const preload = fs.readFileSync(path.join(root, 'electron-client', 'preload.ts'), 'utf8')
    const menu = fs.readFileSync(path.join(root, 'data', 'pages', 'index.html'), 'utf8')

    expect(main).toContain("fullscreen: readWindowPreferences(getUserData()).fullscreen")
    expect(main).toContain("handleTrusted('get-window-fullscreen', ['game']")
    expect(main).toContain("handleTrusted('set-window-fullscreen', ['game']")
    expect(main).toContain("assertTrustedIpcSender(event, channel, trustedTargets(roles))")
    expect(main).toContain("input.key === 'F11'")
    expect(main).toContain("win.webContents.send('window-fullscreen-changed'")
    expect(main).not.toContain("input.key === 'Escape'")
    expect(main).not.toContain('getWindowHandle')
    expect(main).not.toContain('windowHandle')

    expect(preload).toContain("ipcRenderer.invoke('get-window-fullscreen')")
    expect(preload).toContain("ipcRenderer.invoke('set-window-fullscreen'")
    expect(preload).toContain("ipcRenderer.on('window-fullscreen-changed'")
    expect(preload).not.toContain('BrowserWindow')

    expect(menu).toContain('data-window-fullscreen')
    expect(menu).toContain('getWindowFullscreen')
    expect(menu).toContain('setWindowFullscreen')
  })
})
