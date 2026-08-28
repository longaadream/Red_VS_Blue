import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const gallery = readFileSync(resolve(process.cwd(), 'data/pages/pieces.html'), 'utf8')

describe('piece gallery content alignment', () => {
  it('filters the current good and evil piece factions as light and dark', () => {
    expect(gallery).toMatch(/id="btnLight"[^>]*setFilter\('good'\)[^>]*>光方<\/button>/)
    expect(gallery).toMatch(/id="btnDark"[^>]*setFilter\('evil'\)[^>]*>暗方<\/button>/)
    expect(gallery).toContain("f === 'good' ? ' active-light'")
    expect(gallery).toContain("f === 'evil' ? ' active-dark'")

    expect(gallery).not.toContain("setFilter('red')")
    expect(gallery).not.toContain("setFilter('blue')")
  })

  it('uses good and evil for card labels, avatar styles, and fallbacks', () => {
    expect(gallery).toContain("if (f === 'good') return 'faction-light'")
    expect(gallery).toContain("if (f === 'evil') return 'faction-dark'")
    expect(gallery).toContain('faction-label-light">光方')
    expect(gallery).toContain('faction-label-dark">暗方')
    expect(gallery).toContain("p.faction === 'good' ? '☀️'")
    expect(gallery).toContain("p.faction === 'evil' ? '🌑'")
    expect(gallery).toContain('faction-neutral')
    expect(gallery).toContain('中立')

    expect(gallery).not.toContain("p.faction === 'red'")
    expect(gallery).not.toContain("p.faction === 'blue'")
  })
})
