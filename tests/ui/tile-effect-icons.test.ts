import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const TILE_EFFECT_TYPES = [
  'flying-raijin-anchor',
  'shadow-step',
  'lethal-toxin',
  'amaterasu',
  'blizzard',
  'shishio-burn',
  'sticky-bomb',
] as const

describe('tile-effect icon registry', () => {
  const rendererPath = join(process.cwd(), 'data', 'pages', 'js', 'battle-renderer-3d.js')
  const battlePagePath = join(process.cwd(), 'data', 'pages', 'battle.html')
  const iconDirectory = join(process.cwd(), 'data', 'pages', 'images', 'tile-effects')

  it('registers all persistent effects and an unknown-type fallback in 3D', () => {
    const renderer = readFileSync(rendererPath, 'utf8')

    expect(renderer).toContain('TILE_EFFECT_VISUALS')
    for (const type of TILE_EFFECT_TYPES) expect(renderer).toContain(`'${type}'`)
    expect(renderer).toContain('fallback.svg')
  })

  it('keeps the 2D fallback metadata aligned with all persistent effects', () => {
    const battlePage = readFileSync(battlePagePath, 'utf8')

    for (const type of TILE_EFFECT_TYPES) expect(battlePage).toContain(`'${type}'`)
  })

  it.each([...TILE_EFFECT_TYPES, 'fallback'])(
    'provides a self-contained, script-free %s SVG',
    (type) => {
      const iconPath = join(iconDirectory, `${type}.svg`)
      expect(existsSync(iconPath)).toBe(true)
      const svg = readFileSync(iconPath, 'utf8')
      expect(svg).toMatch(/<svg[^>]+viewBox="0 0 64 64"/)
      expect(svg).not.toMatch(/<script/i)
      expect(svg).not.toMatch(/(?:href|src)\s*=\s*["']https?:\/\//i)
      expect(svg).toMatch(/<(path|circle|polygon|line|rect)\b/)
    },
  )

  it('uses deterministic four-slot layout for stacked effects', () => {
    const renderer = readFileSync(rendererPath, 'utf8')

    expect(renderer).toContain('TILE_EFFECT_ICON_SLOTS')
    expect(renderer).toContain('.slice(0, TILE_EFFECT_ICON_SLOTS.length)')
    expect(renderer).toContain('localeCompare')
  })
})
