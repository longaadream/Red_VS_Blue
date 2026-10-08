import type { Pool } from 'pg'

import { getMapById } from '@/lib/game/map-repository'
import { getDemoPieceIds, getPieceById } from '@/lib/game/piece-repository'
import { getServerGameProfileIdentityV1, type GameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'

import { OfficialError, transaction } from './accounts'

const MAX_ACCOUNT_ID_LENGTH = 128
const MAX_CARD_IDS = 50
const HISTORY_PAGE_SIZE = 20
const CURSOR_MAX_LENGTH = 256
const NICKNAME_MAX_LENGTH = 24
const IMAGE_MAX_LENGTH = 160

export const PLAYER_PROFILES_SCHEMA = `
CREATE TABLE IF NOT EXISTS official_player_profiles (
  account_id TEXT PRIMARY KEY REFERENCES official_accounts(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  avatar_character_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS official_player_profiles_updated
  ON official_player_profiles(updated_at DESC, account_id);
`

export type CharacterCard = {
  id: string
  name: string
  image: string
}

export type PlayerCard = {
  id: string
  name: string
  avatar: CharacterCard | null
}

export type Roster = {
  pieces: CharacterCard[]
  games: number
  wins: number
}

export type MatchPlayer = PlayerCard & {
  alignment: 'light' | 'dark' | null
  pieces: CharacterCard[]
  ratingBefore: number | null
  ratingAfter: number | null
  delta: number | null
}

export type MatchSummary = {
  id: string
  createdAt: string
  finishedAt: string | null
  status: string
  map: { id: string; name: string } | null
  players: MatchPlayer[]
  winnerId: string | null
  reason: string | null
  replayAvailable: boolean
}

export type Profile = PlayerCard & {
  totalGames: number
  wins: number
  draws: number
  season: {
    id: string
    name: string
    rating: number
    games: number
    wins: number
  }
  favoriteRosters: {
    light: Roster | null
    dark: Roster | null
  }
  recentMatches: MatchSummary[]
}

export type PlayerCharacterStat = CharacterCard & {
  games: number
  wins: number
  draws: number
  selectionRate: number
  winRate: number
}

export type PlayerProfilesApi = {
  initialize(): Promise<void>
  catalog(): Promise<{ characters: CharacterCard[]; resourceIdentity: GameProfileIdentityV1 }>
  cards(ids: unknown): Promise<{ players: PlayerCard[] }>
  getProfile(viewerId: string, targetId: string): Promise<{ profile: Profile }>
  updateProfile(accountId: string, input: unknown): Promise<{ profile: Profile }>
  history(viewerId: string, targetId: string, cursor?: unknown): Promise<{ matches: MatchSummary[]; nextCursor?: string }>
  characterStats(): Promise<{
    resourceIdentity: GameProfileIdentityV1
    matches: number
    playerGames: number
    characters: PlayerCharacterStat[]
  }>
}

type AccountRow = {
  id: string
  name: string
  avatar_character_id: string | null
}

type MatchRow = {
  id: string
  first_id: string
  second_id: string
  first_name: string
  second_name: string
  first_avatar_character_id: string | null
  second_avatar_character_id: string | null
  status: string
  match_result: unknown
  created_at: Date | string
  finished_at: Date | string | null
  created_at_cursor: string
  pregame_state: unknown
  terminal_reason: string | null
  has_replay: boolean
}

type RosterAggregateRow = {
  alignment: 'light' | 'dark'
  piece_ids: string[]
  games: number | string
  wins: number | string
}

type CharacterAggregateRow = {
  id: string
  games: number | string
  wins: number | string
  draws: number | string
}

type CursorValue = {
  createdAt: string
  id: string
}

type RawObject = Record<string, unknown>

function isObject(value: unknown): value is RawObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function accountId(value: unknown): string {
  if (typeof value !== 'string') throw new OfficialError('账号标识无效')
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_ACCOUNT_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new OfficialError('账号标识无效')
  }
  return normalized
}

function nickname(value: unknown): string {
  if (typeof value !== 'string') throw new OfficialError('昵称格式无效')
  const normalized = value.trim()
  if (
    !normalized
    || normalized.length > NICKNAME_MAX_LENGTH
    || /[\u0000-\u001f\u007f<>]/.test(normalized)
  ) throw new OfficialError('昵称需要1–24个字符，不能包含控制字符或尖括号')
  return normalized
}

function safeImage(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > IMAGE_MAX_LENGTH) return null
  // Images are resolved by the client below its local /images root.  Keep
  // directory separators for the existing adventure asset layout, but reject
  // traversal, absolute paths, URLs, and non-image filenames.
  if (
    value.startsWith('/')
    || value.includes('\\')
    || value.includes('..')
    || value.includes('//')
    || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|gif|svg)$/i.test(value)
  ) return null
  return value
}

function decodeCursor(value: unknown): CursorValue | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new OfficialError('分页游标无效')
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (!isObject(decoded) || typeof decoded.createdAt !== 'string' || typeof decoded.id !== 'string') throw new Error()
    if (!/^\d{1,16}$/.test(decoded.createdAt) || !Number.isSafeInteger(Number(decoded.createdAt)) || Number(decoded.createdAt) < 0) throw new Error()
    if (!decoded.id || decoded.id.length > MAX_ACCOUNT_ID_LENGTH || !/^[A-Za-z0-9_-]+$/.test(decoded.id)) throw new Error()
    return { createdAt: decoded.createdAt, id: decoded.id }
  } catch {
    throw new OfficialError('分页游标无效')
  }
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString('base64url')
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function numberOrNull(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const number = Number(value)
  return Number.isFinite(number) && Number.isSafeInteger(number) ? number : null
}

function currentCharacters(): CharacterCard[] {
  return getDemoPieceIds()
    .map(id => {
      const piece = getPieceById(id)
      const image = safeImage(piece?.image)
      if (!piece || !image || typeof piece.name !== 'string' || !piece.name) return null
      return { id, name: piece.name, image }
    })
    .filter((character): character is CharacterCard => character !== null)
}

function characterById(id: unknown, characters: Map<string, CharacterCard>): CharacterCard | null {
  if (typeof id !== 'string') return null
  const character = characters.get(id)
  return character ? { ...character } : null
}

function piecesFromValue(value: unknown, characters: Map<string, CharacterCard>, expectedAlignment?: 'light' | 'dark'): CharacterCard[] {
  if (!Array.isArray(value) || value.length !== 8) return []
  const ids = value.filter((piece): piece is string => typeof piece === 'string')
  if (ids.length !== 8 || new Set(ids).size !== 8) return []
  const pieces = [...ids].sort().map(id => characterById(id, characters))
  const expectedFaction = expectedAlignment === 'light' ? 'good' : expectedAlignment === 'dark' ? 'evil' : undefined
  return pieces.every((piece): piece is CharacterCard => piece !== null
    && (!expectedFaction || getPieceById(piece.id)?.faction === expectedFaction)) ? pieces : []
}

function catalogPieceIdsByAlignment(characters: Iterable<CharacterCard>): { light: string[]; dark: string[] } {
  const ids: { light: string[]; dark: string[] } = { light: [], dark: [] }
  for (const character of characters) {
    const faction = getPieceById(character.id)?.faction
    if (faction === 'good') ids.light.push(character.id)
    if (faction === 'evil') ids.dark.push(character.id)
  }
  return ids
}

function objectValue(value: unknown): RawObject | undefined {
  return isObject(value) ? value : undefined
}

function pregamePlayers(value: unknown): RawObject[] {
  const state = objectValue(value)
  return Array.isArray(state?.players) ? state.players.filter(isObject) : []
}

function pregamePlayer(value: unknown, id: string): RawObject | undefined {
  return pregamePlayers(value).find(player => player.id === id)
}

function recordedName(player: RawObject | undefined, fallback: string): string {
  return typeof player?.name === 'string' && player.name ? player.name : fallback
}

function alignment(value: unknown): 'light' | 'dark' | null {
  return value === 'light' || value === 'dark' ? value : null
}

function mapCard(value: unknown): { id: string; name: string } | null {
  if (typeof value !== 'string' || !value || value.length > MAX_ACCOUNT_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) return null
  const map = getMapById(value)
  return map ? { id: value, name: map.name } : null
}

function resultObject(value: unknown): RawObject | undefined {
  return objectValue(value)
}

function resultNumber(result: RawObject | undefined, side: 'first' | 'second', field: 'before' | 'after' | 'delta'): number | null {
  const entry = objectValue(result?.[side])
  return numberOrNull(entry?.[field])
}

function winnerId(result: RawObject | undefined, firstId: string, secondId: string): string | null {
  return result?.winnerId === firstId || result?.winnerId === secondId
    ? String(result.winnerId)
    : null
}

function reason(result: RawObject | undefined, terminalReason: unknown): string | null {
  if (typeof result?.reason === 'string' && result.reason) return result.reason
  return typeof terminalReason === 'string' && terminalReason ? terminalReason : null
}

function profileCard(row: AccountRow, characters: Map<string, CharacterCard>): PlayerCard {
  return {
    id: row.id,
    name: row.name,
    avatar: characterById(row.avatar_character_id, characters),
  }
}

function historyPlayer(
  row: MatchRow,
  side: 'first' | 'second',
  characters: Map<string, CharacterCard>,
): MatchPlayer {
  const id = side === 'first' ? row.first_id : row.second_id
  const currentName = side === 'first' ? row.first_name : row.second_name
  const avatarId = side === 'first' ? row.first_avatar_character_id : row.second_avatar_character_id
  const recorded = pregamePlayer(row.pregame_state, id)
  const result = resultObject(row.match_result)
  const locked = recorded?.locked === true
  const recordedAlignment = locked ? alignment(recorded?.alignment) : null
  return {
    id,
    name: recordedName(recorded, currentName),
    avatar: characterById(avatarId, characters),
    alignment: recordedAlignment,
    pieces: recordedAlignment ? piecesFromValue(recorded?.pieces, characters, recordedAlignment) : [],
    ratingBefore: resultNumber(result, side, 'before'),
    ratingAfter: resultNumber(result, side, 'after'),
    delta: resultNumber(result, side, 'delta'),
  }
}

function matchSummary(row: MatchRow, characters: Map<string, CharacterCard>): MatchSummary {
  const result = resultObject(row.match_result)
  const state = objectValue(row.pregame_state)
  return {
    id: row.id,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    finishedAt: iso(row.finished_at),
    status: row.status,
    map: mapCard(state?.mapId),
    players: [historyPlayer(row, 'first', characters), historyPlayer(row, 'second', characters)],
    winnerId: winnerId(result, row.first_id, row.second_id),
    reason: reason(result, row.terminal_reason),
    replayAvailable: !!row.has_replay,
  }
}

function accountIds(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value]
  const values = raw.flatMap(entry => {
    if (typeof entry !== 'string') throw new OfficialError('账号列表无效')
    return entry.split(',')
  }).map(entry => accountId(entry))
  const unique = [...new Set(values)]
  if (unique.length > MAX_CARD_IDS) throw new OfficialError('一次最多查询50个账号')
  return unique
}

function profileInput(input: unknown): { name: string; avatarProvided: boolean; avatarCharacterId: string | null | undefined } {
  if (!isObject(input)) throw new OfficialError('资料格式无效')
  const allowed = new Set(['name', 'avatarCharacterId'])
  if (Object.keys(input).some(key => !allowed.has(key)) || !Object.prototype.hasOwnProperty.call(input, 'name')) {
    throw new OfficialError('资料字段无效')
  }
  const avatarProvided = Object.prototype.hasOwnProperty.call(input, 'avatarCharacterId')
  let avatarCharacterId: string | null | undefined
  if (avatarProvided) {
    if (input.avatarCharacterId === null) avatarCharacterId = null
    else if (typeof input.avatarCharacterId === 'string') avatarCharacterId = input.avatarCharacterId
    else throw new OfficialError('头像角色无效')
  }
  return { name: nickname(input.name), avatarProvided, avatarCharacterId }
}

export class PlayerProfiles implements PlayerProfilesApi {
  constructor(readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(PLAYER_PROFILES_SCHEMA)
  }

  async catalog() {
    return {
      characters: currentCharacters(),
      resourceIdentity: getServerGameProfileIdentityV1(),
    }
  }

  async cards(ids: unknown): Promise<{ players: PlayerCard[] }> {
    const requested = accountIds(ids)
    if (!requested.length) return { players: [] }
    const characters = new Map(currentCharacters().map(character => [character.id, character] as const))
    const rows = await this.pool.query<AccountRow>(`SELECT a.id,a.name,p.avatar_character_id
      FROM official_accounts a
      LEFT JOIN official_player_profiles p ON p.account_id=a.id
      WHERE a.id=ANY($1::text[]) AND NOT a.banned`, [requested])
    const byId = new Map(rows.rows.map(row => [row.id, row]))
    return { players: requested.flatMap(id => {
      const row = byId.get(id)
      return row ? [profileCard(row, characters)] : []
    }) }
  }

  async getProfile(viewerId: string, targetId: string): Promise<{ profile: Profile }> {
    void accountId(viewerId)
    const id = accountId(targetId)
    const characters = new Map(currentCharacters().map(character => [character.id, character] as const))
    const account = await this.pool.query<AccountRow>(`SELECT a.id,a.name,p.avatar_character_id
      FROM official_accounts a LEFT JOIN official_player_profiles p ON p.account_id=a.id
      WHERE a.id=$1 AND NOT a.banned`, [id])
    if (!account.rowCount) throw new OfficialError('账号不存在', 404)

    const [totals, season, favoriteRosters, recent] = await Promise.all([
      this.pool.query<{ total_games: number | string; wins: number | string; draws: number | string }>(`SELECT
        count(*) FILTER (WHERE status='settled')::int AS total_games,
        count(*) FILTER (WHERE status='settled' AND result IS NOT NULL AND result->>'winnerId'=$1)::int AS wins,
        count(*) FILTER (WHERE status='settled' AND result IS NOT NULL AND result->>'winnerId' IS NULL)::int AS draws
        FROM official_matches WHERE first_id=$1 OR second_id=$1`, [id]),
      this.pool.query<{ id: string; name: string; rating: number | string; games: number | string; wins: number | string }>(`SELECT
        s.season_id AS id,season.name,
        coalesce(r.rating,1000)::int AS rating,
        coalesce(r.games,0)::int AS games,
        coalesce(r.wins,0)::int AS wins
        FROM official_settings s JOIN official_seasons season ON season.id=s.season_id
        LEFT JOIN official_ratings r ON r.season_id=s.season_id AND r.account_id=$1
        LIMIT 1`, [id]),
      this.favoriteRosters(id, characters),
      this.history(id, id),
    ])
    const total = totals.rows[0]
    const currentSeason = season.rows[0] ?? { id: '', name: '', rating: 1000, games: 0, wins: 0 }
    return {
      profile: {
        ...profileCard(account.rows[0], characters),
        totalGames: Number(total?.total_games ?? 0),
        wins: Number(total?.wins ?? 0),
        draws: Number(total?.draws ?? 0),
        season: {
          id: currentSeason.id,
          name: currentSeason.name,
          rating: Number(currentSeason.rating),
          games: Number(currentSeason.games),
          wins: Number(currentSeason.wins),
        },
        favoriteRosters,
        recentMatches: recent.matches,
      },
    }
  }

  async updateProfile(accountIdValue: string, input: unknown): Promise<{ profile: Profile }> {
    const id = accountId(accountIdValue)
    const parsed = profileInput(input)
    const characters = new Map(currentCharacters().map(character => [character.id, character] as const))
    const avatarCharacterId = parsed.avatarCharacterId
    if (parsed.avatarProvided && avatarCharacterId !== null && avatarCharacterId !== undefined && !characters.has(avatarCharacterId)) {
      throw new OfficialError('头像角色不在当前目录中')
    }
    await transaction(this.pool, async client => {
      const account = await client.query<{ id: string; banned: boolean }>('SELECT id,banned FROM official_accounts WHERE id=$1 FOR UPDATE', [id])
      if (!account.rowCount) throw new OfficialError('账号不存在', 404)
      if (account.rows[0].banned) throw new OfficialError('账号暂时无法修改资料', 403)
      await client.query('UPDATE official_accounts SET name=$2 WHERE id=$1', [id, parsed.name])
      if (parsed.avatarProvided) {
        await client.query(`INSERT INTO official_player_profiles(account_id,schema_version,avatar_character_id)
          VALUES($1,1,$2)
          ON CONFLICT(account_id) DO UPDATE SET schema_version=1,avatar_character_id=excluded.avatar_character_id,updated_at=now()`, [id, parsed.avatarCharacterId])
      } else {
        await client.query(`INSERT INTO official_player_profiles(account_id,schema_version)
          VALUES($1,1) ON CONFLICT(account_id) DO NOTHING`, [id])
      }
    })
    return this.getProfile(id, id)
  }

  async history(viewerId: string, targetId: string, cursorValue?: unknown): Promise<{ matches: MatchSummary[]; nextCursor?: string }> {
    void accountId(viewerId)
    const id = accountId(targetId)
    const cursor = decodeCursor(cursorValue)
    const characters = new Map(currentCharacters().map(character => [character.id, character] as const))
    const account = await this.pool.query('SELECT id FROM official_accounts WHERE id=$1 AND NOT banned', [id])
    if (!account.rowCount) throw new OfficialError('账号不存在', 404)

    const params: unknown[] = [id]
    let cursorWhere = ''
    if (cursor) {
      params.push(cursor.createdAt, cursor.id)
      cursorWhere = 'AND (floor(extract(epoch from m.created_at)*1000000),m.id)<($2::numeric,$3)'
    }
    params.push(HISTORY_PAGE_SIZE + 1)
    const result = await this.pool.query<MatchRow>(`SELECT m.id,m.first_id,m.second_id,
        first_account.name AS first_name,second_account.name AS second_name,
        first_profile.avatar_character_id AS first_avatar_character_id,
        second_profile.avatar_character_id AS second_avatar_character_id,
        m.status,m.result AS match_result,m.created_at,m.finished_at,
        floor(extract(epoch from m.created_at)*1000000)::text AS created_at_cursor,
        pg.state AS pregame_state,
        b.checkpoint_json #>> '{storage,state,terminalResult,reason}' AS terminal_reason,
        (b.checkpoint_json #> '{storage,state,extensions,debugBattle,replay}' IS NOT NULL
          OR b.checkpoint_json #> '{storage,state,extensions,debugReplay}' IS NOT NULL) AS has_replay
      FROM official_matches m
      JOIN official_accounts first_account ON first_account.id=m.first_id
      JOIN official_accounts second_account ON second_account.id=m.second_id
      LEFT JOIN official_player_profiles first_profile ON first_profile.account_id=m.first_id
      LEFT JOIN official_player_profiles second_profile ON second_profile.account_id=m.second_id
      LEFT JOIN official_pregames pg ON pg.match_id=m.id
      LEFT JOIN battle_terminal_barrier b ON b.battle_id=m.id
      WHERE m.status='settled' AND (m.first_id=$1 OR m.second_id=$1) ${cursorWhere}
      ORDER BY m.created_at DESC,m.id DESC LIMIT $${params.length}`, params)
    const rows = result.rows.slice(0, HISTORY_PAGE_SIZE)
    return {
      matches: rows.map(row => matchSummary(row, characters)),
      ...(result.rows.length > HISTORY_PAGE_SIZE && rows.length
        ? { nextCursor: encodeCursor(rows[rows.length - 1].created_at_cursor, rows[rows.length - 1].id) }
        : {}),
    }
  }

  async characterStats() {
    const resourceIdentity = getServerGameProfileIdentityV1()
    const identity = JSON.stringify(resourceIdentity)
    const characters = currentCharacters()
    const characterIdsByAlignment = catalogPieceIdsByAlignment(characters)
    const client = await this.pool.connect()
    let summaryRows: Array<{ matches: number | string; player_games: number | string }> = []
    let characterRows: CharacterAggregateRow[] = []
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      summaryRows = (await client.query<{ matches: number | string; player_games: number | string }>(`WITH actual AS (
          SELECT m.id,m.first_id,m.second_id
          FROM official_matches m
          JOIN battle_terminal_barrier b ON b.battle_id=m.id
          WHERE m.status='settled' AND coalesce(
            b.checkpoint_json #> '{storage,profileIdentity}',
            b.checkpoint_json #> '{storage,state,profileIdentity}',
            b.checkpoint_json #> '{storage,state,extensions,debugBattle,authority,profileIdentity}'
          )=$1::jsonb
        ), raw_rosters AS (
          SELECT actual.id AS match_id,player.value->>'id' AS player_id,
            player.value->>'alignment' AS alignment,
            CASE WHEN jsonb_typeof(player.value->'pieces')='array' THEN player.value->'pieces' ELSE '[]'::jsonb END AS pieces
          FROM actual JOIN official_pregames pg ON pg.match_id=actual.id
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(pg.state->'players')='array' THEN pg.state->'players' ELSE '[]'::jsonb END
          ) AS player(value)
          WHERE (player.value->>'id'=actual.first_id OR player.value->>'id'=actual.second_id)
            AND player.value->'locked'='true'::jsonb
            AND player.value->>'alignment' IN ('light','dark')
        ), valid_rosters AS (
          SELECT DISTINCT match_id,player_id
          FROM raw_rosters
          WHERE jsonb_array_length(pieces)=8
            AND (SELECT count(*) FROM jsonb_array_elements_text(raw_rosters.pieces))=8
            AND (SELECT count(DISTINCT piece) FROM jsonb_array_elements_text(raw_rosters.pieces) AS piece)=8
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(raw_rosters.pieces) AS piece(id)
              WHERE NOT (piece.id = ANY(CASE WHEN raw_rosters.alignment='light' THEN $2::text[] ELSE $3::text[] END))
            )
        )
        SELECT (SELECT count(*)::int FROM actual) AS matches,
          (SELECT count(*)::int FROM valid_rosters) AS player_games`, [identity, characterIdsByAlignment.light, characterIdsByAlignment.dark])).rows
      characterRows = (await client.query<CharacterAggregateRow>(`WITH actual AS (
          SELECT m.id,m.first_id,m.second_id,m.result,pg.state
          FROM official_matches m
          JOIN battle_terminal_barrier b ON b.battle_id=m.id
          JOIN official_pregames pg ON pg.match_id=m.id
          WHERE m.status='settled' AND coalesce(
            b.checkpoint_json #> '{storage,profileIdentity}',
            b.checkpoint_json #> '{storage,state,profileIdentity}',
            b.checkpoint_json #> '{storage,state,extensions,debugBattle,authority,profileIdentity}'
          )=$1::jsonb
        ), raw_rosters AS (
          SELECT actual.id AS match_id,player.value->>'id' AS player_id,
            player.value->>'alignment' AS alignment,
            actual.result->>'winnerId' AS winner_id,
            CASE WHEN jsonb_typeof(player.value->'pieces')='array' THEN player.value->'pieces' ELSE '[]'::jsonb END AS pieces
          FROM actual CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(actual.state->'players')='array' THEN actual.state->'players' ELSE '[]'::jsonb END
          ) AS player(value)
          WHERE (player.value->>'id'=actual.first_id OR player.value->>'id'=actual.second_id)
            AND player.value->'locked'='true'::jsonb
            AND player.value->>'alignment' IN ('light','dark')
        ), valid_rosters AS (
          SELECT DISTINCT ON (match_id,player_id) match_id,player_id,winner_id,
            ARRAY(SELECT jsonb_array_elements_text(raw_rosters.pieces) ORDER BY 1) AS piece_ids
          FROM raw_rosters
          WHERE jsonb_array_length(pieces)=8
            AND (SELECT count(*) FROM jsonb_array_elements_text(raw_rosters.pieces))=8
            AND (SELECT count(DISTINCT piece) FROM jsonb_array_elements_text(raw_rosters.pieces) AS piece)=8
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(raw_rosters.pieces) AS piece(id)
              WHERE NOT (piece.id = ANY(CASE WHEN raw_rosters.alignment='light' THEN $2::text[] ELSE $3::text[] END))
            )
          ORDER BY match_id,player_id,pieces::text
        ), picked AS (
          SELECT piece.id, count(*)::int AS games,
            count(*) FILTER (WHERE valid_rosters.winner_id=valid_rosters.player_id)::int AS wins,
            count(*) FILTER (WHERE valid_rosters.winner_id IS NULL)::int AS draws
          FROM valid_rosters CROSS JOIN LATERAL unnest(valid_rosters.piece_ids) AS piece(id)
          GROUP BY piece.id
        )
        SELECT id,games,wins,draws FROM picked ORDER BY games DESC,id`, [identity, characterIdsByAlignment.light, characterIdsByAlignment.dark])).rows
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
    const matches = Number(summaryRows[0]?.matches ?? 0)
    const playerGames = Number(summaryRows[0]?.player_games ?? 0)
    const byId = new Map(characters.map(character => [character.id, character] as const))
    return {
      resourceIdentity,
      matches,
      playerGames,
      characters: characterRows.flatMap(row => {
        const character = byId.get(row.id)
        const games = Number(row.games)
        const wins = Number(row.wins)
        const draws = Number(row.draws)
        return character && games > 0 ? [{
          ...character,
          games,
          wins,
          draws,
          selectionRate: playerGames > 0 ? games / playerGames : 0,
          winRate: games > 0 ? wins / games : 0,
        }] : []
      }),
    }
  }

  private async favoriteRosters(id: string, characters: Map<string, CharacterCard>): Promise<{ light: Roster | null; dark: Roster | null }> {
    const characterIdsByAlignment = catalogPieceIdsByAlignment(characters.values())
    const result = await this.pool.query<RosterAggregateRow>(`WITH raw_rosters AS (
        SELECT m.id AS match_id,m.result->>'winnerId' AS winner_id,
          player.value->>'alignment' AS alignment,
          CASE WHEN jsonb_typeof(player.value->'pieces')='array' THEN player.value->'pieces' ELSE '[]'::jsonb END AS pieces
        FROM official_matches m
        JOIN official_pregames pg ON pg.match_id=m.id
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(pg.state->'players')='array' THEN pg.state->'players' ELSE '[]'::jsonb END
        ) AS player(value)
        WHERE m.status='settled' AND (m.first_id=$1 OR m.second_id=$1)
          AND player.value->>'id'=$1
          AND player.value->'locked'='true'::jsonb
          AND player.value->>'alignment' IN ('light','dark')
      ), valid_rosters AS (
        SELECT DISTINCT ON (match_id) match_id,winner_id,alignment,
          ARRAY(SELECT jsonb_array_elements_text(raw_rosters.pieces) ORDER BY 1) AS piece_ids
        FROM raw_rosters
        WHERE jsonb_array_length(pieces)=8
          AND (SELECT count(*) FROM jsonb_array_elements_text(raw_rosters.pieces))=8
          AND (SELECT count(DISTINCT piece) FROM jsonb_array_elements_text(raw_rosters.pieces) AS piece)=8
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(raw_rosters.pieces) AS piece(id)
            WHERE NOT (piece.id = ANY(CASE WHEN raw_rosters.alignment='light' THEN $2::text[] ELSE $3::text[] END))
          )
        ORDER BY match_id,pieces::text,alignment
      ), grouped AS (
        SELECT alignment,piece_ids,count(*)::int AS games,
          count(*) FILTER (WHERE winner_id=$1)::int AS wins
        FROM valid_rosters GROUP BY alignment,piece_ids
      ), ranked AS (
        SELECT alignment,piece_ids,games,wins,
          row_number() OVER (PARTITION BY alignment ORDER BY games DESC,piece_ids) AS roster_rank
        FROM grouped
      )
      SELECT alignment,piece_ids,games,wins FROM ranked WHERE roster_rank<=20
      ORDER BY alignment,roster_rank`, [id, characterIdsByAlignment.light, characterIdsByAlignment.dark])
    const resultByAlignment: { light: Roster | null; dark: Roster | null } = { light: null, dark: null }
    for (const row of result.rows) {
      if (resultByAlignment[row.alignment]) continue
      const pieces = piecesFromValue(row.piece_ids, characters, row.alignment)
      if (pieces.length !== 8) continue
      resultByAlignment[row.alignment] = { pieces, games: Number(row.games), wins: Number(row.wins) }
    }
    return resultByAlignment
  }
}
