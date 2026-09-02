import { beforeEach, describe, expect, it, vi } from 'vitest'

const service = vi.hoisted(() => ({
  catalog: vi.fn(),
  createRun: vi.fn(),
  getRun: vi.fn(),
  execute: vi.fn(),
}))

vi.mock('@/lib/pve/service', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/pve/service')>()
  return { ...actual, getPveServiceV1: () => service }
})

import { GET as getCatalog } from '@/app/api/pve/route'
import { POST as createRun } from '@/app/api/pve/runs/route'
import { GET as getRun } from '@/app/api/pve/runs/[runId]/route'
import { POST as execute } from '@/app/api/pve/runs/[runId]/commands/route'
import { ProfileStoreErrorV1 } from '@/lib/content-pipeline/runtime/profile-store'
import { PveRunStoreErrorV1 } from '@/lib/pve/run-store'
import { PveServiceErrorV1 } from '@/lib/pve/service'

const result = {
  view: {
    runId: 'api-run',
    campaignId: 'prototype-campaign',
    authorityContentHash: 'a'.repeat(64),
    revision: 0,
    node: { nodeId: 'choose-roster', type: 'roster', rosterId: 'prototype-player-roster' },
    battle: null,
    legalCommands: [{ type: 'roster-select', label: 'confirm' }],
  },
  transition: {
    schemaVersion: 'rvb-pve-transition/v1',
    commandId: null,
    duplicate: false,
    fromRevision: 0,
    toRevision: 0,
    fromNodeId: 'choose-roster',
    toNodeId: 'choose-roster',
    steps: [],
    receiptDrafts: [],
    transitionHash: 'b'.repeat(64),
  },
  duplicate: false,
}

describe('RED-117 PVE Route Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    service.catalog.mockReturnValue({ campaigns: [] })
    service.createRun.mockReturnValue(result)
    service.getRun.mockReturnValue(result)
    service.execute.mockResolvedValue(result)
  })

  it('serves the Snapshot catalog and creates a Run with 201/no-store', async () => {
    const catalog = await getCatalog()
    const created = await createRun(new Request('http://local/api/pve/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId: 'prototype-campaign' }),
    }))

    expect(catalog.status).toBe(200)
    expect(catalog.headers.get('cache-control')).toBe('no-store')
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual(result.view)
    expect(service.createRun).toHaveBeenCalledWith('prototype-campaign')
  })

  it('awaits Next 16 dynamic params for read and command routes', async () => {
    const read = await getRun(
      new Request('http://local/api/pve/runs/api-run'),
      { params: Promise.resolve({ runId: 'api-run' }) },
    )
    const body = {
      schemaVersion: 'rvb-pve-command/v1',
      runId: 'api-run',
      commandId: 'api-command',
      expectedRevision: 0,
      type: 'roster-select',
    }
    const advanced = await execute(
      new Request('http://local/api/pve/runs/api-run/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ runId: 'api-run' }) },
    )

    expect(read.status).toBe(200)
    expect(advanced.status).toBe(200)
    expect(await read.json()).toEqual(result.view)
    const publicCommandResponse = await advanced.json()
    expect(publicCommandResponse).toEqual(result.view)
    expect(publicCommandResponse).not.toHaveProperty('transition')
    expect(publicCommandResponse).not.toHaveProperty('battleAudit')
    expect(service.getRun).toHaveBeenCalledWith('api-run')
    expect(service.execute).toHaveBeenCalledWith('api-run', body)
  })

  it('strictly rejects malformed create bodies and maps 404/409 service errors', async () => {
    const malformed = await createRun(new Request('http://local/api/pve/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId: 'prototype-campaign', seed: 7 }),
    }))
    const duplicateKey = await createRun(new Request('http://local/api/pve/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"campaignId":"prototype-campaign","campaignId":"shadow"}',
    }))
    service.getRun.mockImplementationOnce(() => {
      throw new PveServiceErrorV1('PVE_RUN_NOT_FOUND', 'missing', 404)
    })
    const missing = await getRun(
      new Request('http://local/api/pve/runs/missing'),
      { params: Promise.resolve({ runId: 'missing' }) },
    )
    service.execute.mockRejectedValueOnce(new PveServiceErrorV1(
      'PVE_COMMAND_REVISION_CONFLICT',
      'stale',
      409,
    ))
    const conflict = await execute(
      new Request('http://local/api/pve/runs/api-run/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'api-run' }),
      }),
      { params: Promise.resolve({ runId: 'api-run' }) },
    )

    expect(malformed.status).toBe(400)
    expect((await malformed.json()).code).toBe('PVE_REQUEST_INVALID')
    expect(duplicateKey.status).toBe(400)
    expect((await duplicateKey.json()).message).toContain('duplicate keys')
    expect(service.createRun).not.toHaveBeenCalled()
    expect(missing.status).toBe(404)
    expect((await missing.json()).code).toBe('PVE_RUN_NOT_FOUND')
    expect(conflict.status).toBe(409)
    expect((await conflict.json()).code).toBe('PVE_COMMAND_REVISION_CONFLICT')
  })

  it('maps an unavailable verified Snapshot consistently for create, read, and command', async () => {
    const snapshotError = () => {
      throw new ProfileStoreErrorV1('PROFILE_HASH_MISMATCH', 'active Snapshot')
    }
    service.createRun.mockImplementationOnce(snapshotError)
    service.getRun.mockImplementationOnce(snapshotError)
    service.execute.mockRejectedValueOnce(
      new ProfileStoreErrorV1('PROFILE_SNAPSHOT_INCOMPLETE', 'active Snapshot'),
    )

    const created = await createRun(new Request('http://local/api/pve/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId: 'prototype-campaign' }),
    }))
    const read = await getRun(
      new Request('http://local/api/pve/runs/api-run'),
      { params: Promise.resolve({ runId: 'api-run' }) },
    )
    const advanced = await execute(
      new Request('http://local/api/pve/runs/api-run/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 'rvb-pve-command/v1',
          runId: 'api-run',
          commandId: 'api-command',
          expectedRevision: 0,
          type: 'roster-select',
        }),
      }),
      { params: Promise.resolve({ runId: 'api-run' }) },
    )

    for (const response of [created, read, advanced]) {
      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toMatchObject({
        code: 'PVE_SNAPSHOT_UNAVAILABLE',
        message: 'Active verified Snapshot is unavailable',
        context: { profileErrorCode: expect.stringMatching(/^PROFILE_/) },
      })
    }
  })

  it('maps malformed route Run IDs to a client error', async () => {
    service.getRun.mockImplementationOnce(() => {
      throw new PveRunStoreErrorV1('PVE_RUN_ID_INVALID', '../invalid')
    })
    const response = await getRun(
      new Request('http://local/api/pve/runs/invalid'),
      { params: Promise.resolve({ runId: '../invalid' }) },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 'PVE_RUN_ID_INVALID',
    })
  })
})
