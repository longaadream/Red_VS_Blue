const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { dependencyPlan } = require('../../scripts/trace-client-dependencies.cjs')

test('traced directory junction never expands into untraced development files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-trace-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dependencies = path.join(root, 'shared', 'node_modules')
  fs.mkdirSync(dependencies, { recursive: true })
  fs.writeFileSync(path.join(dependencies, 'runtime.js'), 'module.exports = 1')
  fs.writeFileSync(path.join(dependencies, 'untraced-dev-tool.js'), 'development only')
  const link = path.join(root, 'node_modules')
  fs.symlinkSync(dependencies, link, process.platform === 'win32' ? 'junction' : 'dir')
  const plan = dependencyPlan(['node_modules', 'node_modules/runtime.js', 'shared/node_modules/runtime.js'], root, dependencies)
  assert.deepEqual([...plan.keys()], ['runtime.js'])
  assert.equal(fs.readFileSync(path.join(dependencies, 'untraced-dev-tool.js'), 'utf8'), 'development only')
})

test('missing declared dependencies fail instead of producing an incomplete package', () => {
  assert.throws(() => dependencyPlan(['does-not-exist-rvb.js'], os.tmpdir(), os.tmpdir()), /ENOENT/)
})
