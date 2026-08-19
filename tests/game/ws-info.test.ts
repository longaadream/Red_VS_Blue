import { describe, expect, it } from 'vitest'

import { GET } from '../../app/api/ws-info/route'

describe('GET /api/ws-info', () => {
  it('describes the same-origin transport without exposing an internal port', async () => {
    const response = await GET()
    const payload = await response.json() as Record<string, unknown>

    expect(payload).toEqual({
      transport: 'same-origin',
      path: '/ws/rooms/{roomId}',
    })
    expect(payload).not.toHaveProperty('wsPort')
    expect(payload).not.toHaveProperty('wsBaseUrl')
  })
})
