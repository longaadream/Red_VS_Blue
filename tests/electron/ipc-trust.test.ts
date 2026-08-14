import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, test } from 'vitest'
import * as clientTrust from '../../electron-client/ipc-trust'
import * as editorTrust from '../../electron-editor/ipc-trust'
import * as serverTrust from '../../electron/ipc-trust'

type TrustModule = typeof clientTrust

function trustedFixture(frameUrl: string) {
  const mainFrame = { url: frameUrl }
  const webContents = {
    id: 17,
    mainFrame,
    isDestroyed: () => false,
  }
  const window = {
    webContents,
    isDestroyed: () => false,
  }
  return {
    event: { sender: webContents, senderFrame: mainFrame },
    target: {
      role: 'dashboard',
      window,
      allowUrl: (url: string) => url === frameUrl,
    },
  }
}

describe.each([
  ['server', serverTrust],
  ['client', clientTrust],
  ['editor', editorTrust],
] as const)('%s Electron IPC sender trust', (_name, trust: TrustModule) => {
  test('accepts only the exact trusted window main frame and URL', () => {
    const fixture = trustedFixture('file:///trusted/index.html')

    expect(trust.assertTrustedIpcSender(
      fixture.event,
      'safe-channel',
      [fixture.target],
    )).toBe(fixture.target)
  })

  test('rejects an iframe even when it belongs to the trusted WebContents', () => {
    const fixture = trustedFixture('file:///trusted/index.html')
    const iframe = { url: 'file:///trusted/frame.html' }

    expect(() => trust.assertTrustedIpcSender(
      { ...fixture.event, senderFrame: iframe },
      'dangerous-channel',
      [fixture.target],
    )).toThrow(/main frame/i)
  })

  test('rejects another window and a disallowed main-frame URL', () => {
    const fixture = trustedFixture('file:///trusted/index.html')
    const otherMainFrame = { url: 'file:///trusted/index.html' }
    const otherSender = { id: 99, mainFrame: otherMainFrame, isDestroyed: () => false }

    expect(() => trust.assertTrustedIpcSender(
      { sender: otherSender, senderFrame: otherMainFrame },
      'dangerous-channel',
      [fixture.target],
    )).toThrow(/trusted window/i)

    fixture.event.senderFrame.url = 'https://attacker.invalid/'
    expect(() => trust.assertTrustedIpcSender(
      fixture.event,
      'dangerous-channel',
      [fixture.target],
    )).toThrow(/URL/i)
  })

  test('rejects a missing sender frame and a destroyed trusted window', () => {
    const fixture = trustedFixture('file:///trusted/index.html')

    expect(() => trust.assertTrustedIpcSender(
      { ...fixture.event, senderFrame: null },
      'dangerous-channel',
      [fixture.target],
    )).toThrow(/sender frame/i)

    fixture.target.window.isDestroyed = () => true
    expect(() => trust.assertTrustedIpcSender(
      fixture.event,
      'dangerous-channel',
      [fixture.target],
    )).toThrow(/trusted window/i)
  })
})

describe('trusted file URL boundary', () => {
  test.each([serverTrust, clientTrust, editorTrust])('uses path boundaries instead of string prefixes', (trust) => {
    const root = path.resolve('C:/rvb/dashboard')
    expect(trust.isFileUrlWithinRoot(pathToFileURL(path.join(root, 'index.html')).toString(), root)).toBe(true)
    expect(trust.isFileUrlWithinRoot(pathToFileURL(`${root}-attacker/index.html`).toString(), root)).toBe(false)
    expect(trust.isFileUrlWithinRoot('https://attacker.invalid/', root)).toBe(false)
  })
})
