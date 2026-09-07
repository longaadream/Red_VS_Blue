import fs from 'node:fs'
import vm from 'node:vm'
import { expect, it } from 'vitest'

it('loads the singleton through the current Profile URL, outside relative-path pack overrides', async () => {
  const inputs: Array<string | URL> = []
  const context = vm.createContext({ window: {}, URL, AbortSignal, location: { href: 'rvb-client://app/practice.html' },
    fetch: async (input: string | URL) => {
      inputs.push(input)
      return { ok: true, json: async () => String(input).includes('__battle-data') ? { schemaVersion: 'rvb-client-battle-data/v1', files: {} } : {} }
    }, Worker: class {
      onmessage?: (event: unknown) => void
      postMessage() { queueMicrotask(() => this.onmessage?.({ data: { ready: true } })) }
      terminate() {}
    }, setTimeout, clearTimeout })
  new vm.Script(fs.readFileSync('data/pages/js/practice/client.js', 'utf8')).runInContext(context)
  const client = await context.window.RvBPracticeClient.create()
  expect(inputs[2]).toBeInstanceOf(URL)
  expect(String(inputs[2])).toBe('rvb-client://app/data/rules/rule-lucky-coin-gamestart.json')
  client.dispose()
})
