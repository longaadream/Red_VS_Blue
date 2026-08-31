import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ResolvedSnapshotViewV1 } from '@/lib/content-pipeline/core/resolver'
import {
  createPveContentSnapshotV1,
  PveContentSnapshotErrorV1,
} from '@/lib/pve/content-snapshot'
import {
  createPveRuntimeRegistryV1,
  PveRuntimeRegistryErrorV1,
  type PveRuntimeRegistryInputV1,
} from '@/lib/pve/runtime-registry'

const AUTHORITY_HASH = 'a'.repeat(64)
const PROFILE_HASH = 'b'.repeat(64)
const encoder = new TextEncoder()

type JsonDocuments = Record<string, unknown>

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function loadDocuments(): JsonDocuments {
  const root = process.cwd()
  const read = (relativePath: string): unknown => JSON.parse(
    readFileSync(path.join(root, relativePath), 'utf8'),
  ) as unknown
  const manifestPath = 'data/pve/manifest.json'
  const manifest = read(manifestPath) as {
    documents: Array<{ kind: string; contentId: string; path: string }>
  }
  const documents: JsonDocuments = { [manifestPath]: manifest }
  for (const descriptor of manifest.documents) {
    documents[descriptor.path] = read(descriptor.path)
  }

  const campaignPath = manifest.documents.find(item =>
    item.kind === 'campaign')!.path
  const campaign = documents[campaignPath] as {
    nodes: Array<{ nodeId: string; path: string }>
  }
  for (const descriptor of campaign.nodes) {
    documents[descriptor.path] = read(descriptor.path)
  }

  const branchPath =
    'data/pve/campaigns/prototype/nodes/battle-gate.json'
  campaign.nodes.push({ nodeId: 'battle-gate', path: branchPath })
  campaign.nodes.sort((left, right) => compareAscii(left.nodeId, right.nodeId))
  documents[branchPath] = {
    schemaVersion: 'rvb-pve-node/v1',
    nodeId: 'battle-gate',
    type: 'branch',
    routes: [{
      conditionId: 'prototype-take-battle',
      nextNodeId: 'ambush',
    }],
    fallbackNodeId: 'ambush',
  }
  const eventNode = documents[
    'data/pve/campaigns/prototype/nodes/campfire.json'
  ] as { outcomes: Array<{ nextNodeId: string }> }
  eventNode.outcomes.forEach(outcome => {
    outcome.nextNodeId = 'battle-gate'
  })

  const relicPath = 'data/pve/relics/prototype-compass.json'
  manifest.documents.push({
    kind: 'relic',
    contentId: 'prototype-compass',
    path: relicPath,
  })
  manifest.documents.sort((left, right) => {
    const kindOrder = compareAscii(left.kind, right.kind)
    return kindOrder || compareAscii(left.contentId, right.contentId)
  })
  documents[relicPath] = {
    schemaVersion: 'rvb-pve-relic/v1',
    relicId: 'prototype-compass',
    rarityId: 'common',
    nameTextId: 'prototype-compass-name',
    descriptionTextId: 'prototype-compass-description',
    effectIds: ['prototype-relic-effect'],
  }
  return documents
}

function createView(
  documents: JsonDocuments,
  missingPath?: string,
  rawOverrides: Readonly<Record<string, string>> = {},
): { view: ResolvedSnapshotViewV1; reads: string[] } {
  const bytes = new Map(Object.entries(documents).map(([filePath, value]) => [
    filePath,
    encoder.encode(rawOverrides[filePath] ?? JSON.stringify(value)),
  ]))
  const reads: string[] = []
  const view = {
    files: [...bytes.entries()]
      .map(([filePath, value]) => ({
        path: filePath,
        mediaType: 'application/json' as const,
        size: value.byteLength,
        sha256: 'c'.repeat(64),
      }))
      .sort((left, right) => compareAscii(left.path, right.path)),
    readFile(filePath: string) {
      reads.push(filePath)
      if (filePath === missingPath) return undefined
      return bytes.get(filePath)?.slice()
    },
    hasExecutableContent() {
      return false
    },
    profile: {
      authorityContentHash: AUTHORITY_HASH,
      resolvedProfileHash: PROFILE_HASH,
    },
    authorityContentIdentity: {},
    networkEligible: true,
  } as unknown as ResolvedSnapshotViewV1
  return { view, reads }
}

function registryInput(): {
  maps: string[]
  objectives: string[]
  rosters: Array<{
    rosterId: string
    pieceIds: string[]
    initialDeck?: string[]
  }>
  aiProfiles: string[]
  effects: Array<{
    effectId: string
    apply: PveRuntimeRegistryInputV1['effects'] extends
      readonly (infer T)[] | undefined
        ? T extends { apply: infer A } ? A : never
        : never
  }>
  rewardTables: Array<{ rewardTableId: string; subjectIds: string[] }>
  conditions: Array<{ conditionId: string; evaluate: () => boolean }>
} {
  return {
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
        apply: () => ({ flags: { prepared: true } }),
      },
      {
        effectId: 'prototype-grant-card-reward',
        apply: (run, context) => ({
          deck: [...run.deck, context.subjectId],
        }),
      },
      {
        effectId: 'prototype-relic-effect',
        apply: () => ({}),
      },
    ],
    rewardTables: [{
      rewardTableId: 'prototype-card-reward-table',
      subjectIds: ['basic-strike', 'basic-guard'],
    }],
    conditions: [{
      conditionId: 'prototype-take-battle',
      evaluate: () => true,
    }],
  }
}

function createRegistry(input = registryInput()) {
  return createPveRuntimeRegistryV1(input)
}

describe('RED-117 PVE content snapshot', () => {
  it('strictly indexes all eight node kinds from only the verified view', () => {
    const documents = loadDocuments()
    const { view, reads } = createView(documents)
    const snapshot = createPveContentSnapshotV1(view, createRegistry())

    expect(snapshot.authorityContentHash).toBe(AUTHORITY_HASH)
    expect(snapshot.resolvedProfileHash).toBe(PROFILE_HASH)
    expect(snapshot.listCampaigns().map(item => item.campaignId)).toEqual([
      'prototype-campaign',
    ])
    expect(new Set(snapshot.getCampaign('prototype-campaign').nodes.map(node =>
      snapshot.getNode('prototype-campaign', node.nodeId).type))).toEqual(
      new Set([
        'story',
        'roster',
        'battle',
        'event',
        'reward',
        'branch',
        'checkpoint',
        'end',
      ]),
    )
    expect(reads.sort(compareAscii)).toEqual(
      Object.keys(documents).sort(compareAscii),
    )
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.getEvent('prototype-campfire'))).toBe(true)
  })

  it.each([
    ['map', (input: ReturnType<typeof registryInput>) => { input.maps = [] }],
    ['objective', (input: ReturnType<typeof registryInput>) => {
      input.objectives = []
    }],
    ['roster', (input: ReturnType<typeof registryInput>) => {
      input.rosters = input.rosters.filter(item =>
        item.rosterId !== 'prototype-player-roster')
    }],
    ['ai-profile', (input: ReturnType<typeof registryInput>) => {
      input.aiProfiles = []
    }],
    ['effect', (input: ReturnType<typeof registryInput>) => {
      input.effects = input.effects.filter(item =>
        item.effectId !== 'prototype-heal-party-small')
    }],
    ['reward-table', (input: ReturnType<typeof registryInput>) => {
      input.rewardTables = []
    }],
    ['condition', (input: ReturnType<typeof registryInput>) => {
      input.conditions = []
    }],
  ] as const)('fails closed for an unregistered %s ID', (kind, remove) => {
    const input = registryInput()
    remove(input)
    const { view } = createView(loadDocuments())

    try {
      createPveContentSnapshotV1(view, createRegistry(input))
      throw new Error('Expected registry reference validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(PveRuntimeRegistryErrorV1)
      expect((error as PveRuntimeRegistryErrorV1).code).toBe(
        'PVE_REGISTRY_REFERENCE_MISSING',
      )
      expect((error as PveRuntimeRegistryErrorV1).context.kind).toBe(kind)
    }
  })

  it('rejects strict-schema drift, missing bytes, and broken graph closure', () => {
    const withLegacyField = loadDocuments()
    ;(withLegacyField[
      'data/pve/campaigns/prototype/nodes/intro.json'
    ] as Record<string, unknown>).legacyEffect = 'unsafe'
    expect(() => createPveContentSnapshotV1(
      createView(withLegacyField).view,
      createRegistry(),
    )).toThrowError(expect.objectContaining({
      code: 'PVE_SNAPSHOT_SCHEMA_INVALID',
    }))

    const brokenClosure = loadDocuments()
    ;(brokenClosure[
      'data/pve/campaigns/prototype/nodes/intro.json'
    ] as Record<string, unknown>).nextNodeId = 'missing-node'
    expect(() => createPveContentSnapshotV1(
      createView(brokenClosure).view,
      createRegistry(),
    )).toThrowError(expect.objectContaining({
      code: 'PVE_SNAPSHOT_REFERENCE_INVALID',
    }))

    const documents = loadDocuments()
    const missingPath = 'data/pve/events/prototype-campfire.json'
    expect(() => createPveContentSnapshotV1(
      createView(documents, missingPath).view,
      createRegistry(),
    )).toThrowError(expect.objectContaining({
      code: 'PVE_SNAPSHOT_FILE_MISSING',
    }))

    const duplicateKeyPath =
      'data/pve/campaigns/prototype/nodes/intro.json'
    expect(() => createPveContentSnapshotV1(
      createView(loadDocuments(), undefined, {
        [duplicateKeyPath]: '{"schemaVersion":"rvb-pve-node/v1",'
          + '"nodeId":"intro","nodeId":"forged-intro",'
          + '"type":"story","storyId":"prototype-intro",'
          + '"nextNodeId":"campfire"}',
      }).view,
      createRegistry(),
    )).toThrowError(expect.objectContaining({
      code: 'PVE_SNAPSHOT_SCHEMA_INVALID',
    }))
  })

  it('seals and snapshots registry data while allowing duplicate deck cards', () => {
    const input = registryInput()
    let receivedFrozenRun = false
    input.effects[0] = {
      effectId: 'prototype-heal-party-small',
      apply: run => {
        receivedFrozenRun = Object.isFrozen(run)
          && Object.isFrozen(run.deck)
        return { flags: { healed: true } }
      },
    }
    const registry = createRegistry(input)
    input.maps.length = 0
    input.rosters[0].pieceIds.push('red-three')

    expect(() => registry.requireMap('large-hole-arena')).not.toThrow()
    expect(registry.requireRoster('prototype-player-roster')).toEqual({
      rosterId: 'prototype-player-roster',
      pieceIds: ['red-one', 'red-two'],
      initialDeck: ['basic-strike', 'basic-strike'],
    })
    expect(Object.isFrozen(registry)).toBe(true)
    expect((registry as Record<string, unknown>).register).toBeUndefined()

    const patch = registry.applyEffect(
      'prototype-heal-party-small',
      {
        schemaVersion: 'rvb-pve-run/v1',
        runId: 'test-run',
        campaignId: 'prototype-campaign',
        rootSeed: 117,
        revision: 0,
        authorityContentHash: AUTHORITY_HASH,
        currentNodeId: 'choose-roster',
        party: [],
        deck: [],
        relics: [],
        flags: {},
        activeBattle: null,
        checkpoint: {
          schemaVersion: 'rvb-pve-checkpoint/v1',
          checkpointId: 'run-start',
          revision: 0,
          authorityContentHash: AUTHORITY_HASH,
          currentNodeId: 'choose-roster',
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
      },
      {
        kind: 'event',
        sourceNodeId: 'campfire',
        subjectId: 'rest',
      },
    )
    expect(receivedFrozenRun).toBe(true)
    expect(patch).toEqual({ flags: { healed: true } })
    expect(Object.isFrozen(patch)).toBe(true)
  })

  it('rejects unregistered content documents instead of silently indexing them', () => {
    const documents = loadDocuments()
    const manifest = documents['data/pve/manifest.json'] as {
      documents: Array<{ contentId: string }>
    }
    manifest.documents = manifest.documents.filter(item =>
      item.contentId !== 'prototype-compass')

    expect(() => createPveContentSnapshotV1(
      createView(documents).view,
      createRegistry(),
    )).toThrowError(PveContentSnapshotErrorV1)
  })
})
