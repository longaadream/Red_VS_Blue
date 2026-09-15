import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const input = path.resolve(process.argv[2] || root)
const record = JSON.parse(fs.readFileSync(path.join(root, 'config/resource-history.json'), 'utf8'))
const zip = fs.statSync(input).isFile() ? new AdmZip(input) : null
const issues = []
for (const entry of record.files) {
  try {
    const bytes = zip ? zip.getEntry(entry.path)?.getData() : fs.readFileSync(path.join(input, entry.path))
    if (!bytes) throw Error('missing')
    const hash = createHash('sha256').update(JSON.stringify(JSON.parse(bytes.toString('utf8')))).digest('hex')
    if (hash !== entry.sha256) issues.push(`${entry.path}: historical integration differs`)
  } catch {
    issues.push(`${entry.path}: missing or invalid JSON`)
  }
}
if (issues.length) {
  console.error(`Resource history verification failed:\n${issues.join('\n')}`)
  process.exitCode = 1
} else console.log(`Resource history verified: ${record.files.length} files (${input})`)
