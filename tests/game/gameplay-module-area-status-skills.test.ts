/* eslint-disable @typescript-eslint/no-explicit-any -- Differential host fixtures. */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { applyGameplayModuleGraph } from '@/lib/skill-graph/module-document'
import { executeSkillFunction } from '@/lib/game/skills'
import { buildAreaStatusSkillGraph, AREA_STATUS_SKILL_IDS } from '@/scripts/migrate-semantic-area-status-skills'
import { assertFrozenExecutable } from '@/scripts/semantic-migration-source'
import { makePiece, makeState } from '../helpers/minimal-state'

const entries = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries
function run(id: string, semantic: boolean, empty: boolean, duplicate: boolean) {
  const frozen = entries['skills/' + id]
  const definition = semantic ? applyGameplayModuleGraph(frozen, buildAreaStatusSkillGraph(id)) : frozen
  const caster = makePiece({ instanceId: 'caster', x: 4, y: 4 })
  caster.name = '施放者'
  const pieces = empty ? [] : Array.from({ length: 8 }, (_, index) => makePiece({ instanceId: 'target-' + index, ownerPlayerId: index % 2 ? 'player-red' : 'player-blue', x: 4 + Math.floor(index / 2), y: 4, currentHp: index === 7 ? 0 : 10 }))
  pieces.forEach((piece, index) => { piece.name = '棋子' + index })
  const battle = makeState({ pieces: [caster, ...pieces] })
  battle.skillsById[id] = definition
  const context: any = { piece: caster, skill: definition, battle, target: null, targets: [] }
  const result = executeSkillFunction(definition, context, battle)
  const second = duplicate ? executeSkillFunction(definition, context, battle) : null
  const state = JSON.parse(JSON.stringify(battle)); delete state.skillsById
  return { result, second, state }
}
describe('area status module graphs', () => {
  for (const id of AREA_STATUS_SKILL_IDS) for (const empty of [false, true]) for (const duplicate of [false, true]) {
    it(`${id} empty=${empty} duplicate=${duplicate}`, () => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1750000000000)
      try {
        const expected = run(id, false, empty, duplicate)
        expect(run(id, true, empty, duplicate)).toEqual(expected)
        expect(expected.result.success).toBe(true)
        if (!empty) expect(expected.state.pieces.some((piece: any) => piece.statusTags.length > 0)).toBe(true)
      } finally { clock.mockRestore() }
    })
  }
  it('recognizes the historical receiver artifact but rejects an edited executable', () => {
    const frozen = entries['skills/alfonso-freeze']
    const historical = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-receiver.json', 'utf8'))
    expect(() => assertFrozenExecutable(historical, frozen, 'code', 'skill', frozen.id)).not.toThrow()
    expect(() => assertFrozenExecutable(frozen, frozen, 'code', 'skill', frozen.id)).not.toThrow()
    expect(() => assertFrozenExecutable({ code: historical.code.replace('"冰冻"', '"人工修改"') }, frozen, 'code', 'skill', frozen.id)).toThrow(/differs/)
  })
})
