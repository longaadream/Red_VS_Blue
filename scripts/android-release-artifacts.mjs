import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import AdmZip from 'adm-zip'
import { createApkDelta, sha256, MAX_APK } from './apk-delta.mjs'

export function inspectApk(apk) {
  const sdk = process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA || '', 'Android/Sdk')
  const tools = process.env.RVB_ANDROID_BUILD_TOOLS || path.join(sdk, 'build-tools/35.0.0')
  const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java'
  const options = { encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 }
  const info = execFileSync(path.join(tools, process.platform === 'win32' ? 'aapt.exe' : 'aapt'), ['dump', 'badging', apk], options)
  const signature = execFileSync(java, ['-jar', path.join(tools, 'lib/apksigner.jar'), 'verify', '--print-certs', apk], options)
  const match = info.match(/package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/)
  const signers = [...signature.matchAll(/Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]{64})/g)].map(m => m[1].toLowerCase()).sort()
  const minSdk = Number(info.match(/sdkVersion:'(\d+)'/)?.[1])
  if (!match || !signers.length || !minSdk) throw Error('Cannot verify APK metadata/signers')
  return { packageName: match[1], versionCode: Number(match[2]), versionName: match[3], minSdk, signers, debuggable: info.includes('application-debuggable') }
}

export function androidArtifacts(apk, tag, { previousApk, inspect = inspectApk, notes = '' } = {}) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw Error('Use a stable vMAJOR.MINOR.PATCH release tag')
  const meta = inspect(apk), bytes = fs.readFileSync(apk)
  if (!bytes.length || bytes.length > MAX_APK) throw Error('APK size outside supported budget')
  const name = `RED-vs-BLUE-${tag.slice(1)}-Android.apk`
  const url = filename => `https://github.com/longaadream/Red_VS_Blue/releases/download/${tag}/${filename}`
  const manifest = { schemaVersion: 'rvb-android-update/v1', ...meta, size: bytes.length, sha256: sha256(bytes), url: url(name), notes, deltas: [] }
  const assets = new Map([[name, bytes]])
  if (previousApk) {
    const old = inspect(previousApk)
    if (old.packageName !== meta.packageName || old.versionCode >= meta.versionCode || JSON.stringify(old.signers) !== JSON.stringify(meta.signers)) throw Error('Previous APK package/version/signers are incompatible')
    const delta = createApkDelta(fs.readFileSync(previousApk), bytes)
    // A patch that barely saves bandwidth is not worth download + reconstruction.
    if (delta.patch.length < bytes.length * 0.9) {
      const patchName = `RED-vs-BLUE-Android-${old.versionCode}-to-${meta.versionCode}.rvbdelta`
      assets.set(patchName, delta.patch)
      manifest.deltas.push({ format: 'rvb-apk-copy-gzip/v1', fromVersionCode: old.versionCode, baseSha256: delta.baseSha256, url: url(patchName), size: delta.patch.length, sha256: sha256(delta.patch) })
    }
  }
  assets.set('android-latest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'))
  return { assets, manifest }
}

export function verifyPublicApk(apk, expectedSigner, sourceCommit) {
  const meta = inspectApk(apk)
  if (meta.debuggable || meta.packageName !== 'com.redvsblue.client' || meta.signers.length !== 1 || meta.signers[0] !== expectedSigner) throw Error('Expected non-debug public APK signed by the configured release signer')
  const zip = new AdmZip(apk)
  verifyApkContents(zip, sourceCommit)
  return meta
}

export function verifyApkContents(zip, sourceCommit) {
  const source = JSON.parse(zip.readAsText('assets/android-release-source.json'))
  if (source.sourceCommit !== sourceCommit || !Array.isArray(source.files) || !source.files.length) throw Error('APK source proof missing/mismatched')
  for (const abi of ['arm64-v8a','x86_64']) {
    for (const file of [`lib/${abi}/librvb_node.so`,`assets/host-runtime/${abi}/cert.pem`]) if (!zip.getEntry(file)) throw Error('APK host ABI missing: '+file)
  }
  for (const file of source.files) {
    if (!file.path.startsWith('assets/') || !zip.getEntry(file.path) || sha256(zip.readFile(file.path)) !== file.sha256) throw Error('APK differs from freshly staged source: '+file.path)
  }
  const config = JSON.parse(zip.readAsText('assets/android-distribution.json'))
  if (config.updateUrl !== 'https://github.com/longaadream/Red_VS_Blue/releases/latest/download/android-latest.json') throw Error('APK must use the public Android update feed')
  const configuredPublishers = JSON.parse(fs.readFileSync(path.resolve('config/content-script-publishers.json'), 'utf8')).keyIds
  if (!Array.isArray(config.trustedPublisherKeyIds) || config.trustedPublisherKeyIds.length === 0 || configuredPublishers.some(key => !config.trustedPublisherKeyIds.includes(key))) throw Error('APK must trust every configured official content publisher')
  if (zip.getEntries().some(e => /android_qa_ca|(?:^|\/)users\.json$|\.p12$|\.clixml$/i.test(e.entryName))) throw Error('APK includes QA trust or private data')
  if (!zip.getEntries().some(e => /^classes\d*\.dex$/.test(e.entryName) && e.getData().includes(Buffer.from('Lcom/redvsblue/client/ApkDelta;')))) throw Error('APK does not contain the delta updater')
}
