import { describe, expect, it } from 'vitest'
import { advancePregame, applyPregameAction, createPregame, pregameBattlePlayers, publicPregame, validateRankedMapPool } from '@/lib/server/official/pregame'
import { getDemoPieceIds, getPieceById } from '@/lib/game/piece-repository'

const pool = ['large-hole-arena', 'open-expanse', 'winding-pass', 'narrow-corridors']
const players = [{ id: 'one', name: '甲' }, { id: 'two', name: '乙' }]
const pieces = getDemoPieceIds().filter(id => getPieceById(id)?.faction === 'good').slice(0, 8)
describe('official durable pregame rules', () => {
  it('seals choices until both submit, accepts duplicate bans and exact retries', () => {
    const state = createPregame(pool, players, 1000, 17)
    applyPregameAction(state, 'one', { action: 'ban', mapId: pool[0] }, 2000)
    expect(publicPregame(state, 'two', 2000).players[0]).toMatchObject({ ban: null, banSubmitted: true })
    expect(publicPregame(state, 'two', 2000).players[0]).not.toHaveProperty('pieces')
    expect(() => publicPregame(state, 'outsider', 2000)).toThrow('资格')
    expect(() => applyPregameAction(state, 'one', { action: 'ban', mapId: pool[1] }, 2001)).toThrow('已提交')
    applyPregameAction(state, 'two', { action: 'ban', mapId: pool[0] }, 2002)
    expect(state.phase).toBe('roster'); expect(state.mapId).not.toBe(pool[0])
    expect(publicPregame(state, 'two', 2003).players[0].ban).toBe(pool[0])
    applyPregameAction(state, 'one', { action: 'ban', mapId: pool[0] }, 2003)
    expect(state.deadlineAt).toBe(122002)
  })
  it('uses absolute deadlines after restart, fills legal unique rosters once and preserves drafts', () => {
    const state = createPregame(pool, players, 1000, 29)
    advancePregame(state, 31000)
    applyPregameAction(state, 'one', { action: 'draft', revision: 0, alignment: 'light', pieces: pieces.slice(0, 2) }, 32000)
    const restored = JSON.parse(JSON.stringify(state))
    advancePregame(restored, 900000)
    expect(restored.phase).toBe('starting'); expect(restored.deadlineAt).toBe(151000)
    expect(restored.players[0].pieces.slice(0, 2)).toEqual(pieces.slice(0, 2))
    expect(restored.players.every((p: { pieces: string[] }) => new Set(p.pieces).size === 8)).toBe(true)
    expect(pregameBattlePlayers(restored)).toHaveLength(2)
    const completed = JSON.stringify(restored); advancePregame(restored, 999999); expect(JSON.stringify(restored)).toBe(completed)
    const unattended = createPregame(pool, players, 1000, 29); advancePregame(unattended, 900000)
    expect(unattended.phase).toBe('starting'); expect(unattended.deadlineAt).toBe(151000)
  })
  it('rejects late actions, stale drafts, illegal rosters and incompatible pinned profiles', () => {
    const state = createPregame(pool, players, 0, 47)
    expect(() => applyPregameAction(state, 'one', { action: 'ban', mapId: pool[0] }, 30000)).toThrow('结束')
    applyPregameAction(state, 'one', { action: 'draft', revision: 0, alignment: 'light', pieces: pieces.slice(0, 2) }, 30001)
    expect(() => applyPregameAction(state, 'one', { action: 'draft', revision: 0, alignment: 'light', pieces: [] }, 30002)).toThrow('另一页面')
    expect(() => applyPregameAction(state, 'one', { action: 'lock', revision: 1, alignment: 'dark', pieces }, 30002)).toThrow('本阵营')
    applyPregameAction(state, 'one', { action: 'lock', revision: 1, alignment: 'light', pieces }, 30003)
    applyPregameAction(state, 'one', { action: 'lock', revision: 1, alignment: 'light', pieces }, 30004)
    advancePregame(state, 150000)
    state.profileIdentity = { ...state.profileIdentity, runnerRevision: 'old-client' }
    expect(() => pregameBattlePlayers(state)).toThrow()
  })
  it('freezes a separate map pool, rejects fewer than three and gives each remaining map a chance', () => {
    const mutable = [...pool], state = createPregame(mutable, players, 0, 4); mutable.pop()
    expect(state.pool).toHaveLength(4)
    expect(() => validateRankedMapPool(pool.slice(0, 2))).toThrow()
    expect(() => validateRankedMapPool([pool[0], pool[0], pool[1]])).toThrow()
    const selected = new Set<string | null>()
    for (let seed = 0; seed < 100; seed++) { const match = createPregame(pool, players, 0, seed); advancePregame(match, 30000); selected.add(match.mapId) }
    expect([...selected].sort()).toEqual([...pool].sort())
  })
})
