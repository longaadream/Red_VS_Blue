/* eslint-disable @typescript-eslint/no-require-imports */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const REQUIRED_FILES = [
  'resources/app/electron-client/dist/main.js',
  'resources/app/standalone/server.js',
  'resources/app/www/index.html',
  'resources/app/init-db.js',
  'resources/node.exe',
]

const REQUIRED_DIRECTORIES = [
  'resources/app/public',
  'resources/app/data',
  'resources/app/prisma',
]

const FORBIDDEN_FILES = ['resources/app/www/data/users.json']

const OFFLINE_DATA_ENTRIES = [
  'cards',
  'effects',
  'maps',
  'pieces',
  'pve',
  'rules',
  'skills',
  'status-effects',
  'tiles',
  'skill-keywords.json',
]

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

  return files.sort()
}

function listOfflineDataFiles(dataSourceRoot) {
  const files = []

  for (const entry of OFFLINE_DATA_ENTRIES) {
    const source = path.join(dataSourceRoot, entry)
    if (!fs.existsSync(source)) continue

    if (fs.statSync(source).isDirectory()) {
      for (const relative of listFiles(source)) files.push(path.join(entry, relative))
    } else if (fs.statSync(source).isFile()) {
      files.push(entry)
    }
  }

  return files.sort()
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function compareSourceTree(
  issues,
  sourceRoot,
  packagedRoot,
  displayRoot,
  assetLabel,
  sourceFiles = listFiles(sourceRoot),
) {
  for (const relative of sourceFiles) {
    const source = path.join(sourceRoot, relative)
    const packaged = path.join(packagedRoot, relative)
    const displayPath = path.join(displayRoot, relative).replace(/\\/g, '/')

    if (!fs.existsSync(packaged) || !fs.statSync(packaged).isFile()) {
      issues.push(`missing ${assetLabel}: ${displayPath}`)
      continue
    }

    if (sha256(source) !== sha256(packaged)) {
      issues.push(`stale ${assetLabel}: ${displayPath}`)
    }
  }
}

function findClientPackageIssues(packageRoot, pageSourceRoot, dataSourceRoot) {
  const issues = []

  for (const relative of REQUIRED_FILES) {
    const target = path.join(packageRoot, relative)
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      issues.push(`missing required file: ${relative}`)
    }
  }

  for (const relative of REQUIRED_DIRECTORIES) {
    const target = path.join(packageRoot, relative)
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      issues.push(`missing required directory: ${relative}`)
    }
  }

  for (const relative of FORBIDDEN_FILES) {
    if (fs.existsSync(path.join(packageRoot, relative))) {
      issues.push(`forbidden packaged file: ${relative}`)
    }
  }

  const packagedPagesRoot = path.join(packageRoot, 'resources', 'app', 'www')
  compareSourceTree(
    issues,
    pageSourceRoot,
    packagedPagesRoot,
    path.join('resources', 'app', 'www'),
    'source page asset',
  )
  compareSourceTree(
    issues,
    dataSourceRoot,
    path.join(packagedPagesRoot, 'data'),
    path.join('resources', 'app', 'www', 'data'),
    'offline data asset',
    listOfflineDataFiles(dataSourceRoot),
  )

  return issues
}

function verifyClientPackage(packageRoot, pageSourceRoot, dataSourceRoot) {
  const issues = findClientPackageIssues(packageRoot, pageSourceRoot, dataSourceRoot)
  if (issues.length > 0) {
    throw new Error(`Electron client package verification failed:\n- ${issues.join('\n- ')}`)
  }
}

if (require.main === module) {
  const projectRoot = path.join(__dirname, '..')
  const packageRoot = path.join(projectRoot, 'dist', 'client-build', 'win-unpacked')
  const pageSourceRoot = path.join(projectRoot, 'data', 'pages')
  const dataSourceRoot = path.join(projectRoot, 'data')

  try {
    verifyClientPackage(packageRoot, pageSourceRoot, dataSourceRoot)
    console.log(
      `[verify-client-package] OK (${listFiles(pageSourceRoot).length} source page assets and ${listOfflineDataFiles(dataSourceRoot).length} offline data assets checked)`,
    )
  } catch (error) {
    console.error(`[verify-client-package] ${error.message}`)
    process.exitCode = 1
  }
}

module.exports = {
  findClientPackageIssues,
  verifyClientPackage,
}
