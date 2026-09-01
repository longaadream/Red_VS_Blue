import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

export const POSTGRES_VERSION = '16.15-2'
export const POSTGRES_ARCHIVE = `postgresql-${POSTGRES_VERSION}-windows-x64-binaries.zip`
export const POSTGRES_URL = `https://get.enterprisedb.com/postgresql/${POSTGRES_ARCHIVE}`
export const POSTGRES_SHA256 = '840b9d265f6ab6c0a971c1d8e9096de564950d38dc2a5ccd98c8820179ecf115'
export const POSTGRES_MANIFEST_SHA256 = '2cf0c900925debf9ec04a38ab26266a60ffd25f37190498e288a98fa4a863313'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cacheRoot = path.join(projectRoot, '.cache', 'embedded-postgres')
const archivePath = path.join(cacheRoot, POSTGRES_ARCHIVE)
const stageRoot = path.join(projectRoot, '_client-postgres')
const allowedPrefixes = ['pgsql/bin/', 'pgsql/lib/', 'pgsql/share/']
const licenseEntries = new Map([
  ['pgsql/server_license.txt', 'licenses/server_license.txt'],
  ['pgsql/commandlinetools_3rd_party_licenses.txt', 'licenses/commandlinetools_3rd_party_licenses.txt'],
])
const excludedFiles = new Set([
  'pgsql/bin/stackbuilder.exe',
  'pgsql/bin/libcurl.dll',
  'pgsql/bin/libcurl.lib',
])

function isExcludedFile(relative) {
  return excludedFiles.has(relative) || /^pgsql\/(?:bin|lib)\/wx/i.test(relative)
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

async function downloadArchive() {
  fs.mkdirSync(cacheRoot, { recursive: true })
  const temporaryPath = `${archivePath}.download`
  const response = await fetch(POSTGRES_URL, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`PostgreSQL download failed: HTTP ${response.status}`)
  }
  fs.rmSync(temporaryPath, { force: true })
  const output = fs.createWriteStream(temporaryPath, { flags: 'wx' })
  try {
    for await (const chunk of response.body) {
      if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve))
    }
    await new Promise((resolve, reject) => output.end(error => error ? reject(error) : resolve()))
    fs.renameSync(temporaryPath, archivePath)
  } catch (error) {
    output.destroy()
    try { fs.unlinkSync(temporaryPath) } catch {}
    throw error
  }
}

export async function prepareEmbeddedPostgres() {
  if (!fs.existsSync(archivePath)) await downloadArchive()
  const archiveHash = sha256File(archivePath)
  if (archiveHash !== POSTGRES_SHA256) {
    throw new Error(`PostgreSQL archive SHA-256 mismatch: expected ${POSTGRES_SHA256}, got ${archiveHash}`)
  }

  fs.rmSync(stageRoot, { recursive: true, force: true })
  fs.mkdirSync(stageRoot, { recursive: true })
  const zip = new AdmZip(archivePath)
  const files = []
  for (const entry of zip.getEntries()) {
    const relative = entry.entryName.replaceAll('\\', '/')
    if (entry.isDirectory) continue
    if (isExcludedFile(relative)) continue
    const include = allowedPrefixes.some(prefix => relative.startsWith(prefix)) || licenseEntries.has(relative)
    if (!include) continue
    if (relative.includes('../') || path.isAbsolute(relative)) {
      throw new Error(`Unsafe PostgreSQL archive entry: ${relative}`)
    }
    const targetRelative = licenseEntries.get(relative) ?? relative
    const target = path.join(stageRoot, ...targetRelative.split('/'))
    const contents = entry.getData()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, contents)
    files.push({ path: targetRelative, size: contents.byteLength, sha256: sha256Buffer(contents) })
  }

  for (const required of ['postgres.exe', 'initdb.exe', 'pg_ctl.exe', 'pg_isready.exe', 'psql.exe', 'createdb.exe']) {
    if (!files.some(file => file.path === `pgsql/bin/${required}`)) {
      throw new Error(`Prepared PostgreSQL runtime is missing pgsql/bin/${required}`)
    }
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const manifest = {
    formatVersion: 1,
    product: 'PostgreSQL',
    version: POSTGRES_VERSION,
    platform: 'win32-x64',
    sourceUrl: POSTGRES_URL,
    archiveSha256: POSTGRES_SHA256,
    files,
  }
  const manifestPath = path.join(stageRoot, 'runtime-manifest.json')
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )
  const manifestHash = sha256File(manifestPath)
  if (manifestHash !== POSTGRES_MANIFEST_SHA256) {
    throw new Error(`PostgreSQL runtime inventory mismatch: expected ${POSTGRES_MANIFEST_SHA256}, got ${manifestHash}`)
  }
  const bytes = files.reduce((total, file) => total + file.size, 0)
  console.log(`[embedded-postgres] Prepared PostgreSQL ${POSTGRES_VERSION}: ${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MiB`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareEmbeddedPostgres().catch(error => {
    console.error(`[embedded-postgres] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
