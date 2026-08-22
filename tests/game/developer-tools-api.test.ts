import { describe, expect, it } from 'vitest'

import { POST } from '@/app/api/developer-tools/scenario/route'

describe('developer tools isolated scenario API', () => {
  it('rejects invalid scenario parameters before running the rules engine', async () => {
    const response = await POST(new Request('http://localhost/api/developer-tools/scenario', {
      method: 'POST',
      body: JSON.stringify({ seed: -1, mapId: '../room', firstAlignment: 'unknown' }),
      headers: { 'content-type': 'application/json' },
    }))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.any(String) })
  })

  it('runs a fixed-seed in-memory scenario without creating or settling a room', async () => {
    const response = await POST(new Request('http://localhost/api/developer-tools/scenario', {
      method: 'POST',
      body: JSON.stringify({
        seed: 9401,
        mapId: 'large-battlefield',
        firstAlignment: 'dark',
        secondAlignment: 'light',
      }),
      headers: { 'content-type': 'application/json' },
    }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      format: 'rvb-developer-scenario/v1',
      isolation: {
        kind: 'in-memory',
        createsRoom: false,
        grantsRewards: false,
        writesStatistics: false,
      },
      seed: 9401,
      map: { id: 'large-battlefield' },
      turn: {
        number: expect.any(Number),
        phase: expect.any(String),
        currentPlayerId: expect.any(String),
      },
      stateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      actionTrace: expect.arrayContaining([
        expect.objectContaining({
          action: expect.objectContaining({ type: expect.any(String) }),
          preStateHash: expect.any(String),
          postStateHash: expect.any(String),
        }),
      ]),
    })
    expect(body).not.toHaveProperty('roomId')
  })
})
