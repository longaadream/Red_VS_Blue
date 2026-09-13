import fs from 'node:fs'
import path from 'node:path'

/** Read only the immutable application bundle, never an imported pack or active Profile. */
export function readTrustedScriptPublishersV1(appRoot: string): readonly string[] {
  const filename = path.join(appRoot, 'config', 'content-script-publishers.json')
  if (!fs.existsSync(filename)) return []
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('SCRIPT_PUBLISHERS_CONFIG_INVALID')
  const value = JSON.parse(fs.readFileSync(filename, 'utf8'))
  if (value?.schema !== 'rvb-script-publishers/v1' || !Array.isArray(value.keyIds) || value.keyIds.length > 64
    || !value.keyIds.every((key: unknown) => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key))) {
    throw new Error('SCRIPT_PUBLISHERS_CONFIG_INVALID')
  }
  return Object.freeze([...new Set<string>(value.keyIds)])
}
