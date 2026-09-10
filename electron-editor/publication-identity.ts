import fs from 'node:fs'
import path from 'node:path'
import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto'

export function publicationKeyId(filename: string): string {
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128) throw new Error('签名密钥文件无效')
  const seed = fs.readFileSync(filename, 'utf8').trim()
  if (!/^[a-f0-9]{64}$/.test(seed)) throw new Error('签名密钥格式无效')
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'hex')]), format: 'der', type: 'pkcs8' })
  const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' })
  return createHash('sha256').update(publicKey.subarray(-32)).digest('hex')
}

/** The private seed stays in editor user data, never in a content project or release. */
export function preparePublicationIdentity(userData: string) {
  const directory = path.join(userData, 'signing')
  fs.mkdirSync(directory, { recursive: true })
  const filename = path.join(directory, 'official-content.key')
  if (!fs.existsSync(filename)) fs.writeFileSync(filename, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
  return { filename, keyId: publicationKeyId(filename) }
}

export function trustedPublicationKeys(appRoot: string): readonly string[] {
  const filename = path.join(appRoot, 'config', 'content-script-publishers.json')
  if (!fs.existsSync(filename)) return []
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('SCRIPT_PUBLISHERS_CONFIG_INVALID')
  const value = JSON.parse(fs.readFileSync(filename, 'utf8'))
  if (value?.schema !== 'rvb-script-publishers/v1' || !Array.isArray(value.keyIds) || value.keyIds.length > 64 || !value.keyIds.every((key: unknown) => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key))) throw new Error('SCRIPT_PUBLISHERS_CONFIG_INVALID')
  return Object.freeze([...new Set<string>(value.keyIds)])
}
