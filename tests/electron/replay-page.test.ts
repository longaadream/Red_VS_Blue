import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

const pagesDir = resolve(process.cwd(), 'data/pages')
const readPage = (name: string) => readFileSync(resolve(pagesDir, name), 'utf8')
const readScript = (name: string) => readFileSync(resolve(pagesDir, 'js/developer-tools', name), 'utf8')
const readStyle = (name: string) => readFileSync(resolve(pagesDir, 'css/developer-tools', name), 'utf8')

type ReplayElement = {
  hidden: boolean
  textContent: string
  addEventListener: () => void
  setAttribute: () => void
  classList: { toggle: () => void; contains: () => boolean }
}

async function deferredOfficialViewer(changeSession: (store: Map<string, string>) => void): Promise<{
  errorText: string
  responseJsonCalls: number
}> {
  const origin = 'https://play.redvsblue.top'
  const sessionKey = 'rvb_official_session:' + encodeURIComponent(origin)
  const store = new Map<string, string>([
    ['rvb_official_url', origin],
    [sessionKey, JSON.stringify({
      url: origin,
      token: 'first-token',
      account: { id: 'first-account' },
    })],
  ])
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
  }
  const elements = new Map<string, ReplayElement>()
  const getElement = (id: string): ReplayElement => {
    const existing = elements.get(id)
    if (existing) return existing
    const created: ReplayElement = {
      hidden: false,
      textContent: '',
      addEventListener: () => undefined,
      setAttribute: () => undefined,
      classList: { toggle: () => undefined, contains: () => false },
    }
    elements.set(id, created)
    return created
  }
  let resolveFetch!: (response: { ok: boolean; status: number; json: () => never }) => void
  const fetchDeferred = new Promise<{ ok: boolean; status: number; json: () => never }>(resolve => {
    resolveFetch = resolve
  })
  let responseJsonCalls = 0
  const windowObject = {
    location: { search: '?matchId=delayed-match' },
    RvBUtils: {
      normalizeOfficialOrigin: (value: string) => value.replace(/\/+$/, ''),
      readOfficialSession: (url: string) => {
        const serialized = store.get('rvb_official_session:' + encodeURIComponent(url))
        return serialized ? JSON.parse(serialized) as { token: string; account: { id: string } } : null
      },
    },
    setTimeout,
    clearTimeout,
    addEventListener: () => undefined,
  }
  const context = createContext({
    window: windowObject,
    globalThis: windowObject,
    localStorage: storage,
    document: { getElementById: getElement },
    URLSearchParams,
    fetch: () => fetchDeferred,
    RvBDeveloperTools: {
      readActiveBattle: () => null,
      assertTraceRecord: () => undefined,
      readStoredTrace: async () => null,
    },
    console,
  })

  new Script(readScript('replay-viewer.js'), { filename: 'replay-viewer.js' }).runInContext(context)
  await Promise.resolve()
  changeSession(store)
  resolveFetch({
    ok: true,
    status: 200,
    json: () => {
      responseJsonCalls += 1
      throw new Error('stale response was decoded')
    },
  })
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  await Promise.resolve()

  return {
    get errorText() { return getElement('replayError').textContent },
    get responseJsonCalls() { return responseJsonCalls },
  }
}

describe('read-only Trace replay viewer', () => {
  it('reuses the battle presentation boundary and exposes timeline inspection controls', () => {
    const page = readPage('replay.html')

    expect(page).toContain('battle-view-model.js')
    expect(page).toContain('battle-renderer-3d.js')
    expect(page).toContain('replay-viewer.js')
    expect(page).toContain('server-utils.js')
    expect(page).toContain('official.html?tab=history')
    expect(page).toContain('<title>对局回放 · RED vs BLUE</title>')
    expect(page).toContain('>对局回放</div>')
    expect(page).toContain('>下载回放</button>')
    expect(page).toContain('replayDownloadButton')
    expect(page).toContain('replayMatchPlayers')
    expect(page).toContain('replayMatchMap')
    expect(page).toContain('replayPreviousTurnButton')
    expect(page).toContain('replayNextTurnButton')
    expect(page).toContain('replayTurnSelect')
    expect(page).toContain('replayTimeline')
    expect(page).toContain('replayPlayButton')
    expect(page).toContain('replayPreviousButton')
    expect(page).toContain('replayNextButton')
    expect(page).toContain('replaySpeed')
    expect(page).toContain('replayPerspective')
    expect(page).toContain('replayPieceDetails')
    expect(page).toContain('replayEventList')
    expect(page).toContain('replayDiffList')
    expect(page).toContain('replayRandomStreams')
    expect(page).toContain('replayInspectorToggle')
    expect(page).toContain('replayInspectorClose')
    expect(page).toContain('replayInspectorTabs')
  })

  it('keeps the battlefield full viewport and moves details into collapsible floating surfaces', () => {
    const style = readStyle('replay.css')

    expect(style).toContain('position: fixed')
    expect(style).toContain('inset: 0')
    expect(style).toContain('.inspector.is-collapsed')
    expect(style).toContain('backdrop-filter')
  })

  it('loads either an explicitly requested official trace or the local validated trace without room access', () => {
    const page = readPage('replay.html')
    const script = readScript('replay-viewer.js')
    const combined = page + '\n' + script

    expect(script).toContain('readStoredTrace')
    expect(script).toContain('readOfficialSession')
    expect(script).toContain("/official/matches/")
    expect(script).toContain('assertTraceRecord')
    expect(script).toContain('downloadTrace')
    expect(script).toContain("light: '光方'")
    expect(script).toContain("dark: '暗方'")
    expect(script).toContain("surrender: '投降'")
    expect(script).toContain("effect-icons/fallback.svg")
    expect(script).toContain('BattleViewModel.create')
    expect(script).toContain('BattleRenderer3D.update')
    expect(script).toContain("intent.type === 'activate-cell'")
    expect(script).toContain('materializeTraceState')
    expect(script).toContain('currentCooldown')
    expect(script).toContain('usesRemaining')
    expect(script).toContain('textContent')
    expect(combined).not.toContain('RvBColyseus')
    expect(combined).not.toContain('WebSocket')
    expect(combined).not.toContain('serverFetch')
    expect(combined).toContain("fetch(origin + '/official/matches/'")
    expect(combined).not.toContain("fetch('/")
    expect(combined).not.toContain("type: 'action'")
    expect(combined).not.toContain('runBattleAction')
    expect(combined).not.toContain('/api/rooms/')
    expect(combined).not.toContain('innerHTML')
  })

  it.each([
    ['account switch', (store: Map<string, string>) => {
      const origin = 'https://play.redvsblue.top'
      store.set('rvb_official_session:' + encodeURIComponent(origin), JSON.stringify({
        url: origin,
        token: 'second-token',
        account: { id: 'second-account' },
      }))
    }],
    ['server switch', (store: Map<string, string>) => {
      const origin = 'https://other.redvsblue.top'
      store.set('rvb_official_url', origin)
      store.set('rvb_official_session:' + encodeURIComponent(origin), JSON.stringify({
        url: origin,
        token: 'other-token',
        account: { id: 'other-account' },
      }))
    }],
  ] as const)('rejects a delayed official response after a %s', async (_label, changeSession) => {
    const result = await deferredOfficialViewer(changeSession)

    expect(result.responseJsonCalls).toBe(0)
    expect(result.errorText).toContain('官方会话已变化')
  })
})
