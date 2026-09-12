import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { AdventureCheckpoint } from '../lib/pve/roguelike/checkpoint'
import type { AdventureReceipt, AdventureStoredRun } from '../lib/server/colyseus/adventure-store'

/** Called only inside the existing SQLite worker, never on the room or UI thread. */
export class SqliteAdventureStorage {
  constructor(private db: DatabaseSync) {}
  initialize() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS adventure_runs (
      run_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, revision INTEGER NOT NULL,
      current_json TEXT NOT NULL, saved_json TEXT, saved_at TEXT);
      CREATE TABLE IF NOT EXISTS adventure_receipts (
      run_id TEXT NOT NULL REFERENCES adventure_runs(run_id), actor TEXT NOT NULL,
      action_id TEXT NOT NULL, receipt_json TEXT NOT NULL, PRIMARY KEY(run_id,actor,action_id));
      CREATE TABLE IF NOT EXISTS adventure_saves (
      save_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES adventure_runs(run_id),
      host_id TEXT NOT NULL, revision INTEGER NOT NULL, act_number INTEGER NOT NULL,
      saved_json TEXT NOT NULL, saved_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS adventure_saves_host_time ON adventure_saves(host_id,saved_at DESC)`)
  }
  private transaction(run: () => void) {
    this.db.exec('BEGIN IMMEDIATE')
    try { run(); this.db.exec('COMMIT') }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  create(runId: string, hostId: string, current: AdventureCheckpoint) {
    this.db.prepare('INSERT INTO adventure_runs(run_id,host_id,revision,current_json) VALUES(?,?,?,?)')
      .run(runId, hostId, current.revision, JSON.stringify(current))
  }
  get(id: string): AdventureStoredRun | undefined {
    const row = this.db.prepare(id.startsWith('save-')
      ? 'SELECT save_id AS run_id,host_id,saved_json AS current_json,saved_json,saved_at FROM adventure_saves WHERE save_id=?'
      : 'SELECT * FROM adventure_runs WHERE run_id=?').get(id)
    return row ? { runId: String(row.run_id), hostId: String(row.host_id), current: JSON.parse(String(row.current_json)),
      saved: row.saved_json === null ? null : JSON.parse(String(row.saved_json)), savedAt: row.saved_at === null ? null : String(row.saved_at) } : undefined
  }
  list(hostId: string) {
    const rows = this.db.prepare(`SELECT save_id AS run_id,revision,act_number,saved_at,'manual' AS kind
      FROM adventure_saves WHERE host_id=? UNION ALL
      SELECT r.run_id,json_extract(r.saved_json,'$.revision'),
      json_extract(r.saved_json,'$.aggregate.actIndex')+1,r.saved_at,'auto' AS kind
      FROM adventure_runs r WHERE r.host_id=? AND r.saved_json IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM adventure_saves s WHERE s.run_id=r.run_id
      AND s.revision=json_extract(r.saved_json,'$.revision')) ORDER BY saved_at DESC,run_id`).all(hostId, hostId)
    return rows.map(row => ({ runId: String(row.run_id), revision: Number(row.revision), actNumber: Number(row.act_number),
      savedAt: String(row.saved_at), kind: row.kind as 'manual' | 'auto' }))
  }
  commit(runId: string, expected: number, current: AdventureCheckpoint, receipt: AdventureReceipt, save: boolean) {
    if (current.revision !== expected + 1 || receipt.revision !== current.revision) throw new Error('冒险提交版本无效')
    this.transaction(() => {
      const json = JSON.stringify(current)
      const result = this.db.prepare(`UPDATE adventure_runs SET revision=?,current_json=?,
        saved_json=CASE WHEN ? THEN ? ELSE saved_json END,saved_at=CASE WHEN ? THEN ? ELSE saved_at END
        WHERE run_id=? AND revision=?`).run(current.revision, json, Number(save), json, Number(save), new Date().toISOString(), runId, expected)
      if (result.changes !== 1) throw new Error('冒险进度已改变，拒绝覆盖')
      this.db.prepare('INSERT INTO adventure_receipts VALUES(?,?,?,?)').run(runId, receipt.actor, receipt.actionId, JSON.stringify(receipt))
    })
  }
  receipt(runId: string, actor: string, actionId: string): AdventureReceipt | undefined {
    const row = this.db.prepare('SELECT receipt_json FROM adventure_receipts WHERE run_id=? AND actor=? AND action_id=?').get(runId, actor, actionId)
    return row ? JSON.parse(String(row.receipt_json)) : undefined
  }
  save(runId: string, hostId: string, expected: number) {
    this.transaction(() => {
      const now = new Date().toISOString()
      const result = this.db.prepare('UPDATE adventure_runs SET saved_json=current_json,saved_at=? WHERE run_id=? AND host_id=? AND revision=?')
        .run(now, runId, hostId, expected)
      if (result.changes !== 1) throw new Error('存档权限或版本已改变')
      this.db.prepare(`INSERT INTO adventure_saves SELECT ?,run_id,host_id,revision,
        json_extract(saved_json,'$.aggregate.actIndex')+1,saved_json,saved_at FROM adventure_runs WHERE run_id=?`)
        .run('save-' + randomUUID(), runId)
    })
  }
}
