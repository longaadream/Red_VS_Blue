import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
const root = process.cwd()
const output = path.resolve(root, 'docs/qa/RED-202-IDE/auto-update-smoke')
fs.mkdirSync(output, { recursive: true })
const executable = process.env.RVB_GRAPH_ELECTRON_BINARY || path.join(root, 'node_modules/electron/dist/electron.exe')
const userData = fs.mkdtempSync(path.join(tmpdir(), 'rvb-update-smoke-'))
const env = { ...process.env, RVB_UPDATE_SMOKE_ROOT: root, RVB_UPDATE_SMOKE_OUTPUT: output, RVB_UPDATE_SMOKE_USER_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(executable, [path.join(root, 'tests/electron/official-updates-smoke.cjs')], { env, windowsHide: true, stdio: 'pipe' })
child.stdout.on('data', bytes => process.stdout.write(bytes))
child.stderr.on('data', bytes => process.stderr.write(bytes))
const timer = setTimeout(() => { child.kill(); process.exitCode = 1 }, 180000)
child.on('error', error => { clearTimeout(timer); throw error })
child.on('exit', code => { clearTimeout(timer); fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); process.exitCode = code ?? 1; console.log('Official updates smoke exit:', code, output) })
