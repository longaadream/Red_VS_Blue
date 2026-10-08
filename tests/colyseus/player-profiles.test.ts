import { describe, expect, it, vi } from 'vitest'

import { OfficialError } from '@/lib/server/official/accounts'
import { PlayerProfiles } from '@/lib/server/official/player-profiles'

describe('RED-244 player profile service', () => {
  it('returns only safe current catalog cards and preserves requested account order', async () => {
    const query = vi.fn(async () => ({
      rows: [
        { id: 'two', name: '第二名', avatar_character_id: null },
        { id: 'one', name: '第一名', avatar_character_id: 'ana' },
      ],
      rowCount: 2,
    }))
    const service = new PlayerProfiles({ query } as never)

    const result = await service.cards(['one', 'two'])

    expect(result.players.map(player => player.id)).toEqual(['one', 'two'])
    expect(result.players[0].avatar).toMatchObject({ id: 'ana', image: expect.stringMatching(/\.\w+$/) })
    expect(result.players[1].avatar).toBeNull()
    expect(result.players[0]).not.toHaveProperty('email')
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('rejects extra profile fields and avatars outside the server catalog before any write', async () => {
    const query = vi.fn()
    const service = new PlayerProfiles({ query } as never)

    await expect(service.updateProfile('account-1', { name: '新昵称', email: 'leak@example.test' }))
      .rejects.toBeInstanceOf(OfficialError)
    await expect(service.updateProfile('account-1', { name: '新昵称', avatarCharacterId: 'https://evil.test/a.png' }))
      .rejects.toThrow('头像角色不在当前目录中')

    expect(query).not.toHaveBeenCalled()
  })

  it('bounds card queries and rejects malformed history cursors', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const service = new PlayerProfiles({ query } as never)

    await expect(service.cards(Array.from({ length: 51 }, (_, index) => `account-${index}`)))
      .rejects.toThrow('最多查询50个账号')
    await expect(service.history('viewer', 'target', 'not-a-valid-cursor'))
      .rejects.toThrow('分页游标无效')

    expect(query).not.toHaveBeenCalled()
  })
})
