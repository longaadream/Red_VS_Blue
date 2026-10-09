import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { availableParallelism, totalmem, platform } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(resolve(root, 'package.json'))

function check() {
  const checks = []
  const major = Number(process.versions.node.split('.')[0])
  checks.push({ name: 'node>=22', passed: major >= 22, actual: process.versions.node })
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  for (const name of ['@colyseus/sdk', 'esbuild', 'vitest']) {
    try {
      require.resolve(name)
      checks.push({ name, passed: true, declared: manifest.dependencies?.[name] ?? manifest.devDependencies?.[name] })
    } catch {
      checks.push({ name, passed: false, remedy: 'npm ci --ignore-scripts --no-audit --no-fund' })
    }
  }
  for (const name of ['cards', 'skills', 'pieces']) {
    const path = resolve(root, 'data', name, 'manifest.json')
    const ids = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
    checks.push({ name: `data/${name}/manifest.json`, passed: Array.isArray(ids) && ids.length > 0 })
  }
  return {
    ready: checks.every(check => check.passed),
    node: process.versions.node,
    platform: platform(),
    availableCpus: availableParallelism(),
    memoryGiB: Math.round(totalmem() / (1024 ** 3) * 10) / 10,
    checks,
    networkTested: false,
    cloudEnvironmentVerified: false,
    next: 'npm run ai:goal-search -- --smoke',
  }
}

const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: npm run ai:cloud-preflight\nChecks local Node, installed dependencies and trusted content. No network or credentials are used.')
} else if (args.length !== 0) {
  console.error('cloud-ai-preflight accepts only --help or no arguments')
  process.exitCode = 2
} else {
  const report = check()
  console.log(JSON.stringify(report, null, 2))
  if (!report.ready) process.exitCode = 1
}
