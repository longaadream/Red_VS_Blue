import path from 'node:path'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'dist/multiplayer-qa/official-load-smoke.mjs')
await build({ entryPoints: [path.join(root, 'tests/electron/official-load-smoke.mjs')], outfile: output, bundle: true, platform: 'node', target: 'node24', format: 'esm', tsconfig: path.join(root, 'tsconfig.json'), banner: { js: "import { createRequire as __rvbRequire } from 'node:module'; const require = __rvbRequire(import.meta.url);" } })
const child = spawn(process.execPath, [output], { cwd: root, stdio: 'inherit', windowsHide: true })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
