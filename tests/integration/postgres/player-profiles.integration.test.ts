
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ACCOUNT_SCHEMA } from '@/lib/server/official/accounts'
import { PREGAME_SCHEMA } from '@/lib/server/official/pregame'
import { RANKED_SCHEMA } from '@/lib/server/official/ranked'
import {
  PlayerProfiles,
} from '@/lib/server/official/player-profiles'
import { POSTGRES_AUTHORITY_SCHEMA_STATEMENTS } from '@/lib/server/postgres/authority-schema'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { getDemoPieceIds, getPieceById } from '@/lib/game/piece-repository'

const databaseUrl = process.env.RVB_TEST_POSTGRES_URL
const suite = describe.skipIf(!databaseUrl)

suite('RED-244 player profiles against real PostgreSQL', () => {
  let basePool: Pool | undefined
  let pool: Pool
  let service: PlayerProfiles
  let scopedDatabaseUrl = ''
  let schema = ''
  let lightPieces: string[]
  let darkPieces: string[]
  const identity = getServerGameProfileIdentityV1()

  beforeAll(async () => {
    schema = `red244_profile_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
    basePool = new Pool({ connectionString: databaseUrl!, max: 4 })
    await basePool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
    scopedDatabaseUrl = withSearchPath(databaseUrl!, schema)
    pool = new Pool({ connectionString: scopedDatabaseUrl, max: 4 })

    await pool.query(ACCOUNT_SCHEMA)
    await pool.query(RANKED_SCHEMA)
    await pool.query(PREGAME_SCHEMA)
    for (const statement of POSTGRES_AUTHORITY_SCHEMA_STATEMENTS) await pool.query(statement)
    service = new PlayerProfiles(pool)
    await service.initialize()

    lightPieces = getDemoPieceIds().filter(id => getPieceById(id)?.faction === 'good').slice(0, 8)
    darkPieces = getDemoPieceIds().filter(id => getPieceById(id)?.faction === 'evil').slice(0, 8)
    expect(lightPieces).toHaveLength(8)
    expect(darkPieces).toHaveLength(8)
    await seedAccounts()
    await seedMatches()
  }, 120_000)

  afterAll(async () => {
    await pool?.end().catch(() => {})
    await basePool?.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(() => {})
    await basePool?.end().catch(() => {})
  }, 60_000)

  it('keeps profile writes scoped to name/avatar and exposes current cards without credentials', async () => {
    const cards = await service.cards(['red244-a', 'red244-b'])
    expect(cards.players).toHaveLength(2)
    expect(cards.players[0]).toMatchObject({ id: 'red244-a', name: '当前甲', avatar: null })
    expect(cards.players.every(card => !Object.hasOwn(card, 'email'))).toBe(true)

    await expect(service.updateProfile('red244-a', { name: '非法字段', password: 'secret' }))
      .rejects.toThrow('资料字段无效')
    await expect(service.updateProfile('red244-a', { name: '非法头像', avatarCharacterId: 'remote-url' }))
      .rejects.toThrow('头像角色不在当前目录中')

    const updated = await service.updateProfile('red244-a', { name: '新甲', avatarCharacterId: lightPieces[0] })
    expect(updated.profile).toMatchObject({ id: 'red244-a', name: '新甲', avatar: { id: lightPieces[0] } })
    expect((await pool.query('SELECT name FROM official_accounts WHERE id=$1', ['red244-a'])).rows[0].name).toBe('新甲')
    expect((await pool.query('SELECT schema_version,avatar_character_id FROM official_player_profiles WHERE account_id=$1', ['red244-a'])).rows[0])
      .toMatchObject({ schema_version: 1, avatar_character_id: lightPieces[0] })
  }, 30_000)

  it('derives historical names, rosters, maps, replay availability, and stable history cursors', async () => {
    const first = await service.history('red244-b', 'red244-a')
    expect(first.matches).toHaveLength(3)
    expect(first.matches[0]).toMatchObject({
      id: 'red244-withdraw',
      map: { id: 'open-expanse' },
      winnerId: null,
      replayAvailable: false,
    })
    expect(first.matches[0].players[0]).toMatchObject({ alignment: null, pieces: [] })
    expect(first.matches[1]).toMatchObject({ id: 'red244-other-resource', replayAvailable: false })
    expect(first.matches[2]).toMatchObject({ id: 'red244-current', replayAvailable: true })
    expect(first.matches[2].players[0]).toMatchObject({
      id: 'red244-a',
      name: '历史甲',
      avatar: { id: lightPieces[0] },
      alignment: 'light',
    })
    expect(first.matches[2].players[0].pieces).toHaveLength(8)
    expect(first.matches[2].players[0].pieces.some(piece => piece.id === lightPieces[0])).toBe(true)
    expect(first.matches[2].reason).toBe('surrender')

    const profile = await service.getProfile('red244-b', 'red244-a')
    expect(profile.profile).toMatchObject({ totalGames: 3, wins: 1, draws: 1 })
    expect(profile.profile.favoriteRosters.light).toMatchObject({ games: 2, wins: 1 })
    expect(profile.profile.favoriteRosters.light?.pieces).toHaveLength(8)

    const freshService = new PlayerProfiles(pool)
    await freshService.initialize()
    expect((await freshService.getProfile('red244-b', 'red244-a')).profile.name).toBe('新甲')
  }, 30_000)

  it('counts only current-resource actual matches and does not double-count roster pieces', async () => {
    const stats = await service.characterStats()
    expect(stats.matches).toBe(1)
    expect(stats.playerGames).toBe(2)
    const selectedLight = stats.characters.find(character => character.id === lightPieces[0])
    const selectedDark = stats.characters.find(character => character.id === darkPieces[0])
    expect(selectedLight).toMatchObject({ games: 1, wins: 0, draws: 0, selectionRate: 0.5, winRate: 0 })
    expect(selectedDark).toMatchObject({ games: 1, wins: 1, draws: 0, selectionRate: 0.5, winRate: 1 })
  }, 30_000)

  async function seedAccounts() {
    await pool.query(`INSERT INTO official_accounts(id,email,name,password_hash) VALUES
      ('red244-a','red244-a@example.test','当前甲','fixture-password-hash'),
      ('red244-b','red244-b@example.test','当前乙','fixture-password-hash')`)
    await pool.query(`INSERT INTO official_ratings(season_id,account_id,rating,games,wins) VALUES
      ('test-1','red244-a',1016,2,1),('test-1','red244-b',984,2,1)`)
  }

  async function seedMatches() {
    const currentPregame = pregame('历史甲', '历史乙', lightPieces, darkPieces)
    const otherPregame = pregame('历史甲-旧', '历史乙-旧', lightPieces, darkPieces)
    const withdrawState = pregame('历史甲-退出', '历史乙-退出', lightPieces, darkPieces)
    const withdrawPregame = {
      ...withdrawState,
      players: withdrawState.players.map(player => ({ ...player, locked: false })),
    }

    await pool.query(`INSERT INTO official_matches(id,season_id,first_id,second_id,status,result,created_at,finished_at) VALUES
      ($1,'test-1','red244-a','red244-b','settled',$2,now()-interval '3 minutes',now()-interval '2 minutes'),
      ($3,'test-1','red244-a','red244-b','settled',$4,now()-interval '2 minutes',now()-interval '1 minutes'),
      ($5,'test-1','red244-a','red244-b','settled',$6,now()-interval '1 minutes',now())`, [
      'red244-current',
      { winnerId: 'red244-b', first: { id: 'red244-a', before: 1000, after: 984, delta: -16 }, second: { id: 'red244-b', before: 1000, after: 1016, delta: 16 } },
      'red244-other-resource',
      { winnerId: 'red244-a', first: { id: 'red244-a', before: 984, after: 1000, delta: 16 }, second: { id: 'red244-b', before: 1016, after: 1000, delta: -16 } },
      'red244-withdraw',
      { winnerId: null, reason: '赛前主动退出' },
    ])
    await pool.query(`INSERT INTO official_pregames(match_id,state) VALUES($1,$2),($3,$4),($5,$6)`, [
      'red244-current', currentPregame,
      'red244-other-resource', otherPregame,
      'red244-withdraw', withdrawPregame,
    ])

    await insertAuthority('red244-current', identity, true, 'surrender')
    await insertAuthority('red244-other-resource', { ...identity, authorityContentHash: '0'.repeat(64) }, false, 'core-eliminated')
  }

  async function insertAuthority(matchId: string, profileIdentity: unknown, replay: boolean, terminalReason: string) {
    const checkpoint = {
      protocolVersion: 1,
      roomId: matchId,
      authorityVersion: 0,
      storage: {
        type: 'server-state',
        storageSchemaVersion: 'rvb-server-battle-state/v1',
        profileIdentity,
        rootSeed: 1,
        state: {
          terminalResult: { status: 'finished', reason: terminalReason },
          extensions: replay ? { debugBattle: { replay: { format: 'rvb-battle-replay/v2' } } } : {},
        },
      },
      stateHash: 'state',
      publicHash: 'public',
      transitionHash: 'transition',
      reason: 'terminal',
      createdAt: Date.now(),
    }
    await pool.query(`INSERT INTO battle_room_authority(
      battle_id,epoch,room_json,authority_version,durable_version,state_hash,public_hash,transition_hash,terminal
    ) VALUES($1,0,'{}',0,0,'state','public','transition',TRUE)`, [matchId])
    await pool.query(`INSERT INTO battle_terminal_barrier(
      battle_id,authority_version,state_hash,transition_hash,checkpoint_json
    ) VALUES($1,0,'state','transition',$2)`, [matchId, checkpoint])
  }

  function pregame(firstName: string, secondName: string, firstPieces: string[], secondPieces: string[]) {
    return {
      version: 1,
      mapId: 'open-expanse',
      players: [
        { id: 'red244-a', name: firstName, seat: 'red', alignment: 'light', pieces: firstPieces, locked: true },
        { id: 'red244-b', name: secondName, seat: 'blue', alignment: 'dark', pieces: secondPieces, locked: true },
      ],
    }
  }
})

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function withSearchPath(connectionString: string, schema: string): string {
  const url = new URL(connectionString)
  url.searchParams.set('options', `-c search_path=${schema},public`)
  return url.toString()
}
