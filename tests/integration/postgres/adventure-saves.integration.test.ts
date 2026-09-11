import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { EmbeddedPostgresController } from '../../../electron-client/embedded-postgres'
import { findFreePort } from '../../../electron-client/local-port'
import { PostgresAdventureRepository } from '@/lib/server/colyseus/adventure-store'
import { CooperativeAdventureSession, createCooperativeAdventure } from '@/lib/pve/roguelike/cooperative-session'
import { createAdventureCheckpoint, restoreAdventureCheckpoint } from '@/lib/pve/roguelike/checkpoint'
import { adventureContent } from '@/lib/pve/roguelike/content'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'

const runtimeRoot=path.resolve('_client-postgres/pgsql')
describe.skipIf(process.platform!=='win32'||!fs.existsSync(path.join(runtimeRoot,'bin/postgres.exe')))('PVE independent saves on real PostgreSQL',()=>{
  it('retains older snapshots across later saves and restart, rejects stale/foreign saves',async()=>{
    const stateRoot=fs.mkdtempSync(path.join(os.tmpdir(),'rvb-adventure-saves-'))
    const controller=new EmbeddedPostgresController({runtimeRoot,stateRoot,findFreePort,portHint:38731,
      protectSecret:text=>Buffer.from(text),unprotectSecret:bytes=>bytes.toString()})
    let pool:Pool|undefined
    try{
      const connection=await controller.start()
      pool=new Pool({connectionString:connection.url})
      let store=new PostgresAdventureRepository(pool)
      await store.initialize();await store.initialize()
      const profile=getServerGameProfileIdentityV1(),content=structuredClone(adventureContent)
      const session=new CooperativeAdventureSession(await createCooperativeAdventure(profile,content,[{playerId:'host',name:'房主',pieceIds:['tracer','ana']}]),content,profile)
      const first=createAdventureCheckpoint(session,false)
      await store.create('run','host',first)
      await store.save('run','host',first.revision)
      const old=(await store.list('host'))[0]
      expect(old.kind).toBe('manual')
      const before=session.snapshot()
      session.human({type:before.state.turn.phase==='start'?'beginPhase':'endTurn',playerId:'host'},before.revision,'host')
      const next=createAdventureCheckpoint(session,false)
      await store.commit('run',first.revision,next,{actor:'host',actionId:'advance',fingerprint:'advance',revision:next.revision,status:'applied'},true)
      expect((await store.list('host')).map(s=>s.kind)).toContain('auto')
      await expect(store.save('run','guest',next.revision)).rejects.toThrow()
      await expect(store.save('run','host',first.revision)).rejects.toThrow()
      await store.save('run','host',next.revision)
      await store.save('run','host',next.revision)
      const saves=await store.list('host')
      expect(saves).toHaveLength(3)
      expect(new Set(saves.map(s=>s.runId)).size).toBe(3)
      expect(await store.list('guest')).toEqual([])
      await pool.end();pool=undefined
      await controller.stop()
      const restarted=await controller.start()
      pool=new Pool({connectionString:restarted.url});store=new PostgresAdventureRepository(pool)
      await store.initialize()
      const restored=await store.get(old.runId)
      expect(restored?.saved).toEqual(first)
      expect(restoreAdventureCheckpoint(restored!.saved,profile,false).exportAggregate()).toEqual(first.aggregate)
      expect((await store.get('run'))?.current).toEqual(next)
      expect(await store.list('host')).toHaveLength(3)
    }finally{await pool?.end();await controller.stop()}
  },90000)
})
