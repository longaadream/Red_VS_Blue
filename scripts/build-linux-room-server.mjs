import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'

// Build on the developer machine; never ship accounts, credentials or node_modules.
const root = path.resolve(import.meta.dirname, '..')
const outputRoot = path.join(root, 'output', 'linux-room-server')
fs.mkdirSync(outputRoot, { recursive: true })
const output = fs.mkdtempSync(path.join(outputRoot, 'candidate-'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const files = []
function copyTree(source, destination, accept) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Unexpected content symlink: ${entry.name}`)
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isDirectory()) copyTree(from, to, accept)
    else if (entry.isFile() && accept(from)) {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(from, to)
    }
  }
}
copyTree(path.join(root, 'data'), path.join(output, 'data'), file =>
  path.extname(file) === '.json' && path.relative(path.join(root, 'data'), file) !== 'users.json')
copyTree(path.join(root, 'public', 'images'), path.join(output, 'public', 'images'), file =>
  /\.(png|jpe?g|svg|webp)$/i.test(file))
await build({
  entryPoints: [path.join(root, 'scripts', 'run-colyseus-server.mjs')],
  outfile: path.join(output, 'colyseus-server.mjs'), bundle: true,
  platform: 'node', target: 'node24', format: 'esm', logLevel: 'info',
  tsconfig: path.join(root, 'tsconfig.json'),
  banner: { js: "import { createRequire as __rvbCreateRequire } from 'node:module'; const require = __rvbCreateRequire(import.meta.url);" },
})
await build({
  entryPoints: [path.join(root, 'scripts', 'run-linux-official-server.mjs')],
  outfile: path.join(output, 'official-server.mjs'), bundle: true,
  platform: 'node', target: 'node24', format: 'esm', tsconfig: path.join(root, 'tsconfig.json'),
  banner: { js: "import { createRequire as __rvbCreateRequire } from 'node:module'; const require = __rvbCreateRequire(import.meta.url);" },
})
// Use the production content resolver on both trees, rather than inventing a server identity.
const checker = await build({
  stdin: { contents: "export { createBundledBaseProfileV1 } from './lib/content-pipeline/runtime/bundled-base.ts'", resolveDir: root },
  bundle: true, platform: 'node', target: 'node24', format: 'esm', write: false,
})
const checkFile = path.join(output, 'verify-profile.mjs')
fs.writeFileSync(checkFile, checker.outputFiles[0].contents)
const { createBundledBaseProfileV1 } = await import((await import('node:url')).pathToFileURL(checkFile).href)
const sourceProfile = createBundledBaseProfileV1(root)
const packagedProfile = createBundledBaseProfileV1(output)
if (sourceProfile.profile.resolvedProfileHash !== packagedProfile.profile.resolvedProfileHash || !sourceProfile.profile.resolvedProfileHash) {
  throw new Error('Packaged content identity differs from the source profile')
}
fs.unlinkSync(checkFile)
copyTree(path.join(root, 'lib/server/official/panel'), path.join(output, 'control-panel'), () => true)
copyTree(path.join(root, 'data/pages/images/tabletop'), path.join(output, 'data/pages/images/tabletop'), file => /\.(svg|ttf)$/.test(file))
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim())
fs.writeFileSync(path.join(output, 'build.json'), JSON.stringify({
  sourceHead, dirty, createdAt: new Date().toISOString(), nodeMajor: 24,
  resolvedProfileHash: packagedProfile.profile.resolvedProfileHash,
}, null, 2) + '\n')
function inventory(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) inventory(absolute)
    else files.push(`${hash(fs.readFileSync(absolute))}  ${path.relative(output, absolute).split(path.sep).join('/')}`)
  }
}
inventory(output)
fs.writeFileSync(path.join(output, 'SHA256SUMS'), files.sort().join('\n') + '\n')
console.log(JSON.stringify({ output, files: files.length, resolvedProfileHash: packagedProfile.profile.resolvedProfileHash }))
