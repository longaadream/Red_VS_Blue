import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { resolveClientProtocolFile } from '../../electron-client/client-protocol-resource'

const temporaryRoots: string[] = []

function createRoots() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-red46-protocol-'))
  temporaryRoots.push(root)
  const appRoot = path.join(root, 'app')
  const htmlRoot = path.join(root, 'www')
  const activePackRoot = path.join(root, 'pack')
  fs.mkdirSync(path.join(appRoot, 'data', 'pieces'), { recursive: true })
  fs.mkdirSync(path.join(appRoot, 'public'), { recursive: true })
  fs.mkdirSync(path.join(appRoot, 'public', 'effect-icons'), { recursive: true })
  fs.mkdirSync(path.join(appRoot, 'public', 'tile-effects'), { recursive: true })
  fs.mkdirSync(path.join(htmlRoot, 'data', 'pieces'), { recursive: true })
  fs.mkdirSync(path.join(htmlRoot, 'images', 'terrain'), { recursive: true })
  fs.mkdirSync(path.join(activePackRoot, 'data', 'pieces'), { recursive: true })
  fs.mkdirSync(path.join(activePackRoot, 'images'), { recursive: true })
  fs.mkdirSync(path.join(activePackRoot, 'images', 'tile-effects'), { recursive: true })
  fs.mkdirSync(path.join(activePackRoot, '.rvb'), { recursive: true })
  fs.writeFileSync(path.join(htmlRoot, 'index.html'), '<html></html>')
  fs.writeFileSync(path.join(appRoot, 'data', 'pieces', 'manifest.json'), '["development"]')
  fs.writeFileSync(path.join(appRoot, 'public', 'ana.jpg'), 'development portrait')
  fs.writeFileSync(path.join(appRoot, 'public', 'watcher.jpg'), 'application portrait')
  fs.writeFileSync(path.join(appRoot, 'public', 'effect-icons', 'divine-shield.svg'), '<svg>built in</svg>')
  fs.writeFileSync(path.join(appRoot, 'public', 'tile-effects', 'amaterasu.svg'), '<svg>built in</svg>')
  fs.writeFileSync(path.join(htmlRoot, 'data', 'pieces', 'manifest.json'), '["packaged"]')
  fs.writeFileSync(path.join(htmlRoot, 'images', 'terrain', 'floor.webp'), 'page terrain')
  fs.writeFileSync(path.join(activePackRoot, 'data', 'pieces', 'manifest.json'), '["pack"]')
  fs.writeFileSync(path.join(activePackRoot, 'images', 'ana.jpg'), 'pack portrait')
  fs.writeFileSync(path.join(activePackRoot, '.rvb', 'profile.json'), JSON.stringify({
    files: [
      { descriptor: { path: 'data/pieces/manifest.json' } },
      { descriptor: { path: 'images/ana.jpg' } },
    ],
  }))
  fs.writeFileSync(path.join(activePackRoot, 'images', 'tile-effects', 'amaterasu.svg'), '<svg>pack</svg>')
  return { appRoot, htmlRoot, activePackRoot }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('Electron client protocol resource resolution', () => {
  test('serves development data from the repository while pages stay under the HTML root', () => {
    const roots = createRoots()

    expect(resolveClientProtocolFile({
      ...roots,
      activePackRoot: null,
      isPackaged: false,
      relativePath: 'data/pieces/manifest.json',
    })).toBe(path.join(roots.appRoot, 'data', 'pieces', 'manifest.json'))
    expect(resolveClientProtocolFile({
      ...roots,
      activePackRoot: null,
      isPackaged: false,
      relativePath: 'index.html',
    })).toBe(path.join(roots.htmlRoot, 'index.html'))
  })

  test('keeps active resource packs ahead of built-in development data', () => {
    const roots = createRoots()

    expect(resolveClientProtocolFile({
      ...roots,
      isPackaged: false,
      relativePath: 'data/pieces/manifest.json',
    })).toBe(path.join(roots.activePackRoot, 'data', 'pieces', 'manifest.json'))
  })

  test('never mixes bundled data into an incomplete installed Profile', () => {
    const roots = createRoots()
    fs.rmSync(path.join(roots.activePackRoot, 'data', 'pieces', 'manifest.json'))

    expect(resolveClientProtocolFile({
      ...roots,
      isPackaged: false,
      relativePath: 'data/pieces/manifest.json',
    })).toBeNull()
    expect(resolveClientProtocolFile({
      ...roots,
      isPackaged: true,
      relativePath: 'data/pieces/manifest.json',
    })).toBeNull()
  })

  test('serves page images first and falls back to public development images', () => {
    const roots = createRoots()

    expect(resolveClientProtocolFile({
      ...roots,
      activePackRoot: null,
      isPackaged: false,
      relativePath: 'images/terrain/floor.webp',
    })).toBe(path.join(roots.htmlRoot, 'images', 'terrain', 'floor.webp'))
    expect(resolveClientProtocolFile({
      ...roots,
      activePackRoot: null,
      isPackaged: false,
      relativePath: 'images/ana.jpg',
    })).toBe(path.join(roots.appRoot, 'public', 'ana.jpg'))
    expect(resolveClientProtocolFile({
      ...roots,
      isPackaged: false,
      relativePath: 'images/tile-effects/amaterasu.svg',
    })).toBe(path.join(roots.appRoot, 'public', 'tile-effects', 'amaterasu.svg'))
    expect(resolveClientProtocolFile({
      ...roots,
      isPackaged: false,
      relativePath: 'images/effect-icons/divine-shield.svg',
    })).toBe(path.join(roots.appRoot, 'public', 'effect-icons', 'divine-shield.svg'))
  })

  test('keeps active resource-pack images ahead of development fallbacks', () => {
    const roots = createRoots()

    expect(resolveClientProtocolFile({
      ...roots,
      isPackaged: false,
      relativePath: 'images/ana.jpg',
    })).toBe(path.join(roots.activePackRoot, 'images', 'ana.jpg'))
  })

  test('hard-fails a declared missing raster but keeps undeclared app art outside Profile identity', () => {
    const roots = createRoots()
    fs.rmSync(path.join(roots.activePackRoot, 'images', 'ana.jpg'))

    expect(resolveClientProtocolFile({
      ...roots,
      isPackaged: false,
      relativePath: 'images/ana.jpg',
    })).toBeNull()
    expect(resolveClientProtocolFile({
      ...roots,
      isPackaged: false,
      relativePath: 'images/watcher.jpg',
    })).toBe(path.join(roots.appRoot, 'public', 'watcher.jpg'))
  })

  test('keeps packaged resources under the staged HTML root', () => {
    const roots = createRoots()

    expect(resolveClientProtocolFile({
      ...roots,
      activePackRoot: null,
      isPackaged: true,
      relativePath: 'data/pieces/manifest.json',
    })).toBe(path.join(roots.htmlRoot, 'data', 'pieces', 'manifest.json'))
  })

  test('keeps packaged builds from falling back to repository-only images', () => {
    const roots = createRoots()

    expect(resolveClientProtocolFile({
      ...roots,
      activePackRoot: null,
      isPackaged: true,
      relativePath: 'images/ana.jpg',
    })).toBeNull()
  })

  test.each([
    '../data/pieces/manifest.json',
    'data/../pieces/manifest.json',
    'data\\pieces\\manifest.json',
    'data/private.txt',
  ])('rejects unsafe or non-allowlisted repository data path %s', (relativePath) => {
    const roots = createRoots()

    expect(resolveClientProtocolFile({
      ...roots,
      activePackRoot: null,
      isPackaged: false,
      relativePath,
    })).toBeNull()
  })
})
