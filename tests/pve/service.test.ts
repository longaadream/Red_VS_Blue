import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { ProfileStoreErrorV1 } from '@/lib/content-pipeline/runtime/profile-store'
import { openRuntimeVerifiedSnapshotV1 } from '@/lib/content-pipeline/runtime/profile-runtime'
import type { BattleState } from '@/lib/game/turn'
import { hashPveRunV1 } from '@/lib/pve/flow-runner'
import { createPrototypePveRegistryV1 } from '@/lib/pve/prototype-registry'
import { JsonPveRunStoreV1, MemoryPveRunStoreV1 } from '@/lib/pve/run-store'
import {
  PveServiceV1,
  type PvePublicRunViewV1,
  type PveServiceResultV1,
} from '@/lib/pve/service'

function harness() {
  const store = new MemoryPveRunStoreV1()
  let ordinal = 0
  const service = new PveServiceV1({
    store,
    openVerifiedSnapshot: openRuntimeVerifiedSnapshotV1,
    createRegistry: createPrototypePveRegistryV1,
    createRunId: () => `test-run-${++ordinal}`,
    createRootSeed: () => 0x1170cafe,
  })
  return { service, store }
}

function command(
  view: PvePublicRunViewV1,
  commandId: string,
  type: string,
  parameters: Record<string, unknown> = {},
) {
  return {
    ...parameters,
    schemaVersion: 'rvb-pve-command/v1',
    runId: view.runId,
    commandId,
    expectedRevision: view.revision,
    type,
  }
}

async function advance(
  service: PveServiceV1,
  current: PveServiceResultV1,
  commandId: string,
  type: string,
  parameters: Record<string, unknown> = {},
) {
  return service.execute(
    current.view.runId,
    command(current.view, commandId, type, parameters),
  )
}

describe('RED-117 PVE service integration', () => {
  it('runs the fixed-seed Prototype end to end through formal battle settlement', async () => {
    const { service, store } = harness()
    const activeSnapshot = openRuntimeVerifiedSnapshotV1()
    const created = service.createRun('prototype-campaign')

    expect(created.view).toMatchObject({
      campaignId: 'prototype-campaign',
      revision: 0,
      node: { nodeId: 'choose-roster', type: 'roster' },
    })
    expect(store.get(created.view.runId)?.run).not.toHaveProperty('resolvedProfileHash')
    expect(store.get(created.view.runId)?.run).not.toHaveProperty('campaignPackageHash')

    const roster = await advance(service, created, 'cmd-roster', 'roster-select')
    const story = await advance(service, roster, 'cmd-story', 'story-continue')
    const event = await advance(service, story, 'cmd-event', 'event-choose', {
      choiceId: 'rest',
    })
    const started = await advance(service, event, 'cmd-start', 'battle-start')

    expect(started.view).toMatchObject({
      revision: 4,
      node: { nodeId: 'ambush', type: 'battle' },
      battle: { battleId: expect.any(String), stateHash: expect.any(String) },
    })
    expect(
      Object.keys(
        ((store.get(created.view.runId)?.battleState?.state as {
          deployment?: { initialPositions?: Record<string, unknown> }
        }).deployment?.initialPositions) ?? {},
      ),
    ).toHaveLength(16)

    const settled = await advance(service, started, 'cmd-battle', 'battle-action', {
      action: {
        type: 'surrender',
        playerId: 'player-blue',
        reason: 'voluntary',
      },
    })
    expect(settled).toMatchObject({
      duplicate: false,
      view: { revision: 6, node: { nodeId: 'spoils', type: 'reward' } },
      battleAudit: {
        stateHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        actionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        terminalOutcome: 'victory',
        terminalResultHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    })

    const finished = await advance(service, settled, 'cmd-reward', 'reward-claim', {
      subjectId: 'holy-heal',
    })
    expect(finished.view).toMatchObject({
      revision: 8,
      node: {
        nodeId: 'victory-ending',
        type: 'end',
        outcome: 'completed',
      },
    })
    const stored = store.get(created.view.runId)!
    expect(stored.run.deck).toEqual(['holy-heal'])
    expect(stored.run.checkpoint).toMatchObject({
      checkpointId: 'prototype-safe-room',
      revision: 8,
      currentNodeId: 'victory-ending',
      receiptCount: 3,
    })
    expect(stored.run.receipts.map(receipt => receipt.kind)).toEqual([
      'effect',
      'battle-settlement',
      'reward',
    ])
    expect(stored.battleState).not.toBeNull()
    const evidence = {
      resolvedProfileHash: activeSnapshot.profile.resolvedProfileHash,
      authorityContentHash: stored.run.authorityContentHash,
      battleStateHash: settled.battleAudit!.stateHash,
      terminalResult: (stored.battleState!.state as BattleState).terminalResult,
      runTransition: finished.transition,
      finalRunHash: hashPveRunV1(stored.run),
    }
    expect(evidence).toMatchObject({
      resolvedProfileHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      authorityContentHash: activeSnapshot.profile.authorityContentHash,
      battleStateHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      terminalResult: {
        status: 'finished',
        winnerPlayerId: 'player-red',
      },
      runTransition: {
        schemaVersion: 'rvb-pve-transition/v1',
        transitionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      finalRunHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
  })

  it('returns exactly-once results for concurrent effect and terminal retries', async () => {
    const { service, store } = harness()
    let current = service.createRun('prototype-campaign')
    current = await advance(service, current, 'once-roster', 'roster-select')
    current = await advance(service, current, 'once-story', 'story-continue')
    const eventCommand = command(current.view, 'once-event', 'event-choose', {
      choiceId: 'prepare',
    })
    const [first, retry] = await Promise.all([
      service.execute(current.view.runId, eventCommand),
      service.execute(current.view.runId, eventCommand),
    ])

    expect([first.duplicate, retry.duplicate].sort()).toEqual([false, true])
    expect(store.get(current.view.runId)?.run.receipts)
      .toHaveLength(1)

    const started = await advance(service, first, 'once-start', 'battle-start')
    const battleCommand = command(started.view, 'once-terminal', 'battle-action', {
      action: {
        type: 'surrender',
        playerId: 'player-blue',
        reason: 'voluntary',
      },
    })
    const terminal = await service.execute(started.view.runId, battleCommand)
    const terminalRetry = await service.execute(started.view.runId, battleCommand)

    expect(terminal.duplicate).toBe(false)
    expect(terminalRetry.duplicate).toBe(true)
    expect(store.get(started.view.runId)?.run.receipts
      .filter(receipt => receipt.kind === 'battle-settlement')).toHaveLength(1)
  })

  it('reopens a persisted checkpoint and retries reward exactly once after restart', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rvb-red117-restart-'))
    try {
      const createService = (store: JsonPveRunStoreV1) => new PveServiceV1({
        store,
        openVerifiedSnapshot: openRuntimeVerifiedSnapshotV1,
        createRegistry: createPrototypePveRegistryV1,
        createRunId: () => 'restart-run',
        createRootSeed: () => 0x1170cafe,
      })
      const initialStore = new JsonPveRunStoreV1(root)
      const initialService = createService(initialStore)
      let current = initialService.createRun('prototype-campaign')
      current = await advance(initialService, current, 'restart-roster', 'roster-select')
      current = await advance(initialService, current, 'restart-story', 'story-continue')
      current = await advance(initialService, current, 'restart-event', 'event-choose', {
        choiceId: 'rest',
      })
      current = await advance(initialService, current, 'restart-battle-start', 'battle-start')
      current = await advance(initialService, current, 'restart-battle-settle', 'battle-action', {
        action: {
          type: 'surrender',
          playerId: 'player-blue',
          reason: 'voluntary',
        },
      })
      const rewardCommand = command(current.view, 'restart-reward', 'reward-claim', {
        subjectId: 'holy-heal',
      })
      const applied = await initialService.execute(current.view.runId, rewardCommand)
      const persisted = initialStore.get(current.view.runId)!

      expect(applied.duplicate).toBe(false)
      expect(persisted.run.checkpoint).toMatchObject({
        checkpointId: 'prototype-safe-room',
        currentNodeId: 'victory-ending',
        receiptCount: 3,
      })

      const reopenedStore = new JsonPveRunStoreV1(root)
      const restartedService = createService(reopenedStore)
      const recovered = restartedService.getRun(current.view.runId)
      const retry = await restartedService.execute(current.view.runId, rewardCommand)
      const afterRetry = reopenedStore.get(current.view.runId)!

      expect(recovered.view.revision).toBe(persisted.run.revision)
      expect(retry.duplicate).toBe(true)
      expect(afterRetry.run.revision).toBe(persisted.run.revision)
      expect(afterRetry.run.deck.filter(cardId => cardId === 'holy-heal')).toHaveLength(1)
      expect(afterRetry.run.receipts.filter(receipt => (
        receipt.commandId === 'restart-reward' && receipt.kind === 'reward'
      ))).toHaveLength(1)
      expect(afterRetry.run.checkpoint).toEqual(persisted.run.checkpoint)
      expect(afterRetry.run.receipts.slice(0, afterRetry.run.checkpoint.receiptCount))
        .toEqual(persisted.run.receipts)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('deduplicates a persisted non-terminal formal battle action', async () => {
    const { service, store } = harness()
    let current = service.createRun('prototype-campaign')
    current = await advance(service, current, 'live-roster', 'roster-select')
    current = await advance(service, current, 'live-story', 'story-continue')
    current = await advance(service, current, 'live-event', 'event-choose', {
      choiceId: 'rest',
    })
    const started = await advance(service, current, 'live-start', 'battle-start')
    const battleCommand = command(started.view, 'live-end-turn', 'battle-action', {
      action: { type: 'endTurn', playerId: 'player-red' },
    })

    const applied = await service.execute(started.view.runId, battleCommand)
    const persistedRevision = store.get(started.view.runId)!.run.revision
    const retry = await service.execute(started.view.runId, battleCommand)

    expect(applied.duplicate).toBe(false)
    expect(applied.view.node).toMatchObject({ type: 'battle' })
    expect(retry.duplicate).toBe(true)
    expect(store.get(started.view.runId)!.run.revision).toBe(persistedRevision)
  })

  it('rejects stale new commands and all client-authored terminal facts atomically', async () => {
    const { service, store } = harness()
    let current = service.createRun('prototype-campaign')
    current = await advance(service, current, 'guard-roster', 'roster-select')
    current = await advance(service, current, 'guard-story', 'story-continue')
    const revisionBefore = current.view.revision

    await expect(service.execute(current.view.runId, {
      schemaVersion: 'rvb-pve-command/v1',
      runId: current.view.runId,
      commandId: 'forged-result',
      expectedRevision: revisionBefore,
      type: 'battle-action',
      action: {
        type: 'gameOver',
        winner: 'player-red',
        terminalResult: { status: 'finished' },
      },
    })).rejects.toMatchObject({ code: 'PVE_REQUEST_INVALID' })

    const accepted = await advance(service, current, 'fresh-event', 'event-choose', {
      choiceId: 'rest',
    })
    await expect(service.execute(current.view.runId, command(
      current.view,
      'stale-new-command',
      'event-choose',
      { choiceId: 'prepare' },
    ))).rejects.toMatchObject({ code: 'PVE_COMMAND_REVISION_CONFLICT' })
    expect(store.get(current.view.runId)?.run.revision).toBe(accepted.view.revision)
  })

  it('rejects an illegal formal battle action without mutating the aggregate', async () => {
    const { service, store } = harness()
    let current = service.createRun('prototype-campaign')
    current = await advance(service, current, 'illegal-roster', 'roster-select')
    current = await advance(service, current, 'illegal-story', 'story-continue')
    current = await advance(service, current, 'illegal-event', 'event-choose', {
      choiceId: 'rest',
    })
    const started = await advance(service, current, 'illegal-start', 'battle-start')
    const before = store.get(started.view.runId)

    await expect(advance(
      service,
      started,
      'illegal-action',
      'battle-action',
      { action: { type: 'endTurn', playerId: 'not-a-player' } },
    )).rejects.toMatchObject({
      code: 'PVE_BATTLE_ACTION_INVALID',
      status: 400,
    })
    expect(store.get(started.view.runId)).toEqual(before)
  })

  it('fails closed when the active verified Snapshot authority changes', () => {
    const base = openRuntimeVerifiedSnapshotV1()
    let active = base
    const store = new MemoryPveRunStoreV1()
    const service = new PveServiceV1({
      store,
      openVerifiedSnapshot: () => active,
      createRegistry: createPrototypePveRegistryV1,
      createRunId: () => 'authority-run',
      createRootSeed: () => 1,
    })
    const created = service.createRun('prototype-campaign')
    active = {
      ...base,
      profile: {
        ...base.profile,
        authorityContentHash: 'f'.repeat(64),
      },
    }

    expect(() => service.getRun(created.view.runId)).toThrowError(
      expect.objectContaining({ code: 'PVE_RUN_AUTHORITY_MISMATCH' }),
    )
  })

  it('opens the verified Snapshot before create, read, or command can mutate a Run', async () => {
    const store = new MemoryPveRunStoreV1()
    const healthy = new PveServiceV1({
      store,
      openVerifiedSnapshot: openRuntimeVerifiedSnapshotV1,
      createRegistry: createPrototypePveRegistryV1,
      createRunId: () => 'snapshot-guard-run',
      createRootSeed: () => 1,
    })
    const created = healthy.createRun('prototype-campaign')
    const before = store.list()
    const openVerifiedSnapshot = vi.fn(() => {
      throw new ProfileStoreErrorV1('PROFILE_HASH_MISMATCH', 'active Snapshot')
    })
    const unavailable = new PveServiceV1({
      store,
      openVerifiedSnapshot,
      createRegistry: createPrototypePveRegistryV1,
      createRunId: () => 'must-not-be-created',
      createRootSeed: () => 2,
    })

    expect(() => unavailable.createRun('prototype-campaign')).toThrowError(
      expect.objectContaining({ code: 'PROFILE_HASH_MISMATCH' }),
    )
    expect(() => unavailable.getRun(created.view.runId)).toThrowError(
      expect.objectContaining({ code: 'PROFILE_HASH_MISMATCH' }),
    )
    await expect(unavailable.execute(
      created.view.runId,
      command(created.view, 'snapshot-guard-command', 'roster-select'),
    )).rejects.toMatchObject({ code: 'PROFILE_HASH_MISMATCH' })
    expect(openVerifiedSnapshot).toHaveBeenCalledTimes(3)
    expect(store.list()).toEqual(before)
  })

  it('fails closed when activeBattle stateHash diverges from formal BattleState', async () => {
    const { service, store } = harness()
    let current = service.createRun('prototype-campaign')
    current = await advance(service, current, 'hash-roster', 'roster-select')
    current = await advance(service, current, 'hash-story', 'story-continue')
    current = await advance(service, current, 'hash-event', 'event-choose', {
      choiceId: 'rest',
    })
    const started = await advance(service, current, 'hash-start', 'battle-start')
    const corrupt = structuredClone(store.get(started.view.runId)!)
    corrupt.run.activeBattle!.stateHash = 'f'.repeat(64)
    const corruptStore = new MemoryPveRunStoreV1()
    corruptStore.create(corrupt)
    const reader = new PveServiceV1({
      store: corruptStore,
      openVerifiedSnapshot: openRuntimeVerifiedSnapshotV1,
      createRegistry: createPrototypePveRegistryV1,
      createRunId: () => 'unused-run',
      createRootSeed: () => 1,
    })

    expect(() => reader.getRun(started.view.runId)).toThrowError(
      expect.objectContaining({ code: 'PVE_RUN_CORRUPT' }),
    )
  })

  it.each(['receiptsHash', 'stateHash'] as const)(
    'rejects a corrupt checkpoint %s before effect, revision, or receipt mutation',
    async field => {
      const { service, store } = harness()
      const marker = field === 'receiptsHash' ? 'receipts-hash' : 'state-hash'
      let current = service.createRun('prototype-campaign')
      current = await advance(service, current, `${marker}-roster`, 'roster-select')
      current = await advance(service, current, `${marker}-story`, 'story-continue')
      const corrupt = structuredClone(store.get(current.view.runId)!)
      corrupt.run.checkpoint[field] = 'f'.repeat(64)
      const corruptStore = new MemoryPveRunStoreV1()
      corruptStore.create(corrupt)
      const reader = new PveServiceV1({
        store: corruptStore,
        openVerifiedSnapshot: openRuntimeVerifiedSnapshotV1,
        createRegistry: createPrototypePveRegistryV1,
        createRunId: () => 'unused-run',
        createRootSeed: () => 1,
      })
      const before = corruptStore.get(current.view.runId)

      await expect(reader.execute(current.view.runId, command(
        current.view,
        `${marker}-effect`,
        'event-choose',
        { choiceId: 'rest' },
      ))).rejects.toMatchObject({ code: 'PVE_RUN_INVALID' })
      expect(corruptStore.get(current.view.runId)).toEqual(before)
    },
  )
})
