import fs from 'node:fs'
import path from 'node:path'

export interface TrainingSnapshot { contentHash: string; files: { path: string; bytes: Uint8Array }[] }
const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' }

function readWithin(root: string, relative: string): Buffer | null {
  const absolute = path.resolve(root, relative)
  if (!absolute.startsWith(path.resolve(root) + path.sep)) return null
  try {
    const actual = fs.realpathSync(absolute)
    if (!actual.startsWith(fs.realpathSync(root) + path.sep) || !fs.statSync(actual).isFile()) return null
    return fs.readFileSync(actual)
  } catch { return null }
}

/** All data reads belong to the frozen candidate; HTML/JS are application-owned. */
export function createTrainingResources(appRoot: string, snapshot: TrainingSnapshot) {
  if (!/^[a-f0-9]{64}$/.test(snapshot.contentHash)) throw new Error('训练候选版本无效')
  const files = new Map(snapshot.files.map(file => [file.path, Buffer.from(file.bytes)]))
  const htmlRoot = path.join(appRoot, 'data', 'pages')
  if (!fs.existsSync(path.join(htmlRoot, 'battle.html')) || !fs.existsSync(path.join(htmlRoot, 'js/game-engine.js'))) throw new Error('编辑器缺少训练营运行资源，请重新构建编辑器')
  return (rawPath: string): { bytes: Uint8Array; contentType: string } | null => {
    let relative: string
    try { relative = decodeURIComponent(rawPath).replace(/^\//, '') } catch { return null }
    if (!relative || relative.includes('\\') || relative.includes('\0') || relative.split('/').some(part => !part || part === '.' || part === '..')) return null
    if (relative === '__editor-preview.json') return { bytes: Buffer.from(JSON.stringify({ contentHash: snapshot.contentHash, mode: 'training', acceptedOnly: true })), contentType: contentTypes['.json'] }
    const extension = path.extname(relative).toLowerCase(), contentType = contentTypes[extension]
    if (!contentType) return null
    let bytes: Buffer | null = null
    if (relative.startsWith('data/')) {
      if (extension !== '.json') return null
      bytes = files.get(relative) ?? null
    } else if (relative.startsWith('images/') && files.has(relative)) {
      if (!['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(extension)) return null
      bytes = files.get(relative)!
    } else {
      if (extension === '.html' && !['battle.html', 'training.html'].includes(relative)) return null
      bytes = readWithin(htmlRoot, relative)
      if (!bytes && relative.startsWith('images/')) bytes = readWithin(path.join(appRoot, 'public'), relative.slice(7))
    }
    return bytes ? { bytes, contentType } : null
  }
}
