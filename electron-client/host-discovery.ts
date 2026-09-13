import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** Public discovery metadata only: never use this ID to authorize a connection. */
export interface HostDiscoveryInfo { schemaVersion: 1; serverId: string; serverName: string }
export function validateHostName(value: unknown): string {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value)) throw Error('主机名称不能含控制字符')
  const name = value.trim()
  if (!name || [...name].length > 32) throw Error('主机名称需要 1–32 个字符')
  return name
}
export function readHostDiscovery(file: string): HostDiscoveryInfo {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (data.schemaVersion !== 1 || typeof data.serverId !== 'string' || !/^[0-9a-f]{32}$/.test(data.serverId)) throw Error('主机识别配置损坏')
  return { schemaVersion: 1, serverId: data.serverId, serverName: validateHostName(data.serverName) }
}
export function getHostDiscovery(file: string): HostDiscoveryInfo {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const data: HostDiscoveryInfo = { schemaVersion: 1, serverId: randomUUID().replace(/-/g, ''), serverName: '我的主机' }
    try { fs.writeFileSync(file, JSON.stringify(data), { flag: 'wx' }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  return readHostDiscovery(file)
}
export function setHostName(file: string, name: unknown): HostDiscoveryInfo {
  const serverName = validateHostName(name)
  const data = { ...getHostDiscovery(file), serverName }
  const temporary = file + '.tmp'
  fs.writeFileSync(temporary, JSON.stringify(data))
  fs.renameSync(temporary, file)
  return data
}
let lastDiscoveryError = ''
export function hostDiscoveryFromEnvironment(): HostDiscoveryInfo | undefined {
  const file = process.env.RVB_HOST_DISCOVERY_FILE
  if (!file) return undefined
  try { const info = readHostDiscovery(file); lastDiscoveryError = ''; return info }
  catch (error) {
    const message = String(error)
    if (message !== lastDiscoveryError) console.warn('[host-discovery] Metadata unavailable:', message)
    lastDiscoveryError = message
    return undefined
  }
}
export function ipv4Broadcast(address: string, netmask: string): string {
  const ip = address.split('.').map(Number), mask = netmask.split('.').map(Number)
  if (ip.length !== 4 || mask.length !== 4 || [...ip, ...mask].some(value => !Number.isInteger(value) || value < 0 || value > 255)) throw Error('Invalid IPv4 network')
  return ip.map((value, i) => value | (255 ^ mask[i])).join('.')
}
