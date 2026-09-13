import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { androidArtifacts, verifyPublicApk } from './android-release-artifacts.mjs'
import { sha256 } from './apk-delta.mjs'

const repo = 'longaadream/Red_VS_Blue'
const root = path.resolve(import.meta.dirname, '..')
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
export function checkWindows(dir, version, commit) {
  const receipt = read(path.join(dir, 'release-build.json'))
  if (receipt.version !== version || receipt.sourceCommit !== commit || receipt.appId !== 'com.redvsblue.client' || receipt.publish?.provider !== 'github' || receipt.publish?.owner !== 'longaadream' || receipt.publish?.repo !== 'Red_VS_Blue') throw Error('Windows build source/version/feed mismatch')
  const name = `RED-vs-BLUE-${version}-Setup.exe`, bytes = fs.readFileSync(path.join(dir, name))
  const hash = createHash('sha512').update(bytes).digest('base64'), manifest = yaml.load(fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8'))
  if (!bytes.length || manifest.version !== version || manifest.path !== name || manifest.sha512 !== hash || manifest.files?.length !== 1 || manifest.files[0].url !== name || manifest.files[0].size !== bytes.length || manifest.files[0].sha512 !== hash) throw Error('Windows update manifest mismatch')
  const blockmap = fs.readFileSync(path.join(dir, name + '.blockmap'))
  if (!blockmap.length) throw Error('Windows blockmap missing')
  return new Map([[name, bytes], [name + '.blockmap', blockmap], ['latest.yml', fs.readFileSync(path.join(dir, 'latest.yml'))]])
}
export function verifyBundle(directory) {
  const record = read(path.join(directory, 'release-bundle.json'))
  if (record.schemaVersion !== 'rvb-client-release/v1' || !/^\d+\.\d+\.\d+$/.test(record.version) || record.tag !== `v${record.version}` || !/^[0-9a-f]{40}$/.test(record.sourceCommit)) throw Error('Invalid release bundle')
  const names = record.assets.map(a => a.name)
  const required = [`RED-vs-BLUE-${record.version}-Setup.exe`, `RED-vs-BLUE-${record.version}-Setup.exe.blockmap`, 'latest.yml', `RED-vs-BLUE-${record.version}-Android.apk`, 'android-latest.json']
  if (new Set(names).size !== names.length || required.some(n => !names.includes(n))) throw Error('Both platforms and update metadata are required')
  for (const asset of record.assets) {
    if (!/^[A-Za-z0-9._-]+$/.test(asset.name) || !/^[0-9a-f]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size < 1) throw Error('Invalid artifact descriptor')
    const bytes = fs.readFileSync(path.join(directory, asset.name))
    if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256) throw Error('Release artifact changed: ' + asset.name)
  }
  const android = read(path.join(directory, 'android-latest.json'))
  const apk = record.assets.find(a => a.name === required[3])
  const windows = yaml.load(fs.readFileSync(path.join(directory, 'latest.yml'), 'utf8'))
  const exe = fs.readFileSync(path.join(directory, required[0])), sha512 = createHash('sha512').update(exe).digest('base64')
  if (windows.version !== record.version || windows.path !== required[0] || windows.sha512 !== sha512 || windows.files?.length !== 1 || windows.files[0].url !== required[0] || windows.files[0].size !== exe.length || windows.files[0].sha512 !== sha512) throw Error('Windows update manifest mismatch')
  if (android.schemaVersion !== 'rvb-android-update/v1' || !Number.isSafeInteger(android.versionCode) || android.versionCode < 1 || android.versionCode !== record.androidVersionCode || !Number.isSafeInteger(android.minSdk) || android.minSdk < 1 || android.debuggable !== false || !/^[a-f0-9]{64}$/.test(record.androidSignerSha256) || JSON.stringify(android.signers) !== JSON.stringify([record.androidSignerSha256])) throw Error('Android release metadata mismatch')
  if (android.versionName !== record.version && android.versionName !== `${record.version}-demo`) throw Error('Android/Windows versions differ')
  if (android.packageName !== 'com.redvsblue.client' || android.sha256 !== apk.sha256 || android.size !== apk.size || android.url !== `https://github.com/${repo}/releases/download/${record.tag}/${apk.name}`) throw Error('Android update manifest mismatch')
  if (!Array.isArray(android.deltas) || android.deltas.length > 8) throw Error('Invalid delta list')
  const referenced = new Set(required)
  for (const delta of android.deltas) {
    const name = `RED-vs-BLUE-Android-${delta.fromVersionCode}-to-${android.versionCode}.rvbdelta`
    const asset = record.assets.find(a=>a.name===name)
    if (!Number.isSafeInteger(delta.fromVersionCode) || delta.fromVersionCode < 1 || delta.fromVersionCode >= android.versionCode || delta.format !== 'rvb-apk-copy-gzip/v1' || !/^[a-f0-9]{64}$/.test(delta.baseSha256) || !asset || delta.size >= apk.size || asset.size !== delta.size || asset.sha256 !== delta.sha256 || delta.url !== `https://github.com/${repo}/releases/download/${record.tag}/${name}` || referenced.has(name)) throw Error('Invalid/missing delta artifact')
    referenced.add(name)
  }
  if (names.some(name=>!referenced.has(name))) throw Error('Unexpected release artifact')
  return record
}

function runCommand(command, env) {
  if (!Array.isArray(command) || !command.length || command.some(a => typeof a !== 'string')) throw Error('Build command must be an executable/arguments array')
  execFileSync(command[0], command.slice(1), { cwd: root, env, stdio: 'inherit', windowsHide: true })
}

export function buildBundle(config) {
  const version = read(path.join(root, 'package.json')).version, commit = git(['rev-parse', 'HEAD'])
  if (!/^\d+\.\d+\.\d+$/.test(version) || git(['status', '--porcelain'])) throw Error('Commit all release sources before building')
  if (!/stageDemo/.test(fs.readFileSync(path.join(root,'android/app/build.gradle'),'utf8'))) throw Error('Integrate the Android public demo build from the UI issue before synchronized release')
  if (!Number.isSafeInteger(config.androidVersionCode) || config.androidVersionCode < 1 || !/^[0-9a-f]{64}$/.test(config.androidSignerSha256)) throw Error('Provide Android versionCode and existing public signing certificate SHA-256')
  const output = path.resolve(root, 'dist/client-releases', `v${version}`)
  if (fs.existsSync(output)) throw Error('Bundle already exists; preserve it or choose a new version')
  if (typeof config.androidSigningDirectory !== 'string' || !config.androidSigningDirectory) throw Error('Provide the existing Android signing directory')
  const env = { ...process.env, RVB_ANDROID_VERSION_CODE: String(config.androidVersionCode), RVB_ANDROID_VERSION_NAME: version, RVB_RELEASE_SOURCE_COMMIT: commit }
  if (env.RVB_ANDROID_QA_CERT || env.RVB_ANDROID_DISTRIBUTION_CONFIG || env.RVB_ANDROID_HOST_ABI) throw Error('Remove Android QA/ABI overrides before public builds')
  const start = Date.now()
  // Serialized to avoid competing staging directories and excessive memory use.
  runCommand([process.execPath, 'scripts/build-client-release.cjs'], env)
  runCommand(['powershell.exe', '-NoProfile', '-File', 'scripts/build-android-release.ps1', '-SigningDirectory', path.resolve(root,config.androidSigningDirectory)], env)
  const apk = path.resolve(root, 'android/app/build/outputs/apk/demo/app-demo-signed.apk')
  if (fs.statSync(apk).mtimeMs < start) throw Error('Android command did not produce a fresh APK')
  if (git(['rev-parse', 'HEAD']) !== commit || git(['status', '--porcelain'])) throw Error('Sources changed during cross-platform build')
  const meta = verifyPublicApk(apk, config.androidSignerSha256, commit)
  if (meta.versionCode !== config.androidVersionCode) throw Error('Android build ignored requested versionCode')
  const windows = checkWindows(path.resolve(root, '../pr-tools/client-release', `v${version}`), version, commit)
  const android = androidArtifacts(apk, `v${version}`, { previousApk: config.previousApk && path.resolve(root, config.previousApk), notes: config.notes || '' })
  const assets = new Map([...windows, ...android.assets])
  fs.mkdirSync(output, { recursive: true })
  for (const [name, bytes] of assets) fs.writeFileSync(path.join(output, name), bytes)
  const record = { schemaVersion: 'rvb-client-release/v1', version, tag: `v${version}`, sourceCommit: commit, androidVersionCode: meta.versionCode, androidSignerSha256: meta.signers[0], assets: [...assets].map(([name, bytes]) => ({ name, size: bytes.length, sha256: sha256(bytes) })) }
  fs.writeFileSync(path.join(output, 'release-bundle.json'), JSON.stringify(record, null, 2) + '\n')
  verifyBundle(output)
  return output
}

export function publishBundle(directory, { gh = defaultGh, publish = false, verifyApk = verifyPublicApk } = {}) {
  const record = verifyBundle(directory)
  const apkMeta = verifyApk(path.join(directory, `RED-vs-BLUE-${record.version}-Android.apk`), record.androidSignerSha256, record.sourceCommit)
  if (apkMeta.versionCode !== record.androidVersionCode || (apkMeta.versionName !== record.version && apkMeta.versionName !== `${record.version}-demo`)) throw Error('Actual APK version mismatch')
  const api = args => JSON.parse(gh(['api', ...args]))
  // No tag replacement and no --clobber; retries only accept byte-identical remote assets.
  const ref = api([`repos/${repo}/commits/${record.sourceCommit}`])
  if (ref.sha !== record.sourceCommit) throw Error('Push the source commit before creating a release')
  function checkTag() {
    const refs = api([`repos/${repo}/git/matching-refs/tags/${record.tag}`])
    let object = refs.find(r=>r.ref===`refs/tags/${record.tag}`)?.object
    // Missing tag is created by GitHub when publishing this draft.
    if (!object) return
    for (let depth=0; object.type==='tag' && depth<8; depth++) object=api([`repos/${repo}/git/tags/${object.sha}`]).object
    if (object.type!=='commit' || object.sha!==record.sourceCommit) throw Error('Git tag points to another source commit')
  }
  checkTag()
  let release
  const all = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`])).flat()
  release = all.find(r => r.tag_name === record.tag)
  if (release && (!release.draft || release.target_commitish !== record.sourceCommit)) throw Error('Release already public or belongs to another source commit')
  if (!release) {
    gh(['release', 'create', record.tag, '--repo', repo, '--target', record.sourceCommit, '--draft', '--title', `RED vs BLUE ${record.tag} · Windows / Android`, '--notes', 'Windows 与 Android 同步发布。安装器、APK 和平台更新清单请按设备选择；资源包使用独立频道。'])
    // A newly created draft may not yet have a resolvable tag endpoint.
    release = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`])).flat().find(r => r.tag_name === record.tag)
  }
  if (!release || !release.draft || release.prerelease || release.target_commitish !== record.sourceCommit) throw Error('Expected draft missing or changed before upload')
  const receiptBytes = fs.readFileSync(path.join(directory, 'release-bundle.json'))
  const expected = [...record.assets, { name: 'release-bundle.json', size: receiptBytes.length, sha256: sha256(receiptBytes) }]
  for (const asset of expected) {
    const old = release.assets.find(a => a.name === asset.name)
    if (old) {
      if (old.size !== asset.size || old.digest !== `sha256:${asset.sha256}`) throw Error('Draft contains different asset: ' + asset.name)
    } else gh(['release', 'upload', record.tag, path.join(directory, asset.name), '--repo', repo])
  }
  release = api([`repos/${repo}/releases/${release.id}`])
  if (!release.draft || release.prerelease || release.target_commitish !== record.sourceCommit || release.assets.length !== expected.length) throw Error('Draft metadata/assets changed')
  for (const asset of expected) if (!release.assets.some(a => a.name === asset.name && a.state === 'uploaded' && a.size === asset.size && a.digest === `sha256:${asset.sha256}`)) throw Error('Remote digest mismatch: ' + asset.name)
  if (publish) {
    checkTag()
    gh(['release', 'edit', record.tag, '--repo', repo, '--draft=false', '--latest'])
    const latest = api([`repos/${repo}/releases/latest`])
    if (latest.id !== release.id || latest.draft || latest.prerelease) throw Error('Publication status uncertain; inspect remote release before retrying')
  }
  return { tag: record.tag, published: publish, url: `https://github.com/${repo}/releases/tag/${record.tag}` }
}
function defaultGh(args) {
  return execFileSync(process.env.RVB_GH || 'gh', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, file, flag] = process.argv.slice(2)
  if (mode === 'build' && file) console.log(buildBundle(read(file)))
  else if (mode === 'verify' && file) console.log(JSON.stringify(verifyBundle(path.resolve(file)), null, 2))
  else if (mode === 'upload' && file && (!flag || flag === '--publish')) console.log(publishBundle(path.resolve(file), { publish: flag === '--publish' }))
  else throw Error('Usage: synchronized-release.mjs build config.json | verify bundle-dir | upload bundle-dir [--publish]')
}
