import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import yaml from 'js-yaml'
import { prepareCosUpdateSource } from '../../scripts/prepare-cos-update-source.mjs'

const hash = (b, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(b).digest(encoding)
function fixture(t, version = '0.1.3') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-cos-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const clientDirectory = path.join(root, 'client'), resourceDirectory = path.join(root, 'resource'), outputDirectory = path.join(root, 'output')
  fs.mkdirSync(clientDirectory); fs.mkdirSync(resourceDirectory)
  const name = `RED-vs-BLUE-${version}-Setup.exe`, apkName = `RED-vs-BLUE-${version}-Android.apk`
  const exe = Buffer.from('test exe'), apk = Buffer.from('test apk'), signer = 'a'.repeat(64), sha512 = hash(exe, 'sha512', 'base64')
  const files = new Map([[name, exe], [name + '.blockmap', Buffer.from('test map')], [apkName, apk]])
  files.set('latest.yml', Buffer.from(yaml.dump({ version, path: name, sha512, files: [{ url: name, size: exe.length, sha512 }] })))
  files.set('android-latest.json', Buffer.from(JSON.stringify({ schemaVersion: 'rvb-android-update/v1', packageName: 'com.redvsblue.client', versionName: version, versionCode: 22, minSdk: 24, debuggable: false, signers: [signer], size: apk.length, sha256: hash(apk), url: `https://github.com/longaadream/Red_VS_Blue/releases/download/v${version}/${apkName}`, deltas: [] })))
  for (const [file, bytes] of files) fs.writeFileSync(path.join(clientDirectory, file), bytes)
  fs.writeFileSync(path.join(clientDirectory, 'release-bundle.json'), JSON.stringify({ schemaVersion: 'rvb-client-release/v1', version, tag: 'v' + version, sourceCommit: 'b'.repeat(40), androidVersionCode: 22, androidSignerSha256: signer, assets: [...files].map(([name, bytes]) => ({ name, size: bytes.length, sha256: hash(bytes) })) }))
  const pack = Buffer.from('already-verified signed archive fixture'), resourceVersion = '0.0.123', contentHash = 'c'.repeat(64), tag = 'content-test-' + contentHash
  const index = Buffer.from(JSON.stringify({ schema: 'rvb-content-release/v1', channel: 'test', version: resourceVersion, contentHash, archive: 'content.rvbpack', archiveSha256: hash(pack), identity: { signature: 'signed' } }))
  fs.writeFileSync(path.join(resourceDirectory, 'content-update.json'), index)
  fs.writeFileSync(path.join(resourceDirectory, 'content.rvbpack'), pack)
  fs.writeFileSync(path.join(resourceDirectory, 'verification.json'), JSON.stringify({ ok: true, signatureVerified: true }))
  fs.writeFileSync(path.join(resourceDirectory, 'public-verification.json'), JSON.stringify({ ok: true, publicAssetsByteMatched: true, publicDiscovery: true, tag, url: `https://github.com/longaadream/Red_VS_Blue/releases/tag/${tag}`, version: resourceVersion, publishedAt: '2026-09-13T15:42:50Z', assets: [['content-update.json', index], ['content.rvbpack', pack]].map(([name, bytes]) => ({ name, size: bytes.length, digest: 'sha256:' + hash(bytes) })) }))
  return { clientDirectory, resourceDirectory, outputDirectory, index, pack, exe, name }
}

function addResourcePatch(f, options = {}) {
  const archive = options.archive ?? 'content-patch.rvbpack'
  const patch = options.bytes ?? Buffer.from('verified resource patch')
  const indexPath = path.join(f.resourceDirectory, 'content-update.json')
  const receiptPath = path.join(f.resourceDirectory, 'public-verification.json')
  const patchIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  patchIndex.patch = {
    archive,
    sha256: options.sha256 ?? hash(patch),
    parentProfileHash: options.parentProfileHash ?? 'd'.repeat(64),
    resolvedProfileHash: options.resolvedProfileHash ?? 'e'.repeat(64),
    ...(options.includeSize === false ? {} : { size: options.size ?? patch.length }),
  }
  fs.writeFileSync(path.join(f.resourceDirectory, archive), patch)
  const indexBytes = Buffer.from(JSON.stringify(patchIndex))
  fs.writeFileSync(indexPath, indexBytes)
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  const indexAsset = receipt.assets.find(asset => asset.name === 'content-update.json')
  Object.assign(indexAsset, { size: indexBytes.length, digest: 'sha256:' + hash(indexBytes) })
  receipt.assets = receipt.assets.filter(asset => asset.name !== 'content-patch.rvbpack')
  if (options.receiptPatch !== false) receipt.assets.push({ name: 'content-patch.rvbpack', size: patch.length, digest: 'sha256:' + hash(patch) })
  fs.writeFileSync(receiptPath, JSON.stringify(receipt))
  return { archive, patch, indexBytes, patchIndex }
}

test('prepares separate immutable assets and last-published manifests with Android feed', t => {
  const f = fixture(t), receipt = prepareCosUpdateSource(f)
  assert.deepEqual(receipt.publishLast, ['resource/latest.json', 'android-latest.json', 'latest.yml'])
  const windows = yaml.load(fs.readFileSync(path.join(f.outputDirectory, 'latest.yml'), 'utf8'))
  assert.equal(windows.path, '0.1.3/' + f.name)
  assert.equal(windows.files[0].url, windows.path)
  assert.equal(windows.sha512, hash(f.exe, 'sha512', 'base64'))
  assert.deepEqual(fs.readFileSync(path.join(f.outputDirectory, 'resource/0.0.123/content-update.json')), f.index)
  assert.deepEqual(fs.readFileSync(path.join(f.outputDirectory, 'resource/0.0.123/content.rvbpack')), f.pack)
  const [release] = JSON.parse(fs.readFileSync(path.join(f.outputDirectory, 'resource/latest.json')))
  assert.equal(release.rvb_version, '0.0.123')
  assert.equal(release.assets[1].digest, 'sha256:' + hash(f.pack))
  assert.match(release.assets[1].browser_download_url, /^https:\/\/github.com\/longaadream\/Red_VS_Blue\/releases\/download\//)
  assert.deepEqual(fs.readFileSync(path.join(f.outputDirectory, 'android-latest.json')), fs.readFileSync(path.join(f.clientDirectory, 'android-latest.json')))
  assert.deepEqual(fs.readFileSync(path.join(f.outputDirectory, '0.1.3/RED-vs-BLUE-0.1.3-Android.apk')), fs.readFileSync(path.join(f.clientDirectory, 'RED-vs-BLUE-0.1.3-Android.apk')))
  assert.throws(() => prepareCosUpdateSource(f), /already exists/)
})

test('copies a verified canonical resource patch into the version and latest asset lists', t => {
  const f = fixture(t), delta = addResourcePatch(f)
  const result = prepareCosUpdateSource(f)
  assert.deepEqual(fs.readFileSync(path.join(f.outputDirectory, 'resource/0.0.123/content-patch.rvbpack')), delta.patch)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.outputDirectory, 'resource/0.0.123/content-update.json'))).patch, delta.patchIndex.patch)
  const [release] = JSON.parse(fs.readFileSync(path.join(f.outputDirectory, 'resource/latest.json')))
  assert.deepEqual(release.assets.find(asset => asset.name === 'content-patch.rvbpack'), {
    name: 'content-patch.rvbpack',
    size: delta.patch.length,
    digest: 'sha256:' + hash(delta.patch),
    state: 'uploaded',
    browser_download_url: 'https://github.com/longaadream/Red_VS_Blue/releases/download/content-test-' + 'c'.repeat(64) + '/content-patch.rvbpack',
  })
  assert.deepEqual(result.files.find(file => file.name === 'resource/0.0.123/content-patch.rvbpack'), {
    name: 'resource/0.0.123/content-patch.rvbpack',
    size: delta.patch.length,
    sha256: hash(delta.patch),
  })
})

test('rejects a canonical resource patch without a receipt asset', t => {
  const f = fixture(t)
  addResourcePatch(f, { receiptPatch: false })
  assert.throws(() => prepareCosUpdateSource(f), /Resource public asset receipt mismatch: content-patch\.rvbpack/)
  assert.equal(fs.existsSync(f.outputDirectory), false)
})

test('rejects a canonical resource patch with a mismatched receipt digest', t => {
  const f = fixture(t)
  addResourcePatch(f)
  const receiptPath = path.join(f.resourceDirectory, 'public-verification.json')
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  receipt.assets.find(asset => asset.name === 'content-patch.rvbpack').digest = 'sha256:' + '0'.repeat(64)
  fs.writeFileSync(receiptPath, JSON.stringify(receipt))
  assert.throws(() => prepareCosUpdateSource(f), /Resource public asset receipt mismatch: content-patch\.rvbpack/)
  assert.equal(fs.existsSync(f.outputDirectory), false)
})

test('rejects a tampered canonical resource patch before creating output', t => {
  const f = fixture(t), delta = addResourcePatch(f)
  fs.writeFileSync(path.join(f.resourceDirectory, delta.archive), Buffer.alloc(delta.patch.length, 0x78))
  assert.throws(() => prepareCosUpdateSource(f), /Resource patch checksum mismatch/)
  assert.equal(fs.existsSync(f.outputDirectory), false)
})

test('rejects a canonical resource patch with an unsafe archive path', t => {
  const f = fixture(t)
  addResourcePatch(f)
  const indexPath = path.join(f.resourceDirectory, 'content-update.json')
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  index.patch.archive = '../content-patch.rvbpack'
  const indexBytes = Buffer.from(JSON.stringify(index))
  fs.writeFileSync(indexPath, indexBytes)
  const receiptPath = path.join(f.resourceDirectory, 'public-verification.json')
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  Object.assign(receipt.assets.find(asset => asset.name === 'content-update.json'), { size: indexBytes.length, digest: 'sha256:' + hash(indexBytes) })
  fs.writeFileSync(receiptPath, JSON.stringify(receipt))
  assert.throws(() => prepareCosUpdateSource(f), /invalid canonical patch metadata/)
  assert.equal(fs.existsSync(f.outputDirectory), false)
})

test('rejects a canonical resource patch with a mismatched declared size', t => {
  const f = fixture(t), delta = addResourcePatch(f, { size: 1 })
  const indexPath = path.join(f.resourceDirectory, 'content-update.json')
  const indexBytes = fs.readFileSync(indexPath)
  const receiptPath = path.join(f.resourceDirectory, 'public-verification.json')
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  Object.assign(receipt.assets.find(asset => asset.name === 'content-update.json'), { size: indexBytes.length, digest: 'sha256:' + hash(indexBytes) })
  fs.writeFileSync(receiptPath, JSON.stringify(receipt))
  assert.equal(delta.patch.length > 1, true)
  assert.throws(() => prepareCosUpdateSource(f), /Resource patch size mismatch/)
  assert.equal(fs.existsSync(f.outputDirectory), false)
})

test('rejects a canonical resource patch that is not smaller than the full archive', t => {
  const f = fixture(t)
  addResourcePatch(f, { bytes: Buffer.alloc(f.pack.length, 0x70) })
  assert.throws(() => prepareCosUpdateSource(f), /Resource patch must be smaller than the full archive/)
  assert.equal(fs.existsSync(f.outputDirectory), false)
})

test('copies verified previous blockmap into its version directory', t => {
  const f = fixture(t), previous = fixture(t, '0.1.2')
  prepareCosUpdateSource({ ...f, previousClientDirectory: previous.clientDirectory })
  assert.deepEqual(fs.readFileSync(path.join(f.outputDirectory, '0.1.2', previous.name + '.blockmap')), fs.readFileSync(path.join(previous.clientDirectory, previous.name + '.blockmap')))
  assert.equal(fs.existsSync(path.join(f.outputDirectory, '0.1.2', previous.name)), false)
})

test('rejects corrupted previous blockmap before output exists', t => {
  const f = fixture(t), previous = fixture(t, '0.1.2')
  fs.appendFileSync(path.join(previous.clientDirectory, previous.name + '.blockmap'), 'tampered')
  assert.throws(() => prepareCosUpdateSource({ ...f, previousClientDirectory: previous.clientDirectory }))
  assert.equal(fs.existsSync(f.outputDirectory), false)
})

for (const file of ['content.rvbpack', 'content-update.json', 'public-verification.json', 'verification.json']) {
  test('missing resource ' + file + ' leaves no publishable output', t => {
    const f = fixture(t); fs.unlinkSync(path.join(f.resourceDirectory, file))
    assert.throws(() => prepareCosUpdateSource(f))
    assert.equal(fs.existsSync(f.outputDirectory), false)
  })
}
for (const kind of ['pack', 'index', 'installer', 'receipt']) {
  test('rejects altered ' + kind + ' before creating output', t => {
    const f = fixture(t)
    if (kind === 'pack') fs.appendFileSync(path.join(f.resourceDirectory, 'content.rvbpack'), 'tampered')
    if (kind === 'index') fs.appendFileSync(path.join(f.resourceDirectory, 'content-update.json'), ' ')
    if (kind === 'installer') fs.appendFileSync(path.join(f.clientDirectory, f.name), 'tampered')
    if (kind === 'receipt') fs.writeFileSync(path.join(f.resourceDirectory, 'verification.json'), JSON.stringify({ ok: true, signatureVerified: false }))
    assert.throws(() => prepareCosUpdateSource(f))
    assert.equal(fs.existsSync(f.outputDirectory), false)
  })
}

function addDelta(f) {
  const name = 'RED-vs-BLUE-Android-21-to-22.rvbdelta', bytes = Buffer.from('p')
  const manifest = JSON.parse(fs.readFileSync(path.join(f.clientDirectory, 'android-latest.json')))
  manifest.deltas.push({ format: 'rvb-apk-copy-gzip/v1', fromVersionCode: 21, baseSha256: 'd'.repeat(64), url: `https://github.com/longaadream/Red_VS_Blue/releases/download/v0.1.3/${name}`, size: bytes.length, sha256: hash(bytes) })
  const metadata = Buffer.from(JSON.stringify(manifest))
  fs.writeFileSync(path.join(f.clientDirectory, name), bytes)
  fs.writeFileSync(path.join(f.clientDirectory, 'android-latest.json'), metadata)
  const recordPath = path.join(f.clientDirectory, 'release-bundle.json'), record = JSON.parse(fs.readFileSync(recordPath))
  for (const [assetName, data] of [[name, bytes], ['android-latest.json', metadata]]) {
    record.assets = record.assets.filter(a => a.name !== assetName)
    record.assets.push({ name: assetName, size: data.length, sha256: hash(data) })
  }
  fs.writeFileSync(recordPath, JSON.stringify(record))
  return { name, bytes, metadata }
}
test('copies verified Android patch and preserves manifest identity bytes', t => {
  const f = fixture(t), delta = addDelta(f)
  prepareCosUpdateSource(f)
  assert.deepEqual(fs.readFileSync(path.join(f.outputDirectory, '0.1.3', delta.name)), delta.bytes)
  assert.deepEqual(fs.readFileSync(path.join(f.outputDirectory, 'android-latest.json')), delta.metadata)
})
for (const target of ['RED-vs-BLUE-0.1.3-Android.apk', 'RED-vs-BLUE-Android-21-to-22.rvbdelta']) {
  test('corrupted Android asset fails before publishing: ' + target, t => {
    const f = fixture(t); addDelta(f)
    fs.appendFileSync(path.join(f.clientDirectory, target), 'tampered')
    assert.throws(() => prepareCosUpdateSource(f))
    assert.equal(fs.existsSync(f.outputDirectory), false)
  })
}
