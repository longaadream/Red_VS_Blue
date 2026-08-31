import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { PveRunV1Schema } from '@/lib/pve/contracts/run-v1'
import {
  JsonPveRunStoreV1,
  MemoryPveRunStoreV1,
  PVE_RUN_AGGREGATE_SCHEMA_VERSION_V1,
  type PveRunAggregateV1,
} from '@/lib/pve/run-store'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function aggregate(authorityContentHash = 'a'.repeat(64)): PveRunAggregateV1 {
  const run = PveRunV1Schema.parse(JSON.parse(readFileSync(path.resolve('tests/pve/fixtures/contracts/v1/valid/run.json'), 'utf8')))
  run.authorityContentHash = authorityContentHash
  run.checkpoint.authorityContentHash = authorityContentHash
  return { schemaVersion: PVE_RUN_AGGREGATE_SCHEMA_VERSION_V1, run, battleState: null }
}

describe('RED-117 PVE Run aggregate store', () => {
  test('enforces per-run revision CAS and returns defensive copies', () => {
    const store = new MemoryPveRunStoreV1(); const created = store.create(aggregate())
    created.run.currentNodeId = 'mutated-copy'
    expect(store.get(created.run.runId)?.run.currentNodeId).toBe('spoils')
    const next = aggregate(); next.run.revision = 3; next.run.currentNodeId = 'next-node'
    expect(store.compareAndSet(next.run.runId, 2, next).run.revision).toBe(3)
    expect(() => store.compareAndSet(next.run.runId, 2, next)).toThrow(/PVE_RUN_REVISION_CONFLICT/)
  })

  test('allows one CAS to persist a multi-revision stabilization result', () => {
    const store = new MemoryPveRunStoreV1(); store.create(aggregate())
    const stabilized = aggregate(); stabilized.run.revision = 5
    expect(store.compareAndSet(stabilized.run.runId, 2, stabilized).run.revision).toBe(5)
  })

  test('rejects duplicate keys in a persisted Run without rewriting it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rvb-pve-store-')); temporary.push(root)
    const store = new JsonPveRunStoreV1(root)
    store.create(aggregate())
    const target = path.join(root, 'runs', 'run-prototype-001.json')
    const original = readFileSync(target, 'utf8')
    const duplicate = original.replace(
      '"revision": 2,',
      '"revision": 2,\n    "revision": 3,',
    )
    expect(duplicate).not.toBe(original)
    writeFileSync(target, duplicate)

    expect(() => store.get('run-prototype-001'))
      .toThrow(/PVE_RUN_STORE_CORRUPT/)
    expect(readFileSync(target, 'utf8')).toBe(duplicate)
  })

  test('atomically persists JSON and archives incompatible authority evidence idempotently', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rvb-pve-store-')); temporary.push(root)
    const base = aggregate('a'.repeat(64))
    const activeBattle = {
      schemaVersion: 'rvb-pve-active-battle/v1' as const,
      authorityContentHash: 'a'.repeat(64),
      battleId: 'battle-audit',
      sourceNodeId: 'spoils',
      encounterId: 'prototype-encounter',
      stateHash: '1'.repeat(64),
    }
    const value: PveRunAggregateV1 = {
      ...base,
      run: { ...base.run, activeBattle },
      battleState: {
        type: 'server-state',
        storageSchemaVersion: 'rvb-server-battle-state/v1',
        profileIdentity: {
          schemaVersion: 'rvb-game-profile-identity/v1',
          engineAbi: 'rvb-engine/v1',
          runnerRevision: 'rvb-battle-runner/v1',
          resolvedProfileHash: '2'.repeat(64),
          authorityContentHash: 'a'.repeat(64),
        },
        rootSeed: 7,
        state: { trace: [{ index: 0, kind: 'gameStart' }] },
      },
    }
    const first = new JsonPveRunStoreV1(root); first.create(value)
    expect(new JsonPveRunStoreV1(root).list()).toHaveLength(1)
    const report = first.reconcileAuthority('b'.repeat(64), 'activation-commit')
    expect(report.clearedRunIds).toEqual(['run-prototype-001'])
    expect(first.list()).toEqual([])
    const [audit] = first.listTombstones()
    const evidence = first.readArchivedEvidence(audit)
    expect(evidence.run.receipts).toHaveLength(2)
    expect(evidence.battleState?.state).toEqual({ trace: [{ index: 0, kind: 'gameStart' }] })
    // Simulate a crash after audit publication but before active Run deletion.
    writeFileSync(path.join(root, 'runs', 'run-prototype-001.json'), `${JSON.stringify(evidence, null, 2)}\n`)
    expect(first.reconcileAuthority('b'.repeat(64), 'startup-recovery').clearedRunIds)
      .toEqual(['run-prototype-001'])
    expect(first.listTombstones()[0].reason).toBe('activation-commit')
    expect(first.reconcileAuthority('b'.repeat(64), 'activation-commit').clearedRunIds).toEqual([])
  })

  test('preserves a Run across a Profile update with unchanged authority', () => {
    const store = new MemoryPveRunStoreV1(); store.create(aggregate())
    const report = store.reconcileAuthority('a'.repeat(64), 'activation-commit')
    expect(report.preservedRunIds).toEqual(['run-prototype-001'])
    expect(store.listTombstones()).toEqual([])
  })
})
