import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
import { expect, it } from 'vitest'

it('training only offers PVP-ready pieces and ignores old PVE selections', () => {
  const html = readFileSync('data/pages/battle.html', 'utf8')
  const source = html.slice(html.indexOf('    function isTrainingPieceAvailable'), html.indexOf('    function fillTrainingSetupList'))
  const pieces = {
    legacy: { id: 'legacy', faction: 'good' },
    shared: { id: 'shared', faction: 'good', availability: { status: 'ready', modes: ['pvp', 'pve'] } },
    enemy: { id: 'enemy', faction: 'good', availability: { status: 'ready', modes: ['pve'] } },
    draft: { id: 'draft', faction: 'good', availability: { status: 'draft', modes: ['pvp'] } },
  }
  const context = createContext({ PIECES_BY_ID: pieces, getTemplateFactionForBattleFaction: () => 'good' })
  new Script(source).runInContext(context)
  expect(new Script("getPiecesForSetupFaction('blue').map(p => p.id).sort()").runInContext(context)).toEqual(['legacy', 'shared'])
  const resolveStart = html.indexOf('    function resolveTrainingInitialPieces')
  new Script(html.slice(resolveStart, html.indexOf('\n    function ', resolveStart + 10))).runInContext(context)
  expect(new Script("resolveTrainingInitialPieces('blue', ['enemy']).map(p => p.id)").runInContext(context)).not.toContain('enemy')
})
