import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transpileModule, ModuleKind } from 'typescript'
import { expect, it } from 'vitest'

function marker(argv: string[]) {
  let bridge: { getCommunityLaunchId(): string | null } | undefined
  let ipcCalls = 0
  const source = transpileModule(readFileSync('electron-client/preload.ts', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText
  runInNewContext(source, {
    exports: {}, process: { argv },
    require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, api: typeof bridge) => { bridge = api } }, ipcRenderer: { invoke: () => { ipcCalls++ } }, webUtils: {} }),
  })
  const value = bridge!.getCommunityLaunchId()
  expect(ipcCalls).toBe(0)
  return value
}

it('exposes only a valid public launch marker without mutable IPC', () => {
  const first = 'a'.repeat(32), second = 'b'.repeat(32)
  expect(marker(['electron', '--rvb-community-launch=' + first])).toBe(first)
  expect(marker(['electron', '--rvb-community-launch=' + first])).toBe(first)
  expect(marker(['electron', '--rvb-community-launch=' + second])).toBe(second)
  expect(marker(['electron'])).toBe(null)
  expect(marker(['electron', '--rvb-community-launch=arbitrary-value'])).toBe(null)
})
