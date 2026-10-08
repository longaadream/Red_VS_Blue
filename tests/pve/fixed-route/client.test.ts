import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(path.join(process.cwd(), 'data/pages/js/pve-route/client.js'), 'utf8')

function harness() {
  const files: Record<string, unknown> = {}
  for (const directory of ['pieces', 'skills', 'cards', 'maps', 'rules', 'status-effects', 'tiles']) {
    files[`data/${directory}/manifest.json`] = ['fixture']
    files[`data/${directory}/fixture.json`] = { id: 'fixture' }
  }
  const luckyRule = { id: 'rule-lucky-coin-gamestart', skillCode: 'fixture' }
  const messages: Array<{ type: string; files?: Record<string, unknown>; id?: number }> = []
  let terminated = 0
  let workers = 0
  class WorkerStub {
    onmessage?: (event: { data: unknown }) => void
    onerror?: unknown
    constructor() { workers += 1 }
    postMessage(message: typeof messages[number]) {
      messages.push(message)
      queueMicrotask(() => this.onmessage?.({ data: message.type === 'initialize'
        ? { ready: true }
        : { id: message.id, result: { revision: 0, route: { phase: 'between' } } } }))
    }
    terminate() { terminated += 1 }
  }
  const browser: { RvBPveRouteClient?: { create(): Promise<{ files: Record<string, unknown>; request(type: string): Promise<unknown>; dispose(): void }> } } = {}
  vm.runInNewContext(source, {
    window: browser, Worker: WorkerStub, URL, AbortSignal, setTimeout, clearTimeout, console,
    location: { href: 'http://127.0.0.1/pve-route.html' },
    fetch: async (input: string | URL) => ({ ok: true, json: async () => {
      const url = String(input)
      if (url.includes('__battle-data')) return { schemaVersion: 'rvb-client-battle-data/v1', files }
      if (url.includes('__tutorial-profile')) return { schemaVersion: 'profile-fixture' }
      if (url.includes('rule-lucky-coin-gamestart')) return luckyRule
      throw new Error(`Unexpected fixture request: ${url}`)
    } }),
  })
  return { api: browser.RvBPveRouteClient!, luckyRule, messages, workers: () => workers, terminated: () => terminated }
}

describe('fixed route browser resource client', () => {
  it('loads the external opening rule before validating and initializing its sole worker', async () => {
    const fixture = harness()
    const client = await fixture.api.create()
    expect(fixture.workers()).toBe(1)
    expect(fixture.messages[0]?.type).toBe('initialize')
    expect(fixture.messages[0]?.files?.['data/rules/rule-lucky-coin-gamestart.json']).toEqual(fixture.luckyRule)
    expect(await client.request('snapshot')).toEqual({ revision: 0, route: { phase: 'between' } })
    client.dispose()
    expect(fixture.terminated()).toBe(1)
  })

  it('rejects requests after disposal without creating another owner', async () => {
    const fixture = harness()
    const client = await fixture.api.create()
    client.dispose()
    client.dispose()
    await expect(client.request('snapshot')).rejects.toThrow('已退出')
    expect(fixture.workers()).toBe(1)
    expect(fixture.terminated()).toBe(1)
    expect(fixture.messages).toHaveLength(1)
  })
})
