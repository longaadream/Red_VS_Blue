import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

function fixture() {
  const open = vi.fn()
  const selectPiece = vi.fn()
  const context = vm.createContext({ pendingSkill: null, pendingCardAction: null, pendingActionFeedback: null,
    targetSubmissionPending: false, adventureBusy: false, pendingMove: true, validMoves: new Set(['6,5']),
    myPlayerId: 'human', G: { pieces: [{ instanceId: 'captain', ownerPlayerId: 'human', currentHp: 5, x: 5, y: 5 }] },
    adventureSnapshot: { world: { sites: [{ id: 'camp', x: 5, y: 5 }, { id: 'loot', x: 6, y: 5 }] } }, open, selectPiece })
  vm.runInContext(readFileSync('data/pages/js/adventure/world-ui.js', 'utf8'), context)
  vm.runInContext('openAdventureDialog = open', context)
  return { context, open, selectPiece, click: (x: number, y: number) => vm.runInContext(`adventureOpenCell(${x},${y})`, context) }
}
describe('adventure site click priority', () => {
  it('opens the event under a living friendly piece after movement', () => {
    const { click, open, selectPiece } = fixture()
    expect(click(5, 5)).toBe(true)
    expect(open).toHaveBeenCalledWith('site', 'camp')
    expect(selectPiece).toHaveBeenCalledWith('captain')
  })
  it('preserves legal movement to an empty event cell', () => {
    const { click, open } = fixture()
    expect(click(6, 5)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
  it.each(['pendingSkill', 'pendingCardAction', 'pendingActionFeedback', 'targetSubmissionPending', 'adventureBusy'])(
    'does not intercept %s', flag => {
      const { context, click, open } = fixture(); context[flag] = true
      expect(click(5, 5)).toBe(false); expect(open).not.toHaveBeenCalled()
    })
  it.each(['pendingTargetSelection', 'pendingOptionSelection'])('preserves authoritative %s', flag => {
    const { context, click, open } = fixture(); context.G[flag] = { playerId: 'human' }
    expect(click(5, 5)).toBe(false); expect(open).not.toHaveBeenCalled()
  })
})
