/* eslint-disable @typescript-eslint/no-require-imports */

const asar = require('@electron/asar')
const crypto = require('crypto')
const fs = require('fs')
const { createRequire } = require('module')
const path = require('path')

const REQUIRED_ARCHIVE_FILES = [
  'electron-editor/dist/main.js',
  'electron-editor/dist/preload.js',
  'electron-editor/ui/index.html',
  'package.json',
]

const EDITOR_RUNTIME_PACKAGES = [
  'jszip',
  'lie',
  'pako',
  'setimmediate',
  'immediate',
  'core-util-is',
  'inherits',
  'isarray',
  'process-nextick-args',
  'util-deprecate',
]

const REQUIRED_EXTERNAL_DIRECTORIES = [
  'resources/app/data',
  'resources/app/scripts',
  ...EDITOR_RUNTIME_PACKAGES.map(packageName => `resources/app/node_modules/${packageName}`),
]

const FORBIDDEN_LOOSE_FILES = [
  'resources/app/electron-editor/dist/main.js',
  'resources/app/electron-editor/ui/index.html',
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

function normalizeArchiveEntry(entry) {
  return entry.replace(/^[/\\]+/, '').replace(/\\/g, '/')
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function compareSourceTree(issues, sourceRoot, packagedRoot, displayRoot, assetLabel) {
  for (const relative of listFiles(sourceRoot)) {
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

function findEditorPackageIssues(packageRoot, projectRoot, portablePath) {
  const issues = []
  const archivePath = path.join(packageRoot, 'resources', 'app.asar')

  if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
    issues.push('missing editor archive: resources/app.asar')
  } else {
    try {
      const entries = new Set(asar.listPackage(archivePath).map(normalizeArchiveEntry))
      for (const relative of REQUIRED_ARCHIVE_FILES) {
        if (!entries.has(relative)) issues.push(`missing archived editor file: ${relative}`)
      }
      if ([...entries].some(relative => relative.startsWith('node_modules/'))) {
        issues.push('unexpected node_modules inside editor archive')
      }

      if (entries.has('package.json')) {
        const metadata = JSON.parse(asar.extractFile(archivePath, 'package.json').toString('utf8'))
        if (metadata.main !== 'electron-editor/dist/main.js') {
          issues.push(`unexpected archived main entry: ${String(metadata.main)}`)
        }
      }
    } catch (error) {
      issues.push(`unreadable editor archive: ${error.message}`)
    }
  }

  for (const relative of REQUIRED_EXTERNAL_DIRECTORIES) {
    const target = path.join(packageRoot, relative)
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      issues.push(`missing external editor directory: ${relative}`)
    }
  }

  for (const relative of FORBIDDEN_LOOSE_FILES) {
    if (fs.existsSync(path.join(packageRoot, relative))) {
      issues.push(`unexpected loose editor file: ${relative}`)
    }
  }

  compareSourceTree(
    issues,
    path.join(projectRoot, 'data'),
    path.join(packageRoot, 'resources', 'app', 'data'),
    path.join('resources', 'app', 'data'),
    'editor data asset',
  )
  compareSourceTree(
    issues,
    path.join(projectRoot, 'scripts'),
    path.join(packageRoot, 'resources', 'app', 'scripts'),
    path.join('resources', 'app', 'scripts'),
    'editor script asset',
  )
  for (const packageName of EDITOR_RUNTIME_PACKAGES) {
    compareSourceTree(
      issues,
      path.join(projectRoot, 'node_modules', packageName),
      path.join(packageRoot, 'resources', 'app', 'node_modules', packageName),
      path.join('resources', 'app', 'node_modules', packageName),
      'editor runtime asset',
    )
  }

  try {
    const buildScript = path.join(
      packageRoot,
      'resources',
      'app',
      'scripts',
      'build-resource-pack.js',
    )
    const jszipEntry = createRequire(buildScript).resolve('jszip')
    const expectedRoot = path.join(packageRoot, 'resources', 'app', 'node_modules', 'jszip')
    if (jszipEntry !== expectedRoot && !jszipEntry.startsWith(`${expectedRoot}${path.sep}`)) {
      issues.push(`unexpected JSZip runtime path: ${jszipEntry}`)
    }
  } catch (error) {
    issues.push(`unresolvable editor JSZip runtime: ${error.message}`)
  }

  if (portablePath) {
    if (!fs.existsSync(portablePath) || !fs.statSync(portablePath).isFile()) {
      issues.push(`missing editor portable: ${path.basename(portablePath)}`)
    } else if (fs.statSync(portablePath).size === 0) {
      issues.push(`empty editor portable: ${path.basename(portablePath)}`)
    }
  }

  return issues
}

function verifyEditorPackage(packageRoot, projectRoot, portablePath) {
  const issues = findEditorPackageIssues(packageRoot, projectRoot, portablePath)
  if (issues.length > 0) {
    throw new Error(`Electron editor package verification failed:\n- ${issues.join('\n- ')}`)
  }
}

if (require.main === module) {
  if (process.platform !== 'win32') {
    console.log('[verify-editor-package] skipped: Windows candidate verification only')
  } else {
    const projectRoot = path.join(__dirname, '..')
    const outputRoot = path.join(projectRoot, 'dist', 'editor')
    const packageRoot = path.join(outputRoot, 'win-unpacked')
    const packageMetadata = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
    const builderConfig = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'electron-builder.editor.json'), 'utf8'),
    )
    const portablePath = path.join(
      outputRoot,
      `${builderConfig.productName} ${packageMetadata.version}.exe`,
    )

    try {
      verifyEditorPackage(packageRoot, projectRoot, portablePath)
      console.log(
        `[verify-editor-package] OK (${listFiles(path.join(projectRoot, 'data')).length} data assets, ${listFiles(path.join(projectRoot, 'scripts')).length} script assets, and ${EDITOR_RUNTIME_PACKAGES.reduce((total, packageName) => total + listFiles(path.join(projectRoot, 'node_modules', packageName)).length, 0)} runtime assets checked)`,
      )
    } catch (error) {
      console.error(`[verify-editor-package] ${error.message}`)
      process.exitCode = 1
    }
  }
}

module.exports = {
  EDITOR_RUNTIME_PACKAGES,
  findEditorPackageIssues,
  verifyEditorPackage,
}
