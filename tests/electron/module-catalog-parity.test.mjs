import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const source = spawnSync(process.execPath, ['--import', 'tsx', '-e', [
  "import registry from './lib/skill-graph/module-registry.ts'",
  'console.log(JSON.stringify(registry.getGameplayModuleCatalog()))',
].join('; ')], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
assert.equal(source.status, 0, source.stderr || source.stdout)
const expected = JSON.parse(source.stdout)

function assertCatalog(actual, label) {
  const normalize = catalog => JSON.parse(JSON.stringify(catalog))
    .sort((a, b) => `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`))
  const key = item => `${item.id}@${item.version}`
  assert.deepEqual(Array.from(actual, key).sort(), expected.map(key).sort(), `${label}: available modules`)
  assert.deepEqual(normalize(actual), normalize(expected), `${label}: types, parameters and authoring visibility`)
}

test('the shipped sentence editor uses the current typed module catalog', () => {
  // Evaluate the pure generated library, without launching or controlling a browser.
  const context = vm.createContext({ console, TextEncoder, TextDecoder })
  vm.runInContext(readFileSync(path.join(root, 'electron-editor/ui/content-graph-core.js'), 'utf8'), context)
  assertCatalog(context.ContentGraphCore.getGameplayModuleCatalog(), 'sentence editor')
})

test('the Node editor exposes the same module catalog as the source registry', () => {
  assertCatalog(require(path.join(root, 'electron-editor/gameplay-module-core.cjs')).getGameplayModuleCatalog(), 'Node editor')
})
