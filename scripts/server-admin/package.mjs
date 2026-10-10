import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { TOOL_VERSION } from './admin.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const output = path.resolve(process.argv[2] || path.join(root, 'dist/server-admin-' + TOOL_VERSION))
await fs.mkdir(output, { recursive: true })
if ((await fs.readdir(output)).length) throw Error('输出目录必须为空，避免覆盖正在使用的管理工具。')
const files = [
  ...['admin.mjs', 'remote.sh', 'index.html', 'ops-fragment.html', 'style.css', 'ui.js', 'bridge.js', 'README.md'].map(name => 'scripts/server-admin/' + name),
  ...['index.html', 'panel.css', 'panel.js'].map(name => 'lib/server/official/panel/' + name),
  'data/pages/images/tabletop/table-wood.svg',
  'data/pages/images/tabletop/ZCOOLKuaiLe-Regular.ttf',
]
for (const file of files) {
  await fs.mkdir(path.dirname(path.join(output, file)), { recursive: true })
  await fs.copyFile(path.join(root, file), path.join(output, file))
}
await fs.copyFile(process.execPath, path.join(output, process.platform === 'win32' ? 'node.exe' : 'node'))
await fs.writeFile(path.join(output, 'start.cmd'), '@echo off\r\ncd /d "%~dp0"\r\n"%~dp0node.exe" "%~dp0scripts\\server-admin\\admin.mjs"\r\npause\r\n')
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim())
await fs.writeFile(path.join(output, 'build.json'), JSON.stringify({ toolVersion: TOOL_VERSION, commit, dirty, builtAt: new Date().toISOString() }, null, 2))
const inventory = [...files, process.platform === 'win32' ? 'node.exe' : 'node', 'start.cmd', 'build.json']
const hashes = await Promise.all(inventory.map(async file => createHash('sha256').update(await fs.readFile(path.join(output, file))).digest('hex') + '  ' + file))
await fs.writeFile(path.join(output, 'SHA256SUMS'), hashes.join('\n') + '\n')
console.log(output)
