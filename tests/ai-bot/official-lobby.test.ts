import { describe, expect, it, vi } from 'vitest'
import { prepareOfficialMatch } from '@/lib/ai-bot/official-lobby'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'

const profile = getServerGameProfileIdentityV1()
const pieces = Array.from({ length: 8 }, (_, index) => `template-${index}`)
const me = (extra = {}) => ({ account: { id: 'ai-account', name: '[AI] test' }, ...extra })
const pregame = (phase: string, extra = {}) => ({ phase, version: 1, maps: [{ id: 'test-map' }], players: [{ id: 'ai-account', revision: 7, ...extra }] })

function responses(values: Array<Record<string, unknown> | number>) {
  return vi.fn<typeof fetch>().mockImplementation(async () => {
    const value = values.shift()
    if (value === undefined) throw new Error('Unexpected HTTP request')
    return new Response(JSON.stringify(typeof value === 'number' ? {} : value), { status: typeof value === 'number' ? value : 200 })
  })
}

function options(fetchFn: typeof fetch) {
  let time = 0
  return { serverUrl: 'https://example.test', token: 'dummy-token', profileIdentity: profile,
    alignment: 'light' as const, pieces, fetchFn, pollMs: 1, maxRuntimeMs: 100,
    now: () => time, sleep: async (ms: number) => { time += ms } }
}

describe('official AI lobby', () => {
  it('queues, keeps status alive, submits public veto and own roster revision, then joins assigned battle', async () => {
    const fetchFn = responses([{ profileIdentity: profile }, me(), {}, me({ queued: true }), me({ matchId: 'ranked-test' }),
      pregame('veto'), {}, pregame('roster'), {}, pregame('starting', { locked: true }), pregame('battle', { locked: true })])
    const result = await prepareOfficialMatch(options(fetchFn))
    expect(result).toMatchObject({ roomId: 'ranked-test', playerId: 'ai-account', playerName: '[AI] test' })
    const writes = fetchFn.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(writes.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { profileIdentity: profile }, { action: 'ban', mapId: 'test-map' },
      { action: 'lock', alignment: 'light', pieces, revision: 7 },
    ])
    expect(fetchFn.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('dummy-token')
  })

  it('resumes an assigned battle without enqueueing or changing a locked roster', async () => {
    const fetchFn = responses([{ profileIdentity: profile }, me({ matchId: 'ranked-existing' }), pregame('battle', { locked: true })])
    await expect(prepareOfficialMatch({ ...options(fetchFn), roomId: 'ranked-existing' })).resolves.toMatchObject({ roomId: 'ranked-existing' })
    expect(fetchFn.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
  })

  it('uses a refreshed player revision after a concurrent 409 roster edit', async () => {
    const fetchFn = responses([{ profileIdentity: profile }, me({ matchId: 'ranked-test' }),
      pregame('roster'), 409, pregame('roster', { revision: 8 }), {}, pregame('battle', { locked: true })])
    await prepareOfficialMatch(options(fetchFn))
    expect(fetchFn.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)).revision)).toEqual([7, 8])
  })

  it('cancels its pending queue on runtime exhaustion and never withdraws a match', async () => {
    const fetchFn = responses([{ profileIdentity: profile }, me(), {}, me({ queued: true }), {}])
    await expect(prepareOfficialMatch({ ...options(fetchFn), maxRuntimeMs: 2 })).rejects.toMatchObject({ code: 'RUNTIME_LIMIT' })
    expect(String(fetchFn.mock.calls.at(-1)?.[0])).toContain('/official/queue/cancel')
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('withdraw'))).toBe(false)
  })

  it('fails before enqueueing a different content profile or someone else’s match', async () => {
    const wrong = responses([{ profileIdentity: { ...profile, authorityContentHash: '0'.repeat(64) } }])
    await expect(prepareOfficialMatch(options(wrong))).rejects.toThrow()
    expect(wrong).toHaveBeenCalledTimes(1)
    const fetchFn = responses([{ profileIdentity: profile }, me({ matchId: 'ranked-other' })])
    await expect(prepareOfficialMatch({ ...options(fetchFn), roomId: 'ranked-requested' })).rejects.toMatchObject({ code: 'MATCH_MISMATCH' })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('cleans up an uncertain queue join without retrying it or withdrawing a match', async () => {
    const fetchFn = responses([{ profileIdentity: profile }, me(), 503, {}])
    await expect(prepareOfficialMatch(options(fetchFn))).rejects.toMatchObject({ code: 'HTTP_REJECTED', status: 503 })
    const writes = fetchFn.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => String(url))
    expect(writes).toHaveLength(2)
    expect(writes[0]).toContain('/official/queue/join')
    expect(writes[1]).toContain('/official/queue/cancel')
  })

  it('rejects a configured identity mismatch before enqueueing or changing preparation', async () => {
    const fetchFn = responses([{ profileIdentity: profile }, me()])
    await expect(prepareOfficialMatch({ ...options(fetchFn), expectedPlayerId: 'other-account' })).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' })
    expect(fetchFn.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
  })
})
