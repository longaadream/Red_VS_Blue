import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/game/skill-repository', () => ({
  getSkillById: vi.fn(() => null),
}))

import { generateBotActions } from '@/lib/game/ai'
import { makePiece, makeState } from '../helpers/minimal-state'

describe('AI normal movement', () => {
  it('不会生成穿过存活棋子的普通移动', () => {
    const bot = makePiece({ instanceId: 'bot', ownerPlayerId: 'player-red', x: 0, y: 0, moveRange: 3 })
    const summon = makePiece({ instanceId: 'summon', templateId: 'summoned-unit', ownerPlayerId: 'player-red', x: 1, y: 0 })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 4, y: 0 })
    const state = makeState({ pieces: [bot, summon, enemy], width: 6, height: 1, currentPlayerId: 'player-red', phase: 'action' })

    const actions = generateBotActions(
      state as unknown as Parameters<typeof generateBotActions>[0],
      'player-red',
    )

    expect(actions.filter(action => action.type === 'move' && action.pieceId === 'bot')).toEqual([])
    expect(actions.at(-1)).toEqual({ type: 'endTurn', playerId: 'player-red' })
  })
})
