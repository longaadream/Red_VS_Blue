import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
  removeItem(key: string) { this.values.delete(key) }
}

type StoredSession = { url: string; token: string; account: { id: string; name?: string } }
type SessionUtils = {
  saveOfficialSession(session: StoredSession): boolean
  readOfficialSession(url: string): StoredSession | null
  clearOfficialSession(url: string): void
}

function utilities() {
  const localStorage = new MemoryStorage()
  const sessionStorage = new MemoryStorage()
  const window = { localStorage, sessionStorage, location: { search: '' } }
  const context = createContext({ window, localStorage, sessionStorage, URLSearchParams, URL, fetch, AbortController, setTimeout, clearTimeout })
  new Script(readFileSync(resolve(process.cwd(), 'data/pages/js/server-utils.js'), 'utf8')).runInContext(context)
  return { utils: (window as typeof window & { RvBUtils: SessionUtils }).RvBUtils, localStorage, sessionStorage }
}

describe('per-server account session persistence', () => {
  it('keeps separate sessions across page sessions and clears only the selected server', () => {
    const { utils, sessionStorage } = utilities()
    const alpha = { url: 'https://alpha.example/', token: 'alpha-token', account: { id: 'a', name: 'Alpha' } }
    const beta = { url: 'https://beta.example', token: 'beta-token', account: { id: 'b', name: 'Beta' } }

    expect(utils.saveOfficialSession(alpha)).toBe(true)
    expect(utils.saveOfficialSession(beta)).toBe(true)
    sessionStorage.removeItem('rvb_official_session')

    expect(utils.readOfficialSession('https://alpha.example')!.token).toBe('alpha-token')
    expect(utils.readOfficialSession('https://beta.example/')!.token).toBe('beta-token')
    utils.clearOfficialSession('https://alpha.example')
    expect(utils.readOfficialSession('https://alpha.example')).toBe(null)
    expect(utils.readOfficialSession('https://beta.example')!.token).toBe('beta-token')
  })

  it('migrates the previous tab-only session without asking the user to log in again', () => {
    const { utils, localStorage, sessionStorage } = utilities()
    sessionStorage.setItem('rvb_official_session', JSON.stringify({ url: 'https://legacy.example', token: 'legacy-token', account: { id: 'old' } }))

    expect(utils.readOfficialSession('https://legacy.example')!.token).toBe('legacy-token')
    sessionStorage.removeItem('rvb_official_session')
    expect(utils.readOfficialSession('https://legacy.example')!.token).toBe('legacy-token')
    expect(localStorage.getItem('rvb_official_session:' + encodeURIComponent('https://legacy.example'))).toContain('legacy-token')
  })
})
