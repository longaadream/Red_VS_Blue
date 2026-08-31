import { randomBytes, randomUUID } from 'node:crypto'

import type { ResolvedSnapshotViewV1 } from '@/lib/content-pipeline/core/resolver'
import {
  openRuntimeVerifiedSnapshotV1,
} from '@/lib/content-pipeline/runtime/profile-runtime'
import { hashBattleState, hashStable } from '@/lib/game/battle-runner'
import type { BattleState } from '@/lib/game/turn'
import {
  applyPveBattleActionV1,
  createPveBattleV1,
  hasPveBattleActionV1,
  PVE_ENEMY_ID_V1,
  PVE_PLAYER_ID_V1,
  settlePveBattleV1,
} from './battle-adapter'
import { createPveContentSnapshotV1, type PveContentSnapshotV1 } from './content-snapshot'
import { PveClientFlowCommandV1Schema, type PveClientFlowCommandV1 } from './flow-command-v1'
import {
  createInitialPveRunV1,
  runPveFlowV1,
  stabilizePveRunV1,
  type PveFlowRunnerResultV1,
  type PveFlowTransitionV1,
  type PveLegalCommandV1,
  type PvePublicNodeViewV1,
} from './flow-runner'
import { createRuntimePveRunStoreV1 } from './profile-lifecycle'
import { createPrototypePveRegistryV1 } from './prototype-registry'
import {
  PVE_RUN_AGGREGATE_SCHEMA_VERSION_V1,
  type PveRunAggregateV1,
  type PveRunStoreV1,
} from './run-store'
import type { PveRuntimeRegistryV1 } from './runtime-registry'

export type PveServiceErrorCodeV1 =
  | 'PVE_REQUEST_INVALID'
  | 'PVE_RUN_NOT_FOUND'
  | 'PVE_RUN_AUTHORITY_MISMATCH'
  | 'PVE_RUN_CORRUPT'
  | 'PVE_COMMAND_REVISION_CONFLICT'

export class PveServiceErrorV1 extends Error {
  constructor(
    readonly code: PveServiceErrorCodeV1,
    message: string,
    readonly status: number,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'PveServiceErrorV1'
  }
}

export interface PveCatalogViewV1 {
  readonly authorityContentHash: string
  readonly resolvedProfileHash: string
  readonly campaigns: readonly Readonly<{
    campaignId: string
    version: string
    entryNodeId: string
  }>[]
}

export interface PvePublicLegalCommandV1 {
  readonly type: PveLegalCommandV1['type']
  readonly label: string
  readonly primary?: boolean
  readonly parameters?: Readonly<Record<string, unknown>>
}

export interface PvePublicRunViewV1 {
  readonly runId: string
  readonly campaignId: string
  readonly authorityContentHash: string
  readonly revision: number
  readonly node: PvePublicNodeViewV1
  readonly battle: null | Readonly<{ battleId: string; stateHash: string }>
  readonly legalCommands: readonly PvePublicLegalCommandV1[]
}

export interface PveServiceResultV1 {
  readonly view: PvePublicRunViewV1
  readonly transition: Readonly<PveFlowTransitionV1>
  readonly duplicate: boolean
  readonly battleAudit?: Readonly<{
    stateHash: string
    actionHash?: string
    terminalOutcome?: 'victory' | 'defeat' | 'draw'
    terminalResultHash?: string
  }>
}

export interface PveServiceDependenciesV1 {
  readonly store: PveRunStoreV1
  readonly openVerifiedSnapshot: () => ResolvedSnapshotViewV1
  readonly createRegistry: () => Readonly<PveRuntimeRegistryV1>
  readonly createRunId: () => string
  readonly createRootSeed: () => number
}

interface PveServiceContextV1 {
  readonly view: ResolvedSnapshotViewV1
  readonly snapshot: Readonly<PveContentSnapshotV1>
}

const runLocks = new Map<string, Promise<void>>()

export class PveServiceV1 {
  constructor(private readonly dependencies: PveServiceDependenciesV1) {}

  catalog(): PveCatalogViewV1 {
    const context = this.context()
    return Object.freeze({
      authorityContentHash: context.snapshot.authorityContentHash,
      resolvedProfileHash: context.snapshot.resolvedProfileHash,
      campaigns: Object.freeze(context.snapshot.listCampaigns().map(campaign => Object.freeze({
        campaignId: campaign.campaignId,
        version: campaign.version,
        entryNodeId: campaign.entryNodeId,
      }))),
    })
  }

  createRun(campaignId: string): PveServiceResultV1 {
    const context = this.context()
    context.snapshot.getCampaign(campaignId)
    const initial = createInitialPveRunV1(context.snapshot, {
      runId: this.dependencies.createRunId(),
      campaignId,
      rootSeed: this.dependencies.createRootSeed(),
    })
    const aggregate: PveRunAggregateV1 = {
      schemaVersion: PVE_RUN_AGGREGATE_SCHEMA_VERSION_V1,
      run: initial.run,
      battleState: null,
    }
    this.dependencies.store.create(aggregate)
    return this.result(initial, false)
  }

  getRun(runId: string): PveServiceResultV1 {
    const context = this.context()
    const aggregate = this.requireAggregate(runId, context)
    const flow = stabilizePveRunV1(context.snapshot, aggregate.run)
    return this.result(flow, false)
  }

  async execute(
    runId: string,
    commandValue: unknown,
  ): Promise<PveServiceResultV1> {
    return withRunLock(runId, async () => {
      const parsed = PveClientFlowCommandV1Schema.safeParse(commandValue)
      if (!parsed.success || parsed.data.runId !== runId) {
        throw new PveServiceErrorV1(
          'PVE_REQUEST_INVALID',
          'PVE command failed its strict client schema or route Run ID',
          400,
        )
      }
      const command = parsed.data
      const context = this.context()
      const aggregate = this.requireAggregate(runId, context)

      if (aggregate.run.receipts.some(receipt => receipt.commandId === command.commandId)) {
        const duplicate = runPveFlowV1(context.snapshot, aggregate.run, command)
        return this.result(duplicate, true)
      }
      if (command.type === 'battle-start') {
        return this.startBattle(context, aggregate, command)
      }
      if (command.type === 'battle-action') {
        return this.runBattleAction(context, aggregate, command)
      }

      const next = runPveFlowV1(context.snapshot, aggregate.run, command)
      if (next.transition.duplicate) return this.result(next, true)
      const saved = this.dependencies.store.compareAndSet(
        runId,
        aggregate.run.revision,
        {
          schemaVersion: PVE_RUN_AGGREGATE_SCHEMA_VERSION_V1,
          run: next.run,
          battleState: aggregate.battleState,
        },
      )
      return this.result(stabilizePveRunV1(context.snapshot, saved.run), false, next.transition)
    })
  }

  private context(): PveServiceContextV1 {
    const view = this.dependencies.openVerifiedSnapshot()
    const snapshot = createPveContentSnapshotV1(
      view,
      this.dependencies.createRegistry(),
    )
    return { view, snapshot }
  }

  private requireAggregate(
    runId: string,
    context: PveServiceContextV1,
  ): PveRunAggregateV1 {
    const aggregate = this.dependencies.store.get(runId)
    if (!aggregate) {
      throw new PveServiceErrorV1(
        'PVE_RUN_NOT_FOUND',
        `PVE Run ${runId} was not found`,
        404,
      )
    }
    if (aggregate.run.authorityContentHash !== context.snapshot.authorityContentHash) {
      throw new PveServiceErrorV1(
        'PVE_RUN_AUTHORITY_MISMATCH',
        'PVE Run is unavailable under the active authority content',
        409,
        {
          runAuthorityContentHash: aggregate.run.authorityContentHash,
          activeAuthorityContentHash: context.snapshot.authorityContentHash,
        },
      )
    }
    if (aggregate.run.activeBattle !== null && aggregate.battleState === null) {
      throw new PveServiceErrorV1(
        'PVE_RUN_CORRUPT',
        'PVE Run active battle has no formal BattleState',
        409,
      )
    }
    if (
      aggregate.run.activeBattle !== null
      && aggregate.battleState !== null
      && aggregate.battleState.profileIdentity.authorityContentHash
        !== aggregate.run.authorityContentHash
    ) {
      throw new PveServiceErrorV1(
        'PVE_RUN_CORRUPT',
        'PVE Run and formal BattleState authority content differ',
        409,
      )
    }
    if (
      aggregate.run.activeBattle !== null
      && aggregate.battleState !== null
    ) {
      let actualStateHash: string
      try {
        actualStateHash = hashBattleState(
          aggregate.battleState.state as BattleState,
        )
      } catch {
        throw new PveServiceErrorV1(
          'PVE_RUN_CORRUPT',
          'PVE Run formal BattleState cannot be hashed',
          409,
        )
      }
      if (actualStateHash !== aggregate.run.activeBattle.stateHash) {
        throw new PveServiceErrorV1(
          'PVE_RUN_CORRUPT',
          'PVE Run active battle stateHash does not match formal BattleState',
          409,
          {
            expected: aggregate.run.activeBattle.stateHash,
            actual: actualStateHash,
          },
        )
      }
    }
    return aggregate
  }

  private async startBattle(
    context: PveServiceContextV1,
    aggregate: PveRunAggregateV1,
    command: Extract<PveClientFlowCommandV1, { type: 'battle-start' }>,
  ): Promise<PveServiceResultV1> {
    if (aggregate.run.activeBattle !== null && aggregate.battleState !== null) {
      return this.result(stabilizePveRunV1(context.snapshot, aggregate.run), true)
    }
    assertExpectedRevision(aggregate, command.expectedRevision)
    const node = context.snapshot.getNode(
      aggregate.run.campaignId,
      aggregate.run.currentNodeId,
    )
    if (node.type !== 'battle') {
      return this.result(runPveFlowV1(context.snapshot, aggregate.run, command), false)
    }
    const encounter = context.snapshot.getEncounter(node.encounterId)
    const enemy = context.snapshot.getEnemySetup(encounter.enemySetupId)
    const enemyRoster = context.snapshot.registry.requireRoster(enemy.rosterId)
    const playerRoster = context.snapshot.registry.requireRoster('prototype-player-roster')
    if (
      aggregate.run.party.length !== playerRoster.pieceIds.length
      || aggregate.run.party.some((id, index) => id !== playerRoster.pieceIds[index])
    ) {
      throw new PveServiceErrorV1(
        'PVE_RUN_CORRUPT',
        'PVE Run party no longer matches the registered active Profile roster',
        409,
      )
    }
    const created = await createPveBattleV1({
      runId: aggregate.run.runId,
      sourceNodeId: node.nodeId,
      encounterId: encounter.encounterId,
      mapId: encounter.mapId,
      rootSeed: aggregate.run.rootSeed,
      authorityContentHash: aggregate.run.authorityContentHash,
      profileReference: context.view.profile,
      playerPieceIds: playerRoster.pieceIds,
      enemyPieceIds: enemyRoster.pieceIds,
    })
    const next = runPveFlowV1(context.snapshot, aggregate.run, {
      schemaVersion: 'rvb-pve-command/v1',
      type: 'battle-started',
      runId: aggregate.run.runId,
      commandId: command.commandId,
      expectedRevision: aggregate.run.revision,
      activeBattle: created.reference,
    })
    const saved = this.dependencies.store.compareAndSet(
      aggregate.run.runId,
      aggregate.run.revision,
      {
        schemaVersion: PVE_RUN_AGGREGATE_SCHEMA_VERSION_V1,
        run: next.run,
        battleState: created.storage,
      },
    )
    return this.result(
      stabilizePveRunV1(context.snapshot, saved.run),
      false,
      next.transition,
      { stateHash: created.reference.stateHash },
    )
  }

  private runBattleAction(
    context: PveServiceContextV1,
    aggregate: PveRunAggregateV1,
    command: Extract<PveClientFlowCommandV1, { type: 'battle-action' }>,
  ): PveServiceResultV1 {
    if (aggregate.run.activeBattle === null || aggregate.battleState === null) {
      return this.result(runPveFlowV1(context.snapshot, aggregate.run, command), false)
    }
    if (command.expectedRevision !== aggregate.run.revision) {
      if (hasPveBattleActionV1(aggregate.battleState, command.commandId)) {
        return this.result(stabilizePveRunV1(context.snapshot, aggregate.run), true)
      }
      assertExpectedRevision(aggregate, command.expectedRevision)
    }

    const action = {
      ...(command.action as Record<string, unknown>),
      clientActionId: command.commandId,
    }
    const applied = applyPveBattleActionV1(aggregate.battleState, action)
    if (applied.duplicate) {
      return this.result(stabilizePveRunV1(context.snapshot, aggregate.run), true)
    }
    const activeBattle = {
      ...aggregate.run.activeBattle,
      stateHash: applied.stateHash,
    }
    const updated = runPveFlowV1(context.snapshot, aggregate.run, {
      schemaVersion: 'rvb-pve-command/v1',
      type: 'battle-updated',
      runId: aggregate.run.runId,
      commandId: command.commandId,
      expectedRevision: aggregate.run.revision,
      activeBattle,
    })

    const formalState = applied.storage.state as BattleState
    let finalFlow = updated
    let terminalOutcome: 'victory' | 'defeat' | 'draw' | undefined
    let terminalResultHash: string | undefined
    if (formalState.terminalResult?.status === 'finished') {
      const settled = settlePveBattleV1(applied.storage)
      terminalOutcome = settled.outcome
      terminalResultHash = hashStable({
        stateHash: settled.stateHash,
        outcome: settled.outcome,
        terminalResult: settled.terminalResult,
      })
      finalFlow = runPveFlowV1(context.snapshot, updated.run, {
        schemaVersion: 'rvb-pve-command/v1',
        type: 'battle-settle',
        runId: aggregate.run.runId,
        commandId: command.commandId,
        expectedRevision: updated.run.revision,
        battleId: activeBattle.battleId,
        stateHash: applied.stateHash,
        outcome: settled.outcome,
        resultHash: terminalResultHash,
      })
    }

    const saved = this.dependencies.store.compareAndSet(
      aggregate.run.runId,
      aggregate.run.revision,
      {
        schemaVersion: PVE_RUN_AGGREGATE_SCHEMA_VERSION_V1,
        run: finalFlow.run,
        // Keep the terminal envelope as immutable trace evidence for this
        // one-battle Prototype; active-battle leases read Run.activeBattle.
        battleState: applied.storage,
      },
    )
    return this.result(
      stabilizePveRunV1(context.snapshot, saved.run),
      false,
      finalFlow.transition,
      {
        stateHash: applied.stateHash,
        actionHash: applied.actionHash,
        ...(terminalOutcome ? { terminalOutcome } : {}),
        ...(terminalResultHash ? { terminalResultHash } : {}),
      },
    )
  }

  private result(
    flow: Readonly<PveFlowRunnerResultV1>,
    duplicate: boolean,
    transition: Readonly<PveFlowTransitionV1> = flow.transition,
    battleAudit?: PveServiceResultV1['battleAudit'],
  ): PveServiceResultV1 {
    return Object.freeze({
      view: publicRunView(flow),
      transition,
      duplicate,
      ...(battleAudit ? { battleAudit } : {}),
    })
  }
}

let defaultService: PveServiceV1 | undefined

export function getPveServiceV1(): PveServiceV1 {
  defaultService ??= new PveServiceV1({
    store: createRuntimePveRunStoreV1(),
    openVerifiedSnapshot: openRuntimeVerifiedSnapshotV1,
    createRegistry: createPrototypePveRegistryV1,
    createRunId: () => `pve-run-${randomUUID()}`,
    createRootSeed: () => randomBytes(4).readUInt32BE(0),
  })
  return defaultService
}

function publicRunView(
  flow: Readonly<PveFlowRunnerResultV1>,
): PvePublicRunViewV1 {
  const activeBattle = flow.node.type === 'battle'
    ? flow.node.activeBattle
    : null
  return Object.freeze({
    runId: flow.run.runId,
    campaignId: flow.run.campaignId,
    authorityContentHash: flow.run.authorityContentHash,
    revision: flow.run.revision,
    node: flow.node,
    battle: activeBattle,
    legalCommands: Object.freeze(publicLegalCommands(flow.legalCommands)),
  })
}

function publicLegalCommands(
  commands: readonly PveLegalCommandV1[],
): PvePublicLegalCommandV1[] {
  return commands.flatMap<PvePublicLegalCommandV1>(command => {
    switch (command.type) {
      case 'roster-select':
        return [{ type: command.type, label: '确认 8×8 登记阵容', primary: true }]
      case 'story-continue':
        return [{ type: command.type, label: '继续', primary: true }]
      case 'event-choose':
        return [{
          type: command.type,
          label: command.labelTextId,
          parameters: { choiceId: command.choiceId },
        }]
      case 'reward-claim':
        return [{
          type: command.type,
          label: `选择奖励：${command.subjectId}`,
          parameters: { subjectId: command.subjectId },
        }]
      case 'battle-start':
        return [{ type: command.type, label: '开始权威战斗', primary: true }]
      case 'battle-action':
        return [
          {
            type: command.type,
            label: 'Prototype：敌方投降（胜利）',
            primary: true,
            parameters: {
              action: {
                type: 'surrender',
                playerId: PVE_ENEMY_ID_V1,
                reason: 'voluntary',
              },
            },
          },
          {
            type: command.type,
            label: 'Prototype：我方投降（失败）',
            parameters: {
              action: {
                type: 'surrender',
                playerId: PVE_PLAYER_ID_V1,
                reason: 'voluntary',
              },
            },
          },
        ]
    }
  })
}

function assertExpectedRevision(
  aggregate: PveRunAggregateV1,
  expectedRevision: number,
): void {
  if (aggregate.run.revision !== expectedRevision) {
    throw new PveServiceErrorV1(
      'PVE_COMMAND_REVISION_CONFLICT',
      'PVE command expectedRevision is stale',
      409,
      { expected: aggregate.run.revision, actual: expectedRevision },
    )
  }
}

async function withRunLock<T>(
  runId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = runLocks.get(runId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  const queued = predecessor.then(() => current)
  runLocks.set(runId, queued)
  await predecessor
  try {
    return await operation()
  } finally {
    release()
    if (runLocks.get(runId) === queued) runLocks.delete(runId)
  }
}
