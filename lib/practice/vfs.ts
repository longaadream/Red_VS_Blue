/** Read-only, fully primed worker filesystem. Never fetches or falls back during simulation. */
const root = globalThis as typeof globalThis & { __RVB_PRACTICE_FILES__?: Record<string, unknown> }
function files() {
  if (!root.__RVB_PRACTICE_FILES__) throw new Error('练习资源尚未初始化')
  return root.__RVB_PRACTICE_FILES__
}
function clean(path: string) { return String(path).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '') }
export function existsSync(path: string) {
  const key = clean(path)
  return Object.hasOwn(files(), key) || Object.keys(files()).some(item => item.startsWith(key + '/'))
}
export function readFileSync(path: string) {
  const key = clean(path)
  if (!Object.hasOwn(files(), key)) throw new Error('练习资源缺失: ' + key)
  return JSON.stringify(files()[key])
}
export function readdirSync(path: string, options?: { withFileTypes?: boolean }) {
  const prefix = clean(path) + '/'
  const names = Object.keys(files()).filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/')).map(key => key.slice(prefix.length))
  if (!names.length) throw new Error('练习资源目录缺失: ' + path)
  return options?.withFileTypes ? names.map(name => ({ name, isFile: () => true, isDirectory: () => false })) : names
}
// Existing debug logging has no persistent sink in a local practice worker.
export function appendFileSync() {}
export function mkdirSync() {}
export function writeFileSync() { throw new Error('练习资源只读') }
export const linkSync = writeFileSync
export const renameSync = writeFileSync
export const rmSync = writeFileSync
const vfs = { existsSync, readFileSync, readdirSync, appendFileSync, mkdirSync, writeFileSync }
export default vfs
