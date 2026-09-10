import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createBundledBasePackInputV1, getBundledBaseProfileV1 } from '../lib/content-pipeline/runtime/bundled-base'
import { resolveAndroidProfile, type AndroidPackInput } from '../lib/content-pipeline/android/resolve'
import { resolveProfileV1 } from '../lib/content-pipeline/core/resolver'
import { ProfileStoreV1 } from '../lib/content-pipeline/runtime/profile-store'
import { AndroidSqliteAuthorityRepository } from './sqlite-authority-repository'

const output = (value: unknown) => console.log('RVB_HOST ' + JSON.stringify(value))
async function main() {
  const appRoot = process.env.APP_ROOT_DIR!, writable = process.env.USER_DATA_DIR!
  const config = JSON.parse(fs.readFileSync(process.env.RVB_ANDROID_HOST_CONFIG!, 'utf8'))
  const bundled: AndroidPackInput = { id: 'base', source: createBundledBasePackInputV1(appRoot).source }
  if (config.stable !== 'base') {
    const record = JSON.parse(fs.readFileSync(path.join(config.contentRoot, 'profiles', config.stable, 'record.json'), 'utf8'))
    const chain: AndroidPackInput[] = record.chain.map((id: string) => {
      if (id === 'base') return bundled
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid Android source ID')
      const root = path.join(config.contentRoot, 'sources', id)
      const paths: string[] = JSON.parse(fs.readFileSync(path.join(root, '.index.json'), 'utf8')).paths
      return { id, source: { manifestBytes: fs.readFileSync(path.join(root, 'manifest.json')), signatureBytes: fs.readFileSync(path.join(root, 'signature.json')), entries: paths.filter(p => p !== 'manifest.json' && p !== 'signature.json').map(p => {
        if (!/^(data|images)\//.test(p) || p.split('/').includes('..') || p.includes('\\')) throw new Error('Invalid Android content path')
        return { path: p, bytes: fs.readFileSync(path.join(root, p)) }
      }) } }
    })
    const resolved = resolveAndroidProfile(bundled, chain, config.trustedPublisherKeyIds)
    if (resolved.profile.resolvedProfileHash !== config.stable) throw new Error('Android host Profile mismatch')
    const inputs = chain.map(input => ({ source: input.source, policy: { kind: input === bundled ? 'bundled-base' as const : 'external' as const, expectedCompatibility: resolved.profile.compatibility } }))
    const view = resolveProfileV1({ base: inputs[0], patches: inputs.slice(1) })
    const store = new ProfileStoreV1({ rootDir: path.join(writable, 'resource-pack'), bundledBase: getBundledBaseProfileV1(appRoot) })
    const reference = store.installCandidate(view), activation = store.beginActivation(reference.resolvedProfileHash)
    store.commitActivation(activation.activationId, reference.resolvedProfileHash)
    process.env.RVB_PROFILE_ROOT = store.profileRoot(reference)!
    process.env.RVB_RESOLVED_PROFILE_HASH = reference.resolvedProfileHash
  }
  // Import only after selecting the immutable content snapshot; repositories load data at module initialization.
  const { createColyseusBattleServer } = await import('../lib/server/colyseus/create-colyseus-server')
  const { getServerGameProfileIdentityV1 } = await import('../lib/content-pipeline/runtime/profile-game-identity')
  const { openHostTunnel } = await import('../lib/server/relay/host-tunnel')
  const repository = new AndroidSqliteAuthorityRepository(config.databasePath, fileURLToPath(new URL('./sqlite-worker.mjs', import.meta.url)))
  const { server, journal } = createColyseusBattleServer({ repository, requireIdentityProof: true, healthIdentity: { runtime: 'colyseus-android', database: 'sqlite' } })
  let tunnel: Awaited<ReturnType<typeof openHostTunnel>> | undefined
  let stopping = false, publishing = false, generation = 0
  await server.listen(2567, '0.0.0.0')
  const identity = getServerGameProfileIdentityV1()
  if (identity.authorityContentHash !== config.identity.authorityContentHash || identity.resolvedProfileHash !== config.identity.resolvedProfileHash || identity.runnerRevision !== config.identity.runnerRevision) throw new Error('Android native/client/host identity mismatch')
  output({ type: 'ready', port: 2567, node: process.version, profileIdentity: identity })
  async function stop() {
    if (stopping) return
    stopping = true; generation++; tunnel?.close(); tunnel = undefined
    await journal.close()
    await server.gracefullyShutdown(false)
    await repository.close()
  }
  const lines = readline.createInterface({ input: process.stdin })
  lines.on('line', line => {
    if (line.length > 16384) return
    void (async () => {
      let request: { id?: string; action?: string; relayUrl?: string; name?: string; visible?: boolean; publishKey?: string } | undefined
      try {
        request = JSON.parse(line) as NonNullable<typeof request>
        let result: unknown = { published: tunnel?.published ?? null }
        if (request.action === 'shutdown') {
          await stop(); output({ type: 'reply', id: request.id, ok: true }); process.exit(0)
        }
        if (request.action === 'stop') { generation++; tunnel?.close(); tunnel = undefined; result = { published: null } }
        if (request.action === 'publish') {
          if (publishing || stopping) throw new Error('主机正在切换连接，请稍后重试')
          publishing = true; const current = ++generation
          tunnel?.close(); tunnel = undefined
          try {
            const next = await openHostTunnel({ relayUrl: String(request.relayUrl), localOrigin: 'http://127.0.0.1:2567', name: String(request.name || '').slice(0, 60), visible: request.visible === true, publishKey: String(request.publishKey || ''), onClosed: () => { if (generation === current) tunnel = undefined } })
            if (current !== generation || stopping) { next.close(); throw new Error('发布已取消') }
            tunnel = next; result = { published: next.published }
          } finally { publishing = false }
        }
        output({ type: 'reply', id: request.id, ok: true, ...result as object })
      } catch (error) { output({ type: 'reply', id: request?.id, ok: false, error: error instanceof Error ? error.message : String(error) }) }
    })()
  })
  lines.on('close', () => { void stop().then(() => process.exit(0), error => { console.error(error); process.exit(1) }) })
}
main().catch(error => { console.error('[android-host] startup failed', error); output({ type: 'failed', error: error instanceof Error ? error.message : String(error) }); process.exit(1) })
