import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { expect, it } from 'vitest'

it('in-game gallery loading excludes PVE-only and legacy PVE templates but preserves shared pieces', async () => {
  const definitions = [
    { id: 'normal' },
    { id: 'shared', availability: { modes: ['pvp', 'pve'] } },
    { id: 'enemy', availability: { modes: ['pve'] } },
    { id: 'pve-legacy' },
  ]
  const context = createContext({
    fetchJson: async (path: string) => path.endsWith('manifest.json') ? definitions.map(p => p.id) : definitions.find(p => path.endsWith('/' + p.id + '.json')),
  })
  new Script(readFileSync('data/pages/js/gallery-content.js', 'utf8')).runInContext(context)
  new Script('let allPieces = [];').runInContext(context)
  const page = readFileSync('data/pages/pieces.html', 'utf8')
  const start = page.indexOf('    async function loadPieces()')
  new Script(page.slice(start, page.indexOf('    async function loadSkill', start))).runInContext(context)
  await new Script('loadPieces()').runInContext(context)
  expect(new Script('allPieces.map(p => p.id)').runInContext(context)).toEqual(['normal', 'shared'])
  expect(page).toContain('src="js/gallery-content.js"')
})
