import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { createRed68BattleFixture } from './fixtures/red-68-battle-fixture'

const pagesDir = resolve(process.cwd(), 'data/pages')

function readPage(relativePath: string) {
  return readFileSync(resolve(pagesDir, relativePath), 'utf8')
}

function loadTacticalGeometry() {
  const window: Record<string, unknown> = {}
  const source = readPage('js/battle-ui/battle-tactical-geometry.js')
  new Script(source, { filename: 'battle-tactical-geometry.js' }).runInContext(
    createContext({ window, globalThis: window, Math, Object }),
  )
  return window.BattleTacticalGeometry as {
    METRICS: {
      cameraTiltDeg: number
      cameraFovDeg: number
      boardBaseHeight: number
      pieceWidth: number
      pieceDepth: number
      pieceHeight: number
      panActivationPx: number
      minTouchCellPixels: number
    }
    cameraPose(input: { mapWidth: number; mapHeight: number }): {
      target: { x: number; y: number; z: number }
      position: { x: number; y: number; z: number }
    }
    screenPanDelta(input: {
      dx: number
      dy: number
      worldPerPixelX: number
      worldPerPixelY: number
      screenRight: { x: number; z: number }
      screenUp: { x: number; z: number }
    }): { x: number; z: number }
    clampTarget(input: {
      x: number
      z: number
      mapWidth: number
      mapHeight: number
    }): { x: number; z: number }
    pieceFlashStyle(faction: string, progress: number): { color: number; intensity: number }
    factionMarkerPattern(faction: string): [boolean, boolean, boolean]
  }
}

describe('RED-68 fixed tactical table fixture', () => {
  it('locks a 20×16 dense state with 8 pieces per side, 0/1/2/3 statuses, and 5/8 cards', () => {
    const fixture = createRed68BattleFixture()

    expect(fixture.map).toMatchObject({ width: 20, height: 16 })
    expect(fixture.map.tiles).toHaveLength(320)
    expect(fixture.pieces.filter((piece) => piece.faction === 'red')).toHaveLength(8)
    expect(fixture.pieces.filter((piece) => piece.faction === 'blue')).toHaveLength(8)
    expect(new Set(fixture.pieces.map((piece) => piece.statusTags.length))).toEqual(new Set([0, 1, 2, 3]))
    expect(fixture.hands['red-player']).toHaveLength(5)
    expect(fixture.hands['blue-player']).toHaveLength(8)
    expect(fixture.seed).toBe('red-68-fixed-seed-2026-08-20')
  })
})

describe('RED-68 tactical geometry', () => {
  it('uses a fixed single-axis perspective rake and low oval piece metrics', () => {
    const geometry = loadTacticalGeometry()
    const pose = geometry.cameraPose({ mapWidth: 20, mapHeight: 16 })
    const horizontalOffset = Math.hypot(
      pose.position.x - pose.target.x,
      pose.position.z - pose.target.z,
    )
    const angleFromVertical = Math.atan2(horizontalOffset, pose.position.y - pose.target.y) * 180 / Math.PI

    expect(angleFromVertical).toBeCloseTo(45, 5)
    expect(pose.target).toEqual({ x: 9.5, y: 0, z: 7.5 })
    expect(geometry.METRICS).toMatchObject({
      cameraTiltDeg: 45,
      cameraFovDeg: 35,
      boardBaseHeight: 0.72,
      pieceWidth: 0.72,
      pieceDepth: 0.56,
      pieceHeight: 0.1,
      panActivationPx: 10,
      minTouchCellPixels: 44,
    })
  })

  it('maps screen drag through the fixed camera basis and clamps every board corner into reach', () => {
    const geometry = loadTacticalGeometry()

    expect(geometry.screenPanDelta({
      dx: 12,
      dy: 10,
      worldPerPixelX: 0.04,
      worldPerPixelY: 0.05,
      screenRight: { x: 1, z: 0 },
      screenUp: { x: 0, z: -1 },
    })).toEqual({ x: -0.48, z: -0.5 })
    expect(geometry.clampTarget({ x: -20, z: 99, mapWidth: 20, mapHeight: 16 })).toEqual({ x: -0.5, z: 15.5 })
  })

  it('restores the persistent faction emissive after the transient damage flash', () => {
    const geometry = loadTacticalGeometry()

    expect(geometry.pieceFlashStyle('blue', 0.5)).toEqual({
      color: 0xff2200,
      intensity: 0.4,
    })
    expect(geometry.pieceFlashStyle('blue', 1)).toEqual({
      color: 0x3b82f6,
      intensity: 0.08,
    })
  })

  it('provides distinct one-pip and two-pip faction shapes independent of color', () => {
    const geometry = loadTacticalGeometry()

    expect(geometry.factionMarkerPattern('red')).toEqual([true, false, false])
    expect(geometry.factionMarkerPattern('blue')).toEqual([false, true, true])
  })
})

describe('RED-68 renderer and responsive UI contract', () => {
  it('loads the tactical geometry before the renderer and keeps rules out of the presentation layer', () => {
    const battlePage = readPage('battle.html')
    const renderer = readPage('js/battle-renderer-3d.js')

    expect(battlePage.indexOf('js/battle-ui/battle-tactical-geometry.js')).toBeGreaterThan(-1)
    expect(battlePage.indexOf('js/battle-ui/battle-tactical-geometry.js')).toBeLessThan(
      battlePage.indexOf('js/battle-renderer-3d.js'),
    )
    expect(renderer).toContain('window.BattleTacticalGeometry')
    expect(renderer).toContain('new THREE.PerspectiveCamera')
    expect(renderer).not.toContain('new THREE.OrthographicCamera')
    expect(renderer).toContain('_cameraTarget')
    expect(renderer).toContain('_positionCameraFromTarget')
    expect(renderer).toContain('screenToCell(clientX, clientY)')
    expect(renderer).not.toContain('_camera.position.set(_mapW / 2, 50, _mapH / 2)')
    expect(renderer).not.toContain('applyBattleAction')
  })

  it('renders low oval portrait badges and keeps touch hit geometry independent from the texture', () => {
    const renderer = readPage('js/battle-renderer-3d.js')

    expect(renderer).toContain('new THREE.CylinderGeometry(0.5, 0.5, PIECE_H')
    expect(renderer).toContain('body.scale.set(PIECE_W, 1, PIECE_D)')
    expect(renderer).toContain('portraitMesh.scale.set(PIECE_PORTRAIT_W, PIECE_PORTRAIT_D, 1)')
    expect(renderer).toMatch(/function _handleClick[\s\S]*?screenToCell/)
    expect(renderer).toMatch(/const hitRadius = Math\.max\(22,/)
    expect(renderer).toContain('factionMarkers')
    expect(renderer).toContain('TacticalGeometry.factionMarkerPattern')
  })

  it('centralizes tactical tokens and provides playable portrait, landscape, safe-area, and target-mode layouts', () => {
    const battlePage = readPage('battle.html')
    const tacticalCss = readPage('css/battle-tactical-table.css')

    expect(battlePage).toContain('css/battle-tactical-table.css')
    expect(tacticalCss).toContain('--battle-metal-edge')
    expect(tacticalCss).toContain('env(safe-area-inset-bottom)')
    expect(tacticalCss).not.toMatch(/#orientationGuard\s*\{[^}]*display:\s*none\s*!important/)
    expect(battlePage).toMatch(/@media \(orientation:\s*portrait\)[\s\S]*?#orientationGuard\s*\{\s*display:\s*grid/)
    expect(battlePage).toContain('id="orientationGuard" role="dialog" aria-modal="true"')
    expect(battlePage).toMatch(/body > :not\(#orientationGuard\):not\(script\):not\(style\)\s*\{\s*visibility:\s*hidden\s*!important/)
    expect(tacticalCss).toMatch(/\.board-view-button[\s\S]*?min-width:\s*44px[\s\S]*?min-height:\s*44px/)
    expect(tacticalCss).toMatch(/body\.target-mode-active\s+#handCards[\s\S]*?display:\s*none\s*!important/)
    expect(tacticalCss).toMatch(/body\.target-mode-active\s+#tileStatusPanel[\s\S]*?display:\s*none\s*!important/)
    expect(tacticalCss).toContain('@media (max-width: 760px)')
    expect(tacticalCss).toContain('@media (orientation: landscape) and (max-height: 500px)')
    const landscapeStart = tacticalCss.indexOf('@media (orientation: landscape) and (max-height: 500px)')
    const landscapeEnd = tacticalCss.indexOf('@media (prefers-reduced-motion: reduce)', landscapeStart)
    const landscapeBlock = tacticalCss.slice(landscapeStart, landscapeEnd)
    expect(landscapeBlock).toContain('body.target-mode-active #handCards')
    expect(landscapeBlock).toContain('body.target-mode-active #tileStatusPanel')
    expect(battlePage).toContain("(max-width: 760px), (orientation: landscape) and (max-height: 500px)")

    expect(tacticalCss).not.toContain('transition: all')
  })
  it('removes placeholder emoji from visible battle paths while neutralizing the legacy log-title anchor', () => {
    const battlePage = readPage('battle.html')
    const tacticalCss = readPage('css/battle-tactical-table.css')

    for (const placeholder of ['⚡', '💠', '🔴', '🔵', '🏆', '🏳', '💀', '🃏', '☀️', '🌑', '❌']) expect(battlePage).not.toContain(placeholder)
    expect(battlePage).toContain('class="battle-log-title" aria-label="战斗日志"')
    expect(tacticalCss).toMatch(/\.battle-log-title\s*\{[^}]*font-size:\s*0\s*!important/)
  })
})
