import fs from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'dist', 'official-server', 'win-x64')
if (fs.existsSync(output)) {
  const resolved = fs.realpathSync.native(output), expected = path.join(fs.realpathSync.native(root), 'dist', 'official-server', 'win-x64')
  if (resolved.toLowerCase() !== expected.toLowerCase()) throw new Error('Refusing to replace a build directory outside the expected workspace path')
  fs.rmSync(resolved, { recursive: true })
}
fs.mkdirSync(output, { recursive: true })
await build({ entryPoints: [path.join(root, 'scripts/run-official-server.mjs')], outfile: path.join(output, 'server.mjs'),
  bundle: true, platform: 'node', target: 'node24', format: 'esm', tsconfig: path.join(root, 'tsconfig.json'),
  banner: { js: "import { createRequire as __rvbRequire } from 'node:module'; const require = __rvbRequire(import.meta.url);" },
})
for (const directory of ['cards','maps','pages','pieces','pve','rules','skills','status-effects','tiles','tutorial']) fs.cpSync(path.join(root, 'data', directory), path.join(output, 'data', directory), { recursive: true })
fs.copyFileSync(path.join(root,'data/skill-keywords.json'),path.join(output,'data/skill-keywords.json'))
fs.cpSync(path.join(root, 'lib/server/official/panel'), path.join(output, 'control-panel'), { recursive: true })
fs.cpSync(path.join(root, 'public'), path.join(output, 'public'), { recursive: true })
fs.cpSync(path.join(root, '_client-postgres'), path.join(output, 'postgres'), { recursive: true })
fs.copyFileSync(process.execPath, path.join(output, 'node.exe'))
fs.copyFileSync(path.join(root, 'docs/technical/RED-196-OFFICIAL-SERVER.md'), path.join(output, 'START-HERE.md'))
fs.copyFileSync(path.join(root, 'docs/technical/RED-193-FIRST-PLAYTEST.md'), path.join(output, 'RED-193-FIRST-PLAYTEST.md'))
const command = argument => '@echo off\r\ncd /d "%~dp0"\r\nset "RVB_OFFICIAL_ROOT=%~dp0"\r\n"%~dp0node.exe" "%~dp0server.mjs" ' + argument + '\r\npause\r\n'
fs.writeFileSync(path.join(output, 'Start-Official.cmd'), command(''))
fs.writeFileSync(path.join(output, 'Configure-Mail.cmd'), command('--configure'))
fs.writeFileSync(path.join(output, 'Admin.cmd'), command('--admin %*'))
fs.writeFileSync(path.join(output, 'Open-Control-Panel.cmd'), command('--panel'))
fs.writeFileSync(path.join(output, 'build.json'), JSON.stringify({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), builtAt: new Date().toISOString() }, null, 2))
console.info('[official-build]', output)
