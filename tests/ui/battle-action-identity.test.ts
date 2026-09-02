import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Script, createContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

function loadIdentity() {
  const window: Record<string, unknown> = {}
  const context = createContext({ window, globalThis: window })
  const source = readFileSync(
    resolve(process.cwd(), 'data/pages/js/battle-ui/battle-action-identity.js'),
    'utf8',
  )
  new Script(source, { filename: 'battle-action-identity.js' }).runInContext(context)
  return window.BattleActionIdentity as {
    portraitUrl: (ref: string) => string
    resolve: (event: Record<string, unknown>, model: Record<string, unknown>) => Record<string, unknown>
  }
}

describe('RED-167 action identity', () => {
  it('resolves a skill name and caster portrait from presentation-only metadata', () => {
    const identity = loadIdentity()

    expect(identity.resolve(
      { kind: 'skill', sourcePieceId: 'arthas', skillId: 'icebound' },
      {
        pieces: [{ id: 'arthas', name: '阿尔萨斯', portraitId: 'blue-arthas', faction: 'blue' }],
        skillSummariesById: { icebound: { id: 'icebound', name: '寒冰坚忍' } },
      },
    )).toEqual({
      isSkill: true,
      skillName: '寒冰坚忍',
      sourceName: '阿尔萨斯',
      portraitSrc: 'images/arthas.jpg',
      portraitFallback: '阿',
      faction: 'blue',
    })
  })

  it('keeps a readable caster fallback when portrait metadata is missing', () => {
    const identity = loadIdentity()

    expect(identity.resolve(
      { kind: 'chargeSkill', sourcePieceId: 'future-piece', skillId: 'future-skill' },
      { pieces: [{ id: 'future-piece', name: '新角色', faction: 'red' }] },
    )).toMatchObject({
      skillName: 'future-skill',
      portraitSrc: '',
      portraitFallback: '新',
    })
  })
})
