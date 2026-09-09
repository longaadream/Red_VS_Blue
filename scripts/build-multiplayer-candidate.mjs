import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
function cleanCommit() {
  if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Commit candidate sources before building')
  return git('rev-parse', 'HEAD')
}
const commit = cleanCommit()
const candidate = JSON.parse(fs.readFileSync(path.join(root, 'data/pages/config/multiplayer.json'), 'utf8'))
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:electron:client'], {
  cwd: root, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true,
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status || 1)
if (cleanCommit() !== commit) throw new Error('Source changed during candidate build; rebuild from a stable commit')
fs.writeFileSync(path.join(root, 'dist/client-build/win-unpacked/resources/candidate-build.json'), JSON.stringify({
  format: 'rvb-candidate-build-v1', commit, candidate: candidate.candidateId, version: candidate.version, builtAt: new Date().toISOString(),
}, null, 2) + '\n')
