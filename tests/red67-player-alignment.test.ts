import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8')
}

describe('RED-67 cross-page player alignment flow', () => {
  it('uses canonical light/dark values from lobby through selection', () => {
    const lobby = read('data/pages/lobby.html')
    const room = read('data/pages/room.html')
    const selection = read('data/pages/piece-selection.html')

    expect(lobby).toContain("confirmJoin('dark')")
    expect(lobby).toContain("confirmJoin('light')")
    expect(room).toContain("'&alignment=' + encodeURIComponent(currentPlayerAlignment())")
    expect(room).toContain("f === 'red' ? '红方座位' : f === 'blue' ? '蓝方座位'")
    expect(room).not.toContain("f === 'red' ? '先手' : f === 'blue' ? '后手'")
    expect(selection).toContain("p.set('alignment', playerAlignment)")
    expect(selection).toContain('id="alignmentLightBtn" disabled')
    expect(selection).toContain('id="alignmentDarkBtn" disabled')
    expect(selection).not.toContain("onclick=\"setAlignment('light')\"")
    expect(selection).not.toContain("onclick=\"setAlignment('dark')\"")
    expect(selection).not.toContain('async function setAlignment(alignment)')
  })

  it('restores battle labels from authoritative player alignment metadata', () => {
    const battle = read('data/pages/battle.html')

    expect(battle).toContain('G.extensions.playerAlignments')
    expect(battle).toContain("p.alignment === 'light' || p.alignment === 'dark'")
    expect(battle).toContain('if (G) render()')
    expect(battle).toContain('alignmentText(playerAlignments[myPlayerId])')
    expect(battle).toContain('alignmentText(playerAlignments[oppPid])')
  })
})
