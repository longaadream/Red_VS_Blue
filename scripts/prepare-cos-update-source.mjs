import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { verifyBundle } from './synchronized-release.mjs'

export const COS_ORIGIN = 'https://updates.redvsblue.top'
const repository = 'https://github.com/longaadream/Red_VS_Blue'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))

// Preparation only: consume previously verified public release receipts, never sign,
// upload or change the source release. Android metadata retains official asset identities.
export function prepareCosUpdateSource({ clientDirectory, resourceDirectory, outputDirectory, previousClientDirectory, resourceVersionOverride }) {
  const output = path.resolve(outputDirectory)
  if (fs.existsSync(output)) throw Error('Output already exists; use a new preparation directory')
  const client = verifyBundle(clientDirectory)
  const indexBytes = fs.readFileSync(path.join(resourceDirectory, 'content-update.json'))
  const index = JSON.parse(indexBytes.toString('utf8'))
  const resourceVersion = resourceVersionOverride ?? index.version
  const receipt = read(path.join(resourceDirectory, 'public-verification.json'))
  const verification = read(path.join(resourceDirectory, 'verification.json'))
  const tag = `content-test-${index.contentHash}`
  if (index.schema !== 'rvb-content-release/v1' || index.channel !== 'test' || !/^\d+\.\d+\.\d+$/.test(index.version) || !/^[a-f0-9]{64}$/.test(index.contentHash) || index.archive !== 'content.rvbpack' || index.patch || index.identity?.signature !== 'signed') throw Error('Unsupported resource release; expected a signed full snapshot')
  if (receipt.ok !== true || receipt.publicAssetsByteMatched !== true || receipt.publicDiscovery !== true || receipt.tag !== tag || receipt.url !== `${repository}/releases/tag/${tag}` || receipt.version !== index.version || !Number.isFinite(Date.parse(receipt.publishedAt)) || verification.ok !== true || verification.signatureVerified !== true) throw Error('Verified public resource release receipts required')
  const pack = fs.readFileSync(path.join(resourceDirectory, index.archive))
  if (sha(pack) !== index.archiveSha256) throw Error('Resource archive checksum mismatch')
  const resourceAssets = new Map([['content-update.json', indexBytes], ['content.rvbpack', pack]])
  const assets = [...resourceAssets].map(([name, bytes]) => {
    const matching = receipt.assets?.filter(asset => asset.name === name)
    if (matching?.length !== 1 || matching[0].size !== bytes.length || matching[0].digest !== `sha256:${sha(bytes)}`) throw Error('Resource public asset receipt mismatch: ' + name)
    return { name, size: bytes.length, digest: matching[0].digest, state: 'uploaded', browser_download_url: `${repository}/releases/download/${tag}/${name}` }
  })
  const exeName = `RED-vs-BLUE-${client.version}-Setup.exe`
  const windows = yaml.load(fs.readFileSync(path.join(clientDirectory, 'latest.yml'), 'utf8'))
  windows.path = `${client.version}/${exeName}`
  windows.files[0].url = windows.path
  const files = new Map()
  if (previousClientDirectory) {
    const previous = verifyBundle(previousClientDirectory)
    if (previous.version === client.version) throw Error('Previous client must have a different version')
    const oldBlockmap = `RED-vs-BLUE-${previous.version}-Setup.exe.blockmap`
    files.set(`${previous.version}/${oldBlockmap}`, fs.readFileSync(path.join(previousClientDirectory, oldBlockmap)))
  }
  for (const name of [exeName, exeName + '.blockmap']) files.set(`${client.version}/${name}`, fs.readFileSync(path.join(clientDirectory, name)))
  const android = read(path.join(clientDirectory, 'android-latest.json'))
  const apkName = `RED-vs-BLUE-${client.version}-Android.apk`
  for (const name of [apkName, ...android.deltas.map(d => `RED-vs-BLUE-Android-${d.fromVersionCode}-to-${android.versionCode}.rvbdelta`)]) {
    files.set(`${client.version}/${name}`, fs.readFileSync(path.join(clientDirectory, name)))
  }
  // Preserve package identity and hashes; native code maps only download transport.
  files.set('android-latest.json', fs.readFileSync(path.join(clientDirectory, 'android-latest.json')))
  for (const [name, bytes] of resourceAssets) files.set(`resource/${resourceVersion}/${name}`, bytes)
  const release = { tag_name: tag, draft: false, published_at: receipt.publishedAt, rvb_version: resourceVersion, assets }
  files.set('resource/latest.json', Buffer.from(JSON.stringify([release], null, 2) + '\n'))
  files.set('latest.yml', Buffer.from(yaml.dump(windows)))
  // All validation precedes output creation. Local receipts are not public files.
  const result = { schema: 'rvb-cos-preparation/v1', origin: COS_ORIGIN, clientVersion: client.version, sourceCommit: client.sourceCommit, resourceVersion, files: [...files].map(([name, bytes]) => ({ name, size: bytes.length, sha256: sha(bytes) })), publishLast: ['resource/latest.json', 'android-latest.json', 'latest.yml'] }
  fs.mkdirSync(output, { recursive: true })
  for (const [name, bytes] of files) {
    const target = path.join(output, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes, { flag: 'wx' })
  }
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [clientDirectory, resourceDirectory, outputDirectory, previousClientDirectory, resourceVersionOverride] = process.argv.slice(2)
  if (!clientDirectory || !resourceDirectory || !outputDirectory) throw Error('Usage: node scripts/prepare-cos-update-source.mjs <verified-client-bundle> <verified-public-resource-directory> <new-output-directory> [previous-client-bundle] [resource-version-override]')
  console.log(JSON.stringify(prepareCosUpdateSource({ clientDirectory, resourceDirectory, outputDirectory, previousClientDirectory, resourceVersionOverride }), null, 2))
}
