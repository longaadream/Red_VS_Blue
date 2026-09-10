// Build two local-only NSIS candidates from the already validated client stage.
const fs = require('node:fs')
const path = require('node:path')
const { build, Platform, Arch } = require('electron-builder')
const root = path.resolve(__dirname, '..')
const out = path.resolve(root, '../pr-tools/RED-202-IDE/binary-update-lean')
const runtime = process.env.RVB_QA_ELECTRON_DIST || path.resolve(root, '../red194/node_modules/electron/dist')
async function main() {
  process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL ||= '5'
  for (const version of ['0.1.3', '0.1.4']) {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'config/electron-builder.client.json')))
    Object.assign(config, {
      appId: 'com.redvsblue.client.updateqa',
      productName: 'RED vs BLUE Update QA',
      executableName: 'RED vs BLUE Update QA',
      electronDist: runtime,
      electronVersion: '43.4.0',
      compression: 'normal',
      directories: { output: path.join(out, version) },
      artifactName: 'RVB-Update-QA-${version}-Setup.${ext}',
      extraMetadata: { ...config.extraMetadata, version, name: 'red-vs-blue-update-qa', productName: 'RED vs BLUE Update QA' },
      publish: { provider: 'generic', url: 'http://127.0.0.1:18990/', useMultipleRangeRequest: false },
      nsis: { ...config.nsis, runAfterFinish: false, createDesktopShortcut: false, createStartMenuShortcut: false },
    })
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, `config-${version}.json`), JSON.stringify(config, null, 2))
    console.log(`[binary-qa] Building ${version}`)
    await build({ projectDir: root, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), config, publish: 'never' })
    const { verifyClientPackage } = require('./verify-electron-client-package.js')
    verifyClientPackage(path.join(out, version, 'win-unpacked'), path.join(root, 'data/pages'), path.join(root, 'data'), path.join(root, 'public'))
    for (const filename of [`RVB-Update-QA-${version}-Setup.exe`, `RVB-Update-QA-${version}-Setup.exe.blockmap`, 'latest.yml']) {
      if (!fs.statSync(path.join(out, version, filename)).size) throw Error('Empty build artifact: ' + filename)
    }
    console.log(`[binary-qa] ${version} package verified`)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
