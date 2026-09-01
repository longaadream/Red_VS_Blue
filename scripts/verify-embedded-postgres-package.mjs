import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  POSTGRES_MANIFEST_SHA256,
  POSTGRES_SHA256,
  POSTGRES_URL,
  POSTGRES_VERSION,
} from './prepare-embedded-postgres.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requestedRoot = process.argv[2]
const runtimeRoot = requestedRoot
  ? path.resolve(requestedRoot)
  : path.join(projectRoot, 'dist', 'client-build', 'win-unpacked', 'resources', 'postgres')
const requiredExecutables = ['postgres.exe', 'initdb.exe', 'pg_ctl.exe', 'pg_isready.exe', 'psql.exe', 'createdb.exe']
const forbiddenDirectories = ['pgAdmin 4', 'StackBuilder', 'include', 'doc']
const forbiddenFiles = [
  'pgsql/bin/stackbuilder.exe',
  'pgsql/bin/libcurl.dll',
  'pgsql/bin/libcurl.lib',
]
const expectedInventoryCount = 1618
const allowedPrefixes = ['pgsql/bin/', 'pgsql/lib/', 'pgsql/share/']
const allowedExactFiles = new Set([
  'licenses/server_license.txt',
  'licenses/commandlinetools_3rd_party_licenses.txt',
])

function isAllowedRuntimePath(relative) {
  return allowedExactFiles.has(relative) || allowedPrefixes.some(prefix => relative.startsWith(prefix))
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function listFiles(root, relativeRoot = '') {
  const files = []
  for (const entry of fs.readdirSync(path.join(root, relativeRoot), { withFileTypes: true })) {
    const relative = path.posix.join(relativeRoot.replaceAll('\\', '/'), entry.name)
    if (entry.isDirectory()) files.push(...listFiles(root, relative))
    else if (entry.isFile()) files.push(relative)
  }
  return files
}

export function verifyEmbeddedPostgres(root = runtimeRoot) {
  const rootManifest = path.join(root, 'runtime-manifest.json')
  if (!fs.existsSync(rootManifest)) throw new Error(`Missing runtime manifest: ${rootManifest}`)
  if (sha256File(rootManifest) !== POSTGRES_MANIFEST_SHA256) {
    throw new Error('Embedded PostgreSQL runtime manifest SHA-256 mismatch')
  }
  const manifest = JSON.parse(fs.readFileSync(rootManifest, 'utf8'))
  if (
    manifest.formatVersion !== 1
    || manifest.product !== 'PostgreSQL'
    || manifest.platform !== 'win32-x64'
    || manifest.version !== POSTGRES_VERSION
    || manifest.sourceUrl !== POSTGRES_URL
    || manifest.archiveSha256 !== POSTGRES_SHA256
    || !Array.isArray(manifest.files)
    || manifest.files.length !== expectedInventoryCount
  ) {
    throw new Error('Unsupported embedded PostgreSQL runtime manifest')
  }
  const issues = []
  for (const executable of requiredExecutables) {
    const relative = `pgsql/bin/${executable}`
    if (!fs.existsSync(path.join(root, ...relative.split('/')))) issues.push(`missing ${relative}`)
  }
  for (const forbidden of forbiddenDirectories) {
    if (fs.existsSync(path.join(root, 'pgsql', forbidden))) issues.push(`forbidden pgsql/${forbidden}`)
  }
  for (const forbidden of forbiddenFiles) {
    if (fs.existsSync(path.join(root, ...forbidden.split('/')))) issues.push(`forbidden ${forbidden}`)
  }
  for (const relative of listFiles(root)) {
    if (/^pgsql\/(?:bin|lib)\/wx/i.test(relative)) issues.push(`forbidden ${relative}`)
  }
  const declared = new Set()
  for (const file of manifest.files) {
    const relative = String(file.path)
    if (
      relative.includes('..')
      || relative.includes('\\')
      || path.isAbsolute(relative)
      || !isAllowedRuntimePath(relative)
    ) {
      issues.push(`unsafe manifest path ${relative}`)
      continue
    }
    if (declared.has(relative)) {
      issues.push(`duplicate manifest path ${relative}`)
      continue
    }
    declared.add(relative)
    const target = path.join(root, ...relative.split('/'))
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      issues.push(`missing ${relative}`)
      continue
    }
    if (fs.statSync(target).size !== file.size) issues.push(`size mismatch ${relative}`)
    else if (sha256File(target) !== file.sha256) issues.push(`SHA-256 mismatch ${relative}`)
  }
  for (const relative of listFiles(root)) {
    if (relative !== 'runtime-manifest.json' && !declared.has(relative)) {
      issues.push(`unexpected runtime file ${relative}`)
    }
  }
  if (issues.length > 0) throw new Error(`Embedded PostgreSQL verification failed:\n- ${issues.join('\n- ')}`)
  return manifest
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = verifyEmbeddedPostgres(runtimeRoot)
    console.log(`[embedded-postgres] Verified PostgreSQL ${manifest.version} at ${runtimeRoot}`)
  } catch (error) {
    console.error(`[embedded-postgres] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
