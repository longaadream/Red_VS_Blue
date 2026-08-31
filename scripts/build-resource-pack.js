#!/usr/bin/env node

/**
 * Deprecated compatibility wrapper.
 *
 * The only implementation of resource-pack construction is the canonical
 * `rvb build` content pipeline. This file translates the former flag names
 * into that structured CLI and intentionally contains no hashing or ZIP logic.
 */

const argv = process.argv.slice(2)

function option(name, fallback) {
  const indexes = argv.flatMap((value, index) => value === name ? [index] : [])
  if (indexes.length > 1) throw new Error(`${name} may be provided only once`)
  if (indexes.length === 0) return fallback
  const value = argv[indexes[0] + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

async function main() {
  const [{ spawnSync }, { default: path }] = await Promise.all([
    import('node:child_process'),
    import('node:path'),
  ])
  const root = path.resolve(__dirname, '..')
  console.error('[deprecated] scripts/build-resource-pack.js delegates to `rvb build`; use the canonical CLI directly.')
  const taskId = option('--task', 'RED-118')
  const source = option('--source')
  if (!source) throw new Error('--source is required by the canonical content pack format')
  const output = option('--output', path.join(root, 'dist', 'resource-pack.rvbpack'))
  const name = option('--name', 'editor-build')
  const version = option('--version', '0.1.0')
  const description = option('--desc', '')
  const packageId = option('--package-id', `legacy.${name.toLowerCase().replace(/[^a-z0-9.-]+/g, '-')}`)
  const publisherId = option('--publisher-id', 'rvb.local-author')
  const channel = option('--channel', 'local-dev')

  const translated = [
    path.join(root, 'scripts', 'rvb.mjs'),
    'build', taskId, 'snapshot',
    '--source', source,
    '--output', output,
    '--package-id', packageId,
    '--version', version,
    '--display-name', name,
    '--publisher-id', publisherId,
    '--channel', channel,
  ]
  if (description) translated.push('--description', description)
  const compression = option('--compression-level')
  if (compression) translated.push('--compression-level', compression)

  const result = spawnSync(process.execPath, translated, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  process.exitCode = typeof result.status === 'number' ? result.status : 1
}

main().catch(error => {
  console.error(`[deprecated builder] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
})
