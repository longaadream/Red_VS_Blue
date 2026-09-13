// Byte-exact, content-defined APK delta. No APK unzip/repack or signing on device.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { gzipSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

export const MAX_APK = 256 * 1024 * 1024
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const gear = Array.from({ length: 256 }, (_, i) => crypto.createHash('sha256').update(`rvb-apk-chunk-v1:${i}`).digest().readUInt32BE())
function* chunks(bytes) {
  let start = 0, rolling = 0
  for (let i = 0; i < bytes.length; i++) {
    rolling = ((rolling << 1) + gear[bytes[i]]) >>> 0
    const length = i + 1 - start
    if (length >= 65536 || (length >= 4096 && (rolling & 16383) === 0)) {
      yield { offset: start, bytes: bytes.subarray(start, i + 1) }
      start = i + 1; rolling = 0
    }
  }
  if (start < bytes.length) yield { offset: start, bytes: bytes.subarray(start) }
}
export function createApkDelta(base, target) {
  if (!base.length || !target.length || base.length > MAX_APK || target.length > MAX_APK) throw Error('APK size outside supported budget')
  const index = new Map()
  for (const c of chunks(base)) index.set(sha256(c.bytes), c)
  // gzip payload: magic, target size, COPY(offset,length) / ADD(length,bytes), END.
  const header = Buffer.alloc(12); header.write('RVBAPK01'); header.writeUInt32BE(target.length, 8)
  const commands = [header]; let reused = 0
  for (const c of chunks(target)) {
    const old = index.get(sha256(c.bytes))
    if (old && old.bytes.equals(c.bytes)) {
      const op = Buffer.alloc(9); op[0] = 0; op.writeUInt32BE(old.offset, 1); op.writeUInt32BE(c.bytes.length, 5)
      commands.push(op); reused += c.bytes.length
    } else {
      const op = Buffer.alloc(5); op[0] = 1; op.writeUInt32BE(c.bytes.length, 1); commands.push(op, c.bytes)
    }
  }
  commands.push(Buffer.from([255]))
  return { patch: gzipSync(Buffer.concat(commands), { level: 6 }), reused, baseSha256: sha256(base), targetSha256: sha256(target) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, target, output] = process.argv.slice(2)
  if (!output) throw Error('Usage: node scripts/apk-delta.mjs base.apk target.apk output.rvbdelta')
  const result = createApkDelta(fs.readFileSync(base), fs.readFileSync(target))
  fs.writeFileSync(output, result.patch)
  console.log(JSON.stringify({ size: result.patch.length, reused: result.reused, baseSha256: result.baseSha256, targetSha256: result.targetSha256 }))
}
