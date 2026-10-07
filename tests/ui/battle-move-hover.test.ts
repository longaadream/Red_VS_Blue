/* eslint-disable @typescript-eslint/no-explicit-any -- Runs the actual page hover handler with a reentrant viewport callback. */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
const page = readFileSync('data/pages/battle.html', 'utf8')
const branch = page.slice(page.indexOf("      if (intent.type === 'hover-cell')"), page.indexOf("      if (intent.type === 'viewport-change')"))
const helperStart = page.indexOf('    function updateMoveHoverPath(')
const helper = helperStart < 0 ? '' : page.slice(helperStart, page.indexOf('    function normalMovePathForTarget(', helperStart))
function setup(use3d = true) {
  const ctx: any = { moveDraft: null, pendingSkill: null, pendingMove: true, selectedPieceId: 'p',
    hoverMovePath: [], validMoves: new Set(['2,1', '3,1']), waitingForOtherPending: () => false,
    previewSkillTarget: vi.fn(), _use3d: use3d, currentBattleViewModel: { interaction: {}, legal: { moveCells: [{x:2,y:1}] } },
    normalMovePathForTarget: (_id: string, x: number, y: number) => [{x,y}],
  }
  let count = 0
  ctx.render = vi.fn(() => { if (++count > 5) throw Error('recursive hover/resize'); ctx.hover({type:'hover-cell', x:2, y:1}) })
  ctx.battlePresentation = { updateMoveDraft: vi.fn(() => true) }
  runInNewContext(helper + '\nfunction hover(intent) {' + branch + '}', ctx)
  return ctx
}
describe('movement hover viewport feedback', () => {
  it('does not reenter full rendering when hovering after a move', () => {
    const ctx = setup()
    expect(() => ctx.hover({type:'hover-cell', x:2, y:1})).not.toThrow()
    expect(ctx.render).not.toHaveBeenCalled()
    expect(ctx.battlePresentation.updateMoveDraft).toHaveBeenCalledOnce()
    for (let i=0;i<100;i++) ctx.hover({type:'hover-cell', x:2, y:1})
    expect(ctx.battlePresentation.updateMoveDraft).toHaveBeenCalledOnce()
    ctx.hover({type:'hover-cell', x:3, y:1})
    expect(ctx.hoverMovePath).toEqual([{x:3,y:1}])
    ctx.hover({type:'hover-cell', x:null, y:null})
    expect(ctx.hoverMovePath).toEqual([])
    expect(ctx.battlePresentation.updateMoveDraft).toHaveBeenCalledTimes(3)
  })
  it('terminates a repeated hover from the fallback render/resize callback', () => {
    const ctx = setup(false)
    expect(() => ctx.hover({type:'hover-cell', x:2, y:1})).not.toThrow()
    expect(ctx.render).toHaveBeenCalledOnce()
  })
})
