import { describe, expect, it } from 'vitest'

import {
  PveClientFlowCommandV1Schema,
} from '@/lib/pve/flow-command-v1'
import {
  createInitialPveRunV1,
  PveFlowRunnerErrorV1,
  runPveFlowV1,
} from '@/lib/pve/flow-runner'
import type { PveContentSnapshotV1 } from '@/lib/pve/content-snapshot'
import {
  PveCampaignV1Schema,
  PveEncounterV1Schema,
  PveEnemySetupV1Schema,
  PveEventV1Schema,
  PveFlowNodeV1Schema,
  PveRewardV1Schema,
  type PveFlowNodeV1,
  type PveRunV1,
} from '@/lib/pve/contracts'
import { createPveRuntimeRegistryV1 } from '@/lib/pve/runtime-registry'

const AUTHORITY_HASH = 'a'.repeat(64)
const PROFILE_HASH = 'b'.repeat(64)
const BATTLE_STATE_1 = '1'.repeat(64)
const BATTLE_STATE_2 = '2'.repeat(64)
const BATTLE_RESULT = '3'.repeat(64)

interface SnapshotOptions {
  readonly firstRoute?: boolean
  readonly branchLoop?: boolean
  readonly effectThrows?: boolean
}

type WithoutSchema<T> = T extends unknown
  ? Omit<T, 'schemaVersion'>
  : never

function makeSnapshot(
  options: SnapshotOptions = {},
): Readonly<PveContentSnapshotV1> {
  const node = (value: WithoutSchema<PveFlowNodeV1>) =>
    PveFlowNodeV1Schema.parse({
      schemaVersion: 'rvb-pve-node/v1',
      ...value,
    })
  const nodes = new Map<string, PveFlowNodeV1>([
    ['ambush', node({
      nodeId: 'ambush',
      type: 'battle',
      encounterId: 'prototype-encounter-1',
      victoryNodeId: 'spoils',
      defeatNodeId: 'defeat-ending',
      drawNodeId: 'draw-ending',
    })],
    ['battle-gate', node({
      nodeId: 'battle-gate',
      type: 'branch',
      routes: [
        {
          conditionId: 'prototype-first-route',
          nextNodeId: options.branchLoop ? 'battle-gate' : 'ambush',
        },
        {
          conditionId: 'prototype-second-route',
          nextNodeId: 'defeat-ending',
        },
      ],
      fallbackNodeId: 'draw-ending',
    })],
    ['campfire', node({
      nodeId: 'campfire',
      type: 'event',
      eventId: 'prototype-campfire',
      outcomes: [
        { outcomeId: 'prepared', nextNodeId: 'battle-gate' },
        { outcomeId: 'rested', nextNodeId: 'battle-gate' },
      ],
    })],
    ['choose-roster', node({
      nodeId: 'choose-roster',
      type: 'roster',
      rosterId: 'prototype-player-roster',
      nextNodeId: 'intro',
    })],
    ['defeat-ending', node({
      nodeId: 'defeat-ending',
      type: 'end',
      endingId: 'prototype-defeat',
      outcome: 'failed',
    })],
    ['draw-ending', node({
      nodeId: 'draw-ending',
      type: 'end',
      endingId: 'prototype-draw',
      outcome: 'failed',
    })],
    ['intro', node({
      nodeId: 'intro',
      type: 'story',
      storyId: 'prototype-intro',
      nextNodeId: 'campfire',
    })],
    ['safe-room', node({
      nodeId: 'safe-room',
      type: 'checkpoint',
      checkpointId: 'prototype-safe-room',
      nextNodeId: 'victory-ending',
    })],
    ['spoils', node({
      nodeId: 'spoils',
      type: 'reward',
      rewardId: 'prototype-card-choice',
      nextNodeId: 'safe-room',
    })],
    ['victory-ending', node({
      nodeId: 'victory-ending',
      type: 'end',
      endingId: 'prototype-victory',
      outcome: 'completed',
    })],
  ])
  const campaign = PveCampaignV1Schema.parse({
    schemaVersion: 'rvb-pve-campaign/v1',
    campaignId: 'prototype-campaign',
    version: '1.0.0',
    entryNodeId: 'choose-roster',
    nodes: [...nodes.keys()].sort().map(nodeId => ({
      nodeId,
      path: `data/pve/nodes/${nodeId}.json`,
    })),
  })
  const event = PveEventV1Schema.parse({
    schemaVersion: 'rvb-pve-event/v1',
    eventId: 'prototype-campfire',
    narrativeId: 'prototype-campfire-story',
    choices: [
      {
        choiceId: 'rest',
        labelTextId: 'prototype-rest-label',
        effectId: 'prototype-heal-party-small',
        outcomeId: 'rested',
      },
      {
        choiceId: 'prepare',
        labelTextId: 'prototype-prepare-label',
        effectId: 'prototype-prepare-party',
        outcomeId: 'prepared',
      },
    ],
  })
  const reward = PveRewardV1Schema.parse({
    schemaVersion: 'rvb-pve-reward/v1',
    rewardId: 'prototype-card-choice',
    rewardTableId: 'prototype-card-reward-table',
    grantEffectId: 'prototype-grant-card-reward',
  })
  const encounter = PveEncounterV1Schema.parse({
    schemaVersion: 'rvb-pve-encounter/v1',
    encounterId: 'prototype-encounter-1',
    mapId: 'large-hole-arena',
    enemySetupId: 'prototype-bandits',
    objectiveId: 'defeat-all-enemies',
  })
  const enemy = PveEnemySetupV1Schema.parse({
    schemaVersion: 'rvb-pve-enemy-setup/v1',
    enemySetupId: 'prototype-bandits',
    rosterId: 'prototype-enemy-roster',
    aiProfileId: 'prototype-basic-ai',
  })
  const registry = createPveRuntimeRegistryV1({
    maps: ['large-hole-arena'],
    objectives: ['defeat-all-enemies'],
    rosters: [
      {
        rosterId: 'prototype-player-roster',
        pieceIds: ['red-one', 'red-two'],
        initialDeck: ['basic-strike', 'basic-strike'],
      },
      {
        rosterId: 'prototype-enemy-roster',
        pieceIds: ['blue-one', 'blue-two'],
      },
    ],
    aiProfiles: ['prototype-basic-ai'],
    effects: [
      {
        effectId: 'prototype-heal-party-small',
        apply: () => ({ flags: { healed: true } }),
      },
      {
        effectId: 'prototype-prepare-party',
        apply: () => {
          if (options.effectThrows) throw new Error('effect failed')
          return { flags: { prepared: true } }
        },
      },
      {
        effectId: 'prototype-grant-card-reward',
        apply: (run, context) => ({
          deck: [...run.deck, context.subjectId],
        }),
      },
    ],
    rewardTables: [{
      rewardTableId: 'prototype-card-reward-table',
      subjectIds: ['basic-strike', 'basic-guard'],
    }],
    conditions: [
      {
        conditionId: 'prototype-first-route',
        evaluate: () => options.firstRoute !== false,
      },
      {
        conditionId: 'prototype-second-route',
        evaluate: () => true,
      },
    ],
  })

  return Object.freeze({
    authorityContentHash: AUTHORITY_HASH,
    resolvedProfileHash: PROFILE_HASH,
    registry,
    listCampaigns: () => Object.freeze([campaign]),
    getCampaign: (campaignId: string) => {
      if (campaignId !== campaign.campaignId) throw new Error('missing campaign')
      return campaign
    },
    getNode: (campaignId: string, nodeId: string) => {
      if (campaignId !== campaign.campaignId || !nodes.has(nodeId)) {
        throw new Error('missing node')
      }
      return nodes.get(nodeId)!
    },
    getChapter: () => { throw new Error('missing chapter') },
    getEncounter: (encounterId: string) => {
      if (encounterId !== encounter.encounterId) throw new Error('missing encounter')
      return encounter
    },
    getEnemySetup: (enemySetupId: string) => {
      if (enemySetupId !== enemy.enemySetupId) throw new Error('missing enemy')
      return enemy
    },
    getEvent: (eventId: string) => {
      if (eventId !== event.eventId) throw new Error('missing event')
      return event
    },
    getReward: (rewardId: string) => {
      if (rewardId !== reward.rewardId) throw new Error('missing reward')
      return reward
    },
    getRelic: () => { throw new Error('missing relic') },
  })
}

function clientCommand(
  run: Readonly<PveRunV1>,
  commandId: string,
  command: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schemaVersion: 'rvb-pve-command/v1',
    runId: run.runId,
    commandId,
    expectedRevision: run.revision,
    ...command,
  }
}

function reachBattle(snapshot: Readonly<PveContentSnapshotV1>) {
  let result = createInitialPveRunV1(snapshot, {
    runId: 'prototype-run',
    campaignId: 'prototype-campaign',
    rootSeed: 0x1170cafe,
  })
  result = runPveFlowV1(snapshot, result.run, clientCommand(
    result.run,
    'select-roster',
    { type: 'roster-select' },
  ))
  result = runPveFlowV1(snapshot, result.run, clientCommand(
    result.run,
    'continue-intro',
    { type: 'story-continue' },
  ))
  const eventCommand = clientCommand(
    result.run,
    'prepare-at-campfire',
    { type: 'event-choose', choiceId: 'prepare' },
  )
  result = runPveFlowV1(snapshot, result.run, eventCommand)
  return { result, eventCommand }
}

function startBattle(
  snapshot: Readonly<PveContentSnapshotV1>,
  run: Readonly<PveRunV1>,
) {
  return runPveFlowV1(snapshot, run, {
    schemaVersion: 'rvb-pve-command/v1',
    type: 'battle-started',
    runId: run.runId,
    commandId: 'authority-start-battle',
    expectedRevision: run.revision,
    activeBattle: {
      schemaVersion: 'rvb-pve-active-battle/v1',
      authorityContentHash: AUTHORITY_HASH,
      battleId: 'prototype-battle',
      sourceNodeId: 'ambush',
      encounterId: 'prototype-encounter-1',
      stateHash: BATTLE_STATE_1,
    },
  })
}

describe('RED-117 pure PVE flow runner', () => {
  it('creates a canonical run and consumes the complete eight-node flow', () => {
    const snapshot = makeSnapshot()
    const initial = createInitialPveRunV1(snapshot, {
      runId: 'prototype-run',
      campaignId: 'prototype-campaign',
      rootSeed: 0x1170cafe,
    })
    const repeated = createInitialPveRunV1(snapshot, {
      runId: 'prototype-run',
      campaignId: 'prototype-campaign',
      rootSeed: 0x1170cafe,
    })
    expect(initial.run).toEqual(repeated.run)
    expect(initial.run.revision).toBe(0)
    expect(initial.run.checkpoint).toMatchObject({
      checkpointId: 'run-start',
      revision: 0,
      currentNodeId: 'choose-roster',
      receiptCount: 0,
    })
    expect(initial.run.checkpoint.stateHash).not.toBe('0'.repeat(64))
    expect(initial.run.checkpoint.receiptsHash).not.toBe('0'.repeat(64))
    expect(initial.run).not.toHaveProperty('resolvedProfileHash')
    expect(initial.run).not.toHaveProperty('packageHash')

    const atBattle = reachBattle(snapshot).result
    expect(atBattle.node.type).toBe('battle')
    expect(atBattle.run.revision).toBe(4)
    expect(atBattle.run.flags).toEqual({ prepared: true })
    expect(atBattle.run.party).toEqual(['red-one', 'red-two'])
    expect(atBattle.run.deck).toEqual(['basic-strike', 'basic-strike'])
    expect(atBattle.run.receipts).toHaveLength(1)
    expect(atBattle.transition.steps.map(step => step.action)).toEqual([
      'event-choose',
      'branch',
    ])

    const started = startBattle(snapshot, atBattle.run)
    expect(started.run.revision).toBe(5)
    const updated = runPveFlowV1(snapshot, started.run, {
      schemaVersion: 'rvb-pve-command/v1',
      type: 'battle-updated',
      runId: started.run.runId,
      commandId: 'authority-update-battle',
      expectedRevision: started.run.revision,
      activeBattle: {
        ...started.run.activeBattle,
        stateHash: BATTLE_STATE_2,
      },
    })
    expect(updated.run.revision).toBe(6)
    expect(updated.run.activeBattle?.stateHash).toBe(BATTLE_STATE_2)
    expect(updated.transition.receiptDrafts).toEqual([])

    const settled = runPveFlowV1(snapshot, updated.run, {
      schemaVersion: 'rvb-pve-command/v1',
      type: 'battle-settle',
      runId: updated.run.runId,
      commandId: 'authority-settle-battle',
      expectedRevision: updated.run.revision,
      battleId: 'prototype-battle',
      stateHash: BATTLE_STATE_2,
      outcome: 'victory',
      resultHash: BATTLE_RESULT,
    })
    expect(settled.node.type).toBe('reward')
    expect(settled.run.activeBattle).toBeNull()
    expect(settled.transition.receiptDrafts).toEqual([
      expect.objectContaining({ kind: 'battle-settlement' }),
    ])

    const completed = runPveFlowV1(snapshot, settled.run, clientCommand(
      settled.run,
      'claim-basic-guard',
      { type: 'reward-claim', subjectId: 'basic-guard' },
    ))
    expect(completed.node).toEqual({
      nodeId: 'victory-ending',
      type: 'end',
      endingId: 'prototype-victory',
      outcome: 'completed',
    })
    expect(completed.run.revision).toBe(9)
    expect(completed.run.receipts.map(receipt => receipt.kind)).toEqual([
      'effect',
      'battle-settlement',
      'reward',
    ])
    expect(completed.run.checkpoint).toMatchObject({
      checkpointId: 'prototype-safe-room',
      revision: 9,
      currentNodeId: 'victory-ending',
      receiptCount: 3,
    })
    expect(completed.legalCommands).toEqual([])
  })

  it('routes the first matching branch in declaration order', () => {
    const first = reachBattle(makeSnapshot({ firstRoute: true })).result
    expect(first.run.currentNodeId).toBe('ambush')

    const second = reachBattle(makeSnapshot({ firstRoute: false })).result
    expect(second.run.currentNodeId).toBe('defeat-ending')
    expect(second.node).toMatchObject({ type: 'end', outcome: 'failed' })
  })

  it.each([
    ['victory', 'spoils'],
    ['defeat', 'defeat-ending'],
    ['draw', 'draw-ending'],
  ] as const)('maps authority battle %s to its declared node', (outcome, nodeId) => {
    const snapshot = makeSnapshot()
    const atBattle = reachBattle(snapshot).result
    const started = startBattle(snapshot, atBattle.run)
    const settled = runPveFlowV1(snapshot, started.run, {
      schemaVersion: 'rvb-pve-command/v1',
      type: 'battle-settle',
      runId: started.run.runId,
      commandId: `settle-${outcome}`,
      expectedRevision: started.run.revision,
      battleId: 'prototype-battle',
      stateHash: BATTLE_STATE_1,
      outcome,
      resultHash: BATTLE_RESULT,
    })
    expect(settled.run.currentNodeId).toBe(nodeId)
  })

  it('deduplicates receipt commands before stale-revision rejection', () => {
    const snapshot = makeSnapshot()
    const { result, eventCommand } = reachBattle(snapshot)
    const duplicate = runPveFlowV1(snapshot, result.run, eventCommand)

    expect(duplicate.transition.duplicate).toBe(true)
    expect(duplicate.transition.steps).toEqual([])
    expect(duplicate.run).toEqual(result.run)
    expect(duplicate.run.receipts).toHaveLength(1)
  })

  it('bounds automatic chains and never partially commits failed effects', () => {
    const normal = makeSnapshot()
    let atEvent = createInitialPveRunV1(normal, {
      runId: 'failure-run',
      campaignId: 'prototype-campaign',
      rootSeed: 117,
    })
    atEvent = runPveFlowV1(normal, atEvent.run, clientCommand(
      atEvent.run,
      'failure-roster',
      { type: 'roster-select' },
    ))
    atEvent = runPveFlowV1(normal, atEvent.run, clientCommand(
      atEvent.run,
      'failure-story',
      { type: 'story-continue' },
    ))
    const before = structuredClone(atEvent.run)
    const looping = makeSnapshot({ branchLoop: true })

    expect(() => runPveFlowV1(looping, atEvent.run, clientCommand(
      atEvent.run,
      'failure-event',
      { type: 'event-choose', choiceId: 'prepare' },
    ))).toThrowError(expect.objectContaining({
      code: 'PVE_AUTOMATIC_STEP_BUDGET_EXCEEDED',
    }))
    expect(atEvent.run).toEqual(before)
    expect(atEvent.run.receipts).toEqual([])

    const throwing = makeSnapshot({ effectThrows: true })
    expect(() => runPveFlowV1(throwing, atEvent.run, clientCommand(
      atEvent.run,
      'throwing-event',
      { type: 'event-choose', choiceId: 'prepare' },
    ))).toThrowError(expect.objectContaining({
      code: 'PVE_REGISTRY_EFFECT_FAILED',
    }))
    expect(atEvent.run).toEqual(before)
  })

  it('rejects client terminal facts and delegates battle actions to the adapter', () => {
    const invalid = PveClientFlowCommandV1Schema.safeParse({
      schemaVersion: 'rvb-pve-command/v1',
      type: 'battle-action',
      runId: 'prototype-run',
      commandId: 'forge-terminal',
      expectedRevision: 4,
      action: {
        type: 'move',
        payload: { terminalResult: { winnerPlayerId: 'player-red' } },
      },
    })
    expect(invalid.success).toBe(false)

    const snapshot = makeSnapshot()
    const atBattle = reachBattle(snapshot).result
    const before = structuredClone(atBattle.run)
    try {
      runPveFlowV1(snapshot, atBattle.run, clientCommand(
        atBattle.run,
        'formal-battle-action',
        { type: 'battle-action', action: { type: 'endTurn' } },
      ))
      throw new Error('Expected adapter delegation')
    } catch (error) {
      expect(error).toBeInstanceOf(PveFlowRunnerErrorV1)
      expect((error as PveFlowRunnerErrorV1).code).toBe(
        'PVE_BATTLE_ADAPTER_REQUIRED',
      )
    }
    expect(atBattle.run).toEqual(before)
  })

  it('fail-closes battle hash updates that change identity or do not advance', () => {
    const snapshot = makeSnapshot()
    const started = startBattle(snapshot, reachBattle(snapshot).result.run)
    const update = (activeBattle: unknown) => runPveFlowV1(
      snapshot,
      started.run,
      {
        schemaVersion: 'rvb-pve-command/v1',
        type: 'battle-updated',
        runId: started.run.runId,
        commandId: 'bad-battle-update',
        expectedRevision: started.run.revision,
        activeBattle,
      },
    )

    expect(() => update(started.run.activeBattle)).toThrowError(
      expect.objectContaining({ code: 'PVE_ACTIVE_BATTLE_MISMATCH' }),
    )
    expect(() => update({
      ...started.run.activeBattle,
      battleId: 'different-battle',
      stateHash: BATTLE_STATE_2,
    })).toThrowError(expect.objectContaining({
      code: 'PVE_ACTIVE_BATTLE_MISMATCH',
    }))
  })
})
