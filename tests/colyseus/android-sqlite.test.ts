import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AndroidSqliteAuthorityRepository } from '../../mobile-server/sqlite-authority-repository'
import { CandidateBattleStore } from '../../lib/server/colyseus/candidate-battle-store'
import { createDevelopmentBattleRoom } from '../../lib/server/colyseus/development-battle-fixture'
import { PostgresAuthorityJournal } from '../../lib/server/postgres/postgres-authority-journal'
import { dispatchRoomBattleAction } from '../../lib/game/room-battle-actions'
import { getBattleStorage } from '../../lib/game/battle-storage'
import type { BattleAuthorityCheckpointRecord } from '../../lib/game/battle-transition'
import type { BattleState } from '../../lib/game/turn'

describe('Android SQLite authority worker', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rvb-android-storage-'))
  const worker=path.join(root,'worker.mjs')
  beforeAll(async()=>{await build({entryPoints:['mobile-server/sqlite-authority-worker.ts'],outfile:worker,bundle:true,platform:'node',format:'esm',target:'node24'})})
  afterAll(()=>fs.rmSync(root,{recursive:true,force:true}))

  it('rolls back a partially inserted batch, deduplicates exact retries, and detects record corruption',async()=>{
    const file=path.join(root,'source.sqlite'), targetFile=path.join(root,'target.sqlite')
    const repository=new AndroidSqliteAuthorityRepository(file,worker), target=new AndroidSqliteAuthorityRepository(targetFile,worker)
    const journal=new PostgresAuthorityJournal(repository,{maxBatchSize:1,maxDwellMs:1})
    try {
      await repository.initializeSchema();await target.initializeSchema()
      const store=await CandidateBattleStore.open({roomId:'android-sqlite-qa',repository,journal,fixtureFactory:createDevelopmentBattleRoom})
      const genesis=await store.getRoom('android-sqlite-qa');expect(genesis).toBeDefined()
      const read=new DatabaseSync(file)
      const checkpoint=JSON.parse(String(read.prepare('SELECT genesis FROM rooms').get()!.genesis)) as BattleAuthorityCheckpointRecord
      read.close()
      await target.initializeRoom(genesis!,checkpoint,1)
      const commit=vi.spyOn(repository,'commitTransitionBatch')
      for(let index=0;index<2;index++){
        const room=(await store.getRoom('android-sqlite-qa'))!,playerId=(getBattleStorage(room)!.state as BattleState).turn.currentPlayerId
        const command=index===0?{type:'endTurn' as const,playerId,clientActionId:'sqlite-1'}:{type:'beginPhase' as const,clientActionId:'sqlite-2'}
        expect((await dispatchRoomBattleAction(store,room.id,playerId,command,{expectedAuthorityVersion:index})).kind).toBe('applied')
        await journal.drain(room.id)
      }
      await journal.close()
      const jobs=commit.mock.calls.flatMap(call=>call[1]);expect(jobs).toHaveLength(2)
      const invalid=structuredClone(jobs);invalid[1].transition.clientActionId=invalid[0].transition.clientActionId
      await expect(target.commitTransitionBatch(genesis!.id,invalid)).rejects.toThrow('UNIQUE')
      expect((await target.restoreRoom(genesis!.id))!.durableAuthorityVersion).toBe(0)
      expect((await target.restoreRoom(genesis!.id))!.transitions).toHaveLength(0)
      expect(await target.commitTransitionBatch(genesis!.id,jobs)).toBe(2)
      expect(await target.commitTransitionBatch(genesis!.id,jobs)).toBe(2)
      const conflict=structuredClone(jobs);conflict[1].transition.playerId='different-player'
      await expect(target.commitTransitionBatch(genesis!.id,conflict)).rejects.toThrow('duplicate batch conflict')
      const corrupt=new DatabaseSync(targetFile);corrupt.prepare("UPDATE transitions SET job='{}' WHERE version=1").run();corrupt.close()
      await expect(target.restoreRoom(genesis!.id)).rejects.toThrow('checksum mismatch')
    }finally{await journal.close();await repository.close();await target.close()}
    const nextProcess=new AndroidSqliteAuthorityRepository(file,worker)
    try{await nextProcess.initializeSchema();expect(await nextProcess.listRestorableRoomIds()).toEqual([]);expect(await nextProcess.restoreRoom('android-sqlite-qa')).toBeUndefined()}
    finally{await nextProcess.close()}
  })

  it('rejects unknown schema versions and worker failure instead of acknowledging writes',async()=>{
    const file=path.join(root,'unknown.sqlite'),db=new DatabaseSync(file);db.exec('PRAGMA user_version=99');db.close()
    const repository=new AndroidSqliteAuthorityRepository(file,worker)
    try{await expect(repository.initializeSchema()).rejects.toThrow('Unsupported Android authority schema')}
    finally{await repository.close()}
    await expect(repository.healthCheck()).rejects.toThrow('worker stopped')
  })
})
