import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ZodTypeAny } from 'zod'
import { describe, expect, it } from 'vitest'

import { PackJsonPayloadPathV1Schema } from '@/lib/content-pipeline/contracts'
import {
  PveActiveBattleReferenceV1Schema,
  PveCampaignV1Schema,
  PveChapterV1Schema,
  PveCheckpointV1Schema,
  PveContentManifestV1Schema,
  PveEncounterV1Schema,
  PveEnemySetupV1Schema,
  PveEventV1Schema,
  PveFlowNodeV1Schema,
  PveJsonDocumentPathV1Schema,
  PveRelicV1Schema,
  PveRewardV1Schema,
  PveRunV1Schema,
} from '@/lib/pve/contracts'

const fixtureRoot = join(process.cwd(), 'tests/pve/fixtures/contracts/v1')

function readFixture(...parts: string[]): unknown {
  return JSON.parse(readFileSync(join(fixtureRoot, ...parts), 'utf8')) as unknown
}

const validContentFixtures: Array<[string, ZodTypeAny]> = [
  ['content-manifest.json', PveContentManifestV1Schema],
  ['campaign.json', PveCampaignV1Schema],
  ['chapter.json', PveChapterV1Schema],
  ['encounter.json', PveEncounterV1Schema],
  ['event.json', PveEventV1Schema],
  ['reward.json', PveRewardV1Schema],
  ['relic.json', PveRelicV1Schema],
  ['enemy.json', PveEnemySetupV1Schema],
]

const validNodeFixtures = [
  'story-node.json',
  'roster-node.json',
  'battle-node.json',
  'event-node.json',
  'reward-node.json',
  'branch-node.json',
  'checkpoint-node.json',
  'end-node.json',
]

describe('PVE v1 content contracts', () => {
  it('aliases the shared Pack JSON payload path schema', () => {
    expect(PveJsonDocumentPathV1Schema).toBe(PackJsonPayloadPathV1Schema)
  })

  it.each(validContentFixtures)('accepts %s', (fixtureName, schema) => {
    expect(schema.safeParse(readFixture('valid', fixtureName)).success).toBe(true)
  })

  it.each(validNodeFixtures)('accepts %s', fixtureName => {
    expect(
      PveFlowNodeV1Schema.safeParse(readFixture('valid', fixtureName)).success,
    ).toBe(true)
  })

  it('rejects duplicate node IDs with a stable local error path', () => {
    const result = PveCampaignV1Schema.safeParse(
      readFixture('invalid', 'duplicate-campaign-node.json'),
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['nodes', 1, 'nodeId'] }),
        ]),
      )
    }
  })

  it('requires Campaign entryNodeId to name a local node descriptor', () => {
    const campaign = {
      ...(readFixture('valid', 'campaign.json') as Record<string, unknown>),
      entryNodeId: 'missing-entry',
    }
    const result = PveCampaignV1Schema.safeParse(campaign)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['entryNodeId'] }),
        ]),
      )
    }
  })

  it.each([
    [
      'content manifest image path',
      'content-manifest-image-path.json',
      PveContentManifestV1Schema,
      ['documents', 0, 'path'],
    ],
    [
      'Campaign node image path',
      'campaign-image-node-path.json',
      PveCampaignV1Schema,
      ['nodes', 0, 'path'],
    ],
    [
      'content manifest JSON outside data',
      'content-manifest-outside-data-json-path.json',
      PveContentManifestV1Schema,
      ['documents', 0, 'path'],
    ],
    [
      'content manifest root JSON',
      'content-manifest-root-json-path.json',
      PveContentManifestV1Schema,
      ['documents', 0, 'path'],
    ],
    [
      'Campaign empty JSON basename',
      'campaign-empty-json-name-path.json',
      PveCampaignV1Schema,
      ['nodes', 0, 'path'],
    ],
    [
      'Campaign nested empty JSON basename',
      'campaign-nested-empty-json-name-path.json',
      PveCampaignV1Schema,
      ['nodes', 0, 'path'],
    ],
  ] as Array<[string, string, ZodTypeAny, Array<string | number>]>) (
    'rejects %s because PVE document paths must match data/**/*.json',
    (_caseName, fixtureName, schema, expectedPath) => {
      const result = schema.safeParse(readFixture('invalid', fixtureName))
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: expectedPath }),
          ]),
        )
      }
    },
  )

  it('requires canonical ordering for content descriptors', () => {
    const manifest = structuredClone(
      readFixture('valid', 'content-manifest.json'),
    ) as Record<string, unknown> & { documents: unknown[] }

    manifest.documents.reverse()
    expect(PveContentManifestV1Schema.safeParse(manifest).success).toBe(false)
  })

  it('requires canonical ordering for Campaign node descriptors', () => {
    const campaign = structuredClone(
      readFixture('valid', 'campaign.json'),
    ) as Record<string, unknown> & { nodes: unknown[] }

    campaign.nodes.reverse()
    expect(PveCampaignV1Schema.safeParse(campaign).success).toBe(false)
  })

  it('requires canonical ordering for event outcome routes', () => {
    const node = structuredClone(
      readFixture('valid', 'event-node.json'),
    ) as Record<string, unknown> & { outcomes: unknown[] }

    node.outcomes.reverse()
    expect(PveFlowNodeV1Schema.safeParse(node).success).toBe(false)
  })

  it.each([
    ['unknown node type', 'unknown-node.json'],
    ['unknown node field', 'unknown-field.json'],
    ['branch expression', 'branch-expression.json'],
    ['inline node effect', 'inline-effect.json'],
    ['inline node code', 'inline-code.json'],
  ])('fails closed for %s', (_caseName, fixtureName) => {
    expect(
      PveFlowNodeV1Schema.safeParse(readFixture('invalid', fixtureName)).success,
    ).toBe(false)
  })

  it.each([
    ['unknown chapter field', 'chapter-unknown-field.json', PveChapterV1Schema],
    ['inline encounter enemy', 'encounter-inline-enemy.json', PveEncounterV1Schema],
    ['inline event effect', 'event-inline-effect.json', PveEventV1Schema],
    ['inline reward effect', 'reward-inline-effect.json', PveRewardV1Schema],
    ['inline relic hook/code', 'relic-inline-hook-code.json', PveRelicV1Schema],
  ] as Array<[string, string, ZodTypeAny]>) (
    'rejects %s',
    (_caseName, fixtureName, schema) => {
      expect(schema.safeParse(readFixture('invalid', fixtureName)).success).toBe(
        false,
      )
    },
  )
})

describe('PVE v1 run contract', () => {
  it('accepts an authority-pinned run without wall-clock identity fields', () => {
    const fixture = readFixture('valid', 'run.json')
    const result = PveRunV1Schema.safeParse(fixture)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).not.toHaveProperty('createdAt')
      expect(result.data).not.toHaveProperty('updatedAt')
      expect(result.data.authorityContentHash).toBe('a'.repeat(64))
      expect(result.data.checkpoint.authorityContentHash).toBe(
        result.data.authorityContentHash,
      )
    }
  })

  it('allows non-receipt revisions between exactly-once receipts', () => {
    const run = structuredClone(
      readFixture('valid', 'run.json'),
    ) as Record<string, unknown> & {
      receipts: Array<Record<string, unknown>>
    }

    run.revision = 3
    run.receipts[1].fromRevision = 2
    run.receipts[1].toRevision = 3

    expect(PveRunV1Schema.safeParse(run).success).toBe(true)
  })

  it('accepts active battle references pinned to the same authority content', () => {
    const run = structuredClone(
      readFixture('valid', 'run.json'),
    ) as Record<string, unknown> & { checkpoint: Record<string, unknown> }
    const activeBattle = {
      schemaVersion: 'rvb-pve-active-battle/v1',
      authorityContentHash: 'a'.repeat(64),
      battleId: 'battle-001',
      sourceNodeId: 'ambush',
      encounterId: 'prototype-ambush',
      stateHash: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    }

    run.activeBattle = activeBattle
    run.checkpoint.activeBattle = structuredClone(activeBattle)

    const result = PveRunV1Schema.safeParse(run)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.activeBattle?.authorityContentHash).toBe(
        result.data.authorityContentHash,
      )
      expect(result.data.checkpoint.activeBattle?.authorityContentHash).toBe(
        result.data.authorityContentHash,
      )
    }
  })

  it('strictly rejects legacy full Profile and campaign package hash fields', () => {
    const fixture = readFixture('valid', 'run.json') as Record<string, unknown>
    const result = PveRunV1Schema.safeParse({
      ...fixture,
      resolvedProfileHash: 'b'.repeat(64),
      campaignPackageHash: 'c'.repeat(64),
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues.find(item => item.code === 'unrecognized_keys')
      expect(issue).toEqual(
        expect.objectContaining({
          code: 'unrecognized_keys',
          keys: expect.arrayContaining(['resolvedProfileHash', 'campaignPackageHash']),
        }),
      )
    }
  })

  it('requires a valid authorityContentHash on all three state envelopes', () => {
    const run = readFixture('valid', 'run.json') as Record<string, unknown> & {
      checkpoint: Record<string, unknown>
    }
    const activeBattle: Record<string, unknown> = {
      schemaVersion: 'rvb-pve-active-battle/v1',
      authorityContentHash: 'a'.repeat(64),
      battleId: 'battle-001',
      sourceNodeId: 'ambush',
      encounterId: 'prototype-ambush',
      stateHash: '1'.repeat(64),
    }
    const cases: Array<[ZodTypeAny, Record<string, unknown>]> = [
      [PveRunV1Schema, run],
      [PveCheckpointV1Schema, run.checkpoint],
      [PveActiveBattleReferenceV1Schema, activeBattle],
    ]

    for (const [schema, value] of cases) {
      const missing = structuredClone(value)
      delete missing.authorityContentHash
      const invalid = { ...value, authorityContentHash: 'not-a-sha256' }
      for (const candidate of [missing, invalid]) {
        const result = schema.safeParse(candidate)
        expect(
          result.success
            ? []
            : result.error.issues.map(issue => issue.path.join('.')),
        ).toContain('authorityContentHash')
      }
    }
  })

  it('rejects authority hash mismatches at stable parent paths', () => {
    const fixture = readFixture('valid', 'run.json') as Record<string, unknown> & {
      checkpoint: Record<string, unknown>
    }
    const otherAuthorityHash = 'b'.repeat(64)
    const mismatchedBattle = {
      schemaVersion: 'rvb-pve-active-battle/v1',
      authorityContentHash: otherAuthorityHash,
      battleId: 'battle-001',
      sourceNodeId: 'ambush',
      encounterId: 'prototype-ambush',
      stateHash: '1'.repeat(64),
    }
    const checkpointMismatch = structuredClone(fixture)
    checkpointMismatch.checkpoint.authorityContentHash = otherAuthorityHash
    const runBattleMismatch = structuredClone(fixture)
    runBattleMismatch.activeBattle = mismatchedBattle
    const checkpointBattleMismatch = structuredClone(fixture.checkpoint)
    checkpointBattleMismatch.activeBattle = mismatchedBattle

    const cases: Array<[ZodTypeAny, unknown, string]> = [
      [PveRunV1Schema, checkpointMismatch, 'checkpoint.authorityContentHash'],
      [PveRunV1Schema, runBattleMismatch, 'activeBattle.authorityContentHash'],
      [
        PveCheckpointV1Schema,
        checkpointBattleMismatch,
        'activeBattle.authorityContentHash',
      ],
    ]

    for (const [schema, value, expectedPath] of cases) {
      const result = schema.safeParse(value)
      expect(
        result.success
          ? []
          : result.error.issues.map(issue => issue.path.join('.')),
      ).toContain(expectedPath)
    }
  })

  it('rejects duplicate command receipts for exactly-once replay', () => {
    const result = PveRunV1Schema.safeParse(
      readFixture('invalid', 'duplicate-receipt-run.json'),
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['receipts', 1, 'commandId'],
          }),
        ]),
      )
    }
  })

  it('rejects a checkpoint receiptCount that includes later receipts', () => {
    const result = PveRunV1Schema.safeParse(
      readFixture('invalid', 'checkpoint-receipt-prefix-run.json'),
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['checkpoint', 'receiptCount'],
          }),
        ]),
      )
    }
  })

  it('rejects overlapping receipt revisions', () => {
    const run = structuredClone(
      readFixture('valid', 'run.json'),
    ) as Record<string, unknown> & {
      receipts: Array<Record<string, unknown>>
    }

    run.receipts[1].fromRevision = 0
    run.receipts[1].toRevision = 1

    const result = PveRunV1Schema.safeParse(run)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['receipts', 1, 'fromRevision'] }),
        ]),
      )
    }
  })

  it('rejects unsafe integer revisions', () => {
    const run = {
      ...(readFixture('valid', 'run.json') as Record<string, unknown>),
      revision: Number.MAX_SAFE_INTEGER + 1,
    }

    expect(PveRunV1Schema.safeParse(run).success).toBe(false)
  })

  it('rejects wall-clock and other unknown run fields', () => {
    const fixture = readFixture('valid', 'run.json')
    const result = PveRunV1Schema.safeParse({
      ...(fixture as Record<string, unknown>),
      createdAt: 1_700_000_000_000,
    })

    expect(result.success).toBe(false)
  })
})
