const fs = require('node:fs')
const path = require('node:path')

function inside(root, file) {
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

function collectTraces(dir) {
  const result = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'standalone' || entry.name === 'cache' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) result.push(...collectTraces(full))
    else if (entry.name.endsWith('.nft.json')) result.push(full)
  }
  return result
}

// NFT emits directory symlinks as well as their individual resolved files. Never
// recursively copy such a directory: a Windows worktree junction can point at
// the entire development installation, even in Next's standalone output.
function dependencyPlan(files, base, dependencyRoot) {
  const result = new Map()
  for (const relative of files) {
    const source = path.resolve(base, relative)
    if (!fs.statSync(source).isFile()) continue
    const real = fs.realpathSync(source)
    if (!inside(dependencyRoot, real)) continue
    const target = path.relative(dependencyRoot, real)
    result.set(target, real)
  }
  return result
}

async function copyTracedDependencies(projectRoot, standaloneDir, destination) {
  const { nodeFileTrace } = require('next/dist/compiled/@vercel/nft')
  const dependencyRoot = fs.realpathSync(path.join(projectRoot, 'node_modules'))
  let base = projectRoot
  while (!inside(base, dependencyRoot)) {
    const parent = path.dirname(base)
    if (parent === base) throw new Error('Runtime dependencies must be on the same volume as the project')
    base = parent
  }
  const entries = new Set([path.join(standaloneDir, 'server.js')])
  const declared = new Set()
  const traces = collectTraces(path.join(projectRoot, '.next'))
  if (!traces.length) throw new Error('Missing Next output traces; rebuild before staging')
  for (const trace of traces) {
    const entry = trace.slice(0, -'.nft.json'.length)
    if (fs.existsSync(entry)) entries.add(entry)
    for (const relative of JSON.parse(fs.readFileSync(trace, 'utf8')).files) {
      const file = path.resolve(path.dirname(trace), relative)
      declared.add(path.relative(base, file))
      if (fs.statSync(file).isFile() && /\.(?:cjs|mjs|js)$/.test(file)) entries.add(file)
    }
  }
  // Trace again across the real dependency root. Next's project-root trace can
  // omit transitive dependencies when node_modules points outside a worktree.
  const trace = await nodeFileTrace([...entries], { base, processCwd: standaloneDir })
  const plan = dependencyPlan(new Set([...declared, ...trace.fileList]), base, dependencyRoot)
  if (!plan.has(path.join('next', 'package.json'))) throw new Error('Trace did not include the Next runtime')
  // File tracing follows executable imports, not accompanying license notices.
  // Preserve notices alongside the selected files and at their package roots.
  const noticeDirectories = new Set()
  for (const source of plan.values()) {
    let directory = path.dirname(source)
    while (directory !== dependencyRoot && inside(dependencyRoot, directory)) {
      noticeDirectories.add(directory)
      directory = path.dirname(directory)
    }
  }
  for (const directory of noticeDirectories) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && (/^(?:licen[sc]e|notice|copying|copyright)(?:[._-]|$)/i.test(entry.name) || /\.LICENSE\.txt$/i.test(entry.name))) {
        const source = path.join(directory, entry.name)
        plan.set(path.relative(dependencyRoot, source), source)
      }
    }
  }
  let bytes = 0
  for (const [relative, source] of plan) {
    const target = path.join(destination, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
    bytes += fs.statSync(source).size
  }
  const report = { dependencyFiles: plan.size, dependencyBytes: bytes, traceWarnings: [...trace.warnings].map(String) }
  fs.writeFileSync(path.join(path.dirname(destination), 'dependency-trace-report.json'), JSON.stringify(report, null, 2))
  console.log(`[stage-client] Traced ${plan.size} dependency files (${Math.round(bytes / 1024 / 1024)} MiB); ${trace.warnings.size} trace warnings recorded for smoke validation`)
  return report
}

module.exports = { copyTracedDependencies, dependencyPlan }
