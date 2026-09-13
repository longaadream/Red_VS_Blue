import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getHostDiscovery, setHostName, validateHostName, ipv4Broadcast } from '../../electron-client/host-discovery'

const roots: string[] = []
function file() { const root = mkdtempSync(join(tmpdir(), 'rvb-host-test-')); roots.push(root); return join(root, 'host-discovery.json') }
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
describe('persistent host identity', () => {
  it('uses the real Radmin /8 and WLAN /22 broadcast addresses', () => {
    expect(ipv4Broadcast('26.111.123.250', '255.0.0.0')).toBe('26.255.255.255')
    expect(ipv4Broadcast('172.21.92.92', '255.255.252.0')).toBe('172.21.95.255')
  })
  it('keeps its ID across reads and renames, using the same public schema as Android', () => {
    const target = file(), first = getHostDiscovery(target)
    expect(first.serverId).toMatch(/^[a-f0-9]{32}$/)
    expect(setHostName(target, '  周末开黑  ')).toEqual({ ...first, serverName: '周末开黑' })
    expect(getHostDiscovery(target)).toEqual({ ...first, serverName: '周末开黑' })
    expect(getHostDiscovery(file()).serverId).not.toBe(first.serverId)
  })
  it('does not overwrite corrupt metadata or silently change identity', () => {
    const target = file()
    writeFileSync(target, '{broken')
    expect(() => getHostDiscovery(target)).toThrow()
    expect(readFileSync(target, 'utf8')).toBe('{broken')
  })
  it('rejects empty, oversized, control and bidi names without changing stored data', () => {
    const target = file(), first = getHostDiscovery(target)
    for (const name of ['', ' ', '\u00a0', '\u3000', 'a'.repeat(33), 'a\nb', '\u202eabc', null]) expect(() => setHostName(target, name)).toThrow()
    expect(getHostDiscovery(target)).toEqual(first)
    expect(validateHostName('\u00a0\u3000同名主机\u3000')).toBe('同名主机')
    expect(validateHostName('猫'.repeat(32))).toHaveLength(32)
    expect(validateHostName('<img src=x onerror=alert(1)>')).toContain('<img')
  })
})
