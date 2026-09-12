import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AndroidSqliteAuthorityRepository } from '../../mobile-server/sqlite-authority-repository'
import { CooperativeAdventureSession, createCooperativeAdventure } from '../../lib/pve/roguelike/cooperative-session'
import { createAdventureCheckpoint, restoreAdventureCheckpoint } from '../../lib/pve/roguelike/checkpoint'
import { adventureContent } from '../../lib/pve/roguelike/content'
import { getServerGameProfileIdentityV1 } from '../../lib/content-pipeline/runtime/profile-game-identity'

describe('Android durable adventure storage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-android-pve-'))
  const worker = path.join(root, 'worker.mjs')
  beforeAll(async () => { await build({ entryPoints: ['mobile-server/sqlite-authority-worker.ts'], outfile: worker, bundle: true, platform: 'node', format: 'esm', target: 'node24' }) })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
  it('keeps independent history after restart, rejects stale/foreign writes and rolls back duplicate receipts', async () => {
    const file = path.join(root, 'host.sqlite')
    let repository = new AndroidSqliteAuthorityRepository(file, worker)
    const profile = getServerGameProfileIdentityV1(), content = structuredClone(adventureContent)
    const session = new CooperativeAdventureSession(await createCooperativeAdventure(profile, content, [{ playerId: 'host', name: '房主', pieceIds: ['tracer', 'ana'] }]), content, profile)
    const first = createAdventureCheckpoint(session, false)
    try {
      await repository.initializeSchema()
      let store = repository.adventureRepository()
      await store.initialize(); await store.initialize()
      await store.create('run', 'host', first)
      await store.save('run', 'host', first.revision)
      const old = (await store.list('host'))[0]
      const before = session.snapshot()
      session.human({ type: before.state.turn.phase === 'start' ? 'beginPhase' : 'endTurn', playerId: 'host' }, before.revision, 'host')
      const next = createAdventureCheckpoint(session, false)
      const receipt = { actor: 'host', actionId: 'advance', fingerprint: 'advance', revision: next.revision, status: 'applied' as const }
      await store.commit('run', first.revision, next, receipt, true)
      expect((await store.list('host')).some(s => s.kind === 'auto')).toBe(true)
      await expect(store.save('run', 'guest', next.revision)).rejects.toThrow('权限')
      await expect(store.save('run', 'host', first.revision)).rejects.toThrow('版本')
      await expect(store.commit('run', first.revision, next, receipt, false)).rejects.toThrow('拒绝覆盖')
      const later = structuredClone(next); later.revision++
      await expect(store.commit('run', next.revision, later, { ...receipt, revision: later.revision }, true)).rejects.toThrow('UNIQUE')
      expect((await store.get('run'))?.current).toEqual(next)
      expect((await store.get('run'))?.saved).toEqual(next)
      await store.save('run', 'host', next.revision); await store.save('run', 'host', next.revision)
      expect(await store.list('guest')).toEqual([])
      await repository.close()
      repository = new AndroidSqliteAuthorityRepository(file, worker)
      await repository.initializeSchema(); store = repository.adventureRepository(); await store.initialize()
      expect(await store.receipt('run', 'host', 'advance')).toEqual(receipt)
      const saved = (await store.get(old.runId))!
      expect(saved.saved).toEqual(first)
      expect(restoreAdventureCheckpoint(saved.saved!, profile, false).exportAggregate()).toEqual(first.aggregate)
      expect((await store.get('run'))?.current).toEqual(next)
      expect(await store.list('host')).toHaveLength(3)
      expect(new Set((await store.list('host')).map(s => s.runId)).size).toBe(3)
    } finally { await repository.close() }
  })
})
