import { createHash, randomUUID } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ContentIdV1Schema, Sha256HexV1Schema } from '@/lib/content-pipeline/contracts/primitives-v1'
import { parseStrictJsonBytesV1 } from '@/lib/content-pipeline/core/json-safety'
import { parseGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { SERVER_BATTLE_STORAGE_SCHEMA_V1, type ServerBattleState } from '@/lib/game/battle-storage'
import { PveRunV1Schema, type PveRunV1 } from './contracts/run-v1'

export const PVE_RUN_AGGREGATE_SCHEMA_VERSION_V1 = 'rvb-pve-run-aggregate/v1' as const
export const PVE_AUTHORITY_TOMBSTONE_SCHEMA_VERSION_V1 = 'rvb-pve-authority-tombstone/v1' as const
export interface PveRunAggregateV1 { readonly schemaVersion: typeof PVE_RUN_AGGREGATE_SCHEMA_VERSION_V1; readonly run: PveRunV1; readonly battleState: ServerBattleState | null }
export interface PveAuthorityTombstoneV1 {
  readonly schemaVersion: typeof PVE_AUTHORITY_TOMBSTONE_SCHEMA_VERSION_V1
  readonly runId: string; readonly campaignId: string; readonly authorityContentHash: string
  readonly replacementAuthorityContentHash: string; readonly revision: number; readonly checkpointId: string
  readonly activeBattleId: string | null; readonly activeBattleStateHash: string | null
  readonly receiptCount: number; readonly evidenceHash: string; readonly reason: string
}
export interface PveAuthorityCleanupReportV1 { readonly authorityContentHash: string; readonly preservedRunIds: readonly string[]; readonly clearedRunIds: readonly string[]; readonly tombstones: readonly PveAuthorityTombstoneV1[] }
export class PveRunStoreErrorV1 extends Error { constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); this.name = 'PveRunStoreErrorV1' } }
export interface PveRunStoreV1 {
  get(runId: string): PveRunAggregateV1 | undefined; list(): readonly PveRunAggregateV1[]
  create(value: PveRunAggregateV1): PveRunAggregateV1
  compareAndSet(runId: string, expectedRevision: number, next: PveRunAggregateV1): PveRunAggregateV1
  reconcileAuthority(hash: string, reason: string): PveAuthorityCleanupReportV1
  listTombstones(): readonly PveAuthorityTombstoneV1[]
  readArchivedEvidence(tombstone: PveAuthorityTombstoneV1): PveRunAggregateV1
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const serialize = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
function id(v: string) { try { return ContentIdV1Schema.parse(v) } catch { throw new PveRunStoreErrorV1('PVE_RUN_ID_INVALID', v) } }
function hash(v: string) { try { return Sha256HexV1Schema.parse(v) } catch { throw new PveRunStoreErrorV1('PVE_HASH_INVALID', v) } }
function parseBattle(v: unknown): ServerBattleState | null {
  if (v === null) return null
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('invalid battleState')
  const x = v as Record<string, unknown>
  if (Object.keys(x).sort().join(',') !== 'profileIdentity,rootSeed,state,storageSchemaVersion,type' || x.type !== 'server-state' || x.storageSchemaVersion !== SERVER_BATTLE_STORAGE_SCHEMA_V1 || !Number.isSafeInteger(x.rootSeed) || Number(x.rootSeed) < 0 || Number(x.rootSeed) > 0xffff_ffff || !x.state || typeof x.state !== 'object' || Array.isArray(x.state)) throw new Error('invalid formal battleState')
  return { type: 'server-state', storageSchemaVersion: SERVER_BATTLE_STORAGE_SCHEMA_V1, profileIdentity: parseGameProfileIdentityV1(x.profileIdentity), rootSeed: Number(x.rootSeed) >>> 0, state: clone(x.state) }
}
export function parsePveRunAggregateV1(v: unknown): PveRunAggregateV1 {
  try {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('aggregate must be an object')
    const x = v as Record<string, unknown>
    if (Object.keys(x).sort().join(',') !== 'battleState,run,schemaVersion' || x.schemaVersion !== PVE_RUN_AGGREGATE_SCHEMA_VERSION_V1) throw new Error('aggregate schema mismatch')
    const run = PveRunV1Schema.parse(x.run); const battleState = parseBattle(x.battleState)
    if (battleState && battleState.profileIdentity.authorityContentHash !== run.authorityContentHash) throw new Error('battle authority mismatch')
    return { schemaVersion: PVE_RUN_AGGREGATE_SCHEMA_VERSION_V1, run, battleState }
  } catch (e) { throw e instanceof PveRunStoreErrorV1 ? e : new PveRunStoreErrorV1('PVE_RUN_AGGREGATE_INVALID', e instanceof Error ? e.message : String(e)) }
}
function evidenceHash(v: PveRunAggregateV1) { return createHash('sha256').update(serialize(v)).digest('hex') }
function readStrictJsonFile(target: string, code: string): unknown {
  try {
    return parseStrictJsonBytesV1(new Uint8Array(readFileSync(target)))
  } catch {
    throw new PveRunStoreErrorV1(code, target)
  }
}
function parseTombstone(v: unknown): PveAuthorityTombstoneV1 {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new PveRunStoreErrorV1('PVE_AUDIT_TOMBSTONE_CORRUPT', 'not an object')
  const x = v as Record<string, unknown>
  if (Object.keys(x).sort().join(',') !== 'activeBattleId,activeBattleStateHash,authorityContentHash,campaignId,checkpointId,evidenceHash,reason,receiptCount,replacementAuthorityContentHash,revision,runId,schemaVersion') throw new PveRunStoreErrorV1('PVE_AUDIT_TOMBSTONE_CORRUPT', 'unexpected fields')
  if (x.schemaVersion !== PVE_AUTHORITY_TOMBSTONE_SCHEMA_VERSION_V1 || !Number.isSafeInteger(x.revision) || Number(x.revision) < 0 || !Number.isSafeInteger(x.receiptCount) || Number(x.receiptCount) < 0 || typeof x.reason !== 'string' || !x.reason.trim()) throw new PveRunStoreErrorV1('PVE_AUDIT_TOMBSTONE_CORRUPT', 'invalid fields')
  return {
    schemaVersion: PVE_AUTHORITY_TOMBSTONE_SCHEMA_VERSION_V1,
    runId: id(String(x.runId)), campaignId: id(String(x.campaignId)),
    authorityContentHash: hash(String(x.authorityContentHash)),
    replacementAuthorityContentHash: hash(String(x.replacementAuthorityContentHash)),
    revision: Number(x.revision), checkpointId: id(String(x.checkpointId)),
    activeBattleId: x.activeBattleId === null ? null : id(String(x.activeBattleId)),
    activeBattleStateHash: x.activeBattleStateHash === null ? null : hash(String(x.activeBattleStateHash)),
    receiptCount: Number(x.receiptCount), evidenceHash: hash(String(x.evidenceHash)), reason: x.reason,
  }
}
function tombstone(v: PveRunAggregateV1, replacement: string, reason: string): PveAuthorityTombstoneV1 {
  return { schemaVersion: PVE_AUTHORITY_TOMBSTONE_SCHEMA_VERSION_V1, runId: v.run.runId, campaignId: v.run.campaignId, authorityContentHash: v.run.authorityContentHash, replacementAuthorityContentHash: replacement, revision: v.run.revision, checkpointId: v.run.checkpoint.checkpointId, activeBattleId: v.run.activeBattle?.battleId ?? null, activeBattleStateHash: v.run.activeBattle?.stateHash ?? null, receiptCount: v.run.receipts.length, evidenceHash: evidenceHash(v), reason: reason.trim() || 'authority-transition' }
}
function cas(runId: string, expected: number, current: PveRunAggregateV1 | undefined, next: PveRunAggregateV1) {
  if (!current) throw new PveRunStoreErrorV1('PVE_RUN_NOT_FOUND', runId)
  if (current.run.revision !== expected || next.run.runId !== runId || next.run.revision <= expected) throw new PveRunStoreErrorV1('PVE_RUN_REVISION_CONFLICT', `${runId}:${current.run.revision}`)
}

export class MemoryPveRunStoreV1 implements PveRunStoreV1 {
  private readonly runs = new Map<string, PveRunAggregateV1>()
  private readonly evidence = new Map<string, PveRunAggregateV1>()
  private readonly tombstones = new Map<string, PveAuthorityTombstoneV1>()
  get(v: string) { const found = this.runs.get(id(v)); return found ? clone(found) : undefined }
  list() { return [...this.runs.values()].sort((a, b) => a.run.runId.localeCompare(b.run.runId)).map(clone) }
  create(v: PveRunAggregateV1) { const a = parsePveRunAggregateV1(v); if (this.runs.has(a.run.runId)) throw new PveRunStoreErrorV1('PVE_RUN_ALREADY_EXISTS', a.run.runId); this.runs.set(a.run.runId, clone(a)); return clone(a) }
  compareAndSet(v: string, expected: number, value: PveRunAggregateV1) { const runId = id(v); const next = parsePveRunAggregateV1(value); cas(runId, expected, this.runs.get(runId), next); this.runs.set(runId, clone(next)); return clone(next) }
  reconcileAuthority(v: string, reason: string) {
    const replacement = hash(v); const preservedRunIds: string[] = []; const clearedRunIds: string[] = []; const tombstones: PveAuthorityTombstoneV1[] = []
    for (const a of this.list()) { if (a.run.authorityContentHash === replacement) { preservedRunIds.push(a.run.runId); continue }; const t = tombstone(a, replacement, reason); const key = `${t.runId}.${t.evidenceHash}`; this.evidence.set(key, clone(a)); this.tombstones.set(key, clone(t)); this.runs.delete(a.run.runId); clearedRunIds.push(a.run.runId); tombstones.push(t) }
    return { authorityContentHash: replacement, preservedRunIds, clearedRunIds, tombstones }
  }
  listTombstones() { return [...this.tombstones.values()].map(clone) }
  readArchivedEvidence(t: PveAuthorityTombstoneV1) { const v = this.evidence.get(`${id(t.runId)}.${hash(t.evidenceHash)}`); if (!v) throw new PveRunStoreErrorV1('PVE_AUDIT_EVIDENCE_MISSING', t.evidenceHash); return clone(v) }
}

export class JsonPveRunStoreV1 implements PveRunStoreV1 {
  private readonly runsDir: string
  private readonly evidenceDir: string
  private readonly tombstonesDir: string
  constructor(readonly rootDir: string) { this.runsDir = path.join(rootDir, 'runs'); this.evidenceDir = path.join(rootDir, 'audit', 'evidence'); this.tombstonesDir = path.join(rootDir, 'audit', 'tombstones') }
  private ensure() { for (const dir of [this.runsDir, this.evidenceDir, this.tombstonesDir]) mkdirSync(dir, { recursive: true }) }
  private pathFor(v: string) { return path.join(this.runsDir, `${id(v)}.json`) }
  private atomicCreate(destination: string, contents: string) { mkdirSync(path.dirname(destination), { recursive: true }); const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`; writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx' }); try { linkSync(temporary, destination) } finally { rmSync(temporary, { force: true }) } }
  private immutableWrite(destination: string, contents: string) { if (existsSync(destination)) { if (readFileSync(destination, 'utf8') !== contents) throw new PveRunStoreErrorV1('PVE_AUDIT_COLLISION', destination); return }; this.atomicCreate(destination, contents) }
  private writeTombstone(destination: string, value: PveAuthorityTombstoneV1) {
    if (!existsSync(destination)) { this.atomicCreate(destination, serialize(value)); return value }
    const existing = parseTombstone(readStrictJsonFile(destination, 'PVE_AUDIT_TOMBSTONE_CORRUPT'))
    const sameEvidence = existing.schemaVersion === value.schemaVersion
      && existing.runId === value.runId
      && existing.evidenceHash === value.evidenceHash
      && existing.replacementAuthorityContentHash === value.replacementAuthorityContentHash
    if (!sameEvidence) throw new PveRunStoreErrorV1('PVE_AUDIT_COLLISION', destination)
    return existing
  }
  get(v: string) { const target = this.pathFor(v); if (!existsSync(target)) return undefined; try { return parsePveRunAggregateV1(readStrictJsonFile(target, 'PVE_RUN_STORE_CORRUPT')) } catch (e) { throw e instanceof PveRunStoreErrorV1 ? e : new PveRunStoreErrorV1('PVE_RUN_STORE_CORRUPT', target) } }
  list() { if (!existsSync(this.runsDir)) return []; return readdirSync(this.runsDir).filter(v => v.endsWith('.json')).sort().map(v => this.get(v.slice(0, -5))!) }
  create(v: PveRunAggregateV1) { const a = parsePveRunAggregateV1(v); const target = this.pathFor(a.run.runId); if (existsSync(target)) throw new PveRunStoreErrorV1('PVE_RUN_ALREADY_EXISTS', a.run.runId); this.atomicCreate(target, serialize(a)); return clone(a) }
  compareAndSet(v: string, expected: number, value: PveRunAggregateV1) { const runId = id(v); const next = parsePveRunAggregateV1(value); cas(runId, expected, this.get(runId), next); const target = this.pathFor(runId); const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`; writeFileSync(temporary, serialize(next), { encoding: 'utf8', flag: 'wx' }); try { renameSync(temporary, target) } finally { rmSync(temporary, { force: true }) }; return clone(next) }
  reconcileAuthority(v: string, reason: string) {
    const replacement = hash(v); this.ensure(); const preservedRunIds: string[] = []; const clearedRunIds: string[] = []; const tombstones: PveAuthorityTombstoneV1[] = []
    for (const a of this.list()) { if (a.run.authorityContentHash === replacement) { preservedRunIds.push(a.run.runId); continue }; const t = tombstone(a, replacement, reason); const name = `${t.runId}.${t.evidenceHash}.json`; this.immutableWrite(path.join(this.evidenceDir, name), serialize(a)); const recorded = this.writeTombstone(path.join(this.tombstonesDir, name), t); const current = this.get(a.run.runId); if (!current || evidenceHash(current) !== t.evidenceHash) throw new PveRunStoreErrorV1('PVE_RUN_REVISION_CONFLICT', a.run.runId); rmSync(this.pathFor(a.run.runId)); clearedRunIds.push(a.run.runId); tombstones.push(recorded) }
    return { authorityContentHash: replacement, preservedRunIds, clearedRunIds, tombstones }
  }
  listTombstones() { if (!existsSync(this.tombstonesDir)) return []; return readdirSync(this.tombstonesDir).filter(v => v.endsWith('.json')).sort().map(v => parseTombstone(readStrictJsonFile(path.join(this.tombstonesDir, v), 'PVE_AUDIT_TOMBSTONE_CORRUPT'))) }
  readArchivedEvidence(t: PveAuthorityTombstoneV1) { const target = path.join(this.evidenceDir, `${id(t.runId)}.${hash(t.evidenceHash)}.json`); if (!existsSync(target)) throw new PveRunStoreErrorV1('PVE_AUDIT_EVIDENCE_MISSING', t.evidenceHash); const a = parsePveRunAggregateV1(readStrictJsonFile(target, 'PVE_AUDIT_EVIDENCE_CORRUPT')); if (evidenceHash(a) !== t.evidenceHash) throw new PveRunStoreErrorV1('PVE_AUDIT_EVIDENCE_CORRUPT', t.evidenceHash); return a }
}
