// Shim for the 'fs' Node.js module — populated with game data inlined at build time
// via the esbuild virtual:game-data plugin in scripts/build-mobile-server.js.
//
// Paths are matched relative to 'data/' (as returned by app-paths-shim.getDataRoot()).
// Example: readFileSync('data/skills/fireball.json', 'utf-8') → skill JSON string.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const __GAME_DATA__: {
  skills: Record<string, any>
  pieces: Record<string, any>
  maps: Record<string, any>
  cards: Record<string, any>
  rules: Record<string, any>
  effects: Record<string, any>
  tiles: Record<string, any>
  statusEffects: Record<string, any>
}

const vfs = new Map<string, string>()

function populateVfs() {
  const sections: Array<[string, Record<string, unknown>]> = [
    ['skills', __GAME_DATA__.skills],
    ['pieces', __GAME_DATA__.pieces],
    ['maps',   __GAME_DATA__.maps],
    ['cards',  __GAME_DATA__.cards],
    ['rules',  __GAME_DATA__.rules],
    ['effects', __GAME_DATA__.effects],
    ['tiles',  __GAME_DATA__.tiles],
    ['status-effects', __GAME_DATA__.statusEffects],
  ]
  for (const [dir, data] of sections) {
    for (const [id, obj] of Object.entries(data ?? {})) {
      vfs.set(`data/${dir}/${id}.json`, JSON.stringify(obj))
    }
  }
}

populateVfs()

// ── Fake Dirent ───────────────────────────────────────────────────────────────

interface FakeDirent { name: string; isFile(): boolean; isDirectory(): boolean }
function dirent(name: string): FakeDirent {
  return { name, isFile: () => true, isDirectory: () => false }
}

// ── Normalise a path so it matches vfs keys (starts with 'data/...') ─────────

function norm(p: string): string {
  // Replace backslashes, collapse double slashes
  let s = p.replace(/\\/g, '/').replace(/\/+/g, '/')
  // Strip leading './' or '/'
  s = s.replace(/^\.\//, '').replace(/^\/+/, '')
  // If the path contains '/data/' somewhere in the middle, strip the prefix
  const idx = s.indexOf('/data/')
  if (idx > 0) s = s.substring(idx + 1)
  return s
}

// ── Exports ───────────────────────────────────────────────────────────────────

export function existsSync(p: string): boolean {
  const n = norm(p)
  if (vfs.has(n)) return true
  const prefix = n.endsWith('/') ? n : n + '/'
  for (const k of vfs.keys()) {
    if (k.startsWith(prefix)) return true
  }
  return false
}

export function readdirSync(dirPath: string, options?: { withFileTypes?: boolean }): FakeDirent[] | string[] {
  const n = norm(dirPath).replace(/\/$/, '')
  const prefix = n + '/'
  const seen = new Set<string>()
  const results: FakeDirent[] = []

  for (const k of vfs.keys()) {
    if (k.startsWith(prefix)) {
      const rest = k.slice(prefix.length)
      const name = rest.split('/')[0]
      if (!seen.has(name)) {
        seen.add(name)
        results.push(dirent(name))
      }
    }
  }

  if (options && options.withFileTypes) return results
  return results.map(d => d.name)
}

export function readFileSync(filePath: string, encoding: string): string {
  const n = norm(filePath)
  const content = vfs.get(n)
  if (content !== undefined) return content
  throw Object.assign(new Error(`ENOENT: '${filePath}'`), { code: 'ENOENT' })
}

export function mkdirSync(_p: string, _opts?: unknown): void {}
export function appendFileSync(_p: string, _data: string): void {}
export function writeFileSync(_p: string, _data: string): void {}
export function rmSync(_p: string, _opts?: unknown): void {}

export default {
  existsSync, readdirSync, readFileSync,
  mkdirSync, appendFileSync, writeFileSync, rmSync,
}
