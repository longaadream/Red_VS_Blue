import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import type { Room } from '../lib/game/room-model'
import type { BattleAuthorityCheckpointRecord } from '../lib/game/battle-transition'
import type { PostgresAuthorityTransitionJob } from '../lib/server/postgres/authority-types'

// Runs in a dedicated worker; SQLite fsync never blocks the Colyseus room clock.
const db = new DatabaseSync(workerData.databasePath)
const sessionRooms = new Set<string>()
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
function transaction<T>(run: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try { const result = run(); db.exec('COMMIT'); return result }
  catch (error) { db.exec('ROLLBACK'); throw error }
}
function schema() {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA max_page_count=65536; PRAGMA wal_autocheckpoint=256')
  const version = db.prepare('PRAGMA user_version').get()!.user_version
  if (version !== 0 && version !== 1) throw new Error('Unsupported Android authority schema: ' + version)
  transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, durable INTEGER NOT NULL,
      chain TEXT NOT NULL, room TEXT NOT NULL, genesis TEXT NOT NULL, updated INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS transitions (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, action_id TEXT NOT NULL, job TEXT NOT NULL, checksum TEXT NOT NULL,
      PRIMARY KEY(room_id,version), UNIQUE(room_id,action_id)
    ); PRAGMA user_version=1`)
    // Previous process rooms are diagnostic records, never advertised as resumable sessions.
    db.prepare('DELETE FROM rooms WHERE updated < ?').run(Date.now() - 7 * 86400000)
    db.exec('DELETE FROM rooms WHERE id NOT IN (SELECT id FROM rooms ORDER BY updated DESC LIMIT 100)')
  })
}
function initialize(room: Room, checkpoint: BattleAuthorityCheckpointRecord, epoch: number) {
  const id = room.id.trim().toLowerCase()
  if (!id || checkpoint.roomId !== id || checkpoint.authorityVersion !== 0 || checkpoint.reason !== 'initial' || !Number.isSafeInteger(epoch) || epoch < 1) throw new Error('Invalid Android authority genesis')
  transaction(() => {
    const existing = db.prepare('SELECT genesis,epoch,durable FROM rooms WHERE id=?').get(id)
    if (existing) {
      if (!sessionRooms.has(id) || existing.genesis !== JSON.stringify(checkpoint) || existing.epoch !== epoch || existing.durable !== 0) throw new Error('Android authority genesis conflict')
      return
    }
    if (sessionRooms.size >= 32) throw new Error('本次主机已达到对局记录上限，请结束开房后重新启动主机')
    db.prepare('INSERT INTO rooms VALUES (?,?,0,?,?,?,?)').run(id, epoch, checkpoint.transitionHash, JSON.stringify(room), JSON.stringify(checkpoint), Date.now())
  })
  sessionRooms.add(id)
}
function commit(id: string, jobs: readonly PostgresAuthorityTransitionJob[]) {
  if (!sessionRooms.has(id) || !jobs.length) throw new Error('Android authority session missing or batch empty')
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i], t = job.transition, previous = jobs[i - 1]?.transition
    if (job.roomId !== id || job.nextRoom.id !== id || t.roomId !== id || t.receipt.roomId !== id || job.epoch !== jobs[0].epoch || t.toVersion !== t.fromVersion + 1 ||
      (previous && (previous.toVersion !== t.fromVersion || previous.transitionHash !== t.previousTransitionHash))) throw new Error('Android authority batch identity/version/hash gap')
  }
  return transaction(() => {
    const row = db.prepare('SELECT epoch,durable,chain FROM rooms WHERE id=?').get(id)!
    const first = jobs[0], last = jobs[jobs.length - 1]
    if (row.epoch !== first.epoch) throw new Error('Android authority epoch conflict')
    if (row.durable === last.transition.toVersion) {
      for (const job of jobs) {
        const stored = db.prepare('SELECT job,checksum FROM transitions WHERE room_id=? AND version=?').get(id, job.transition.toVersion)
        const json = JSON.stringify(job)
        if (!stored || stored.job !== json || stored.checksum !== digest(json)) throw new Error('Android authority duplicate batch conflict')
      }
      return Number(row.durable)
    }
    if (row.durable !== first.transition.fromVersion || row.chain !== first.transition.previousTransitionHash) throw new Error('Android authority durable CAS conflict')
    for (const job of jobs) {
      const json = JSON.stringify(job)
      db.prepare('INSERT INTO transitions VALUES (?,?,?,?,?)').run(id, job.transition.toVersion, job.transition.clientActionId, json, digest(json))
    }
    db.prepare('UPDATE rooms SET durable=?,chain=?,room=?,updated=? WHERE id=?').run(last.transition.toVersion, last.transition.transitionHash, JSON.stringify(last.nextRoom), Date.now(), id)
    return last.transition.toVersion
  })
}
function restore(id: string) {
  if (!sessionRooms.has(id)) return undefined
  const row = db.prepare('SELECT * FROM rooms WHERE id=?').get(id)!
  const rows = db.prepare('SELECT job,checksum FROM transitions WHERE room_id=? ORDER BY version').all(id)
  const transitions = rows.map(entry => {
    if (digest(String(entry.job)) !== entry.checksum) throw new Error('Android authority record checksum mismatch')
    return (JSON.parse(String(entry.job)) as PostgresAuthorityTransitionJob).transition
  })
  return { room: { ...JSON.parse(String(row.room)), battleAuthorityVersion: row.durable, battleAuthorityDurableVersion: row.durable, battleAuthorityPersistenceStatus: 'durable' }, epoch: row.epoch, durableAuthorityVersion: row.durable, transitions, receipts: transitions.map(t => t.receipt) }
}
parentPort!.on('message', ({ id, method, args }) => {
  try {
    let value: unknown
    if (method === 'initializeSchema') schema()
    else if (method === 'healthCheck') db.prepare('SELECT 1').get()
    else if (method === 'initializeRoom') initialize(args[0], args[1], args[2])
    else if (method === 'commitTransitionBatch') value = commit(args[0], args[1])
    else if (method === 'restoreRoom') value = restore(args[0])
    else if (method === 'close') { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close() }
    else throw new Error('Unknown Android storage method')
    parentPort!.postMessage({ id, value })
  } catch (error) { parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) }) }
})
