/* eslint-disable @typescript-eslint/no-explicit-any -- frozen definitions compared through the real SkillCode host. */
import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyGameplayModuleGraph } from '../../lib/skill-graph/module-document'
import { buildStatusSkillGraph, STATUS_SKILL_RECIPES } from '../../scripts/migrate-semantic-status-skills'
import { executeSkillFunction } from '../../lib/game/skills'
import { globalTriggerSystem } from '../../lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

const entries = JSON.parse(fs.readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
afterEach(() => { vi.restoreAllMocks(); globalTriggerSystem.clearRules() })

function execute(definition: any, mode: 'normal' | 'duplicate' | 'pending' | 'self', defense: number) {
  globalTriggerSystem.clearRules()
  const recipe = STATUS_SKILL_RECIPES[definition.id]
  const source = makePiece({ instanceId: 'source', name: '施放者', defense, x: 1, y: 1 })
  const target = makePiece({ instanceId: 'target', name: '目标', defense, ownerPlayerId: recipe.target?.filter === 'enemy' ? 'player-blue' : 'player-red', x: 2, y: 1 })
  source.name = '施放者'; target.name = '目标'; source.defense = defense; target.defense = defense
  source.skills = [{ skillId: 'sasuke-chidori', currentCooldown: 2 }]
  const battle = makeState({ pieces: [source, target] }) as any
  battle.skillsById[definition.id] = definition
  const selected = mode === 'self' ? source : target
  if (mode === 'duplicate') (recipe.target ? selected : source).statusTags = [{ id: 'existing', type: String(recipe.status.type), intensity: 2, stacks: 2, currentDuration: 2 }]
  const result = executeSkillFunction(definition, {
    piece: source, battle, skill: definition, target: mode === 'pending' ? null : selected, targetPosition: null,
    targets: mode === 'pending' ? [] : [{ info: selected, pos: null }],
  } as any, battle)
  const state = clone(battle)
  delete state.skillsById
  return { result: clone(result), state }
}

describe('semantic status/ability skill migrations', () => {
  for (const id of Object.keys(STATUS_SKILL_RECIPES)) {
    for (const mode of ['normal', 'duplicate', 'pending', 'self'] as const) it(`${id} preserves ${mode} result and full host state`, () => {
      vi.spyOn(Date, 'now').mockReturnValue(1770000000123)
      const original = clone(entries['skills/' + id])
      const semantic = applyGameplayModuleGraph(original, buildStatusSkillGraph(id))
      for (const defense of [0, 0.5, 3]) {
        const before = execute(original, mode, defense)
        const after = execute(semantic, mode, defense)
        expect(after).toEqual(before)
        if (mode === 'normal') {
          expect(after.result.success).toBe(true)
          expect(after.result.needsTargetSelection).not.toBe(true)
          expect(after.state.pieces.some((piece: any) => piece.statusTags.some((tag: any) => tag.type === STATUS_SKILL_RECIPES[id].status.type))).toBe(true)
        }
      }
    })
  }
})
