const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { build, Platform, Arch } = require('electron-builder')
const { verifyClientPackage } = require('./verify-electron-client-package.js')
const yaml = require('js-yaml')

async function main() {
  const root = path.resolve(__dirname, '..')
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version
  const out = path.resolve(root, `../pr-tools/client-release/v${version}`)
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config/electron-builder.client.json')))
  const electronDist = process.env.RVB_RELEASE_ELECTRON_DIST
  if (!electronDist || !fs.existsSync(path.join(electronDist, 'electron.exe'))) throw Error('Set RVB_RELEASE_ELECTRON_DIST to the validated Electron runtime')
  const electronVersion = fs.readFileSync(path.join(electronDist, 'version'), 'utf8').trim()
  if (config.appId !== 'com.redvsblue.client' || config.publish.provider !== 'github' || config.publish.owner !== 'longaadream' || config.publish.repo !== 'Red_VS_Blue') throw Error('Unexpected release identity or update repository')
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim()) throw Error('Commit the release sources before building')
  // Rebuild ignored artifacts from the pinned commit; a clean Git tree alone
  // says nothing about the provenance of an old QA stage.
  for (const name of ['.next', '_client-colyseus', '_client-stage', '_client-node', '_client-postgres']) {
    const target = path.resolve(root, name)
    if (path.dirname(target) !== root || (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())) throw Error('Unsafe build output: ' + target)
  }
  const clientDist = path.join(root, 'electron-client', 'dist')
  if (fs.existsSync(clientDist) && fs.lstatSync(clientDist).isSymbolicLink()) throw Error('Unsafe client dist link')
  fs.rmSync(clientDist, { recursive: true, force: true })
  const env = { ...process.env, NODE_OPTIONS: '--max-old-space-size=1024', RVB_BUILD_LOW_MEMORY: '1', NEXT_TELEMETRY_DISABLED: '1' }
  for (const args of [
    ['scripts/build-practice-ai.mjs'], ['scripts/build-tailwind.mjs'],
    ['node_modules/next/dist/bin/next', 'build', '--webpack'],
    ['scripts/build-colyseus-server.mjs'], ['scripts/prepare-embedded-postgres.mjs'],
    ['scripts/stage-client-resources.js'], ['scripts/build-client-updater.mjs'],
    ['node_modules/typescript/bin/tsc', '-p', 'electron-client/tsconfig.json'],
  ]) {
    console.log('[client-release] Rebuild:', args.join(' '))
    execFileSync(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true })
  }
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim()) throw Error('Build changed tracked sources; commit them and rebuild')
  Object.assign(config, {
    electronDist, electronVersion, compression: 'normal',
    directories: { output: out }, artifactName: 'RED-vs-BLUE-${version}-Setup.${ext}',
  })
  process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL ||= '5'
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'release-build.json'), JSON.stringify({ version, sourceCommit, electronVersion, appId: config.appId, publish: config.publish }, null, 2))
  await build({ projectDir: root, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), config, publish: 'never' })
  verifyClientPackage(path.join(out, 'win-unpacked'), path.join(root, 'data/pages'), path.join(root, 'data'), path.join(root, 'public'))
  const packageRoot = path.join(out, 'win-unpacked/resources/app')
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json')))
  const feed = fs.readFileSync(path.join(out, 'win-unpacked/resources/app-update.yml'), 'utf8')
  if (metadata.version !== version || metadata.name === 'red-vs-blue-update-qa' || !feed.includes('provider: github') || /127\.0\.0\.1|localhost|18990|generic/.test(feed)) throw Error('Release package contains incorrect metadata/feed')
  const assets = [`RED-vs-BLUE-${version}-Setup.exe`, `RED-vs-BLUE-${version}-Setup.exe.blockmap`, 'latest.yml']
  const manifest = yaml.load(fs.readFileSync(path.join(out, 'latest.yml'), 'utf8'))
  const installer = fs.readFileSync(path.join(out, assets[0]))
  const digest512 = crypto.createHash('sha512').update(installer).digest('base64')
  if (manifest.version !== version || manifest.path !== assets[0] || manifest.sha512 !== digest512 || manifest.files?.[0]?.url !== assets[0] || manifest.files[0].sha512 !== digest512 || manifest.files[0].size !== installer.length) throw Error('latest.yml does not match the built installer')
  const checksums = assets.map(name => {
    const bytes = fs.readFileSync(path.join(out, name))
    if (!bytes.length) throw Error('Empty release artifact: ' + name)
    return `${crypto.createHash('sha256').update(bytes).digest('hex')}  ${name}`
  })
  fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), checksums.join('\n') + '\n')
  console.log(`[client-release] Verified ${version} from ${sourceCommit}: ${out}`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
