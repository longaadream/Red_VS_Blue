import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
const root = process.cwd()
const output = path.resolve(root, '../pr-tools/RED-202-IDE/binary-update-lean')
const executable = process.env.RVB_GRAPH_ELECTRON_BINARY || path.resolve(root, '../red194/node_modules/electron/dist/electron.exe')
const env = { ...process.env, RVB_BINARY_QA_ROOT: root, RVB_BINARY_QA_OUTPUT: output }
delete env.ELECTRON_RUN_AS_NODE
fs.mkdirSync(output, { recursive: true })
const child = spawn(executable, [path.join(root, 'tests/electron/binary-update-download.cjs')], { env, windowsHide: true, stdio: 'inherit' })
const timer = setTimeout(() => { child.kill(); process.exitCode = 1 }, 300000)
child.on('error', error => { clearTimeout(timer); throw error })
child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1 })
