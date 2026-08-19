import { NextRequest, NextResponse } from 'next/server'

import { hashStable, replayBattle, runBattleAction } from '@/lib/game/battle-runner'
import { createDebugDuel } from '@/lib/game/debug-battle'
import { DebugIdentityProvider } from '@/lib/game/debug-identity'
import { alignmentToPieceFaction, getRoomStore, type Room } from '@/lib/game/room-store'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import {
  collectRed43TargetEvidence,
  getRed43Scenario,
  prepareRed43State,
  type Red43ScenarioId,
} from '@/app/qa/same-alignment/server'
import { isRed43LocalDevelopmentHostname } from '@/app/qa/same-alignment/access'

type DebugBattleBody =
  | { mode?: 'create-duel'; mapId?: string; seed?: number; first?: unknown; second?: unknown; piecesPerPlayer?: number }
  | { mode: 'apply-action'; state?: BattleState; action?: BattleAction; seed?: number }
  | { mode: 'replay'; initialState?: BattleState; actions?: BattleAction[]; seed?: number }
  | { mode: 'identities'; labels?: string[] }
  | { mode: 'create-selection-room'; mapId?: string }
  | { mode: 'create-loopback-room'; mapId?: string; seed?: number; first?: unknown; second?: unknown; piecesPerPlayer?: number }
  | { mode: 'create-ui-acceptance-room'; scenario?: Red43ScenarioId }

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
}

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: {
      ...CORS_HEADERS,
      ...(init?.headers || {}),
    },
  })
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

export async function GET() {
  return json({
    ok: true,
    service: 'debug-battle',
    modes: [
      'create-duel',
      'apply-action',
      'replay',
      'identities',
      'create-selection-room',
      'create-loopback-room',
      'create-ui-acceptance-room',
    ],
  })
}

export async function POST(req: NextRequest) {
  let body: DebugBattleBody = {}
  try {
    body = await req.json()
  } catch {}

  try {
    if (!body.mode || body.mode === 'create-duel') {
      const result = await createDebugDuel({
        mapId: body.mapId,
        seed: body.seed,
        first: body.first as any,
        second: body.second as any,
        piecesPerPlayer: body.piecesPerPlayer,
      })
      return json(result)
    }

    if (body.mode === 'apply-action') {
      if (!body.state || !body.action) {
        return json({ error: 'state and action are required' }, { status: 400 })
      }
      return json(runBattleAction(body.state, body.action, { rootSeed: body.seed }))
    }

    if (body.mode === 'replay') {
      if (!body.initialState || !Array.isArray(body.actions)) {
        return json({ error: 'initialState and actions[] are required' }, { status: 400 })
      }
      return json(replayBattle({
        initialState: body.initialState,
        actions: body.actions,
        seed: body.seed,
      }))
    }

    if (body.mode === 'identities') {
      const provider = new DebugIdentityProvider()
      const labels = body.labels && body.labels.length > 0 ? body.labels : ['red', 'blue']
      const identities = await Promise.all(labels.map(label => provider.createIdentity(label)))
      return json({ identities })
    }

    if (body.mode === 'create-ui-acceptance-room') {
      if (!isRed43LocalDevelopmentHostname(req.nextUrl.hostname)) {
        return json({ error: 'RED-43 QA rooms are available only from local development.' }, { status: 404 })
      }

      const scenario = getRed43Scenario(body.scenario)
      if (!scenario) {
        return json({ error: 'scenario must be light-light or dark-dark' }, { status: 400 })
      }

      const provider = new DebugIdentityProvider('red-43-ui-acceptance')
      const [aliceIdentity, bobIdentity] = await Promise.all([
        provider.createIdentity('alice'),
        provider.createIdentity('bob'),
      ])
      const duel = await createDebugDuel({
        seed: scenario.seed,
        first: {
          playerId: aliceIdentity.playerId,
          seat: 'red',
          alignment: scenario.alignment,
          templateIds: scenario.roster,
        },
        second: {
          playerId: bobIdentity.playerId,
          seat: 'blue',
          alignment: scenario.alignment,
          templateIds: scenario.roster,
        },
        piecesPerPlayer: scenario.roster.length,
      })
      const state = prepareRed43State(duel.state, aliceIdentity.playerId, scenario)
      const targetEvidence = collectRed43TargetEvidence(state, aliceIdentity.playerId, scenario)
      const roomId = `red43-${scenario.alignment}-${Date.now().toString(36)}`
      const accountId = `red43-local-${Date.now().toString(36)}`
      const contentFaction = alignmentToPieceFaction(scenario.alignment)!
      const room: Room = {
        id: roomId,
        name: `RED-43 ${scenario.id} UI acceptance`,
        status: 'in-progress',
        createdAt: Date.now(),
        maxPlayers: 2,
        players: [
          {
            id: aliceIdentity.playerId,
            accountId,
            name: 'Alice',
            publicKey: aliceIdentity.publicKey,
            seat: 'red',
            faction: 'red',
            alignment: scenario.alignment,
            hasSelectedPieces: true,
            selectedPieces: scenario.roster.map(templateId => ({ templateId, faction: contentFaction })),
            ready: true,
          },
          {
            id: bobIdentity.playerId,
            accountId,
            name: 'Bob',
            publicKey: bobIdentity.publicKey,
            seat: 'blue',
            faction: 'blue',
            alignment: scenario.alignment,
            hasSelectedPieces: true,
            selectedPieces: scenario.roster.map(templateId => ({ templateId, faction: contentFaction })),
            ready: true,
          },
        ],
        spectators: [],
        currentTurnIndex: 0,
        actions: [],
        hostId: aliceIdentity.playerId,
        firstPlayerId: aliceIdentity.playerId,
        mapId: 'large-battlefield',
        visibility: 'private',
        battleState: {
          type: 'server-state',
          seed: duel.seed,
          state,
        } as unknown as BattleState,
      }

      await getRoomStore().setRoom(roomId, room)

      const origin = req.nextUrl.origin
      const buildBattleUrl = (player: { playerId: string; name: string }) => {
        const url = new URL('/qa/client/battle.html', origin)
        url.searchParams.set('roomId', roomId)
        url.searchParams.set('playerId', player.playerId)
        url.searchParams.set('accountId', accountId)
        url.searchParams.set('playerName', player.name)
        url.searchParams.set('server', 'local')
        url.searchParams.set('serverUrl', origin)
        url.searchParams.set('debug', '1')
        url.searchParams.set('qa', 'RED-43')
        url.searchParams.set('qaScenario', scenario.id)
        url.searchParams.set('qaAlignment', scenario.alignment)
        url.searchParams.set('qaCaster', scenario.casterTemplateId)
        url.searchParams.set('qaSkill', scenario.skillId)
        url.searchParams.set('qaExpected', scenario.expectedFilter)
        url.searchParams.set('qaExpectedTargets', targetEvidence.acceptedTargetPieceIds.join(','))
        return url.toString()
      }
      const stateHash = hashStable(state)
      const evidence = {
        roomId,
        seed: duel.seed,
        stateHash,
        scenario: scenario.id,
        alignment: scenario.alignment,
        players: {
          alice: { playerId: aliceIdentity.playerId, name: 'Alice' },
          bob: { playerId: bobIdentity.playerId, name: 'Bob' },
        },
        urls: {
          alice: buildBattleUrl({ playerId: aliceIdentity.playerId, name: 'Alice' }),
          bob: buildBattleUrl({ playerId: bobIdentity.playerId, name: 'Bob' }),
        },
        targetEvidence,
      }
      console.info('[RED-43 QA]', JSON.stringify(evidence))
      return json(evidence)
    }

    if (body.mode === 'create-selection-room') {
      const provider = new DebugIdentityProvider()
      const [firstIdentity, secondIdentity] = await Promise.all([
        provider.createIdentity('red'),
        provider.createIdentity('blue'),
      ])
      const roomId = `dbg-sel-${Date.now().toString(36)}`
      const accountId = `local-debug-account-${Date.now().toString(36)}`
      const room: Room = {
        id: roomId,
        name: 'Local PVP Selection Debug',
        status: 'waiting',
        createdAt: Date.now(),
        maxPlayers: 2,
        players: [
          {
            id: firstIdentity.playerId,
            accountId,
            name: firstIdentity.displayName,
            publicKey: firstIdentity.publicKey,
            seat: 'red',
            faction: 'red',
            hasSelectedPieces: false,
            selectedPieces: [],
            ready: true,
          },
          {
            id: secondIdentity.playerId,
            accountId,
            name: secondIdentity.displayName,
            publicKey: secondIdentity.publicKey,
            seat: 'blue',
            faction: 'blue',
            hasSelectedPieces: false,
            selectedPieces: [],
            ready: true,
          },
        ],
        spectators: [],
        currentTurnIndex: 0,
        actions: [],
        hostId: firstIdentity.playerId,
        mapId: body.mapId || 'large-battlefield',
        visibility: 'private',
      }

      const roomStore = getRoomStore()
      await roomStore.setRoom(roomId, room)

      return json({
        roomId,
        accountId,
        room,
        identities: [firstIdentity, secondIdentity],
        urls: [
          `piece-selection.html?roomId=${encodeURIComponent(roomId)}&playerId=${encodeURIComponent(firstIdentity.playerId)}&accountId=${encodeURIComponent(accountId)}&playerName=${encodeURIComponent(firstIdentity.displayName)}&debug=1`,
          `piece-selection.html?roomId=${encodeURIComponent(roomId)}&playerId=${encodeURIComponent(secondIdentity.playerId)}&accountId=${encodeURIComponent(accountId)}&playerName=${encodeURIComponent(secondIdentity.displayName)}&debug=1`,
        ],
      })
    }

    if (body.mode === 'create-loopback-room') {
      const provider = new DebugIdentityProvider()
      const [firstIdentity, secondIdentity] = await Promise.all([
        provider.createIdentity('red'),
        provider.createIdentity('blue'),
      ])
      const duel = await createDebugDuel({
        mapId: body.mapId,
        seed: body.seed,
        first: { ...(body.first as any), playerId: firstIdentity.playerId, seat: 'red' },
        second: { ...(body.second as any), playerId: secondIdentity.playerId, seat: 'blue' },
        piecesPerPlayer: body.piecesPerPlayer,
      })
      const roomId = `dbg-${Date.now().toString(36)}`
      const accountId = `local-debug-account-${Date.now().toString(36)}`
      const room: Room = {
        id: roomId,
        name: 'Local PVP Debug',
        status: 'in-progress',
        createdAt: Date.now(),
        maxPlayers: 2,
        players: [
          {
            id: firstIdentity.playerId,
            accountId,
            name: firstIdentity.displayName,
            publicKey: firstIdentity.publicKey,
            seat: 'red',
            faction: 'red',
            alignment: duel.players[0].alignment,
            hasSelectedPieces: true,
            selectedPieces: duel.players[0].templateIds.map(templateId => ({ templateId, faction: 'red' })),
            ready: true,
          },
          {
            id: secondIdentity.playerId,
            accountId,
            name: secondIdentity.displayName,
            publicKey: secondIdentity.publicKey,
            seat: 'blue',
            faction: 'blue',
            alignment: duel.players[1].alignment,
            hasSelectedPieces: true,
            selectedPieces: duel.players[1].templateIds.map(templateId => ({ templateId, faction: 'blue' })),
            ready: true,
          },
        ],
        spectators: [],
        currentTurnIndex: 0,
        actions: [],
        hostId: firstIdentity.playerId,
        mapId: body.mapId || 'large-battlefield',
        visibility: 'private',
        battleState: {
          type: 'server-state',
          seed: duel.seed,
          state: duel.state,
        } as any,
      }

      const roomStore = getRoomStore()
      await roomStore.setRoom(roomId, room)

      return json({
        roomId,
        accountId,
        room,
        stateHash: duel.stateHash,
        seed: duel.seed,
        identities: [firstIdentity, secondIdentity],
        urls: [
          `battle.html?roomId=${encodeURIComponent(roomId)}&playerId=${encodeURIComponent(firstIdentity.playerId)}&accountId=${encodeURIComponent(accountId)}&playerName=${encodeURIComponent(firstIdentity.displayName)}&debug=1`,
          `battle.html?roomId=${encodeURIComponent(roomId)}&playerId=${encodeURIComponent(secondIdentity.playerId)}&accountId=${encodeURIComponent(accountId)}&playerName=${encodeURIComponent(secondIdentity.displayName)}&debug=1`,
        ],
      })
    }

    return json({ error: `Unsupported debug mode: ${(body as any).mode}` }, { status: 400 })
  } catch (error) {
    const err = error as any
    if (err?.needsTargetSelection) {
      return json({
        error: err.message,
        needsTargetSelection: true,
        targetType: err.targetType,
        range: err.range,
        filter: err.filter,
        targetIndex: err.targetIndex,
      }, { status: 400 })
    }
    if (err?.needsOptionSelection) {
      return json({
        error: err.message,
        needsOptionSelection: true,
        options: err.options,
        title: err.title,
      }, { status: 400 })
    }

    return json(
      { error: error instanceof Error ? error.message : 'Failed to run debug battle action' },
      { status: 500 },
    )
  }
}
