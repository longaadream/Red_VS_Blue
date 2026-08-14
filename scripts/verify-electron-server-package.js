/* eslint-disable @typescript-eslint/no-require-imports */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const SERVER_EXECUTABLE = 'RED vs BLUE Server.exe'

const RESOURCE_GROUPS = [
  {
    label: 'Electron main resource',
    source: 'electron/dist',
    packaged: 'resources/app/electron/dist',
  },
  {
    label: 'dashboard resource',
    source: 'electron/dashboard',
    packaged: 'resources/app/electron/dashboard',
  },
  {
    label: 'standalone resource',
    source: '_client-stage',
    packaged: 'resources/app/standalone',
  },
  {
    label: 'public resource',
    source: 'public',
    packaged: 'resources/app/public',
  },
  {
    label: 'data resource',
    source: 'data',
    packaged: 'resources/app/data',
  },
  {
    label: 'Prisma resource',
    source: 'prisma',
    packaged: 'resources/app/prisma',
  },
  {
    label: 'init-db resource',
    source: 'scripts/init-db.js',
    packaged: 'resources/app/init-db.js',
  },
  {
    label: 'adm-zip resource',
    source: 'node_modules/adm-zip',
    packaged: 'resources/app/node_modules/adm-zip',
  },
  {
    label: 'Node runtime',
    source: path.join('_client-node', process.platform === 'win32' ? 'node.exe' : 'node'),
    packaged: path.join('resources', process.platform === 'win32' ? 'node.exe' : 'node'),
  },
]

const REQUIRED_PACKAGED_FILES = [
  SERVER_EXECUTABLE,
  'resources/app/package.json',
  'resources/app/electron/dist/main.js',
  'resources/app/electron/dist/preload.js',
  'resources/app/electron/dashboard/index.html',
  'resources/app/standalone/server.js',
  'resources/app/standalone/node_modules/.prisma/client/index.js',
  'resources/app/init-db.js',
  'resources/app/node_modules/adm-zip/adm-zip.js',
  path.join('resources', process.platform === 'win32' ? 'node.exe' : 'node'),
]

const REQUIRED_PACKAGED_DIRECTORIES = [
  'resources/app/standalone/.next/static',
  'resources/app/standalone/node_modules',
  'resources/app/public',
  'resources/app/data',
  'resources/app/prisma',
]

const FORBIDDEN_BUILDER_KEYS = [
  'afterSign',
  'appx',
  'certificateFile',
  'certificatePassword',
  'cscKeyPassword',
  'cscLink',
  'forceCodeSigning',
  'msi',
  'msix',
  'nsis',
  'portable',
  'publisherName',
  'publish',
  'signtoolOptions',
  'squirrelWindows',
]

function slash(relative) {
  return relative.replace(/\\/g, '/')
}

function listFiles(root) {
  const files = []
  if (!fs.existsSync(root)) return files

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      for (const nested of listFiles(full)) files.push(path.join(entry.name, nested))
    } else if (entry.isFile()) {
      files.push(entry.name)
    }
  }

  return files.sort((left, right) => slash(left).localeCompare(slash(right)))
}

function sha256(file) {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)

  try {
    let bytesRead = 0
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    fs.closeSync(descriptor)
  }

  return hash.digest('hex')
}

function fileEvidence(file) {
  const absolutePath = path.resolve(file)
  return {
    absolutePath,
    bytes: fs.statSync(absolutePath).size,
    sha256: sha256(absolutePath),
  }
}

function readJson(issues, file, displayPath) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    issues.push(`missing project configuration: ${displayPath}`)
    return null
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    issues.push(`invalid JSON in ${displayPath}: ${error.message}`)
    return null
  }
}

function compareFile(issues, source, packaged, displayPath, label) {
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    issues.push(`missing verification source for ${label}: ${slash(path.relative(process.cwd(), source))}`)
    return
  }
  if (!fs.existsSync(packaged) || !fs.statSync(packaged).isFile()) {
    issues.push(`missing ${label}: ${slash(displayPath)}`)
    return
  }
  if (sha256(source) !== sha256(packaged)) {
    issues.push(`stale ${label}: ${slash(displayPath)}`)
  }
}

function compareDirectory(issues, sourceRoot, packagedRoot, displayRoot, label) {
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    issues.push(
      `missing verification source for ${label}: ${slash(path.relative(process.cwd(), sourceRoot))}`,
    )
    return
  }
  if (!fs.existsSync(packagedRoot) || !fs.statSync(packagedRoot).isDirectory()) {
    issues.push(`missing ${label}: ${slash(displayRoot)}`)
    return
  }

  const sourceFiles = listFiles(sourceRoot)
  const packagedFiles = listFiles(packagedRoot)
  const sourceSet = new Set(sourceFiles.map(slash))

  for (const relative of sourceFiles) {
    compareFile(
      issues,
      path.join(sourceRoot, relative),
      path.join(packagedRoot, relative),
      path.join(displayRoot, relative),
      label,
    )
  }

  for (const relative of packagedFiles) {
    if (!sourceSet.has(slash(relative))) {
      issues.push(`unexpected ${label}: ${slash(path.join(displayRoot, relative))}`)
    }
  }
}

function findForbiddenBuilderKeys(value, prefix = '') {
  if (!value || typeof value !== 'object') return []
  const findings = []

  for (const [key, nested] of Object.entries(value)) {
    const keyPath = prefix ? `${prefix}.${key}` : key
    if (FORBIDDEN_BUILDER_KEYS.includes(key)) findings.push(keyPath)
    findings.push(...findForbiddenBuilderKeys(nested, keyPath))
  }

  return findings
}

function validateBuildBoundary(issues, projectRoot) {
  const packageJson = readJson(issues, path.join(projectRoot, 'package.json'), 'package.json')
  const builder = readJson(
    issues,
    path.join(projectRoot, 'electron-builder.server.json'),
    'electron-builder.server.json',
  )

  if (packageJson) {
    for (const scriptName of ['build:electron', 'build:all']) {
      const command = packageJson.scripts?.[scriptName]
      if (command !== 'npm run build:electron:client') {
        issues.push(`package.json ${scriptName} must remain client-only: ${String(command)}`)
      }
    }

    const serverCommand = packageJson.scripts?.['build:electron:server']
    const verifier = 'node scripts/verify-electron-server-package.js'
    const cleanup = 'node scripts/cleanup-client-resources.js'
    if (typeof serverCommand !== 'string' || !serverCommand.includes(verifier)) {
      issues.push('package.json build:electron:server must run the Server package verifier')
    } else if (!serverCommand.includes(cleanup) || serverCommand.indexOf(cleanup) < serverCommand.indexOf(verifier)) {
      issues.push('package.json build:electron:server must clean staging after verification')
    }
  }

  if (builder) {
    const target = builder.win?.target
    if (target !== 'dir' && !(Array.isArray(target) && target.length === 1 && target[0] === 'dir')) {
      issues.push('electron-builder.server.json win.target must be dir')
    }

    for (const keyPath of findForbiddenBuilderKeys(builder)) {
      issues.push(`electron-builder.server.json must not configure ${keyPath}`)
    }

    const standaloneModulesMapping = builder.extraResources?.some((mapping) =>
      mapping &&
      typeof mapping === 'object' &&
      slash(String(mapping.from ?? '')).replace(/^\.\//, '') === '_client-stage/node_modules' &&
      slash(String(mapping.to ?? '')).replace(/^\.\//, '') === 'app/standalone/node_modules',
    )
    if (!standaloneModulesMapping) {
      issues.push(
        'electron-builder.server.json must explicitly copy standalone node_modules',
      )
    }
  }
}

function findServerPackageIssues({ packageRoot, projectRoot, compareSources = true }) {
  const issues = []
  validateBuildBoundary(issues, projectRoot)

  for (const relative of REQUIRED_PACKAGED_FILES) {
    const target = path.join(packageRoot, relative)
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      issues.push(`missing required file: ${slash(relative)}`)
    }
  }

  for (const relative of REQUIRED_PACKAGED_DIRECTORIES) {
    const target = path.join(packageRoot, relative)
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      issues.push(`missing required directory: ${slash(relative)}`)
    } else if (listFiles(target).length === 0) {
      issues.push(`empty required directory: ${slash(relative)}`)
    }
  }

  if (compareSources) {
    for (const group of RESOURCE_GROUPS) {
      const source = path.join(projectRoot, group.source)
      const packaged = path.join(packageRoot, group.packaged)
      if (fs.existsSync(source) && fs.statSync(source).isFile()) {
        compareFile(issues, source, packaged, group.packaged, group.label)
      } else {
        compareDirectory(issues, source, packaged, group.packaged, group.label)
      }
    }
  }

  const runtimeModules = path.join(packageRoot, 'resources', 'app', 'node_modules')
  if (fs.existsSync(runtimeModules) && fs.statSync(runtimeModules).isDirectory()) {
    for (const entry of fs.readdirSync(runtimeModules, { withFileTypes: true })) {
      if (entry.name !== 'adm-zip') {
        issues.push(
          `unexpected top-level runtime dependency: resources/app/node_modules/${slash(entry.name)}`,
        )
      }
    }
  }

  return [...new Set(issues)].sort()
}

function readInstalledVersion(projectRoot, packageName) {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'node_modules', packageName, 'package.json'), 'utf8'),
    )
    return packageJson.version ?? null
  } catch {
    return null
  }
}

function readBaselineCommit(projectRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim()
  } catch {
    return null
  }
}

function npmVersionFromUserAgent() {
  const match = process.env.npm_config_user_agent?.match(/(?:^|\s)npm\/([^\s]+)/)
  return match?.[1] ?? null
}

function inventoryResources(packageRoot) {
  const resourcesRoot = path.join(packageRoot, 'resources')
  const records = listFiles(resourcesRoot).map((relative) => {
    const file = path.join(resourcesRoot, relative)
    return {
      path: slash(path.join('resources', relative)),
      bytes: fs.statSync(file).size,
      sha256: sha256(file),
    }
  })
  const treeHash = crypto.createHash('sha256')
  for (const record of records) {
    treeHash.update(`${record.path}\0${record.bytes}\0${record.sha256}\n`)
  }
  return {
    files: records,
    summary: {
      fileCount: records.length,
      totalBytes: records.reduce((total, record) => total + record.bytes, 0),
      sha256: treeHash.digest('hex'),
    },
  }
}

function findManifestReplayIssues(manifest, packageRoot, inventory) {
  const issues = []
  if (manifest.schemaVersion !== 1) {
    issues.push(`unsupported Server candidate manifest schema: ${String(manifest.schemaVersion)}`)
  }
  if (manifest.candidateType !== 'internal-only' || manifest.publicDistribution !== false) {
    issues.push('Server candidate manifest must remain internal-only')
  }
  if (path.resolve(manifest.packageRoot ?? '') !== packageRoot) {
    issues.push(`manifest package root does not match candidate: ${String(manifest.packageRoot)}`)
  }

  const expectedFiles = new Map(
    Array.isArray(manifest.files)
      ? manifest.files.map((record) => [record.path, record])
      : [],
  )
  const currentFiles = new Map(inventory.files.map((record) => [record.path, record]))

  for (const [filePath, expected] of expectedFiles) {
    const current = currentFiles.get(filePath)
    if (!current) {
      issues.push(`manifest mismatch (missing): ${filePath}`)
    } else if (current.bytes !== expected.bytes || current.sha256 !== expected.sha256) {
      issues.push(`manifest mismatch (size or SHA-256): ${filePath}`)
    }
  }
  for (const filePath of currentFiles.keys()) {
    if (!expectedFiles.has(filePath)) {
      issues.push(`manifest mismatch (unexpected): ${filePath}`)
    }
  }

  const expectedSummary = manifest.resources ?? {}
  if (
    inventory.summary.fileCount !== expectedSummary.fileCount ||
    inventory.summary.totalBytes !== expectedSummary.totalBytes ||
    inventory.summary.sha256 !== expectedSummary.sha256
  ) {
    issues.push('manifest resource summary does not match candidate')
  }

  const actualServer = fileEvidence(path.join(packageRoot, SERVER_EXECUTABLE))
  const actualNode = fileEvidence(
    path.join(packageRoot, 'resources', process.platform === 'win32' ? 'node.exe' : 'node'),
  )
  for (const [label, expected, actual] of [
    ['Server executable', manifest.artifacts?.serverExecutable, actualServer],
    ['Node runtime', manifest.artifacts?.nodeRuntime, actualNode],
  ]) {
    if (!expected || expected.bytes !== actual.bytes || expected.sha256 !== actual.sha256) {
      issues.push(`manifest artifact mismatch: ${label}`)
    }
  }

  return issues
}

function verifyServerPackage({
  packageRoot,
  projectRoot,
  manifestPath = path.join(projectRoot, 'dist', 'server-build', 'server-candidate-manifest.json'),
}) {
  const resolvedPackageRoot = path.resolve(packageRoot)
  const resolvedProjectRoot = path.resolve(projectRoot)
  const resolvedManifestPath = path.resolve(manifestPath)
  const stagingAvailable = fs.existsSync(path.join(resolvedProjectRoot, '_client-stage')) &&
    fs.existsSync(path.join(
      resolvedProjectRoot,
      '_client-node',
      process.platform === 'win32' ? 'node.exe' : 'node',
    ))
  const issues = findServerPackageIssues({
    packageRoot: resolvedPackageRoot,
    projectRoot: resolvedProjectRoot,
    compareSources: stagingAvailable,
  })

  let existingManifest = null
  let inventory = null
  if (!stagingAvailable) {
    if (!fs.existsSync(resolvedManifestPath)) {
      issues.push(`missing Server candidate manifest: ${resolvedManifestPath}`)
    } else {
      try {
        existingManifest = JSON.parse(fs.readFileSync(resolvedManifestPath, 'utf8'))
        inventory = inventoryResources(resolvedPackageRoot)
        issues.push(...findManifestReplayIssues(existingManifest, resolvedPackageRoot, inventory))
      } catch (error) {
        issues.push(`invalid Server candidate manifest: ${error.message}`)
      }
    }
  }

  if (issues.length > 0) {
    throw new Error(`Electron Server package verification failed:\n- ${issues.join('\n- ')}`)
  }

  if (!stagingAvailable) {
    return {
      verificationMode: 'manifest-replay',
      candidateType: existingManifest.candidateType,
      packageRoot: resolvedPackageRoot,
      baselineCommit: existingManifest.baselineCommit,
      toolchain: existingManifest.toolchain,
      resources: inventory.summary,
      serverExecutable: fileEvidence(path.join(resolvedPackageRoot, SERVER_EXECUTABLE)),
      nodeRuntime: fileEvidence(
        path.join(resolvedPackageRoot, 'resources', process.platform === 'win32' ? 'node.exe' : 'node'),
      ),
      manifest: fileEvidence(resolvedManifestPath),
    }
  }

  inventory = inventoryResources(resolvedPackageRoot)
  const toolchain = {
    node: process.version,
    npm: npmVersionFromUserAgent(),
    electron: readInstalledVersion(resolvedProjectRoot, 'electron'),
    electronBuilder: readInstalledVersion(resolvedProjectRoot, 'electron-builder'),
  }
  const serverExecutable = fileEvidence(path.join(resolvedPackageRoot, SERVER_EXECUTABLE))
  const nodeRuntime = fileEvidence(
    path.join(resolvedPackageRoot, 'resources', process.platform === 'win32' ? 'node.exe' : 'node'),
  )
  const manifest = {
    schemaVersion: 1,
    candidateType: 'internal-only',
    publicDistribution: false,
    generatedAt: new Date().toISOString(),
    baselineCommit: readBaselineCommit(resolvedProjectRoot),
    platform: { platform: process.platform, arch: process.arch },
    toolchain,
    packageRoot: resolvedPackageRoot,
    resources: inventory.summary,
    artifacts: { serverExecutable, nodeRuntime },
    files: inventory.files,
  }

  fs.mkdirSync(path.dirname(resolvedManifestPath), { recursive: true })
  fs.writeFileSync(resolvedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  return {
    verificationMode: 'source-comparison',
    candidateType: manifest.candidateType,
    packageRoot: resolvedPackageRoot,
    baselineCommit: manifest.baselineCommit,
    toolchain,
    resources: inventory.summary,
    serverExecutable,
    nodeRuntime,
    manifest: fileEvidence(resolvedManifestPath),
  }
}

if (require.main === module) {
  const projectRoot = path.join(__dirname, '..')
  const packageRoot = path.join(projectRoot, 'dist', 'server-build', 'win-unpacked')

  try {
    const evidence = verifyServerPackage({ packageRoot, projectRoot })
    console.log(
      `[verify-server-package] OK (${evidence.resources.fileCount} resource files, ${evidence.resources.totalBytes} bytes checked)`,
    )
    console.log(JSON.stringify({ verification: 'electron-server-internal-candidate', ...evidence }))
  } catch (error) {
    console.error(`[verify-server-package] ${error.message}`)
    process.exitCode = 1
  }
}

module.exports = {
  findServerPackageIssues,
  verifyServerPackage,
}
