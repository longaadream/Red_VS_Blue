/* Rasterize the self-contained RED VS BLUE wordmark for desktop platforms. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = fileURLToPath(new URL('../config/branding/', import.meta.url))
const source = path.join(root, 'icon.svg')
const png = size => sharp(source).resize(size, size, { fit: 'contain', background: '#00000000' }).png().toBuffer()

async function main() {
  // PNG-compressed ICO entries are supported by modern Windows and retain alpha.
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
  const frames = await Promise.all(sizes.map(png))
  const header = Buffer.alloc(6 + sizes.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  frames.forEach((frame, i) => {
    const entry = 6 + i * 16
    header[entry] = header[entry + 1] = sizes[i] === 256 ? 0 : sizes[i]
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(frame.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += frame.length
  })
  await fs.writeFile(path.join(root, 'icon.ico'), Buffer.concat([header, ...frames]))
  await fs.writeFile(path.join(root, 'icon.png'), await png(512))

  const chunks = []
  for (const [type, size] of [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]]) {
    const frame = await png(size)
    const chunkHeader = Buffer.alloc(8)
    chunkHeader.write(type)
    chunkHeader.writeUInt32BE(frame.length + 8, 4)
    chunks.push(chunkHeader, frame)
  }
  const icnsHeader = Buffer.alloc(8)
  icnsHeader.write('icns')
  icnsHeader.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4)
  await fs.writeFile(path.join(root, 'icon.icns'), Buffer.concat([icnsHeader, ...chunks]))
  console.log('Created Windows ICO (9 sizes), macOS ICNS (7 sizes), and 512px PNG.')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
