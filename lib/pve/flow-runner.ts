import { canonicalJsonBytesV1 } from '@/lib/content-pipeline/core/canonical-json'
import { sha256HexV1 } from '@/lib/content-pipeline/core/hash'
import type { PveContentSnapshotV1 } from '@/lib/pve/content-snapshot'
import {
  PveFlowCommandV1Schema,
  type PveFlowCommandV1,
} from '@/lib/pve/flow-command-v1'
import {
  PVE_CHECKPOINT_SCHEMA_VERSION_V1,
  PVE_RECEIPT_SCHEMA_VERSION_V1,
  PVE_RUN_SCHEMA_VERSION_V1,
  PveRunV1Schema,
  type PveFlowNodeV1,
  type PveReceiptV1,
  type PveRunV1,
} from '@/lib/pve/contracts'
import type { PveRunStatePatchV1 } from '@/lib/pve/runtime-registry'

export const PVE_FLOW_TRANSITION_SCHEMA_VERSION_V1 =
  'rvb-pve-transition/v1' as const
export const PVE_AUTOMATIC_STEP_BUDGET_V1 = 32

export type PveFlowRunnerErrorCodeV1 =
  | 'PVE_RUN_INVALID'
  | 'PVE_RUN_AUTHORITY_MISMATCH'
  | 'PVE_COMMAND_INVALID'
  | 'PVE_COMMAND_RUN_MISMATCH'
  | 'PVE_COMMAND_REVISION_CONFLICT'
  | 'PVE_COMMAND_NOT_LEGAL'
  | 'PVE_BATTLE_ADAPTER_REQUIRED'
  | 'PVE_ACTIVE_BATTLE_MISMATCH'
  | 'PVE_AUTOMATIC_STEP_BUDGET_EXCEEDED'

export class PveFlowRunnerErrorV1 extends Error {
  constructor(
    readonly code: PveFlowRunnerErrorCodeV1,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'PveFlowRunnerErrorV1'
  }
}

export type PveLegalCommandV1 =
  | Readonly<{ type: 'roster-select' }>
  | Readonly<{ type: 'story-continue' }>
  | Readonly<{
      type: 'event-choose'
      choiceId: string
      labelTextId: string
    }>
  | Readonly<{ type: 'reward-claim'; subjectId: string }>
  | Readonly<{ type: 'battle-start' }>
  | Readonly<{ type: 'battle-action' }>

export type PvePublicNodeViewV1 =
  | Readonly<{ nodeId: string; type: 'story'; storyId: string }>
  | Readonly<{ nodeId: string; type: 'roster'; rosterId: string }>
  | Readonly<{
      nodeId: string
      type: 'event'
      eventId: string
      choices: readonly Readonly<{
        choiceId: string
        labelTextId: string
      }>[]
    }>
  | Readonly<{
      nodeId: string
      type: 'battle'
      encounterId: string
      activeBattle: null | Readonly<{
        battleId: string
        stateHash: string
      }>
    }>
  | Readonly<{
      nodeId: string
      type: 'reward'
      rewardId: string
      subjects: readonly string[]
    }>
  | Readonly<{ nodeId: string; type: 'branch' }>
  | Readonly<{ nodeId: string; type: 'checkpoint'; checkpointId: string }>
  | Readonly<{
      nodeId: string
      type: 'end'
      endingId: string
      outcome: 'completed' | 'failed'
    }>

export interface PveReceiptDraftV1 {
  readonly commandId: string
  readonly kind: PveReceiptV1['kind']
  readonly sourceNodeId: string
  readonly subjectId: string
  readonly resultHash: string
}

export interface PveFlowTransitionStepV1 {
  readonly kind: 'command' | 'automatic'
  readonly action: string
  readonly nodeId: string
  readonly nextNodeId: string
  readonly fromRevision: number
  readonly toRevision: number
}

export interface PveFlowTransitionV1 {
  readonly schemaVersion: typeof PVE_FLOW_TRANSITION_SCHEMA_VERSION_V1
  readonly commandId: string | null
  readonly duplicate: boolean
  readonly fromRevision: number
  readonly toRevision: number
  readonly fromNodeId: string
  readonly toNodeId: string
  readonly steps: readonly Readonly<PveFlowTransitionStepV1>[]
  readonly receiptDrafts: readonly Readonly<PveReceiptDraftV1>[]
  readonly transitionHash: string
}

export interface PveFlowRunnerResultV1 {
  readonly run: Readonly<PveRunV1>
  readonly node: PvePublicNodeViewV1
  readonly legalCommands: readonly PveLegalCommandV1[]
  readonly transition: Readonly<PveFlowTransitionV1>
}

export interface CreateInitialPveRunInputV1 {
  readonly runId: string
  readonly campaignId: string
  readonly rootSeed: number
}

interface MutableTransitionV1 {
  commandId: string | null
  duplicate: boolean
  fromRevision: number
  fromNodeId: string
  steps: PveFlowTransitionStepV1[]
  receiptDrafts: PveReceiptDraftV1[]
}

const encoder = new TextEncoder()

function flowError(
  code: PveFlowRunnerErrorCodeV1,
  message: string,
  context: Readonly<Record<string, unknown>> = {},
): never {
  throw new PveFlowRunnerErrorV1(code, message, context)
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value
  }
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child)
  }
  return value
}

function hashValue(domain: string, value: unknown): string {
  const prefix = encoder.encode(domain)
  const payload = canonicalJsonBytesV1(value)
  const bytes = new Uint8Array(prefix.byteLength + payload.byteLength)
  bytes.set(prefix)
  bytes.set(payload, prefix.byteLength)
  return sha256HexV1(bytes)
}

function parseRunSchema(value: unknown): PveRunV1 {
  const result = PveRunV1Schema.safeParse(value)
  if (!result.success) {
    return flowError('PVE_RUN_INVALID', 'PVE Run failed its strict v1 schema')
  }
  return result.data
}

function checkpointStateProjection(run: PveRunV1): Record<string, unknown> {
  const checkpoint = run.checkpoint
  return {
    authorityContentHash: checkpoint.authorityContentHash,
    campaignId: run.campaignId,
    currentNodeId: checkpoint.currentNodeId,
    rootSeed: run.rootSeed,
    revision: checkpoint.revision,
    party: checkpoint.party,
    deck: checkpoint.deck,
    relics: checkpoint.relics,
    flags: checkpoint.flags,
    activeBattle: checkpoint.activeBattle,
  }
}

function assertCheckpointIntegrity(run: PveRunV1): void {
  const checkpoint = run.checkpoint
  const receiptsHash = hashValue(
    'RVB_PVE_RECEIPTS_V1\u0000',
    run.receipts.slice(0, checkpoint.receiptCount),
  )
  const stateHash = hashValue(
    'RVB_PVE_CHECKPOINT_STATE_V1\u0000',
    checkpointStateProjection(run),
  )
  if (
    checkpoint.receiptsHash !== receiptsHash
    || checkpoint.stateHash !== stateHash
  ) {
    flowError(
      'PVE_RUN_INVALID',
      'PVE Run checkpoint integrity verification failed',
      {
        checkpointId: checkpoint.checkpointId,
        receiptsHashMatches: checkpoint.receiptsHash === receiptsHash,
        stateHashMatches: checkpoint.stateHash === stateHash,
      },
    )
  }
}

function parseRun(value: unknown): PveRunV1 {
  const run = parseRunSchema(value)
  assertCheckpointIntegrity(run)
  return run
}

function parseCommand(value: unknown): PveFlowCommandV1 {
  const result = PveFlowCommandV1Schema.safeParse(value)
  if (!result.success) {
    return flowError(
      'PVE_COMMAND_INVALID',
      'PVE command failed its strict v1 schema',
    )
  }
  return result.data
}

function assertRunSnapshot(
  snapshot: Readonly<PveContentSnapshotV1>,
  run: PveRunV1,
): void {
  if (snapshot.authorityContentHash !== run.authorityContentHash) {
    flowError(
      'PVE_RUN_AUTHORITY_MISMATCH',
      'Run and Resolved Snapshot authorityContentHash differ',
      {
        expected: run.authorityContentHash,
        actual: snapshot.authorityContentHash,
      },
    )
  }
  snapshot.getCampaign(run.campaignId)
  snapshot.getNode(run.campaignId, run.currentNodeId)
}

function incrementRevision(run: PveRunV1): number {
  if (run.revision >= Number.MAX_SAFE_INTEGER) {
    flowError('PVE_RUN_INVALID', 'PVE Run revision is exhausted')
  }
  run.revision += 1
  return run.revision
}

function stateProjection(run: PveRunV1): Record<string, unknown> {
  return {
    authorityContentHash: run.authorityContentHash,
    campaignId: run.campaignId,
    currentNodeId: run.currentNodeId,
    rootSeed: run.rootSeed,
    revision: run.revision,
    party: run.party,
    deck: run.deck,
    relics: run.relics,
    flags: run.flags,
    activeBattle: run.activeBattle,
  }
}

function applyStatePatch(run: PveRunV1, patch: PveRunStatePatchV1): void {
  if (patch.party !== undefined) run.party = [...patch.party]
  if (patch.deck !== undefined) run.deck = [...patch.deck]
  if (patch.relics !== undefined) run.relics = [...patch.relics]
  if (patch.flags !== undefined) {
    run.flags = { ...run.flags, ...patch.flags }
  }
}

function appendReceipt(
  run: PveRunV1,
  draft: PveReceiptDraftV1,
  fromRevision: number,
): void {
  run.receipts.push({
    schemaVersion: PVE_RECEIPT_SCHEMA_VERSION_V1,
    commandId: draft.commandId,
    kind: draft.kind,
    sourceNodeId: draft.sourceNodeId,
    subjectId: draft.subjectId,
    fromRevision,
    toRevision: fromRevision + 1,
    resultHash: draft.resultHash,
  })
}

function recordStep(
  transition: MutableTransitionV1,
  kind: PveFlowTransitionStepV1['kind'],
  action: string,
  nodeId: string,
  nextNodeId: string,
  fromRevision: number,
  toRevision: number,
): void {
  transition.steps.push({
    kind,
    action,
    nodeId,
    nextNodeId,
    fromRevision,
    toRevision,
  })
}

function advanceNode(
  run: PveRunV1,
  transition: MutableTransitionV1,
  kind: PveFlowTransitionStepV1['kind'],
  action: string,
  nextNodeId: string,
): { fromRevision: number; toRevision: number; nodeId: string } {
  const nodeId = run.currentNodeId
  const fromRevision = run.revision
  run.currentNodeId = nextNodeId
  const toRevision = incrementRevision(run)
  recordStep(
    transition,
    kind,
    action,
    nodeId,
    nextNodeId,
    fromRevision,
    toRevision,
  )
  return { fromRevision, toRevision, nodeId }
}

function createCheckpoint(
  run: PveRunV1,
  checkpointId: string,
): PveRunV1['checkpoint'] {
  const receiptsHash = hashValue(
    'RVB_PVE_RECEIPTS_V1\u0000',
    run.receipts,
  )
  return {
    schemaVersion: PVE_CHECKPOINT_SCHEMA_VERSION_V1,
    checkpointId,
    revision: run.revision,
    authorityContentHash: run.authorityContentHash,
    currentNodeId: run.currentNodeId,
    party: [...run.party],
    deck: [...run.deck],
    relics: [...run.relics],
    flags: { ...run.flags },
    activeBattle: run.activeBattle === null
      ? null
      : structuredClone(run.activeBattle),
    receiptCount: run.receipts.length,
    receiptsHash,
    stateHash: hashValue(
      'RVB_PVE_CHECKPOINT_STATE_V1\u0000',
      stateProjection(run),
    ),
  }
}

function stabilizeMutable(
  snapshot: Readonly<PveContentSnapshotV1>,
  run: PveRunV1,
  transition: MutableTransitionV1,
): void {
  let automaticSteps = 0
  while (true) {
    const node = snapshot.getNode(run.campaignId, run.currentNodeId)
    if (node.type !== 'branch' && node.type !== 'checkpoint') return
    if (automaticSteps >= PVE_AUTOMATIC_STEP_BUDGET_V1) {
      flowError(
        'PVE_AUTOMATIC_STEP_BUDGET_EXCEEDED',
        'PVE automatic transition budget was exceeded',
        {
          campaignId: run.campaignId,
          nodeId: run.currentNodeId,
          budget: PVE_AUTOMATIC_STEP_BUDGET_V1,
        },
      )
    }
    automaticSteps += 1

    if (node.type === 'branch') {
      let nextNodeId = node.fallbackNodeId
      for (const route of node.routes) {
        if (snapshot.registry.evaluateCondition(route.conditionId, run)) {
          nextNodeId = route.nextNodeId
          break
        }
      }
      advanceNode(run, transition, 'automatic', 'branch', nextNodeId)
      continue
    }

    advanceNode(
      run,
      transition,
      'automatic',
      'checkpoint',
      node.nextNodeId,
    )
    run.checkpoint = createCheckpoint(run, node.checkpointId)
  }
}

function legalCommandsForNode(
  snapshot: Readonly<PveContentSnapshotV1>,
  run: Readonly<PveRunV1>,
  node: Readonly<PveFlowNodeV1>,
): readonly PveLegalCommandV1[] {
  switch (node.type) {
    case 'roster':
      return Object.freeze([{ type: 'roster-select' as const }])
    case 'story':
      return Object.freeze([{ type: 'story-continue' as const }])
    case 'event': {
      const event = snapshot.getEvent(node.eventId)
      return Object.freeze(event.choices.map(choice => Object.freeze({
        type: 'event-choose' as const,
        choiceId: choice.choiceId,
        labelTextId: choice.labelTextId,
      })))
    }
    case 'reward': {
      const reward = snapshot.getReward(node.rewardId)
      const table = snapshot.registry.requireRewardTable(reward.rewardTableId)
      return Object.freeze(table.subjectIds.map(subjectId => Object.freeze({
        type: 'reward-claim' as const,
        subjectId,
      })))
    }
    case 'battle':
      return run.activeBattle === null
        ? Object.freeze([{ type: 'battle-start' as const }])
        : Object.freeze([{ type: 'battle-action' as const }])
    case 'branch':
    case 'checkpoint':
    case 'end':
      return Object.freeze([])
  }
}

function publicNodeView(
  snapshot: Readonly<PveContentSnapshotV1>,
  run: Readonly<PveRunV1>,
  node: Readonly<PveFlowNodeV1>,
): PvePublicNodeViewV1 {
  switch (node.type) {
    case 'story':
      return Object.freeze({
        nodeId: node.nodeId,
        type: node.type,
        storyId: node.storyId,
      })
    case 'roster':
      return Object.freeze({
        nodeId: node.nodeId,
        type: node.type,
        rosterId: node.rosterId,
      })
    case 'event': {
      const event = snapshot.getEvent(node.eventId)
      return deepFreeze({
        nodeId: node.nodeId,
        type: node.type,
        eventId: node.eventId,
        choices: event.choices.map(choice => ({
          choiceId: choice.choiceId,
          labelTextId: choice.labelTextId,
        })),
      })
    }
    case 'battle':
      return deepFreeze({
        nodeId: node.nodeId,
        type: node.type,
        encounterId: node.encounterId,
        activeBattle: run.activeBattle === null
          ? null
          : {
              battleId: run.activeBattle.battleId,
              stateHash: run.activeBattle.stateHash,
            },
      })
    case 'reward': {
      const reward = snapshot.getReward(node.rewardId)
      const table = snapshot.registry.requireRewardTable(reward.rewardTableId)
      return deepFreeze({
        nodeId: node.nodeId,
        type: node.type,
        rewardId: node.rewardId,
        subjects: [...table.subjectIds],
      })
    }
    case 'branch':
      return Object.freeze({ nodeId: node.nodeId, type: node.type })
    case 'checkpoint':
      return Object.freeze({
        nodeId: node.nodeId,
        type: node.type,
        checkpointId: node.checkpointId,
      })
    case 'end':
      return Object.freeze({
        nodeId: node.nodeId,
        type: node.type,
        endingId: node.endingId,
        outcome: node.outcome,
      })
  }
}

function finalizeResult(
  snapshot: Readonly<PveContentSnapshotV1>,
  runValue: PveRunV1,
  transition: MutableTransitionV1,
): Readonly<PveFlowRunnerResultV1> {
  const run = deepFreeze(parseRun(runValue))
  const node = snapshot.getNode(run.campaignId, run.currentNodeId)
  const transitionBase = {
    schemaVersion: PVE_FLOW_TRANSITION_SCHEMA_VERSION_V1,
    commandId: transition.commandId,
    duplicate: transition.duplicate,
    fromRevision: transition.fromRevision,
    toRevision: run.revision,
    fromNodeId: transition.fromNodeId,
    toNodeId: run.currentNodeId,
    steps: transition.steps,
    receiptDrafts: transition.receiptDrafts,
  }
  const completedTransition = deepFreeze({
    ...transitionBase,
    transitionHash: hashValue(
      'RVB_PVE_TRANSITION_V1\u0000',
      { ...transitionBase, run },
    ),
  })
  return deepFreeze({
    run,
    node: publicNodeView(snapshot, run, node),
    legalCommands: legalCommandsForNode(snapshot, run, node),
    transition: completedTransition,
  })
}

function ensureCommand(
  command: PveFlowCommandV1,
  run: PveRunV1,
): void {
  if (command.runId !== run.runId) {
    flowError(
      'PVE_COMMAND_RUN_MISMATCH',
      'PVE command targets a different Run',
      { expected: run.runId, actual: command.runId },
    )
  }
}

function commandNotLegal(node: PveFlowNodeV1, command: PveFlowCommandV1): never {
  return flowError(
    'PVE_COMMAND_NOT_LEGAL',
    'PVE command is not legal for the current node',
    { nodeId: node.nodeId, nodeType: node.type, commandType: command.type },
  )
}

function runInteractiveCommand(
  snapshot: Readonly<PveContentSnapshotV1>,
  run: PveRunV1,
  command: PveFlowCommandV1,
  transition: MutableTransitionV1,
): void {
  const node = snapshot.getNode(run.campaignId, run.currentNodeId)
  switch (node.type) {
    case 'roster': {
      if (command.type !== 'roster-select') commandNotLegal(node, command)
      const roster = snapshot.registry.requireRoster(node.rosterId)
      run.party = [...roster.pieceIds]
      if (roster.initialDeck !== undefined) {
        run.deck = [...roster.initialDeck]
      }
      advanceNode(
        run,
        transition,
        'command',
        command.type,
        node.nextNodeId,
      )
      return
    }
    case 'story':
      if (command.type !== 'story-continue') commandNotLegal(node, command)
      advanceNode(
        run,
        transition,
        'command',
        command.type,
        node.nextNodeId,
      )
      return
    case 'event': {
      if (command.type !== 'event-choose') commandNotLegal(node, command)
      const event = snapshot.getEvent(node.eventId)
      const choice = event.choices.find(item =>
        item.choiceId === command.choiceId)
      if (choice === undefined) commandNotLegal(node, command)
      const route = node.outcomes.find(item =>
        item.outcomeId === choice.outcomeId)
      if (route === undefined) commandNotLegal(node, command)
      const fromRevision = run.revision
      applyStatePatch(
        run,
        snapshot.registry.applyEffect(choice.effectId, run, {
          kind: 'event',
          sourceNodeId: node.nodeId,
          subjectId: choice.choiceId,
        }),
      )
      advanceNode(
        run,
        transition,
        'command',
        command.type,
        route.nextNodeId,
      )
      const draft: PveReceiptDraftV1 = {
        commandId: command.commandId,
        kind: 'effect',
        sourceNodeId: node.nodeId,
        subjectId: choice.effectId,
        resultHash: hashValue(
          'RVB_PVE_COMMAND_RESULT_V1\u0000',
          { command, state: stateProjection(run) },
        ),
      }
      appendReceipt(run, draft, fromRevision)
      transition.receiptDrafts.push(draft)
      return
    }
    case 'reward': {
      if (command.type !== 'reward-claim') commandNotLegal(node, command)
      const reward = snapshot.getReward(node.rewardId)
      const table = snapshot.registry.requireRewardTable(reward.rewardTableId)
      if (!table.subjectIds.includes(command.subjectId)) {
        commandNotLegal(node, command)
      }
      const fromRevision = run.revision
      applyStatePatch(
        run,
        snapshot.registry.applyEffect(reward.grantEffectId, run, {
          kind: 'reward',
          sourceNodeId: node.nodeId,
          subjectId: command.subjectId,
        }),
      )
      advanceNode(
        run,
        transition,
        'command',
        command.type,
        node.nextNodeId,
      )
      const draft: PveReceiptDraftV1 = {
        commandId: command.commandId,
        kind: 'reward',
        sourceNodeId: node.nodeId,
        subjectId: command.subjectId,
        resultHash: hashValue(
          'RVB_PVE_COMMAND_RESULT_V1\u0000',
          { command, rewardId: reward.rewardId, state: stateProjection(run) },
        ),
      }
      appendReceipt(run, draft, fromRevision)
      transition.receiptDrafts.push(draft)
      return
    }
    case 'battle':
      if (command.type === 'battle-start' || command.type === 'battle-action') {
        flowError(
          'PVE_BATTLE_ADAPTER_REQUIRED',
          'Battle command must be handled by the formal Battle Adapter',
          { nodeId: node.nodeId, commandType: command.type },
        )
      }
      if (command.type === 'battle-started') {
        if (
          run.activeBattle !== null
          || command.activeBattle.authorityContentHash
            !== run.authorityContentHash
          || command.activeBattle.sourceNodeId !== node.nodeId
          || command.activeBattle.encounterId !== node.encounterId
        ) {
          flowError(
            'PVE_ACTIVE_BATTLE_MISMATCH',
            'Authority battle start does not match the current Run',
            { nodeId: node.nodeId },
          )
        }
        const fromRevision = run.revision
        run.activeBattle = structuredClone(command.activeBattle)
        incrementRevision(run)
        recordStep(
          transition,
          'command',
          command.type,
          node.nodeId,
          node.nodeId,
          fromRevision,
          run.revision,
        )
        return
      }
      if (command.type === 'battle-updated') {
        const active = run.activeBattle
        if (
          active === null
          || command.activeBattle.authorityContentHash
            !== run.authorityContentHash
          || command.activeBattle.battleId !== active.battleId
          || command.activeBattle.sourceNodeId !== active.sourceNodeId
          || command.activeBattle.sourceNodeId !== node.nodeId
          || command.activeBattle.encounterId !== active.encounterId
          || command.activeBattle.encounterId !== node.encounterId
          || command.activeBattle.stateHash === active.stateHash
        ) {
          flowError(
            'PVE_ACTIVE_BATTLE_MISMATCH',
            'Authority battle update does not match the active battle',
            { nodeId: node.nodeId },
          )
        }
        const fromRevision = run.revision
        run.activeBattle = structuredClone(command.activeBattle)
        incrementRevision(run)
        recordStep(
          transition,
          'command',
          command.type,
          node.nodeId,
          node.nodeId,
          fromRevision,
          run.revision,
        )
        return
      }
      if (command.type === 'battle-settle') {
        const active = run.activeBattle
        if (
          active === null
          || active.battleId !== command.battleId
          || active.stateHash !== command.stateHash
          || active.sourceNodeId !== node.nodeId
          || active.encounterId !== node.encounterId
          || active.authorityContentHash !== run.authorityContentHash
        ) {
          flowError(
            'PVE_ACTIVE_BATTLE_MISMATCH',
            'Authority battle terminal fact does not match the active battle',
            { nodeId: node.nodeId, battleId: command.battleId },
          )
        }
        const fromRevision = run.revision
        run.activeBattle = null
        const nextNodeId = command.outcome === 'victory'
          ? node.victoryNodeId
          : command.outcome === 'defeat'
            ? node.defeatNodeId
            : node.drawNodeId
        advanceNode(
          run,
          transition,
          'command',
          command.type,
          nextNodeId,
        )
        const draft: PveReceiptDraftV1 = {
          commandId: command.commandId,
          kind: 'battle-settlement',
          sourceNodeId: node.nodeId,
          subjectId: command.battleId,
          resultHash: command.resultHash,
        }
        appendReceipt(run, draft, fromRevision)
        transition.receiptDrafts.push(draft)
        return
      }
      return commandNotLegal(node, command)
    case 'branch':
    case 'checkpoint':
      return flowError(
        'PVE_COMMAND_NOT_LEGAL',
        'Automatic PVE nodes must be stabilized before accepting a command',
        { nodeId: node.nodeId, nodeType: node.type },
      )
    case 'end':
      return commandNotLegal(node, command)
  }
}

export function stabilizePveRunV1(
  snapshot: Readonly<PveContentSnapshotV1>,
  runValue: unknown,
): Readonly<PveFlowRunnerResultV1> {
  const run = parseRun(runValue)
  assertRunSnapshot(snapshot, run)
  const transition: MutableTransitionV1 = {
    commandId: null,
    duplicate: false,
    fromRevision: run.revision,
    fromNodeId: run.currentNodeId,
    steps: [],
    receiptDrafts: [],
  }
  stabilizeMutable(snapshot, run, transition)
  return finalizeResult(snapshot, run, transition)
}

/**
 * Construct the only canonical revision-zero Run shape, including the
 * checkpoint hashes, then consume any automatic entry-node chain.
 */
export function createInitialPveRunV1(
  snapshot: Readonly<PveContentSnapshotV1>,
  input: Readonly<CreateInitialPveRunInputV1>,
): Readonly<PveFlowRunnerResultV1> {
  const campaign = snapshot.getCampaign(input.campaignId)
  const run = parseRunSchema({
    schemaVersion: PVE_RUN_SCHEMA_VERSION_V1,
    runId: input.runId,
    campaignId: input.campaignId,
    rootSeed: input.rootSeed,
    revision: 0,
    authorityContentHash: snapshot.authorityContentHash,
    currentNodeId: campaign.entryNodeId,
    party: [],
    deck: [],
    relics: [],
    flags: {},
    activeBattle: null,
    checkpoint: {
      schemaVersion: PVE_CHECKPOINT_SCHEMA_VERSION_V1,
      checkpointId: 'run-start',
      revision: 0,
      authorityContentHash: snapshot.authorityContentHash,
      currentNodeId: campaign.entryNodeId,
      party: [],
      deck: [],
      relics: [],
      flags: {},
      activeBattle: null,
      receiptCount: 0,
      receiptsHash: '0'.repeat(64),
      stateHash: '0'.repeat(64),
    },
    receipts: [],
  })
  run.checkpoint = createCheckpoint(run, 'run-start')
  return stabilizePveRunV1(snapshot, run)
}

/** Domain-separated canonical Run hash for audit/E2E evidence. */
export function hashPveRunV1(runValue: unknown): string {
  return hashValue('RVB_PVE_RUN_V1\u0000', parseRun(runValue))
}

export function runPveFlowV1(
  snapshot: Readonly<PveContentSnapshotV1>,
  runValue: unknown,
  commandValue: unknown,
): Readonly<PveFlowRunnerResultV1> {
  const run = parseRun(runValue)
  const command = parseCommand(commandValue)
  assertRunSnapshot(snapshot, run)
  ensureCommand(command, run)

  const existingReceipt = run.receipts.find(receipt =>
    receipt.commandId === command.commandId)
  if (existingReceipt !== undefined) {
    return finalizeResult(snapshot, run, {
      commandId: command.commandId,
      duplicate: true,
      fromRevision: run.revision,
      fromNodeId: run.currentNodeId,
      steps: [],
      receiptDrafts: [],
    })
  }
  if (command.expectedRevision !== run.revision) {
    flowError(
      'PVE_COMMAND_REVISION_CONFLICT',
      'PVE command expectedRevision is stale',
      { expected: run.revision, actual: command.expectedRevision },
    )
  }

  const transition: MutableTransitionV1 = {
    commandId: command.commandId,
    duplicate: false,
    fromRevision: run.revision,
    fromNodeId: run.currentNodeId,
    steps: [],
    receiptDrafts: [],
  }
  runInteractiveCommand(snapshot, run, command, transition)
  stabilizeMutable(snapshot, run, transition)
  return finalizeResult(snapshot, run, transition)
}
