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

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function findClientPackageIssues(packageRoot, pageSourceRoot) {
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

  const packagedPagesRoot = path.join(packageRoot, 'resources', 'app', 'www')
  for (const relative of listFiles(pageSourceRoot)) {
    const source = path.join(pageSourceRoot, relative)
    const packaged = path.join(packagedPagesRoot, relative)
    const displayPath = path.join('resources', 'app', 'www', relative).replace(/\\/g, '/')

    if (!fs.existsSync(packaged) || !fs.statSync(packaged).isFile()) {
      issues.push(`missing source page asset: ${displayPath}`)
      continue
    }

    if (sha256(source) !== sha256(packaged)) {
      issues.push(`stale source page asset: ${displayPath}`)
    }
  }

  return issues
}

function verifyClientPackage(packageRoot, pageSourceRoot) {
  const issues = findClientPackageIssues(packageRoot, pageSourceRoot)
  if (issues.length > 0) {
    throw new Error(`Electron client package verification failed:\n- ${issues.join('\n- ')}`)
  }
}

if (require.main === module) {
  const projectRoot = path.join(__dirname, '..')
  const packageRoot = path.join(projectRoot, 'dist', 'client-build', 'win-unpacked')
  const pageSourceRoot = path.join(projectRoot, 'data', 'pages')

  try {
    verifyClientPackage(packageRoot, pageSourceRoot)
    console.log(`[verify-client-package] OK (${listFiles(pageSourceRoot).length} source page assets checked)`)
  } catch (error) {
    console.error(`[verify-client-package] ${error.message}`)
    process.exitCode = 1
  }
}

module.exports = {
  findClientPackageIssues,
  verifyClientPackage,
}
