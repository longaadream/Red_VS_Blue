import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const modes = {
  'electron-client': {
    packages: ['next', 'typescript', 'electron'],
    requiresStandalone: true,
  },
  'electron-editor': {
    packages: ['typescript', 'electron'],
    requiresStandalone: false,
  },
}

const modeName = process.argv[2]
const mode = modes[modeName]
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const currentDirectory = path.resolve(process.cwd())

function comparablePath(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isInside(root, candidate) {
  const relative = path.relative(comparablePath(root), comparablePath(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function fail(lines) {
  console.error(`[worktree-preflight] FAILED${modeName ? ` mode=${modeName}` : ''}`)
  for (const line of lines) console.error(line)
  process.exitCode = 1
}

if (!mode) {
  fail([
    `Project root: ${projectRoot}`,
    `Unsupported mode: ${modeName ?? '(missing)'}`,
    `Expected one of: ${Object.keys(modes).join(', ')}`,
  ])
} else if (comparablePath(currentDirectory) !== comparablePath(projectRoot)) {
  fail([
    `Project root: ${projectRoot}`,
    `Current directory: ${currentDirectory}`,
    'Run the Electron command from the exact worktree root shown above.',
  ])
} else {
  const packageJsonPath = path.join(projectRoot, 'package.json')
  const packageLockPath = path.join(projectRoot, 'package-lock.json')
  const nodeModulesPath = path.join(projectRoot, 'node_modules')
  const projectIssues = [packageJsonPath, packageLockPath].filter((candidate) => !fs.existsSync(candidate))

  if (projectIssues.length > 0) {
    fail([
      `Project root: ${projectRoot}`,
      'Missing required project files:',
      ...projectIssues.map((candidate) => `  - ${candidate}`),
      'This directory is not a complete npm worktree checkout.',
    ])
  } else {
    const dependencyIssues = []
    const realProjectRoot = fs.realpathSync.native(projectRoot)
    let realNodeModulesPath

    if (!fs.existsSync(nodeModulesPath)) {
      dependencyIssues.push(nodeModulesPath)
    } else {
      let nodeModulesIsLocal = true
      try {
        const nodeModulesStat = fs.lstatSync(nodeModulesPath)
        realNodeModulesPath = fs.realpathSync.native(nodeModulesPath)
        nodeModulesIsLocal = !nodeModulesStat.isSymbolicLink()
          && comparablePath(realNodeModulesPath) === comparablePath(path.join(realProjectRoot, 'node_modules'))
      } catch {
        nodeModulesIsLocal = false
      }

      if (!nodeModulesIsLocal) dependencyIssues.push(`${nodeModulesPath} (must be local to this worktree)`)
    }

    for (const packageName of mode.packages) {
      const packageJson = path.join(nodeModulesPath, ...packageName.split('/'), 'package.json')
      if (!fs.existsSync(packageJson)) {
        dependencyIssues.push(packageJson)
        continue
      }

      try {
        if (!realNodeModulesPath || !isInside(realNodeModulesPath, fs.realpathSync.native(packageJson))) {
          dependencyIssues.push(`${packageJson} (resolves outside this worktree)`)
        }
      } catch {
        dependencyIssues.push(packageJson)
      }
    }

    if (dependencyIssues.length > 0) {
      fail([
        `Project root: ${projectRoot}`,
        'Missing or invalid local dependencies:',
        ...dependencyIssues.map((candidate) => `  - ${candidate}`),
        'Recovery (run from this exact worktree):',
        `  cd "${projectRoot}"`,
        '  npm.cmd ci --foreground-scripts',
      ])
    } else if (mode.requiresStandalone) {
      const standaloneServer = path.join(projectRoot, '.next', 'standalone', 'server.js')
      if (!fs.existsSync(standaloneServer)) {
        fail([
          `Project root: ${projectRoot}`,
          'Local dependencies are present, but the Next.js standalone server is missing:',
          `  - ${standaloneServer}`,
          'Recovery (run from this exact worktree):',
          `  cd "${projectRoot}"`,
          '  npm.cmd run build',
        ])
      } else {
        console.log(`[worktree-preflight] OK mode=${modeName} root=${projectRoot}`)
      }
    } else {
      console.log(`[worktree-preflight] OK mode=${modeName} root=${projectRoot}`)
    }
  }
}
