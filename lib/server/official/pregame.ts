import { randomInt } from 'node:crypto'
import type { PoolClient } from 'pg'
import { assertSelectableMapId, SELECTABLE_MAP_IDS } from '@/lib/game/map-selection'
import { getMapById } from '@/lib/game/map-repository'
import { getDemoPieceIds, getPieceById } from '@/lib/game/piece-repository'
import { DEMO_ROSTER_MANIFEST_VERSION, validateDemoRosterSelection } from '@/lib/game/roster-contract'
import { deriveStreamSeed, mulberry32 } from '@/lib/game/rule-runtime'
import { getServerGameProfileIdentityV1, assertGameProfileCompatibleV1, type GameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import type { Player } from '@/lib/game/room-model'
import { OfficialError } from './accounts'

export const PREGAME_SCHEMA = `
ALTER TABLE official_settings ADD COLUMN IF NOT EXISTS ranked_maps JSONB NOT NULL DEFAULT '["large-hole-arena","open-expanse","winding-pass","narrow-corridors"]';
CREATE TABLE IF NOT EXISTS official_pregames(match_id TEXT PRIMARY KEY REFERENCES official_matches(id),state JSONB NOT NULL);
ALTER TABLE official_queue ADD COLUMN IF NOT EXISTS profile_identity JSONB;
`
export type PregamePlayer = { id: string; name: string; seat: 'red' | 'blue'; alignment: 'light' | 'dark' | null; pieces: string[]; locked: boolean; autoFilled: boolean; ban: string | null; banSubmitted: boolean; revision: number }
export type PregameState = { version: 1; profileIdentity: GameProfileIdentityV1; seed: number; phase: 'veto' | 'roster' | 'starting' | 'battle'; pool: string[]; mapId: string | null; deadlineAt: number; players: PregamePlayer[] }

export function validateRankedMapPool(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > SELECTABLE_MAP_IDS.length || new Set(value).size !== value.length) throw new OfficialError('排位地图池须包含至少3张不同的1v1地图')
  try { return value.map(id => assertSelectableMapId(id, '1v1')) }
  catch { throw new OfficialError('地图不在可用1v1目录中') }
}
export function rankedMapCatalog(ids: string[]) {
  return ids.map(id => {
    const map = getMapById(id)
    if (!map) throw new OfficialError('排位地图资源不可用', 503)
    return { id, name: map.name, width: map.width, height: map.height,
      tiles: map.tiles.map(t => ({ x: t.x, y: t.y, type: t.props.type })) }
  })
}
export function createPregame(pool: unknown, players: Array<{ id: string; name: string }>, now: number, seed = randomInt(0x100000000)): PregameState {
  const firstRed = mulberry32(deriveStreamSeed(seed, 'ranked/seats'))() < .5
  return { version: 1, profileIdentity: getServerGameProfileIdentityV1(), seed, phase: 'veto', pool: validateRankedMapPool(pool), mapId: null, deadlineAt: now + 30000,
    players: players.map((p, i) => ({ ...p, seat: (i === 0) === firstRed ? 'red' : 'blue', alignment: null, pieces: [], locked: false, autoFilled: false, ban: null, banSubmitted: false, revision: 0 })) }
}
function fillRoster(state: PregameState, player: PregamePlayer) {
  const random = mulberry32(deriveStreamSeed(state.seed, `ranked/roster/${player.id}`))
  player.alignment ??= random() < .5 ? 'light' : 'dark'
  const faction = player.alignment === 'light' ? 'good' : 'evil'
  const available = getDemoPieceIds().filter(id => getPieceById(id)?.faction === faction && !player.pieces.includes(id)).sort()
  while (player.pieces.length < 8) {
    if (!available.length) throw new OfficialError('可用棋子不足，无法自动补齐', 503)
    player.pieces.push(available.splice(Math.floor(random() * available.length), 1)[0])
  }
  validateDemoRosterSelection({ alignment: player.alignment, pieces: player.pieces.map(templateId => ({ templateId })) })
  player.locked = true; player.autoFilled = true
}
export function advancePregame(state: PregameState, now: number) {
  if (state.phase === 'veto' && (now >= state.deadlineAt || state.players.every(p => p.banSubmitted))) {
    const remaining = state.pool.filter(id => !state.players.some(p => p.banSubmitted && p.ban === id))
    const random = mulberry32(deriveStreamSeed(state.seed, 'ranked/map'))
    state.mapId = remaining[Math.floor(random() * remaining.length)]
    const endedAt = Math.min(now, state.deadlineAt)
    state.phase = 'roster'; state.deadlineAt = endedAt + 120000
  }
  if (state.phase === 'roster') {
    if (now >= state.deadlineAt) for (const player of state.players) if (!player.locked) fillRoster(state, player)
    if (state.players.every(p => p.locked)) state.phase = 'starting'
  }
}
export function applyPregameAction(state: PregameState, playerId: string, input: Record<string, unknown>, now: number) {
  const player = state.players.find(p => p.id === playerId)
  if (!player) throw new OfficialError('没有参赛资格', 403)
  advancePregame(state, now)
  if (input.action === 'ban') {
    if (state.phase !== 'veto' || player.banSubmitted) {
      if (player.banSubmitted && player.ban === input.mapId) return
      throw new OfficialError('禁图已结束或已提交', 409)
    }
    if (typeof input.mapId !== 'string' || !state.pool.includes(input.mapId)) throw new OfficialError('请选择本局地图池中的地图')
    player.ban = input.mapId; player.banSubmitted = true
  } else if (input.action === 'draft' || input.action === 'lock' || input.action === 'fill') {
    if (input.action === 'lock' && player.locked && player.alignment === input.alignment && JSON.stringify(player.pieces) === JSON.stringify(input.pieces)) return
    if (state.phase !== 'roster' || player.locked) throw new OfficialError('阵容已锁定或选择阶段已结束', 409)
    if (input.revision !== player.revision) throw new OfficialError('阵容已在另一页面更新，请同步后再试', 409)
    if (input.alignment !== 'light' && input.alignment !== 'dark') throw new OfficialError('请选择光方或暗方')
    const ids = input.pieces
    if (!Array.isArray(ids) || ids.length > 8 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !getDemoPieceIds().includes(id) || getPieceById(id)?.faction !== (input.alignment === 'light' ? 'good' : 'evil'))) throw new OfficialError('阵容必须为本阵营内最多8枚不同的可用棋子')
    player.alignment = input.alignment; player.pieces = ids; player.autoFilled = false; player.revision++
    if (input.action === 'fill') fillRoster(state, player)
    if (input.action === 'lock') {
      try { validateDemoRosterSelection({ alignment: player.alignment, pieces: ids.map(templateId => ({ templateId })) }) }
      catch { throw new OfficialError('请完整选择8枚不同的棋子') }
      player.locked = true
    }
  } else throw new OfficialError('未知赛前操作')
  advancePregame(state, now)
}
export function publicPregame(state: PregameState, playerId: string, now: number) {
  if (!state.players.some(p => p.id === playerId)) throw new OfficialError('没有参赛资格', 403)
  return { version: state.version, phase: state.phase, mapId: state.mapId, deadlineAt: state.deadlineAt, serverNow: now,
    maps: rankedMapCatalog(state.pool), players: state.players.map(p => ({ id: p.id, name: p.name, seat: p.seat, locked: p.locked,
      banSubmitted: p.banSubmitted, ban: state.phase !== 'veto' || p.id === playerId ? p.ban : null,
      ...(p.id === playerId ? { alignment: p.alignment, pieces: p.pieces, autoFilled: p.autoFilled, revision: p.revision } : {}) })) }
}
export function pregameBattlePlayers(state: PregameState): Player[] {
  if (state.phase !== 'starting' || !state.mapId) throw new Error('Pregame is not ready')
  const profileIdentity = assertGameProfileCompatibleV1(state.profileIdentity)
  return state.players.map(p => {
    if (!p.alignment || !p.locked) throw new Error('Roster is not locked')
    return { id: p.id, accountId: p.id, name: p.name, seat: p.seat, faction: p.seat, alignment: p.alignment,
      ready: true, rosterLocked: true, hasSelectedPieces: true, rosterManifestVersion: DEMO_ROSTER_MANIFEST_VERSION,
      profileIdentity, selectedPieces: validateDemoRosterSelection({ alignment: p.alignment, pieces: p.pieces.map(templateId => ({ templateId })) }) }
  })
}
export async function readPregame(client: PoolClient, id: string): Promise<PregameState | undefined> {
  return (await client.query('SELECT state FROM official_pregames WHERE match_id=$1 FOR UPDATE', [id])).rows[0]?.state
}
