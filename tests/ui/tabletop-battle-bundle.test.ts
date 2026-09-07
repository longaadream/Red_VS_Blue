import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { Script, createContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const pages = resolve('data/pages')
describe('RED-186 checked-in art bundle', () => {
  it('loads production art without a preview server or automatic QA state mutations', () => {
    const html = readFileSync(resolve(pages, 'battle.html'), 'utf8')
    expect(html).not.toContain('/skin/')
    expect(html).not.toContain('showcase.js')
    for (const name of ['refinements', 'character-dock']) {
      expect(html.match(new RegExp('src="tabletop-battle/' + name + '\\.js"', 'g'))).toHaveLength(1)
      new Script(readFileSync(resolve(pages, 'tabletop-battle', name + '.js'), 'utf8'))
    }
    for (const name of readdirSync(resolve(pages, 'tabletop-battle')).filter(f => f.endsWith('.css'))) {
      const file = resolve(pages, 'tabletop-battle', name)
      for (const match of readFileSync(file, 'utf8').matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g))
        expect(existsSync(resolve(dirname(file), match[1])), name + ': ' + match[1]).toBe(true)
    }
  })
  it('keeps hidden statuses hidden and does not read private hands to draw opponent backs', () => {
    const window = {} as { BattleSkinStatusIcons: string[]; BattleEffectIcons: { resolveStatus(status: unknown): { visibility: string }; resolveStatusType(type: string): { assetPath: string } } }
    Object.defineProperty(window, 'G', { get() { throw Error('Private battle state read') } })
    const context = createContext({ window, document: { getElementById: () => null, querySelectorAll: () => [] } })
    new Script(readFileSync(resolve(pages, 'js/battle-ui/battle-effect-icons.js'), 'utf8')).runInContext(context)
    new Script(readFileSync(resolve(pages, 'tabletop-battle/refinements.js'), 'utf8')).runInContext(context)
    for (const type of ['aizen-kyoka-secret', 'shadow-ride-sweep-side']) {
      expect(window.BattleEffectIcons.resolveStatus({ type }).visibility).toBe('hidden')
    }
    for (const type of window.BattleSkinStatusIcons) {
      expect(window.BattleEffectIcons.resolveStatus({ type, visible: false }).visibility).toBe('hidden')
      const meta = window.BattleEffectIcons.resolveStatusType(type)
      expect(existsSync(resolve(pages, meta.assetPath))).toBe(true)
    }
  })
})
