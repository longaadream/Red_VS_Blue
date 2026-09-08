import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import AdmZip from 'adm-zip'

const root = path.resolve(import.meta.dirname, '..')
const id = process.argv[2] || 'RED-193-rc1'
if (!/^[A-Za-z0-9._-]{1,60}$/.test(id)) throw new Error('Invalid candidate ID')
const windowsRoot = path.join(root, 'dist', 'client-build', 'win-unpacked')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Commit candidate sources before packaging')
const commit = git('rev-parse', 'HEAD')
const built = JSON.parse(fs.readFileSync(path.join(windowsRoot, 'resources/candidate-build.json'), 'utf8'))
const config = JSON.parse(fs.readFileSync(path.join(windowsRoot, 'resources/app/www/config/multiplayer.json'), 'utf8'))
if (built.commit !== commit || built.candidate !== id || config.candidateId !== id || config.version !== built.version) throw new Error('Candidate ID or source commit differs from built client; update config and run build:multiplayer')
for (const file of ['RED vs BLUE.exe', 'resources/node.exe', 'resources/app/www/multiplayer.html', 'resources/postgres/runtime-manifest.json']) {
  if (!fs.existsSync(path.join(windowsRoot, file))) throw new Error(`Build and verify the Windows client before packaging: ${file}`)
}
const output = path.join(root, 'dist', 'multiplayer', id)
fs.mkdirSync(output, { recursive: true })
const filename = `Red-vs-Blue-0.1.0-${id}`
const windowsZip = path.join(output, `${filename}-Windows-x64.zip`)
const relayZip = path.join(output, `${filename}-Relay.zip`)
if (fs.existsSync(windowsZip) || fs.existsSync(relayZip)) throw new Error('Candidate archives already exist; use a new candidate ID')
const instructions = fs.readFileSync(path.join(root, id.startsWith('RED-196-') ? 'docs/technical/RED-196-OFFICIAL-SERVER.md' : 'docs/technical/RED-193-FIRST-PLAYTEST.md'), 'utf8')
const windows = new AdmZip()
windows.addLocalFolder(windowsRoot, 'Red-vs-Blue')
windows.addFile('START-HERE.md', Buffer.from(instructions))
windows.addLocalFile(path.join(root,'docs/technical/RED-193-FIRST-PLAYTEST.md'))
windows.writeZip(windowsZip)
console.log(`[candidate] ${windowsZip}`)
const relay = new AdmZip()
for (const file of ['package.json', 'package-lock.json', 'protocol.mjs', 'relay.mjs', 'start.mjs', 'Dockerfile']) relay.addLocalFile(path.join(root, 'multiplayer-relay', file), 'multiplayer-relay')
for (const file of ['compose.yaml', 'Caddyfile', '.env.example']) relay.addLocalFile(path.join(root, 'deploy/multiplayer-relay', file), 'deploy/multiplayer-relay')
relay.addFile('START-HERE.md', Buffer.from(instructions))
relay.addLocalFile(path.join(root,'docs/technical/RED-193-FIRST-PLAYTEST.md'))
relay.writeZip(relayZip)
const artifacts = [windowsZip, relayZip].map(file => ({ file: path.basename(file), bytes: fs.statSync(file).size, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }))
const manifest = { format: 'rvb-multiplayer-candidate-v1', candidate: id, version: built.version, commit, builtAt: built.builtAt, packagedAt: new Date().toISOString(), publicEndpointConfigured: Boolean(config.relayUrl), status: 'candidate-requires-public-network-acceptance', artifacts }
fs.writeFileSync(path.join(output, 'release.json'), JSON.stringify(manifest, null, 2) + '\n')
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), artifacts.map(a => `${a.sha256}  ${a.file}`).join('\n') + '\n')
fs.writeFileSync(path.join(output, 'START-HERE.md'), instructions)
console.log(JSON.stringify(manifest, null, 2))

fs.copyFileSync(path.join(root,'docs/technical/RED-193-FIRST-PLAYTEST.md'),path.join(output,'RED-193-FIRST-PLAYTEST.md'))
