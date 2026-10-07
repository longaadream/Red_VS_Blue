import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// RED-240 restores the battle integration; other pages remain separate RED-226 scope.
const pages = ['battle.html']

const read = (file: string) => readFileSync(`data/pages/${file}`, 'utf8')

describe('RED-226 shared page motion integration', () => {
  it.each(pages)('loads the shared motion CSS and deferred runtime on %s', page => {
    const source = read(page)
    expect(source).toMatch(/<link[^>]+href=["'](?:\.\/)?css\/ui-motion\.css["']/)
    expect(source).toMatch(/<script(?=[^>]*\bdefer\b)[^>]*src=["'](?:\.\/)?js\/ui-motion\.js["'][^>]*>/)
  })

  it('keeps cursor semantics and hotspots in the shared stylesheet', () => {
    const css = readFileSync('data/pages/css/ui-motion.css', 'utf8')
    expect(css).toContain('html.ui-motion-enabled')
    expect(css).toContain('cursor-default.svg") 3 3')
    expect(css).toContain('cursor-pointer.svg") 3 3')
    expect(css).toContain('cursor-target.svg") 3 3, crosshair !important')
    expect(css).toContain('cursor: not-allowed !important')
    expect(css).toContain('input[type="text"]')
  })

  it('styles actual battle interaction states without moving anchored context menus', () => {
    const css = readFileSync('data/pages/css/ui-motion.css', 'utf8')
    expect(css).toContain('.ui-motion-hover')
    expect(css).toContain('.ui-motion-pressed')
    expect(css).toContain('#handCards > .card-item.ui-motion-hover')
    expect(css).toContain('.pi-skill.ui-motion-hover')
    expect(css).toContain('#battleSettingsButton.ui-motion-pressed')
    expect(css).toContain('.topbar[data-battle-ui-region] > button.ui-motion-hover')
    expect(css).toContain('.piece-context-skill:hover')
    expect(css).toContain('.piece-context-skill:active')
    expect(css).not.toMatch(/\.piece-context-menu[^{}]*\{[^}]*transform/)
  })

  it('contains the runtime paths required for mouse, touch, reduced motion and teardown', () => {
    const runtime = readFileSync('data/pages/js/ui-motion.js', 'utf8')
    expect(runtime).toContain("'ui-motion-enabled'")
    expect(runtime).toContain("pointerType === 'mouse'")
    expect(runtime).toContain("'pointerover'")
    expect(runtime).toContain("'pointerdown'")
    expect(runtime).toContain("'pointercancel'")
    expect(runtime).toContain("'(prefers-reduced-motion: reduce)'")
    expect(runtime).toContain('cancelAnimationFrame')
    expect(runtime).toContain('visibilitychange')
    expect(runtime).toContain('pagehide')
  })
})
