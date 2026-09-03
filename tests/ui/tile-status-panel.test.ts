import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const battleHtml = readFileSync(resolve(process.cwd(), 'data/pages/battle.html'), 'utf8')

describe('tile status side panel', () => {
  it('provides an accessible, dismissible non-modal side panel', () => {
    expect(battleHtml).toContain('id="tileStatusPanel"')
    expect(battleHtml).toContain('role="dialog"')
    expect(battleHtml).toContain('aria-modal="false"')
    expect(battleHtml).toContain('closeTileStatus()')
    expect(battleHtml).toContain('toggleTileStatusExpanded()')
    expect(battleHtml).toContain('aria-controls="tileStatusDetails"')
    expect(battleHtml).toContain('aria-expanded="false"')
    expect(battleHtml).toContain("e.key === 'Escape'")
    expect(battleHtml).toContain('position: absolute;')
    expect(battleHtml).toContain("panel.style.display = 'flex'")
    expect(battleHtml).toContain('flex: 1 1 auto;')
    expect(battleHtml).not.toContain('position: fixed; inset: 0; z-index: 155')
    expect(battleHtml).not.toContain('onclick="if(event.target===this)closeTileStatus()"')
  })

  it('uses the current battle UI baseline and compact collision-safe sizing', () => {
    expect(battleHtml).toContain('css/battle-context-ui.css')
    expect(battleHtml).not.toContain('id="selectedStatusOverlay"')
    expect(battleHtml).not.toContain('#selectedStatusOverlay:not([hidden]) ~ #tileStatusPanel')
    expect(battleHtml).toContain('width: min(248px, calc(100% - 28px))')
    expect(battleHtml).toContain('left: 14px')
    expect(battleHtml).toContain('right: auto')
    expect(battleHtml).toContain('#tileStatusPanel:not(.is-expanded) .ts-details')
    expect(battleHtml).toContain('width: min(232px, calc(100% - 16px))')
    expect(battleHtml).not.toContain('UI 20260517')
    expect(battleHtml).not.toContain(String.fromCodePoint(0x9239, 0x20ac))
    expect(battleHtml).not.toContain('?'.repeat(5))
  })

  it('reads terrain and tile effects from the authoritative battle snapshot', () => {
    expect(battleHtml).toContain('function showTileStatus(x, y)')
    expect(battleHtml).toContain('G.map.tiles.find')
    expect(battleHtml).toContain('G.extensions.tileEffects')
    expect(battleHtml).toContain('当前没有持续地格效果')
  })

  it('renders every effect in stable order with known and fallback visuals', () => {
    expect(battleHtml).toContain('function tileEffectSortKey(effect)')
    expect(battleHtml).toContain('tileEffectSortKey(left).localeCompare(tileEffectSortKey(right))')
    expect(battleHtml).toContain('未知地格效果')
    expect(battleHtml).toContain('meta.icon')
    expect(battleHtml).not.toContain('.slice(0, 4).map(tileStatus')
  })

  it('keeps target-selection branches ahead of the idle inspection action', () => {
    const start = battleHtml.indexOf('function onCellClick(x, y)')
    const end = battleHtml.indexOf('function selectPiece(instanceId)', start)
    const clickHandler = battleHtml.slice(start, end)
    const inspection = clickHandler.lastIndexOf('showTileStatus(x, y)')

    expect(inspection).toBeGreaterThan(0)
    for (const priorityBranch of [
      'pendingOptionSelectionForOther()',
      'TRAINING_MODE && placingMode',
      'if (pendingCardAction)',
      'pendingSkill && pendingSkill.turnTargetActionType',
      'pendingMove && selectedPieceId',
      'pendingSkill && selectedPieceId',
    ]) {
      expect(clickHandler.indexOf(priorityBranch)).toBeLessThan(inspection)
    }
  })
})
