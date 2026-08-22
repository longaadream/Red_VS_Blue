import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

const rootDir = process.cwd()
const pagesDir = resolve(rootDir, 'data/pages')
const standeeDir = resolve(pagesDir, 'public/standees')

type StandeeEntry = {
  templateId: string
  status: 'ready' | 'portrait-fallback'
  src: string | null
}

function readPage(relativePath: string) {
  return readFileSync(resolve(pagesDir, relativePath), 'utf8')
}

function pngHeader(path: string) {
  const bytes = readFileSync(path)
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
  }
}

function loadRuntimeManifest() {
  const window: Record<string, unknown> = {}
  new Script(readPage('js/battle-ui/battle-standee-manifest.js'), {
    filename: 'battle-standee-manifest.js',
  }).runInContext(createContext({ window, globalThis: window, Object, String }))
  return window.BattleStandeeManifest as {
    schemaVersion: number
    canvas: { width: number; height: number; baselineY: number; safeMarginPx: number }
    fallback: string
    entries: Record<string, StandeeEntry>
    resolve(templateId: string): StandeeEntry | null
  }
}

describe('RED-102 paper-puppet asset contract', () => {
  it('maps every current piece explicitly and keeps only the three approved samples ready', () => {
    const manifest = JSON.parse(readFileSync(resolve(standeeDir, 'manifest.json'), 'utf8')) as {
      schemaVersion: number
      canvas: { width: number; height: number; baselineY: number; safeMarginPx: number; background: string }
      fallback: string
      entries: StandeeEntry[]
    }
    const roster = readdirSync(resolve(rootDir, 'data/pieces'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => String(JSON.parse(readFileSync(resolve(rootDir, 'data/pieces', name), 'utf8')).id || ''))
      .filter(Boolean)
      .sort()
    const manifestIds = manifest.entries.map((entry) => entry.templateId).sort()
    const ready = manifest.entries.filter((entry) => entry.status === 'ready')

    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.canvas).toMatchObject({
      width: 512,
      height: 1024,
      baselineY: 932,
      safeMarginPx: 32,
      background: 'transparent',
    })
    expect(manifest.fallback).toBe('portrait-token')
    expect(manifestIds).toEqual(roster)
    expect(roster).toHaveLength(26)
    expect(ready.map((entry) => entry.templateId).sort()).toEqual(['arthas', 'blue-naruto', 'jaina'])
    expect(manifest.entries.filter((entry) => entry.status === 'portrait-fallback')).toHaveLength(23)

    ready.forEach((entry) => {
      expect(entry.src).toBeTruthy()
      const assetPath = resolve(pagesDir, entry.src!.replace(/^public\//, 'public/'))
      expect(existsSync(assetPath)).toBe(true)
      expect(pngHeader(assetPath)).toEqual({ width: 512, height: 1024, bitDepth: 8, colorType: 6 })
    })
  })

  it('keeps the browser manifest identical to the pipeline manifest', () => {
    const jsonManifest = JSON.parse(readFileSync(resolve(standeeDir, 'manifest.json'), 'utf8')) as {
      schemaVersion: number
      canvas: { width: number; height: number; baselineY: number; safeMarginPx: number }
      fallback: string
      entries: StandeeEntry[]
    }
    const runtime = loadRuntimeManifest()

    expect(runtime.schemaVersion).toBe(jsonManifest.schemaVersion)
    expect(runtime.canvas).toEqual({
      width: jsonManifest.canvas.width,
      height: jsonManifest.canvas.height,
      baselineY: jsonManifest.canvas.baselineY,
      safeMarginPx: jsonManifest.canvas.safeMarginPx,
    })
    expect(runtime.fallback).toBe(jsonManifest.fallback)
    expect(Object.values(runtime.entries)).toEqual(jsonManifest.entries)
    expect(runtime.resolve('blue-naruto')?.src).toBe('public/standees/blue-naruto.png')
    expect(runtime.resolve('missing-role')).toBeNull()
  })
})

describe('RED-102 paper-puppet presentation contract', () => {
  it('loads the explicit standee manifest before the renderer and the paper skin last', () => {
    const page = readPage('battle.html')

    expect(page.indexOf('js/battle-ui/battle-standee-manifest.js')).toBeGreaterThan(-1)
    expect(page.indexOf('js/battle-ui/battle-standee-manifest.js')).toBeLessThan(page.indexOf('js/battle-renderer-3d.js'))
    expect(page.indexOf('css/battle-paper-puppet.css')).toBeGreaterThan(page.indexOf('css/battle-tactical-table.css'))
    expect(page).toContain('行动 1 · 选择路线')
    expect(page).toContain('piece-context-skill-icon"><img')
    expect(page).not.toContain('>结束回合 →</button>')
    expect(page).not.toContain("btnEnd.textContent = inAction ? '结束回合 ->'")
  })

  it('uses transparent vertical standees while retaining the RED-68 portrait and cell hit fallback', () => {
    const renderer = readPage('js/battle-renderer-3d.js')

    expect(renderer).toContain('StandeeManifest.resolve(templateId)')
    expect(renderer).toContain('standeeUrl(piece.templateId)')
    expect(renderer).toContain("entry.status !== 'ready'")
    expect(renderer).toContain("standeeMesh.userData.motionRole = 'paper-standee'")
    expect(renderer).toContain("portraitMesh.userData.motionRole = 'portrait-fallback'")
    expect(renderer).toContain('obj.standeeMesh.visible = false')
    expect(renderer).toContain('obj.portraitMesh.visible = true')
    expect(renderer).toContain('transparent: true')
    expect(renderer).toContain('alphaTest: 0.08')
    expect(renderer).toContain('screenToCell(clientX, clientY)')
    expect(renderer).toMatch(/function _handleClick[\s\S]*?screenToCell/)
    expect(renderer).toContain('function portraitUrl(portraitRef)')
    expect(renderer).not.toMatch(/piece\.templateId\s*\+\s*['"]\.png/)
  })

  it('uses a real paper texture and avoids generated CSS gradients in the RED-102 layer', () => {
    const css = readPage('css/battle-paper-puppet.css')
    const renderer = readPage('js/battle-renderer-3d.js')

    expect(existsSync(resolve(standeeDir, 'paper-board-texture.png'))).toBe(true)
    for (const asset of ['terrain-wall.png', 'terrain-cover.png']) {
      expect(pngHeader(resolve(standeeDir, asset))).toEqual({
        width: 512,
        height: 512,
        bitDepth: 8,
        colorType: 6,
      })
    }
    expect(css).toContain("url('../public/standees/paper-board-texture.png')")
    expect(css).not.toMatch(/(?:linear|radial|conic)-gradient/)
    expect(css).toContain('.piece-context-skill-icon img')
    expect(css).toContain('.turn-clock')
    expect(css).toContain('#tileStatusPanel')
    expect(renderer).toContain("loadTexture('public/standees/paper-board-texture.png'")
    expect(renderer).toContain('texture.wrapS = THREE.RepeatWrapping')
    expect(renderer).toContain("wall: Object.freeze({ src: 'public/standees/terrain-wall.png'")
    expect(renderer).toContain("cover: Object.freeze({ src: 'public/standees/terrain-cover.png'")
    expect(renderer).toContain("prop.userData.motionRole = 'paper-terrain'")
    expect(renderer).toContain('const tileRenderHeight = TERRAIN_PROP_VISUALS[type] ? tileHeight : tileVisualHeight')
    expect(renderer).toContain('mat.opacity = 0.10')
  })
})
