import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

const pagesDir = resolve(process.cwd(), 'data/pages')

function readPage(name: string) {
  return readFileSync(resolve(pagesDir, name), 'utf8')
}

function readNamedFunction(html: string, name: string) {
  const marker = `function ${name}(`
  const start = html.indexOf(marker)
  if (start === -1) throw new Error(`Missing ${name} in battle.html`)

  const nextFunction = html.indexOf('\n    function ', start + marker.length)
  if (nextFunction === -1) throw new Error(`Could not isolate ${name} in battle.html`)

  return html.slice(start, nextFunction)
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

  it('lists placeable templates for both runtime battle factions', () => {
    const battlePage = readPage('battle.html')
    const owner = { value: 'training-red' }
    const select = { innerHTML: '' }
    const context = createContext({
      PIECES_BY_ID: {
        ana: { id: 'ana', name: 'Ana', faction: 'good' },
        reaper: { id: 'reaper', name: 'Reaper', faction: 'evil' },
        neutral: { id: 'neutral', name: 'Neutral', faction: 'neutral' },
        mercenary: { id: 'mercenary', name: 'Mercenary' },
      },
      trainingSetupConfig: null,
      getTrainingPlayerFaction: (playerId: string) => playerId === 'training-red' ? 'red' : 'blue',
      document: {
        getElementById: (id: string) => {
          if (id === 'placeOwner') return owner
          if (id === 'placeTemplate') return select
          return null
        },
      },
    })
    new Script([
      readNamedFunction(battlePage, 'getTemplateFactionForBattleFaction'),
      readNamedFunction(battlePage, 'refreshPlaceTemplates'),
    ].join('\n')).runInContext(context)

    new Script('refreshPlaceTemplates()').runInContext(context)
    expect(select.innerHTML).toContain('value="reaper"')
    expect(select.innerHTML).not.toContain('value="ana"')
    expect(select.innerHTML).toContain('value="neutral"')
    expect(select.innerHTML).toContain('value="mercenary"')

    owner.value = 'training-blue'
    new Script('refreshPlaceTemplates()').runInContext(context)
    expect(select.innerHTML).toContain('value="ana"')
    expect(select.innerHTML).not.toContain('value="reaper"')
    expect(select.innerHTML).toContain('value="neutral"')
    expect(select.innerHTML).toContain('value="mercenary"')
  })
})
