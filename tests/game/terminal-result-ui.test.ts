import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

it('shows a journal-backed terminal result without exporting history or fetching a report', () => {
  const html = readFileSync('data/pages/battle.html', 'utf8')
  const source = html.slice(html.indexOf('    function handleGameOver()'), html.indexOf('    var _signedRecord'))
  const nodes = new Map<string, { style: Record<string, string>; textContent: string }>()
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { style: {}, textContent: '' })
    return nodes.get(id)!
  }
  const exportTrace = vi.fn(() => { throw new Error('Must not materialize full history') })
  const fetchReport = vi.fn(() => { throw new Error('Must not request a full report automatically') })
  const disconnect = vi.fn()
  const context = createContext({
    G: { terminalResult: { status: 'finished', winnerPlayerId: 'red', reason: 'surrender' }, extensions: { debugBattle: { authority: { replayFrameCount: 500 }, replay: { frames: [] } } } },
    PRACTICE_MODE: false, ADVENTURE_MODE: false, TUTORIAL_MODE: false, TRAINING_MODE: false, SPECTATE_MODE: false,
    pollTimer: null, completedMatchTraceRecord: null, recordSaved: false, myPlayerId: 'red', playerNames: { red: '玩家' },
    localStorage: { removeItem: vi.fn() }, document: { getElementById: node },
    RvBColyseus: { disconnect }, storeCompletedMatchTrace: exportTrace, _signGameRecord: fetchReport,
  })
  new Script(source + '\nhandleGameOver()').runInContext(context)
  expect(node('resultOverlay').style.display).toBe('flex')
  expect(node('resultTitle').textContent).toBe('胜利')
  expect(node('recordDownloadBtn').style.display).toBe('inline-block')
  expect(exportTrace).not.toHaveBeenCalled()
  expect(fetchReport).not.toHaveBeenCalled()
  expect(disconnect).toHaveBeenCalledOnce()
})
