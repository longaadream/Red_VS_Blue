import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import type { AdventureCheckpoint } from '../../pve/roguelike/checkpoint'

export interface AdventureStoredRun { runId:string; hostId:string; current:AdventureCheckpoint; saved:AdventureCheckpoint|null; savedAt:string|null }
export interface AdventureReceipt { actor:string; actionId:string; fingerprint:string; revision:number; status:'applied'|'rejected'; error?:string }
export interface AdventureRepository {
  initialize():Promise<void>
  create(runId:string,hostId:string,current:AdventureCheckpoint):Promise<void>
  get(runId:string):Promise<AdventureStoredRun|undefined>
  list(hostId:string):Promise<{runId:string;revision:number;actNumber:number;savedAt:string;kind?:'manual'|'auto'}[]>
  commit(runId:string,expectedRevision:number,current:AdventureCheckpoint,receipt:AdventureReceipt,save:boolean):Promise<void>
  receipt(runId:string,actor:string,actionId:string):Promise<AdventureReceipt|undefined>
  save(runId:string,hostId:string,expectedRevision:number):Promise<void>
}

/** JSONB aggregate and its command receipt are one PostgreSQL transaction. */
export class PostgresAdventureRepository implements AdventureRepository {
  constructor(private pool:Pool){}
  async initialize(){
    await this.pool.query(`CREATE TABLE IF NOT EXISTS rvb_adventure_runs (
      run_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, revision BIGINT NOT NULL,
      current_json JSONB NOT NULL, saved_json JSONB, saved_at TIMESTAMPTZ)`)
    await this.pool.query(`CREATE TABLE IF NOT EXISTS rvb_adventure_receipts (
      run_id TEXT NOT NULL REFERENCES rvb_adventure_runs(run_id), actor TEXT NOT NULL,
      action_id TEXT NOT NULL, receipt_json JSONB NOT NULL, PRIMARY KEY(run_id,actor,action_id))`)
    await this.pool.query(`CREATE TABLE IF NOT EXISTS rvb_adventure_saves (
      save_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES rvb_adventure_runs(run_id),
      host_id TEXT NOT NULL, revision BIGINT NOT NULL, act_number INTEGER NOT NULL,
      saved_json JSONB NOT NULL, saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    await this.pool.query('CREATE INDEX IF NOT EXISTS rvb_adventure_saves_host_time ON rvb_adventure_saves(host_id,saved_at DESC)')
  }
  async create(runId:string,hostId:string,current:AdventureCheckpoint){
    await this.pool.query('INSERT INTO rvb_adventure_runs(run_id,host_id,revision,current_json) VALUES($1,$2,$3,$4)',[runId,hostId,current.revision,JSON.stringify(current)])
  }
  async get(runId:string){
    const r=await this.pool.query(runId.startsWith('save-')
      ? 'SELECT save_id AS run_id,host_id,saved_json AS current_json,saved_json,saved_at FROM rvb_adventure_saves WHERE save_id=$1'
      : 'SELECT * FROM rvb_adventure_runs WHERE run_id=$1',[runId]),row=r.rows[0]
    return row?{runId:row.run_id,hostId:row.host_id,current:row.current_json,saved:row.saved_json,savedAt:row.saved_at?.toISOString()??null}:undefined
  }
  async list(hostId:string){
    const r=await this.pool.query(`SELECT save_id AS run_id,revision,act_number,saved_at,'manual' AS kind
      FROM rvb_adventure_saves WHERE host_id=$1
      UNION ALL
      SELECT r.run_id,(r.saved_json->>'revision')::bigint,
        (r.saved_json->'aggregate'->>'actIndex')::integer+1,r.saved_at,'auto' AS kind
      FROM rvb_adventure_runs r WHERE r.host_id=$1 AND r.saved_json IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM rvb_adventure_saves s WHERE s.run_id=r.run_id
          AND s.revision=(r.saved_json->>'revision')::bigint)
      ORDER BY saved_at DESC,run_id`,[hostId])
    return r.rows.map(row=>({runId:row.run_id,revision:Number(row.revision),actNumber:row.act_number,savedAt:row.saved_at.toISOString(),kind:row.kind as 'manual'|'auto'}))
  }
  async commit(runId:string,expectedRevision:number,current:AdventureCheckpoint,receipt:AdventureReceipt,save:boolean){
    if(current.revision!==expectedRevision+1||receipt.revision!==current.revision)throw new Error('冒险提交版本无效')
    const client=await this.pool.connect()
    try{
      await client.query('BEGIN')
      const updated=await client.query(`UPDATE rvb_adventure_runs SET revision=$3,current_json=$4,
        saved_json=CASE WHEN $5 THEN $4::jsonb ELSE saved_json END,
        saved_at=CASE WHEN $5 THEN NOW() ELSE saved_at END WHERE run_id=$1 AND revision=$2`,[runId,expectedRevision,current.revision,JSON.stringify(current),save])
      if(updated.rowCount!==1)throw new Error('冒险进度已改变，拒绝覆盖')
      await client.query('INSERT INTO rvb_adventure_receipts(run_id,actor,action_id,receipt_json) VALUES($1,$2,$3,$4)',[runId,receipt.actor,receipt.actionId,JSON.stringify(receipt)])
      await client.query('COMMIT')
    }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  }
  async receipt(runId:string,actor:string,actionId:string){
    const r=await this.pool.query('SELECT receipt_json FROM rvb_adventure_receipts WHERE run_id=$1 AND actor=$2 AND action_id=$3',[runId,actor,actionId])
    return r.rows[0]?.receipt_json as AdventureReceipt|undefined
  }
  async save(runId:string,hostId:string,expectedRevision:number){
    // One statement locks the expected revision and appends an immutable checkpoint atomically.
    const r=await this.pool.query(`WITH checkpoint AS (
      UPDATE rvb_adventure_runs SET saved_json=current_json,saved_at=NOW()
      WHERE run_id=$1 AND host_id=$2 AND revision=$3 RETURNING *
    ) INSERT INTO rvb_adventure_saves(save_id,run_id,host_id,revision,act_number,saved_json,saved_at)
      SELECT $4,run_id,host_id,revision,(saved_json->'aggregate'->>'actIndex')::integer+1,saved_json,saved_at
      FROM checkpoint`,[runId,hostId,expectedRevision,`save-${randomUUID()}`])
    if(r.rowCount!==1)throw new Error('存档权限或版本已改变')
  }
}
