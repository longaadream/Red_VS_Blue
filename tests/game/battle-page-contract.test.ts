import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script } from 'node:vm'

import { describe, expect, it } from 'vitest'

const pagesDir = resolve(process.cwd(), 'data/pages')

function readPage(name: string) {
  return readFileSync(resolve(pagesDir, name), 'utf8')
}

function extractInlineScripts(html: string) {
  const scripts: Array<{ source: string; htmlLine: number }> = []
  const pattern = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi

  for (const match of html.matchAll(pattern)) {
    const source = match[1]
    if (!source.trim()) continue

    const sourceOffset = (match.index ?? 0) + match[0].indexOf(source)
    const htmlLine = html.slice(0, sourceOffset).split('\n').length
    scripts.push({ source, htmlLine })
  }

  return scripts
}

function parseInlineScript(script: { source: string; htmlLine: number }, index: number) {
  const filename = `battle-inline-${index + 1}.js`

  try {
    new Script(script.source, { filename })
  } catch (error) {
    const stack = error instanceof Error ? error.stack ?? '' : ''
    const scriptLine = Number(stack.match(new RegExp(`${filename.replace('.', '\\.')}:(\\d+)`))?.[1] ?? 1)
    const htmlLine = script.htmlLine + scriptLine - 1
    throw new Error(`battle.html:${htmlLine} inline script ${index + 1} failed to parse: ${String(error)}`, {
      cause: error,
    })
  }
}

describe('battle page route contract', () => {
  it('parses every inline script in the canonical battle page', () => {
    const scripts = extractInlineScripts(readPage('battle.html'))

    expect(scripts.length).toBeGreaterThan(0)
    for (const [index, script] of scripts.entries()) {
      expect(() => parseInlineScript(script, index)).not.toThrow()
    }
  })

  it('keeps one responsive HUD, board-anchored piece menu, and curved hand structure', () => {
    const battlePage = readPage('battle.html')
    const responsiveCss = readFileSync(resolve(pagesDir, 'css/battle-responsive.css'), 'utf8')
    const contextCss = readFileSync(resolve(pagesDir, 'css/battle-context-ui.css'), 'utf8')
    const mobileCss = readFileSync(resolve(pagesDir, 'css/battle-responsive-mobile.css'), 'utf8')

    expect(battlePage).toContain('<link rel="stylesheet" href="css/battle-responsive.css" />')
    expect(battlePage).toContain('<link rel="stylesheet" href="css/battle-context-ui.css" />')
    expect(battlePage).toContain('<script src="js/battle-ui/battle-context-layout.js"></script>')
    expect(battlePage).toContain('<link rel="stylesheet" href="css/battle-responsive-mobile.css" />')
    expect(battlePage).toContain('id="btnResetBoardView"')
    expect(battlePage).toContain('id="pieceContextMenu"')
    expect(battlePage).toContain('id="pieceContextSkills"')
    expect(battlePage).not.toContain('id="btnToggleBattleDetail"')
    expect(battlePage).not.toContain('id="battleDetailRail"')
    expect(battlePage).not.toContain('skillBar')
    expect(battlePage).not.toContain('.board-side-rail')
    expect(battlePage).not.toContain('.selected-status-card')
    expect(responsiveCss).not.toContain('.board-side-rail')
    expect(battlePage).toContain('id="handCards" role="region" aria-label="手牌列表" tabindex="0"')
    expect(battlePage).not.toContain('arcHandContainer')
    expect(battlePage).toContain('--hand-arc-angle:')
    expect(contextCss).toContain('.piece-context-menu')
    expect(contextCss).toContain('var(--hand-arc-angle')
    expect(battlePage).toMatch(/if \(pendingSkill \|\| pendingCardAction\) \{\s*closePieceContextMenu\(\)/)
    expect(battlePage).toMatch(/const draftAction[^\n]+\s*closePieceContextMenu\(\)\s*await doAction\(draftAction\)/)
    expect(battlePage).toMatch(/function closePieceInfo\(\)[\s\S]*?style\.display = 'none'[\s\S]*?renderPieceContextMenu\(selected \|\| null\)/)
    expect(battlePage).toContain('const disabled = !isMyTurn || !inAction || onCD || noUses')
    expect(battlePage).not.toContain('ap < apCost || cp < cpCost')
    expect(responsiveCss).not.toContain('@media (max-width: 760px)')
    expect(responsiveCss).toContain('touch-action: pan-x')
    expect(mobileCss).toContain('@media (max-width: 760px)')
    expect(mobileCss).toMatch(/\.board-view-button\s*\{[\s\S]*?min-height:\s*42px/)
    expect(mobileCss).toMatch(/\.piece-context-skill\s*\{[\s\S]*?min-height:\s*44px/)
    expect(mobileCss).toMatch(/\.training-setup-sheet\s*\{[\s\S]*?max-height:\s*calc\(100dvh - 16px\)/)
    expect(mobileCss).toMatch(/\.training-setup-grid\s*\{[\s\S]*?overflow-y:\s*auto/)
  })

  it('routes the lobby training entry to battle.html training mode', () => {
    const lobby = readPage('index.html')

    expect(lobby).toContain("window.location.href = 'battle.html?mode=training'")
    expect(lobby).not.toMatch(/location\.href\s*=\s*['"]training\.html/)
  })

  it('keeps training.html as a compatibility redirect without battle interactions', () => {
    const legacyTrainingPage = readPage('training.html')
    const battlePage = readPage('battle.html')
    const sharedInteractionMarkers = [
      'function renderBoard',
      'function onCellClick',
      'function renderActionBar',
      'function computeValidSkillTargets',
      'async function doAction',
    ]

    expect(legacyTrainingPage).toContain('battle.html')
    expect(legacyTrainingPage).toContain("params.set('mode', 'training')")
    expect(legacyTrainingPage).toContain('window.location.search')
    expect(legacyTrainingPage).toContain('window.location.replace')
    expect(legacyTrainingPage).not.toMatch(
      /applyBattleAction|GameEngine|function\s+(?:renderBoard|onCellClick|toggleMove|doAction)\b/,
    )
    for (const marker of sharedInteractionMarkers) {
      expect(battlePage).toContain(marker)
      expect(legacyTrainingPage).not.toContain(marker)
    }
  })

  it('turns missing battle parameters into a terminal error instead of an endless spinner', () => {
    const battlePage = readPage('battle.html')

    expect(battlePage).toMatch(/if \(!roomId \|\| !myPlayerId\) \{ showMsg\([^\n]+, 'err'\); return \}/)
    expect(battlePage).toContain("spinner.style.display = type === 'err' ? 'none' : ''")
  })

  it('recovers training data from the connected server and rejects empty starting rosters', () => {
    const battlePage = readPage('battle.html')

    expect(battlePage).toContain('async function loadServerBattleDataFallback()')
    expect(battlePage).toContain('RvBUtils.serverFetch(path, { timeoutMs: timeoutMs || 3500 })')
    expect(battlePage).toMatch(
      /if \(!Object\.keys\(PIECES_BY_ID\)\.length\) \{\s*try \{\s*await loadServerBattleDataFallback\(\)/,
    )
    expect(battlePage).toContain('return { ok: recoveredFromServer || errors.length === 0, errors }')
    expect(battlePage).toMatch(
      /if \(!firstPieces\.length \|\| !secondPieces\.length\) \{\s*throw new Error\('训练棋子资源未加载/,
    )
  })
})
