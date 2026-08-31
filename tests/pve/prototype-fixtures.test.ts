import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import type { ZodTypeAny } from 'zod'
import { describe, expect, it } from 'vitest'

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
  type PveFlowNodeV1,
} from '@/lib/pve/contracts'

const repositoryRoot = process.cwd()
const pveRoot = path.join(repositoryRoot, 'data', 'pve')

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(path.join(repositoryRoot, relativePath), 'utf8')) as unknown
}

function listJsonFiles(directory: string): string[] {
  const result: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      result.push(...listJsonFiles(absolute))
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      result.push(path.relative(repositoryRoot, absolute).split(path.sep).join('/'))
    }
  }
  return result.sort()
}

const contentSchemas: Record<string, ZodTypeAny> = {
  campaign: PveCampaignV1Schema,
  chapter: PveChapterV1Schema,
  encounter: PveEncounterV1Schema,
  enemy: PveEnemySetupV1Schema,
  event: PveEventV1Schema,
  relic: PveRelicV1Schema,
  reward: PveRewardV1Schema,
}

function contentDocumentId(kind: string, value: Record<string, unknown>): unknown {
  switch (kind) {
    case 'campaign': return value.campaignId
    case 'chapter': return value.chapterId
    case 'encounter': return value.encounterId
    case 'enemy': return value.enemySetupId
    case 'event': return value.eventId
    case 'relic': return value.relicId
    case 'reward': return value.rewardId
    default: return undefined
  }
}

function nextNodeIds(node: PveFlowNodeV1): string[] {
  switch (node.type) {
    case 'story':
    case 'roster':
    case 'reward':
    case 'checkpoint':
      return [node.nextNodeId]
    case 'battle':
      return [node.victoryNodeId, node.defeatNodeId, node.drawNodeId]
    case 'event':
      return node.outcomes.map(outcome => outcome.nextNodeId)
    case 'branch':
      return [...node.routes.map(route => route.nextNodeId), node.fallbackNodeId]
    case 'end':
      return []
  }
}

function collectObjectKeys(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach(item => collectObjectKeys(item, keys))
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    keys.add(key)
    collectObjectKeys(nested, keys)
  }
}

describe('RED-117 strict Prototype fixtures', () => {
  it('contains only versioned PVE v1 JSON without legacy inline rule fields', () => {
    const files = listJsonFiles(pveRoot)
    expect(files).toEqual([
      'data/pve/campaigns/prototype/campaign.json',
      'data/pve/campaigns/prototype/nodes/ambush.json',
      'data/pve/campaigns/prototype/nodes/campfire.json',
      'data/pve/campaigns/prototype/nodes/choose-roster.json',
      'data/pve/campaigns/prototype/nodes/defeat-ending.json',
      'data/pve/campaigns/prototype/nodes/draw-ending.json',
      'data/pve/campaigns/prototype/nodes/intro.json',
      'data/pve/campaigns/prototype/nodes/safe-room.json',
      'data/pve/campaigns/prototype/nodes/spoils.json',
      'data/pve/campaigns/prototype/nodes/victory-ending.json',
      'data/pve/chapters/prototype-chapter.json',
      'data/pve/encounters/prototype-encounter-1.json',
      'data/pve/enemies/prototype-bandits.json',
      'data/pve/events/prototype-campfire.json',
      'data/pve/manifest.json',
      'data/pve/rewards/prototype-card-choice.json',
    ])

    const keys = new Set<string>()
    for (const file of files) {
      const value = readJson(file) as Record<string, unknown>
      expect(value.schemaVersion, file).toMatch(/^rvb-pve-.+\/v1$/)
      collectObjectKeys(value, keys)
    }
    for (const forbidden of [
      'effect',
      'hooks',
      'pools',
      'pieces',
      'rewards',
      'winCondition',
      'enemyTeamId',
      'aiProfile',
    ]) {
      expect(keys.has(forbidden), forbidden).toBe(false)
    }
  })

  it('registers every strict content document once with canonical order and identity', () => {
    const manifest = PveContentManifestV1Schema.parse(
      readJson('data/pve/manifest.json'),
    )
    expect(manifest.manifestId).toBe('prototype-pve')
    expect(manifest.documents.map(document => document.kind)).toEqual([
      'campaign',
      'chapter',
      'encounter',
      'enemy',
      'event',
      'reward',
    ])

    for (const descriptor of manifest.documents) {
      const value = contentSchemas[descriptor.kind].parse(
        readJson(descriptor.path),
      ) as Record<string, unknown>
      expect(contentDocumentId(descriptor.kind, value)).toBe(descriptor.contentId)
    }
  })

  it('closes the declared graph and preserves the exact playable main path', () => {
    const campaign = PveCampaignV1Schema.parse(
      readJson('data/pve/campaigns/prototype/campaign.json'),
    )
    const nodes = new Map<string, PveFlowNodeV1>()
    for (const descriptor of campaign.nodes) {
      const node = PveFlowNodeV1Schema.parse(readJson(descriptor.path))
      expect(node.nodeId).toBe(descriptor.nodeId)
      nodes.set(node.nodeId, node)
    }

    for (const node of nodes.values()) {
      for (const nextNodeId of nextNodeIds(node)) {
        expect(nodes.has(nextNodeId), node.nodeId + ' -> ' + nextNodeId).toBe(true)
      }
    }

    const reachable = new Set<string>()
    const pending = [campaign.entryNodeId]
    while (pending.length > 0) {
      const nodeId = pending.pop()!
      if (reachable.has(nodeId)) continue
      reachable.add(nodeId)
      pending.push(...nextNodeIds(nodes.get(nodeId)!))
    }
    expect(reachable.size).toBe(nodes.size)

    expect(campaign.entryNodeId).toBe('choose-roster')
    expect(nodes.get('choose-roster')).toMatchObject({
      type: 'roster',
      nextNodeId: 'intro',
    })
    expect(nodes.get('intro')).toMatchObject({
      type: 'story',
      nextNodeId: 'campfire',
    })
    expect(nodes.get('campfire')).toMatchObject({
      type: 'event',
      outcomes: [
        { outcomeId: 'prepared', nextNodeId: 'ambush' },
        { outcomeId: 'rested', nextNodeId: 'ambush' },
      ],
    })
    expect(nodes.get('ambush')).toMatchObject({
      type: 'battle',
      victoryNodeId: 'spoils',
      defeatNodeId: 'defeat-ending',
      drawNodeId: 'draw-ending',
    })
    expect(nodes.get('spoils')).toMatchObject({
      type: 'reward',
      nextNodeId: 'safe-room',
    })
    expect(nodes.get('safe-room')).toMatchObject({
      type: 'checkpoint',
      nextNodeId: 'victory-ending',
    })
    expect(nodes.get('victory-ending')).toMatchObject({
      type: 'end',
      outcome: 'completed',
    })
    expect(nodes.get('defeat-ending')).toMatchObject({
      type: 'end',
      outcome: 'failed',
    })
    expect(nodes.get('draw-ending')).toMatchObject({
      type: 'end',
      outcome: 'failed',
    })
  })

  it('uses only the sealed Prototype registry IDs', () => {
    expect(PveFlowNodeV1Schema.parse(
      readJson('data/pve/campaigns/prototype/nodes/choose-roster.json'),
    )).toMatchObject({
      rosterId: 'prototype-player-roster',
    })

    expect(PveEncounterV1Schema.parse(
      readJson('data/pve/encounters/prototype-encounter-1.json'),
    )).toEqual({
      schemaVersion: 'rvb-pve-encounter/v1',
      encounterId: 'prototype-encounter-1',
      mapId: 'large-hole-arena',
      enemySetupId: 'prototype-bandits',
      objectiveId: 'defeat-all-enemies',
    })

    expect(PveEnemySetupV1Schema.parse(
      readJson('data/pve/enemies/prototype-bandits.json'),
    )).toMatchObject({
      rosterId: 'prototype-enemy-roster',
      aiProfileId: 'prototype-basic-ai',
    })

    const event = PveEventV1Schema.parse(
      readJson('data/pve/events/prototype-campfire.json'),
    )
    expect(event.choices.map(choice => choice.effectId)).toEqual([
      'prototype-heal-party-small',
      'prototype-prepare-party',
    ])

    expect(PveRewardV1Schema.parse(
      readJson('data/pve/rewards/prototype-card-choice.json'),
    )).toMatchObject({
      rewardTableId: 'prototype-card-reward-table',
      grantEffectId: 'prototype-grant-card-reward',
    })
  })
})
