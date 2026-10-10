import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { expect, it } from 'vitest'

const source = readFileSync('data/pages/js/compatibility-presentation.js', 'utf8')
const lobbySource = readFileSync('data/pages/lobby.html', 'utf8')
const indexSource = readFileSync('data/pages/index.html', 'utf8')

type PresentationNode = {
  hidden: boolean
  textContent: string
  dataset: Record<string, string>
  children: PresentationNode[]
  onclick: () => void
  replaceChildren(): void
  appendChild(child: PresentationNode): void
}

function setup(locationValue = { origin: 'https://rvb.test', href: 'https://rvb.test/lobby.html' }) {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }
  const node = (): PresentationNode => ({
    hidden: false,
    textContent: '',
    dataset: {} as Record<string, string>,
    children: [],
    onclick: () => {},
    replaceChildren() { this.children = [] },
    appendChild(child) { this.children.push(child) },
  })
  const document = { createElement: node }
  const location = { ...locationValue }
  const context = createContext({
    URL,
    Object,
    document,
    location,
    sessionStorage: storage,
    window: { location, sessionStorage: storage },
  })
  new Script(source).runInContext(context)
  return { api: context.window.RvBCompatibilityPresentation, location, storage, node }
}

it('classifies only known compatibility failures and keeps pinned server outages without a client fix', () => {
  const { api } = setup()
  expect(api.classify({ code: 'ENGINE_ABI_MISMATCH' })).toBe('client')
  expect(api.classify({ code: 'RUNNER_REVISION_MISMATCH' })).toBe('client')
  expect(api.classify({ code: 'PROFILE_HASH_MISMATCH' })).toBe('resource')
  expect(api.classify({ code: 'PROFILE_INVALID' })).toBe('resource')
  expect(api.classify({ code: 'PINNED_PROFILE_UNAVAILABLE' })).toBe('server')
  expect(api.classify({ message: api.officialCompatibilityMessage })).toBe('generic')
  expect(api.classify(new Error('ordinary network failure'))).toBeNull()
  const host = setup().node()
  expect(api.render(host, { code: 'PINNED_PROFILE_UNAVAILABLE', message: '资源不可用' })).toBe('server')
  expect(host.children).toHaveLength(2)
  expect(host.children.some((child: { dataset: Record<string, string> }) => child.dataset.compatibilityEntry)).toBe(false)
})

it('routes known client/resource entries through hardcoded same-origin pages', () => {
  const client = setup()
  const clientHost = client.node()
  client.api.render(clientHost, { code: 'ENGINE_ABI_MISMATCH', message: '客户端不兼容' })
  clientHost.children[1].onclick()
  expect(client.location.href).toBe('index.html')
  expect(client.storage.getItem('rvb_compatibility_update_entry')).toBe('client')

  const resource = setup()
  const resourceHost = resource.node()
  resource.api.render(resourceHost, { code: 'PROFILE_HASH_MISMATCH', message: '资源不兼容' })
  resourceHost.children[1].onclick()
  expect(resource.location.href).toBe('pack.html')
  expect(resource.storage.getItem('rvb_compatibility_update_entry')).toBeNull()
})

it('allows the trusted Electron scheme when Chromium reports a null origin', () => {
  const electron = setup({ origin: 'null', href: 'rvb-client://app/lobby.html' })
  const host = electron.node()
  electron.api.render(host, { code: 'RUNNER_REVISION_MISMATCH', message: '客户端不兼容' })
  host.children[1].onclick()
  expect(electron.location.href).toBe('index.html')
  expect(electron.storage.getItem('rvb_compatibility_update_entry')).toBe('client')
})

it('rejects an untrusted custom-scheme origin before writing the homepage flag', () => {
  const untrusted = setup({ origin: 'rvb-client://evil', href: 'rvb-client://evil/lobby.html' })
  expect(untrusted.api.open('client')).toBe(false)
  expect(untrusted.location.href).toBe('rvb-client://evil/lobby.html')
  expect(untrusted.storage.getItem('rvb_compatibility_update_entry')).toBeNull()
})

it('does not clear a compatibility entry from background room or map success', () => {
  const roomsSuccess = lobbySource.slice(lobbySource.indexOf('const data = await lobbyRequest(\'rooms.list\')'), lobbySource.indexOf('} catch (e) {', lobbySource.indexOf('const data = await lobbyRequest(\'rooms.list\')')))
  const mapsSuccess = lobbySource.slice(lobbySource.indexOf('mapsLoaded = true'), lobbySource.indexOf('} catch (error) {', lobbySource.indexOf('mapsLoaded = true')))
  expect(roomsSuccess).not.toContain('clearCompatibilityRecovery()')
  expect(mapsSuccess).not.toContain('clearCompatibilityRecovery()')
  expect(lobbySource).toContain('if (userInitiated) clearCompatibilityRecovery()')
  expect(lobbySource).toContain('onclick="loadRooms(true)"')
  expect(lobbySource).toContain('onchange="mapsLoaded=false;loadMaps(true)"')
})

it('mounts LAN and create-room recovery entries inside their active overlays', () => {
  expect(indexSource).toContain('id="lanCompatibilityRecovery"')
  expect(indexSource).toContain("lanOverlay.classList.contains('show')")
  expect(indexSource).toContain('showCompatibilityRecovery(error, detail, error && error.context && error.context.field, recoveryHost)')
  expect(lobbySource).toContain('id="createCompatibilityRecovery"')
  expect(lobbySource).toContain('renderCompatibilityRecovery(e, detail, undefined, document.getElementById(\'createCompatibilityRecovery\'))')
})

