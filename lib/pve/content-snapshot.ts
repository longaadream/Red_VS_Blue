import type { ResolvedSnapshotViewV1 } from '@/lib/content-pipeline/core/resolver'
import { parseStrictJsonBytesV1 } from '@/lib/content-pipeline/core/json-safety'
import {
  PveCampaignV1Schema,
  PveChapterV1Schema,
  PveContentManifestV1Schema,
  PveEncounterV1Schema,
  PveEnemySetupV1Schema,
  PveEventV1Schema,
  PveFlowNodeV1Schema,
  PveRelicV1Schema,
  PveRewardV1Schema,
  type PveCampaignV1,
  type PveChapterV1,
  type PveContentKindV1,
  type PveContentManifestV1,
  type PveEncounterV1,
  type PveEnemySetupV1,
  type PveEventV1,
  type PveFlowNodeV1,
  type PveRelicV1,
  type PveRewardV1,
} from '@/lib/pve/contracts'
import type { PveRuntimeRegistryV1 } from '@/lib/pve/runtime-registry'

export type PveContentSnapshotErrorCodeV1 =
  | 'PVE_SNAPSHOT_EMPTY'
  | 'PVE_SNAPSHOT_FILE_MISSING'
  | 'PVE_SNAPSHOT_SCHEMA_INVALID'
  | 'PVE_SNAPSHOT_REFERENCE_INVALID'

export class PveContentSnapshotErrorV1 extends Error {
  constructor(
    readonly code: PveContentSnapshotErrorCodeV1,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'PveContentSnapshotErrorV1'
  }
}

export interface PveContentSnapshotV1 {
  readonly authorityContentHash: string
  readonly resolvedProfileHash: string
  readonly registry: Readonly<PveRuntimeRegistryV1>
  listCampaigns(): readonly Readonly<PveCampaignV1>[]
  getCampaign(campaignId: string): Readonly<PveCampaignV1>
  getNode(campaignId: string, nodeId: string): Readonly<PveFlowNodeV1>
  getChapter(chapterId: string): Readonly<PveChapterV1>
  getEncounter(encounterId: string): Readonly<PveEncounterV1>
  getEnemySetup(enemySetupId: string): Readonly<PveEnemySetupV1>
  getEvent(eventId: string): Readonly<PveEventV1>
  getReward(rewardId: string): Readonly<PveRewardV1>
  getRelic(relicId: string): Readonly<PveRelicV1>
}

type ParsedPveDocumentV1 =
  | { readonly kind: 'content-manifest'; readonly value: PveContentManifestV1 }
  | { readonly kind: 'campaign'; readonly value: PveCampaignV1 }
  | { readonly kind: 'chapter'; readonly value: PveChapterV1 }
  | { readonly kind: 'encounter'; readonly value: PveEncounterV1 }
  | { readonly kind: 'enemy'; readonly value: PveEnemySetupV1 }
  | { readonly kind: 'event'; readonly value: PveEventV1 }
  | { readonly kind: 'reward'; readonly value: PveRewardV1 }
  | { readonly kind: 'relic'; readonly value: PveRelicV1 }
  | { readonly kind: 'node'; readonly value: PveFlowNodeV1 }

interface ParsedPveFileV1 {
  readonly path: string
  readonly document: ParsedPveDocumentV1
}

function fail(
  code: PveContentSnapshotErrorCodeV1,
  message: string,
  context: Readonly<Record<string, unknown>> = {},
): never {
  throw new PveContentSnapshotErrorV1(code, message, context)
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

function parseJson(path: string, bytes: Uint8Array): unknown {
  try {
    return parseStrictJsonBytesV1(bytes)
  } catch {
    return fail(
      'PVE_SNAPSHOT_SCHEMA_INVALID',
      'PVE Snapshot file is not strict UTF-8 JSON',
      { path },
    )
  }
}

function parseDocument(path: string, value: unknown): ParsedPveDocumentV1 {
  const schemaVersion = (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
  ) ? (value as Record<string, unknown>).schemaVersion : undefined

  const parse = <T>(
    kind: ParsedPveDocumentV1['kind'],
    schema: { safeParse(input: unknown):
      | { success: true; data: T }
      | { success: false } },
  ): ParsedPveDocumentV1 => {
    const result = schema.safeParse(value)
    if (!result.success) {
      return fail(
        'PVE_SNAPSHOT_SCHEMA_INVALID',
        'PVE Snapshot document failed its strict schema',
        { path, schemaVersion },
      )
    }
    return deepFreeze({ kind, value: result.data }) as ParsedPveDocumentV1
  }

  switch (schemaVersion) {
    case 'rvb-pve-content-manifest/v1':
      return parse('content-manifest', PveContentManifestV1Schema)
    case 'rvb-pve-campaign/v1':
      return parse('campaign', PveCampaignV1Schema)
    case 'rvb-pve-chapter/v1':
      return parse('chapter', PveChapterV1Schema)
    case 'rvb-pve-encounter/v1':
      return parse('encounter', PveEncounterV1Schema)
    case 'rvb-pve-enemy-setup/v1':
      return parse('enemy', PveEnemySetupV1Schema)
    case 'rvb-pve-event/v1':
      return parse('event', PveEventV1Schema)
    case 'rvb-pve-reward/v1':
      return parse('reward', PveRewardV1Schema)
    case 'rvb-pve-relic/v1':
      return parse('relic', PveRelicV1Schema)
    case 'rvb-pve-node/v1':
      return parse('node', PveFlowNodeV1Schema)
    default:
      return fail(
        'PVE_SNAPSHOT_SCHEMA_INVALID',
        'Unknown schema in the PVE namespace',
        { path, schemaVersion },
      )
  }
}

function contentDocumentId(document: ParsedPveDocumentV1): string | undefined {
  switch (document.kind) {
    case 'campaign': return document.value.campaignId
    case 'chapter': return document.value.chapterId
    case 'encounter': return document.value.encounterId
    case 'enemy': return document.value.enemySetupId
    case 'event': return document.value.eventId
    case 'reward': return document.value.rewardId
    case 'relic': return document.value.relicId
    default: return undefined
  }
}

function contentKey(kind: PveContentKindV1, contentId: string): string {
  return kind + '\u0000' + contentId
}

function nextNodeIds(node: PveFlowNodeV1): readonly string[] {
  switch (node.type) {
    case 'story':
    case 'roster':
    case 'reward':
    case 'checkpoint':
      return [node.nextNodeId]
    case 'battle':
      return [node.victoryNodeId, node.defeatNodeId, node.drawNodeId]
    case 'event':
      return node.outcomes.map(route => route.nextNodeId)
    case 'branch':
      return [
        ...node.routes.map(route => route.nextNodeId),
        node.fallbackNodeId,
      ]
    case 'end':
      return []
  }
}

function required<T>(
  values: ReadonlyMap<string, T>,
  id: string,
  kind: string,
): T {
  const value = values.get(id)
  if (value === undefined) {
    return fail(
      'PVE_SNAPSHOT_REFERENCE_INVALID',
      'Missing PVE ' + kind + ' reference: ' + id,
      { kind, id },
    )
  }
  return value
}

function addUnique<T>(
  values: Map<string, T>,
  id: string,
  value: T,
  kind: string,
  path: string,
): void {
  if (values.has(id)) {
    fail(
      'PVE_SNAPSHOT_REFERENCE_INVALID',
      'Duplicate PVE ' + kind + ' ID: ' + id,
      { kind, id, path },
    )
  }
  values.set(id, value)
}

/**
 * Strictly index PVE documents from one already-verified Resolved Snapshot.
 * This layer never consults the active Profile pointer or a filesystem root.
 */
export function createPveContentSnapshotV1(
  snapshot: ResolvedSnapshotViewV1,
  registry: Readonly<PveRuntimeRegistryV1>,
): Readonly<PveContentSnapshotV1> {
  const pveDescriptors = snapshot.files.filter(file =>
    file.path.startsWith('data/pve/'))
  if (pveDescriptors.length === 0) {
    return fail('PVE_SNAPSHOT_EMPTY', 'Resolved Snapshot contains no PVE data')
  }

  const parsedFiles: ParsedPveFileV1[] = []
  const parsedByPath = new Map<string, ParsedPveFileV1>()
  for (const descriptor of pveDescriptors) {
    if (
      descriptor.mediaType !== 'application/json'
      || parsedByPath.has(descriptor.path)
    ) {
      fail(
        'PVE_SNAPSHOT_SCHEMA_INVALID',
        'PVE Snapshot inventory is invalid',
        { path: descriptor.path },
      )
    }
    const bytes = snapshot.readFile(descriptor.path)
    if (bytes === undefined) {
      fail(
        'PVE_SNAPSHOT_FILE_MISSING',
        'Resolved Snapshot did not provide a declared PVE file',
        { path: descriptor.path },
      )
    }
    const file = deepFreeze({
      path: descriptor.path,
      document: parseDocument(
        descriptor.path,
        parseJson(descriptor.path, bytes),
      ),
    })
    parsedFiles.push(file)
    parsedByPath.set(file.path, file)
  }

  const manifests = new Map<string, PveContentManifestV1>()
  const campaigns = new Map<string, PveCampaignV1>()
  const chapters = new Map<string, PveChapterV1>()
  const encounters = new Map<string, PveEncounterV1>()
  const enemies = new Map<string, PveEnemySetupV1>()
  const events = new Map<string, PveEventV1>()
  const rewards = new Map<string, PveRewardV1>()
  const relics = new Map<string, PveRelicV1>()
  const nodeFiles = new Map<string, ParsedPveFileV1>()

  for (const file of parsedFiles) {
    const document = file.document
    switch (document.kind) {
      case 'content-manifest':
        addUnique(
          manifests,
          document.value.manifestId,
          document.value,
          'manifest',
          file.path,
        )
        break
      case 'campaign':
        addUnique(
          campaigns,
          document.value.campaignId,
          document.value,
          'campaign',
          file.path,
        )
        break
      case 'chapter':
        addUnique(
          chapters,
          document.value.chapterId,
          document.value,
          'chapter',
          file.path,
        )
        break
      case 'encounter':
        addUnique(
          encounters,
          document.value.encounterId,
          document.value,
          'encounter',
          file.path,
        )
        break
      case 'enemy':
        addUnique(
          enemies,
          document.value.enemySetupId,
          document.value,
          'enemy',
          file.path,
        )
        break
      case 'event':
        addUnique(
          events,
          document.value.eventId,
          document.value,
          'event',
          file.path,
        )
        break
      case 'reward':
        addUnique(
          rewards,
          document.value.rewardId,
          document.value,
          'reward',
          file.path,
        )
        break
      case 'relic':
        addUnique(
          relics,
          document.value.relicId,
          document.value,
          'relic',
          file.path,
        )
        break
      case 'node':
        nodeFiles.set(file.path, file)
        break
    }
  }

  if (manifests.size === 0 || campaigns.size === 0) {
    fail(
      'PVE_SNAPSHOT_REFERENCE_INVALID',
      'PVE Snapshot requires a manifest and a Campaign',
    )
  }

  const registrations = new Map<string, { path: string; contentId: string }>()
  const registrationPaths = new Set<string>()
  for (const manifest of manifests.values()) {
    for (const descriptor of manifest.documents) {
      const key = contentKey(descriptor.kind, descriptor.contentId)
      if (registrations.has(key) || registrationPaths.has(descriptor.path)) {
        fail(
          'PVE_SNAPSHOT_REFERENCE_INVALID',
          'Duplicate PVE content registration',
          { path: descriptor.path, contentId: descriptor.contentId },
        )
      }
      registrations.set(key, {
        path: descriptor.path,
        contentId: descriptor.contentId,
      })
      registrationPaths.add(descriptor.path)
    }
  }

  for (const [key, registration] of registrations) {
    const target = parsedByPath.get(registration.path)
    if (
      target === undefined
      || target.document.kind === 'node'
      || target.document.kind === 'content-manifest'
    ) {
      fail(
        'PVE_SNAPSHOT_REFERENCE_INVALID',
        'Registered PVE content path has the wrong document',
        registration,
      )
    }
    const separator = key.indexOf('\u0000')
    const kind = key.slice(0, separator)
    if (
      target.document.kind !== kind
      || contentDocumentId(target.document) !== registration.contentId
    ) {
      fail(
        'PVE_SNAPSHOT_REFERENCE_INVALID',
        'Registered PVE content identity does not match its document',
        registration,
      )
    }
  }

  for (const file of parsedFiles) {
    const contentId = contentDocumentId(file.document)
    if (contentId === undefined) continue
    const registration = registrations.get(
      contentKey(file.document.kind as PveContentKindV1, contentId),
    )
    if (registration?.path !== file.path) {
      fail(
        'PVE_SNAPSHOT_REFERENCE_INVALID',
        'PVE content document is not registered exactly once',
        { path: file.path, contentId },
      )
    }
  }

  for (const chapter of chapters.values()) {
    required(campaigns, chapter.campaignId, 'campaign')
  }
  for (const encounter of encounters.values()) {
    const enemy = required(enemies, encounter.enemySetupId, 'enemy')
    registry.requireMap(encounter.mapId)
    registry.requireObjective(encounter.objectiveId)
    registry.requireRoster(enemy.rosterId)
    registry.requireAiProfile(enemy.aiProfileId)
  }
  for (const event of events.values()) {
    for (const choice of event.choices) registry.requireEffect(choice.effectId)
  }
  for (const reward of rewards.values()) {
    registry.requireRewardTable(reward.rewardTableId)
    registry.requireEffect(reward.grantEffectId)
  }
  for (const relic of relics.values()) {
    for (const effectId of relic.effectIds) registry.requireEffect(effectId)
  }

  const nodesByCampaign = new Map<string, ReadonlyMap<string, PveFlowNodeV1>>()
  const referencedNodePaths = new Set<string>()
  for (const campaign of campaigns.values()) {
    const nodes = new Map<string, PveFlowNodeV1>()
    for (const descriptor of campaign.nodes) {
      const file = nodeFiles.get(descriptor.path)
      if (
        file?.document.kind !== 'node'
        || file.document.value.nodeId !== descriptor.nodeId
      ) {
        fail(
          'PVE_SNAPSHOT_REFERENCE_INVALID',
          'Campaign node descriptor does not match its document',
          { path: descriptor.path, nodeId: descriptor.nodeId },
        )
      }
      nodes.set(descriptor.nodeId, file.document.value)
      referencedNodePaths.add(descriptor.path)
    }

    for (const node of nodes.values()) {
      for (const nextNodeId of nextNodeIds(node)) {
        required(nodes, nextNodeId, 'node')
      }
      switch (node.type) {
        case 'battle':
          required(encounters, node.encounterId, 'encounter')
          break
        case 'event': {
          const event = required(events, node.eventId, 'event')
          const declared = [...new Set(
            event.choices.map(choice => choice.outcomeId),
          )].sort()
          const routed = node.outcomes.map(route => route.outcomeId)
          if (
            declared.length !== routed.length
            || declared.some((id, index) => id !== routed[index])
          ) {
            fail(
              'PVE_SNAPSHOT_REFERENCE_INVALID',
              'Event outcomes do not match the event node routes',
              { eventId: node.eventId, nodeId: node.nodeId },
            )
          }
          break
        }
        case 'reward':
          required(rewards, node.rewardId, 'reward')
          break
        case 'roster':
          registry.requireRoster(node.rosterId)
          break
        case 'branch':
          for (const route of node.routes) {
            registry.requireCondition(route.conditionId)
          }
          break
        default:
          break
      }
    }

    const reachable = new Set<string>()
    const pending = [campaign.entryNodeId]
    while (pending.length > 0) {
      const nodeId = pending.pop() as string
      if (reachable.has(nodeId)) continue
      const node = required(nodes, nodeId, 'node')
      reachable.add(nodeId)
      pending.push(...nextNodeIds(node))
    }
    if (reachable.size !== nodes.size) {
      fail(
        'PVE_SNAPSHOT_REFERENCE_INVALID',
        'Campaign contains unreachable nodes',
        { campaignId: campaign.campaignId },
      )
    }
    nodesByCampaign.set(campaign.campaignId, nodes)
  }

  for (const [path, file] of nodeFiles) {
    if (!referencedNodePaths.has(path)) {
      fail(
        'PVE_SNAPSHOT_REFERENCE_INVALID',
        'PVE node is not owned by a Campaign',
        { path, nodeId: (file.document as { value: PveFlowNodeV1 }).value.nodeId },
      )
    }
  }

  const api: PveContentSnapshotV1 = {
    authorityContentHash: snapshot.profile.authorityContentHash,
    resolvedProfileHash: snapshot.profile.resolvedProfileHash,
    registry,
    listCampaigns() {
      return Object.freeze([...campaigns.values()])
    },
    getCampaign(campaignId) {
      return required(campaigns, campaignId, 'campaign')
    },
    getNode(campaignId, nodeId) {
      return required(
        required(nodesByCampaign, campaignId, 'campaign nodes'),
        nodeId,
        'node',
      )
    },
    getChapter(chapterId) {
      return required(chapters, chapterId, 'chapter')
    },
    getEncounter(encounterId) {
      return required(encounters, encounterId, 'encounter')
    },
    getEnemySetup(enemySetupId) {
      return required(enemies, enemySetupId, 'enemy')
    },
    getEvent(eventId) {
      return required(events, eventId, 'event')
    },
    getReward(rewardId) {
      return required(rewards, rewardId, 'reward')
    },
    getRelic(relicId) {
      return required(relics, relicId, 'relic')
    },
  }
  return Object.freeze(api)
}
