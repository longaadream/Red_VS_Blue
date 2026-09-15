import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { validate, verifyPackage, serve } from '../../scripts/server-admin/admin.mjs'

describe('server admin boundaries', () => {
  const config = { host: '38.22.90.175', key: path.resolve('key'), service: 'rvb-game' }
  it('rejects shell syntax and invalid deployment identities', () => {
    for (const bad of [{ host: '-oProxyCommand=evil' }, { user: 'root;id' }, { release: '../current' }, { database: 'db;id' }, { port: '99999' }, { service: 'sshd' }]) {
      expect(() => validate({ ...config, ...bad })).toThrow()
    }
    expect(validate(config).port).toBe('22')
  })
  it('verifies bytes and rejects omitted files and traversal', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rvb-admin-test-'))
    try {
      await fs.writeFile(path.join(dir, 'server.mjs'), 'test')
      const hash = createHash('sha256').update('test').digest('hex')
      await fs.writeFile(path.join(dir, 'SHA256SUMS'), `${hash}  server.mjs\n`)
      expect(await verifyPackage(dir)).toBe(1)
      await fs.writeFile(path.join(dir, 'extra'), 'secret')
      await expect(verifyPackage(dir)).rejects.toThrow('清单外')
      await fs.writeFile(path.join(dir, 'SHA256SUMS'), `${hash}  ../server.mjs\n`)
      await expect(verifyPackage(dir)).rejects.toThrow('路径')
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
  it('denies unauthenticated and foreign origin requests', async () => {
    const server = await serve()
    try {
      const address = server.address() as { port: number }
      const url = `http://127.0.0.1:${address.port}`
      expect((await fetch(url)).status).toBe(200)
      expect((await fetch(url + '/api', { method: 'POST', headers: { Origin: url } })).status).toBe(403)
      expect((await fetch(url + '/api', { method: 'POST', headers: { Origin: 'https://other.test', Authorization: 'Bearer invalid' } })).status).toBe(403)
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('forwards original panel actions over SSH without putting tokens in command arguments', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const runner = vi.fn(async () => '{"ok":true}')
    const server = await serve({ proxyRunner: runner })
    try {
      const launch = String(log.mock.calls.at(-1)?.[0]).split('：')[1]
      const url = new URL(launch)
      const headers = { Origin: url.origin, Authorization: 'Bearer ' + url.hash.slice(1), 'Content-Type': 'application/json' }
      const remoteToken = 'a'.repeat(43)
      expect((await fetch(url.origin + '/api', { method: 'POST', headers, body: JSON.stringify({ ...config, action: 'connect-panel', panelPort: 4567, panelToken: remoteToken }) })).status).toBe(200)
      const body = JSON.stringify({ action: 'announcement', value: 'hello\nworld', reason: 'test' })
      const response = await fetch(url.origin + '/api/action', { method: 'POST', headers, body })
      expect(await response.json()).toEqual({ ok: true })
      const call = runner.mock.calls[0] as unknown as [string, string[], string, number]
      expect(call[1].join(' ')).not.toContain(remoteToken)
      expect(call[2]).toContain('http://127.0.0.1:4567/api/action')
      expect(call[2]).toContain('Authorization: Bearer ' + remoteToken)
      expect(call[2]).toContain('data = ' + JSON.stringify(body))
      expect(call[3]).toBeGreaterThan(300000)
    } finally { log.mockRestore(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('stops a failed candidate before restoring the old service and rejects effective path mismatch', async () => {
    const source = (await fs.readFile('scripts/server-admin/remote.sh', 'utf8'))
      .replaceAll('/opt/rvb', '$work').replace('/var/lock/rvb-admin.lock', '$work/lock').replace('(echo > /dev/tcp/127.0.0.1/$port) 2>/dev/null', 'false')
    const prelude = `
work=$(mktemp -d)
mkdir -p "$work/releases/old" "$work/releases/new"
echo test > "$work/releases/new/relay.mjs"
(cd "$work/releases/new" && sha256sum relay.mjs > SHA256SUMS)
# Model symlink operations because Windows Git Bash may copy instead of linking.
ln() { if [ "$1" = -sfn ]; then echo "$2" > "$3"; else echo "$2" > "$3"; fi; }
readlink() { if [ "$1" = -f ]; then cat "$2"; else cat "$1"; fi; }
test() { if [ "$1" = -L ]; then [ -f "$2" ]; elif [ "$1" = ! ] && [ "$2" = -L ]; then [ -d "$3" ]; else builtin test "$@"; fi; }
ln -s "$work/releases/old" "$work/relay-current"
systemctl() {
  echo "$*" >> "$work/calls"
  if [ "$1" = show ]; then
    if [ "$mismatch" = yes ]; then echo '/fixed/relay.mjs ;'; else echo "$work/relay-current/relay.mjs ;"; fi
  fi
  return 0
}
sleep() { :; }
flock() { :; }
set -- activate rvb-relay '' new
`
    for (const mismatch of ['yes', 'no']) {
      const result = spawnSync('C:/Program Files/Git/bin/bash.exe', ['-s'], { encoding: 'utf8', input: `mismatch=${mismatch}\n${prelude}\n(\n${source}\n)\ncat "$work/calls"\nreadlink "$work/relay-current"\nrm -rf "$work"\n` })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      if (mismatch === 'yes') expect(result.stdout).not.toContain('stop rvb-relay')
      else expect(result.stdout.match(/stop rvb-relay/g)).toHaveLength(2)
      expect(result.stdout.trim().endsWith('/releases/old'), result.stdout + result.stderr).toBe(true)
    }
  })
})

