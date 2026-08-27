import { NextResponse } from 'next/server'

import { createDebugDuel } from '@/lib/game/debug-battle'
import { readSanitizedBattleActionTrace } from '@/lib/game/battle-trace'

export const dynamic = 'force-dynamic'

const DEFAULT_SCENARIO_SEED = 20260821
const DEFAULT_MAP_ID = 'large-hole-arena'
const ALIGNMENTS = new Set(['light', 'dark'])

interface ScenarioRequest {
  seed?: unknown
  mapId?: unknown
  firstAlignment?: unknown
  secondAlignment?: unknown
}

export async function POST(request: Request) {
  let input: ScenarioRequest
  try {
    input = await request.json() as ScenarioRequest
  } catch {
    return failure('请求体必须是有效 JSON', 400)
  }

  const validation = validateInput(input)
  if (!validation.ok) return failure(validation.error, 400)

  try {
    const duel = await createDebugDuel({
      seed: validation.value.seed,
      mapId: validation.value.mapId,
      first: {
        playerId: 'developer-red',
        seat: 'red',
        alignment: validation.value.firstAlignment,
      },
      second: {
        playerId: 'developer-blue',
        seat: 'blue',
        alignment: validation.value.secondAlignment,
      },
      beginPhase: true,
    })
    return NextResponse.json({
      format: 'rvb-developer-scenario/v1',
      isolation: {
        kind: 'in-memory',
        createsRoom: false,
        grantsRewards: false,
        writesStatistics: false,
      },
      seed: duel.seed,
      map: {
        id: duel.state.map.id,
        name: duel.state.map.name,
        width: duel.state.map.width,
        height: duel.state.map.height,
      },
      turn: {
        number: duel.state.turn.turnNumber,
        phase: duel.state.turn.phase,
        currentPlayerId: duel.state.turn.currentPlayerId,
      },
      players: duel.players,
      pieceCount: duel.state.pieces.length,
      stateVersion: duel.state._v ?? null,
      stateHash: duel.stateHash,
      actionTrace: readSanitizedBattleActionTrace(duel.state),
    }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    console.error('[developer-tools] isolated scenario failed', error)
    return failure('无法创建隔离调试场景，请检查地图与本地资源', 422)
  }
}

function validateInput(input: ScenarioRequest):
  | {
      ok: true
      value: {
        seed: number
        mapId: string
        firstAlignment: 'light' | 'dark'
        secondAlignment: 'light' | 'dark'
      }
    }
  | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '请求体必须是对象' }
  }

  const seed = input.seed === undefined ? DEFAULT_SCENARIO_SEED : input.seed
  if (!Number.isSafeInteger(seed) || Number(seed) < 0 || Number(seed) > 0xffff_ffff) {
    return { ok: false, error: 'seed 必须是 0 到 4294967295 的整数' }
  }

  const mapId = input.mapId === undefined ? DEFAULT_MAP_ID : input.mapId
  if (typeof mapId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(mapId)) {
    return { ok: false, error: 'mapId 格式无效' }
  }

  const firstAlignment = input.firstAlignment === undefined ? 'dark' : input.firstAlignment
  const secondAlignment = input.secondAlignment === undefined ? 'light' : input.secondAlignment
  if (!ALIGNMENTS.has(String(firstAlignment)) || !ALIGNMENTS.has(String(secondAlignment))) {
    return { ok: false, error: '阵营只能是 light 或 dark' }
  }

  return {
    ok: true,
    value: {
      seed: Number(seed) >>> 0,
      mapId,
      firstAlignment: firstAlignment as 'light' | 'dark',
      secondAlignment: secondAlignment as 'light' | 'dark',
    },
  }
}

function failure(error: string, status: number) {
  return NextResponse.json(
    { error },
    { status, headers: { 'Cache-Control': 'no-store' } },
  )
}
