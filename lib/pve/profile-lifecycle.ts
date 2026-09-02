import path from 'node:path'
import { getUserDataDir } from '@/lib/app-paths'
import { JsonPveRunStoreV1, type PveAuthorityCleanupReportV1, type PveRunStoreV1 } from './run-store'

export interface PveActiveBattleLeaseReportV1 { readonly active: boolean; readonly runIds: readonly string[]; readonly battleIds: readonly string[] }
export function getPveRunStoreRootV1(userDataDir = getUserDataDir()) { return path.join(userDataDir, 'pve-runs') }
export function createRuntimePveRunStoreV1(userDataDir = getUserDataDir()): PveRunStoreV1 { return new JsonPveRunStoreV1(getPveRunStoreRootV1(userDataDir)) }
export function getPveActiveBattleLeaseReportV1(store: PveRunStoreV1 = createRuntimePveRunStoreV1()): PveActiveBattleLeaseReportV1 {
  const active = store.list().filter(a => a.run.activeBattle !== null)
  return { active: active.length > 0, runIds: active.map(a => a.run.runId).sort(), battleIds: active.map(a => a.run.activeBattle!.battleId).sort() }
}
export function reconcilePveAuthorityV1(authorityContentHash: string, reason: string, store: PveRunStoreV1 = createRuntimePveRunStoreV1()): PveAuthorityCleanupReportV1 {
  if (!process.env.RVB_PROFILE_ADMISSION_PAUSED) throw new Error('PVE_PROFILE_ADMISSION_MUST_BE_CLOSED')
  return store.reconcileAuthority(authorityContentHash, reason)
}
