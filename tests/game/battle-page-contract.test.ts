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

  it('keeps target submission single-flight and clears transient targeting on every authoritative exit', () => {
    const battlePage = readPage('battle.html')

    expect(battlePage).toContain('function submitTargetAction(action, label)')
    expect(battlePage).toMatch(
      /function submitTargetAction\(action, label\) \{\s*if \(targetSubmissionPending\)/,
    )
    expect(battlePage).toContain('目标指令已提交，正在等待权威确认')
    expect(battlePage).toContain("clearTargetInteraction('user-cancelled')")
    expect(battlePage).toContain("clearTargetInteraction('piece-switched')")
    expect(battlePage).toContain("clearTargetInteraction('turn-changed')")
    expect(battlePage).toContain("clearTargetInteraction('selected-piece-unavailable')")
    expect(battlePage).toContain("clearTargetInteraction('server-rejected')")
    expect(battlePage).toContain('function reconcileBattleInteractionState(previousState, nextState)')
  })

  it('keeps the side rail status-only while preserving the existing right-click piece detail', () => {
    const battlePage = readPage('battle.html')
    const domUi = readPage('js/battle-ui/battle-dom-ui.js')

    expect(domUi).toContain('特殊状态')
    expect(domUi).toContain('无特殊状态')
    expect(domUi).not.toContain('selected-detail-portrait')
    expect(domUi).not.toContain('selected-detail-stats')
    expect(domUi).not.toContain('selected-skill-list')
    expect(domUi).not.toContain('data-skill-id')
    expect(battlePage).toContain('function resolveSkillAvailability(piece, skillOrId)')
    expect(battlePage).toMatch(
      /function selectSkillCard[\s\S]*?resolveSkillAvailability\(sp, skId\)/,
    )
    expect(battlePage).not.toContain('detailPiece.skills')
    expect(battlePage).toContain('oncontextmenu="event.preventDefault();dispatchBattleIntent({type:\'inspect-piece\'')
    expect(battlePage).toContain('function showPieceInfo(instanceId, preserveKeyword)')
    expect(battlePage).toContain('statsHtml + tagsHtml')
    expect(battlePage).toContain('\`<div class="pi-section-label">技能</div>\` + skillsHtml')
  })

  it('exposes accessible target feedback and a mobile target mode that removes obstructing detail UI', () => {
    const battlePage = readPage('battle.html')

    expect(battlePage).toContain('<div id="statusMsg" role="status" aria-live="polite">')
    expect(battlePage).toContain('<div id="targetOverlay" role="status" aria-live="polite">')
    expect(battlePage).toContain('id="targetSourceName"')
    expect(battlePage).toContain('id="targetCancelButton"')
    expect(battlePage).toContain('.board-side-rail.target-mode { display: none; }')
    expect(battlePage).toContain('body.target-mode-active #skillBar')
    expect(battlePage).toContain('@media (prefers-reduced-motion: reduce)')
    expect(battlePage).toContain('button:focus-visible')
  })

  it('keeps skill availability feedback in the existing skill operation area', () => {
    const battlePage = readPage('battle.html')

    expect(battlePage).toContain('sk-unavailable-reason')
    expect(battlePage).toContain('#skillBar:not(:empty)')
    expect(battlePage).not.toMatch(/^\s*#skillBar \{ display: none !important; \}/m)
    for (const reason of ['冷却中', '可用次数已耗尽', '行动点不足', '充能点不足']) {
      expect(battlePage).toContain(reason)
    }
  })

  it('requires landscape play on phones and reserves usable space at both mobile acceptance sizes', () => {
    const battlePage = readPage('battle.html')

    expect(battlePage).toContain('id="orientationGuard"')
    expect(battlePage).toContain('请旋转设备')
    expect(battlePage).toContain('@media (orientation: portrait) and (max-width: 760px)')
    expect(battlePage).toContain('@media (orientation: landscape) and (max-width: 1000px) and (max-height: 500px)')
    expect(battlePage).toContain('--mobile-landscape-min: 844px')
    expect(battlePage).toContain('--mobile-landscape-recommended: 932px')
    expect(battlePage).toContain('.board-side-rail.target-mode')
    expect(battlePage).toContain('body.target-mode-active #statusMsg')
  })
})
