import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

function viewModel() {
  const window: Record<string, unknown> = {}
  new Script(readFileSync(resolve(process.cwd(), 'data/pages/js/battle-ui/battle-view-model.js'), 'utf8'))
    .runInContext(createContext({ window, globalThis: window, console }))
  return window.BattleViewModel as { create(input: unknown): { effects: Array<{ type: string; x: number; y: number }> } }
}

function snapshot(kind: 'revolver' | 'storm') {
  return {
    map: { width: 8, height: 3, tiles: Array.from({ length: 8 }, (_, x) => ({
      x, y: 1, props: { bulletPassable: x !== 3 },
    })) },
    pieces: [{ instanceId: 'colt', ownerPlayerId: 'red', currentHp: 10, x: 1, y: 1 }],
    players: [], turn: {},
    extensions: { coltZones: { colt: { kind, dx: 1, dy: 0, turns: 2 } } },
  }
}

describe('Colt moving zone overlay', () => {
  it('shows the revolver line through the blocking tile', () => {
    const model = viewModel().create({ snapshot: snapshot('revolver') })
    expect(model.effects.filter(effect => effect.type === 'colt-zone').map(effect => effect.x)).toEqual([2, 3])
  })

  it('shows bullet storm through walls and follows the current caster position', () => {
    const state = snapshot('storm')
    const api = viewModel()
    expect(api.create({ snapshot: state }).effects.filter(effect => effect.type === 'colt-zone').map(effect => effect.x))
      .toEqual([2, 3, 4, 5, 6, 7])
    state.pieces[0].x = 2
    expect(api.create({ snapshot: state }).effects.filter(effect => effect.type === 'colt-zone').map(effect => effect.x))
      .toEqual([3, 4, 5, 6, 7])
  })
})
