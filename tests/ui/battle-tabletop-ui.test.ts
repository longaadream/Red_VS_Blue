import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext, Script } from 'node:vm'
import { describe, expect, it } from 'vitest'

type PlayerInput = {
  playerId: string
  teamId: 'red' | 'blue'
  name?: string
  actionPoints?: number
  maxActionPoints?: number
  chargePoints?: number
  maxChargePoints?: number
}

type BattleViewModelApi = {
  create(input: {
    snapshot: {
      players: PlayerInput[]
      turn: { currentPlayerId: string; turnNumber?: number; phase?: string }
      pieces?: unknown[]
    }
    viewerId?: string
    playerNames?: Record<string, string>
    training?: boolean
    spectating?: boolean
  }): { players: { id: string; name: string; faction: string }[]; viewer: { id: string; name: string } | null; turn: { isViewerTurn: boolean }; training: boolean; spectating: boolean }
}

function loadViewModel(): BattleViewModelApi {
  const browserWindow: Record<string, unknown> = {}
  const context = createContext({ window: browserWindow, globalThis: browserWindow, console })
  new Script(readFileSync(resolve(process.cwd(), 'data/pages/js/battle-ui/battle-view-model.js'), 'utf8'), {
    filename: 'battle-view-model.js',
  }).runInContext(context)
  return browserWindow.BattleViewModel as BattleViewModelApi
}

function snapshot(players: PlayerInput[]) {
  return {
    players,
    turn: { currentPlayerId: players[0]?.playerId || '', turnNumber: 3, phase: 'action' },
    pieces: [],
  }
}

describe('RED-241 tabletop battle ViewModel metadata', () => {
  it('uses a faction role until a late nickname arrives, then matches nickname keys case-insensitively', () => {
    const api = loadViewModel()
    const state = snapshot([
      { playerId: 'red-UID-42', teamId: 'red', name: 'red-uid-42' },
      { playerId: 'blue-UID-7', teamId: 'blue', name: 'blue-uid-7' },
    ])

    const beforeNickname = api.create({ snapshot: state, viewerId: 'RED-uid-42' })
    expect(beforeNickname.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'red-UID-42', name: '红方玩家', faction: 'red' }),
      expect.objectContaining({ id: 'blue-UID-7', name: '蓝方玩家', faction: 'blue' }),
    ]))
    expect(beforeNickname.players.map(player => player.name)).not.toContain('red-uid-42')

    const afterNickname = api.create({
      snapshot: state,
      viewerId: 'RED-uid-42',
      playerNames: { 'RED-uid-42': '赤焰' },
    })
    expect(afterNickname.viewer).toMatchObject({ id: 'red-UID-42', name: '赤焰' })
    expect(afterNickname.players.find(player => player.id === 'red-UID-42')?.name).toBe('赤焰')
    expect(afterNickname.turn.isViewerTurn).toBe(true)
  })

  it('keeps UID-shaped snapshot names private behind the faction role fallback', () => {
    const api = loadViewModel()
    const state = snapshot([
      { playerId: 'player-red-123', teamId: 'red', name: 'PLAYER-RED-123' },
      { playerId: 'player-blue-456', teamId: 'blue', name: 'player-blue-456' },
    ])

    const model = api.create({ snapshot: state, viewerId: 'player-red-123' })

    expect(model.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'player-red-123', name: '红方玩家' }),
      expect.objectContaining({ id: 'player-blue-456', name: '蓝方玩家' }),
    ]))
    expect(model.players.map(player => player.name)).not.toEqual(expect.arrayContaining([
      'PLAYER-RED-123',
      'player-blue-456',
    ]))
    const uidMetadata = api.create({ snapshot: state, viewerId: 'player-red-123', playerNames: { 'PLAYER-RED-123': 'player-red-123', 'player-blue-456': 'PLAYER-BLUE-456' } })
    expect(uidMetadata.players.map(player => player.name)).toEqual(['红方玩家', '蓝方玩家'])
  })

  it('projects training and spectator metadata while using faction labels for training players', () => {
    const api = loadViewModel()
    const state = snapshot([
      { playerId: 'red-id', teamId: 'red', name: 'Alice' },
      { playerId: 'blue-id', teamId: 'blue', name: 'Bob' },
    ])

    const model = api.create({
      snapshot: state,
      viewerId: 'red-id',
      playerNames: { 'red-id': 'Alice', 'blue-id': 'Bob' },
      training: true,
      spectating: true,
    })

    expect(model).toMatchObject({ training: true, spectating: true })
    expect(model.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'red-id', name: '红方', faction: 'red' }),
      expect.objectContaining({ id: 'blue-id', name: '蓝方', faction: 'blue' }),
    ]))
  })
})
